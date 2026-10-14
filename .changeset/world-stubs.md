---
"@agex-ts/world": minor
---

**Stubs:** `withStub(host, source)` gives a host object a code-side half, the source of `(remote) => object` run in the worker for each run, so code can get functions, classes and errors of its own from a host object. A run's timeout now counts the code's own time: a host object's call doesn't count against it, up to `CodeSettings.hostTime` (600 seconds by default), past which the clock runs whatever is pending.
