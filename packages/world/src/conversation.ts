/**
 * The conversation: what a harness remembers, kept in the session's
 * branch beside the files, so a commit holds both, a checkout rewinds
 * both, and a fork carries both (or, fresh, only the files).
 *
 * Harness-neutral. The world keeps an index; the rest is the harness's
 * own format:
 *
 * | key | value |
 * |---|---|
 * | `__conversation__/index` | {@link ConversationIndex}: the harness, the session, the runs in order |
 * | `__conversation__/record` | the harness's record of the session, opaque |
 * | `__conversation__/runs/<id>` | one run's body, in the harness's format |
 *
 * A branch holds one harness's conversation; another harness can't add
 * a run to it.
 */

import { WorldError } from './errors'
import type { KeyReader, KeyWriter } from './fs'
import { COMPACTION_PREFIX, CONVERSATION_PREFIX } from './layout'

export const CONVERSATION_INDEX_KEY = `${CONVERSATION_PREFIX}index`
export const CONVERSATION_RECORD_KEY = `${CONVERSATION_PREFIX}record`
export const CONVERSATION_RUN_PREFIX = `${CONVERSATION_PREFIX}runs/`

/** The format of the index this world writes. */
export const CONVERSATION_FORMAT = 1

export interface ConversationIndex {
  readonly format: number
  /** The harness whose conversation this is. */
  readonly harness: string
  /** The session the conversation belongs to; a fork or a checkout of
   *  another session's commit names its new one. */
  readonly session: string | null
  /** The runs' ids, oldest first. */
  readonly runs: readonly string[]
  /** The session this one's conversation was forked from. */
  readonly forkedFrom: string | null
}

/** A run added to a conversation another harness wrote. */
export class HarnessMismatchError extends WorldError {
  override readonly name: string = 'HarnessMismatchError'
}

const runKey = (id: string): string => `${CONVERSATION_RUN_PREFIX}${id}`

function asIndex(value: unknown): ConversationIndex | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  return {
    format: typeof v.format === 'number' ? v.format : CONVERSATION_FORMAT,
    harness: typeof v.harness === 'string' ? v.harness : '',
    session: typeof v.session === 'string' ? v.session : null,
    runs: Array.isArray(v.runs) ? v.runs.filter((r): r is string => typeof r === 'string') : [],
    forkedFrom: typeof v.forkedFrom === 'string' ? v.forkedFrom : null,
  }
}

/** The conversation's index, or null for a branch with none. */
export async function readIndex(kv: KeyReader): Promise<ConversationIndex | null> {
  return asIndex(await kv.get(CONVERSATION_INDEX_KEY))
}

/** The harness's record, or undefined when there is none. */
export async function readRecord(kv: KeyReader): Promise<unknown> {
  return kv.get(CONVERSATION_RECORD_KEY)
}

/** The bodies of the runs asked for that exist, by id. */
export async function readRuns(
  kv: KeyReader,
  ids: Iterable<string>,
): Promise<Map<string, unknown>> {
  const wanted = [...ids]
  const found = await kv.getMany(wanted.map(runKey))
  const out = new Map<string, unknown>()
  for (const id of wanted) {
    const body = found.get(runKey(id))
    if (body !== undefined) out.set(id, body)
  }
  return out
}

export interface WriteConversation {
  /** The record: a value to store, null to delete it, or leave it as
   *  it is (omitted). */
  readonly record?: unknown
  /** Run bodies to store, by id. */
  readonly runs?: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>
  /** Runs whose bodies to delete. */
  readonly drop?: Iterable<string>
}

/** Stage the index, and the record and run bodies given. */
export async function writeConversation(
  kv: KeyWriter,
  index: ConversationIndex,
  opts: WriteConversation = {},
): Promise<void> {
  kv.set(CONVERSATION_INDEX_KEY, { ...index, runs: [...index.runs] })
  if ('record' in opts) {
    if (opts.record === null) await kv.delete(CONVERSATION_RECORD_KEY)
    else kv.set(CONVERSATION_RECORD_KEY, opts.record)
  }
  const runs = opts.runs instanceof Map ? opts.runs : new Map(Object.entries(opts.runs ?? {}))
  for (const [id, body] of runs) kv.set(runKey(id), body)
  for (const id of opts.drop ?? []) await kv.delete(runKey(id))
}

/**
 * Add a run to the conversation (or replace its body, for a resumed
 * run), creating the index if there is none.
 *
 * @throws HarnessMismatchError when another harness wrote the
 *   conversation.
 */
export async function storeRun(
  kv: KeyWriter,
  session: string,
  harness: string,
  runId: string,
  opts: { body?: unknown; record?: unknown } = {},
): Promise<void> {
  const current = await readIndex(kv)
  if (current !== null && current.harness !== '' && current.harness !== harness) {
    throw new HarnessMismatchError(
      `this branch holds a conversation ${current.harness} wrote; ${harness} cannot add a run to it`,
    )
  }
  const runs = current?.runs ?? []
  const index: ConversationIndex = {
    format: CONVERSATION_FORMAT,
    harness,
    session: current?.session ?? session,
    runs: runs.includes(runId) ? runs : [...runs, runId],
    forkedFrom: current?.forkedFrom ?? null,
  }
  await writeConversation(kv, index, {
    ...(opts.body !== undefined && { runs: new Map([[runId, opts.body]]) }),
    ...('record' in opts && { record: opts.record }),
  })
}

/** For a full fork: the conversation is now `child`'s, forked from the
 *  session it named (or `parent`). False when there's nothing to do. */
export async function rebindConversation(
  kv: KeyWriter,
  child: string,
  parent: string,
): Promise<boolean> {
  const index = await readIndex(kv)
  if (index === null || index.session === child) return false
  await writeConversation(kv, { ...index, session: child, forkedFrom: index.session ?? parent })
  return true
}

/** For a checkout of a commit whose conversation names another session
 *  (from before a fork): the conversation is `session`'s again, its
 *  lineage `lineage` (else the session it named). False when it already
 *  is. */
export async function reclaimConversation(
  kv: KeyWriter,
  session: string,
  lineage: string | null,
): Promise<boolean> {
  const index = await readIndex(kv)
  if (index === null || index.session === null || index.session === session) return false
  await writeConversation(kv, {
    ...index,
    session,
    forkedFrom: lineage ?? index.session,
  })
  return true
}

/** Delete the conversation and compaction's record: a fresh start. */
export async function wipeConversation(kv: KeyWriter): Promise<boolean> {
  let changed = false
  for (const key of await kv.keys()) {
    if (key.startsWith(CONVERSATION_PREFIX) || key.startsWith(COMPACTION_PREFIX)) {
      changed = (await kv.delete(key)) || changed
    }
  }
  return changed
}

/** A workspace's conversation as a harness reads it: pending changes
 *  included, so it reads what the turn so far has stored. */
export class WorkspaceConversation {
  readonly #kv: KeyReader

  /** @internal Made by the workspace. */
  constructor(kv: KeyReader) {
    this.#kv = kv
  }

  index(): Promise<ConversationIndex | null> {
    return readIndex(this.#kv)
  }

  record(): Promise<unknown> {
    return readRecord(this.#kv)
  }

  /** The bodies of the runs asked for that exist, by id; all the
   *  index's runs, in order, when none are named. */
  async runs(ids?: Iterable<string>): Promise<Map<string, unknown>> {
    return readRuns(this.#kv, ids ?? (await this.index())?.runs ?? [])
  }
}
