import { describe, expect, it } from 'vitest'
import { type ToolCallEvent, type UsageHolder, translateGeminiStream } from '../src/stream'

async function* fromArray<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const x of items) yield x
}

async function collect(iter: AsyncIterable<ToolCallEvent>): Promise<ToolCallEvent[]> {
  const out: ToolCallEvent[] = []
  for await (const e of iter) out.push(e)
  return out
}

const enc = new TextEncoder()

function b64(s: string): string {
  // biome-ignore lint/suspicious/noExplicitAny: Node Buffer fallback
  const Buf = (globalThis as any).Buffer
  if (Buf !== undefined) return Buf.from(s, 'utf-8').toString('base64')
  return btoa(s)
}

describe('translateGeminiStream — function calls', () => {
  it('emits Start + ArgDelta(stringified) + End for a single function_call', async () => {
    const events = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    id: 'tu_1',
                    name: 'ts_action',
                    args: { code: 'taskSuccess(1)', title: 't' },
                  },
                  thoughtSignature: b64('opaque-sig'),
                },
              ],
            },
          },
        ],
      },
    ]
    const out = await collect(translateGeminiStream(fromArray(events)))
    // Start, ArgDelta, End — then a synthetic ThinkingPart carrying
    // the signature so the renderer can replay it on the next turn.
    expect(out).toEqual([
      { type: 'toolCallStart', callId: 'tu_1', toolName: 'ts_action' },
      {
        type: 'toolCallArgDelta',
        callId: 'tu_1',
        argumentChunk: JSON.stringify({ code: 'taskSuccess(1)', title: 't' }),
      },
      { type: 'toolCallEnd', callId: 'tu_1' },
      { type: 'thinkingPart', signature: enc.encode('opaque-sig') },
    ])
  })

  it('synthesizes a callId when the chunk omits id', async () => {
    const events = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'ts_action', args: {} },
                },
              ],
            },
          },
        ],
      },
    ]
    const out = await collect(translateGeminiStream(fromArray(events)))
    const start = out.find((e) => e.type === 'toolCallStart')
    expect(start?.callId).toMatch(/^call_0_ts_action$/)
  })

  it('buffers across chunks and lets a late-arriving thoughtSignature win', async () => {
    // Gemini 3 sometimes surfaces a function_call in one chunk
    // without a thoughtSignature and then delivers the signature
    // on a later chunk for the same call id. The translator must
    // buffer all parts until the stream closes; the signature
    // surfaces on the trailing ThinkingPart.
    const events = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { id: 'tu_1', name: 'ts_action', args: { code: 'x' } },
                  // no signature on this chunk
                },
              ],
            },
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { id: 'tu_1', name: 'ts_action', args: { code: 'x' } },
                  thoughtSignature: b64('late-sig'),
                },
              ],
            },
          },
        ],
      },
    ]
    const out = await collect(translateGeminiStream(fromArray(events)))
    // One Start (deduped), one ArgDelta, one End, plus the latest
    // signature on the ThinkingPart.
    const starts = out.filter((e) => e.type === 'toolCallStart')
    expect(starts).toHaveLength(1)
    const sig = out.find((e) => e.type === 'thinkingPart')
    expect(sig?.signature).toEqual(enc.encode('late-sig'))
  })

  it('applies the documented dummy signature when the first function_call has none', async () => {
    // Gemini 3's validator rejects subsequent turns when the first
    // function_call lacks a thoughtSignature. agex-py's escape
    // hatch (and ours) is a literal sentinel that bypasses
    // validation at an accepted model-quality cost.
    const events = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { id: 'tu_1', name: 'ts_action', args: { code: 'x' } },
                },
              ],
            },
          },
        ],
      },
    ]
    const out = await collect(translateGeminiStream(fromArray(events)))
    const sig = out.find((e) => e.type === 'thinkingPart')
    expect(sig?.signature).toBeDefined()
    expect(new TextDecoder().decode(sig?.signature)).toBe('context_engineering_is_the_way_to_go')
  })
})

describe('translateGeminiStream — text + thought parts', () => {
  it('concatenates consecutive text parts across chunks and emits one TextPart', async () => {
    const events = [
      { candidates: [{ content: { parts: [{ text: 'one ' }] } }] },
      { candidates: [{ content: { parts: [{ text: 'two ' }, { text: 'three' }] } }] },
    ]
    const out = await collect(translateGeminiStream(fromArray(events)))
    expect(out).toEqual([{ type: 'textPart', text: 'one two three' }])
  })

  it('round-trips signed thought parts (no function_call) as ThinkingParts', async () => {
    const events = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  thought: true,
                  text: 'planning',
                  thoughtSignature: b64('sig-1'),
                },
              ],
            },
          },
        ],
      },
    ]
    const out = await collect(translateGeminiStream(fromArray(events)))
    expect(out).toHaveLength(1)
    const part = out[0]
    if (part?.type !== 'thinkingPart') throw new Error('expected thinkingPart')
    expect(part.text).toBe('planning')
    expect(new TextDecoder().decode(part.signature)).toBe('sig-1')
  })

  it('drops empty thought parts (no text, no signature)', async () => {
    const events = [
      {
        candidates: [{ content: { parts: [{ thought: true }] } }],
      },
    ]
    expect(await collect(translateGeminiStream(fromArray(events)))).toEqual([])
  })
})

describe('translateGeminiStream — usage capture', () => {
  it('captures the latest usageMetadata fields (Gemini sends incrementally)', async () => {
    const events = [
      {
        candidates: [{ content: { parts: [{ text: 'hi' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1 },
      },
      {
        candidates: [{ content: { parts: [] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
      },
    ]
    const usage: UsageHolder = { inputTokens: null, outputTokens: null }
    await collect(translateGeminiStream(fromArray(events), usage))
    expect(usage.inputTokens).toBe(10)
    expect(usage.outputTokens).toBe(5)
  })
})

describe('translateGeminiStream — error events', () => {
  it('throws when a chunk carries an error object', async () => {
    const events = [
      { candidates: [{ content: { parts: [{ text: 'partial' }] } }] },
      { error: { message: 'Resource exhausted', code: 429 } },
    ]
    await expect(collect(translateGeminiStream(fromArray(events)))).rejects.toThrow(
      /Resource exhausted/,
    )
  })
})
