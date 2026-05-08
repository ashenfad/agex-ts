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

import { buildChapterScopeFilter } from '../chaptering'
import { formatErrorPart } from '../output-part'
import type {
  ActionEvent,
  AgentEvent,
  ChapterEvent,
  Emission,
  ImageFormat,
  OutputPart,
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
export {
  TOOL_TS,
  TOOL_TERMINAL,
  TOOL_WRITE_FILE,
  TOOL_EDIT_FILE,
  toolSchemas,
  type ToolSchema,
  type ToolSchemaOptions,
} from './tool-schemas'

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
 *    - `error` / `file` / `systemNote` — framework metadata, not
 *      conversation
 *
 * Rendered events:
 *
 *    - `TaskStartEvent` becomes a user turn with the stored task
 *      message (the message stamped at task launch by
 *      `buildTaskMessage`). For multi-task sessions, this places
 *      each task's opening prompt at its actual position in the
 *      timeline, not floating at the front of the request.
 *    - `ActionEvent` becomes one assistant turn. Tool-call
 *      emissions (`ts` / `terminal` / `fileWrite` / `fileEdit`)
 *      become `tool_use` parts. `text` / `thinking` become
 *      text / thinking parts inline in the same assistant turn.
 *    - `OutputEvent`s following the action are routed by their
 *      `emissionId` back to the tool_use that produced them. All
 *      tool_results for one assistant turn collapse into a single
 *      user turn (Anthropic and OpenAI both reject split user
 *      turns of tool_results).
 *    - Every tool_use part gets *some* tool_result: real outputs
 *      when present, a synthesized "wrote /path" line for file
 *      emissions on success, or "(no observation)" for silent
 *      `ts` / `terminal` blocks.
 *    - `success` / `fail` / `clarify` / `cancelled` become brief
 *      assistant text turns ("[Task 'X' complete]" etc.) so the
 *      model sees prior tasks closing out before the next one
 *      opens. Without this, two consecutive task starts in the
 *      same session would look like the model went rogue mid-task.
 *    - `ChapterEvent` becomes its own assistant turn (with the
 *      `/chapters/<slug>/` hint) and forces a flush of any pending
 *      user content first.
 */
export function renderEvents(events: ReadonlyArray<AgentEvent>): NeutralTurn[] {
  const turns: NeutralTurn[] = []

  // Filter A: skip events inside *closed* `__chapter__` task scopes.
  // The chapter task's bookkeeping (taskStart, action with the
  // `taskSuccess([Chapter(...)])` code, success) sits in the parent's
  // log alongside everything else, but rendering it to the LLM would
  // (a) duplicate the summary text already rendered via the
  // ChapterEvents themselves and (b) clutter the parent agent's
  // context with "I ran a `__chapter__` task" noise. Open scopes
  // (the chapter task currently running, mid-loop) are intentionally
  // *not* filtered — that's how the chapter task's own LLM call sees
  // its own user prompt (the TaskStartEvent) plus any prior turns.
  const skip = buildChapterScopeFilter(events)

  // Per-action state, reset each time a new ActionEvent arrives.
  let toolUseOrder: { id: string; toolName: ToolName }[] = []
  let obsByEmission = new Map<string, OutputPart[]>()
  let synthByEmission = new Map<string, string>()
  let pendingTrailingParts: NeutralPart[] = []

  function flushUser(): void {
    const parts: NeutralPart[] = []
    for (const { id, toolName } of toolUseOrder) {
      parts.push(buildToolResultPart(id, toolName, obsByEmission.get(id), synthByEmission.get(id)))
    }
    parts.push(...pendingTrailingParts)
    if (parts.length > 0) turns.push({ role: 'user', content: parts })
    toolUseOrder = []
    obsByEmission = new Map()
    synthByEmission = new Map()
    pendingTrailingParts = []
  }

  function lastEmissionId(): string | null {
    return toolUseOrder.length > 0
      ? (toolUseOrder[toolUseOrder.length - 1] as { id: string }).id
      : null
  }

  for (let __i = 0; __i < events.length; __i++) {
    if (skip.has(__i)) continue
    const event = events[__i] as AgentEvent
    switch (event.type) {
      case 'taskStart': {
        flushUser()
        // Fall back to a stub if no message was stamped (legacy event
        // logs from before the message field landed). Using just the
        // task name keeps the conversation alternating cleanly.
        const text = event.message ?? `Task: ${event.taskName}`
        turns.push({ role: 'user', content: [{ type: 'text', text }] })
        break
      }
      case 'action': {
        flushUser()
        turns.push(renderActionTurn(event, toolUseOrder, synthByEmission))
        break
      }
      case 'output': {
        const stamped = event.emissionId
        const orderIds = new Set(toolUseOrder.map((t) => t.id))
        // Route by stamped id when it matches a known tool_use; fall
        // back to the most recent tool_use (e.g. legacy events without
        // emissionId, or outputs surfaced from a wrapper that didn't
        // stamp). When no tool_use exists at all, hold the parts as
        // plain user content for the next flush.
        const id = stamped !== undefined && orderIds.has(stamped) ? stamped : lastEmissionId()
        if (id !== null) {
          const slot = obsByEmission.get(id) ?? []
          slot.push(...event.parts)
          obsByEmission.set(id, slot)
        } else {
          for (const p of event.parts) {
            pendingTrailingParts.push(outputPartToNeutral(p))
          }
        }
        break
      }
      case 'chapter': {
        flushUser()
        turns.push(renderChapterTurn(event))
        break
      }
      case 'success': {
        flushUser()
        turns.push(closingAssistantTurn('[Task complete]'))
        break
      }
      case 'fail': {
        flushUser()
        turns.push(closingAssistantTurn(`[Task failed: ${event.message}]`))
        break
      }
      case 'clarify': {
        flushUser()
        turns.push(closingAssistantTurn(`[Task needs clarification: ${event.message}]`))
        break
      }
      case 'cancelled': {
        flushUser()
        turns.push(
          closingAssistantTurn(
            `[Task '${event.taskName}' cancelled after ${event.iterationsCompleted} iterations]`,
          ),
        )
        break
      }
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
  // Final flush — the last action's tool_results need to land in the
  // request as the trailing user turn so the next LLM call sees them.
  flushUser()
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

function renderActionTurn(
  event: ActionEvent,
  toolUseOrder: { id: string; toolName: ToolName }[],
  synthByEmission: Map<string, string>,
): NeutralTurn {
  const content: NeutralPart[] = []
  for (let i = 0; i < event.emissions.length; i++) {
    const em = event.emissions[i] as Emission
    const id = makeToolUseId(event.timestamp, i)
    const built = renderEmission(em, id)
    if (built === null) continue
    content.push(built.part)
    if (built.toolName !== null) {
      toolUseOrder.push({ id, toolName: built.toolName })
      const synth = synthesizeFileResult(em)
      if (synth !== null) synthByEmission.set(id, synth)
    }
  }
  return { role: 'assistant', content }
}

/** Build the neutral part for an emission. `toolName` is non-null iff
 *  the part is a `tool_use` (i.e. needs a paired tool_result). */
function renderEmission(
  em: Emission,
  emissionId: string,
): { part: NeutralPart; toolName: ToolName | null } | null {
  switch (em.type) {
    case 'ts': {
      const part: ToolUsePart = {
        type: 'toolUse',
        toolUseId: emissionId,
        toolName: 'ts_action',
        input: {
          code: em.code,
          ...(em.thinking !== undefined && { thinking: em.thinking }),
          ...(em.title !== undefined && { title: em.title }),
        },
        ...(em.signature !== undefined && { signature: em.signature }),
      }
      return { part, toolName: 'ts_action' }
    }
    case 'terminal': {
      const part: ToolUsePart = {
        type: 'toolUse',
        toolUseId: emissionId,
        toolName: 'terminal_action',
        input: {
          commands: em.commands,
          ...(em.thinking !== undefined && { thinking: em.thinking }),
          ...(em.title !== undefined && { title: em.title }),
        },
        ...(em.signature !== undefined && { signature: em.signature }),
      }
      return { part, toolName: 'terminal_action' }
    }
    case 'fileWrite': {
      const part: ToolUsePart = {
        type: 'toolUse',
        toolUseId: emissionId,
        toolName: 'write_file',
        input: { path: em.path, content: em.content, mode: em.mode },
        ...(em.signature !== undefined && { signature: em.signature }),
      }
      return { part, toolName: 'write_file' }
    }
    case 'fileEdit': {
      const part: ToolUsePart = {
        type: 'toolUse',
        toolUseId: emissionId,
        toolName: 'edit_file',
        input: {
          path: em.path,
          search: em.search,
          content: em.content,
          ...(em.matchAll !== undefined && { matchAll: em.matchAll }),
        },
        ...(em.signature !== undefined && { signature: em.signature }),
      }
      return { part, toolName: 'edit_file' }
    }
    case 'text':
      return { part: { type: 'text', text: em.text }, toolName: null }
    case 'thinking': {
      const part: ThinkingPart = {
        type: 'thinking',
        text: em.text,
        ...(em.redacted !== undefined && { redacted: em.redacted }),
        ...(em.signature !== undefined && { signature: em.signature }),
      }
      return { part, toolName: null }
    }
    default: {
      const exhaustive: never = em
      void exhaustive
      return null
    }
  }
}

/** File ops produce no execution output on the happy path, so the
 *  renderer synthesizes a short "wrote /path" line that stands in for
 *  the missing tool_result content. Used only when no real
 *  observation lands on this emission's id. */
function synthesizeFileResult(em: Emission): string | null {
  if (em.type === 'fileWrite') {
    const verb = em.mode === 'append' ? 'appended to' : 'wrote'
    return `write_file: ${verb} ${em.path}`
  }
  if (em.type === 'fileEdit') {
    const suffix = em.matchAll === true ? ' (matchAll)' : ''
    return `edit_file: replace applied to ${em.path}${suffix}`
  }
  return null
}

/** Produce the tool_result part for one tool_use. Real observations
 *  win over the synth fallback (e.g. a failed fileEdit logs an error
 *  to its slot, which would be wrong to mask with a "success" line). */
function buildToolResultPart(
  toolUseId: string,
  toolName: ToolName,
  observations: OutputPart[] | undefined,
  synth: string | undefined,
): ToolResultPart {
  const obs = observations ?? []
  const hasObservable = obs.some(
    (p) => p.type === 'text' || p.type === 'image' || p.type === 'error',
  )
  if (synth !== undefined && !hasObservable) {
    return {
      type: 'toolResult',
      toolUseId,
      content: [{ type: 'text', text: synth }],
    }
  }
  const content: Array<TextPart | ImagePart> = []
  // Coalesce text + error parts into a single text block so a single
  // emission's stdout-then-error sequence reads naturally to the LLM.
  // Errors lower via `outputPartToNeutral` to the agex-py-compatible
  // `💥 ErrorName: message` shape.
  const textBits: string[] = []
  for (const p of obs) {
    if (p.type === 'text') textBits.push(p.text)
    else if (p.type === 'error') textBits.push(formatErrorPart(p.errorName, p.errorMessage))
  }
  if (textBits.length > 0) {
    content.push({ type: 'text', text: `${toolName}: output\n${textBits.join('\n')}` })
  }
  for (const p of obs) {
    if (p.type === 'image') {
      content.push({
        type: 'image',
        format: p.format,
        data: p.data,
        ...(p.altText !== undefined && { altText: p.altText }),
      })
    }
  }
  if (content.length === 0) {
    content.push({ type: 'text', text: `${toolName}: (no observation)` })
  }
  return { type: 'toolResult', toolUseId, content }
}

function outputPartToNeutral(p: OutputPart): TextPart | ImagePart {
  if (p.type === 'text') return { type: 'text', text: p.text }
  if (p.type === 'error') {
    // The LLM sees the same `💥 {ErrorName}: {message}` shape agex-py
    // uses, so the agent's prompt-side recognition stays uniform across
    // implementations. Embedders rendering a UI should switch on
    // `part.type === 'error'` directly to style it distinctly.
    return { type: 'text', text: formatErrorPart(p.errorName, p.errorMessage) }
  }
  return {
    type: 'image',
    format: p.format,
    data: p.data,
    ...(p.altText !== undefined && { altText: p.altText }),
  }
}

function renderChapterTurn(event: ChapterEvent): NeutralTurn {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: renderChapterText(event) }],
  }
}

/** A short assistant turn marking the end of a task. Surfaces
 *  prior-task closure to the model so a subsequent task start
 *  doesn't read like the model went off-script mid-task. */
function closingAssistantTurn(text: string): NeutralTurn {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}
