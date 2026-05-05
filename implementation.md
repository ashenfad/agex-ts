# agex-ts: Implementation Plan

> **Status:** Scaffolded. Component sections fill in iteratively as
> implementation begins. `design.md` is the source of truth for
> *what* we're building; this document covers *how, in what order,
> and where to look for inspiration*. When a section here disagrees
> with `design.md`, design wins — fix this document.

## Build order

Bottom-up by dependency:

1. **`kvgit-ts`** — foundation. No agex-ts dependencies; can be
   built standalone. Provides the versioned KV store agex-ts core
   uses for state (`design.md` §6).
2. **`termish-ts`** — foundation. No agex-ts dependencies; can be
   built standalone. Provides the shell layer agex-ts core uses for
   `terminal` emissions (`design.md` §4.2).
3. **`agex-ts` core** — depends on `kvgit-ts` (state) and
   `termish-ts` (terminal). Defines the contracts
   (`RuntimeAdapter`, `LLMClient`) that runtime and provider
   packages implement.
4. **`@agex-ts/runtime-worker`** — depends on `agex-ts` core
   (specifically the `RuntimeAdapter` contract). Default v1 runtime.
5. **LLM provider packages** (parallel with #4) — depend on
   `agex-ts` core (specifically the `LLMClient` contract). Each
   provider package ships independently. First-priority is
   `@agex-ts/anthropic`; `@agex-ts/openai` and `@agex-ts/gemini`
   follow the same pattern.

```
kvgit-ts ─┐
          ├─→ agex-ts core ─→ @agex-ts/runtime-worker
termish-ts┘                ├─→ @agex-ts/anthropic
                           ├─→ @agex-ts/openai
                           └─→ @agex-ts/gemini
```

Within #3 (agex-ts core), expect a chicken-and-egg phase: the
contracts that #4 and #5 implement *are part of* agex-ts core.
Approach: sketch the contracts first based on `design.md` §8.3 and
§9.2; let `runtime-worker` and the first LLM provider exercise them;
revise the contracts when real usage surfaces issues. Aim to **ship
something end-to-end fast** (kvgit-ts + termish-ts + agex-ts core +
runtime-worker + Anthropic provider) before broadening to the rest.

## Component plans

### `kvgit-ts`

**Purpose.** Versioned KV store with branches, commits, and merges.
Powers agex-ts's persistence model (`design.md` §6). Sessions are
branches; every agent action commits a checkpoint; the HAMT
underneath makes branching cheap.

**Inspiration / starting points.**

- **agex-py's `kvgit` source** (`~/git/kvgit/`) — primary reference.
  Specifically: `kvgit/hamt.py` (HAMT data structure),
  `kvgit/versioned/kv.py` (commit log + branch CAS + recovery),
  `kvgit/versioned/merge.py` (three-way merge resolution, ports
  cleanly), `kvgit/versioned/keyset.py` (HAMT wrapper carrying
  `KeysetEntry`), `kvgit/staged.py` (buffered writes),
  `kvgit/namespaced.py` (key-prefix view), `kvgit/kv/base.py`
  (`KVStore` ABC with CAS + bulk methods),
  `kvgit/kv/indexeddb.py` (IDB patterns; ports with simplifications
  — see Pitfalls).
- **agex-studio's persistence wiring** — the browser-side
  diskcache+sqlite-on-OPFS setup is a working example of running a
  KV store on non-traditional storage. Less directly applicable to
  TS, but illustrates the mount-and-flush pattern.
- **Standard JS KV libraries** worth surveying: `idb` (IndexedDB
  promise wrapper), `better-sqlite3` / `node:sqlite` (Node),
  `lmdb-js` (if LMDB ever becomes a backend). These are the drivers
  our storage backends wrap.

**v1 scope.**

In:
- `KVStore` interface with first-class CAS plus bulk methods
  (`getMany`, `setMany`, `removeMany`).
- HAMT — content-addressable, 16-way (hex nibbles of SHA-256),
  default `bucketMax = 8`, JSON-serialized nodes with sorted keys
  for canonical hashing, base64-encoded values inside leaves. The
  `_try_collapse` invariant (`hamt.py:532`) is load-bearing for
  hash determinism; port carefully with fixtures.
- `Keyset` — kvgit-specific HAMT wrapper carrying
  `KeysetEntry = (blob_pointer, MetaEntry)`.
- `Versioned` protocol — full surface: read (`get`, `getMany`,
  `keys`, `peek` — cross-branch read without switching), write
  (`commit` with `onConflict` / `mergeFns` / `defaultMerge` /
  `info`), navigation (`refresh`, `checkout`, `createBranch`,
  `deleteBranch`, `switchBranch`, `resetTo`, `history`,
  `listBranches`), inspection (`commitInfo`, `diff`, `parents`),
  plus the `currentCommit` / `baseCommit` / `latestHead` /
  `currentBranch` / `initialCommit` properties and
  `lastMergeResult`.
- `VersionedKV` — concrete `Versioned` over a `KVStore`. Includes
  `info` dict pass-through and prev-HEAD backup written before each
  CAS for recovery.
- `Staged` — buffered writes over `Versioned`, atomic flush via
  `commit()` with optional per-key `mergeFns` and `defaultMerge`.
  Map-shaped surface for reads/writes; per-call generics for
  typed access (`staged.get<Model>('model')`).
- `Namespaced` — key-prefix view over any Map-shaped store; nests
  cleanly.
- Three-way merge (`resolveMerge`) with `MergeConflict` for
  unresolvable contested keys.
- `cleanOrphans` with `minAge` guard and **young-orphan blob
  protection** (preserves blobs/chunks referenced by in-flight
  writers whose CAS hasn't landed).
- Recovery: prev-HEAD backup written before each CAS, with
  fallback to it when current HEAD is invalid. Slot-but-no-impl
  for the commit-scan fallback (the second-tier recovery in
  kvgit-py's `_resolve_head`); shipped as an injection point so
  the implementation can land later without restructuring.
  Synthetic-corrupt-store test infra ships in v1 so both tiers
  are testable.
- Backends: `memory` (always), `indexeddb` (browser), `sqlite`
  (Node — `node:sqlite`, requires Node 22.5+). `KVStore` interface
  for custom backends.

Out (deferred per `design.md` §11):
- Custom value codecs (chunked dedup of large numpy/pandas-style
  buffers).
- Storage format compatibility with kvgit-py — greenfield, no
  migration story.
- Commit-scan fallback in `_resolve_head` (slot-only in v1).
- `Live` — that's an agex-ts state primitive, not a kvgit one.
- OPFS as a first-party backend — the `KVStore` interface lets
  users plug their own OPFS implementation in the meantime; we
  re-evaluate when a real consumer measures it as necessary.

**Cross-cutting decisions.**

| Decision | Choice |
|---|---|
| Async surface | Async end-to-end. Memory backend wraps sync ops in resolved promises so the API doesn't change between dev and prod. |
| Hashing | SubtleCrypto SHA-256 (browser + Node 19+, no import — available on `globalThis.crypto.subtle`). |
| HAMT serialization | JSON with sorted keys + base64-encoded values inside leaves — matches kvgit-py's hashing scheme so we can reuse correctness fixtures. |
| HAMT branching | 16-way (hex nibbles of SHA-256), default `bucketMax = 8`. Matches kvgit-py. |
| `info` dict | `Record<string, unknown> \| undefined` on commits, surfaced via `commitInfo()`. |
| `history()` | `AsyncIterable<string>` with `allParents` flag — preserves laziness for long histories. |
| Concurrency | Optimistic with `ConcurrencyError` on branch-update CAS, no locking. |
| Sub-path exports | Yes — `kvgit-ts/backends/idb`, `kvgit-ts/backends/sqlite`, etc., so unused backends tree-shake out of bundles. |
| TS strictness | `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. |
| Module / target | ESM-only, `target: ES2022`, `moduleResolution: Bundler`. |

**Concrete contracts.** Live in `packages/kvgit-ts/src/types.ts` —
that file is the canonical source for signatures; this doc defers
to it. Major shapes:

- `KVStore` (CAS, bulk reads/writes, async iteration)
- `Versioned` (full surface enumerated above)
- Errors: `ConcurrencyError`, `MergeConflict`
- Data: `MetaEntry`, `KeysetEntry`, `HamtDiff`, `DiffResult`,
  `MergeResult`
- Functions: `BytesMergeFn`, `MergeFn<T>`, `Encoder<T>`,
  `Decoder<T>`
- Unions: `ConflictDisposition` (`'raise' | 'merge' | 'skip'`)

`Hamt`, `Staged`, `Namespaced`, `VersionedKV` are concrete
classes; their constructors and method signatures live alongside
the implementations and re-export through `src/index.ts`.

**Pitfalls and lessons from agex-py.**

- **HAMT `_try_collapse` is load-bearing.** Without it, the
  invariant "same logical contents → same root hash" breaks and
  structural sharing across versions silently degrades. Port with
  collapse-equivalence fixtures (delete-then-collapse should
  produce the same root hash as the never-overflowed version).
- **Prev-HEAD backup recovers from the common HEAD-corruption
  case.** Cheap (one extra write per CAS); high-value when
  storage partial-writes happen — browser tab close mid-IDB-
  transaction is the most likely failure mode.
- **IndexedDB `onblocked` is "promise never resolves," not
  technically a deadlock.** Fires when a stale connection holds
  the DB open. Fix: attach an `onblocked` handler that rejects
  with a clear actionable error. (Re-word
  implementation.md / design.md anywhere the "deadlock" framing
  appears.)
- **IndexedDB request handlers must be attached synchronously
  before any await.** Otherwise the event loop can complete the
  request before handlers exist → silent loss. Strict
  "create request, attach handlers, then await" discipline. The
  module docstring at `kvgit/kv/indexeddb.py:38` has the
  authoritative explanation.
- **The WASM-memory-view structured-clone workaround in
  kvgit-py's IndexedDB module does NOT apply to TS** — drop
  entirely. Native ArrayBuffer/Uint8Array round-trips through
  structured-clone fine.
- **`cleanOrphans` must protect young-orphan blobs/chunks** —
  they may belong to in-flight writers whose CAS hasn't landed.
  Walk young orphans during the mark phase even though the
  commits themselves aren't deleted until they age past the
  `minAge` cutoff (default 1 hour).
- **Browser storage is more corruption-prone than server
  SQLite.** Tab close, browser crash, OPFS quirks, IDB
  version-upgrade edge cases. Bias toward including defensive
  primitives (prev-HEAD, recovery slot) even if they feel like
  overkill — the studio-style scenarios will hit these failure
  modes that server-side kvgit-py rarely sees.
- **`Live` does not belong in kvgit-ts.** kvgit-py exports
  `Staged`, `Versioned`, `VersionedKV`, `Namespaced` only — the
  `Live` type is in `agex/state/` and belongs in agex-ts core.

**Verification.**

- HAMT correctness fixtures: insert/delete/iterate parity with
  a reference `Map`. Includes the `_try_collapse` test (delete-
  then-collapse should produce the same root hash as the never-
  overflowed version). Reuse kvgit-py fixtures where storage
  layouts permit.
- Branch isolation: writes on a fork don't leak to parent.
- Three-way merge: non-overlapping changes auto-merge; contested
  keys with no merge fn raise `MergeConflict`; per-key fns and
  `defaultMerge` resolve appropriately; same-change-on-both-sides
  isn't a conflict.
- Recovery: synthetic-corrupt-store test infra. Verify prev-HEAD
  fallback recovers from invalidated current HEAD; verify the
  commit-scan slot is wired (returns null in v1, doesn't crash).
- `cleanOrphans`: orphaned commits + their HAMT nodes + their
  blobs are removed; reachable commits preserved; young orphans
  protected; HAMT nodes shared by multiple deleted commits
  removed exactly once.
- Backend conformance: each backend (memory, IDB, SQLite) passes
  the same interface-conformance suite. CAS is correctness-critical
  and tested under simulated concurrent access where the backend
  supports it.
- Browser tests via Vitest browser mode (Playwright) for IDB; Node
  tests for memory and SQLite.

**Build order within kvgit-ts.**

1. Skeleton: package.json, tsconfig, vitest, tsup.
2. `KVStore` interface + `Memory` backend + bulk-method tests.
3. HAMT — pure data structure, parity-tested against reference
   `Map`. Standalone; no kvgit-specific concerns.
4. `Keyset` (HAMT wrapper carrying `KeysetEntry`).
5. `VersionedKV` — commits, branches, three-way merge, prev-HEAD
   backup, `info` pass-through.
6. `Staged` + `Namespaced`.
7. `cleanOrphans` (depends on `Keyset.walk` + history).
8. End-to-end smoke: branches, commits, merges, GC against
   memory backend.
9. IndexedDB backend (with the two lessons baked in: handle
   `onblocked`, attach handlers synchronously).
10. SQLite backend (Node, via `node:sqlite`).
11. *(deferred)* OPFS backend — see `design.md` §11.

---

### `termish-ts`

**Purpose.** Shell parser + builtin commands operating over an
async `FileSystem` interface. Powers agex-ts's `terminal` emissions
(`design.md` §4.2). Custom commands plug in via `agent.terminal` —
agex-ts core provides that hook on top of termish-ts's lower-level
registration mechanism.

**Inspiration / starting points.**

- **agex-py's `termish` source** (`~/git/termish/`) — primary
  reference. Shell parser (pipelines, redirects, semicolons,
  quoting, line continuation), the bundled builtins (`ls`, `cat`,
  `grep`, `find`, `sed`, `tr`, `wc`, `sort`, `uniq`, `cut`, `tar`,
  `gzip`, `diff`, `xargs`, etc.), the `CommandContext` pattern.
  Skip the `jq` engine — deferred per `design.md` §11.
- **agex-studio's esbuild terminal command** —
  `agex-studio/public/python/agent_modules.py` `_register_esbuild` —
  concrete example of a complex custom command (esbuild-wasm
  bundling) registered as a shell builtin. Useful template for any
  consumer building rich custom commands on top of `agent.terminal`.
- **Existing TS shell tooling** worth surveying for sub-problems:
  `shell-quote` (npm, argument tokenization), `mvdan/sh` (Go, but
  the AST shape is informative). Don't depend on these for parser
  work; survey to avoid reinventing solved primitives.

**v1 scope.**

In:
- Shell parser with full termish-py surface: pipes (`|`), redirects
  (`<`, `>`, `>>`), pipeline operators (`;`, `&&`, `||`), single +
  double quoting, line continuation, fd-1/2 stderr discard.
- Async interpreter with `AbortSignal` support (agex's task loop is
  cancellable; long-running `find` / `grep` should bail at iteration
  boundaries).
- **Full builtin parity with termish-py minus `jq`** —
  ~30 commands across filesystem (`pwd`, `cd`, `ls`, `mkdir`,
  `touch`, `cp`, `mv`, `rm`, `basename`, `dirname`), I/O (`echo`,
  `cat`, `head`, `tail`, `tee`), search (`grep`, `find`),
  text (`wc`, `sort`, `uniq`, `cut`, `tr`, `sed`), `diff`,
  `xargs`, archive (`tar`, `gzip`, `gunzip`, `zip`, `unzip`).
- Own `FileSystem` interface (~12 async methods + cwd state). The
  in-memory file metadata an interactive shell needs (`stat()` size
  + mtime) doesn't exist on `node:fs/promises` cleanly, and the
  shell needs cwd state which `fs.promises` lacks — so we define
  our own protocol and ship adapters.
- **Three FS adapters** in v1:
  - `MemoryFS` — in-process, for tests + ephemeral use
  - `RealFS` — hits the actual disk on Node; wraps `node:fs/promises`
    + tracks cwd. Useful for direct termish-ts consumers (CLI tools)
    and e2e tests; agex agents intentionally don't reach for it (they
    get `MemoryFS` or `KvgitFS` per design.md's sandbox-vs-host model).
  - `KvgitFS` — backed by a `Staged<Uint8Array>` from `kvgit-ts`,
    so agent shell sessions get versioning / branching / merge for
    free. Sub-path export `termish-ts/fs/kvgit`; `kvgit-ts` is a
    peer dependency. Synthesizes `stat()` from value byte length;
    real `MetaEntry` exposure on `Staged` can come later.
- Standalone `glob()` helper (`*`, `?`, `[abc]`, `**`) over the
  `FileSystem` listing primitives — backends don't need to
  implement glob themselves.
- Custom command registration mechanism (`CommandContext` +
  injected commands map, with injected names overriding builtins).

Out (deferred):
- `jq` engine — per `design.md` §11. Agents working with JSON in
  `terminal` emissions can use registered helpers or `ts`
  emissions with `JSON.parse` plus lodash/object navigation.

**String pipelines + binary archive constraint.** Stdin / stdout
between pipeline stages are `string`s (matches termish-py, simplest
mental model, covers all text builtins). Archive commands that
would write binary to a string pipeline (`tar -c` with no `-f`,
`gzip -c`, etc.) raise a meaningful `TerminalError` directing the
agent to use a file (`-f file` or `> redirect`). Archives operate
on FS files for round-tripping; pipeline binary streaming is out of
scope. (Same constraint as termish-py.)

**Cross-cutting decisions.**

| Decision | Choice |
|---|---|
| Async surface | Async end-to-end. FS calls are async; builtins are async; pipeline executor awaits each stage. |
| Pipeline data type | `string` between stages; binary handled at FS boundaries (read/write bytes, in-memory text). |
| Cancellation | `AbortSignal` on `CommandContext` from v1. Loop-heavy builtins (grep, find, xargs) check at iteration boundaries. |
| Globbing | Standalone helper over FS listing primitives. Backends do not implement `glob()`. |
| Quote masking | Hand-port from termish-py's `quote_masker.py` — preserves quoted wildcards through tokenization. |
| Tokenization | Hand-rolled (no JS equivalent of Python's `shlex`). Same token vocabulary. |
| Sub-path exports | Yes — `termish-ts/fs/memory`, `/fs/real`, `/fs/kvgit` so unused adapters tree-shake. |
| Archive deps | `tar-stream` (tar I/O), `fflate` (zip + DEFLATE) as runtime deps. gzip uses Node `node:zlib` and browser `DecompressionStream` — no extra dep. |

**Concrete contracts.** Live in `packages/termish-ts/src/types.ts`
(or the relevant module for each shape) — that file is the
canonical source. Major shapes:

- `Script`, `Pipeline`, `Command`, `Redirect` (AST)
- `CommandContext` (args, stdin, stdout, fs, env, signal),
  `CommandResult` (exitCode, stderr)
- `CommandHandler` (`(ctx) => Promise<CommandResult | void>`)
- `FileSystem` interface (~12 async methods), `FileMetadata`,
  `FileInfo`
- Errors: `TerminalError`, `ParseError`

**Pitfalls and lessons from agex-py.**

- **`shlex.shlex(posix=True, punctuation_chars=True)`** is doing
  real work. The TS hand-rolled tokenizer needs to handle:
  - Single + double quoting with escape inside doubles
  - Punctuation as separate tokens (`ls|grep` → `[ls, |, grep]`)
  - Word characters: alphanumeric + `:@,%+!^` (so `user@host`
    stays one token)
  - Newlines as separators (not whitespace)
- **Quote masker preserves quoted wildcards.** Without it, `'*'`
  gets unquoted and globbed; with it, the literal `*` survives.
  This is how `grep '*' file` works correctly.
- **Injected commands override builtins** — the priority isn't
  "fall back to builtin"; it's "user-registered name *replaces*
  the builtin of the same name."
- **String pipelines + binary archives**: write a clear error
  message when an archive command would emit binary to a string
  pipeline. Agents need to know how to adapt (use `-f file` or
  redirect to a file).
- **`AbortSignal` discipline**: builtins that loop check at the
  top of each iteration. Failure to check leads to runaway commands
  the host can't cancel.
- **`KvgitFS`'s file metadata gap**: `Staged` doesn't expose
  `MetaEntry` (size + createdAt). v1 synthesizes `stat()` from
  `value.byteLength` and uses an unknown-mtime sentinel. If a
  consumer needs real meta, extend kvgit-ts's `Staged` to expose
  `KeysetEntry` directly.

**Verification.**

- Parser: fixture tests for shell-grammar edge cases (nested
  quotes, escaped quotes, line continuation, `2>` discard,
  trailing pipe error, etc.).
- Interpreter: pipeline correctness with redirects, exit-code
  propagation through `&&` / `||`, `AbortSignal` cancellation at
  iteration boundaries, injected-command override.
- Builtins: per-command behavior tests against `MemoryFS`. The
  archive commands test the file round-trip (`tar -czf` then
  `tar -tzf`) plus the binary-to-pipeline error.
- FS adapters: `MemoryFS` and `KvgitFS` exercised by the same
  conformance suite (when extracted); `RealFS` tested against
  a temp directory.
- End-to-end: a story-shaped flow exercising parser →
  interpreter → builtins → MemoryFS, plus `KvgitFS` with branching.

**Build order within termish-ts.**

1. Skeleton: package.json, tsconfig, vitest, tsup.
2. AST + errors + `CommandContext`.
3. Parser: tokenizer + quote masker + AST builder.
4. `FileSystem` protocol + `MemoryFS` + standalone `glob` helper.
5. Interpreter core (pipeline executor, redirects, injected
   commands, `AbortSignal`) — with `echo` + `cat` only as
   throwaway builtins for the early end-to-end signal.
6. Filesystem builtins (10).
7. I/O builtins (5).
8. Text builtins (5).
9. Search builtins (`grep`, `find` — full flag coverage).
10. `diff`.
11. `sed` (full).
12. `xargs`.
13. Archive (`tar` via `tar-stream`, `gzip`/`gunzip` native, `zip`/`unzip` via `fflate`).
14. `RealFS` adapter.
15. `KvgitFS` adapter (sub-path export, `kvgit-ts` peer dep).
16. End-to-end smoke.
17. CI (Node-only — no browser-specific behavior).

---

### `agex-ts` core

**Purpose.** The `Agent` class, `task` / registration surface, event
log machinery, cache + VFS APIs, runtime-adapter glue, LLM-client
glue, chaptering. Implements the action loop (`design.md` §4),
registration model (§5), and persistence model (§6). No LLM SDK
dependency.

**Inspiration / starting points.**

- **agex-py's source** (`~/git/agex/`) — the entire framework is
  the reference. Per area:
  - `agex/agent/agent.py` — Agent class shape, registration methods,
    constructor options.
  - `agex/agent/events.py` — event taxonomy and lifecycle.
  - `agex/agent/emissions.py` — emission shapes.
  - `agex/eval/` — evaluation loop semantics. **Note**: `sandtrap`
    integration is Python-specific and doesn't translate; the loop
    *structure* does.
  - `agex/state/` — state container patterns
    (`Staged`/`Live`/`Versioned` boundary).
  - `agex/agent/chaptering.py` — chaptering trigger and
    `__chapter__` task wiring.
- **agex-studio's `streaming.py`** for streaming integration
  patterns (event/token interleaving with `asyncio.CancelledError`
  recovery — the cancel-bypass-path lesson is real and applies).
- **Vercel AI SDK** (`ai` package) — useful as *contrast*: shows
  the standalone-LLM-SDK shape we're explicitly *not* building, but
  the streaming and tool-use abstractions are well-shaped TS to
  compare against. Look at how they normalize across providers.

**v1 scope.**

- `Agent` class with `design.md` §2 / §4.5 constructor surface.
- `agent.task({ ... })` factory returning a typed callable
  (`design.md` §4.5).
- Registration methods: `agent.fn`, `agent.cls`, `agent.namespace`,
  `agent.skill`, `agent.terminal` (`design.md` §5).
- Event log with the v1 event types from `design.md` §4.6
  (including `ChapterEvent`).
- Cache and VFS host-side APIs (`design.md` §6.2, §6.3).
- Inspection surface (`agent.state(session)`, `state.events()`,
  `state.checkout()`).
- `RuntimeAdapter` contract (`design.md` §8.3).
- `LLMClient` contract (`design.md` §9.2).
- Chaptering machinery (`design.md` §6.7).
- `viewImage(...)` built-in helper for image OutputEvents.
- *Not in v1*: multi-agent, setup parameter, agent-side LLM access,
  per `design.md` §11.

**Concrete contracts.** `[TBD]` — formal TypeScript signatures for
`Agent`, `TaskFn`, `TaskCallOptions`, every event type, every
emission type, `TokenChunk`, `RuntimeAdapter`, `LLMClient`,
`AgentEvent` discriminated union, `Chapter` constructor args.

**Pitfalls and lessons from agex-py.** `[TBD]` — expect lessons
about system-message construction (cache-friendliness matters from
day one), event-log token estimation (the `low_detail_tokens`
shape), chaptering trigger heuristics, the bare-`except` rewrite
(we can't replicate; document the limitation per `design.md` §4.3
and the appendix).

**Verification.** `[TBD]` — unit tests for registration, task
definition, event log construction, chaptering boundary detection,
schema validation. Integration tests using the runtime-worker +
Anthropic provider for an end-to-end smoke flow.

---

### `@agex-ts/runtime-worker`

**Purpose.** Default v1 runtime adapter. Web Worker on browser,
`worker_threads` on Node. Implements the `RuntimeAdapter` contract
defined by agex-ts core. Per `design.md` §8.

**Inspiration / starting points.**

- **agex-studio's Worker setup** —
  `agex-studio/public/worker.js` — concrete example of running an
  LLM-driven sandbox in a browser Worker. The Pyodide bootstrapping
  isn't applicable, but the message-passing patterns, bridge setup,
  and OPFS persistent-mount patterns are.
- **Node's `worker_threads` documentation** — for the Node-side
  setup. Less mature ecosystem than browser Workers; expect more
  bespoke glue. The `worker_data` and `parentPort` APIs are the
  primary message-passing surface.
- **esbuild's API documentation** for transpilation entry points.
  `esbuild-wasm` (browser) and the native `esbuild` binary (Node)
  share an API; pick at adapter init based on environment. The
  `transform` entry point is what we want for per-emission TS
  stripping; the `build` entry point handles agent-authored
  `helpers/*.ts` modules with imports.

**v1 scope.**

- Web Worker (browser) + `worker_threads` (Node) with a thin
  unified abstraction.
- esbuild-based transpilation (wasm in browser, native in Node).
- Module resolution against the policy table — importmap-based on
  browser, custom loader on Node.
- `console.*` capture, message-passing fs/cache bridges.
- Per-emission timeout enforcement (terminate worker on budget
  exceeded).
- AbortSignal honoring at event-loop tick boundaries.
- *Not in v1*: hard memory limits, mid-instruction cancellation,
  SES Compartments, isolated-vm, iframe primitives.

**Concrete contracts.** `[TBD]` — `workerRuntime(options)` factory
signature, platform-specific options (e.g., `Worker` URL handling
for browsers, `eval: true` for Node Workers), the structured-clone
boundary semantics.

**Pitfalls and lessons from agex-py.** `[TBD]` — most agex-py
runtime work is Python-specific (sandtrap), but expect lessons from
agex-studio's Worker integration: cancellation bypass paths
(asyncio.CancelledError recovery), localStorage shimming,
import-map cache-busting, and the policy-table-injection ordering.

**Verification.** `[TBD]` — dual-target test matrix per `design.md`
notes (Vitest in Node mode + Vitest browser mode via Playwright).
At minimum: end-to-end smoke test that runs a `ts` emission and
returns a result, on both platforms.

---

### LLM provider packages

This section covers the shared structure across `@agex-ts/anthropic`,
`@agex-ts/openai`, `@agex-ts/gemini`, with provider-specific notes
at the end.

**Purpose.** Implement the `LLMClient` contract for each provider.
Each package depends on the provider's official SDK as a peer
dependency. Per `design.md` §9.

**Inspiration / starting points.**

- **agex-py's LLM clients** —
  - `agex/llm/pyfetch_anthropic.py` — Anthropic streaming, tool
    use, prompt caching.
  - `agex/llm/pyfetch_openai.py` — OpenAI tool calls, reasoning
    handling, OpenAI-compatible endpoint patterns.
  - `agex/llm/pyfetch_gemini.py` — Gemini function calling, thought
    parts.

  The `pyfetch_*` flavors are designed for Pyodide's HTTP shape
  (no sync shims) and translate most cleanly to TS.
- **agex-studio's `bridge_llm.py`** — adapter pattern for routing
  through host-side fetch (relevant to how the agex-ts provider
  package bridges to the SDK without owning auth).
- **Each provider's official TS SDK** — `@anthropic-ai/sdk`,
  `openai`, `@google/generative-ai`. Each exposes streaming and
  tool-use primitives we wrap thinly.

**v1 scope per provider.**

- `complete()` returning an async iterable of provider-specific
  token chunks.
- Tool-schema translation from agex-ts's normalized list to the
  provider's format.
- Error classification (transient vs fatal) for the framework's
  retry logic.
- AbortSignal honoring on the in-flight HTTP request.
- **Prompt caching support** (`design.md` §9.4 — load-bearing):
  - **Anthropic**: emit `cache_control` markers at the optimal
    boundaries (system prompt, tool definitions, message history).
  - **OpenAI**: ensure stable-prefix shape so the provider's
    automatic caching kicks in.
  - **Gemini**: explicit context cache management when configured.

**Provider-specific notes.**

- **Anthropic** — extended thinking has a budget-tokens shape;
  expose via `thinkingBudget` option. Cache control is the most
  expressive caching surface across providers; place markers at
  three points (system, tools, history-prefix).
- **OpenAI** — handle the o-series / GPT-5 reasoning shape vs the
  standard GPT shape; both share the SDK but use different request
  fields. OpenRouter and other OpenAI-compatible endpoints work
  via `baseUrl` override; don't ship a separate OpenRouter package.
- **Gemini** — function calling shape differs from tool-use; the
  translation layer needs to be careful about argument
  serialization. Thought parts surface as a separate content type.

**Pitfalls and lessons from agex-py.** `[TBD]` — expect lessons
about streaming-edge-case handling, the precise error-class
boundary between transient and fatal, cache-marker placement
specifics, and Gemini's odd response shapes (especially around
streaming tool calls).

**Verification.** `[TBD]` — fixture-based tests with mock provider
responses (canned SSE streams from each provider); live integration
tests gated on env-var API keys and run in CI on a separate
workflow.

---

## Cross-cutting infrastructure

### Repository tooling

`[TBD]` — pnpm workspaces; Changesets for coordinated releases;
TypeScript config (target, lib, strictness flags); ESLint /
Biome / oxlint choice; Prettier or Biome for formatting; commit
hooks.

### Test matrix

`[TBD]` — Vitest in Node mode for the bulk of unit + integration
tests; Vitest browser mode (Playwright-backed) for `runtime-worker`
browser-side tests; CI matrix with Node 20/22 × Linux/macOS for
Node tests, plus Chromium/Firefox/WebKit for browser tests; live
LLM-provider tests gated on env vars and run in a separate workflow.

### Build & bundling

`[TBD]` — per-package build configs (likely `tsup` or `tsdown` for
the libraries; the `runtime-worker` package needs special handling
for the Worker entry point and the esbuild-wasm asset). Browser
bundle sizes worth tracking — esbuild-wasm is the largest single
payload at ~5MB.

### Documentation

`[TBD]` — TypeDoc for auto-generated API reference per package;
hand-written getting-started guide and key examples in a `docs/`
directory at repo root; `examples/` directory with runnable
scenarios mirroring `design.md` §2 (Hono server, VS Code extension
shell, browser data tool); README files per package linking to
TypeDoc and the relevant `design.md` section.

### Release & versioning

`[TBD]` — Changesets workflow (each PR adds a changeset noting
patch/minor/major); pre-1.0 conventions per `design.md` §12 (minor
bumps may include breaking changes; consumers pin); LLM-provider
and runtime-adapter packages version independently of agex-ts core
but coordinated through Changesets. Initial release after the
end-to-end smoke flow (kvgit-ts + termish-ts + agex-ts core +
runtime-worker + Anthropic provider) is green on both Node and
browser.
