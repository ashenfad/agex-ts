# agex-ts

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
