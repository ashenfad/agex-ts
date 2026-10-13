---
"@agex-ts/world": minor
---

**The kernel:** `ws.runCode(code)` runs TypeScript in a worker (a browser Web Worker or Node `worker_threads`) as one call, committed as `{tool: 'run_ts'}`.
- **What code has:** the session's files as `fs`, the cache, `env`, a captured console, and the profile's host objects.
- **What it can import:** the world's own modules, `'host'`, URLs, and bare names through a resolver.
- **Timeouts and interrupts:** a timeout (30 seconds by default) or `ws.interrupt()` stops a run, keeping and committing what it wrote.

**Profiles:** granted at `store.open(id, {profile})` and inherited by forks.
- They carry host objects, made per world with `hostFactory`, plus variables, secrets and code settings.
- A host method declared `withCall` can change the calling workspace as part of the code's call.
