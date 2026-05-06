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
 *      (`agent.fn`), and non-live namespaces (`agent.namespace`).
 *      All of those round-trip through the host via `bridgeCall` /
 *      `bridgeResponse` (see the `BridgeChannel` class below). The
 *      registered names come from a one-time `configure` message
 *      the host posts after worker boot. `inputs`, registered
 *      classes, and live-namespace instance proxies are still
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
import type {
  BridgeTarget,
  ConfigureMessage,
  Host2WorkerMessage,
  SerializedError,
  Worker2HostMessage,
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

  /** Build a non-live namespace object: each visible member becomes
   *  a method that posts `bridgeCall` with the namespace name as
   *  `subject` so the host knows which surface to dispatch to. */
  buildNamespace(name: string, members: ReadonlyArray<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const member of members) {
      out[member] = (...args: unknown[]): Promise<unknown> =>
        this.call('namespace', member, args, name)
    }
    return out
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
      try {
        post({
          type: 'bridgeCall',
          executeId: this.executeId,
          callId,
          target,
          ...(subject !== undefined && { subject }),
          method,
          args,
        })
      } catch (e) {
        // postMessage threw — typically a DataCloneError because an
        // arg wasn't structured-cloneable. Surface it on the
        // returned Promise so the agent code sees a real error
        // rather than a hung await.
        this.pending.delete(callId)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** Called by the module-level message listener when a
   *  `bridgeResponse` arrives. Looks up the parked resolver and
   *  settles it. Unknown callIds are ignored (e.g. a late response
   *  for a previous emission whose worker scope was reused). */
  handleResponse(msg: Extract<Host2WorkerMessage, { type: 'bridgeResponse' }>): void {
    const slot = this.pending.get(msg.callId)
    if (slot === undefined) return
    this.pending.delete(msg.callId)
    if (msg.ok) slot.resolve(msg.value)
    else slot.reject(rebuildError(msg.error))
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
    // Each registered (non-live) namespace becomes one object whose
    // visible members are the host's filtered method list.
    for (const ns of configured.namespaces) {
      if (ns.name in injected) continue
      injected[ns.name] = bridge.buildNamespace(ns.name, ns.members)
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
  activeBridge = null
  post({ type: 'result', executeId, outcome, error })
}

self.addEventListener('message', (ev: MessageEvent<Host2WorkerMessage>) => {
  const msg = ev.data
  if (msg?.type === 'configure') {
    configured = msg
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
