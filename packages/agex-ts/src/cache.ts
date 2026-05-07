/**
 * `CacheImpl` — typed Map-shaped cache backed by a `StateBackend`.
 *
 * The `StateBackend` handed in is already session-scoped (one
 * `VersionedKV` per session at the substrate layer), so this cache
 * uses a plain static prefix (`cache/`) to keep its keyspace separate
 * from the event log within the same store. No session id appears in
 * the key — sessions are isolated below this layer.
 *
 * `set` is exposed as `Promise<void>` to match the agent-facing
 * interface (which crosses the worker boundary in the runtime
 * adapter case). The underlying `StateBackend.set` is sync;
 * resolving the Promise is immediate.
 */

import type { StateBackend } from './state/backend'
import type { Cache } from './types'

const KEY_PREFIX = 'cache/'

export class CacheImpl implements Cache {
  readonly #state: StateBackend
  readonly #session: string

  constructor(state: StateBackend, session: string) {
    this.#state = state
    this.#session = session
  }

  /** Session id this cache is scoped to. */
  get session(): string {
    return this.#session
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.#state.set(KEY_PREFIX + key, value)
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.#state.get<T>(KEY_PREFIX + key)
  }

  async has(key: string): Promise<boolean> {
    return this.#state.has(KEY_PREFIX + key)
  }

  async delete(key: string): Promise<boolean> {
    if (!(await this.#state.has(KEY_PREFIX + key))) return false
    this.#state.delete(KEY_PREFIX + key)
    return true
  }

  async keys(): Promise<ReadonlyArray<string>> {
    const out: string[] = []
    for await (const k of this.#state.keys()) {
      if (k.startsWith(KEY_PREFIX)) out.push(k.slice(KEY_PREFIX.length))
    }
    return out.sort()
  }
}
