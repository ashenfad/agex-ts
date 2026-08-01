---
"agex-ts": patch
---

Simplify chaptering internals. No behavior change.

Chaptering had accumulated the most coupled invariants of any subsystem, so this is a structural pass with the existing three test files as the safety net:

- `buildChapterScopeFilter(events, includeOpen)` served two callers with opposite contracts off one boolean. Split into `closedChapterScopes` (the renderer's view — a running chapter task stays visible so its own loop can render itself) and `allChapterScopes` (the index builder's view — a chapter task can't chapter itself), over one shared walker.
- `hasCompletableBoundary` recomputed the same scope filter the index builder had just computed, and the two had to agree on which indices to skip or ranges would silently misresolve. It's now derived inside `buildBoundaryIndex` from the same scan, as `hasCompletable`. One filter computation per run, no cross-function agreement to maintain.
- `runChaptering` derived boundary *positions* and the *state keys* it folds from two independently-fetched views of the log, assumed index-aligned. They could diverge: `iter()` drops entries whose value is missing while `refs()` returns every key, so one absent value would shift positions against refs and fold the wrong range. Both now come from a single `EventLogImpl.entries()` read that pairs them, making alignment structural. `runChaptering` no longer takes a `parentEvents` argument — it reads its own snapshot — which also removes a redundant log walk from `agent.runChaptering`.
- Removed `isChapteringInFlight`, which had no callers outside a test and whose doc claimed the action loop consulted it. Recursion is prevented by `runChaptering`'s own check on entry; the comment now says so.

Also fixes two stale references in comments: the default-primer docstring pointed at a removed `agent.chapterTask({ primer })` API (it's `AgentOptions.chapterPrimer`), and the "Filter A / Filter B" vocabulary is replaced by the function names.
