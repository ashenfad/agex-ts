/**
 * Web Worker entrypoint.
 *
 * Runs a single `ts` emission per `execute` message:
 *
 *   1. Wrap the (already host-transformed) JavaScript in
 *      `new AsyncFunction(...)` so it can use `await` and the
 *      injected names land directly in scope. Same shape as
 *      `evalRuntime`, just inside a Worker realm.
 *   2. Inject the v1-minimum surface: `taskSuccess`, `taskFail`,
 *      `taskClarify`, `viewImage`, plus a captured `console`. PR 1
 *      does not bridge `fs`, `cache`, `inputs`, or registered
 *      fns / namespaces — those are explicit follow-up PRs and
 *      simply aren't in scope yet.
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
import type { Host2WorkerMessage, SerializedError, Worker2HostMessage } from './messages'

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

async function handleExecute(msg: Host2WorkerMessage): Promise<void> {
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

  const injected: Record<string, unknown> = {
    taskSuccess,
    taskFail,
    taskClarify,
    viewImage: viewImageFor(executeId),
    console: makeConsole(executeId),
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
  post({ type: 'result', executeId, outcome, error })
}

self.addEventListener('message', (ev: MessageEvent<Host2WorkerMessage>) => {
  const msg = ev.data
  if (msg?.type === 'execute') {
    void handleExecute(msg)
  }
})

post({ type: 'ready' })
