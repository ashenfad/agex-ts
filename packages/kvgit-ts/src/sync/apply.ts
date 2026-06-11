/**
 * Wire replay: apply `WireCommit`s to a local store.
 *
 * `applyWire` is the receiver side of every transfer (sync pull,
 * bundle import). It reconstructs each commit's records byte-exactly:
 * blob pointers are re-derived (`<hash>:<key>` for updates, carried
 * pointers from the wire's provenance), the keyset HAMT is rebuilt
 * locally (nodes never cross the wire), and the commit hash is
 * recomputed from the replayed state and compared against the claimed
 * hash — a mismatch refuses the commit before anything is written.
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

import { Keyset } from '../keyset'
import type { KVStore, KeysetEntry, WireCommit } from '../types'
import {
  BRANCH_HEAD,
  COMMIT_ROOT,
  COMMIT_TIME,
  INFO_KEY,
  PARENT_COMMIT,
  SYNC_HEAD,
  blobPointer,
  checkStorageVersion,
  contentHash,
  dumps,
  loads,
  pendingPointer,
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

/** Replayed-pointer-map cache bound: maps are reloadable from the
 *  store once their commit is applied, so eviction only costs a
 *  re-materialize on the (rare) far-apart merge parent. */
const POINTER_MAP_CACHE_MAX = 64

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

  // key → blob pointer maps for already-seen commits. Insertion-order
  // eviction; misses fall back to materializing the commit's keyset
  // from the store (correct for any applied/pre-existing commit).
  const pointerMaps = new Map<string, Map<string, string>>()
  const remember = (commit: string, map: Map<string, string>): void => {
    pointerMaps.set(commit, map)
    if (pointerMaps.size > POINTER_MAP_CACHE_MAX) {
      const oldest = pointerMaps.keys().next().value as string
      pointerMaps.delete(oldest)
    }
  }
  const getPointerMap = async (commit: string): Promise<Map<string, string>> => {
    const hit = pointerMaps.get(commit)
    if (hit !== undefined) return hit
    const rootBytes = await store.get(COMMIT_ROOT(commit))
    if (rootBytes === null) {
      throw new Error(
        `applyWire: parent ${commit} is neither in the stream nor the store (stream must be parents-first)`,
      )
    }
    const ks = Keyset.fromRoot(store, loads(rootBytes) as string)
    const map = new Map<string, string>()
    for (const [k, entry] of await ks.materialize()) map.set(k, entry.blob)
    remember(commit, map)
    return map
  }

  let applied = 0
  let skipped = 0
  let head: string | null = null

  for await (const wc of commits) {
    head = wc.hash
    if ((await store.get(COMMIT_ROOT(wc.hash))) !== null) {
      // Content-addressed: present means identical. Its pointer map is
      // loaded lazily from the store if a later child needs it.
      skipped++
      continue
    }

    const firstParent = wc.parents[0]
    const base =
      firstParent !== undefined ? await getPointerMap(firstParent) : new Map<string, string>()

    // Reconstruct the preview keyset contentHash saw at creation:
    // carried-forward pointers, minus removals, plus carries' real
    // pointers, plus pending placeholders for updates.
    const preview = new Map(base)
    for (const key of wc.removals) preview.delete(key)
    for (const [key, carry] of wc.carries) preview.set(key, blobPointer(carry.owner, key))
    for (const key of wc.updates.keys()) preview.set(key, pendingPointer(key))

    const recomputed = await contentHash(wc.parents, preview, wc.updates, wc.info)
    if (recomputed !== wc.hash) {
      throw new Error(
        `applyWire: integrity check failed for ${wc.hash} (recomputed ${recomputed}) — refusing commit`,
      )
    }

    // Rebuild the keyset HAMT over the first parent's (nodes are
    // local; structural sharing comes back for free).
    const entryUpdates: Array<readonly [string, KeysetEntry]> = []
    const blobWrites: Array<[string, Uint8Array]> = []
    for (const [key, bytes] of wc.updates) {
      const pointer = blobPointer(wc.hash, key)
      blobWrites.push([pointer, bytes])
      entryUpdates.push([
        key,
        {
          blob: pointer,
          meta: { size: bytes.length, createdAt: wc.meta.get(key)?.createdAt ?? wc.time },
        },
      ])
    }
    for (const [key, carry] of wc.carries) {
      entryUpdates.push([
        key,
        {
          blob: blobPointer(carry.owner, key),
          meta: { size: carry.size, createdAt: carry.createdAt },
        },
      ])
    }

    const parentKs =
      firstParent !== undefined ? await loadKeysetAt(store, firstParent) : await Keyset.empty(store)
    const newKs = await parentKs.updated({ updates: entryUpdates, removals: wc.removals })

    // One atomic batch per commit, mirroring createCommit: blobs +
    // HAMT pending + commit records.
    const writes: Array<[string, Uint8Array]> = [...blobWrites]
    for (const [k, v] of newKs.pending) writes.push([k, v])
    writes.push([COMMIT_ROOT(wc.hash), dumps(newKs.root)])
    writes.push([PARENT_COMMIT(wc.hash), dumps([...wc.parents])])
    writes.push([COMMIT_TIME(wc.hash), dumps(wc.time)])
    if (wc.info !== null) writes.push([INFO_KEY(wc.hash), dumps(wc.info)])
    await store.setMany(writes)

    const real = new Map(preview)
    for (const key of wc.updates.keys()) real.set(key, blobPointer(wc.hash, key))
    remember(wc.hash, real)
    applied++
  }

  if (opts.createBranch !== undefined && head !== null) {
    const ok = await store.cas(BRANCH_HEAD(opts.createBranch), dumps(head), null)
    if (!ok) {
      throw new Error(`applyWire: branch '${opts.createBranch}' already exists`)
    }
  }

  return { applied, skipped, head }
}

/** Open the keyset at a commit; throws if the commit root is absent. */
async function loadKeysetAt(store: KVStore, commit: string): Promise<Keyset> {
  const rootBytes = await store.get(COMMIT_ROOT(commit))
  if (rootBytes === null) {
    throw new Error(`applyWire: commit root missing for ${commit}`)
  }
  return Keyset.fromRoot(store, loads(rootBytes) as string)
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
