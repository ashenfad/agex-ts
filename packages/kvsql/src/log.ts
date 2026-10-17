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
} from '@agex-ts/kvgit'
import type { Database, SqlValue, Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import {
  type Conflict,
  INTERNAL_TABLE_PREFIX,
  type Session,
  applyChangeset,
  changesetTables,
  combineChangesets,
  startSession,
} from './changeset'
import {
  type DatabaseFile,
  copyDatabase,
  deleteDatabase,
  openDatabase,
  vacuumDatabase,
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
  encodeSqlBody,
  entryInfo,
  parseEntryInfo,
  schemaAfter,
  sha256Hex,
} from './entry'
import {
  type SnapshotRecord,
  currentEpoch,
  epochBranch,
  epochsOf,
  finished,
  parseEpoch,
  readSnapshot,
  restoreSnapshot,
  snapshotCommit,
  writeSnapshot,
} from './epoch'
import {
  CorruptEntryError,
  KvsqlError,
  LogError,
  RebaseRequiredError,
  RefusedError,
  ReplayError,
  StatementError,
} from './errors'
import type { Directory } from './files'
import { type SchemaGuard, checkSchema, installGuard } from './guard'
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
const DEFAULT_EPOCH_RATIO = 0.5
const DEFAULT_EPOCH_MIN_BYTES = 8 << 20

/** The base a snapshot's file records, until it is opened on its epoch and given the snapshot's commit. */
const SNAPSHOT_BASE = 'snapshot'

/** The file, beside the database's own, a snapshot is made in before it's committed. */
const snapshotName = (name: string): string => `${name}-snapshot`

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
  previous: { branch: string; base: string; pending: string | null }
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
 * `transaction`, `flush`, `close`, ...) run one at a time, in the order
 * they were made.
 */
export class LoggedDatabase {
  readonly name: string
  /** What opening did to bring the file level with the log. */
  readonly recovery: Recovery

  readonly #sqlite3: Sqlite3Static
  readonly #file: DatabaseFile
  readonly #db: Database
  readonly #guard: SchemaGuard
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
  /** The epoch being started, if one is. */
  #epoch: Promise<EpochResult> | null = null
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
    this.#branch = branch
    this.recovery = { ownFlush: false, entries: 0, transactions: 0, snapshot: false }
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
    this.#meta = meta
    this.#pending = pending
  }

  /** @internal Use {@link openLog}. */
  static async open(options: LogOptions): Promise<LoggedDatabase> {
    checkOptions(options)
    const branch = await currentEpoch(options.repo, options.branch)
    const rebuilt = await prepareFile(options, branch)
    const wt = await options.repo.worktree(branch, { create: true })
    const log = await LoggedDatabase.#start(options, branch, wt)
    try {
      Object.assign(log.recovery, await log.#catchUp(), { snapshot: rebuilt })
      await log.#readEpoch()
    } catch (err) {
      log.#file.close()
      throw err
    }
    await log.#tidy()
    if (log.#pending > 0) log.#arm()
    return log
  }

  /** @internal Use {@link openDetached}. */
  static openDetached(options: DetachedOptions): Promise<LoggedDatabase> {
    return LoggedDatabase.#start(options, DETACHED, null)
  }

  static async #start(
    options: Partial<LogOptions> & DetachedOptions,
    branch: string,
    wt: Worktree<Uint8Array> | null,
  ): Promise<LoggedDatabase> {
    const sqlite3 = await loadSqlite()
    const file = await openDatabase(options.dir, options.name)
    try {
      const foreignKeys = options.foreignKeys ?? true
      file.db.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`)
      const guard = installGuard(
        sqlite3,
        file.db,
        options.label === undefined ? {} : { label: options.label },
      )
      const { meta, pending } = guard.trusted(() => {
        initFile(file.db, branch)
        return readPosition(file.db, branch)
      })
      return new LoggedDatabase(options, branch, sqlite3, file, guard, wt, meta, pending)
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
   * Commit every pending transaction to the log as one entry. Returns
   * null if none were pending.
   *
   * @throws RebaseRequiredError if another copy of the database
   *   flushed to the branch first.
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
    const copy = await openDatabase(dir, name)
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
      file = await openDatabase(dir, name)
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
    return this.#serial(async () => {
      const { results, logged, bytes } = this.#transact(statements, single)
      if (logged && this.#reaches(bytes)) {
        // the new epoch's snapshot holds it, so it never becomes a log entry
        this.#startEpochReporting()
        this.#arm()
      } else if (logged === 'sql' || (logged && this.#every > 0 && this.#pending >= this.#every)) {
        await this.#flushReporting()
      } else if (logged) {
        this.#arm()
      }
      return results
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
   * Run a call's statements as one file transaction, recording what
   * they changed in the pending table inside it.
   */
  #transact(
    statements: readonly Statement[],
    single: boolean,
  ): { results: QueryResult[]; logged: ItemKind | undefined; bytes: number } {
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
      const results = statements.map((statement, i) => {
        try {
          const result = guard.run(() => this.#statement(statement))
          // The guard refuses BEGIN, COMMIT and ROLLBACK; a statement
          // that ended the transaction anyway must not commit unlogged.
          if (capi.sqlite3_get_autocommit(db) !== 0) {
            throw new KvsqlError('the statement ended the transaction')
          }
          return result
        } catch (err) {
          throw single ? err : new StatementError(i, err)
        }
      })

      let item: { kind: ItemKind; body: Uint8Array } | undefined
      // A statement that could change the schema, confirmed by the file:
      // `CREATE TABLE IF NOT EXISTS` on a table that exists, run by an
      // app on every load, changes nothing and logs as rows do.
      if (guard.schemaChanged && (guard.analyzed || this.#header() !== header)) {
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
      return { results, logged: item?.kind, bytes: item?.body.byteLength ?? 0 }
    } catch (err) {
      this.#rollback()
      throw err
    } finally {
      session?.dispose()
    }
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

  async #flush(retried = false): Promise<FlushResult | null> {
    this.#disarm()
    // Committing a snapshot for a new epoch: the switch to it arms again.
    if (this.#holding) return null
    if (this.#pending === 0) return null
    // A flush whose commit landed but whose delete didn't leaves the
    // file's base behind the log; settle that before writing another.
    if (this.#wt.head !== this.#meta.base) await this.#catchUp()
    const items = this.#readPending()
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
        return this.#flush(true)
      }
      throw err
    }
    const commit = this.#wt.head
    const next: Meta = { ...this.#meta, base: commit, baseSeq: last.seq, appliedSeq: last.seq }
    this.#inTransaction(() => {
      this.#exec('DELETE FROM _kvsql_pending WHERE seq <= ?', [last.seq])
      this.#saveMeta(next)
    })
    this.#meta = next
    this.#pending -= items.length
    this.#flushError = undefined
    this.#logBytes = total
    if (this.#reaches(total)) this.#startEpochReporting()
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
      if (shot) await deleteDatabase(this.#file.directory, shot.tmp).catch(() => {})
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
    const repo = this.#repo
    // The snapshot must hold every entry of the log it replaces.
    await this.#wt.refresh()
    if (this.#wt.head !== this.#meta.base) await this.#catchUp()
    const branch = epochBranch(parsed.log, parsed.n + 1)
    if (await repo.branches.has(branch)) {
      if (await finished(repo, branch)) {
        throw new LogError(`the log's next epoch, '${branch}', already exists`)
      }
      // left by an epoch that didn't finish
      await repo.branches.delete(branch)
    }
    const dir = this.#file.directory
    const tmp = snapshotName(this.name)
    await vacuumDatabase(this.#file, dir, tmp, (sql) => this.#exec(sql))
    const seq = this.seq
    const pending = await pendingDigest(this.#sqlite3, this.#readPending())
    const snap = await openDatabase(dir, tmp)
    try {
      // the pending rows' pages are freed as zeros, which gzip all but drops
      snap.db.exec('PRAGMA secure_delete = ON')
      snap.db.exec('BEGIN IMMEDIATE')
      snap.db.exec('DELETE FROM _kvsql_pending')
      snap.db.exec({
        sql: 'UPDATE _kvsql_meta SET branch = ?, base = ?, base_seq = ?, applied_seq = ?, next_seq = ? WHERE id = 1',
        bind: [branch, SNAPSHOT_BASE, seq, seq, seq + 1],
      })
      snap.db.exec('COMMIT')
    } finally {
      snap.close()
    }
    this.#holding = true
    return {
      branch,
      tmp,
      seq,
      schema: this.#meta.schema,
      previous: { branch: this.#branch, base: this.#meta.base, pending },
    }
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
   * old epoch's branch goes.
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
    if ((await repo.branches.get(shot.previous.branch)) !== shot.previous.base) {
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
    const next: Meta = { ...this.#meta, base: commit, baseSeq: shot.seq, appliedSeq: shot.seq }
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
    const previous = this.#branch
    this.#meta = next
    this.#pending -= dropped
    this.#branch = shot.branch
    this.#log = { repo, wt }
    this.#logBytes = 0
    this.#snapshotGzipped = record.gzipped
    try {
      await repo.branches.delete(previous)
    } catch (err) {
      // the next open deletes it
      if (!(err instanceof UnknownBranchError)) this.#reportEpochError(err)
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

  /**
   * Delete what an epoch that moved on, or one that didn't finish,
   * left: the log's older epochs, and a snapshot file.
   */
  async #tidy(): Promise<void> {
    try {
      const parsed = parseEpoch(this.#branch)
      if (parsed) {
        for (const epoch of await epochsOf(this.#repo, parsed.log)) {
          if (epoch.n < parsed.n) await this.#repo.branches.delete(epoch.branch)
        }
      }
      const dir = this.#file.directory
      const tmp = snapshotName(this.name)
      if (await dir.exists(tmp)) await deleteDatabase(dir, tmp)
    } catch (err) {
      this.#reportEpochError(err)
    }
  }

  // --- Recovery and replay ---

  /**
   * Bring the file level with the branch's tip: drop this file's own
   * flush if the log has it, then replay every entry after the file's
   * base.
   *
   * @throws RebaseRequiredError if the file has pending transactions
   *   and the log has entries it didn't write.
   */
  async #catchUp(): Promise<Recovery> {
    const recovery: Recovery = { ownFlush: false, entries: 0, transactions: 0, snapshot: false }
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
        throw new RebaseRequiredError(this.#pending, entries.length)
      }
    }
    if (entries.length > 0) {
      recovery.entries = entries.length
      recovery.transactions = await this.#replay(entries)
    }
    return recovery
  }

  /**
   * The log entries from just after the file's base to `tip`, oldest
   * first, checked to be a line of consecutive entries.
   */
  async #walk(tip: string): Promise<LogEntry[]> {
    const base = this.#meta.base
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
    let seq = this.#meta.baseSeq
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
  #checkChangeset(piece: Piece, columns: Map<string, number>): string | undefined {
    if (piece.schema !== this.#meta.schema) {
      return `it was written under schema version ${piece.schema}, but the database is at version ${this.#meta.schema}`
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
    file = await openDatabase(dir, name)
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
 * an older epoch with nothing pending; or, if it is where the snapshot
 * was taken from (a crash stopped the move), finish moving it over.
 * Anything else is left for opening to take or refuse. Whether the
 * file was rebuilt.
 */
async function prepareFile(options: LogOptions, branch: string): Promise<boolean> {
  const { repo, dir, name } = options
  if (!(await repo.branches.has(branch))) return false
  const tip = await repo.branches.get(branch)
  const record = await readSnapshot(repo, tip)
  if (!record) return false
  const file = await peekFile(dir, name)
  if (file === 'other') return false
  const rebuild = async () => {
    const commit = await snapshotCommit(repo, tip)
    await restoreSnapshot(repo, commit, record, dir, name)
    await anchor(dir, name, branch, commit, record.seq, false)
    return true
  }
  if (file === 'fresh') return rebuild()
  if (file.base === SNAPSHOT_BASE) {
    // rebuilt, and stopped before it was given the snapshot's commit
    if (file.baseSeq !== record.seq) return rebuild()
    await anchor(dir, name, branch, await snapshotCommit(repo, tip), record.seq, false)
    return true
  }
  if (file.branch === branch) return false
  const ours = parseEpoch(file.branch)
  const theirs = parseEpoch(branch)
  if (!ours || !theirs || ours.log !== theirs.log || ours.n >= theirs.n) return false
  const { previous } = record
  if (
    previous?.branch === file.branch &&
    previous.base === file.base &&
    (await pendingThrough(dir, name, file.baseSeq, record.seq)) === previous.pending
  ) {
    // the file the snapshot was taken from, which a crash stopped moving
    await anchor(dir, name, branch, await snapshotCommit(repo, tip), record.seq, true)
    return false
  }
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
  const file = await openDatabase(dir, name)
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
): Promise<void> {
  const file = await openDatabase(dir, name)
  try {
    file.db.exec('BEGIN IMMEDIATE')
    try {
      if (dropPending) {
        file.db.exec({ sql: 'DELETE FROM _kvsql_pending WHERE seq <= ?', bind: [seq] })
      }
      file.db.exec({
        sql: 'UPDATE _kvsql_meta SET branch = ?, base = ?, base_seq = ?, applied_seq = ? WHERE id = 1',
        bind: [branch, commit, seq, seq],
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
  if (typeof options.branch !== 'string' || options.branch === '') {
    throw new TypeError('openLog: branch must be a non-empty string')
  }
  for (const key of ['every', 'maxAgeMs'] as const) {
    const value = options.flush?.[key]
    if (value !== undefined && !(Number.isSafeInteger(value) && value >= 0)) {
      throw new TypeError(`openLog: flush.${key} must be a whole number >= 0`)
    }
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
