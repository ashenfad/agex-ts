/**
 * Nested chaptering — a chapter task may chapter a range that
 * includes prior ChapterEvents. The overlay must surface the
 * outer-then-inner hierarchy:
 *
 *   /chapters/<outer-slug>/summary.md
 *   /chapters/<outer-slug>/chapters/<inner-slug>/summary.md
 *   /chapters/<outer-slug>/chapters/<inner-slug>/events/...
 *
 * And the parent event log must end up with the outer chapter in
 * place of the (already-chaptered) inner chapter ranges.
 *
 * Boundary-based chaptering: chapters and tasks are both first-class
 * boundary entries in the index. Picking a range like `[1, 2]` over
 * two prior chapter events folds them into a higher-level chapter.
 */

import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { Dummy } from '../src/llm/dummy'
import { evalRuntime } from '../src/runtime/eval'
import type { AgentEvent, ChapterEvent, LLMResponse } from '../src/types'

const dec = new TextDecoder()

const finishTurn: LLMResponse = {
  emissions: [{ type: 'ts', code: 'taskSuccess(null)' }],
  inputTokens: 50,
}

const heavyNonTerminal: LLMResponse = {
  emissions: [{ type: 'ts', code: '/* heavy */' }],
  inputTokens: 5000,
}

describe('nested chaptering', () => {
  it('produces a hierarchical /chapters/<outer>/chapters/<inner>/ layout and the right log shape', async () => {
    // Multi-task scenario: tasks A, B complete normally, then task C
    // runs a heavy turn that trips chaptering — chapter task #1 folds
    // A and B as two separate chapters (Phase 1, Phase 2). Task C
    // closes out, task D runs a heavy turn that trips chaptering #2,
    // and chapter task #2 wraps the two prior chapters as a single
    // outer chapter "Phases 1+2".
    const responses: LLMResponse[] = [
      // task A: trivial completion
      finishTurn,
      // task B: trivial completion
      finishTurn,
      // task C turn 1: heavy non-terminal — trips chaptering #1
      heavyNonTerminal,
      // chapter task #1: fold tasks A and B into Phase 1 and Phase 2.
      // Boundary index at this point: [1] task A → success,
      // [2] task B → success, [3] task C (in progress).
      {
        emissions: [
          {
            type: 'ts',
            code: 'taskSuccess([{ start: 1, end: 1, name: "Phase 1", message: "did phase 1 work" }, { start: 2, end: 2, name: "Phase 2", message: "did phase 2 work" }])',
          },
        ],
      },
      // task C turn 2: close out
      finishTurn,
      // task D turn 1: heavy non-terminal — trips chaptering #2
      heavyNonTerminal,
      // chapter task #2: log boundaries now [1] chapter Phase 1,
      // [2] chapter Phase 2, [3] task C → success, [4] task D
      // (in progress). Wrap [1,2] (the two prior chapters) into one
      // outer chapter.
      {
        emissions: [
          {
            type: 'ts',
            code: 'taskSuccess([{ start: 1, end: 2, name: "Phases 1+2", message: "rolled up early phases" }])',
          },
        ],
      },
      // task D turn 2: close out
      finishTurn,
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

    const taskA = agent.task<undefined, null>({ description: 'Task A.' })
    const taskB = agent.task<undefined, null>({ description: 'Task B.' })
    const taskC = agent.task<undefined, null>({ description: 'Task C.' })
    const taskD = agent.task<undefined, null>({ description: 'Task D.' })
    await taskA(undefined)
    await taskB(undefined)
    await taskC(undefined)
    await taskD(undefined)

    // -- Parent log holds the outer chapter --------------------------------
    const parentEvents: AgentEvent[] = []
    const parentLog = await agent.events('default')
    for await (const e of parentLog.iter()) parentEvents.push(e)

    const chapterEvents = parentEvents.filter((e): e is ChapterEvent => e.type === 'chapter')
    // Only the outer chapter remains in the active log — the two
    // inner chapters were folded into it.
    expect(chapterEvents.length).toBe(1)
    const outer = chapterEvents[0] as ChapterEvent
    expect(outer.name).toBe('Phases 1+2')

    // The outer's eventRefs hold the two inner chapters.
    expect(outer.eventRefs.length).toBe(2)
    const state = await agent.state()
    const innerSlugs: string[] = []
    for (const ref of outer.eventRefs) {
      const inner = (await state.get(ref)) as AgentEvent | undefined
      expect(inner?.type).toBe('chapter')
      if (inner?.type === 'chapter') innerSlugs.push(inner.slug)
    }
    expect(innerSlugs.sort()).toEqual(['phase-1', 'phase-2'])

    // -- VFS overlay shape -------------------------------------------------
    const fs = await agent.fs('default')
    // Outer summary at the top level
    const outerSummary = await fs.read(`/chapters/${outer.slug}/summary.md`)
    expect(dec.decode(outerSummary)).toContain('Phases 1+2')
    expect(dec.decode(outerSummary)).toContain('rolled up early phases')

    // The outer chapter's children directory contains its inner
    // chapters under `/chapters/<outer>/chapters/`
    const innerNames = await fs.list(`/chapters/${outer.slug}/chapters`)
    expect(innerNames.sort()).toEqual(['phase-1', 'phase-2'])

    // Each inner chapter has its own summary
    const phase1Summary = await fs.read(`/chapters/${outer.slug}/chapters/phase-1/summary.md`)
    expect(dec.decode(phase1Summary)).toContain('Phase 1')
    expect(dec.decode(phase1Summary)).toContain('did phase 1 work')

    const phase2Summary = await fs.read(`/chapters/${outer.slug}/chapters/phase-2/summary.md`)
    expect(dec.decode(phase2Summary)).toContain('Phase 2')
    expect(dec.decode(phase2Summary)).toContain('did phase 2 work')
  })

  it('slug collisions are resolved with -2, -3, ... suffixes', async () => {
    // Two chapters with the same name in the same session — the
    // second gets `-2` appended. Multi-task scenario: tasks A and B
    // complete, task C runs heavy and chaptering folds A and B into
    // two chapters both named "Work".
    const responses: LLMResponse[] = [
      finishTurn, // task A
      finishTurn, // task B
      heavyNonTerminal, // task C heavy turn
      // Chapter task: fold A and B as two chapters with the same name.
      {
        emissions: [
          {
            type: 'ts',
            code: 'taskSuccess([{ start: 1, end: 1, name: "Work", message: "first" }, { start: 2, end: 2, name: "Work", message: "second" }])',
          },
        ],
      },
      finishTurn, // task C close-out
    ]
    const agent = await createAgent({
      name: 'slug-collide',
      llm: new Dummy({ responses }),
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
    })
    agent.chapterTask({ description: 'Compact.' })
    const taskA = agent.task<undefined, null>({ description: 'A.' })
    const taskB = agent.task<undefined, null>({ description: 'B.' })
    const taskC = agent.task<undefined, null>({ description: 'C.' })
    await taskA(undefined)
    await taskB(undefined)
    await taskC(undefined)

    const slugs: string[] = []
    const log = await agent.events('default')
    for await (const e of log.iter()) {
      if (e.type === 'chapter') slugs.push(e.slug)
    }
    expect(slugs.sort()).toEqual(['work', 'work-2'])

    const fs = await agent.fs('default')
    const top = await fs.list('/chapters')
    expect(top.sort()).toEqual(['work', 'work-2'])
  })
})
