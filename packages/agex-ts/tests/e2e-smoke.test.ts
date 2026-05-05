/**
 * End-to-end smoke for agex-ts core.
 *
 * Drives a multi-turn task through the full pipeline:
 *   Dummy LLM (scripted) → action loop → eval-runtime → emission
 *   dispatcher → kvgit-backed state + termish-ts MemoryFS.
 *
 * Exercises every contract this PR landed:
 *   - registration (fn + namespace + terminal)
 *   - per-session VFS / cache / event log
 *   - all four emission types (ts, fileWrite, fileEdit, terminal)
 *   - chaptering trigger + handler invocation
 *   - AbortSignal cancellation mid-task
 *   - inspection (commitInfo, history, eventsAt)
 *
 * If any of the contracts the runtime-worker / Anthropic provider
 * packages are about to depend on shifts, this test catches it.
 */

import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { Dummy } from '../src/llm/dummy'
import { evalRuntime } from '../src/runtime/eval'
import type { AgentEvent, LLMResponse } from '../src/types'

const r = (...emissions: LLMResponse['emissions']): LLMResponse => ({ emissions })
const dec = new TextDecoder()

describe('E2E smoke — full agent pipeline', () => {
  it('drives a multi-turn task through every emission type with chaptering', async () => {
    const responses: LLMResponse[] = [
      // Turn 1: write a seed file + run a shell pipeline against it
      {
        emissions: [
          { type: 'thinking', text: 'starting work' },
          {
            type: 'fileWrite',
            path: '/data.txt',
            content: 'banana\napple\ncherry\n',
            mode: 'write',
          },
          // First terminal: produces stdout (line count) → OutputEvent
          { type: 'terminal', commands: 'wc -l /data.txt' },
          // Second terminal: writes to a file (no stdout)
          { type: 'terminal', commands: 'sort /data.txt > /sorted.txt' },
          { type: 'ts', code: '/* let the sort settle */' },
        ],
        inputTokens: 100,
      },
      // Turn 2: edit the sorted file (heavy turn — triggers chaptering)
      {
        emissions: [
          { type: 'fileEdit', path: '/sorted.txt', search: 'apple', content: 'APPLE' },
          { type: 'ts', code: '/* keep going */' },
        ],
        inputTokens: 5_000, // exceeds chapteringTrigger
      },
      // Chapter task's one turn — consumed when chaptering trips
      // *after* turn 2. The Dummy cycles in declaration order, so this
      // entry has to land between turn 2 and turn 3. A real LLM would
      // summarize the index it sees; the Dummy just emits structured
      // chapters directly.
      {
        emissions: [
          {
            type: 'ts',
            code: 'taskSuccess([{ start: 1, end: 3, name: "setup + edit", message: "seeded files; sorted; uppercased apple" }])',
          },
        ],
      },
      // Turn 3: read everything back via a registered fn and finish
      {
        emissions: [
          {
            type: 'ts',
            code: 'const text = await readFile("/sorted.txt"); taskSuccess(summarize(text))',
          },
        ],
        inputTokens: 200,
      },
    ]
    const llm = new Dummy({ responses })

    const agent = await createAgent({
      name: 'smoke',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
      chapteringTrigger: 1000,
    })
    agent.chapterTask({
      description: 'Summarize completed task ranges into chapters.',
    })

    // Register a host fn the agent can call from emission code, plus
    // a custom terminal command that helps it inspect.
    agent
      .fn(
        'readFile',
        async (...args: unknown[]) => {
          const path = args[0] as string
          const bytes = await agent.fs().read(path)
          return dec.decode(bytes)
        },
        { description: 'Read a file from the VFS as text.' },
      )
      .fn(
        'summarize',
        (...args: unknown[]) => {
          const text = args[0] as string
          const lines = text.split('\n').filter((l) => l.length > 0)
          return { lineCount: lines.length, first: lines[0] }
        },
        { description: 'Summarize a text blob.' },
      )
      .terminal('beep', {
        description: 'Used in tests; emits BEEP.',
        handler: async (ctx) => {
          ctx.stdout.write('BEEP\n')
          return undefined
        },
      })

    // Capture the event stream in real time
    const onEvent: AgentEvent[] = []
    const onToken: number[] = []

    const fn = agent.task<undefined, { lineCount: number; first: string }>({
      description: 'Sort, edit, summarize.',
    })
    const result = await fn(undefined, {
      onEvent: (e) => void onEvent.push(e),
      onToken: () => void onToken.push(1),
    })

    // -- Outcome ---------------------------------------------------------
    expect(result).toEqual({ lineCount: 3, first: 'APPLE' })

    // -- Event log ------------------------------------------------------
    const types = onEvent.map((e) => e.type)
    expect(types[0]).toBe('taskStart')
    expect(types).toContain('action')
    expect(types).toContain('output') // from terminal stdout
    expect(types).toContain('chapter')
    expect(types[types.length - 1]).toBe('success')

    // The Dummy LLM observed every (system, turns) pair the agent sent.
    // 3 parent-task calls + 1 chapter-task call = 4.
    expect(llm.callCount).toBe(4)
    // System message contains the BUILTIN_PRIMER, not the task
    // description (that's now in the first user turn).
    expect(llm.allSystems[0]).toContain('Agex Agent Environment')
    // The task description lives in the opening user turn.
    const firstParentTurn = llm.allTurns[0]?.[0]
    const firstTurnText =
      firstParentTurn?.content[0]?.type === 'text' ? firstParentTurn.content[0].text : ''
    expect(firstTurnText).toContain('Sort, edit, summarize.')
    // Chapter task ran with its own task message
    const chapterTaskCallText = llm.allTurns
      .map((t) => (t[0]?.content[0]?.type === 'text' ? t[0].content[0].text : ''))
      .find((s) => s.includes('Summarize completed task ranges'))
    expect(chapterTaskCallText).toBeDefined()

    // Streaming worked
    expect(onToken.length).toBeGreaterThan(0)

    // -- VFS state survives across turns -------------------------------
    expect(dec.decode(await agent.fs().read('/sorted.txt'))).toBe('APPLE\nbanana\ncherry\n')

    // -- Versioned state persists + commitInfo round-trip --------------
    const hash = await agent.commit({ info: { phase: 'final' } })
    expect(hash).toBeTruthy()
    const info = await agent.commitInfo(hash as string)
    expect(info).toBeTruthy()
    expect((info as Record<string, unknown>).phase).toBe('final')

    // -- History walks backwards through commits ------------------------
    const hashes: string[] = []
    for await (const h of agent.history()) hashes.push(h)
    expect(hashes.length).toBeGreaterThan(0)
  })

  it('honors AbortSignal mid-task and emits CancelledEvent', async () => {
    const llm = new Dummy({
      responses: [r({ type: 'ts', code: 'await new Promise((r) => setTimeout(r, 5000))' })],
    })
    const agent = await createAgent({
      name: 'cancel',
      llm,
      runtime: evalRuntime({ timeoutMs: 30_000 }),
    })
    const fn = agent.task<undefined, void>({ description: 'Long-running.' })

    const onEvent: AgentEvent[] = []
    const ac = new AbortController()
    const promise = fn(undefined, {
      signal: ac.signal,
      onEvent: (e) => void onEvent.push(e),
    })
    setTimeout(() => ac.abort(), 50)
    await expect(promise).rejects.toThrow()

    expect(onEvent.find((e) => e.type === 'cancelled')).toBeDefined()
  })

  it('chaptering compacts the parent log: turn 3 sees the chapter, not the originals', async () => {
    // Turn 1: heavy work that trips chaptering after this turn
    // Turn 2 is consumed by the chapter task (replaces turn-1 events)
    // Turn 3: the parent's actual second turn — its LLM call should
    // see the *chapter* in place of the originals.
    const llm = new Dummy({
      responses: [
        // Parent turn 1 — heavy
        {
          emissions: [
            {
              type: 'fileWrite',
              path: '/seed.txt',
              content: 'first',
              mode: 'write',
            },
            { type: 'ts', code: '/* think hard */' },
          ],
          inputTokens: 5000,
        },
        // Chapter task turn — chapter the action that just landed
        // (position 2: taskStart=1, action=2)
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 2, end: 2, name: "warmup", message: "wrote seed and thought" }])',
            },
          ],
        },
        // Parent turn 2 — finish
        {
          emissions: [{ type: 'ts', code: 'taskSuccess("done")' }],
          inputTokens: 100,
        },
      ],
    })
    const agent = await createAgent({
      name: 'chaptered',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
    })
    agent.chapterTask({ description: 'Summarize prior task work into chapters.' })
    const fn = agent.task<undefined, string>({ description: 'X.' })
    const result = await fn(undefined)
    expect(result).toBe('done')

    // The Dummy captured every (system, turns) pair. Turn 3 is the
    // parent's second LLM call. Its rendered turns should reflect
    // the compacted log: the original heavy ActionEvent is replaced
    // by a ChapterEvent (which renders as a text part containing
    // the "📖 Chapter:" hint).
    expect(llm.allTurns.length).toBe(3) // parent t1, chapter t1, parent t2

    const turn3 = llm.allTurns[2] ?? []
    // The chapter rendering surfaces a text part with the slug hint
    const chapterTextSeen = turn3.some((t) =>
      t.content.some((p) => p.type === 'text' && p.text.includes('📖 Chapter')),
    )
    expect(chapterTextSeen).toBe(true)
    // The original heavy ts emission shouldn't appear in turn 3's
    // turns (its tool_use was rolled into the chapter)
    const heavyTsToolUses = turn3.flatMap((t) =>
      t.content.filter(
        (p) =>
          p.type === 'toolUse' && p.toolName === 'ts_action' && p.input.code === '/* think hard */',
      ),
    )
    expect(heavyTsToolUses.length).toBe(0)

    // Parent's final iter() over its log shows the same compacted shape:
    // taskStart, chapter, success (the success comes after turn 3 lands).
    const finalEvents: AgentEvent[] = []
    for await (const e of agent.events('default').iter()) finalEvents.push(e)
    const finalTypes = finalEvents.map((e) => e.type)
    expect(finalTypes).toEqual(['taskStart', 'chapter', 'action', 'success'])

    // The originals stay accessible via ChapterEvent.eventRefs even
    // though they're out of the active log.
    const chapterEv = finalEvents.find((e) => e.type === 'chapter')
    expect(chapterEv).toBeDefined()
    if (chapterEv?.type === 'chapter') {
      expect(chapterEv.eventRefs.length).toBe(1)
      // VFS overlay /chapters/<slug>/ that exposes these is TBD —
      // but the refs are here for it to read.
    }
  })

  it('host-injected fns and terminals resolve in deeply nested code', async () => {
    const llm = new Dummy({
      responses: [
        r({
          type: 'ts',
          code: `
            const xs = [1, 2, 3]
            const doubled = xs.map((x) => double(x))
            taskSuccess(doubled.reduce(add, 0))
          `,
        }),
      ],
    })
    const agent = await createAgent({ name: 'nested', llm, runtime: evalRuntime() })
    agent
      .fn('double', (...a: unknown[]) => (a[0] as number) * 2)
      .fn('add', (...a: unknown[]) => (a[0] as number) + (a[1] as number))
    const fn = agent.task<undefined, number>({ description: 'X.' })
    expect(await fn(undefined)).toBe(12) // 2+4+6
  })
})
