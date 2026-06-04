---
"@agex-ts/runtime-worker": minor
---

`workerRuntime` now supports concurrent `execute()` calls multiplexed on a single worker, instead of throwing "concurrent execute() not supported". The worker thread is free while an emission is parked at an `await`, so several emissions can be in flight at once — which is what makes worker-runtime `spawn` possible (a parent emission parks at `await spawn(...)` while the clone emissions it triggered run). Host-side, in-flight executes are tracked by `executeId` and bridge traffic is routed per-execute; worker-side, the per-execute bridge channel and `__load` loader are scoped by `executeId` rather than a single active slot.

Trade-off — **shared fate**: a kill (timeout, abort, worker error, or `dispose()`) terminates the shared worker and settles *all* executes multiplexed on it (the offender gets its specific error; co-residents get a "terminated by a concurrent emission" cancellation). The blast radius is one worker = one `workerRuntime` instance, so give each session you want isolated its own instance.

Known limitation: with `routeFetchToVfs` enabled, library-internal `fetch`es route to the VFS only when exactly one execute is in flight; under concurrent executes (different clones have different VFSs and a global `fetch` carries no execute context) they fall through to the network rather than risk reading the wrong VFS. A per-execute fetch context is a follow-up.
