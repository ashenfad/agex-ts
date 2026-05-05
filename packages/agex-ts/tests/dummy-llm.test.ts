import { describe, expect, it } from 'vitest'
import { Dummy } from '../src/llm/dummy'
import type { Emission, LLMResponse, TokenChunk } from '../src/types'

const success: Emission = { type: 'ts', code: 'taskSuccess(1)' }
const r = (...emissions: Emission[]): LLMResponse => ({ emissions })

async function collect(stream: AsyncIterable<TokenChunk>): Promise<TokenChunk[]> {
  const out: TokenChunk[] = []
  for await (const t of stream) out.push(t)
  return out
}

describe('Dummy — defaults', () => {
  it('produces a default success-with-null response', async () => {
    const d = new Dummy()
    const tokens = await collect(d.complete({ system: 'sys', events: [] }))
    expect(tokens.length).toBe(2) // one emission + final marker
    expect(tokens[0]?.emission?.type).toBe('ts')
  })

  it('exposes "dummy" model + 60s timeout', () => {
    const d = new Dummy()
    expect(d.model).toBe('dummy')
    expect(d.timeoutSeconds).toBe(60)
  })
})

describe('Dummy — scripted cycling', () => {
  it('cycles responses by callCount % len', async () => {
    const d = new Dummy({
      responses: [r({ type: 'ts', code: 'one' }), r({ type: 'ts', code: 'two' })],
    })
    const a = await collect(d.complete({ system: '', events: [] }))
    const b = await collect(d.complete({ system: '', events: [] }))
    const c = await collect(d.complete({ system: '', events: [] }))
    expect(a[0]?.emission).toMatchObject({ type: 'ts', code: 'one' })
    expect(b[0]?.emission).toMatchObject({ type: 'ts', code: 'two' })
    expect(c[0]?.emission).toMatchObject({ type: 'ts', code: 'one' })
    expect(d.callCount).toBe(3)
  })
})

describe('Dummy — error-as-response', () => {
  it('throws the Error entry on its turn', async () => {
    const boom = new Error('rate limit')
    const d = new Dummy({ responses: [r(success), boom, r(success)] })
    // Turn 0: ok
    await collect(d.complete({ system: '', events: [] }))
    // Turn 1: throws synchronously when the iterable is requested
    expect(() => d.complete({ system: '', events: [] })).toThrow('rate limit')
    // callCount still bumped past the failure so the next call advances
    expect(d.callCount).toBe(2)
    // Turn 2: ok again
    const out = await collect(d.complete({ system: '', events: [] }))
    expect(out[0]?.emission).toBeDefined()
  })
})

describe('Dummy — inspection state', () => {
  it('records every system + events sent', async () => {
    const d = new Dummy()
    await collect(d.complete({ system: 'sys-1', events: [] }))
    await collect(
      d.complete({
        system: 'sys-2',
        events: [{ type: 'success', timestamp: 't', agentName: 'a', result: null }],
      }),
    )
    expect(d.allSystems).toEqual(['sys-1', 'sys-2'])
    expect(d.allEvents.length).toBe(2)
    expect(d.allEvents[1]?.length).toBe(1)
  })
})

describe('Dummy — summarize', () => {
  it('honors a configured summaryResponse', async () => {
    const d = new Dummy({ summaryResponse: 'tldr;' })
    expect(await d.summarize('sys', 'big text')).toBe('tldr;')
  })

  it('throws a configured summaryError', async () => {
    const d = new Dummy({ summaryError: new Error('summary down') })
    await expect(d.summarize('sys', '')).rejects.toThrow('summary down')
  })

  it('default summarize is a deterministic stringification', async () => {
    const d = new Dummy()
    const text = await d.summarize('S', 'C')
    expect(text).toBe('S C')
  })
})

describe('Dummy — dumpConfig / fromConfig round-trip', () => {
  it('preserves responses (modulo Error entries)', () => {
    const original = new Dummy({
      responses: [r(success), new Error('drop'), r({ type: 'text', text: 'hi' })],
    })
    const cfg = original.dumpConfig()
    const restored = Dummy.fromConfig(cfg)
    expect(restored.responses.length).toBe(2)
    expect(restored.model).toBe('dummy')
  })
})

describe('Dummy — final emission marker', () => {
  it('emits a final empty-content chunk that may carry token counts', async () => {
    const d = new Dummy({
      responses: [{ emissions: [success], inputTokens: 100, outputTokens: 50 }],
    })
    const tokens = await collect(d.complete({ system: '', events: [] }))
    const last = tokens[tokens.length - 1]
    expect(last?.content).toBe('')
    expect(last?.inputTokens).toBe(100)
    expect(last?.outputTokens).toBe(50)
  })
})
