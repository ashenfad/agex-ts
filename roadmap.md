# agex-ts: Roadmap

Tracks deferred work — items we know we want, scoped well enough to
pick up later without re-deriving the analysis. Live priorities go
here; once an item is in flight, it moves out (PR description carries
the detail). Once shipped, delete the entry.

[`docs/`](docs/) describes what's currently shipped. This document is
for known-wanted work that hasn't shipped yet.

---

## Deferred

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

### `@agex-ts/git` — agent-view git over the agent's VFS

**Why it matters.** Port of agex-py's `agent_git`: branches, an index,
and a commit log on the agent's VFS files, layered over kvgit. Gives
agents undo / branching / diff / time-travel for iterative work in
their workspace. Aligns with the embeddable LLM-work primitive thesis
— file content lives in the same versioned substrate as agent state,
so a `git commit` is a true snapshot and rollback rolls everything
back together.

**Prerequisite.** The unified-kvgit-substrate work (in progress /
landed) is a hard prereq — `@agex-ts/git` has nothing to commit
against until VFS contents live in the same versioned store as
agent state.

**Scope.**

- Port `agent_git` from agex-py: `metadata.ts`, `refs.ts`,
  `core.ts`, `cli.ts`. ~1400 LOC of mostly mechanical translation
  (sync → async, monkeyfs path encoding → KvgitFS `f:` / `d:`
  prefix, `difflib.unified_diff` → npm `diff` wrapper).
- Termish-ts API expansion: optional `extras` field on
  `CommandContext`, threaded through `execute()`. ~15 LOC. Lets
  registered commands reach beyond `fs` for substrate access (git
  needs the `Staged` and `Versioned` handles).
- Subcommands: `log`, `diff`, `status`, `branch`, `checkout`,
  `commit`, `reset`, `show`, `merge`, `add`, `rm`. Same surface as
  agex-py.
- Diff library wrapper (`diff` npm + binary-detect heuristic).
- Test suite mirroring agex-py's coverage.

**Architectural notes.**

- agex-py's substrate model with one polymorphic encoder is the
  target — both file content and agent state live in the same
  `VersionedKV` and one commit captures both atomically. The
  unified-substrate prereq delivers this.
- `_flush_alignment` pattern (commit `info: undefined` to advance
  the kvgit chain after a file rewrite, without a virtual commit)
  works with kvgit-ts's fast-forward path unchanged.
- Path encoding is simpler than Python's: `f:/path` / `d:/path`
  prefixes from `KvgitFS`, no monkeyfs `__vfs_` poke-into-internals.
- Metadata blob (`__agex_git__`) sits at a no-prefix key, naturally
  invisible to FS operations. Encode as a `FileRecord` with
  `isDir: false` and JSON-bytes content, or via the polymorphic
  encoder's JSON branch — depends on what the unified substrate
  settles on.

**Estimate.** ~1500 LOC port, 3 focused sessions. Risk concentrated
in (a) async refactor of pervasive sync iteration patterns and
(b) the edge cases around `Staged`'s selective commit + buffered
removal semantics — the agex-py tests cover these well, so mirroring
the suite catches drift.

**Defer rationale.** Substrate unification first. Once that's in,
this lands cleanly without architectural surprises.
