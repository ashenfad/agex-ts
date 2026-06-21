/**
 * Worker-side platform seam.
 *
 * `worker-core.ts` holds all the agent-execution logic and is
 * platform-agnostic — it never names `self` or `parentPort`. Instead it
 * talks to a `WorkerPort`, supplied at boot by whichever entry wired it
 * up (`worker.ts` for the browser `self`, `worker.node.ts` for Node's
 * `parentPort`). Three things actually differ between the two runtimes:
 *
 *   - **message transport** — `self.postMessage` / `addEventListener`
 *     vs `parentPort.postMessage` / `.on`, and the browser's
 *     `MessageEvent.data` wrapper vs Node's directly-delivered value.
 *   - **unhandled-rejection suppression** — the browser needs an
 *     explicit `event.preventDefault()`; Node suppresses the default
 *     the moment a listener exists.
 *   - **dynamic module import** — the browser can `import()` any
 *     ESM-resolvable URL (incl. remote `https:`); Node can't import
 *     remote URLs and reports a clear error instead.
 */
import type { Host2WorkerMessage, Worker2HostMessage } from './messages'

export interface WorkerPort {
  /** Send a message to the host. */
  post(msg: Worker2HostMessage): void
  /** Register the single boot-time message handler. Called once. */
  onMessage(cb: (msg: Host2WorkerMessage) => void): void
  /**
   * Install an unhandled-rejection suppressor for the duration of the
   * late-terminator drain window. `shouldSuppress(reason)` returns true
   * for the worker's own task-control signals (which the drain handles
   * deliberately) so their orphan rejections don't print realm noise.
   * Returns an unsubscribe function.
   */
  onUnhandledRejection(shouldSuppress: (reason: unknown) => boolean): () => void
  /**
   * Dynamic-import a module by URL for URL-shipped registrations.
   * Browser: native `import()` of any ESM-resolvable URL. Node: native
   * `import()` of `data:` / `file:` / local specifiers; remote
   * `http(s):` URLs throw a clear "browser-only" error (Node can't
   * dynamic-import network URLs).
   */
  loadModule(url: string): Promise<unknown>
}
