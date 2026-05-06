/**
 * Wire protocol for the host ⇄ worker boundary.
 *
 * Every payload here MUST structured-clone (no functions, no
 * closures, no class instances with private state). This is enforced
 * by the runtime — Workers throw `DataCloneError` on
 * non-cloneable values.
 *
 * Host → worker:
 *   - `execute` — kick off one emission. The host has already run
 *     the configured `transform` over the code (default:
 *     `ts-blank-space`), so the worker receives plain JavaScript
 *     ready for `new AsyncFunction(...)`.
 *
 * Worker → host:
 *   - `ready`   — sent once at module top, after the worker scope
 *     has set up its message listener. The host awaits this before
 *     posting any `execute`.
 *   - `output`  — captured `console.*` (and, later, `viewImage(...)`)
 *     becomes one or more `OutputPart`s. Streamed live so the
 *     parent agent loop can forward through `onEvent` while the
 *     emission is still running.
 *   - `result`  — terminal message for an `execute` call. Carries
 *     the resolved `TaskOutcome` (success / fail / clarify /
 *     continue) plus an optional unexpected error (parse failure,
 *     uncaught exception that wasn't a task-control raise).
 *
 *  PR 1 ships the bare execute / output / result loop. Bridges for
 *  `fs`, `cache`, registered functions, and namespace proxies are
 *  follow-up PRs and add their own message variants here without
 *  changing the existing ones.
 */

import type { OutputPart, TaskOutcome } from 'agex-ts/types'

/** Serialized form of a host `Error` (the original isn't structured-cloneable
 *  with full fidelity across realms — `name` and `message` survive, the
 *  prototype chain doesn't). */
export interface SerializedError {
  readonly name: string
  readonly message: string
  readonly stack?: string
}

export type Host2WorkerMessage = {
  readonly type: 'execute'
  /** Already-transformed JavaScript (TS types stripped on the host
   *  side via the configured `transform` hook). */
  readonly code: string
  /** Echoed back on the matching `result` so the host can correlate
   *  even if `execute` calls overlap (currently they don't — one
   *  outstanding execute at a time — but the field future-proofs
   *  the protocol). */
  readonly executeId: number
  /** Optional, threaded through for diagnostic logs. */
  readonly emissionId?: string
}

export type Worker2HostMessage =
  | { readonly type: 'ready' }
  | {
      readonly type: 'output'
      readonly executeId: number
      readonly part: OutputPart
    }
  | {
      readonly type: 'result'
      readonly executeId: number
      readonly outcome: TaskOutcome
      readonly error: SerializedError | null
    }
