/**
 * `EventLogImpl` — append-only log of `AgentEvent`s over a
 * `StateBackend`.
 *
 * Keys are prefixed `evt/<ISO timestamp>/<seq>`. The ISO prefix gives
 * lexicographic-equals-chronological ordering; the per-millisecond
 * sequence number resolves collisions when multiple events land in
 * the same millisecond. `iter()` materializes the prefixed key set
 * and sorts — fine for the volumes we expect (thousands per session,
 * not millions).
 *
 * `ChapterEvent`s are stored just like any other event. Whether to
 * substitute them for the events they summarize is the primer
 * renderer's call, not the log's.
 *
 * `at(commitHash)` returns a read-only view at a historical commit
 * if the underlying backend is versioned; `null` otherwise.
 */

import { type StateBackend, isVersioned } from './state/backend'
import type { AgentEvent, EventLog } from './types'

const KEY_PREFIX = 'evt/'

export class EventLogImpl implements EventLog {
  readonly #state: StateBackend
  /** Per-millisecond collision counter so two events at the same
   *  timestamp don't overwrite each other. Reset whenever the
   *  observed timestamp ticks forward. */
  #lastTimestamp = ''
  #seq = 0

  constructor(state: StateBackend) {
    this.#state = state
  }

  async add(event: AgentEvent): Promise<string> {
    const ts = event.timestamp || new Date().toISOString()
    if (ts === this.#lastTimestamp) this.#seq++
    else {
      this.#lastTimestamp = ts
      this.#seq = 0
    }
    const key = `${KEY_PREFIX}${ts}/${this.#seq.toString().padStart(6, '0')}`
    this.#state.set(key, event)
    return key
  }

  async *iter(): AsyncIterable<AgentEvent> {
    const keys: string[] = []
    for await (const k of this.#state.keys()) {
      if (k.startsWith(KEY_PREFIX)) keys.push(k)
    }
    keys.sort()
    for (const k of keys) {
      const v = await this.#state.get<AgentEvent>(k)
      if (v !== undefined) yield v
    }
  }

  async at(commitHash: string): Promise<EventLog | null> {
    if (!isVersioned(this.#state)) return null
    // Time-travel via kvgit checkout is a future enhancement — the
    // surface is here so callers can probe with `await log.at(...)
    // !== null` to detect support without crashing. v1 returns null.
    void commitHash
    return null
  }
}
