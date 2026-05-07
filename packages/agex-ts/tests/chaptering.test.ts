import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { isChapteringInFlight, shouldTriggerChaptering } from '../src/chaptering'
import { Dummy } from '../src/llm/dummy'
import { evalRuntime } from '../src/runtime/eval'
import type { AgentEvent, ChapterEvent, LLMResponse } from '../src/types'

describe('shouldTriggerChaptering', () => {
  it('false when threshold is undefined', () => {
    expect(shouldTriggerChaptering([], undefined)).toBe(false)
  })

  it('false when no ActionEvent has been logged', () => {
    expect(shouldTriggerChaptering([], 1000)).toBe(false)
  })

  it('false when latest action has no inputTokens', () => {
    const events: AgentEvent[] = [{ type: 'action', timestamp: 't', agentName: 'a', emissions: [] }]
    expect(shouldTriggerChaptering(events, 1000)).toBe(false)
  })

  it('false when latest action is below threshold', () => {
    const events: AgentEvent[] = [
      { type: 'action', timestamp: 't', agentName: 'a', emissions: [], inputTokens: 500 },
    ]
    expect(shouldTriggerChaptering(events, 1000)).toBe(false)
  })

  it('true when latest action meets or exceeds threshold', () => {
    const events: AgentEvent[] = [
      { type: 'action', timestamp: 't', agentName: 'a', emissions: [], inputTokens: 1500 },
    ]
    expect(shouldTriggerChaptering(events, 1000)).toBe(true)
    expect(shouldTriggerChaptering(events, 1500)).toBe(true)
  })

  it('reads the most recent ActionEvent only (not aggregated)', () => {
    const events: AgentEvent[] = [
      { type: 'action', timestamp: 't0', agentName: 'a', emissions: [], inputTokens: 5000 },
      { type: 'output', timestamp: 't1', agentName: 'a', parts: [] },
      { type: 'action', timestamp: 't2', agentName: 'a', emissions: [], inputTokens: 100 },
    ]
    expect(shouldTriggerChaptering(events, 1000)).toBe(false)
  })
})

/** Build a Dummy with responses interleaved in the order the action
 *  loop will actually consume them. Order matters: parent turn N
 *  → if chaptering trips, chapter task turn(s) → parent turn N+1. */
function dummyWith(responses: ReadonlyArray<LLMResponse | Error>): Dummy {
  return new Dummy({ responses })
}

const heavyTurn: LLMResponse = {
  emissions: [{ type: 'ts', code: '/* think */' }],
  inputTokens: 5000,
}
const finishTurn: LLMResponse = {
  emissions: [{ type: 'ts', code: 'taskSuccess(null)' }],
  inputTokens: 50,
}

async function runChapterAgent(opts: {
  responses: ReadonlyArray<LLMResponse | Error>
  withChapterTask: boolean
}) {
  const llm = dummyWith(opts.responses)
  const agent = await createAgent({
    name: 'A',
    llm,
    runtime: evalRuntime(),
    chapteringTrigger: 1000,
  })
  if (opts.withChapterTask) {
    agent.chapterTask({ description: 'Summarize completed task ranges into chapters.' })
  }
  const fn = agent.task<undefined, null>({ description: 'X.' })
  const events: AgentEvent[] = []
  await fn(undefined, { onEvent: (e) => void events.push(e) })
  return { agent, llm, events }
}

describe('chaptering — chapterTask integration', () => {
  it('does not fire when no chapter task is registered', async () => {
    const { events } = await runChapterAgent({
      responses: [
        { emissions: [{ type: 'ts', code: 'taskSuccess(null)' }], inputTokens: 1_000_000 },
      ],
      withChapterTask: false,
    })
    expect(events.find((e) => e.type === 'chapter')).toBeUndefined()
  })

  it('runs the chapter task when threshold is exceeded', async () => {
    const { events } = await runChapterAgent({
      // Order: parent heavy → triggers chaptering → chapter task → parent finish
      responses: [
        heavyTurn,
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 2, end: 2, name: "warmup", message: "thought briefly" }])',
            },
          ],
        },
        finishTurn,
      ],
      withChapterTask: true,
    })

    const chapters = events.filter((e): e is ChapterEvent => e.type === 'chapter')
    expect(chapters.length).toBe(1)
    expect(chapters[0]?.name).toBe('warmup')
    expect(chapters[0]?.message).toBe('thought briefly')
    // eventRefs holds the actual state keys that the chapter replaced.
    // Per-session isolation now lives at the substrate layer, so refs
    // start with `evt/` (no session segment).
    expect(chapters[0]?.eventRefs.length).toBe(1)
    expect(chapters[0]?.eventRefs.every((r) => r.startsWith('evt/'))).toBe(true)
  })

  it('emits a SystemNoteEvent when the chapter task throws', async () => {
    const { events } = await runChapterAgent({
      responses: [
        heavyTurn,
        // Chapter task fails
        { emissions: [{ type: 'ts', code: 'taskFail("summary api down")' }] },
        finishTurn,
      ],
      withChapterTask: true,
    })

    const note = events.find((e) => e.type === 'systemNote')
    expect(note).toBeDefined()
    expect((note as { message: string }).message).toMatch(/chaptering failed/)
    expect(events.find((e) => e.type === 'chapter')).toBeUndefined()
  })

  it('emits a SystemNoteEvent when the chapter task returns malformed output', async () => {
    const { events } = await runChapterAgent({
      responses: [
        heavyTurn,
        // Wrong shape
        { emissions: [{ type: 'ts', code: 'taskSuccess("not an array")' }] },
        finishTurn,
      ],
      withChapterTask: true,
    })

    const note = events.find((e) => e.type === 'systemNote')
    expect(note).toBeDefined()
    expect((note as { message: string }).message).toMatch(/must return an array/)
  })

  it('chapter task events go to a child session, not the parent log', async () => {
    const { agent } = await runChapterAgent({
      responses: [
        heavyTurn,
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 2, end: 2, name: "x", message: "y" }])',
            },
          ],
        },
        finishTurn,
      ],
      withChapterTask: true,
    })

    const parentEvents: AgentEvent[] = []
    const parentLog = await agent.events('default')
    for await (const e of parentLog.iter()) parentEvents.push(e)
    const childEvents: AgentEvent[] = []
    const childLog = await agent.events('default.__chapter__')
    for await (const e of childLog.iter()) childEvents.push(e)

    // Parent session: one taskStart (the parent task)
    expect(parentEvents.filter((e) => e.type === 'taskStart').length).toBe(1)
    // Child session: one taskStart (the chapter task)
    expect(childEvents.filter((e) => e.type === 'taskStart').length).toBe(1)
    // The chapter task's success lives in the child log too
    expect(childEvents.filter((e) => e.type === 'success').length).toBe(1)
    // The parent's chapter event lives in the parent log
    expect(parentEvents.filter((e) => e.type === 'chapter').length).toBe(1)
  })

  it('chaptering does not recurse — the chapter task itself does not trigger chaptering', async () => {
    // Configure threshold so even the chapter task's action would
    // trip it if the recursion guard were missing.
    const { events } = await runChapterAgent({
      responses: [
        // Parent turn 1 — heavy → trips chaptering
        { emissions: [{ type: 'ts', code: '/* think */' }], inputTokens: 5000 },
        // Chapter task turn — also heavy, but guard prevents re-fire
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 2, end: 2, name: "n", message: "m" }])',
            },
          ],
          inputTokens: 9999,
        },
        // Parent turn 2 — finish
        finishTurn,
      ],
      withChapterTask: true,
    })

    // Exactly one chapter event — the recursion guard worked
    expect(events.filter((e) => e.type === 'chapter').length).toBe(1)
  })
})

describe('isChapteringInFlight (recursion guard)', () => {
  it('is false outside of a chapter run', async () => {
    const agent = await createAgent({ name: 'A' })
    expect(isChapteringInFlight(agent)).toBe(false)
  })
})
