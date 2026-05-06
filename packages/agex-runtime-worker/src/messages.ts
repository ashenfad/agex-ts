/**
 * Wire protocol for the host ⇄ worker boundary.
 *
 * Every payload here MUST structured-clone (no functions, no
 * closures, no class instances with private state). This is enforced
 * by the runtime — Workers throw `DataCloneError` on
 * non-cloneable values. The bridge response path catches host-side
 * clone failures and re-emits them as serialized errors so the
 * worker doesn't hang on a value the channel can't carry.
 *
 * Host → worker:
 *   - `execute`         — kick off one emission. The host has
 *     already run the configured `transform` over the code
 *     (default: `ts-blank-space`), so the worker receives plain
 *     JavaScript ready for `new AsyncFunction(...)`.
 *   - `bridgeResponse`  — reply to an earlier `bridgeCall` from the
 *     worker. Carries the resolved value (cloneable) or a
 *     serialized error.
 *
 * Worker → host:
 *   - `ready`        — sent once at module top, after the worker
 *     scope has set up its message listener. The host awaits this
 *     before posting any `execute`.
 *   - `output`       — captured `console.*` (and `viewImage(...)`)
 *     becomes one or more `OutputPart`s. Streamed live so the
 *     parent agent loop can forward through `onEvent` while the
 *     emission is still running.
 *   - `bridgeCall`   — RPC for `fs.*` / `cache.*` calls made by
 *     agent code. The host dispatches the call against the live
 *     `ExecuteContext.fs` / `ExecuteContext.cache` and replies with
 *     a `bridgeResponse`. Multiple bridge calls may be in flight
 *     concurrently within a single emission (the worker awaits
 *     them through the `callId` map).
 *   - `result`       — terminal message for an `execute` call.
 *     Carries the resolved `TaskOutcome` (success / fail / clarify
 *     / continue) plus an optional unexpected error (parse
 *     failure, uncaught exception that wasn't a task-control raise).
 *
 *  Bridges for registered classes (`agent.cls`) + live namespaces
 *  share an instance-handle protocol that lands in the next PR;
 *  importmap-based module policy is the PR after that.
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

/** Which surface a `bridgeCall` targets.
 *
 *   - `fs` / `cache` — the per-execute `ExecuteContext` surfaces.
 *   - `fn` — a registered host function (`agent.fn(name, ...)`).
 *     `method` carries the registered name; `subject` is unused.
 *   - `namespace` — a registered non-live namespace
 *     (`agent.namespace(name, target)`). `subject` is the namespace
 *     name, `method` is the visible member.
 *
 *  Live namespaces (`live: true`) and registered classes
 *  (`agent.cls`) get an instance-handle protocol in the next PR;
 *  they aren't represented here yet. */
export type BridgeTarget = 'fs' | 'cache' | 'fn' | 'namespace'

/** Sent once after the worker reports `ready`, before the first
 *  `execute`. Tells the worker which registered names exist so it
 *  can build the matching stubs in the per-execute injected scope.
 *  Re-sent on respawn (timeout / abort kills the worker), which is
 *  fine — the policy is fixed for the runtime's lifetime. */
export interface ConfigureMessage {
  readonly type: 'configure'
  /** Names registered via `agent.fn(...)`. */
  readonly fns: ReadonlyArray<string>
  /** Non-live namespaces and the visible (post-include/exclude)
   *  function-member names per namespace. */
  readonly namespaces: ReadonlyArray<{
    readonly name: string
    readonly members: ReadonlyArray<string>
  }>
}

export type Host2WorkerMessage =
  | ConfigureMessage
  | {
      readonly type: 'execute'
      /** Already-transformed JavaScript (TS types stripped on the
       *  host side via the configured `transform` hook). */
      readonly code: string
      /** Echoed back on the matching `result` so the host can
       *  correlate even if `execute` calls overlap (currently they
       *  don't — one outstanding execute at a time — but the field
       *  future-proofs the protocol). */
      readonly executeId: number
      /** Optional, threaded through for diagnostic logs. */
      readonly emissionId?: string
    }
  | {
      readonly type: 'bridgeResponse'
      readonly executeId: number
      readonly callId: number
      readonly ok: true
      /** Whatever the host method returned. Must structured-clone. */
      readonly value: unknown
    }
  | {
      readonly type: 'bridgeResponse'
      readonly executeId: number
      readonly callId: number
      readonly ok: false
      readonly error: SerializedError
    }

export type Worker2HostMessage =
  | { readonly type: 'ready' }
  | {
      readonly type: 'output'
      readonly executeId: number
      readonly part: OutputPart
    }
  | {
      readonly type: 'bridgeCall'
      readonly executeId: number
      readonly callId: number
      readonly target: BridgeTarget
      /** Identifies the dispatch root when one bridge target hosts
       *  multiple distinct surfaces — only used for `target:
       *  'namespace'`, where it carries the namespace name. Unused
       *  (and ignored) for `fs` / `cache` / `fn`. */
      readonly subject?: string
      /** What to invoke. For `fs` / `cache`: the method name on
       *  that surface. For `fn`: the registered function name. For
       *  `namespace`: the visible member name on the namespace
       *  identified by `subject`. The host re-validates against
       *  the allowlist established at configure time, so a typo /
       *  hostile worker can't reach prototype-chain methods or
       *  unregistered names. */
      readonly method: string
      /** Positional args. Must structured-clone (Uint8Array / string
       *  / plain object / undefined are typical). */
      readonly args: ReadonlyArray<unknown>
    }
  | {
      readonly type: 'result'
      readonly executeId: number
      readonly outcome: TaskOutcome
      readonly error: SerializedError | null
    }
