/**
 * The Remote protocol: how two kvgit histories exchange commits.
 *
 * A remote is a far peer that stores history and exposes refs — NOT a
 * `KVStore` backend (that's the near-storage boundary; see the README's
 * "Sync & remotes" section). The protocol is deliberately minimal:
 * list refs, fetch a delta, push a delta with compare-and-swap ref
 * advancement. Merge is absent by design — reconciliation always
 * happens locally, so a remote can be *passive*: any object store
 * with CAS-able refs qualifies, and no kvgit code needs to run on the
 * far side.
 *
 * `MemoryRemote` is the reference implementation (and test double): a
 * kvgit object store plus branch-head refs, composed directly from
 * `walkDelta` + `applyWire`. Real transports (GitHub Git Data API)
 * implement the same interface over the wire; bundles are the
 * degenerate case (a one-shot `fetch` with `have = ∅`).
 */

import type { KVStore, WireCommit } from '../types'
import {
  BRANCH_HEAD,
  BRANCH_HEAD_PREFIX,
  COMMIT_ROOT,
  dumps,
  readBranchHead,
} from '../versioned/layout'
import { applyWire } from './apply'
import { walkDelta } from './walk'

/** One remote branch pointer. */
export interface RemoteRef {
  branch: string
  /** kvgit commit hash at the remote branch's tip. */
  head: string
}

export interface Remote {
  /** Current branch → head pointers on the remote. */
  listRefs(): Promise<RemoteRef[]>

  /**
   * Commits reachable from `want` but not from any of `have`, in
   * topological order (parents first). `have` hashes the remote can't
   * resolve contribute nothing to the exclusion (conservative
   * re-send — transfers are idempotent).
   */
  fetch(want: string, have: Iterable<string>): AsyncIterable<WireCommit>

  /**
   * Store `commits` and advance the branch ref to `newHead` iff the
   * ref currently equals `expectedOld` (`null` = "branch must not
   * exist"). Returns false — with the ref unmoved — when the CAS
   * loses; stored objects may remain (content-addressed, harmless).
   */
  push(
    branch: string,
    expectedOld: string | null,
    newHead: string,
    commits: AsyncIterable<WireCommit> | Iterable<WireCommit>,
  ): Promise<boolean>
}

/**
 * In-memory reference Remote: a kvgit object store with branch-head
 * refs, on any `KVStore` (tests pass `Memory`). Verifies integrity on
 * push as a side effect of replaying via `applyWire` — a property
 * passive transports won't have (their receivers verify on fetch
 * instead).
 */
export class MemoryRemote implements Remote {
  readonly store: KVStore

  constructor(store: KVStore) {
    this.store = store
  }

  async listRefs(): Promise<RemoteRef[]> {
    const out: RemoteRef[] = []
    for await (const k of this.store.keys(BRANCH_HEAD_PREFIX)) {
      const branch = k.slice(BRANCH_HEAD_PREFIX.length)
      if (branch.length === 0) continue
      const head = await readBranchHead(this.store, branch)
      if (head !== null) out.push({ branch, head })
    }
    return out.sort((a, b) => (a.branch < b.branch ? -1 : 1))
  }

  fetch(want: string, have: Iterable<string>): AsyncIterable<WireCommit> {
    return walkDelta(this.store, { want, have })
  }

  async push(
    branch: string,
    expectedOld: string | null,
    newHead: string,
    commits: AsyncIterable<WireCommit> | Iterable<WireCommit>,
  ): Promise<boolean> {
    await applyWire(this.store, commits)
    // The stream must have delivered (or the store already held) the
    // commit the ref is about to point at.
    if ((await this.store.get(COMMIT_ROOT(newHead))) === null) {
      throw new Error(`MemoryRemote: pushed head ${newHead} not present after apply`)
    }
    const expected = expectedOld === null ? null : dumps(expectedOld)
    return this.store.cas(BRANCH_HEAD(branch), dumps(newHead), expected)
  }
}
