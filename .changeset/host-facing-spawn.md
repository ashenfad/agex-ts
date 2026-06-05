---
"agex-ts": minor
---

Add a host-facing `Agent.spawn(spec, opts?)` method. It runs an ephemeral
clone of the agent on a typed sub-task directly from host code — the
symmetric counterpart of the agent-authored `spawn` builtin, with the same
`SpawnSpec` and semantics (shared policy + `/skills`, depth-1, output
enforce-and-retry, read-only `view`, failure-as-rejection, cancellation via
`signal`). Runs cold; no live parent task required. Each call gets its own
concurrency semaphore bounded by `maxSpawns`.
