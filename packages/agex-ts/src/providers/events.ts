/**
 * Provider-agnostic event vocabulary that the tool-call parser
 * consumes. Each provider package translates its native streaming
 * events (Anthropic `content_block_*`, OpenAI `delta.tool_calls`,
 * Gemini `parts[]`) into this small union; the shared parser then
 * turns it into the `TokenChunk` stream the agent loop knows about.
 *
 * The vocabulary is deliberately minimal: just the four cadences
 * needed to assemble agex-ts emissions across providers — tool
 * calls (start / arg deltas / end), text content (deltas + final
 * part), thinking content (deltas + final part with optional
 * signature), and a usage-token holder that providers populate as
 * the stream progresses.
 */

import type { ToolName } from '../render'

export interface ToolCallStart {
  readonly type: 'toolCallStart'
  readonly callId: string
  readonly toolName: ToolName
  /** Per-call opaque signature the provider wants round-tripped on
   *  subsequent turns (Gemini's `thoughtSignature`). The parser
   *  threads this onto the built Emission so the renderer can place
   *  it correctly on the next request. `undefined` for providers
   *  that don't sign (Anthropic puts signatures on separate
   *  thinking blocks; OpenAI Chat Completions doesn't sign). */
  readonly signature?: Uint8Array
}

export interface ToolCallArgDelta {
  readonly type: 'toolCallArgDelta'
  readonly callId: string
  readonly argumentChunk: string
}

export interface ToolCallEnd {
  readonly type: 'toolCallEnd'
  readonly callId: string
}

export interface TextDelta {
  readonly type: 'textDelta'
  readonly content: string
}

export interface TextPartEvent {
  readonly type: 'textPart'
  readonly text: string
}

export interface ThinkingDelta {
  readonly type: 'thinkingDelta'
  readonly content: string
}

export interface ThinkingPartEvent {
  readonly type: 'thinkingPart'
  readonly text?: string
  readonly signature?: Uint8Array
  readonly redacted?: boolean
}

export type ToolCallEvent =
  | ToolCallStart
  | ToolCallArgDelta
  | ToolCallEnd
  | TextDelta
  | TextPartEvent
  | ThinkingDelta
  | ThinkingPartEvent

/** Shared mutable holder providers populate from their stream's
 *  usage events (Anthropic message_start/delta, OpenAI's final
 *  chunk.usage, Gemini's usageMetadata). Read by the client after
 *  the stream closes to surface token totals on the trailing
 *  TokenChunk. */
export interface UsageHolder {
  inputTokens: number | null
  outputTokens: number | null
}
