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
 *      `taskClarify`, `viewImage`, a captured `console`, proxy
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
 *      settles: a `taskSuccess` raise → success; a `TaskFailError` /
 *      `TaskClarifyError` raise → fail / clarify; clean return →
 *      `continue` with no value; any other throw → unexpected error
 *      (the host turns this into a fail with a message).
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

import type { OutputPart, TaskOutcome } from 'agex-ts/types'
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

/** Mirrors `agex-ts`'s `TaskFailError` / `TaskClarifyError` shapes,
 *  but defined locally so the worker bundle doesn't have to import
 *  the whole agex-ts core. Detection is by `name` (set on the
 *  prototype) — same convention `agex-ts/errors.isTaskControlError`
 *  uses on the host side. */
class TaskFailSignal extends Error {
  override readonly name = 'TaskFailError'
}
class TaskClarifySignal extends Error {
  override readonly name = 'TaskClarifyError'
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
  const emit = (level: 'log' | 'info' | 'warn' | 'error', args: unknown[]): void => {
    const text = args.map(safeStringify).join(' ')
    const part: OutputPart = { type: 'text', text: level === 'log' ? text : `[${level}] ${text}` }
    post({ type: 'output', executeId, part })
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

/** Best-effort string conversion — picks `JSON.stringify` for plain
 *  objects, falls back to `String(...)` for everything else. Caps
 *  long output so a runaway `console.log(hugeObj)` doesn't blow the
 *  message channel. */
function safeStringify(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  const t = typeof v
  if (t === 'string') return v as string
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v)
  if (t === 'function') return '[function]'
  try {
    const json = JSON.stringify(v)
    if (json === undefined) return String(v) // e.g. circular caught by stringify
    return json.length > 10_000 ? `${json.slice(0, 10_000)}…(truncated)` : json
  } catch {
    try {
      return String(v)
    } catch {
      return '[unserializable]'
    }
  }
}

function viewImageFor(executeId: number) {
  return (image: { format: 'png' | 'jpeg' | 'webp'; data: string }): void => {
    post({ type: 'output', executeId, part: { type: 'image', ...image } })
  }
}

// ---------------------------------------------------------------------------
// fs / cache bridge: per-execute call table
// ---------------------------------------------------------------------------

/** Methods we expose on the worker-side `fs` proxy. Mirrors
 *  termish-ts's `FileSystem` surface. The same list is enforced on
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

/** Currently-running execute's bridge channel, looked up by the
 *  module-level message listener on every `bridgeResponse`. Only
 *  one execute runs at a time (host-side guard), so a single slot is
 *  enough. Cleared when the AsyncFunction settles. */
let activeBridge: BridgeChannel | null = null

/** Most recent `configure` payload from the host. Set once after
 *  boot, possibly overwritten on a respawn (host re-sends after a
 *  hard-kill). The execute handler reads this to know which fn /
 *  namespace stubs to inject; if absent, it falls back to no-extras
 *  (matches the empty-policy case). */
let configured: ConfigureMessage | null = null

/** Loaded modules from URL-shipped registrations, keyed by the
 *  registered name. Populated lazily — `handleConfigure` kicks off
 *  imports, and `urlReady` resolves once they all complete (or
 *  rejects if any fail). The execute handler awaits this before
 *  building the agent scope so URL-shipped names are guaranteed
 *  available. Cleared and rebuilt on respawn (configure may
 *  arrive again with the same payload, but we re-import in case
 *  the host changed something). */
const urlModuleRefs = new Map<string, unknown>()
let urlReady: Promise<void> = Promise.resolve()

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

/** Process a `configure` message: store the payload + kick off
 *  dynamic imports for any URL-shipped registrations. We resolve
 *  one Promise per import in parallel (`Promise.all`) and surface
 *  failure on `urlReady` so a later `execute` sees a clean
 *  rejection rather than a hung await on a name that never
 *  populates. */
function handleConfigure(msg: ConfigureMessage): void {
  configured = msg
  urlModuleRefs.clear()
  if (msg.urlModules.length === 0) {
    urlReady = Promise.resolve()
    return
  }
  urlReady = Promise.all(
    msg.urlModules.map(async (spec) => {
      const mod = (await rawImport(spec.url)) as Record<string, unknown>
      // Missing `export` on the wire means "use the whole module
      // namespace object" — agex-runtime-worker.ts buildConfigure
      // resolves the fn / cls default to the registration name
      // before posting, so an absent field here always carries the
      // namespace whole-module semantic. With an export set, pluck
      // it (the same code path serves explicit `export: 'Vec'` and
      // `export: 'default'`).
      const value = spec.export === undefined ? mod : mod[spec.export]
      if (value === undefined) {
        throw new Error(
          `workerRuntime URL import '${spec.url}': module has no '${spec.export}' export (named exports: ${Object.keys(mod).join(', ') || '<none>'})`,
        )
      }
      urlModuleRefs.set(spec.name, value)
    }),
  ).then(() => undefined)
  // Tag a `.catch` that swallows the unhandled-rejection warning
  // when nothing's awaiting yet — the actual error still surfaces
  // through the next `await urlReady` in `handleExecute`.
  urlReady.catch(() => undefined)
}

async function handleExecute(msg: Extract<Host2WorkerMessage, { type: 'execute' }>): Promise<void> {
  const { code, executeId } = msg

  const taskSuccess = (value: unknown): never => {
    throw new TaskSuccessSignal(value)
  }
  const taskFail = (message: string): never => {
    throw new TaskFailSignal(message)
  }
  const taskClarify = (message: string): never => {
    throw new TaskClarifySignal(message)
  }

  const bridge = new BridgeChannel(executeId)
  activeBridge = bridge

  // Block until URL-shipped imports have all resolved (or one
  // failed). This is the natural place to await — it lets `execute`
  // messages arrive during boot's import phase and just queue
  // behind. If `urlReady` rejects, surface as a normal execute
  // error result so the agent loop sees a clean failure.
  try {
    await urlReady
  } catch (e) {
    activeBridge = null
    post({
      type: 'result',
      executeId,
      outcome: { kind: 'continue' },
      error: serializeError(e),
    })
    return
  }

  const injected: Record<string, unknown> = {
    taskSuccess,
    taskFail,
    taskClarify,
    viewImage: viewImageFor(executeId),
    console: makeConsole(executeId),
    fs: bridge.build('fs', FS_METHODS),
    cache: bridge.build('cache', CACHE_METHODS),
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
    // URL-shipped registrations: the dynamic imports are already
    // resolved (the `await urlReady` above blocked until they
    // were). Inject the live module exports directly — no proxy,
    // no RPC. Subclassing, `instanceof`, static access, etc. all
    // just work because these are real worker-realm references.
    for (const [name, value] of urlModuleRefs) {
      if (name in injected) continue
      injected[name] = value
    }
  }

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
    } else if (e instanceof TaskClarifySignal) {
      outcome = { kind: 'clarify', message: e.message }
    } else {
      error = serializeError(e)
    }
  }
  // Reject any orphan bridge Promises (user code dispatched a call
  // without awaiting it before unwinding) so their `await`-side
  // closures release rather than retaining the channel forever.
  // Done before nulling `activeBridge` so any in-flight catch
  // handlers triggered by the rejection still see the right channel.
  bridge.cancelPending(makeCancelledError('execute settled with pending bridge calls'))
  activeBridge = null
  post({ type: 'result', executeId, outcome, error })
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
    activeBridge?.handleResponse(msg)
    return
  }
})

post({ type: 'ready' })
