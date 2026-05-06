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
 * Cooperative cancellation is a follow-up. PR 1 only does the
 * hard-terminate path, which is enough to honor wall-clock budgets
 * and external aborts.
 */

import { CancelledError } from 'agex-ts/errors'
import type {
  ExecResult,
  ExecuteContext,
  OutputPart,
  Policy,
  RuntimeAdapter,
  TaskOutcome,
} from 'agex-ts/types'
import type { Host2WorkerMessage, SerializedError, Worker2HostMessage } from './messages'
import { type TransformFn, defaultTransform } from './transform'

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

  function spawn(): void {
    const w = new Worker(workerUrl, { type: 'module' })
    worker = w
    readyPromise = new Promise<void>((resolve, reject) => {
      const onMsg = (ev: MessageEvent<Worker2HostMessage>): void => {
        if (ev.data?.type === 'ready') {
          w.removeEventListener('message', onMsg)
          w.removeEventListener('error', onErr)
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
    async init(_policy: Policy): Promise<void> {
      // Policy is intentionally unused in PR 1 — module-resolution
      // and the registered-fns / namespace-proxy bridges land in
      // follow-up PRs. Keeping init() in the contract so the agent
      // loop's existing call site doesn't change.
      void _policy
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
