/**
 * `Live` — in-process state backend. A thin async wrapper around a
 * `Map<string, unknown>`.
 *
 * Use cases:
 * - **Tests** that don't want kvgit overhead.
 * - **Ephemeral agents** whose results don't need to survive a
 *   process restart.
 * - **Default fallback** when no `StateConfig` is provided.
 *
 * `Live` deliberately does NOT implement `VersionedStateBackend` —
 * it has no commits, no branches, no merges. The agent's persistence
 * APIs check at runtime via `isVersioned()` and degrade gracefully
 * (e.g. `state.checkout(hash)` returns `null` against `Live`).
 */

import type { StateBackend } from './backend'

export class Live implements StateBackend {
  readonly #data = new Map<string, unknown>()

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.#data.get(key) as T | undefined
  }

  set<T = unknown>(key: string, value: T): void {
    this.#data.set(key, value)
  }

  delete(key: string): void {
    this.#data.delete(key)
  }

  async has(key: string): Promise<boolean> {
    return this.#data.has(key)
  }

  async *keys(): AsyncIterable<string> {
    // Snapshot the key set so concurrent mutations during iteration
    // don't surface ConcurrentModificationException-style issues.
    // Mirrors how kvgit's Staged.keys() behaves.
    for (const k of [...this.#data.keys()]) yield k
  }

  /** Test/inspection helper — returns the current size without
   *  iterating. Not part of `StateBackend`. */
  get size(): number {
    return this.#data.size
  }
}
