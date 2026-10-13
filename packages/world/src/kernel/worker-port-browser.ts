import type { Host2Worker, Worker2Host } from './messages'
import { type WorkerPort, rawImport } from './worker-port'

/** The port for a browser Web Worker: its global `self`. */
export function createBrowserPort(): WorkerPort {
  const scope = self as unknown as DedicatedWorkerGlobalScope
  return {
    post: (msg: Worker2Host): void => scope.postMessage(msg),
    onMessage: (cb): void => {
      scope.addEventListener('message', (ev: MessageEvent<Host2Worker>) => cb(ev.data))
    },
    loadModule: (url): Promise<unknown> => rawImport(url),
  }
}
