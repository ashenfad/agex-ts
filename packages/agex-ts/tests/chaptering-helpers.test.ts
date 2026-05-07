/**
 * Unit tests for chaptering's internal helpers — narrow, fast tests
 * that pin behaviors the e2e tests in `chaptering.test.ts` exercise
 * implicitly.
 *
 * Helpers under test (exported for testing only; not part of the
 * public API):
 *   - buildChapterScopeFilter — Filter A/B's shared boundary detector
 *   - buildBoundaryIndex      — boundary index + log ranges
 *   - hasCompletableBoundary  — runtime no-op guard
 *
 * These tests exist primarily as regression guards; several were
 * suggested verbatim by an agent porting these improvements back to
 * agex-py and finding bugs surface only with explicit coverage.
 */

import { describe, expect, it } from 'vitest'
import {
  buildBoundaryIndex,
  buildChapterScopeFilter,
  hasCompletableBoundary,
} from '../src/chaptering'
import type {
  ActionEvent,
  AgentEvent,
  ChapterEvent,
  SuccessEvent,
  TaskStartEvent,
} from '../src/types'

const ts = (i: number) => `2026-05-07T00:00:${i.toString().padStart(2, '0')}.000Z`

const taskStart = (taskName: string, idx = 0): TaskStartEvent => ({
  type: 'taskStart',
  timestamp: ts(idx),
  agentName: 't',
  taskName,
  inputs: undefined,
  message: `Task: ${taskName}`,
})

const action = (idx = 0): ActionEvent => ({
  type: 'action',
  timestamp: ts(idx),
  agentName: 't',
  emissions: [],
})

const success = (idx = 0): SuccessEvent => ({
  type: 'success',
  timestamp: ts(idx),
  agentName: 't',
  result: null,
})

const chapter = (slug: string, idx = 0): ChapterEvent => ({
  type: 'chapter',
  timestamp: ts(idx),
  agentName: 't',
  name: slug,
  message: '...',
  slug,
  eventRefs: [],
})

describe('hasCompletableBoundary', () => {
  it('false when the only boundary is an in-progress task', () => {
    const events: AgentEvent[] = [taskStart('parent', 0), action(1)]
    const { ranges } = buildBoundaryIndex(events)
    expect(hasCompletableBoundary(events, ranges)).toBe(false)
  })

  it('true when a parent task has succeeded inside its range', () => {
    const events: AgentEvent[] = [taskStart('parent', 0), action(1), success(2)]
    const { ranges } = buildBoundaryIndex(events)
    expect(hasCompletableBoundary(events, ranges)).toBe(true)
  })

  it('true when a parent has clarified — clarify counts as completion', () => {
    const events: AgentEvent[] = [
      taskStart('parent', 0),
      action(1),
      {
        type: 'clarify',
        timestamp: ts(2),
        agentName: 't',
        message: 'which one?',
      },
    ]
    const { ranges } = buildBoundaryIndex(events)
    expect(hasCompletableBoundary(events, ranges)).toBe(true)
  })

  it('true when there is a prior chapter event in the index', () => {
    const events: AgentEvent[] = [chapter('phase-1', 0), taskStart('parent', 1), action(2)]
    const { ranges } = buildBoundaryIndex(events)
    expect(hasCompletableBoundary(events, ranges)).toBe(true)
  })

  // Regression: a closed __chapter__ scope nested inside an in-progress
  // parent's range used to make hasCompletableBoundary report true
  // (it found the chapter task's own success while scanning the parent
  // for a terminator). Surfaced by an agent porting these improvements
  // back to agex-py; the same shape applied here.
  it('false when the parent is in-progress and a closed chapter scope is nested inside its range', () => {
    const events: AgentEvent[] = [
      taskStart('parent', 0), //  [0]
      action(1), //               [1]
      taskStart('__chapter__', 2), // [2] — chapter-scope start
      action(3), //                  [3]
      success(4), //                 [4] — chapter-scope end
      action(5), //               [5] — parent continues, still no terminator
    ]
    const { ranges } = buildBoundaryIndex(events)
    // The boundary index has just one entry (the parent), and its
    // range absorbs the chapter scope. Without the filter inside
    // hasCompletableBoundary, the chapter task's success at [4]
    // would be misread as the parent's completion.
    expect(ranges.length).toBe(1)
    expect(hasCompletableBoundary(events, ranges)).toBe(false)
  })
})

describe('buildBoundaryIndex', () => {
  it('boundary range absorbs trailing chapter-scope events into the preceding boundary', () => {
    // Pins the design choice: each boundary's range extends to the
    // next boundary's start, including any filtered events in between.
    // Folding the parent task therefore sweeps the chapter task's
    // bookkeeping into the new chapter's eventRefs — keeping the log
    // compact across many chaptering rounds.
    const events: AgentEvent[] = [
      taskStart('t1', 0), //          [0]
      action(1), //                   [1]
      success(2), //                  [2]
      taskStart('__chapter__', 3), // [3] — filtered scope start
      action(4), //                   [4]
      success(5), //                  [5] — filtered scope end
      taskStart('t2', 6), //          [6] — next non-filtered boundary
      success(7), //                  [7]
    ]
    const { ranges } = buildBoundaryIndex(events)
    expect(ranges.length).toBe(2)
    // t1 absorbs the chapter scope (positions 3-5).
    expect(ranges[0]).toEqual({ start: 0, end: 6 })
    // t2 picks up at the next boundary.
    expect(ranges[1]).toEqual({ start: 6, end: 8 })
  })

  it('chapter event is a first-class boundary', () => {
    const events: AgentEvent[] = [chapter('phase-1', 0), taskStart('parent', 1), action(2)]
    const { ranges, text } = buildBoundaryIndex(events)
    expect(ranges.length).toBe(2)
    expect(text).toContain('chapter "phase-1"')
    expect(text).toContain('task "parent"')
  })
})

describe('buildChapterScopeFilter', () => {
  it('marks closed chapter scopes (default includeOpen=false)', () => {
    const events: AgentEvent[] = [
      taskStart('parent', 0),
      action(1),
      taskStart('__chapter__', 2),
      action(3),
      success(4),
      action(5),
    ]
    const skip = buildChapterScopeFilter(events)
    // Closed scope [2..4] is marked.
    expect(skip.has(2)).toBe(true)
    expect(skip.has(3)).toBe(true)
    expect(skip.has(4)).toBe(true)
    // Parent's events stay unmarked.
    expect(skip.has(0)).toBe(false)
    expect(skip.has(1)).toBe(false)
    expect(skip.has(5)).toBe(false)
  })

  it('leaves open chapter scopes unmarked when includeOpen=false', () => {
    // The renderer needs the running chapter task's own taskStart and
    // prior turns visible so its own loop can render itself.
    const events: AgentEvent[] = [taskStart('parent', 0), taskStart('__chapter__', 1), action(2)]
    const skip = buildChapterScopeFilter(events) // default false
    expect(skip.size).toBe(0)
  })

  it('marks open chapter scopes when includeOpen=true', () => {
    // The boundary index builder filters even open scopes — the
    // running chapter task's bookkeeping must never appear as a
    // foldable boundary.
    const events: AgentEvent[] = [taskStart('parent', 0), taskStart('__chapter__', 1), action(2)]
    const skip = buildChapterScopeFilter(events, true)
    expect(skip.has(1)).toBe(true)
    expect(skip.has(2)).toBe(true)
    // Parent stays visible.
    expect(skip.has(0)).toBe(false)
  })
})
