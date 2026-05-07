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

const finishTurn: LLMResponse = {
  emissions: [{ type: 'ts', code: 'taskSuccess(null)' }],
  inputTokens: 50,
}

const heavyNonTerminal: LLMResponse = {
  // Non-terminal heavy turn — its inputTokens trips chaptering, then
  // the loop continues to the next response (the chapter task's
  // emission, then the task's eventual taskSuccess).
  emissions: [{ type: 'ts', code: '/* think */' }],
  inputTokens: 5000,
}

/** Run a multi-task scenario: task A completes, task B completes,
 *  then task C runs with a heavy non-terminal turn that trips
 *  chaptering. By the time chaptering fires, the boundary index has
 *  three entries — `task "A"`, `task "B"`, `task "C" (in progress)` —
 *  so the chapter task can meaningfully pick a range like
 *  `{ start: 1, end: 2 }` to fold the two completed tasks.
 *
 *  Returns the agent and the full ordered event stream observed via
 *  onEvent across all task invocations. */
async function runMultiTaskScenario(opts: {
  responses: ReadonlyArray<LLMResponse | Error>
  withChapterTask: boolean
}) {
  const llm = new Dummy({ responses: opts.responses })
  const agent = await createAgent({
    name: 'A',
    llm,
    runtime: evalRuntime(),
    // chapteringTrigger auto-registers the chapter task internally.
    // When disabled, no trigger means no chaptering.
    ...(opts.withChapterTask && { chapteringTrigger: 1000 }),
  })

  const events: AgentEvent[] = []
  const onEvent = (e: AgentEvent) => void events.push(e)

  // Three sequential tasks against the default session — they share
  // one substrate so chaptering inside task C sees boundaries from
  // tasks A and B.
  const taskA = agent.task<undefined, null>({ description: 'Task A.' })
  const taskB = agent.task<undefined, null>({ description: 'Task B.' })
  const taskC = agent.task<undefined, null>({ description: 'Task C.' })
  await taskA(undefined, { onEvent })
  await taskB(undefined, { onEvent })
  await taskC(undefined, { onEvent })
  return { agent, llm, events }
}

describe('chaptering — chapterTask integration', () => {
  it('does not fire when no chapter task is registered', async () => {
    const { events } = await runMultiTaskScenario({
      responses: [
        finishTurn, // task A
        finishTurn, // task B
        // Task C: heavy non-terminal — would trigger chaptering if a
        // chapter task were registered.
        { emissions: [{ type: 'ts', code: 'taskSuccess(null)' }], inputTokens: 1_000_000 },
      ],
      withChapterTask: false,
    })
    expect(events.find((e) => e.type === 'chapter')).toBeUndefined()
  })

  it('runs the chapter task when threshold is exceeded', async () => {
    const { events } = await runMultiTaskScenario({
      responses: [
        finishTurn, // task A
        finishTurn, // task B
        heavyNonTerminal, // task C turn 1 — trips chaptering
        // Chapter task: fold boundaries 1+2 (tasks A and B).
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 2, name: "warmup", message: "thought briefly" }])',
            },
          ],
        },
        finishTurn, // task C turn 2 — close out
      ],
      withChapterTask: true,
    })

    const chapters = events.filter((e): e is ChapterEvent => e.type === 'chapter')
    expect(chapters.length).toBe(1)
    expect(chapters[0]?.name).toBe('warmup')
    expect(chapters[0]?.message).toBe('thought briefly')
    // eventRefs holds the actual state keys that were folded — every
    // event from task A's start through task B's success.
    expect(chapters[0]?.eventRefs.length).toBeGreaterThanOrEqual(2)
    expect(chapters[0]?.eventRefs.every((r) => r.startsWith('evt/'))).toBe(true)
  })

  it('emits a SystemNoteEvent when the chapter task throws', async () => {
    const { events } = await runMultiTaskScenario({
      responses: [
        finishTurn,
        finishTurn,
        heavyNonTerminal,
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
    const { events } = await runMultiTaskScenario({
      responses: [
        finishTurn,
        finishTurn,
        heavyNonTerminal,
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

  it('chapter task events live in the parent log (no child session)', async () => {
    // After the substrate-unification + boundary-based chaptering
    // redirect, the chapter task runs in the parent's session so its
    // LLM sees the parent's full conversation. Its bookkeeping events
    // (taskStart "__chapter__", action, success) land in the parent
    // log — they're filtered from LLM render, but visible to UI / undo
    // / iter().
    const { agent } = await runMultiTaskScenario({
      responses: [
        finishTurn,
        finishTurn,
        heavyNonTerminal,
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 2, name: "x", message: "y" }])',
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

    // taskStart events: tasks A, B, C plus the __chapter__ task. Tasks
    // A and B were folded into a chapter event though — their refs
    // moved out of the active index. So the active index at this
    // point holds: ChapterEvent (folds A+B), task C's taskStart,
    // task C's action(s), __chapter__ taskStart, __chapter__ action,
    // __chapter__ success, task C's final action+success.
    const chapterTaskStarts = parentEvents.filter(
      (e) => e.type === 'taskStart' && e.taskName === '__chapter__',
    )
    expect(chapterTaskStarts.length).toBe(1)
    expect(parentEvents.filter((e) => e.type === 'chapter').length).toBe(1)
  })

  it('chaptering does not recurse — the chapter task itself does not trigger chaptering', async () => {
    // Configure threshold so even the chapter task's action would
    // trip it if the recursion guard were missing.
    const { events } = await runMultiTaskScenario({
      responses: [
        finishTurn, // task A
        finishTurn, // task B
        heavyNonTerminal, // task C heavy turn — trips chaptering
        // Chapter task action — also heavy, but guard prevents re-fire.
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 2, name: "n", message: "m" }])',
            },
          ],
          inputTokens: 9999,
        },
        finishTurn, // task C close-out
      ],
      withChapterTask: true,
    })

    // Exactly one chapter event — the recursion guard worked.
    expect(events.filter((e) => e.type === 'chapter').length).toBe(1)
  })
})

describe('chaptering — single-task scenarios are a no-op', () => {
  it('a single in-progress task offers no foldable boundaries — chapter task is not invoked', async () => {
    // With only one task and no completed prior work, the boundary
    // index has just one entry ("task X (in progress)"). Per the
    // primer's rules, in-progress work shouldn't be chaptered — and
    // there's nothing else. The runtime detects this and *skips*
    // the chapter task entirely (no LLM call, no bookkeeping
    // events). The trigger will simply re-fire next turn if the
    // task is still over budget; if other tasks have completed by
    // then, those become foldable.
    const llm = new Dummy({
      responses: [
        // Task X turn 1 — heavy. No chapter task LLM call follows
        // because the runtime skips chaptering when nothing is
        // foldable.
        heavyNonTerminal,
        // Task X turn 2 — close-out
        finishTurn,
      ],
    })
    const agent = await createAgent({
      name: 'A',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
    })
    const events: AgentEvent[] = []
    const fn = agent.task<undefined, null>({ description: 'X.' })
    await fn(undefined, { onEvent: (e) => void events.push(e) })

    expect(events.filter((e) => e.type === 'chapter').length).toBe(0)
    // No chapter task bookkeeping in the log either — the runtime
    // skipped invocation entirely.
    expect(
      events.filter((e) => e.type === 'taskStart' && e.taskName === '__chapter__').length,
    ).toBe(0)
    // Two LLM calls total: task X turn 1, task X turn 2. No chapter
    // task call.
    expect(llm.callCount).toBe(2)
  })
})

describe('chaptering — multi-turn chapter task', () => {
  it('the chapter task sees its own prior turns when its own scope is open', async () => {
    // Filter A's contract: while the chapter task is running, its own
    // taskStart and any prior-turn actions must remain visible to
    // renderEvents — the chapter task LLM needs its own conversation
    // history when it goes to call the LLM on turn 2+. Filter B (the
    // boundary index) is the opposite — it must never enumerate the
    // running chapter task's events as foldable boundaries.
    //
    // We exercise the multi-turn case by having the chapter task emit
    // a non-terminal action on its first turn, then taskSuccess on
    // its second turn. If Filter A incorrectly hides the chapter
    // task's own prior turn, the LLM response queue gets out of sync
    // (the renderer's expected turns don't match what the LLM sees).
    const llm = new Dummy({
      responses: [
        finishTurn, // task A
        finishTurn, // task B
        heavyNonTerminal, // task C heavy → triggers chaptering
        // Chapter task turn 1 — emits a non-terminal action so the
        // chapter task runs a second turn.
        { emissions: [{ type: 'ts', code: '/* picking which to fold */' }] },
        // Chapter task turn 2 — finally taskSuccess. By now the
        // chapter task's loop has rendered events including its own
        // turn-1 taskStart + action. Filter A must keep the open
        // scope visible.
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 2, name: "early", message: "tasks A and B" }])',
            },
          ],
        },
        finishTurn, // task C close-out
      ],
    })
    const agent = await createAgent({
      name: 'A',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
    })
    const taskA = agent.task<undefined, null>({ description: 'A.' })
    const taskB = agent.task<undefined, null>({ description: 'B.' })
    const taskC = agent.task<undefined, null>({ description: 'C.' })
    await taskA(undefined)
    await taskB(undefined)
    await taskC(undefined)

    // Chapter actually applied (chapter task ran 2 turns + emitted
    // a valid Chapter[]).
    const events: AgentEvent[] = []
    const log = await agent.events('default')
    for await (const e of log.iter()) events.push(e)
    expect(events.filter((e) => e.type === 'chapter').length).toBe(1)
  })
})

describe('isChapteringInFlight (recursion guard)', () => {
  it('is false outside of a chapter run', async () => {
    const agent = await createAgent({ name: 'A' })
    expect(isChapteringInFlight(agent)).toBe(false)
  })
})
