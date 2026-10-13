/** The kernel's browser Web Worker entry, built to `dist/worker.js`. */
import { bootWorker } from './kernel/worker-core'
import { createBrowserPort } from './kernel/worker-port-browser'

bootWorker(createBrowserPort())
