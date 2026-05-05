/**
 * Chaptering — context compaction triggered by token budget.
 *
 * Mechanism (mirrors agex-py):
 *   - The user registers a chapter task via `agent.chapterTask({...})`.
 *     It's a normal task that runs through the action loop, sees
 *     registered fns/namespaces, and uses the agent's LLM. Its
 *     contract: input is a numbered event index (string); output is
 *     `readonly Chapter[]`, returned via `taskSuccess(...)`.
 *   - After each `ActionEvent`, the parent task's loop calls
 *     `shouldTriggerChaptering`. If it trips and a chapter task is
 *     registered, `runChaptering` builds the event index, invokes
 *     the chapter task (in a separate session so its events don't
 *     pollute the parent), and writes one `ChapterEvent` per
 *     returned `Chapter`.
 *   - Recursion guard: chaptering doesn't re-fire while the chapter
 *     task itself is executing. Tracked via a `WeakSet<Agent>`.
 *
 * Per `design.md` §6.7, the originals stay in the event log;
 * substituting the chapter summary for them is the renderer's call,
 * not the log's.
 */

import type { Agent } from './agent'
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

/** Run the registered chapter task and append `ChapterEvent`s for
 *  each returned `Chapter`. No-op if no chapter task is registered.
 *  Returns the number of chapter events emitted. */
export async function runChaptering(
  parentEvents: ReadonlyArray<AgentEvent>,
  agent: Agent,
  parentSession: string,
  signal: AbortSignal,
  emit: (event: AgentEvent) => Promise<void>,
): Promise<number> {
  const chapterTask = agent.getChapterTask()
  if (chapterTask === undefined) return 0
  if (chapteringInFlight.has(agent)) return 0

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
    chapters = validateChapters(raw)
  } catch (e) {
    // Surface chaptering failures as a SystemNoteEvent so the agent
    // sees that compaction was attempted and failed; don't crash the
    // outer task.
    await emit({
      type: 'systemNote',
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      message: `chaptering failed: ${e instanceof Error ? e.message : String(e)}`,
    })
    return 0
  } finally {
    chapteringInFlight.delete(agent)
  }

  if (chapters.length === 0) return 0

  for (const ch of chapters) {
    const ev: ChapterEvent = {
      type: 'chapter',
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      name: ch.name,
      message: ch.message,
      eventRefs: [ch.start, ch.end],
    }
    await emit(ev)
  }
  return chapters.length
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the parent event log as a numbered index for the chapter
 *  task to consume. One line per event, position prefixed in
 *  brackets. The chapter task uses the bracketed positions as
 *  `start` / `end` values when constructing chapters.
 *
 *  Format kept terse to keep the chapter-task prompt cheap — the
 *  task can refer back to its own conversation history for richer
 *  detail on any range it wants to summarize. */
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

/** Validate that the chapter task's output looks like `Chapter[]`.
 *  Throws on shape mismatch — caller surfaces as a SystemNoteEvent. */
function validateChapters(raw: unknown): ReadonlyArray<Chapter> {
  if (!Array.isArray(raw)) {
    throw new Error(`chapter task must return an array, got ${typeof raw}`)
  }
  const out: Chapter[] = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as Record<string, unknown>
    if (
      c === null ||
      typeof c !== 'object' ||
      typeof c.start !== 'string' ||
      typeof c.end !== 'string' ||
      typeof c.name !== 'string' ||
      typeof c.message !== 'string'
    ) {
      throw new Error(`chapter task: item ${i} must be { start, end, name, message } strings`)
    }
    out.push({
      start: c.start as string,
      end: c.end as string,
      name: c.name as string,
      message: c.message as string,
    })
  }
  return out
}
