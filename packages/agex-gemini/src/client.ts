/**
 * Google Gemini client implementing agex-ts's `LLMClient`.
 *
 * Builds the request from `LLMRequest` (system + neutral turns),
 * fires `fetch` against `:streamGenerateContent?alt=sse`, and runs
 * the response through the SSE → stream translator → tool-call
 * parser pipeline to yield `TokenChunk`s.
 *
 * Auth via `x-goog-api-key` header (AI Studio API key). Vertex AI
 * service-account auth is deferred to v2.
 *
 * Defaults:
 *   - `tool_config.function_calling_config.mode = 'ANY'` — equivalent
 *     to Anthropic's `tool_choice: 'any'`. Forces a function call
 *     each turn.
 *   - `thinking_config.include_thoughts = true` — surface Gemini 3
 *     signed thought parts so they round-trip on the next turn.
 *
 * Out of scope (v1):
 *   - Grounding tools (google_search, url_context)
 *   - Vertex AI auth
 *   - Multimodal tool outputs (images flatten to placeholders)
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
  type GeminiContent,
  type GeminiFunctionDeclaration,
  lowerNeutralTurns,
  schemasToGeminiFunctionDeclarations,
} from './adapter'
import { translateGeminiStream } from './stream'

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_MODEL = 'gemini-2.5-flash'
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384
const DEFAULT_TIMEOUT_MS = 90_000
const STREAM_MAX_RETRIES = 2
const RETRY_BACKOFF_MS = 1_000

export interface GeminiOptions {
  /** Model id. Defaults to `gemini-2.5-flash`. Pass e.g.
   *  `gemini-3.1-flash`, `gemini-2.5-pro`, etc. */
  readonly model?: string
  /** AI Studio API key. Sent as `x-goog-api-key` header. */
  readonly apiKey?: string
  /** API base URL. Defaults to
   *  `https://generativelanguage.googleapis.com/v1beta`. Override
   *  for Vertex AI's regional endpoints once that path is supported. */
  readonly baseUrl?: string
  /** Per-request timeout. Defaults to 90s. */
  readonly timeoutMs?: number
  /** Cap on output tokens (`generationConfig.maxOutputTokens`).
   *  Defaults to 16k. */
  readonly maxOutputTokens?: number
  /** Force the model to call a function each turn. Defaults to
   *  `true` (sends `tool_config.function_calling_config.mode =
   *  'ANY'`). Set false to allow text-only turns. */
  readonly forceToolUse?: boolean
  /** Surface Gemini 3 signed thought parts so they round-trip on
   *  subsequent turns. Defaults to `true` (sends
   *  `generationConfig.thinkingConfig.includeThoughts = true`). */
  readonly nativeThinking?: boolean
  /** Extra fields merged into `generationConfig` (e.g.
   *  `temperature`, `topP`, `topK`). Wins over computed defaults. */
  readonly generationConfig?: Readonly<Record<string, unknown>>
  /** Override `fetch` for tests / custom transports. */
  readonly fetchImpl?: typeof fetch
}

export class Gemini implements LLMClient {
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxOutputTokens: number
  private readonly forceToolUse: boolean
  private readonly nativeThinking: boolean
  private readonly generationConfig: Readonly<Record<string, unknown>>
  private readonly fetchImpl: typeof fetch

  constructor(opts: GeminiOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL
    this.apiKey = opts.apiKey ?? ''
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    this.forceToolUse = opts.forceToolUse ?? true
    this.nativeThinking = opts.nativeThinking ?? true
    this.generationConfig = opts.generationConfig ?? {}
    // Bind to globalThis so browsers don't throw "Illegal invocation"
    // — `window.fetch` requires `this === window` and we call it as
    // `this.fetchImpl(...)` from inside the client. Node/Deno don't
    // enforce the check, but the bind is harmless there.
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis)
  }

  // ---------- LLMClient surface ----------

  async *complete(request: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk> {
    const body = this.buildBody(request)
    const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse`
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
      provider: 'gemini',
      model: this.model,
      timeoutSeconds: this.timeoutMs / 1000,
      extras: {
        baseUrl: this.baseUrl,
        maxOutputTokens: this.maxOutputTokens,
        forceToolUse: this.forceToolUse,
        nativeThinking: this.nativeThinking,
        ...this.generationConfig,
      },
    }
  }

  // ---------- Request construction ----------

  private buildBody(request: LLMRequest): Record<string, unknown> {
    const contents: ReadonlyArray<GeminiContent> = lowerNeutralTurns(request.turns)
    const declarations: GeminiFunctionDeclaration[] = schemasToGeminiFunctionDeclarations(
      toolSchemas({ nativeThinking: this.nativeThinking }),
    )
    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: this.maxOutputTokens,
      ...(this.nativeThinking && {
        thinkingConfig: { includeThoughts: true },
      }),
      ...this.generationConfig,
    }
    const body: Record<string, unknown> = {
      systemInstruction: { role: 'user', parts: [{ text: request.system }] },
      contents,
      tools: [{ functionDeclarations: declarations }],
      generationConfig,
    }
    if (this.forceToolUse) {
      body.toolConfig = { functionCallingConfig: { mode: 'ANY' } }
    }
    return body
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (this.apiKey.length > 0) h['x-goog-api-key'] = this.apiKey
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
        `Gemini API error ${response.status} ${response.statusText}: ${text || '(empty body)'}`,
      )
    }
    if (response.body === null) {
      throw new Error('Gemini API returned no response body')
    }

    const usage: UsageHolder = { inputTokens: null, outputTokens: null }
    const sseLines = parseSseEvents(response.body)
    const events = sseLinesToEventDicts(sseLines)
    const toolCallEvents = translateGeminiStream(events, usage)

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
