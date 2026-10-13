/** The run record: plain data, read back checked. */

import { describe, expect, it } from 'vitest'
import {
  FORMAT,
  type Message,
  NO_USAGE,
  RecordError,
  type Run,
  dumpRun,
  loadRun,
  messageText,
  newId,
  runUsage,
} from '../src/index'

const reply: Message = {
  id: newId(),
  role: 'assistant',
  parts: [
    { kind: 'thinking', text: 'look it up', signature: 'sig', provider: 'anthropic' },
    { kind: 'text', text: 'Checking ', provider: 'anthropic' },
    { kind: 'text', text: 'the weather.' },
    {
      kind: 'tool_call',
      callId: 'toolu_1',
      name: 'weather',
      args: { city: 'Paris' },
      details: { google: { thoughtSignature: 'abc' } },
    },
  ],
  model: 'claude-haiku-5-5',
  provider: 'anthropic',
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheWriteTokens: 0 },
  fold: null,
}

const run: Run = {
  format: FORMAT,
  runId: newId(),
  status: 'completed',
  messages: [
    { id: newId(), role: 'user', parts: [{ kind: 'text', text: 'Weather in Paris?' }] },
    reply,
    {
      id: newId(),
      role: 'tool',
      parts: [
        {
          kind: 'tool_result',
          callId: 'toolu_1',
          name: 'weather',
          content: 'Sunny.',
          isError: false,
          images: [{ kind: 'image', data: 'iVBOR', mediaType: 'image/png' }],
        },
      ],
    },
  ],
  startedAt: 1,
  endedAt: 2,
  compaction: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
}

describe('the run record', () => {
  it('reads back from JSON as it was written', () => {
    const stored = JSON.parse(JSON.stringify(dumpRun(run)))
    expect(loadRun(stored)).toEqual(
      JSON.parse(
        JSON.stringify({
          ...run,
          messages: run.messages.map((m) => ({
            model: null,
            provider: null,
            usage: null,
            fold: null,
            ...m,
            parts: m.parts.map((p) =>
              p.kind === 'tool_result'
                ? p
                : {
                    id: null,
                    provider: null,
                    details: null,
                    ...(p.kind === 'thinking' && { signature: null }),
                    ...p,
                  },
            ),
          })),
        }),
      ),
    )
  })

  it('sums what a run cost, its summary calls included', () => {
    expect(runUsage(run)).toEqual({
      inputTokens: 105,
      outputTokens: 21,
      cacheReadTokens: 80,
      cacheWriteTokens: 0,
    })
    expect(runUsage({ ...run, messages: [], compaction: null })).toEqual(NO_USAGE)
    expect(messageText(reply)).toBe('Checking the weather.')
  })

  it('refuses what does not fit, saying where', () => {
    expect(() => loadRun({ ...run, format: FORMAT + 1 })).toThrow(/newer than/)
    expect(() => loadRun({ ...run, status: 'done' })).toThrow(/\.status: unknown status/)
    expect(() => loadRun({ ...run, runId: 7 })).toThrow(/\.runId: not a string/)
    const bad = { ...run, messages: [{ ...reply, parts: [{ kind: 'video' }] }] }
    expect(() => loadRun(bad)).toThrow(RecordError)
    expect(() => loadRun(bad)).toThrow(
      /\.messages\[0\]\.parts\[0\]\.kind: unknown part kind "video"/,
    )
    expect(() => loadRun([])).toThrow(/not an object/)
    // a record missing its messages is truncated, not empty
    const { messages: _, ...truncated } = run
    expect(() => loadRun(truncated)).toThrow(/\.messages: not a list/)
    const partless = { ...run, messages: [{ id: 'm', role: 'user' }] }
    expect(() => loadRun(partless)).toThrow(/\.messages\[0\]\.parts: not a list/)
    // a tool failure isn't turned into a success
    const result = run.messages[2] as Message
    const flagged = (isError: unknown) => ({
      ...run,
      messages: [{ ...result, parts: [{ ...result.parts[0], isError }] }],
    })
    expect(() => loadRun(flagged('true'))).toThrow(/\.isError: not a boolean/)
    expect(() => loadRun(flagged(1))).toThrow(/not a boolean/)
    const failed = loadRun(flagged(true)).messages[0]?.parts[0]
    expect(failed?.kind === 'tool_result' && failed.isError).toBe(true)
  })

  it('reads a running run, with defaults for what an older one lacks', () => {
    const loaded = loadRun({
      runId: 'r1',
      messages: [{ id: 'm', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    })
    expect(loaded).toMatchObject({ format: FORMAT, runId: 'r1', status: null, startedAt: null })
  })
})
