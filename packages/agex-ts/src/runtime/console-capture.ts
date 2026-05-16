/**
 * Host-realm console capture — Node variant.
 *
 * Two channels share the same `OutputPart` pipeline:
 *
 * 1. **Implicit (ALS-gated global proxy):** `installConsoleProxy()`
 *    swaps `globalThis.console` once for a Proxy that reads its capture
 *    target from `AsyncLocalStorage`. Inside `runWithCapture(target,
 *    fn)`, every `console.log` / `.warn` / `.error` / `.info` anywhere
 *    in the host process — agent code, registered host fns, helper
 *    libraries — pushes into `target.outputs`. Outside any active ALS
 *    context, calls fall through to the original real console.
 *
 * 2. **Explicit (per-fn `ctx.console`):** `makeHostFnContext({outputs,
 *    signal})` builds a `HostFnContext` whose `.console` closes over
 *    the outputs array directly (no ALS). Used by registered host fns
 *    that opt in via `wantsContext: true` — required when the host
 *    realm is a browser (no `node:async_hooks`), useful elsewhere when
 *    the embedder wants the explicit channel.
 *
 * The realm-agnostic surface — `detectImage`, `pushArgs`,
 * `bytesToBase64`, `makeHostFnContext`, etc. — lives in
 * `console-capture-shared` and is re-exported below.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  type CaptureTarget,
  pushArgs,
  realConsole,
  reflectBoundToReal,
} from './console-capture-shared'

export * from './console-capture-shared'

const als = new AsyncLocalStorage<CaptureTarget>()

let installed = false

/** Install the global console proxy. Idempotent — calling repeatedly is
 *  a no-op after the first install. */
export function installConsoleProxy(): void {
  if (installed) return
  installed = true
  globalThis.console = new Proxy(realConsole, {
    get(target, prop, receiver) {
      if (prop === 'log' || prop === 'warn' || prop === 'error' || prop === 'info') {
        const level = prop as 'log' | 'warn' | 'error' | 'info'
        return (...args: unknown[]) => {
          const t = als.getStore()
          if (t !== undefined) {
            pushArgs(t, level, args)
            if (t.passConsole) (target as unknown as Console)[level](...args)
          } else {
            ;(target as unknown as Console)[level](...args)
          }
        }
      }
      return reflectBoundToReal(target, prop, receiver)
    },
  })
}

/** Run `fn` with `target` bound as the active capture target. Any
 *  `console.log` (etc.) on the proxy that fires synchronously, in an
 *  awaited continuation, or through a registered host fn called from
 *  this chain pushes into `target.outputs`. */
export function runWithCapture<T>(target: CaptureTarget, fn: () => Promise<T>): Promise<T> {
  return als.run(target, fn)
}
