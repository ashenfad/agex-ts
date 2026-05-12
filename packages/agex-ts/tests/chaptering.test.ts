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

const heavyFinishTurn: LLMResponse = {
  // Heavy task-completing turn — its inputTokens trips the chaptering
  // trigger when checked at the task boundary. Chaptering fires after
  // the task's success event lands in the log.
  emissions: [{ type: 'ts', code: 'taskSuccess(null)' }],
  inputTokens: 5000,
}

/** Run a multi-task scenario: task A completes, task B completes,
 *  then task C runs as a single heavy turn whose inputTokens exceed
 *  the chaptering threshold. Chaptering fires at task C's boundary
 *  (after its success event lands). The boundary index then has three
 *  entries — `task "A" → success`, `task "B" → success`, `task "C" →
 *  success` — and the chapter task can fold `{ start: 1, end: 2 }`
 *  (tasks A and B). The just-completed task C is itself foldable but
 *  the agent typically chooses to leave it alone; tests can pick
 *  whichever range they want.
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
        heavyFinishTurn, // task C — high inputTokens, completes
        // Chapter task: fires at task C's boundary; folds [1, 2] (A+B).
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 2, name: "warmup", message: "thought briefly" }])',
            },
          ],
        },
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
        heavyFinishTurn,
        // Chapter task fails — fires at task C's boundary
        { emissions: [{ type: 'ts', code: 'taskFail("summary api down")' }] },
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
        heavyFinishTurn,
        // Wrong shape
        { emissions: [{ type: 'ts', code: 'taskSuccess("not an array")' }] },
      ],
      withChapterTask: true,
    })

    const note = events.find((e) => e.type === 'systemNote')
    expect(note).toBeDefined()
    expect((note as { message: string }).message).toMatch(/must return an array/)
  })

  it('chapter task events live in the parent log (no child session)', async () => {
    // The chapter task runs in the parent's session so its LLM sees
    // the parent's full conversation. Its bookkeeping events
    // (taskStart "__chapter__", action, success) land in the parent
    // log — filtered from LLM render, but visible to UI / undo /
    // iter().
    const { agent } = await runMultiTaskScenario({
      responses: [
        finishTurn,
        finishTurn,
        heavyFinishTurn,
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 2, name: "x", message: "y" }])',
            },
          ],
        },
      ],
      withChapterTask: true,
    })

    const parentEvents: AgentEvent[] = []
    const parentLog = await agent.events('default')
    for await (const e of parentLog.iter()) parentEvents.push(e)

    // After chaptering folds A+B, the active log holds: ChapterEvent
    // (folds A+B), task C's full range, plus the chapter task's
    // bookkeeping (taskStart "__chapter__", action, success) appended
    // *after* task C's success since chaptering fires post-task-end.
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
        heavyFinishTurn, // task C — trips chaptering at boundary
        // Chapter task action — also heavy, but guard prevents re-fire
        // when the chapter task itself ends.
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 2, name: "n", message: "m" }])',
            },
          ],
          inputTokens: 9999,
        },
      ],
      withChapterTask: true,
    })

    // Exactly one chapter event — the recursion guard worked.
    expect(events.filter((e) => e.type === 'chapter').length).toBe(1)
  })
})

describe('chaptering — single-task scenarios', () => {
  it('a light-token single task does not trip the trigger — no chapter task invocation', async () => {
    // Trigger gating: shouldTriggerChaptering checks the latest
    // ActionEvent's inputTokens against chapteringTrigger. If no
    // action exceeds the threshold, the chapter task isn't invoked
    // even at the task boundary.
    const llm = new Dummy({ responses: [finishTurn] }) // inputTokens: 50
    const agent = await createAgent({
      name: 'A',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
    })
    const events: AgentEvent[] = []
    await agent.task<undefined, null>({ description: 'X.' })(undefined, {
      onEvent: (e) => void events.push(e),
    })

    expect(events.filter((e) => e.type === 'chapter').length).toBe(0)
    expect(
      events.filter((e) => e.type === 'taskStart' && e.taskName === '__chapter__').length,
    ).toBe(0)
    // One LLM call: the task's only turn. No chapter task call.
    expect(llm.callCount).toBe(1)
  })

  it('a heavy single task triggers chaptering at its boundary — agent may fold itself', async () => {
    // Under task-boundary firing, a just-completed task is a
    // completable boundary. The chapter task is invoked with that
    // single boundary in the index; it can choose to fold itself,
    // leave it alone, or fold nothing. Here the test agent picks
    // `[1, 1]` to fold the parent.
    const llm = new Dummy({
      responses: [
        heavyFinishTurn, // task X — high inputTokens, completes
        // Chapter task fires at task X's boundary; folds X itself.
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 1, name: "the-work", message: "did X" }])',
            },
          ],
        },
      ],
    })
    const agent = await createAgent({
      name: 'A',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
    })
    const events: AgentEvent[] = []
    await agent.task<undefined, null>({ description: 'X.' })(undefined, {
      onEvent: (e) => void events.push(e),
    })

    // Chapter applied; chapter task ran one turn.
    expect(events.filter((e) => e.type === 'chapter').length).toBe(1)
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
        heavyFinishTurn, // task C — high inputTokens, triggers chaptering at boundary
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

describe('chaptering — multi-turn parent task triggers at the boundary', () => {
  it('mid-task heavy turns do not fire chaptering — only the post-completion check does', async () => {
    // Under task-boundary firing, chaptering does not fire mid-loop.
    // A multi-turn parent task can have heavy turns in the middle;
    // chaptering checks only when the task completes. The trigger
    // gate (latest action's inputTokens >= threshold) reads the
    // close-out turn, which in real usage carries the cumulative
    // conversation tokens — so a task that grew heavy will still
    // be over the threshold at completion. (Test fixture mimics
    // this by giving the close-out turn high inputTokens.)
    const llm = new Dummy({
      responses: [
        finishTurn, // task A — completes
        finishTurn, // task B — completes
        // Task C: multi-turn parent.
        // Turn 1: a non-terminal action with low inputTokens. Under
        // per-action firing this would not have triggered chaptering
        // either; under task-boundary firing it definitely doesn't.
        { emissions: [{ type: 'ts', code: '/* working */' }], inputTokens: 200 },
        // Turn 2: another non-terminal action.
        { emissions: [{ type: 'ts', code: '/* still working */' }], inputTokens: 500 },
        // Turn 3: heavy close-out (cumulative inputTokens trips trigger).
        heavyFinishTurn,
        // Chapter task: fires *after* task C's success event lands.
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 2, name: "early-phase", message: "did A then B" }])',
            },
          ],
        },
      ],
    })
    const agent = await createAgent({
      name: 'A',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
    })
    const events: AgentEvent[] = []
    const onEvent = (e: AgentEvent) => void events.push(e)

    const taskA = agent.task<undefined, null>({ description: 'Task A.' })
    const taskB = agent.task<undefined, null>({ description: 'Task B.' })
    const taskC = agent.task<undefined, null>({ description: 'Task C.' })
    await taskA(undefined, { onEvent })
    await taskB(undefined, { onEvent })
    await taskC(undefined, { onEvent })

    // 1. Exactly one ChapterEvent (folding A+B), produced post-task-C.
    expect(events.filter((e) => e.type === 'chapter').length).toBe(1)
    // 2. LLM call count: A=1 + B=1 + C-turn1=1 + C-turn2=1 + C-turn3=1
    //    + chapter=1 = 6.
    expect(llm.callCount).toBe(6)
    // 3. Visible terminal events: A success, B success, C success.
    //    No fail/cancelled. (Chapter task's own success doesn't
    //    propagate through onEvent.)
    const terminals = events.filter((e) => e.type === 'success' || e.type === 'fail')
    expect(terminals.length).toBe(3)
    expect(terminals.every((e) => e.type === 'success')).toBe(true)
  })
})

describe('agent.runChaptering — manual trigger', () => {
  it('bypasses the threshold gate — chapters fold even when latest tokens are low', async () => {
    // Embedder controls when chaptering runs (e.g. a "compact now"
    // UI button). The auto-trigger threshold check doesn't apply.
    // Even with a finishTurn (inputTokens=50) below the trigger of
    // 1000, calling agent.runChaptering(session) folds whatever the
    // chapter task picks.
    const llm = new Dummy({
      responses: [
        finishTurn, // task A
        finishTurn, // task B
        // Chapter task — fires only because the embedder calls
        // agent.runChaptering() directly.
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 2, name: "manual", message: "compacted on demand" }])',
            },
          ],
        },
      ],
    })
    const agent = await createAgent({
      name: 'A',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 1000, // task tokens stay below this; auto wouldn't fire
    })
    const taskA = agent.task<undefined, null>({ description: 'A.' })
    const taskB = agent.task<undefined, null>({ description: 'B.' })
    await taskA(undefined)
    await taskB(undefined)

    // Pre-condition: no chapter applied yet — auto-trigger didn't trip.
    let log = await agent.events('default')
    const preEvents: AgentEvent[] = []
    for await (const e of log.iter()) preEvents.push(e)
    expect(preEvents.filter((e) => e.type === 'chapter').length).toBe(0)

    // Manual call.
    const observed: AgentEvent[] = []
    const applied = await agent.runChaptering('default', {
      onEvent: (e) => void observed.push(e),
    })
    expect(applied).toBe(1)
    expect(observed.filter((e) => e.type === 'chapter').length).toBe(1)

    // Post-condition: one chapter in the log.
    log = await agent.events('default')
    const postEvents: AgentEvent[] = []
    for await (const e of log.iter()) postEvents.push(e)
    expect(postEvents.filter((e) => e.type === 'chapter').length).toBe(1)
  })

  it('returns 0 when chapter task is not registered', async () => {
    const agent = await createAgent({
      name: 'A',
      llm: new Dummy({ responses: [] }),
      runtime: evalRuntime(),
      // chapteringTrigger omitted — no chapter task registered.
    })
    const applied = await agent.runChaptering('default')
    expect(applied).toBe(0)
  })

  it('returns 0 when there is nothing safe to fold', async () => {
    // Manual call with no completed tasks and no prior chapters in
    // the session. Runtime guard catches this — chapter task isn't
    // invoked, no LLM call burned.
    const llm = new Dummy({ responses: [] })
    const agent = await createAgent({
      name: 'A',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
    })
    const applied = await agent.runChaptering('default')
    expect(applied).toBe(0)
    expect(llm.callCount).toBe(0)
  })
})

describe('isChapteringInFlight (recursion guard)', () => {
  it('is false outside of a chapter run', async () => {
    const agent = await createAgent({ name: 'A' })
    expect(isChapteringInFlight(agent)).toBe(false)
  })
})
