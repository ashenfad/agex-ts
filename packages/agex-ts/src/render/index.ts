/**
 * Provider-agnostic rendering — the "what the agent sees" surface
 * shared across every provider package.
 *
 * Three pieces, each focused:
 *
 *   - `buildSystemMessage(inputs)` — composes the system prompt
 *     (BUILTIN_PRIMER + capabilities/registrations + skills listing
 *     + agent.primer)
 *   - `buildTaskMessage(def, inputValue)` — composes the per-task
 *     opening user message (description + inputs + expected return)
 *   - `renderEvents(events)` — composes the conversation turns from
 *     the event log (ActionEvent → assistant tool_use, OutputEvent →
 *     user tool_result, ChapterEvent → assistant text with the
 *     `/chapters/<slug>/` path hint)
 *
 * Provider packages (`@agex-ts/anthropic` etc.) take the
 * `NeutralTurn[]` from `renderEvents` plus the system + task
 * messages and lower them into their wire format (Anthropic content
 * blocks, OpenAI tool messages, Gemini parts arrays).
 *
 * Tool-use IDs are derived deterministically from the source
 * ActionEvent's timestamp + emission index. Stability matters
 * because each new request re-renders the full history; the IDs in
 * the historical parts must match what the provider has seen
 * before. As long as the renderer is pure and the events don't
 * mutate, the IDs stay stable.
 */

import type {
  ActionEvent,
  AgentEvent,
  ChapterEvent,
  Emission,
  ImageFormat,
  OutputEvent,
} from '../types'

// Re-exports — single import surface for provider packages
export { BUILTIN_PRIMER } from './builtin-primer'
export {
  extractJsonSchema,
  hasObjectProperties,
  objectPropertyNames,
} from './extract-schema'
export { renderRegistrations } from './registrations'
export { buildSystemMessage, type SystemMessageInputs } from './system-message'
export { buildTaskMessage } from './task-message'

// ---------------------------------------------------------------------------
// Neutral content shapes
// ---------------------------------------------------------------------------

export type Role = 'user' | 'assistant'

/** The four "actions" the agent can emit. Each becomes a tool_use
 *  block in the provider's wire format. */
export type ToolName = 'ts_action' | 'terminal_action' | 'write_file' | 'edit_file'

export interface TextPart {
  readonly type: 'text'
  readonly text: string
}

export interface ImagePart {
  readonly type: 'image'
  readonly format: ImageFormat
  /** Base64-encoded bytes. */
  readonly data: string
  readonly altText?: string
}

export interface ThinkingPart {
  readonly type: 'thinking'
  readonly text: string
  readonly redacted?: boolean
  /** Provider-native opaque round-trip blob. MUST be passed back
   *  verbatim on the next request — providers reject mismatched
   *  signatures. */
  readonly signature?: Uint8Array
}

export interface ToolUsePart {
  readonly type: 'toolUse'
  readonly toolUseId: string
  readonly toolName: ToolName
  readonly input: Readonly<Record<string, unknown>>
  readonly signature?: Uint8Array
}

export interface ToolResultPart {
  readonly type: 'toolResult'
  readonly toolUseId: string
  readonly content: ReadonlyArray<TextPart | ImagePart>
  readonly isError?: boolean
}

export type NeutralPart = TextPart | ImagePart | ThinkingPart | ToolUsePart | ToolResultPart

export interface NeutralTurn {
  readonly role: Role
  readonly content: ReadonlyArray<NeutralPart>
}

// ---------------------------------------------------------------------------
// Event renderer
// ---------------------------------------------------------------------------

/** Render a sequence of events as a neutral conversation. The
 *  returned turns are ordered chronologically. Skipped events:
 *
 *    - `TaskStartEvent` — the per-task opening user message is
 *      reconstructed from the live `TaskDefinition` + input via
 *      `buildTaskMessage`, not from this audit-trail event
 *    - `success` / `fail` / `clarify` / `cancelled` — terminal
 *      markers; the loop has already exited
 *    - `error` / `file` / `systemNote` — framework metadata, not
 *      conversation
 *
 * Rendered events:
 *    - `ActionEvent` → assistant turn with one part per emission
 *    - `OutputEvent` → user turn with `toolResult` if it can be
 *      tied back to a prior ActionEvent's emission, else plain
 *      user text/image content
 *    - `ChapterEvent` → assistant turn with the chapter summary +
 *      `/chapters/<slug>/` path hint
 */
export function renderEvents(events: ReadonlyArray<AgentEvent>): NeutralTurn[] {
  const turns: NeutralTurn[] = []
  // Track the most recent action so OutputEvents can be tied back to
  // the right tool_use IDs. Multiple OutputEvents may follow one
  // ActionEvent (one per emission that produced output).
  let lastActionTimestamp: string | null = null
  let lastActionEmissionCount = 0
  let outputCursor = 0
  for (const event of events) {
    switch (event.type) {
      case 'taskStart':
        // Skipped — buildTaskMessage handles the opening user turn
        break
      case 'action':
        turns.push(renderActionTurn(event))
        lastActionTimestamp = event.timestamp
        lastActionEmissionCount = event.emissions.length
        outputCursor = 0
        break
      case 'output': {
        if (lastActionTimestamp !== null && outputCursor < lastActionEmissionCount) {
          const toolUseId = makeToolUseId(lastActionTimestamp, outputCursor)
          outputCursor++
          turns.push(renderOutputAsToolResult(event, toolUseId))
        } else {
          turns.push(renderOutputAsUserMessage(event))
        }
        break
      }
      case 'chapter':
        turns.push(renderChapterTurn(event))
        break
      case 'success':
      case 'fail':
      case 'clarify':
      case 'cancelled':
      case 'error':
      case 'file':
      case 'systemNote':
        break
      default: {
        const exhaustive: never = event
        void exhaustive
      }
    }
  }
  return turns
}

/** Render a single chapter event as the text the LLM will see in
 *  place of the originals. Includes the `/chapters/<slug>/` path
 *  hint so the agent can drill in via its VFS tools. */
export function renderChapterText(event: ChapterEvent): string {
  return `📖 Chapter: "${event.name}"\n\n${event.message}\n\nFull details: /chapters/${event.slug}/`
}

/** Stable deterministic toolUseId for a given action position. The
 *  same (timestamp, index) pair always produces the same id, so the
 *  framework can re-render the history across turns without
 *  breaking provider-side validation. */
export function makeToolUseId(actionTimestamp: string, emissionIndex: number): string {
  const safeTs = actionTimestamp.replace(/[:.]/g, '_').replace(/-/g, '_')
  return `tu_${safeTs}_${emissionIndex}`
}

// ---------------------------------------------------------------------------
// Per-event renderers
// ---------------------------------------------------------------------------

function renderActionTurn(event: ActionEvent): NeutralTurn {
  const content: NeutralPart[] = []
  for (let i = 0; i < event.emissions.length; i++) {
    const em = event.emissions[i] as Emission
    const part = renderEmission(em, event.timestamp, i)
    if (part !== null) content.push(part)
  }
  return { role: 'assistant', content }
}

function renderEmission(em: Emission, actionTimestamp: string, index: number): NeutralPart | null {
  switch (em.type) {
    case 'ts': {
      const part: ToolUsePart = {
        type: 'toolUse',
        toolUseId: makeToolUseId(actionTimestamp, index),
        toolName: 'ts_action',
        input: {
          code: em.code,
          ...(em.thinking !== undefined && { thinking: em.thinking }),
          ...(em.title !== undefined && { title: em.title }),
        },
        ...(em.signature !== undefined && { signature: em.signature }),
      }
      return part
    }
    case 'terminal': {
      const part: ToolUsePart = {
        type: 'toolUse',
        toolUseId: makeToolUseId(actionTimestamp, index),
        toolName: 'terminal_action',
        input: {
          commands: em.commands,
          ...(em.thinking !== undefined && { thinking: em.thinking }),
          ...(em.title !== undefined && { title: em.title }),
        },
        ...(em.signature !== undefined && { signature: em.signature }),
      }
      return part
    }
    case 'fileWrite': {
      const part: ToolUsePart = {
        type: 'toolUse',
        toolUseId: makeToolUseId(actionTimestamp, index),
        toolName: 'write_file',
        input: { path: em.path, content: em.content, mode: em.mode },
        ...(em.signature !== undefined && { signature: em.signature }),
      }
      return part
    }
    case 'fileEdit': {
      const part: ToolUsePart = {
        type: 'toolUse',
        toolUseId: makeToolUseId(actionTimestamp, index),
        toolName: 'edit_file',
        input: {
          path: em.path,
          search: em.search,
          content: em.content,
          ...(em.matchAll !== undefined && { matchAll: em.matchAll }),
        },
        ...(em.signature !== undefined && { signature: em.signature }),
      }
      return part
    }
    case 'text':
      return { type: 'text', text: em.text }
    case 'thinking': {
      const part: ThinkingPart = {
        type: 'thinking',
        text: em.text,
        ...(em.redacted !== undefined && { redacted: em.redacted }),
        ...(em.signature !== undefined && { signature: em.signature }),
      }
      return part
    }
    default: {
      const exhaustive: never = em
      void exhaustive
      return null
    }
  }
}

function renderOutputAsToolResult(event: OutputEvent, toolUseId: string): NeutralTurn {
  const content: Array<TextPart | ImagePart> = []
  for (const p of event.parts) {
    if (p.type === 'text') {
      content.push({ type: 'text', text: p.text })
    } else {
      content.push({
        type: 'image',
        format: p.format,
        data: p.data,
        ...(p.altText !== undefined && { altText: p.altText }),
      })
    }
  }
  return {
    role: 'user',
    content: [{ type: 'toolResult', toolUseId, content }],
  }
}

function renderOutputAsUserMessage(event: OutputEvent): NeutralTurn {
  const content: NeutralPart[] = []
  for (const p of event.parts) {
    if (p.type === 'text') {
      content.push({ type: 'text', text: p.text })
    } else {
      content.push({
        type: 'image',
        format: p.format,
        data: p.data,
        ...(p.altText !== undefined && { altText: p.altText }),
      })
    }
  }
  return { role: 'user', content }
}

function renderChapterTurn(event: ChapterEvent): NeutralTurn {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: renderChapterText(event) }],
  }
}
