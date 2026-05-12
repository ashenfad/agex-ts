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
 * registered fns, registered namespaces, and registered classes.
 * For classes the agent sees a Proxy-backed constructor: `new
 * MyClass(args)` posts `newInstance` to the host (which parks a
 * real instance in the per-execute table), and method calls on the
 * Proxy post `instanceCall` carrying the assigned `instanceId`.
 * Static methods on the class itself dispatch through `target:
 * 'cls'`. Instance state lives entirely host-side; per-emission
 * cleanup releases everything when the execute settles.
 */

import { installConsoleProxy, makeHostFnContext, runWithCapture } from 'agex-ts/console-capture'
import { CancelledError } from 'agex-ts/errors'
import { prepareScriptForWire } from 'agex-ts/module-loader'
import { memberAllowed } from 'agex-ts/policy'
import type {
  ExecResult,
  ExecuteContext,
  MemberFilter,
  NamespaceResolver,
  OutputPart,
  Policy,
  RegisteredCls,
  RegisteredNs,
  RuntimeAdapter,
  RuntimeInitOptions,
  TaskOutcome,
} from 'agex-ts/types'
import {
  type BridgeTarget,
  type ConfigureMessage,
  type Host2WorkerMessage,
  INSTANCE_HANDLE_KEY,
  type SerializedError,
  type Worker2HostMessage,
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
  /**
   * Route the agent's `fetch(...)` calls for path-shaped URLs (no
   * scheme, starts with `/`) to the agent's VFS. Recovers agex-py's
   * "registered libraries see the VFS" property — Arquero's
   * `loadCSV`, Plotly's loaders, and any other library function
   * that internally fetches a URL will read from VFS instead of
   * hitting the host's HTTP origin.
   *
   * - `true` — every path-absolute URL is tried against VFS first;
   *   falls through to real network on miss. Use when the agent
   *   doesn't talk to a same-origin API (the common case).
   * - `string[]` — only these prefixes go to VFS; everything else
   *   (including `/api/...`) passes through unchanged. Use when
   *   your app serves an API the agent might want to call. A
   *   path that matches a prefix but isn't in VFS returns a 404
   *   Response (it was an explicit miss, not "fall through and
   *   try the network").
   * - `false` (default) — current behavior: every fetch hits the
   *   network, agent uses `fs.read` explicitly for VFS access.
   *
   * Only path-absolute URLs (`/foo`) are considered — relative
   * (`foo`, `./foo`) and scheme-relative (`//host/foo`) URLs are
   * always passed through to the real `fetch`.
   *
   * Only `GET` and `HEAD` requests are routed; other methods always
   * pass through to real `fetch` (writing to VFS via fetch is
   * outside the natural shape).
   *
   * When enabled, a short note is appended to the agent's primer
   * so the agent knows the VFS is reachable via `fetch` (and via
   * registered libraries that use it).
   */
  readonly routeFetchToVfs?: boolean | ReadonlyArray<string>
}

export function workerRuntime(opts: WorkerRuntimeOptions = {}): RuntimeAdapter {
  // Idempotent — first runtime construction in the host process
  // installs the ALS-gated console proxy. Subsequent calls are no-ops.
  // Outside any `runWithCapture` context the proxy falls through to
  // the original real console. (Node-host only; on browser hosts
  // `node:async_hooks` isn't available — registered host fns there
  // should opt in to `wantsContext: true` to capture via the explicit
  // `ctx.console` channel.)
  installConsoleProxy()
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
  let namespaceResolver: NamespaceResolver | undefined

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
    async init(policy: Policy, initOpts: RuntimeInitOptions = {}): Promise<void> {
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
      namespaceResolver = initOpts.namespaceResolver
      configurePayload = buildConfigure(
        policy,
        opts.routeFetchToVfs,
        namespaceResolver !== undefined,
      )
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

      // Resolve agent-authored `import` statements that reach the
      // VFS (`/helpers/...`). The host walks the import graph,
      // reads + transforms each helper file, and produces a list
      // of compiled-but-unevaluated bodies in dependency order
      // alongside the user code's rewritten import-to-lookup form.
      // The worker AsyncFunction-evaluates each helper in its own
      // realm — function exports don't structured-clone, so the
      // eval has to happen worker-side.
      let preparedCode: string
      let helpers: ReadonlyArray<{ path: string; body: string }>
      try {
        // Registered names give the agent (and its helpers) the
        // ability to reach the runtime-injected fns / cls /
        // namespaces via natural `import` syntax. Build the set
        // from the policy at execute time — registrations are
        // immutable per runtime instance, so this could be cached,
        // but the cost is trivial.
        // `registeredNames` covers both host-bound and URL-shipped;
        // the rewriter routes them to different emit shapes
        // (`__registered['name']` vs `await __load('name')`) based on
        // membership in `urlNames`.
        const registeredNames = new Set<string>()
        const urlNames = new Set<string>()
        if (policyRef !== null) {
          for (const [n, reg] of policyRef.fns) {
            registeredNames.add(n)
            if (reg.url !== undefined) urlNames.add(n)
          }
          for (const [n, reg] of policyRef.namespaces) {
            registeredNames.add(n)
            if (reg.url !== undefined) urlNames.add(n)
          }
          for (const [n, reg] of policyRef.classes) {
            registeredNames.add(n)
            if (reg.url !== undefined) urlNames.add(n)
          }
        }
        const prepared = await prepareScriptForWire(
          transformed,
          ctx.fs,
          transform,
          registeredNames,
          urlNames,
        )
        preparedCode = prepared.code
        helpers = prepared.helpers
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
      // Per-execute live instance table — populated by `newInstance`,
      // looked up by `instanceCall`, dropped wholesale at settle so
      // host instances don't leak across emissions. `instanceId`s
      // restart at 1 each execute; the executeId guard on the
      // message routing ensures stale messages from a prior execute
      // can't accidentally reach into the current table.
      const instances = new Map<number, unknown>()
      // Parallel map: instanceId → the `RegisteredCls` it was
      // constructed from. Lets `handleInstanceCall` re-validate
      // method visibility against the policy before dispatching,
      // mirroring the host-side allowlist check on fs / cache / fn
      // / namespace / static dispatch. Without this re-check, a
      // worker that fabricated an `instanceCall` message (or an
      // agent that bypassed our Proxy whitelist via direct
      // `self.postMessage`) could invoke methods the
      // include/exclude filter was supposed to hide.
      const instanceClasses = new Map<number, RegisteredCls>()
      let nextInstanceId = 1

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
          // Drop instance handles + their class registrations —
          // agent's "fresh slate per emission" model. Real release
          // happens when no other closure retains a reference; the
          // Map clear is the host letting go of its hold.
          instances.clear()
          instanceClasses.clear()
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
            void handleBridgeCall(m, ctx, policyRef, instances, w, outputs)
            return
          }
          if (m?.type === 'newInstance' && m.executeId === executeId) {
            void handleNewInstance(
              m,
              policyRef,
              instances,
              instanceClasses,
              () => nextInstanceId++,
              w,
            )
            return
          }
          if (m?.type === 'instanceCall' && m.executeId === executeId) {
            void handleInstanceCall(m, instances, instanceClasses, w)
            return
          }
          if (m?.type === 'resolveNamespace' && m.executeId === executeId) {
            void handleResolveNamespace(m, namespaceResolver, w)
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
          code: preparedCode,
          executeId,
          ...(helpers.length > 0 && { helpers }),
          ...(ctx.inputs !== undefined && { inputs: ctx.inputs }),
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

    primerAddendum(): string | undefined {
      const route = opts.routeFetchToVfs
      if (route === undefined || route === false) return undefined
      // Build scope description + a concrete example using the
      // actual configured prefixes (when in array mode) so the
      // primer doesn't mislead an embedder who carved out a non-
      // default VFS namespace.
      const scope = Array.isArray(route)
        ? `under these prefixes: ${route.map((p) => `\`${p}\``).join(', ')}`
        : 'for any path-absolute URL'
      const examplePath = Array.isArray(route) ? `${route[0] ?? '/'}foo.csv` : '/data/foo.csv'
      const arrayCaveat = Array.isArray(route)
        ? "  Path-absolute URLs that DO NOT match a listed prefix pass through to the network unchanged — that namespace is the host's, not yours."
        : ''
      return [
        '## Filesystem is fetch-accessible',
        '',
        `This runtime routes \`fetch(...)\` calls to your VFS ${scope} (GET/HEAD only).  That means library functions that internally call \`fetch\` — Arquero's \`loadCSV\`, Plotly's loaders, JSON/URL fetchers in any data lib — read from the same VFS your \`fs.read\` reaches, without an explicit bytes-shuttling step.  Mental model: when a registered library asks you for a "URL", a path like \`${examplePath}\` resolves against the VFS first.  Absolute URLs (\`https://...\`) and relative URLs (\`./foo\`) are unaffected — they go to the network as usual.${arrayCaveat}`,
      ].join('\n')
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
  instances: Map<number, unknown>,
  w: Worker,
  outputs: OutputPart[],
): Promise<void> {
  const { executeId, callId } = msg
  let value: unknown
  let error: SerializedError | null = null
  try {
    value = await dispatch(msg, ctx, policy, instances, outputs)
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
  instances: Map<number, unknown>,
  outputs: OutputPart[],
): Promise<unknown> {
  const { target, method } = msg
  const args = unpackArgs(msg.args, instances)
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
      return await fn.apply(surface, args)
    }
    case 'fn': {
      if (policy === null) {
        throw new Error("workerRuntime bridge: 'fn' call before init() / policy unavailable")
      }
      const reg = policy.fns.get(method)
      if (reg === undefined) {
        throw new Error(`workerRuntime bridge: no registered fn named '${method}'`)
      }
      if (reg.fn === undefined) {
        // URL-shipped — the worker resolves these natively from
        // its dynamic-imported module table; there's no host-side
        // function to invoke. If we got here, the worker stub
        // builder mis-routed.
        throw new Error(
          `workerRuntime bridge: fn '${method}' is URL-shipped; should not see RPC traffic`,
        )
      }
      const fn = reg.fn
      // Wrap the host-side dispatch so any `console.log` inside the
      // handler — including from helper modules it calls into —
      // captures into the per-execute outputs array on Node-host
      // (`node:async_hooks` available). Browser-host falls through
      // to the real console; opt in to `wantsContext: true` for
      // explicit capture there.
      return await runWithCapture({ outputs, passConsole: false }, async () => {
        if (reg.wantsContext === true) {
          const hostCtx = makeHostFnContext({ outputs, signal: ctx.signal })
          return await fn(...args, hostCtx)
        }
        return await fn(...args)
      })
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
      if (reg.target === undefined) {
        throw new Error(
          `workerRuntime bridge: namespace '${subject}' is URL-shipped; should not see RPC traffic`,
        )
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
      return await fn.apply(target, args)
    }
    case 'cls': {
      if (policy === null) {
        throw new Error("workerRuntime bridge: 'cls' call before init() / policy unavailable")
      }
      const subject = msg.subject
      if (subject === undefined) {
        throw new Error("workerRuntime bridge: 'cls' call missing required `subject`")
      }
      const reg = policy.classes.get(subject)
      if (reg === undefined) {
        throw new Error(`workerRuntime bridge: no registered class named '${subject}'`)
      }
      if (reg.cls === undefined) {
        throw new Error(
          `workerRuntime bridge: class '${subject}' is URL-shipped; should not see RPC traffic`,
        )
      }
      const visible = visibleClassStatics(reg)
      if (!visible.has(method)) {
        throw new Error(
          `workerRuntime bridge: static member '${method}' not visible on class '${subject}'`,
        )
      }
      // biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch
      const cls: any = reg.cls
      const fn = cls[method]
      if (typeof fn !== 'function') {
        throw new Error(
          `workerRuntime bridge: '${subject}.${method}' is not callable (non-function statics aren't bridged in this PR)`,
        )
      }
      return await fn.apply(cls, args)
    }
  }
}

/** Handle a `newInstance` message: invoke the registered class's
 *  constructor with the given args, park the resulting instance in
 *  the per-execute table, reply with the assigned `instanceId`. */
async function handleNewInstance(
  msg: Extract<Worker2HostMessage, { type: 'newInstance' }>,
  policy: Policy | null,
  instances: Map<number, unknown>,
  instanceClasses: Map<number, RegisteredCls>,
  nextId: () => number,
  w: Worker,
): Promise<void> {
  const { executeId, callId, clsName } = msg
  let value: { instanceId: number } | null = null
  let error: SerializedError | null = null
  try {
    if (policy === null) {
      throw new Error("workerRuntime bridge: 'newInstance' before init() / policy unavailable")
    }
    const reg = policy.classes.get(clsName)
    if (reg === undefined) {
      throw new Error(`workerRuntime bridge: no registered class named '${clsName}'`)
    }
    if (reg.constructable === false) {
      throw new Error(
        `workerRuntime bridge: class '${clsName}' is registered with constructable: false`,
      )
    }
    if (reg.cls === undefined) {
      throw new Error(
        `workerRuntime bridge: class '${clsName}' is URL-shipped; should not see RPC traffic`,
      )
    }
    const Cls = reg.cls
    const args = unpackArgs(msg.args, instances)
    const instance = new Cls(...args)
    const instanceId = nextId()
    instances.set(instanceId, instance)
    // Pair the registration with the instance so `handleInstanceCall`
    // can re-validate visibility on subsequent method dispatches.
    instanceClasses.set(instanceId, reg)
    value = { instanceId }
  } catch (e) {
    error = serializeError(e)
  }
  postBridgeResponse(w, executeId, callId, value, error)
}

/** Handle an `instanceCall` message: look up the live instance,
 *  call the named method on it (validating against the same
 *  visibility filter used at configure time), reply with the
 *  return value. */
/** Handle the worker's `resolveNamespace` request: invoke the host's
 *  `namespaceResolver`, post back the URL (or `null` to deny) the
 *  resolver returned. Errors / missing resolver collapse to `null`. */
async function handleResolveNamespace(
  msg: Extract<Worker2HostMessage, { type: 'resolveNamespace' }>,
  resolver: NamespaceResolver | undefined,
  w: Worker,
): Promise<void> {
  const { executeId, callId, specifier } = msg
  let url: string | null = null
  if (resolver !== undefined) {
    try {
      url = (await Promise.resolve(resolver(specifier))) ?? null
    } catch {
      url = null
    }
  }
  try {
    w.postMessage({ type: 'resolveNamespaceResponse', executeId, callId, url })
  } catch {
    // Worker is gone; ignore — the awaiting __load promise will be
    // cancelled when the execute settles.
  }
}

async function handleInstanceCall(
  msg: Extract<Worker2HostMessage, { type: 'instanceCall' }>,
  instances: Map<number, unknown>,
  instanceClasses: Map<number, RegisteredCls>,
  w: Worker,
): Promise<void> {
  const { executeId, callId, instanceId, method } = msg
  let value: unknown
  let error: SerializedError | null = null
  try {
    const instance = instances.get(instanceId)
    const reg = instanceClasses.get(instanceId)
    if (instance === undefined || reg === undefined) {
      throw new Error(
        `workerRuntime bridge: no live instance with id ${instanceId} (was it created in a different emission?)`,
      )
    }
    // Re-validate method visibility against the registration, the
    // same check `buildConfigure` applied to populate the worker's
    // method-name allowlist. Defense-in-depth against a fabricated
    // `instanceCall` (hostile worker, agent-side `self.postMessage`
    // bypassing the Proxy whitelist) trying to invoke an excluded
    // method that the host's prototype walk would otherwise resolve.
    const visible = visibleClassInstanceMethods(reg)
    if (!visible.has(method)) {
      throw new Error(
        `workerRuntime bridge: instance method '${method}' not visible on class '${reg.name}'`,
      )
    }
    // biome-ignore lint/suspicious/noExplicitAny: dynamic dispatch
    const target: any = instance
    const fn = target[method]
    if (typeof fn !== 'function') {
      throw new Error(`workerRuntime bridge: instance method '${method}' is not callable`)
    }
    const args = unpackArgs(msg.args, instances)
    value = await fn.apply(target, args)
  } catch (e) {
    error = serializeError(e)
  }
  postBridgeResponse(w, executeId, callId, value, error)
}

/** Walk the wire-form args and rehydrate `INSTANCE_HANDLE_KEY`
 *  markers back into the live host instances they refer to. The
 *  worker's `packArgs` produced these markers when the agent
 *  passed an instance Proxy to a bridged call (top-level, in an
 *  array, or in a plain object); this is the inverse step that
 *  lets the host method see the actual instance instead of a
 *  cloned empty shell.
 *
 *  Unrecognized references (id not in the instance table) throw —
 *  the agent likely passed a stale handle from a prior execute, or
 *  fabricated a marker by hand. Both are mistakes the host should
 *  surface, not paper over. */
function unpackArgs(args: ReadonlyArray<unknown>, instances: Map<number, unknown>): unknown[] {
  const visited = new WeakSet<object>()
  const unpack = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v
    // Marker detection — must be a plain object whose handle key
    // carries a `{ id: number }` payload. Anything else (different
    // shape, or the same key on a non-plain object) passes through.
    if (Object.getPrototypeOf(v) === Object.prototype) {
      const handle = (v as Record<string, unknown>)[INSTANCE_HANDLE_KEY]
      if (
        handle !== undefined &&
        typeof handle === 'object' &&
        handle !== null &&
        typeof (handle as { id: unknown }).id === 'number'
      ) {
        const id = (handle as { id: number }).id
        const inst = instances.get(id)
        if (inst === undefined) {
          throw new Error(
            `workerRuntime bridge: stale instance handle id=${id} (created in a prior emission, or fabricated)`,
          )
        }
        return inst
      }
    }
    if (visited.has(v)) return v
    visited.add(v)
    if (Array.isArray(v)) return v.map(unpack)
    if (Object.getPrototypeOf(v) !== Object.prototype) return v
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v)) {
      out[k] = unpack((v as Record<string, unknown>)[k])
    }
    return out
  }
  return args.map(unpack)
}

/** Common reply path for `newInstance` and `instanceCall`. Mirrors
 *  the try-twice clone-failure handling used in `handleBridgeCall`
 *  so a non-cloneable return value or a terminated worker doesn't
 *  crash the host. */
function postBridgeResponse(
  w: Worker,
  executeId: number,
  callId: number,
  value: unknown,
  error: SerializedError | null,
): void {
  try {
    if (error !== null) {
      w.postMessage({ type: 'bridgeResponse', executeId, callId, ok: false, error })
    } else {
      w.postMessage({ type: 'bridgeResponse', executeId, callId, ok: true, value })
    }
  } catch (cloneErr) {
    try {
      w.postMessage({
        type: 'bridgeResponse',
        executeId,
        callId,
        ok: false,
        error: serializeError(cloneErr),
      })
    } catch {
      // Worker is gone.
    }
  }
}

/** Build the `configure` payload from a `Policy`. Each registration
 *  is classified as either **host-bound** (RPC-bridged via fns /
 *  namespaces / classes arrays — the worker's stub builder produces
 *  proxies that round-trip every call) or **URL-shipped** (routed
 *  through the `urlModules` array — the worker dynamic-imports the
 *  URL and exposes the named export natively, no RPC). Visible
 *  namespace and class members are pre-filtered through include/
 *  exclude here so the worker never sees names that policy
 *  excluded; URL registrations skip that filter entirely (whole-
 *  module exposure is the semantic of URL mode). */
function buildConfigure(
  policy: Policy,
  routeFetchToVfs: boolean | ReadonlyArray<string> | undefined,
  hasNamespaceResolver: boolean,
): ConfigureMessage {
  const fns: string[] = []
  const namespaces: Array<{ name: string; members: ReadonlyArray<string> }> = []
  const classes: Array<{
    name: string
    instanceMethods: ReadonlyArray<string>
    staticMethods: ReadonlyArray<string>
  }> = []
  const urlModules: Array<{ name: string; url: string; export?: string }> = []

  for (const [name, reg] of policy.fns) {
    if (reg.url !== undefined) {
      // fn / cls default to plucking `mod[name]` when no explicit
      // export is given. Resolve that here so the worker can treat
      // a missing `export` field uniformly as "use whole module"
      // (which is what we want for namespace).
      urlModules.push(urlSpec(name, reg.url, reg.export ?? name))
      continue
    }
    fns.push(name)
  }

  for (const [name, reg] of policy.namespaces) {
    if (reg.url !== undefined) {
      // namespace default is the whole module — `import * as foo
      // from '...'` semantics. Pass `reg.export` through unresolved
      // so an absent value stays absent on the wire.
      urlModules.push(urlSpec(name, reg.url, reg.export))
      continue
    }
    if (reg.target === undefined) continue // host xor url enforces this
    const visible = visibleNamespaceMembers(reg)
    const target = reg.target
    const callable = [...visible].filter((m) => {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic introspection
      const v = (target as any)[m]
      return typeof v === 'function'
    })
    namespaces.push({ name, members: callable })
  }

  for (const [name, reg] of policy.classes) {
    if (reg.url !== undefined) {
      // Same default as fn — pluck `mod[name]` unless the embedder
      // named a different export.
      urlModules.push(urlSpec(name, reg.url, reg.export ?? name))
      continue
    }
    if (reg.cls === undefined) continue // host xor url enforces this
    const cls = reg.cls
    const instanceMethods = [...visibleClassInstanceMethods(reg)].filter((m) => {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic introspection
      return typeof (cls.prototype as any)[m] === 'function'
    })
    const staticMethods = [...visibleClassStatics(reg)].filter((m) => {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic introspection
      return typeof (cls as any)[m] === 'function'
    })
    classes.push({ name, instanceMethods, staticMethods })
  }

  return {
    type: 'configure',
    fns,
    namespaces,
    classes,
    urlModules,
    ...(routeFetchToVfs !== undefined && routeFetchToVfs !== false && { routeFetchToVfs }),
    ...(hasNamespaceResolver && { hasNamespaceResolver: true }),
  }
}

/** Build a `urlModules` entry, conditionally including `export` so
 *  `exactOptionalPropertyTypes` doesn't complain about
 *  `export: undefined`. */
function urlSpec(
  name: string,
  url: string,
  exportName: string | undefined,
): { name: string; url: string; export?: string } {
  return exportName !== undefined ? { name, url, export: exportName } : { name, url }
}

/** Visible instance-method names on a registered class. Walks the
 *  prototype chain so inherited methods are included; applies the
 *  registration's include/exclude filters. Same machinery as the
 *  namespace case, just rooted at `cls.prototype` instead of the
 *  registered target. */
function visibleClassInstanceMethods(reg: RegisteredCls): Set<string> {
  // URL-shipped classes never reach this code path — `buildConfigure`
  // routes them through `urlModules` rather than the host-bound
  // `classes` array, so callers always have `reg.cls` defined.
  if (reg.cls === undefined) return new Set()
  return walkPrototypeChain(reg.cls.prototype as object, reg.include, reg.exclude)
}

/** Visible static-method names on a registered class — own
 *  properties of the class function itself (plus inherited
 *  statics if the registered class extends another). Skips
 *  built-in `prototype` / `name` / `length` since those aren't
 *  user-meaningful. */
function visibleClassStatics(reg: RegisteredCls): Set<string> {
  const seen = new Set<string>()
  if (reg.cls === undefined) return seen
  const skip = new Set(['prototype', 'name', 'length'])
  const test = (k: string): boolean => {
    if (skip.has(k)) return false
    return memberAllowed(k, reg.include, reg.exclude)
  }
  // biome-ignore lint/suspicious/noExplicitAny: dynamic introspection
  let level: any = reg.cls
  while (level !== null && level !== Function.prototype && level !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(level)) {
      if (test(k)) seen.add(k)
    }
    level = Object.getPrototypeOf(level)
  }
  return seen
}

/** Compute the set of allowed member names on a namespace, applying
 *  the registration's include/exclude filters. Walks the prototype
 *  chain so methods defined on a class's `.prototype` get listed
 *  too. Uses agex-ts's `memberAllowed` directly so the visibility
 *  semantics here track the registration system's source of truth
 *  — no parallel glob implementation to drift. */
function visibleNamespaceMembers(reg: RegisteredNs): Set<string> {
  if (reg.target === undefined) return new Set()
  return walkPrototypeChain(reg.target, reg.include, reg.exclude)
}

/** Walk a prototype chain (own properties of `root` plus everything
 *  reachable via `Object.getPrototypeOf` until `Object.prototype`),
 *  collect member names that pass `memberAllowed(include, exclude)`,
 *  skipping `'constructor'`. Shared by the namespace, class
 *  instance, and any future surface that exposes "all reachable
 *  members" with the same filter semantics. */
function walkPrototypeChain(
  root: object,
  include: MemberFilter | undefined,
  exclude: MemberFilter | undefined,
): Set<string> {
  const seen = new Set<string>()
  const test = (k: string): boolean => {
    if (k === 'constructor') return false
    return memberAllowed(k, include, exclude)
  }
  for (const k of Object.getOwnPropertyNames(root)) {
    if (test(k)) seen.add(k)
  }
  let proto: object | null = Object.getPrototypeOf(root) as object | null
  while (proto !== null && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (test(k)) seen.add(k)
    }
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return seen
}
