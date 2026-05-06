import { describe, expect, it } from 'vitest'
import { type ToolCallEvent, type UsageHolder, translateAnthropicStream } from '../src/stream'

async function* fromArray<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const x of items) yield x
}

async function collect(iter: AsyncIterable<ToolCallEvent>): Promise<ToolCallEvent[]> {
  const out: ToolCallEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

describe('translateAnthropicStream — tool_use blocks', () => {
  it('emits start / arg-deltas / end with the right call id', async () => {
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_1', name: 'ts_action', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"co' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'de":"x' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"}' },
      },
      { type: 'content_block_stop', index: 0 },
    ]
    const out = await collect(translateAnthropicStream(fromArray(events)))
    expect(out).toEqual([
      { type: 'toolCallStart', callId: 'tu_1', toolName: 'ts_action' },
      { type: 'toolCallArgDelta', callId: 'tu_1', argumentChunk: '{"co' },
      { type: 'toolCallArgDelta', callId: 'tu_1', argumentChunk: 'de":"x' },
      { type: 'toolCallArgDelta', callId: 'tu_1', argumentChunk: '"}' },
      { type: 'toolCallEnd', callId: 'tu_1' },
    ])
  })

  it('emits a safety-net end for tool_use blocks left open at stream close', async () => {
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'tu_open', name: 'ts_action', input: {} },
      },
      // no content_block_stop — stream ends mid-call
    ]
    const out = await collect(translateAnthropicStream(fromArray(events)))
    expect(out.at(-1)).toEqual({ type: 'toolCallEnd', callId: 'tu_open' })
  })

  it('handles two interleaved tool_use blocks at distinct indices', async () => {
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'A', name: 'ts_action', input: {} },
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'B', name: 'terminal_action', input: {} },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'a' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: 'b' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_stop', index: 0 },
    ]
    const out = await collect(translateAnthropicStream(fromArray(events)))
    const argDeltas = out.filter((e) => e.type === 'toolCallArgDelta')
    expect(argDeltas).toEqual([
      { type: 'toolCallArgDelta', callId: 'A', argumentChunk: 'a' },
      { type: 'toolCallArgDelta', callId: 'B', argumentChunk: 'b' },
    ])
  })
})

describe('translateAnthropicStream — thinking blocks', () => {
  it('streams thinking_delta as ThinkingDelta events; final ThinkingPart carries the full text + signature', async () => {
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Step ' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'one.' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-pa' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'rt-2' },
      },
      { type: 'content_block_stop', index: 0 },
    ]
    const out = await collect(translateAnthropicStream(fromArray(events)))
    // Two delta events (one per thinking_delta), then the final
    // ThinkingPart at content_block_stop carrying the accumulated
    // text + signature.
    expect(out.length).toBe(3)
    expect(out[0]).toEqual({ type: 'thinkingDelta', content: 'Step ' })
    expect(out[1]).toEqual({ type: 'thinkingDelta', content: 'one.' })
    const part = out[2]
    if (part?.type !== 'thinkingPart') throw new Error('expected thinkingPart')
    expect(part.text).toBe('Step one.')
    expect(part.redacted).toBeUndefined()
    expect(part.signature).toBeDefined()
    expect(new TextDecoder().decode(part.signature)).toBe('sig-part-2')
  })

  it('preserves redacted_thinking via the encrypted data payload on block_start', async () => {
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'redacted_thinking', data: 'enc-payload' },
      },
      { type: 'content_block_stop', index: 0 },
    ]
    const out = await collect(translateAnthropicStream(fromArray(events)))
    expect(out.length).toBe(1)
    const part = out[0]
    if (part?.type !== 'thinkingPart') throw new Error('expected thinkingPart')
    expect(part.redacted).toBe(true)
    expect(part.signature).toBeDefined()
    expect(new TextDecoder().decode(part.signature)).toBe('enc-payload')
  })

  it('drops thinking blocks that ended up empty', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_stop', index: 0 },
    ]
    const out = await collect(translateAnthropicStream(fromArray(events)))
    expect(out).toEqual([])
  })
})

describe('translateAnthropicStream — text blocks', () => {
  it('streams text_delta as TextDelta events; final TextPart carries the full text', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'aside ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'to user' } },
      { type: 'content_block_stop', index: 0 },
    ]
    const out = await collect(translateAnthropicStream(fromArray(events)))
    expect(out).toEqual([
      { type: 'textDelta', content: 'aside ' },
      { type: 'textDelta', content: 'to user' },
      { type: 'textPart', text: 'aside to user' },
    ])
  })

  it('skips empty text blocks at close', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_stop', index: 0 },
    ]
    expect(await collect(translateAnthropicStream(fromArray(events)))).toEqual([])
  })
})

describe('translateAnthropicStream — usage capture', () => {
  it('sums input + cache_creation + cache_read tokens', async () => {
    const events = [
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 50,
            cache_read_input_tokens: 25,
            output_tokens: 0,
          },
        },
      },
      {
        type: 'message_delta',
        delta: {},
        usage: { output_tokens: 200 },
      },
    ]
    const usage: UsageHolder = { inputTokens: null, outputTokens: null }
    await collect(translateAnthropicStream(fromArray(events), usage))
    expect(usage.inputTokens).toBe(175)
    expect(usage.outputTokens).toBe(200)
  })

  it('handles missing usage fields gracefully', async () => {
    const events = [{ type: 'message_start', message: {} }, { type: 'message_stop' }]
    const usage: UsageHolder = { inputTokens: null, outputTokens: null }
    await collect(translateAnthropicStream(fromArray(events), usage))
    expect(usage.inputTokens).toBeNull()
    expect(usage.outputTokens).toBeNull()
  })
})

describe('translateAnthropicStream — error events', () => {
  it('throws when Anthropic emits an error event', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Try again' } },
    ]
    await expect(collect(translateAnthropicStream(fromArray(events)))).rejects.toThrow(/Try again/)
  })
})
