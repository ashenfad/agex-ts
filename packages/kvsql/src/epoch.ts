/**
 * Epochs: a database's log as a series of branches, each but the first
 * starting from a snapshot of the whole database, so the log behind it
 * can go.
 *
 * A log on branch `<log>/<n>` is epoch `n` of log `<log>`, and its next
 * epoch is branch `<log>/<n+1>`. A branch whose name doesn't end in
 * `/<n>` is a log of one epoch, which never starts another.
 *
 * An epoch's branch starts from the root commit. Its first commits hold
 * the snapshot: the database file (compacted, without its pending
 * transactions), gzipped and cut into {@link SNAPSHOT_CHUNK}-byte
 * chunks under `snapshot/<i>`, {@link CHUNKS_PER_COMMIT} to a commit,
 * so a sync can send a snapshot of any size as a run of requests of a
 * few chunks each. The last of them also holds the snapshot's record
 * under {@link EPOCH_KEY}, and its commit info says it is the last
 * (`snapshot.last`): a branch whose tip is an earlier one is an epoch
 * that never finished. Every later commit is a log entry, as on any log
 * branch, and the snapshot's keys stay in its tree as they were.
 */

import {
  ROOT_COMMIT,
  type Repo,
  UnknownBranchError,
  type Worktree,
  cborCodec,
} from '@agex-ts/kvgit'
import { deleteCheckpoints } from './checkpoint'
import { MAGIC_BYTES, deleteDatabaseFiles } from './database'
import { sha256Hex } from './entry'
import { CorruptSnapshotError } from './errors'
import type { Directory, SyncFile } from './files'

/** The size of a snapshot's chunks, but its last. */
export const SNAPSHOT_CHUNK = 8 << 20

/** How many chunks each of a snapshot's commits holds (its last, fewer). */
export const CHUNKS_PER_COMMIT = 2

/** The key a snapshot's record is under. */
export const EPOCH_KEY = 'epoch'

/** The key of a snapshot's `i`th chunk. */
export const chunkKey = (i: number): string => `snapshot/${i}`

/** How many bytes of the file a snapshot reads, and a restore writes, at a time. */
const IO_CHUNK = 1 << 20

/** What a snapshot records about itself, under {@link EPOCH_KEY}. */
export interface SnapshotRecord {
  v: 1
  /** The last transaction the snapshot holds (0 for none). */
  seq: number
  /** Its schema version. */
  schema: number
  /** The database file's size. */
  bytes: number
  /** The gzipped size: the chunks' total. */
  gzipped: number
  /** The SHA-256 of each chunk, lowercase hex. */
  digests: string[]
  /**
   * The epoch it was taken from, where that epoch's log stood in the
   * file then, and the SHA-256 of the file's pending transactions then
   * encoded as one entry (null for none): so a file left there by a
   * crash before it moved over, and only that file, can finish the
   * move. Null for none.
   */
  previous: { branch: string; base: string; pending: string | null } | null
}

/** A snapshot commit's info. */
export interface SnapshotInfo {
  v: 1
  snapshot: { seq: number; schema: number; last: boolean }
}

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0

/** A commit's info as a {@link SnapshotInfo}, or undefined if it isn't one. */
export function parseSnapshotInfo(info: unknown): SnapshotInfo | undefined {
  if (info === null || typeof info !== 'object') return undefined
  const { v, snapshot } = info as { v?: unknown; snapshot?: unknown }
  if (v !== 1 || snapshot === null || typeof snapshot !== 'object') return undefined
  const { seq, schema, last } = snapshot as Record<string, unknown>
  if (!isCount(seq) || !isCount(schema) || typeof last !== 'boolean') return undefined
  return { v, snapshot: { seq, schema, last } }
}

function decodeRecord(bytes: unknown, commit: string): SnapshotRecord {
  const corrupt = (message: string) => new CorruptSnapshotError(commit, message)
  if (!(bytes instanceof Uint8Array)) throw corrupt('the commit holds no snapshot record')
  let raw: Record<string, unknown>
  try {
    raw = cborCodec.decode(bytes) as Record<string, unknown>
  } catch (err) {
    throw corrupt(`its record doesn't decode: ${err instanceof Error ? err.message : String(err)}`)
  }
  const { v, seq, schema, bytes: size, gzipped, digests, previous } = raw ?? {}
  const prev = previous as
    | { branch?: unknown; base?: unknown; pending?: unknown }
    | null
    | undefined
  if (
    v !== 1 ||
    !isCount(seq) ||
    !isCount(schema) ||
    !isCount(size) ||
    !isCount(gzipped) ||
    !Array.isArray(digests) ||
    !digests.every((d) => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d)) ||
    (prev !== null &&
      (typeof prev?.branch !== 'string' ||
        typeof prev.base !== 'string' ||
        (prev.pending !== null && typeof prev.pending !== 'string')))
  ) {
    throw corrupt('its record is malformed')
  }
  return {
    v,
    seq,
    schema,
    bytes: size,
    gzipped,
    digests: digests as string[],
    previous:
      prev === null
        ? null
        : {
            branch: prev.branch as string,
            base: prev.base as string,
            pending: prev.pending as string | null,
          },
  }
}

// --- Naming ---

/** Branch `<log>/<n>` as its log and epoch number, or null if it isn't named for epochs. */
export function parseEpoch(branch: string): { log: string; n: number } | null {
  const match = /^(.+)\/(0|[1-9][0-9]*)$/.exec(branch)
  if (!match) return null
  const n = Number(match[2])
  return Number.isSafeInteger(n) ? { log: match[1] as string, n } : null
}

/** Epoch `n` of log `log`: branch `<log>/<n>`. */
export function epochBranch(log: string, n: number): string {
  return `${log}/${n}`
}

/** The epochs of log `log` in `repo`, newest first. */
export async function epochsOf(
  repo: Repo<Uint8Array>,
  log: string,
): Promise<{ branch: string; n: number }[]> {
  const prefix = `${log}/`
  const out: { branch: string; n: number }[] = []
  for (const branch of await repo.branches.list()) {
    if (!branch.startsWith(prefix)) continue
    const parsed = parseEpoch(branch)
    if (parsed?.log === log) out.push({ branch, n: parsed.n })
  }
  return out.sort((a, b) => b.n - a.n)
}

/**
 * The epoch of `branch`'s log a database on it opens: the newest
 * finished one from `branch`'s on. A database whose log moved to a new
 * epoch follows it there, whatever branch it was asked for by, and so
 * does one whose file is gone. An epoch that didn't finish is passed
 * over; `branch` itself always counts, even if it is missing or empty.
 */
export async function currentEpoch(repo: Repo<Uint8Array>, branch: string): Promise<string> {
  const parsed = parseEpoch(branch)
  if (!parsed) return branch
  for (const epoch of await epochsOf(repo, parsed.log)) {
    if (epoch.n < parsed.n) break
    if (epoch.n === parsed.n || (await finished(repo, epoch.branch))) return epoch.branch
  }
  return branch
}

/** Whether `branch` is an epoch whose snapshot was committed whole (or one with none). */
export async function finished(repo: Repo<Uint8Array>, branch: string): Promise<boolean> {
  let tip: string
  try {
    tip = await repo.branches.get(branch)
  } catch (err) {
    if (err instanceof UnknownBranchError) return false
    throw err
  }
  if (tip === ROOT_COMMIT) return false
  return parseSnapshotInfo((await repo.getCommit(tip)).info)?.snapshot.last !== false
}

/**
 * The branch a restore of log `log` rebuilds the database from, at a
 * checkpoint (`<log>/restore`, which no epoch's branch is), for as long
 * as the rebuild takes.
 */
export function restoreBranch(log: string): string {
  return `${log}/restore`
}

/**
 * The branch a rebase of log `log` builds the database's new line on
 * (`<log>/rebase`, which no epoch's branch is): from the commit it
 * rebases onto, with this database's own entries after it, until the
 * log's branch moves there.
 */
export function rebaseBranch(log: string): string {
  return `${log}/rebase`
}

/**
 * The tag a rebase of log `log` marks the log's branch's head with
 * (`kvsql/rebase/<log>`) while it runs: the head the branch moves from,
 * which only a rebase interrupted after the file committed needs, to
 * move the branch on from there and nowhere else.
 */
export function rebaseTag(log: string): string {
  return `kvsql/rebase/${log}`
}

/**
 * Delete the log on `branch`: `branch`, every other epoch of its log,
 * its checkpoints, and a restore's or rebase's branch (and a rebase's
 * tag) left by a crash.
 * Deleting a log that's gone does nothing.
 */
export async function deleteLog(repo: Repo<Uint8Array>, branch: string): Promise<void> {
  const parsed = parseEpoch(branch)
  const log = parsed?.log ?? branch
  await deleteCheckpoints(repo, log)
  const branches = parsed ? (await epochsOf(repo, parsed.log)).map((e) => e.branch) : []
  // the branch asked for, if the log hasn't moved on from it; a
  // restore's or rebase's, if a crash left it
  for (const extra of [branch, restoreBranch(log), rebaseBranch(log)]) {
    if (!branches.includes(extra) && (await repo.branches.has(extra))) branches.push(extra)
  }
  if (await repo.tags.has(rebaseTag(log))) await repo.tags.delete(rebaseTag(log))
  for (const name of branches) {
    try {
      await repo.branches.delete(name)
    } catch (err) {
      if (!(err instanceof UnknownBranchError)) throw err
    }
  }
}

// --- Snapshots ---

/** The snapshot at `tip`'s branch, by the record in `tip`'s tree, or null if it has none. */
export async function readSnapshot(
  repo: Repo<Uint8Array>,
  tip: string,
): Promise<SnapshotRecord | null> {
  if (tip === ROOT_COMMIT) return null
  const bytes = await (await repo.snapshot({ commit: tip })).get(EPOCH_KEY)
  return bytes === undefined || bytes === null ? null : decodeRecord(bytes, tip)
}

/**
 * The last commit of the snapshot behind `tip`, where its epoch's log
 * starts: walked back from `tip`, past every log entry.
 */
export async function snapshotCommit(repo: Repo<Uint8Array>, tip: string): Promise<string> {
  let commit = tip
  while (commit !== ROOT_COMMIT) {
    const record = await repo.getCommit(commit)
    if (parseSnapshotInfo(record.info)?.snapshot.last === true) return commit
    commit = record.parents[0] ?? ROOT_COMMIT
  }
  throw new CorruptSnapshotError(tip, 'its branch holds a snapshot record, but no snapshot commit')
}

/** What a snapshot's file was taken at. */
export interface SnapshotOf {
  seq: number
  schema: number
  previous: SnapshotRecord['previous']
}

/**
 * Commit the database file `source` (open, not written meanwhile) as
 * the snapshot of new epoch `branch`, which must be empty: gzipped,
 * chunked and checksummed. Returns the branch's worktree, its head the
 * snapshot's last commit, and the snapshot's record.
 */
export async function writeSnapshot(
  repo: Repo<Uint8Array>,
  branch: string,
  source: SyncFile,
  of: SnapshotOf,
): Promise<{ wt: Worktree<Uint8Array>; record: SnapshotRecord }> {
  const wt = await repo.worktree(branch, { create: true })
  if (wt.head !== ROOT_COMMIT) throw new Error(`the new epoch's branch '${branch}' isn't empty`)
  const size = source.size()
  const gzip = new CompressionStream('gzip')
  const writer = gzip.writable.getWriter()
  const reading = (async () => {
    try {
      for (let at = 0; at < size; at += IO_CHUNK) {
        const part = new Uint8Array(Math.min(IO_CHUNK, size - at))
        if (source.read(part, at) !== part.byteLength) {
          throw new Error('the snapshot file ended while it was being read')
        }
        await writer.write(part)
      }
      await writer.close()
    } catch (err) {
      await writer.abort(err).catch(() => {})
      throw err
    }
  })()

  const info = (last: boolean): SnapshotInfo => ({
    v: 1,
    snapshot: { seq: of.seq, schema: of.schema, last },
  })
  const digests: string[] = []
  let gzipped = 0
  let inCommit = 0
  const emit = async (chunk: Uint8Array) => {
    const i = digests.length
    digests.push(await sha256Hex(chunk))
    gzipped += chunk.byteLength
    wt.set(chunkKey(i), chunk)
    if (++inCommit === CHUNKS_PER_COMMIT) {
      await wt.commit({ info: { ...info(false) }, onMoved: 'raise' })
      inCommit = 0
    }
  }
  const writing = (async () => {
    const reader = gzip.readable.getReader()
    let chunk = new Uint8Array(SNAPSHOT_CHUNK)
    let fill = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        let from = 0
        while (from < value.byteLength) {
          const n = Math.min(value.byteLength - from, SNAPSHOT_CHUNK - fill)
          chunk.set(value.subarray(from, from + n), fill)
          fill += n
          from += n
          if (fill === SNAPSHOT_CHUNK) {
            await emit(chunk)
            chunk = new Uint8Array(SNAPSHOT_CHUNK)
            fill = 0
          }
        }
      }
    } catch (err) {
      // the reading side stops at its next write
      await reader.cancel(err).catch(() => {})
      throw err
    }
    if (fill > 0) {
      const i = digests.length
      const last = chunk.slice(0, fill)
      digests.push(await sha256Hex(last))
      gzipped += fill
      wt.set(chunkKey(i), last)
    }
  })()
  try {
    await Promise.all([reading, writing])
  } catch (err) {
    wt.discard()
    throw err
  }
  const record: SnapshotRecord = {
    v: 1,
    seq: of.seq,
    schema: of.schema,
    bytes: size,
    gzipped,
    digests,
    previous: of.previous,
  }
  wt.set(EPOCH_KEY, cborCodec.encode(record))
  await wt.commit({ info: { ...info(true) }, onMoved: 'raise' })
  return { wt, record }
}

/**
 * Write the snapshot whose last commit is `commit` as the database
 * `name` in `dir`, replacing any there, which must not be open: each
 * chunk checked against its digest, the whole against gzip's own check
 * and the file's recorded size. The magic string goes last
 * (`MAGIC_BYTES`), so a restore cut short leaves a file SQLite reads as
 * no database at all.
 */
export async function restoreSnapshot(
  repo: Repo<Uint8Array>,
  commit: string,
  record: SnapshotRecord,
  dir: Directory,
  name: string,
): Promise<void> {
  const corrupt = (message: string, cause?: unknown) =>
    new CorruptSnapshotError(commit, message, cause === undefined ? undefined : { cause })
  const tree = await repo.snapshot({ commit })
  await deleteDatabaseFiles(dir, name)
  const into = await dir.open(name)
  // Failures of the store or the file, rather than of the snapshot.
  const own = new Set<unknown>()
  const io = <T>(fn: () => T | Promise<T>): Promise<T> =>
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        own.add(err)
        throw err
      })
  try {
    const gunzip = new DecompressionStream('gzip')
    const writer = gunzip.writable.getWriter()
    const reading = (async () => {
      try {
        for (const [i, digest] of record.digests.entries()) {
          const chunk = await io(() => tree.get(chunkKey(i)))
          if (!(chunk instanceof Uint8Array)) throw corrupt(`its chunk ${i} is missing`)
          if ((await sha256Hex(chunk)) !== digest) {
            throw corrupt(`its chunk ${i}'s SHA-256 doesn't match the digest its record holds`)
          }
          await writer.write(chunk as Uint8Array<ArrayBuffer>)
        }
        await writer.close()
      } catch (err) {
        await writer.abort(err).catch(() => {})
        throw err
      }
    })()
    const head = new Uint8Array(Math.min(MAGIC_BYTES, record.bytes))
    let at = 0
    const writing = (async () => {
      const reader = gunzip.readable.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (at + value.byteLength > record.bytes) {
            throw corrupt(`it holds more than the ${record.bytes} bytes its record says`)
          }
          const inHead = Math.max(0, Math.min(value.byteLength, head.byteLength - at))
          if (inHead > 0) head.set(value.subarray(0, inHead), at)
          if (inHead < value.byteLength) {
            await io(() => into.write(value.subarray(inHead), at + inHead))
          }
          at += value.byteLength
        }
      } catch (err) {
        await reader.cancel(err).catch(() => {})
        throw err
      }
    })()
    try {
      await Promise.all([reading, writing])
    } catch (err) {
      if (err instanceof CorruptSnapshotError || own.has(err)) throw err
      throw corrupt(
        `it doesn't decompress: ${err instanceof Error ? err.message : String(err)}`,
        err,
      )
    }
    if (at !== record.bytes) {
      throw corrupt(`it holds ${at} bytes, but its record says ${record.bytes}`)
    }
    into.sync()
    into.write(head, 0)
    into.sync()
  } finally {
    into.close()
  }
}
