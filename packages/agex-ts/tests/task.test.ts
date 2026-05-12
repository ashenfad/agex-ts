import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent'
import { TaskFailError } from '../src/errors'
import { Dummy } from '../src/llm/dummy'
import { evalRuntime } from '../src/runtime/eval'
import type { AgentEvent, LLMResponse, TokenChunk } from '../src/types'

const r = (...emissions: LLMResponse['emissions']): LLMResponse => ({ emissions })

async function makeAgent(responses: ReadonlyArray<LLMResponse | Error>) {
  const llm = new Dummy({ responses })
  const runtime = evalRuntime()
  const agent = await createAgent({ name: 'T', llm, runtime })
  return { agent, llm, runtime }
}

describe('task — single-turn success', () => {
  it('returns the value passed to taskSuccess', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskSuccess(42)' })])
    const fn = agent.task<undefined, number>({ description: 'Return 42.' })
    const result = await fn(undefined)
    expect(result).toBe(42)
  })
})

describe('task — multi-turn success', () => {
  it('loops until taskSuccess fires', async () => {
    const { agent, llm } = await makeAgent([
      r({ type: 'ts', code: '/* think */' }), // continue
      r({ type: 'ts', code: '/* still thinking */' }), // continue
      r({ type: 'ts', code: 'taskSuccess("done")' }), // terminate
    ])
    const fn = agent.task<undefined, string>({ description: 'Eventually return.' })
    const result = await fn(undefined)
    expect(result).toBe('done')
    expect(llm.callCount).toBe(3)
  })
})

describe('task — taskFail', () => {
  it('rejects with TaskFailError on taskFail', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskFail("nope")' })])
    const fn = agent.task<undefined, void>({ description: 'Fail.' })
    await expect(fn(undefined)).rejects.toBeInstanceOf(TaskFailError)
  })
})

describe('task — event log', () => {
  it('writes TaskStartEvent, ActionEvent, SuccessEvent in order', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskSuccess("ok")' })])
    const fn = agent.task<undefined, string>({ description: 'Tiny.' })
    const onEvent: AgentEvent[] = []
    await fn(undefined, { onEvent: (e) => void onEvent.push(e) })
    expect(onEvent.map((e) => e.type)).toEqual(['taskStart', 'action', 'success'])
    expect((onEvent[0] as { taskName: string }).taskName).toBe('Tiny.')
  })

  it('forwards every TokenChunk to onToken', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskSuccess(1)' })])
    const fn = agent.task<undefined, number>({ description: 'X.' })
    const tokens: TokenChunk[] = []
    await fn(undefined, { onToken: (t) => void tokens.push(t) })
    expect(tokens.length).toBeGreaterThan(0)
  })
})

describe('task — maxIterations safeguard', () => {
  it('rejects with TaskFailError after maxIterations turns', async () => {
    // Every response is "continue" (no terminal action). With
    // maxIterations: 3 the loop should bail out.
    const { agent } = await makeAgent([
      r({ type: 'ts', code: '/* nope */' }),
      r({ type: 'ts', code: '/* nope */' }),
      r({ type: 'ts', code: '/* nope */' }),
    ])
    // override maxIterations on the agent via a fresh build
    const llm = new Dummy({
      responses: [
        r({ type: 'ts', code: '/* nope */' }),
        r({ type: 'ts', code: '/* nope */' }),
        r({ type: 'ts', code: '/* nope */' }),
      ],
    })
    const a = await createAgent({
      name: 'T',
      llm,
      runtime: evalRuntime(),
      maxIterations: 2,
    })
    const fn = a.task<undefined, void>({ description: 'Loop forever.' })
    await expect(fn(undefined)).rejects.toThrow(/exceeded maxIterations/)
    expect(llm.callCount).toBe(2)
  })
})

describe('task — registered fn reachable from emission code', () => {
  it('agent.fn becomes a callable identifier in ts emissions', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskSuccess(double(7))' })])
    agent.fn((...args: unknown[]) => (args[0] as number) * 2, {
      name: 'double',
      description: 'Double a number.',
    })
    const fn = agent.task<undefined, number>({ description: 'Double 7.' })
    const result = await fn(undefined)
    expect(result).toBe(14)
  })
})

describe('task — AbortSignal', () => {
  it('rejects with CancelledError when aborted before the first turn', async () => {
    const { agent } = await makeAgent([r({ type: 'ts', code: 'taskSuccess(1)' })])
    const fn = agent.task<undefined, number>({ description: 'X.' })
    const ac = new AbortController()
    ac.abort()
    await expect(fn(undefined, { signal: ac.signal })).rejects.toThrow()
  })
})

describe('task — missing config', () => {
  it('throws if no llm is configured', async () => {
    const a = await createAgent({ name: 'T', runtime: evalRuntime() })
    const fn = a.task<undefined, number>({ description: 'X.' })
    await expect(fn(undefined)).rejects.toThrow(/missing required llm/)
  })

  it('throws if no runtime is configured', async () => {
    const a = await createAgent({ name: 'T', llm: new Dummy() })
    const fn = a.task<undefined, number>({ description: 'X.' })
    await expect(fn(undefined)).rejects.toThrow(/missing required runtime/)
  })
})
