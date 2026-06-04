---
"@agex-ts/runtime-worker": minor
"agex-ts": minor
---

`spawn` now works under the worker runtime. Building on the concurrent-execute support, agent code in the worker can call `spawn(spec)` to run an ephemeral clone: a dedicated `spawnCall` bridge message (reusing the existing `bridgeResponse` + callId machinery, like `newInstance`/`instanceCall`) carries the spec to the host, which runs the clone and replies with its result — the parent emission parks at `await spawn(...)` while the clone's emissions run as concurrent executes on the same worker. `workerRuntime` now reports `injectsSpawn`, and the per-run `spawnEnabled` flag keeps clones depth-1 (no nested `spawn`).

Sub-task clones now also get a short primer note (on any runtime): they have their own scratch VFS reachable via `fs.read`/`fs.write`, but third-party libraries that `fetch` URLs won't reach it. `routeFetchToVfs`'s transparent redirect is top-level-only — under concurrency (the global `fetch` shim has no per-execute context in a browser worker) it passes through to the network, so clones use explicit `fs.*` (or bytes-shuttling) for VFS data.
