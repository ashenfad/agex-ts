# @agex-ts/runtime-worker

Worker-isolated `RuntimeAdapter` for [agex-ts](../agex-ts). Runs on both a browser **Web Worker** and a Node **`worker_threads`** worker. The agent's TypeScript runs in a fresh realm with no DOM access and no shared globals; the host bridges via postMessage. See [agex-ts's Runtime API doc](../../docs/api/runtime.md#workerruntime-agex-tsruntime-worker) for the full surface.

> **Status:** Pre-alpha. Public API is unstable; pin a specific minor version.

> **Vite users:** add `'@agex-ts/runtime-worker'` to `optimizeDeps.exclude` — see [Using with Vite](../../README.md#using-with-vite) in the top-level README.

## Target selection

`workerRuntime` picks a worker backend with the `target` option:

```ts
import { workerRuntime } from '@agex-ts/runtime-worker'

// Auto-detect (default): 'node' when running under Node (process.versions.node
// present and no global Worker), else 'browser'.
workerRuntime()

// Force a backend explicitly:
workerRuntime({ target: 'browser' }) // Web Worker  → worker.js
workerRuntime({ target: 'node' })    // worker_threads → worker.node.js
```

The target also selects the default `workerUrl` (`worker.js` vs `worker.node.js`). Both bundles share the same agent-execution core; only the platform transport (`self` vs `parentPort`) and a few capabilities differ. Use the Node target on Node / Bun / Deno to get real isolation for agent-authored code server-side — `evalRuntime` runs it in-process with none.

### Remote URL-shipped registrations are browser-only

URL-shipped registrations (`agent.cls({ url: 'https://esm.sh/…' })`) and esm.sh bare-import routing dynamic-`import()` a module URL inside the worker. The browser target imports any ESM-resolvable URL — including remote `https:` — natively. **The Node target can't**: Node has no stable support for importing `http(s):` module URLs, so a remote URL-shipped registration raises a clear `ImportError` on first use there. Ship such modules as a bundled `data:` URL, a `file:` URL, or a local module on the Node target, or keep them on the browser target.

Everything else — `fs` / `cache` bridging, registered fns / namespaces / classes, `spawn` fan-out, the VFS-backed `fetch` shim, helper modules — works identically on both targets.
