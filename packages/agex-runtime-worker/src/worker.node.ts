/**
 * Node `worker_threads` entry. Wires the platform-agnostic worker core
 * (`worker-core.ts`) to the `parentPort`-based `WorkerPort` and boots it.
 * Built to `dist/worker.node.js`; the host resolves it via
 * `new URL('./worker.node.js', import.meta.url)` on the Node target.
 */
import { bootWorker } from './worker-core'
import { createNodePort } from './worker-port-node'

bootWorker(createNodePort())
