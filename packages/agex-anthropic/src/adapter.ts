/**
 * Pure-function adapter from agex-ts neutral shapes to Anthropic's
 * Messages API wire format.
 *
 * Three concerns:
 *
 *  1. **Tool schemas** — Anthropic wants `{ name, description,
 *     input_schema }`, no outer envelope (no OpenAI-style
 *     `{ type: "function", function: {...} }` wrapper).
 *
 *  2. **Messages** — our renderer's NeutralTurn shape is already very
 *     close to Anthropic's. The deltas:
 *       - Image parts: our `{ type: 'image', format, data }` →
 *         Anthropic's `{ type: 'image', source: { type: 'base64',
 *         media_type, data } }`.
 *       - Thinking parts: decode `signature: Uint8Array` back to the
 *         opaque string Anthropic returned, and re-emit as
 *         `{ type: 'thinking', thinking, signature }` or, when
 *         redacted, `{ type: 'redacted_thinking', data }`.
 *       - Tool_use parts: drop `signature` if present (Gemini round-
 *         trip artifact; Anthropic 400s on it).
 *
 *  3. **Cache control** — Anthropic prompt caching is opted into per
 *     content block via `cache_control: { type: 'ephemeral', ttl }`.
 *     `applyCacheControl` adds the breakpoint to the last block of
 *     the targeted message; the client typically targets the system
 *     primer plus the second-to-last conversation message.
 */

import type {
  ImagePart,
  NeutralPart,
  NeutralTurn,
  TextPart,
  ThinkingPart,
  ToolName,
  ToolResultPart,
  ToolSchema,
  ToolUsePart,
} from 'agex-ts/render'

// ---------------------------------------------------------------------------
// Anthropic wire-format types (lightweight; we don't pull the SDK)
// ---------------------------------------------------------------------------

export type AnthropicMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface AnthropicCacheControl {
  readonly type: 'ephemeral'
  readonly ttl?: '5m' | '1h'
}

export interface AnthropicTextBlock {
  readonly type: 'text'
  readonly text: string
  readonly cache_control?: AnthropicCacheControl
}

export interface AnthropicImageBlock {
  readonly type: 'image'
  readonly source: {
    readonly type: 'base64'
    readonly media_type: AnthropicMediaType
    readonly data: string
  }
  readonly cache_control?: AnthropicCacheControl
}

export interface AnthropicThinkingBlock {
  readonly type: 'thinking'
  readonly thinking: string
  readonly signature: string
  readonly cache_control?: AnthropicCacheControl
}

export interface AnthropicRedactedThinkingBlock {
  readonly type: 'redacted_thinking'
  readonly data: string
  readonly cache_control?: AnthropicCacheControl
}

export interface AnthropicToolUseBlock {
  readonly type: 'tool_use'
  readonly id: string
  readonly name: ToolName
  readonly input: Readonly<Record<string, unknown>>
  readonly cache_control?: AnthropicCacheControl
}

export interface AnthropicToolResultBlock {
  readonly type: 'tool_result'
  readonly tool_use_id: string
  readonly content: ReadonlyArray<AnthropicTextBlock | AnthropicImageBlock>
  readonly is_error?: boolean
  readonly cache_control?: AnthropicCacheControl
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock

export interface AnthropicMessage {
  readonly role: 'user' | 'assistant'
  readonly content: ReadonlyArray<AnthropicContentBlock>
}

export interface AnthropicTool {
  readonly name: ToolName
  readonly description: string
  readonly input_schema: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Tool schema envelope
// ---------------------------------------------------------------------------

/** Rename `parameters` → `input_schema` (Anthropic's key). No outer
 *  envelope — Anthropic tools are flat `{ name, description,
 *  input_schema }`. */
export function schemasToAnthropicTools(schemas: ReadonlyArray<ToolSchema>): AnthropicTool[] {
  return schemas.map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.parameters,
  }))
}

// ---------------------------------------------------------------------------
// Message lowering
// ---------------------------------------------------------------------------

/** Lower a sequence of `NeutralTurn`s into Anthropic Messages-API
 *  shape. Renderer output already uses Anthropic vocabulary
 *  (`tool_use` / `tool_result` / `thinking`); the deltas are image
 *  envelope translation, thinking signature decode, and dropping
 *  the Gemini-only `signature` field from `tool_use` blocks. */
export function lowerNeutralTurns(turns: ReadonlyArray<NeutralTurn>): AnthropicMessage[] {
  return turns.map((turn) => ({
    role: turn.role,
    content: turn.content.flatMap(lowerPart),
  }))
}

function lowerPart(part: NeutralPart): AnthropicContentBlock[] {
  switch (part.type) {
    case 'text':
      return [lowerText(part)]
    case 'image':
      return [lowerImage(part)]
    case 'thinking':
      return lowerThinking(part)
    case 'toolUse':
      return [lowerToolUse(part)]
    case 'toolResult':
      return [lowerToolResult(part)]
    default: {
      const exhaustive: never = part
      void exhaustive
      return []
    }
  }
}

function lowerText(part: TextPart): AnthropicTextBlock {
  return { type: 'text', text: part.text }
}

function lowerImage(part: ImagePart): AnthropicImageBlock {
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: imageMediaType(part.format),
      data: part.data,
    },
  }
}

function imageMediaType(format: ImagePart['format']): AnthropicMediaType {
  switch (format) {
    case 'png':
      return 'image/png'
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
  }
}

/** Round-trip a thinking part back into the native Anthropic block.
 *
 *  Non-redacted: `{ type: 'thinking', thinking, signature }` — the
 *  `Uint8Array` signature is decoded as UTF-8 (Anthropic returned it
 *  as a string and we stored its bytes for cross-provider
 *  consistency).
 *
 *  Redacted: `{ type: 'redacted_thinking', data }` — same decode
 *  applied to the bytes that were stashed as `signature` at parse
 *  time.
 *
 *  Either form REQUIRES the signature field; without it Anthropic
 *  rejects the request. We drop signature-less thinking parts here
 *  rather than send a malformed block (the alternative — send empty
 *  signature — also 400s). */
function lowerThinking(part: ThinkingPart): AnthropicContentBlock[] {
  if (part.signature === undefined) return []
  const sig = decodeUtf8(part.signature)
  if (part.redacted === true) {
    return [{ type: 'redacted_thinking', data: sig }]
  }
  return [{ type: 'thinking', thinking: part.text, signature: sig }]
}

function lowerToolUse(part: ToolUsePart): AnthropicToolUseBlock {
  // Drop signature: Gemini-only round-trip artifact. Anthropic's
  // Messages API doesn't accept it on tool_use blocks (signatures
  // live on separate thinking blocks instead) and would 400.
  return {
    type: 'tool_use',
    id: part.toolUseId,
    name: part.toolName,
    input: part.input,
  }
}

function lowerToolResult(part: ToolResultPart): AnthropicToolResultBlock {
  return {
    type: 'tool_result',
    tool_use_id: part.toolUseId,
    content: part.content.map((c) => (c.type === 'text' ? lowerText(c) : lowerImage(c))),
    ...(part.isError === true && { is_error: true }),
  }
}

const _decoder = new TextDecoder('utf-8', { fatal: false })

function decodeUtf8(bytes: Uint8Array): string {
  return _decoder.decode(bytes)
}

// ---------------------------------------------------------------------------
// Cache control
// ---------------------------------------------------------------------------

/** Return a copy of `messages` with a `cache_control` breakpoint on
 *  the last content block of `messages[cacheIndex]`. Out-of-range
 *  indices are silently ignored.
 *
 *  Anthropic applies caching to the prefix ending at the marked
 *  block — the client typically targets the second-to-last message
 *  (the last "completed" turn) so the breakpoint covers everything
 *  the model has already seen. */
export function applyCacheControl(
  messages: ReadonlyArray<AnthropicMessage>,
  cacheIndex: number,
  ttl: '5m' | '1h' = '1h',
): AnthropicMessage[] {
  if (messages.length === 0 || cacheIndex < 0 || cacheIndex >= messages.length) {
    return messages.map((m) => ({ ...m }))
  }
  const cc: AnthropicCacheControl = { type: 'ephemeral', ttl }
  return messages.map((msg, i) => {
    if (i !== cacheIndex || msg.content.length === 0) return { ...msg }
    const lastIdx = msg.content.length - 1
    const newContent: AnthropicContentBlock[] = msg.content.map((b, j) =>
      j === lastIdx ? withCacheControl(b, cc) : b,
    )
    return { role: msg.role, content: newContent }
  })
}

function withCacheControl(
  block: AnthropicContentBlock,
  cc: AnthropicCacheControl,
): AnthropicContentBlock {
  // Spread + cast — every block type accepts cache_control, but
  // narrowing each variant individually would be 6 nearly-identical
  // arms. The spread preserves the discriminant.
  return { ...block, cache_control: cc } as AnthropicContentBlock
}
