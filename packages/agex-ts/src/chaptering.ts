/**
 * Chaptering — context compaction triggered by token budget.
 *
 * Mechanism (mirrors agex-py):
 *   - The user registers a chapter task via `agent.chapterTask({...})`.
 *     It's a normal task that runs through the action loop, sees
 *     registered fns/namespaces, and uses the agent's LLM. Contract:
 *     input is a numbered event index (string); output is `Chapter[]`
 *     where each chapter has 1-based inclusive `start`/`end`
 *     positions into that index.
 *   - After each `ActionEvent`, the parent task's loop calls
 *     `shouldTriggerChaptering`. If it trips and a chapter task is
 *     registered, `runChaptering` builds the index, invokes the
 *     chapter task (in a child session so its events don't pollute
 *     the parent), and for each returned `Chapter`:
 *       1. Translates `start`/`end` to the actual state keys at those
 *          index positions.
 *       2. Calls `EventLogImpl.replaceRange(refs, chapterEvent)`,
 *          which writes the chapter event and rewrites the log's
 *          index — the chaptered range is removed and the chapter
 *          ref is spliced in. The originals stay at their state keys
 *          but leave the active log.
 *   - Recursion guard: chaptering doesn't re-fire while the chapter
 *     task itself is executing. Tracked via a `WeakSet<Agent>`.
 *
 * After this, subsequent `iter()` over the parent's event log yields
 * the chapter event in place of the originals — so the next LLM call
 * sees the compacted log naturally, no separate render-time
 * substitution needed.
 */

import type { Agent } from './agent'
import type { EventLogImpl } from './event-log'
import type { ActionEvent, AgentEvent, Chapter, ChapterEvent } from './types'

/** True when the latest `ActionEvent.inputTokens` is at or above
 *  `threshold`. Returns false if no threshold is configured, or if
 *  no ActionEvent has been logged yet, or if its `inputTokens` is
 *  unset (provider didn't report). */
export function shouldTriggerChaptering(
  events: ReadonlyArray<AgentEvent>,
  threshold: number | undefined,
): boolean {
  if (threshold === undefined) return false
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as AgentEvent
    if (e.type === 'action') {
      return (e.inputTokens ?? 0) >= threshold
    }
  }
  return false
}

/** Recursion guard — chaptering doesn't fire while its own chapter
 *  task is executing. WeakSet so finished agents don't leak. */
const chapteringInFlight = new WeakSet<Agent>()

/** Returns true if the agent is currently inside a chapter-task run.
 *  The action loop checks this to skip the chaptering trigger while
 *  the chapter task itself is producing ActionEvents. */
export function isChapteringInFlight(agent: Agent): boolean {
  return chapteringInFlight.has(agent)
}

/** Run the registered chapter task and apply each returned `Chapter`
 *  to the parent log via `replaceRange`. No-op if no chapter task is
 *  registered. Returns the number of chapter events applied.
 *
 *  `notify` is invoked for every event the user-facing onEvent
 *  callback should see (SystemNote on failure + each ChapterEvent on
 *  success). The chaptering machinery handles writing to the log
 *  itself — `notify` is purely for the live event stream. */
export async function runChaptering(
  parentEvents: ReadonlyArray<AgentEvent>,
  parentEventLog: EventLogImpl,
  agent: Agent,
  parentSession: string,
  signal: AbortSignal,
  notify: (event: AgentEvent) => Promise<void>,
): Promise<number> {
  const chapterTask = agent.getChapterTask()
  if (chapterTask === undefined) return 0
  if (chapteringInFlight.has(agent)) return 0

  // Snapshot the index before we run the chapter task — chapter
  // positions resolve against this exact ordering.
  const refsAtTrigger = await parentEventLog.refs()
  const eventIndex = renderEventIndex(parentEvents)

  chapteringInFlight.add(agent)
  let chapters: ReadonlyArray<Chapter>
  try {
    const raw = await chapterTask(eventIndex, {
      // Run the chapter task in an isolated session so its own task
      // events (taskStart, action, success) don't pollute the parent
      // log we're trying to summarize.
      session: `${parentSession}/__chapter__`,
      signal,
    })
    chapters = validateChapters(raw, parentEvents.length)
  } catch (e) {
    const note: AgentEvent = {
      type: 'systemNote',
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      message: `chaptering failed: ${e instanceof Error ? e.message : String(e)}`,
    }
    await parentEventLog.add(note)
    await notify(note)
    return 0
  } finally {
    chapteringInFlight.delete(agent)
  }

  if (chapters.length === 0) return 0

  // Apply chapters in reverse order so earlier indices remain valid
  // as we mutate the log (mirrors agex-py's reverse-application).
  const sorted = [...chapters].sort((a, b) => b.start - a.start)
  let applied = 0
  for (const ch of sorted) {
    // Translate 1-based inclusive positions to a slice of state keys.
    const refs = refsAtTrigger.slice(ch.start - 1, ch.end)
    if (refs.length === 0) continue
    const ev: ChapterEvent = {
      type: 'chapter',
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      name: ch.name,
      message: ch.message,
      eventRefs: refs,
    }
    await parentEventLog.replaceRange(refs, ev)
    await notify(ev)
    applied++
  }
  return applied
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the parent event log as a numbered index. One line per
 *  event, position prefixed in brackets. The chapter task uses the
 *  bracketed positions as `start` / `end` values when constructing
 *  chapters. */
function renderEventIndex(events: ReadonlyArray<AgentEvent>): string {
  const lines: string[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as AgentEvent
    const pos = `[${i + 1}]`
    lines.push(`${pos} ${describeEvent(e)}`)
  }
  return lines.join('\n')
}

function describeEvent(e: AgentEvent): string {
  switch (e.type) {
    case 'taskStart':
      return `taskStart "${truncate(e.taskName, 60)}"`
    case 'action': {
      const a = e as ActionEvent
      const types = a.emissions.map((em) => em.type).join(', ')
      const tokens = a.inputTokens !== undefined ? `; inputTokens=${a.inputTokens}` : ''
      return `action (${a.emissions.length} emissions: ${types})${tokens}`
    }
    case 'output':
      return `output (${e.parts.length} parts)`
    case 'success':
      return 'success'
    case 'fail':
      return `fail "${truncate(e.message, 60)}"`
    case 'clarify':
      return `clarify "${truncate(e.message, 60)}"`
    case 'cancelled':
      return `cancelled (after ${e.iterationsCompleted} iterations)`
    case 'error':
      return `error ${e.errorName}: "${truncate(e.errorMessage, 60)}"`
    case 'file':
      return `file (+${e.added.length} ~${e.modified.length} -${e.removed.length})`
    case 'systemNote':
      return `systemNote "${truncate(e.message, 60)}"`
    case 'chapter':
      return `chapter "${truncate(e.name, 40)}" — ${truncate(e.message, 40)}`
    default: {
      const exhaustive: never = e
      void exhaustive
      return 'unknown'
    }
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** Validate that the chapter task's output looks like `Chapter[]`
 *  with reasonable position bounds. Throws on shape mismatch —
 *  caller surfaces as a SystemNoteEvent. */
function validateChapters(raw: unknown, indexLen: number): ReadonlyArray<Chapter> {
  if (!Array.isArray(raw)) {
    throw new Error(`chapter task must return an array, got ${typeof raw}`)
  }
  const out: Chapter[] = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as Record<string, unknown>
    if (
      c === null ||
      typeof c !== 'object' ||
      typeof c.start !== 'number' ||
      typeof c.end !== 'number' ||
      typeof c.name !== 'string' ||
      typeof c.message !== 'string'
    ) {
      throw new Error(
        `chapter task: item ${i} must be { start: number, end: number, name: string, message: string }`,
      )
    }
    if (c.start < 1 || c.end > indexLen || c.start > c.end) {
      throw new Error(
        `chapter task: item ${i} range [${c.start}, ${c.end}] is invalid for index of length ${indexLen}`,
      )
    }
    out.push({
      start: c.start as number,
      end: c.end as number,
      name: c.name as string,
      message: c.message as string,
    })
  }
  // Reject overlapping ranges — they'd cause replaceRange to operate
  // on stale refs.
  const sorted = [...out].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as Chapter
    const curr = sorted[i] as Chapter
    if (curr.start <= prev.end) {
      throw new Error(
        `chapter task: chapters [${prev.start},${prev.end}] and [${curr.start},${curr.end}] overlap`,
      )
    }
  }
  return out
}
