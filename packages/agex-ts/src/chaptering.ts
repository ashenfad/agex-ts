/**
 * Chaptering — context compaction triggered by token budget.
 *
 * Mechanism (mirrors agex-py):
 *   - The user registers a chapter task via `agent.chapterTask({...})`.
 *     It's a normal task that runs through the action loop, sees
 *     registered fns/namespaces, and uses the agent's LLM. Contract:
 *     input is a numbered task index (string); output is `Chapter[]`
 *     where each chapter has 1-based inclusive `start`/`end`
 *     positions into that index.
 *   - After each `ActionEvent`, the parent task's loop calls
 *     `shouldTriggerChaptering`. If it trips and a chapter task is
 *     registered, `runChaptering` builds the index, invokes the
 *     chapter task **in the parent's session** (so the chapter task's
 *     LLM sees the parent's full conversation history rendered as
 *     turns), and for each returned `Chapter`:
 *       1. Translates `start`/`end` boundary positions to a contiguous
 *          slice of state keys.
 *       2. Calls `EventLogImpl.replaceRange(refs, chapterEvent)`,
 *          which writes the chapter event and rewrites the log's
 *          index — the chaptered range is removed and the chapter
 *          ref is spliced in. The originals stay at their state keys
 *          but leave the active log.
 *   - Recursion guard: chaptering doesn't re-fire while the chapter
 *     task itself is executing. Tracked via a `WeakSet<Agent>`.
 *
 * **Why same session, not a child:** the chapter task running in the
 * parent's session means its loop renders the parent's full event log
 * as conversation history when it calls the LLM. The agent reflects on
 * its *own* work with full context visible — actual code, results,
 * outputs, errors — not a skeletal summary string. The numbered index
 * passed as input is just a navigational aid that tells the LLM how
 * positions map to ranges. Without same-session, chaptering quality
 * collapses to "summarise from a log skeleton."
 *
 * **Boundaries, not events:** the chapter task picks ranges over
 * *boundaries* (TaskStartEvent ∪ ChapterEvent), not raw events. Each
 * boundary owns the events from itself up to (but not including) the
 * next boundary — so a TaskStartEvent boundary is "this whole task"
 * and a ChapterEvent boundary is "this folded summary." Picking a
 * range that spans both kinds is nested chaptering: the new
 * ChapterEvent's `eventRefs` includes the inner ChapterEvent's storage
 * key, and walking down resolves to the original raw events.
 *
 * **Filtering:** the chapter task's own bookkeeping events
 * (`taskStart` with `taskName === '__chapter__'` and its closing
 * outcome) are filtered from both the LLM render path (Filter A in
 * `renderEvents`) and the chaptering index builder (Filter B here).
 * They stay in the log for UI / undo. This avoids the summary text
 * being duplicated (once in the ChapterEvent, again in the chapter
 * task's emitted code) and keeps future chapter tasks from seeing
 * prior chaptering work as enumerable entries.
 */

import type { Agent } from './agent'
import type { EventLogImpl } from './event-log'
import { slugify, uniqueSlug } from './slugify'
import type { AgentEvent, Chapter, ChapterEvent } from './types'

/** Reserved task name used to stamp the chapter task's events.
 *  Filters in the renderer and the index builder key off this name. */
export const CHAPTER_TASK_NAME = '__chapter__'

/** Default primer attached to chapter tasks unless the embedder
 *  overrides via `agent.chapterTask({ primer })`. Adapted from
 *  agex-py's `CHAPTER_TASK_PRIMER` for our boundary-based index.
 *
 *  Key bits the LLM needs to know:
 *    - Its full conversation history sits above; the numbered index
 *      points at *boundary* positions (task starts and prior chapter
 *      events). Read the full context to write detailed summaries.
 *    - Picking a range that includes a prior chapter is normal —
 *      that's nested chaptering. The original details remain at
 *      `/chapters/<slug>/`.
 *    - Don't chapter in-progress or recent work; only fold completed
 *      phases. Returning `[]` is fine.
 *    - The chapter task's own bookkeeping is filtered from the index,
 *      so it won't see entries for prior chaptering it performed. */
export const DEFAULT_CHAPTER_PRIMER = `\
Compact your context by folding completed work into named chapters. \
You were invoked because your context is over budget — default to \
folding something. The originals stay browsable at \`/chapters/<slug>/\`.

The numbered index in your inputs maps to the [N] boundaries you can \
fold. Each entry is either a task you ran (with its outcome) or a \
chapter you produced earlier. Read the full task content in your \
context above to write detailed summaries; the index is just for \
referring to ranges.

Construct \`Chapter\` instances and return them via \`taskSuccess\`:

    taskSuccess([
      { start: 1, end: 3, name: "Data exploration", message: "Found 3 tables..." },
    ])

Fold completed work that's no longer your immediate context. Including \
a prior chapter entry in a new range is normal — that's how you fold \
older summaries into higher-level ones (nested chaptering).

Don't fold the in-progress entry, or anything you still need detailed \
access to for active work. \`taskSuccess([])\` is a last resort — \
return it only when literally every boundary is in-progress or actively \
needed.

Rules:
- \`start\` and \`end\` are 1-based inclusive boundary positions.
- Ranges must be contiguous and non-overlapping.
- \`message\` must be VERBOSE — capture specific findings, data values, \
variable names, file paths, decisions, and outcomes. The chapter message \
is what you'll see in place of the originals, so include everything you \
might need later.
- \`name\` should serve as a table-of-contents entry.
`

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
 *  registered, or if no boundaries to fold over (e.g., a single-task
 *  parent that hasn't accumulated enough scoped work). Returns the
 *  number of chapter events applied.
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

  // Build the boundary-based index. Each boundary entry maps to a
  // contiguous range of underlying log positions; the chapter task
  // picks boundary positions and we fold the corresponding log range.
  const { text: indexText, ranges } = buildBoundaryIndex(parentEvents)

  // Skip the chapter task entirely when there's nothing safe to
  // fold. The trigger fires *during* a task — its taskStart is one
  // of the boundaries, but it's marked `(in progress)` and the
  // primer rules out chaptering in-progress work. So we need at
  // least one *completable* boundary in addition to the running
  // task: another completed task or a prior ChapterEvent. Invoking
  // the chapter task without one wastes an LLM call (it'd return
  // `[]`) and pollutes the parent log with empty chaptering
  // bookkeeping that Filter A would then filter out anyway.
  if (!hasCompletableBoundary(parentEvents, ranges)) {
    return 0
  }

  chapteringInFlight.add(agent)
  let chapters: ReadonlyArray<Chapter>
  try {
    // Run the chapter task in the parent's session. Its loop will
    // render the parent's full log as conversation history (the
    // open chapter scope is not filtered — see Filter A) so the
    // LLM has actual context to reflect on. The numbered index is
    // a navigational aid pointing at boundary positions.
    const raw = await chapterTask(indexText, {
      session: parentSession,
      signal,
    })
    chapters = validateChapters(raw, ranges.length)
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

  // Apply chapters in reverse boundary-order so earlier ranges remain
  // valid as we mutate the log (mirrors agex-py's reverse application).
  const sorted = [...chapters].sort((a, b) => b.start - a.start)

  // Collect existing slugs from the parent log so new chapters don't
  // collide on path. `parentEvents` is the snapshot from the trigger
  // point and already contains any prior chapters in this session.
  const takenSlugs = new Set<string>()
  for (const e of parentEvents) {
    if (e.type === 'chapter') takenSlugs.add(e.slug)
  }

  let applied = 0
  for (const ch of sorted) {
    // Translate 1-based inclusive boundary positions to a slice of
    // underlying log refs. The boundary range stored alongside
    // each index entry holds the log [start, end) span.
    const startRange = ranges[ch.start - 1]
    const endRange = ranges[ch.end - 1]
    if (startRange === undefined || endRange === undefined) continue
    const refs = refsAtTrigger.slice(startRange.start, endRange.end)
    if (refs.length === 0) continue
    const slug = uniqueSlug(slugify(ch.name), takenSlugs)
    takenSlugs.add(slug)
    const ev: ChapterEvent = {
      type: 'chapter',
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      name: ch.name,
      message: ch.message,
      slug,
      eventRefs: refs,
    }
    await parentEventLog.replaceRange(refs, ev)
    await notify(ev)
    applied++
  }
  // Refresh the `/chapters/` overlay for the parent session so the
  // newly applied chapters are browseable on the agent's next FS read.
  if (applied > 0) {
    await agent.refreshChaptersOverlay(parentSession)
  }
  return applied
}

// ---------------------------------------------------------------------------
// Filter helpers — also used by the renderer
// ---------------------------------------------------------------------------

/** Walk events and mark which indices fall inside a `__chapter__`
 *  task scope.
 *
 *  Two callers, two contracts — controlled by `includeOpen`:
 *
 *  - **Renderer (Filter A, `includeOpen=false`, default):** mark only
 *    *closed* chapter scopes. The currently-running chapter task's
 *    own events stay unmarked so its loop's `renderEvents(...)` call
 *    can see its own taskStart prompt and any prior turns. Once the
 *    chapter task closes (success / fail / cancelled), the parent's
 *    next render skips the now-closed scope.
 *
 *  - **Index builder (Filter B, `includeOpen=true`):** mark events
 *    inside *both* open and closed chapter scopes. The boundary
 *    index handed to the chapter task should never enumerate the
 *    chapter task's own (in-progress) bookkeeping as a foldable
 *    boundary — the chapter task can't chapter itself.
 *
 *  Implementation: stack-based scope tracking with non-chapter
 *  task frames recorded too (so close events pair with the right
 *  frame inside nested cases). Closed scopes are marked via a
 *  range fill at close time (`for j in [start, close]`). Open-scope
 *  marking happens *after* the stack update for the current event,
 *  so the chapter taskStart that opens the scope gets marked when
 *  `includeOpen` is true (its push has just happened, putting it in
 *  range). For close events, the pop happens first, then the close
 *  branch's range-fill marks the close index — `inChapterRange()`
 *  is false post-pop, so the open-scope mark below correctly
 *  declines to re-mark it.
 *
 *  Exported so `renderEvents` can apply the renderer-mode filter
 *  without duplicating the boundary-detection logic. */
export function buildChapterScopeFilter(
  events: ReadonlyArray<AgentEvent>,
  includeOpen = false,
): ReadonlySet<number> {
  const skip = new Set<number>()
  type Frame = { kind: 'chapter'; start: number } | { kind: 'other' }
  const stack: Frame[] = []
  const inChapterRange = (): boolean => stack.some((f) => f.kind === 'chapter')

  for (let i = 0; i < events.length; i++) {
    const e = events[i] as AgentEvent

    // Update the stack based on this event first.
    if (e.type === 'taskStart') {
      if (e.taskName === CHAPTER_TASK_NAME) {
        stack.push({ kind: 'chapter', start: i })
      } else {
        stack.push({ kind: 'other' })
      }
    } else if (e.type === 'success' || e.type === 'fail' || e.type === 'cancelled') {
      const top = stack.pop()
      if (top !== undefined && top.kind === 'chapter') {
        // Closed scope — mark from start through this close event.
        for (let j = top.start; j <= i; j++) skip.add(j)
      }
    }

    // Open-scope marking — only when the caller wants in-progress
    // chapter scopes filtered too (Filter B). For the renderer
    // (Filter A), this stays off so the running chapter task can
    // see its own loop history.
    if (includeOpen && inChapterRange()) skip.add(i)
  }
  return skip
}

// ---------------------------------------------------------------------------
// Boundary-based index builder
// ---------------------------------------------------------------------------

interface BoundaryRange {
  /** 0-based, inclusive log position where this boundary's range
   *  starts (the boundary event itself). */
  readonly start: number
  /** 0-based, exclusive log position where this boundary's range
   *  ends — equal to the next boundary's `start`, or `events.length`
   *  for the final boundary. */
  readonly end: number
}

/** Build the numbered task index handed to the chapter task's LLM,
 *  plus the parallel array of underlying log ranges that boundary
 *  positions resolve to.
 *
 *  Boundaries: every TaskStartEvent (excluding `__chapter__`-scoped)
 *  and every ChapterEvent. Each boundary owns the events from itself
 *  up to but not including the next boundary. The final boundary
 *  owns through the end of the log.
 *
 *  **Boundary-range absorption.** A boundary's range extends to the
 *  next boundary's start, *including any filtered (chapter-scoped)
 *  events in between*. The alternative — trim each range at the first
 *  filtered index — would leave orphaned chapter-task bookkeeping in
 *  the log between boundaries. With absorption, folding a parent task
 *  sweeps trailing chapter-task bookkeeping into the new chapter's
 *  `eventRefs`; subsequent renders are smaller and the active log
 *  stays clean across many chaptering rounds. Locked in by a test
 *  ("boundary range absorbs trailing chapter-scope events") so a
 *  silent flip to the trim interpretation is caught immediately.
 *
 *  Outcome detection: for TaskStartEvent boundaries, scan the events
 *  in the boundary's range for a closing event (success/fail/clarify/
 *  cancelled). Filtered indices are skipped during the scan so a
 *  closed chapter scope's terminator inside an in-progress parent's
 *  range doesn't get misread as the parent's own outcome. The first
 *  match becomes the rendered outcome; absence marks the task
 *  `(in progress)`. */
/** Exported for unit testing. Not part of the public API surface;
 *  consumers should drive chaptering through `runChaptering`. */
export function buildBoundaryIndex(events: ReadonlyArray<AgentEvent>): {
  text: string
  ranges: BoundaryRange[]
} {
  // Filter B — exclude *both* open and closed `__chapter__` scopes.
  // The currently-running chapter task (if any) must not appear in
  // the index; it can't chapter itself.
  const skip = buildChapterScopeFilter(events, true)

  // First pass: locate boundary indices, in order.
  const boundaryIndices: number[] = []
  for (let i = 0; i < events.length; i++) {
    if (skip.has(i)) continue
    const e = events[i] as AgentEvent
    if (e.type === 'taskStart' || e.type === 'chapter') boundaryIndices.push(i)
  }

  // Second pass: compute (start, end) for each boundary.
  const ranges: BoundaryRange[] = boundaryIndices.map((start, i) => ({
    start,
    end: i + 1 < boundaryIndices.length ? (boundaryIndices[i + 1] as number) : events.length,
  }))

  // Third pass: render index lines.
  const lines: string[] = []
  for (let i = 0; i < boundaryIndices.length; i++) {
    const idx = boundaryIndices[i] as number
    const range = ranges[i] as BoundaryRange
    const e = events[idx] as AgentEvent
    const label = describeBoundary(e, events, range, skip)
    lines.push(`[${i + 1}] ${label}`)
  }

  return { text: lines.join('\n'), ranges }
}

/** True if at least one boundary in `ranges` represents foldable
 *  content: a ChapterEvent (always completable) or a TaskStartEvent
 *  whose range contains a closing outcome event (success / fail /
 *  clarify / cancelled). The currently-running task is *not*
 *  completable — its boundary range has no closing event yet.
 *
 *  Important: scan past `__chapter__`-scoped events when looking for
 *  the parent's terminator. Boundary ranges absorb trailing filtered
 *  events (see `buildBoundaryIndex`), so a chapter task that ran and
 *  closed *inside* a still-running parent's range would otherwise be
 *  misread as the parent's own completion — the chapter task's
 *  `success` would land in the loop and we'd return `true` for an
 *  in-progress parent. Apply the same `includeOpen=true` filter the
 *  index builder uses to skip those indices.
 *
 *  `clarify` counts as a completion: a clarified task is closed
 *  (waiting on the human, not continuing), so its outcome is fixed
 *  and the chapter message can capture both the question and the
 *  surrounding context. Matches `describeBoundary`, which has had a
 *  clarify branch since the boundary index was introduced. */
/** Exported for unit testing. Not part of the public API surface. */
export function hasCompletableBoundary(
  events: ReadonlyArray<AgentEvent>,
  ranges: ReadonlyArray<BoundaryRange>,
): boolean {
  const skip = buildChapterScopeFilter(events, true)
  for (const r of ranges) {
    const head = events[r.start] as AgentEvent
    if (head.type === 'chapter') return true
    for (let j = r.start + 1; j < r.end; j++) {
      if (skip.has(j)) continue
      const ev = events[j] as AgentEvent
      if (
        ev.type === 'success' ||
        ev.type === 'fail' ||
        ev.type === 'clarify' ||
        ev.type === 'cancelled'
      ) {
        return true
      }
    }
  }
  return false
}

function describeBoundary(
  boundary: AgentEvent,
  events: ReadonlyArray<AgentEvent>,
  range: BoundaryRange,
  skip: ReadonlySet<number>,
): string {
  if (boundary.type === 'chapter') {
    return `chapter "${truncate(boundary.name, 60)}" — ${truncate(boundary.message, 80)}`
  }
  if (boundary.type !== 'taskStart') return 'unknown'
  // taskStart: find the closing event in the range, if any.
  const taskName = boundary.taskName
  const message = boundary.message ?? ''
  const head = `task "${truncate(taskName, 50)}"`
  const trailer = message.length > 0 ? `: ${truncate(message.replace(/\n/g, ' '), 80)}` : ''

  for (let j = range.start + 1; j < range.end; j++) {
    if (skip.has(j)) continue
    const ev = events[j] as AgentEvent
    if (ev.type === 'success') return `${head}${trailer} → success`
    if (ev.type === 'fail') return `${head}${trailer} → fail "${truncate(ev.message, 60)}"`
    if (ev.type === 'clarify') return `${head}${trailer} → clarify "${truncate(ev.message, 60)}"`
    if (ev.type === 'cancelled') return `${head}${trailer} → cancelled`
  }
  return `${head}${trailer} (in progress)`
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
