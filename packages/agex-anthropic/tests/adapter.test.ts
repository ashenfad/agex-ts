import { type NeutralTurn, toolSchemas } from 'agex-ts/render'
import { describe, expect, it } from 'vitest'
import {
  type AnthropicMessage,
  applyCacheControl,
  lowerNeutralTurns,
  schemasToAnthropicTools,
} from '../src/adapter'

describe('schemasToAnthropicTools', () => {
  it('renames parameters to input_schema with no outer envelope', () => {
    const out = schemasToAnthropicTools(toolSchemas())
    expect(out.length).toBe(4)
    for (const tool of out) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.input_schema).toBeDefined()
      // No OpenAI-style envelope
      const probe = tool as unknown as Record<string, unknown>
      expect(probe.type).toBeUndefined()
      expect(probe.function).toBeUndefined()
      expect(probe.parameters).toBeUndefined()
    }
  })
})

describe('lowerNeutralTurns — text + image', () => {
  it('passes text through unchanged', () => {
    const turns: NeutralTurn[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    expect(lowerNeutralTurns(turns)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ])
  })

  it('translates image parts into the source envelope with the right media type', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'user',
        content: [
          { type: 'image', format: 'png', data: 'b64png' },
          { type: 'image', format: 'jpeg', data: 'b64jpeg' },
          { type: 'image', format: 'webp', data: 'b64webp' },
        ],
      },
    ]
    const out = lowerNeutralTurns(turns)
    const blocks = out[0]?.content ?? []
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'b64png' },
    })
    expect(blocks[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'b64jpeg' },
    })
    expect(blocks[2]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/webp', data: 'b64webp' },
    })
  })
})

describe('lowerNeutralTurns — thinking', () => {
  it('emits { type: thinking, thinking, signature } for non-redacted parts', () => {
    const sig = new TextEncoder().encode('opaque-sig-string')
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', text: 'reasoning here', signature: sig }],
      },
    ]
    const block = lowerNeutralTurns(turns)[0]?.content[0]
    expect(block).toEqual({
      type: 'thinking',
      thinking: 'reasoning here',
      signature: 'opaque-sig-string',
    })
  })

  it('emits { type: redacted_thinking, data } when redacted=true', () => {
    const data = new TextEncoder().encode('encrypted-payload')
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', text: '', signature: data, redacted: true }],
      },
    ]
    const block = lowerNeutralTurns(turns)[0]?.content[0]
    expect(block).toEqual({ type: 'redacted_thinking', data: 'encrypted-payload' })
  })

  it('drops thinking parts that have no signature (Anthropic rejects them)', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', text: 'no sig' }],
      },
    ]
    const blocks = lowerNeutralTurns(turns)[0]?.content ?? []
    expect(blocks).toEqual([])
  })
})

describe('lowerNeutralTurns — tool_use / tool_result', () => {
  it('passes tool_use through but drops the Gemini signature field', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolUse',
            toolUseId: 'tu_1',
            toolName: 'ts_action',
            input: { code: 'taskSuccess(1)' },
            signature: new Uint8Array([0xab, 0xcd]),
          },
        ],
      },
    ]
    const block = lowerNeutralTurns(turns)[0]?.content[0]
    expect(block).toEqual({
      type: 'tool_use',
      id: 'tu_1',
      name: 'ts_action',
      input: { code: 'taskSuccess(1)' },
    })
    // Anthropic 400s if signature is present on tool_use blocks.
    const probe = block as unknown as Record<string, unknown>
    expect(probe.signature).toBeUndefined()
  })

  it('translates inner image parts inside tool_result blocks', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'user',
        content: [
          {
            type: 'toolResult',
            toolUseId: 'tu_1',
            content: [
              { type: 'text', text: 'observed' },
              { type: 'image', format: 'png', data: 'b64' },
            ],
          },
        ],
      },
    ]
    const block = lowerNeutralTurns(turns)[0]?.content[0]
    if (block?.type !== 'tool_result') throw new Error('expected tool_result')
    expect(block.content[0]).toEqual({ type: 'text', text: 'observed' })
    expect(block.content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'b64' },
    })
  })

  it('forwards is_error when present', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'user',
        content: [
          {
            type: 'toolResult',
            toolUseId: 'tu_1',
            content: [{ type: 'text', text: 'oops' }],
            isError: true,
          },
        ],
      },
    ]
    const block = lowerNeutralTurns(turns)[0]?.content[0]
    if (block?.type !== 'tool_result') throw new Error('expected tool_result')
    expect(block.is_error).toBe(true)
  })
})

describe('applyCacheControl', () => {
  function msg(text: string): AnthropicMessage {
    return { role: 'user', content: [{ type: 'text', text }] }
  }

  function readCC(block: unknown): unknown {
    return (block as Record<string, unknown> | undefined)?.cache_control
  }

  it('adds cache_control to the last block of the indexed message', () => {
    const out = applyCacheControl([msg('a'), msg('b'), msg('c')], 1)
    const target = out[1]?.content[0]
    if (target?.type !== 'text') throw new Error('expected text')
    expect(target.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    // Untargeted messages stay untouched
    expect(readCC(out[0]?.content[0])).toBeUndefined()
    expect(readCC(out[2]?.content[0])).toBeUndefined()
  })

  it('honors a custom ttl', () => {
    const out = applyCacheControl([msg('only')], 0, '5m')
    const target = out[0]?.content[0]
    if (target?.type !== 'text') throw new Error('expected text')
    expect(target.cache_control?.ttl).toBe('5m')
  })

  it('silently ignores out-of-range indices', () => {
    const original = [msg('a'), msg('b')]
    const negative = applyCacheControl(original, -1)
    const past = applyCacheControl(original, 5)
    for (const out of [negative, past]) {
      for (const m of out) {
        for (const b of m.content) {
          expect(readCC(b)).toBeUndefined()
        }
      }
    }
  })

  it('skips a message with empty content array', () => {
    const empty: AnthropicMessage = { role: 'user', content: [] }
    const out = applyCacheControl([empty], 0)
    expect(out[0]?.content).toEqual([])
  })
})
