/**
 * Nested chaptering — a chapter task may chapter a range that
 * includes prior ChapterEvents. The overlay must surface the
 * outer-then-inner hierarchy:
 *
 *   /chapters/<outer-slug>/summary.md
 *   /chapters/<outer-slug>/chapters/<inner-slug>/summary.md
 *   /chapters/<outer-slug>/chapters/<inner-slug>/events/...
 *
 * And the parent event log must end up with just the outer chapter
 * in place of the (already-chaptered) inner chapter ranges.
 */

import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { Dummy } from '../src/llm/dummy'
import { evalRuntime } from '../src/runtime/eval'
import type { AgentEvent, ChapterEvent, LLMResponse } from '../src/types'

const dec = new TextDecoder()

describe('nested chaptering', () => {
  it('produces a hierarchical /chapters/<outer>/chapters/<inner>/ layout and the right log shape', async () => {
    // Three parent turns, each heavy enough to trigger chaptering.
    // Each chapter task call produces one chapter, so after turn 1
    // and turn 2 we have two ChapterEvents in the parent log. The
    // chapter task on turn 3 sees those existing chapters in its
    // numbered index and chooses to wrap them in a single outer
    // chapter.
    const responses: LLMResponse[] = [
      // Parent turn 1 — heavy
      {
        emissions: [{ type: 'ts', code: '/* phase 1 work */' }],
        inputTokens: 5000,
      },
      // Chapter task #1 — chapter the action that just landed
      // (event positions: [1] taskStart, [2] action) → chapter [2]
      {
        emissions: [
          {
            type: 'ts',
            code: 'taskSuccess([{ start: 2, end: 2, name: "Phase 1", message: "did phase 1 work" }])',
          },
        ],
      },
      // Parent turn 2 — heavy again
      {
        emissions: [{ type: 'ts', code: '/* phase 2 work */' }],
        inputTokens: 5000,
      },
      // Chapter task #2 — log now: [1] taskStart, [2] chapter "Phase 1",
      // [3] action(turn 2). Chapter the new action: [3].
      {
        emissions: [
          {
            type: 'ts',
            code: 'taskSuccess([{ start: 3, end: 3, name: "Phase 2", message: "did phase 2 work" }])',
          },
        ],
      },
      // Parent turn 3 — heavy
      {
        emissions: [{ type: 'ts', code: '/* phase 3 work */' }],
        inputTokens: 5000,
      },
      // Chapter task #3 — log now: [1] taskStart, [2] chapter "Phase 1",
      // [3] chapter "Phase 2", [4] action(turn 3). The chapter task
      // wraps the two existing chapters into one outer chapter
      // covering positions [2,3].
      {
        emissions: [
          {
            type: 'ts',
            code: 'taskSuccess([{ start: 2, end: 3, name: "Phases 1+2", message: "rolled up early phases" }])',
          },
        ],
      },
      // Parent turn 4 — finish
      {
        emissions: [{ type: 'ts', code: 'taskSuccess(null)' }],
        inputTokens: 50,
      },
    ]
    const llm = new Dummy({ responses })

    const agent = await createAgent({
      name: 'nested',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
      chapteringTrigger: 1000,
    })
    agent.chapterTask({ description: 'Compact prior task ranges into chapters.' })

    const fn = agent.task<undefined, null>({ description: 'Multi-phase work.' })
    await fn(undefined)

    // -- Parent log shape -----------------------------------------------
    // Final order: taskStart, chapter "Phases 1+2" (which holds the
    // two inner chapters via eventRefs), action(turn 3), action(turn 4
    // that called taskSuccess), success.
    const parentEvents: AgentEvent[] = []
    for await (const e of agent.events('default').iter()) parentEvents.push(e)
    const types = parentEvents.map((e) => e.type)
    expect(types).toEqual(['taskStart', 'chapter', 'action', 'action', 'success'])

    const outer = parentEvents.find((e) => e.type === 'chapter') as ChapterEvent
    expect(outer.name).toBe('Phases 1+2')
    expect(outer.eventRefs.length).toBe(2)
    // Both inner refs point at the prior ChapterEvents
    for (const ref of outer.eventRefs) {
      const inner = (await agent.state().get(ref)) as AgentEvent | undefined
      expect(inner?.type).toBe('chapter')
    }

    // -- VFS overlay shape ----------------------------------------------
    const fs = agent.fs('default')
    // Outer summary at the top level
    const outerSummary = await fs.read(`/chapters/${outer.slug}/summary.md`)
    expect(dec.decode(outerSummary)).toContain('Phases 1+2')
    expect(dec.decode(outerSummary)).toContain('rolled up early phases')

    // The outer chapter's children directory contains its inner
    // chapters under `/chapters/<outer>/chapters/`
    const innerNames = await fs.list(`/chapters/${outer.slug}/chapters`)
    expect(innerNames.sort()).toEqual(['phase-1', 'phase-2'])

    // Each inner chapter has its own summary + per-event files
    const phase1Summary = await fs.read(`/chapters/${outer.slug}/chapters/phase-1/summary.md`)
    expect(dec.decode(phase1Summary)).toContain('Phase 1')
    expect(dec.decode(phase1Summary)).toContain('did phase 1 work')

    const phase1Events = await fs.list(`/chapters/${outer.slug}/chapters/phase-1/events`)
    expect(phase1Events.length).toBe(1) // the heavy action from turn 1
    const ev = await fs.read(`/chapters/${outer.slug}/chapters/phase-1/events/${phase1Events[0]}`)
    expect(dec.decode(ev)).toContain('phase 1 work')
  })

  it('slug collisions are resolved with -2, -3, ... suffixes', async () => {
    // Two chapters with the same name in the same session — second
    // gets `-2` appended.
    const responses: LLMResponse[] = [
      // Turn 1 heavy
      { emissions: [{ type: 'ts', code: '/* a */' }], inputTokens: 5000 },
      // Chapter the action: name "Work"
      {
        emissions: [
          {
            type: 'ts',
            code: 'taskSuccess([{ start: 2, end: 2, name: "Work", message: "first" }])',
          },
        ],
      },
      // Turn 2 heavy
      { emissions: [{ type: 'ts', code: '/* b */' }], inputTokens: 5000 },
      // Chapter the new action: same name "Work"
      // Log positions: [1] taskStart, [2] chapter "Work", [3] action
      {
        emissions: [
          {
            type: 'ts',
            code: 'taskSuccess([{ start: 3, end: 3, name: "Work", message: "second" }])',
          },
        ],
      },
      // Turn 3 finish
      { emissions: [{ type: 'ts', code: 'taskSuccess(null)' }], inputTokens: 50 },
    ]
    const agent = await createAgent({
      name: 'slug-collide',
      llm: new Dummy({ responses }),
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
    })
    agent.chapterTask({ description: 'Compact.' })
    await agent.task<undefined, null>({ description: 'X.' })(undefined)

    const slugs: string[] = []
    for await (const e of agent.events('default').iter()) {
      if (e.type === 'chapter') slugs.push(e.slug)
    }
    expect(slugs).toEqual(['work', 'work-2'])

    const fs = agent.fs('default')
    const top = await fs.list('/chapters')
    expect(top.sort()).toEqual(['work', 'work-2'])
  })
})
