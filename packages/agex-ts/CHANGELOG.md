# agex-ts

## 0.6.3

### Patch Changes

- ace31b6: **Tool descriptions are read at each request:** a session tells the model of its tools as they are now, so a secret the world gains or loses mid-turn shows in the next request.
- Updated dependencies [0ee8a71]
  - @agex-ts/world@0.1.6

## 0.6.2

### Patch Changes

- bd58ae2: **A fold's commit says `folded`, not `runs`:** `{ tool: 'fold', through, folded }`, so `runs` on a commit means only what a turn's stamp means by it, the runs it landed.
- 110bc5b: **An agex session reads as a trace:** `AgexTraces`, the world's `TraceSource` for agex's stored runs, so `Store.open(kv, { traces: { [HARNESS]: new AgexTraces() } })` lets another session mount an agex session's conversation with `ws-git worktree add --trace`. It reads a run as Python agex's `AgexTraces` does: status, times, models, token counts, and each call paired with its result.
- Updated dependencies [ab9084c]
- Updated dependencies [21020d5]
- Updated dependencies [297ff23]
  - @agex-ts/world@0.1.5

## 0.6.1

### Patch Changes

- 69ac7c5: **`readRuns(ws)` reads a workspace's runs without an agent:** a page restoring a chat's history reads them from the workspace alone, where it needed a session, and so a model, to call `runs()`.
- Updated dependencies [8a29999]
- Updated dependencies [ee3020b]
- Updated dependencies [e3b247f]
- Updated dependencies [83c2b5b]
- Updated dependencies [9414881]
- Updated dependencies [adde488]
  - @agex-ts/kvgit@0.2.1
  - @agex-ts/world@0.1.3

## 0.6.0

### Minor Changes

- a507f31: **Agent-defined tasks:** `agentTasks(agent)` grants `agex`, with which the agent's code defines a task (`agex.task({ name, instructions, params, returns })`, types as JSON Schema) and calls it or `.map`s it; each call runs a helper agent as a delegate of the calling world (or on a scratch world), and a helper that fails or asks throws `agex.TaskFailed` or `agex.TaskNeedsInput`. `standInTasks(answer?)` answers without a model, `AGEX_GUIDE` tells the model how, and `agex-ts/conformance` runs agex's code scenarios (`runCodeScenario`).
- cba99fa: **AI SDK models:** `new Agent({ model })` takes any AI SDK `LanguageModelV4` and drives its `doStream` through `AiSdkProvider`, without the AI SDK's core. `settings.thinking` is the spec's reasoning effort, provider metadata (signatures, encrypted reasoning) is kept on the record's parts and sent back to its provider alone, `settings.extra` is provider options, and rate limits, overloads and unreachable providers interrupt a run. Depends on `@ai-sdk/provider`.
- c2e9ed2: **Delegation:** `agent.session(ws, { sessions: true })` offers the world's `sessions` tool over the workspace's helper. Each delegate runs as a session of the asking agent (`Runner`) until nothing it waits on is outstanding, and answers ride the next tool result or open a woken turn. A new agent for the next turn finds the same jobs; `session.close()` waits for them.
- 745d8ec: **Folding:** `new Agent({ compaction: new Policy(budget) })` folds the conversation into a summary written by the agent's own model when a request reaches the budget, within a run too. Each fold is recorded on `ws.compaction` and streamed as `Compacted`, summary calls count against `maxSteps` and in `Run.compaction` (with `Run.compactionCalls`), and a fold over a range is spliced where its range began. `ScriptedProvider` reports an estimate of the request for a step that gives no `input_tokens`.
- 3f143b2: Breaking: agex-ts is rewritten as a loop over `@agex-ts/world`, with the run record (`Run`, `Message` and their parts, `loadRun`/`dumpRun`), the provider protocol (`Provider`, `stream` with an abort signal, `transient`), `ScriptedProvider`, and agex's shape corpus at `agex-ts/conformance`. The previous design's API is gone, and with it `@agex-ts/runtime-worker`, `@agex-ts/git`, `@agex-ts/anthropic`, `@agex-ts/openai` and `@agex-ts/gemini`, replaced by the world's kernel and ws-git and the AI SDK's providers.
- 0a8dcc7: **Sessions:** `new Agent({model, primer, settings, maxSteps, maxToolCalls})` and `agent.session(ws)`, the loop over the world's turn: `say`, `stream` (TurnEvents as they happen), `resume`, `abandon`, `wake`, `cancel(reason)`, and the stored runs. `agexHarness` (`agex-ts/conformance`) runs it against nontainer's harness corpus.
- 707259e: **Tasks:** `agent.task({ name, instructions, params, returns })` runs the agent on a scratch world (`new Agent({ profile, scratch })`) or a fork of `world`, and hands back a value checked against its Standard Schema; `task.success`, `task.fail` and `task.needsInput` end the agent's script, and a task that asks resumes through its outcome or by ref from its `__task__` plane. `live()` declares an input whose methods the code calls on the host, `fromJsonSchema` makes a Standard Schema of a JSON Schema literal, and `agex-ts/conformance` runs agex's task scenarios (`AgexTasks`).
- 326eedf: Breaking: Node 22 or later is required (Node 20 is past its end of life, and the AI SDK's packages need 22).

### Patch Changes

- Updated dependencies [cbaa8ea]
- Updated dependencies [6115187]
- Updated dependencies [3c938b2]
- Updated dependencies [f72a259]
- Updated dependencies [f154ccc]
- Updated dependencies [7de1515]
- Updated dependencies [36a2042]
- Updated dependencies [7ab2502]
- Updated dependencies [1494f5c]
- Updated dependencies [f65aaec]
- Updated dependencies [d7a3f69]
- Updated dependencies [62727b0]
- Updated dependencies [1cfdbf5]
- Updated dependencies [3f0b814]
- Updated dependencies [b382ec7]
- Updated dependencies [a574362]
- Updated dependencies [231a95e]
- Updated dependencies [bd9900f]
- Updated dependencies [9b4cfef]
- Updated dependencies [326eedf]
- Updated dependencies [a05bdb1]
- Updated dependencies [1c9308b]
- Updated dependencies [701d47f]
- Updated dependencies [cca0960]
- Updated dependencies [b2c181f]
- Updated dependencies [03c1930]
- Updated dependencies [af5df2b]
- Updated dependencies [c2e9ed2]
- Updated dependencies [4d77423]
- Updated dependencies [ef608ae]
- Updated dependencies [a507f31]
- Updated dependencies [f73fead]
- Updated dependencies [056800c]
- Updated dependencies [707259e]
- Updated dependencies [d54e54f]
- Updated dependencies [992eacf]
- Updated dependencies [88439fe]
- Updated dependencies [3f0b814]
  - @agex-ts/kvgit@0.2.0
  - @agex-ts/world@0.1.0

## 0.5.0

### Minor Changes

- 12219da: Add an optional Codex-shaped `apply_patch` action surface, durable patch
  emissions, streaming patch tokens, and validated multi-file VFS dispatch.
  Match Codex's lenient patch syntax, provide line-specific diagnostics, and
  return explicit commit or rollback status to the model.
- 6e9a4c3: Enforce `paramsSchema` on registered fns, and drop the inert capability flags.

  `paramsSchema` was documented as validating the agent's call args before a host fn runs, but nothing ever read it — both runtimes invoked the handler with raw args. An embedder who attached a schema believing it gated agent-supplied arguments had an unguarded host function. It's now enforced at both runtimes' host-side dispatch sites via a shared `enforceParamsSchema` helper (exported from `agex-ts/policy`), including when an agent-authored helper module under `/helpers/` calls the fn.

  The validation subject is the argument list, so a tuple schema is the natural shape (`z.tuple([z.number(), z.string()])`). A failure raises `SchemaError` into the agent's observation as an ordinary runtime error it can adjust to, and the host fn doesn't run. A transforming schema has its output spread as the call args; a non-array return is ignored in favor of the original args. Enforcement stays synchronous when the validator is synchronous — Zod, Valibot and ArkType all are for non-async schemas — so a registered sync fn doesn't silently become promise-returning under `evalRuntime`.

  **Breaking for anyone who set `paramsSchema` expecting it to be ignored:** calls that don't satisfy the schema now fail instead of reaching the handler. That's the documented behavior, so this is a fix rather than a change of contract.

  **Removed:** `hostFsAccess` and `networkAccess` on every registration. Both were declaration-only — no runtime ever read them — while `docs/concepts/sandboxing.md` presented them alongside the policy as if enforced. A capability flag that does nothing is worse than no flag; they can return designed against real enforcement. Registrations passing either field just need it deleted.

- 7bad540: Add a provider-native action surface that keeps `ts_action` dynamic while delegating shell and file operations to provider tools.

### Patch Changes

- 0ab568e: Simplify chaptering internals. No behavior change.

  Chaptering had accumulated the most coupled invariants of any subsystem, so this is a structural pass with the existing three test files as the safety net:

  - `buildChapterScopeFilter(events, includeOpen)` served two callers with opposite contracts off one boolean. Split into `closedChapterScopes` (the renderer's view — a running chapter task stays visible so its own loop can render itself) and `allChapterScopes` (the index builder's view — a chapter task can't chapter itself), over one shared walker.
  - `hasCompletableBoundary` recomputed the same scope filter the index builder had just computed, and the two had to agree on which indices to skip or ranges would silently misresolve. It's now derived inside `buildBoundaryIndex` from the same scan, as `hasCompletable`. One filter computation per run, no cross-function agreement to maintain.
  - `runChaptering` derived boundary _positions_ and the _state keys_ it folds from two independently-fetched views of the log, assumed index-aligned. They could diverge: `iter()` drops entries whose value is missing while `refs()` returns every key, so one absent value would shift positions against refs and fold the wrong range. Both now come from a single `EventLogImpl.entries()` read that pairs them, making alignment structural. `runChaptering` no longer takes a `parentEvents` argument — it reads its own snapshot — which also removes a redundant log walk from `agent.runChaptering`.
  - Removed `isChapteringInFlight`, which had no callers outside a test and whose doc claimed the action loop consulted it. Recursion is prevented by `runChaptering`'s own check on entry; the comment now says so.

  Also fixes two stale references in comments: the default-primer docstring pointed at a removed `agent.chapterTask({ primer })` API (it's `AgentOptions.chapterPrimer`), and the "Filter A / Filter B" vocabulary is replaced by the function names.

- 6aef3c1: Correct documentation drift, and remove the dead `EventLog.at()` stub.

  Docs had fallen behind several shipped features. Fixed: `FileEvent`'s field is `source: 'user' | 'agent'`, not `fileSource: string`; `ErrorEvent` carries `recoverable` and is embedder-emitted rather than framework-emitted (as is `FileEvent`); `RuntimeAdapter` has five members, not three; `ActionSurface` has three values, and the `'agex-patch'` surface is now documented; `captureSpawnEvents` is documented for the first time, including that it makes clone events durable — which the events page previously described as impossible; Node `worker_threads` is documented as shipped in `sandboxing.md` and `quick-start.md` rather than as roadmap material; `docs/index.md` lists `@agex-ts/git`; `errors.md` no longer claims the bundled providers throw `TransientError` / `FatalError` (they classify with `isTransientNetworkError` and re-throw — the classes are an extension point for custom `LLMClient`s); `quick-start.md` no longer implies task type parameters are validated at runtime without a schema.

  Eight source comments pointed at `docs/roadmap/spawn.md`, which doesn't exist; they now point at the spawn section of `docs/api/agent.md`. Three comments stated _wrong reasons_ for correct behavior — the event-log index comment claimed the chapter task runs in a child session (it runs in the parent's, and non-overlap comes from the parent awaiting it at a task boundary), the chaptering header described a removed `agent.chapterTask()` API and an after-every-action trigger (it fires at task boundaries), and runtime-worker's Node vitest config claimed the lane had nothing to run.

  **Removed:** `EventLog.at()`. It returned `null` unconditionally while its interface doc implied a historical view on versioned state, and the docs already redirected callers to `agent.eventsAt(hash, session)`, which is the working path.

  `PolicyBuilder.fingerprint()` now hashes each registration's agent-visible config rather than name-and-count. Registration is add-only, so the old form already caught every mutation of one builder over time; the change matters for comparing two policies, where identical names with different descriptions render different primers but previously produced identical fingerprints. Also exports `ReconfigurableOptions`, `SkillRegistration` and `UrlSpec`, which the docs referenced by name but weren't importable.

- 7bad540: Preserve provider-assigned tool-call IDs and original arguments through
  parsing, dispatch, and conversation rendering so stateful OpenAI-compatible
  endpoints receive the exact call required to continue a parked tool.
- Updated dependencies [d660ff6]
- Updated dependencies [c271f52]
- Updated dependencies [fe74fd6]
- Updated dependencies [d83f06c]
  - @agex-ts/kvgit@0.1.3
  - @agex-ts/termish@0.2.0

## 0.4.1

### Patch Changes

- 87e92b5: Resolve bare npm specifiers inside `/helpers` modules, not just action bodies. A `import { createNoise2D } from 'simplex-noise'` in a helper now routes through the host's namespace resolver (→ esm.sh in the studio), exactly like the same import in an action body. Previously the helper rewriter left unregistered bare imports untouched, so the surviving `import` statement threw the opaque "Cannot use import statement outside a module" at evaluation time — and npm packages worked in action bodies but not helpers, a surprising asymmetry.

## 0.4.0

### Minor Changes

- af6de76: Add an opt-in `captureSpawnEvents` flag (on `AgentOptions` /
  `ReconfigurableOptions`, default `false`). When on, each `spawn` clone's
  full event timeline is captured onto the parent task's terminal event
  (`SuccessEvent` / `FailEvent` / `CancelledEvent`) as a new optional
  `spawnEvents` field — an array of `{ spawnIndex, events }` entries
  (`SpawnEventsEntry`), keyed by the clone's `spawnIndex` and covering
  every clone the task launched across all its turns. This gives a durable,
  groupable record of sub-task activity for host UX drill-down and audit,
  without the per-clone kvgit keys / lifecycle a separate sub-session would
  need.

  The payload is invisible to the parent LLM: `renderEvents` reads only
  `result` / `message` / `taskName` off a terminal event, so the captured
  events ride along unseen (no filtering required). Capture also works with
  no host `onEvent` attached. Off by default and uncapped when on — a wide
  fan-out produces a correspondingly large terminal event.

## 0.3.1

### Patch Changes

- dcf5867: Spawn `view` ergonomics + a structured spawn index:

  - **Self-announcing `view` mounts.** A clone is now told which read-only
    `view` files were mounted, in its opening task message (per-file for a
    file view; root + a count-capped shallow listing for a directory view),
    so a real model no longer has to guess to `list("/")` to find them.
  - **cwd-relative `view` paths.** A relative `view` path now resolves
    against the parent session's cwd — the same way the parent's own `fs.*`
    calls resolve it — instead of always anchoring at `/`. A `view` path
    that resolves to nothing throws a clear error rather than silently
    mounting an empty overlay.
  - **`EventBase.spawnIndex`.** Spawn-clone events now carry the clone's
    0-based index as a structured field, so hosts can demux concurrent
    clones without parsing it out of the `"<name>:spawn#<n>"` `agentName`.

## 0.3.0

### Minor Changes

- 1a9df08: Add a host-facing `Agent.spawn(spec, opts?)` method. It runs an ephemeral
  clone of the agent on a typed sub-task directly from host code — the
  symmetric counterpart of the agent-authored `spawn` builtin, with the same
  `SpawnSpec` and semantics (shared policy + `/skills`, depth-1, output
  enforce-and-retry, read-only `view`, failure-as-rejection, cancellation via
  `signal`). Runs cold; no live parent task required. Each call gets its own
  concurrency semaphore bounded by `maxSpawns`.

## 0.2.0

### Minor Changes

- da49328: Raise the default per-emission wall-clock timeout from 5s to 5 minutes (`evalRuntime` and `workerRuntime`). Unlike agex-py — whose AST-instrumented sandbox has a separate instruction (tick) limit as the runaway guard — agex-ts has no tick limit, so the wall-clock budget is the _only_ bound and must therefore cover legitimate long host-side awaits (a large `fetch`, a slow registered fn, a multi-step host call), not just compute. 5s was too tight for those. A genuine runaway is still capped by this budget (the worker is force-killed on expiry); a tighter instruction/tick budget remains a possible future addition. Override per runtime via `timeoutMs`.
- 82856bb: Batch truncation is now observable, and successful file ops are acknowledged. When a recoverable error truncates a multi-emission action, the trailing emissions that never ran render an explicit skip notice ("Not executed — an earlier action in this turn raised an error…") instead of "(no observation)". This also fixes a latent bug where a dropped `write_file`/`edit_file` rendered a synthesized "wrote <path>" success line, falsely reporting a call that never executed as succeeded — naming the skipped calls lets the agent re-issue only those rather than replaying the whole batch (which silently double-applies the ones that did run). Successful `write_file`/`edit_file` now emit a `✓ write_file: <path>` / `✓ edit_file: <path>` `SystemNote`, mirroring agex-py's `sync_loop`: the renderer skips `systemNote` events so the LLM's view is unchanged, but the embedder receives a discrete in-turn success signal via `onEvent`.
- 4f7eae9: Output validation is now enforced but recoverable. Previously, a `taskSuccess` value that failed the task's `output` schema hard-rejected the whole task with a `SchemaError` the agent never saw. Now the mismatch is surfaced to the agent as a system reminder, costs one iteration, and lets it re-issue `taskSuccess` with a corrected value — a persistent mismatch is bounded by `maxIterations` and becomes the terminal failure only on exhaustion (the message carries the validation detail). Mirrors agex-py's return-type idiom, where a mismatch is a recoverable error counted against the loop rather than a hard fail.
- 242b322: Add `spawn` — agent-authored ephemeral sub-tasks. Under a spawn-capable runtime (the same-realm `evalRuntime` for now), a top-level agent's code gets a `spawn` builtin that runs an ephemeral, memoryless clone of the agent to fulfil a typed sub-task: `await spawn('summarize /docs/spec.md')`, or the structured form `await spawn({ task, input, output })` where `output` is a JSON Schema the result is validated against. Fan out with native `Promise.all`; concurrency is bounded by the new `maxSpawns` agent option (default 8; set `0` to disable).

  Clones run the same task loop on throwaway state (fresh in-memory event log + cache, a blank VFS with the parent's `/skills` overlay mounted), so nothing touches the parent's session and clone events stream to `onEvent` (tagged `<name>:spawn#<n>`) without entering the durable log. Clones are depth-1 (no nested `spawn`), inherit the parent's registrations, and inherit output enforce-and-retry. A clone failure rejects the `spawn` promise as an ordinary recoverable error the parent can catch or surface — never as the parent's own failure.

  The worker-runtime bridge for `spawn` is a follow-up; under the worker runtime `spawn` is not yet injected (and the primer won't teach it).

- d443474: `spawn` gains a `view` option: read-only access to part of the parent's filesystem. `spawn({ task, view: '/data' })` (or `view: ['/data', '/config']`) exposes those parent VFS paths to the clone **read-only at the same location** — the clone reads `/data/...` like the parent does, writes there throw, and everything else is its own throwaway scratch. Lets a sub-task explore real files without copying them in. Works on both runtimes (it's a host-side `MountFS` composition over the parent's backing FS; the worker bridges clone reads to it). Snapshot/frozen views remain a follow-up — `view` is a live read-only window.
- a7ee5f7: `spawn` now works under the worker runtime. Building on the concurrent-execute support, agent code in the worker can call `spawn(spec)` to run an ephemeral clone: a dedicated `spawnCall` bridge message (reusing the existing `bridgeResponse` + callId machinery, like `newInstance`/`instanceCall`) carries the spec to the host, which runs the clone and replies with its result — the parent emission parks at `await spawn(...)` while the clone's emissions run as concurrent executes on the same worker. `workerRuntime` now reports `injectsSpawn`, and the per-run `spawnEnabled` flag keeps clones depth-1 (no nested `spawn`).

  Sub-task clones now also get a short primer note (on any runtime): they have their own scratch VFS reachable via `fs.read`/`fs.write`, but third-party libraries that `fetch` URLs won't reach it. `routeFetchToVfs`'s transparent redirect is top-level-only — under concurrency (the global `fetch` shim has no per-execute context in a browser worker) it passes through to the network, so clones use explicit `fs.*` (or bytes-shuttling) for VFS data.

## 0.1.1

### Patch Changes

- 690308c: `fileEdit` is more forgiving and fails more loudly. A non-`matchAll` edit now errors when the search string occurs more than once (instead of silently editing the first match), and a not-found search that differs only by typographic look-alikes (curly quotes, em-dashes) or Unicode normal form now reports the likely cause. When an exact match isn't found, two fallbacks recover the common near-misses: trailing-whitespace-flexible matching and indent-flexible matching (the replacement is re-indented to the file's baseline). Matching tolerates LF or CRLF files, and fuzzy replacements are normalized to the file's existing line endings.
