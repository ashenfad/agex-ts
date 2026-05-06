/**
 * `workerRuntime` — `RuntimeAdapter` that runs each `ts` emission
 * inside a Web Worker.
 *
 * High-level flow per `execute`:
 *
 *   1. Lazily spawn a Worker (on first call, or after a previous
 *      worker was terminated by timeout / abort). Wait for the
 *      worker to post `ready`.
 *   2. Run the configured `transform` on the host side (default
 *      `ts-blank-space`). Surface syntax errors before paying
 *      message-passing cost.
 *   3. `postMessage({ type: 'execute', code, ... })`. Stream
 *      incoming `output` messages into a local buffer. Resolve when
 *      a `result` message arrives.
 *   4. If the per-emission `timeoutMs` fires *or* `ctx.signal`
 *      aborts: `worker.terminate()`, drop the worker, return an
 *      `ExecResult` carrying any outputs collected before the kill
 *      plus a `CancelledError` (for abort) or generic timeout
 *      `Error` (for the budget). The next `execute` spawns a fresh
 *      worker.
 *
 * Cooperative cancellation is a follow-up — today the adapter only
 * does the hard-terminate path, which is enough to honor wall-clock
 * budgets and external aborts.
 *
 * What gets bridged today: `fs` / `cache` (per-execute context),
 * registered fns, and registered namespaces. Registered classes
 * (`agent.cls`) — agent-side `new` returning per-emission instance
 * handles whose method calls round-trip — are the next slice.
 */

import { CancelledError } from 'agex-ts/errors'
import { memberAllowed } from 'agex-ts/policy'
import type {
  ExecResult,
  ExecuteContext,
  OutputPart,
  Policy,
  RegisteredNs,
  RuntimeAdapter,
  TaskOutcome,
} from 'agex-ts/types'
import type {
  BridgeTarget,
  ConfigureMessage,
  Host2WorkerMessage,
  SerializedError,
  Worker2HostMessage,
} from './messages'
import { type TransformFn, defaultTransform } from './transform'

// Methods we accept on each bridged surface. Matching the worker's
// proxy whitelist so a typo / hostile worker can't reach
// prototype-chain methods (`toString`, `__proto__`, etc.). Kept in
// sync with `worker.ts`'s `FS_METHODS` / `CACHE_METHODS`.
const FS_METHODS: ReadonlySet<string> = new Set([
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
])
const CACHE_METHODS: ReadonlySet<string> = new Set(['set', 'get', 'has', 'delete', 'keys'])

export interface WorkerRuntimeOptions {
  /** URL the host should hand to `new Worker(...)`. Defaults to the
   *  bundled `worker.js` shipped alongside this module — resolves
   *  via `new URL('./worker.js', import.meta.url)`, which Vite,
   *  webpack, esbuild, and modern browsers all understand. Override
   *  if you're shipping the worker file from a different origin or
   *  embedding agex inside an app with a custom asset pipeline. */
  readonly workerUrl?: string | URL
  /** TS → JS transform run on the host before code is shipped to
   *  the worker. Defaults to `ts-blank-space` (lightweight type
   *  stripping; matches `evalRuntime`). Pass your own to swap in
   *  e.g. `esbuild-wasm` for fuller TS coverage. */
  readonly transform?: TransformFn
  /** Per-emission wall-clock budget, in milliseconds. Hitting it
   *  terminates the worker; the next emission spawns a fresh one.
   *  Default `5000`. */
  readonly timeoutMs?: number
}

export function workerRuntime(opts: WorkerRuntimeOptions = {}): RuntimeAdapter {
  const transform = opts.transform ?? defaultTransform
  const timeoutMs = opts.timeoutMs ?? 5000
  const workerUrl = opts.workerUrl ?? new URL('./worker.js', import.meta.url)

  // Worker is spawned lazily — on first `execute` and after every
  // hard-terminate. Holding a single live worker across consecutive
  // execute calls is intentional: spawning costs ~10ms in browsers
  // and we don't yet have a per-call importmap to mutate (that
  // changes in the module-policy PR).
  //
  // Concurrency: this adapter assumes one outstanding `execute()`
  // at a time. The agent loop calls into us sequentially per
  // emission, so this matches actual usage; concurrent calls would
  // share a single worker and a `killWorker()` from one (timeout,
  // abort, dispose) would yank the rug out from under any other
  // in-flight execute. We enforce the assumption with a guard
  // (`activeExecute`) below — if it ever throws in practice that's
  // a bug in the caller, not in this adapter.
  let worker: Worker | null = null
  let readyPromise: Promise<void> | null = null
  let nextExecuteId = 1
  let disposed = false
  // Hoisted out of the per-execute Promise so `dispose()` (and any
  // future cancellation point) can settle a hung execute
  // immediately rather than waiting for `timeoutMs` to fire.
  let activeExecute: { settle: (reason: Error) => void } | null = null
  // Captured at `init()` and re-shipped on every spawn (the worker
  // is recreated after timeout / abort kills it). Holds the
  // RegisteredFn / RegisteredNs entries the bridge dispatcher needs
  // and the matching wire-form the worker's stub builder expects.
  let policyRef: Policy | null = null
  let configurePayload: ConfigureMessage | null = null

  function spawn(): void {
    const w = new Worker(workerUrl, { type: 'module' })
    worker = w
    readyPromise = new Promise<void>((resolve, reject) => {
      const onMsg = (ev: MessageEvent<Worker2HostMessage>): void => {
        if (ev.data?.type === 'ready') {
          w.removeEventListener('message', onMsg)
          w.removeEventListener('error', onErr)
          // Configure must arrive before the first `execute` so the
          // worker's stub builder can populate fn / namespace
          // bindings. postMessage delivery is FIFO, so posting it
          // here (before `execute` is sent) is enough — no
          // round-trip needed.
          if (configurePayload !== null) w.postMessage(configurePayload)
          resolve()
        }
      }
      const onErr = (ev: ErrorEvent): void => {
        w.removeEventListener('message', onMsg)
        w.removeEventListener('error', onErr)
        reject(new Error(`worker failed during boot: ${ev.message}`))
      }
      w.addEventListener('message', onMsg)
      w.addEventListener('error', onErr)
    })
  }

  function killWorker(): void {
    if (worker !== null) {
      worker.terminate()
      worker = null
      readyPromise = null
    }
  }

  return {
    async init(policy: Policy): Promise<void> {
      // Capture the policy so:
      //   1. `handleBridgeCall` can dispatch `fn` / `namespace`
      //      calls against the live registrations.
      //   2. `spawn()` (lazy + on respawn after a hard-kill) can
      //      ship the matching `configure` message to the worker
      //      so its stub builder knows what names to expose.
      //
      // The configure payload is fixed at init time — no in-flight
      // policy mutation. If the embedder wants new registrations,
      // they need a fresh runtime instance.
      policyRef = policy
      configurePayload = buildConfigure(policy)
    },

    async execute(code: string, ctx: ExecuteContext): Promise<ExecResult> {
      const start = performance.now()

      // Honor a pre-fired abort *before* spawning anything — saves
      // a worker boot when the caller has already given up.
      if (ctx.signal.aborted) {
        return {
          outcome: { kind: 'continue' },
          outputs: [],
          error: new CancelledError(),
          elapsedMs: 0,
        }
      }

      if (disposed) {
        throw new Error('workerRuntime: execute() called after dispose()')
      }
      if (activeExecute !== null) {
        throw new Error(
          'workerRuntime: concurrent execute() not supported — ' +
            'previous emission is still running. The agent loop calls ' +
            'execute() sequentially per emission; if you hit this, the ' +
            'embedder is calling the adapter directly from multiple ' +
            'concurrent task calls against the same runtime instance.',
        )
      }
      // Claim the slot *synchronously* so back-to-back execute()
      // calls in the same microtask trip the guard above. The real
      // settle is wired up later inside the per-execute Promise; up
      // until that happens, dispose-during-setup is a no-op (the
      // setup awaits are short — transform + ready). Cleared in the
      // settle path on every exit, including the early-return
      // transform/ready failure branches below.
      activeExecute = { settle: () => {} }

      // Transform on the host. Syntax errors surface here without
      // ever spawning / messaging the worker.
      let transformed: string
      try {
        transformed = await transform(code)
      } catch (e) {
        activeExecute = null
        return {
          outcome: { kind: 'continue' },
          outputs: [],
          error: e instanceof Error ? e : new Error(String(e)),
          elapsedMs: performance.now() - start,
        }
      }

      if (worker === null) spawn()
      // `spawn()` populates both `worker` and `readyPromise`; tell TS.
      const w = worker as Worker
      const ready = readyPromise as Promise<void>
      try {
        await ready
      } catch (e) {
        activeExecute = null
        killWorker()
        return {
          outcome: { kind: 'continue' },
          outputs: [],
          error: e instanceof Error ? e : new Error(String(e)),
          elapsedMs: performance.now() - start,
        }
      }

      const executeId = nextExecuteId++
      const outputs: OutputPart[] = []

      let outcome: TaskOutcome = { kind: 'continue' }
      let error: Error | null = null

      await new Promise<void>((resolve) => {
        let settled = false
        // `settle` accepts an optional reason so external callers
        // (today: `dispose()`) can force-settle a hung execute by
        // setting `error` and resolving — no need to wait for the
        // timeout timer. The internal settle paths (result message,
        // worker error, abort, timer) call it with no arg and rely
        // on `error` having already been assigned in their own
        // branch.
        const settle = (reason?: Error): void => {
          if (settled) return
          settled = true
          if (reason !== undefined) error = reason
          w.removeEventListener('message', onMsg)
          w.removeEventListener('error', onErr)
          ctx.signal.removeEventListener('abort', onAbort)
          clearTimeout(timer)
          activeExecute = null
          resolve()
        }
        activeExecute = { settle }

        const onMsg = (ev: MessageEvent<Worker2HostMessage>): void => {
          const m = ev.data
          if (m?.type === 'output' && m.executeId === executeId) {
            outputs.push(m.part)
            return
          }
          if (m?.type === 'bridgeCall' && m.executeId === executeId) {
            void handleBridgeCall(m, ctx, policyRef, w)
            return
          }
          if (m?.type === 'result' && m.executeId === executeId) {
            outcome = m.outcome
            if (m.error !== null) error = rebuildError(m.error)
            settle()
          }
        }
        const onErr = (ev: ErrorEvent): void => {
          // Worker threw outside an `execute` (e.g. a parse error in
          // its own module — shouldn't happen with our entry, but
          // surface it cleanly if it does). The worker is now in a
          // bad state; kill and respawn next time.
          error = new Error(`worker error: ${ev.message}`)
          killWorker()
          settle()
        }
        const onAbort = (): void => {
          error = new CancelledError()
          killWorker()
          settle()
        }

        const timer = setTimeout(() => {
          error = new Error(`emission exceeded ${timeoutMs}ms timeout`)
          killWorker()
          settle()
        }, timeoutMs)

        w.addEventListener('message', onMsg)
        w.addEventListener('error', onErr)
        ctx.signal.addEventListener('abort', onAbort)

        const out: Host2WorkerMessage = {
          type: 'execute',
          code: transformed,
          executeId,
          ...(ctx.emissionId !== undefined && { emissionId: ctx.emissionId }),
        }
        w.postMessage(out)
      })

      return {
        outcome,
        outputs,
        error,
        elapsedMs: performance.now() - start,
      }
    },

    async dispose(): Promise<void> {
      disposed = true
      // Settle any in-flight execute *before* terminating the
      // worker — once `worker.terminate()` runs, no more `message`
      // or `error` events fire, so the only remaining settle path
      // would be the per-execute `timeoutMs` timer (default 5s of
      // pointless waiting). Force-settle with a CancelledError so
      // the awaiting caller returns immediately.
      if (activeExecute !== null) {
        activeExecute.settle(new CancelledError('runtime disposed'))
      }
      killWorker()
    },
  }
}

/** Reconstruct a host-side `Error` from the wire form. We can't
 *  preserve the prototype chain (Anthropic's `TaskFailError` etc.
 *  live in agex-ts core; we'd have to import them), so callers get a
 *  plain `Error` whose `name` and `message` come from the worker. */
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
  return { name: 'Error', message: String(e) }
}

/** Dispatch a `bridgeCall` from the worker against the live
 *  `ExecuteContext` / `Policy`. Reply with a `bridgeResponse`
 *  carrying either the awaited return value or a serialized error.
 *
 *  Two failure modes worth distinguishing:
 *
 *    1. The host call itself throws (e.g. `fs.read('/missing')` on
 *       a strict backend, or a registered fn that rejects) —
 *       caught and serialized as `ok: false`.
 *    2. The successful return value isn't structured-cloneable
 *       (e.g. a registered fn returns another function). The outer
 *       `try/catch` around `postMessage` catches the
 *       `DataCloneError` and re-emits it as `ok: false` so the
 *       worker's awaiting promise rejects rather than hangs.
 *
 *  If the worker has been terminated between the call and the
 *  response (timeout / abort fired during the await), `postMessage`
 *  is a no-op or throws — either way, no one is listening, so we
 *  swallow any failure on this final send. */
async function handleBridgeCall(
  msg: Extract<Worker2HostMessage, { type: 'bridgeCall' }>,
  ctx: ExecuteContext,
  policy: Policy | null,
  w: Worker,
): Promise<void> {
  const { executeId, callId } = msg
  let value: unknown
  let error: SerializedError | null = null
  try {
    value = await dispatch(msg, ctx, policy)
  } catch (e) {
    error = serializeError(e)
  }

  // Final reply. Wrapped in try/catch because the value might not
  // structured-clone, and because the worker may have been
  // terminated mid-call (timeout / abort) — both cases would
  // otherwise crash the host.
  try {
    if (error !== null) {
      w.postMessage({ type: 'bridgeResponse', executeId, callId, ok: false, error })
    } else {
      w.postMessage({ type: 'bridgeResponse', executeId, callId, ok: true, value })
    }
  } catch (cloneErr) {
    // Successful host call but result wasn't cloneable. Try once
    // more with the failure encoded so the worker's await rejects.
    try {
      w.postMessage({
        type: 'bridgeResponse',
        executeId,
        callId,
        ok: false,
        error: serializeError(cloneErr),
      })
    } catch {
      // Worker is gone. Nothing to deliver to.
    }
  }
}

async function dispatch(
  msg: Extract<Worker2HostMessage, { type: 'bridgeCall' }>,
  ctx: ExecuteContext,
  policy: Policy | null,
): Promise<unknown> {
  const { target, method, args } = msg
  switch (target) {
    case 'fs':
    case 'cache': {
      const allowed = target === 'fs' ? FS_METHODS : CACHE_METHODS
      if (!allowed.has(method)) {
        throw new Error(`workerRuntime bridge: method '${method}' not allowed on '${target}'`)
      }
      // biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over the bridged contract
      const surface: any = target === 'fs' ? ctx.fs : ctx.cache
      const fn = surface[method]
      if (typeof fn !== 'function') {
        throw new Error(
          `workerRuntime bridge: '${target}.${method}' is not callable on this context`,
        )
      }
      return await fn.apply(surface, args as unknown[])
    }
    case 'fn': {
      if (policy === null) {
        throw new Error("workerRuntime bridge: 'fn' call before init() / policy unavailable")
      }
      const reg = policy.fns.get(method)
      if (reg === undefined) {
        throw new Error(`workerRuntime bridge: no registered fn named '${method}'`)
      }
      return await reg.fn(...(args as unknown[]))
    }
    case 'namespace': {
      if (policy === null) {
        throw new Error("workerRuntime bridge: 'namespace' call before init() / policy unavailable")
      }
      const subject = msg.subject
      if (subject === undefined) {
        throw new Error("workerRuntime bridge: 'namespace' call missing required `subject`")
      }
      const reg = policy.namespaces.get(subject)
      if (reg === undefined) {
        throw new Error(`workerRuntime bridge: no registered namespace named '${subject}'`)
      }
      const visible = visibleNamespaceMembers(reg)
      if (!visible.has(method)) {
        throw new Error(
          `workerRuntime bridge: member '${method}' not visible on namespace '${subject}'`,
        )
      }
      // Functions can live anywhere on the prototype chain. Use
      // bracket access (NOT Object.getOwnPropertyDescriptor) so
      // we get inherited methods too. The visibility check above
      // already enforced that the name is allowed.
      // biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch over the bridged contract
      const target: any = reg.target
      const fn = target[method]
      if (typeof fn !== 'function') {
        throw new Error(
          `workerRuntime bridge: '${subject}.${method}' is not callable (non-function members aren't bridged in this PR)`,
        )
      }
      return await fn.apply(target, args as unknown[])
    }
  }
}

/** Build the `configure` payload from a `Policy`. Visible
 *  namespace members are pre-filtered through include/exclude here
 *  so the worker never sees names that policy excluded — defense
 *  in depth, paired with the host-side allowlist re-check in
 *  `dispatch`. Non-function members are skipped — they aren't
 *  bridged in this PR. */
function buildConfigure(policy: Policy): ConfigureMessage {
  const fns = [...policy.fns.keys()]
  const namespaces: Array<{ name: string; members: ReadonlyArray<string> }> = []
  for (const [name, reg] of policy.namespaces) {
    const visible = visibleNamespaceMembers(reg)
    const callable = [...visible].filter((m) => {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic introspection
      const v = (reg.target as any)[m]
      return typeof v === 'function'
    })
    namespaces.push({ name, members: callable })
  }
  return { type: 'configure', fns, namespaces }
}

/** Compute the set of allowed member names on a namespace, applying
 *  the registration's include/exclude filters. Walks the prototype
 *  chain so methods defined on a class's `.prototype` get listed
 *  too. Uses agex-ts's `memberAllowed` directly so the visibility
 *  semantics here track the registration system's source of truth
 *  — no parallel glob implementation to drift. */
function visibleNamespaceMembers(reg: RegisteredNs): Set<string> {
  const seen = new Set<string>()
  const test = (k: string): boolean => {
    if (k === 'constructor') return false
    return memberAllowed(k, reg.include, reg.exclude)
  }
  for (const k of Object.getOwnPropertyNames(reg.target)) {
    if (test(k)) seen.add(k)
  }
  let proto: object | null = Object.getPrototypeOf(reg.target) as object | null
  while (proto !== null && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (test(k)) seen.add(k)
    }
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return seen
}
