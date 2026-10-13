---
"agex-ts": minor
---

**Folding:** `new Agent({ compaction: new Policy(budget) })` folds the conversation into a summary written by the agent's own model when a request reaches the budget, within a run too. Each fold is recorded on `ws.compaction` and streamed as `Compacted`, summary calls count against `maxSteps` and in `Run.compaction` (with `Run.compactionCalls`), and a fold over a range is spliced where its range began. `ScriptedProvider` reports an estimate of the request for a step that gives no `input_tokens`.
