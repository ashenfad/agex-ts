/**
 * In-memory stand-ins for what the worker host gets from a browser, so
 * the handoff between "tabs" runs in Node: a Web Lock manager, a
 * broadcast channel, workers (a server each, reached through a
 * message port) and a disk that outlives them.
 *
 * Killing a worker does what a browser does when a worker is
 * terminated: its locks are released, its channel stops sending and
 * receiving, and its pages' ports are cut. Its database is left as it
 * was, open; the next worker reopens the files from a copy of the disk.
 */

import { type KVStore, Repo } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { type ConnectOptions, type DatabaseClient, connect } from '../src/client'
import {
  type Channel,
  type DatabaseConfig,
  type DatabaseStorage,
  type Locks,
  MemoryDirectory,
  type Opener,
  type ServeOptions,
  type Server,
  serve,
} from '../src/index'

interface LockRequest {
  owner: string
  name: string
  grant: () => void
}

/** A Web Lock manager shared by every fake worker. */
export class LockHub {
  readonly held = new Map<string, LockRequest>()
  readonly queue: LockRequest[] = []
  readonly #dead = new Set<string>()

  for(owner: string): Locks {
    return {
      request: <T>(
        name: string,
        options: { signal: AbortSignal } | { ifAvailable: true },
        callback: (lock: unknown) => Promise<T>,
      ): Promise<T> => {
        if ('ifAvailable' in options) {
          if (this.held.has(name) || this.queue.some((r) => r.name === name)) {
            return Promise.resolve().then(() => callback(null))
          }
          return new Promise<T>((resolve, reject) => {
            const entry: LockRequest = { owner, name, grant: () => {} }
            this.held.set(name, entry)
            Promise.resolve()
              .then(() => callback({ name }))
              .then(resolve, reject)
              .finally(() => this.#releaseIf(entry))
          })
        }
        const { signal } = options
        return new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(new DOMException('aborted', 'AbortError'))
            return
          }
          const entry: LockRequest = {
            owner,
            name,
            grant: () => {
              Promise.resolve()
                .then(() => callback({ name }))
                .then(resolve, reject)
                .finally(() => this.#releaseIf(entry))
            },
          }
          signal.addEventListener('abort', () => {
            const i = this.queue.indexOf(entry)
            if (i < 0) return
            this.queue.splice(i, 1)
            reject(new DOMException('aborted', 'AbortError'))
          })
          this.queue.push(entry)
          this.#pump(name)
        })
      },
      query: async () => ({
        pending: this.queue.map((r) => ({ name: r.name })),
        held: [...this.held.values()].map((r) => ({ name: r.name })),
      }),
    }
  }

  /** Who holds `name`, if anyone. */
  holder(name: string): string | undefined {
    return this.held.get(name)?.owner
  }

  /** Release every lock `owner` holds and drop its queued requests, as termination does. */
  kill(owner: string): void {
    this.#dead.add(owner)
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]?.owner === owner) this.queue.splice(i, 1)
    }
    for (const [name, entry] of this.held) {
      if (entry.owner !== owner) continue
      this.held.delete(name)
      this.#pump(name)
    }
  }

  #releaseIf(entry: LockRequest): void {
    if (this.held.get(entry.name) !== entry) return
    this.held.delete(entry.name)
    this.#pump(entry.name)
  }

  #pump(name: string): void {
    if (this.held.has(name)) return
    const i = this.queue.findIndex((r) => r.name === name && !this.#dead.has(r.owner))
    if (i < 0) return
    const [entry] = this.queue.splice(i, 1) as [LockRequest]
    this.held.set(name, entry)
    setTimeout(entry.grant, 0)
  }
}

interface Member {
  owner: string
  name: string
  listener: ((message: unknown) => void) | null
  closed: boolean
}

/** Broadcast channels shared by every fake worker, delivering in order per sender. */
export class ChannelHub {
  readonly #members = new Set<Member>()
  readonly #dead = new Set<string>()
  /** Every message sent, for tests that look at the traffic. */
  readonly sent: { owner: string; message: unknown }[] = []
  /** Called as each message is sent, before it is delivered. */
  onSend: ((owner: string, message: unknown) => void) | null = null
  /**
   * Decides each delivery, from the sending worker to a receiving one:
   * a delay in milliseconds (0 when unset), or `'drop'`. Delays that
   * differ reorder messages between senders, as a browser may; a
   * sender's messages to one receiver keep their order only while
   * their delays don't decrease.
   */
  route: ((from: string, to: string, message: unknown) => number | 'drop') | null = null

  for(owner: string): (name: string) => Channel {
    return (name) => {
      const me: Member = { owner, name, listener: null, closed: false }
      this.#members.add(me)
      return {
        postMessage: (message) => {
          if (me.closed || this.#dead.has(owner)) return
          this.sent.push({ owner, message })
          this.onSend?.(owner, message)
          const data = structuredClone(message)
          for (const other of this.#members) {
            if (other === me || other.name !== name) continue
            const route = this.route?.(owner, other.owner, data) ?? 0
            if (route === 'drop') continue
            setTimeout(() => {
              if (!other.closed && !this.#dead.has(other.owner)) other.listener?.(data)
            }, route)
          }
        },
        listen: (listener) => {
          me.listener = listener
        },
        close: () => {
          me.closed = true
          this.#members.delete(me)
        },
      }
    }
  }

  kill(owner: string): void {
    this.#dead.add(owner)
  }
}

/**
 * The files of one database as they persist across workers. Each open
 * starts from a copy of the latest files, as the next worker finds them
 * on disk.
 */
export class Disk {
  dir = new MemoryDirectory()

  open(): MemoryDirectory {
    this.dir = new MemoryDirectory(this.dir.image())
    return this.dir
  }
}

export interface FakeWorker {
  readonly name: string
  readonly server: Server
  /** Connect a client to `config` through this worker. */
  connect(config: DatabaseConfig, options?: ConnectOptions): DatabaseClient
  /** Terminate the worker. */
  kill(): void
}

/** A browser origin's worth of fakes: locks, channels, one disk and repository store. */
export class Origin {
  readonly locks = new LockHub()
  readonly channels = new ChannelHub()
  readonly disk = new Disk()
  readonly store: KVStore
  readonly workers: FakeWorker[] = []
  #ports: MessagePort[] = []

  constructor(store: KVStore = new Memory()) {
    this.store = store
  }

  /** The default opener: the disk's files, and a repository over the shared store. */
  readonly open: Opener = async (): Promise<DatabaseStorage> => ({
    dir: this.disk.open(),
    repo: await Repo.open(this.store),
  })

  /** A worker serving with `open`, and `options` beside the fakes' own. */
  worker(name: string, open: Opener = this.open, options: ServeOptions = {}): FakeWorker {
    const ports: MessagePort[] = []
    const server = serve(open, {
      ...options,
      scope: null,
      locks: this.locks.for(name),
      channel: this.channels.for(name),
      workerId: name,
      openRetryMs: 1_000,
      deleteDrainMs: 500,
    })
    const target = {
      postMessage: (message: unknown) => {
        const { config, port } = message as { config: DatabaseConfig; port: MessagePort }
        ports.push(port)
        this.#ports.push(port)
        server.connect(config, port)
      },
    }
    const worker: FakeWorker = {
      name,
      server,
      connect: (config, options = {}) =>
        connect(target, config, { flushOnHide: false, ...options }),
      kill: () => {
        this.locks.kill(name)
        this.channels.kill(name)
        for (const port of ports) port.close()
      },
    }
    this.workers.push(worker)
    return worker
  }

  /** Cut every port left open, so nothing keeps the process alive. */
  dispose(): void {
    for (const port of this.#ports) port.close()
    this.#ports = []
  }
}

/** Wait until `check` returns true, or fail after `ms`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  ms = 3_000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
