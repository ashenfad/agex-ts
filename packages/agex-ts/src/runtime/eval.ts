/**
 * `evalRuntime` — same-realm `RuntimeAdapter` used by tests and by
 * embedders that explicitly opt out of worker isolation.
 *
 * What it does:
 * - Strips TypeScript type annotations via `ts-blank-space` so the
 *   agent can emit idiomatic typed code (the schemas advertise
 *   "TypeScript" — this delivers on that). Whitespace-preserving:
 *   line/column positions in stack traces match the original code.
 * - Evaluates the emitted code via `new AsyncFunction(...)` so the
 *   code can use `await` and the injected names land directly in
 *   scope (no `with` block needed).
 * - Injects the active policy's `fns` and `namespaces` as
 *   identifiers — same as the worker runtime would expose, just
 *   without the message-passing layer.
 * - Injects `taskSuccess`, `taskFail`, `taskClarify`, `cache`, `fs`
 *   — the standard task-loop bindings the agent's emitted code
 *   expects.
 * - Installs a process-wide ALS-gated `console` proxy so `console.log`
 *   from agent code AND from registered host fns dispatched on this
 *   call chain captures into the result's `outputs` array. Image-
 *   shaped values (`{format,data}`, data URLs, PNG/JPEG/WebP
 *   `Uint8Array`s) become `image` parts; everything else flows
 *   through `safeStringifyArgs` to a `text` part.
 *
 * What it explicitly does NOT do:
 * - No bundling / esbuild — `ts-blank-space` strips types only. Full
 *   TS features that aren't erasable as types (enum, namespace,
 *   decorators, parameter properties) throw a syntax error. Modern
 *   TS style avoids these and the primer flags them.
 * - No sandboxing. The code runs in the host realm with full access
 *   to the surrounding closures. Use this for tests or for trusted
 *   embedders only.
 * - No tick limit. Wall-clock `timeoutMs` is the only enforcement.
 */

import tsBlankSpace from 'ts-blank-space'
import { CancelledError, TaskClarifyError, TaskFailError, isTaskControlError } from '../errors'
import type {
  ExecResult,
  ExecuteContext,
  OutputPart,
  Policy,
  RuntimeAdapter,
  TaskOutcome,
} from '../types'
import { installConsoleProxy, makeHostFnContext, runWithCapture } from './console-capture'
import { prepareScript } from './module-loader'
import { wrapAgentFs } from './wrap-fs'

export interface EvalRuntimeOptions {
  /** Per-emission wall-clock budget in milliseconds. Default `5000`. */
  readonly timeoutMs?: number
  /** When true, console.* calls also pass through to the host's
   *  console (useful when debugging tests). Default `false`. */
  readonly passConsole?: boolean
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<unknown>

export function evalRuntime(opts: EvalRuntimeOptions = {}): RuntimeAdapter {
  // Idempotent — first runtime construction in the process installs the
  // ALS-gated console proxy; later calls are a no-op. Outside any
  // `runWithCapture` context the proxy falls through to the original
  // real console.
  installConsoleProxy()
  let policy: Policy | null = null
  const timeoutMs = opts.timeoutMs ?? 5000
  // URL-shipped registration specs, keyed by registered name.
  // Populated at `init()` but NOT imported — the dynamic `import()`
  // fires on first reference via `__load(name)` from the agent's
  // emitted code, mirroring workerRuntime's lazy semantics.
  const urlSpecs = new Map<string, { url: string; key: string | undefined }>()
  // Per-name resolved-or-in-flight promise cache. First reader stashes;
  // concurrent readers await the same promise. Failures wrap in a plain
  // Error named `'ImportError'` so the agent's recoverable-error path
  // emits a readable `💥 ImportError: Could not load module 'X' (URL): ...`
  // line on the next turn.
  const urlPromiseCache = new Map<string, Promise<unknown>>()

  function __load(name: string): Promise<unknown> {
    const cached = urlPromiseCache.get(name)
    if (cached !== undefined) return cached
    const spec = urlSpecs.get(name)
    if (spec === undefined) {
      return Promise.reject(
        new Error(`evalRuntime: __load('${name}') called for an unregistered URL-shipped name`),
      )
    }
    const p = (async () => {
      try {
        const mod = (await import(spec.url)) as Record<string, unknown>
        const value = spec.key === undefined ? mod : mod[spec.key]
        if (value === undefined) {
          const e = new Error(
            `Could not load registered module '${name}' (${spec.url}): module has no '${spec.key}' export (named exports: ${Object.keys(mod).join(', ') || '<none>'})`,
          )
          e.name = 'ImportError'
          throw e
        }
        return value
      } catch (raw) {
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

  return {
    async init(p: Policy): Promise<void> {
      policy = p
      urlSpecs.clear()
      urlPromiseCache.clear()
      // Record specs only — no imports fire here. Same `key`
      // convention as workerRuntime's `buildConfigure`: namespace
      // defaults to the whole module (key === undefined); fn / cls
      // default to plucking by the registration name.
      for (const [name, reg] of p.fns) {
        if (reg.url !== undefined) urlSpecs.set(name, { url: reg.url, key: reg.export ?? name })
      }
      for (const [name, reg] of p.namespaces) {
        if (reg.url !== undefined) urlSpecs.set(name, { url: reg.url, key: reg.export })
      }
      for (const [name, reg] of p.classes) {
        if (reg.url !== undefined) urlSpecs.set(name, { url: reg.url, key: reg.export ?? name })
      }
    },

    async execute(code: string, ctx: ExecuteContext): Promise<ExecResult> {
      if (policy === null) {
        throw new Error('evalRuntime: execute() called before init()')
      }

      const outputs: OutputPart[] = []
      const passConsole = opts.passConsole === true

      let outcome: TaskOutcome = { kind: 'continue' }
      // Per-execute "late terminator" slot. Recorded inside the wrapped
      // taskSuccess/Fail/Clarify before the throw, so we still know
      // what the agent meant even when the body has already settled
      // (i.e., the call came from a non-awaited async path). After
      // the body settles, `bodySettled` flips and the wrapped
      // terminators stop throwing — they just record and return.
      // This avoids the unhandled-rejection noise that would
      // otherwise leak from the agent's orphaned promise chain into
      // Node's process-level rejection logging (and into Vitest's
      // unhandled-error tracking in tests).
      let lateTerminator: TaskOutcome | null = null
      let bodySettled = false
      const recordLate = (slot: TaskOutcome): void => {
        if (lateTerminator === null) lateTerminator = slot
      }
      const taskSuccess = (value: unknown): never => {
        recordLate({ kind: 'success', value })
        if (bodySettled) return undefined as never
        throw new TaskFailErrorButForSuccess(value)
      }
      const taskFail = (message: string): never => {
        recordLate({ kind: 'fail', message })
        if (bodySettled) return undefined as never
        throw new TaskFailError(message)
      }
      const taskClarify = (message: string): never => {
        recordLate({ kind: 'clarify', message })
        if (bodySettled) return undefined as never
        throw new TaskClarifyError(message)
      }
      // Build the injected name list. Functions go in directly;
      // namespaces are exposed as objects keyed by member name.
      // `inputs` is the validated task input — stable across every
      // emission of a single task call, accessed via `inputs.field`
      // syntax in the agent code (per the builtin primer).
      // Sync-flip flag for the bodySettled signal. Appended to the
      // agent's code so that any microtask queued during body
      // execution (e.g. an unawaited `generateReport()` whose
      // resumption is already in the microtask queue) sees
      // `bodySettled === true` by the time it gets to call a
      // terminator. Without this, the resumption fires before the
      // outer `await Promise.race` returns, the terminator throws,
      // and we get an unhandled rejection from the orphan chain.
      const __agexBodyDone = (): void => {
        bodySettled = true
      }
      const injected: Record<string, unknown> = {
        taskSuccess,
        taskFail,
        taskClarify,
        cache: ctx.cache,
        // Node-fs-style ergonomic wrapper. The agent can write
        // `await fs.read(path, 'utf8')` to get a string back, or
        // `await fs.write(path, 'hello')` to encode-and-write —
        // matches the conventional Node fs surface they were
        // trained on. Bytes-form still works unchanged.
        fs: wrapAgentFs(ctx.fs),
        // No `console` injection — the global ALS-gated proxy (installed
        // in `evalRuntime()`) captures `console.log` etc. from the
        // AsyncFunction body AND from any registered host fn dispatched
        // on this call chain, all routed via the same `runWithCapture`
        // context below.
        inputs: ctx.inputs,
        // Lazy loader for URL-shipped registrations. The agent's
        // emitted code calls this via the rewriter's
        // `await __load('name')` expansion of
        // `import { ... } from 'name'`. First call per name per
        // runtime lifetime fires the dynamic import; subsequent calls
        // hit the per-name promise cache.
        __load,
        __agexBodyDone,
      }
      const start = performance.now()
      let error: Error | null = null
      const ac = new AbortController()
      // Lazy `HostFnContext` for opt-in host fns. Built on first call
      // — most invocations have no opt-in fns, and even when they do,
      // we'd rather not allocate a Console proxy speculatively.
      let cachedHostCtx: ReturnType<typeof makeHostFnContext> | null = null
      const getHostCtx = (): ReturnType<typeof makeHostFnContext> => {
        if (cachedHostCtx === null) {
          cachedHostCtx = makeHostFnContext({ outputs, signal: ac.signal, passConsole })
        }
        return cachedHostCtx
      }
      // Host-bound registrations inject their live JS reference (or a
      // ctx-appending wrapper, when `wantsContext: true`). URL-shipped
      // names are NOT injected here — the rewriter routes their imports
      // through `__load(name)` (see `urlSpecs` / `__load` above) so the
      // dynamic `import()` only fires on first reference.
      for (const [name, reg] of policy.fns) {
        if (reg.fn === undefined) continue
        if (reg.wantsContext === true) {
          const fn = reg.fn
          injected[name] = (...args: unknown[]) => fn(...args, getHostCtx())
        } else {
          injected[name] = reg.fn
        }
      }
      for (const [name, reg] of policy.namespaces) {
        if (reg.target !== undefined) injected[name] = reg.target
      }
      for (const [name, reg] of policy.classes) {
        if (reg.cls !== undefined) injected[name] = reg.cls
      }
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      const linkedAbort = (): void => ac.abort()
      ctx.signal.addEventListener('abort', linkedAbort)

      try {
        // Strip TS type annotations before AsyncFunction sees the code.
        // ts-blank-space throws on non-erasable TS (enum, namespace,
        // decorators, parameter properties); that surfaces as a normal
        // runtime error so the agent can read the message and adjust.
        const erased = tsBlankSpace(code)
        // Resolve `import { x } from '/helpers/foo'` statements against
        // the agent's VFS, and `import * as foo from 'foo'` against
        // the registered fn / cls / namespace table. Pre-loaded
        // helpers come back via the `__modules` map; registered
        // names are flowed to helpers via `__registered`. The
        // agent's main code uses globals (already in `injected`)
        // so registered-name imports just rebind in main scope.
        // Host-bound registrations flow to helpers via `__registered`
        // (sync map lookup). URL-shipped names are NOT in this map —
        // their imports rewrite to `await __load('name')`, which
        // closes over the eval runtime's lazy loader.
        const registeredValues = new Map<string, unknown>()
        for (const [n, reg] of policy.fns) {
          if (reg.fn !== undefined) registeredValues.set(n, reg.fn)
        }
        for (const [n, reg] of policy.namespaces) {
          if (reg.target !== undefined) registeredValues.set(n, reg.target)
        }
        for (const [n, reg] of policy.classes) {
          if (reg.cls !== undefined) registeredValues.set(n, reg.cls)
        }
        // Pass URL-shipped names + the lazy loader so the rewriter
        // emits `await __load(...)` for these and helpers thread
        // `__load` through their parameter list.
        const urlNames = new Set(urlSpecs.keys())
        const prepared = await prepareScript(erased, ctx.fs, registeredValues, {
          urlNames,
          load: __load,
        })
        injected.__modules = prepared.modules
        const names = Object.keys(injected)
        // Append a sourceURL pragma so AsyncFunction-emitted stack
        // traces refer to "<ts_action>" instead of "<anonymous>".
        // Wrap the body in `try { ... } finally { __agexBodyDone() }`
        // so the bodySettled flag flips on every exit path — fall-
        // through, terminator-throw, top-level `return`, and any
        // unexpected throw. Without the try/finally, a top-level
        // `return` would bypass the flag flip, leaving any later
        // microtask resumption with `bodySettled === false` (which
        // would re-throw a terminator instead of recording it as a
        // missing-await).
        const annotated = `try {\n${prepared.code}\n} finally { __agexBodyDone() }\n//# sourceURL=<ts_action>\n`
        const fn = new AsyncFunction(...names, annotated)

        // Race the user code against the abort signal. The user
        // promise must be created INSIDE `runWithCapture` so the ALS
        // store is bound to its synchronous frames and awaited
        // continuations — and so that any registered host fn invoked
        // from this chain inherits the same store.
        await runWithCapture({ outputs, passConsole }, async () => {
          const userPromise = fn(...names.map((n) => injected[n]))
          const cancellation = new Promise<never>((_, reject) => {
            ac.signal.addEventListener('abort', () =>
              reject(new CancelledError(`evalRuntime: aborted after ${timeoutMs}ms`)),
            )
          })
          await Promise.race([userPromise, cancellation])
        })
        // Promise resolved with no taskSuccess / taskFail / taskClarify —
        // the agent wants another turn.
      } catch (e) {
        if (e instanceof TaskFailErrorButForSuccess) {
          outcome = { kind: 'success', value: e.value }
        } else if (isTaskControlError(e)) {
          if (e.name === 'TaskFailError') outcome = { kind: 'fail', message: e.message }
          else if (e.name === 'TaskClarifyError') outcome = { kind: 'clarify', message: e.message }
          else if (e.name === 'CancelledError') error = e as Error
        } else {
          error = e instanceof Error ? e : new Error(String(e))
        }
      } finally {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', linkedAbort)
      }

      // Late-terminator detection: the AsyncFunction body settled
      // cleanly with no terminator caught synchronously, but the
      // agent may have invoked a terminator from an async path it
      // didn't `await`. The injected `__agexBodyDone()` call at the
      // end of the body has already flipped `bodySettled`, so the
      // wrapped terminators record-without-throwing for any
      // resumption that fires while we drain. Drain bounded so we
      // don't spin forever on a real "agent intentionally fired-and-
      // forgot" case.
      if (outcome.kind === 'continue' && error === null && !ac.signal.aborted) {
        for (let i = 0; i < 16 && lateTerminator === null; i++) {
          await Promise.resolve()
        }
        if (lateTerminator !== null) {
          error = makeMissingAwaitError(lateTerminator)
        }
      }

      return {
        outcome,
        outputs,
        error,
        elapsedMs: performance.now() - start,
      }
    },

    async dispose(): Promise<void> {
      policy = null
    },
  }
}

/**
 * Build the user-facing error surfaced when a terminator was called
 * from an async path the agent didn't `await`. The message names the
 * terminator and prescribes the fix in JS/TS-idiomatic terms — `await`
 * is the standard pattern; `void` is the standard escape hatch for
 * intentional fire-and-forget.
 */
function makeMissingAwaitError(late: TaskOutcome): Error {
  const kind =
    late.kind === 'success'
      ? 'taskSuccess'
      : late.kind === 'fail'
        ? 'taskFail'
        : late.kind === 'clarify'
          ? 'taskClarify'
          : 'task terminator'
  const e = new Error(
    `${kind}() was called from an async function that wasn't awaited at the top level — the terminator fired AFTER ts_action returned, so this turn produced no observable outcome. Add \`await\` before the call (e.g. \`await generateReport()\`) so the terminator unwinds before the action returns. If you genuinely meant to fire-and-forget, prefix the call with \`void\` (the standard JS/TS idiom for intentionally discarding a Promise).`,
  )
  e.name = 'MissingAwaitError'
  return e
}

/** Internal — used to smuggle the success value through the throw
 *  channel so the runtime can route success uniformly with fail/
 *  clarify. Not part of the public error hierarchy. */
class TaskFailErrorButForSuccess extends Error {
  constructor(readonly value: unknown) {
    super('taskSuccess')
    this.name = 'TaskSuccessSignal'
  }
}
