/**
 * Pure-function adapter from agex-ts neutral shapes to OpenAI's
 * Chat Completions wire format.
 *
 * Three concerns:
 *
 *  1. **Tool schemas** — OpenAI expects `tools=[{ type: 'function',
 *     function: { name, description, parameters } }]`. Wrap our
 *     generic `{ name, description, parameters }` schemas in that
 *     envelope.
 *
 *  2. **Messages** — our renderer produces NeutralTurns with
 *     `tool_use` / `tool_result` content blocks. OpenAI encodes the
 *     same information differently:
 *       - Assistant messages with `tool_use` parts → an assistant
 *         message with a `tool_calls: [{ id, type: 'function',
 *         function: { name, arguments } }]` array. `arguments` is a
 *         JSON-stringified object. Plain text alongside becomes the
 *         message's `content`.
 *       - User messages with `tool_result` parts → one separate
 *         `{ role: 'tool', tool_call_id, content }` message per
 *         result. Any text/image parts in the same NeutralTurn
 *         become a trailing `{ role: 'user', content }` message.
 *
 *  3. **No cache_control** — OpenAI does automatic stable-prefix
 *     caching; nothing to mark explicitly. (The provider just needs
 *     us to send the same prefix bytes each call to hit cache.)
 *
 *  Image parts inside `tool_result` blocks flatten to `[image]`
 *  placeholders since OpenAI's `role:'tool'` content is string-only.
 *  Mixed text/image content in a normal user turn is preserved as
 *  the multi-part `content` array OpenAI accepts.
 */

import type {
  ImagePart,
  NeutralPart,
  NeutralTurn,
  ToolName,
  ToolResultPart,
  ToolSchema,
  ToolUsePart,
} from 'agex-ts/render'

// ---------------------------------------------------------------------------
// OpenAI wire-format types (lightweight; we don't pull the SDK)
// ---------------------------------------------------------------------------

export interface OpenAIToolFunction {
  readonly name: ToolName
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

export interface OpenAITool {
  readonly type: 'function'
  readonly function: OpenAIToolFunction
}

export interface OpenAIToolCall {
  readonly id: string
  readonly type: 'function'
  readonly function: {
    readonly name: ToolName
    /** JSON-stringified arguments object. */
    readonly arguments: string
  }
}

export interface OpenAITextContent {
  readonly type: 'text'
  readonly text: string
}

export interface OpenAIImageContent {
  readonly type: 'image_url'
  readonly image_url: { readonly url: string }
}

export type OpenAIUserContent = string | ReadonlyArray<OpenAITextContent | OpenAIImageContent>

export interface OpenAISystemMessage {
  readonly role: 'system'
  readonly content: string
}

export interface OpenAIUserMessage {
  readonly role: 'user'
  readonly content: OpenAIUserContent
}

export interface OpenAIAssistantMessage {
  readonly role: 'assistant'
  readonly content: string | null
  readonly tool_calls?: ReadonlyArray<OpenAIToolCall>
}

export interface OpenAIToolMessage {
  readonly role: 'tool'
  readonly tool_call_id: string
  readonly content: string
}

export type OpenAIMessage =
  | OpenAISystemMessage
  | OpenAIUserMessage
  | OpenAIAssistantMessage
  | OpenAIToolMessage

// ---------------------------------------------------------------------------
// Tool schema envelope
// ---------------------------------------------------------------------------

/** Wrap our flat `{ name, description, parameters }` schemas in
 *  OpenAI's `{ type: 'function', function: { ... } }` envelope. */
export function schemasToOpenAITools(schemas: ReadonlyArray<ToolSchema>): OpenAITool[] {
  return schemas.map((s) => ({
    type: 'function',
    function: {
      name: s.name,
      description: s.description,
      parameters: s.parameters,
    },
  }))
}

// ---------------------------------------------------------------------------
// Message lowering
// ---------------------------------------------------------------------------

/** Lower a sequence of `NeutralTurn`s into OpenAI Chat Completions
 *  messages. Each NeutralTurn can fan out to multiple OpenAI
 *  messages — a user turn with two tool_results becomes two
 *  `role: 'tool'` messages, possibly followed by a user message
 *  with the trailing text/image content. */
export function lowerNeutralTurns(turns: ReadonlyArray<NeutralTurn>): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  for (const turn of turns) {
    if (turn.role === 'assistant') {
      out.push(lowerAssistantTurn(turn.content))
    } else {
      out.push(...lowerUserTurn(turn.content))
    }
  }
  return out
}

function lowerAssistantTurn(parts: ReadonlyArray<NeutralPart>): OpenAIAssistantMessage {
  const textBits: string[] = []
  const toolCalls: OpenAIToolCall[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      textBits.push(part.text)
    } else if (part.type === 'thinking') {
      // OpenAI Chat Completions has no native thinking field.
      // OpenRouter supports a separate `reasoning_details` array
      // but that's a v2 concern. Drop on egress; the captured
      // emission still lives in the agex event log.
    } else if (part.type === 'toolUse') {
      toolCalls.push(lowerToolUse(part))
    }
    // toolResult / image have no place in an assistant turn.
  }
  const msg: OpenAIAssistantMessage = {
    role: 'assistant',
    content: textBits.length > 0 ? textBits.join('') : null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
  }
  return msg
}

function lowerToolUse(part: ToolUsePart): OpenAIToolCall {
  return {
    id: part.toolUseId,
    type: 'function',
    function: {
      name: part.toolName,
      arguments: JSON.stringify(part.input),
    },
  }
}

function lowerUserTurn(parts: ReadonlyArray<NeutralPart>): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  // Tool results become individual `role: 'tool'` messages.
  const trailing: NeutralPart[] = []
  for (const part of parts) {
    if (part.type === 'toolResult') {
      out.push(lowerToolResult(part))
    } else {
      trailing.push(part)
    }
  }
  // Anything else (text / image) becomes a trailing user message.
  if (trailing.length > 0) {
    out.push(lowerTrailingUserContent(trailing))
  }
  return out
}

function lowerToolResult(part: ToolResultPart): OpenAIToolMessage {
  // OpenAI's `role: 'tool'` content is string-only. Flatten image
  // parts to a placeholder; if the caller needs multimodal tool
  // observation, surface the image in a follow-up user message.
  const bits: string[] = []
  for (const inner of part.content) {
    if (inner.type === 'text') bits.push(inner.text)
    else bits.push('[image]')
  }
  return {
    role: 'tool',
    tool_call_id: part.toolUseId,
    content: bits.join('\n'),
  }
}

function lowerTrailingUserContent(parts: ReadonlyArray<NeutralPart>): OpenAIUserMessage {
  // All text → simple string content (the cheaper path).
  const allText = parts.every((p) => p.type === 'text')
  if (allText) {
    return {
      role: 'user',
      content: parts.map((p) => (p as { text: string }).text).join(''),
    }
  }
  // Mixed → multi-part array.
  const content: Array<OpenAITextContent | OpenAIImageContent> = []
  for (const part of parts) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text })
    } else if (part.type === 'image') {
      content.push(lowerImage(part))
    }
  }
  return { role: 'user', content }
}

function lowerImage(part: ImagePart): OpenAIImageContent {
  // OpenAI uses a data URL inside `image_url.url`.
  const mediaType = mediaTypeFor(part.format)
  return {
    type: 'image_url',
    image_url: { url: `data:${mediaType};base64,${part.data}` },
  }
}

function mediaTypeFor(format: ImagePart['format']): string {
  switch (format) {
    case 'png':
      return 'image/png'
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
  }
}
