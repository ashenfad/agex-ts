/**
 * Convert a stream of provider-agnostic `ToolCallEvent`s into the
 * `TokenChunk`s that agex-ts's task loop consumes.
 *
 * Two cadences:
 *
 *  1. **Streaming chunks** — for each tool call's JSON args, the
 *     `JsonStringExtractor` emits per-key string deltas as the model
 *     writes. Each delta becomes a `TokenChunk` whose `type` is the
 *     per-tool mapped name (`title` / `thinking` / `ts` / `terminal`
 *     / `filePath` / `fileSearch` / `fileContent`) so callers can
 *     forward UI text in real time via `onToken`.
 *
 *  2. **Final emission** — at `ToolCallEnd`, we re-parse the buffered
 *     raw JSON and build the authoritative `Emission`, then emit one
 *     final `TokenChunk { type: 'emission', done: true, emission }`
 *     that the task loop slots into the `ActionEvent`. Re-parsing
 *     covers non-string fields (`mode`, `matchAll`) that the
 *     streaming extractor skips.
 *
 *  TextPart and ThinkingPart events from the translator each emit
 *  their own `emission` token at a fresh emission index, so they
 *  ride alongside tool calls in the order the model produced them.
 */

import {
  TOOL_EDIT_FILE,
  TOOL_TERMINAL,
  TOOL_TS,
  TOOL_WRITE_FILE,
  type ToolName,
} from 'agex-ts/render'
import type {
  Emission,
  FileEditEmission,
  FileWriteEmission,
  TerminalEmission,
  TextEmission,
  ThinkingEmission,
  TokenChunk,
  TokenChunkType,
  TsEmission,
} from 'agex-ts/types'
import { JsonStringExtractor } from './json-stream'
import type { ToolCallEvent } from './stream'

// JSON-arg key → TokenChunk.type per tool. Streaming chunks for keys
// not in the map are dropped (e.g. `mode` on write_file is non-string
// and isn't streamed).
const TS_KEY_MAP: Readonly<Record<string, TokenChunkType>> = {
  title: 'title',
  thinking: 'thinking',
  code: 'ts',
}
const TERMINAL_KEY_MAP: Readonly<Record<string, TokenChunkType>> = {
  title: 'title',
  thinking: 'thinking',
  commands: 'terminal',
}
const WRITE_FILE_KEY_MAP: Readonly<Record<string, TokenChunkType>> = {
  path: 'filePath',
  content: 'fileContent',
}
const EDIT_FILE_KEY_MAP: Readonly<Record<string, TokenChunkType>> = {
  path: 'filePath',
  search: 'fileSearch',
  content: 'fileContent',
}

function keyMapFor(toolName: ToolName): Readonly<Record<string, TokenChunkType>> {
  switch (toolName) {
    case TOOL_TS:
      return TS_KEY_MAP
    case TOOL_TERMINAL:
      return TERMINAL_KEY_MAP
    case TOOL_WRITE_FILE:
      return WRITE_FILE_KEY_MAP
    case TOOL_EDIT_FILE:
      return EDIT_FILE_KEY_MAP
  }
}

class CallState {
  readonly toolName: ToolName
  readonly emissionIndex: number
  private readonly extractor = new JsonStringExtractor()
  private readonly rawBuf: string[] = []
  private readonly keyMap: Readonly<Record<string, TokenChunkType>>

  constructor(toolName: ToolName, emissionIndex: number) {
    this.toolName = toolName
    this.emissionIndex = emissionIndex
    this.keyMap = keyMapFor(toolName)
  }

  feedArgs(chunk: string): TokenChunk[] {
    this.rawBuf.push(chunk)
    const out: TokenChunk[] = []
    for (const delta of this.extractor.feed(chunk)) {
      const tokenType = this.keyMap[delta.key]
      if (tokenType === undefined) continue
      out.push({
        type: tokenType,
        content: delta.content,
        done: delta.done,
        emissionIndex: this.emissionIndex,
      })
    }
    return out
  }

  /** Build the authoritative Emission from the buffered raw JSON.
   *
   *  On any parse / shape failure, returns a synthetic `TextEmission`
   *  describing what went wrong — never `null`. Two reasons:
   *
   *    1. An empty assistant turn (no emissions) makes Anthropic
   *       400 on the next request.
   *    2. The text shows up as a `[text]` part in the action's
   *       conversation history, so the model can read its own
   *       error and adjust on the next turn. */
  finalize(): TokenChunk {
    const raw = this.rawBuf.join('')
    const fallback = (reason: string): TokenChunk => ({
      type: 'emission',
      content: '',
      done: true,
      emissionIndex: this.emissionIndex,
      emission: {
        type: 'text',
        text: `(${this.toolName} call dropped: ${reason})`,
      },
    })
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      return fallback(`invalid JSON args — ${e instanceof Error ? e.message : 'unknown'}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return fallback('args were not a JSON object')
    }
    const args = parsed as Record<string, unknown>
    const emission = this.buildEmission(args)
    if (emission === null) {
      return fallback('required fields missing (e.g. path / search)')
    }
    return {
      type: 'emission',
      content: '',
      done: true,
      emissionIndex: this.emissionIndex,
      emission,
    }
  }

  private buildEmission(args: Record<string, unknown>): Emission | null {
    switch (this.toolName) {
      case TOOL_TS:
        return buildTsEmission(args)
      case TOOL_TERMINAL:
        return buildTerminalEmission(args)
      case TOOL_WRITE_FILE:
        return buildWriteFileEmission(args)
      case TOOL_EDIT_FILE:
        return buildEditFileEmission(args)
    }
  }
}

function buildTsEmission(args: Record<string, unknown>): TsEmission | null {
  const code = strOr(args.code, '')
  // Permit empty code — the model occasionally calls ts_action with
  // just thinking + title to "comment out" a turn. Surfaces as a
  // no-op Emission, agent sees "(no observation)" and continues.
  return {
    type: 'ts',
    code,
    ...(args.thinking !== undefined && { thinking: strOr(args.thinking, '') }),
    ...(args.title !== undefined && { title: strOr(args.title, '') }),
  }
}

function buildTerminalEmission(args: Record<string, unknown>): TerminalEmission | null {
  const commands = strOr(args.commands, '')
  return {
    type: 'terminal',
    commands,
    ...(args.thinking !== undefined && { thinking: strOr(args.thinking, '') }),
    ...(args.title !== undefined && { title: strOr(args.title, '') }),
  }
}

function buildWriteFileEmission(args: Record<string, unknown>): FileWriteEmission | null {
  const path = strOr(args.path, '')
  if (path.length === 0) return null
  const rawMode = args.mode
  const mode = rawMode === 'append' ? 'append' : 'write'
  return {
    type: 'fileWrite',
    path,
    content: strOr(args.content, ''),
    mode,
  }
}

function buildEditFileEmission(args: Record<string, unknown>): FileEditEmission | null {
  const path = strOr(args.path, '')
  if (path.length === 0) return null
  // Without `search`, the edit is incoherent — drop. `content` may be
  // empty (delete the matched block).
  if (typeof args.search !== 'string') return null
  return {
    type: 'fileEdit',
    path,
    search: args.search,
    content: strOr(args.content, ''),
    ...(args.matchAll === true && { matchAll: true }),
  }
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export async function* parseToolEvents(
  events: AsyncIterable<ToolCallEvent>,
): AsyncIterable<TokenChunk> {
  const calls = new Map<string, CallState>()
  let nextIndex = 0
  // Track the currently-streaming thinking / text block's emission
  // index so per-delta TokenChunks share an index with the final
  // emission TokenChunk that closes the block. Anthropic streams
  // content blocks one at a time (start → deltas → stop) without
  // interleaving per-index, so a single "currently open" slot is
  // sufficient. Both reset to null at the closing *Part event.
  let currentThinkingIdx: number | null = null
  let currentTextIdx: number | null = null

  for await (const event of events) {
    if (event.type === 'thinkingDelta') {
      if (currentThinkingIdx === null) currentThinkingIdx = nextIndex++
      yield {
        type: 'thinking',
        content: event.content,
        done: false,
        emissionIndex: currentThinkingIdx,
      }
      continue
    }
    if (event.type === 'textDelta') {
      if (currentTextIdx === null) currentTextIdx = nextIndex++
      yield { type: 'text', content: event.content, done: false, emissionIndex: currentTextIdx }
      continue
    }
    if (event.type === 'textPart') {
      // Don't drop whitespace-only text. Earlier we filtered it out
      // ("noise from providers between content blocks"), but if the
      // model's *only* output is a whitespace text block, dropping
      // it leaves the action with no emissions — which renders as an
      // empty assistant turn and Anthropic 400s on the next request.
      // A whitespace text part in the log is harmless; an empty
      // assistant turn is not.
      const text = event.text
      const idx = currentTextIdx ?? nextIndex++
      currentTextIdx = null
      const emission: TextEmission = { type: 'text', text }
      yield { type: 'emission', content: '', done: true, emissionIndex: idx, emission }
      continue
    }
    if (event.type === 'thinkingPart') {
      const hasText = event.text !== undefined && event.text.length > 0
      const hasSig = event.signature !== undefined
      const isRedacted = event.redacted === true
      if (!hasText && !hasSig && !isRedacted) {
        currentThinkingIdx = null
        continue
      }
      const idx = currentThinkingIdx ?? nextIndex++
      currentThinkingIdx = null
      const emission: ThinkingEmission = {
        type: 'thinking',
        text: event.text ?? '',
        ...(event.signature !== undefined && { signature: event.signature }),
        ...(event.redacted === true && { redacted: true }),
      }
      yield { type: 'emission', content: '', done: true, emissionIndex: idx, emission }
      continue
    }
    if (event.type === 'toolCallStart') {
      const idx = nextIndex++
      calls.set(event.callId, new CallState(event.toolName, idx))
      // toolStart token names the tool so the UI can show "calling
      // ts_action..." before any args have arrived.
      yield {
        type: 'toolStart',
        content: event.toolName,
        done: true,
        emissionIndex: idx,
      }
      continue
    }
    if (event.type === 'toolCallArgDelta') {
      const state = calls.get(event.callId)
      if (state === undefined) continue
      for (const tok of state.feedArgs(event.argumentChunk)) yield tok
      continue
    }
    if (event.type === 'toolCallEnd') {
      const state = calls.get(event.callId)
      if (state === undefined) continue
      calls.delete(event.callId)
      yield state.finalize()
    }
  }
}
