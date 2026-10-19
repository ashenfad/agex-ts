/**
 * The worker host: a database served from a dedicated worker to the
 * page's clients, with one writer across tabs.
 *
 * Each tab runs its own worker, and a database's file can be open in
 * only one of them (OPFS access handles are exclusive). So the workers
 * of one database share a Web Lock, `kvsql:<id>`: the worker holding it
 * opens the file and keeps it open for as long as it holds the lock.
 * The others wait in the lock's queue and meanwhile send their tabs'
 * requests to the holder over the database's `BroadcastChannel`.
 *
 * When the holder goes away, the browser releases its lock and the
 * next worker in the queue takes it, announces itself, opens the file
 * (the log's open-time recovery runs) and serves every tab from then
 * on. A request that was sent to the old holder and not answered may
 * or may not have run; a query or transaction fails with
 * `ConnectionLostError`, while requests that are safe to run twice
 * (flush, info, delete) are sent again. A holder that closes on its own
 * answers every request it ran before it says it is releasing, so
 * whatever is unanswered then never ran and is sent again.
 *
 * The lock and the channel are injectable, so the handoff runs in Node
 * tests with in-memory stand-ins.
 */

import type { Repo } from '@agex-ts/kvgit'
import { deleteDatabase } from './database'
import { deleteLog } from './epoch'
import { ConnectionLostError, KvsqlError } from './errors'
import type { Directory } from './files'
import { type CopyResult, type LoggedDatabase, openDetached, openLog } from './log'
import {
  CONNECT,
  type ChannelMessage,
  type ConnectMessage,
  type DatabaseConfig,
  type DeleteOptions,
  type Op,
  RETRY_SAFE,
  type Request,
  type Response,
  type Role,
  type SerializedError,
  lockName,
  resolveConfig,
  reviveError,
  serializeError,
} from './protocol'

/** Where a worker keeps a database: the file's directory and the log's repository. */
export interface DatabaseStorage {
  /** The directory holding the database file and its journal. */
  dir: Directory
  /**
   * The kvgit repository holding the log (codec `'bytes'`). A detached
   * copy has no log, so its opener may leave it out.
   */
  repo?: Repo<Uint8Array>
  /** Called after the database closes: release the repository's store. */
  close?(): void | Promise<void>
  /**
   * Called when the database is deleted, after `close`: remove what
   * the opener made for it alone (its directory, its own store).
   */
  destroy?(): void | Promise<void>
  /**
   * Called when the log's older epochs are deleted (`onEpochsDeleted`):
   * what they alone held is left for a sweep of the repository.
   */
  epochsDeleted?(branches: string[]): void
}

/**
 * Opens a database's storage from its config. Called by the worker that
 * takes the database's lock, once per open.
 */
export type Opener<C extends DatabaseConfig = DatabaseConfig> = (
  config: C,
) => DatabaseStorage | Promise<DatabaseStorage>

/** The part of the Web Locks API (`navigator.locks`) the host uses. */
export interface Locks {
  /**
   * Hold lock `name` while `callback` runs. With `ifAvailable`, take it
   * only if it is free now: the callback gets null if it isn't.
   */
  request<T>(
    name: string,
    options: { signal: AbortSignal } | { ifAvailable: true },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>
  query(): Promise<{ pending?: readonly { name?: string }[] }>
}

/** A channel to the other workers of a database, as `BroadcastChannel` is. */
export interface Channel {
  /** Send to every other worker on the channel. */
  postMessage(message: unknown): void
  /** Deliver each message from the others to `listener`. */
  listen(listener: (message: unknown) => void): void
  close(): void
}

/** Where a worker receives the page's connect messages. */
export interface MessageScope {
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

export interface ServeOptions {
  /**
   * Where connect messages arrive. Default `globalThis`, the worker
   * itself. Null: listen nowhere, and pass ports to `server.connect`.
   */
  scope?: MessageScope | null
  /** Default `navigator.locks`. */
  locks?: Locks
  /** Default: a `BroadcastChannel` of that name. */
  channel?: (name: string) => Channel
  /** This worker's id in status and between workers. Default: a random one. */
  workerId?: string
  /**
   * How long a new holder retries opening a file that another worker
   * still has open (a worker that just lost the lock may not have
   * released its file handles yet). Default 10 s.
   */
  openRetryMs?: number
  /**
   * How long a worker that deleted a database holds its lock while the
   * other workers leave the lock's queue, so none of them takes the
   * lock and creates the database again. Default 2 s.
   */
  deleteDrainMs?: number
}

/** A worker's server for the databases its page connects to. */
export interface Server<C extends DatabaseConfig = DatabaseConfig> {
  /** This worker's id. */
  readonly id: string
  /** Serve the database `config` on `port` (a client's end of a `MessageChannel`). */
  connect(config: C, port: MessagePort): void
}

/**
 * Serve databases from this worker: each connect message names a
 * database's config and carries a port, and the database is opened with
 * `open` by whichever worker holds its lock. One worker serves any
 * number of databases (by `id`) and connections.
 */
export function serve<C extends DatabaseConfig>(
  open: Opener<C>,
  options: ServeOptions = {},
): Server<C> {
  const worker = options.workerId ?? randomId()
  const env: Env = {
    worker,
    locks: options.locks ?? (globalThis.navigator?.locks as unknown as Locks),
    channel: options.channel ?? broadcastChannel,
    openRetryMs: options.openRetryMs ?? 10_000,
    deleteDrainMs: options.deleteDrainMs ?? 2_000,
    handledDeletes: new Set(),
  }
  const hosts = new Map<string, DatabaseHost<C>>()
  const incarnations = new Map<string, number>()
  const server: Server<C> = {
    id: worker,
    connect(config, port) {
      let host: DatabaseHost<C> | undefined
      try {
        resolveConfig(config)
        if (!env.locks) throw new KvsqlError('kvsql: the Web Locks API is not available here')
        host = hosts.get(config.id)
        if (host && host.key !== configKey(config)) {
          throw new KvsqlError(
            `kvsql: database ${JSON.stringify(config.id)} is already open in this worker with a different config`,
          )
        }
        if (!host) {
          const n = (incarnations.get(config.id) ?? 0) + 1
          incarnations.set(config.id, n)
          const self = n === 1 ? worker : `${worker}#${n}`
          const created = new DatabaseHost(config, open, env, self, () => {
            if (hosts.get(config.id) === created) hosts.delete(config.id)
          })
          hosts.set(config.id, created)
          host = created
        }
      } catch (err) {
        refuse(port, err)
        return
      }
      host.attach(port)
    },
  }
  const scope =
    options.scope === undefined ? (globalThis as unknown as MessageScope) : options.scope
  if (typeof scope?.addEventListener !== 'function') return server
  scope.addEventListener('message', (event) => {
    const message = event.data as Partial<ConnectMessage> | null
    if (message?.type !== CONNECT || !message.port || !message.config) return
    server.connect(message.config as C, message.port)
  })
  return server
}

interface Env {
  worker: string
  locks: Locks
  channel: (name: string) => Channel
  openRetryMs: number
  deleteDrainMs: number
  /**
   * Deletions this worker has applied, by id: a `deleted` message for
   * one of them arrives late (after the delete's own answer, or from
   * an earlier host of the database in this worker) and must not close
   * a host made since.
   */
  handledDeletes: Set<string>
}

/**
 * How long a request sent to a worker that lost the lock may still be
 * answered by it, after another worker announced it holds the lock.
 */
const LOST_GRACE_MS = 200

/** The first wait between `hello`s while no holder is known, doubling to the most. */
const HELLO_FIRST_MS = 50
const HELLO_MAX_MS = 2_000

/** A request waiting for its outcome. */
interface Pending {
  op: Op
  args: unknown[]
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

/** One database in this worker: its lock, its channel, its connections. */
class DatabaseHost<C extends DatabaseConfig> {
  /** Identifies the config, to refuse a second connect with another. */
  readonly key: string
  readonly #config: C
  readonly #name: string
  readonly #branch: string
  readonly #opener: Opener<C>
  readonly #env: Env
  /**
   * This host's id between workers: the worker's id, with `#<n>` for
   * the n-th host of the same database in one worker, so a host that
   * closed is never mistaken for one that came after it.
   */
  readonly #self: string
  readonly #onGone: () => void
  readonly #channel: Channel
  readonly #abort = new AbortController()

  #role: Role = 'connecting'
  /** The worker holding the lock, if known. */
  #holder: string | null = null
  /**
   * The newest holder accepted, as (epoch, id): an announcement counts
   * only if it is newer. It stays when the holder becomes unknown, so a
   * late announcement from an older holder can't bring that one back.
   */
  #newest: { epoch: number; id: string } = { epoch: Number.NEGATIVE_INFINITY, id: '' }
  /** The largest epoch seen in any announcement. */
  #seenEpoch = 0
  /** This host's epoch while it holds the lock. */
  #epoch = 0
  /** Holders that said they are releasing or closing: never holders again. */
  readonly #gone = new Set<string>()
  #helloTimer: ReturnType<typeof setTimeout> | null = null
  #helloDelay = HELLO_FIRST_MS
  /** Whether this worker holds the lock. */
  #holding = false
  #release: (() => void) | null = null
  /** Set once the last connection closed: remote requests are no longer run. */
  #stopping = false
  #deleted = false
  #openRetries = 0
  #openError: unknown = undefined
  #brokenError: unknown = undefined

  /** Requests waiting for a holder to send them to. */
  #unsent: Pending[] = []
  /** Requests sent to the holder, by request id, with the worker they went to. */
  readonly #inflight = new Map<number, Pending & { to: string }>()
  #nextRid = 1

  /** The holder's calls, one at a time, in order. */
  #chain: Promise<unknown> = Promise.resolve()
  #db: LoggedDatabase | null = null
  #storage: DatabaseStorage | null = null

  /** Each connection's requests not yet answered. */
  readonly #ports = new Map<MessagePort, Set<Promise<unknown>>>()

  constructor(config: C, opener: Opener<C>, env: Env, self: string, onGone: () => void) {
    const { name, branch } = resolveConfig(config)
    this.key = configKey(config)
    this.#config = config
    this.#name = name
    this.#branch = branch
    this.#opener = opener
    this.#env = env
    this.#self = self
    this.#onGone = onGone
    this.#channel = env.channel(lockName(config.id))
    this.#channel.listen((message) => this.#onChannel(message as ChannelMessage))
    this.#seekHolder()
    env.locks
      .request(lockName(config.id), { signal: this.#abort.signal }, () => this.#hold())
      .catch((err: unknown) => {
        // Leaving the queue (closing, or the database was deleted)
        // rejects the request; anything else means no lock to be had.
        if (this.#abort.signal.aborted) return
        this.#broken(err)
      })
  }

  // --- Connections ---

  attach(port: MessagePort): void {
    this.#ports.set(port, new Set())
    port.onmessage = (event: MessageEvent) => this.#onPort(port, event.data as Request)
  }

  #onPort(port: MessagePort, request: Request): void {
    const { id, op, args } = request
    const pending = this.#ports.get(port)
    if (!pending) return
    const outcome =
      op === 'status'
        ? Promise.resolve(this.#status())
        : op === 'close'
          ? this.#closePort(port, pending)
          : this.#dispatch(op, Array.isArray(args) ? args : [])
    if (op !== 'close') {
      pending.add(outcome)
      void outcome.finally(() => pending.delete(outcome)).catch(() => {})
    }
    outcome.then(
      (value) => reply(port, { id, ok: true, value }),
      (err: unknown) => reply(port, { id, ok: false, error: serializeError(err) }),
    )
    if (op === 'close') void outcome.finally(() => port.close()).catch(() => {})
  }

  /**
   * Detach a connection once its earlier requests are answered. The
   * last one to close shuts the host down: the holder flushes and
   * closes the file and releases the lock, so another tab's worker
   * takes over.
   */
  async #closePort(port: MessagePort, pending: Set<Promise<unknown>>): Promise<undefined> {
    await Promise.allSettled([...pending])
    this.#ports.delete(port)
    if (this.#ports.size === 0) await this.#shutdown()
    return undefined
  }

  #status() {
    return {
      worker: this.#self,
      role: this.#role,
      holder: this.#holder,
      openRetries: this.#openRetries,
      deleted: this.#deleted,
      ...(this.#role === 'failed' && { error: serializeError(this.#openError) }),
      ...(this.#brokenError !== undefined && { error: serializeError(this.#brokenError) }),
    }
  }

  // --- Requests ---

  /** Run a request here if this worker holds the lock, or send it to the holder. */
  #dispatch(op: Op, args: unknown[]): Promise<unknown> {
    if (op === 'delete') {
      // The deletion's id rides the request, the answer and the
      // `deleted` broadcast. This worker applies it on the answer,
      // before the client hears of it, so a connect made right after
      // gets a new host, which the broadcast arriving later leaves be.
      const deletion = randomId()
      return this.#route(op, [args[0] ?? {}, deletion]).then((value) => {
        if ((value as { deleted?: unknown } | undefined)?.deleted === deletion) {
          this.#applyDeleted(deletion)
        }
        return undefined
      })
    }
    return this.#route(op, args)
  }

  #route(op: Op, args: unknown[]): Promise<unknown> {
    if (this.#deleted) return Promise.reject(deletedError(this.#config))
    if (this.#role === 'closed') {
      return Promise.reject(this.#brokenError ?? new KvsqlError('the database is closed'))
    }
    if (this.#holding) return this.#execute(op, args)
    return new Promise((resolve, reject) => {
      const pending: Pending = { op, args, resolve, reject }
      if (this.#holder !== null) this.#send(pending, this.#holder)
      else this.#unsent.push(pending)
    })
  }

  #send(pending: Pending, to: string): void {
    const rid = this.#nextRid++
    this.#inflight.set(rid, { ...pending, to })
    this.#post({ t: 'request', from: this.#self, to, rid, op: pending.op, args: pending.args })
  }

  /** Queue a call on the holder's chain. */
  #execute(op: Op, args: unknown[]): Promise<unknown> {
    return this.#enqueue(() => this.#perform(op, args))
  }

  #enqueue<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.#chain.then(fn)
    this.#chain = run.catch(() => {})
    return run
  }

  async #perform(op: Op, args: unknown[]): Promise<unknown> {
    if (this.#deleted) throw deletedError(this.#config)
    if (op === 'delete') {
      const deletion = typeof args[1] === 'string' ? args[1] : randomId()
      return this.#delete((args[0] ?? {}) as DeleteOptions, deletion)
    }
    const db = this.#db
    if (!db) throw this.#openError ?? new KvsqlError('the database is closed')
    switch (op) {
      case 'query':
        return db.query(args[0] as string, args[1] as never)
      case 'transaction':
        return db.transaction(args[0] as never)
      case 'flush':
        return db.flush()
      case 'export':
        return db.export()
      case 'copy':
        return this.#copy(db, args[0] as C)
      case 'epoch':
        return db.newEpoch()
      case 'checkpoint':
        return db.checkpoint(args[0] as string)
      case 'checkpoints':
        return db.checkpoints()
      case 'deleteCheckpoint':
        return db.deleteCheckpoint(args[0] as string)
      case 'restore':
        return db.restore(args[0] as string)
      case 'contentHash':
        return db.contentHash()
      case 'rebase':
        return db.rebase((args[0] as string | null) ?? undefined, (args[1] ?? {}) as never)
      case 'adopt':
        return db.adopt(args[0] as string, (args[1] ?? {}) as never)
      case 'info':
        return {
          holder: this.#self,
          name: db.name,
          branch: db.branch,
          detached: db.detached,
          seq: db.seq,
          pendingCount: db.pendingCount,
          schemaVersion: db.schemaVersion,
          base: db.base,
          recovery: { ...db.recovery },
          ...(db.flushError !== undefined && { flushError: serializeError(db.flushError) }),
        }
      default:
        throw new TypeError(`kvsql: unknown request ${JSON.stringify(op)}`)
    }
  }

  // --- The lock ---

  /** The lock's callback: hold it until the host releases it. */
  #hold(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#release = resolve
      if (this.#role === 'closed') {
        resolve()
        return
      }
      this.#holding = true
      this.#role = 'opening'
      // Newer than every holder this host has heard of, even if the
      // clock stepped back; the clock keeps it newer than holders it
      // hasn't heard of, which held the lock earlier.
      this.#epoch = Math.max(this.#seenEpoch + 1, Date.now())
      this.#seenEpoch = this.#epoch
      this.#newest = { epoch: this.#epoch, id: this.#self }
      this.#post({ t: 'holder', from: this.#self, epoch: this.#epoch })
      this.#setHolder(this.#self)
      void this.#enqueue(() => this.#open())
      for (const pending of this.#unsent.splice(0)) this.#runHere(pending)
    })
  }

  #runHere(pending: Pending): void {
    this.#execute(pending.op, pending.args).then(pending.resolve, pending.reject)
  }

  /**
   * Open the storage and the database. A file still held by the worker
   * that had the lock before is retried with backoff; any other failure
   * leaves the host `failed`, holding the lock, so a delete can still
   * remove a file that won't open.
   */
  async #open(): Promise<void> {
    const deadline = Date.now() + this.#env.openRetryMs
    let delay = 25
    for (;;) {
      try {
        this.#storage ??= await this.#opener(this.#config)
        const { dir, repo, epochsDeleted } = this.#storage
        const { label, foreignKeys, flush, epochs, autoCheckpoints, detached } = this.#config
        const options = {
          dir,
          name: this.#name,
          ...(label !== undefined && { label }),
          ...(foreignKeys !== undefined && { foreignKeys }),
        }
        this.#db =
          detached === true
            ? await openDetached(options)
            : await openLog({
                ...options,
                repo: needRepo(repo, this.#config),
                branch: this.#branch,
                ...(flush !== undefined && { flush }),
                ...(epochs !== undefined && { epochs }),
                ...(autoCheckpoints !== undefined && { autoCheckpoints }),
                onFlushError: (err) => this.#flushFailed(err),
                onEpochError: (err) => this.#flushFailed(err),
                ...(epochsDeleted !== undefined && {
                  onEpochsDeleted: (branches: string[]) => epochsDeleted(branches),
                }),
              })
        this.#openError = undefined
        this.#role = 'holder'
        return
      } catch (err) {
        if (isFileBusy(err) && Date.now() < deadline) {
          this.#openRetries++
          await sleep(delay)
          delay = Math.min(delay * 2, 500)
          continue
        }
        this.#openError = err
        this.#role = 'failed'
        return
      }
    }
  }

  #flushFailed(err: unknown): void {
    const error = serializeError(err)
    this.#post({ t: 'flushError', from: this.#self, error })
    this.#notify(error)
  }

  #notify(error: SerializedError): void {
    for (const port of this.#ports.keys()) reply(port, { event: 'flushError', error })
  }

  // --- Delete ---

  /**
   * Copy the database to the database `target` names, holding its lock
   * while the copy is made: a detached copy if `target` is, else a
   * logged one on its branch. A target that is open anywhere is
   * refused rather than waited for.
   */
  async #copy(db: LoggedDatabase, target: C): Promise<CopyResult> {
    const { name, branch } = resolveConfig(target)
    if (target.id === this.#config.id) {
      throw new KvsqlError(
        `kvsql: database ${JSON.stringify(target.id)} can't be copied onto itself`,
      )
    }
    const result = await this.#env.locks.request(
      lockName(target.id),
      { ifAvailable: true },
      async (lock) => {
        if (lock === null) return null
        const storage = await this.#opener(target)
        try {
          return await db.copy({
            dir: storage.dir,
            name,
            ...(target.detached !== true && { repo: needRepo(storage.repo, target), branch }),
          })
        } finally {
          await storage.close?.()
        }
      },
    )
    if (result === null) {
      throw new KvsqlError(
        `kvsql: database ${JSON.stringify(target.id)} is open, so a copy can't replace it`,
      )
    }
    return result
  }

  /** Runs on the holder's chain, so every call before it has finished. */
  async #delete(
    options: DeleteOptions,
    deletion: string,
  ): Promise<{ deleted: string } | undefined> {
    const db = this.#db
    if (options.keepLog === true && this.#config.detached === true) {
      throw new KvsqlError(
        'kvsql: a detached copy has no log to rebuild its file from: delete it without keepLog',
      )
    }
    if (options.keepLog === true) {
      if (db) {
        // A flush that fails leaves the file, and its transactions, as they were.
        await db.flush()
        await db.close()
        this.#db = null
      }
      try {
        this.#storage ??= await this.#opener(this.#config)
        await deleteDatabase(this.#storage.dir, this.#name)
      } finally {
        this.#role = 'opening'
        await this.#open()
      }
      if ((this.#role as Role) === 'failed') throw this.#openError
      return undefined
    }
    try {
      if (db) {
        this.#db = null
        await db.close()
      }
      const storage = this.#storage ?? (await this.#opener(this.#config))
      this.#storage = storage
      await deleteDatabase(storage.dir, this.#name)
      if (this.#config.detached !== true) {
        // every epoch of the log, wherever the database had moved to
        await deleteLog(needRepo(storage.repo, this.#config), this.#branch)
      }
      this.#storage = null
      await storage.close?.()
      await storage.destroy?.()
    } catch (err) {
      // Part-way deleted: serve nothing but another delete, which
      // starts over.
      this.#openError = err
      this.#role = 'failed'
      throw err
    }
    this.#env.handledDeletes.add(deletion)
    this.#deleted = true
    // While it keeps the lock to drain the queue, this host announces
    // nothing and runs nothing more: hosts made since the deletion wait
    // for the next holder, which starts the database afresh.
    this.#stopping = true
    void this.#finishDeleted(deletion)
    return { deleted: deletion }
  }

  /**
   * Leave the database deleted: keep the lock until the other workers
   * have left its queue (they leave on the `deleted` message), so none
   * of them takes it and creates the database again; then let go.
   */
  async #finishDeleted(deletion: string): Promise<void> {
    this.#onGone()
    this.#role = 'closed'
    this.#failWaiting(deletedError(this.#config))
    // After the delete's own answer, which is posted once the call
    // returns: the others close on this, failing what they still wait for.
    await sleep(0)
    this.#post({ t: 'deleted', from: this.#self, id: deletion })
    const name = lockName(this.#config.id)
    const deadline = Date.now() + this.#env.deleteDrainMs
    while (Date.now() < deadline) {
      const snapshot = await this.#env.locks.query().catch(() => ({ pending: [] }))
      if (!(snapshot.pending ?? []).some((lock) => lock.name === name)) break
      await sleep(25)
    }
    this.#letGo()
  }

  // --- Shutdown ---

  /** The last connection closed. */
  async #shutdown(): Promise<void> {
    this.#onGone()
    this.#stopping = true
    if (this.#deleted || this.#role === 'closed') return
    this.#abort.abort()
    if (this.#holding) {
      await this.#enqueue(async () => {
        const db = this.#db
        this.#db = null
        if (db) await db.close()
        const storage = this.#storage
        this.#storage = null
        await storage?.close?.()
      }).catch(() => {})
      this.#post({ t: 'released', from: this.#self })
    }
    this.#role = 'closed'
    this.#failWaiting(new KvsqlError('the database is closed'))
    this.#letGo()
  }

  #letGo(): void {
    this.#stopSeeking()
    this.#holding = false
    this.#release?.()
    this.#release = null
    this.#abort.abort()
    try {
      this.#channel.close()
    } catch {}
  }

  /** A lock that can't be had: nothing can be served. */
  #broken(err: unknown): void {
    this.#brokenError = err
    this.#role = 'closed'
    this.#onGone()
    this.#failWaiting(err)
    this.#letGo()
  }

  #failWaiting(err: unknown): void {
    for (const pending of this.#unsent.splice(0)) pending.reject(err)
    for (const pending of this.#inflight.values()) pending.reject(err)
    this.#inflight.clear()
  }

  // --- Between workers ---

  #post(message: ChannelMessage): void {
    try {
      this.#channel.postMessage(message)
    } catch {
      // A closed channel: this host is done.
    }
  }

  #onChannel(message: ChannelMessage): void {
    if (!message || typeof message !== 'object' || message.from === this.#self) return
    switch (message.t) {
      case 'hello':
        if (this.#holding && !this.#stopping) {
          this.#post({ t: 'holder', from: this.#self, epoch: this.#epoch })
        }
        return
      case 'holder':
        this.#onHolder(message.from, message.epoch)
        return
      case 'request':
        this.#onRequest(message)
        return
      case 'response':
        this.#onResponse(message)
        return
      case 'released':
        this.#gone.add(message.from)
        if (message.from === this.#holder) this.#holderReleased(message.from)
        return
      case 'deleted':
        if (typeof message.id !== 'string' || this.#env.handledDeletes.has(message.id)) return
        this.#applyDeleted(message.id)
        return
      case 'flushError':
        this.#notify(message.error)
        return
    }
  }

  /**
   * An announcement that `worker` holds the lock. Messages from different
   * workers can arrive out of order, so an old holder's announcement
   * (an answer to a `hello` just before it let go) can come after its
   * successor's: only one newer than the newest accepted counts, and
   * none from a holder that said it was going.
   */
  #onHolder(worker: string, epoch: number): void {
    if (typeof epoch !== 'number' || Number.isNaN(epoch)) return
    this.#seenEpoch = Math.max(this.#seenEpoch, epoch)
    if (this.#holding || this.#gone.has(worker)) return
    const newest = this.#newest
    if (!(epoch > newest.epoch || (epoch === newest.epoch && worker > newest.id))) return
    this.#newest = { epoch, id: worker }
    this.#setHolder(worker)
  }

  /**
   * Ask for the holder until one is known: `hello` now, then again with
   * backoff, which the holder answers by announcing itself.
   */
  #seekHolder(): void {
    if (this.#helloTimer !== null) return
    const ask = () => {
      this.#helloTimer = null
      if (this.#holder !== null || this.#holding || this.#role === 'closed') return
      this.#post({ t: 'hello', from: this.#self })
      this.#helloTimer = setTimeout(ask, this.#helloDelay)
      ;(this.#helloTimer as { unref?: () => void }).unref?.()
      this.#helloDelay = Math.min(this.#helloDelay * 2, HELLO_MAX_MS)
    }
    ask()
  }

  #stopSeeking(): void {
    if (this.#helloTimer !== null) clearTimeout(this.#helloTimer)
    this.#helloTimer = null
    this.#helloDelay = HELLO_FIRST_MS
  }

  /**
   * `worker` holds the lock now. Requests sent to any other worker and
   * not answered may or may not have run: those safe to run twice go
   * to the new holder, and the others fail with ConnectionLostError.
   * Then every waiting request goes to the new holder.
   */
  #setHolder(worker: string): void {
    const resend: Pending[] = []
    const lost: number[] = []
    for (const [rid, pending] of this.#inflight) {
      if (pending.to === worker) continue
      if (RETRY_SAFE.has(pending.op)) {
        this.#inflight.delete(rid)
        resend.push(pending)
      } else {
        lost.push(rid)
      }
    }
    if (lost.length > 0) {
      // Messages from different workers can arrive out of order, so the
      // old holder's last answers may land just after the new holder's
      // announcement: give them a moment before calling them lost.
      setTimeout(() => {
        for (const rid of lost) {
          const pending = this.#inflight.get(rid)
          if (!pending) continue
          this.#inflight.delete(rid)
          pending.reject(lostError(pending.op))
        }
      }, LOST_GRACE_MS)
    }
    this.#holder = worker
    this.#stopSeeking()
    this.#unsent.unshift(...resend)
    if (worker === this.#self) return
    if (this.#role === 'connecting') this.#role = 'forwarding'
    for (const pending of this.#unsent.splice(0)) this.#send(pending, worker)
  }

  /**
   * The holder closed on its own. It answered every request it ran
   * before saying so, so the unanswered ones never ran: they wait for
   * the next holder.
   */
  #holderReleased(worker: string): void {
    for (const [rid, pending] of this.#inflight) {
      if (pending.to !== worker) continue
      this.#inflight.delete(rid)
      this.#unsent.push(pending)
    }
    this.#holder = null
    if (this.#role === 'forwarding') this.#role = 'connecting'
    this.#seekHolder()
  }

  #onRequest(message: Extract<ChannelMessage, { t: 'request' }>): void {
    if (message.to !== this.#self) return
    const answer = (fields: Partial<Extract<ChannelMessage, { t: 'response' }>>) =>
      this.#post({
        t: 'response',
        from: this.#self,
        to: message.from,
        rid: message.rid,
        ok: false,
        ...fields,
      })
    // Not run here: the sender sends it to the next holder.
    if (!this.#holding || this.#stopping) {
      answer({ retry: true })
      return
    }
    this.#execute(message.op, Array.isArray(message.args) ? message.args : []).then(
      (value) => {
        try {
          answer({ ok: true, value })
        } catch (err) {
          answer({ error: serializeError(err) })
        }
      },
      (err: unknown) => answer({ error: serializeError(err) }),
    )
  }

  #onResponse(message: Extract<ChannelMessage, { t: 'response' }>): void {
    if (message.to !== this.#self) return
    const pending = this.#inflight.get(message.rid)
    if (!pending || pending.to !== message.from) return
    this.#inflight.delete(message.rid)
    if (message.retry) {
      // A holder answers `retry` only once it is closing.
      this.#gone.add(message.from)
      this.#unsent.push(pending)
      if (this.#holder === message.from) {
        this.#holder = null
        if (this.#role === 'forwarding') this.#role = 'connecting'
        this.#seekHolder()
      }
    } else if (message.ok) {
      pending.resolve(message.value)
    } else {
      pending.reject(reviveError(message.error ?? { name: 'Error', message: 'request failed' }))
    }
  }

  /**
   * The database was deleted (by the holder this host sent the delete
   * to, or another tab's): stop serving it, leave the lock's queue and
   * close.
   */
  #applyDeleted(deletion: string): void {
    this.#env.handledDeletes.add(deletion)
    if (this.#deleted) return
    this.#deleted = true
    this.#onGone()
    const db = this.#db
    this.#db = null
    if (this.#holding && db) void db.close().catch(() => {})
    this.#role = 'closed'
    this.#failWaiting(deletedError(this.#config))
    this.#letGo()
  }
}

// --- Helpers ---

/** A logged database's repository, which its opener must give. */
function needRepo(repo: Repo<Uint8Array> | undefined, config: DatabaseConfig): Repo<Uint8Array> {
  if (!repo) {
    throw new KvsqlError(
      `kvsql: the opener gave database ${JSON.stringify(config.id)} no repository for its log`,
    )
  }
  return repo
}

function reply(port: MessagePort, message: Response): void {
  try {
    port.postMessage(message)
  } catch (err) {
    if ('id' in message) {
      try {
        port.postMessage({ id: message.id, ok: false, error: serializeError(err) })
      } catch {}
    }
  }
}

/** Answer every request on `port` with `err`. */
function refuse(port: MessagePort, err: unknown): void {
  const error = serializeError(err)
  port.onmessage = (event: MessageEvent) => {
    const { id, op } = event.data as Request
    reply(port, op === 'close' ? { id, ok: true, value: undefined } : { id, ok: false, error })
    if (op === 'close') port.close()
  }
}

function broadcastChannel(name: string): Channel {
  const channel = new BroadcastChannel(name)
  return {
    postMessage: (message) => channel.postMessage(message),
    listen: (listener) => {
      channel.onmessage = (event: MessageEvent) => listener(event.data)
    },
    close: () => channel.close(),
  }
}

function lostError(op: Op): ConnectionLostError {
  return new ConnectionLostError(
    `the worker running this ${op} went away before answering: it may or may not have committed`,
  )
}

function deletedError(config: DatabaseConfig): KvsqlError {
  return new KvsqlError(`${config.label ?? 'the database'} was deleted`)
}

/**
 * Whether opening failed because another worker still has the file:
 * OPFS refuses a second access handle with NoModificationAllowedError
 * (Chromium, Firefox) or InvalidStateError (WebKit).
 */
function isFileBusy(err: unknown): boolean {
  return (
    typeof DOMException === 'function' &&
    err instanceof DOMException &&
    (err.name === 'NoModificationAllowedError' || err.name === 'InvalidStateError')
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * A config as a canonical string: equal for configs that clone to the
 * same value, different otherwise. Each value becomes a tagged node
 * (`['s', text]`, `['n', number]`, `['b', bigint digits]`, `['t']`,
 * `['f']`, `['z']` for null, `['a', ...items]`, `['o', [key, node],
 * ...]` with keys sorted), so no two kinds of value share an encoding.
 * As in JSON, object members that are undefined (or functions or
 * symbols, which don't clone) are left out; in an array they are
 * `['u']`.
 */
export function configKey(config: DatabaseConfig): string {
  return JSON.stringify(canonical(config))
}

type Node = readonly unknown[]

function canonical(value: unknown): Node {
  switch (typeof value) {
    case 'string':
      return ['s', value]
    case 'number':
      return ['n', Object.is(value, -0) ? '-0' : String(value)]
    case 'bigint':
      return ['b', value.toString()]
    case 'boolean':
      return [value ? 't' : 'f']
    case 'undefined':
    case 'function':
    case 'symbol':
      return ['u']
  }
  if (value === null) return ['z']
  if (Array.isArray(value)) return ['a', ...value.map(canonical)]
  if (value instanceof Date) return ['d', String(value.getTime())]
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    return ['v', value.constructor.name, Array.from(bytes).join(',')]
  }
  const members = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function' && typeof v !== 'symbol')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => [k, canonical(v)])
  return ['o', ...members]
}
