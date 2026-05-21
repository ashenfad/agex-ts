# @agex-ts/runtime-worker

Worker-isolated `RuntimeAdapter` for [agex-ts](../agex-ts). Browser-first (Web Worker); `worker_threads` planned for Node. The agent's TypeScript runs in a fresh realm with no DOM access and no shared globals; the host bridges via postMessage. See [agex-ts's Runtime API doc](../../docs/api/runtime.md#workerruntime-agex-tsruntime-worker) for the full surface.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

> **Vite users:** add `'@agex-ts/runtime-worker'` to `optimizeDeps.exclude` — see [Using with Vite](../../README.md#using-with-vite) in the top-level README.
