# @agex-ts/runtime-worker

## 4.0.0

### Minor Changes

- ff10a85: Add a Node `worker_threads` target alongside the browser Web Worker.

  `workerRuntime` now runs on Node (and Bun / Deno) with real worker isolation, not just in the browser. A new `target?: 'auto' | 'browser' | 'node'` option selects the backend — `'auto'` (default) detects the environment, `'node'` uses `worker_threads` (`worker.node.js`), `'browser'` uses a Web Worker (`worker.js`). The platform transport now lives behind a `WorkerHandle` (host) / `WorkerPort` (worker) seam; the agent-execution core is shared and platform-agnostic.

  All bridged surfaces — `fs` / `cache`, registered fns / namespaces / classes, `spawn`, helpers, and the VFS `fetch` shim — work identically on both targets. The one exception: remote URL-shipped registrations (`agent.cls({ url: 'https://…' })`) are browser-only; on the Node target they raise a clear `ImportError` (Node can't dynamic-import remote module URLs). Ship such modules as `data:` / `file:` / local specifiers there.

  New `./worker.node` package export for the Node worker bundle.

### Patch Changes

- 6e9a4c3: Enforce `paramsSchema` on registered fns, and drop the inert capability flags.

  `paramsSchema` was documented as validating the agent's call args before a host fn runs, but nothing ever read it — both runtimes invoked the handler with raw args. An embedder who attached a schema believing it gated agent-supplied arguments had an unguarded host function. It's now enforced at both runtimes' host-side dispatch sites via a shared `enforceParamsSchema` helper (exported from `agex-ts/policy`), including when an agent-authored helper module under `/helpers/` calls the fn.

  The validation subject is the argument list, so a tuple schema is the natural shape (`z.tuple([z.number(), z.string()])`). A failure raises `SchemaError` into the agent's observation as an ordinary runtime error it can adjust to, and the host fn doesn't run. A transforming schema has its output spread as the call args; a non-array return is ignored in favor of the original args. Enforcement stays synchronous when the validator is synchronous — Zod, Valibot and ArkType all are for non-async schemas — so a registered sync fn doesn't silently become promise-returning under `evalRuntime`.

  **Breaking for anyone who set `paramsSchema` expecting it to be ignored:** calls that don't satisfy the schema now fail instead of reaching the handler. That's the documented behavior, so this is a fix rather than a change of contract.

  **Removed:** `hostFsAccess` and `networkAccess` on every registration. Both were declaration-only — no runtime ever read them — while `docs/concepts/sandboxing.md` presented them alongside the policy as if enforced. A capability flag that does nothing is worse than no flag; they can return designed against real enforcement. Registrations passing either field just need it deleted.

- Updated dependencies [12219da]
- Updated dependencies [0ab568e]
- Updated dependencies [6aef3c1]
- Updated dependencies [6e9a4c3]
- Updated dependencies [7bad540]
- Updated dependencies [7bad540]
  - agex-ts@0.5.0

## 3.0.0

### Patch Changes

- Updated dependencies [af6de76]
  - agex-ts@0.4.0

## 2.0.0

### Patch Changes

- Updated dependencies [1a9df08]
  - agex-ts@0.3.0

## 1.0.0

### Minor Changes

- da49328: Raise the default per-emission wall-clock timeout from 5s to 5 minutes (`evalRuntime` and `workerRuntime`). Unlike agex-py — whose AST-instrumented sandbox has a separate instruction (tick) limit as the runaway guard — agex-ts has no tick limit, so the wall-clock budget is the _only_ bound and must therefore cover legitimate long host-side awaits (a large `fetch`, a slow registered fn, a multi-step host call), not just compute. 5s was too tight for those. A genuine runaway is still capped by this budget (the worker is force-killed on expiry); a tighter instruction/tick budget remains a possible future addition. Override per runtime via `timeoutMs`.
- a7ee5f7: `spawn` now works under the worker runtime. Building on the concurrent-execute support, agent code in the worker can call `spawn(spec)` to run an ephemeral clone: a dedicated `spawnCall` bridge message (reusing the existing `bridgeResponse` + callId machinery, like `newInstance`/`instanceCall`) carries the spec to the host, which runs the clone and replies with its result — the parent emission parks at `await spawn(...)` while the clone's emissions run as concurrent executes on the same worker. `workerRuntime` now reports `injectsSpawn`, and the per-run `spawnEnabled` flag keeps clones depth-1 (no nested `spawn`).

  Sub-task clones now also get a short primer note (on any runtime): they have their own scratch VFS reachable via `fs.read`/`fs.write`, but third-party libraries that `fetch` URLs won't reach it. `routeFetchToVfs`'s transparent redirect is top-level-only — under concurrency (the global `fetch` shim has no per-execute context in a browser worker) it passes through to the network, so clones use explicit `fs.*` (or bytes-shuttling) for VFS data.

- 82a5229: `workerRuntime` now supports concurrent `execute()` calls multiplexed on a single worker, instead of throwing "concurrent execute() not supported". The worker thread is free while an emission is parked at an `await`, so several emissions can be in flight at once — which is what makes worker-runtime `spawn` possible (a parent emission parks at `await spawn(...)` while the clone emissions it triggered run). Host-side, in-flight executes are tracked by `executeId` and bridge traffic is routed per-execute; worker-side, the per-execute bridge channel and `__load` loader are scoped by `executeId` rather than a single active slot.

  Trade-off — **shared fate**: a kill (timeout, abort, worker error, or `dispose()`) terminates the shared worker and settles _all_ executes multiplexed on it (the offender gets its specific error; co-residents get a "terminated by a concurrent emission" cancellation). The blast radius is one worker = one `workerRuntime` instance, so give each session you want isolated its own instance.

  Known limitation: with `routeFetchToVfs` enabled, library-internal `fetch`es route to the VFS only when exactly one execute is in flight; under concurrent executes (different clones have different VFSs and a global `fetch` carries no execute context) they fall through to the network rather than risk reading the wrong VFS. A per-execute fetch context is a follow-up.

### Patch Changes

- Updated dependencies [da49328]
- Updated dependencies [82856bb]
- Updated dependencies [4f7eae9]
- Updated dependencies [242b322]
- Updated dependencies [d443474]
- Updated dependencies [a7ee5f7]
  - agex-ts@0.2.0
