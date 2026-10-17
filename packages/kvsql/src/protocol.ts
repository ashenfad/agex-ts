/**
 * The messages between a page's client and its worker, and between the
 * workers of one database in different tabs; and errors as they cross
 * them.
 *
 * Everything here is structured-cloned, so values keep their types
 * (`Uint8Array`, bigint), but an error arrives as a plain `Error`
 * without its class or fields. Errors therefore travel as a
 * {@link SerializedError} and are rebuilt on the other side as the
 * same class, for `instanceof`.
 */

import {
  ConnectionLostError,
  CorruptEntryError,
  KvsqlError,
  LogError,
  RebaseRequiredError,
  RefusedError,
  ReplayError,
  SqliteError,
  StatementError,
} from './errors'
import type { CopyResult, FlushPolicy, FlushResult, QueryResult, Recovery } from './log'

/**
 * What a worker needs to open a database. Every tab passes the same
 * config for the same database. It is structured-cloned to the worker,
 * so it holds plain data; a worker's opener may read fields of its own
 * beside these.
 */
export interface DatabaseConfig {
  /**
   * Names the database across the origin: its Web Lock and its
   * `BroadcastChannel` are `kvsql:<id>`. Every tab must use the same id
   * for the same database file, and different ids for different files:
   * the lock is what keeps a second connection, or a delete, away from
   * an open file.
   */
  id: string
  /** The database file's name in its directory. Default `db.sqlite`. */
  name?: string
  /** The log's kvgit branch. Default `kvsql/<id>`. */
  branch?: string
  /**
   * A detached copy: the file alone, with no log, so its writes are
   * recorded nowhere (`openDetached`), as a test's copy is. Made by a
   * logged database's `copy()`, or empty. It has no `branch`, and its
   * opener needn't give a repository.
   */
  detached?: boolean
  /** How error messages name the database, e.g. `'agex.db'`. */
  label?: string
  /** `PRAGMA foreign_keys` for the connection. Default true. */
  foreignKeys?: boolean
  flush?: FlushPolicy
}

/** The default file name of a database. */
export const DEFAULT_NAME = 'db.sqlite'

/** The name of a database's Web Lock and `BroadcastChannel`. */
export function lockName(id: string): string {
  return `kvsql:${id}`
}

/**
 * A database's file name and branch, with the defaults filled in; a
 * detached copy's branch is empty.
 */
export function resolveConfig(config: DatabaseConfig): { name: string; branch: string } {
  if (typeof config?.id !== 'string' || config.id === '') {
    throw new TypeError('kvsql: the database config needs an id, a non-empty string')
  }
  const name = config.name ?? DEFAULT_NAME
  if (config.detached === true) {
    if (config.branch !== undefined) {
      throw new TypeError('kvsql: a detached database has no log, so no branch')
    }
    return { name, branch: '' }
  }
  return { name, branch: config.branch ?? `kvsql/${config.id}` }
}

/** What this worker's part in serving the database is. */
export type Role =
  /** Waiting for the lock, and not yet told which worker holds it. */
  | 'connecting'
  /** Waiting for the lock, and sending requests to the worker holding it. */
  | 'forwarding'
  /** Holding the lock, and opening the database. */
  | 'opening'
  /** Holding the lock with the database open, serving every tab. */
  | 'holder'
  /** Holding the lock, but the database failed to open; see `error`. */
  | 'failed'
  /** Closed: the client closed, or the database was deleted. */
  | 'closed'

/** Where a connection's worker stands. */
export interface Status {
  /** This worker's id. */
  worker: string
  role: Role
  /** The worker holding the database's lock, if known (this one, when it does). */
  holder: string | null
  /**
   * How many times opening the file was retried because another worker
   * still had it (one that just lost the lock, and hasn't released its
   * file handles yet).
   */
  openRetries: number
  /** Why the database failed to open, in role `failed`. */
  error?: unknown
  /** Whether the database was deleted. */
  deleted: boolean
}

/** The open database's state, from the worker holding it. */
export interface DatabaseInfo {
  /** The worker holding the database. */
  holder: string
  name: string
  /** The log's branch; empty for a detached copy. */
  branch: string
  /** Whether the database is a detached copy, with no log. */
  detached: boolean
  /** The number of the last transaction (0 for none). */
  seq: number
  /** Transactions in the file not yet flushed to the log. */
  pendingCount: number
  schemaVersion: number
  /** The log commit the flushed transactions end at. */
  base: string
  /** What the holder's open did to bring the file level with the log. */
  recovery: Recovery
  /** Why the last flush the policy started failed, if it did. */
  flushError?: unknown
}

export interface DeleteOptions {
  /**
   * Keep the log: delete only this device's file, which the worker
   * rebuilds from the log at once (and every tab goes on using). Its
   * pending transactions are flushed first, and if that fails nothing
   * is deleted; a database that failed to open loses its unflushed
   * transactions. Default false: delete the file and the log's branch
   * (and, with the default opener, its storage), and close every tab's
   * connection.
   */
  keepLog?: boolean
}

/** The requests a client makes, with their arguments and results. */
export interface Ops {
  query: { args: [sql: string, params: unknown]; result: QueryResult }
  transaction: { args: [statements: unknown]; result: QueryResult[] }
  flush: { args: []; result: FlushResult | null }
  export: { args: []; result: Uint8Array }
  copy: { args: [target: DatabaseConfig]; result: CopyResult }
  info: { args: []; result: DatabaseInfo }
  delete: { args: [options: DeleteOptions]; result: undefined }
  status: { args: []; result: Status }
  close: { args: []; result: undefined }
}

export type Op = keyof Ops

/**
 * Requests that are safe to run twice, so one sent to a worker that
 * went away before answering is sent again to the next one: reading
 * the state or the file, flushing whatever is pending, and deleting. A query or a
 * transaction might write, and might have committed, so it fails with
 * {@link ConnectionLostError} instead.
 */
export const RETRY_SAFE: ReadonlySet<Op> = new Set<Op>(['flush', 'export', 'info', 'delete'])

/** Marks the message a client sends a worker to connect to a database. */
export const CONNECT = 'kvsql:connect'

/** Client to worker, on the worker itself: connect `port` to the database `config`. */
export interface ConnectMessage {
  type: typeof CONNECT
  config: DatabaseConfig
  port: MessagePort
}

/** Client to worker, on the connection's port. */
export interface Request {
  id: number
  op: Op
  args: unknown[]
}

/** Worker to client, on the connection's port: a request's outcome, or an event. */
export type Response =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: SerializedError }
  | { event: 'flushError'; error: SerializedError }

/** Between the workers of one database, on its `BroadcastChannel`. */
export type ChannelMessage =
  /** A worker joined: the holder answers with `holder`. */
  | { t: 'hello'; from: string }
  /**
   * `from` holds the lock: send requests to it. `epoch` orders holders:
   * each takes one larger than any it has seen (and than the clock), so
   * a late announcement from an earlier holder is recognised as one.
   */
  | { t: 'holder'; from: string; epoch: number }
  /** A forwarded request. */
  | { t: 'request'; from: string; to: string; rid: number; op: Op; args: unknown[] }
  /**
   * A forwarded request's outcome. `retry`: the holder is closing and
   * didn't run it; send it to the next holder.
   */
  | {
      t: 'response'
      from: string
      to: string
      rid: number
      ok: boolean
      value?: unknown
      error?: SerializedError
      retry?: boolean
    }
  /**
   * The holder closed the database and is releasing the lock. It
   * answered every request it ran before sending this, so any still
   * unanswered never ran.
   */
  | { t: 'released'; from: string }
  /**
   * The database was deleted: every worker closes, except where the
   * deletion `id` was already applied (by the worker that asked for it).
   */
  | { t: 'deleted'; from: string; id: string }
  /** A flush the holder's policy started failed. */
  | { t: 'flushError'; from: string; error: SerializedError }

// --- Errors ---

/** An error as it crosses a message boundary. */
export interface SerializedError {
  name: string
  message: string
  stack?: string
  cause?: SerializedError
  /**
   * The error's own fields with plain values (a `StatementError`'s
   * `index`, a `SqliteError`'s `rc`, SQLite's `resultCode`, ...).
   */
  fields?: Record<string, string | number | boolean | bigint | null>
}

type ErrorClass = new (...args: never[]) => Error

/**
 * The classes an error is rebuilt as, by name: kvsql's own and
 * JavaScript's. Any other error arrives as an `Error` with its `name`.
 */
const CLASSES: Record<string, ErrorClass> = {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
  KvsqlError,
  SqliteError,
  RefusedError,
  StatementError,
  LogError,
  CorruptEntryError,
  ReplayError,
  RebaseRequiredError,
  ConnectionLostError,
}

const FIELD_TYPES = new Set(['string', 'number', 'boolean', 'bigint'])

/** `err` as plain data, its causes too (to a depth of 8). */
export function serializeError(err: unknown, depth = 0): SerializedError {
  if (!(err instanceof Error)) {
    return { name: 'Error', message: typeof err === 'string' ? err : String(err) }
  }
  const out: SerializedError = { name: err.name, message: err.message }
  if (typeof err.stack === 'string') out.stack = err.stack
  if (err.cause !== undefined && depth < 8) out.cause = serializeError(err.cause, depth + 1)
  const fields: NonNullable<SerializedError['fields']> = {}
  for (const key of Object.keys(err)) {
    if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue
    const value = (err as unknown as Record<string, unknown>)[key]
    if (value === null || FIELD_TYPES.has(typeof value)) fields[key] = value as never
  }
  if (Object.keys(fields).length > 0) out.fields = fields
  return out
}

/**
 * The error `s` describes, as its own class when that is one of
 * kvsql's or JavaScript's (so `instanceof` works), with its message,
 * fields, cause and the stack where it was thrown. A DOMException
 * (OPFS's errors, `QuotaExceededError`) is rebuilt as one.
 */
export function reviveError(s: SerializedError): Error {
  const cause = s.cause === undefined ? undefined : reviveError(s.cause)
  let err: Error
  const Class = Object.hasOwn(CLASSES, s.name) ? CLASSES[s.name] : undefined
  if (Class) {
    // Construct as an Error with the class's prototype, without running
    // the class's own constructor, whose arguments differ per class.
    err = Reflect.construct(
      Error,
      cause === undefined ? [s.message] : [s.message, { cause }],
      Class,
    ) as Error
    // kvsql's classes set `name` as an instance field, which the
    // constructor skipped; JavaScript's have it on the prototype.
    if (Class !== Error && !isNativeError(Class)) {
      Object.defineProperty(err, 'name', {
        value: s.name,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
  } else if (typeof DOMException === 'function' && DOM_EXCEPTIONS.has(s.name)) {
    err = new DOMException(s.message, s.name)
  } else {
    err = cause === undefined ? new Error(s.message) : new Error(s.message, { cause })
    err.name = s.name
  }
  for (const [key, value] of Object.entries(s.fields ?? {})) {
    Object.defineProperty(err, key, { value, writable: true, enumerable: true, configurable: true })
  }
  if (s.stack !== undefined) {
    Object.defineProperty(err, 'stack', { value: s.stack, writable: true, configurable: true })
  }
  return err
}

function isNativeError(Class: ErrorClass): boolean {
  return (
    Class === TypeError ||
    Class === RangeError ||
    Class === SyntaxError ||
    Class === ReferenceError ||
    Class === EvalError ||
    Class === URIError
  )
}

/** DOMException names a storage call can throw. */
const DOM_EXCEPTIONS = new Set([
  'AbortError',
  'DataCloneError',
  'InvalidModificationError',
  'InvalidStateError',
  'NoModificationAllowedError',
  'NotAllowedError',
  'NotFoundError',
  'NotReadableError',
  'QuotaExceededError',
  'SecurityError',
  'TypeMismatchError',
  'UnknownError',
])
