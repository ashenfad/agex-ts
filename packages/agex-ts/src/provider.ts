/**
 * How agex talks to a model, after Python agex's `agex.providers`.
 *
 * A {@link Provider} takes the conversation so far (agex's own
 * {@link Message}s), the tools the model may call, and the request's
 * settings, and streams the reply: text and reasoning as they arrive,
 * then the whole reply as one assistant message, its usage included.
 * Everything provider-specific (message formats, streaming protocols,
 * cache controls) stays behind it. The AI SDK's providers come in
 * through one adapter of this protocol; {@link ScriptedProvider} replies
 * from a script, for tests.
 *
 * **Cancellation is explicit.** JS has no task cancellation that would
 * interrupt an await, and closing an async iterator doesn't stop a
 * request waiting on the network, so a request takes an abort signal:
 * aborted, the request ends and the stream rejects.
 */

import type { Tool, TurnEvent } from '@agex-ts/world'
import type { Message } from './record'

/** A tool the model may call: its name, what it does, and the JSON
 *  Schema of its arguments. */
export interface ToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

/** A world tool's spec, for a request. */
export function toolSpec(tool: Tool): ToolSpec {
  return { name: tool.name, description: tool.description, parameters: tool.parameters }
}

/** How hard a model reasons before it answers, where it can. */
export type Effort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/**
 * A request's settings. `thinking` asks for reasoning (`true`, or an
 * effort) on any provider that offers it, each in its own terms; `false`
 * asks for none, and leaving it out leaves the provider's default.
 * `extra` passes provider-specific settings through as they are (cache
 * controls, a reasoning budget).
 */
export interface Settings {
  readonly maxTokens?: number
  readonly temperature?: number
  readonly thinking?: boolean | Effort
  readonly extra?: Readonly<Record<string, unknown>>
}

/** The model's whole reply, last in the stream: one assistant message,
 *  with the model that wrote it and its usage. */
export interface Reply {
  readonly kind: 'Reply'
  readonly message: Message
}

/** What a provider streams: text and reasoning deltas as they arrive
 *  (the turn's own events), then one {@link Reply}. */
export type ProviderEvent = Extract<TurnEvent, { kind: 'TextDelta' | 'ThinkingDelta' }> | Reply

/** What a request takes beside its messages, tools and settings. */
export interface StreamOptions {
  /** Aborted, the request ends and the stream rejects. */
  readonly signal?: AbortSignal
}

/** A model, as agex calls it. */
export interface Provider {
  /** The model, as a person would name it (`anthropic:claude-...`). */
  readonly name: string
  /** Stream the reply to `messages`: deltas, then one {@link Reply}. A
   *  failed request rejects. */
  stream(
    messages: readonly Message[],
    tools: readonly ToolSpec[],
    settings: Settings,
    opts?: StreamOptions,
  ): AsyncIterable<ProviderEvent>
  /** Whether a request that failed with `error` is worth resuming: the
   *  provider was overloaded, rate-limited or briefly down. A run that
   *  meets one is interrupted, not failed. */
  transient(error: unknown): boolean
  /** A failed request in words, for the turn's message; null (or no
   *  method) falls back to the error's own. */
  describe?(error: unknown): string | null
}

/** The error an aborted request rejects with. */
export function aborted(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error(typeof reason === 'string' ? reason : 'the request was cancelled')
  error.name = 'AbortError'
  return error
}
