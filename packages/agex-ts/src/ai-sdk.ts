/**
 * Any AI SDK model as a {@link Provider}: the provider spec's
 * `LanguageModelV4.doStream` driven directly, without the AI SDK's
 * core, as Python agex drives pydantic-ai's `direct`.
 *
 * The embedder installs and imports the provider it uses
 * (`createAnthropic(...)('claude-...')` and the like) and hands the model
 * to `new Agent({ model })`; agex-ts depends on the spec alone. The run
 * record is mapped to the spec's prompt and the stream back into the
 * record at this edge, nowhere else:
 *
 * - **Provider metadata rides each part** (a reasoning signature, an
 *   encrypted reasoning item, an item id, a signature on a tool call):
 *   kept in the part's `details`, sent back as its provider options, and
 *   only to the provider that wrote it. Another provider's reasoning is
 *   left out of a request.
 * - **Thinking** (`Settings.thinking`) is the spec's reasoning effort,
 *   which each provider resolves for each model, plus what a provider
 *   needs besides (OpenRouter's own option, Gemini's thoughts shown).
 *   `Settings.extra` is the provider options themselves, by provider
 *   (`{anthropic: {cacheControl: {type: 'ephemeral'}}}`), merged over
 *   that.
 * - **Cancellation** is the spec's `abortSignal`.
 */

import {
  APICallError,
  type JSONValue,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4FunctionTool,
  type LanguageModelV4Message,
  type LanguageModelV4Prompt,
  type LanguageModelV4StreamPart,
  type LanguageModelV4ToolResultOutput,
  type LanguageModelV4Usage,
  type SharedV4ProviderOptions,
} from '@ai-sdk/provider'
import type { Effort, Provider, ProviderEvent, Settings, StreamOptions, ToolSpec } from './provider'
import {
  type Details,
  type Message,
  type Part,
  type Text,
  type Thinking,
  type Usage,
  messageText,
  newId,
} from './record'

/** Whether `value` is an AI SDK language model (spec v4). */
export function isLanguageModel(value: unknown): value is LanguageModelV4 {
  const v = value as Partial<LanguageModelV4> | null
  return (
    typeof v === 'object' &&
    v !== null &&
    v.specificationVersion === 'v4' &&
    typeof v.doStream === 'function'
  )
}

/** HTTP statuses a provider may get past on the next request. */
export const TRANSIENT_STATUS: ReadonlySet<number> = new Set([408, 409, 425, 429])

/** How OpenRouter words an error it passes on from the upstream provider. */
export const RELAYED = 'Provider returned error'

/** A part streamed in deltas. */
type Streamed = Text | Thinking

/** An AI SDK model, driven as agex drives a provider. */
export class AiSdkProvider implements Provider {
  readonly model: LanguageModelV4
  /** The key its options and metadata go under: `anthropic` for
   *  `anthropic.messages`, and so on. */
  readonly key: string
  readonly name: string

  constructor(model: LanguageModelV4, opts: { name?: string } = {}) {
    this.model = model
    this.key = model.provider.split('.')[0] as string
    this.name = opts.name ?? `${this.key}:${model.modelId}`
  }

  toString(): string {
    return `<AiSdkProvider ${this.name}>`
  }

  async *stream(
    messages: readonly Message[],
    tools: readonly ToolSpec[],
    settings: Settings,
    opts: StreamOptions = {},
  ): AsyncIterable<ProviderEvent> {
    const call: LanguageModelV4CallOptions = {
      prompt: toPrompt(messages, this.key),
      ...(tools.length > 0 && { tools: tools.map(toTool) }),
      ...(settings.maxTokens !== undefined && { maxOutputTokens: settings.maxTokens }),
      ...(settings.temperature !== undefined && { temperature: settings.temperature }),
      ...(settings.thinking !== undefined && { reasoning: reasoningOf(settings.thinking) }),
      providerOptions: merge(thinkingOptions(this.key, settings.thinking), settings.extra ?? {}),
      ...(opts.signal !== undefined && { abortSignal: opts.signal }),
    }
    const { stream } = await this.model.doStream(call)
    const parts: Part[] = []
    // a text or reasoning part being streamed, by the stream's id, and
    // where it sits among the reply's parts (the order it began in)
    const open = new Map<string, number>()
    let usage: Usage | null = null
    let modelId: string = this.model.modelId
    const reader = stream.getReader()
    let drained = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          drained = true
          break
        }
        const part = value as LanguageModelV4StreamPart
        switch (part.type) {
          case 'text-start':
          case 'reasoning-start': {
            open.set(part.id, parts.length)
            parts.push(
              part.type === 'text-start'
                ? {
                    kind: 'text',
                    text: '',
                    provider: this.key,
                    details: detailsOf(part.providerMetadata),
                  }
                : {
                    kind: 'thinking',
                    text: '',
                    provider: this.key,
                    details: detailsOf(part.providerMetadata),
                  },
            )
            break
          }
          case 'text-delta':
          case 'reasoning-delta': {
            const at = open.get(part.id)
            if (at === undefined) break
            const current = parts[at] as Streamed
            parts[at] = {
              ...current,
              text: current.text + part.delta,
              details: mergeDetails(current.details, part.providerMetadata),
            }
            if (part.delta !== '') {
              yield part.type === 'text-delta'
                ? { kind: 'TextDelta', text: part.delta }
                : { kind: 'ThinkingDelta', text: part.delta }
            }
            break
          }
          case 'text-end':
          case 'reasoning-end': {
            const at = open.get(part.id)
            if (at === undefined) break
            const current = parts[at] as Streamed
            parts[at] = {
              ...current,
              details: mergeDetails(current.details, part.providerMetadata),
            }
            open.delete(part.id)
            break
          }
          case 'tool-call':
            // a tool the provider ran itself (a hosted search) isn't one
            // of the workspace's, and its result stays on the provider's side
            if (part.providerExecuted === true) break
            parts.push({
              kind: 'tool_call',
              callId: part.toolCallId,
              name: part.toolName,
              args: argsOf(part.input),
              provider: this.key,
              details: detailsOf(part.providerMetadata),
            })
            break
          case 'response-metadata':
            if (part.modelId !== undefined) modelId = part.modelId
            break
          case 'finish':
            usage = usageOf(part.usage)
            break
          case 'error':
            throw part.error
          default:
            break
        }
      }
    } finally {
      // left early (an error, or the reader stopped): close the response
      if (!drained) await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    yield {
      kind: 'Reply',
      message: {
        id: newId(),
        role: 'assistant',
        // an empty text part says nothing, and some providers refuse one
        parts: parts.filter((p) => !(p.kind === 'text' && p.text === '')),
        model: modelId,
        provider: this.key,
        usage,
      },
    }
  }

  /**
   * An error the provider may get past: a timeout, conflict or rate
   * limit (408, 409, 425, 429), any server-side error (5xx, 529
   * included), or a provider that couldn't be reached. Through
   * OpenRouter, an error relayed from the upstream provider is
   * transient whatever its status: the next request may route
   * elsewhere. Anything else (a refused request, a content filter) is
   * not, and nor is a cancel.
   */
  transient(error: unknown): boolean {
    if (isAbort(error)) return false
    if (APICallError.isInstance(error)) {
      if (this.key === 'openrouter' && relayed(error)) return true
      const code = error.statusCode
      return code !== undefined ? TRANSIENT_STATUS.has(code) || code >= 500 : error.isRetryable
    }
    return unreachable(error)
  }

  /** An HTTP error in words a person reads: refused or failed, its
   *  status, and the provider's own message. Null for anything else. */
  describe(error: unknown): string | null {
    if (!APICallError.isInstance(error)) return null
    const detail = bodyMessage(error.responseBody) ?? error.message
    const verdict = this.transient(error) ? 'failed' : 'refused the request'
    return `the model provider ${verdict} (${error.statusCode ?? 'no status'}): ${detail}`
  }
}

/** An AI SDK model as a provider. */
export function aiSdk(model: LanguageModelV4, opts: { name?: string } = {}): AiSdkProvider {
  return new AiSdkProvider(model, opts)
}

// ---------------------------------------------------------------------------
// The record, to the spec's prompt
// ---------------------------------------------------------------------------

/** The run record's messages as the spec's prompt, for the provider
 *  whose options go under `key`. */
export function toPrompt(messages: readonly Message[], key: string): LanguageModelV4Prompt {
  const prompt: LanguageModelV4Message[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        prompt.push({ role: 'system', content: messageText(message) })
        break
      case 'user': {
        const content = message.parts.flatMap((p) =>
          p.kind === 'text' ? [{ type: 'text' as const, text: p.text }] : [],
        )
        if (content.length > 0) prompt.push({ role: 'user', content })
        break
      }
      case 'assistant': {
        const content = message.parts.flatMap((p) => assistantPart(p, key))
        if (content.length > 0) prompt.push({ role: 'assistant', content })
        break
      }
      case 'tool': {
        const content = message.parts.flatMap((p) =>
          p.kind === 'tool_result'
            ? [
                {
                  type: 'tool-result' as const,
                  toolCallId: p.callId,
                  toolName: p.name,
                  output: outputOf(p),
                },
              ]
            : [],
        )
        if (content.length > 0) prompt.push({ role: 'tool', content })
        break
      }
    }
  }
  return prompt
}

type AssistantContent = Extract<LanguageModelV4Message, { role: 'assistant' }>['content'][number]

function assistantPart(part: Part, key: string): AssistantContent[] {
  // what a provider attached goes back to that provider alone
  const own = 'provider' in part && part.provider === key
  const options = own && 'details' in part ? optionsOf(part.details) : undefined
  switch (part.kind) {
    case 'text':
      return part.text === '' ? [] : [{ type: 'text', text: part.text, ...options }]
    case 'thinking':
      return own ? [{ type: 'reasoning', text: part.text, ...options }] : []
    case 'tool_call':
      return [
        {
          type: 'tool-call',
          toolCallId: part.callId,
          toolName: part.name,
          input: part.args,
          ...options,
        },
      ]
    default:
      return []
  }
}

function outputOf(part: Extract<Part, { kind: 'tool_result' }>): LanguageModelV4ToolResultOutput {
  const images = part.images ?? []
  if (images.length > 0) {
    return {
      type: 'content',
      value: [
        { type: 'text', text: part.content },
        ...images.map((image) => ({
          type: 'file' as const,
          data: { type: 'data' as const, data: image.data },
          mediaType: image.mediaType,
        })),
      ],
    }
  }
  return part.isError === true
    ? { type: 'error-text', value: part.content }
    : { type: 'text', value: part.content }
}

function toTool(spec: ToolSpec): LanguageModelV4FunctionTool {
  return {
    type: 'function',
    name: spec.name,
    description: spec.description,
    inputSchema: spec.parameters as LanguageModelV4FunctionTool['inputSchema'],
  }
}

// ---------------------------------------------------------------------------
// Settings and metadata
// ---------------------------------------------------------------------------

/** `Settings.thinking` as the spec's reasoning effort, which each
 *  provider resolves for each model (an effort, a budget, adaptive). */
export function reasoningOf(thinking: boolean | Effort): Effort | 'none' {
  return thinking === true ? 'medium' : thinking === false ? 'none' : thinking
}

/** What else `Settings.thinking` takes, in a provider's own options:
 *  what the spec's reasoning effort doesn't reach. */
export function thinkingOptions(
  key: string,
  thinking: Settings['thinking'],
): SharedV4ProviderOptions {
  const on = thinking !== undefined && thinking !== false
  switch (key) {
    case 'openai':
      // reasoning goes back as encrypted content, never as a reference
      // to an item OpenAI kept: agex keeps the conversation
      return {
        openai: {
          store: false,
          include: ['reasoning.encrypted_content'],
          ...(on && { reasoningSummary: 'auto' }),
        },
      }
    case 'google':
      // Gemini thinks without saying so unless asked
      return on ? { google: { thinkingConfig: { includeThoughts: true } } } : {}
    case 'openrouter': {
      // OpenRouter takes its own reasoning option, not the spec's
      if (thinking === undefined) return {}
      const effort = reasoningOf(thinking)
      return {
        openrouter: {
          reasoning:
            effort === 'none'
              ? { enabled: false }
              : { effort: effort === 'xhigh' ? 'high' : effort },
        },
      }
    }
    default:
      return {}
  }
}

/** Provider options, `extra` over the base, one provider's at a time. */
function merge(
  base: SharedV4ProviderOptions,
  extra: Readonly<Record<string, unknown>>,
): SharedV4ProviderOptions {
  const out: Record<string, Record<string, JSONValue | undefined>> = { ...base }
  for (const [provider, options] of Object.entries(extra)) {
    if (typeof options === 'object' && options !== null) {
      out[provider] = { ...(out[provider] ?? {}), ...(options as Record<string, JSONValue>) }
    }
  }
  return out as SharedV4ProviderOptions
}

function detailsOf(metadata: unknown): Details | null {
  return typeof metadata === 'object' && metadata !== null && Object.keys(metadata).length > 0
    ? (JSON.parse(JSON.stringify(metadata)) as Details)
    : null
}

function mergeDetails(current: Details | null | undefined, metadata: unknown): Details | null {
  const more = detailsOf(metadata)
  if (more === null) return current ?? null
  if (current === null || current === undefined) return more
  const out: Record<string, unknown> = { ...current }
  for (const [provider, value] of Object.entries(more)) {
    const was = out[provider]
    out[provider] =
      typeof was === 'object' && was !== null && typeof value === 'object' && value !== null
        ? { ...(was as object), ...(value as object) }
        : value
  }
  return out
}

function optionsOf(details: Details | null | undefined): {
  providerOptions?: SharedV4ProviderOptions
} {
  return details === null || details === undefined
    ? {}
    : { providerOptions: details as SharedV4ProviderOptions }
}

/** A tool call's arguments: the model's JSON, or none when it sent
 *  something else, so the tool says what's missing. */
function argsOf(input: string): Readonly<Record<string, unknown>> {
  if (input === '') return {}
  try {
    const parsed: unknown = JSON.parse(input)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function usageOf(usage: LanguageModelV4Usage): Usage {
  return {
    inputTokens: usage.inputTokens.total ?? 0,
    outputTokens: usage.outputTokens.total ?? 0,
    cacheReadTokens: usage.inputTokens.cacheRead ?? 0,
    cacheWriteTokens: usage.inputTokens.cacheWrite ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/** Whether an error, or one that caused it, says the provider couldn't
 *  be reached: a failed fetch, a dropped connection, a timeout. */
function unreachable(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    const { name, message, code } = current as { name?: unknown; message?: unknown; code?: unknown }
    if (
      name === 'TypeError' &&
      typeof message === 'string' &&
      /fetch|network|load failed/i.test(message)
    ) {
      return true
    }
    if (
      typeof code === 'string' &&
      /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_)/.test(code)
    ) {
      return true
    }
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/** Whether OpenRouter relayed this error from the upstream provider,
 *  rather than refusing the request itself. */
function relayed(error: APICallError): boolean {
  const body = parse(error.responseBody)
  if (typeof body === 'string') return body.trim() === RELAYED
  if (typeof body !== 'object' || body === null) return error.message.trim() === RELAYED
  const inner = (body as { error?: unknown }).error
  const e = (typeof inner === 'object' && inner !== null ? inner : body) as {
    message?: unknown
    metadata?: unknown
  }
  return (
    e.message === RELAYED ||
    (typeof e.metadata === 'object' && e.metadata !== null && 'provider_name' in e.metadata)
  )
}

function bodyMessage(responseBody: string | undefined): string | null {
  const body = parse(responseBody)
  if (typeof body !== 'object' || body === null) return null
  const inner = (body as { error?: unknown }).error
  const e = (typeof inner === 'object' && inner !== null ? inner : body) as { message?: unknown }
  return typeof e.message === 'string' && e.message !== '' ? e.message : null
}

function parse(text: string | undefined): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
