/**
 * Chaptering — context compaction triggered by token budget.
 *
 * The agent loop calls `shouldTriggerChaptering` after each
 * `ActionEvent`. If the most recent action's `inputTokens` exceeds
 * the configured threshold and a `ChapterHandler` is registered,
 * the loop calls `runChapteringIfNeeded`, which:
 *
 *   1. Invokes the handler with the current event log.
 *   2. Wraps each returned `Chapter` in a `ChapterEvent` and appends
 *      it to the log.
 *   3. The originals stay in the log — `ChapterEvent.eventRefs`
 *      points at the state keys they replaced. Whether to substitute
 *      the summary for the originals when rendering the LLM request
 *      is the *renderer's* call, not the log's. Per design.md §6.7.
 *
 * Threshold semantics: only the most recent `ActionEvent` is checked,
 * not the cumulative total. Providers report the actual token count
 * of the request that produced this turn — that's the load-bearing
 * measurement for "is the prompt getting too big".
 */

import type { AgentEvent, Chapter, ChapterEvent, ChapterHandler, EventLog } from './types'

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

/** Run the chapter handler and append `ChapterEvent`s for each
 *  returned `Chapter`. No-op if either the handler or any chapter
 *  is missing. Returns the number of chapter events emitted. */
export async function runChaptering(
  events: ReadonlyArray<AgentEvent>,
  handler: ChapterHandler,
  log: EventLog,
  agentName: string,
  signal: AbortSignal,
  emit: (event: AgentEvent) => Promise<void>,
): Promise<number> {
  let chapters: ReadonlyArray<Chapter>
  try {
    chapters = await handler(events, signal)
  } catch (e) {
    // Surface chaptering failures as a SystemNoteEvent so the agent
    // sees that compaction was attempted and failed; don't crash the
    // outer task.
    await emit({
      type: 'systemNote',
      timestamp: new Date().toISOString(),
      agentName,
      message: `chaptering failed: ${e instanceof Error ? e.message : String(e)}`,
    })
    return 0
  }
  if (chapters.length === 0) return 0

  // The handler chooses opaque start/end strings; we pass them
  // through verbatim into ChapterEvent.eventRefs so the renderer
  // can decide what to do. A future enhancement could resolve them
  // against the log to produce the precise covered range; for now
  // the handler is responsible for accuracy.
  void log
  for (const ch of chapters) {
    const ev: ChapterEvent = {
      type: 'chapter',
      timestamp: new Date().toISOString(),
      agentName,
      name: ch.name,
      message: ch.message,
      eventRefs: [ch.start, ch.end],
    }
    await emit(ev)
  }
  return chapters.length
}
