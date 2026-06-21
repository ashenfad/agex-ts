---
"@agex-ts/runtime-worker": minor
---

Add a Node `worker_threads` target alongside the browser Web Worker.

`workerRuntime` now runs on Node (and Bun / Deno) with real worker isolation, not just in the browser. A new `target?: 'auto' | 'browser' | 'node'` option selects the backend — `'auto'` (default) detects the environment, `'node'` uses `worker_threads` (`worker.node.js`), `'browser'` uses a Web Worker (`worker.js`). The platform transport now lives behind a `WorkerHandle` (host) / `WorkerPort` (worker) seam; the agent-execution core is shared and platform-agnostic.

All bridged surfaces — `fs` / `cache`, registered fns / namespaces / classes, `spawn`, helpers, and the VFS `fetch` shim — work identically on both targets. The one exception: remote URL-shipped registrations (`agent.cls({ url: 'https://…' })`) are browser-only; on the Node target they raise a clear `ImportError` (Node can't dynamic-import remote module URLs). Ship such modules as `data:` / `file:` / local specifiers there.

New `./worker.node` package export for the Node worker bundle.
