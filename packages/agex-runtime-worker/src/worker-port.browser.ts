/**
 * Browser `WorkerPort` — wires the worker core to the Web Worker global
 * scope (`self`). Used by the `worker.ts` entry, built to `worker.js`.
 */
import type { Host2WorkerMessage, Worker2HostMessage } from './messages'
import type { WorkerPort } from './worker-port'

/** Raw `import(url)` indirection that bypasses bundler-side dynamic-import
 *  wrapping (notably Vite's `wrapDynamicImport`, which assumes a
 *  main-thread runtime that doesn't exist inside a Worker). The
 *  `new Function` form keeps the call site opaque to static analysis;
 *  the result is the native `import()` exactly as the engine implements
 *  it. Constructed once — the Function constructor cost is paid at boot. */
const rawImport = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>

export function createBrowserPort(): WorkerPort {
  const scope = self as unknown as DedicatedWorkerGlobalScope
  return {
    post: (msg: Worker2HostMessage): void => scope.postMessage(msg),
    onMessage: (cb): void => {
      scope.addEventListener('message', (ev: MessageEvent<Host2WorkerMessage>) => cb(ev.data))
    },
    onUnhandledRejection: (shouldSuppress): (() => void) => {
      const handler = (ev: PromiseRejectionEvent): void => {
        if (shouldSuppress(ev.reason)) ev.preventDefault()
      }
      scope.addEventListener('unhandledrejection', handler)
      return () => scope.removeEventListener('unhandledrejection', handler)
    },
    loadModule: (url): Promise<unknown> => rawImport(url),
  }
}
