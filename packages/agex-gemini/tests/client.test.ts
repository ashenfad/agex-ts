import type { Emission, LLMRequest, TokenChunk } from 'agex-ts/types'
import { describe, expect, it } from 'vitest'
import { Gemini } from '../src/client'

const enc = new TextEncoder()

function sseStream(events: ReadonlyArray<Record<string, unknown>>): ReadableStream<Uint8Array> {
  // Gemini's stream is `data: <json>\n\n` (two newlines per event).
  // No `[DONE]` marker — the stream just closes.
  const lines = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
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
    candidates: [
      {
        content: {
          parts: [
            {
              functionCall: {
                id: 'tu_1',
                name: 'ts_action',
                args: { code: 'taskSuccess(1)', title: 'x' },
              },
              thoughtSignature: 'b3BhcXVlLXNpZw==', // base64('opaque-sig')
            },
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 },
  },
]

describe('Gemini — request URL + headers', () => {
  it('hits :streamGenerateContent?alt=sse with the model in the URL path', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({ model: 'gemini-3.1-flash', apiKey: 'k', fetchImpl: fn })
    await collect(client.complete(trivialRequest))

    expect(calls.length).toBe(1)
    const call = calls[0]
    if (call === undefined) throw new Error('expected one call')
    expect(call.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash:streamGenerateContent?alt=sse',
    )
    expect(call.init.method).toBe('POST')
    const headers = call.init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBe('k')
    expect(headers['content-type']).toBe('application/json')
  })

  it('omits the api-key header when no key is set', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({ model: 'gemini-3.1-flash', fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['x-goog-api-key']).toBeUndefined()
  })

  it('strips a trailing slash from baseUrl', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({
      apiKey: 'k',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/',
      fetchImpl: fn,
    })
    await collect(client.complete(trivialRequest))
    expect(calls[0]?.url).toMatch(
      /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\//,
    )
  })
})

describe('Gemini — request body shape', () => {
  it('sends systemInstruction + contents + tools (functionDeclarations) + generationConfig', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({ apiKey: 'k', fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    const sys = body.systemInstruction as { parts: ReadonlyArray<{ text: string }> }
    expect(sys.parts[0]?.text).toBe('system primer')
    const contents = body.contents as ReadonlyArray<Record<string, unknown>>
    expect(contents[0]?.role).toBe('user')
    const tools = body.tools as ReadonlyArray<{
      functionDeclarations: ReadonlyArray<{ name: string }>
    }>
    expect(tools[0]?.functionDeclarations.map((d) => d.name).sort()).toEqual(
      ['edit_file', 'terminal_action', 'ts_action', 'write_file'].sort(),
    )
  })

  it("defaults toolConfig.functionCallingConfig.mode to 'ANY' (force a tool call)", async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({ apiKey: 'k', fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY' } })
  })

  it('omits toolConfig when forceToolUse is false', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({ apiKey: 'k', forceToolUse: false, fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(body.toolConfig).toBeUndefined()
  })

  it('enables thinkingConfig.includeThoughts by default (Gemini 3 thought parts)', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({ apiKey: 'k', fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    const cfg = body.generationConfig as Record<string, unknown>
    expect(cfg.thinkingConfig).toEqual({ includeThoughts: true })
  })

  it('caller generationConfig overrides defaults', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({
      apiKey: 'k',
      maxOutputTokens: 4096,
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      fetchImpl: fn,
    })
    await collect(client.complete(trivialRequest))
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    const cfg = body.generationConfig as Record<string, unknown>
    expect(cfg.temperature).toBe(0.2)
    expect(cfg.maxOutputTokens).toBe(2048)
  })
})

describe('Gemini — response streaming', () => {
  it('builds the right Emission with signature attached and surfaces token usage', async () => {
    const { fn } = recordingFetch(happyPathEvents)
    const client = new Gemini({ apiKey: 'k', fetchImpl: fn })
    const tokens = await collect(client.complete(trivialRequest))
    const emissions = emissionsOf(tokens)
    // The function_call becomes a TsEmission; the thoughtSignature
    // rides directly on the emission so the renderer can place it
    // as a sibling of `functionCall` on the same Part on replay.
    const ts = emissions.find((e) => e.type === 'ts')
    if (ts?.type !== 'ts') throw new Error('expected ts emission')
    expect(ts.code).toBe('taskSuccess(1)')
    expect(ts.title).toBe('x')
    expect(ts.signature).toBeDefined()
    expect(new TextDecoder().decode(ts.signature)).toBe('opaque-sig')
    const trailer = tokens.at(-1)
    expect(trailer?.inputTokens).toBe(50)
    expect(trailer?.outputTokens).toBe(10)
  })

  it('surfaces a non-2xx response as an Error with the body', async () => {
    const fn: typeof fetch = async () =>
      new Response('quota exceeded', { status: 429, statusText: 'Too Many Requests' })
    const client = new Gemini({ apiKey: 'k', fetchImpl: fn })
    await expect(collect(client.complete(trivialRequest))).rejects.toThrow(/429/)
  })
})

describe('Gemini — retry', () => {
  it('retries once on a transient TypeError and succeeds on the second try', async () => {
    let attempt = 0
    const fn: typeof fetch = async () => {
      attempt++
      if (attempt === 1) throw new TypeError('network error')
      return new Response(sseStream(happyPathEvents), { status: 200 })
    }
    const client = new Gemini({ apiKey: 'k', fetchImpl: fn })
    const tokens = await collect(client.complete(trivialRequest))
    expect(attempt).toBe(2)
    expect(emissionsOf(tokens).find((e) => e.type === 'ts')).toBeDefined()
  })

  it('does not retry on a non-network error (e.g. 400)', async () => {
    let attempt = 0
    const fn: typeof fetch = async () => {
      attempt++
      return new Response('bad', { status: 400, statusText: 'Bad Request' })
    }
    const client = new Gemini({ apiKey: 'k', fetchImpl: fn })
    await expect(collect(client.complete(trivialRequest))).rejects.toThrow(/400/)
    expect(attempt).toBe(1)
  })
})

describe('Gemini — dumpConfig', () => {
  it('returns provider/model/timeout plus extras snapshot', () => {
    const client = new Gemini({
      model: 'gemini-3.1-flash',
      apiKey: 'k',
      timeoutMs: 30_000,
      maxOutputTokens: 4096,
      generationConfig: { temperature: 0.5 },
    })
    const cfg = client.dumpConfig()
    expect(cfg.provider).toBe('gemini')
    expect(cfg.model).toBe('gemini-3.1-flash')
    expect(cfg.timeoutSeconds).toBe(30)
    expect(cfg.extras).toMatchObject({ temperature: 0.5, maxOutputTokens: 4096 })
  })
})

describe('Gemini — headers customization', () => {
  it('passes through extra string headers alongside defaults', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({
      apiKey: 'k',
      fetchImpl: fn,
      headers: { 'x-custom': 'value' },
    })
    await collect(client.complete(trivialRequest))
    const sent = calls[0]?.init.headers as Record<string, string>
    expect(sent['x-custom']).toBe('value')
    expect(sent['content-type']).toBe('application/json')
    expect(sent['x-goog-api-key']).toBe('k')
  })

  it('null value DELETES a default header', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({
      apiKey: 'k',
      fetchImpl: fn,
      // Compat endpoint that uses a different auth header.
      headers: { 'x-goog-api-key': null, authorization: 'Bearer my-token' },
    })
    await collect(client.complete(trivialRequest))
    const sent = calls[0]?.init.headers as Record<string, string>
    expect('x-goog-api-key' in sent).toBe(false)
    expect(sent.authorization).toBe('Bearer my-token')
  })

  it('header names are case-insensitive (HTTP semantics)', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({
      apiKey: 'k',
      fetchImpl: fn,
      headers: { 'X-Goog-Api-Key': 'override-key', 'X-Custom': 'mixed' },
    })
    await collect(client.complete(trivialRequest))
    const sent = calls[0]?.init.headers as Record<string, string>
    expect(sent['x-goog-api-key']).toBe('override-key')
    expect('X-Goog-Api-Key' in sent).toBe(false)
    expect(sent['x-custom']).toBe('mixed')
  })

  it('omitted headers option preserves all defaults (no behavior change)', async () => {
    const { fn, calls } = recordingFetch(happyPathEvents)
    const client = new Gemini({ apiKey: 'k', fetchImpl: fn })
    await collect(client.complete(trivialRequest))
    const sent = calls[0]?.init.headers as Record<string, string>
    expect(sent['content-type']).toBe('application/json')
    expect(sent['x-goog-api-key']).toBe('k')
  })
})
