/**
 * `CacheImpl` — typed Map-shaped cache backed by a `StateBackend`,
 * scoped to one session via key prefix.
 *
 * Layout: every entry lives at `cache/<session>/<userKey>`. Sharing
 * the agent's state backend means the cache participates in the same
 * commit cycle as the event log — when the agent commits, all three
 * (events + cache + future per-session FS state) land in one atomic
 * versioned commit.
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
  readonly #prefix: string

  constructor(state: StateBackend, session: string) {
    this.#state = state
    this.#session = session
    this.#prefix = `${KEY_PREFIX}${session}/`
  }

  /** Session id this cache is scoped to. */
  get session(): string {
    return this.#session
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.#state.set(this.#prefix + key, value)
  }

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.#state.get<T>(this.#prefix + key)
  }

  async has(key: string): Promise<boolean> {
    return this.#state.has(this.#prefix + key)
  }

  async delete(key: string): Promise<boolean> {
    if (!(await this.#state.has(this.#prefix + key))) return false
    this.#state.delete(this.#prefix + key)
    return true
  }

  async keys(): Promise<ReadonlyArray<string>> {
    const out: string[] = []
    for await (const k of this.#state.keys()) {
      if (k.startsWith(this.#prefix)) out.push(k.slice(this.#prefix.length))
    }
    return out.sort()
  }
}

/** Per-session cache cache (yes). Lazily creates and reuses a
 *  `CacheImpl` per session id over the same underlying state. */
export class CacheManager {
  readonly #state: StateBackend
  readonly #cache = new Map<string, CacheImpl>()

  constructor(state: StateBackend) {
    this.#state = state
  }

  cache(session: string): CacheImpl {
    const cached = this.#cache.get(session)
    if (cached !== undefined) return cached
    const fresh = new CacheImpl(this.#state, session)
    this.#cache.set(session, fresh)
    return fresh
  }
}
