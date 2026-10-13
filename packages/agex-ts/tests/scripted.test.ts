/** The scripted provider: the corpus's model steps as a provider's
 *  stream. */

import type { ModelStep } from '@agex-ts/world/conformance'
import { describe, expect, it } from 'vitest'
import {
  type Message,
  type ProviderEvent,
  ScriptOverloaded,
  ScriptedProvider,
  newId,
  texts,
} from '../src/index'

const step = (over: Partial<ModelStep>): ModelStep => ({
  kind: 'model',
  text: '',
  thinking: '',
  tool_calls: [],
  fail: '',
  input_tokens: 0,
  ...over,
})

const user = (text: string): Message => ({
  id: newId(),
  role: 'user',
  parts: [{ kind: 'text', text }],
})

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

describe('the scripted provider', () => {
  it('streams a step as deltas, then the reply, tool calls given ids', async () => {
    const provider = new ScriptedProvider([
      step({
        thinking: 'need the tool',
        text: 'Let me look.',
        tool_calls: [
          { name: 'terminal', args: { command: 'ls' } },
          { name: 'file_write', args: { path: 'a', content: 'b' } },
        ],
        input_tokens: 1234,
      }),
      step({ tool_calls: [{ name: 'terminal', args: { command: 'pwd' } }] }),
    ])
    const events = await collect(provider.stream([user('hi')], [], {}))
    expect(events.map((e) => e.kind)).toEqual(['ThinkingDelta', 'TextDelta', 'Reply'])
    const reply = events[2]
    if (reply?.kind !== 'Reply') throw new Error('no reply')
    expect(reply.message).toMatchObject({ role: 'assistant', model: 'scripted' })
    expect(reply.message.parts.map((p) => (p.kind === 'tool_call' ? p.callId : p.kind))).toEqual([
      'thinking',
      'text',
      'call_1',
      'call_2',
    ])
    expect(reply.message.usage?.inputTokens).toBe(1234)
    const next = await collect(provider.stream([user('hi')], [], {}))
    const call = next[0]?.kind === 'Reply' ? next[0].message.parts[0] : undefined
    expect(call?.kind === 'tool_call' && call.callId).toBe('call_3')
    expect(provider.seen).toHaveLength(2)
  })

  it('runs out with the exhausted step rather than hang', async () => {
    const provider = new ScriptedProvider([])
    const events = await collect(provider.stream([], [], {}))
    expect(events.map((e) => (e.kind === 'TextDelta' ? e.text : e.kind))).toEqual([
      '(the script ran out)',
      'Reply',
    ])
  })

  it('fails as the step says: a provider failure is transient, an error not', async () => {
    const provider = new ScriptedProvider([step({ fail: 'provider' }), step({ fail: 'error' })])
    const overloaded = await collect(provider.stream([], [], {})).catch((e) => e)
    expect(overloaded).toBeInstanceOf(ScriptOverloaded)
    expect(provider.transient(overloaded)).toBe(true)
    const failed = await collect(provider.stream([], [], {})).catch((e) => e)
    expect(failed).toBeInstanceOf(Error)
    expect(provider.transient(failed)).toBe(false)
  })

  it("asks a function for each step, passing the request's texts", async () => {
    const asked: (readonly string[])[] = []
    const provider = new ScriptedProvider(async (sent) => {
      asked.push(sent)
      return step({ text: 'ok' })
    })
    const messages: Message[] = [
      user('first'),
      {
        id: newId(),
        role: 'assistant',
        parts: [
          { kind: 'thinking', text: 'hmm' },
          { kind: 'tool_call', callId: 'c', name: 'terminal', args: {} },
        ],
      },
      {
        id: newId(),
        role: 'tool',
        parts: [{ kind: 'tool_result', callId: 'c', name: 'terminal', content: 'out' }],
      },
    ]
    await collect(provider.stream(messages, [], {}))
    expect(asked).toEqual([['first', 'hmm', 'out']])
    expect(texts(messages)).toEqual(['first', 'hmm', 'out'])
  })

  it('stops on an abort signal', async () => {
    const controller = new AbortController()
    controller.abort('the person stopped it')
    const provider = new ScriptedProvider([step({ text: 'never' })])
    await expect(
      collect(provider.stream([], [], {}, { signal: controller.signal })),
    ).rejects.toThrow('the person stopped it')
    const later = new AbortController()
    const waiting = new ScriptedProvider(async () => {
      later.abort()
      return step({ text: 'too late' })
    })
    await expect(
      collect(waiting.stream([], [], {}, { signal: later.signal })),
    ).rejects.toMatchObject({
      name: 'AbortError',
    })
  })
})
