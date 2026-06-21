/**
 * Browser Web Worker entry. Wires the platform-agnostic worker core
 * (`worker-core.ts`) to the browser `self`-based `WorkerPort` and boots
 * it. Built to `dist/worker.js`; the host resolves it via
 * `new URL('./worker.js', import.meta.url)` on the browser target.
 */
import { bootWorker } from './worker-core'
import { createBrowserPort } from './worker-port.browser'

bootWorker(createBrowserPort())
