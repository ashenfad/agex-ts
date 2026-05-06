/**
 * Pure-function adapter from agex-ts neutral shapes to Gemini's
 * `generateContent` wire format.
 *
 * Three concerns:
 *
 *  1. **Tool schemas** — Gemini expects `[{ functionDeclarations:
 *     [{ name, description, parameters }] }]` wrapped in a `Tool`.
 *     The inner shape is identical to ours (no `parameters` rename
 *     like Anthropic's `input_schema`, no `function` wrapper like
 *     OpenAI). The client wraps the declarations alongside any
 *     grounding tools (deferred to v2).
 *
 *  2. **Messages** — Gemini uses `Content[]` with `role: 'user' |
 *     'model'` (note: 'model', not 'assistant') and `parts: [...]`
 *     where each Part is one of:
 *       - `{ text }`
 *       - `{ functionCall: { id, name, args } }` (args = dict)
 *       - `{ functionResponse: { id, name, response: { result } } }`
 *       - `{ thought: true, text?, thoughtSignature }`
 *       - `{ inlineData: { mimeType, data } }` (image)
 *     `functionResponse` is keyed by **function name**; our
 *     `tool_result` only carries `tool_use_id`, so we walk messages
 *     in order and maintain an `id → name` map populated from
 *     preceding `tool_use` blocks to recover the name.
 *
 *  3. **Thought signatures** — Gemini 3 requires that the **first**
 *     `functionCall` in each model turn carry a `thoughtSignature`
 *     (sibling field of `functionCall` on the same Part). When the
 *     original response didn't supply one, agex-py's documented
 *     escape hatch is to fill it with a literal sentinel; the
 *     stream translator already injects this fallback, so by the
 *     time messages reach this adapter the signature is always
 *     present on round-trip.
 *
 *  Also: Gemini rejects `Content` with empty `parts: []`, so the
 *  adapter drops empty turns silently rather than 400-ing.
 */

import type {
  ImagePart,
  NeutralPart,
  NeutralTurn,
  ThinkingPart,
  ToolName,
  ToolResultPart,
  ToolSchema,
  ToolUsePart,
} from 'agex-ts/render'

// ---------------------------------------------------------------------------
// Gemini wire-format types (lightweight; we don't pull the SDK)
// ---------------------------------------------------------------------------

export type GeminiRole = 'user' | 'model'

export interface GeminiTextPart {
  readonly text: string
}

export interface GeminiInlineDataPart {
  readonly inlineData: { readonly mimeType: string; readonly data: string }
}

export interface GeminiFunctionCallPart {
  readonly functionCall: {
    readonly id?: string
    readonly name: ToolName
    readonly args: Readonly<Record<string, unknown>>
  }
  /** Base64-encoded thought signature when the call is being
   *  replayed from a previous turn. Required by Gemini 3 on the
   *  first functionCall in each model turn. */
  readonly thoughtSignature?: string
}

export interface GeminiFunctionResponsePart {
  readonly functionResponse: {
    readonly id?: string
    readonly name: ToolName
    readonly response: Readonly<Record<string, unknown>>
  }
}

export interface GeminiThoughtPart {
  readonly thought: true
  readonly text?: string
  readonly thoughtSignature?: string
}

export type GeminiPart =
  | GeminiTextPart
  | GeminiInlineDataPart
  | GeminiFunctionCallPart
  | GeminiFunctionResponsePart
  | GeminiThoughtPart

export interface GeminiContent {
  readonly role: GeminiRole
  readonly parts: ReadonlyArray<GeminiPart>
}

export interface GeminiFunctionDeclaration {
  readonly name: ToolName
  readonly description: string
  readonly parameters: Readonly<Record<string, unknown>>
}

// ---------------------------------------------------------------------------
// Tool schema envelope
// ---------------------------------------------------------------------------

/** Project our generic schemas into Gemini's `FunctionDeclaration`
 *  shape. Same field names — pure projection. The client wraps
 *  these in `tools: [{ functionDeclarations: [...] }]`. */
export function schemasToGeminiFunctionDeclarations(
  schemas: ReadonlyArray<ToolSchema>,
): GeminiFunctionDeclaration[] {
  return schemas.map((s) => ({
    name: s.name,
    description: s.description,
    parameters: s.parameters,
  }))
}

// ---------------------------------------------------------------------------
// Message lowering
// ---------------------------------------------------------------------------

const _enc = new TextEncoder()
const _dec = new TextDecoder('utf-8', { fatal: false })

/** Gemini transmits thoughtSignature as base64 in JSON. Encode our
 *  `Uint8Array` form back. */
function bytesToBase64(bytes: Uint8Array): string {
  // Avoid the spread + fromCharCode trick on long arrays (call-stack
  // overflow). Build via chunks, fall back to Buffer in Node.
  if (typeof btoa === 'function') {
    let bin = ''
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.subarray(i, i + chunkSize)
      bin += String.fromCharCode(...slice)
    }
    return btoa(bin)
  }
  // biome-ignore lint/suspicious/noExplicitAny: Node-only fallback
  const Buf = (globalThis as any).Buffer
  if (Buf !== undefined) return Buf.from(bytes).toString('base64')
  // Throw rather than silently corrupt — Gemini would 400 on the
  // mangled signature anyway, and the error here is more
  // actionable than the API's. (Both Node 16+ and every modern
  // browser ship `btoa`; this branch shouldn't fire in practice.)
  throw new Error(
    'agex-gemini: no base64 encoder available — neither btoa() nor globalThis.Buffer ' +
      'exists in this runtime. Cannot encode thoughtSignature for the Gemini API.',
  )
}

/** Lower a sequence of `NeutralTurn`s into Gemini `Content[]`. */
export function lowerNeutralTurns(turns: ReadonlyArray<NeutralTurn>): GeminiContent[] {
  // Gemini's functionResponse is keyed by name (plus optional id),
  // but our `tool_result` only carries `tool_use_id`. Walk messages
  // in order and remember each tool_use's name keyed by its id, so
  // when we later see a tool_result we can recover the name.
  const idToName = new Map<string, ToolName>()
  const out: GeminiContent[] = []
  for (const turn of turns) {
    const role: GeminiRole = turn.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []
    for (const part of turn.content) {
      const lowered = lowerPart(part, idToName)
      parts.push(...lowered)
    }
    if (parts.length === 0) continue // Gemini rejects empty parts arrays
    out.push({ role, parts })
  }
  return out
}

function lowerPart(part: NeutralPart, idToName: Map<string, ToolName>): GeminiPart[] {
  switch (part.type) {
    case 'text':
      return part.text.length > 0 ? [{ text: part.text }] : []
    case 'image':
      return [lowerImage(part)]
    case 'thinking':
      return lowerThinking(part)
    case 'toolUse': {
      idToName.set(part.toolUseId, part.toolName)
      return [lowerToolUse(part)]
    }
    case 'toolResult':
      return [lowerToolResult(part, idToName)]
    default: {
      const exhaustive: never = part
      void exhaustive
      return []
    }
  }
}

function lowerImage(part: ImagePart): GeminiInlineDataPart {
  return {
    inlineData: {
      mimeType: imageMediaType(part.format),
      data: part.data,
    },
  }
}

function imageMediaType(format: ImagePart['format']): string {
  switch (format) {
    case 'png':
      return 'image/png'
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
  }
}

/** Round-trip a thinking part as a Gemini thought Part. The
 *  signature MUST come back at the same position or Gemini 3 400s
 *  the request. */
function lowerThinking(part: ThinkingPart): GeminiPart[] {
  const out: GeminiThoughtPart = {
    thought: true,
    ...(part.text !== undefined && part.text.length > 0 && { text: part.text }),
    ...(part.signature !== undefined && {
      thoughtSignature: bytesToBase64(part.signature),
    }),
  }
  // Drop entirely-empty thoughts (no text, no signature, no
  // redacted flag) — they have nothing to round-trip.
  if (out.text === undefined && out.thoughtSignature === undefined) return []
  return [out]
}

function lowerToolUse(part: ToolUsePart): GeminiFunctionCallPart {
  // Gemini expects args as an object dict (not a string). Our
  // ToolUsePart.input is already a Record<string, unknown>.
  const out: GeminiFunctionCallPart = {
    functionCall: {
      ...(part.toolUseId.length > 0 && { id: part.toolUseId }),
      name: part.toolName,
      args: part.input,
    },
    ...(part.signature !== undefined && {
      thoughtSignature: bytesToBase64(part.signature),
    }),
  }
  return out
}

function lowerToolResult(
  part: ToolResultPart,
  idToName: Map<string, ToolName>,
): GeminiFunctionResponsePart {
  // FunctionResponse needs the function name, but our
  // ToolResultPart only has the id. Recover from the in-order
  // id→name map populated by preceding toolUse parts. Falls back to
  // an empty string if we somehow lost track (extremely unusual —
  // would only happen on a tool_result with no preceding tool_use
  // in the same conversation).
  const name = idToName.get(part.toolUseId) ?? ('' as unknown as ToolName)
  // Flatten the inner content into a string — Gemini's
  // functionResponse.response is a JSON object, not a multi-part
  // content list. Image parts become text placeholders; if a
  // caller needs multimodal observation, they should send the
  // image as a separate user-turn part.
  const bits: string[] = []
  for (const inner of part.content) {
    if (inner.type === 'text') bits.push(inner.text)
    else bits.push('[image]')
  }
  return {
    functionResponse: {
      ...(part.toolUseId.length > 0 && { id: part.toolUseId }),
      name,
      response: { result: bits.join('\n') },
    },
  }
}
