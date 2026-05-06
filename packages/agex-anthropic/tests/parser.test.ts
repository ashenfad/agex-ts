import type { Emission, TokenChunk } from 'agex-ts/types'
import { describe, expect, it } from 'vitest'
import { parseToolEvents } from '../src/parser'
import type { ToolCallEvent } from '../src/stream'

async function* fromArray<T>(items: ReadonlyArray<T>): AsyncIterable<T> {
  for (const x of items) yield x
}

async function collect(iter: AsyncIterable<TokenChunk>): Promise<TokenChunk[]> {
  const out: TokenChunk[] = []
  for await (const t of iter) out.push(t)
  return out
}

function emissionsOf(tokens: ReadonlyArray<TokenChunk>): Emission[] {
  return tokens
    .filter((t) => t.type === 'emission' && t.emission !== undefined)
    .map((t) => t.emission as Emission)
}

/** Stream a tool call as an array of events. JSON args may be split
 *  across multiple ArgDelta events to mimic real provider behavior. */
function callEvents(
  callId: string,
  toolName: string,
  jsonArgs: string,
  splitAt?: ReadonlyArray<number>,
): ToolCallEvent[] {
  const out: ToolCallEvent[] = [
    {
      type: 'toolCallStart',
      callId,
      toolName: toolName as ToolCallEvent extends { toolName: infer T } ? T : never,
    },
  ]
  if (splitAt === undefined) {
    out.push({ type: 'toolCallArgDelta', callId, argumentChunk: jsonArgs })
  } else {
    let cursor = 0
    for (const at of splitAt) {
      out.push({
        type: 'toolCallArgDelta',
        callId,
        argumentChunk: jsonArgs.slice(cursor, at),
      })
      cursor = at
    }
    out.push({
      type: 'toolCallArgDelta',
      callId,
      argumentChunk: jsonArgs.slice(cursor),
    })
  }
  out.push({ type: 'toolCallEnd', callId })
  return out
}

describe('parseToolEvents — ts_action tool', () => {
  it('builds a TsEmission with code/title/thinking from the JSON args', async () => {
    const events = callEvents(
      'a',
      'ts_action',
      '{"title":"work","thinking":"plan","code":"taskSuccess(1)"}',
    )
    const tokens = await collect(parseToolEvents(fromArray(events)))
    const emissions = emissionsOf(tokens)
    expect(emissions).toEqual([
      { type: 'ts', code: 'taskSuccess(1)', thinking: 'plan', title: 'work' },
    ])
  })

  it('emits per-key streaming chunks for the UI before the final emission', async () => {
    const events = callEvents(
      'a',
      'ts_action',
      '{"title":"x","thinking":"hmm","code":"abc"}',
      [1, 12, 30],
    )
    const tokens = await collect(parseToolEvents(fromArray(events)))
    // toolStart appears first, then a stream of typed chunks, then the
    // final emission token.
    expect(tokens[0]?.type).toBe('toolStart')
    expect(tokens[0]?.content).toBe('ts_action')
    const streamedTypes = new Set(tokens.slice(1, -1).map((t) => t.type))
    expect(streamedTypes.has('title')).toBe(true)
    expect(streamedTypes.has('thinking')).toBe(true)
    expect(streamedTypes.has('ts')).toBe(true)
    expect(tokens.at(-1)?.type).toBe('emission')
  })

  it('handles native-thinking schema (no thinking field)', async () => {
    const events = callEvents('a', 'ts_action', '{"title":"x","code":"y"}')
    const tokens = await collect(parseToolEvents(fromArray(events)))
    expect(emissionsOf(tokens)).toEqual([{ type: 'ts', code: 'y', title: 'x' }])
  })
})

describe('parseToolEvents — terminal_action tool', () => {
  it('builds a TerminalEmission and surfaces commands as terminal-typed chunks', async () => {
    const events = callEvents(
      'a',
      'terminal_action',
      '{"title":"t","commands":"ls /","thinking":"glance"}',
    )
    const tokens = await collect(parseToolEvents(fromArray(events)))
    expect(emissionsOf(tokens)).toEqual([
      { type: 'terminal', commands: 'ls /', thinking: 'glance', title: 't' },
    ])
    const streamedTypes = tokens.map((t) => t.type)
    expect(streamedTypes).toContain('terminal')
  })
})

describe('parseToolEvents — write_file tool', () => {
  it('builds a FileWriteEmission with mode from the parsed JSON', async () => {
    const events = callEvents('a', 'write_file', '{"path":"/n.txt","content":"hi","mode":"append"}')
    expect(emissionsOf(await collect(parseToolEvents(fromArray(events))))).toEqual([
      { type: 'fileWrite', path: '/n.txt', content: 'hi', mode: 'append' },
    ])
  })

  it('defaults mode to write when omitted or invalid', async () => {
    const omitted = callEvents('a', 'write_file', '{"path":"/n","content":"hi"}')
    expect(emissionsOf(await collect(parseToolEvents(fromArray(omitted))))).toEqual([
      { type: 'fileWrite', path: '/n', content: 'hi', mode: 'write' },
    ])
    const invalid = callEvents('a', 'write_file', '{"path":"/n","content":"","mode":"junk"}')
    expect(emissionsOf(await collect(parseToolEvents(fromArray(invalid))))).toEqual([
      { type: 'fileWrite', path: '/n', content: '', mode: 'write' },
    ])
  })

  it('emits filePath / fileContent streaming chunks for the UI', async () => {
    const events = callEvents('a', 'write_file', '{"path":"/n.txt","content":"hi"}', [1, 18])
    const tokens = await collect(parseToolEvents(fromArray(events)))
    const types = tokens.map((t) => t.type)
    expect(types).toContain('filePath')
    expect(types).toContain('fileContent')
  })

  it('drops the call when path is missing', async () => {
    const events = callEvents('a', 'write_file', '{"content":"orphan"}')
    expect(emissionsOf(await collect(parseToolEvents(fromArray(events))))).toEqual([])
  })
})

describe('parseToolEvents — edit_file tool', () => {
  it('builds a FileEditEmission with matchAll preserved', async () => {
    const events = callEvents(
      'a',
      'edit_file',
      '{"path":"/n","search":"old","content":"new","matchAll":true}',
    )
    expect(emissionsOf(await collect(parseToolEvents(fromArray(events))))).toEqual([
      { type: 'fileEdit', path: '/n', search: 'old', content: 'new', matchAll: true },
    ])
  })

  it('omits matchAll when false / missing', async () => {
    const events = callEvents('a', 'edit_file', '{"path":"/n","search":"x","content":"y"}')
    expect(emissionsOf(await collect(parseToolEvents(fromArray(events))))).toEqual([
      { type: 'fileEdit', path: '/n', search: 'x', content: 'y' },
    ])
  })

  it('emits filePath / fileSearch / fileContent UI chunks', async () => {
    const events = callEvents(
      'a',
      'edit_file',
      '{"path":"/p","search":"o","content":"n"}',
      [4, 18, 30],
    )
    const types = (await collect(parseToolEvents(fromArray(events)))).map((t) => t.type)
    expect(types).toContain('filePath')
    expect(types).toContain('fileSearch')
    expect(types).toContain('fileContent')
  })

  it('drops the call when search is missing', async () => {
    const events = callEvents('a', 'edit_file', '{"path":"/n","content":"new"}')
    expect(emissionsOf(await collect(parseToolEvents(fromArray(events))))).toEqual([])
  })
})

describe('parseToolEvents — TextPart / ThinkingPart events', () => {
  it('TextPart becomes a TextEmission', async () => {
    const events: ToolCallEvent[] = [{ type: 'textPart', text: 'aside to user' }]
    expect(emissionsOf(await collect(parseToolEvents(fromArray(events))))).toEqual([
      { type: 'text', text: 'aside to user' },
    ])
  })

  it('drops whitespace-only TextPart', async () => {
    const events: ToolCallEvent[] = [{ type: 'textPart', text: '\n  ' }]
    expect(emissionsOf(await collect(parseToolEvents(fromArray(events))))).toEqual([])
  })

  it('ThinkingPart becomes a ThinkingEmission with signature preserved as bytes', async () => {
    const sig = new TextEncoder().encode('opaque-sig')
    const events: ToolCallEvent[] = [{ type: 'thinkingPart', text: 'reasoning', signature: sig }]
    const emissions = emissionsOf(await collect(parseToolEvents(fromArray(events))))
    expect(emissions).toEqual([{ type: 'thinking', text: 'reasoning', signature: sig }])
  })

  it('redacted ThinkingPart preserves the redacted flag', async () => {
    const sig = new TextEncoder().encode('encrypted')
    const events: ToolCallEvent[] = [{ type: 'thinkingPart', signature: sig, redacted: true }]
    const emissions = emissionsOf(await collect(parseToolEvents(fromArray(events))))
    expect(emissions[0]).toEqual({
      type: 'thinking',
      text: '',
      signature: sig,
      redacted: true,
    })
  })

  it('streams thinking deltas as TokenChunks before the final emission', async () => {
    const sig = new TextEncoder().encode('opaque')
    const events: ToolCallEvent[] = [
      { type: 'thinkingDelta', content: 'Step ' },
      { type: 'thinkingDelta', content: 'one.' },
      { type: 'thinkingPart', text: 'Step one.', signature: sig },
    ]
    const tokens = await collect(parseToolEvents(fromArray(events)))
    // Two streaming chunks (done=false) sharing the emission index of
    // the eventual final emission, then the final emission token.
    const thinkingChunks = tokens.filter((t) => t.type === 'thinking')
    expect(thinkingChunks).toHaveLength(2)
    expect(thinkingChunks[0]?.content).toBe('Step ')
    expect(thinkingChunks[1]?.content).toBe('one.')
    const idx = thinkingChunks[0]?.emissionIndex
    expect(thinkingChunks.every((t) => t.emissionIndex === idx)).toBe(true)
    const final = tokens.at(-1)
    expect(final?.type).toBe('emission')
    expect(final?.emissionIndex).toBe(idx)
    expect(final?.emission).toEqual({ type: 'thinking', text: 'Step one.', signature: sig })
  })

  it('streams text deltas as TokenChunks sharing the final emission index', async () => {
    const events: ToolCallEvent[] = [
      { type: 'textDelta', content: 'aside ' },
      { type: 'textDelta', content: 'to user' },
      { type: 'textPart', text: 'aside to user' },
    ]
    const tokens = await collect(parseToolEvents(fromArray(events)))
    const textChunks = tokens.filter((t) => t.type === 'text')
    expect(textChunks).toHaveLength(2)
    expect(textChunks[0]?.content).toBe('aside ')
    expect(textChunks[1]?.content).toBe('to user')
    const idx = textChunks[0]?.emissionIndex
    expect(textChunks.every((t) => t.emissionIndex === idx)).toBe(true)
    const final = tokens.at(-1)
    expect(final?.emissionIndex).toBe(idx)
    expect(final?.emission).toEqual({ type: 'text', text: 'aside to user' })
  })
})

describe('parseToolEvents — invariants', () => {
  it('drops calls with malformed JSON', async () => {
    const events: ToolCallEvent[] = [
      { type: 'toolCallStart', callId: 'a', toolName: 'ts_action' },
      { type: 'toolCallArgDelta', callId: 'a', argumentChunk: '{"code":"x"' }, // unclosed
      { type: 'toolCallEnd', callId: 'a' },
    ]
    const emissions = emissionsOf(await collect(parseToolEvents(fromArray(events))))
    expect(emissions).toEqual([])
  })

  it('assigns monotonically increasing emission indices across mixed events', async () => {
    const events: ToolCallEvent[] = [
      { type: 'thinkingPart', text: 'plan', signature: new Uint8Array([1]) },
      ...callEvents('a', 'ts_action', '{"title":"t","code":"c"}'),
      { type: 'textPart', text: 'aside' },
    ]
    const emissions = (await collect(parseToolEvents(fromArray(events)))).filter(
      (t) => t.type === 'emission',
    )
    expect(emissions.map((t) => t.emissionIndex)).toEqual([0, 1, 2])
  })

  it('surfaces the toolStart token before any arg deltas', async () => {
    const events = callEvents('a', 'ts_action', '{"code":"x"}', [3, 9])
    const tokens = await collect(parseToolEvents(fromArray(events)))
    const startIdx = tokens.findIndex((t) => t.type === 'toolStart')
    const firstArgIdx = tokens.findIndex((t) => t.type === 'ts')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    if (firstArgIdx >= 0) expect(startIdx).toBeLessThan(firstArgIdx)
  })
})
