/**
 * `evalRuntime` — same-realm `RuntimeAdapter` used by tests and by
 * embedders that explicitly opt out of worker isolation.
 *
 * What it does:
 * - Evaluates the emitted code via `new AsyncFunction(...)` so the
 *   code can use `await` and the injected names land directly in
 *   scope (no `with` block needed).
 * - Injects the active policy's `fns` and `namespaces` as
 *   identifiers — same as the worker runtime would expose, just
 *   without the message-passing layer.
 * - Injects `taskSuccess`, `taskFail`, `taskClarify`, `cache`, `fs`
 *   and `viewImage` per `design.md` §4.
 * - Captures `console.log` / `.error` calls into the result's
 *   `outputs` array.
 *
 * What it explicitly does NOT do:
 * - No TypeScript transpilation. Emit raw JS or use a runtime that
 *   ships esbuild (e.g. `@agex-ts/runtime-worker`).
 * - No sandboxing. The code runs in the host realm with full access
 *   to the surrounding closures. Use this for tests or for trusted
 *   embedders only.
 * - No tick limit. Wall-clock `timeoutMs` is the only enforcement.
 */

import { CancelledError, TaskClarifyError, TaskFailError, isTaskControlError } from '../errors'
import type {
  ExecResult,
  ExecuteContext,
  OutputPart,
  Policy,
  RuntimeAdapter,
  TaskOutcome,
} from '../types'
import { safeStringifyArgs } from './safe-stringify'

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
  let policy: Policy | null = null
  const timeoutMs = opts.timeoutMs ?? 5000

  return {
    async init(p: Policy): Promise<void> {
      policy = p
    },

    async execute(code: string, ctx: ExecuteContext): Promise<ExecResult> {
      if (policy === null) {
        throw new Error('evalRuntime: execute() called before init()')
      }

      const outputs: OutputPart[] = []
      const captureConsole = makeConsoleCapture(outputs, opts.passConsole === true)

      let outcome: TaskOutcome = { kind: 'continue' }
      const taskSuccess = (value: unknown): never => {
        throw new TaskFailErrorButForSuccess(value)
      }
      const taskFail = (message: string): never => {
        throw new TaskFailError(message)
      }
      const taskClarify = (message: string): never => {
        throw new TaskClarifyError(message)
      }
      const viewImage = (image: { format: 'png' | 'jpeg' | 'webp'; data: string }): void => {
        outputs.push({ type: 'image', ...image })
      }

      // Build the injected name list. Functions go in directly;
      // namespaces are exposed as objects keyed by member name.
      // `inputs` is the validated task input (per design.md and the
      // builtin primer) — stable across every emission of a single
      // task call, accessed via `inputs.field` syntax in the agent
      // code.
      const injected: Record<string, unknown> = {
        taskSuccess,
        taskFail,
        taskClarify,
        viewImage,
        cache: ctx.cache,
        fs: ctx.fs,
        console: captureConsole,
        inputs: ctx.inputs,
      }
      for (const [name, reg] of policy.fns) injected[name] = reg.fn
      for (const [name, reg] of policy.namespaces) injected[name] = reg.target
      // Classes are exposed as constructors at their registered name.
      for (const [name, reg] of policy.classes) injected[name] = reg.cls

      const start = performance.now()
      let error: Error | null = null
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      const linkedAbort = (): void => ac.abort()
      ctx.signal.addEventListener('abort', linkedAbort)

      try {
        const names = Object.keys(injected)
        const fn = new AsyncFunction(...names, code)
        const userPromise = fn(...names.map((n) => injected[n]))

        // Race the user code against the abort signal.
        const cancellation = new Promise<never>((_, reject) => {
          ac.signal.addEventListener('abort', () =>
            reject(new CancelledError(`evalRuntime: aborted after ${timeoutMs}ms`)),
          )
        })

        await Promise.race([userPromise, cancellation])
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

/** Internal — used to smuggle the success value through the throw
 *  channel so the runtime can route success uniformly with fail/
 *  clarify. Not part of the public error hierarchy. */
class TaskFailErrorButForSuccess extends Error {
  constructor(readonly value: unknown) {
    super('taskSuccess')
    this.name = 'TaskSuccessSignal'
  }
}

function makeConsoleCapture(outputs: OutputPart[], passConsole: boolean): Console {
  const capture =
    (level: 'log' | 'error' | 'warn' | 'info') =>
    (...args: unknown[]) => {
      // safeStringifyArgs handles Error / BigInt / Symbol / undefined /
      // circular refs without throwing, and per-arg char-budgets the
      // output so a single huge value can't blow out the agent's
      // context. See src/runtime/safe-stringify.ts.
      const text = safeStringifyArgs(args)
      outputs.push({ type: 'text', text })
      if (passConsole) console[level](...args)
    }
  // We only mirror the most common methods; rare ones fall back to host
  // console. The proxy keeps the shape Console-like so user code that
  // does feature checks (`if (console.table) ...`) doesn't crash.
  return new Proxy(console as unknown as Console, {
    get(target, prop) {
      if (prop === 'log') return capture('log')
      if (prop === 'error') return capture('error')
      if (prop === 'warn') return capture('warn')
      if (prop === 'info') return capture('info')
      return Reflect.get(target, prop)
    },
  })
}
