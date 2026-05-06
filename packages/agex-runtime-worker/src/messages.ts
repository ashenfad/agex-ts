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
 *   - `bridgeCall`     — RPC for `fs.*` / `cache.*` / registered
 *     fn / registered namespace member / static method on a
 *     registered class. The host dispatches the call and replies
 *     with a `bridgeResponse`. Multiple bridge calls may be in
 *     flight concurrently within one emission.
 *   - `newInstance`    — agent code did `new MyClass(...args)` for
 *     a registered class. Host calls the real constructor, parks
 *     the instance in a per-execute table, replies with the
 *     `instanceId` carried by `bridgeResponse.value`.
 *   - `instanceCall`   — method invocation on a previously-created
 *     instance handle. Carries `instanceId` plus the method name.
 *     Host looks up the live instance and calls the method against
 *     it; reply is a normal `bridgeResponse`.
 *   - `result`         — terminal message for an `execute` call.
 *     Carries the resolved `TaskOutcome` (success / fail / clarify
 *     / continue) plus an optional unexpected error (parse
 *     failure, uncaught exception that wasn't a task-control raise).
 *
 *  Per-emission instance lifecycle: every instance the host parks
 *  during one `execute` is released when that execute settles. The
 *  agent's "fresh slate per turn" model means there's no need for
 *  WeakRef-based cleanup or cross-emission identity. If the embedder
 *  wants persistent state, that's `cache`.
 *
 *  Importmap-based URL-shipped registrations (subclassable, no RPC
 *  for method calls) land in a follow-up PR. They'll add their own
 *  field to `configure` and a worker-side dynamic-import path; the
 *  RPC variants here keep working unchanged.
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
 *   - `namespace` — a registered namespace
 *     (`agent.namespace(name, target)`). `subject` is the namespace
 *     name, `method` is the visible member.
 *   - `cls` — a static method on a registered class. `subject` is
 *     the class name, `method` is the visible static-member name.
 *     Instance method calls use `instanceCall` instead.
 */
export type BridgeTarget = 'fs' | 'cache' | 'fn' | 'namespace' | 'cls'

/** Sent once after the worker reports `ready`, before the first
 *  `execute`. Tells the worker which registered names exist so it
 *  can build the matching stubs in the per-execute injected scope.
 *  Re-sent on respawn (timeout / abort kills the worker), which is
 *  fine — the policy is fixed for the runtime's lifetime. */
export interface ConfigureMessage {
  readonly type: 'configure'
  /** Names registered via `agent.fn(...)`. */
  readonly fns: ReadonlyArray<string>
  /** Registered namespaces and the visible (post-include/exclude)
   *  function-member names per namespace. */
  readonly namespaces: ReadonlyArray<{
    readonly name: string
    readonly members: ReadonlyArray<string>
  }>
  /** Registered classes plus the visible instance-method names
   *  (collected from the prototype chain, post-include/exclude) and
   *  the visible static-method names (own properties of the class
   *  itself, post-include/exclude). The same filter applies to
   *  both lists — host-side `agent.cls(...)` policy doesn't
   *  distinguish them today. Static *data* properties aren't
   *  bridged in this PR; the agent sees only callable statics. */
  readonly classes: ReadonlyArray<{
    readonly name: string
    readonly instanceMethods: ReadonlyArray<string>
    readonly staticMethods: ReadonlyArray<string>
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
       *  multiple distinct surfaces — used for `target: 'namespace'`
       *  (carries the namespace name) and `target: 'cls'` (carries
       *  the class name). Unused (and ignored) for `fs` / `cache` /
       *  `fn`. */
      readonly subject?: string
      /** What to invoke. For `fs` / `cache`: the method name on
       *  that surface. For `fn`: the registered function name. For
       *  `namespace`: the visible member name on the namespace
       *  identified by `subject`. For `cls`: the visible static
       *  member name. The host re-validates against the allowlist
       *  established at configure time, so a typo / hostile worker
       *  can't reach prototype-chain methods or unregistered names. */
      readonly method: string
      /** Positional args. Must structured-clone (Uint8Array / string
       *  / plain object / undefined are typical). */
      readonly args: ReadonlyArray<unknown>
    }
  | {
      /** Agent code did `new MyClass(...args)`. Host constructs a
       *  real instance via the registered class, parks it in the
       *  per-execute instance table, replies with the assigned
       *  `instanceId` as `bridgeResponse.value: { instanceId }`. */
      readonly type: 'newInstance'
      readonly executeId: number
      readonly callId: number
      readonly clsName: string
      readonly args: ReadonlyArray<unknown>
    }
  | {
      /** Method call on a previously-constructed instance handle.
       *  Host looks up `instanceId` in the per-execute instance
       *  table and calls `method(...args)` against the live
       *  instance. Reply is a normal `bridgeResponse`. */
      readonly type: 'instanceCall'
      readonly executeId: number
      readonly callId: number
      readonly instanceId: number
      readonly method: string
      readonly args: ReadonlyArray<unknown>
    }
  | {
      readonly type: 'result'
      readonly executeId: number
      readonly outcome: TaskOutcome
      readonly error: SerializedError | null
    }
