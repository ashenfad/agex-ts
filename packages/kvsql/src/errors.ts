/**
 * kvsql's errors. Everything kvsql throws about a database or a
 * changeset derives from {@link KvsqlError}; arguments that are invalid
 * on their face throw `TypeError`.
 */

import type { Conflict } from './changeset'

/** Base class for kvsql's errors. */
export class KvsqlError extends Error {
  override readonly name: string = 'KvsqlError'
}

/** A SQLite C call failed with a result code. */
export class SqliteError extends KvsqlError {
  override readonly name: string = 'SqliteError'
  /** SQLite's result code, e.g. 21 for `SQLITE_MISUSE`. */
  readonly rc: number

  constructor(what: string, rc: number, rcName: string, detail?: string) {
    super(`${what} failed: ${rcName || `rc ${rc}`}${detail ? `: ${detail}` : ''}`)
    this.rc = rc
  }
}

/**
 * A statement the schema guard refused. The message says what was
 * refused and what to do instead; `cause` is SQLite's own error.
 */
export class RefusedError extends KvsqlError {
  override readonly name: string = 'RefusedError'
}

/**
 * A statement of a `transaction([...])` call failed, and the whole call
 * was rolled back. `index` is the statement's position in the call
 * (from 0); `cause` is the error it failed with (SQLite's, or a
 * {@link RefusedError}), whose message this one repeats.
 */
export class StatementError extends KvsqlError {
  override readonly name: string = 'StatementError'

  constructor(
    readonly index: number,
    cause: unknown,
  ) {
    super(`statement ${index}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    })
  }
}

/**
 * The changeset log and the database file disagree, or the log is not
 * one this version can read. Nothing was changed by the call that
 * threw it.
 */
export class LogError extends KvsqlError {
  override readonly name: string = 'LogError'
}

/**
 * An epoch's snapshot (see `epoch.ts`) doesn't match its record: a
 * chunk is missing or altered, it doesn't decompress, or it isn't the
 * size the record says. The database file isn't rebuilt from it.
 */
export class CorruptSnapshotError extends LogError {
  override readonly name: string = 'CorruptSnapshotError'

  constructor(
    /** The snapshot's last commit, or the commit whose record names it. */
    readonly commit: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`snapshot ${commit}: ${message}`, options)
  }
}

/**
 * A log entry's stored bytes don't match what its commit records (its
 * length or SHA-256 digest), or aren't in a format this version reads:
 * the entry was truncated, altered or written by something else.
 */
export class CorruptEntryError extends LogError {
  override readonly name: string = 'CorruptEntryError'

  constructor(
    /** The log commit holding the entry. */
    readonly commit: string,
    message: string,
  ) {
    super(`log entry ${commit}: ${message}`)
  }
}

/**
 * Replaying the log stopped: an entry doesn't apply to the database as
 * it stands (a conflict, a schema version or column count that doesn't
 * match, a schema change that failed). In a log written only by
 * appending, none of these happen, so the database and the log have
 * diverged. The replay's last transaction was rolled back; what it
 * applied before that stays applied and is resumed from on the next
 * open.
 */
export class ReplayError extends LogError {
  override readonly name: string = 'ReplayError'

  constructor(
    /** The log commit holding the entry that failed. */
    readonly commit: string,
    /** The first transaction number of the part that failed. */
    readonly seq: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`replaying log entry ${commit} at transaction ${seq}: ${message}`, options)
  }
}

/**
 * The database holds transactions its log's branch doesn't (pending, or
 * flushed to entries only it has), and the branch has entries this
 * database didn't write (another copy's), and the two conflict, so its
 * transactions can't be rebased onto those entries as they are. The
 * file and the log are left as they were; `rebase()` with `keep`
 * settles it.
 */
export class RebaseRequiredError extends LogError {
  override readonly name: string = 'RebaseRequiredError'
  /** What re-applying this database's transactions met. */
  readonly conflicts: readonly Conflict[]
  /** The side whose schema change stopped the rebase, if one did. */
  readonly schemaChange: 'mine' | 'theirs' | null

  constructor(
    /** How many transactions the database holds that the log doesn't. */
    readonly pending: number,
    /** How many log entries the database hasn't applied. */
    readonly entries: number,
    detail: { conflicts?: readonly Conflict[]; schemaChange?: 'mine' | 'theirs' | null } = {},
  ) {
    const conflicts = detail.conflicts ?? []
    const schemaChange = detail.schemaChange ?? null
    const why =
      schemaChange === 'mine'
        ? 'its own schema change'
        : schemaChange === 'theirs'
          ? "the log's schema change"
          : `${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}`
    super(
      `this database has ${pending} transaction${pending === 1 ? '' : 's'} not yet in its log, and the log has ${entries} entr${entries === 1 ? 'y' : 'ies'} it didn't write, which they can't follow (${why}): rebase keeping one side`,
    )
    this.conflicts = conflicts
    this.schemaChange = schemaChange
  }
}

/**
 * A copy of the database is at the point a new epoch's snapshot was
 * taken, holding nothing past it, yet holds something else: its content
 * hash isn't the snapshot's. One of the two went wrong without an error
 * (a change SQLite skipped, a file changed outside the log), so the
 * file is left as it is, on its epoch, rather than moved over.
 */
export class DivergedError extends LogError {
  override readonly name: string = 'DivergedError'

  constructor(
    /** The epoch the file is on. */
    readonly branch: string,
    /** The log commit it is at. */
    readonly base: string,
    /** The snapshot's content hash. */
    readonly expected: string,
    /** The file's. */
    readonly actual: string,
  ) {
    super(
      `the database file on '${branch}' is where the next epoch's snapshot was taken, but holds something else: its content hash is ${actual}, the snapshot's ${expected}`,
    )
  }
}

/**
 * The worker serving a request went away before answering it (its tab
 * closed, or it was terminated), so the request may or may not have
 * run: a write may or may not have committed. Nothing retries it; a
 * caller that retries a write should make it safe to run twice (an
 * upsert, or a check that it hasn't landed). Requests made after this
 * go to the worker that takes over.
 */
export class ConnectionLostError extends KvsqlError {
  override readonly name: string = 'ConnectionLostError'
}
