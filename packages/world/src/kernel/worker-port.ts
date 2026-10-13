/**
 * The worker's side of the platform seam. The kernel's worker code
 * never names `self` or `parentPort`; an entry (`worker.ts` for a
 * browser Web Worker, `worker.node.ts` for Node's `worker_threads`)
 * hands it one of these.
 */
import type { Host2Worker, Worker2Host } from './messages'

export interface WorkerPort {
  /** Send a message to the host. */
  post(msg: Worker2Host): void
  /** Register the one message handler. Called once, at boot. */
  onMessage(cb: (msg: Host2Worker) => void): void
  /**
   * Import a module by URL. A browser imports any ESM URL, remote ones
   * included; Node imports `data:`, `file:` and local specifiers and
   * refuses `http(s):` with a clear error.
   */
  loadModule(url: string): Promise<unknown>
}

/** `import(url)` behind `new Function`, so a bundler doesn't rewrite
 *  the dynamic import for a main-thread runtime the worker lacks. */
export const rawImport = new Function('url', 'return import(url)') as (
  url: string,
) => Promise<unknown>
