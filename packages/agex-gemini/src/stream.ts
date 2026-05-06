/**
 * Translate Gemini `:streamGenerateContent?alt=sse` chunks into the
 * provider-agnostic `ToolCallEvent` vocabulary the tool-call parser
 * consumes.
 *
 * Each SSE `data:` line is a full `GenerateContentResponse` fragment
 * with `candidates[0].content.parts[*]`. Parts can be:
 *   - `text`: assistant text (concatenate with adjacent text parts)
 *   - `function_call`: `{ id?, name, args }` — args is a complete dict
 *     (NOT a streamed JSON string like Anthropic / OpenAI). We
 *     stringify it and feed the parser as a single ArgDelta.
 *   - `function_response`: tool result (only on user turns; ignored
 *     for stream translation — only model turns stream).
 *   - `thought_signature`: opaque bytes that MUST round-trip on
 *     subsequent turns. Can sit on a Part alongside `function_call`,
 *     alongside `text`, or alone (Gemini 3 reasoning blocks).
 *   - `thought: true`: marks a part as model reasoning rather than
 *     visible output.
 *   - `inline_data`: image (only on user turns; ignored here).
 *
 * Critical buffering invariant (Gemini 3): a `function_call` may
 * arrive in one chunk WITHOUT a `thought_signature` and the matching
 * signature may arrive on a *later* chunk for the same call id.
 * Emitting Start/ArgDelta/End on first sight would lock in the
 * unsigned form and Gemini 400s the next request with "Function call
 * is missing a thought_signature in functionCall parts". So we
 * accumulate all parts across the stream and flush at end — last
 * signature seen wins.
 */

import type { ToolName } from 'agex-ts/render'

// ---------------------------------------------------------------------------
// Output vocabulary — must match the other providers' so the shared
// tool-call parser consumes it. Duplicated for now; lift to a shared
// module once we extract sse/json-stream/parser/events to agex-ts/
// providers.
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

export interface UsageHolder {
  inputTokens: number | null
  outputTokens: number | null
}

// ---------------------------------------------------------------------------
// Internal pending-buffer entries. We can't emit anything until the
// stream closes (see top-of-file invariant), so we record each Part
// as it walks and emit in order at the end.
// ---------------------------------------------------------------------------

type Pending =
  | { kind: 'fc'; callId: string; toolName: ToolName; args: unknown; signature?: Uint8Array }
  | { kind: 'text'; text: string }
  | { kind: 'thought'; text?: string; signature?: Uint8Array; isThought: boolean }

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/** Documented escape hatch for Gemini 3's thought-signature
 *  validator. agex-py uses this literal when Gemini's own response
 *  lacked a signature where the validator now requires one (the
 *  first function_call in each model turn). It bypasses validation
 *  at an accepted model-quality cost. */
const DUMMY_THOUGHT_SIGNATURE = new TextEncoder().encode('context_engineering_is_the_way_to_go')

export async function* translateGeminiStream(
  events: AsyncIterable<unknown>,
  usage?: UsageHolder,
): AsyncIterable<ToolCallEvent> {
  const pending: Pending[] = []
  const fcIndexById = new Map<string, number>()
  let counter = 0

  for await (const raw of events) {
    const ev = (raw ?? {}) as Record<string, unknown>
    captureUsage(ev, usage)
    if (isErrorChunk(ev)) {
      throw new Error(`Gemini stream error: ${describeError(ev)}`)
    }
    for (const walked of walkChunk(ev)) {
      counter = accumulate(walked, pending, fcIndexById, counter)
    }
  }
  yield* flush(pending)
}

// ---------------------------------------------------------------------------
// Walking + accumulation
// ---------------------------------------------------------------------------

interface WalkedPart {
  kind: 'function_call' | 'text' | 'thought'
  fc?: { id?: string; name?: string; args?: unknown }
  text?: string
  signature?: Uint8Array
  isThought?: boolean
}

function* walkChunk(ev: Record<string, unknown>): Iterable<WalkedPart> {
  const candidates = ev.candidates as ReadonlyArray<Record<string, unknown>> | undefined
  if (candidates === undefined) return
  for (const cand of candidates) {
    const content = cand.content as Record<string, unknown> | undefined
    if (content === undefined) continue
    const parts = content.parts as ReadonlyArray<Record<string, unknown>> | undefined
    if (parts === undefined) continue
    for (const part of parts) {
      const fc = part.functionCall as Record<string, unknown> | undefined
      const sig = decodeSig(part.thoughtSignature)
      if (fc !== undefined) {
        const id = fc.id as string | undefined
        const name = fc.name as string | undefined
        yield {
          kind: 'function_call',
          fc: {
            ...(id !== undefined && { id }),
            ...(name !== undefined && { name }),
            args: fc.args,
          },
          ...(sig !== undefined && { signature: sig }),
        }
        continue
      }
      const isThought = part.thought === true
      const text = (part.text as string | undefined) || undefined
      if (sig !== undefined || isThought) {
        yield {
          kind: 'thought',
          ...(text !== undefined && { text }),
          ...(sig !== undefined && { signature: sig }),
          isThought,
        }
        continue
      }
      // Plain text part (no fc, no thought, no signature).
      if (text !== undefined && text.length > 0) {
        yield { kind: 'text', text }
      }
    }
  }
}

function decodeSig(raw: unknown): Uint8Array | undefined {
  // Gemini transmits thought_signature as a base64-encoded string in
  // the JSON wire format. Decode to bytes for cross-provider
  // consistency (our ThinkingPart.signature is Uint8Array).
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    // atob is available in modern Node + browsers; fall back to
    // Buffer when not.
    if (typeof atob === 'function') {
      const bin = atob(raw)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return bytes
    }
    // biome-ignore lint/suspicious/noExplicitAny: Node-only fallback
    const Buf = (globalThis as any).Buffer
    if (Buf !== undefined) return new Uint8Array(Buf.from(raw, 'base64'))
  } catch {
    // Fall through to undefined.
  }
  return undefined
}

function accumulate(
  walked: WalkedPart,
  pending: Pending[],
  fcIndexById: Map<string, number>,
  counter: number,
): number {
  if (walked.kind === 'function_call' && walked.fc !== undefined) {
    const fc = walked.fc
    const callId = fc.id ?? `call_${counter}_${fc.name ?? 'fn'}`
    const existing = fcIndexById.get(callId)
    if (existing === undefined) {
      fcIndexById.set(callId, pending.length)
      pending.push({
        kind: 'fc',
        callId,
        toolName: (fc.name ?? '') as ToolName,
        args: fc.args ?? {},
        ...(walked.signature !== undefined && { signature: walked.signature }),
      })
      return counter + (fc.id !== undefined ? 0 : 1)
    }
    // Update the existing entry with the latest body / signature.
    const entry = pending[existing] as Extract<Pending, { kind: 'fc' }>
    entry.args = fc.args ?? entry.args
    if (walked.signature !== undefined) entry.signature = walked.signature
    return counter
  }
  if (walked.kind === 'text' && walked.text !== undefined) {
    // Concatenate consecutive text parts.
    const last = pending[pending.length - 1]
    if (last !== undefined && last.kind === 'text') {
      last.text += walked.text
    } else {
      pending.push({ kind: 'text', text: walked.text })
    }
    return counter
  }
  if (walked.kind === 'thought') {
    pending.push({
      kind: 'thought',
      ...(walked.text !== undefined && { text: walked.text }),
      ...(walked.signature !== undefined && { signature: walked.signature }),
      isThought: walked.isThought ?? false,
    })
    return counter
  }
  return counter
}

// ---------------------------------------------------------------------------
// Flushing
// ---------------------------------------------------------------------------

function* flush(pending: ReadonlyArray<Pending>): Iterable<ToolCallEvent> {
  let firstFcSeenWithoutSig = false
  for (const item of pending) {
    if (item.kind === 'fc') {
      // Ensure the first function_call carries a signature (apply
      // the documented dummy when Gemini didn't provide one — see
      // top-of-file note).
      let sig = item.signature
      if (sig === undefined && !firstFcSeenWithoutSig) {
        sig = DUMMY_THOUGHT_SIGNATURE
        firstFcSeenWithoutSig = true
      }
      // Gemini delivers args as a complete dict, not a JSON-string
      // stream. We feed the parser one ArgDelta with the full
      // serialized payload — the parser's JsonStringExtractor will
      // surface per-key string values for streaming UI consumers.
      yield { type: 'toolCallStart', callId: item.callId, toolName: item.toolName }
      yield {
        type: 'toolCallArgDelta',
        callId: item.callId,
        argumentChunk: JSON.stringify(item.args ?? {}),
      }
      yield { type: 'toolCallEnd', callId: item.callId }
      // Surface the signature as a synthetic ThinkingPart so the
      // renderer can replay it as a thought_signature on a sibling
      // Part next turn. (No model text — just the signature bytes.)
      if (sig !== undefined) {
        yield { type: 'thinkingPart', signature: sig }
      }
      continue
    }
    if (item.kind === 'text') {
      if (item.text.length > 0) yield { type: 'textPart', text: item.text }
      continue
    }
    if (item.kind === 'thought') {
      if (item.signature === undefined && (item.text === undefined || item.text.length === 0)) {
        continue
      }
      yield {
        type: 'thinkingPart',
        ...(item.text !== undefined && { text: item.text }),
        ...(item.signature !== undefined && { signature: item.signature }),
        ...(item.isThought && item.text === undefined && { redacted: true }),
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Usage + error helpers
// ---------------------------------------------------------------------------

function captureUsage(ev: Record<string, unknown>, usage: UsageHolder | undefined): void {
  if (usage === undefined) return
  // Gemini surfaces usage on every chunk under usageMetadata.
  // Latest-seen wins (the final chunk has the cumulative totals).
  const raw = ev.usageMetadata
  if (raw === undefined || raw === null || typeof raw !== 'object') return
  const u = raw as Record<string, unknown>
  const prompt = u.promptTokenCount
  const candidates = u.candidatesTokenCount
  if (typeof prompt === 'number') usage.inputTokens = prompt
  if (typeof candidates === 'number') usage.outputTokens = candidates
}

function isErrorChunk(ev: Record<string, unknown>): boolean {
  return ev.error !== undefined && ev.error !== null
}

function describeError(ev: Record<string, unknown>): string {
  const err = ev.error as Record<string, unknown> | undefined
  if (err === undefined) return 'unknown'
  const msg = err.message ?? err.status ?? err.code
  return typeof msg === 'string' ? msg : 'unknown'
}
