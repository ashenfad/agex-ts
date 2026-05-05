import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { runChaptering, shouldTriggerChaptering } from '../src/chaptering'
import { Dummy } from '../src/llm/dummy'
import { evalRuntime } from '../src/runtime/eval'
import type { AgentEvent, Chapter, ChapterEvent } from '../src/types'

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

describe('runChaptering — handler invocation', () => {
  it('emits one ChapterEvent per returned Chapter', async () => {
    const emitted: AgentEvent[] = []
    const handler = async () =>
      [
        { start: 'k0', end: 'k5', name: 'phase 1', message: 'planned' },
        { start: 'k6', end: 'k9', name: 'phase 2', message: 'executed' },
      ] as ReadonlyArray<Chapter>
    const n = await runChaptering(
      [],
      handler,
      // log isn't used in v1 chaptering
      // biome-ignore lint/suspicious/noExplicitAny: minimal log stub for the test
      { add: async () => 'k', iter: async function* () {}, at: async () => null } as any,
      'agent',
      new AbortController().signal,
      async (e) => void emitted.push(e),
    )
    expect(n).toBe(2)
    expect(emitted.length).toBe(2)
    expect(emitted.every((e) => e.type === 'chapter')).toBe(true)
    const ch0 = emitted[0] as ChapterEvent
    expect(ch0.name).toBe('phase 1')
    expect(ch0.eventRefs).toEqual(['k0', 'k5'])
  })

  it('surfaces handler failures as a SystemNoteEvent', async () => {
    const emitted: AgentEvent[] = []
    const handler = async () => {
      throw new Error('summary api down')
    }
    const n = await runChaptering(
      [],
      handler,
      // biome-ignore lint/suspicious/noExplicitAny: minimal log stub
      { add: async () => 'k', iter: async function* () {}, at: async () => null } as any,
      'agent',
      new AbortController().signal,
      async (e) => void emitted.push(e),
    )
    expect(n).toBe(0)
    expect(emitted.length).toBe(1)
    expect(emitted[0]?.type).toBe('systemNote')
    expect((emitted[0] as { message: string }).message).toMatch(/summary api down/)
  })
})

describe('chaptering integration in the action loop', () => {
  it('does not fire when no chapterHandler is registered', async () => {
    const llm = new Dummy({
      responses: [
        { emissions: [{ type: 'ts', code: 'taskSuccess(null)' }], inputTokens: 1_000_000 },
      ],
    })
    const agent = await createAgent({
      name: 'A',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 100,
      // intentionally no chapterHandler
    })
    const fn = agent.task<undefined, null>({ description: 'X.' })
    const events: AgentEvent[] = []
    await fn(undefined, { onEvent: (e) => void events.push(e) })
    expect(events.find((e) => e.type === 'chapter')).toBeUndefined()
  })

  it('fires after an ActionEvent that exceeds the threshold', async () => {
    const llm = new Dummy({
      responses: [
        { emissions: [{ type: 'ts', code: '/* think */' }], inputTokens: 5000 },
        { emissions: [{ type: 'ts', code: 'taskSuccess(null)' }], inputTokens: 50 },
      ],
    })
    let chapterCalls = 0
    const agent = await createAgent({
      name: 'A',
      llm,
      runtime: evalRuntime(),
      chapteringTrigger: 1000,
      chapterHandler: async () => {
        chapterCalls++
        return [{ start: 'a', end: 'b', name: 'compact', message: '...' }]
      },
    })
    const fn = agent.task<undefined, null>({ description: 'X.' })
    const events: AgentEvent[] = []
    await fn(undefined, { onEvent: (e) => void events.push(e) })
    expect(chapterCalls).toBe(1)
    const chapters = events.filter((e) => e.type === 'chapter')
    expect(chapters.length).toBe(1)
    expect((chapters[0] as ChapterEvent).name).toBe('compact')
  })
})
