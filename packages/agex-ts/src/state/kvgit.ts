/**
 * `KvgitState` — `VersionedStateBackend` wrapping a @agex-ts/kvgit `Staged`.
 *
 * Reads / writes go straight through to the staging buffer; `commit()`
 * flushes them as one versioned commit (with three-way merge if HEAD
 * has moved). `currentCommit` reads the underlying Versioned's HEAD.
 *
 * Sessions get their own `Namespaced` view of the same root, so two
 * sessions writing under the same agent don't collide. That wiring
 * lives in the host-side persistence APIs, not here.
 */

import type { CommitInfo, Staged, Versioned } from '@agex-ts/kvgit'
import type { VersionedStateBackend } from './backend'

export class KvgitState implements VersionedStateBackend {
  readonly #staged: Staged

  constructor(staged: Staged) {
    this.#staged = staged
  }

  /** Expose the underlying Staged so callers can reach kvgit-specific
   *  surface (branches, history walks, etc.). */
  get staged(): Staged {
    return this.#staged
  }

  get currentCommit(): string | null {
    return this.#staged.currentCommit
  }

  get hasChanges(): boolean {
    return this.#staged.hasChanges
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.#staged.get<T>(key)
  }

  set<T = unknown>(key: string, value: T): void {
    this.#staged.set(key, value)
  }

  delete(key: string): void {
    this.#staged.delete(key)
  }

  async has(key: string): Promise<boolean> {
    return this.#staged.has(key)
  }

  keys(): AsyncIterable<string> {
    return this.#staged.keys()
  }

  async commit(opts: { info?: Readonly<Record<string, unknown>> } = {}): Promise<string | null> {
    if (!this.#staged.hasChanges) return this.#staged.currentCommit
    const result = await this.#staged.commit({
      ...(opts.info !== undefined && { info: opts.info as Record<string, unknown> }),
    })
    return result.commit ?? this.#staged.currentCommit
  }

  /** Pass through to the underlying VersionedKV. Returns commit
   *  metadata (info dict + parents) at `hash`, or current HEAD if
   *  omitted. Returns `null` if the hash doesn't exist. */
  async commitInfo(hash?: string): Promise<CommitInfo | null> {
    return this.#staged.versioned.commitInfo(hash)
  }

  /** Walk commit hashes from `hash` (or HEAD) backward through
   *  the history. Pass through to the underlying VersionedKV. */
  history(hash?: string, opts: { allParents?: boolean } = {}): AsyncIterable<string> {
    return this.#staged.versioned.history(hash, opts)
  }

  /** Open a read-only view at a historical commit. Returns the
   *  underlying `Versioned`; callers wrap with their own `Staged`
   *  if they need write semantics. */
  async checkoutAt(hash: string): Promise<Versioned | null> {
    return this.#staged.versioned.checkout(hash)
  }
}
