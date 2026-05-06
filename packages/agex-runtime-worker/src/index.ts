// Public surface — host-side `workerRuntime()` factory and the
// transform-hook type. The worker itself is a separate entry
// (`agex-runtime-worker/worker`) that consumers don't import
// directly; the runtime resolves it via `new URL('./worker.js',
// import.meta.url)`.

export type { TransformFn } from './transform'
export { defaultTransform } from './transform'
export { type WorkerRuntimeOptions, workerRuntime } from './runtime'
