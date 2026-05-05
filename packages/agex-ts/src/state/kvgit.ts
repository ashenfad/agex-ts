/**
 * `KvgitState` — `VersionedStateBackend` wrapping a kvgit-ts `Staged`.
 *
 * Reads / writes go straight through to the staging buffer; `commit()`
 * flushes them as one versioned commit (with three-way merge if HEAD
 * has moved). `currentCommit` reads the underlying Versioned's HEAD.
 *
 * Sessions get their own `Namespaced` view of the same root, so two
 * sessions writing under the same agent don't collide. That wiring
 * lives in the host-side persistence APIs, not here.
 */

import type { Staged } from 'kvgit-ts'
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
}
