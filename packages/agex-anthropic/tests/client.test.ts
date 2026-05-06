import type { Emission, LLMRequest, TokenChunk } from 'agex-ts/types'
import { describe, expect, it } from 'vitest'
import { Anthropic } from '../src/client'

const enc = new TextEncoder()

/** Build a ReadableStream that yields a sequence of SSE event dicts
 *  encoded as `data: <json>\n` lines. The final `data: [DONE]` line
 *  is appended automatically. */
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
    type: 'message_start',
    message: { usage: { input_tokens: 50, output_tokens: 0 } },
  },
  {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: 'tu_1', name: 'ts_action', input: {} },
  },
  {
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"title":"x","code":"taskSuccess(1)"}',
    },
  },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: {}, usage: { output_tokens: 10 } },
  { type: 'message_stop' },
]

describe('Anthropic — request body shape', () => {
  it('sends model, system (with cache_control), tools, messages, stream:true', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Anthropic({ model: 'claude-test', apiKey: 'k', fetchImpl: fn })
    await collect(client.complete(trivialRequest))

    expect(calls.length).toBe(1)
    const call = calls[0]
    if (call === undefined) throw new Error('expected one call')
    expect(call.url).toBe('https://api.anthropic.com/v1/messages')
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('k')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')

    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>
    expect(body.model).toBe('claude-test')
    expect(body.stream).toBe(true)
    const system = body.system as ReadonlyArray<Record<string, unknown>>
    expect(system[0]?.text).toBe('system primer')
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    const tools = body.tools as ReadonlyArray<{ name: string; input_schema: unknown }>
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['edit_file', 'terminal_action', 'ts_action', 'write_file'].sort(),
    )
  })

  it('extended thinking on by default; tool_choice omitted (incompatible)', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Anthropic({ apiKey: 'k', fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 })
    expect(body.tool_choice).toBeUndefined()
    // ts_action schema strips thinking when nativeThinking=true
    const tools = body.tools as ReadonlyArray<{
      name: string
      input_schema: { properties: Record<string, unknown> }
    }>
    const tsTool = tools.find((t) => t.name === 'ts_action')
    expect(Object.keys(tsTool?.input_schema.properties ?? {})).not.toContain('thinking')
  })

  it('non-native mode forces tool_choice: any and keeps the thinking schema field', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Anthropic({ apiKey: 'k', nativeThinking: false, fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.thinking).toBeUndefined()
    expect(body.tool_choice).toEqual({ type: 'any' })
    const tools = body.tools as ReadonlyArray<{
      name: string
      input_schema: { properties: Record<string, unknown> }
    }>
    const tsTool = tools.find((t) => t.name === 'ts_action')
    expect(Object.keys(tsTool?.input_schema.properties ?? {})).toContain('thinking')
  })

  it('caller extras override computed defaults', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Anthropic({
      apiKey: 'k',
      maxTokens: 4096,
      extras: { temperature: 0.2, max_tokens: 2048 },
      fetchImpl: fn,
    })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.temperature).toBe(0.2)
    expect(body.max_tokens).toBe(2048) // extras win over the constructor default
  })

  it('opt-in browser-direct-access header', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Anthropic({ apiKey: 'k', browserDirectAccess: true, fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true')
  })
})

describe('Anthropic — response streaming', () => {
  it('builds the right Emission and surfaces token usage on the trailing chunk', async () => {
    const { fn } = recordingFetch(happyPathEvents)
    const client = new Anthropic({ apiKey: 'k', fetchImpl: fn })
    const tokens = await collect(client.complete(trivialRequest))
    const emissions = emissionsOf(tokens)
    expect(emissions).toEqual([{ type: 'ts', code: 'taskSuccess(1)', title: 'x' }])
    // The trailing chunk carries the totals (50 input, 10 output).
    const trailer = tokens.at(-1)
    expect(trailer?.inputTokens).toBe(50)
    expect(trailer?.outputTokens).toBe(10)
  })

  it('surfaces a non-2xx response as an Error', async () => {
    const fn: typeof fetch = async () =>
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })
    const client = new Anthropic({ apiKey: 'k', fetchImpl: fn })
    await expect(collect(client.complete(trivialRequest))).rejects.toThrow(/429/)
  })

  it('surfaces an Anthropic stream error event', async () => {
    const errorEvents: Record<string, unknown>[] = [
      { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'error', error: { type: 'overloaded_error', message: 'Try again later' } },
    ]
    const { fn } = recordingFetch(errorEvents)
    const client = new Anthropic({ apiKey: 'k', fetchImpl: fn })
    await expect(collect(client.complete(trivialRequest))).rejects.toThrow(/Try again/)
  })
})

describe('Anthropic — retry', () => {
  it('retries once on a transient TypeError and succeeds on the second try', async () => {
    let attempt = 0
    const fn: typeof fetch = async () => {
      attempt++
      if (attempt === 1) throw new TypeError('network error')
      return new Response(sseStream(happyPathEvents), { status: 200 })
    }
    const client = new Anthropic({ apiKey: 'k', fetchImpl: fn })
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
    const client = new Anthropic({ apiKey: 'k', fetchImpl: fn })
    await expect(collect(client.complete(trivialRequest))).rejects.toThrow(/400/)
    expect(attempt).toBe(1)
  })

  it('does not retry when AbortSignal is aborted', async () => {
    let attempt = 0
    const fn: typeof fetch = async () => {
      attempt++
      throw new TypeError('network')
    }
    const ac = new AbortController()
    ac.abort()
    const client = new Anthropic({ apiKey: 'k', fetchImpl: fn })
    await expect(collect(client.complete(trivialRequest, ac.signal))).rejects.toThrow()
    expect(attempt).toBe(1)
  })
})

describe('Anthropic — dumpConfig', () => {
  it('returns provider/model/timeout plus extras snapshot', () => {
    const client = new Anthropic({
      model: 'claude-test',
      apiKey: 'k',
      timeoutMs: 30_000,
      maxTokens: 4096,
      extras: { temperature: 0.5 },
    })
    const cfg = client.dumpConfig()
    expect(cfg.provider).toBe('anthropic')
    expect(cfg.model).toBe('claude-test')
    expect(cfg.timeoutSeconds).toBe(30)
    expect(cfg.extras).toMatchObject({ temperature: 0.5, maxTokens: 4096 })
  })
})
