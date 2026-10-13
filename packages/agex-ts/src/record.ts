/**
 * The stored run record: what agex keeps of a run, in its own format,
 * after Python agex's `agex.record`.
 *
 * A run is the messages one turn exchanged with the model, with how it
 * ended. It is stored in the workspace's conversation plane (one run
 * body per run id, see the world's `ws.turn`), so its format is agex's:
 * a provider's message types are mapped to and from it at the edge and
 * never stored. Plain data with a `kind` on every part, read and written
 * as JSON; the field names are the world's camelCase, the `kind`s and
 * the meaning Python's.
 *
 * Every message has a stable `id`. Compaction anchors a fold on a
 * message id, so an id never changes once the message is stored.
 */

import type { RunStatus } from '@agex-ts/world'

/** The record's format version. Bumped only when a stored field changes
 *  meaning or goes away; an added optional field doesn't bump it. */
export const FORMAT = 1

/** A fresh message or run id. */
export function newId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

/** What a provider attached to a part that it needs back with it, by
 *  provider: a reasoning signature, an encrypted reasoning item, an
 *  item id. Kept as given, and sent back to the provider that wrote it. */
export type Details = Readonly<Record<string, unknown>>

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/** Prose: what a person said, or what the model replied. */
export interface Text {
  readonly kind: 'text'
  readonly text: string
  /** The provider's own id for it. */
  readonly id?: string | null
  readonly provider?: string | null
  readonly details?: Details | null
}

/** The model's reasoning, kept so it can be sent back. Some providers
 *  only take reasoning back with the `signature` they issued for it, and
 *  some carry more in `details`. `provider` names who wrote it: one
 *  provider's reasoning isn't sent to another. */
export interface Thinking {
  readonly kind: 'thinking'
  readonly text: string
  readonly signature?: string | null
  readonly id?: string | null
  readonly provider?: string | null
  readonly details?: Details | null
}

/** A tool call the model made. `callId` is the provider's id for it,
 *  which the matching {@link ToolResult} carries back; `id` is its id as
 *  an item of the reply, and `details` what else came with it (a
 *  signature on the call). Both go back with the call. */
export interface ToolCall {
  readonly kind: 'tool_call'
  readonly callId: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly id?: string | null
  readonly provider?: string | null
  readonly details?: Details | null
}

/** An image a tool returned for the model to see, base64-encoded. */
export interface Image {
  readonly kind: 'image'
  readonly data: string
  /** `image/png` and the like. */
  readonly mediaType: string
}

/** What a tool call returned, to the model. `images` are kept only
 *  where the model takes images. */
export interface ToolResult {
  readonly kind: 'tool_result'
  readonly callId: string
  readonly name: string
  readonly content: string
  readonly isError?: boolean
  readonly images?: readonly Image[]
}

export type Part = Text | Thinking | ToolCall | ToolResult

/** Who a message is from: `tool` messages hold tool results, and an
 *  `assistant` message is one model reply. */
export type Role = 'system' | 'user' | 'assistant' | 'tool'

// ---------------------------------------------------------------------------
// Messages and runs
// ---------------------------------------------------------------------------

/** What a model call cost, in tokens. */
export interface Usage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

export const NO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}

/**
 * One message of a run. An `assistant` message is one model reply, and
 * says which `model` (and `provider`) wrote it, what it cost, and the
 * anchor of the compaction fold in force in the request it answers
 * (`fold`), which is how a later request is measured from its usage.
 */
export interface Message {
  readonly id: string
  readonly role: Role
  readonly parts: readonly Part[]
  readonly model?: string | null
  readonly provider?: string | null
  readonly usage?: Usage | null
  readonly fold?: string | null
}

/** A message's prose: its text parts joined. */
export function messageText(message: Message): string {
  return message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
}

/**
 * One run: the messages a turn exchanged with the model, in order, and
 * how it ended (null while it runs). Times are milliseconds since the
 * epoch. `compaction` is what the run's summary calls cost, and
 * `compactionCalls` how many it made, which no message records.
 */
export interface Run {
  readonly format: number
  readonly runId: string
  readonly status: RunStatus | null
  readonly messages: readonly Message[]
  readonly startedAt?: number | null
  readonly endedAt?: number | null
  readonly compaction?: Usage | null
  readonly compactionCalls?: number | null
}

/** What a run's model calls cost, summed: its replies' and its summary
 *  calls'. */
export function runUsage(run: Run): Usage {
  let total = run.compaction ?? NO_USAGE
  for (const message of run.messages) if (message.usage) total = addUsage(total, message.usage)
  return total
}

/** A run as JSON data, the stored form. */
export function dumpRun(run: Run): unknown {
  return JSON.parse(JSON.stringify(run))
}

/**
 * A run read back from {@link dumpRun}'s output, checked.
 *
 * @throws RecordError for data that doesn't fit the format, naming
 *   where; including a format newer than this agex knows.
 */
export function loadRun(data: unknown): Run {
  const at = (path: string, why: string): never => {
    throw new RecordError(`run record${path}: ${why}`)
  }
  const obj = (v: unknown, path: string): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : at(path, 'not an object')
  const str = (v: unknown, path: string): string =>
    typeof v === 'string' ? v : at(path, 'not a string')
  const optStr = (v: unknown, path: string): string | null =>
    v === undefined || v === null ? null : str(v, path)
  const num = (v: unknown, path: string): number =>
    typeof v === 'number' && Number.isFinite(v) ? v : at(path, 'not a number')
  const optNum = (v: unknown, path: string): number | null =>
    v === undefined || v === null ? null : num(v, path)
  const bool = (v: unknown, path: string): boolean =>
    v === undefined || v === null ? false : typeof v === 'boolean' ? v : at(path, 'not a boolean')
  const arr = (v: unknown, path: string): unknown[] =>
    Array.isArray(v) ? v : at(path, 'not a list')
  const details = (v: unknown, path: string): Details | null =>
    v === undefined || v === null ? null : obj(v, path)
  const usage = (v: unknown, path: string): Usage | null => {
    if (v === undefined || v === null) return null
    const u = obj(v, path)
    return {
      inputTokens: num(u.inputTokens ?? 0, `${path}.inputTokens`),
      outputTokens: num(u.outputTokens ?? 0, `${path}.outputTokens`),
      cacheReadTokens: num(u.cacheReadTokens ?? 0, `${path}.cacheReadTokens`),
      cacheWriteTokens: num(u.cacheWriteTokens ?? 0, `${path}.cacheWriteTokens`),
    }
  }
  const image = (v: unknown, path: string): Image => {
    const i = obj(v, path)
    if (i.kind !== 'image') at(`${path}.kind`, `not 'image'`)
    return {
      kind: 'image',
      data: str(i.data, `${path}.data`),
      mediaType: str(i.mediaType, `${path}.mediaType`),
    }
  }
  const part = (v: unknown, path: string): Part => {
    const p = obj(v, path)
    const common = {
      id: optStr(p.id, `${path}.id`),
      provider: optStr(p.provider, `${path}.provider`),
      details: details(p.details, `${path}.details`),
    }
    switch (p.kind) {
      case 'text':
        return { kind: 'text', text: str(p.text, `${path}.text`), ...common }
      case 'thinking':
        return {
          kind: 'thinking',
          text: str(p.text, `${path}.text`),
          signature: optStr(p.signature, `${path}.signature`),
          ...common,
        }
      case 'tool_call':
        return {
          kind: 'tool_call',
          callId: str(p.callId, `${path}.callId`),
          name: str(p.name, `${path}.name`),
          args: obj(p.args ?? {}, `${path}.args`),
          ...common,
        }
      case 'tool_result':
        return {
          kind: 'tool_result',
          callId: str(p.callId, `${path}.callId`),
          name: str(p.name, `${path}.name`),
          content: str(p.content, `${path}.content`),
          isError: bool(p.isError, `${path}.isError`),
          images: arr(p.images ?? [], `${path}.images`).map((x, i) =>
            image(x, `${path}.images[${i}]`),
          ),
        }
      default:
        return at(`${path}.kind`, `unknown part kind ${JSON.stringify(p.kind)}`)
    }
  }
  const ROLES: readonly string[] = ['system', 'user', 'assistant', 'tool']
  const message = (v: unknown, path: string): Message => {
    const m = obj(v, path)
    const role = str(m.role, `${path}.role`)
    if (!ROLES.includes(role)) at(`${path}.role`, `unknown role ${JSON.stringify(role)}`)
    return {
      id: str(m.id, `${path}.id`),
      role: role as Role,
      parts: arr(m.parts, `${path}.parts`).map((x, i) => part(x, `${path}.parts[${i}]`)),
      model: optStr(m.model, `${path}.model`),
      provider: optStr(m.provider, `${path}.provider`),
      usage: usage(m.usage, `${path}.usage`),
      fold: optStr(m.fold, `${path}.fold`),
    }
  }
  const r = obj(data, '')
  const format = r.format ?? FORMAT
  if (typeof format !== 'number' || !Number.isInteger(format) || format > FORMAT) {
    at('.format', `format ${JSON.stringify(format)} is newer than ${FORMAT}`)
  }
  const status = r.status ?? null
  const STATUSES: readonly unknown[] = [null, 'completed', 'cancelled', 'interrupted', 'failed']
  if (!STATUSES.includes(status)) at('.status', `unknown status ${JSON.stringify(status)}`)
  return {
    format: FORMAT,
    runId: str(r.runId, '.runId'),
    status: status as RunStatus | null,
    messages: arr(r.messages, '.messages').map((x, i) => message(x, `.messages[${i}]`)),
    startedAt: optNum(r.startedAt, '.startedAt'),
    endedAt: optNum(r.endedAt, '.endedAt'),
    compaction: usage(r.compaction, '.compaction'),
    compactionCalls: optNum(r.compactionCalls, '.compactionCalls'),
  }
}

/** Stored data that doesn't fit the run record's format. */
export class RecordError extends Error {
  override readonly name: string = 'RecordError'
}
