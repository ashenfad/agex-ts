/**
 * Wire replay: apply `WireCommit`s to a local store.
 *
 * `applyWire` is the receiver side of every transfer (sync pull,
 * bundle import). It reconstructs each commit's records byte-exactly:
 * blob keys are derived from the bytes, the keyset HAMT is rebuilt
 * locally over the first parent's (nodes never cross the wire), and the
 * commit hash is recomputed from the rebuilt root and the recorded
 * time and info, and compared against the claimed hash — a mismatch
 * refuses the commit before anything is written.
 *
 * Requirements on the stream (which `walkDelta` guarantees):
 * - topological order: every parent precedes its children, except
 *   parents already present in the store (the receiver's frontier)
 * - complete deltas relative to each commit's first parent
 *
 * Idempotency: commits are content-addressed, so a commit whose
 * records already exist is skipped wholesale. Re-applying a stream is
 * a no-op apart from the optional branch creation.
 *
 * Remote-tracking state (`getSyncHead`/`setSyncHead`) lives here too:
 * `__sync_head__<branch>` records the last commit a branch is known to
 * share with its remote. It is bookkeeping for the sync orchestration
 * layer — `applyWire` itself never touches it.
 */

import { EMPTY_HASH } from '../hamt'
import { Keyset } from '../keyset'
import type { KVStore, KeysetEntry, WireCommit } from '../types'
import {
  BRANCH_HEAD,
  BRANCH_HEAD_PREV,
  COMMIT_ROOT,
  ROOT_COMMIT,
  SYNC_HEAD,
  blobKey,
  checkStorageVersion,
  commitHash,
  commitRecords,
  dumps,
  loads,
  safeLoads,
} from '../versioned/layout'

export interface ApplyWireOptions {
  /**
   * Create this branch pointing at the stream's final commit. Fails if
   * the branch already exists (import semantics — fast-forwarding an
   * existing branch is the sync orchestration layer's job, where the
   * CAS race is handled). No-op when the stream is empty.
   */
  createBranch?: string
}

export interface ApplyWireResult {
  /** Commits written by this call. */
  applied: number
  /** Commits skipped because their records already existed. */
  skipped: number
  /** The last commit in the stream (the transfer's `want`), or null
   *  for an empty stream. */
  head: string | null
}

/**
 * Apply a stream of wire commits to `store`.
 *
 * Throws on: storage-version mismatch, a parent missing both from the
 * stream-so-far and the store, a failed integrity check, or a
 * `createBranch` collision. Already-applied commits stay applied if a
 * later commit throws — they're valid, content-addressed history.
 */
export async function applyWire(
  store: KVStore,
  commits: AsyncIterable<WireCommit> | Iterable<WireCommit>,
  opts: ApplyWireOptions = {},
): Promise<ApplyWireResult> {
  await checkStorageVersion(store)

  let applied = 0
  let skipped = 0
  let head: string | null = null

  for await (const wc of commits) {
    head = wc.hash
    if ((await store.get(COMMIT_ROOT(wc.hash))) !== null) {
      // Content-addressed: present means identical.
      skipped++
      continue
    }

    // Rebuild the keyset over the first parent's (structural sharing
    // comes back for free), with each update's blob keyed by its bytes.
    const writes = new Map<string, Uint8Array>()
    const entryUpdates: Array<readonly [string, KeysetEntry]> = []
    for (const [key, bytes] of wc.updates) {
      const pointer = await blobKey(bytes)
      writes.set(pointer, bytes)
      entryUpdates.push([key, { blob: pointer, meta: { size: bytes.length } }])
    }
    const firstParent = wc.parents[0]
    const parentKs = Keyset.fromRoot(
      store,
      firstParent !== undefined ? await rootAt(store, firstParent) : EMPTY_HASH,
    )
    const newKs = await parentKs.updated({ updates: entryUpdates, removals: wc.removals })

    // The root commit's hash is fixed rather than derived, so it is
    // checked by its shape: no parents, no info, an empty keyset.
    const recomputed =
      wc.hash === ROOT_COMMIT
        ? wc.parents.length === 0 && newKs.root === EMPTY_HASH && wc.info == null
          ? ROOT_COMMIT
          : 'a root commit with content'
        : await commitHash(wc.parents, newKs.root, wc.time, wc.info)
    if (recomputed !== wc.hash) {
      throw new Error(
        `applyWire: integrity check failed for ${wc.hash} (recomputed ${recomputed}) — refusing commit`,
      )
    }

    // One batch per commit, as a commit is written: blobs, nodes, records.
    for (const [k, v] of newKs.pending) writes.set(k, v)
    const records = commitRecords({
      commit: wc.hash,
      root: newKs.root,
      parents: wc.parents,
      parentGens: wc.parentGens,
      created: wc.time,
      info: wc.info ?? null,
    })
    for (const [k, v] of records) writes.set(k, v)
    await store.setMany(writes)
    applied++
  }

  if (opts.createBranch !== undefined && head !== null) {
    const branchKey = BRANCH_HEAD(opts.createBranch)
    const ok = await store.casMany(
      new Map([[branchKey, null]]),
      new Map([[branchKey, dumps(head)]]),
      [BRANCH_HEAD_PREV(opts.createBranch)],
    )
    if (!ok) {
      throw new Error(`applyWire: branch '${opts.createBranch}' already exists`)
    }
  }

  return { applied, skipped, head }
}

/** A commit's keyset root; throws if the commit is absent, which in a
 *  parents-first stream means a parent neither sent nor held. */
async function rootAt(store: KVStore, commit: string): Promise<string> {
  const rootBytes = await store.get(COMMIT_ROOT(commit))
  if (rootBytes === null) {
    throw new Error(
      `applyWire: parent ${commit} is neither in the stream nor the store (stream must be parents-first)`,
    )
  }
  return loads(rootBytes) as string
}

// ---------------------------------------------------------------------------
// Remote-tracking heads
// ---------------------------------------------------------------------------

/** Last commit `branch` is known to share with its remote, or null if
 *  the branch has never synced. */
export async function getSyncHead(store: KVStore, branch: string): Promise<string | null> {
  const raw = await store.get(SYNC_HEAD(branch))
  if (raw === null) return null
  const parsed = safeLoads(raw)
  return typeof parsed === 'string' ? parsed : null
}

/** Record `commit` as the branch's last-synced remote head. */
export async function setSyncHead(store: KVStore, branch: string, commit: string): Promise<void> {
  await store.set(SYNC_HEAD(branch), dumps(commit))
}

/** Forget a branch's remote-tracking state (e.g. on remote detach). */
export async function clearSyncHead(store: KVStore, branch: string): Promise<void> {
  await store.remove(SYNC_HEAD(branch))
}
