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

import type { FileSystem } from '@agex-ts/termish'
import type { WorkspaceCache } from '../cache'
import {
  type CodeSettings,
  type HostCall,
  type HostEntry,
  type MethodContract,
  callAware,
} from '../profile'
import { Mismatch, check, findLive } from '../values'
import { callFs } from './code-fs'
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
import { prepareCode, prepareModule } from './modules'
import type { UiHarvest } from './ui-values'

/** ts-blank-space, loaded by the first run that needs it: it brings the
 *  TypeScript compiler, which a host that imports the world without
 *  running code (or that brings its own transform) shouldn't load. */
let blankSpace: Promise<(code: string) => string> | null = null

/** TypeScript to JavaScript, types blanked out (the default transform). */
async function stripTypes(code: string): Promise<string> {
  blankSpace ??= import('ts-blank-space').then((m) => m.default)
  return (await blankSpace)(code)
}

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
  /** What the code put in `ui`, for a profile that binds it; null when
   *  it doesn't, or the run was stopped. */
  readonly ui: UiHarvest | null
}

/** What a run reaches on the host. */
export interface RunContext {
  readonly fs: FileSystem
  readonly cache: WorkspaceCache | null
  readonly env: Readonly<Record<string, string>>
  /** The secrets' names, never their values. */
  readonly secrets: readonly string[]
  readonly hostObjects: ReadonlyMap<string, HostEntry>
  /** Data bound by name, sent with each run. */
  readonly values: Readonly<Record<string, unknown>>
  /** Given to host methods declared `withCall`. */
  readonly call: HostCall
  readonly settings: CodeSettings
}

export const DEFAULT_TIMEOUT = 30
export const DEFAULT_HOST_TIME = 600
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
    const finish = (
      out: Omit<KernelOutput, 'duration' | 'truncated' | 'ui'>,
      ui: UiHarvest | null = null,
    ): KernelOutput =>
      this.#render({ ...out, ui }, started, ctx.settings.maxObservation ?? DEFAULT_MAX_OBSERVATION)
    const failed = (e: unknown) =>
      finish({
        stdout: '',
        stderr: '',
        images: [],
        value: null,
        error: userStack(serializeError(e), 0),
      })

    if (this.#closed) return failed(cancelled('the workspace closed'))
    if (this.#stop !== null) return failed(new Error('a run is already in progress'))

    let prepared: Awaited<ReturnType<typeof prepareCode>>
    try {
      const transform = this.#transform
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
    const codeLines = prepared.code.split('\n').length
    const timeout = this.#settings.timeout ?? DEFAULT_TIMEOUT
    const output = new Collected(ctx.settings.maxObservation ?? DEFAULT_MAX_OBSERVATION)
    const answering = new Set<Promise<void>>()

    return new Promise<KernelOutput>((resolve) => {
      let ended = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const end = (
        value: string | null,
        error: SerializedError | null,
        ui: UiHarvest | null = null,
      ): void => {
        if (ended) return
        ended = true
        offMessage()
        offError()
        clearTimeout(timer)
        this.#stop = null
        // The calls the host already took land before the run ends.
        void Promise.allSettled([...answering]).then(() =>
          resolve({
            ...finish(
              {
                stdout: output.text('stdout'),
                stderr: output.text('stderr'),
                images: output.images,
                value,
                error,
              },
              ui,
            ),
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
          if (msg.target === 'host') pause()
          const answer = this.#answer(worker, msg, ctx)
          // A stopped run waits for the file and cache calls already
          // taken, whose changes its commit must hold, but not for a
          // host object, which may not return.
          if (msg.target !== 'host') {
            answering.add(answer)
            void answer.finally(() => answering.delete(answer))
          } else {
            void answer.finally(resume)
          }
        } else if (msg.type === 'done') {
          end(
            msg.value,
            msg.error === null ? null : userStack(msg.error, codeLines),
            msg.ui ?? null,
          )
        }
      })
      const offError = worker.addErrorListener((err) =>
        stop({ name: 'Error', message: `the kernel's worker failed: ${err.message}` }),
      )
      // The timeout is the code's own time: a host object's call is the
      // host's (a helper agent's run, say), so the clock stops for it.
      // The host can't tell code waiting on a call from code computing
      // beside one it didn't await, so the time off is capped: past
      // `hostTime`, the clock runs whatever is pending.
      const hostMs = (this.#settings.hostTime ?? DEFAULT_HOST_TIME) * 1000
      let used = 0
      let since = performance.now()
      let hosting = 0
      let hostUsed = 0
      let pausedAt = 0
      let spent = false
      const arm = () =>
        setTimeout(
          () =>
            stop({
              name: 'TimeoutError',
              message: `the run took longer than ${timeout}s and was stopped`,
            }),
          Math.min(Math.max(timeout * 1000 - used, 0), MAX_DELAY_MS),
        )
      timer = arm()
      const pause = () => {
        if (hosting++ > 0 || spent) return
        clearTimeout(timer)
        used += performance.now() - since
        pausedAt = performance.now()
        timer = setTimeout(
          () => {
            spent = true
            since = performance.now()
            timer = arm()
          },
          Math.min(Math.max(hostMs - hostUsed, 0), MAX_DELAY_MS),
        )
      }
      const resume = () => {
        if (--hosting > 0 || ended || spent) return
        clearTimeout(timer)
        hostUsed += performance.now() - pausedAt
        since = performance.now()
        timer = arm()
      }
      this.#stop = stop

      const message: Host2Worker = {
        type: 'run',
        runId,
        code: prepared.code,
        modules: prepared.modules,
        hostObjects: [...ctx.hostObjects].map(([name, entry]) => ({
          name,
          methods: entry.methods,
          ...(entry.stub !== null && { stub: entry.stub }),
        })),
        values: ctx.values,
        env: ctx.env,
        secrets: ctx.secrets,
        hasCache: ctx.cache !== null,
        hasResolver: this.#settings.resolve !== undefined,
        routeFetch: this.#settings.routeFetch ?? false,
        ui: ctx.settings.ui ?? false,
      }
      worker.postMessage(message)
    })
  }

  // ---------- internals ----------

  get #transform(): (code: string) => string | Promise<string> {
    return this.#settings.transform ?? stripTypes
  }

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
    const what = msg.subject === undefined ? msg.target : msg.subject
    let reply: Host2Worker
    try {
      const value = await this.#dispatch(msg, ctx)
      const live = findLive(value)
      if (live !== null) {
        const e = new Error(
          `${what}.${msg.method} returned a value that can't be sent to code by value (${live})`,
        )
        e.name = 'DataCloneError'
        throw e
      }
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
      // A value that can't cross fails the call instead of the run.
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
      return await callFs(ctx.fs, method, args)
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
    if (target === 'import') {
      return await prepareModule(String(args[0]), ctx.fs, this.#transform)
    }
    const name = msg.subject as string
    const entry = ctx.hostObjects.get(name)
    if (entry === undefined || !entry.methods.includes(method)) {
      throw new TypeError(`${name}.${method} is not a function`)
    }
    const { obj } = entry
    const contract = entry.contract?.[method]
    const where = `${name}.${method}`
    const given = contract === undefined ? [...args] : await checkArgs(where, contract, args)
    const fn = (obj as Record<string, unknown>)[method] as (...a: unknown[]) => unknown
    const aware = callAware(fn)
    const result = await (aware === undefined
      ? fn.apply(obj, given)
      : aware.call(obj, ctx.call, ...given))
    if (contract?.returns === undefined) return result
    try {
      return await check(result, contract.returns)
    } catch (e) {
      if (!(e instanceof Mismatch)) throw e
      throw new TypeError(
        `${where} returned a value that doesn't fit its declared type: ${e.message}`,
      )
    }
  }
}

/** A typed method's arguments, checked against its contract: what the
 *  schemas give back, in order. */
async function checkArgs(
  where: string,
  contract: MethodContract,
  args: readonly unknown[],
): Promise<unknown[]> {
  if (contract.args === undefined) return [...args]
  const named = !Array.isArray(contract.args)
  const schemas = Object.entries(contract.args)
  if (args.length > schemas.length) {
    const n = schemas.length
    throw new TypeError(
      `${where} takes ${n === 1 ? '1 argument' : `${n} arguments`}, not ${args.length}`,
    )
  }
  const out: unknown[] = []
  for (const [i, [key, schema]] of schemas.entries()) {
    try {
      out.push(await check(args[i], schema))
    } catch (e) {
      if (!(e instanceof Mismatch)) throw e
      const arg = named ? key : `argument ${i + 1}`
      const at = e.where === '' ? arg : `${arg}${e.where.startsWith('[') ? '' : '.'}${e.where}`
      throw new TypeError(`${where}: at ${at}: ${e.detail}`)
    }
  }
  // Trailing arguments left out stay left out, so a method's defaults apply.
  while (out.length > args.length && out[out.length - 1] === undefined) out.pop()
  return out
}

function cancelled(message: string): Error {
  const e = new Error(message)
  e.name = 'CancelledError'
  return e
}

/** Lines the worker puts before the code (the function's header). */
const HEADER_LINES = 2

/**
 * An error's stack reduced to the frames of the code and the world's
 * modules, at their own line numbers: `at line 3` in the code run,
 * `at boom (/workspace/lib.ts:2)` in a module. The worker's own frames
 * are left out.
 */
export function userStack(error: SerializedError, codeLines: number): SerializedError {
  if (error.stack === undefined) return error
  const frames: string[] = []
  for (const line of error.stack.split('\n').slice(1)) {
    const code = /<anonymous>:(\d+):\d+\)?$/.exec(line)
    if (code !== null) {
      const at = Number(code[1]) - HEADER_LINES
      if (at >= 1 && at <= codeLines) frames.push(`    at line ${at}`)
      continue
    }
    const mod = /^\s*at (?:(\S+) \()?(\/[^():]*):(\d+):\d+\)?$/.exec(line)
    if (mod !== null) {
      const where = `${mod[2]}:${Number(mod[3]) - HEADER_LINES}`
      frames.push(mod[1] === undefined ? `    at ${where}` : `    at ${mod[1]} (${where})`)
    }
  }
  return { ...error, stack: [`${error.name}: ${error.message}`, ...frames].join('\n') }
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
