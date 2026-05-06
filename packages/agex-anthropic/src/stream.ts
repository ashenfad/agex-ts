/**
 * Translate Anthropic Messages-API SSE event dicts into a small
 * provider-agnostic vocabulary the tool-call parser consumes.
 *
 * Anthropic streams structured events:
 *   - `message_start` — carries initial `usage` (input/output tokens)
 *   - `content_block_start` — opens a `tool_use` / `thinking` /
 *     `redacted_thinking` / `text` block at content-array `index`
 *   - `content_block_delta` — `input_json_delta` (partial JSON for
 *     a tool_use's `input`), `thinking_delta`, `signature_delta`,
 *     or `text_delta`
 *   - `content_block_stop` — closes index N
 *   - `message_delta` — usage updates
 *   - `message_stop` / `ping` — non-content
 *   - `error` — surfaces as a thrown Error
 *
 * Output events are routed by content-block index → call id (for
 * tool_use) or accumulated text/signature (for thinking/text).
 *
 * The translator is bytes-agnostic: it accepts already-parsed JSON
 * dicts. SSE byte parsing happens upstream in `sse.ts`.
 */

import type { ToolName } from 'agex-ts/render'

// ---------------------------------------------------------------------------
// Output vocabulary — what the tool-call parser consumes
// ---------------------------------------------------------------------------

export interface ToolCallStart {
  readonly type: 'toolCallStart'
  readonly callId: string
  readonly toolName: ToolName
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

// ---------------------------------------------------------------------------
// Usage holder — populated by the translator from message_start /
// message_delta events. The client reads it after the stream closes.
// ---------------------------------------------------------------------------

export interface UsageHolder {
  inputTokens: number | null
  outputTokens: number | null
}

// ---------------------------------------------------------------------------
// Per-stream state
// ---------------------------------------------------------------------------

interface ThinkingState {
  text: string
  signature: string
  redacted: boolean
  data: string
}

interface StreamState {
  openByIndex: Map<number, { callId: string; toolName: ToolName }>
  thinkingByIndex: Map<number, ThinkingState>
  textByIndex: Map<number, string>
}

function newState(): StreamState {
  return {
    openByIndex: new Map(),
    thinkingByIndex: new Map(),
    textByIndex: new Map(),
  }
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

export async function* translateAnthropicStream(
  events: AsyncIterable<unknown>,
  usage?: UsageHolder,
): AsyncIterable<ToolCallEvent> {
  const state = newState()
  for await (const raw of events) {
    const ev = (raw ?? {}) as Record<string, unknown>
    captureUsage(ev, usage)
    if (ev.type === 'error') {
      const e = (ev.error ?? {}) as { message?: string; type?: string }
      throw new Error(`Anthropic stream error: ${e.message ?? e.type ?? 'unknown'}`)
    }
    yield* handleEvent(state, ev)
  }
  // Stream closed — emit safety-net ToolCallEnd for any tool_use blocks
  // still open, and flush any unclosed thinking accumulators.
  for (const { callId } of state.openByIndex.values()) {
    yield { type: 'toolCallEnd', callId }
  }
  state.openByIndex.clear()
  for (const t of state.thinkingByIndex.values()) {
    yield* emitThinking(t)
  }
  state.thinkingByIndex.clear()
}

function* handleEvent(state: StreamState, ev: Record<string, unknown>): Iterable<ToolCallEvent> {
  const etype = ev.type
  if (etype === 'content_block_start') {
    const idx = ev.index as number | undefined
    if (idx === undefined) return
    const block = (ev.content_block ?? {}) as Record<string, unknown>
    const btype = block.type
    if (btype === 'tool_use') {
      const callId = (block.id as string | undefined) ?? `call_${idx}`
      const name = ((block.name as string | undefined) ?? '') as ToolName
      state.openByIndex.set(idx, { callId, toolName: name })
      yield { type: 'toolCallStart', callId, toolName: name }
    } else if (btype === 'thinking') {
      state.thinkingByIndex.set(idx, {
        text: '',
        signature: '',
        redacted: false,
        data: '',
      })
    } else if (btype === 'redacted_thinking') {
      state.thinkingByIndex.set(idx, {
        text: '',
        signature: '',
        redacted: true,
        // Encrypted payload arrives whole on block_start (not via deltas).
        data: (block.data as string | undefined) ?? '',
      })
    } else if (btype === 'text') {
      state.textByIndex.set(idx, (block.text as string | undefined) ?? '')
    }
    return
  }
  if (etype === 'content_block_delta') {
    const idx = ev.index as number | undefined
    if (idx === undefined) return
    const delta = (ev.delta ?? {}) as Record<string, unknown>
    const dtype = delta.type
    if (dtype === 'input_json_delta') {
      const open = state.openByIndex.get(idx)
      const partial = (delta.partial_json as string | undefined) ?? ''
      if (open !== undefined && partial.length > 0) {
        yield { type: 'toolCallArgDelta', callId: open.callId, argumentChunk: partial }
      }
    } else if (dtype === 'thinking_delta') {
      const t = state.thinkingByIndex.get(idx)
      if (t !== undefined) {
        const chunk = (delta.thinking as string | undefined) ?? ''
        t.text += chunk
        if (chunk.length > 0) yield { type: 'thinkingDelta', content: chunk }
      }
    } else if (dtype === 'signature_delta') {
      const t = state.thinkingByIndex.get(idx)
      if (t !== undefined) t.signature += (delta.signature as string | undefined) ?? ''
    } else if (dtype === 'text_delta') {
      const cur = state.textByIndex.get(idx)
      if (cur !== undefined) {
        const chunk = (delta.text as string | undefined) ?? ''
        state.textByIndex.set(idx, cur + chunk)
        if (chunk.length > 0) yield { type: 'textDelta', content: chunk }
      }
    }
    return
  }
  if (etype === 'content_block_stop') {
    const idx = ev.index as number | undefined
    if (idx === undefined) return
    const open = state.openByIndex.get(idx)
    if (open !== undefined) {
      state.openByIndex.delete(idx)
      yield { type: 'toolCallEnd', callId: open.callId }
      return
    }
    const t = state.thinkingByIndex.get(idx)
    if (t !== undefined) {
      state.thinkingByIndex.delete(idx)
      yield* emitThinking(t)
      return
    }
    const text = state.textByIndex.get(idx)
    if (text !== undefined) {
      state.textByIndex.delete(idx)
      if (text.length > 0) yield { type: 'textPart', text }
    }
  }
  // message_start / message_delta / message_stop / ping — handled by
  // captureUsage or ignored.
}

const _enc = new TextEncoder()

function* emitThinking(t: ThinkingState): Iterable<ThinkingPartEvent> {
  if (t.redacted) {
    if (t.data.length === 0) return
    yield {
      type: 'thinkingPart',
      signature: _enc.encode(t.data),
      redacted: true,
    }
    return
  }
  const hasText = t.text.length > 0
  const hasSig = t.signature.length > 0
  if (!hasText && !hasSig) return
  yield {
    type: 'thinkingPart',
    ...(hasText && { text: t.text }),
    ...(hasSig && { signature: _enc.encode(t.signature) }),
  }
}

// ---------------------------------------------------------------------------
// Usage capture — sums input + cache_creation + cache_read tokens.
// ---------------------------------------------------------------------------

function captureUsage(ev: Record<string, unknown>, usage: UsageHolder | undefined): void {
  if (usage === undefined) return
  const t = ev.type
  if (t === 'message_start') {
    const msg = (ev.message ?? {}) as { usage?: Record<string, unknown> }
    applyUsage(msg.usage, usage)
  } else if (t === 'message_delta') {
    applyUsage(ev.usage as Record<string, unknown> | undefined, usage)
  }
}

function applyUsage(u: Record<string, unknown> | undefined, holder: UsageHolder): void {
  if (u === undefined) return
  const totalIn = totalInputTokens(u)
  if (totalIn !== null) holder.inputTokens = totalIn
  const out = u.output_tokens
  if (typeof out === 'number') holder.outputTokens = out
}

function totalInputTokens(u: Record<string, unknown>): number | null {
  const hasAny =
    'input_tokens' in u || 'cache_creation_input_tokens' in u || 'cache_read_input_tokens' in u
  if (!hasAny) return null
  return (
    numberOr0(u.input_tokens) +
    numberOr0(u.cache_creation_input_tokens) +
    numberOr0(u.cache_read_input_tokens)
  )
}

function numberOr0(v: unknown): number {
  return typeof v === 'number' ? v : 0
}
