/**
 * The logged database: SQLite on a file of a `Directory`, with every
 * transaction's changes recorded in the file and flushed, in batches,
 * to a changeset log on a kvgit branch.
 *
 * A call is one transaction. Its changes are recorded as a changeset
 * (or, for a schema change, as its SQL) and written into the file's
 * pending table inside that same transaction, so the file's COMMIT
 * alone makes the call durable on this device. A flush later commits
 * every pending transaction to the log as one entry, one kvgit commit,
 * then deletes them from the file and records the entry's commit as
 * the file's base.
 *
 * Opening reconciles the two. Log entries after the file's base that
 * this file didn't write are replayed into it, so opening an empty
 * directory against an existing branch rebuilds the database. An entry
 * whose range, length and digest match the file's pending transactions
 * is the file's own flush, which crashed before its delete: those
 * transactions are dropped from the pending table instead.
 *
 * A log on a branch named `<log>/<n>` has epochs (`epoch.ts`): a new
 * epoch is a new branch starting from a snapshot of the database, onto
 * which the database moves, its old epoch deleted, so the log behind it
 * doesn't grow without end. Opening follows the log to its newest
 * epoch, and a file that is missing, or behind on an older epoch, is
 * rebuilt from the snapshot.
 */

import {
  BranchMovedError,
  type Commit,
  ROOT_COMMIT,
  type Repo,
  UnknownBranchError,
  UnknownCommitError,
  type Worktree,
  publishHead,
} from '@agex-ts/kvgit'
import type { Database, SqlValue, Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import {
  type Conflict,
  INTERNAL_TABLE_PREFIX,
  type Session,
  applyChangeset,
  changesetTables,
  combineChangesets,
  invertChangeset,
  startSession,
} from './changeset'
import {
  type Checkpoint,
  checkpointId,
  deleteCheckpoint,
  listCheckpoints,
  logName,
  readCheckpoint,
} from './checkpoint'
import {
  type DatabaseFile,
  checkDatabaseName,
  copyDatabase,
  deleteDatabaseFiles,
  openDatabaseFile,
  rebaseName,
  reclaimPages,
  restoreName,
  snapshotName,
  vacuumInto,
} from './database'
import {
  ENTRY_KEY,
  type EntryInfo,
  type ItemKind,
  type Params,
  type PendingItem,
  type Piece,
  type Statement,
  decodeEntry,
  decodeSqlBody,
  encodeEntry,
  encodePieces,
  encodeSqlBody,
  entryInfo,
  parseEntryInfo,
  pieceOf,
  renumber,
  schemaAfter,
  sha256Hex,
} from './entry'
import {
  type SnapshotRecord,
  currentEpoch,
  deleteOlderEpochs,
  epochBranch,
  epochsOf,
  finished,
  parseEpoch,
  parseSnapshotInfo,
  readSnapshot,
  rebaseBranch,
  rebaseTag,
  restoreBranch,
  restoreSnapshot,
  snapshotCommit,
  writeSnapshot,
} from './epoch'
import {
  CorruptEntryError,
  DivergedError,
  KvsqlError,
  LogError,
  RebaseRequiredError,
  RefusedError,
  ReplayError,
  StatementError,
} from './errors'
import type { Directory } from './files'
import { type SchemaGuard, checkSchema, installGuard } from './guard'
import { contentHash } from './hash'
import { loadSqlite } from './sqlite'

export type { Params, Statement } from './entry'

/** When a database flushes its pending transactions to the log. */
export interface FlushPolicy {
  /** Flush once this many transactions are pending. Default 100; 0: never by count. */
  every?: number
  /**
   * Flush when the oldest pending transaction is this many
   * milliseconds old. Default 2000; 0: never by age.
   */
  maxAgeMs?: number
}

/**
 * When a database starts a new epoch by itself (see `epoch.ts`): once
 * its epoch's log has grown large next to the epoch's snapshot, or one
 * transaction is (an import, which then goes into the snapshot rather
 * than the log). `newEpoch()` starts one any time.
 */
export interface EpochPolicy {
  /**
   * The size, as a fraction of the snapshot's gzipped size, the log, or
   * one transaction, reaches to start an epoch. Default 0.5; 0: never.
   */
  ratio?: number
  /**
   * The size the log, or one transaction, reaches first in any case, in
   * bytes. Default 8 MiB. A log's first epoch has no snapshot, so this
   * alone starts its second.
   */
  minBytes?: number
}

export interface LogOptions {
  /** The directory holding the database file. */
  dir: Directory
  /** The database file's name in `dir`. */
  name: string
  /**
   * The kvgit repository holding the log. Its codec must store a
   * `Uint8Array` as it is (`'bytes'`, the default).
   */
  repo: Repo<Uint8Array>
  /**
   * The log's branch, created if missing. A database file belongs to
   * one branch, and refuses to open against another.
   */
  branch: string
  /** How error messages name the database, e.g. `'agex.db'`. */
  label?: string
  /**
   * `PRAGMA foreign_keys` for the connection. Default true: an app
   * that declares REFERENCES expects them enforced, and a replay or
   * merge only detects a broken foreign key when they are. Schema
   * changes record the setting they ran under, and replay runs them
   * under the same one.
   */
  foreignKeys?: boolean
  flush?: FlushPolicy
  /**
   * Called with the error when a flush the policy started (by count,
   * by age, after a schema change, or on close) fails. The
   * transactions stay pending in the file, and the next flush retries
   * them. Explicit `flush()` calls throw instead.
   */
  onFlushError?: (err: unknown) => void
  /**
   * How many of the checkpoints the database takes itself, one before
   * each schema change, it keeps: the oldest go past this many. Default
   * 10; 0: it takes none. Checkpoints taken with `checkpoint()` are
   * kept until deleted.
   */
  autoCheckpoints?: number
  /**
   * When to start a new epoch by itself; false: only when `newEpoch()`
   * is called. Only a log on a branch named for epochs (`<name>/<n>`)
   * has them.
   */
  epochs?: EpochPolicy | false
  /**
   * Called with the error when an epoch the policy started fails, or
   * tidying up after one does. The database stays on the epoch it was
   * on, and a later one is tried when the policy calls for it again.
   * Explicit `newEpoch()` calls throw instead.
   */
  onEpochError?: (err: unknown) => void
  /**
   * Called with the branches of the log's older epochs when they are
   * deleted (after a move to a new epoch, or at open): what they alone
   * held is left for a sweep of the repository (`repo.gc()`).
   */
  onEpochsDeleted?: (branches: string[]) => void
}

/** What a statement returned. */
/** Options for {@link openDetached}. */
export interface DetachedOptions {
  /** The directory holding the database file. */
  dir: Directory
  /** The database file's name in `dir`. */
  name: string
  /** How error messages name the database, e.g. `'agex.db'`. */
  label?: string
  /** `PRAGMA foreign_keys` for the connection. Default true. */
  foreignKeys?: boolean
}

/**
 * Where {@link LoggedDatabase.copy} writes a copy: the file `name` in
 * `dir`, and, for a logged copy, its log's new branch in `repo`.
 */
export interface CopyTarget {
  dir: Directory
  name: string
  /**
   * For a logged copy: the repository its log is in, which must hold
   * this database's log, since the copy's branch starts from it (the
   * same repository, or one it is synced with).
   */
  repo?: Repo<Uint8Array>
  /** For a logged copy: its log's branch, which mustn't exist yet. */
  branch?: string
}

/** What a copy took. */
export interface CopyResult {
  /** The size of the file copied. */
  bytes: number
  /** The last transaction in the copy (0 for none). */
  seq: number
  /** The copy's schema version. */
  schema: number
  /** The log commit the copy's flushed transactions end at, where a logged copy's branch starts. */
  base: string
}

export interface QueryResult {
  /**
   * Its rows, as objects keyed by column name. For SQL holding several
   * statements, the rows of the first one that returns any.
   */
  rows: Record<string, SqlValue>[]
  /** Rows it inserted, updated or deleted (0 for a statement that changes none). */
  changes: number
  /**
   * The rowid of the connection's last insert (`last_insert_rowid()`),
   * a bigint only past 2^53.
   */
  lastInsertRowid: number | bigint
}

/**
 * The transaction a {@link LoggedDatabase.transact} function runs in,
 * open while the function runs.
 */
export interface Transaction {
  /**
   * Run one statement in the transaction, behind the schema guard, and
   * return its result. A statement that fails throws its error, and
   * the transaction rolls back if the function throws it on.
   */
  query(sql: string, params?: Params | null): QueryResult
}

/** What a restore did. */
export interface RestoreResult {
  /** The checkpoint restored to. */
  checkpoint: Checkpoint
  /** How many transactions it undid. */
  undone: number
  /**
   * How: `undo`, one transaction applying the inverse of the changes
   * since, logged as any is; `epoch`, a new epoch whose snapshot is the
   * database rebuilt at the checkpoint (a schema change since, or a
   * checkpoint on an earlier epoch, can't be undone by a changeset);
   * `none`, the database was at the checkpoint already.
   */
  how: 'undo' | 'epoch' | 'none'
  /** The database's last transaction after: a restore moves forward. */
  seq: number
  /** The log's branch after (a new one for `epoch`). */
  branch: string
}

/** A side of a rebase: this database's changes, or the log's. */
export type RebaseSide = 'mine' | 'theirs'

export interface RebaseOptions {
  /**
   * Settle a conflict by keeping one side: `'mine'`, this database's
   * changes since it and the log parted, with an entry before them
   * undoing the log's; `'theirs'`, the log's, this database's dropped.
   * The side not kept stays as a checkpoint. Without it, a conflict
   * changes nothing.
   */
  keep?: RebaseSide
  /**
   * For a rebase onto a newer epoch: the last commit of the database's
   * own epoch that the newer one holds, such as the one this copy last
   * synced (everything a sync pushed to an epoch is in the next one by
   * the time the old one goes). The database's changes after it are
   * what moves. Null: this copy synced none of its epoch, so every
   * change on it is its own. By default, where the newer epoch's
   * snapshot was taken in the database's epoch, followed back through
   * any epochs between that the repository has; or, for a database with
   * nothing on its epoch, its epoch's start.
   */
  synced?: string | null
}

/** Options for {@link LoggedDatabase.adopt}. */
export interface AdoptOptions {
  /**
   * Where the entries to take start: the commit of the old epoch after
   * which they follow, such as the last this copy synced there. By
   * default where `tip`'s line parted from the one the snapshot of the
   * epoch after `tip`'s was taken on, followed back from the database's
   * epoch through the epochs the repository has.
   */
  since?: string
  /** Settle a conflict by keeping this database's side: nothing is taken, and the entries stay as a checkpoint. */
  keep?: 'mine'
}

/** What a rebase did. */
export interface RebaseResult {
  /**
   * - `up-to-date`: the database's log holds the commit already.
   * - `fast-forwarded`: the database had nothing the log lacks, and
   *   caught up with it.
   * - `rebased`: the database's own changes since it and the log
   *   parted now follow the log's, numbered after them.
   * - `conflict`: they can't follow as they are (`conflicts`, or a
   *   `schemaChange`); nothing changed. Rebase again keeping a side.
   * - `kept`: a conflict settled by keeping one side (`kept`); the
   *   other is `checkpoint`.
   */
  status: 'up-to-date' | 'fast-forwarded' | 'rebased' | 'conflict' | 'kept'
  /** For `kept`: the side kept. */
  kept: RebaseSide | null
  /** For `conflict`: what re-applying the database's changes after the log's met. */
  conflicts: Conflict[]
  /**
   * For `conflict`: the side whose schema change stopped it, if one
   * did. A changeset is recorded under one schema, so the database's
   * changes can't follow a schema change of the log's, nor be undone
   * past one of their own.
   */
  schemaChange: RebaseSide | null
  /** The database's transactions the log didn't hold. */
  mine: number
  /** The log's transactions the database didn't hold. */
  theirs: number
  /** For `kept`: the side not kept, as a checkpoint to restore. */
  checkpoint: Checkpoint | null
  /** The database's last transaction after. */
  seq: number
  /** The log commit the file is at after. */
  base: string
}

/** A new epoch, which the database moved to. */
export interface EpochResult {
  /** Its branch, which the database's log is on now. */
  branch: string
  /** The epoch the database left, whose branch is deleted. */
  previous: string
  /** The last transaction the snapshot holds. */
  seq: number
  /** The snapshot's schema version. */
  schema: number
  /** The size of the database file the snapshot holds. */
  bytes: number
  /** The snapshot's gzipped size. */
  gzipped: number
  /** The chunks it is stored in. */
  chunks: number
  /** The snapshot's last commit, where the epoch's log starts. */
  commit: string
}

/** One flush: the log entry it committed. */
export interface FlushResult {
  /** The log commit holding the entry. */
  commit: string
  /** The first and last transactions it holds. */
  from: number
  to: number
  /** The entry's length in bytes. */
  bytes: number
  /** How many pieces it holds: transactions, plus merged runs. */
  pieces: number
}

/** What opening the database did to bring the file level with the log. */
export interface Recovery {
  /**
   * Whether the log's next entry was this file's own flush, interrupted
   * before its pending transactions were deleted, so they were.
   */
  ownFlush: boolean
  /** Log entries replayed into the file. */
  entries: number
  /** Transactions those entries held. */
  transactions: number
  /**
   * This file's transactions, pending or in entries the log's branch
   * no longer holds, rebased onto entries another copy wrote.
   */
  rebased: number
  /**
   * A newer epoch of the log that the file didn't move to, staying on
   * its own (still in the repository): it holds changes of its own that
   * the newer epoch's snapshot may not (another device's epoch, which
   * `rebase()` moves the database onto). Null if none.
   */
  stayed: string | null
  /**
   * Whether the file was rebuilt from the epoch's snapshot first: it
   * was missing, or behind on an older epoch with nothing pending.
   */
  snapshot: boolean
}

/**
 * Replay applies runs of changesets combined, which measured 7 to 9
 * times faster than one at a time, in chunks of at most this many
 * transactions or bytes. A chunk is held in memory about three times
 * over (the changesets, the combined one, and its copy in wasm memory),
 * so 32 MiB, about 100k one-row transactions, keeps a replay's peak
 * near 100 MB while per-chunk overhead stays negligible.
 */
export const REPLAY_CHUNK_TRANSACTIONS = 100_000
export const REPLAY_CHUNK_BYTES = 32 << 20

const DEFAULT_EVERY = 100
const DEFAULT_MAX_AGE_MS = 2000
const DEFAULT_AUTO_CHECKPOINTS = 10
const DEFAULT_EPOCH_RATIO = 0.5
const DEFAULT_EPOCH_MIN_BYTES = 8 << 20

/** The base a snapshot's file records, until it is opened on its epoch and given the snapshot's commit. */
const SNAPSHOT_BASE = 'snapshot'

/** The version of the file's own tables. */
const FILE_FORMAT = 1

/** The branch a detached copy's file names: none. */
const DETACHED = ''

const INTERNAL_TABLES = `
  CREATE TABLE _kvsql_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    format INTEGER NOT NULL,
    branch TEXT NOT NULL,
    base TEXT NOT NULL,
    base_seq INTEGER NOT NULL,
    applied_seq INTEGER NOT NULL,
    next_seq INTEGER NOT NULL,
    schema INTEGER NOT NULL
  );
  CREATE TABLE _kvsql_pending (
    seq INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('changeset', 'sql')),
    body BLOB NOT NULL,
    schema INTEGER NOT NULL
  );
`

/** The file's position in the log, as `_kvsql_meta` holds it. */
interface Meta {
  /** The log commit of the last whole entry in the file (the root commit for none). */
  base: string
  /** The last transaction of that entry (0 for none). */
  baseSeq: number
  /**
   * The last transaction from the log in the file: `baseSeq`, or more
   * while a replay is part-way through the next entry.
   */
  appliedSeq: number
  /** The number the next transaction gets. */
  nextSeq: number
  /** The schema version: how many schema changes the file has had. */
  schema: number
}

/** A database file opened behind its schema guard, and where it stands. */
interface OpenedFile {
  file: DatabaseFile
  guard: SchemaGuard
  meta: Meta
  pending: number
}

/** A log entry found walking the branch: its commit and what it records. */
interface LogEntry extends EntryInfo {
  commit: string
}

/** A snapshot taken for a new epoch, waiting to be committed. */
interface Shot {
  /** The new epoch's branch. */
  branch: string
  /** The snapshot's file, beside the database's. */
  tmp: string
  seq: number
  schema: number
  previous: { branch: string; base: string; pending: string | null; seq?: number }
  /** Its content hash, once worked out. */
  hash?: string
  /** The old epoch's tip the move expects, if not `previous.base`. */
  from?: string
}

/** One entry of a rebase's new line: its pieces, and their encoding. */
interface Line {
  pieces: Piece[]
  bytes: Uint8Array
  /** For the last of entries taken by `adopt()`: the tip they were taken from. */
  adopted?: string
}

/** Changesets gathered for one replay chunk. */
interface Chunk {
  /** The log commit of its first changeset, for errors. */
  commit: string
  from: number
  to: number
  bodies: Uint8Array[]
  bytes: number
}

/** Open the logged database `name` in `dir`, on the log at `branch`. */
export function openLog(options: LogOptions): Promise<LoggedDatabase> {
  return LoggedDatabase.open(options)
}

/**
 * Open the detached copy `name` in `dir` (made by
 * {@link LoggedDatabase.copy}), or a new one if the file is empty: a
 * database with no log. Its calls run as a logged database's do,
 * refused and checked alike, but record nothing; `flush()` has nothing
 * to do, and `seq`, `base` and `schemaVersion` stay where the copy was
 * taken.
 */
export function openDetached(options: DetachedOptions): Promise<LoggedDatabase> {
  return LoggedDatabase.openDetached(options)
}

/**
 * An open logged database, or a detached copy of one. Calls (`query`,
 * `transaction`, `transact`, `flush`, `close`, ...) run one at a time,
 * in the order they were made.
 */
export class LoggedDatabase {
  readonly name: string
  /** What opening did to bring the file level with the log. */
  readonly recovery: Recovery

  readonly #sqlite3: Sqlite3Static
  readonly #options: Partial<LogOptions> & DetachedOptions
  #file: DatabaseFile
  #db: Database
  #guard: SchemaGuard
  /** The log, unless the database is a detached copy. */
  #log: { repo: Repo<Uint8Array>; wt: Worktree<Uint8Array> } | null
  #branch: string
  readonly #label: string | undefined
  readonly #foreignKeys: boolean
  readonly #every: number
  readonly #maxAgeMs: number
  readonly #onFlushError: ((err: unknown) => void) | undefined
  readonly #epochs: Required<EpochPolicy> | null
  readonly #onEpochError: ((err: unknown) => void) | undefined
  readonly #onEpochsDeleted: ((branches: string[]) => void) | undefined
  readonly #autoCheckpoints: number
  /** The epoch being started, if one is. */
  #epoch: Promise<EpochResult> | null = null
  /**
   * Checkpoints before schema changes made while flushes waited for an
   * epoch's snapshot, taken once they no longer wait.
   */
  #deferred: { before: number; label: string; schema: number }[] = []
  /** Whether flushes wait: a snapshot is being committed for a new epoch. */
  #holding = false
  /** The bytes of the current epoch's log entries. */
  #logBytes = 0
  /** The current epoch's snapshot's gzipped size (0 for none). */
  #snapshotGzipped = 0
  #meta: Meta
  #pending: number
  #queue: Promise<unknown> = Promise.resolve()
  #timer: ReturnType<typeof setTimeout> | null = null
  #closing: Promise<void> | null = null
  #flushError: unknown = undefined

  private constructor(
    options: Partial<LogOptions> & DetachedOptions,
    branch: string,
    sqlite3: Sqlite3Static,
    file: DatabaseFile,
    guard: SchemaGuard,
    wt: Worktree<Uint8Array> | null,
    meta: Meta,
    pending: number,
  ) {
    this.name = options.name
    this.#options = options
    this.#branch = branch
    this.recovery = {
      ownFlush: false,
      entries: 0,
      transactions: 0,
      rebased: 0,
      snapshot: false,
      stayed: null,
    }
    this.#sqlite3 = sqlite3
    this.#file = file
    this.#db = file.db
    this.#guard = guard
    this.#log = options.repo && wt ? { repo: options.repo, wt } : null
    this.#label = options.label
    this.#foreignKeys = options.foreignKeys ?? true
    this.#every = options.flush?.every ?? DEFAULT_EVERY
    this.#maxAgeMs = options.flush?.maxAgeMs ?? DEFAULT_MAX_AGE_MS
    this.#onFlushError = options.onFlushError
    this.#epochs =
      options.epochs === false
        ? null
        : {
            ratio: options.epochs?.ratio ?? DEFAULT_EPOCH_RATIO,
            minBytes: options.epochs?.minBytes ?? DEFAULT_EPOCH_MIN_BYTES,
          }
    this.#onEpochError = options.onEpochError
    this.#onEpochsDeleted = options.onEpochsDeleted
    this.#autoCheckpoints = options.autoCheckpoints ?? DEFAULT_AUTO_CHECKPOINTS
    this.#meta = meta
    this.#pending = pending
  }

  /** @internal Use {@link openLog}. */
  static async open(options: LogOptions): Promise<LoggedDatabase> {
    checkOptions(options)
    checkDatabaseName(options.name)
    return LoggedDatabase.#open(options)
  }

  /** Open, with `options` checked, but not the name: a restore's own may be kvsql's. */
  static async #open(options: LogOptions): Promise<LoggedDatabase> {
    await settleRebasedFile(options)
    const prepared = await prepareFile(options, await currentEpoch(options.repo, options.branch))
    const { branch } = prepared
    const wt = await options.repo.worktree(branch, { create: true })
    const log = await LoggedDatabase.#start(options, branch, wt)
    try {
      await log.#settleRebase()
      Object.assign(log.recovery, await log.#catchUp(), {
        snapshot: prepared.rebuilt,
        stayed: prepared.stayed,
      })
      await log.#readEpoch()
    } catch (err) {
      log.#file.close()
      throw err
    }
    await log.#tidy()
    log.#reclaim()
    if (log.#pending > 0) log.#arm()
    return log
  }

  /** @internal Use {@link openDetached}. */
  static async openDetached(options: DetachedOptions): Promise<LoggedDatabase> {
    checkDatabaseName(options.name)
    return LoggedDatabase.#start(options, DETACHED, null)
  }

  static async #start(
    options: Partial<LogOptions> & DetachedOptions,
    branch: string,
    wt: Worktree<Uint8Array> | null,
  ): Promise<LoggedDatabase> {
    const sqlite3 = await loadSqlite()
    const { file, guard, meta, pending } = await LoggedDatabase.#openFile(sqlite3, options, branch)
    return new LoggedDatabase(options, branch, sqlite3, file, guard, wt, meta, pending)
  }

  /** Open the file on `branch`, behind the schema guard, and read its position. */
  static async #openFile(
    sqlite3: Sqlite3Static,
    options: Partial<LogOptions> & DetachedOptions,
    branch: string,
  ): Promise<OpenedFile> {
    const file = await openDatabaseFile(options.dir, options.name)
    try {
      const foreignKeys = options.foreignKeys ?? true
      file.db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
      const guard = installGuard(
        sqlite3,
        file.db,
        options.label === undefined ? {} : { label: options.label },
      )
      try {
        const { meta, pending } = guard.trusted(() => {
          initFile(file.db, branch)
          return readPosition(file.db, branch)
        })
        return { file, guard, meta, pending }
      } catch (err) {
        guard.dispose()
        throw err
      }
    } catch (err) {
      file.close()
      throw err
    }
  }

  /** The log's worktree: only a logged database's paths reach for it. */
  get #wt(): Worktree<Uint8Array> {
    if (!this.#log) throw new LogError('a detached copy has no log')
    return this.#log.wt
  }

  get #repo(): Repo<Uint8Array> {
    if (!this.#log) throw new LogError('a detached copy has no log')
    return this.#log.repo
  }

  // --- State ---

  /** The log's branch: its current epoch's. Empty for a detached copy. */
  get branch(): string {
    return this.#branch
  }

  /** The schema version: how many schema changes the database has had. */
  get schemaVersion(): number {
    return this.#meta.schema
  }

  /** How many transactions are in the file but not yet in the log. */
  get pendingCount(): number {
    return this.#pending
  }

  /** The number of the last transaction in the database (0 for none). */
  get seq(): number {
    return this.#meta.nextSeq - 1
  }

  /** The log commit the file's flushed transactions end at (the root commit for none). */
  get base(): string {
    return this.#meta.base
  }

  /**
   * Why the last flush the policy started failed, or undefined if it
   * didn't (or a flush has succeeded since).
   */
  get flushError(): unknown {
    return this.#flushError
  }

  /** Whether this is a detached copy: a database with no log. */
  get detached(): boolean {
    return this.#log === null
  }

  /** Whether `close()` has been called. */
  get closed(): boolean {
    return this.#closing !== null
  }

  // --- Calls ---

  /**
   * Run one statement as a transaction. A statement that fails, or
   * that the schema guard refuses, rolls back and throws its error.
   */
  query(sql: string, params?: Params | null): Promise<QueryResult> {
    return this.#call([[sql, params ?? null]], true).then((results) => results[0] as QueryResult)
  }

  /**
   * Run statements as one transaction: all of them land, or, if any
   * fails, none does, and the error is a {@link StatementError} naming
   * the statement.
   *
   * A transaction that changed the schema (DDL, `PRAGMA user_version`
   * or `application_id`) is logged as its SQL and run again on replay,
   * every statement of it, including any that changed rows: the
   * session extension can't follow rows through a schema change. So
   * such a call must give the same result wherever it runs, and is
   * refused if it calls a function that may not (`random()`, the
   * clock: `NONDETERMINISTIC_FUNCTIONS`) or uses a TEMP table or view
   * an earlier call made, which other copies don't have. Make the
   * schema change on its own, then change rows in a call of their
   * own, where any value is recorded as it was written.
   */
  transaction(statements: readonly Statement[]): Promise<QueryResult[]> {
    return this.#call(statements, false)
  }

  /**
   * Run `fn` as one transaction, its statements run with `tx.query`,
   * and resolve with what it returns: if it returns, they all land; if
   * it throws, none does, and the call rejects with its error. `fn`
   * runs synchronously, so it reads, decides and writes with nothing
   * else in between, as a compare-and-swap needs; a function that
   * returns a promise is refused.
   *
   * Its statements are refused and checked as a call's are, and its
   * changes are logged as a changeset, as a `transaction`'s are; one
   * that changed nothing logs nothing. It can't change the schema: a
   * schema change is logged as its SQL and run again on replay, and
   * the choices a function made can't be, so one is refused and the
   * call rolled back. Change the schema with `query` or `transaction`.
   */
  transact<T>(fn: (tx: Transaction) => T): Promise<T> {
    if (this.#closing) return Promise.reject(closedError())
    if (typeof fn !== 'function') {
      return Promise.reject(new TypeError('transact takes a function of the transaction'))
    }
    return this.#run(() => this.#runFunction(fn), null)
  }

  /**
   * Commit every pending transaction to the log as one entry. Returns
   * null if none were pending. If another copy of the database flushed
   * to the branch first, this one's transactions are rebased after its
   * entries, then flushed.
   *
   * @throws RebaseRequiredError if they conflict with those entries.
   */
  flush(): Promise<FlushResult | null> {
    if (this.#closing) return Promise.reject(closedError())
    return this.#afterEpoch(() => this.#serial(() => this.#flush()))
  }

  /**
   * Start the log's next epoch (see `epoch.ts`), and move the database
   * onto it: a snapshot of the database as it stands, every transaction
   * so far included, flushed or not, committed to the new epoch's
   * branch (`<name>/<n+1>`); the old epoch's branch is then deleted.
   * Calls go on meanwhile, but flushes wait until the snapshot is in,
   * since the log behind them is about to go; their transactions stay
   * pending in the file, where they are safe, and flush to the new
   * epoch. Resolves once the database is on it. An epoch already being
   * started is the one this resolves with.
   *
   * @throws LogError if the log's branch isn't named for epochs, or the
   *   database is a detached copy.
   */
  newEpoch(): Promise<EpochResult> {
    if (this.#closing) return Promise.reject(closedError())
    return this.#startEpoch()
  }

  /**
   * Take a checkpoint: flush, then name the log's position, to
   * `restore()` to later. Kept until `deleteCheckpoint()`. The database
   * also takes one itself before each schema change (`autoCheckpoints`).
   *
   * @throws LogError for a database with no transactions yet, or a
   *   detached copy.
   */
  checkpoint(label = ''): Promise<Checkpoint> {
    if (this.#closing) return Promise.reject(closedError())
    if (typeof label !== 'string')
      return Promise.reject(new TypeError('checkpoint: label must be a string'))
    return this.#afterEpoch(() =>
      this.#serial(async () => {
        await this.#flush()
        if (this.#meta.baseSeq === 0) {
          throw new LogError('the database has no transactions yet, so nothing to checkpoint')
        }
        return this.#checkpointAt(label, false, this.#meta.schema)
      }),
    )
  }

  /** The database's checkpoints, oldest first, across all its epochs. */
  checkpoints(): Promise<Checkpoint[]> {
    if (this.#closing) return Promise.reject(closedError())
    return this.#serial(() => listCheckpoints(this.#repo, logName(this.#branch)))
  }

  /** Delete checkpoint `id`, if it's there. */
  deleteCheckpoint(id: string): Promise<void> {
    if (this.#closing) return Promise.reject(closedError())
    return this.#serial(() => deleteCheckpoint(this.#repo, logName(this.#branch), id))
  }

  /**
   * Bring the database back to checkpoint `id`: every transaction since
   * is undone, by a transaction that moves the log forward, so other
   * copies follow it as they follow any. Within the current epoch with
   * no schema change since, that is one transaction applying the
   * inverse of every change since; otherwise (a schema change since, or
   * a checkpoint on an earlier epoch) the database is rebuilt at the
   * checkpoint beside the file and becomes a new epoch's snapshot, which
   * the file is then rebuilt from, and which counts as a schema change.
   * Calls wait meanwhile. Everything written since the checkpoint is
   * gone, other checkpoints aside.
   *
   * @throws LogError if there's no such checkpoint, or a restore that
   *   needs a new epoch on a branch not named for epochs.
   */
  restore(id: string): Promise<RestoreResult> {
    if (this.#closing) return Promise.reject(closedError())
    return this.#afterEpoch(() => this.#serial(() => this.#restore(id)))
  }

  /**
   * Rebase the database onto `onto`, a commit of its log that another
   * copy of it wrote after the two parted (another device's, fetched
   * by sync), or by default its branch's tip. The database's own
   * changes since then, its pending transactions and the entries only
   * it has, follow the log's: in one file transaction they are undone,
   * the log's applied and theirs applied again, and they become entries
   * numbered after the log's, on a line the log's branch then moves to.
   * Only this copy ever had those entries, so moving the branch off
   * them rewrites nothing another copy holds, and pushing the branch
   * afterwards is a fast-forward.
   *
   * Changes to different rows, or different columns of one row, follow
   * cleanly. Anything else stops it with nothing changed (`conflict`):
   * one column changed both ways, a row deleted on one side and changed
   * on the other, one key inserted on both, a constraint the two break
   * together, or a schema change on either side. Rebasing again with
   * `keep` settles it, the other side kept as a checkpoint; keeping
   * this database's changes over a schema change of the log's starts a
   * new epoch from its file.
   *
   * `onto` must be in the repository (a sync that found the two
   * diverged has fetched it). With a newer epoch of the log there, and
   * no `onto`, the database moves onto it instead, its changes since
   * `synced` with it.
   *
   * @throws LogError for a detached copy, or an `onto` that isn't in
   *   the repository or shares no history with the database's log.
   */
  rebase(onto?: string, options: RebaseOptions = {}): Promise<RebaseResult> {
    if (this.#closing) return Promise.reject(closedError())
    const keep = options.keep
    if (keep !== undefined && keep !== 'mine' && keep !== 'theirs') {
      return Promise.reject(new TypeError("rebase: keep must be 'mine' or 'theirs'"))
    }
    const synced = options.synced
    if (synced !== undefined && synced !== null && typeof synced !== 'string') {
      return Promise.reject(new TypeError('rebase: synced must be a commit'))
    }
    return this.#afterEpoch(() => this.#serial(() => this.#rebase(onto, keep, synced)))
  }

  /**
   * Take into the database entries another copy wrote to the epoch it
   * has moved on from, after its snapshot was taken (another device's
   * pushed while this one started the epoch): those on `tip`'s line
   * after `options.since`, by default where that line parted from the
   * one the snapshot was taken on.
   * Pending transactions flush first; then the entries apply in one file
   * transaction, as new entries numbered after the database's. A
   * conflict with what the database did since changes nothing; keeping
   * `'mine'` takes nothing and keeps `tip` as a checkpoint.
   *
   * @throws LogError for a detached copy, or `tip` not following `since`.
   */
  adopt(tip: string, options: AdoptOptions = {}): Promise<RebaseResult> {
    if (this.#closing) return Promise.reject(closedError())
    if (options.keep !== undefined && options.keep !== 'mine') {
      return Promise.reject(new TypeError("adopt: keep must be 'mine'"))
    }
    return this.#afterEpoch(() => this.#serial(() => this.#adopt(tip, options.since, options.keep)))
  }

  /**
   * The database's content hash (`hash.ts`): a SHA-256 of its schema and
   * every row, the same for any copy holding the same, however it came
   * by them. Taken between calls, so it covers every transaction
   * committed so far, flushed or not.
   */
  contentHash(): Promise<string> {
    if (this.#closing) return Promise.reject(closedError())
    return this.#serial(() => contentHash(this.#db, (fn) => this.#guard.trusted(fn)))
  }

  /**
   * The database as a standalone SQLite file: its tables, indexes,
   * views and triggers and `user_version`, without kvsql's own tables,
   * compacted, for any SQLite tool to open. Taken between calls, so it
   * holds every transaction committed so far, flushed or not. The copy
   * is built in memory, so it costs about twice the file's size there
   * while it's made.
   */
  export(): Promise<Uint8Array> {
    if (this.#closing) return Promise.reject(closedError())
    return this.#serial(() => this.#export())
  }

  /**
   * Copy the database, as it stands between calls, to `target.name` in
   * `target.dir`, replacing any copy there: a detached copy (a file
   * with no log, as tests use), or, given `repo` and `branch`, a logged
   * copy, whose log is a new branch starting where this database's
   * flushed transactions end. A logged copy flushes first, and fails if
   * that does, or if the branch exists. Either way the file is copied
   * as it is, at any size, without going through memory whole.
   *
   * The target must be missing, empty, not a database (a copy cut
   * short: the first page goes last), or a detached copy. Anything else
   * there is refused, so a copy never replaces a database, and nothing
   * may have it open. A logged copy is marked detached until its branch
   * exists, so one cut short before then is replaced too; one cut short
   * in the moments between its last page and its mark, or between its
   * branch and its mark, is refused like a database, and deleting the
   * target clears it.
   */
  copy(target: CopyTarget): Promise<CopyResult> {
    if (this.#closing) return Promise.reject(closedError())
    return this.#afterEpoch(() => this.#serial(() => this.#copy(target)))
  }

  async #copy(target: CopyTarget): Promise<CopyResult> {
    checkCopyTarget(target)
    const { dir, name, repo, branch } = target
    const logged = repo !== undefined && branch !== undefined
    if (logged) {
      if (!this.#log) {
        throw new LogError(
          "a detached copy can't be copied into a logged one: its changes are in no log",
        )
      }
      await this.#flush()
      if (await repo.branches.has(branch)) {
        throw new LogError(`the copy's branch '${branch}' already exists`)
      }
      try {
        await repo.getCommit(this.#meta.base)
      } catch (err) {
        if (!(err instanceof UnknownCommitError)) throw err
        throw new LogError(
          `the copy's repository doesn't hold this database's log, which the copy's branch '${branch}' starts from`,
        )
      }
    }
    await this.#checkTarget(dir, name)
    const bytes = await copyDatabase(this.#file, dir, name)
    const copy = await openDatabaseFile(dir, name)
    try {
      this.#mark(copy, DETACHED, true)
      if (logged) {
        await repo.branches.create(branch, this.#meta.base)
        this.#mark(copy, branch, false)
      }
    } finally {
      copy.close()
    }
    return { bytes, seq: this.seq, schema: this.#meta.schema, base: this.#meta.base }
  }

  /** Name the copy's branch in its file, dropping its pending transactions first time. */
  #mark(copy: DatabaseFile, branch: string, dropPending: boolean): void {
    copy.db.exec('BEGIN IMMEDIATE')
    try {
      copy.db.exec({ sql: 'UPDATE _kvsql_meta SET branch = ? WHERE id = 1', bind: [branch] })
      if (dropPending) copy.db.exec('DELETE FROM _kvsql_pending')
      copy.db.exec('COMMIT')
    } catch (err) {
      if (this.#sqlite3.capi.sqlite3_get_autocommit(copy.db) === 0) copy.db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * Refuse a target file a copy mustn't replace: only a missing or
   * empty file, one that isn't a database (a copy cut short starts with
   * zeros) and a detached copy may go. A logged database is refused
   * whatever its branch: even one on this database's own may hold
   * transactions no log has.
   */
  async #checkTarget(dir: Directory, name: string): Promise<void> {
    if (!(await dir.exists(name))) return
    let file: DatabaseFile
    try {
      file = await openDatabaseFile(dir, name)
    } catch (err) {
      if (isNotADatabase(err)) return
      throw err
    }
    try {
      let owner: SqlValue
      try {
        const known = file.db.selectValue(
          "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = '_kvsql_meta'",
        )
        if (known === 0) {
          if (file.db.selectValue('SELECT count(*) FROM sqlite_schema') === 0) return
          throw new LogError(
            `${name} holds a database that isn't a copy, which a copy won't replace`,
          )
        }
        owner = file.db.selectValue('SELECT branch FROM _kvsql_meta WHERE id = 1') as SqlValue
      } catch (err) {
        if (isNotADatabase(err)) return
        throw err
      }
      if (owner === DETACHED) return
      throw new LogError(
        `${name} holds the database on branch '${String(owner)}', which a copy won't replace`,
      )
    } finally {
      file.close()
    }
  }

  #export(): Uint8Array {
    const { capi, oo1 } = this.#sqlite3
    const name = `file:/kvsql-export-${crypto.randomUUID()}?vfs=memdb`
    // An open connection keeps the memdb alive for VACUUM INTO to fill.
    const copy = new oo1.DB(name)
    try {
      this.#exec(`VACUUM INTO '${name}'`)
      const own = copy.selectValues(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND substr(name, 1, ?) = ?",
        [INTERNAL_TABLE_PREFIX.length, INTERNAL_TABLE_PREFIX],
      ) as string[]
      for (const table of own) copy.exec(`DROP TABLE "${table}"`)
      copy.exec('VACUUM')
      return capi.sqlite3_js_db_export(copy)
    } finally {
      copy.close()
    }
  }

  /**
   * Flush, then close the connection and release the files. If the
   * flush fails (reported to `onFlushError`), the database still
   * closes, and its transactions stay pending in the file for the next
   * open. Calls made before `close()` finish first; calls after it
   * throw.
   */
  close(): Promise<void> {
    this.#closing ??= this.#afterEpoch(() =>
      this.#serial(async () => {
        this.#disarm()
        if (this.#pending > 0) await this.#flushReporting()
      }),
    ).finally(() => {
      this.#disarm()
      this.#guard.dispose()
      this.#file.close()
    })
    return this.#closing
  }

  async #call(statements: readonly Statement[], single: boolean): Promise<QueryResult[]> {
    if (this.#closing) throw closedError()
    checkStatements(statements)
    return this.#run(
      () =>
        statements.map((statement, i) => {
          try {
            return this.#statementIn(statement)
          } catch (err) {
            throw single ? err : new StatementError(i, err)
          }
        }),
      statements,
    )
  }

  /**
   * Run `body` as one transaction (`#transact`), after every call
   * queued before it, then flush or arm as the policy says.
   */
  #run<T>(body: () => T, statements: readonly Statement[] | null): Promise<T> {
    return this.#serial(async () => {
      const { value, logged, bytes } = this.#transact(body, statements)
      if (logged === 'sql' && statements) await this.#autoCheckpoint(statements)
      if (logged && this.#reaches(bytes)) {
        // the new epoch's snapshot holds it, so it never becomes a log entry
        this.#startEpochReporting()
        this.#arm()
      } else if (logged === 'sql' || (logged && this.#every > 0 && this.#pending >= this.#every)) {
        await this.#flushReporting()
      } else if (logged) {
        this.#arm()
      }
      return value
    })
  }

  /** Run `fn` after every call queued before it. */
  #serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.#queue.then(fn)
    this.#queue = run.catch(() => {})
    return run
  }

  /** Run `fn` once no epoch is being started. */
  async #afterEpoch<T>(fn: () => Promise<T>): Promise<T> {
    while (this.#epoch) await this.#epoch.catch(() => {})
    return fn()
  }

  // --- Transactions ---

  /**
   * Run `body`, a call's statements, as one file transaction, recording
   * what they changed in the pending table inside it. `statements` are
   * the call's SQL, logged if it changes the schema; a `transact`
   * function's call has none, and changing the schema is refused.
   */
  #transact<T>(
    body: () => T,
    statements: readonly Statement[] | null,
  ): { value: T; logged: ItemKind | undefined; bytes: number } {
    const { capi } = this.#sqlite3
    const db = this.#db
    const guard = this.#guard
    guard.resetSchemaChanged()
    this.#exec('BEGIN IMMEDIATE')
    let session: Session | undefined
    try {
      const header = this.#header()
      // A detached copy records nothing, but checks what it runs alike.
      if (this.#log) session = startSession(this.#sqlite3, db)
      const value = body()
      // A function that caught a failed statement's error goes on, but
      // that statement may have rolled the transaction back.
      if (capi.sqlite3_get_autocommit(db) !== 0) throw rolledBackError()

      let item: { kind: ItemKind; body: Uint8Array } | undefined
      // A statement that could change the schema, confirmed by the file:
      // `CREATE TABLE IF NOT EXISTS` on a table that exists, run by an
      // app on every load, changes nothing and logs as rows do.
      if (guard.schemaChanged && (guard.analyzed || this.#header() !== header)) {
        if (statements === null) throw new RefusedError(this.#transactSchemaMessage())
        const fn = guard.nondeterministic
        if (fn !== undefined) throw new RefusedError(this.#nondeterministicMessage(fn))
        const temp = guard.tempDependency
        if (temp !== undefined) throw new RefusedError(this.#tempMessage(temp))
        const violations = checkSchema(db, this.#label === undefined ? {} : { label: this.#label })
        if (violations.length > 0) {
          throw new RefusedError(violations.map((v) => v.message).join('\n'))
        }
        item = {
          kind: 'sql',
          body: encodeSqlBody({
            foreignKeys: this.#foreignKeys,
            statements: statements.map(([sql, params]) => [sql, params ?? null]),
          }),
        }
      } else if (session) {
        const changeset = session.changeset()
        if (changeset.byteLength > 0) item = { kind: 'changeset', body: changeset }
      }
      session?.dispose()
      if (!this.#log) item = undefined

      let next = this.#meta
      if (item) {
        const seq = next.nextSeq
        // The pending row's insert must not become the caller's
        // last_insert_rowid().
        const rowid = capi.sqlite3_last_insert_rowid(db)
        this.#exec('INSERT INTO _kvsql_pending (seq, kind, body, schema) VALUES (?, ?, ?, ?)', [
          seq,
          item.kind,
          item.body,
          next.schema,
        ])
        capi.sqlite3_set_last_insert_rowid(db, rowid)
        next = {
          ...next,
          nextSeq: seq + 1,
          schema: item.kind === 'sql' ? next.schema + 1 : next.schema,
        }
        this.#saveMeta(next)
      }
      this.#exec('COMMIT')
      this.#meta = next
      if (item) this.#pending++
      return { value, logged: item?.kind, bytes: item?.body.byteLength ?? 0 }
    } catch (err) {
      this.#rollback()
      throw err
    } finally {
      session?.dispose()
    }
  }

  /**
   * Run a `transact` function, its `tx.query` running statements in
   * the open transaction while it runs, and none after.
   */
  #runFunction<T>(fn: (tx: Transaction) => T): T {
    let open = true
    const tx: Transaction = {
      query: (sql, params) => {
        if (!open) {
          throw new KvsqlError(
            'the transaction is over: tx.query runs statements only while its transact function runs',
          )
        }
        const statement: Statement = [sql, params ?? null]
        checkStatements([statement])
        return this.#statementIn(statement)
      },
    }
    try {
      const value = fn(tx)
      if (isThenable(value)) {
        // Its statements after the first await find the transaction
        // over; the refusal below is the error to report.
        Promise.resolve(value).catch(() => {})
        throw new TypeError(
          "transact's function must be synchronous: it returned a promise, and the transaction can't stay open across an await. Read, decide and write without awaiting, and return the result.",
        )
      }
      return value
    } finally {
      open = false
    }
  }

  /** Run a caller's statement in the open transaction, behind the schema guard. */
  #statementIn(statement: Statement): QueryResult {
    const { capi } = this.#sqlite3
    const db = this.#db
    // A failed statement may have rolled the whole transaction back
    // (`OR ROLLBACK`, a full disk): run nothing more, or it would
    // commit on its own, unlogged.
    if (capi.sqlite3_get_autocommit(db) !== 0) throw rolledBackError()
    const result = this.#guard.run(() => this.#statement(statement))
    // The guard refuses BEGIN, COMMIT and ROLLBACK; a statement that
    // ended the transaction anyway must not commit unlogged.
    if (capi.sqlite3_get_autocommit(db) !== 0) {
      throw new KvsqlError('the statement ended the transaction')
    }
    return result
  }

  #statement([sql, params]: Statement): QueryResult {
    const { capi } = this.#sqlite3
    const db = this.#db
    const before = capi.sqlite3_total_changes(db)
    const rows = db.exec({
      sql,
      ...(params !== undefined && params !== null && { bind: params }),
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Record<string, SqlValue>[]
    const changes = capi.sqlite3_total_changes(db) === before ? 0 : capi.sqlite3_changes(db)
    const rowid = capi.sqlite3_last_insert_rowid(db)
    const asNumber = Number(rowid)
    return {
      rows,
      changes,
      lastInsertRowid: Number.isSafeInteger(asNumber) ? asNumber : BigInt(rowid),
    }
  }

  #nondeterministicMessage(fn: string): string {
    const label = this.#label ?? 'this database'
    return `${fn}() can't be used in a call that changes the schema of ${label}: schema changes are replayed as SQL on every copy of the database, so they must give the same result wherever they run, and ${fn}() can give a different one each time. Change the schema in one call, then the rows in another, where values are recorded as written.`
  }

  #transactSchemaMessage(): string {
    const label = this.#label ?? 'this database'
    return `The schema of ${label} can't change inside transact(): schema changes are replayed as SQL on every copy of the database, and a function's choices of what to run can't be. Change the schema with query() or transaction() first, then change rows in transact().`
  }

  #tempMessage(name: string): string {
    const label = this.#label ?? 'this database'
    return `A call that changes the schema of ${label} can't use the TEMP table or view "${name}" made by an earlier call: schema changes are replayed as SQL on every copy of the database, where TEMP objects from other calls don't exist. Keep the data in an ordinary table, or compute it in the same call (a CTE, or a TEMP table created in this call).`
  }

  // --- Flush ---

  /** Flush, reporting a failure to `onFlushError` instead of throwing. */
  async #flushReporting(): Promise<void> {
    try {
      await this.#flush()
    } catch (err) {
      this.#flushError = err
      this.#arm()
      try {
        this.#onFlushError?.(err)
      } catch {}
    }
  }

  /** Flush the pending transactions, or those through `through`. */
  async #flush(retried = false, through = Number.POSITIVE_INFINITY): Promise<FlushResult | null> {
    this.#disarm()
    // Committing a snapshot for a new epoch: the switch to it arms again.
    if (this.#holding) return null
    if (this.#pending === 0) return null
    // A flush whose commit landed but whose delete didn't leaves the
    // file's base behind the log; settle that before writing another.
    if (this.#wt.head !== this.#meta.base) await this.#catchUp()
    const items = this.#readPending().filter((item) => item.seq <= through)
    const first = items[0]
    const last = items[items.length - 1]
    if (!first || !last) return null
    if (first.seq !== this.#meta.appliedSeq + 1) {
      throw new LogError(
        `the pending transactions start at ${first.seq}, but the database's log position is ${this.#meta.appliedSeq}`,
      )
    }
    const { bytes, pieces } = encodeEntry(this.#sqlite3, items)
    const total = this.#logBytes + bytes.byteLength
    const info = entryInfo(pieces, bytes, await sha256Hex(bytes), total)
    this.#wt.set(ENTRY_KEY, bytes)
    try {
      await this.#wt.commit({ info: { ...info }, onMoved: 'raise' })
    } catch (err) {
      this.#wt.discard()
      if (err instanceof BranchMovedError && !retried) {
        // The branch moved: by this database's own flush, if a commit
        // landed but reported failure (which catching up drops), or by
        // another copy's, which needs a rebase.
        await this.#catchUp()
        return this.#flush(true, through)
      }
      throw err
    }
    const commit = this.#wt.head
    const next: Meta = { ...this.#meta, base: commit, baseSeq: last.seq, appliedSeq: last.seq }
    this.#inTransaction(() => {
      this.#exec('DELETE FROM _kvsql_pending WHERE seq <= ?', [last.seq])
      this.#saveMeta(next)
    })
    this.#reclaim()
    this.#meta = next
    this.#pending -= items.length
    this.#flushError = undefined
    this.#logBytes = total
    if (this.#reaches(total)) this.#startEpochReporting()
    if (this.#pending > 0) this.#arm()
    return { commit, from: first.seq, to: last.seq, bytes: bytes.byteLength, pieces: pieces.length }
  }

  /**
   * Arm the age trigger, if it isn't armed: it fires `maxAgeMs` after
   * the oldest pending transaction landed (or the database opened with
   * some pending, or a flush of them failed).
   */
  #arm(): void {
    if (this.#maxAgeMs <= 0 || this.#timer !== null || this.#closing || this.#pending === 0) return
    const timer = setTimeout(() => {
      this.#timer = null
      if (this.#closing) return
      void this.#serial(() => this.#flushReporting())
    }, this.#maxAgeMs)
    // A timer alone shouldn't keep a Node process running.
    ;(timer as { unref?: () => void }).unref?.()
    this.#timer = timer
  }

  #disarm(): void {
    if (this.#timer === null) return
    clearTimeout(this.#timer)
    this.#timer = null
  }

  // --- Checkpoints and restore ---

  /** Tag the log's position, the file's base, as a checkpoint. */
  async #checkpointAt(label: string, auto: boolean, schema: number): Promise<Checkpoint> {
    const repo = this.#repo
    const { base: commit, baseSeq: seq } = this.#meta
    const id = checkpointId(logName(this.#branch), seq)
    const time = Date.now()
    await repo.tags.create(id, commit, {
      info: { v: 1, checkpoint: { seq, schema, label, auto, time } },
    })
    return { id, label, auto, seq, schema, time, commit }
  }

  /**
   * After a transaction that changed the schema (the last pending one),
   * checkpoint the database as it was before it: flush the transactions
   * before it on their own, so a log commit holds that state, and tag
   * it. Then let only `autoCheckpoints` of these stay. A failure is
   * reported to `onFlushError`; the schema change stands.
   */
  async #autoCheckpoint(statements: readonly Statement[]): Promise<void> {
    if (this.#autoCheckpoints === 0 || !this.#log) return
    const before = this.seq - 1
    // nothing before it to go back to
    if (before === 0) return
    const sql = (statements[0]?.[0] ?? '').replace(/\s+/g, ' ').trim()
    const label = `before ${sql.length > 100 ? `${sql.slice(0, 99)}…` : sql}`
    // the schema change's own item records the schema it ran under
    const wanted = { before, label, schema: this.#meta.schema - 1 }
    // Flushes wait for an epoch's snapshot, which was taken before this
    // change: once the database is past it, `before` is the snapshot's
    // position or a pending transaction after it.
    if (this.#holding) this.#deferred.push(wanted)
    else await this.#autoCheckpointAt(wanted)
  }

  /** Take the checkpoint `#autoCheckpoint` wants, flushing up to its position first. */
  async #autoCheckpointAt(wanted: { before: number; label: string; schema: number }) {
    try {
      if (this.#meta.baseSeq < wanted.before) await this.#flush(false, wanted.before)
      if (this.#meta.baseSeq !== wanted.before) return
      await this.#checkpointAt(wanted.label, true, wanted.schema)
      const autos = (await listCheckpoints(this.#repo, logName(this.#branch))).filter((c) => c.auto)
      for (const old of autos.slice(0, Math.max(0, autos.length - this.#autoCheckpoints))) {
        await deleteCheckpoint(this.#repo, logName(this.#branch), old.id)
      }
    } catch (err) {
      this.#flushError = err
      try {
        this.#onFlushError?.(err)
      } catch {}
    }
  }

  async #restore(id: string): Promise<RestoreResult> {
    const repo = this.#repo
    const checkpoint = await readCheckpoint(repo, logName(this.#branch), id)
    await this.#flush()
    await this.#wt.refresh()
    if (this.#wt.head !== this.#meta.base) await this.#catchUp()
    if (this.#pending > 0) {
      throw new LogError(
        `the database's ${this.#pending} pending transactions didn't flush, so it can't be restored`,
      )
    }
    const at = this.seq
    const result = (how: RestoreResult['how']): RestoreResult => ({
      checkpoint,
      undone: at - checkpoint.seq,
      how,
      seq: this.seq,
      branch: this.#branch,
    })
    if (checkpoint.commit === this.#meta.base) return result('none')
    const since = await this.#entriesSince(checkpoint.commit)
    if (since) {
      const pieces = (await Promise.all(since.map((entry) => this.#readEntry(entry)))).flat()
      if (pieces.every((piece) => piece.kind === 'changeset')) {
        await this.#undo(checkpoint, pieces)
        return result('undo')
      }
    }
    await this.#rebuildAt(checkpoint)
    return result('epoch')
  }

  /**
   * The log entries after `commit`, oldest first, if `commit` is on the
   * current epoch's line behind the file's base; null if it isn't.
   */
  async #entriesSince(commit: string): Promise<LogEntry[] | null> {
    const entries: LogEntry[] = []
    for (let at = this.#meta.base; at !== commit; ) {
      if (at === ROOT_COMMIT) return null
      const record = await this.#repo.getCommit(at)
      const info = parseEntryInfo(record.info)
      if (!info) return null
      entries.push({ commit: at, ...info })
      at = record.parents[0] ?? ROOT_COMMIT
    }
    return entries.reverse()
  }

  /**
   * Undo `pieces` (changesets, every one since `checkpoint`) in one
   * transaction, recorded and logged as any transaction is.
   */
  async #undo(checkpoint: Checkpoint, pieces: readonly Piece[]): Promise<void> {
    const sqlite3 = this.#sqlite3
    const bodies = pieces.map((piece) => piece.body)
    const changes =
      bodies.length === 1 ? (bodies[0] as Uint8Array) : combineChangesets(sqlite3, bodies)
    this.#exec('BEGIN IMMEDIATE')
    const session = startSession(sqlite3, this.#db)
    try {
      const applied = this.#guard.trusted(() =>
        applyChangeset(sqlite3, this.#db, changes, { invert: true }),
      )
      if (!applied.applied) {
        throw new LogError(
          `undoing the changes since checkpoint ${checkpoint.id} conflicts with the database (${describeConflicts(applied.conflicts)})`,
        )
      }
      const body = session.changeset()
      session.dispose()
      let next = this.#meta
      if (body.byteLength > 0) {
        this.#exec('INSERT INTO _kvsql_pending (seq, kind, body, schema) VALUES (?, ?, ?, ?)', [
          next.nextSeq,
          'changeset',
          body,
          next.schema,
        ])
        next = { ...next, nextSeq: next.nextSeq + 1 }
        this.#saveMeta(next)
      }
      this.#exec('COMMIT')
      this.#meta = next
      if (body.byteLength > 0) this.#pending++
    } catch (err) {
      this.#rollback()
      throw err
    } finally {
      session.dispose()
    }
    await this.#flushReporting()
  }

  /**
   * Restore by a new epoch: rebuild the database at `checkpoint` beside
   * the file (from its epoch's snapshot and log, on a branch of its own
   * at the checkpoint), commit that as the new epoch's snapshot, then
   * rebuild the file from it as opening does. The snapshot comes after
   * every transaction so far, and counts as a schema change: its
   * schema can't follow from the log's by any entry. A crash anywhere
   * leaves the database as it was, or on the new epoch.
   */
  async #rebuildAt(checkpoint: Checkpoint): Promise<void> {
    const parsed = parseEpoch(this.#branch)
    if (!parsed) {
      throw new LogError(
        `restoring checkpoint ${checkpoint.id} starts a new epoch (a schema change since it, or an earlier epoch), but the log's branch '${this.#branch}' isn't named for epochs ('<name>/<n>')`,
      )
    }
    const repo = this.#repo
    const dir = this.#file.directory
    const scratch = restoreName(this.name)
    const temp = restoreBranch(parsed.log)
    const branch = await this.#nextEpoch(parsed)
    await deleteDatabaseFiles(dir, scratch)
    if (await repo.branches.has(temp)) await repo.branches.delete(temp)
    await repo.branches.create(temp, checkpoint.commit)
    try {
      const rebuilt = await LoggedDatabase.#open({
        dir,
        name: scratch,
        repo,
        branch: temp,
        foreignKeys: this.#foreignKeys,
        epochs: false,
        autoCheckpoints: 0,
        flush: { every: 0, maxAgeMs: 0 },
      })
      const seq = rebuilt.seq
      await rebuilt.close()
      if (seq !== checkpoint.seq) {
        throw new LogError(
          `checkpoint ${checkpoint.id} is at transaction ${checkpoint.seq}, but its log rebuilds to ${seq}`,
        )
      }
    } finally {
      await repo.branches.delete(temp).catch(() => {})
    }
    const tmp = snapshotName(this.name)
    try {
      const source = await openDatabaseFile(dir, scratch)
      try {
        await vacuumInto(source, dir, tmp, (sql) => source.db.exec(sql))
      } finally {
        source.close()
      }
      await deleteDatabaseFiles(dir, scratch)
      const seq = this.seq + 1
      const schema = this.#meta.schema + 1
      await markSnapshot(dir, tmp, branch, seq, schema)
      const hash = await hashFile(dir, tmp)
      const file = await dir.open(tmp)
      try {
        await writeSnapshot(repo, branch, file, {
          seq,
          schema,
          hash,
          previous: { branch: this.#branch, base: this.#meta.base, pending: null },
        })
      } catch (err) {
        await this.#dropEpoch(branch)
        throw err
      } finally {
        file.close()
      }
    } finally {
      await deleteDatabaseFiles(dir, tmp).catch(() => {})
      await deleteDatabaseFiles(dir, scratch).catch(() => {})
    }
    await this.#reopen("the restore's new epoch is in the log")
  }

  /**
   * Close the file and open it again on the log's current epoch, as
   * opening the database does: after a restore committed a new epoch,
   * the file is rebuilt from its snapshot. `before` runs once the file
   * is closed. If either fails, the database is closed, and opening it
   * again finishes the job; `done` says what was done that it finishes.
   */
  async #reopen(done: string, before?: () => Promise<void>): Promise<void> {
    const repo = this.#repo
    this.#disarm()
    this.#guard.dispose()
    this.#file.close()
    let opened: OpenedFile | undefined
    try {
      await before?.()
      const options = { ...this.#options, repo } as LogOptions
      await settleRebasedFile(options)
      const { branch } = await prepareFile(options, await currentEpoch(repo, this.#branch))
      const wt = await repo.worktree(branch, { create: true })
      opened = await LoggedDatabase.#openFile(this.#sqlite3, options, branch)
      this.#file = opened.file
      this.#db = opened.file.db
      this.#guard = opened.guard
      this.#meta = opened.meta
      this.#pending = opened.pending
      this.#branch = branch
      this.#log = { repo, wt }
      await this.#settleRebase()
      await this.#catchUp()
      await this.#readEpoch()
    } catch (err) {
      // closed, so its files are free for the next open to finish the job
      if (opened) {
        opened.guard.dispose()
        opened.file.close()
      }
      this.#closing = Promise.resolve()
      throw new LogError(
        `${done}, but the database file couldn't be rebuilt from it: open the database again to finish (${messageOf(err)})`,
        { cause: err },
      )
    }
    await this.#tidy()
  }

  // --- Rebase ---

  async #rebase(
    onto: string | undefined,
    keep: RebaseSide | undefined,
    synced?: string | null,
  ): Promise<RebaseResult> {
    if (!this.#log) throw new LogError('a detached copy has no log to rebase onto')
    const repo = this.#repo
    const newer = await this.#newerEpoch()
    if (newer !== null) {
      const tip = await repo.branches.get(newer)
      if (onto === undefined || onto === tip) return this.#rebaseAcross(newer, tip, keep, synced)
      if (await holdsCommit(repo, tip, onto)) {
        throw new LogError(`a rebase onto epoch '${newer}' goes onto its tip, ${tip}, not ${onto}`)
      }
    }
    await this.#wt.refresh()
    const head = this.#wt.head
    // this file's own flush, landed but not yet dropped from the file
    if (
      head !== this.#meta.base &&
      this.#pending > 0 &&
      (await this.#holds(head, this.#meta.base))
    ) {
      const [first] = await this.#walk(head)
      if (first) await this.#dropOwnFlush(first)
    }
    const target = onto ?? head
    const base = this.#meta.base
    let parted: string | null
    try {
      parted = await repo.mergeBase(base, target)
    } catch (err) {
      if (!(err instanceof UnknownCommitError)) throw err
      throw new LogError(`commit ${target} isn't in the repository`, { cause: err })
    }
    if (parted === null) {
      throw new LogError(
        `commit ${target} shares no history with the database's log: it is another log's, or another epoch's`,
      )
    }
    if (head !== base && !(await this.#holds(target, head))) {
      throw new LogError(
        `branch '${this.#branch}' has entries the database file hasn't applied, which commit ${target} doesn't hold`,
      )
    }
    const at = await this.#positionAt(parted)
    const theirs = await this.#walk(target, parted, at.seq)
    const own = await this.#walk(base, parted, at.seq)
    const pending = this.#readPending()
    const transactions = (entries: readonly LogEntry[]) =>
      entries.reduce((n, e) => n + e.to - e.from + 1, 0)
    const mine = transactions(own) + pending.length
    const theirCount = transactions(theirs)
    const result = (
      status: RebaseResult['status'],
      more: Partial<RebaseResult> = {},
    ): RebaseResult => ({
      status,
      kept: null,
      conflicts: [],
      schemaChange: null,
      mine,
      theirs: theirCount,
      checkpoint: null,
      seq: this.seq,
      base: this.#meta.base,
      ...more,
    })
    if (theirs.length === 0) return result('up-to-date')
    if (mine === 0) {
      if (head !== target) await this.#moveBranch(head, target)
      await this.#catchUp()
      return result('fast-forwarded')
    }

    const ownPieces = [
      ...(await Promise.all(own.map((entry) => this.#readEntry(entry)))).flat(),
      ...pending.map(pieceOf),
    ]
    const theirPieces = (await Promise.all(theirs.map((entry) => this.#readEntry(entry)))).flat()
    const ownSql = ownPieces.some((piece) => piece.kind === 'sql')
    // this database's entries, then its pending transactions, as
    // entries numbered `by` later
    const ownEntries = async (by: number): Promise<Line[]> => {
      const lines = await Promise.all(
        own.map(async (entry) => {
          const pieces = renumber(await this.#readEntry(entry), by)
          return { pieces, bytes: encodePieces(pieces) }
        }),
      )
      if (pending.length > 0) {
        lines.push(
          encodeEntry(
            this.#sqlite3,
            pending.map((p) => ({ ...p, seq: p.seq + by })),
          ),
        )
      }
      return lines
    }

    if (keep === undefined) {
      if (ownSql) return result('conflict', { schemaChange: 'mine' })
      const landed = await this.#rebaseFile(head, target, at.schema, {
        undo: ownPieces,
        apply: theirPieces,
        redo: ownPieces,
        lines: await ownEntries(theirCount),
      })
      if ('conflicts' in landed) return result('conflict', landed)
      return result('rebased')
    }

    if (keep === 'theirs') {
      const checkpoint = await this.#keepMine(base, pending)
      if (ownSql) {
        // its schema change can't be undone: the file is rebuilt from the log
        await this.#reopen('the rebase moved the log to the synced changes', async () => {
          await deleteDatabaseFiles(this.#file.directory, this.name)
          if (!(await publishHead(repo.store, this.#branch, head, target))) {
            throw new LogError(`branch '${this.#branch}' moved during the rebase`)
          }
        })
      } else {
        await this.#rebaseFile(head, target, at.schema, {
          undo: ownPieces,
          apply: theirPieces,
          redo: [],
          lines: [],
        })
      }
      return result('kept', { kept: 'theirs', checkpoint })
    }

    const ends = await this.#positionAt(target)
    if (theirPieces.some((piece) => piece.kind === 'sql')) {
      // the log's changes can't be undone past a schema change: this
      // database's file becomes a new epoch's snapshot instead
      const checkpoint = await this.#keepByEpoch(target, ends, at.schema, ownSql, head)
      return result('kept', { kept: 'mine', checkpoint })
    }
    const checkpoint = await this.#tag(
      target,
      ends.seq,
      ends.schema,
      "the synced changes, replaced by this copy's",
    )
    // an entry undoing the log's changes, then this database's own
    const lines: Line[] = []
    const inverse = invertChangeset(
      this.#sqlite3,
      combineChangesets(
        this.#sqlite3,
        theirPieces.map((piece) => piece.body),
      ),
    )
    if (inverse.byteLength > 0) {
      const piece: Piece = {
        kind: 'changeset',
        from: ends.seq + 1,
        to: ends.seq + 1,
        schema: ends.schema,
        body: inverse,
      }
      lines.push({ pieces: [piece], bytes: encodePieces([piece]) })
    }
    lines.push(...(await ownEntries(theirCount + lines.length)))
    await this.#rebaseFile(head, target, at.schema, { undo: [], apply: [], redo: [], lines })
    return result('kept', { kept: 'mine', checkpoint })
  }

  /** A newer finished epoch of the database's log, if the repository has one. */
  async #newerEpoch(): Promise<string | null> {
    if (!parseEpoch(this.#branch)) return null
    const current = await currentEpoch(this.#repo, this.#branch)
    return current === this.#branch ? null : current
  }

  /**
   * Rebase onto epoch `newer`, at `tip`: this database's changes on its
   * own epoch since `synced` (by default, since where the snapshot chain
   * back from the newer epoch left this one) follow the newer epoch's.
   * Its snapshot folds in what changed before it, so there is no log to
   * undo or apply: the database is rebuilt at `tip` beside its file, its
   * changes applied there and committed after `tip`, and that file
   * replaces the database's. With nothing of its own, the database just
   * moves.
   */
  async #rebaseAcross(
    newer: string,
    tip: string,
    keep: RebaseSide | undefined,
    synced: string | null | undefined,
  ): Promise<RebaseResult> {
    const repo = this.#repo
    // level with its own epoch's branch first
    await this.#wt.refresh()
    if (this.#wt.head !== this.#meta.base) await this.#catchUp()
    const base = this.#meta.base
    const record = await readSnapshot(repo, tip)
    if (!record) throw new LogError(`epoch '${newer}' has no snapshot at ${tip}`)
    let parted = synced === null ? await epochStart(repo, base) : (synced ?? null)
    const previous = await takenOn(repo, tip, async (p) => p.branch === this.#branch)
    if (parted === null && previous && (await holdsCommit(repo, previous.base, previous.base))) {
      parted = await repo.mergeBase(base, previous.base)
    }
    // nothing on its epoch: nothing of its own to take
    if (parted === null && (await epochStart(repo, base)) === base) parted = base
    if (parted === null) {
      throw new LogError(
        `which of this database's changes on '${this.#branch}' epoch '${newer}' holds isn't known here: rebase with \`synced\`, the last commit of '${this.#branch}' this copy synced`,
      )
    }
    if (!(await holdsCommit(repo, base, parted))) {
      throw new LogError(`commit ${parted} isn't in this database's log on '${this.#branch}'`)
    }
    const at = await this.#positionAt(parted)
    const ends = await this.#positionAt(tip)
    const own = await this.#walk(base, parted, at.seq)
    const pending = this.#readPending()
    const mine = own.reduce((n, e) => n + e.to - e.from + 1, 0) + pending.length
    const result = (
      status: RebaseResult['status'],
      more: Partial<RebaseResult> = {},
    ): RebaseResult => ({
      status,
      kept: null,
      conflicts: [],
      schemaChange: null,
      mine,
      theirs: Math.max(0, ends.seq - at.seq),
      checkpoint: null,
      seq: this.seq,
      base: this.#meta.base,
      ...more,
    })

    if (mine === 0) {
      // at the very point the newer epoch's snapshot was taken, it must
      // hold the same
      const taken = record.previous
      if (
        taken?.branch === this.#branch &&
        taken.base === base &&
        taken.pending === null &&
        record.hash !== undefined
      ) {
        const hash = await contentHash(this.#db, (fn) => this.#guard.trusted(fn))
        if (hash !== record.hash) throw new DivergedError(this.#branch, base, record.hash, hash)
      }
      await this.#moveOnto(newer)
      return result('fast-forwarded')
    }
    const ownPieces = [
      ...(await Promise.all(own.map((entry) => this.#readEntry(entry)))).flat(),
      ...pending.map(pieceOf),
    ]
    const ownSql = ownPieces.some((piece) => piece.kind === 'sql')

    if (keep === 'theirs') {
      const checkpoint = await this.#keepMine(base, pending)
      await this.#moveOnto(newer)
      return result('kept', { kept: 'theirs', checkpoint })
    }
    if (keep === 'mine') {
      const checkpoint = await this.#keepByEpoch(tip, ends, at.schema, ownSql)
      return result('kept', { kept: 'mine', checkpoint })
    }
    if (ownSql) return result('conflict', { schemaChange: 'mine' })
    if (ends.schema !== at.schema) return result('conflict', { schemaChange: 'theirs' })
    const by = ends.seq - at.seq
    const lines: Line[] = await Promise.all(
      own.map(async (entry) => {
        const pieces = renumber(await this.#readEntry(entry), by)
        return { pieces, bytes: encodePieces(pieces) }
      }),
    )
    if (pending.length > 0) {
      lines.push(
        encodeEntry(
          this.#sqlite3,
          pending.map((p) => ({ ...p, seq: p.seq + by })),
        ),
      )
    }
    const built = await this.#buildOnto(newer, tip, ends.schema, ownPieces, lines)
    if (built) return result('conflict', built)
    return result('rebased')
  }

  /**
   * Move the database onto epoch `newer`, with nothing of its own to
   * take: its file is rebuilt from the epoch, as opening a missing one
   * does, and its own epoch goes.
   */
  async #moveOnto(newer: string): Promise<void> {
    await this.#reopen(`the database is moving to epoch '${newer}'`, async () => {
      await deleteDatabaseFiles(this.#file.directory, this.name)
    })
  }

  /**
   * Build the database rebased onto epoch `newer` beside its file
   * (`<name>-rebase`): rebuilt at `tip` on the rebase's branch, `pieces`
   * applied, and `lines` committed after `tip`. Then, marked as the
   * epoch's, it replaces the database's file as the database opens it
   * again (`settleRebasedFile`), and the epoch's branch moves to it.
   * Returns the conflicts applying `pieces` met, with nothing changed,
   * or null once the database is on `newer`.
   */
  async #buildOnto(
    newer: string,
    tip: string,
    schema: number,
    pieces: Piece[],
    lines: Line[],
  ): Promise<{ conflicts: Conflict[]; schemaChange: RebaseSide | null } | null> {
    const repo = this.#repo
    const dir = this.#file.directory
    const scratch = rebaseName(this.name)
    const log = logName(this.#branch)
    const temp = rebaseBranch(log)
    const cleanUp = async () => {
      await deleteDatabaseFiles(dir, scratch).catch(() => {})
      for (const branch of [temp, rebaseBranch(temp)]) {
        await repo.branches.delete(branch).catch(() => {})
      }
      await repo.tags.delete(rebaseTag(temp)).catch(() => {})
    }
    await cleanUp()
    await repo.branches.create(temp, tip)
    let built: LoggedDatabase | null = null
    try {
      built = await LoggedDatabase.#open({
        dir,
        name: scratch,
        repo,
        branch: temp,
        foreignKeys: this.#foreignKeys,
        epochs: false,
        autoCheckpoints: 0,
        flush: { every: 0, maxAgeMs: 0 },
      })
      const landed = await built.#rebaseFile(tip, tip, schema, {
        undo: [],
        apply: [],
        redo: pieces,
        lines,
      })
      await built.close()
      built = null
      if ('conflicts' in landed) {
        await cleanUp()
        return landed
      }
      // the head the epoch's branch moves from, then the file marked as
      // the epoch's: from here, opening finishes the move
      const tag = rebaseTag(log)
      if (await repo.tags.has(tag)) await repo.tags.delete(tag)
      await repo.tags.create(tag, tip)
      await markBranch(dir, scratch, newer)
    } catch (err) {
      if (built) await built.close().catch(() => {})
      await cleanUp()
      throw err
    }
    await this.#reopen(`the rebase onto epoch '${newer}' is built`)
    return null
  }

  /**
   * Keep this database's side by making its file a new epoch's snapshot,
   * after every epoch there is, the log's side (at `target`, the
   * position `ends`) kept as a checkpoint. The snapshot comes after
   * every transaction of either side, and counts as a schema change if
   * either side made one since they parted (at schema version
   * `partedSchema`). Pending transactions go into the snapshot. The
   * database's branch moves on only with the move, from `from` (its
   * tip, if not the file's position): until then a failure leaves it,
   * and the log's side, as they were.
   */
  async #keepByEpoch(
    target: string,
    ends: { seq: number; schema: number },
    partedSchema: number,
    ownSql: boolean,
    from?: string,
  ): Promise<Checkpoint> {
    const parsed = parseEpoch(this.#branch)
    if (!parsed) {
      throw new LogError(
        `keeping this database's side here starts a new epoch, but the log's branch '${this.#branch}' isn't named for epochs ('<name>/<n>')`,
      )
    }
    const checkpoint = await this.#tag(
      target,
      ends.seq,
      ends.schema,
      "the synced changes, replaced by this copy's",
    )
    const epochs = await epochsOf(this.#repo, parsed.log)
    const n = Math.max(parsed.n, ...epochs.map((e) => e.n)) + 1
    if (!Number.isSafeInteger(n)) {
      throw new LogError(`the log's epochs can't be counted past ${n - 1}`)
    }
    const changed = ownSql || ends.schema !== partedSchema
    await this.#epochAt(
      epochBranch(parsed.log, n),
      Math.max(this.seq, ends.seq) + 1,
      changed ? Math.max(this.#meta.schema, ends.schema) + 1 : this.#meta.schema,
      from,
    )
    await this.#tidy()
    return checkpoint
  }

  /**
   * Start epoch `branch` from the database as it stands, its snapshot
   * at transaction `seq` and schema version `schema`, and move onto it,
   * all while calls wait; the old epoch's branch must be at `from` (by
   * default the file's position).
   */
  async #epochAt(branch: string, seq: number, schema: number, from?: string): Promise<EpochResult> {
    const dir = this.#file.directory
    const tmp = snapshotName(this.name)
    try {
      await vacuumInto(this.#file, dir, tmp, (sql) => this.#exec(sql))
      const pending = await pendingDigest(this.#sqlite3, this.#readPending())
      await markSnapshot(dir, tmp, branch, seq, schema)
      const shot: Shot = {
        branch,
        tmp,
        seq,
        schema,
        previous: {
          branch: this.#branch,
          base: this.#meta.base,
          pending,
          ...(seq !== this.seq && { seq: this.seq }),
        },
        hash: await hashFile(dir, tmp),
        ...(from !== undefined && { from }),
      }
      let written: Awaited<ReturnType<typeof writeSnapshot>>
      const source = await dir.open(tmp)
      try {
        written = await writeSnapshot(this.#repo, branch, source, shot)
      } catch (err) {
        await this.#dropEpoch(branch)
        throw err
      } finally {
        source.close()
      }
      return await this.#moveTo(shot, written.wt, written.record)
    } finally {
      await deleteDatabaseFiles(dir, tmp).catch(() => {})
    }
  }

  /** The tips `adopt()` took entries from into this epoch, newest first. */
  async #adopted(): Promise<string[]> {
    const out: string[] = []
    for (let at = this.#wt.head; at !== ROOT_COMMIT; ) {
      const commit = await this.#repo.getCommit(at)
      if (!parseEntryInfo(commit.info)) break
      const adopted = (commit.info as { adopted?: unknown }).adopted
      if (typeof adopted === 'string') out.push(adopted)
      at = commit.parents[0] ?? ROOT_COMMIT
    }
    return out
  }

  async #adopt(
    tip: string,
    since: string | undefined,
    keep: 'mine' | undefined,
  ): Promise<RebaseResult> {
    if (!this.#log) throw new LogError('a detached copy has no log to take entries into')
    const repo = this.#repo
    await this.#flush()
    if (this.#pending > 0) {
      throw new LogError(`the database's ${this.#pending} pending transactions didn't flush`)
    }
    let from = since ?? null
    // what an earlier adopt took: `tip` itself, or a commit it follows
    for (const taken of await this.#adopted()) {
      if (taken === tip) {
        return {
          status: 'up-to-date',
          kept: null,
          conflicts: [],
          schemaChange: null,
          mine: 0,
          theirs: 0,
          checkpoint: null,
          seq: this.seq,
          base: this.#meta.base,
        }
      }
      if (from === null && (await holdsCommit(repo, tip, taken))) from = taken
    }
    if (from === null && (await holdsCommit(repo, tip, tip))) {
      // where `tip`'s line parted from the one the snapshot of the epoch
      // after its was taken on
      const on = await epochStart(repo, tip)
      const taken = await takenOn(
        repo,
        this.#wt.head,
        async (p) =>
          (await holdsCommit(repo, p.base, p.base)) && (await epochStart(repo, p.base)) === on,
      )
      if (taken) from = await repo.mergeBase(tip, taken.base)
    }
    if (from === null) {
      throw new LogError(
        "where the entries to take start isn't known here: adopt `since` the last commit of the old epoch this copy synced",
      )
    }
    if (!(await holdsCommit(repo, tip, from))) {
      throw new LogError(
        `commit ${tip} isn't in the history after ${from}, or isn't in the repository`,
      )
    }
    const at = await this.#positionAt(from)
    const entries = await this.#walk(tip, from, at.seq)
    const theirs = entries.reduce((n, e) => n + e.to - e.from + 1, 0)
    const result = (
      status: RebaseResult['status'],
      more: Partial<RebaseResult> = {},
    ): RebaseResult => ({
      status,
      kept: null,
      conflicts: [],
      schemaChange: null,
      mine: 0,
      theirs,
      checkpoint: null,
      seq: this.seq,
      base: this.#meta.base,
      ...more,
    })
    if (entries.length === 0) return result('up-to-date')
    if (keep === 'mine') {
      // kept once: an adopt run again finds its checkpoint
      const label = 'changes synced to an older epoch, not taken into this one'
      const kept = (await listCheckpoints(repo, logName(this.#branch))).find(
        (c) => c.commit === tip && c.label === label,
      )
      const ends = await this.#positionAt(tip)
      const checkpoint = kept ?? (await this.#tag(tip, ends.seq, ends.schema, label))
      return result('kept', { kept: 'mine', checkpoint })
    }
    const pieces = (await Promise.all(entries.map((entry) => this.#readEntry(entry)))).flat()
    if (pieces.some((piece) => piece.kind === 'sql')) {
      return result('conflict', { schemaChange: 'theirs' })
    }
    if (at.schema !== this.#meta.schema) return result('conflict', { schemaChange: 'mine' })
    const by = this.seq - at.seq
    const renumbered: Line[] = await Promise.all(
      entries.map(async (entry) => {
        const own = renumber(await this.#readEntry(entry), by)
        return { pieces: own, bytes: encodePieces(own) }
      }),
    )
    ;(renumbered[renumbered.length - 1] as Line).adopted = tip
    const head = this.#wt.head
    const landed = await this.#rebaseFile(head, head, this.#meta.schema, {
      undo: [],
      apply: [],
      redo: pieces,
      lines: renumbered,
    })
    if ('conflicts' in landed) return result('conflict', landed)
    return result('rebased')
  }

  /**
   * Rebase the file, in one transaction: undo `undo` (this database's
   * changes since the log parted, all changesets), apply `apply` (the
   * log's since, from schema version `from`), and apply `redo` (this
   * database's again), stopping with the file unchanged at a conflict
   * re-applying them. Then, still in the transaction, commit `lines`
   * on the rebase's branch, started at `onto`, and make its tip the
   * file's log position, with nothing pending; once the file commits,
   * the log's branch moves from `head` to that tip.
   *
   * A crash before the file commits leaves the database as it was, and
   * after it, opening finishes the move (`#settleRebase`), from the head
   * the rebase's tag names. A conflict stops it before anything is
   * written; any other failure leaves the rebase's branch and tag, for
   * opening to settle by where the file is.
   */
  async #rebaseFile(
    head: string,
    onto: string,
    from: number,
    steps: { undo: Piece[]; apply: Piece[]; redo: Piece[]; lines: Line[] },
  ): Promise<{ landed: string } | { conflicts: Conflict[]; schemaChange: RebaseSide | null }> {
    const sqlite3 = this.#sqlite3
    const combined = (pieces: readonly Piece[]) =>
      pieces.length === 1
        ? (pieces[0] as Piece).body
        : combineChangesets(
            sqlite3,
            pieces.map((piece) => piece.body),
          )
    const apply = (changeset: Uint8Array, invert = false) =>
      this.#guard.trusted(() => applyChangeset(sqlite3, this.#db, changeset, { invert }))
    // `PRAGMA foreign_keys` can't change inside the transaction
    const bodies = new Map<Piece, ReturnType<typeof decodeSqlBody>>()
    for (const piece of steps.apply) {
      if (piece.kind !== 'sql') continue
      const body = decodeSqlBody(piece.body)
      if (body.foreignKeys !== this.#foreignKeys) {
        throw new LogError(
          `the log's schema change at transaction ${piece.from} ran with foreign keys ${body.foreignKeys ? 'on' : 'off'}, and this database has them ${this.#foreignKeys ? 'on' : 'off'}, which a rebase can't switch`,
        )
      }
      bodies.set(piece, body)
    }
    const temp = rebaseBranch(logName(this.#branch))
    let line: { head: string; seq: number; schema: number; total: number } | null = null
    let schema = from
    this.#exec('BEGIN IMMEDIATE')
    try {
      if (steps.undo.length > 0) {
        const undone = apply(combined(steps.undo), true)
        if (!undone.applied) {
          throw new LogError(
            `undoing this database's own changes since its log parted conflicts with the file (${describeConflicts(undone.conflicts)})`,
          )
        }
      }
      const columns = new Map<string, number>()
      let run: Piece[] = []
      const applyRun = () => {
        if (run.length === 0) return
        const applied = apply(combined(run))
        if (!applied.applied) {
          throw new LogError(
            `the log's transactions ${(run[0] as Piece).from} to ${(run[run.length - 1] as Piece).to} conflict with the database as it was when they were written (${describeConflicts(applied.conflicts)})`,
          )
        }
        run = []
      }
      for (const piece of steps.apply) {
        const body = bodies.get(piece)
        if (body) {
          applyRun()
          if (piece.schema !== schema) {
            throw new LogError(
              `the log's schema change at transaction ${piece.from} was written under schema version ${piece.schema}, not ${schema}`,
            )
          }
          body.statements.forEach(([sql, params], i) => {
            try {
              this.#guard.trusted(() =>
                this.#db.exec({
                  sql,
                  ...(params !== undefined && params !== null && { bind: params }),
                }),
              )
            } catch (err) {
              throw new LogError(
                `statement ${i} of the log's schema change at transaction ${piece.from} failed: ${messageOf(err)}`,
                { cause: err },
              )
            }
          })
          schema = schemaAfter(piece)
          columns.clear()
        } else {
          const problem = this.#checkChangeset(piece, columns, schema)
          if (problem !== undefined) {
            throw new LogError(`the log's transaction ${piece.from}: ${problem}`)
          }
          run.push(piece)
        }
      }
      applyRun()
      if (steps.redo.length > 0) {
        for (const piece of steps.redo) {
          if (this.#checkChangeset(piece, columns, schema) !== undefined) {
            this.#rollback()
            return { conflicts: [], schemaChange: 'theirs' }
          }
        }
        const redone = apply(combined(steps.redo))
        if (!redone.applied) {
          this.#rollback()
          return { conflicts: redone.conflicts, schemaChange: null }
        }
      }
      line = await this.#commitLine(temp, onto, steps.lines)
      // the head to move from, for a crash after the COMMIT
      const tag = rebaseTag(logName(this.#branch))
      if (await this.#repo.tags.has(tag)) await this.#repo.tags.delete(tag)
      await this.#repo.tags.create(tag, head)
      const next: Meta = {
        base: line.head,
        baseSeq: line.seq,
        appliedSeq: line.seq,
        nextSeq: line.seq + 1,
        schema: line.schema,
      }
      this.#exec('DELETE FROM _kvsql_pending')
      this.#saveMeta(next)
      this.#exec('COMMIT')
      this.#meta = next
      this.#pending = 0
      this.#logBytes = line.total
      this.#disarm()
    } catch (err) {
      // The rebase's branch stays: if the file's COMMIT failed but
      // landed, opening finds the file at its tip and moves the log's
      // branch there; if it didn't, opening drops it.
      this.#rollback()
      if (line && this.#meta.base === line.head) this.#closeUnfinished(err)
      throw err
    }
    try {
      await this.#moveBranch(head, line.head)
    } catch (err) {
      this.#closeUnfinished(err)
    }
    await this.#dropRebase()
    return { landed: line.head }
  }

  /**
   * The rebase is in the file, but the log's branch didn't move to it:
   * close, so that opening again, which moves it, is the next step.
   */
  #closeUnfinished(err: unknown): never {
    this.#disarm()
    this.#guard.dispose()
    this.#file.close()
    this.#closing = Promise.resolve()
    throw new LogError(
      `the rebase is in the database file, but branch '${this.#branch}' wasn't moved to it: open the database again to finish (${messageOf(err)})`,
      { cause: err },
    )
  }

  /**
   * Start branch `temp` at `onto` (replacing what a crash left there)
   * and commit `lines` on it, each one log entry. Returns its tip, and
   * the log's position there.
   */
  async #commitLine(
    temp: string,
    onto: string,
    lines: readonly Line[],
  ): Promise<{ head: string; seq: number; schema: number; total: number }> {
    const repo = this.#repo
    if (await repo.branches.has(temp)) await repo.branches.delete(temp)
    await repo.branches.create(temp, onto)
    const wt = await repo.worktree(temp)
    let { seq, schema } = await this.#positionAt(onto)
    let total = parseEntryInfo((await repo.getCommit(onto)).info)?.total ?? 0
    for (const { pieces, bytes, adopted } of lines) {
      total += bytes.byteLength
      const info = entryInfo(pieces, bytes, await sha256Hex(bytes), total)
      wt.set(ENTRY_KEY, bytes)
      await wt.commit({ info: { ...info, ...(adopted !== undefined && { adopted }) } })
      seq = info.to
      schema = info.schema
    }
    return { head: wt.head, seq, schema, total }
  }

  /**
   * Keep this database's changes as a checkpoint, before a rebase drops
   * them: its log position `base`, with `pending` after it committed
   * there first, off the log's branch.
   */
  async #keepMine(base: string, pending: readonly PendingItem[]): Promise<Checkpoint> {
    const label = "this copy's changes, replaced by sync"
    const last = pending[pending.length - 1]
    if (!last) return this.#tag(base, this.#meta.baseSeq, this.#meta.schema, label)
    const temp = rebaseBranch(logName(this.#branch))
    try {
      const line = await this.#commitLine(temp, base, [encodeEntry(this.#sqlite3, pending)])
      return await this.#tag(line.head, line.seq, line.schema, label)
    } finally {
      await this.#repo.branches.delete(temp).catch(() => {})
    }
  }

  /** Tag `commit`, transaction `seq` at schema version `schema`, as a checkpoint. */
  async #tag(commit: string, seq: number, schema: number, label: string): Promise<Checkpoint> {
    const id = checkpointId(logName(this.#branch), seq)
    const time = Date.now()
    await this.#repo.tags.create(id, commit, {
      info: { v: 1, checkpoint: { seq, schema, label, auto: false, time } },
    })
    return { id, label, auto: false, seq, schema, time, commit }
  }

  /** Move the log's branch from `from` to `to`, if it's still at `from`. */
  async #moveBranch(from: string, to: string): Promise<void> {
    if (!(await publishHead(this.#repo.store, this.#branch, from, to))) {
      throw new LogError(`branch '${this.#branch}' moved during the rebase`)
    }
    await this.#wt.refresh()
  }

  /**
   * Finish or drop a rebase a crash interrupted. If the file is at the
   * rebase branch's tip, the rebase committed it, and the log's branch
   * moves there from the head the rebase's tag names; otherwise the
   * file is as it was before, and the rebase's branch and tag are only
   * dropped.
   *
   * @throws LogError if the file has the rebase but the branch has
   *   moved on since from the head the rebase started from: moving it
   *   would drop what it moved to, so both stay as they are.
   */
  async #settleRebase(): Promise<void> {
    const repo = this.#repo
    const log = logName(this.#branch)
    const temp = rebaseBranch(log)
    const tag = rebaseTag(log)
    if (!(await repo.branches.has(temp))) {
      if (await repo.tags.has(tag)) await repo.tags.delete(tag)
      return
    }
    const line = await repo.branches.get(temp)
    await this.#wt.refresh()
    const head = this.#wt.head
    if (this.#meta.base === line && !(await this.#holds(head, line))) {
      const from = (await repo.tags.has(tag)) ? await repo.tags.get(tag) : null
      if (head !== from) {
        throw new LogError(
          `a rebase of this database was cut short after the file took it, and branch '${this.#branch}' has moved since, to ${head}, from ${from ?? 'where the rebase started'}: moving it to the rebase (${line}, on branch '${temp}') would drop that, so both are left as they are`,
        )
      }
      await this.#moveBranch(head, line)
    }
    await this.#dropRebase()
  }

  /** Drop the rebase's branch and tag. */
  async #dropRebase(): Promise<void> {
    const log = logName(this.#branch)
    await this.#repo.branches.delete(rebaseBranch(log)).catch(() => {})
    await this.#repo.tags.delete(rebaseTag(log)).catch(() => {})
  }

  /** Whether commit `ancestor` is `commit` or in its history. */
  async #holds(commit: string, ancestor: string): Promise<boolean> {
    return commit === ancestor || (await this.#repo.mergeBase(commit, ancestor)) === ancestor
  }

  /** The log's position at `commit`: its last transaction, and the schema version after it. */
  async #positionAt(commit: string): Promise<{ seq: number; schema: number }> {
    if (commit === ROOT_COMMIT) return { seq: 0, schema: 0 }
    const info = (await this.#repo.getCommit(commit)).info
    const entry = parseEntryInfo(info)
    if (entry) return { seq: entry.to, schema: entry.schema }
    const snapshot = parseSnapshotInfo(info)?.snapshot
    if (snapshot?.last) return { seq: snapshot.seq, schema: snapshot.schema }
    throw new LogError(`commit ${commit} isn't a position in a kvsql log`)
  }

  // --- Epochs ---

  /**
   * Whether `bytes`, of the epoch's log or of one transaction, call for
   * a new epoch by the policy, now.
   */
  #reaches(bytes: number): boolean {
    const policy = this.#epochs
    if (!policy || policy.ratio === 0 || this.#epoch || this.#closing || !this.#log) return false
    if (!parseEpoch(this.#branch)) return false
    return bytes >= Math.max(policy.minBytes, policy.ratio * this.#snapshotGzipped)
  }

  #startEpoch(): Promise<EpochResult> {
    this.#epoch ??= this.#runEpoch()
    return this.#epoch
  }

  /** Start an epoch the policy called for, reporting a failure to `onEpochError`. */
  #startEpochReporting(): void {
    this.#startEpoch().catch((err) => this.#reportEpochError(err))
  }

  #reportEpochError(err: unknown): void {
    try {
      this.#onEpochError?.(err)
    } catch {}
  }

  /**
   * Take the snapshot (between calls), commit it while calls go on,
   * then move the file onto the new epoch (between calls again).
   */
  async #runEpoch(): Promise<EpochResult> {
    let shot: Shot | undefined
    try {
      shot = await this.#serial(() => this.#takeSnapshot())
      const taken = shot
      // the snapshot's file is its own: hashed while calls go on
      taken.hash = await hashFile(this.#file.directory, taken.tmp)
      let written: Awaited<ReturnType<typeof writeSnapshot>>
      try {
        const source = await this.#file.directory.open(taken.tmp)
        try {
          written = await writeSnapshot(this.#repo, taken.branch, source, taken)
        } finally {
          source.close()
        }
      } catch (err) {
        // An epoch that didn't finish: the file is still on the old one.
        await this.#dropEpoch(taken.branch)
        throw err
      }
      return await this.#serial(() => this.#moveTo(taken, written.wt, written.record))
    } finally {
      this.#epoch = null
      this.#holding = false
      if (shot)
        await deleteDatabaseFiles(this.#file.directory, snapshotName(this.name)).catch(() => {})
      // before a close, which waits for the epoch, queues its flush
      for (const wanted of this.#deferred.splice(0)) {
        void this.#serial(() => this.#autoCheckpointAt(wanted))
      }
      if (!this.#closing) {
        if (this.#every > 0 && this.#pending >= this.#every) {
          void this.#serial(() => this.#flushReporting())
        } else {
          this.#arm()
        }
      }
    }
  }

  /**
   * Write the database, compacted, as the new epoch's snapshot file,
   * with its own tables saying where it stands and nothing pending: its
   * pending transactions are in it, so they never go to the old epoch.
   * Flushes wait from here until the move.
   */
  async #takeSnapshot(): Promise<Shot> {
    if (!this.#log) throw new LogError('a detached copy has no log, so no epochs')
    const parsed = parseEpoch(this.#branch)
    if (!parsed) {
      throw new LogError(
        `the log's branch '${this.#branch}' isn't named for epochs ('<name>/<n>'), so it can't start a new one`,
      )
    }
    // The snapshot must hold every entry of the log it replaces.
    await this.#wt.refresh()
    if (this.#wt.head !== this.#meta.base) await this.#catchUp()
    const branch = await this.#nextEpoch(parsed)
    const dir = this.#file.directory
    const tmp = snapshotName(this.name)
    await vacuumInto(this.#file, dir, tmp, (sql) => this.#exec(sql))
    const seq = this.seq
    const pending = await pendingDigest(this.#sqlite3, this.#readPending())
    await markSnapshot(dir, tmp, branch, seq, this.#meta.schema)
    this.#holding = true
    return {
      branch,
      tmp,
      seq,
      schema: this.#meta.schema,
      previous: { branch: this.#branch, base: this.#meta.base, pending },
    }
  }

  /**
   * The branch of the log's next epoch, `<log>/<n+1>`, free: one left by
   * an epoch that didn't finish is deleted.
   */
  async #nextEpoch(parsed: { log: string; n: number }): Promise<string> {
    if (!Number.isSafeInteger(parsed.n + 1)) {
      throw new LogError(
        `the log's branch '${this.#branch}' is its last epoch: ${parsed.n} can't be counted past`,
      )
    }
    const repo = this.#repo
    const branch = epochBranch(parsed.log, parsed.n + 1)
    if (await repo.branches.has(branch)) {
      if (await finished(repo, branch)) {
        throw new LogError(`the log's next epoch, '${branch}', already exists`)
      }
      await repo.branches.delete(branch)
    }
    return branch
  }

  /** Delete an epoch the file never moved to, if it's there. */
  async #dropEpoch(branch: string): Promise<void> {
    try {
      await this.#repo.branches.delete(branch)
    } catch {}
  }

  /**
   * Move the file onto the new epoch, whose snapshot is in: one file
   * transaction drops the transactions the snapshot holds from the
   * pending table and moves the file's base to the snapshot. Then the
   * old epoch's branch goes, unless it synced (`deleteOlderEpochs`).
   *
   * A transaction that throws may still have landed (a COMMIT that
   * failed after its journal was cleared), so the file says which: moved,
   * the move goes on; not, the new epoch goes, since entries flushed to
   * the old one from now on wouldn't be in it; unreadable, the new
   * epoch stays for the next open to settle (it finishes the move if
   * the file is still where the snapshot was taken).
   */
  async #moveTo(
    shot: Shot,
    wt: Worktree<Uint8Array>,
    record: SnapshotRecord,
  ): Promise<EpochResult> {
    const repo = this.#repo
    const commit = wt.head
    // nothing may reach the old epoch after the snapshot: one writer
    // holds the database, but a log can move by sync
    if ((await repo.branches.get(shot.previous.branch)) !== (shot.from ?? shot.previous.base)) {
      await this.#dropEpoch(shot.branch)
      throw new LogError(
        `the log on branch '${shot.previous.branch}' moved while the new epoch's snapshot was committed, so the snapshot misses its new entries`,
      )
    }
    const dropped = this.#guard.trusted(
      () =>
        this.#db.selectValue('SELECT count(*) FROM _kvsql_pending WHERE seq <= ?', [
          shot.seq,
        ]) as number,
    )
    // a snapshot may come after every transaction, and be a schema change
    const next: Meta = {
      ...this.#meta,
      base: commit,
      baseSeq: shot.seq,
      appliedSeq: shot.seq,
      nextSeq: Math.max(this.#meta.nextSeq, shot.seq + 1),
      // a schema change made while its snapshot was committed is past it
      schema: Math.max(this.#meta.schema, shot.schema),
    }
    try {
      this.#inTransaction(() => {
        this.#exec('DELETE FROM _kvsql_pending WHERE seq <= ?', [shot.seq])
        this.#exec('UPDATE _kvsql_meta SET branch = ? WHERE id = 1', [shot.branch])
        this.#saveMeta(next)
      })
    } catch (err) {
      let landed: boolean | null = null
      try {
        landed =
          this.#guard.trusted(() =>
            this.#db.selectValue('SELECT branch FROM _kvsql_meta WHERE id = 1'),
          ) === shot.branch
      } catch {}
      if (landed !== true) {
        if (landed === false) await this.#dropEpoch(shot.branch)
        throw err
      }
    }
    this.#reclaim()
    const previous = this.#branch
    this.#meta = next
    this.#pending -= dropped
    this.#branch = shot.branch
    this.#log = { repo, wt }
    this.#logBytes = 0
    this.#snapshotGzipped = record.gzipped
    try {
      this.#deleted(await deleteOlderEpochs(repo, shot.branch))
    } catch (err) {
      // the next open deletes them
      this.#reportEpochError(err)
    }
    return {
      branch: shot.branch,
      previous,
      seq: shot.seq,
      schema: record.schema,
      bytes: record.bytes,
      gzipped: record.gzipped,
      chunks: record.digests.length,
      commit,
    }
  }

  /** Read how large the epoch's log and snapshot are, from its tip. */
  async #readEpoch(): Promise<void> {
    const tip = this.#wt.head
    if (tip === ROOT_COMMIT) return
    this.#logBytes = parseEntryInfo((await this.#repo.getCommit(tip)).info)?.total ?? 0
    this.#snapshotGzipped = (await readSnapshot(this.#repo, tip))?.gzipped ?? 0
  }

  /** Report older epochs deleted, if any, to `onEpochsDeleted`. */
  #deleted(branches: string[]): void {
    if (branches.length === 0) return
    try {
      this.#onEpochsDeleted?.(branches)
    } catch (err) {
      this.#reportEpochError(err)
    }
  }

  /**
   * Delete what an epoch that moved on, or one that didn't finish,
   * left: the log's older epochs (but those that synced, and those after
   * them), and a snapshot file.
   */
  async #tidy(): Promise<void> {
    try {
      const parsed = parseEpoch(this.#branch)
      this.#deleted(await deleteOlderEpochs(this.#repo, this.#branch))
      const dir = this.#file.directory
      for (const leftover of [
        snapshotName(this.name),
        restoreName(this.name),
        rebaseName(this.name),
      ]) {
        if (await dir.exists(leftover)) await deleteDatabaseFiles(dir, leftover)
      }
      const temp = parsed ? restoreBranch(parsed.log) : null
      if (temp && (await this.#repo.branches.has(temp))) await this.#repo.branches.delete(temp)
    } catch (err) {
      this.#reportEpochError(err)
    }
  }

  // --- Recovery and replay ---

  /**
   * Bring the file level with the branch's tip: drop this file's own
   * flush if the log has it, then replay every entry after the file's
   * base, or, if the file has pending transactions too, rebase them
   * onto those entries.
   *
   * @throws RebaseRequiredError if the file has pending transactions
   *   that conflict with entries the log has that it didn't write.
   */
  async #catchUp(): Promise<Recovery> {
    const recovery: Recovery = {
      ownFlush: false,
      entries: 0,
      transactions: 0,
      rebased: 0,
      snapshot: false,
      stayed: null,
    }
    await this.#wt.refresh()
    const tip = this.#wt.head
    if (tip === this.#meta.base) return recovery
    let entries = await this.#walk(tip)
    const first = entries[0]
    if (this.#pending > 0 && first) {
      if (await this.#dropOwnFlush(first)) {
        recovery.ownFlush = true
        entries = entries.slice(1)
      }
      if (this.#pending > 0 && entries.length > 0) {
        const rebased = await this.#rebase(tip, undefined)
        if (rebased.status === 'conflict') {
          throw new RebaseRequiredError(rebased.mine, entries.length, rebased)
        }
        recovery.entries = entries.length
        recovery.transactions = rebased.theirs
        recovery.rebased = rebased.mine
        return recovery
      }
    }
    if (entries.length > 0) {
      recovery.entries = entries.length
      recovery.transactions = await this.#replay(entries)
    }
    return recovery
  }

  /**
   * The log entries from just after `base` (the file's, by default), at
   * transaction `baseSeq`, to `tip`, oldest first, checked to be a line
   * of consecutive entries.
   */
  async #walk(
    tip: string,
    base = this.#meta.base,
    baseSeq = this.#meta.baseSeq,
  ): Promise<LogEntry[]> {
    const entries: LogEntry[] = []
    let commit = tip
    while (commit !== base) {
      if (commit === ROOT_COMMIT) {
        throw new LogError(
          `the database's log position ${base} isn't in the history of branch '${this.branch}'`,
        )
      }
      const record: Commit = await this.#repo.getCommit(commit)
      const info = parseEntryInfo(record.info)
      if (!info) {
        throw new LogError(`commit ${commit} on branch '${this.branch}' isn't a kvsql log entry`)
      }
      const parent = record.parents[0]
      if (record.parents.length !== 1 || parent === undefined) {
        throw new LogError(
          `commit ${commit} on branch '${this.branch}' has ${record.parents.length} parents: a log is a line of commits`,
        )
      }
      entries.push({ commit, ...info })
      commit = parent
    }
    entries.reverse()
    let seq = baseSeq
    for (const entry of entries) {
      if (entry.from !== seq + 1) {
        throw new LogError(
          `log entry ${entry.commit} starts at transaction ${entry.from}, not ${seq + 1}`,
        )
      }
      seq = entry.to
    }
    return entries
  }

  /**
   * If `entry` is this file's own flush (its range starts the pending
   * transactions, and encoding those again gives its length and
   * digest), delete them and move the base to it.
   */
  async #dropOwnFlush(entry: LogEntry): Promise<boolean> {
    const items = this.#readPending().filter((item) => item.seq <= entry.to)
    if (items[0]?.seq !== entry.from || items[items.length - 1]?.seq !== entry.to) return false
    const { bytes } = encodeEntry(this.#sqlite3, items)
    if (bytes.byteLength !== entry.length || (await sha256Hex(bytes)) !== entry.digest) return false
    const next: Meta = {
      ...this.#meta,
      base: entry.commit,
      baseSeq: entry.to,
      appliedSeq: entry.to,
    }
    this.#inTransaction(() => {
      this.#exec('DELETE FROM _kvsql_pending WHERE seq <= ?', [entry.to])
      this.#saveMeta(next)
    })
    this.#meta = next
    this.#pending -= items.length
    return true
  }

  /**
   * Apply `entries` to the file, which has no pending transactions.
   * Runs of changesets are combined and applied in chunks; each schema
   * change runs in a transaction of its own. Each chunk commits with
   * the file's new log position, so a replay that stops resumes there.
   * Returns how many transactions were applied.
   *
   * Each changeset is checked before it joins a chunk: it must have
   * been written under the database's schema version, and record each
   * table's current column count. Combining assumes the log is
   * consistent, as one written only by appending is: changesets of one
   * chunk that contradict each other (a key inserted twice) are merged
   * rather than reported, while a conflict with the database as it
   * stands stops the replay.
   */
  async #replay(entries: readonly LogEntry[]): Promise<number> {
    let handed = this.#meta.appliedSeq
    let applied = 0
    // Entries handed out but not yet the base: the base moves to each
    // once a chunk through its last transaction commits.
    const unbased: LogEntry[] = []
    // Column counts of the tables changesets touched, until the next
    // schema change.
    const columns = new Map<string, number>()
    let chunk: Chunk | null = null
    const commitChunk = () => {
      if (!chunk) return
      this.#applyChunk(chunk, unbased)
      applied += chunk.to - chunk.from + 1
      chunk = null
    }
    for (const entry of entries) {
      unbased.push(entry)
      for (const piece of await this.#readEntry(entry)) {
        if (piece.to <= handed) continue
        if (piece.from !== handed + 1) {
          throw new LogError(
            `log entry ${entry.commit} holds transactions ${piece.from} to ${piece.to}, across the database's log position ${handed}`,
          )
        }
        if (piece.kind === 'sql') {
          commitChunk()
          this.#applySql(piece, entry, unbased)
          columns.clear()
          applied++
        } else {
          const problem = this.#checkChangeset(piece, columns)
          if (problem !== undefined) {
            commitChunk()
            throw new ReplayError(entry.commit, piece.from, problem)
          }
          const c = chunk as Chunk | null
          if (
            c &&
            (c.to - c.from + 1 + (piece.to - piece.from + 1) > REPLAY_CHUNK_TRANSACTIONS ||
              c.bytes + piece.body.byteLength > REPLAY_CHUNK_BYTES)
          ) {
            commitChunk()
          }
          chunk ??= {
            commit: entry.commit,
            from: piece.from,
            to: piece.from - 1,
            bodies: [],
            bytes: 0,
          }
          chunk.bodies.push(piece.body)
          chunk.to = piece.to
          chunk.bytes += piece.body.byteLength
        }
        handed = piece.to
      }
    }
    commitChunk()
    const last = entries[entries.length - 1]
    if (last && this.#meta.base !== last.commit) {
      // Every piece was applied before (a replay that stopped after its
      // last chunk), but the base didn't reach the last entry.
      const next = this.#advance(unbased, this.#meta.appliedSeq, this.#meta.schema)
      this.#inTransaction(() => this.#saveMeta(next))
      this.#meta = next
    }
    return applied
  }

  /**
   * Why a changeset piece can't apply to the database as it stands, or
   * undefined if it can. SQLite skips, without an error, the changes
   * to a table whose column count differs from the changeset's.
   */
  #checkChangeset(
    piece: Piece,
    columns: Map<string, number>,
    schema = this.#meta.schema,
  ): string | undefined {
    if (piece.schema !== schema) {
      return `it was written under schema version ${piece.schema}, but the database is at version ${schema}`
    }
    for (const [table, recorded] of changesetTables(this.#sqlite3, piece.body)) {
      let have = columns.get(table)
      if (have === undefined) {
        have = this.#guard.trusted(
          () =>
            this.#db.selectValue("SELECT count(*) FROM pragma_table_info(?, 'main')", [
              table,
            ]) as number,
        )
        columns.set(table, have)
      }
      if (have === 0) return `it changes table "${table}", which doesn't exist`
      if (have !== recorded) {
        return `it records ${recorded} columns for table "${table}", which has ${have}: SQLite would skip those changes`
      }
    }
    return undefined
  }

  /** The file's log position once everything through `seq` is applied. */
  #advance(unbased: LogEntry[], seq: number, schema: number): Meta {
    let { base, baseSeq } = this.#meta
    while (unbased[0] && unbased[0].to <= seq) {
      const entry = unbased.shift() as LogEntry
      base = entry.commit
      baseSeq = entry.to
    }
    return { base, baseSeq, appliedSeq: seq, nextSeq: seq + 1, schema }
  }

  #applyChunk(chunk: Chunk, unbased: LogEntry[]): void {
    const fail = (message: string, options?: ErrorOptions) =>
      new ReplayError(chunk.commit, chunk.from, message, options)
    let changeset: Uint8Array
    if (chunk.bodies.length === 1) {
      changeset = chunk.bodies[0] as Uint8Array
    } else {
      try {
        changeset = combineChangesets(this.#sqlite3, chunk.bodies)
      } catch (err) {
        throw fail(`its changesets don't combine: ${messageOf(err)}`, { cause: err })
      }
    }
    let next: Meta | undefined
    this.#inTransaction(() => {
      const result = this.#guard.trusted(() => applyChangeset(this.#sqlite3, this.#db, changeset))
      if (!result.applied) {
        throw fail(`it conflicts with the database (${describeConflicts(result.conflicts)})`)
      }
      next = this.#advance(unbased, chunk.to, this.#meta.schema)
      this.#saveMeta(next)
    })
    if (next) this.#meta = next
  }

  #applySql(piece: Piece, entry: LogEntry, unbased: LogEntry[]): void {
    const fail = (message: string, options?: ErrorOptions) =>
      new ReplayError(entry.commit, piece.from, message, options)
    let body: ReturnType<typeof decodeSqlBody>
    try {
      body = decodeSqlBody(piece.body)
    } catch (err) {
      throw new CorruptEntryError(entry.commit, messageOf(err))
    }
    // The pragma can only change outside a transaction.
    const toggle = body.foreignKeys !== this.#foreignKeys
    if (toggle) this.#setForeignKeys(body.foreignKeys)
    let next: Meta | undefined
    try {
      this.#inTransaction(() => {
        if (piece.schema !== this.#meta.schema) {
          throw fail(
            `its schema change was written under schema version ${piece.schema}, but the database is at version ${this.#meta.schema}`,
          )
        }
        body.statements.forEach(([sql, params], i) => {
          try {
            this.#guard.trusted(() =>
              this.#db.exec({
                sql,
                ...(params !== undefined && params !== null && { bind: params }),
              }),
            )
          } catch (err) {
            throw fail(`statement ${i} of its schema change failed: ${messageOf(err)}`, {
              cause: err,
            })
          }
        })
        next = this.#advance(unbased, piece.to, schemaAfter(piece))
        this.#saveMeta(next)
      })
    } finally {
      if (toggle) this.#setForeignKeys(this.#foreignKeys)
    }
    if (next) this.#meta = next
  }

  #setForeignKeys(on: boolean): void {
    this.#exec(`PRAGMA foreign_keys = ${on ? 'ON' : 'OFF'}`)
  }

  /** An entry's pieces, after checking its bytes against its commit. */
  async #readEntry(entry: LogEntry): Promise<Piece[]> {
    const corrupt = (message: string) => new CorruptEntryError(entry.commit, message)
    const snapshot = await this.#repo.snapshot({ commit: entry.commit })
    const bytes = await snapshot.get(ENTRY_KEY)
    if (!(bytes instanceof Uint8Array)) throw corrupt('the commit holds no entry')
    if (bytes.byteLength !== entry.length) {
      throw corrupt(`it is ${bytes.byteLength} bytes long, but its commit records ${entry.length}`)
    }
    if ((await sha256Hex(bytes)) !== entry.digest) {
      throw corrupt("its SHA-256 doesn't match the digest its commit records")
    }
    let pieces: Piece[]
    try {
      pieces = decodeEntry(bytes)
    } catch (err) {
      throw corrupt(messageOf(err))
    }
    const first = pieces[0] as Piece
    const last = pieces[pieces.length - 1] as Piece
    if (first.from !== entry.from || last.to !== entry.to || schemaAfter(last) !== entry.schema) {
      throw corrupt("its contents don't match the range and schema version its commit records")
    }
    return pieces
  }

  // --- The file's own tables ---

  #readPending(): PendingItem[] {
    return this.#guard.trusted(
      () =>
        this.#db.exec({
          sql: 'SELECT seq, kind, body, schema FROM _kvsql_pending ORDER BY seq',
          rowMode: 'object',
          returnValue: 'resultRows',
        }) as unknown as PendingItem[],
    )
  }

  /**
   * What a schema change alters in the file's header: the schema cookie
   * (bumped by every change to `sqlite_schema`), `user_version` and
   * `application_id`.
   */
  #header(): string {
    return this.#guard.trusted(() =>
      JSON.stringify(
        this.#db.selectArray(
          'SELECT s.schema_version, u.user_version, a.application_id FROM pragma_schema_version s, pragma_user_version u, pragma_application_id a',
        ),
      ),
    )
  }

  #saveMeta(meta: Meta): void {
    this.#exec(
      'UPDATE _kvsql_meta SET base = ?, base_seq = ?, applied_seq = ?, next_seq = ?, schema = ? WHERE id = 1',
      [meta.base, meta.baseSeq, meta.appliedSeq, meta.nextSeq, meta.schema],
    )
  }

  /** Run one of kvsql's own statements. */
  #exec(sql: string, bind?: readonly SqlValue[]): void {
    this.#guard.trusted(() => this.#db.exec({ sql, ...(bind !== undefined && { bind }) }))
  }

  /**
   * Give the file's free pages back once they're many, as after a flush
   * or a new epoch drops a large transaction's pending copy
   * (`reclaimPages`). A failure leaves them for the next time: the file
   * is only larger than it needs to be.
   */
  #reclaim(): void {
    try {
      reclaimPages(this.#db, (fn) => this.#guard.trusted(fn))
    } catch {}
  }

  /** Run `fn` in a file transaction of kvsql's own. */
  #inTransaction(fn: () => void): void {
    this.#exec('BEGIN IMMEDIATE')
    try {
      fn()
      this.#exec('COMMIT')
    } catch (err) {
      this.#rollback()
      throw err
    }
  }

  /**
   * Roll back the open transaction, if there still is one, then re-read
   * the file's log position: a COMMIT that failed may have landed.
   */
  #rollback(): void {
    try {
      if (this.#sqlite3.capi.sqlite3_get_autocommit(this.#db) === 0) this.#exec('ROLLBACK')
      const { meta, pending } = this.#guard.trusted(() => readPosition(this.#db, this.branch))
      this.#meta = meta
      this.#pending = pending
    } catch {
      // The file is failing: a failed rollback leaves a hot journal,
      // which the next open rolls back. The error that led here is the
      // one to report.
    }
  }
}

/**
 * Create the file's own tables if it has none. A file without them
 * must be empty: its contents would be in no log.
 */
function initFile(db: Database, branch: string): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const known = db.selectValue(
      "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = '_kvsql_meta'",
    )
    if (known === 0) {
      const objects = db.selectValue(
        "SELECT count(*) FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
      )
      const header =
        (db.selectValue('PRAGMA user_version') as number) !== 0 ||
        (db.selectValue('PRAGMA application_id') as number) !== 0
      if (objects !== 0 || header) {
        throw new LogError(
          'the database file already has a schema, but no log position: a logged database starts empty, so that its log holds all of it',
        )
      }
      db.exec(INTERNAL_TABLES)
      db.exec({
        sql: 'INSERT INTO _kvsql_meta (id, format, branch, base, base_seq, applied_seq, next_seq, schema) VALUES (1, ?, ?, ?, 0, 0, 1, 0)',
        bind: [FILE_FORMAT, branch, ROOT_COMMIT],
      })
    }
    db.exec('COMMIT')
  } catch (err) {
    if (db.pointer !== undefined) {
      try {
        db.exec('ROLLBACK')
      } catch {}
    }
    throw err
  }
}

/** What a database file holds, as `prepareFile` reads it without opening it for use. */
type Peeked =
  | 'fresh'
  | 'other'
  | { branch: string; base: string; baseSeq: number; nextSeq: number; pending: number }

/**
 * The file `name` in `dir`: fresh (missing, empty, or not a database
 * yet: a rebuild cut short starts with zeros), a logged database's
 * position, or some other database.
 */
async function peekFile(dir: Directory, name: string): Promise<Peeked> {
  if (!(await dir.exists(name))) return 'fresh'
  let file: DatabaseFile
  try {
    file = await openDatabaseFile(dir, name)
  } catch (err) {
    if (isNotADatabase(err)) return 'fresh'
    throw err
  }
  try {
    const known = file.db.selectValue(
      "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name = '_kvsql_meta'",
    )
    if (known === 0) {
      return file.db.selectValue('SELECT count(*) FROM sqlite_schema') === 0 ? 'fresh' : 'other'
    }
    const row = file.db.exec({
      sql: 'SELECT branch, base, base_seq, next_seq FROM _kvsql_meta WHERE id = 1',
      rowMode: 'object',
      returnValue: 'resultRows',
    })[0] as Record<string, SqlValue> | undefined
    if (!row) return 'other'
    return {
      branch: String(row.branch),
      base: String(row.base),
      baseSeq: Number(row.base_seq),
      nextSeq: Number(row.next_seq),
      pending: Number(file.db.selectValue('SELECT count(*) FROM _kvsql_pending')),
    }
  } catch (err) {
    if (isNotADatabase(err)) return 'fresh'
    throw err
  } finally {
    file.close()
  }
}

/**
 * Make the file ready to open on epoch `branch`, if the epoch has a
 * snapshot: rebuild it from the snapshot if it is fresh, or behind on
 * an older epoch with nothing the snapshot doesn't hold; or, if it is
 * where the snapshot was taken from (a crash stopped the move), finish
 * moving it over. A file behind on an older epoch with changes the
 * snapshot may not hold stays there, if that epoch's branch is still in
 * the repository (another device's epoch: `rebase()` moves it). Anything
 * else is left for opening to take or refuse.
 *
 * Returns the branch to open the file on, whether the file was rebuilt,
 * and the newer epoch it stayed behind, if it did.
 */
async function prepareFile(
  options: LogOptions,
  branch: string,
): Promise<{ branch: string; rebuilt: boolean; stayed: string | null }> {
  const { repo, dir, name } = options
  const as = (rebuilt: boolean) => ({ branch, rebuilt, stayed: null })
  if (!(await repo.branches.has(branch))) return as(false)
  const tip = await repo.branches.get(branch)
  const record = await readSnapshot(repo, tip)
  if (!record) return as(false)
  const file = await peekFile(dir, name)
  if (file === 'other') return as(false)
  const rebuild = async () => {
    const commit = await snapshotCommit(repo, tip)
    await restoreSnapshot(repo, commit, record, dir, name)
    await anchor(dir, name, branch, commit, record.seq, false)
    return as(true)
  }
  if (file === 'fresh') return rebuild()
  if (file.base === SNAPSHOT_BASE) {
    // rebuilt, and stopped before it was given the snapshot's commit
    if (file.baseSeq !== record.seq) return rebuild()
    await anchor(dir, name, branch, await snapshotCommit(repo, tip), record.seq, false)
    return as(true)
  }
  if (file.branch === branch) return as(false)
  const ours = parseEpoch(file.branch)
  const theirs = parseEpoch(branch)
  if (!ours || !theirs || ours.log !== theirs.log || ours.n >= theirs.n) return as(false)
  const { previous } = record
  if (
    previous?.branch === file.branch &&
    previous.base === file.base &&
    (await pendingThrough(dir, name, file.baseSeq, previous.seq ?? record.seq)) === previous.pending
  ) {
    // the file the snapshot was taken from, which a crash stopped moving,
    // or a copy at the same point: holding nothing past the snapshot, it
    // must hold what the snapshot does
    if (record.hash !== undefined && file.nextSeq - 1 === (previous.seq ?? record.seq)) {
      const hash = await hashFile(dir, name)
      if (hash !== record.hash) throw new DivergedError(file.branch, file.base, record.hash, hash)
    }
    await anchor(
      dir,
      name,
      branch,
      await snapshotCommit(repo, tip),
      record.seq,
      true,
      record.schema,
    )
    return as(false)
  }
  // the snapshot holds the file's flushed transactions if the file's
  // position is in the history of where it was taken
  const held =
    previous?.branch === file.branch && (await holdsCommit(repo, previous.base, file.base))
  if (file.pending === 0 && held) return rebuild()
  if (await repo.branches.has(file.branch)) {
    // its epoch is still here: another device's epoch replaced it, and
    // what this file holds besides is for a rebase to take over
    return { branch: file.branch, rebuilt: false, stayed: branch }
  }
  // Its epoch's branch is gone: this device moved off it, so what the
  // file flushed is in the log the snapshot was taken from.
  if (file.pending > 0) {
    throw new LogError(
      `the database file is on epoch '${file.branch}', behind its log's current epoch '${branch}', and holds ${file.pending} transaction${file.pending === 1 ? '' : 's'} no log has, which rebuilding it from the epoch's snapshot would lose`,
    )
  }
  if (file.baseSeq > record.seq) {
    throw new LogError(
      `the database file is on epoch '${file.branch}', with transactions through ${file.baseSeq}, past the ${record.seq} of its log's current epoch '${branch}' starts from, which rebuilding it would lose`,
    )
  }
  return rebuild()
}

/**
 * The start of the epoch commit `commit` is on: its snapshot's last
 * commit, or the root commit for an epoch with no snapshot (a log's
 * first).
 */
async function epochStart(repo: Repo<Uint8Array>, commit: string): Promise<string> {
  return (await readSnapshot(repo, commit)) === null ? ROOT_COMMIT : snapshotCommit(repo, commit)
}

/**
 * Where the snapshot chain back from epoch tip `tip` left the epoch
 * `on` picks: each snapshot was taken at a commit of the epoch before
 * (`previous`), so the chain is followed back through each earlier
 * epoch the repository has, to the first link `on` accepts. Null if it
 * ends, or reaches a commit the repository doesn't have, first.
 */
async function takenOn(
  repo: Repo<Uint8Array>,
  tip: string,
  on: (previous: NonNullable<SnapshotRecord['previous']>) => Promise<boolean>,
): Promise<NonNullable<SnapshotRecord['previous']> | null> {
  let record = await readSnapshot(repo, tip)
  while (record?.previous) {
    const previous = record.previous
    if (await on(previous)) return previous
    if (!(await holdsCommit(repo, previous.base, previous.base))) return null
    record = await readSnapshot(repo, previous.base)
  }
  return null
}

/** Whether `ancestor` is `commit` or in its history; false if either isn't in `repo`. */
async function holdsCommit(
  repo: Repo<Uint8Array>,
  commit: string,
  ancestor: string,
): Promise<boolean> {
  try {
    if (commit === ancestor) {
      await repo.getCommit(commit)
      return true
    }
    return (await repo.mergeBase(commit, ancestor)) === ancestor
  } catch (err) {
    if (err instanceof UnknownCommitError) return false
    throw err
  }
}

/**
 * Finish what a rebase onto a new epoch left beside database `name` in
 * `dir` (`<name>-rebase`), before it opens. A rebase file that names
 * the new epoch, at the tip of the rebase's branch, is the database
 * rebased: the epoch's branch moves to the file's position, from the
 * head the rebase's tag names (if it hasn't yet), the file replaces
 * the database's, and goes. One that
 * doesn't is a rebase cut short before then, and only goes.
 *
 * @throws LogError if the new epoch's branch has moved on since from
 *   where the rebase started: both are left as they are.
 */
async function settleRebasedFile(options: LogOptions): Promise<void> {
  const { dir, name, repo } = options
  const scratch = rebaseName(name)
  if (!(await dir.exists(scratch))) return
  const log = logName(options.branch)
  const file = await peekFile(dir, scratch)
  // built and marked: at the rebase branch's tip, naming an epoch
  const temp = rebaseBranch(log)
  const ready =
    typeof file === 'object' &&
    parseEpoch(file.branch)?.log === log &&
    (await repo.branches.has(file.branch)) &&
    (await repo.branches.has(temp)) &&
    (await repo.branches.get(temp)) === file.base
  if (!ready) {
    await deleteDatabaseFiles(dir, scratch)
    return
  }
  const tip = await repo.branches.get(file.branch)
  if (!(await holdsCommit(repo, tip, file.base))) {
    const tag = rebaseTag(log)
    const from = (await repo.tags.has(tag)) ? await repo.tags.get(tag) : null
    if (tip !== from) {
      throw new LogError(
        `a rebase of this database onto epoch '${file.branch}' was cut short after it was built, and the epoch has moved since, to ${tip}: moving it to the rebase (${file.base}, in ${scratch}) would drop that, so both are left as they are`,
      )
    }
    if (!(await publishHead(repo.store, file.branch, tip, file.base))) {
      throw new LogError(`epoch '${file.branch}' moved while a rebase onto it was finished`)
    }
  }
  const source = await openDatabaseFile(dir, scratch)
  try {
    await copyDatabase(source, dir, name)
  } finally {
    source.close()
  }
  await deleteDatabaseFiles(dir, scratch)
}

/** The content hash of the database file `name` in `dir`, which mustn't be open. */
async function hashFile(dir: Directory, name: string): Promise<string> {
  const file = await openDatabaseFile(dir, name)
  try {
    return await contentHash(file.db)
  } finally {
    file.close()
  }
}

/** The SHA-256 of pending transactions encoded as one entry; null for none. */
async function pendingDigest(
  sqlite3: Sqlite3Static,
  items: readonly PendingItem[],
): Promise<string | null> {
  return items.length === 0 ? null : sha256Hex(encodeEntry(sqlite3, items).bytes)
}

/**
 * The digest of the file's pending transactions through `seq`
 * ({@link pendingDigest}), if they are all of the transactions from
 * `baseSeq` to `seq`; undefined if they aren't.
 */
async function pendingThrough(
  dir: Directory,
  name: string,
  baseSeq: number,
  seq: number,
): Promise<string | null | undefined> {
  const file = await openDatabaseFile(dir, name)
  let items: PendingItem[]
  try {
    items = file.db.exec({
      sql: 'SELECT seq, kind, body, schema FROM _kvsql_pending WHERE seq <= ? ORDER BY seq',
      bind: [seq],
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as unknown as PendingItem[]
  } finally {
    file.close()
  }
  const last = items.length === 0 ? baseSeq : items[items.length - 1]?.seq
  if (last !== seq || (items[0] !== undefined && items[0].seq !== baseSeq + 1)) return undefined
  return pendingDigest(await loadSqlite(), items)
}

/**
 * Make the database file `name` in `dir` (a compacted copy) a snapshot
 * of epoch `branch` at transaction `seq` and schema version `schema`:
 * nothing pending, and the base a snapshot's file records until it is
 * opened on its epoch.
 */
/** Mark the database file `name` in `dir` as on branch `branch`. */
async function markBranch(dir: Directory, name: string, branch: string): Promise<void> {
  const file = await openDatabaseFile(dir, name)
  try {
    file.db.exec({ sql: 'UPDATE _kvsql_meta SET branch = ? WHERE id = 1', bind: [branch] })
  } finally {
    file.close()
  }
}

async function markSnapshot(
  dir: Directory,
  name: string,
  branch: string,
  seq: number,
  schema: number,
): Promise<void> {
  const snap = await openDatabaseFile(dir, name)
  try {
    // the pending rows' pages are freed as zeros, which gzip all but drops
    snap.db.exec('PRAGMA secure_delete = ON')
    snap.db.exec('BEGIN IMMEDIATE')
    snap.db.exec('DELETE FROM _kvsql_pending')
    snap.db.exec({
      sql: 'UPDATE _kvsql_meta SET branch = ?, base = ?, base_seq = ?, applied_seq = ?, next_seq = ?, schema = ? WHERE id = 1',
      bind: [branch, SNAPSHOT_BASE, seq, seq, seq + 1, schema],
    })
    snap.db.exec('COMMIT')
  } finally {
    snap.close()
  }
}

/**
 * Give the file `name` in `dir` the log position `commit` (holding
 * transactions through `seq`) on `branch`, dropping its pending
 * transactions through `seq` if `dropPending`.
 */
async function anchor(
  dir: Directory,
  name: string,
  branch: string,
  commit: string,
  seq: number,
  dropPending: boolean,
  schema?: number,
): Promise<void> {
  const file = await openDatabaseFile(dir, name)
  try {
    file.db.exec('BEGIN IMMEDIATE')
    try {
      if (dropPending) {
        file.db.exec({ sql: 'DELETE FROM _kvsql_pending WHERE seq <= ?', bind: [seq] })
      }
      // a snapshot may come after the file's last transaction, and be a
      // schema change
      file.db.exec({
        sql: 'UPDATE _kvsql_meta SET branch = ?, base = ?, base_seq = ?, applied_seq = ?, next_seq = max(next_seq, ?), schema = max(schema, ?) WHERE id = 1',
        bind: [branch, commit, seq, seq, seq + 1, schema ?? 0],
      })
      file.db.exec('COMMIT')
    } catch (err) {
      try {
        file.db.exec('ROLLBACK')
      } catch {}
      throw err
    }
  } finally {
    file.close()
  }
}

/** The file's log position and pending count, checked against `branch`. */
function readPosition(db: Database, branch: string): { meta: Meta; pending: number } {
  const row = db.exec({
    sql: 'SELECT format, branch, base, base_seq, applied_seq, next_seq, schema FROM _kvsql_meta WHERE id = 1',
    rowMode: 'object',
    returnValue: 'resultRows',
  })[0] as Record<string, SqlValue> | undefined
  if (!row) throw new LogError('the database file has lost its log position')
  if (row.format !== FILE_FORMAT) {
    throw new LogError(
      `the database file's tables are format ${String(row.format)}, which this version doesn't read`,
    )
  }
  if (row.branch !== branch && (row.branch === DETACHED || branch === DETACHED)) {
    throw new LogError(
      row.branch === DETACHED
        ? `the database file is a detached copy, with no log, so it can't be opened on branch '${branch}'`
        : `the database file belongs to the log on branch '${String(row.branch)}', and isn't a detached copy`,
    )
  }
  if (row.branch !== branch) {
    throw new LogError(
      `the database file belongs to the log on branch '${String(row.branch)}', not '${branch}'`,
    )
  }
  return {
    meta: {
      base: row.base as string,
      baseSeq: row.base_seq as number,
      appliedSeq: row.applied_seq as number,
      nextSeq: row.next_seq as number,
      schema: row.schema as number,
    },
    pending: db.selectValue('SELECT count(*) FROM _kvsql_pending') as number,
  }
}

function checkCopyTarget(target: CopyTarget): void {
  checkDatabaseName(target.name)
  if ((target.repo === undefined) !== (target.branch === undefined)) {
    throw new TypeError('copy: a logged copy needs both repo and branch, a detached one neither')
  }
  if (target.branch !== undefined && (typeof target.branch !== 'string' || target.branch === '')) {
    throw new TypeError('copy: branch must be a non-empty string')
  }
}

/** SQLite's result code for a file that isn't a database. */
const SQLITE_NOTADB = 26

function isNotADatabase(err: unknown): boolean {
  return (err as { resultCode?: unknown } | null)?.resultCode === SQLITE_NOTADB
}

function checkOptions(options: LogOptions): void {
  checkDatabaseName(options.name)
  if (typeof options.branch !== 'string' || options.branch === '') {
    throw new TypeError('openLog: branch must be a non-empty string')
  }
  for (const key of ['every', 'maxAgeMs'] as const) {
    const value = options.flush?.[key]
    if (value !== undefined && !(Number.isSafeInteger(value) && value >= 0)) {
      throw new TypeError(`openLog: flush.${key} must be a whole number >= 0`)
    }
  }
  const auto = options.autoCheckpoints
  if (auto !== undefined && !(Number.isSafeInteger(auto) && auto >= 0)) {
    throw new TypeError('openLog: autoCheckpoints must be a whole number >= 0')
  }
  if (options.epochs !== undefined && options.epochs !== false) {
    const { ratio, minBytes } = options.epochs
    if (ratio !== undefined && !(Number.isFinite(ratio) && ratio >= 0)) {
      throw new TypeError('openLog: epochs.ratio must be a number >= 0')
    }
    if (minBytes !== undefined && !(Number.isSafeInteger(minBytes) && minBytes >= 0)) {
      throw new TypeError('openLog: epochs.minBytes must be a whole number >= 0')
    }
  }
}

function checkStatements(statements: readonly Statement[]): void {
  if (!Array.isArray(statements)) {
    throw new TypeError('transaction takes an array of [sql, params] statements')
  }
  statements.forEach((statement, i) => {
    if (!Array.isArray(statement) || typeof statement[0] !== 'string') {
      throw new TypeError(`statement ${i}: expected [sql, params], with sql a string`)
    }
    const params = statement[1]
    if (params !== undefined && params !== null && typeof params !== 'object') {
      throw new TypeError(`statement ${i}: params must be an array or an object of named values`)
    }
  })
}

function closedError(): KvsqlError {
  return new KvsqlError('the database is closed')
}

function rolledBackError(): KvsqlError {
  return new KvsqlError(
    'the transaction was rolled back by a statement that failed: nothing more runs in it',
  )
}

function isThenable(value: unknown): boolean {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function describeConflicts(conflicts: readonly Conflict[]): string {
  const shown = conflicts
    .slice(0, 3)
    .map((c) =>
      c.kind === 'FOREIGN_KEY'
        ? `${c.count} broken foreign key${c.count === 1 ? '' : 's'}`
        : `${c.kind} on ${c.op} of "${c.table}" key ${JSON.stringify(c.pk, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
    )
  if (conflicts.length > shown.length) shown.push(`${conflicts.length - shown.length} more`)
  return shown.join('; ') || 'aborted'
}
