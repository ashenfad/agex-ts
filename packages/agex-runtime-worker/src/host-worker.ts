/**
 * Host-side worker transport seam.
 *
 * Abstracts the platform differences between a browser `Worker` and a
 * Node `worker_threads.Worker` so `runtime.ts` stays platform-agnostic.
 * The two differ in three places this seam papers over:
 *
 *   - **construction** — `new Worker(url, { type: 'module' })` vs
 *     `new (await import('node:worker_threads')).Worker(url)`.
 *   - **listeners** — `addEventListener` / `removeEventListener` with the
 *     payload wrapped in `MessageEvent.data` vs `.on` / `.off` with the
 *     value delivered directly. Node also splits failures across
 *     `'error'` and `'messageerror'`.
 *   - **errors** — the browser hands you an `ErrorEvent` (`.message`),
 *     Node an `Error`.
 */
import type { Host2WorkerMessage, Worker2HostMessage } from './messages'

/** A resolved worker target (never `'auto'`). */
export type ResolvedTarget = 'browser' | 'node'

/** Platform-neutral handle over a spawned worker. `runtime.ts` talks only
 *  to this — never to `Worker` / `worker_threads` directly. */
export interface WorkerHandle {
  /** Post a host→worker message (`configure` is part of this union). */
  postMessage(msg: Host2WorkerMessage): void
  /** Hard-terminate the worker. Idempotent at the call site. */
  terminate(): void
  /** Subscribe to worker→host messages. Returns an unsubscribe fn. */
  addMessageListener(cb: (msg: Worker2HostMessage) => void): () => void
  /** Subscribe to fatal worker errors (boot failure, uncaught throw,
   *  message deserialization failure). Returns an unsubscribe fn. */
  addErrorListener(cb: (err: { message: string }) => void): () => void
}

/** Auto-detect the worker target. Node's main thread exposes `process`
 *  but no global `Worker`; browsers and Web Workers expose a global
 *  `Worker`. The combined check avoids a false 'node' in exotic setups
 *  that polyfill `process` in the browser. */
export function detectTarget(): ResolvedTarget {
  const g = globalThis as { process?: { versions?: { node?: string } }; Worker?: unknown }
  const isNode = g.process?.versions?.node !== undefined
  if (isNode && typeof g.Worker === 'undefined') return 'node'
  return 'browser'
}

/** Construct a worker for the given target. Async because the Node path
 *  dynamic-imports `node:worker_threads` (keeping that builtin out of a
 *  browser bundle's static import graph — it's only reached when the
 *  target resolved to 'node'). */
export async function createWorkerHandle(
  url: string | URL,
  target: ResolvedTarget,
): Promise<WorkerHandle> {
  return target === 'node' ? createNodeHandle(url) : createBrowserHandle(url)
}

function createBrowserHandle(url: string | URL): WorkerHandle {
  const w = new Worker(url, { type: 'module' })
  return {
    postMessage: (msg) => w.postMessage(msg),
    terminate: () => w.terminate(),
    addMessageListener: (cb) => {
      const h = (ev: MessageEvent<Worker2HostMessage>): void => cb(ev.data)
      w.addEventListener('message', h)
      return () => w.removeEventListener('message', h)
    },
    addErrorListener: (cb) => {
      const h = (ev: ErrorEvent): void => cb({ message: ev.message })
      w.addEventListener('error', h)
      return () => w.removeEventListener('error', h)
    },
  }
}

async function createNodeHandle(url: string | URL): Promise<WorkerHandle> {
  const { Worker } = await import('node:worker_threads')
  const w = new Worker(url)
  return {
    postMessage: (msg) => w.postMessage(msg),
    terminate: () => {
      void w.terminate()
    },
    addMessageListener: (cb) => {
      const h = (value: Worker2HostMessage): void => cb(value)
      w.on('message', h)
      return () => {
        w.off('message', h)
      }
    },
    addErrorListener: (cb) => {
      const onError = (err: Error): void => cb({ message: err.message })
      const onMessageError = (err: Error): void =>
        cb({ message: `worker message deserialization failed: ${err.message}` })
      w.on('error', onError)
      w.on('messageerror', onMessageError)
      return () => {
        w.off('error', onError)
        w.off('messageerror', onMessageError)
      }
    },
  }
}
