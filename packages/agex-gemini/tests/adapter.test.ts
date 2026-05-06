import { type NeutralTurn, toolSchemas } from 'agex-ts/render'
import { describe, expect, it } from 'vitest'
import {
  type GeminiContent,
  type GeminiFunctionCallPart,
  type GeminiFunctionResponsePart,
  lowerNeutralTurns,
  schemasToGeminiFunctionDeclarations,
} from '../src/adapter'

describe('schemasToGeminiFunctionDeclarations', () => {
  it('projects each schema as { name, description, parameters }', () => {
    const out = schemasToGeminiFunctionDeclarations(toolSchemas())
    expect(out.length).toBe(4)
    for (const decl of out) {
      expect(decl.name).toBeTruthy()
      expect(decl.description).toBeTruthy()
      expect(decl.parameters).toBeDefined()
      // No OpenAI envelope, no Anthropic input_schema rename.
      const probe = decl as unknown as Record<string, unknown>
      expect(probe.type).toBeUndefined()
      expect(probe.function).toBeUndefined()
      expect(probe.input_schema).toBeUndefined()
    }
  })
})

describe('lowerNeutralTurns — roles', () => {
  it("maps assistant role to 'model' (Gemini's term)", () => {
    const turns: NeutralTurn[] = [{ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }]
    const out: GeminiContent[] = lowerNeutralTurns(turns)
    expect(out[0]?.role).toBe('model')
  })

  it("keeps user role as 'user'", () => {
    const turns: NeutralTurn[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    expect(lowerNeutralTurns(turns)[0]?.role).toBe('user')
  })

  it('drops turns whose parts all collapse to empty (Gemini rejects empty parts arrays)', () => {
    const turns: NeutralTurn[] = [
      { role: 'assistant', content: [{ type: 'text', text: '' }] },
      // also a thinking part with no text, no signature → empty
      { role: 'assistant', content: [{ type: 'thinking', text: '' }] },
    ]
    expect(lowerNeutralTurns(turns)).toEqual([])
  })
})

describe('lowerNeutralTurns — text + image', () => {
  it('lowers text parts as { text }', () => {
    const turns: NeutralTurn[] = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    expect(lowerNeutralTurns(turns)[0]?.parts).toEqual([{ text: 'hello' }])
  })

  it('lowers image parts as { inlineData: { mimeType, data } } (note camelCase)', () => {
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
    expect(lowerNeutralTurns(turns)[0]?.parts).toEqual([
      { inlineData: { mimeType: 'image/png', data: 'b64png' } },
      { inlineData: { mimeType: 'image/jpeg', data: 'b64jpeg' } },
      { inlineData: { mimeType: 'image/webp', data: 'b64webp' } },
    ])
  })
})

describe('lowerNeutralTurns — thinking', () => {
  it('round-trips a signed thought part with base64 thoughtSignature', () => {
    const sig = new TextEncoder().encode('opaque-sig')
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [{ type: 'thinking', text: 'reasoning here', signature: sig }],
      },
    ]
    const part = lowerNeutralTurns(turns)[0]?.parts[0] as {
      thought: true
      text: string
      thoughtSignature: string
    }
    expect(part.thought).toBe(true)
    expect(part.text).toBe('reasoning here')
    expect(part.thoughtSignature).toBeTruthy()
    // base64 of 'opaque-sig'
    expect(part.thoughtSignature).toBe('b3BhcXVlLXNpZw==')
  })

  it('drops thought parts with no text and no signature', () => {
    const turns: NeutralTurn[] = [{ role: 'assistant', content: [{ type: 'thinking', text: '' }] }]
    expect(lowerNeutralTurns(turns)).toEqual([])
  })
})

describe('lowerNeutralTurns — tool_use / tool_result', () => {
  it('lowers tool_use as { functionCall: { id, name, args } } with sibling thoughtSignature', () => {
    const sig = new TextEncoder().encode('sig')
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolUse',
            toolUseId: 'tu_1',
            toolName: 'ts_action',
            input: { code: 'taskSuccess(1)' },
            signature: sig,
          },
        ],
      },
    ]
    const part = lowerNeutralTurns(turns)[0]?.parts[0] as GeminiFunctionCallPart
    expect(part.functionCall).toEqual({
      id: 'tu_1',
      name: 'ts_action',
      args: { code: 'taskSuccess(1)' },
    })
    expect(part.thoughtSignature).toBeTruthy()
  })

  it('recovers function name from preceding tool_use when lowering tool_result', () => {
    // Two NeutralTurns: an assistant turn with a tool_use, then a
    // user turn with the tool_result. The lowering must walk in
    // order, remember the tool_use's name keyed by its id, and use
    // that name when emitting the functionResponse.
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolUse',
            toolUseId: 'tu_42',
            toolName: 'terminal_action',
            input: { commands: 'ls /' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'toolResult',
            toolUseId: 'tu_42',
            content: [{ type: 'text', text: 'README.md' }],
          },
        ],
      },
    ]
    const out = lowerNeutralTurns(turns)
    const part = out[1]?.parts[0] as GeminiFunctionResponsePart
    expect(part.functionResponse).toEqual({
      id: 'tu_42',
      name: 'terminal_action',
      response: { result: 'README.md' },
    })
  })

  it('flattens image content inside tool_result to an [image] placeholder', () => {
    const turns: NeutralTurn[] = [
      {
        role: 'assistant',
        content: [{ type: 'toolUse', toolUseId: 'tu_1', toolName: 'ts_action', input: {} }],
      },
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
    const part = lowerNeutralTurns(turns)[1]?.parts[0] as GeminiFunctionResponsePart
    expect(part.functionResponse.response).toEqual({ result: 'screenshot:\n[image]' })
  })
})
