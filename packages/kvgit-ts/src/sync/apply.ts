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
import { PyFloat } from '../pyjson'
import type { KVStore, KeysetEntry, WireCommit } from '../types'
import {
  BRANCH_HEAD,
  BRANCH_HEAD_PREV,
  COMMIT_ROOT,
  GC_LEASE_KEY,
  IN_FLIGHT_KEY,
  PARENT_COMMIT,
  PARENT_GENS,
  ROOT_COMMIT,
  SYNC_HEAD,
  blobKey,
  checkStorageVersion,
  commitHash,
  commitRecords,
  dumps,
  generationOf,
  loads,
  safeLoads,
} from '../versioned/layout'
import { IN_FLIGHT_TTL, tryLand, waitForGc } from '../versioned/lease'

export interface ApplyWireOptions {
  /** The clock in-flight markers are stamped with, in seconds. Default:
   *  wall time. */
  now?: () => number
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
  /** Commits written by this call and not yet under a head: each is
   *  marked in flight, so a sweep keeps it until the head that names it
   *  lands. Pass them to {@link publishHead}, which drops the markers in
   *  the same write; ones never published lapse. Empty when
   *  `createBranch` published them. */
  inFlight: readonly string[]
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
  const now = opts.now ?? wallClock
  const inFlight: string[] = []

  let applied = 0
  let skipped = 0
  let head: string | null = null
  const generations = new Map<string, number>()

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

    // The hash doesn't cover parent generations, so they are checked
    // against the parents' own records: commits made on top of this one
    // count from them.
    const expectedGens =
      wc.parents.length === 0
        ? null
        : await Promise.all(wc.parents.map((p) => generationAt(store, p, generations)))
    if (dumpsText(wc.parentGens) !== dumpsText(expectedGens)) {
      throw new Error(
        `applyWire: parent generations ${dumpsText(wc.parentGens)} for ${wc.hash} do not match its parents' ${dumpsText(expectedGens)} — refusing commit`,
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
    // Marked in flight and landed while no sweep runs: a commit no head
    // names yet must not be swept before one does.
    writes.set(IN_FLIGHT_KEY(wc.hash), dumps(new PyFloat(now() + IN_FLIGHT_TTL)))
    for (;;) {
      const lease = await waitForGc(store, now)
      if (await store.casMany(new Map([[GC_LEASE_KEY, lease]]), writes)) break
    }
    inFlight.push(wc.hash)
    applied++
  }

  if (opts.createBranch !== undefined && head !== null) {
    if (!(await publishHead(store, opts.createBranch, null, head, { inFlight, now }))) {
      throw new Error(`applyWire: branch '${opts.createBranch}' already exists`)
    }
    return { applied, skipped, head, inFlight: [] }
  }

  return { applied, skipped, head, inFlight }
}

/**
 * Move `branch` from `expected` (null: create it) to `newHead`, with
 * the backup, while no sweep runs, dropping the in-flight markers of
 * the commits this publishes in the same write.
 *
 * @returns false if the branch isn't at `expected` (or exists, for a
 *   create).
 */
export async function publishHead(
  store: KVStore,
  branch: string,
  expected: string | null,
  newHead: string,
  opts: { inFlight?: readonly string[]; now?: () => number } = {},
): Promise<boolean> {
  const now = opts.now ?? wallClock
  const branchKey = BRANCH_HEAD(branch)
  const expectedBytes = expected === null ? null : dumps(expected)
  const writes = new Map([[branchKey, dumps(newHead)]])
  const removes = (opts.inFlight ?? []).map(IN_FLIGHT_KEY)
  if (expectedBytes === null) removes.push(BRANCH_HEAD_PREV(branch))
  else writes.set(BRANCH_HEAD_PREV(branch), expectedBytes)
  for (;;) {
    const lease = await waitForGc(store, now)
    // The head must name a commit that is here when it lands.
    if ((await store.get(COMMIT_ROOT(newHead))) === null) {
      throw new Error(`publishHead: commit ${newHead} is not in the store`)
    }
    const landed = await tryLand(
      store,
      lease,
      new Map([[branchKey, expectedBytes]]),
      writes,
      removes,
    )
    if (landed !== null) return landed
  }
}

const wallClock = (): number => Date.now() / 1000

/** A stored commit's generation: 0 with no parents, else one more than
 *  its highest parent's, as its recorded parent generations say. */
async function generationAt(
  store: KVStore,
  commit: string,
  cache: Map<string, number>,
): Promise<number> {
  const cached = cache.get(commit)
  if (cached !== undefined) return cached
  const parentsBytes = await store.get(PARENT_COMMIT(commit))
  if (parentsBytes === null) {
    throw new Error(
      `applyWire: parent ${commit} is neither in the stream nor the store (stream must be parents-first)`,
    )
  }
  const parents = loads(parentsBytes) as string[]
  let gen = 0
  if (parents.length > 0) {
    const gensBytes = await store.get(PARENT_GENS(commit))
    const gens = gensBytes === null ? null : safeLoads(gensBytes)
    if (!Array.isArray(gens) || gens.length !== parents.length) {
      throw new Error(`applyWire: commit ${commit} has no parent generations recorded`)
    }
    gen = generationOf(gens as number[])
  }
  cache.set(commit, gen)
  return gen
}

function dumpsText(value: unknown): string {
  return JSON.stringify(value ?? null)
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
