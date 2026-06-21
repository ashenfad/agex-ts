/**
 * Node `WorkerPort` — wires the worker core to `worker_threads`'
 * `parentPort`. Used by the `worker.node.ts` entry, built to
 * `worker.node.js`. This file is only ever bundled into the Node worker
 * entry, so its `node:*` imports never reach a browser build.
 */
import process from 'node:process'
import { parentPort } from 'node:worker_threads'
import type { Host2WorkerMessage, Worker2HostMessage } from './messages'
import type { WorkerPort } from './worker-port'

/** Same `new Function` indirection as the browser port — harmless under
 *  Node (no Vite), and keeps the two ports symmetric. */
const rawImport = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>

/** Match `http:` / `https:` URLs, which Node can't dynamic-import. */
const REMOTE_URL = /^https?:/i

export function createNodePort(): WorkerPort {
  const port = parentPort
  if (port === null) {
    throw new Error(
      '@agex-ts/runtime-worker: the Node worker entry was loaded outside a worker_threads context (parentPort is null).',
    )
  }
  return {
    post: (msg: Worker2HostMessage): void => port.postMessage(msg),
    onMessage: (cb): void => {
      port.on('message', (value: Host2WorkerMessage) => cb(value))
    },
    onUnhandledRejection: (shouldSuppress): (() => void) => {
      // Node suppresses the default unhandled-rejection action the moment
      // ANY listener exists — there's no per-event `preventDefault()` like
      // the browser. During the short drain window this therefore swallows
      // *all* unhandled rejections, not just the task-control signals the
      // browser path targets with `shouldSuppress`. A genuine orphaned
      // agent-code rejection landing in that window is silent on the Node
      // target where the browser would still log it. Accepted, documented
      // asymmetry: the window is brief (≤2s / 16 microtasks) and the
      // rejections in question are unawaited by construction. We still call
      // `shouldSuppress` so the contract stays honest if it ever grows
      // side effects.
      const handler = (reason: unknown): void => {
        void shouldSuppress(reason)
      }
      process.on('unhandledRejection', handler)
      return () => {
        process.off('unhandledRejection', handler)
      }
    },
    loadModule: (url): Promise<unknown> => {
      if (REMOTE_URL.test(url)) {
        return Promise.reject(
          new Error(
            `Remote URL imports aren't supported on the Node worker target (${url}). Node can't dynamic-import http(s) module URLs. Ship the module as a bundled \`data:\` URL, a \`file:\` URL, or a local module — or run the agent on the browser worker target, where remote URL-shipped registrations import natively.`,
          ),
        )
      }
      return rawImport(url)
    },
  }
}
