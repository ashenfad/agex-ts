/**
 * An AI SDK model as a provider: the run record mapped to the spec's
 * prompt, the spec's stream back into the record, settings into each
 * provider's options, and its errors judged. Driven by a fake
 * `LanguageModelV4`; real models are the smoke script's.
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store } from '@agex-ts/world'
import {
  APICallError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4StreamPart,
} from '@ai-sdk/provider'
import { describe, expect, it } from 'vitest'
import {
  Agent,
  AiSdkProvider,
  type Message,
  type ProviderEvent,
  StreamError,
  isLanguageModel,
  newId,
  reasoningOf,
  thinkingOptions,
  toPrompt,
} from '../src/index'

const usage = (input: number, output: number, cacheRead = 0) => ({
  inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: undefined },
  outputTokens: { total: output, text: undefined, reasoning: undefined },
})

const finish = (input = 10, output = 5, cacheRead = 0): LanguageModelV4StreamPart => ({
  type: 'finish',
  usage: usage(input, output, cacheRead),
  finishReason: { unified: 'stop', raw: 'stop' },
})

/** A model that streams one scripted reply per call and keeps what it
 *  was asked. */
class Fake implements LanguageModelV4 {
  readonly specificationVersion = 'v4'
  readonly supportedUrls = {}
  readonly calls: LanguageModelV4CallOptions[] = []
  cancelled = 0
  constructor(
    readonly provider: string,
    readonly modelId: string,
    private readonly replies: (LanguageModelV4StreamPart[] | Error)[],
  ) {}
  doGenerate(): never {
    throw new Error('not driven')
  }
  async doStream(options: LanguageModelV4CallOptions) {
    this.calls.push(options)
    const reply = this.replies.shift()
    if (reply === undefined) throw new Error('no more replies')
    if (reply instanceof Error) throw reply
    return {
      stream: new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of reply) controller.enqueue(part)
          controller.close()
        },
        cancel: () => {
          this.cancelled += 1
        },
      }),
    }
  }
}

const text = (id: string, ...deltas: string[]): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id },
  ...deltas.map((delta) => ({ type: 'text-delta' as const, id, delta })),
  { type: 'text-end', id },
]

const user = (t: string): Message => ({
  id: newId(),
  role: 'user',
  parts: [{ kind: 'text', text: t }],
})

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = []
  for await (const event of stream) out.push(event)
  return out
}

const replyOf = (events: ProviderEvent[]) => {
  const last = events.at(-1)
  if (last?.kind !== 'Reply') throw new Error('no reply')
  return last.message
}

describe('an AI SDK model as a provider', () => {
  it('is named for its provider and model', () => {
    const provider = new AiSdkProvider(new Fake('anthropic.messages', 'claude-x', []))
    expect([provider.key, provider.name]).toEqual(['anthropic', 'anthropic:claude-x'])
    expect(isLanguageModel(provider.model)).toBe(true)
    expect(isLanguageModel(provider)).toBe(false)
  })

  it('streams deltas, then the reply with its usage and the model that wrote it', async () => {
    const model = new Fake('anthropic.messages', 'claude-x', [
      [
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', modelId: 'claude-x-20260101' },
        { type: 'reasoning-start', id: 'r' },
        { type: 'reasoning-delta', id: 'r', delta: 'hmm' },
        {
          type: 'reasoning-end',
          id: 'r',
          providerMetadata: { anthropic: { signature: 'sig' } },
        },
        ...text('t', 'Hel', 'lo'),
        { type: 'tool-input-start', id: 'c1', toolName: 'terminal' },
        { type: 'tool-input-delta', id: 'c1', delta: '{"command":"ls"}' },
        { type: 'tool-input-end', id: 'c1' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'terminal', input: '{"command":"ls"}' },
        { type: 'tool-call', toolCallId: 'c2', toolName: 'terminal', input: 'not json' },
        finish(100, 20, 60),
      ],
    ])
    const events = await collect(new AiSdkProvider(model).stream([user('hi')], [], {}))
    expect(events.map((e) => (e.kind === 'Reply' ? e.kind : `${e.kind}:${e.text}`))).toEqual([
      'ThinkingDelta:hmm',
      'TextDelta:Hel',
      'TextDelta:lo',
      'Reply',
    ])
    const reply = replyOf(events)
    expect(reply).toMatchObject({
      role: 'assistant',
      model: 'claude-x-20260101',
      provider: 'anthropic',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 0 },
    })
    expect(reply.parts).toEqual([
      {
        kind: 'thinking',
        text: 'hmm',
        provider: 'anthropic',
        details: { anthropic: { signature: 'sig' } },
      },
      { kind: 'text', text: 'Hello', provider: 'anthropic', details: null },
      {
        kind: 'tool_call',
        callId: 'c1',
        name: 'terminal',
        args: { command: 'ls' },
        provider: 'anthropic',
        details: null,
      },
      // arguments that aren't a JSON object reach the tool as none
      {
        kind: 'tool_call',
        callId: 'c2',
        name: 'terminal',
        args: {},
        provider: 'anthropic',
        details: null,
      },
    ])
  })

  it('merges metadata across a part, and drops empty text and provider-run tools', async () => {
    const model = new Fake('openai.responses', 'gpt-x', [
      [
        { type: 'reasoning-start', id: 'r', providerMetadata: { openai: { itemId: 'rs_1' } } },
        {
          type: 'reasoning-end',
          id: 'r',
          providerMetadata: { openai: { reasoningEncryptedContent: 'enc' } },
        },
        ...text('t'),
        {
          type: 'tool-call',
          toolCallId: 'ws',
          toolName: 'web_search',
          input: '{}',
          providerExecuted: true,
        },
        finish(),
      ],
    ])
    const reply = replyOf(await collect(new AiSdkProvider(model).stream([user('hi')], [], {})))
    expect(reply.parts).toEqual([
      {
        kind: 'thinking',
        text: '',
        provider: 'openai',
        details: { openai: { itemId: 'rs_1', reasoningEncryptedContent: 'enc' } },
      },
    ])
  })

  it('rejects with an error the stream carries, and closes the stream', async () => {
    const error = new Error('overloaded')
    const model = new Fake('anthropic.messages', 'claude-x', [
      [...text('t', 'par'), { type: 'error', error }, finish()],
    ])
    await expect(collect(new AiSdkProvider(model).stream([user('hi')], [], {}))).rejects.toBe(error)
    expect(model.cancelled).toBe(1)
  })

  it('asks with the tools, the settings and the signal', async () => {
    const model = new Fake('anthropic.messages', 'claude-x', [[...text('t', 'ok'), finish()]])
    const signal = new AbortController().signal
    const tool = { name: 'terminal', description: 'Run.', parameters: { type: 'object' } }
    await collect(
      new AiSdkProvider(model).stream(
        [user('hi')],
        [tool],
        {
          maxTokens: 1000,
          temperature: 0.5,
          thinking: 'high',
          extra: { anthropic: { sendReasoning: true }, other: { x: 1 } },
        },
        { signal },
      ),
    )
    expect(model.calls[0]).toMatchObject({
      tools: [
        {
          type: 'function',
          name: 'terminal',
          description: 'Run.',
          inputSchema: { type: 'object' },
        },
      ],
      maxOutputTokens: 1000,
      temperature: 0.5,
      reasoning: 'high',
      providerOptions: { anthropic: { sendReasoning: true }, other: { x: 1 } },
      abortSignal: signal,
    })
  })

  it('leaves out what the settings and the tools leave unset', async () => {
    const model = new Fake('google.generative-ai', 'gemini-x', [[...text('t', 'ok'), finish()]])
    await collect(new AiSdkProvider(model).stream([user('hi')], [], {}))
    const call = model.calls[0]
    expect(Object.keys(call ?? {}).sort()).toEqual(['prompt', 'providerOptions'])
    expect(call?.providerOptions).toEqual({})
  })
})

describe('the record as a prompt', () => {
  const sig = { anthropic: { signature: 'sig' } }
  const messages: Message[] = [
    {
      id: 'm0',
      role: 'system',
      parts: [
        { kind: 'text', text: 'Be ' },
        { kind: 'text', text: 'brief.' },
      ],
    },
    user('list files'),
    {
      id: 'm2',
      role: 'assistant',
      provider: 'anthropic',
      parts: [
        { kind: 'thinking', text: 'look', provider: 'anthropic', details: sig },
        { kind: 'text', text: '', provider: 'anthropic' },
        { kind: 'text', text: 'Looking.', provider: 'anthropic' },
        {
          kind: 'tool_call',
          callId: 'c1',
          name: 'terminal',
          args: { command: 'ls' },
          provider: 'anthropic',
          details: sig,
        },
      ],
    },
    {
      id: 'm3',
      role: 'tool',
      parts: [
        { kind: 'tool_result', callId: 'c1', name: 'terminal', content: 'a.txt' },
        { kind: 'tool_result', callId: 'c2', name: 'nope', content: 'no such tool', isError: true },
        {
          kind: 'tool_result',
          callId: 'c3',
          name: 'view',
          content: 'an image',
          images: [{ kind: 'image', data: 'AAAA', mediaType: 'image/png' }],
        },
      ],
    },
  ]

  it('maps each role, sending metadata back to the provider that wrote it', () => {
    expect(toPrompt(messages, 'anthropic')).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'list files' }] },
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'look', providerOptions: sig },
          { type: 'text', text: 'Looking.' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'terminal',
            input: { command: 'ls' },
            providerOptions: sig,
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'terminal',
            output: { type: 'text', value: 'a.txt' },
          },
          {
            type: 'tool-result',
            toolCallId: 'c2',
            toolName: 'nope',
            output: { type: 'error-text', value: 'no such tool' },
          },
          {
            type: 'tool-result',
            toolCallId: 'c3',
            toolName: 'view',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'an image' },
                { type: 'file', data: { type: 'data', data: 'AAAA' }, mediaType: 'image/png' },
              ],
            },
          },
        ],
      },
    ])
  })

  it("leaves another provider's reasoning and metadata out", () => {
    const [, , assistant] = toPrompt(messages, 'openai')
    expect(assistant).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Looking.' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'terminal', input: { command: 'ls' } },
      ],
    })
  })

  it('skips a message left with nothing to send', () => {
    const empty: Message = {
      id: 'e',
      role: 'assistant',
      parts: [{ kind: 'thinking', text: 'x', provider: 'openai' }],
    }
    expect(toPrompt([user('hi'), empty], 'anthropic')).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ])
  })
})

describe('thinking, by provider', () => {
  it("is the spec's reasoning effort", () => {
    expect([reasoningOf(true), reasoningOf(false), reasoningOf('xhigh')]).toEqual([
      'medium',
      'none',
      'xhigh',
    ])
  })

  it('adds what a provider needs besides', () => {
    expect(thinkingOptions('anthropic', 'low')).toEqual({})
    expect(thinkingOptions('openai', true)).toEqual({
      openai: { store: false, include: ['reasoning.encrypted_content'], reasoningSummary: 'auto' },
    })
    expect(thinkingOptions('google', 'high')).toEqual({
      google: { thinkingConfig: { includeThoughts: true } },
    })
    expect(thinkingOptions('google', false)).toEqual({})
    expect(thinkingOptions('openrouter', 'xhigh')).toEqual({
      openrouter: { reasoning: { effort: 'high' } },
    })
    expect(thinkingOptions('openrouter', false)).toEqual({
      openrouter: { reasoning: { enabled: false } },
    })
    expect(thinkingOptions('mistral', 'high')).toEqual({})
  })

  it("keeps OpenAI's reasoning with the record when thinking is left unset", () => {
    expect(thinkingOptions('openai', undefined)).toEqual({
      openai: { store: false, include: ['reasoning.encrypted_content'] },
    })
    expect(thinkingOptions('openrouter', undefined)).toEqual({})
  })
})

describe('errors', () => {
  const apiError = (statusCode: number | undefined, responseBody?: string, isRetryable = false) =>
    new APICallError({
      message: 'Bad things',
      url: 'https://example.invalid',
      requestBodyValues: {},
      ...(statusCode !== undefined && { statusCode }),
      ...(responseBody !== undefined && { responseBody }),
      isRetryable,
    })
  const anthropic = new AiSdkProvider(new Fake('anthropic.messages', 'claude-x', []))
  const openrouter = new AiSdkProvider(new Fake('openrouter.chat', 'some/model', []))

  it('judges statuses: rate limits and server errors are transient, refusals not', () => {
    for (const code of [408, 409, 425, 429, 500, 503, 529]) {
      expect(anthropic.transient(apiError(code))).toBe(true)
    }
    for (const code of [400, 401, 403, 404, 413, 422]) {
      expect(anthropic.transient(apiError(code))).toBe(false)
    }
    expect(anthropic.transient(apiError(undefined, undefined, true))).toBe(true)
    expect(anthropic.transient(apiError(undefined))).toBe(false)
  })

  it("takes OpenRouter's relayed errors as transient, whatever their status", () => {
    const relayed = JSON.stringify({ error: { message: 'Provider returned error', code: 400 } })
    const upstream = JSON.stringify({ error: { message: 'x', metadata: { provider_name: 'Y' } } })
    const own = JSON.stringify({ error: { message: 'Invalid model', code: 400 } })
    expect(openrouter.transient(apiError(400, relayed))).toBe(true)
    expect(openrouter.transient(apiError(400, upstream))).toBe(true)
    expect(openrouter.transient(apiError(400, own))).toBe(false)
    expect(anthropic.transient(apiError(400, relayed))).toBe(false)
  })

  it('takes a provider out of reach or timed out as transient, and a cancel never', () => {
    expect(anthropic.transient(new TypeError('fetch failed'))).toBe(true)
    const reset = Object.assign(new Error('socket'), { code: 'ECONNRESET' })
    expect(anthropic.transient(new TypeError('x', { cause: reset }))).toBe(true)
    expect(anthropic.transient(new DOMException('stopped', 'AbortError'))).toBe(false)
    expect(anthropic.transient(new DOMException('slow', 'TimeoutError'))).toBe(true)
    const timedOut = new Error('request failed', {
      cause: new DOMException('slow', 'TimeoutError'),
    })
    expect(anthropic.transient(timedOut)).toBe(true)
    expect(anthropic.transient(new Error('a bug'))).toBe(false)
  })

  it("describes an HTTP error in the provider's words", () => {
    const body = JSON.stringify({
      type: 'error',
      error: { type: 'x', message: 'prompt is too long' },
    })
    expect(anthropic.describe(apiError(400, body))).toBe(
      'the model provider refused the request (400): prompt is too long',
    )
    expect(anthropic.describe(apiError(529, 'not json'))).toBe(
      'the model provider failed (529): Bad things',
    )
    expect(anthropic.describe(new Error('other'))).toBeNull()
  })
})

describe('an agent over an AI SDK model', () => {
  it('runs a turn with tools against the workspace, and sends the record back', async () => {
    const store = await Store.open(new Memory())
    const ws = await store.open('s')
    const model = new Fake('anthropic.messages', 'claude-x', [
      [
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'file_write',
          input: JSON.stringify({ path: '/workspace/a.txt', content: 'A' }),
          providerMetadata: { anthropic: { caller: 'x' } },
        },
        finish(),
      ],
      [...text('t', 'Wrote it.'), finish()],
    ])
    const outcome = await new Agent({ model, primer: 'Be brief.' }).session(ws).say('write a')
    expect([outcome.status, outcome.text]).toEqual(['completed', 'Wrote it.'])
    expect(await ws.files.readText('/workspace/a.txt')).toBe('A')
    const second = model.calls[1]?.prompt ?? []
    expect(second.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
    expect(second[2]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'file_write',
          input: { path: '/workspace/a.txt', content: 'A' },
          providerOptions: { anthropic: { caller: 'x' } },
        },
      ],
    })
    expect(model.calls[0]?.tools?.map((t) => t.name)).toContain('file_write')
  })

  it('interrupts a run on a rate limit, and fails it on a refusal', async () => {
    const store = await Store.open(new Memory())
    const ws = await store.open('s')
    const limited = new APICallError({
      message: 'slow down',
      url: 'https://example.invalid',
      requestBodyValues: {},
      statusCode: 429,
    })
    const refused = new APICallError({
      message: 'bad request',
      url: 'https://example.invalid',
      requestBodyValues: {},
      statusCode: 400,
    })
    const model = new Fake('anthropic.messages', 'claude-x', [limited, refused])
    const session = new Agent({ model }).session(ws)
    expect((await session.say('hi')).status).toBe('interrupted')
    const failed = await session.say('again')
    expect(failed.status).toBe('failed')
    expect(failed.message).toBe('the model provider refused the request (400): bad request')
  })

  // what @ai-sdk/anthropic hands on for an `error` event mid-stream: a
  // plain object (createProviderStreamError), not an Error
  const overloaded = {
    message: 'Overloaded',
    type: 'overloaded_error',
    statusCode: 529,
    isRetryable: true,
    data: { type: 'overloaded_error', message: 'Overloaded' },
  }

  it("judges an error the stream carried by the provider's word, else its status", () => {
    const anthropic = new AiSdkProvider(new Fake('anthropic.messages', 'claude-x', []))
    const e = new StreamError('x', { isRetryable: true })
    expect(anthropic.transient(e)).toBe(true)
    expect(anthropic.transient(new StreamError('x', { statusCode: 529 }))).toBe(true)
    expect(anthropic.transient(new StreamError('x', { statusCode: 400 }))).toBe(false)
    expect(anthropic.transient(new StreamError('x'))).toBe(false)
  })

  it('ends a turn whose stream errored mid-reply interrupted, saying what the provider said', async () => {
    const store = await Store.open(new Memory())
    const ws = await store.open('main')
    const model = new Fake('anthropic.messages', 'claude-x', [
      [...text('t1', 'Writing the vid'), { type: 'error', error: overloaded }],
      [...text('t2', 'Done.'), finish()],
    ])
    const session = new Agent({ model }).session(ws)
    const out = await session.say('Make the video.')
    expect(out.status).toBe('interrupted')
    expect(out.message).toBe('the model provider failed mid-reply: overloaded_error: Overloaded')
    expect(out.message).not.toContain('[object Object]')
    expect((await session.resume()).status).toBe('completed')
  })

  it('fails a turn on a stream error the provider says not to retry, in its words', async () => {
    const store = await Store.open(new Memory())
    const ws = await store.open('main')
    const refused = {
      type: 'error',
      error: { type: 'invalid_request_error', message: 'max_tokens is too large' },
    }
    const model = new Fake('anthropic.messages', 'claude-x', [[{ type: 'error', error: refused }]])
    const out = await new Agent({ model }).session(ws).say('Go.')
    expect(out.status).toBe('failed')
    expect(out.message).toBe(
      'the model provider refused the request mid-reply: invalid_request_error: max_tokens is too large',
    )
  })

  it('says what a thrown non-Error holds, never [object Object]', async () => {
    const store = await Store.open(new Memory())
    const ws = await store.open('main')
    const model = new Fake('anthropic.messages', 'claude-x', [
      [{ type: 'error', error: { code: 7 } }],
    ])
    const out = await new Agent({ model }).session(ws).say('Go.')
    expect(out.status).toBe('failed')
    expect(out.message).toContain('{"code":7}')
  })
})
