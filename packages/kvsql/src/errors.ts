/**
 * kvsql's errors. Everything kvsql throws about a database or a
 * changeset derives from {@link KvsqlError}; arguments that are invalid
 * on their face throw `TypeError`.
 */

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
