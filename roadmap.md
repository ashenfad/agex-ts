# agex-ts: Roadmap

Tracks deferred work — items we know we want, scoped well enough to
pick up later without re-deriving the analysis. Live priorities go
here; once an item is in flight, it moves out (PR description carries
the detail). Once shipped, delete the entry.

[`docs/`](docs/) describes what's currently shipped. This document is
for known-wanted work that hasn't shipped yet.

---

## Deferred

### Overflow protection — fail-and-chapter for the long-task case

**Why it matters.** Chaptering currently fires only at task boundaries (success / fail / clarify). A task that runs many turns without ever completing accumulates context unchecked — chaptering can't help because there's no completable boundary to fold over. The single long-running-task case (typically autonomous workers without sub-task decomposition) hits the model's context window with no relief.

**Scope.** Add a hard-watermark mechanism that detects overflow during a task and forces the task to end so chaptering can fold its work, with optional auto-resume.

- **Hard watermark auto-derived from the model.** No new `overflowTrigger` knob on `AgentOptions`. The threshold comes from `LLMConfig.contextWindow * (1 - safetyMargin)`. Default safety margin handles output budget + tokenization slop (~5% of window).
- **Detection in the action loop.** After each `ActionEvent`, check whether `inputTokens` exceeds the derived overflow threshold. If yes:
  1. Synthesize a `FailEvent` with a "context-overflow" reason.
  2. Run chaptering — the task is now closed, so its range is foldable. The chapter folds the failed task plus prior completed work.
  3. Throw `TaskOverflowError` (subclass of `TaskFailError`) so the caller can distinguish "agent decided to fail" from "framework forced termination."
- **Opt-in auto-retry.** Add `maxOverflowRetries?: number` to `TaskCallOptions` (default `0`). When `>0`, the framework re-invokes the task with the same input in the same session, up to N retries; the new attempt sees the chapter from the failed run as part of its conversation history and picks up from there.
- **Provider work.** Each `connect*` factory adds a model→`contextWindow` lookup table and populates the field on `dumpConfig`. ~10 LOC × 3 providers. If the lookup misses (custom / self-hosted model), `contextWindow` is `undefined` and overflow protection silently disables — emit a `SystemNoteEvent` once on the first task call so the embedder knows.

**Estimate.** ~250 LOC across `task.ts`, `chaptering.ts`, `errors.ts`, plus tests. Not invasive — adds one detection point in the loop and one new error type. Provider lookups are mechanical.

**Trade-offs.** A forced fail is a strong intervention — the agent didn't choose to fail. `TaskOverflowError` is a distinct subclass so embedders can handle it specifically; the agent's TS doesn't see it (it surfaces only on the host side). In-flight state inside the failing task is gone; only what's in the chapter summary survives. Acceptable for the autonomous-worker case where decomposition into sub-tasks is the right answer anyway; less great for tasks that hold complex stateful intermediate results.

**Defer rationale.** Task-boundary chaptering covers the chat / multi-task case completely (the dominant use). The single-long-task case hasn't surfaced as a concrete user need yet; pick this up when one does.

---

### Node `worker_threads` target for `@agex-ts/runtime-worker`

**Why it matters.** `workerRuntime` is browser-only today; Node-side
embedders (backend services, CLIs, Next.js server actions, BullMQ
workers, Bun, Deno) can only use `evalRuntime`, which has no
isolation. That rules out untrusted or agent-authored code on the
server — the main reason `workerRuntime` exists. Cloudflare Workers
are out of scope here (no `worker_threads`); standard Node + Bun +
Deno are the targets.

**Scope.** Small. Most of the package is target-agnostic; only ~15
lines actually touch the Web Worker API.

- Host-side adapter wrapping `new Worker` / `terminate` /
  `postMessage` / `on('message' | 'error')`. Two impls behind one
  interface (~80 LOC).
- Worker-side shim swapping `self.postMessage` /
  `self.addEventListener` for `parentPort.postMessage` /
  `parentPort.on('message')` (~30 LOC).
- `target: 'auto' | 'browser' | 'node'` option on
  `WorkerRuntimeOptions`, auto-detected via
  `typeof process?.versions?.node`.
- Second worker entry in tsup config (`worker.node.mjs` alongside
  `worker.js`).
- New `vitest.node.config.ts` running the existing 68-test suite
  against the Node worker. A handful of fixture tests that build
  URL-shipped modules via `URL.createObjectURL` need a Node-friendly
  variant (`data:` URLs or temp files).
- README + runtime docstring updates noting target selection.

**Estimate.** 1–2 focused sessions, ~300–500 LOC delta. Risk
concentrated in the multi-target tsup config and Vitest's
`worker_threads` spawning under test — both can surprise. Functionality
risk is low; the abstraction shape is obvious in advance.

**Defer rationale.** No concrete user is asking, and the author's own
work is browser-side. Architecture isn't something we'll regret
delaying. Pick this up when a Node embedder surfaces or when broader
adoption makes server-side isolation a credible ask.

---

### Per-clone iteration budgets + supervised extension hearings

**Why it matters.** A `spawn` clone today inherits one global cap — `agent.maxIterations` (default `10`), read straight off the agent in the task loop (`task.ts`), with no per-task override anywhere. That bounds runaways (good — every clone can't spin forever for free), but it gives the orchestrating parent no per-subtask control, and it gives a clone making *slow but steady* progress no recourse: it hits the wall and fails, even when a few more turns would finish the job. The missing primitive is a **per-clone, mutable iteration budget** — and once you have it, two distinct capabilities fall out of the same plumbing.

**The primitive.** A per-clone iteration budget that is (a) settable at spawn time and (b) adjustable mid-flight. `agent.maxIterations` stays as the default/floor; the per-clone budget overrides it for that one run.

**Use 1 — static, parent-set budgets (small, could land alone).**
- Add `maxIterations?: number` to `SpawnSpec`; thread it through `buildCloneDef` → the clone's task loop so a clone reads *its* budget, not the shared `agent.maxIterations`.
- Lets the parent right-size each subtask: `spawn({ task, maxIterations: 5 })` for a quick lookup, a larger cap for real work. This is the cheap, no-LLM "runaway budget" tier, and it's the foundation the dynamic version builds on.

**Use 2 — supervised extension hearings (the premium tier; the reason supervisor mode is worth building).**
- A clone nearing its cap can emit an explicit, structured `requestExtension(report)` instead of silently hitting the wall. The `report` is the clone's *justification* — "processed 8 of 12 files, steady progress, need ~6 more turns."
- On that request, the host runs a **supervisor**: a *read-only branch of the parent* (the same `RunContext` resource-injection seam `spawn` already uses, but seeded with the parent's event log read-only instead of a blank substrate — it needs the parent's goal to judge relevance; it must not mutate parent state or it corrupts the suspended real agent). The supervisor is a **single-turn structured decision**, not a full agent loop: `{ grant: boolean, additionalIterations?: number, guidance?: string }`.
- On grant: bump *that* clone's `maxIter` and continue the same loop — no pause/resume, since the loop control is host-side in `makeTask` and supervision is synchronous at the boundary. `guidance` doubles as a steering channel ("yes, +5, but focus only on the error logs"). On deny: normal cap-exhaust fail.

**Why this is the payoff for the "report" channel.** A separate exploration (see the conversation that produced this entry) concluded that piping a clone's free-form prose into the *parent's* reasoning is a step sideways — the parent has no in-flight moment (it's parked at `await spawn(...)`), so prose and the typed return arrive together and the return value strictly dominates (opt-in via schema, attributed by handle, bounded). The extension hearing is the *one* place a clone's report earns a parent-adjacent audience: not as ambient narration, but as **evidence in a resource request a supervisor adjudicates.** The trigger is discrete and rare (only on an extension request — a well-behaved clone that finishes under budget never fires it), which is exactly what makes the supervisor's full-context cost affordable where polling never was.

**Plumbing shared by both uses (build first).**
- Per-clone mutable iteration budget in the clone's task loop (replaces the bare `agent.maxIterations` read for clones).
- Per-clone `AbortController` chained to the parent (`AbortSignal.any([parentSignal, perClone.signal])`) so the host can act on *one* clone — needed if a denied/abandoned subtask should be cancelled rather than left to exhaust. Today `createSpawn` threads `parentSignal` straight to every clone.
- A non-throwing cancellation/exhaustion *sentinel* outcome (`{ cancelled: true, reason }` / `{ exhausted: true }`) so a supervised stop resolves the clone's promise rather than rejecting the parent's `Promise.all` — the parent wakes to "3 returned, 2 stopped, here's why," not an error it never initiated.

**Defer rationale.** Use 2 needs the supervisor (a read-only parent branch + an LLM call per hearing) and the sentinel-outcome semantics — real surface area. Use 1 (`SpawnSpec.maxIterations`) is small and self-contained and is the natural thing to land first if/when the per-subtask-budget need is concrete; the supervisor is the eventual escalation once "is this subtask worth more turns?" becomes a judgment worth paying for.
