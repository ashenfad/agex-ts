/**
 * Host-realm console capture — browser variant.
 *
 * `node:async_hooks` (and therefore `AsyncLocalStorage`) doesn't exist
 * in browsers / Workers, so the implicit capture path can't work. This
 * module ships:
 *
 * - `installConsoleProxy()` as a no-op (no ALS to gate on).
 * - `runWithCapture(target, fn)` as `fn()` — runs the user code
 *   straight through with no per-call store. Agent-code `console.log`
 *   inside the worker realm continues to capture via the in-Worker
 *   `makeConsole` (which doesn't depend on this module). Host-fn
 *   capture in the host realm requires the registered fn to opt in to
 *   `wantsContext: true` and use `ctx.console` — that path lives
 *   entirely in `makeHostFnContext` and works here.
 * - The full `pushArgs` / `detectImage` / `bytesToBase64` /
 *   `makeHostFnContext` surface unchanged, re-exported from
 *   `console-capture-shared`.
 *
 * Selected via `package.json`'s `"browser"` export condition.
 */

import type { CaptureTarget } from './console-capture-shared'

export * from './console-capture-shared'

export function installConsoleProxy(): void {
  // No-op in browser / Worker hosts. The agent-code in-Worker capture
  // path is independent of this module; host-fn capture requires
  // `wantsContext: true` on the registration.
}

export function runWithCapture<T>(_target: CaptureTarget, fn: () => Promise<T>): Promise<T> {
  return fn()
}
