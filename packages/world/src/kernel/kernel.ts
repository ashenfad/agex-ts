/**
 * The host side of a workspace's kernel: one worker, one run at a time.
 *
 * A run prepares the code on the host (types stripped, the world
 * modules it imports read and compiled), sends it to the worker, and
 * answers the worker's calls (the filesystem, the cache, host objects,
 * the import resolver) until it's done. Stopping a run (a timeout, an
 * interrupt, closing) terminates the worker; the next run starts a
 * fresh one. The file and cache calls the host had already taken
 * finish first, so a stopped run's writes are all there to commit.
 */

import tsBlankSpace from 'ts-blank-space'
import type { WorkspaceCache } from '../cache'
import type { WorldFS } from '../fs'
import { type CodeSettings, type HostCall, callAware, publicMethods } from '../profile'
import { type ResolvedTarget, type WorkerHandle, createWorkerHandle, detectTarget } from './handle'
import {
  CACHE_METHODS,
  FS_METHODS,
  type Host2Worker,
  type Image,
  type SerializedError,
  type Worker2Host,
  serializeError,
} from './messages'
import { prepareCode } from './modules'

/** What a run gave, before the workspace commits it. */
export interface KernelOutput {
  readonly stdout: string
  readonly stderr: string
  readonly images: readonly Image[]
  /** A top-level `return`'s value, shown as text; null for none. */
  readonly value: string | null
  readonly error: SerializedError | null
  /** stdout or stderr was cut to `maxObservation`. */
  readonly truncated: boolean
  /** Seconds the run took. */
  readonly duration: number
}

/** What a run reaches on the host. */
export interface RunContext {
  readonly fs: WorldFS
  readonly cache: WorkspaceCache | null
  readonly env: Readonly<Record<string, string>>
  readonly hostObjects: ReadonlyMap<string, object>
  /** Given to host methods declared `withCall`. */
  readonly call: HostCall
  readonly settings: CodeSettings
}

export const DEFAULT_TIMEOUT = 30
export const DEFAULT_MAX_OBSERVATION = 32_000

/** `setTimeout`'s longest delay, so `Infinity` means no timeout. */
const MAX_DELAY_MS = 2_147_483_647

const FS_SET: ReadonlySet<string> = new Set(FS_METHODS)
const CACHE_SET: ReadonlySet<string> = new Set(CACHE_METHODS)

export class Kernel {
  readonly #settings: CodeSettings
  #worker: WorkerHandle | null = null
  #booting: Promise<WorkerHandle> | null = null
  #stop: ((error: SerializedError) => void) | null = null
  #nextRun = 1
  #closed = false

  constructor(settings: CodeSettings = {}) {
    this.#settings = settings
  }

  /** A run is in progress. */
  get running(): boolean {
    return this.#stop !== null
  }

  /**
   * Stop the run in progress: its worker is terminated, and the run
   * ends with a `CancelledError`. Returns false if nothing was running.
   */
  interrupt(): boolean {
    if (this.#stop === null) return false
    this.#stop({ name: 'CancelledError', message: 'cancelled' })
    return true
  }

  /** Stop any run, and the worker for good. */
  close(): void {
    this.#closed = true
    this.#stop?.({ name: 'CancelledError', message: 'the workspace closed' })
    this.#kill()
  }

  async run(code: string, ctx: RunContext): Promise<KernelOutput> {
    const started = performance.now()
    const finish = (out: Omit<KernelOutput, 'duration' | 'truncated'>): KernelOutput =>
      this.#render(out, started, ctx.settings.maxObservation ?? DEFAULT_MAX_OBSERVATION)
    const failed = (e: unknown) =>
      finish({ stdout: '', stderr: '', images: [], value: null, error: serializeError(e) })

    if (this.#closed) return failed(cancelled('the workspace closed'))
    if (this.#stop !== null) return failed(new Error('a run is already in progress'))

    let prepared: Awaited<ReturnType<typeof prepareCode>>
    try {
      const transform = this.#settings.transform ?? tsBlankSpace
      prepared = await prepareCode(await transform(code), ctx.fs, ctx.fs.getcwd(), transform)
    } catch (e) {
      return failed(e)
    }

    let worker: WorkerHandle
    try {
      worker = await this.#start()
    } catch (e) {
      return failed(e)
    }
    if (this.#closed) return failed(cancelled('the workspace closed'))

    const runId = this.#nextRun++
    const timeout = this.#settings.timeout ?? DEFAULT_TIMEOUT
    const output = new Collected(ctx.settings.maxObservation ?? DEFAULT_MAX_OBSERVATION)
    const answering = new Set<Promise<void>>()

    return new Promise<KernelOutput>((resolve) => {
      let ended = false
      const end = (value: string | null, error: SerializedError | null): void => {
        if (ended) return
        ended = true
        offMessage()
        offError()
        clearTimeout(timer)
        this.#stop = null
        // The calls the host already took land before the run ends.
        void Promise.allSettled([...answering]).then(() =>
          resolve({
            ...finish({
              stdout: output.text('stdout'),
              stderr: output.text('stderr'),
              images: output.images,
              value,
              error,
            }),
            ...(output.truncated && { truncated: true }),
          }),
        )
      }
      const stop = (error: SerializedError): void => {
        this.#kill()
        end(null, error)
      }

      const offMessage = worker.addMessageListener((msg: Worker2Host) => {
        if (msg?.type === 'ready' || msg.runId !== runId || ended) return
        if (msg.type === 'output') {
          output.add(msg.part)
        } else if (msg.type === 'call') {
          const answer = this.#answer(worker, msg, ctx)
          // A stopped run waits for the file and cache calls already
          // taken, whose changes its commit must hold, but not for a
          // host object, which may not return.
          if (msg.target !== 'host') {
            answering.add(answer)
            void answer.finally(() => answering.delete(answer))
          }
        } else if (msg.type === 'done') {
          end(msg.value, msg.error)
        }
      })
      const offError = worker.addErrorListener((err) =>
        stop({ name: 'Error', message: `the kernel's worker failed: ${err.message}` }),
      )
      const timer = setTimeout(
        () =>
          stop({
            name: 'TimeoutError',
            message: `the run took longer than ${timeout}s and was stopped`,
          }),
        Math.min(timeout * 1000, MAX_DELAY_MS),
      )
      this.#stop = stop

      const message: Host2Worker = {
        type: 'run',
        runId,
        code: prepared.code,
        modules: prepared.modules,
        hostObjects: [...ctx.hostObjects].map(([name, obj]) => ({
          name,
          methods: publicMethods(obj),
        })),
        env: ctx.env,
        hasCache: ctx.cache !== null,
        hasResolver: this.#settings.resolve !== undefined,
        routeFetch: this.#settings.routeFetch ?? false,
      }
      worker.postMessage(message)
    })
  }

  // ---------- internals ----------

  #render(
    out: Omit<KernelOutput, 'duration' | 'truncated'>,
    started: number,
    limit: number,
  ): KernelOutput {
    const [stdout, cutOut] = headCut(out.stdout, limit)
    const [stderr, cutErr] = headCut(out.stderr, limit)
    return {
      ...out,
      stdout,
      stderr,
      truncated: cutOut || cutErr,
      duration: (performance.now() - started) / 1000,
    }
  }

  async #start(): Promise<WorkerHandle> {
    if (this.#worker !== null) return this.#worker
    if (this.#booting !== null) return this.#booting
    const target: ResolvedTarget =
      this.#settings.worker?.target === undefined || this.#settings.worker.target === 'auto'
        ? detectTarget()
        : this.#settings.worker.target
    const url =
      this.#settings.worker?.url ??
      new URL(target === 'node' ? './worker.node.js' : './worker.js', import.meta.url)
    const booting = (async () => {
      const handle = await createWorkerHandle(url, target)
      await new Promise<void>((resolve, reject) => {
        const offMessage = handle.addMessageListener((msg) => {
          if (msg?.type !== 'ready') return
          offMessage()
          offError()
          resolve()
        })
        const offError = handle.addErrorListener((err) => {
          offMessage()
          offError()
          handle.terminate()
          reject(new Error(`the kernel's worker failed to start: ${err.message}`))
        })
      })
      // A worker that dies between runs is started afresh by the next.
      handle.addErrorListener(() => {
        if (this.#worker === handle) this.#kill()
      })
      return handle
    })()
    this.#booting = booting
    try {
      const handle = await booting
      if (this.#booting !== booting) {
        // Killed while starting.
        handle.terminate()
        throw cancelled('the kernel stopped while starting')
      }
      this.#worker = handle
      return handle
    } finally {
      if (this.#booting === booting) this.#booting = null
    }
  }

  #kill(): void {
    this.#worker?.terminate()
    this.#worker = null
    this.#booting = null
  }

  /** Run one call from the worker on the host, and send the answer if
   *  the worker is still the one that asked. */
  async #answer(
    worker: WorkerHandle,
    msg: Extract<Worker2Host, { type: 'call' }>,
    ctx: RunContext,
  ): Promise<void> {
    let reply: Host2Worker
    try {
      const value = await this.#dispatch(msg, ctx)
      reply = { type: 'reply', runId: msg.runId, callId: msg.callId, ok: true, value }
    } catch (e) {
      reply = {
        type: 'reply',
        runId: msg.runId,
        callId: msg.callId,
        ok: false,
        error: serializeError(e),
      }
    }
    if (this.#worker !== worker) return
    try {
      worker.postMessage(reply)
    } catch (e) {
      // A value that can't cross (a function, a live object) fails the
      // call instead of the run.
      const what = msg.subject === undefined ? msg.target : msg.subject
      worker.postMessage({
        type: 'reply',
        runId: msg.runId,
        callId: msg.callId,
        ok: false,
        error: {
          name: 'DataCloneError',
          message: `${what}.${msg.method} returned a value that can't be sent to code (${e instanceof Error ? e.message : String(e)})`,
        },
      })
    }
  }

  async #dispatch(msg: Extract<Worker2Host, { type: 'call' }>, ctx: RunContext): Promise<unknown> {
    const { target, method, args } = msg
    if (target === 'fs') {
      if (!FS_SET.has(method)) throw new TypeError(`fs.${method} is not a function`)
      const fn = (ctx.fs as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
      return await (fn as (...a: unknown[]) => unknown).apply(ctx.fs, [...args])
    }
    if (target === 'cache') {
      if (ctx.cache === null) throw new Error('this workspace has no cache')
      if (!CACHE_SET.has(method)) throw new TypeError(`cache.${method} is not a function`)
      const fn = (ctx.cache as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
      return await (fn as (...a: unknown[]) => unknown).apply(ctx.cache, [...args])
    }
    if (target === 'resolve') {
      const resolve = this.#settings.resolve
      return resolve === undefined ? null : await resolve(String(args[0]))
    }
    const name = msg.subject as string
    const obj = ctx.hostObjects.get(name)
    if (obj === undefined || !publicMethods(obj).includes(method)) {
      throw new TypeError(`${name}.${method} is not a function`)
    }
    const fn = (obj as Record<string, unknown>)[method] as (...a: unknown[]) => unknown
    const aware = callAware(fn)
    return await (aware === undefined
      ? fn.apply(obj, [...args])
      : aware.call(obj, ctx.call, ...args))
  }
}

function cancelled(message: string): Error {
  const e = new Error(message)
  e.name = 'CancelledError'
  return e
}

/** The most images a run keeps; more set `truncated`. */
export const MAX_IMAGES = 16

/**
 * A run's output as it arrives, kept within bounds as it comes: past
 * `limit` characters a stream keeps nothing more, and past
 * {@link MAX_IMAGES} no more images, so code printing without end
 * can't fill the host's memory before the run is stopped.
 */
class Collected {
  readonly images: Image[] = []
  truncated = false
  readonly #limit: number
  readonly #streams = {
    stdout: { parts: [] as string[], size: 0 },
    stderr: { parts: [] as string[], size: 0 },
  }

  constructor(limit: number) {
    this.#limit = limit
  }

  add(part: Extract<Worker2Host, { type: 'output' }>['part']): void {
    if (part.type === 'image') {
      if (this.images.length < MAX_IMAGES)
        this.images.push({ format: part.format, data: part.data })
      else this.truncated = true
      return
    }
    const stream = this.#streams[part.stream]
    // Parts are joined by newlines, which count too.
    const room = this.#limit - stream.size - (stream.parts.length > 0 ? 1 : 0)
    if (room < part.text.length) {
      this.truncated = true
      if (room > 0) stream.parts.push(part.text.slice(0, room))
      stream.size = this.#limit
      return
    }
    stream.parts.push(part.text)
    stream.size += part.text.length + (stream.parts.length > 1 ? 1 : 0)
  }

  text(stream: 'stdout' | 'stderr'): string {
    return this.#streams[stream].parts.join('\n')
  }
}

function headCut(text: string, limit: number): [string, boolean] {
  return text.length > limit ? [text.slice(0, limit), true] : [text, false]
}
