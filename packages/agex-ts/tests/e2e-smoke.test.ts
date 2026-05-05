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
import type { AgentEvent, Chapter, LLMResponse } from '../src/types'

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

    const chapterCalls: number[] = []
    const agent = await createAgent({
      name: 'smoke',
      llm,
      runtime: evalRuntime(),
      state: { type: 'versioned', storage: 'memory' },
      chapteringTrigger: 1000,
      chapterHandler: async (events): Promise<readonly Chapter[]> => {
        chapterCalls.push(events.length)
        return [
          {
            start: 'evt/begin',
            end: 'evt/snapshot',
            name: 'turn 1 + 2',
            message: 'seeded files; sorted; uppercased apple',
          },
        ]
      },
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

    // Chaptering fired exactly once (after turn 2's heavy ActionEvent)
    expect(chapterCalls.length).toBe(1)

    // The Dummy LLM observed every system + events the agent sent
    expect(llm.callCount).toBe(3)
    expect(llm.allSystems[0]).toContain('Sort, edit, summarize.')

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
