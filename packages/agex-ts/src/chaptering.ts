/**
 * Chaptering — context compaction triggered by token budget.
 *
 * Mechanism (mirrors agex-py):
 *   - The chapter task is auto-registered by the `Agent` constructor
 *     when `chapteringTrigger` is set — the embedder opts in via that
 *     option rather than registering a task themselves. It's a normal
 *     task that runs through the action loop, sees registered
 *     fns/namespaces, and uses the agent's LLM. Contract: input is a
 *     numbered task index (string); output is `Chapter[]` where each
 *     chapter has 1-based inclusive `start`/`end` positions into that
 *     index.
 *   - At each *task boundary* (success / fail), the loop calls
 *     `maybeFireBoundaryChaptering`, which consults
 *     `shouldTriggerChaptering`. Firing mid-task isn't possible —
 *     chapters fold whole completed tasks, so a long-running single
 *     task has no completable boundary to compact. If it trips,
 *     `runChaptering` builds the index, invokes the
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
 * outcome) are filtered from both the LLM render path
 * (`closedChapterScopes`, used by `renderEvents`) and the chaptering
 * index builder (`allChapterScopes`, here).
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
 *  overrides via `AgentOptions.chapterPrimer`. Adapted from
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
 *  unset (provider didn't report).
 *
 *  `lastFiredActionTimestamp` gates against the **stale-trigger
 *  loop**: after chaptering folds a range, the most recent
 *  ActionEvent's `inputTokens` still reflects the pre-fold context
 *  size (the provider measured it then; we don't re-estimate). If
 *  another task boundary fires before a fresh LLM call lands —
 *  e.g. a parent task that emits `taskSuccess(subTask())` so its
 *  most-recent action was measured before subTask's chaptering ran
 *  — the trigger would fire again on the same stale measurement
 *  and waste an LLM call on a redundant chapter task.
 *
 *  When `lastFiredActionTimestamp` matches the latest ActionEvent's
 *  timestamp, we treat that measurement as already-consumed and
 *  return false. The next genuine LLM call produces a new
 *  ActionEvent (different timestamp), the gate clears, and the
 *  trigger can fire again if the new measurement is still over
 *  threshold. */
export function shouldTriggerChaptering(
  events: ReadonlyArray<AgentEvent>,
  threshold: number | undefined,
  lastFiredActionTimestamp?: string,
): boolean {
  if (threshold === undefined) return false
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as AgentEvent
    if (e.type === 'action') {
      if ((e.inputTokens ?? 0) < threshold) return false
      if (lastFiredActionTimestamp !== undefined && e.timestamp === lastFiredActionTimestamp) {
        return false
      }
      return true
    }
  }
  return false
}

/** Per-`EventLogImpl` marker for "the ActionEvent timestamp at which
 *  we last fired chaptering on this session." Read by
 *  `shouldTriggerChaptering` (stale-measurement gate) and written by
 *  the boundary-fire path in `task.ts`. WeakMap-keyed so dropped
 *  logs don't leak. */
const lastFiredActionByLog = new WeakMap<EventLogImpl, string>()

export function getLastFiredActionTimestamp(log: EventLogImpl): string | undefined {
  return lastFiredActionByLog.get(log)
}

export function markChapteringFired(log: EventLogImpl, actionTimestamp: string): void {
  lastFiredActionByLog.set(log, actionTimestamp)
}

/** Recursion guard — chaptering doesn't fire while its own chapter
 *  task is executing.
 *
 *  The chapter task runs through the normal loop in the parent's
 *  session, so it reaches the same task-boundary trigger on its way
 *  out. `runChaptering` checks this set on entry and bails, which is
 *  what stops the recursion; the loop itself doesn't need to know.
 *
 *  WeakSet so finished agents don't leak. Keyed by `Agent` rather
 *  than by session, so chaptering in one session currently suppresses
 *  it in another on the same agent — see the note in `runChaptering`. */
const chapteringInFlight = new WeakSet<Agent>()

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
  parentEventLog: EventLogImpl,
  agent: Agent,
  parentSession: string,
  signal: AbortSignal,
  notify: (event: AgentEvent) => Promise<void>,
): Promise<number> {
  const chapterTask = agent.getChapterTask()
  if (chapterTask === undefined) return 0
  // Bailing here is what prevents recursion: the chapter task runs
  // the normal loop in this same session and hits the boundary
  // trigger on its way out.
  if (chapteringInFlight.has(agent)) return 0

  // One aligned read of the log, taken before the chapter task runs.
  // Boundary positions index into `parentEvents`; the fold resolves
  // them against `refsAtTrigger` at the same positions, so the two
  // must come from a single snapshot — see `EventLogImpl.entries`.
  const snapshot = await parentEventLog.entries()
  const parentEvents = snapshot.map((e) => e.event)
  const refsAtTrigger = snapshot.map((e) => e.ref)

  // Build the boundary-based index. Each boundary entry maps to a
  // contiguous range of underlying log positions; the chapter task
  // picks boundary positions and we fold the corresponding log range.
  const { text: indexText, ranges, hasCompletable } = buildBoundaryIndex(parentEvents)

  // Skip the chapter task entirely when there's nothing safe to
  // fold. The trigger fires *during* a task — its taskStart is one
  // of the boundaries, but it's marked `(in progress)` and the
  // primer rules out chaptering in-progress work. So we need at
  // least one *completable* boundary in addition to the running
  // task: another completed task or a prior ChapterEvent. Invoking
  // the chapter task without one wastes an LLM call (it'd return
  // `[]`) and pollutes the parent log with empty chaptering
  // bookkeeping the renderer would then filter out anyway.
  if (!hasCompletable) return 0

  chapteringInFlight.add(agent)
  let chapters: ReadonlyArray<Chapter>
  try {
    // Run the chapter task in the parent's session. Its loop will
    // render the parent's full log as conversation history (the
    // open chapter scope is not filtered — see `closedChapterScopes`) so the
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

/** Indices inside a **closed** `__chapter__` task scope — the
 *  renderer's filter.
 *
 *  A currently-running chapter task's own events stay unmarked, which
 *  is how its `renderEvents(...)` call sees its own taskStart prompt
 *  and prior turns. Once it closes (success / fail / cancelled), the
 *  parent's next render skips the now-closed scope.
 *
 *  Exported so `renderEvents` gets this without duplicating the
 *  scope-detection walk. */
export function closedChapterScopes(events: ReadonlyArray<AgentEvent>): ReadonlySet<number> {
  return walkChapterScopes(events, false)
}

/** Indices inside **any** `__chapter__` task scope, open or closed —
 *  the chaptering index builder's filter.
 *
 *  The boundary index handed to the chapter task must never enumerate
 *  the chapter task's own in-progress bookkeeping as a foldable
 *  boundary: a chapter task can't chapter itself. Also applied when
 *  scanning *inside* a boundary range, since ranges absorb trailing
 *  filtered events (see `buildBoundaryIndex`). */
export function allChapterScopes(events: ReadonlyArray<AgentEvent>): ReadonlySet<number> {
  return walkChapterScopes(events, true)
}

/** Shared walk behind the two filters above.
 *
 *  Stack-based scope tracking, with non-chapter task frames recorded
 *  too so close events pair with the right frame in nested cases.
 *  Closed scopes are marked by a range fill at close time
 *  (`for j in [start, close]`).
 *
 *  Ordering is load-bearing: the open-scope mark happens *after* the
 *  stack update for the current event, so a chapter `taskStart` gets
 *  marked under `includeOpen` (its push has just landed, putting it
 *  in range). On a close event the pop happens first, so
 *  `inChapterRange()` is already false and the open-scope branch
 *  correctly declines to re-mark the index the range fill just
 *  covered. */
function walkChapterScopes(
  events: ReadonlyArray<AgentEvent>,
  includeOpen: boolean,
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
    // chapter scopes filtered too (`allChapterScopes`). For the
    // renderer, this stays off so the running chapter task can
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
 *  in the boundary's range for a closing event (success/fail/
 *  cancelled). Filtered indices are skipped during the scan so a
 *  closed chapter scope's terminator inside an in-progress parent's
 *  range doesn't get misread as the parent's own outcome. The first
 *  match becomes the rendered outcome; absence marks the task
 *  `(in progress)`.
 *
 *  `hasCompletable` rides along from the same scan rather than being
 *  recomputed: it's true when at least one boundary is foldable — a
 *  ChapterEvent (always) or a task whose range contains a closing
 *  outcome. The running task isn't completable, since its range has
 *  no terminator yet. Deriving it here means the scope filter is
 *  computed once per run and the two consumers can't drift apart on
 *  which indices they skip. */
/** Exported for unit testing. Not part of the public API surface;
 *  consumers should drive chaptering through `runChaptering`. */
export function buildBoundaryIndex(events: ReadonlyArray<AgentEvent>): {
  text: string
  ranges: BoundaryRange[]
  hasCompletable: boolean
} {
  // Exclude *both* open and closed `__chapter__` scopes. The
  // currently-running chapter task (if any) must not appear in the
  // index; it can't chapter itself.
  const skip = allChapterScopes(events)

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

  // Third pass: render index lines, tracking foldability as we go.
  const lines: string[] = []
  let hasCompletable = false
  for (let i = 0; i < boundaryIndices.length; i++) {
    const idx = boundaryIndices[i] as number
    const range = ranges[i] as BoundaryRange
    const e = events[idx] as AgentEvent
    const outcome = findOutcome(events, range, skip)
    // A ChapterEvent is always foldable; a task is foldable once its
    // range holds a terminator.
    if (e.type === 'chapter' || outcome !== null) hasCompletable = true
    lines.push(`[${i + 1}] ${describeBoundary(e, outcome)}`)
  }

  return { text: lines.join('\n'), ranges, hasCompletable }
}

/** The closing event for a boundary's range, or `null` while the task
 *  is still running.
 *
 *  Skips `__chapter__`-scoped indices. Boundary ranges absorb trailing
 *  filtered events, so a chapter task that ran and closed *inside* a
 *  still-running parent's range would otherwise be misread as the
 *  parent's own terminator. */
function findOutcome(
  events: ReadonlyArray<AgentEvent>,
  range: BoundaryRange,
  skip: ReadonlySet<number>,
): AgentEvent | null {
  for (let j = range.start + 1; j < range.end; j++) {
    if (skip.has(j)) continue
    const ev = events[j] as AgentEvent
    if (ev.type === 'success' || ev.type === 'fail' || ev.type === 'cancelled') return ev
  }
  return null
}

function describeBoundary(boundary: AgentEvent, outcome: AgentEvent | null): string {
  if (boundary.type === 'chapter') {
    return `chapter "${truncate(boundary.name, 60)}" — ${truncate(boundary.message, 80)}`
  }
  if (boundary.type !== 'taskStart') return 'unknown'
  const message = boundary.message ?? ''
  const head = `task "${truncate(boundary.taskName, 50)}"`
  const trailer = message.length > 0 ? `: ${truncate(message.replace(/\n/g, ' '), 80)}` : ''

  if (outcome === null) return `${head}${trailer} (in progress)`
  if (outcome.type === 'success') return `${head}${trailer} → success`
  if (outcome.type === 'fail') return `${head}${trailer} → fail "${truncate(outcome.message, 60)}"`
  return `${head}${trailer} → cancelled`
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
