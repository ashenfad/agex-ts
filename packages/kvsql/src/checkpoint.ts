/**
 * Checkpoints: named positions in a database's log, to restore to.
 *
 * A checkpoint is a kvgit tag on the log commit whose entry ends at
 * the position, so it holds every transaction through it, flushed
 * first. Its tag is `kvsql/checkpoint/<log>/<seq>-<random>`, `<log>`
 * the log's name without its epoch (`db/abc` for `db/abc/3`), so a
 * log's checkpoints outlive its epochs; and the tag's info records
 * what it is ({@link CheckpointInfo}). A tag keeps its commit, and
 * everything that commit descends from, from being collected: a
 * checkpoint on an epoch since replaced keeps that epoch's snapshot and
 * log (but not its branch) until the checkpoint is deleted.
 */

import { type Repo, UnknownTagError } from '@agex-ts/kvgit'
import { parseEpoch } from './epoch'
import { LogError } from './errors'

/** The prefix of every checkpoint's tag. */
export const CHECKPOINT_PREFIX = 'kvsql/checkpoint/'

/** A checkpoint of a database. */
export interface Checkpoint {
  /** Its id: its tag's name. */
  id: string
  /** What it was taken for. */
  label: string
  /** Whether the database took it itself, before a schema change. */
  auto: boolean
  /** The last transaction it holds. */
  seq: number
  /** The schema version there. */
  schema: number
  /** When it was taken, in milliseconds since the Unix epoch. */
  time: number
  /** The log commit it names. */
  commit: string
}

/** What a checkpoint's tag records, as its info. */
export interface CheckpointInfo {
  v: 1
  checkpoint: { seq: number; schema: number; label: string; auto: boolean; time: number }
}

/** The name of the log on `branch`: without its epoch, if it has epochs. */
export function logName(branch: string): string {
  return parseEpoch(branch)?.log ?? branch
}

/** The tag prefix of log `log`'s checkpoints. */
function prefixOf(log: string): string {
  return `${CHECKPOINT_PREFIX}${log}/`
}

/** Whether tag `tag` is one of log `log`'s checkpoints, not a log's nested under it. */
function isOf(tag: string, log: string): boolean {
  const prefix = prefixOf(log)
  return tag.startsWith(prefix) && /^[0-9]+-[0-9a-z]+$/.test(tag.slice(prefix.length))
}

/** A new checkpoint id for log `log` at transaction `seq`. */
export function checkpointId(log: string, seq: number): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) =>
    b.toString(36).padStart(2, '0'),
  ).join('')
  return `${prefixOf(log)}${seq}-${random}`
}

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0

function parseInfo(info: unknown): CheckpointInfo['checkpoint'] | undefined {
  if (info === null || typeof info !== 'object') return undefined
  const { v, checkpoint } = info as { v?: unknown; checkpoint?: unknown }
  if (v !== 1 || checkpoint === null || typeof checkpoint !== 'object') return undefined
  const { seq, schema, label, auto, time } = checkpoint as Record<string, unknown>
  if (
    !isCount(seq) ||
    !isCount(schema) ||
    typeof label !== 'string' ||
    typeof auto !== 'boolean' ||
    !isCount(time)
  ) {
    return undefined
  }
  return { seq, schema, label, auto, time }
}

/**
 * Log `log`'s checkpoint `id`.
 *
 * @throws LogError if there's no such checkpoint of this log.
 */
export async function readCheckpoint(
  repo: Repo<Uint8Array>,
  log: string,
  id: string,
): Promise<Checkpoint> {
  const missing = () => new LogError(`there's no checkpoint ${JSON.stringify(id)} of this database`)
  if (!isOf(id, log)) throw missing()
  let tag: Awaited<ReturnType<Repo<Uint8Array>['tags']['info']>>
  try {
    tag = await repo.tags.info(id)
  } catch (err) {
    if (err instanceof UnknownTagError) throw missing()
    throw err
  }
  const info = parseInfo(tag.info)
  if (!info || tag.dangling) {
    throw new LogError(
      `checkpoint ${JSON.stringify(id)} is damaged: its tag's record is missing or malformed, or its commit is gone`,
    )
  }
  return { id, ...info, commit: tag.commit }
}

/** Log `log`'s checkpoints, oldest first; a damaged one is left out. */
export async function listCheckpoints(repo: Repo<Uint8Array>, log: string): Promise<Checkpoint[]> {
  const out: Checkpoint[] = []
  for (const id of await repo.tags.list()) {
    if (!isOf(id, log)) continue
    try {
      out.push(await readCheckpoint(repo, log, id))
    } catch (err) {
      if (!(err instanceof LogError)) throw err
    }
  }
  return out.sort((a, b) => a.seq - b.seq || a.time - b.time)
}

/** Delete checkpoint `id` of log `log`, if it's there. */
export async function deleteCheckpoint(
  repo: Repo<Uint8Array>,
  log: string,
  id: string,
): Promise<void> {
  if (!isOf(id, log))
    throw new LogError(`${JSON.stringify(id)} isn't a checkpoint of this database`)
  try {
    await repo.tags.delete(id)
  } catch (err) {
    if (!(err instanceof UnknownTagError)) throw err
  }
}

/** Delete every checkpoint of log `log`, damaged ones too. */
export async function deleteCheckpoints(repo: Repo<Uint8Array>, log: string): Promise<void> {
  for (const id of await repo.tags.list()) {
    if (isOf(id, log)) await deleteCheckpoint(repo, log, id)
  }
}
