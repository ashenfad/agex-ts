/**
 * Delta walk: translate a slice of kvgit history into wire form.
 *
 * `walkDelta` yields the commits reachable from `want` but not from
 * any commit in `have`, as `WireCommit`s in topological order (parents
 * before children). This is the sender side of every transfer:
 *
 *   - sync push: `have` = the remote-tracking head
 *   - sync fetch (served locally): `have` = the requester's heads
 *   - bundle export: `have` = ∅ (full history)
 *
 * Works directly on a `KVStore` using the v1 storage layout
 * (`versioned/layout.ts`) rather than a `Versioned` instance — the
 * walk is a pure read over committed state and shouldn't be entangled
 * with a working tree's branch/HEAD bookkeeping.
 *
 * Cost: O(delta) store reads. Per emitted commit, the keyset diff vs
 * the first parent is structural (`Keyset.diff` skips shared subtrees
 * by hash), so work is proportional to changed keys, not keyset size.
 */

import { Keyset } from '../keyset'
import type { CommitInfo, KVStore, WireCommit } from '../types'
import {
  COMMIT_ROOT,
  COMMIT_TIME,
  INFO_KEY,
  PARENT_COMMIT,
  blobPointerOwner,
  loads,
  safeLoads,
} from '../versioned/layout'

export interface WalkDeltaOptions {
  /** Commit hash to walk back from (typically a branch HEAD). */
  want: string
  /** Commits the receiver already has. Their full ancestries are
   *  excluded from the walk. Empty/omitted = full history. */
  have?: Iterable<string>
}

/** Loaded-per-commit record cache built during the reachability pass. */
interface CommitRecord {
  parents: readonly string[]
  time: number
}

/**
 * Yield `WireCommit`s for every commit reachable from `want` but not
 * from `have`, parents before children.
 *
 * Throws if `want` (or any commit record in the delta) is missing from
 * the store — a partial history is not a valid transfer source.
 */
export async function* walkDelta(
  store: KVStore,
  opts: WalkDeltaOptions,
): AsyncIterable<WireCommit> {
  const { want } = opts

  // Phase 1: everything the receiver already has. Missing commits are
  // tolerated here — `have` reflects the receiver's claims, and a
  // hash we can't resolve simply contributes nothing to the skip set.
  const haveSet = new Set<string>()
  for (const h of opts.have ?? []) {
    await collectAncestors(store, h, haveSet, { tolerateMissing: true })
  }

  if (haveSet.has(want)) return

  // Phase 2: the delta — ancestors of `want` minus `haveSet`. Strict:
  // a missing record inside the delta means we can't produce a valid
  // transfer.
  const missing = new Map<string, CommitRecord>()
  await collectDelta(store, want, haveSet, missing)

  // Phase 3: topological order via Kahn's algorithm. In-degree counts
  // only parents inside the delta (parents in `haveSet` — or beyond a
  // tolerated-missing horizon — are already satisfied receiver-side).
  // Ready commits are popped oldest-first (time, then hash) so output
  // order is deterministic for a given history.
  const inDegree = new Map<string, number>()
  const children = new Map<string, string[]>()
  for (const [hash, rec] of missing) {
    let deg = 0
    for (const p of rec.parents) {
      if (!missing.has(p)) continue
      deg++
      let kids = children.get(p)
      if (kids === undefined) {
        kids = []
        children.set(p, kids)
      }
      kids.push(hash)
    }
    inDegree.set(hash, deg)
  }

  const byAge = (a: string, b: string): number => {
    const ta = (missing.get(a) as CommitRecord).time
    const tb = (missing.get(b) as CommitRecord).time
    if (ta !== tb) return ta - tb
    return a < b ? -1 : 1
  }
  const ready: string[] = []
  for (const [hash, deg] of inDegree) {
    if (deg === 0) ready.push(hash)
  }
  ready.sort(byAge)

  let emitted = 0
  while (ready.length > 0) {
    const hash = ready.shift() as string
    const rec = missing.get(hash) as CommitRecord
    yield await buildWireCommit(store, hash, rec)
    emitted++
    for (const child of children.get(hash) ?? []) {
      const deg = (inDegree.get(child) as number) - 1
      inDegree.set(child, deg)
      if (deg === 0) {
        // Insert keeping the ready list age-sorted; delta sets are
        // small enough that a linear scan beats a heap in practice.
        const at = ready.findIndex((r) => byAge(child, r) < 0)
        if (at === -1) ready.push(child)
        else ready.splice(at, 0, child)
      }
    }
  }

  if (emitted !== missing.size) {
    // Parent cycles are impossible in content-addressed history unless
    // the store is corrupt — fail loudly rather than emit a partial walk.
    throw new Error(
      `walkDelta: cycle detected in commit graph (emitted ${emitted}/${missing.size})`,
    )
  }
}

/** Walk all parents (iterative DFS — traversal order is irrelevant
 *  for set collection), adding every reachable commit to `into`. */
async function collectAncestors(
  store: KVStore,
  start: string,
  into: Set<string>,
  opts: { tolerateMissing: boolean },
): Promise<void> {
  const stack: string[] = [start]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (into.has(current)) continue
    const parents = await loadParents(store, current)
    if (parents === null) {
      if (opts.tolerateMissing) continue
      throw new Error(`walkDelta: commit record missing for ${current}`)
    }
    into.add(current)
    for (const p of parents) {
      if (!into.has(p)) stack.push(p)
    }
  }
}

/** Walk from `want` (iterative DFS), stopping at `haveSet`, recording
 *  commit records. Output order doesn't matter — Kahn re-orders. */
async function collectDelta(
  store: KVStore,
  want: string,
  haveSet: ReadonlySet<string>,
  into: Map<string, CommitRecord>,
): Promise<void> {
  const stack: string[] = [want]
  while (stack.length > 0) {
    const current = stack.pop() as string
    if (into.has(current) || haveSet.has(current)) continue
    const parents = await loadParents(store, current)
    if (parents === null) {
      throw new Error(`walkDelta: commit record missing for ${current}`)
    }
    const timeRaw = await store.get(COMMIT_TIME(current))
    const time = timeRaw !== null ? safeLoads(timeRaw) : null
    into.set(current, {
      parents,
      time: typeof time === 'number' ? time : 0,
    })
    for (const p of parents) {
      if (!into.has(p) && !haveSet.has(p)) stack.push(p)
    }
  }
}

/** Load a commit's parent list, or null if the record is absent. */
async function loadParents(store: KVStore, commit: string): Promise<readonly string[] | null> {
  const raw = await store.get(PARENT_COMMIT(commit))
  if (raw === null) return null
  const parsed = safeLoads(raw)
  if (typeof parsed === 'string') return [parsed]
  if (Array.isArray(parsed)) return parsed.filter((p): p is string => typeof p === 'string')
  return []
}

/** Diff a commit's keyset against its first parent and classify. */
async function buildWireCommit(
  store: KVStore,
  hash: string,
  rec: CommitRecord,
): Promise<WireCommit> {
  const firstParent = rec.parents[0]
  const [commitKs, parentKs] = await Promise.all([
    loadKeysetAt(store, hash),
    firstParent !== undefined ? loadKeysetAt(store, firstParent) : Keyset.empty(store),
  ])
  if (commitKs === null) {
    throw new Error(`walkDelta: commit root missing for ${hash}`)
  }
  if (parentKs === null) {
    throw new Error(`walkDelta: commit root missing for ${firstParent}`)
  }

  const diff = await parentKs.diff(commitKs)

  const updates = new Map<string, Uint8Array>()
  const removals = new Set<string>()
  const meta = new Map<string, { readonly createdAt: number }>()
  const carries = new Map<string, string>()

  // added/modified relative to the first parent: written here (owner
  // is this commit) → updates; otherwise adopted from another ancestor
  // (the non-first parent's side of a merge) → carries.
  const changed: Array<readonly [string, string, number]> = []
  for (const [key, entry] of diff.added) changed.push([key, entry.blob, entry.meta.createdAt])
  for (const [key, [, entry]] of diff.modified)
    changed.push([key, entry.blob, entry.meta.createdAt])

  // Partition by pointer ownership first, then batch-fetch the owned
  // blobs in one getMany — one round trip instead of one per key on
  // high-latency stores.
  const owned: Array<readonly [string, string, number]> = []
  for (const [key, pointer, createdAt] of changed) {
    const owner = blobPointerOwner(pointer)
    if (owner === hash) owned.push([key, pointer, createdAt])
    else carries.set(key, owner)
  }
  if (owned.length > 0) {
    const fetched = await store.getMany(owned.map(([, pointer]) => pointer))
    for (const [key, pointer, createdAt] of owned) {
      const bytes = fetched.get(pointer)
      if (bytes === undefined) {
        throw new Error(`walkDelta: blob missing for ${pointer}`)
      }
      updates.set(key, bytes)
      meta.set(key, { createdAt })
    }
  }
  for (const key of diff.removed.keys()) removals.add(key)

  const infoRaw = await store.get(INFO_KEY(hash))
  const info = infoRaw !== null ? (loads(infoRaw) as CommitInfo) : null

  return {
    hash,
    parents: rec.parents,
    time: rec.time,
    info,
    updates,
    removals,
    meta,
    carries,
  }
}

/** Open the keyset at a commit, or null if the commit root is absent. */
async function loadKeysetAt(store: KVStore, commit: string): Promise<Keyset | null> {
  const rootBytes = await store.get(COMMIT_ROOT(commit))
  if (rootBytes === null) return null
  return Keyset.fromRoot(store, loads(rootBytes) as string)
}
