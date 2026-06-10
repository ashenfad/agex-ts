/**
 * Web Worker entrypoint.
 *
 * Runs a single `ts` emission per `execute` message:
 *
 *   1. Wrap the (already host-transformed) JavaScript in
 *      `new AsyncFunction(...)` so it can use `await` and the
 *      injected names land directly in scope. Same shape as
 *      `evalRuntime`, just inside a Worker realm.
 *   2. Inject the v1 surface: `taskSuccess`, `taskFail`,
 *      a captured `console` (image-aware — `console.log` of
 *      `{format,data}` / data URLs / PNG/JPEG/WebP `Uint8Array`s
 *      becomes `image` parts), proxy
 *      objects for `fs` / `cache`, registered host functions
 *      (`agent.fn`), registered namespaces (`agent.namespace`),
 *      and registered classes (`agent.cls`). Functions and
 *      namespaces round-trip through the host via `bridgeCall`;
 *      classes use a Proxy-backed constructor that posts
 *      `newInstance` and exposes per-instance handles whose
 *      method calls round-trip via `instanceCall`. Registered
 *      names come from a one-time `configure` message the host
 *      posts after worker boot. `inputs` and URL-shipped
 *      registrations (worker-side imports, no RPC) are still
 *      follow-up PRs.
 *   3. Resolve the emission's outcome from the way the AsyncFunction
 *      settles: a `taskSuccess` raise → success; a `TaskFailError`
 *      raise → fail; clean return → `continue` with no value; any
 *      other throw → unexpected error (the host turns this into a
 *      fail with a message).
 *   4. Post `result` back. Any captured `console.*` calls in (1)
 *      already streamed as `output` messages, so the host has them
 *      before `result` arrives.
 *
 * The whole worker is intentionally stateless across `execute` calls
 * for now — every emission gets a fresh `AsyncFunction`. Cross-emission
 * state leaks via `globalThis` are theoretically possible but not a
 * security concern (the agent IS the principal in this realm). A
 * follow-up PR can add a "fresh worker per emission" mode if the
 * isolation tradeoff matters.
 */

import type { OutputPart, SpawnSpec, TaskOutcome } from 'agex-ts/types'
import { wrapAgentFs } from 'agex-ts/wrap-fs'
import {
  type BridgeTarget,
  type ConfigureMessage,
  type Host2WorkerMessage,
  INSTANCE_HANDLE_KEY,
  type SerializedError,
  type Worker2HostMessage,
} from './messages'

// ---------------------------------------------------------------------------
// Task-control sentinels
// ---------------------------------------------------------------------------

/** Thrown by the worker-side `taskSuccess(value)` to unwind the
 *  AsyncFunction with a result. The host translates this into a
 *  `TaskOutcome` — it never crosses the worker boundary as an
 *  exception (Errors don't structured-clone with their prototypes
 *  intact; we serialize manually). */
class TaskSuccessSignal {
  constructor(readonly value: unknown) {}
}

/** Mirrors `agex-ts`'s `TaskFailError` shape, but defined locally so
 *  the worker bundle doesn't have to import the whole agex-ts core.
 *  Detection is by `name` (set on the prototype) — same convention
 *  `agex-ts/errors.isTaskControlError` uses on the host side. */
class TaskFailSignal extends Error {
  override readonly name = 'TaskFailError'
}

// ---------------------------------------------------------------------------
// Per-execute state
// ---------------------------------------------------------------------------

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

function post(msg: Worker2HostMessage): void {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)
}

function makeConsole(executeId: number): Console {
  // Capture the four levels the agent-loop primer documents
  // (`log` / `info` / `warn` / `error`). Anything else falls through
  // to a no-op so user code calling, say, `console.table(...)` doesn't
  // throw — matches `evalRuntime`'s behavior.
  //
  // Image-shaped values are split out into `image` parts (mirrors the
  // host-realm console-capture pipeline): `{format,data}`, data URLs,
  // and `Uint8Array`s with PNG/JPEG/WebP magic bytes. Mixed args
  // produce ordered parts (text-then-image-then-text).
  const emit = (level: 'log' | 'info' | 'warn' | 'error', args: unknown[]): void => {
    const buf: unknown[] = []
    const flush = (): void => {
      if (buf.length === 0) return
      const text = buf.map(safeStringify).join(' ')
      const out = level === 'log' ? text : `[${level}] ${text}`
      post({ type: 'output', executeId, part: { type: 'text', text: out } })
      buf.length = 0
    }
    for (const a of args) {
      const img = detectImage(a)
      if (img !== null) {
        flush()
        post({ type: 'output', executeId, part: { type: 'image', ...img } })
      } else {
        buf.push(a)
      }
    }
    flush()
  }
  const noop = (): void => {}
  return {
    log: (...a: unknown[]) => emit('log', a),
    info: (...a: unknown[]) => emit('info', a),
    warn: (...a: unknown[]) => emit('warn', a),
    error: (...a: unknown[]) => emit('error', a),
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
    // biome-ignore lint/suspicious/noExplicitAny: Console has many optional members across realms
  } as any
}

/** Per-arg cap for captured-console output, measured in UTF-16 code
 *  units (`String#length`) — not bytes. Applied uniformly across
 *  every type so a `console.log(JSON.stringify(big))` (string path)
 *  is bounded just like `console.log(big)` (object path) — the two
 *  idioms used to diverge wildly, with the string variant bypassing
 *  the cap entirely and blowing past LLM context windows on the
 *  next turn. 50 K chars leaves room for honest debugging output
 *  (formatted JSON dumps, log-line bundles) while tripping the
 *  truncation marker on data-URI floods, base64-embedded
 *  resources, and the like. */
const MAX_CAPTURE_CHARS = 50_000

function _cap(s: string): string {
  return s.length > MAX_CAPTURE_CHARS
    ? `${s.slice(0, MAX_CAPTURE_CHARS)}…(truncated, original ${s.length} chars)`
    : s
}

/** Best-effort string conversion — picks `JSON.stringify` for plain
 *  objects, falls back to `String(...)` for everything else. Every
 *  branch funnels through `_cap` so the cap is honored regardless of
 *  how the agent arrived at its log argument. */
function safeStringify(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  const t = typeof v
  if (t === 'string') return _cap(v as string)
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v)
  if (t === 'function') return '[function]'
  try {
    const json = JSON.stringify(v)
    if (json === undefined) return _cap(String(v)) // e.g. circular caught by stringify
    return _cap(json)
  } catch {
    try {
      return _cap(String(v))
    } catch {
      return '[unserializable]'
    }
  }
}

/** Inline copy of `agex-ts/console-capture`'s `detectImage` rules, kept
 *  in-realm so the worker bundle doesn't need to pull in
 *  `node:async_hooks`. Three accept rules: `{format,data}` objects
 *  (`data` as base64 string OR raw `Uint8Array` with matching magic),
 *  `data:image/...;base64,...` strings, and `Uint8Array`s whose first
 *  ~12 bytes match a PNG / JPEG / WebP magic. Returns `null` for non-
 *  image values. */
function detectImage(value: unknown): { format: 'png' | 'jpeg' | 'webp'; data: string } | null {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array)
  ) {
    const v = value as { format?: unknown; data?: unknown }
    if (v.format === 'png' || v.format === 'jpeg' || v.format === 'webp') {
      if (typeof v.data === 'string' && v.data.length > 0) {
        return { format: v.format, data: v.data }
      }
      // Raw-bytes variant: `{format, data: <Uint8Array>}`. Agents
      // wrapping image bytes (e.g. rendered PDF pages) reach for this
      // shape unprompted; without this branch the wrapper falls
      // through to safeStringify and the bytes JSON-serialize into
      // `{"0":137,"1":80,...}` garbage. Trust the magic bytes over
      // the declared label — a mislabeled but valid image renders as
      // what it actually is.
      if (v.data instanceof Uint8Array) {
        const fmt = detectMagicFormat(v.data)
        if (fmt !== null) return { format: fmt, data: bytesToBase64(v.data) }
      }
    }
  }
  if (typeof value === 'string') {
    const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(value)
    if (m !== null && m[1] !== undefined && m[2] !== undefined) {
      return { format: m[1] as 'png' | 'jpeg' | 'webp', data: m[2] }
    }
  }
  if (value instanceof Uint8Array) {
    const fmt = detectMagicFormat(value)
    if (fmt !== null) return { format: fmt, data: bytesToBase64(value) }
  }
  return null
}

/** Inspect the first 12 bytes for PNG / JPEG / WebP signatures. */
function detectMagicFormat(b: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  if (b.byteLength < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  ) {
    return 'webp'
  }
  return null
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

// ---------------------------------------------------------------------------
// fs / cache bridge: per-execute call table
// ---------------------------------------------------------------------------

/** Methods we expose on the worker-side `fs` proxy. Mirrors
 *  @agex-ts/termish's `FileSystem` surface. The same list is enforced on
 *  the host so an unrecognized method name throws cleanly instead
 *  of reaching for a prototype-chain method. Note that `getcwd` is
 *  sync host-side but becomes `Promise<string>` here — it has to
 *  cross a postMessage boundary like every other bridged call. */
const FS_METHODS = [
  'getcwd',
  'chdir',
  'read',
  'write',
  'exists',
  'isFile',
  'isDir',
  'stat',
  'mkdir',
  'remove',
  'rmdir',
  'rename',
  'list',
  'listDetailed',
] as const

/** Methods we expose on the worker-side `cache` proxy. Mirrors
 *  agex-ts's `Cache` interface from `agex-ts/types`. */
const CACHE_METHODS = ['set', 'get', 'has', 'delete', 'keys'] as const

interface PendingBridgeCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** Per-execute bridge — owns the callId counter and the pending-call
 *  table. Callers in user code do `await fs.read('/x')`; that builds
 *  a `bridgeCall`, posts it, parks the resolver in `pending`, and
 *  resolves when the matching `bridgeResponse` arrives at the
 *  module-level message listener (which dispatches into here via
 *  `handleResponse`).
 *
 *  When an emission's AsyncFunction settles, any still-parked calls
 *  are stranded — but that only happens if the user code ignored
 *  pending fs/cache promises (e.g. fired and forgot, or raced them
 *  against `taskSuccess`). The orphans never see a resolver, no one
 *  awaits them, the message channel closes when the next `execute`
 *  starts. Harmless. */
class BridgeChannel {
  private nextCallId = 1
  private readonly pending = new Map<number, PendingBridgeCall>()
  /** Tracks Proxies this channel created via `buildClass`, so we
   *  can recognize them when they appear in outbound args and
   *  replace with a wire marker the host can rehydrate. WeakMap
   *  keyed on the Proxy reference — entries auto-clear when the
   *  Proxy is no longer reachable (typically at execute settle
   *  when the agent's locals go out of scope). */
  private readonly trackedProxies = new WeakMap<object, Promise<number>>()

  constructor(private readonly executeId: number) {}

  /** Build the worker-side `fs` or `cache` object. Each method is a
   *  thin wrapper that posts a `bridgeCall` and returns a Promise. */
  build<T extends string>(target: BridgeTarget, methods: ReadonlyArray<T>): Record<T, unknown> {
    const out = {} as Record<T, unknown>
    for (const method of methods) {
      out[method] = (...args: unknown[]): Promise<unknown> => this.call(target, method, args)
    }
    return out
  }

  /** Build a stub for a single registered fn — calling it posts a
   *  `bridgeCall` with `target: 'fn'` and `method: <name>`. */
  buildFn(name: string): (...args: unknown[]) => Promise<unknown> {
    return (...args: unknown[]) => this.call('fn', name, args)
  }

  /** Build a namespace object: each visible member becomes a method
   *  that posts `bridgeCall` with the namespace name as `subject`
   *  so the host knows which surface to dispatch to. */
  buildNamespace(name: string, members: ReadonlyArray<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const member of members) {
      out[member] = (...args: unknown[]): Promise<unknown> =>
        this.call('namespace', member, args, name)
    }
    return out
  }

  /** Build the worker-side stub for a registered class. The returned
   *  function is what the agent sees as `MyClass`:
   *
   *    - Called with `new MyClass(...args)` → posts `newInstance`
   *      and returns a Proxy synchronously. The Proxy carries a
   *      pending-creation Promise; method calls on it await that
   *      Promise before posting `instanceCall`. The constructor
   *      *throws* if it's invoked without `new` or via subclass
   *      `super(...)` (`new.target !== WorkerStub`), since the
   *      host can't model an agent-defined subclass that adds its
   *      own state.
   *
   *    - Property access for static methods returns a stub function
   *      that posts a `bridgeCall { target: 'cls' }`. Same dispatch
   *      shape as namespace members — the host treats the class as
   *      a namespace for static dispatch.
   *
   *    - `instance instanceof WorkerStub` works because the Proxy's
   *      `getPrototypeOf` trap returns `WorkerStub.prototype` (a
   *      sentinel object we control). `instance.constructor`
   *      returns `WorkerStub`. Subclassing in agent code is not
   *      supported — see the `new.target` check inside the
   *      constructor below. */
  buildClass(spec: {
    name: string
    instanceMethods: ReadonlyArray<string>
    staticMethods: ReadonlyArray<string>
  }): unknown {
    const channel = this
    const { name, instanceMethods, staticMethods } = spec
    const instanceMethodSet = new Set(instanceMethods)
    // Sentinel prototype object — gives `instanceof` a target to
    // chain through. The actual method stubs live on the per-instance
    // Proxy's `get` trap, not here, so the prototype itself stays
    // empty + identifiable.
    const sentinelProto = Object.create(null) as object

    function WorkerStub(this: unknown, ...args: unknown[]): unknown {
      // `new.target` is the constructor that was actually invoked
      // with `new`. If it's `undefined`, we were called as a plain
      // function (`MyClass()` not `new MyClass()`). If it's anything
      // other than this stub, the agent did `class Sub extends
      // MyClass {}` and called `super(...)`. Both paths can't be
      // honored host-side — the host owns the instance state and
      // doesn't know about agent-defined fields/methods.
      if (new.target === undefined) {
        throw new TypeError(`Class constructor ${name} cannot be invoked without 'new'`)
      }
      if (new.target !== WorkerStub) {
        throw new Error(
          `Subclassing registered class '${name}' isn't supported in this runtime; instances live host-side and can't carry agent-defined state. Define worker-realm hierarchies in /helpers (or in a class you compose, not extend).`,
        )
      }
      const idPromise = channel.newInstance(name, args)
      // Surface synchronous construction failures (DataCloneError on
      // args, etc.) by letting `idPromise` reject; method calls on
      // the returned Proxy will reject in turn.
      const proxy: object = new Proxy(Object.create(sentinelProto), {
        getPrototypeOf(): object {
          // `instance instanceof WorkerStub` walks the prototype
          // chain via this trap. We hand back our sentinel which
          // is *also* `WorkerStub.prototype`, so the standard
          // `Symbol.hasInstance` resolves to `true`.
          return sentinelProto
        },
        get(_t, prop) {
          if (prop === 'constructor') return WorkerStub
          if (typeof prop !== 'string') return undefined
          if (!instanceMethodSet.has(prop)) return undefined
          return (...callArgs: unknown[]): Promise<unknown> => {
            // Wait for construction to complete before dispatching;
            // method calls fire-and-forget across the boundary
            // are fine because the host's instance map is keyed
            // by id and the host won't accept calls for unknown
            // ids. If construction failed (e.g. DataCloneError on
            // args), `idPromise` rejects and so does the method
            // call.
            return idPromise.then((id) => channel.instanceCall(id, prop, callArgs))
          }
        },
      })
      // Register the Proxy so `packArgs` can recognize it when the
      // agent passes this instance to *another* bridged call (e.g.
      // `a.add(b)` — `b` is one of these Proxies). Without this,
      // the Proxy would hit structured-clone as an opaque empty
      // object and the agent's await would reject with
      // DataCloneError.
      channel.trackProxy(proxy, idPromise)
      // ECMAScript: if the constructor returns a non-primitive,
      // that object is what `new` evaluates to. We rely on this so
      // the agent gets the Proxy, not whatever `this` happens to
      // be in here.
      return proxy
    }

    // Give the stub the right `name` + the sentinel as its
    // `prototype`. Functions are configurable here.
    Object.defineProperty(WorkerStub, 'name', { value: name, configurable: true })
    Object.defineProperty(WorkerStub, 'prototype', {
      value: sentinelProto,
      writable: false,
      enumerable: false,
      configurable: false,
    })

    // Attach static-method stubs directly on the function. These
    // dispatch through `target: 'cls'` so the host can call
    // `MyClass.staticName(...)` against the registered class
    // itself (not an instance).
    for (const m of staticMethods) {
      ;(WorkerStub as unknown as Record<string, unknown>)[m] = (
        ...args: unknown[]
      ): Promise<unknown> => this.call('cls', m, args, name)
    }

    return WorkerStub
  }

  /** Register a Proxy this channel built so it can be recognized
   *  in later outbound args. The id Promise is stored (not the
   *  resolved id) because construction is async — when the Proxy
   *  is first passed as an arg, we await the id at that moment. */
  trackProxy(proxy: object, idPromise: Promise<number>): void {
    this.trackedProxies.set(proxy, idPromise)
  }

  /** Sync probe: does the args tree contain any tracked Proxy? If
   *  not, the args pass through structured-clone unchanged and we
   *  can avoid the async pack-then-post path entirely. Keeping the
   *  common case synchronous matters for orphan-call cancellation
   *  timing: when an agent fires `void slow()` then `taskSuccess`'s,
   *  the bridgeCall must reach the host *before* the result message
   *  for the host's per-execute listener to handle the response —
   *  deferring all posts behind an `await` shifts the orphan call
   *  past the listener teardown and the orphan never executes. */
  private argsNeedPacking(args: ReadonlyArray<unknown>): boolean {
    const seen = new WeakSet<object>()
    const probe = (v: unknown): boolean => {
      if (v === null || typeof v !== 'object') return false
      if (this.trackedProxies.has(v)) return true
      if (seen.has(v)) return false
      seen.add(v)
      if (Array.isArray(v)) return v.some(probe)
      if (Object.getPrototypeOf(v) !== Object.prototype) return false
      return Object.keys(v).some((k) => probe((v as Record<string, unknown>)[k]))
    }
    return args.some(probe)
  }

  /** Walk an args array and replace any tracked Proxy (top-level,
   *  in arrays, or in plain objects) with an `INSTANCE_HANDLE_KEY`
   *  marker the host knows how to rehydrate. Non-plain objects
   *  (Uint8Array, Date, Map, etc.) pass through unchanged — they
   *  structured-clone fine on their own. Cycle protection via a
   *  visited WeakSet so a circular plain-object structure doesn't
   *  stack-overflow.
   *
   *  Awaits each tracked Proxy's id Promise lazily so this works
   *  even when the agent calls a method on `b` immediately after
   *  `new B()` — the id may still be pending host-side, but we
   *  serialize the wait into the call's own pre-post step rather
   *  than blocking arg construction. */
  private async packArgs(args: ReadonlyArray<unknown>): Promise<unknown[]> {
    const visited = new WeakSet<object>()
    const pack = async (v: unknown): Promise<unknown> => {
      if (v === null || typeof v !== 'object') return v
      const tracked = this.trackedProxies.get(v)
      if (tracked !== undefined) {
        const id = await tracked
        return { [INSTANCE_HANDLE_KEY]: { id } }
      }
      if (visited.has(v)) return v
      visited.add(v)
      if (Array.isArray(v)) {
        const out: unknown[] = []
        for (const e of v) out.push(await pack(e))
        return out
      }
      // Plain objects only — Uint8Array / Date / Map / Set / etc.
      // pass through. structured-clone handles them natively.
      if (Object.getPrototypeOf(v) !== Object.prototype) return v
      const out: Record<string, unknown> = {}
      for (const k of Object.keys(v)) {
        out[k] = await pack((v as Record<string, unknown>)[k])
      }
      return out
    }
    return Promise.all(args.map(pack))
  }

  /** Wrappers around `call()` that produce alternate outbound
   *  message shapes — `newInstance` and `instanceCall` aren't
   *  `bridgeCall` variants on the wire (the host needs to dispatch
   *  them differently), but they share the same callId/pending
   *  bookkeeping since responses come back as `bridgeResponse`
   *  regardless of which outbound shape created them. */
  newInstance(clsName: string, args: unknown[]): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const callId = this.nextCallId++
      this.pending.set(callId, {
        resolve: (v) => resolve((v as { instanceId: number }).instanceId),
        reject,
      })
      this.postWithArgs(callId, reject, args, (packed) => ({
        type: 'newInstance',
        executeId: this.executeId,
        callId,
        clsName,
        args: packed,
      }))
    })
  }

  instanceCall(instanceId: number, method: string, args: unknown[]): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const callId = this.nextCallId++
      this.pending.set(callId, { resolve, reject })
      this.postWithArgs(callId, reject, args, (packed) => ({
        type: 'instanceCall',
        executeId: this.executeId,
        callId,
        instanceId,
        method,
        args: packed,
      }))
    })
  }

  /** Run an ephemeral sub-task clone on the host (`ctx.spawn`) and
   *  resolve with its result. Like `newInstance` / `instanceCall`, it
   *  posts its own outbound shape (`spawnCall`) but reuses the callId /
   *  pending map and gets a `bridgeResponse` back. The spec is plain
   *  data (no tracked Proxies), so packing is a no-op — but routing it
   *  through `postWithArgs` keeps the DataCloneError handling. */
  spawn(spec: SpawnSpec): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const callId = this.nextCallId++
      this.pending.set(callId, { resolve, reject })
      this.postWithArgs(callId, reject, [spec], (packed) => ({
        type: 'spawnCall',
        executeId: this.executeId,
        callId,
        spec: packed[0] as SpawnSpec,
      }))
    })
  }

  private call(
    target: BridgeTarget,
    method: string,
    args: unknown[],
    subject?: string,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const callId = this.nextCallId++
      this.pending.set(callId, { resolve, reject })
      this.postWithArgs(callId, reject, args, (packed) => ({
        type: 'bridgeCall',
        executeId: this.executeId,
        callId,
        target,
        ...(subject !== undefined && { subject }),
        method,
        args: packed,
      }))
    })
  }

  /** Common post path that respects the sync/async split:
   *
   *    - If `args` contain no tracked Proxies, skip packing entirely
   *      and post synchronously. This is the common case (primitives,
   *      Uint8Array, plain objects, etc.) and matters for orphan-
   *      call cancellation timing — the bridgeCall reaches the host
   *      *before* the per-execute listener tears down at execute
   *      settle, so cancelPending can correctly settle the orphan.
   *    - If `args` *do* contain tracked Proxies, pack them async
   *      (awaiting each Proxy's idPromise) and post when done. This
   *      branch is only used when the agent passes one Proxy
   *      instance as an argument to another instance's method.
   *
   *  In both branches a `postMessage` failure (typically
   *  DataCloneError on an arg) deletes the pending entry and
   *  rejects the caller's Promise. */
  private postWithArgs(
    callId: number,
    reject: (e: Error) => void,
    args: unknown[],
    build: (packed: unknown[]) => Worker2HostMessage,
  ): void {
    const fail = (e: unknown): void => {
      this.pending.delete(callId)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
    if (!this.argsNeedPacking(args)) {
      try {
        post(build(args))
      } catch (e) {
        fail(e)
      }
      return
    }
    this.packArgs(args).then(
      (packed) => {
        try {
          post(build(packed))
        } catch (e) {
          fail(e)
        }
      },
      (e) => fail(e),
    )
  }

  /** Called by the module-level message listener when a
   *  `bridgeResponse` arrives. Looks up the parked resolver and
   *  settles it.
   *
   *  We filter on **both** `executeId` and `callId`: the worker
   *  scope is reused across consecutive executes (one BridgeChannel
   *  per execute, but the same Worker), and `callId` resets to 1
   *  every new channel. A response from a previous execute whose
   *  bridged call finished *after* the execute settled (orphaned
   *  Promise — agent code dispatched a call without awaiting it,
   *  then `taskSuccess`'d) would otherwise collide on `callId`
   *  with a live pending call in the current execute and resolve
   *  it with the stale value. The `executeId` check drops those
   *  stale responses cleanly. */
  handleResponse(msg: Extract<Host2WorkerMessage, { type: 'bridgeResponse' }>): void {
    if (msg.executeId !== this.executeId) return
    const slot = this.pending.get(msg.callId)
    if (slot === undefined) return
    this.pending.delete(msg.callId)
    if (msg.ok) slot.resolve(msg.value)
    else slot.reject(rebuildError(msg.error))
  }

  /** Reject any still-pending calls with `reason`, then clear the
   *  pending map. Called when the owning `execute` settles so that
   *  Promises orphaned by user code (e.g. `void slow(); taskSuccess()`,
   *  or a `setTimeout` that fires after `taskSuccess`) don't pin the
   *  channel + their closures in memory across emissions. Without
   *  this, a never-resolved `await` in a `setTimeout` callback would
   *  retain a frame indefinitely until the worker is finally
   *  terminated. */
  cancelPending(reason: Error): void {
    if (this.pending.size === 0) return
    const entries = [...this.pending.values()]
    this.pending.clear()
    for (const slot of entries) slot.reject(reason)
  }

  /** Number of bridge calls awaiting host responses. Used by the
   *  late-terminator-detection path to decide whether to drain
   *  before declaring an emission settled. */
  get pendingCount(): number {
    return this.pending.size
  }

  /** Wait for the pending-bridge-calls map to drain (or hit the
   *  timeout). Polled because pending calls resolve asynchronously
   *  via `handleResponse` from the message listener — we just need
   *  yields back to the event loop for those messages to land.
   *
   *  Bounded so a runaway "agent fired infinite background work"
   *  case can't pin us forever. The host-side per-emission timeout
   *  bounds the total wait independently. */
  async drain(timeoutMs: number): Promise<void> {
    const start = performance.now()
    while (this.pending.size > 0) {
      if (performance.now() - start > timeoutMs) return
      await new Promise((r) => setTimeout(r, 5))
    }
  }
}

function rebuildError(s: SerializedError): Error {
  const e = new Error(s.message)
  e.name = s.name
  if (s.stack !== undefined) e.stack = s.stack
  return e
}

function serializeError(e: unknown): SerializedError {
  if (e instanceof Error) {
    const out: SerializedError = { name: e.name, message: e.message }
    if (e.stack !== undefined) return { ...out, stack: e.stack }
    return out
  }
  return { name: 'Error', message: safeStringify(e) }
}

// ---------------------------------------------------------------------------
// Execute loop
// ---------------------------------------------------------------------------

/** Bridge channels for in-flight executes, keyed by executeId. The
 *  module-level message listener routes each `bridgeResponse` to the
 *  right channel by id. Multiple executes can run concurrently — a
 *  parent emission parked at `await spawn(...)` coexists with the clone
 *  emissions it triggered — so a single slot isn't enough. An entry is
 *  added when an execute starts and removed when it settles. (The
 *  `__load` resolver RPC stamps its own executeId via a per-execute
 *  closure, so it no longer needs a global "current id".) */
const bridges = new Map<number, BridgeChannel>()

/** Most recent `configure` payload from the host. Set once after
 *  boot, possibly overwritten on a respawn (host re-sends after a
 *  hard-kill). The execute handler reads this to know which fn /
 *  namespace stubs to inject; if absent, it falls back to no-extras
 *  (matches the empty-policy case). */
let configured: ConfigureMessage | null = null

/** URL-shipped registration specs, keyed by registered name. Populated
 *  at configure time but NOT imported — the dynamic `import()` fires
 *  on first reference via `__load(name)` from the agent's emitted code.
 *  Cleared and rebuilt on respawn. */
const urlSpecs = new Map<string, { url: string; export?: string }>()

/** Per-name resolved-or-in-flight promise cache. First reader stashes
 *  the promise; concurrent readers await the same one (single fetch).
 *  Cleared on respawn alongside `urlSpecs`. Failures are wrapped in
 *  an `Error` named `'ImportError'` so the agent loop's recoverable-
 *  error path renders a `💥 ImportError: Could not load registered
 *  module 'X' (URL): <reason>` line on the next turn. */
const urlPromiseCache = new Map<string, Promise<unknown>>()

/** Build a raw `import(url)` indirection that bypasses any
 *  bundler-side dynamic-import wrapping (notably Vite's
 *  `wrapDynamicImport`, which assumes a main-thread runtime that
 *  doesn't exist inside a Worker). The `new Function` form keeps
 *  the call site opaque to static analysis; the result is the
 *  native `import()` exactly as the engine implements it.
 *
 *  Constructed once at module load — the Function constructor's
 *  cost is paid at boot, not per import. */
const rawImport = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>

// ---------------------------------------------------------------------------
// namespaceResolver RPC
// ---------------------------------------------------------------------------

/** Pending `resolveNamespace` requests, keyed by callId. The host
 *  replies with `resolveNamespaceResponse`; we resolve the matching
 *  promise. Cleared when the worker is garbage collected (worker
 *  lifecycle is per-execute → respawn). */
const pendingResolveCalls = new Map<number, (url: string | null) => void>()
let nextResolveCallId = 1

/** Ask the host to resolve `specifier` to a URL. Returns `null` when
 *  the host's resolver returns null OR no resolver is configured (the
 *  `__load` caller already gated on `configured.hasNamespaceResolver`
 *  before calling this — so a `null` here means the resolver itself
 *  said no). */
function resolveNamespaceViaHost(executeId: number, specifier: string): Promise<string | null> {
  const callId = nextResolveCallId++
  return new Promise<string | null>((resolve) => {
    pendingResolveCalls.set(callId, resolve)
    post({ type: 'resolveNamespace', executeId, callId, specifier })
  })
}

function handleResolveNamespaceResponse(msg: {
  callId: number
  url: string | null
}): void {
  const resolver = pendingResolveCalls.get(msg.callId)
  if (resolver === undefined) return
  pendingResolveCalls.delete(msg.callId)
  resolver(msg.url)
}

/** Process a `configure` message: store the payload + record the
 *  URL-shipped registration specs. No imports fire here — the actual
 *  `import()` happens on first reference from the agent's emitted code
 *  (via `__load(name)`). Per-name promise cache is cleared so a respawn
 *  re-imports cleanly. */
function handleConfigure(msg: ConfigureMessage): void {
  configured = msg
  urlSpecs.clear()
  urlPromiseCache.clear()
  for (const spec of msg.urlModules) {
    urlSpecs.set(spec.name, {
      url: spec.url,
      ...(spec.export !== undefined && { export: spec.export }),
    })
  }
  // Install the fetch shim if the host configured route-to-VFS. Done
  // once per configure message; the shim is inert unless exactly one
  // execute is in flight (it falls through to the original fetch when
  // there's no single bridge to read VFS through — see the shim).
  if (msg.routeFetchToVfs !== undefined) {
    installFetchShim(msg.routeFetchToVfs)
  }
}

// ---------------------------------------------------------------------------
// fetch-to-VFS shim
// ---------------------------------------------------------------------------

const _originalFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)
let _fetchShimInstalled = false

/** Install a `globalThis.fetch` shim that routes path-shaped GET/HEAD
 *  requests to the bridged VFS. Idempotent — calling twice replaces
 *  the routing config but doesn't double-wrap the original fetch. */
function installFetchShim(routing: boolean | ReadonlyArray<string>): void {
  if (_fetchShimInstalled) {
    // Already wrapped; just rebind the routing config closure.
    _activeRouting = routing
    return
  }
  _activeRouting = routing
  _fetchShimInstalled = true
  globalThis.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const decision = decideFetchRoute(input, init, _activeRouting)
    if (decision === 'passthrough') return _originalFetch(input, init)
    if (decision === 'not-in-prefix-vfs') {
      // Prefix-mode declared "this prefix is VFS"; agent's path
      // didn't resolve. 404 is a clean fetch-shaped miss.
      return new Response(null, { status: 404, statusText: 'Not Found in VFS' })
    }
    // decision is { path }: try the VFS read.
    const path = decision.path
    // The shim is a single global `fetch` override, but a library's
    // internal fetch carries no execute context — so we can only route
    // to a VFS when there's exactly one execute in flight (the common,
    // non-concurrent case; routing matches today's behavior). With zero
    // (e.g. URL-module loading) or several concurrent executes (spawn
    // fan-out, where clones have *different* VFSs and we can't tell
    // which one called), fall through to the network rather than risk
    // reading the wrong clone's files. (A per-execute fetch context —
    // e.g. AsyncLocalStorage on Node — is the follow-up to route VFS
    // fetches per clone.)
    if (bridges.size !== 1) {
      return _originalFetch(input, init)
    }
    const [soleBridge] = bridges.values()
    if (soleBridge === undefined) {
      return _originalFetch(input, init)
    }
    try {
      const fs = soleBridge.build('fs', FS_METHODS) as { read(p: string): Promise<Uint8Array> }
      const bytes = await fs.read(path)
      // Cast to BodyInit — DOM lib types still expect ArrayBufferView
      // here, and recent Node Uint8Array<ArrayBufferLike> generic
      // doesn't structurally match without help. Runtime accepts it.
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': inferContentType(path) },
      })
    } catch (e) {
      if (Array.isArray(_activeRouting)) {
        // Prefix mode: the path matched a declared VFS prefix but
        // the read failed. Surface a 404 — the agent declared this
        // namespace as VFS, so a miss IS a miss, not a network
        // pass-through opportunity.
        return new Response(null, { status: 404, statusText: 'Not Found in VFS' })
      }
      // Boolean-true mode: VFS miss falls through to the network so
      // the agent can still reach legitimate same-origin paths that
      // happen to live under the host's HTTP root rather than the
      // VFS. Honors the "VFS first, network fallback" semantic.
      void e
      return _originalFetch(input, init)
    }
  }
}

let _activeRouting: boolean | ReadonlyArray<string> = false

/** Decide what to do with a fetch call. Centralizes the URL-shape
 *  + method + routing-mode logic so the shim's body stays focused on
 *  the fs/Response mechanics. */
function decideFetchRoute(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  routing: boolean | ReadonlyArray<string>,
): 'passthrough' | 'not-in-prefix-vfs' | { path: string } {
  // Method gate: only GET/HEAD are routed. Other methods don't have
  // a sensible VFS interpretation (writing via fetch isn't a thing
  // we want to support; the agent uses fs.write for that).
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') return 'passthrough'

  // Extract the URL string from whatever shape we got.
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

  // Path-absolute check: only `/foo`-style URLs are routable.
  // Scheme-prefixed (`https://...`), scheme-relative (`//host/...`),
  // and relative (`foo`, `./foo`) all pass through. Strip query +
  // fragment when computing the VFS path; both are noise for file
  // lookup.
  if (!urlStr.startsWith('/') || urlStr.startsWith('//')) return 'passthrough'
  const noQuery = urlStr.split('#')[0]?.split('?')[0] ?? urlStr
  const path = noQuery

  if (routing === true) return { path }
  if (Array.isArray(routing)) {
    const matches = routing.some((prefix) => path.startsWith(prefix))
    if (!matches) return 'passthrough'
    return { path }
  }
  return 'passthrough'
}

/** Best-effort content-type from file extension. The full IANA list
 *  isn't worth pulling in — the libraries that need this (CSV / JSON /
 *  Parquet / images) have a small set of canonical types they expect.
 *  Default `application/octet-stream` is safe for everything else
 *  (libraries that need a specific type usually inspect bytes anyway). */
function inferContentType(path: string): string {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return 'application/octet-stream'
  const ext = path.slice(dot + 1).toLowerCase()
  switch (ext) {
    case 'csv':
      return 'text/csv'
    case 'json':
      return 'application/json'
    case 'txt':
    case 'md':
      return 'text/plain'
    case 'html':
    case 'htm':
      return 'text/html'
    case 'xml':
      return 'application/xml'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'parquet':
      return 'application/vnd.apache.parquet'
    case 'arrow':
      return 'application/vnd.apache.arrow.stream'
    default:
      return 'application/octet-stream'
  }
}

/** Lazy module loader injected into the agent's scope (and passed to
 *  helpers). First call for a name fires the dynamic import; concurrent
 *  callers await the same in-flight promise; later calls hit the cache.
 *
 *  Failures are wrapped in an `Error` named `'ImportError'` carrying
 *  the registered name + URL + underlying message, so the agent's
 *  recoverable-error path emits a useful `💥 ImportError: ...` line
 *  rather than a bare `TypeError: Failed to fetch...`. */
function __load(executeId: number, name: string): Promise<unknown> {
  const cached = urlPromiseCache.get(name)
  if (cached !== undefined) return cached
  const spec = urlSpecs.get(name)
  if (spec !== undefined) {
    // Registered URL-shipped name — fetch and pluck the named export.
    const p = (async () => {
      try {
        const mod = (await rawImport(spec.url)) as Record<string, unknown>
        const value = spec.export === undefined ? mod : mod[spec.export]
        if (value === undefined) {
          const e = new Error(
            `Could not load registered module '${name}' (${spec.url}): module has no '${spec.export}' export (named exports: ${Object.keys(mod).join(', ') || '<none>'})`,
          )
          e.name = 'ImportError'
          throw e
        }
        return value
      } catch (raw) {
        // Already wrapped → re-throw as-is so the cached rejection
        // stays informative across retries.
        if (raw instanceof Error && raw.name === 'ImportError') throw raw
        const reason = raw instanceof Error ? raw.message : String(raw)
        const wrapped = new Error(
          `Could not load registered module '${name}' (${spec.url}): ${reason}`,
        )
        wrapped.name = 'ImportError'
        throw wrapped
      }
    })()
    urlPromiseCache.set(name, p)
    p.catch(() => undefined)
    return p
  }
  // Unregistered name. If the host has a namespaceResolver configured
  // (signalled via configure.hasNamespaceResolver), RPC over for the
  // URL; otherwise fail with the standardized "module missing" error
  // the agent's training data recognizes.
  const p = (async () => {
    if (configured?.hasNamespaceResolver === true) {
      const url = await resolveNamespaceViaHost(executeId, name)
      if (url !== null) {
        // Cache the resolution as a urlSpec entry so subsequent
        // imports take the registered path (sticky resolution per
        // worker lifetime).
        urlSpecs.set(name, { url })
        return await rawImport(url)
      }
    }
    throw new Error(`Cannot find module '${name}'`)
  })()
  urlPromiseCache.set(name, p)
  // Defang the unhandled-rejection warning if nothing has awaited
  // the cached promise yet (e.g. the agent destructured but never
  // referenced the value). The next caller still gets the real
  // rejection on its `await __load(name)`.
  p.catch(() => undefined)
  return p
}

async function handleExecute(msg: Extract<Host2WorkerMessage, { type: 'execute' }>): Promise<void> {
  const { code, executeId } = msg

  // Per-execute "late terminator" slot. Recorded inside the wrapped
  // taskSuccess/Fail before the throw, so even if the throw becomes
  // an unhandled rejection (because the agent called the terminator
  // from an async path it didn't `await`), we still know what they
  // meant. After the body settles we use this to surface a "missing
  // await" hint instead of a silent "no observation" turn.
  let lateTerminator:
    | { kind: 'success'; value: unknown }
    | { kind: 'fail'; message: string }
    | null = null
  const taskSuccess = (value: unknown): never => {
    if (lateTerminator === null) lateTerminator = { kind: 'success', value }
    throw new TaskSuccessSignal(value)
  }
  const taskFail = (message: string): never => {
    if (lateTerminator === null) lateTerminator = { kind: 'fail', message }
    throw new TaskFailSignal(message)
  }

  const bridge = new BridgeChannel(executeId)
  bridges.set(executeId, bridge)
  // Per-execute loader: binds this execute's id so the resolver RPC
  // (`resolveNamespace`) is stamped correctly even when several executes
  // are in flight at once. The agent's rewritten `await __load('name')`
  // calls this; helpers receive it too.
  const load = (name: string): Promise<unknown> => __load(executeId, name)

  const injected: Record<string, unknown> = {
    taskSuccess,
    taskFail,
    console: makeConsole(executeId),
    // Node-fs-style ergonomic wrapper around the bridged proxy. The
    // agent can write `await fs.read(path, 'utf8')` to get a string
    // back, or `await fs.write(path, 'hello')` to encode-and-write —
    // matches the conventional Node fs surface they were trained on.
    // Bytes-form still works unchanged. The wrapper proxies all
    // other methods through to the bridged fs.
    fs: wrapAgentFs(bridge.build('fs', FS_METHODS) as Parameters<typeof wrapAgentFs>[0] & object),
    cache: bridge.build('cache', CACHE_METHODS),
    // Always present in the agent's scope — set to the validated task
    // input when the host forwarded one, else `undefined`. Mirrors the
    // eval-runtime behavior so `const value = inputs` never throws a
    // ReferenceError just because the task had no inputs.
    inputs: msg.inputs,
    // Lazy loader for URL-shipped registrations. The agent's emitted
    // code calls this via the rewriter's `await __load('name')`
    // expansion of `import { ... } from 'name'`. First call per name
    // per worker lifetime fires the dynamic import; subsequent calls
    // hit the per-name promise cache.
    __load: load,
  }

  // `spawn` — only for spawn-enabled top-level executes (the host sets
  // the flag from `ctx.spawn` being present). Clones never get it, so
  // sub-tasks stay depth-1. The stub bridges to the host's `ctx.spawn`.
  if (msg.spawnEnabled === true) {
    injected.spawn = (spec: SpawnSpec): Promise<unknown> => bridge.spawn(spec)
  }

  if (configured !== null) {
    // Inject one stub per registered fn name. The agent calls
    // `await myFn(args)` and the stub round-trips through the host.
    for (const fnName of configured.fns) {
      // Skip names that would collide with built-ins above — the
      // host shouldn't allow these registrations in the first
      // place, but defending here avoids a silent override.
      if (fnName in injected) continue
      injected[fnName] = bridge.buildFn(fnName)
    }
    // Each registered namespace becomes one object whose visible
    // members are the host's filtered method list.
    for (const ns of configured.namespaces) {
      if (ns.name in injected) continue
      injected[ns.name] = bridge.buildNamespace(ns.name, ns.members)
    }
    // Each registered class becomes a constructor stub the agent
    // can `new`. See `BridgeChannel.buildClass` for what the stub
    // actually does (newInstance round-trip, Proxy with method
    // dispatch + instanceof support, static-method stubs).
    for (const cls of configured.classes) {
      if (cls.name in injected) continue
      injected[cls.name] = bridge.buildClass(cls)
    }
    // URL-shipped registrations are NOT injected as scope names —
    // the rewriter routes their imports through `__load(name)` so
    // the dynamic `import()` only fires on first reference. See
    // `__load` and `urlSpecs` above.
  }

  // Evaluate any agent-authored helpers shipped in the execute
  // message. Each helper body is `async function(__exports,
  // __modules, __registered, __load)` — produced by
  // `prepareScriptForWire` on the host side. We iterate in dependency
  // order (the host emits them that way), populate a local `__modules`
  // map, then pass it to the user's main code (which has had its
  // imports rewritten into `__modules['/path']` / `__registered['name']`
  // / `await __load('name')` lookups). The `__registered` map holds
  // host-bound fn / cls / namespace stubs (RPC bridges); URL-shipped
  // names go through `__load` for lazy import.
  const __modules: Record<string, Readonly<Record<string, unknown>>> = {}
  const __registered: Record<string, unknown> = {}
  if (configured !== null) {
    for (const fnName of configured.fns) __registered[fnName] = bridge.buildFn(fnName)
    for (const ns of configured.namespaces)
      __registered[ns.name] = bridge.buildNamespace(ns.name, ns.members)
    for (const cls of configured.classes) __registered[cls.name] = bridge.buildClass(cls)
  }
  if (msg.helpers !== undefined && msg.helpers.length > 0) {
    try {
      for (const h of msg.helpers) {
        const fn = new AsyncFunction('__exports', '__modules', '__registered', '__load', h.body)
        const exports: Record<string, unknown> = {}
        await fn(exports, __modules, __registered, load)
        ;(__modules as Record<string, Readonly<Record<string, unknown>>>)[h.path] = exports
      }
    } catch (e) {
      bridges.delete(executeId)
      post({
        type: 'result',
        executeId,
        outcome: { kind: 'continue' },
        error: serializeError(e),
      })
      return
    }
  }
  injected.__modules = __modules

  const names = Object.keys(injected)
  const values = names.map((n) => injected[n])

  let outcome: TaskOutcome = { kind: 'continue' }
  let error: SerializedError | null = null
  try {
    const fn = new AsyncFunction(...names, code)
    await fn(...values)
  } catch (e) {
    if (e instanceof TaskSuccessSignal) {
      outcome = { kind: 'success', value: e.value }
    } else if (e instanceof TaskFailSignal) {
      outcome = { kind: 'fail', message: e.message }
    } else {
      error = serializeError(e)
    }
  }

  // Late-terminator detection: the AsyncFunction body settled cleanly
  // with no terminator caught synchronously. Two ways the agent can
  // still have queued a terminator from an unawaited async path:
  //
  //   (a) Bridge-mediated — `await fs.read(...)` / registered fn /
  //       namespace call inside an async wrapper that wasn't awaited.
  //       Detectable by `bridge.pendingCount > 0` at body settle.
  //       Drain the bridge so the deferred chain completes.
  //
  //   (b) Purely local — e.g. `void proposeIdeas()` where the wrapper
  //       calls `taskSuccess(...)` synchronously and the throw becomes
  //       an orphan promise rejection. `bridge.pendingCount` is 0 here
  //       (no bridge traffic at all), but `lateTerminator` was already
  //       recorded synchronously inside the throw path. Without a
  //       microtask drain + check this case posted back
  //       `{outcome: continue, error: null}` and the agent saw no
  //       observation at all.
  //
  // The wrapped terminators (`taskSuccess` / `taskFail` above) record
  // their intent into `lateTerminator` BEFORE throwing, so either path
  // leaves a usable signal we can synthesize a MissingAwaitError from.
  // Suppress matching unhandled-rejection events during the drain so
  // the worker realm's default rejection logging doesn't print noise
  // for what we're explicitly handling.
  if (outcome.kind === 'continue' && error === null) {
    const onUnhandled = (ev: PromiseRejectionEvent): void => {
      const reason = ev.reason as unknown
      if (reason instanceof TaskSuccessSignal || reason instanceof TaskFailSignal) {
        ev.preventDefault()
      }
    }
    self.addEventListener('unhandledrejection', onUnhandled)
    try {
      if (bridge.pendingCount > 0) {
        // 2s upper bound is generous for a deferred chain to complete;
        // the host's per-emission timeout bounds the total wait
        // separately.
        await bridge.drain(2000)
      } else {
        // No bridge traffic — give purely-local orphan async chains a
        // chance to settle. Microtask drain bounded at 16 ticks so we
        // don't spin forever on a genuine "fire and forget the wrong
        // thing" case the agent intended.
        for (let i = 0; i < 16 && lateTerminator === null; i++) {
          await Promise.resolve()
        }
      }
    } finally {
      self.removeEventListener('unhandledrejection', onUnhandled)
    }
    if (lateTerminator !== null) {
      error = serializeError(makeMissingAwaitError(lateTerminator))
    }
  }

  // Reject any orphan bridge Promises (user code dispatched a call
  // without awaiting it before unwinding) so their `await`-side
  // closures release rather than retaining the channel forever.
  // Done before dropping the channel from `bridges` so any in-flight
  // catch handlers triggered by the rejection still see it.
  bridge.cancelPending(makeCancelledError('execute settled with pending bridge calls'))
  bridges.delete(executeId)
  post({ type: 'result', executeId, outcome, error })
}

/** Build the user-facing error surfaced when a terminator was called
 *  from an async path the agent didn't `await`. Names the terminator
 *  and prescribes the fix in JS/TS-idiomatic terms — `await` is the
 *  standard pattern, `void` the standard escape hatch for intentional
 *  fire-and-forget. Mirrors `eval.ts`'s `makeMissingAwaitError` so
 *  embedders see the same message regardless of runtime. */
function makeMissingAwaitError(
  late: { kind: 'success'; value: unknown } | { kind: 'fail'; message: string },
): Error {
  const kind = late.kind === 'success' ? 'taskSuccess' : 'taskFail'
  const e = new Error(
    `${kind}() was called from an async function that wasn't awaited at the top level — the terminator fired AFTER ts_action returned, so this turn produced no observable outcome. Add \`await\` before the call (e.g. \`await generateReport()\`) so the terminator unwinds before the action returns. If you genuinely meant to fire-and-forget, prefix the call with \`void\` (the standard JS/TS idiom for intentionally discarding a Promise).`,
  )
  e.name = 'MissingAwaitError'
  return e
}

/** Local mirror of agex-ts's `CancelledError`. Built here (rather
 *  than imported) so the worker bundle stays free of agex-ts itself
 *  — only the type sub-paths cross this boundary. The host side
 *  doesn't need to instanceof-check this; it's purely the message
 *  the agent code sees in its `catch` clause. */
function makeCancelledError(message: string): Error {
  const e = new Error(message)
  e.name = 'CancelledError'
  return e
}

self.addEventListener('message', (ev: MessageEvent<Host2WorkerMessage>) => {
  const msg = ev.data
  if (msg?.type === 'configure') {
    handleConfigure(msg)
    return
  }
  if (msg?.type === 'execute') {
    void handleExecute(msg)
    return
  }
  if (msg?.type === 'bridgeResponse') {
    bridges.get(msg.executeId)?.handleResponse(msg)
    return
  }
  if (msg?.type === 'resolveNamespaceResponse') {
    handleResolveNamespaceResponse(msg)
    return
  }
})

post({ type: 'ready' })
