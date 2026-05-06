import { type NeutralTurn, toolSchemas } from 'agex-ts/render'
import { describe, expect, it } from 'vitest'
import {
  type OpenAIAssistantMessage,
  type OpenAIToolMessage,
  lowerNeutralTurns,
  schemasToOpenAITools,
} from '../src/adapter'

describe('schemasToOpenAITools', () => {
  it('wraps each schema in the function envelope', () => {
    const out = schemasToOpenAITools(toolSchemas())
    expect(out.length).toBe(4)
    for (const tool of out) {
      expect(tool.type).toBe('function')
      expect(tool.function.name).toBeTruthy()
      expect(tool.function.description).toBeTruthy()
      expect(tool.function.parameters).toBeDefined()
      // No Anthropic-style flat shape
      const probe = tool as unknown as Record<string, unknown>
      expect(probe.input_schema).toBeUndefined()
      expect(probe.parameters).toBeUndefined()
    }
  })
})

describe('lowerNeutralTurns — text', () => {
  it('passes a plain user text turn through as a string-content message', () => {
    const turns: NeutralTurn[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    expect(lowerNeutralTurns(turns)).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('joins multiple text parts in a user turn into one string', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      },
    ]
    expect(lowerNeutralTurns(turns)).toEqual([{ role: 'user', content: 'ab' }])
  })

  it('uses array content when text mixes with images', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', format: 'png', data: 'b64png' },
        ],
      },
    ]
    const msg = lowerNeutralTurns(turns)[0]
    if (msg?.role !== 'user') throw new Error('expected user')
    expect(Array.isArray(msg.content)).toBe(true)
    if (Array.isArray(msg.content)) {
      expect(msg.content[0]).toEqual({ type: 'text', text: 'see this' })
      expect(msg.content[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,b64png' },
      })
    }
  })
})

describe('lowerNeutralTurns — assistant tool_use', () => {
  it('emits an assistant message with tool_calls and stringified arguments', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolUse',
            toolUseId: 'tu_1',
            toolName: 'ts_action',
            input: { code: 'taskSuccess(1)', title: 't' },
          },
        ],
      },
    ]
    const msg = lowerNeutralTurns(turns)[0] as OpenAIAssistantMessage
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBeNull()
    expect(msg.tool_calls).toHaveLength(1)
    expect(msg.tool_calls?.[0]).toEqual({
      id: 'tu_1',
      type: 'function',
      function: {
        name: 'ts_action',
        arguments: JSON.stringify({ code: 'taskSuccess(1)', title: 't' }),
      },
    })
  })

  it('packs assistant text alongside tool_calls into the message content', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'about to call: ' },
          {
            type: 'toolUse',
            toolUseId: 'tu_1',
            toolName: 'ts_action',
            input: { code: 'x' },
          },
        ],
      },
    ]
    const msg = lowerNeutralTurns(turns)[0] as OpenAIAssistantMessage
    expect(msg.content).toBe('about to call: ')
    expect(msg.tool_calls).toHaveLength(1)
  })

  it('drops thinking parts on egress (Chat Completions has no thinking field)', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            text: 'reasoning here',
            signature: new TextEncoder().encode('sig'),
          },
          { type: 'toolUse', toolUseId: 'tu_1', toolName: 'ts_action', input: { code: 'x' } },
        ],
      },
    ]
    const msg = lowerNeutralTurns(turns)[0] as OpenAIAssistantMessage
    // Text bits exclude the thinking content; tool_calls preserved.
    expect(msg.content).toBeNull()
    expect(msg.tool_calls).toHaveLength(1)
  })
})

describe('lowerNeutralTurns — tool_result', () => {
  it('fan-outs each tool_result to a separate role:tool message', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'user',
        content: [
          {
            type: 'toolResult',
            toolUseId: 'tu_1',
            content: [{ type: 'text', text: 'first' }],
          },
          {
            type: 'toolResult',
            toolUseId: 'tu_2',
            content: [{ type: 'text', text: 'second' }],
          },
        ],
      },
    ]
    const out = lowerNeutralTurns(turns)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ role: 'tool', tool_call_id: 'tu_1', content: 'first' })
    expect(out[1]).toEqual({ role: 'tool', tool_call_id: 'tu_2', content: 'second' })
  })

  it('flattens image content inside tool_result to an [image] placeholder', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'user',
        content: [
          {
            type: 'toolResult',
            toolUseId: 'tu_1',
            content: [
              { type: 'text', text: 'screenshot:' },
              { type: 'image', format: 'png', data: 'b64' },
            ],
          },
        ],
      },
    ]
    const msg = lowerNeutralTurns(turns)[0] as OpenAIToolMessage
    expect(msg.content).toBe('screenshot:\n[image]')
  })

  it('appends a trailing user message when text/image parts follow tool_results', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'user',
        content: [
          {
            type: 'toolResult',
            toolUseId: 'tu_1',
            content: [{ type: 'text', text: 'done' }],
          },
          { type: 'text', text: 'now please continue' },
        ],
      },
    ]
    const out = lowerNeutralTurns(turns)
    expect(out).toHaveLength(2)
    expect(out[0]?.role).toBe('tool')
    expect(out[1]).toEqual({ role: 'user', content: 'now please continue' })
  })
})
