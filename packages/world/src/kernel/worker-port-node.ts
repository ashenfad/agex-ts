/**
 * The port for a Node `worker_threads` worker: its `parentPort`. Only
 * the Node worker entry imports this, so its `node:` imports never reach
 * a browser bundle.
 */
import { parentPort } from 'node:worker_threads'
import type { Host2Worker, Worker2Host } from './messages'
import { type WorkerPort, rawImport } from './worker-port'

const REMOTE_URL = /^https?:/i

export function createNodePort(): WorkerPort {
  const port = parentPort
  if (port === null) {
    throw new Error('the kernel worker was loaded outside a worker_threads worker')
  }
  return {
    post: (msg: Worker2Host): void => port.postMessage(msg),
    onMessage: (cb): void => {
      port.on('message', (value: Host2Worker) => cb(value))
    },
    loadModule: (url): Promise<unknown> => {
      if (REMOTE_URL.test(url)) {
        return Promise.reject(
          new Error(
            `can't import ${url}: a Node worker doesn't import http(s) URLs (use a data: or file: URL, or a browser)`,
          ),
        )
      }
      return rawImport(url)
    },
  }
}
