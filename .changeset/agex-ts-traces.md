---
"agex-ts": patch
---

**An agex session reads as a trace:** `AgexTraces`, the world's `TraceSource` for agex's stored runs, so `Store.open(kv, { traces: { [HARNESS]: new AgexTraces() } })` lets another session mount an agex session's conversation with `ws-git worktree add --trace`. It reads a run as Python agex's `AgexTraces` does: status, times, models, token counts, and each call paired with its result.
