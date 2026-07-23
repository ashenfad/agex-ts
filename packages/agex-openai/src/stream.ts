/**
 * Translate OpenAI Chat Completions streaming chunks into the small
 * provider-agnostic `ToolCallEvent` vocabulary the tool-call parser
 * consumes.
 *
 * OpenAI streams `chat.completion.chunk` JSON objects — one per SSE
 * `data:` line. Each chunk carries `choices[0].delta` which can have
 * any of:
 *   - `content`: a string fragment of plain assistant text
 *   - `tool_calls`: array of `{ index, id?, type?, function:{ name?,
 *     arguments? } }` partials
 *   - `finish_reason`: terminal marker on the closing chunk
 *
 * Multiple tool calls can stream in parallel keyed by `index`. We
 * track each open call by index so per-call arg deltas route to the
 * right `ToolCallStart` we emitted earlier.
 *
 * Usage tokens land on the `chunk.usage` object of the final chunk
 * when `stream_options: { include_usage: true }` is set on the
 * request (the client always sets it).
 *
 * Compared to Anthropic:
 *   - No structured `content_block_start/stop` boundaries — text
 *     accumulates across deltas; we flush as a single TextPart at
 *     stream end (matching agex-py's OpenAI adapter).
 *   - Native reasoning text is normalized from the common
 *     `reasoning`, `reasoning_content`, and OpenRouter
 *     `reasoning_details` extensions.
 *   - Tool args arrive as a JSON string fragment under
 *     `function.arguments` (no `input_json_delta` wrapper).
 */

import type { ToolCallEvent, UsageHolder } from 'agex-ts/providers'
import type { ToolName } from 'agex-ts/render'

export type { ToolCallEvent, UsageHolder }

// ---------------------------------------------------------------------------
// Per-stream state
// ---------------------------------------------------------------------------

interface StreamState {
  /** Open tool-call slots, keyed by OpenAI's per-chunk `index`. */
  openByIndex: Map<number, { callId: string; toolName: ToolName }>
  /** Accumulated text content (flushed on stream end as one TextPart). */
  textBuf: string[]
  /** Accumulated native reasoning text (flushed as one ThinkingPart). */
  thinkingBuf: string[]
}

function newState(): StreamState {
  return { openByIndex: new Map(), textBuf: [], thinkingBuf: [] }
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

export async function* translateOpenAIStream(
  events: AsyncIterable<unknown>,
  usage?: UsageHolder,
  includeReasoning = true,
): AsyncIterable<ToolCallEvent> {
  const state = newState()
  for await (const raw of events) {
    const ev = (raw ?? {}) as Record<string, unknown>
    captureUsage(ev, usage)
    if (isErrorChunk(ev)) {
      throw new Error(`OpenAI stream error: ${describeError(ev)}`)
    }
    yield* handleChunk(state, ev, includeReasoning)
  }
  yield* close(state)
}

function* handleChunk(
  state: StreamState,
  ev: Record<string, unknown>,
  includeReasoning: boolean,
): Iterable<ToolCallEvent> {
  const choices = ev.choices as ReadonlyArray<Record<string, unknown>> | undefined
  if (choices === undefined || choices.length === 0) return
  const choice = choices[0] as Record<string, unknown>
  const delta = (choice.delta ?? {}) as Record<string, unknown>

  const reasoning = includeReasoning ? reasoningText(delta) : ''
  if (reasoning.length > 0) {
    state.thinkingBuf.push(reasoning)
    yield { type: 'thinkingDelta', content: reasoning }
  }

  // Plain text content streams as deltas in `delta.content`. Yield a
  // TextDelta per chunk for live streaming AND buffer for the final
  // TextPart at stream end. (Mirrors agex-anthropic's text handling.)
  const content = delta.content
  if (typeof content === 'string' && content.length > 0) {
    yield* flushThinking(state)
    state.textBuf.push(content)
    yield { type: 'textDelta', content }
  }

  // Tool-call partials. Each carries a per-stream `index`; arg
  // chunks for the same index belong to the same call.
  const toolCalls = delta.tool_calls as ReadonlyArray<Record<string, unknown>> | undefined
  if (toolCalls !== undefined) {
    yield* flushThinking(state)
    for (const tc of toolCalls) {
      const idx = tc.index as number | undefined
      if (idx === undefined) continue
      let open = state.openByIndex.get(idx)
      if (open === undefined) {
        const id = (tc.id as string | undefined) ?? `call_${idx}`
        const fn = (tc.function ?? {}) as Record<string, unknown>
        const name = ((fn.name as string | undefined) ?? '') as ToolName
        open = { callId: id, toolName: name }
        state.openByIndex.set(idx, open)
        yield { type: 'toolCallStart', callId: id, toolName: name }
      }
      const fn = (tc.function ?? {}) as Record<string, unknown>
      const args = fn.arguments as string | undefined
      if (args !== undefined && args.length > 0) {
        yield { type: 'toolCallArgDelta', callId: open.callId, argumentChunk: args }
      }
    }
  }
}

function* close(state: StreamState): Iterable<ToolCallEvent> {
  // Close any tool calls still open. OpenAI signals the end via
  // `finish_reason: 'tool_calls'` on a chunk with no further deltas;
  // we treat the absence of more arg chunks as end-of-call when the
  // outer stream finishes.
  for (const open of state.openByIndex.values()) {
    yield { type: 'toolCallEnd', callId: open.callId }
  }
  state.openByIndex.clear()
  // Flush accumulated plain text as a single TextPart.
  if (state.textBuf.length > 0) {
    yield { type: 'textPart', text: state.textBuf.join('') }
    state.textBuf = []
  }
  yield* flushThinking(state)
}

function* flushThinking(state: StreamState): Iterable<ToolCallEvent> {
  if (state.thinkingBuf.length === 0) return
  yield { type: 'thinkingPart', text: state.thinkingBuf.join('') }
  state.thinkingBuf = []
}

function reasoningText(delta: Record<string, unknown>): string {
  const details = delta.reasoning_details
  if (Array.isArray(details)) {
    const chunks: string[] = []
    for (const raw of details) {
      if (raw === null || typeof raw !== 'object') continue
      const detail = raw as Record<string, unknown>
      const text =
        detail.type === 'reasoning.summary'
          ? detail.summary
          : detail.type === 'reasoning.text'
            ? detail.text
            : undefined
      if (typeof text === 'string') chunks.push(text)
    }
    if (chunks.length > 0) return chunks.join('')
  }
  if (typeof delta.reasoning === 'string') return delta.reasoning
  if (typeof delta.reasoning_content === 'string') return delta.reasoning_content
  return ''
}

// ---------------------------------------------------------------------------
// Usage + error helpers
// ---------------------------------------------------------------------------

function captureUsage(ev: Record<string, unknown>, usage: UsageHolder | undefined): void {
  if (usage === undefined) return
  // OpenAI sends `usage: null` on every non-final chunk and the
  // populated object only on the final usage chunk (when
  // `stream_options.include_usage = true`). Guard against null
  // explicitly — the `as` cast doesn't narrow it away.
  const raw = ev.usage
  if (raw === undefined || raw === null || typeof raw !== 'object') return
  const u = raw as Record<string, unknown>
  const promptTokens = u.prompt_tokens
  const completionTokens = u.completion_tokens
  if (typeof promptTokens === 'number') usage.inputTokens = promptTokens
  if (typeof completionTokens === 'number') usage.outputTokens = completionTokens
}

function isErrorChunk(ev: Record<string, unknown>): boolean {
  return ev.error !== undefined && ev.error !== null
}

function describeError(ev: Record<string, unknown>): string {
  const err = ev.error as Record<string, unknown> | undefined
  if (err === undefined) return 'unknown'
  const msg = err.message ?? err.type ?? err.code
  return typeof msg === 'string' ? msg : 'unknown'
}
