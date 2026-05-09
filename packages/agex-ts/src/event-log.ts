/**
 * `EventLogImpl` — append-only log of `AgentEvent`s, organized as
 * an explicit ordered index over a `StateBackend`.
 *
 * Storage layout (within the per-session state):
 *   `__event_log__`            — ordered array of event refs (state
 *                                keys), defines the active log shape
 *   `evt/<ISO ts>/<seq>`       — one entry per event, holds the value
 *
 * The `StateBackend` handed in is already session-scoped (one
 * `VersionedKV` per session at the substrate layer), so this log
 * uses plain keys with no session prefix. Sessions are isolated below
 * this layer.
 *
 * `iter()` walks the index, batch-fetching values. The prefix scan
 * the prior implementation used returns inactive keys post-chaptering;
 * walking the index naturally yields chapters in place of the events
 * they replaced.
 *
 * `replaceRange(eventRefs, chapterEvent)` is the chaptering primitive
 * that mirrors agex-py's `replace_events_with_chapters`: writes the
 * chapter event at its own state key, rewrites the index to splice
 * the chapter ref in at the position of the first removed event, and
 * removes the chaptered refs from the index. The originals stay at
 * their state keys so callers can browse them via
 * `ChapterEvent.eventRefs` (the upcoming `/chapters/<slug>/` VFS
 * overlay reads them from there).
 */

import { type StateBackend, isVersioned } from './state/backend'
import type { AgentEvent, ChapterEvent, EventLog } from './types'

const DEFAULT_SESSION = 'default'
const VALUE_PREFIX = 'evt/'
const INDEX_KEY = '__event_log__'

export class EventLogImpl implements EventLog {
  readonly #state: StateBackend
  /** Tracked for surface compatibility with callers that read
   *  `log.session` for diagnostics; the prefix is no longer derived
   *  from this field — sessions are isolated at the substrate. */
  readonly #session: string
  /** Per-millisecond collision counter so two events at the same
   *  timestamp don't overwrite each other. */
  #lastTimestamp = ''
  #seq = 0

  constructor(state: StateBackend, session: string = DEFAULT_SESSION) {
    this.#state = state
    this.#session = session
  }

  /** Session id this log is scoped to. */
  get session(): string {
    return this.#session
  }

  async add(event: AgentEvent): Promise<string> {
    // The read-modify-write of the index isn't atomic. Safe under the
    // v1 contract — the action loop is sequential within a session,
    // and the chapter task runs in a child session — so two `add()`
    // calls on the same EventLogImpl never overlap. If we ever permit
    // concurrent tasks per session, this needs a CAS loop or an index
    // mutex. Note also: `set` is sync per `StateBackend` (writes go to
    // the kvgit Staged buffer; transactions only fire on commit), so
    // there's nothing to await here.
    const key = this.#generateKey(event)
    this.#state.set(key, this.#stamp(event))
    const index = ((await this.#state.get<string[]>(INDEX_KEY)) ?? []) as string[]
    this.#state.set(INDEX_KEY, [...index, key])
    return key
  }

  async *iter(): AsyncIterable<AgentEvent> {
    const index = ((await this.#state.get<string[]>(INDEX_KEY)) ?? []) as string[]
    for (const key of index) {
      const v = await this.#state.get<AgentEvent>(key)
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

  /** Read the index of active event refs in chronological order.
   *  Used by chaptering to map numbered positions back to state
   *  keys; not part of the public `EventLog` interface. */
  async refs(): Promise<ReadonlyArray<string>> {
    return ((await this.#state.get<string[]>(INDEX_KEY)) ?? []) as string[]
  }

  /** Replace a contiguous run of event refs with a single
   *  `ChapterEvent`. The originals stay at their state keys (so
   *  `chapterEvent.eventRefs` can resolve them) but are removed
   *  from the active index. Subsequent `iter()` yields the chapter
   *  in their place.
   *
   *  Mirrors agex-py's `replace_events_with_chapters`. Returns the
   *  state key the chapter event was written to. */
  async replaceRange(
    eventRefs: ReadonlyArray<string>,
    chapterEvent: ChapterEvent,
  ): Promise<string> {
    if (eventRefs.length === 0) {
      throw new Error('replaceRange: eventRefs must be non-empty')
    }
    // Same sequential-within-session assumption as `add()` — see the
    // comment there. Chaptering runs between LLM turns, not concurrent
    // with anything else writing to the same session log.
    const chapterKey = this.#generateKey(chapterEvent)
    this.#state.set(chapterKey, this.#stamp(chapterEvent))

    const index = ((await this.#state.get<string[]>(INDEX_KEY)) ?? []) as string[]
    const refSet = new Set(eventRefs)
    const next: string[] = []
    let inserted = false
    for (const key of index) {
      if (refSet.has(key)) {
        if (!inserted) {
          next.push(chapterKey)
          inserted = true
        }
        // skip the original — it stays at its state key but leaves the active index
      } else {
        next.push(key)
      }
    }
    // If none of the refs were in the index (caller error), append the
    // chapter at the end so we don't silently drop it.
    if (!inserted) next.push(chapterKey)
    this.#state.set(INDEX_KEY, next)
    return chapterKey
  }

  // ---------------------------------------------------------------------------

  /**
   * Stamp `commitHash` onto an event being added to the log.
   *
   * Mirrors agex-py's `add_event_to_log` (state/log.py): when the
   * underlying state is versioned, record the *parent* commit at
   * add-time — i.e., the most recent landed commit, NOT the commit
   * this event will be part of after the next flush. The semantic
   * the studio (and any other history-replay consumer) wants is "the
   * commit you'd revert to in order to undo this event and everything
   * after it." Live state has no commits, so the field stays absent.
   *
   * Stamps once at add-time and is never rewritten when `commit()`
   * eventually lands. Same shape as agex-py — no post-commit
   * walk-back, no sidecar (eventKey → commitHash) index.
   */
  #stamp<E extends AgentEvent>(event: E): E {
    if (!isVersioned(this.#state)) return event
    const parent = this.#state.currentCommit
    if (parent === null) return event
    return { ...event, commitHash: parent } as E
  }

  #generateKey(event: AgentEvent): string {
    const ts = event.timestamp || new Date().toISOString()
    if (ts === this.#lastTimestamp) this.#seq++
    else {
      this.#lastTimestamp = ts
      this.#seq = 0
    }
    return `${VALUE_PREFIX}${ts}/${this.#seq.toString().padStart(6, '0')}`
  }
}
