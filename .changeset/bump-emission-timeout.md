---
"agex-ts": minor
"@agex-ts/runtime-worker": minor
---

Raise the default per-emission wall-clock timeout from 5s to 5 minutes (`evalRuntime` and `workerRuntime`). Unlike agex-py — whose AST-instrumented sandbox has a separate instruction (tick) limit as the runaway guard — agex-ts has no tick limit, so the wall-clock budget is the *only* bound and must therefore cover legitimate long host-side awaits (a large `fetch`, a slow registered fn, a multi-step host call), not just compute. 5s was too tight for those. A genuine runaway is still capped by this budget (the worker is force-killed on expiry); a tighter instruction/tick budget remains a possible future addition. Override per runtime via `timeoutMs`.
