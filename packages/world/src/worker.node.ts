/** The kernel's Node `worker_threads` entry, built to
 *  `dist/worker.node.js`. */
import { bootWorker } from './kernel/worker-core'
import { createNodePort } from './kernel/worker-port-node'

bootWorker(createNodePort())
