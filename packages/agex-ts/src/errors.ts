/**
 * Error hierarchy for agex-ts.
 *
 * Two flavors:
 *
 * 1. **Task-control errors** (`TaskFailError`, `TaskClarifyError`) are
 *    thrown from inside a `ts` emission by the agent's call to the
 *    injected `taskFail()` / `taskClarify()`. They carry a brand
 *    symbol so the runtime adapter can recognize them across realms
 *    (a worker can't share `instanceof` with the host, but it can
 *    inspect a property tag).
 *
 * 2. **Framework errors** (`AgentError` and its subclasses) are
 *    thrown by agex-ts itself — registration violations, runtime
 *    transport failures, schema mismatches. Provider/runtime errors
 *    classify as `TransientError` (retry candidate) or `FatalError`
 *    (reraise immediately).
 */

/** Brand symbol identifying task-control errors across realms. */
export const TASK_CONTROL_BRAND = '__agex_task_control__'

export interface BrandedTaskError extends Error {
  readonly [TASK_CONTROL_BRAND]: 'fail' | 'clarify' | 'cancelled'
}

/** Returns true if `e` is a task-control error from any realm. */
export function isTaskControlError(e: unknown): e is BrandedTaskError {
  return (
    typeof e === 'object' &&
    e !== null &&
    TASK_CONTROL_BRAND in e &&
    typeof (e as Record<string, unknown>)[TASK_CONTROL_BRAND] === 'string'
  )
}

/** Thrown by `taskFail(message)` inside a `ts` emission. */
export class TaskFailError extends Error {
  readonly [TASK_CONTROL_BRAND] = 'fail' as const
  constructor(message: string) {
    super(message)
    this.name = 'TaskFailError'
  }
}

/** Thrown by `taskClarify(message)` inside a `ts` emission. */
export class TaskClarifyError extends Error {
  readonly [TASK_CONTROL_BRAND] = 'clarify' as const
  constructor(message: string) {
    super(message)
    this.name = 'TaskClarifyError'
  }
}

/** Raised when a task is aborted via the host `AbortSignal`. */
export class CancelledError extends Error {
  readonly [TASK_CONTROL_BRAND] = 'cancelled' as const
  constructor(message = 'Task cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}

/** Base for framework-internal errors. */
export class AgentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentError'
  }
}

/** Validation failed on registration input (bad include/exclude pattern,
 *  missing required field, conflicting names, etc.). */
export class RegistrationError extends AgentError {
  constructor(message: string) {
    super(message)
    this.name = 'RegistrationError'
  }
}

/** Schema validation failed on a task input or output. */
export class SchemaError extends AgentError {
  constructor(
    message: string,
    readonly issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
  ) {
    super(message)
    this.name = 'SchemaError'
  }
}

/** Provider/runtime error worth retrying (timeouts, rate limits,
 *  transient network failures). The agent loop reads the optional
 *  `retryAfterMs` hint when scheduling retry. */
export class TransientError extends AgentError {
  readonly retryAfterMs?: number
  constructor(message: string, opts: { cause?: unknown; retryAfterMs?: number } = {}) {
    super(message)
    this.name = 'TransientError'
    if (opts.cause !== undefined) this.cause = opts.cause
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
  }
}

/** Provider/runtime error that should be reraised, not retried
 *  (4xx, parse errors, configuration errors). */
export class FatalError extends AgentError {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message)
    this.name = 'FatalError'
    if (opts.cause !== undefined) this.cause = opts.cause
  }
}
