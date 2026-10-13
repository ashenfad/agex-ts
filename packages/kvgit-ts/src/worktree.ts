/**
 * Worktree: a branch checked out for work, as Python kvgit 0.4 shapes
 * it.
 */

import { UnknownCommitError } from './errors'
import type { Repo } from './repo'
import type { BytesMergeFn, CommitInfo, MergeFn, MergeResult } from './types'
import type { VersionedKV } from './versioned/kv'

/** A worktree's pending changes: keys written and keys deleted since
 *  its last commit. */
export class Status {
  constructor(
    readonly updated: ReadonlySet<string>,
    readonly removed: ReadonlySet<string>,
  ) {}

  /** No pending changes. */
  get clean(): boolean {
    return this.updated.size === 0 && this.removed.size === 0
  }
}

export interface WorktreeCommitOptions<V> {
  /** Commit only these pending keys and leave the rest pending. */
  keys?: Iterable<string>
  info?: CommitInfo
  /** What a conflict the merge rules can't resolve does: `'raise'`
   *  (default) throws `MergeConflict`; `'abandon'` returns a result
   *  with `merged: false` and leaves the changes pending. */
  onConflict?: 'raise' | 'abandon'
  /** Merge functions by key, for this call. */
  mergeFns?: ReadonlyMap<string, MergeFn<V>>
  /** The merge function for keys no other rule covers, for this call. */
  defaultMerge?: MergeFn<V>
}

/**
 * A branch checked out for work: a map whose writes stay pending until
 * {@link commit}.
 *
 * Bound to one branch for its whole life. Reads see pending changes on
 * top of the commit the worktree is based on ({@link head}). Several
 * worktrees, in one process or many, may hold the same branch; a
 * commit that loses the race to another merges automatically, and
 * throws only when the two changed the same key in ways no merge rule
 * resolves.
 *
 * Obtain one from `Repo.worktree`.
 */
export class Worktree<V = Uint8Array> {
  readonly repo: Repo<V>
  readonly #engine: VersionedKV
  readonly #updates = new Map<string, V>()
  readonly #removals = new Set<string>()
  readonly #cache = new Map<string, V>()
  readonly #mergeFns = new Map<string, MergeFn<V>>()
  #defaultMerge: MergeFn<V> | undefined

  /** @internal Made by `Repo.worktree`. */
  constructor(repo: Repo<V>, engine: VersionedKV) {
    this.repo = repo
    this.#engine = engine
  }

  /** The branch this worktree is bound to. */
  get branch(): string {
    return this.#engine.currentBranch
  }

  /**
   * The commit this worktree is based on. The branch itself may have
   * moved on since, if another worktree committed to it;
   * `repo.branches.get(wt.branch)` reads the branch's tip.
   */
  get head(): string {
    return this.#engine.currentCommit
  }

  // --- Reads ---

  /** A value, pending changes included; undefined if absent. */
  async get(key: string): Promise<V | undefined> {
    if (this.#removals.has(key)) return undefined
    if (this.#updates.has(key)) return this.#updates.get(key)
    if (this.#cache.has(key)) return this.#cache.get(key)
    const raw = await this.#engine.get(key)
    if (raw === null) return undefined
    const value = this.repo.codec.decode(raw)
    this.#cache.set(key, value)
    return value
  }

  /** The values of the given keys that exist, pending changes included. */
  async getMany(keys: Iterable<string>): Promise<Map<string, V>> {
    const out = new Map<string, V>()
    const fetch: string[] = []
    for (const key of keys) {
      if (this.#removals.has(key)) continue
      if (this.#updates.has(key)) out.set(key, this.#updates.get(key) as V)
      else if (this.#cache.has(key)) out.set(key, this.#cache.get(key) as V)
      else fetch.push(key)
    }
    if (fetch.length > 0) {
      for (const [key, raw] of await this.#engine.getMany(fetch)) {
        const value = this.repo.codec.decode(raw)
        this.#cache.set(key, value)
        out.set(key, value)
      }
    }
    return out
  }

  async has(key: string): Promise<boolean> {
    if (this.#removals.has(key)) return false
    if (this.#updates.has(key)) return true
    return this.#engine.has(key)
  }

  /** Every key visible here, sorted: committed, plus pending, minus
   *  deleted. */
  async keys(): Promise<string[]> {
    const seen = new Set<string>()
    for await (const key of this.#engine.keys()) {
      if (!this.#removals.has(key)) seen.add(key)
    }
    for (const key of this.#updates.keys()) seen.add(key)
    return [...seen].sort()
  }

  // --- Writes ---

  /** Write a value; it stays pending until {@link commit}. */
  set(key: string, value: V): void {
    this.#removals.delete(key)
    this.#updates.set(key, value)
  }

  /**
   * Delete a key; the deletion stays pending until {@link commit}.
   *
   * @returns false if the key was not there.
   */
  async delete(key: string): Promise<boolean> {
    if (!(await this.has(key))) return false
    this.#updates.delete(key)
    // A key written only in pending changes has nothing committed to
    // remove: dropping the pending write is the whole deletion.
    if (await this.#engine.has(key)) this.#removals.add(key)
    return true
  }

  /** The changes pending since this worktree's last commit. */
  status(): Status {
    return new Status(new Set(this.#updates.keys()), new Set(this.#removals))
  }

  // --- Merge rules ---

  /** Register a merge function for one key. A worktree's rules sit over
   *  the repository's defaults and under a single call's. */
  setMergeFn(key: string, fn: MergeFn<V>): void {
    this.#mergeFns.set(key, fn)
  }

  /** Register the merge function for keys no other rule covers. */
  setDefaultMerge(fn: MergeFn<V>): void {
    this.#defaultMerge = fn
  }

  // --- Commit ---

  /**
   * Commit the pending changes to the branch.
   *
   * Fast-forwards when the branch has not moved since this worktree's
   * head; otherwise three-way merges onto its tip with the effective
   * merge rules.
   *
   * @throws MergeConflict for keys both sides changed that no rule
   *   resolves (unless `onConflict: 'abandon'`).
   * @throws ConcurrencyError if the branch moved again mid-merge.
   * @throws UnknownBranchError if the branch was deleted.
   */
  async commit(opts: WorktreeCommitOptions<V> = {}): Promise<MergeResult> {
    const only = opts.keys === undefined ? null : new Set(opts.keys)
    const updates = new Map<string, Uint8Array>()
    for (const [key, value] of this.#updates) {
      if (only === null || only.has(key)) updates.set(key, this.repo.codec.encode(value))
    }
    const removals = new Set<string>()
    for (const key of this.#removals) {
      if (only === null || only.has(key)) removals.add(key)
    }

    const fns = new Map<string, MergeFn<V>>([
      ...this.repo.mergeFns,
      ...this.#mergeFns,
      ...(opts.mergeFns ?? []),
    ])
    const fallback = opts.defaultMerge ?? this.#defaultMerge ?? this.repo.defaultMerge
    const result = await this.#engine.commit({
      ...(updates.size > 0 && { updates }),
      ...(removals.size > 0 && { removals }),
      onConflict: opts.onConflict === 'abandon' ? 'skip' : 'raise',
      ...(fns.size > 0 && {
        mergeFns: new Map([...fns].map(([k, fn]) => [k, this.lower(fn)])),
      }),
      ...(fallback !== undefined && { defaultMerge: this.lower(fallback) }),
      ...(opts.info !== undefined && { info: opts.info }),
    })

    if (result.merged) {
      if (only === null) {
        this.#updates.clear()
        this.#removals.clear()
      } else {
        for (const key of only) {
          this.#updates.delete(key)
          this.#removals.delete(key)
        }
      }
      // The head moved, and a merge may have changed other keys.
      this.#cache.clear()
    }
    return result
  }

  /** A merge function over values, as the bytes-level merge takes it:
   *  each side decoded with the repository's codec, the result encoded
   *  back with it. */
  private lower(fn: MergeFn<V>): BytesMergeFn {
    const { codec } = this.repo
    return (old, ours, theirs) =>
      codec.encode(
        fn(
          old === null ? null : codec.decode(old),
          ours === null ? null : codec.decode(ours),
          theirs === null ? null : codec.decode(theirs),
        ),
      )
  }

  // --- Moving ---

  /** Drop every pending change. */
  discard(): void {
    this.#updates.clear()
    this.#removals.clear()
    this.#cache.clear()
  }

  /**
   * Move the branch to `commit` and drop pending changes. The commit
   * the branch left stays in its history only if something else
   * reaches it.
   *
   * @throws UnknownCommitError if `commit` is not in the store.
   * @throws UnknownBranchError if the branch was deleted.
   */
  async reset(commit: string): Promise<void> {
    if (!(await this.#engine.resetTo(commit))) throw new UnknownCommitError(commit)
    this.discard()
  }

  /**
   * Move to the branch's current tip, dropping pending changes.
   *
   * @throws UnknownBranchError if the branch was deleted.
   * @throws CorruptHeadError if its HEAD is damaged beyond recovery.
   */
  async refresh(): Promise<void> {
    await this.#engine.refresh()
    this.discard()
  }
}
