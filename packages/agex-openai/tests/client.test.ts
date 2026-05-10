import type { Emission, LLMRequest, TokenChunk } from 'agex-ts/types'
import { describe, expect, it } from 'vitest'
import { OpenAI } from '../src/client'

const enc = new TextEncoder()

function sseStream(events: ReadonlyArray<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const lines = `${events.map((e) => `data: ${JSON.stringify(e)}\n`).join('')}data: [DONE]\n`
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(lines))
      controller.close()
    },
  })
}

interface FetchCall {
  url: string
  init: RequestInit
}

function recordingFetch(events: ReadonlyArray<Record<string, unknown>>): {
  fn: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fn: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} })
    return new Response(sseStream(events), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  return { fn, calls }
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

const trivialRequest: LLMRequest = {
  system: 'system primer',
  turns: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
}

const happyPathEvents: Record<string, unknown>[] = [
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
    choices: [
      {
        delta: {
          tool_calls: [
            { index: 0, function: { arguments: '{"title":"x","code":"taskSuccess(1)"}' } },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } },
]

describe('OpenAI — request body shape', () => {
  it('sends model, messages (system + lowered turns), tools, stream, stream_options', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({ model: 'gpt-test', apiKey: 'sk-test', fetchImpl: fn })
    await collect(client.complete(trivialRequest))

    expect(calls.length).toBe(1)
    const call = calls[0]
    if (call === undefined) throw new Error('expected one call')
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-test')
    expect(headers['content-type']).toBe('application/json')

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>
    expect(body.model).toBe('gpt-test')
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
    const messages = body.messages as ReadonlyArray<Record<string, unknown>>
    expect(messages[0]).toEqual({ role: 'system', content: 'system primer' })
    expect(messages[1]).toEqual({ role: 'user', content: 'hello' })
    const tools = body.tools as ReadonlyArray<{ type: string; function: { name: string } }>
    expect(tools.every((t) => t.type === 'function')).toBe(true)
    expect(tools.map((t) => t.function.name).sort()).toEqual(
      ['edit_file', 'terminal_action', 'ts_action', 'write_file'].sort(),
    )
  })

  it('defaults tool_choice to required (forces a tool call each turn)', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({ apiKey: 'sk-test', fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.tool_choice).toBe('required')
  })

  it('omits tool_choice when forceToolUse is false', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({ apiKey: 'sk-test', forceToolUse: false, fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.tool_choice).toBeUndefined()
  })

  it('caller extras override computed defaults', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({
      apiKey: 'sk-test',
      maxTokens: 4096,
      extras: { temperature: 0.2, max_tokens: 2048, response_format: { type: 'text' } },
      fetchImpl: fn,
    })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(2048)
    expect(body.response_format).toEqual({ type: 'text' })
  })

  it('uses max_tokens for legacy / non-reasoning models', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({ apiKey: 'sk-test', model: 'gpt-4o-mini', fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.max_tokens).toBeDefined()
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('uses max_completion_tokens for gpt-5* and o-series reasoning models', async () => {
    // gpt-5* and o-series reject max_tokens — they require
    // max_completion_tokens to disambiguate visible-output tokens
    // from internal reasoning tokens. We detect on model name.
    const { fn, calls } = recordingFetch(happyPathEvents)
    for (const model of ['gpt-5.4-nano', 'gpt-5', 'o1-mini', 'o3']) {
      calls.length = 0
      const client = new OpenAI({ apiKey: 'sk-test', model, fetchImpl: fn })
      await collect(client.complete(trivialRequest))
      const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
      expect(body.max_completion_tokens).toBeDefined()
      expect(body.max_tokens).toBeUndefined()
    }
  })
})

describe('OpenAI — baseUrl override (local models / proxies)', () => {
  it('hits the configured baseUrl + /chat/completions', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({
      apiKey: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.1',
      fetchImpl: fn,
    })
    await collect(client.complete(trivialRequest))
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions')
  })

  it('strips a trailing slash from baseUrl', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1/',
      fetchImpl: fn,
    })
    await collect(client.complete(trivialRequest))
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions')
  })

  it('sends a dummy Bearer header when no apiKey is set (for local servers)', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({ baseUrl: 'http://localhost:11434/v1', fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer sk-no-key')
  })
})

describe('OpenAI — response streaming', () => {
  it('builds the right Emission and surfaces token usage on the trailing chunk', async () => {
    const { fn } = recordingFetch(happyPathEvents)
    const client = new OpenAI({ apiKey: 'sk-test', fetchImpl: fn })
    const tokens = await collect(client.complete(trivialRequest))
    const emissions = emissionsOf(tokens)
    expect(emissions).toEqual([{ type: 'ts', code: 'taskSuccess(1)', title: 'x' }])
    const trailer = tokens.at(-1)
    expect(trailer?.inputTokens).toBe(50)
    expect(trailer?.outputTokens).toBe(10)
  })

  it('surfaces a non-2xx response as an Error', async () => {
    const fn: typeof fetch = async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })
    const client = new OpenAI({ apiKey: 'sk-test', fetchImpl: fn })
    await expect(collect(client.complete(trivialRequest))).rejects.toThrow(/429/)
  })
})

describe('OpenAI — retry', () => {
  it('retries once on a transient TypeError and succeeds on the second try', async () => {
    let attempt = 0
    const fn: typeof fetch = async () => {
      attempt++
      if (attempt === 1) throw new TypeError('network error')
      return new Response(sseStream(happyPathEvents), { status: 200 })
    }
    const client = new OpenAI({ apiKey: 'sk-test', fetchImpl: fn })
    const tokens = await collect(client.complete(trivialRequest))
    expect(attempt).toBe(2)
    expect(emissionsOf(tokens).length).toBe(1)
  })

  it('does not retry on a non-network error (e.g. 400)', async () => {
    let attempt = 0
    const fn: typeof fetch = async () => {
      attempt++
      return new Response('bad', { status: 400, statusText: 'Bad Request' })
    }
    const client = new OpenAI({ apiKey: 'sk-test', fetchImpl: fn })
    await expect(collect(client.complete(trivialRequest))).rejects.toThrow(/400/)
    expect(attempt).toBe(1)
  })
})

describe('OpenAI — dumpConfig', () => {
  it('returns provider/model/timeout plus extras snapshot including baseUrl', () => {
    const client = new OpenAI({
      model: 'gpt-test',
      apiKey: 'sk-test',
      baseUrl: 'http://localhost:11434/v1',
      timeoutMs: 30_000,
      maxTokens: 4096,
      extras: { temperature: 0.5 },
    })
    const cfg = client.dumpConfig()
    expect(cfg.provider).toBe('openai')
    expect(cfg.model).toBe('gpt-test')
    expect(cfg.timeoutSeconds).toBe(30)
    expect(cfg.extras).toMatchObject({
      baseUrl: 'http://localhost:11434/v1',
      temperature: 0.5,
      maxTokens: 4096,
    })
  })
})

describe('OpenAI — headers customization', () => {
  it('passes through extra string headers alongside defaults', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({
      apiKey: 'sk-test',
      fetchImpl: fn,
      headers: { 'http-referer': 'https://my-app.example', 'x-title': 'My App' },
    })
    await collect(client.complete(trivialRequest))
    const sent = calls[0]?.init.headers as Record<string, string>
    expect(sent['http-referer']).toBe('https://my-app.example')
    expect(sent['x-title']).toBe('My App')
    expect(sent['content-type']).toBe('application/json')
    expect(sent.authorization).toBe('Bearer sk-test')
  })

  it('null value DELETES a default header', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({
      apiKey: 'sk-test',
      fetchImpl: fn,
      // Some compat endpoints reject the standard auth header in
      // favor of one they expect (e.g. via a custom proxy header).
      headers: { authorization: null, 'x-my-auth': 'secret' },
    })
    await collect(client.complete(trivialRequest))
    const sent = calls[0]?.init.headers as Record<string, string>
    expect('authorization' in sent).toBe(false)
    expect(sent['x-my-auth']).toBe('secret')
  })

  it('header names are case-insensitive (HTTP semantics)', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({
      apiKey: 'sk-test',
      fetchImpl: fn,
      headers: { Authorization: 'Bearer override-key', 'X-Custom': 'mixed' },
    })
    await collect(client.complete(trivialRequest))
    const sent = calls[0]?.init.headers as Record<string, string>
    // Default lowercased version was overridden, not duplicated.
    expect(sent.authorization).toBe('Bearer override-key')
    expect('Authorization' in sent).toBe(false)
    expect(sent['x-custom']).toBe('mixed')
  })

  it('omitted headers option preserves all defaults (no behavior change)', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new OpenAI({ apiKey: 'sk-test', fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const sent = calls[0]?.init.headers as Record<string, string>
    expect(sent['content-type']).toBe('application/json')
    expect(sent.authorization).toBe('Bearer sk-test')
  })
})
