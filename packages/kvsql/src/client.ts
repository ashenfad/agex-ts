/**
 * The page's side of a database served by a worker: `connect` gives a
 * client with the logged database's calls, each a message to the
 * worker answered by a promise.
 *
 * This module loads neither SQLite nor kvgit, so a page can import it
 * without either.
 */

import type { Params, Statement } from './entry'
import { KvsqlError } from './errors'
import type { CopyResult, EpochResult, FlushResult, QueryResult } from './log'
import {
  CONNECT,
  type ConnectMessage,
  type DatabaseConfig,
  type DatabaseInfo,
  type DeleteOptions,
  type Op,
  type Ops,
  type Request,
  type Response,
  type SerializedError,
  type Status,
  resolveConfig,
  reviveError,
} from './protocol'

export * from './errors'
export type {
  DatabaseConfig,
  DatabaseInfo,
  DeleteOptions,
  Role,
  Status,
} from './protocol'
export type { CopyResult, EpochResult, FlushResult, QueryResult, Recovery } from './log'
export type { Params, Statement } from './entry'

/** Where a client sends its connect message: a `Worker`, usually. */
export interface WorkerLike {
  postMessage(message: unknown, transfer: Transferable[]): void
}

/** The page events a client flushes on. */
export interface PageEvents {
  /** Fires `visibilitychange`; flushed on when `visibilityState` is `'hidden'`. */
  document?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & {
    readonly visibilityState?: string
  }
  /** Fires `pagehide`. */
  window?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
}

export interface ConnectOptions {
  /**
   * Flush when the page is hidden (`visibilitychange` to hidden) and on
   * `pagehide`, best effort: a worker can't see either, and a hidden
   * page may be closed without another event. Default true.
   */
  flushOnHide?: boolean
  /**
   * Where those events come from. Default the global `document` and
   * `globalThis`.
   */
  page?: PageEvents
  /**
   * Called with the error when a flush the worker's policy started
   * failed (in whichever tab's worker holds the database). The
   * transactions stay pending, and a later flush retries them.
   */
  onFlushError?: (err: Error) => void
}

/**
 * Connect to the database `config` served by `worker` (one running
 * `serve`, such as kvsql's default worker). The connection is a
 * `MessageChannel` of its own, so a worker can serve several.
 */
export function connect(
  worker: WorkerLike,
  config: DatabaseConfig,
  options: ConnectOptions = {},
): DatabaseClient {
  resolveConfig(config)
  const { port1, port2 } = new MessageChannel()
  const message: ConnectMessage = { type: CONNECT, config, port: port2 }
  worker.postMessage(message, [port2])
  return new DatabaseClient(port1, options)
}

/**
 * A connection to a database in a worker. Its calls are those of
 * `LoggedDatabase`, run by whichever tab's worker holds the database,
 * one at a time in the order the worker receives them.
 *
 * Errors arrive as the classes they were thrown as (kvsql's errors, and
 * JavaScript's own), with their fields (`StatementError.index`) and
 * cause; any other error arrives as an `Error` with its `name`.
 */
export class DatabaseClient {
  readonly #port: MessagePort
  readonly #waiting = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  readonly #onFlushError: ((err: Error) => void) | undefined
  readonly #unlisten: () => void
  #nextId = 1
  #closing: Promise<void> | null = null

  /** @internal Use {@link connect}. */
  constructor(port: MessagePort, options: ConnectOptions) {
    this.#port = port
    this.#onFlushError = options.onFlushError
    port.onmessage = (event: MessageEvent) => this.#onMessage(event.data as Response)
    this.#unlisten = options.flushOnHide === false ? () => {} : this.#listenForHide(options.page)
  }

  /** Whether `close()` has been called. */
  get closed(): boolean {
    return this.#closing !== null
  }

  /** Run one statement as a transaction. */
  query(sql: string, params?: Params | null): Promise<QueryResult> {
    return this.#call('query', [sql, params ?? null])
  }

  /**
   * Run statements as one transaction: all of them land or none does,
   * and a failure is a `StatementError` naming the statement.
   */
  transaction(statements: readonly Statement[]): Promise<QueryResult[]> {
    return this.#call('transaction', [statements])
  }

  /** Commit every pending transaction to the log as one entry; null if none were pending. */
  flush(): Promise<FlushResult | null> {
    return this.#call('flush', [])
  }

  /**
   * The database as a standalone SQLite file, without kvsql's own
   * tables, from the worker holding it (see `LoggedDatabase.export`).
   */
  export(): Promise<Uint8Array> {
    return this.#call('export', [])
  }

  /**
   * Copy the database, by the worker holding it, to the database
   * `target` names (its config, as a connect to it would pass): a
   * detached copy if `target.detached`, else a logged copy whose log
   * starts from this one's, on `target`'s branch (see
   * `LoggedDatabase.copy`). The worker makes it with its opener and
   * holds `target`'s lock meanwhile, so nothing may have `target`
   * open. Connect to `target` afterwards to use the copy.
   */
  copy(target: DatabaseConfig): Promise<CopyResult> {
    return this.#call('copy', [target])
  }

  /**
   * Start the log's next epoch, by the worker holding the database, and
   * move the database onto it (see `LoggedDatabase.newEpoch`).
   */
  newEpoch(): Promise<EpochResult> {
    return this.#call('epoch', [])
  }

  /** The database's state, from the worker holding it. */
  async info(): Promise<DatabaseInfo> {
    const { flushError, ...info } = (await this.#call('info', [])) as unknown as Omit<
      DatabaseInfo,
      'flushError'
    > & { flushError?: SerializedError }
    return flushError === undefined ? info : { ...info, flushError: reviveError(flushError) }
  }

  /** Where this connection's worker stands: holding the database, forwarding to the holder, ... */
  async status(): Promise<Status> {
    const { error, ...status } = (await this.#call('status', [])) as unknown as Omit<
      Status,
      'error'
    > & { error?: SerializedError }
    return error === undefined ? status : { ...status, error: reviveError(error) }
  }

  /**
   * Delete the database: its file (and journal) and its log branch, by
   * the worker holding its lock, after every call it received before.
   * Every tab's connection closes; their calls fail from then on. With
   * `keepLog`, delete only this device's file, which the worker
   * rebuilds from the log and goes on serving.
   */
  delete(options: DeleteOptions = {}): Promise<void> {
    return this.#call('delete', [options]) as Promise<never>
  }

  /**
   * Close this connection, after its calls made before are answered.
   * When the worker holding the database has no connection left, it
   * flushes and closes the file and lets the lock go, and another
   * tab's worker takes over. Calls after `close()` throw.
   */
  close(): Promise<void> {
    if (this.#closing) return this.#closing
    this.#unlisten()
    this.#closing = this.#send('close', [])
      .then(() => {})
      .finally(() => {
        for (const waiter of this.#waiting.values()) waiter.reject(closedError())
        this.#waiting.clear()
        this.#port.close()
      })
    return this.#closing
  }

  #call<O extends Op>(op: O, args: Ops[O]['args']): Promise<Ops[O]['result']> {
    if (this.#closing) return Promise.reject(closedError())
    return this.#send(op, args)
  }

  #send<O extends Op>(op: O, args: Ops[O]['args']): Promise<Ops[O]['result']> {
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve: resolve as (v: unknown) => void, reject })
      const request: Request = { id, op, args }
      try {
        this.#port.postMessage(request)
      } catch (err) {
        // Arguments that can't be cloned (a function, a DOM node).
        this.#waiting.delete(id)
        reject(err)
      }
    })
  }

  #onMessage(message: Response): void {
    if ('event' in message) {
      if (message.event === 'flushError') {
        try {
          this.#onFlushError?.(reviveError(message.error))
        } catch {}
      }
      return
    }
    const waiter = this.#waiting.get(message.id)
    if (!waiter) return
    this.#waiting.delete(message.id)
    if (message.ok) waiter.resolve(message.value)
    else waiter.reject(reviveError(message.error))
  }

  #listenForHide(page: PageEvents | undefined): () => void {
    const doc =
      page?.document ?? (globalThis as { document?: PageEvents['document'] }).document ?? undefined
    const win =
      page?.window ??
      (typeof (globalThis as { addEventListener?: unknown }).addEventListener === 'function'
        ? (globalThis as unknown as PageEvents['window'])
        : undefined)
    const flush = () => {
      if (!this.#closing) this.flush().catch(() => {})
    }
    const onVisibility = () => {
      if (doc?.visibilityState === 'hidden') flush()
    }
    doc?.addEventListener('visibilitychange', onVisibility)
    win?.addEventListener('pagehide', flush)
    return () => {
      doc?.removeEventListener('visibilitychange', onVisibility)
      win?.removeEventListener('pagehide', flush)
    }
  }
}

function closedError(): Error {
  return new KvsqlError('the database connection is closed')
}
