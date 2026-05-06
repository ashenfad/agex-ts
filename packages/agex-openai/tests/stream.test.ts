import { describe, expect, it } from 'vitest'
import { type ToolCallEvent, type UsageHolder, translateOpenAIStream } from '../src/stream'

async function* fromArray<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const x of items) yield x
}

async function collect(iter: AsyncIterable<ToolCallEvent>): Promise<ToolCallEvent[]> {
  const out: ToolCallEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

describe('translateOpenAIStream — text content', () => {
  it('streams delta.content as TextDelta and flushes a final TextPart at close', async () => {
    const events = [
      { choices: [{ delta: { content: 'hel' } }] },
      { choices: [{ delta: { content: 'lo ' } }] },
      { choices: [{ delta: { content: 'world' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]
    const out = await collect(translateOpenAIStream(fromArray(events)))
    expect(out).toEqual([
      { type: 'textDelta', content: 'hel' },
      { type: 'textDelta', content: 'lo ' },
      { type: 'textDelta', content: 'world' },
      { type: 'textPart', text: 'hello world' },
    ])
  })

  it('emits no text events when content is empty / absent', async () => {
    const events = [{ choices: [{ delta: {}, finish_reason: 'stop' }] }]
    expect(await collect(translateOpenAIStream(fromArray(events)))).toEqual([])
  })
})

describe('translateOpenAIStream — tool calls', () => {
  it('emits toolCallStart on first delta, args on subsequent deltas, end at close', async () => {
    const events = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'tu_1',
                  type: 'function',
                  function: { name: 'ts_action', arguments: '' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"co' } }] } }],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'de":"x' } }] } }],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const out = await collect(translateOpenAIStream(fromArray(events)))
    expect(out).toEqual([
      { type: 'toolCallStart', callId: 'tu_1', toolName: 'ts_action' },
      { type: 'toolCallArgDelta', callId: 'tu_1', argumentChunk: '{"co' },
      { type: 'toolCallArgDelta', callId: 'tu_1', argumentChunk: 'de":"x' },
      { type: 'toolCallArgDelta', callId: 'tu_1', argumentChunk: '"}' },
      { type: 'toolCallEnd', callId: 'tu_1' },
    ])
  })

  it('handles two parallel tool calls keyed by index', async () => {
    const events = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'A', function: { name: 'ts_action', arguments: '' } },
                { index: 1, id: 'B', function: { name: 'terminal_action', arguments: '' } },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'a' } }] } }],
      },
      {
        choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: 'b' } }] } }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const out = await collect(translateOpenAIStream(fromArray(events)))
    const argDeltas = out.filter((e) => e.type === 'toolCallArgDelta')
    expect(argDeltas).toEqual([
      { type: 'toolCallArgDelta', callId: 'A', argumentChunk: 'a' },
      { type: 'toolCallArgDelta', callId: 'B', argumentChunk: 'b' },
    ])
    const ends = out.filter((e) => e.type === 'toolCallEnd')
    expect(ends.map((e) => e.callId).sort()).toEqual(['A', 'B'])
  })

  it('synthesizes a callId when the provider omits id (some local servers)', async () => {
    const events = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: 'ts_action', arguments: '{}' } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]
    const out = await collect(translateOpenAIStream(fromArray(events)))
    const start = out.find((e) => e.type === 'toolCallStart')
    expect(start?.callId).toBe('call_0')
  })
})

describe('translateOpenAIStream — usage capture', () => {
  it('captures prompt_tokens / completion_tokens from the final usage chunk', async () => {
    const events = [
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 25, total_tokens: 125 } },
    ]
    const usage: UsageHolder = { inputTokens: null, outputTokens: null }
    await collect(translateOpenAIStream(fromArray(events), usage))
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(25)
  })

  it('handles missing usage gracefully', async () => {
    const events = [{ choices: [{ delta: {}, finish_reason: 'stop' }] }]
    const usage: UsageHolder = { inputTokens: null, outputTokens: null }
    await collect(translateOpenAIStream(fromArray(events), usage))
    expect(usage.inputTokens).toBeNull()
    expect(usage.outputTokens).toBeNull()
  })
})

describe('translateOpenAIStream — error events', () => {
  it('throws when the chunk carries an error object (mid-stream rate limit, etc.)', async () => {
    const events = [
      { choices: [{ delta: { content: 'partial' } }] },
      { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } },
    ]
    await expect(collect(translateOpenAIStream(fromArray(events)))).rejects.toThrow(/Rate limit/)
  })
})
