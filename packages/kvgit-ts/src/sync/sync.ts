/**
 * Sync orchestration: pull / push / sync a branch against a Remote.
 *
 * Policy (v1, deliberate):
 * - **Fast-forward only.** A ref moves only along its own ancestry —
 *   local on pull, remote on push. When both sides hold commits the
 *   other lacks, the result is `'diverged'`: objects may transfer
 *   (useful for a later merge), but no ref moves and nothing merges.
 *   Reconciliation is an explicit, local act the caller performs with
 *   kvgit's existing three-way machinery, then syncs again.
 * - **Lifecycle conflicts surface, never resolve silently.** A remote
 *   ref that vanishes after a prior sync (`'remote-gone'`) means
 *   someone deleted/archived the branch elsewhere; the caller decides.
 * - **CAS races retry once.** A lost push CAS means the remote moved
 *   between classification and push; one re-classification handles
 *   the benign case (someone else pushed commits we already have),
 *   anything else is `'diverged'`.
 *
 * Remote-tracking (`__sync_head__<branch>`) records the last head
 * known shared with the remote. It advances on successful syncs and
 * is the `have` frontier for delta computation; it never advances on
 * divergence.
 *
 * Note: a fast-forwarded local ref does not refresh live `VersionedKV`
 * instances — callers holding one should `refresh()` after a pull
 * that reports movement.
 */

import type { KVStore, WireCommit } from '../types'
import {
  BRANCH_HEAD,
  BRANCH_HEAD_PREV,
  COMMIT_ROOT,
  PARENT_COMMIT,
  dumps,
  readBranchHead,
  safeLoads,
} from '../versioned/layout'
import { applyWire, getSyncHead, setSyncHead } from './apply'
import type { Remote } from './remote'
import { walkDelta } from './walk'

export type SyncStatus =
  | 'up-to-date'
  | 'fast-forwarded' // pull moved the local ref
  | 'pushed' // push moved the remote ref
  | 'created' // pull created the local branch / push created the remote one
  | 'diverged' // both sides hold unshared commits; no refs moved
  | 'remote-gone' // remote ref vanished after a prior sync (lifecycle conflict)

export interface SyncResult {
  status: SyncStatus
  branch: string
  /** Local branch head after the operation (null = branch absent). */
  localHead: string | null
  /** Remote branch head as last observed (null = ref absent). */
  remoteHead: string | null
  /** Wire commits transferred (applied on pull, sent on push). */
  transferred: number
}

/** Combined pull-then-push outcome from `syncBranch`. */
export interface SyncOutcome {
  /** The most significant of the two phases; `'diverged'` /
   *  `'remote-gone'` short-circuit (push is skipped, `push: null`). */
  status: SyncStatus
  pull: SyncResult
  push: SyncResult | null
}

/**
 * Pull `branch` from `remote`: fetch missing commits and fast-forward
 * (or create) the local branch ref.
 */
export async function pullBranch(
  store: KVStore,
  remote: Remote,
  branch: string,
): Promise<SyncResult> {
  const remoteHead = await readRemoteHead(remote, branch)
  const localHead = await readBranchHead(store, branch)
  const syncHead = await getSyncHead(store, branch)
  const result = (status: SyncStatus, transferred = 0): SyncResult => ({
    status,
    branch,
    localHead,
    remoteHead,
    transferred,
  })

  if (remoteHead === null) {
    // Nothing remote: a prior sync means the ref was deleted/archived
    // elsewhere; otherwise there's simply nothing to pull.
    return syncHead !== null ? result('remote-gone') : result('up-to-date')
  }
  if (remoteHead === localHead) {
    if (syncHead !== remoteHead) await setSyncHead(store, branch, remoteHead)
    return result('up-to-date')
  }

  // Local strictly ahead (remote head already in our ancestry):
  // nothing to pull — advancing the remote is pushBranch's job.
  if (
    localHead !== null &&
    (await store.get(COMMIT_ROOT(remoteHead))) !== null &&
    (await isAncestor(store, remoteHead, localHead))
  ) {
    return result('up-to-date')
  }

  // Fetch the delta relative to everything we can claim.
  const have: string[] = []
  if (localHead !== null) have.push(localHead)
  if (syncHead !== null && syncHead !== localHead) have.push(syncHead)
  const applied = await applyWire(store, remote.fetch(remoteHead, have))

  if (localHead === null) {
    const ok = await store.cas(BRANCH_HEAD(branch), dumps(remoteHead), null)
    if (!ok) return result('diverged', applied.applied) // local creation race
    await setSyncHead(store, branch, remoteHead)
    return { ...result('created', applied.applied), localHead: remoteHead }
  }

  if (await isAncestor(store, localHead, remoteHead)) {
    // Fast-forward, with the same prev-HEAD backup discipline as
    // VersionedKV's casHead.
    await store.set(BRANCH_HEAD_PREV(branch), dumps(localHead))
    const ok = await store.cas(BRANCH_HEAD(branch), dumps(remoteHead), dumps(localHead))
    if (!ok) return result('diverged', applied.applied) // local writer race
    await setSyncHead(store, branch, remoteHead)
    return { ...result('fast-forwarded', applied.applied), localHead: remoteHead }
  }

  // Both sides advanced. Objects are stored (handy for a later
  // merge); refs and sync head stay put.
  return result('diverged', applied.applied)
}

/**
 * Push `branch` to `remote`: send missing commits and fast-forward
 * (or create) the remote branch ref via CAS.
 */
export async function pushBranch(
  store: KVStore,
  remote: Remote,
  branch: string,
): Promise<SyncResult> {
  const localHead = await readBranchHead(store, branch)
  if (localHead === null) {
    throw new Error(`pushBranch: local branch '${branch}' does not exist`)
  }
  const syncHead = await getSyncHead(store, branch)

  // One retry: a lost CAS means the remote moved under us; re-observe
  // and re-classify once before declaring divergence.
  for (let attempt = 0; attempt < 2; attempt++) {
    const remoteHead = await readRemoteHead(remote, branch)
    const result = (status: SyncStatus, transferred = 0): SyncResult => ({
      status,
      branch,
      localHead,
      remoteHead,
      transferred,
    })

    if (remoteHead === localHead) {
      if (syncHead !== localHead) await setSyncHead(store, branch, localHead)
      return result('up-to-date')
    }

    if (remoteHead === null) {
      if (syncHead !== null) return result('remote-gone')
      const counter = { n: 0 }
      const ok = await remote.push(
        branch,
        null,
        localHead,
        counted(walkDelta(store, { want: localHead }), counter),
      )
      if (ok) {
        await setSyncHead(store, branch, localHead)
        return result('created', counter.n)
      }
      continue // creation race — re-classify
    }

    // Remote moved past our tracking: safe only if its head is
    // already in our ancestry (e.g. another device pushed, we pulled,
    // then committed on top — or a sibling tab pushed for us).
    if (
      (await store.get(COMMIT_ROOT(remoteHead))) !== null &&
      (await isAncestor(store, remoteHead, localHead))
    ) {
      const counter = { n: 0 }
      const ok = await remote.push(
        branch,
        remoteHead,
        localHead,
        counted(walkDelta(store, { want: localHead, have: [remoteHead] }), counter),
      )
      if (ok) {
        await setSyncHead(store, branch, localHead)
        return result('pushed', counter.n)
      }
      continue // CAS race — re-classify
    }

    return result('diverged')
  }

  return {
    status: 'diverged',
    branch,
    localHead,
    remoteHead: await readRemoteHead(remote, branch),
    transferred: 0,
  }
}

/**
 * Pull then push. Divergence or a lifecycle conflict on the pull
 * short-circuits (push is skipped — pushing would fail the same way).
 */
export async function syncBranch(
  store: KVStore,
  remote: Remote,
  branch: string,
): Promise<SyncOutcome> {
  const pull = await pullBranch(store, remote, branch)
  if (pull.status === 'diverged' || pull.status === 'remote-gone') {
    return { status: pull.status, pull, push: null }
  }
  const push = await pushBranch(store, remote, branch)
  const status = push.status === 'up-to-date' ? pull.status : push.status
  return { status, pull, push }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readRemoteHead(remote: Remote, branch: string): Promise<string | null> {
  const refs = await remote.listRefs()
  return refs.find((r) => r.branch === branch)?.head ?? null
}

/** Is `ancestor` reachable from `from` (inclusive) in local history? */
async function isAncestor(store: KVStore, ancestor: string, from: string): Promise<boolean> {
  if (ancestor === from) return true
  const seen = new Set<string>([from])
  const stack: string[] = [from]
  while (stack.length > 0) {
    const current = stack.pop() as string
    const raw = await store.get(PARENT_COMMIT(current))
    if (raw === null) continue // unreachable record — treat as a root
    const parsed = safeLoads(raw)
    const parents = Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === 'string')
      : typeof parsed === 'string'
        ? [parsed]
        : []
    for (const p of parents) {
      if (p === ancestor) return true
      if (!seen.has(p)) {
        seen.add(p)
        stack.push(p)
      }
    }
  }
  return false
}

/** Pass-through that counts yielded wire commits (for `transferred`). */
async function* counted(
  iter: AsyncIterable<WireCommit>,
  counter: { n: number },
): AsyncIterable<WireCommit> {
  for await (const wc of iter) {
    counter.n++
    yield wc
  }
}
