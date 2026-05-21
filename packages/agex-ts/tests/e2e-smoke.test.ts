/**
 * End-to-end smoke for agex-ts core.
 *
 * Drives a multi-turn task through the full pipeline:
 *   Dummy LLM (scripted) → action loop → eval-runtime → emission
 *   dispatcher → kvgit-backed state + @agex-ts/termish MemoryFS.
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
  it('drives a multi-turn task through every emission type', async () => {
    const responses: LLMResponse[] = [
      // Turn 1: write a seed file + run shell pipelines against it
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
      // Turn 2: edit the sorted file
      {
        emissions: [
          { type: 'fileEdit', path: '/sorted.txt', search: 'apple', content: 'APPLE' },
          { type: 'ts', code: '/* keep going */' },
        ],
        inputTokens: 200,
      },
      // Turn 3: read everything back via a registered fn and finish
      {
        emissions: [
          {
            type: 'ts',
            code: 'const text = await readFile("/sorted.txt"); taskSuccess(summarize(text))',
          },
        ],
        inputTokens: 250,
      },
    ]
    const llm = new Dummy({ responses })

    const agent = await createAgent({
      name: 'smoke',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
    })

    // Register a host fn the agent can call from emission code, plus
    // a custom terminal command that helps it inspect.
    agent
      .fn(
        async (...args: unknown[]) => {
          const path = args[0] as string
          const fs = await agent.fs()
          const bytes = await fs.read(path)
          return dec.decode(bytes)
        },
        { name: 'readFile', description: 'Read a file from the VFS as text.' },
      )
      .fn(
        (...args: unknown[]) => {
          const text = args[0] as string
          const lines = text.split('\n').filter((l) => l.length > 0)
          return { lineCount: lines.length, first: lines[0] }
        },
        { name: 'summarize', description: 'Summarize a text blob.' },
      )
      .terminal(
        async (ctx) => {
          ctx.stdout.write('BEEP\n')
          return undefined
        },
        { name: 'beep', description: 'Used in tests; emits BEEP.' },
      )

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
    expect(types[types.length - 1]).toBe('success')

    // The Dummy LLM observed every (system, turns) pair the agent sent.
    // 3 task turns total — no chaptering in this test.
    expect(llm.callCount).toBe(3)
    // System message contains the BUILTIN_PRIMER, not the task
    // description (that's now in the first user turn).
    expect(llm.allSystems[0]).toContain('Agex Agent Environment')
    // The task description lives in the opening user turn.
    const firstParentTurn = llm.allTurns[0]?.[0]
    const firstTurnText =
      firstParentTurn?.content[0]?.type === 'text' ? firstParentTurn.content[0].text : ''
    expect(firstTurnText).toContain('Sort, edit, summarize.')

    // Streaming worked
    expect(onToken.length).toBeGreaterThan(0)

    // -- VFS state survives across turns -------------------------------
    const fs = await agent.fs()
    expect(dec.decode(await fs.read('/sorted.txt'))).toBe('APPLE\nbanana\ncherry\n')

    // -- Versioned state persists + commitInfo round-trip --------------
    const hash = await agent.commit('default', { info: { phase: 'final' } })
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

  it('chaptering compacts the parent log: a later task sees the chapter, not the originals', async () => {
    // Task-boundary chaptering: after a task completes, if the latest
    // action's inputTokens exceeds the threshold, the chapter task
    // fires. So a task that runs *after* chaptering will see the
    // chapter event in its first LLM call's rendered history — not
    // the originals.
    const llm = new Dummy({
      responses: [
        // Task A — write a file then complete (small).
        {
          emissions: [
            {
              type: 'fileWrite',
              path: '/seed.txt',
              content: 'first',
              mode: 'write',
            },
            { type: 'ts', code: 'taskSuccess(null)' },
          ],
          inputTokens: 80,
        },
        // Task B — heavy completion. Trips chaptering at B's boundary.
        { emissions: [{ type: 'ts', code: 'taskSuccess(null)' }], inputTokens: 5000 },
        // Chapter task — boundary index has [1] task A → success,
        // [2] task B → success. Fold both as one chapter "warmup".
        {
          emissions: [
            {
              type: 'ts',
              code: 'taskSuccess([{ start: 1, end: 2, name: "warmup", message: "did A then B" }])',
            },
          ],
        },
        // Task C — runs AFTER chaptering applied. Its first LLM call
        // sees the chapter event in place of tasks A and B.
        { emissions: [{ type: 'ts', code: 'taskSuccess("done")' }], inputTokens: 100 },
      ],
    })
    const agent = await createAgent({
      name: 'chaptered',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
    })
    const taskA = agent.task<undefined, null>({ description: 'A.' })
    const taskB = agent.task<undefined, null>({ description: 'B.' })
    const taskC = agent.task<undefined, string>({ description: 'C.' })
    await taskA(undefined)
    await taskB(undefined)
    const result = await taskC(undefined)
    expect(result).toBe('done')

    // 4 LLM calls: task A, task B, chapter task (post-B), task C.
    expect(llm.allTurns.length).toBe(4)

    // Task C's first (and only) LLM call is rendered *after* chaptering
    // applied. The compacted log shows the ChapterEvent (📖 Chapter)
    // in place of tasks A and B.
    const taskCCall = llm.allTurns[3] ?? []
    const chapterTextSeen = taskCCall.some((t) =>
      t.content.some((p) => p.type === 'text' && p.text.includes('📖 Chapter')),
    )
    expect(chapterTextSeen).toBe(true)
    // Filter A: the chapter task's own bookkeeping (its
    // `taskSuccess([Chapter(...)])` action) is filtered from the
    // LLM render — closed `__chapter__` scopes don't appear — so
    // the long summary text doesn't get duplicated.
    const chapterTaskActionSeen = taskCCall.some((t) =>
      t.content.some(
        (p) =>
          p.type === 'toolUse' &&
          p.toolName === 'ts_action' &&
          (p.input.code as string).includes('"warmup"'),
      ),
    )
    expect(chapterTaskActionSeen).toBe(false)

    // Parent's final iter() yields everything still in the active
    // index, including the chapter task's own bookkeeping events
    // (visible to UI / undo / iter() — only LLM render filters them).
    const finalEvents: AgentEvent[] = []
    const finalLog = await agent.events('default')
    for await (const e of finalLog.iter()) finalEvents.push(e)
    const finalTypes = finalEvents.map((e) => e.type)
    // First entry is the chapter (folding A+B); the rest is task C's
    // bracket plus the chapter task's bookkeeping.
    expect(finalTypes[0]).toBe('chapter')
    expect(finalTypes).toContain('taskStart')
    expect(finalTypes[finalTypes.length - 1]).toBe('success') // task C close

    // The originals stay accessible via ChapterEvent.eventRefs.
    const chapterEv = finalEvents.find((e) => e.type === 'chapter')
    expect(chapterEv).toBeDefined()
    if (chapterEv?.type === 'chapter') {
      // Folded tasks A and B — at least the 6 events from {taskStart,
      // action, success} × 2 tasks. (Could be more depending on
      // chapter task bookkeeping nested inside; the slice is
      // contiguous over the underlying log.)
      expect(chapterEv.eventRefs.length).toBeGreaterThanOrEqual(6)
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
      .fn((...a: unknown[]) => (a[0] as number) * 2, { name: 'double' })
      .fn((...a: unknown[]) => (a[0] as number) + (a[1] as number), { name: 'add' })
    const fn = agent.task<undefined, number>({ description: 'X.' })
    expect(await fn(undefined)).toBe(12) // 2+4+6
  })
})
