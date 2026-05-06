/**
 * OpenAI Chat Completions client implementing agex-ts's `LLMClient`.
 *
 * Builds the request from `LLMRequest` (system + neutral turns),
 * fires `fetch` with `stream: true`, and runs the response through
 * the SSE → stream translator → tool-call parser pipeline to yield
 * `TokenChunk`s.
 *
 * `baseUrl` override is the entry point for OpenAI-compatible
 * servers (ollama, vLLM, LM Studio, OpenRouter, Together, etc.).
 * Auth is `Authorization: Bearer <key>`; many local servers accept
 * any non-empty key (we send 'sk-no-key' if none provided so the
 * header is well-formed).
 *
 * Defaults set: `tool_choice: 'required'` so the model emits at
 * least one tool call per turn (parallel to Anthropic's
 * `tool_choice: 'any'`); `stream_options: { include_usage: true }`
 * so the trailing chunk carries token totals.
 *
 * Out of scope (v1):
 *   - Responses API (gpt-5 / o-series). Use Chat Completions models.
 *   - OpenRouter `reasoning_details` round-trip.
 */

import {
  type UsageHolder,
  isTransientNetworkError,
  parseSseEvents,
  parseToolEvents,
  safeReadText,
  sleep,
  sseLinesToEventDicts,
} from 'agex-ts/providers'
import { toolSchemas } from 'agex-ts/render'
import type { LLMClient, LLMConfig, LLMRequest, TokenChunk } from 'agex-ts/types'
import {
  type OpenAIMessage,
  type OpenAITool,
  lowerNeutralTurns,
  schemasToOpenAITools,
} from './adapter'
import { translateOpenAIStream } from './stream'

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_MODEL = 'gpt-4o-mini'
const DEFAULT_MAX_TOKENS = 16_384
const DEFAULT_TIMEOUT_MS = 90_000
const STREAM_MAX_RETRIES = 2
const RETRY_BACKOFF_MS = 1_000

export interface OpenAIOptions {
  /** Model id. Defaults to `gpt-4o-mini`. For OpenAI-compatible
   *  servers (ollama, vLLM, etc.) pass the model name they expose. */
  readonly model?: string
  /** API key. Sent as `Authorization: Bearer <key>`. Required for
   *  the public OpenAI endpoint; may be unused/dummy for local
   *  servers (we always send a header so picky proxies don't 401). */
  readonly apiKey?: string
  /** API base URL. Defaults to `https://api.openai.com/v1`. Set
   *  this to point at any OpenAI-compatible server:
   *    - ollama: `http://localhost:11434/v1`
   *    - vLLM:   `http://localhost:8000/v1`
   *    - LM Studio: `http://localhost:1234/v1`
   *    - OpenRouter: `https://openrouter.ai/api/v1`
   *    - Together: `https://api.together.xyz/v1` */
  readonly baseUrl?: string
  /** Per-request timeout. Defaults to 90s. */
  readonly timeoutMs?: number
  /** Cap on output tokens. Defaults to 16k. */
  readonly maxTokens?: number
  /** Force the model to emit a tool call each turn. Defaults to
   *  `true` (sends `tool_choice: 'required'`). Set false to allow
   *  text-only turns — useful with models that don't reliably
   *  follow `required` (notably some local models). */
  readonly forceToolUse?: boolean
  /** Extra fields merged into the request body (e.g. `temperature`,
   *  `top_p`, `seed`, `response_format`). Wins over computed
   *  defaults. */
  readonly extras?: Readonly<Record<string, unknown>>
  /** Override `fetch` for tests / custom transports. */
  readonly fetchImpl?: typeof fetch
}

export class OpenAI implements LLMClient {
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxTokens: number
  private readonly forceToolUse: boolean
  private readonly extras: Readonly<Record<string, unknown>>
  private readonly fetchImpl: typeof fetch

  constructor(opts: OpenAIOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL
    this.apiKey = opts.apiKey ?? ''
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
    this.forceToolUse = opts.forceToolUse ?? true
    this.extras = opts.extras ?? {}
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  // ---------- LLMClient surface ----------

  async *complete(request: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk> {
    const body = this.buildBody(request)
    const url = `${this.baseUrl}/chat/completions`
    const headers = this.buildHeaders()
    let lastError: unknown
    for (let attempt = 0; attempt < STREAM_MAX_RETRIES; attempt++) {
      try {
        yield* this.streamOnce(url, body, headers, signal)
        return
      } catch (err) {
        lastError = err
        if (signal?.aborted) throw err
        if (!isTransientNetworkError(err) || attempt + 1 >= STREAM_MAX_RETRIES) throw err
        await sleep(RETRY_BACKOFF_MS, signal)
      }
    }
    throw lastError
  }

  dumpConfig(): LLMConfig {
    return {
      provider: 'openai',
      model: this.model,
      timeoutSeconds: this.timeoutMs / 1000,
      extras: {
        baseUrl: this.baseUrl,
        maxTokens: this.maxTokens,
        forceToolUse: this.forceToolUse,
        ...this.extras,
      },
    }
  }

  // ---------- Request construction ----------

  private buildBody(request: LLMRequest): Record<string, unknown> {
    const lowered: ReadonlyArray<OpenAIMessage> = lowerNeutralTurns(request.turns)
    const messages: OpenAIMessage[] = [{ role: 'system', content: request.system }, ...lowered]
    // Native thinking is provider-specific; we don't strip the
    // `thinking` schema field for OpenAI since most OpenAI-hosted
    // models don't have a separate channel for it. Models that
    // *do* (gpt-5 / o-series) use the Responses API, which is
    // out of scope for v1.
    const tools: OpenAITool[] = schemasToOpenAITools(toolSchemas())
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      tools,
      // gpt-5* and o-series reasoning models reject `max_tokens` and
      // require `max_completion_tokens` instead (it disambiguates
      // visible-output tokens from internal reasoning tokens). Older
      // models accept either; we send the right one based on model
      // name. Local servers (ollama, vLLM, etc.) using older model
      // names get `max_tokens` and stay happy.
      [tokenLimitField(this.model)]: this.maxTokens,
      stream: true,
      // include_usage = true makes the final chunk carry the
      // prompt/completion token counts so the chaptering trigger
      // works correctly.
      stream_options: { include_usage: true },
    }
    if (this.forceToolUse) {
      body.tool_choice = 'required'
    }
    Object.assign(body, this.extras)
    return body
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      // Send a header even when no key was provided so picky
      // local-model proxies that require *some* auth header don't
      // 401. The string is meaningless to them.
      authorization: `Bearer ${this.apiKey || 'sk-no-key'}`,
    }
    return h
  }

  // ---------- Streaming ----------

  private async *streamOnce(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
  ): AsyncIterable<TokenChunk> {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (signal !== undefined) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutHandle)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    if (!response.ok) {
      const text = await safeReadText(response)
      throw new Error(
        `OpenAI API error ${response.status} ${response.statusText}: ${text || '(empty body)'}`,
      )
    }
    if (response.body === null) {
      throw new Error('OpenAI API returned no response body')
    }

    const usage: UsageHolder = { inputTokens: null, outputTokens: null }
    const sseLines = parseSseEvents(response.body)
    const events = sseLinesToEventDicts(sseLines)
    const toolCallEvents = translateOpenAIStream(events, usage)

    let lastIndex = -1
    for await (const tok of parseToolEvents(toolCallEvents)) {
      if (tok.type === 'emission' && tok.emissionIndex > lastIndex) {
        lastIndex = tok.emissionIndex
      }
      yield tok
    }

    yield {
      type: 'emission',
      content: '',
      done: true,
      emissionIndex: lastIndex + 1,
      ...(usage.inputTokens !== null && { inputTokens: usage.inputTokens }),
      ...(usage.outputTokens !== null && { outputTokens: usage.outputTokens }),
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI-specific helpers
// ---------------------------------------------------------------------------

/** OpenAI's reasoning models (gpt-5, o-series) require
 *  `max_completion_tokens` instead of `max_tokens`. Detect on the
 *  model name prefix; everything else (gpt-4*, claude-via-OR, local
 *  models) gets the legacy `max_tokens`. */
function tokenLimitField(model: string): 'max_tokens' | 'max_completion_tokens' {
  if (/^(gpt-5|o[1-9])/.test(model)) return 'max_completion_tokens'
  return 'max_tokens'
}
