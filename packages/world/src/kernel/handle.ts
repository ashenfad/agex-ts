/**
 * Host-side worker transport seam.
 *
 * Abstracts the platform differences between a browser `Worker` and a
 * Node `worker_threads.Worker` so the kernel stays platform-agnostic.
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
 *
 * A browser refuses a module worker whose script is cross-origin to the
 * page (a world loaded from a CDN), so such a worker starts from a
 * same-origin `blob:` module that imports the script.
 */
import type { Host2Worker, Worker2Host } from './messages'

/** A resolved worker target (never `'auto'`). */
export type ResolvedTarget = 'browser' | 'node'

/** Platform-neutral handle over a spawned worker. The kernel talks only
 *  to this — never to `Worker` / `worker_threads` directly. */
export interface WorkerHandle {
  /** Post a message to the worker. */
  postMessage(msg: Host2Worker): void
  /** Hard-terminate the worker. Idempotent at the call site. */
  terminate(): void
  /** Subscribe to worker→host messages. Returns an unsubscribe fn. */
  addMessageListener(cb: (msg: Worker2Host) => void): () => void
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

/** The page a browser worker starts from: its address, which a
 *  relative worker URL resolves against, and its origin. */
export interface WorkerPage {
  readonly href: string
  readonly origin: string
}

/**
 * The absolute address of a worker script the page can't start directly:
 * an http(s) URL of another origin than the page's (an opaque origin,
 * `'null'`, matches none). Null when the worker starts from `url` as
 * given: a same-origin, `blob:` or `data:` URL, or no page to compare
 * with.
 */
export function crossOriginScript(url: string | URL, page: WorkerPage | undefined): string | null {
  if (page === undefined) return null
  let resolved: URL
  try {
    resolved = new URL(url, page.href)
  } catch {
    return null
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null
  return resolved.origin === page.origin ? null : resolved.href
}

function createBrowserHandle(url: string | URL): WorkerHandle {
  const page = (globalThis as { location?: WorkerPage }).location
  const script = crossOriginScript(url, page)
  const shim =
    script === null
      ? null
      : URL.createObjectURL(
          new Blob([`import ${JSON.stringify(script)}\n`], { type: 'text/javascript' }),
        )
  const w = new Worker(shim ?? url, { type: 'module' })
  // The shim's address is let go once the worker has answered or failed
  // (by then its module graph is fetched), or when it's terminated.
  let held = shim
  const revoke = (): void => {
    if (held === null) return
    URL.revokeObjectURL(held)
    held = null
    w.removeEventListener('message', revoke)
    w.removeEventListener('error', revoke)
  }
  if (held !== null) {
    w.addEventListener('message', revoke)
    w.addEventListener('error', revoke)
  }
  return {
    postMessage: (msg) => w.postMessage(msg),
    terminate: () => {
      w.terminate()
      revoke()
    },
    addMessageListener: (cb) => {
      const h = (ev: MessageEvent<Worker2Host>): void => cb(ev.data)
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
      const h = (value: Worker2Host): void => cb(value)
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
