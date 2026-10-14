/**
 * The kernel's worker: runs code the host sends, one run at a time.
 *
 * Code runs as the body of an async function, so top-level `await` and
 * `return` work. Its bindings are:
 * - `fs`: the world's files, every method async, with `read(path,
 *   'utf8')`, `readText`, `writeText` and string writes besides;
 * - `cache`: the session's cache (absent when the workspace has none);
 * - `env`: the profile's variables, read-only;
 * - `secret(name)`: a reference to one of the profile's secrets, which
 *   a host object fills at a request (the value never comes here);
 * - each host object by name, and all of them as `host` (also
 *   `import { db } from 'host'`): its stub, for one that has one;
 * - each of the profile's values by name, a copy of its own per run;
 * - `console`: `log` and `info` to stdout, `warn` and `error` to
 *   stderr, images shown as images.
 *
 * Nothing carries over between runs but what the code writes to the
 * files or the cache: each run gets fresh bindings and a fresh scope.
 * Every call to the host goes over messages and is answered
 * asynchronously.
 */

import { describe, inspect } from '../values/inspect'
import { wrapAgentFs } from './agent-fs'
import {
  CACHE_METHODS,
  FS_METHODS,
  type Host2Worker,
  type Image,
  type Worker2Host,
  serializeError,
} from './messages'
import type { WorkerPort } from './worker-port'

type RunMessage = Extract<Host2Worker, { type: 'run' }>

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

let port: WorkerPort | null = null

function post(msg: Worker2Host): void {
  ;(port as WorkerPort).post(msg)
}

// ---------- the host bridge ----------

/** One run's calls to the host, by call id. */
class Bridge {
  #nextId = 1
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; site: Error }
  >()

  constructor(readonly runId: number) {}

  call(
    target: 'fs' | 'cache' | 'host' | 'resolve',
    method: string,
    args: readonly unknown[],
    subject?: string,
  ): Promise<unknown> {
    const callId = this.#nextId++
    // Where the code made the call: a failure answered later gets this
    // stack, so it points at the code's line.
    const site = new Error()
    const answer = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(callId, { resolve, reject, site })
      try {
        // What structured clone would change (a class's instance loses
        // its methods) or refuse, refused here, naming where it is.
        for (const [i, arg] of args.entries()) {
          const found = inspect(arg, 'cross')
          if (found !== null) {
            throw new Error(`argument ${i + 1} can't be sent by value: ${describe(found)}`)
          }
        }
        post({
          type: 'call',
          runId: this.runId,
          callId,
          target,
          ...(subject !== undefined && { subject }),
          method,
          args,
        })
      } catch (e) {
        this.#pending.delete(callId)
        reject(cloneError(e, `${subject ?? target}.${method}`))
      }
    })
    // Code that doesn't await a call it made (`cache.set(…)` left
    // floating) mustn't take the worker down if the run's end rejects
    // it: an unhandled rejection kills a Node worker.
    answer.catch(() => undefined)
    return answer
  }

  answer(msg: Extract<Host2Worker, { type: 'reply' }>): void {
    const waiting = this.#pending.get(msg.callId)
    if (waiting === undefined) return
    this.#pending.delete(msg.callId)
    if (msg.ok) {
      waiting.resolve(msg.value)
    } else {
      const e = new Error(msg.error.message)
      e.name = msg.error.name
      if (msg.error.code !== undefined) Object.assign(e, { code: msg.error.code })
      const frames = waiting.site.stack?.split('\n').slice(1) ?? []
      e.stack = [`${e.name}: ${e.message}`, ...frames].join('\n')
      waiting.reject(e)
    }
  }

  /** Reject the calls still waiting when the run ends, so nothing
   *  holds on to them. */
  abandon(): void {
    for (const { reject } of this.#pending.values()) {
      const e = new Error('the run ended before this call was answered')
      e.name = 'CancelledError'
      reject(e)
    }
    this.#pending.clear()
  }

  /** An object whose `methods` call `target` on the host. */
  stub(target: 'fs' | 'cache' | 'host', methods: readonly string[], subject?: string): object {
    const out: Record<string, unknown> = {}
    for (const m of methods) {
      out[m] = (...args: unknown[]) => this.call(target, m, args, subject)
    }
    return Object.freeze(out)
  }
}

/** A value that can't be posted (a function, say) fails the call that
 *  carried it, naming the call. */
function cloneError(e: unknown, what: string): Error {
  const out = new Error(
    `${what}: an argument can't be sent to the host (${e instanceof Error ? e.message : String(e)})`,
  )
  out.name = 'DataCloneError'
  return out
}

// ---------- console ----------

/** The longest any one console argument prints, in characters. */
const MAX_ARG_CHARS = 50_000

function cap(s: string): string {
  return s.length > MAX_ARG_CHARS
    ? `${s.slice(0, MAX_ARG_CHARS)}…(truncated, original ${s.length} chars)`
    : s
}

/** A value as console output shows it. */
export function show(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  const t = typeof v
  if (t === 'string') return cap(v as string)
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v)
  if (t === 'function') return '[function]'
  if (v instanceof Error) return cap(`${v.name}: ${v.message}`)
  try {
    const json = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x))
    return cap(json === undefined ? String(v) : json)
  } catch {
    try {
      return cap(String(v))
    } catch {
      return '[unprintable]'
    }
  }
}

function makeConsole(runId: number): Console {
  const emit = (stream: 'stdout' | 'stderr', args: unknown[]): void => {
    const buf: unknown[] = []
    const flush = (): void => {
      if (buf.length === 0) return
      post({ type: 'output', runId, part: { type: 'text', stream, text: buf.map(show).join(' ') } })
      buf.length = 0
    }
    for (const a of args) {
      const img = detectImage(a)
      if (img === null) {
        buf.push(a)
      } else {
        flush()
        post({ type: 'output', runId, part: { type: 'image', ...img } })
      }
    }
    flush()
  }
  const noop = (): void => {}
  return {
    log: (...a: unknown[]) => emit('stdout', a),
    info: (...a: unknown[]) => emit('stdout', a),
    warn: (...a: unknown[]) => emit('stderr', a),
    error: (...a: unknown[]) => emit('stderr', a),
    debug: noop,
    trace: noop,
    dir: noop,
    table: noop,
    group: noop,
    groupCollapsed: noop,
    groupEnd: noop,
    assert: noop,
    count: noop,
    countReset: noop,
    time: noop,
    timeEnd: noop,
    timeLog: noop,
    clear: noop,
  } as unknown as Console
}

/** An image a value is: `{format, data}` (base64 or bytes), a
 *  `data:image/…;base64,` URL, or bytes with a PNG, JPEG or WebP
 *  signature. Null for anything else. */
export function detectImage(value: unknown): Image | null {
  if (typeof value === 'string') {
    const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(value)
    return m === null ? null : { format: m[1] as Image['format'], data: m[2] as string }
  }
  if (value instanceof Uint8Array) {
    const format = magicFormat(value)
    return format === null ? null : { format, data: toBase64(value) }
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as { format?: unknown; data?: unknown }
    if (v.format === 'png' || v.format === 'jpeg' || v.format === 'webp') {
      if (typeof v.data === 'string' && v.data.length > 0) return { format: v.format, data: v.data }
      if (v.data instanceof Uint8Array) {
        // The bytes say what the image is, whatever the label says.
        const format = magicFormat(v.data)
        if (format !== null) return { format, data: toBase64(v.data) }
      }
    }
  }
  return null
}

function magicFormat(b: Uint8Array): Image['format'] | null {
  if (b.byteLength < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  const riff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
  if (riff && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return null
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

// ---------- imports ----------

/** Modules imported by URL or resolved specifier, kept for the
 *  worker's life: a library loads once. */
const loaded = new Map<string, Promise<unknown>>()

const URL_SPECIFIER = /^(https?|data|file|blob):/i

/** Load a bare or URL import: a URL directly, a bare specifier through
 *  the host's resolver. */
function load(bridge: Bridge, hasResolver: boolean, specifier: string): Promise<unknown> {
  const cached = loaded.get(specifier)
  if (cached !== undefined) return cached
  const p = (async () => {
    let url: string | null = URL_SPECIFIER.test(specifier) ? specifier : null
    if (url === null && hasResolver) {
      url = (await bridge.call('resolve', 'resolve', [specifier])) as string | null
    }
    if (url === null) throw new Error(`Cannot find module '${specifier}'`)
    try {
      return await (port as WorkerPort).loadModule(url)
    } catch (e) {
      const out = new Error(
        `Could not load module '${specifier}' (${url}): ${e instanceof Error ? e.message : String(e)}`,
      )
      out.name = 'ImportError'
      throw out
    }
  })()
  loaded.set(specifier, p)
  // A failed import is retried by the next run, not cached.
  p.catch(() => loaded.delete(specifier))
  return p
}

// ---------- fetch from the world's files ----------

const networkFetch: typeof globalThis.fetch | undefined = globalThis.fetch?.bind(globalThis)
let fetchRouting: boolean | readonly string[] = false
let fetchBridge: Bridge | null = null

/** Route `fetch('/path')` (GET or HEAD) to the world's files while a
 *  run is on: every such path (`true`, falling back to the network on
 *  a miss) or the paths under some prefixes (a miss is a 404). */
function installFetch(): void {
  if (networkFetch === undefined) return
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = worldPath(input, init)
    const bridge = fetchBridge
    if (path === null || bridge === null) return networkFetch(input, init)
    try {
      const bytes = (await bridge.call('fs', 'read', [path])) as Uint8Array
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': contentType(path) },
      })
    } catch {
      if (Array.isArray(fetchRouting)) {
        return new Response(null, { status: 404, statusText: 'Not Found' })
      }
      return networkFetch(input, init)
    }
  }
}

function worldPath(input: RequestInfo | URL, init: RequestInit | undefined): string | null {
  if (fetchRouting === false) return null
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return null
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!url.startsWith('/') || url.startsWith('//')) return null
  const path = url.split('#')[0]?.split('?')[0] ?? url
  if (fetchRouting === true) return path
  return fetchRouting.some((prefix) => path.startsWith(prefix)) ? path : null
}

const CONTENT_TYPES: Record<string, string> = {
  csv: 'text/csv',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  parquet: 'application/vnd.apache.parquet',
  arrow: 'application/vnd.apache.arrow.stream',
}

function contentType(path: string): string {
  const dot = path.lastIndexOf('.')
  const ext = dot === -1 ? '' : path.slice(dot + 1).toLowerCase()
  return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

// ---------- a run ----------

let current: Bridge | null = null

/** A host object's stub, run in front of its remote half: what code
 *  gets by the object's name. */
function stubbed(name: string, source: string, remote: object): object {
  let made: unknown
  try {
    const make = new Function(`"use strict"; return (${source})`)() as (remote: object) => unknown
    made = make(remote)
  } catch (e) {
    throw new Error(
      `host object ${name}'s stub failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if ((typeof made !== 'object' && typeof made !== 'function') || made === null) {
    throw new Error(
      `host object ${name}'s stub returned ${made === null ? 'null' : typeof made}, not an object`,
    )
  }
  return made
}

async function run(msg: RunMessage): Promise<void> {
  const bridge = new Bridge(msg.runId)
  current = bridge
  fetchBridge = bridge
  fetchRouting = msg.routeFetch
  const loader = (specifier: string): Promise<unknown> => load(bridge, msg.hasResolver, specifier)

  let value: string | null = null
  let error: unknown = null
  try {
    // in the try: a stub that throws fails the run, as code would
    const host: Record<string, object> = {}
    for (const h of msg.hostObjects) {
      const remote = bridge.stub('host', h.methods, h.name)
      host[h.name] = h.stub === undefined ? remote : stubbed(h.name, h.stub, remote)
    }
    const bindings: Record<string, unknown> = {
      fs: wrapAgentFs(bridge.stub('fs', FS_METHODS) as Parameters<typeof wrapAgentFs>[0]),
      cache: msg.hasCache ? bridge.stub('cache', CACHE_METHODS) : undefined,
      env: Object.freeze({ ...msg.env }),
      secret: (name: string): string => {
        if (!msg.secrets.includes(name)) throw new Error(`no secret named '${name}'`)
        return `\${${name}}`
      },
      console: makeConsole(msg.runId),
      host: Object.freeze(host),
      ...host,
      ...msg.values,
    }
    const registered = { host: bindings.host }
    const modules: Record<string, Record<string, unknown>> = {}
    for (const m of msg.modules) {
      const body = new AsyncFunction('__exports', '__modules', '__registered', '__load', m.body)
      // A body returns its exports object (another spelling of a
      // module returns that module's).
      modules[m.path] = (await body({}, modules, registered, loader)) as Record<string, unknown>
    }
    const names = [...Object.keys(bindings), '__modules', '__load']
    const values = [...Object.values(bindings), modules, loader]
    // An inner function, so the code may declare a name a binding has
    // (`const { db } = host`).
    const fn = new AsyncFunction(...names, `return (async () => {${msg.code}\n})()`)
    const returned = await fn(...values)
    if (returned !== undefined) value = show(returned)
  } catch (e) {
    error = e
  } finally {
    bridge.abandon()
    current = null
    fetchBridge = null
  }
  post({
    type: 'done',
    runId: msg.runId,
    value,
    error: error === null ? null : serializeError(error),
  })
}

/** Start the worker on a platform's port: the entries call this once. */
export function bootWorker(p: WorkerPort): void {
  port = p
  installFetch()
  p.onMessage((msg) => {
    if (msg?.type === 'run') {
      void run(msg)
    } else if (msg?.type === 'reply') {
      if (current?.runId === msg.runId) current.answer(msg)
    }
  })
  p.post({ type: 'ready' })
}
