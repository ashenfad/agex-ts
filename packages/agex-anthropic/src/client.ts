/**
 * Anthropic Messages API client implementing agex-ts's `LLMClient`.
 *
 * Builds the request from the agex `LLMRequest` (system + neutral
 * turns), applies prompt caching breakpoints, defaults extended
 * thinking on and `tool_choice` to `any`, fires `fetch` with
 * `stream: true`, and runs the response through the SSE → stream
 * translator → tool-call parser pipeline to yield `TokenChunk`s.
 *
 * No SDK dependency — `fetch` only, runs anywhere it's available
 * (Node 20+, browsers, edge runtimes).
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
  type AnthropicMessage,
  type AnthropicTool,
  applyCacheControl,
  lowerNeutralTurns,
  schemasToAnthropicTools,
} from './adapter'
import { translateAnthropicStream } from './stream'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'
const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_MAX_TOKENS = 16_384
const DEFAULT_THINKING_BUDGET = 2_048
const DEFAULT_TIMEOUT_MS = 90_000
const STREAM_MAX_RETRIES = 2
const RETRY_BACKOFF_MS = 1_000
const CACHE_TTL = '1h' as const

export interface AnthropicOptions {
  /** Model id. Defaults to `claude-sonnet-4-5`. */
  readonly model?: string
  /** API key. Sent as `x-api-key`. Required for the public endpoint;
   *  optional when paired with a custom `fetchImpl` that injects auth
   *  on the way out (e.g. a proxy bridge). */
  readonly apiKey?: string
  /** API base URL. Defaults to `https://api.anthropic.com/v1`. */
  readonly baseUrl?: string
  /** Per-request timeout. Defaults to 90s. */
  readonly timeoutMs?: number
  /** Enable Claude's extended thinking (Claude 4+). When on, the
   *  model emits native thinking blocks (with replayable signatures)
   *  and the action tool schemas drop the `thinking` parameter.
   *  Defaults to `true`. */
  readonly nativeThinking?: boolean
  /** Token budget for extended thinking. Anthropic requires >= 1024.
   *  Ignored when `nativeThinking` is false. Defaults to 2048. */
  readonly thinkingBudget?: number
  /** Cap on output tokens. Defaults to 16k. */
  readonly maxTokens?: number
  /** Extra fields merged into the request body (e.g. `temperature`,
   *  `top_p`, `top_k`). Wins over computed defaults. */
  readonly extras?: Readonly<Record<string, unknown>>
  /** Browser-flavored opt-in: send the
   *  `anthropic-dangerous-direct-browser-access: true` header so the
   *  request is allowed to come straight from a browser context.
   *  Anthropic only honors this in trusted browser contexts. */
  readonly browserDirectAccess?: boolean
  /** Override `fetch` for tests / custom transports. Defaults to the
   *  global `fetch`. */
  readonly fetchImpl?: typeof fetch
}

export class Anthropic implements LLMClient {
  readonly model: string
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly nativeThinking: boolean
  private readonly thinkingBudget: number
  private readonly maxTokens: number
  private readonly extras: Readonly<Record<string, unknown>>
  private readonly browserDirectAccess: boolean
  private readonly fetchImpl: typeof fetch

  constructor(opts: AnthropicOptions = {}) {
    this.model = opts.model ?? DEFAULT_MODEL
    this.apiKey = opts.apiKey ?? ''
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.nativeThinking = opts.nativeThinking ?? true
    this.thinkingBudget = opts.thinkingBudget ?? DEFAULT_THINKING_BUDGET
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS
    this.extras = opts.extras ?? {}
    this.browserDirectAccess = opts.browserDirectAccess ?? false
    // Bind to globalThis so browsers don't throw "Illegal invocation"
    // — `window.fetch` requires `this === window` and we call it as
    // `this.fetchImpl(...)` from inside the client. Node/Deno don't
    // enforce the check, but the bind is harmless there.
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis)
  }

  // ---------- LLMClient surface ----------

  async *complete(request: LLMRequest, signal?: AbortSignal): AsyncIterable<TokenChunk> {
    const body = this.buildBody(request)
    const url = `${this.baseUrl}/messages`
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
      provider: 'anthropic',
      model: this.model,
      timeoutSeconds: this.timeoutMs / 1000,
      extras: {
        baseUrl: this.baseUrl,
        nativeThinking: this.nativeThinking,
        thinkingBudget: this.thinkingBudget,
        maxTokens: this.maxTokens,
        ...this.extras,
      },
    }
  }

  // ---------- Request construction ----------

  private buildBody(request: LLMRequest): Record<string, unknown> {
    const lowered = lowerNeutralTurns(request.turns)
    // Cache the second-to-last conversation message (the last completed
    // turn). The last message is always new per-request, so caching it
    // never hits.
    const cacheIdx = lowered.length - 2
    const messages: ReadonlyArray<AnthropicMessage> = applyCacheControl(
      lowered,
      cacheIdx,
      CACHE_TTL,
    )
    const system = [
      {
        type: 'text',
        text: request.system,
        cache_control: { type: 'ephemeral', ttl: CACHE_TTL },
      },
    ]
    const tools: AnthropicTool[] = schemasToAnthropicTools(
      toolSchemas({ nativeThinking: this.nativeThinking }),
    )
    const body: Record<string, unknown> = {
      model: this.model,
      system,
      messages,
      tools,
      max_tokens: this.maxTokens,
      stream: true,
    }
    if (this.nativeThinking) {
      body.thinking = { type: 'enabled', budget_tokens: this.thinkingBudget }
    } else {
      // tool_choice:any forces a tool call each turn. Anthropic
      // rejects it when extended thinking is enabled, so we only
      // apply it in the non-native path.
      body.tool_choice = { type: 'any' }
    }
    // Caller extras win over computed defaults.
    Object.assign(body, this.extras)
    return body
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    }
    if (this.apiKey.length > 0) h['x-api-key'] = this.apiKey
    if (this.browserDirectAccess) h['anthropic-dangerous-direct-browser-access'] = 'true'
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
        `Anthropic API error ${response.status} ${response.statusText}: ${text || '(empty body)'}`,
      )
    }
    if (response.body === null) {
      throw new Error('Anthropic API returned no response body')
    }

    const usage: UsageHolder = { inputTokens: null, outputTokens: null }
    const sseLines = parseSseEvents(response.body)
    const events = sseLinesToEventDicts(sseLines)
    const toolCallEvents = translateAnthropicStream(events, usage)

    let lastIndex = -1
    for await (const tok of parseToolEvents(toolCallEvents)) {
      if (tok.type === 'emission' && tok.emissionIndex > lastIndex) {
        lastIndex = tok.emissionIndex
      }
      yield tok
    }

    // Final marker — token totals on a no-op emission slot. The agent
    // task loop reads inputTokens off the latest chunk that carries
    // them; emitting a clean trailer (without an emission) signals
    // the LLM call is over.
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
