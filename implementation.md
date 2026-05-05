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
- **`Dummy` LLM client** — first-class shipped test double, ports
  agex-py's `agex/llm/dummy_client.py`. Lives in core (no provider
  dep), exported from `agex-ts/llm-dummy`. Used by agex-ts's own
  tests *and* by downstream consumers writing tests for their own
  agents without spending tokens.
- Chaptering machinery (`design.md` §6.7).
- `viewImage(...)` built-in helper for image OutputEvents.
- *Not in v1*: multi-agent, setup parameter, agent-side LLM access,
  per `design.md` §11.

**Cross-cutting decisions.**

| Decision | Choice |
|---|---|
| Async surface | Async end-to-end. No sync mirrors of LLM/runtime APIs (Pyodide-compatibility was an agex-py concession; TS has no equivalent constraint). |
| State storage | `kvgit-ts` `VersionedKV` for the durable path, `Live` (in-process Map) for ephemeral. Same `Versioned`-shaped surface for both so the Agent code is unaware. |
| Cancellation | `AbortSignal` from v1, threaded through both `RuntimeAdapter.execute` and `LLMClient.complete`. Worker-side cancellation reads a state-key sentinel since Workers can't observe an `AbortSignal` directly. |
| Schema validation | [`@standard-schema/spec`](https://standardschema.dev/) — pluggable validators (zod, valibot, arktype, etc.) for task input/output. |
| Prominence model | Binary, presence-of-description. No numeric tiers — see `design.md` §5.7. |
| Registration timing | Eager — every registration call validates and updates the policy table immediately; cached primer/dependency snapshots invalidate on registration. |
| Event log key generation | ISO-8601 timestamp prefix with collision suffix; chronological iteration is `keys.sort()`. |
| Error classification | Provider/runtime errors surface as `TransientError` (retry candidate) or `FatalError` (reraise) — retry budget is centralized in the agent loop, never inside the SDK. |
| Sub-path exports | Yes — `agex-ts/types`, `agex-ts/state` so consumers can pull the contract surface without dragging the agent runtime. |
| Module / target | ESM-only, `target: ES2022`, `moduleResolution: Bundler`. |
| TS strictness | `strict: true` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`. |

**Concrete contracts.** Live in `packages/agex-ts/src/types.ts` — that
file is the canonical source for signatures; this doc defers to it.
Major shapes (mirror `design.md` §4.5, §4.6, §5, §8.3, §9.2):

- **`Agent`** — class with the `design.md` §4.5 constructor surface.
  Carries a `Policy` (registration table), a `StateConfig`, an
  optional `FSConfig`, an `LLMClient`, a `RuntimeAdapter`, and the
  five registration methods plus `task()`, `state(session)`,
  `fs(session)`, `cache(session)`.
- **`TaskFn<I, O>`** — `(input: I, options?: TaskCallOptions) => Promise<O>`.
- **`TaskCallOptions`** — `{ session?: string; signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void; onToken?: (t: TokenChunk) => void }`.
- **`Emission`** — discriminated union over `'ts' | 'terminal' |
  'fileWrite' | 'fileEdit' | 'text' | 'thinking'`. Each variant
  carries its own fields plus optional `signature?: Uint8Array` for
  provider-native round-trip (Claude thinking blocks, Gemini
  `thought_signatures`).
- **`AgentEvent`** — discriminated union of the v1 event types:
  `TaskStartEvent`, `ActionEvent` (carries `emissions: Emission[]`,
  preserving order), `OutputEvent`, `SuccessEvent`, `FailEvent`,
  `ClarifyEvent`, `CancelledEvent`, `ChapterEvent`, `FileEvent`,
  `ErrorEvent`, `SystemNoteEvent`. Every event carries `timestamp`
  (ISO 8601 UTC), `agentName`, optional `commitHash`, optional
  `parentRef` (kvgit commit hash threading task ancestry), optional
  token estimates.
- **`TokenChunk`** — streaming chunk: `{ type, content, done,
  emissionIndex, emission?, signature?, inputTokens?, outputTokens? }`.
  `type` ranges over the same set as `Emission` plus internal
  markers (`'title'`, `'tool_start'`, `'signature'`).
- **`Chapter`** — `{ start: string; end: string; name: string;
  message: string }`. `start`/`end` are state keys bracketing the
  range being summarized.
- **`RuntimeAdapter`** (`design.md` §8.3) — interface with three
  methods: `init(policy)`, `execute(code, opts)` returning
  `Promise<ExecResult>`, `dispose()`. `ExecResult = { error:
  TaskOutcome | Error | null; outputs: OutputPart[]; elapsedMs: number;
  inputTokens?: number; outputTokens?: number }`. `TaskOutcome` is the
  discriminated union `{ kind: 'success'; value: unknown }` |
  `{ kind: 'fail'; message: string }` |
  `{ kind: 'clarify'; message: string }` | `{ kind: 'continue' }`.
- **`LLMClient`** (`design.md` §9.2) — interface with
  `complete(request, signal)` returning `AsyncIterable<TokenChunk>`,
  plus `dumpConfig()` for serialization, plus a `summarize(...)`
  helper used by chaptering. `LLMRequest` carries `system`, `events`,
  `tools` (normalized schemas), and `cacheBoundaries` (the markers a
  provider adapter places into its wire format).
- **`Dummy` LLM client** — concrete `LLMClient` implementation that
  cycles through a scripted sequence of `LLMResponse | Error` items.
  Constructor: `new Dummy({ responses?, summaryResponse?, summaryError? })`.
  Surface:
  - `responses: Array<LLMResponse | Error>` — cycled by
    `callCount % responses.length`. An `Error` entry is thrown on
    that turn (simulates provider failure mid-task).
  - Inspection state: `callCount: number`, `allSystems: string[]`,
    `allEvents: AgentEvent[][]`, `allRenderedMessages: unknown[][]`.
    Tests assert against these to verify what the agent sent.
  - Runs the same event-rendering pass real provider clients use,
    so any image-export or serialization bug surfaces in tests
    before it hits a real provider.
  - `summarize()` returns `summaryResponse` (default: a
    deterministic stringification of inputs) or throws
    `summaryError` if set — lets chaptering tests cover both paths.
  - `dumpConfig()` / `Dummy.fromConfig(cfg)` serialize the scripted
    response list (Errors are stripped, since they don't
    structured-clone) so a `StateConfig`-tracked agent reconstitutes
    the same dummy on another process. Mirrors agex-py exactly.
- **`Policy`** — registration table built incrementally by `agent.fn`
  / `.cls` / `.namespace` / `.skill` / `.terminal`. Carries
  `RegisteredFn`, `RegisteredCls`, `RegisteredNs`, `RegisteredSkill`,
  `RegisteredTerminal` records. The runtime adapter consumes it at
  `init()` to scope the agent's name resolution.
- **Persistence APIs**: `Cache` (typed Map-shaped, `set`/`get`/`has`/
  `delete`/`keys`, all async), `VirtualFileSystem` (re-exported from
  termish-ts's `FileSystem` protocol), `EventLog` (append-only,
  `add(event) => Promise<string>`, `iter() => AsyncIterable<AgentEvent>`,
  `at(commitHash)` for time-travel views).
- **Errors**: `TaskFailError`, `TaskClarifyError` (thrown from inside
  `ts` emissions by the injected `taskFail` / `taskClarify`); base
  `AgentError`; runtime/provider errors classified as `TransientError |
  FatalError` for the retry layer.

**Pitfalls and lessons from agex-py.**

- **Emission order is load-bearing for prompt caching.**
  `ActionEvent.emissions` carries the LLM's exact output sequence
  (interleaved thinking, code, file actions, tool calls). Every
  emission may carry an opaque provider signature (Claude thinking
  blocks, Gemini `thought_signatures`) that the next turn's request
  must echo verbatim — providers reject mismatched signatures with
  "invalid block signature" errors, and the resulting cache miss
  invalidates hours of context. Treat emissions as an ordered
  sequence with immutable signatures from the moment of capture; do
  not filter, reorder, or re-encode them when rendering the event
  log back to the provider.

- **Fingerprint changes invalidate the agent's cached state.**
  agex-py's `_update_fingerprint` clears the cached dependency graph
  on every registration call. The TS analogue: any `agent.fn` /
  `.cls` / `.namespace` / `.skill` / `.terminal` call invalidates
  the cached primer/policy snapshot. Lazy recomputation on first
  use is fine, but the cache lifetime is registration-driven, not
  time-driven. Don't snapshot outside the agent.

- **Cancellation reaches sandboxed code via state polling, not
  signals.** A worker can't observe a parent-thread `AbortSignal`
  directly. The pattern: when the host signal fires, the agent
  loop writes a sentinel key to the session's state; the runtime
  adapter checks for it at safe points (between iterations of
  agent-authored loops, before injecting `taskSuccess`-class raises)
  and raises a `CancelledError` inside the worker. Outer worker
  termination is the fallback, not the primary path — termination
  loses partial work.

- **Description-presence is the only prominence lever.** Per
  `design.md` §5.7, agex-ts has no per-registration
  `visibility: high|medium|low` enum. Presence of `description:` in
  the registration call is the lever — described items go in the
  primer, undescribed ones don't. This is a deliberate
  simplification from agex-py; resist requests to add tiers, since
  doing so re-creates the agex-py footgun of "the agent has no idea
  this method exists because it's hidden."

- **`ChapterEvent` is summarization, not deletion.** The events it
  replaces in the rendered context still live in the event log
  (referenced by `eventRefs: string[]`). `state.events()` and
  `state.checkout()` resolve through chapters to the originals.
  Test that listing events from a chaptered session returns the
  full unsummarized history; only the *primer rendering* uses the
  chapter summary.

- **Live host instances stay on the host; the worker accesses them
  through an RPC proxy.** A live instance (DB connection, open file
  handle, socket) can't structured-clone into a Web Worker, but the
  same is already true of the `fs` and `cache` host APIs — the
  runtime adapter handles them by exposing a host-side proxy whose
  method calls become postMessage round-trips. `agent.namespace
  (instance, ...)` works the same way: the instance stays where it
  was registered, and the agent's `import { db } from 'db'` resolves
  to a Proxy in the worker that forwards method calls. Consequences
  agents and authors need to know:
  - **All proxied methods are async**, even ones that were
    synchronous on the host. Acceptable because TS is async-first;
    document the pattern in the registration help.
  - **Per-call postMessage overhead.** Microseconds in-browser —
    fine for studio-style work — but the agent should not call the
    proxy in a tight inner loop.
  - **Method arguments and return values must structured-clone.**
    The instance itself doesn't cross; what crosses per call is the
    args (host-bound) and the return value (worker-bound). Same
    `DataCloneError` surface as `fs` / `cache`.
  - **Iterators and async iterators need explicit support** in the
    proxy layer (postMessage doesn't stream natively); the runtime
    adapter wraps an `AsyncIterable` return into a chunked-message
    protocol.
  - **The fail-loud case is narrow**: a live instance the agent
    tries to *return* through `taskSuccess(...)` hits structured-
    clone on the way out. Method-call usage is fine; only escaping
    the worker as a value fails.

  Same-realm execution (no worker boundary, sync method calls) is
  expressible as an alternative runtime adapter — see `design.md`
  §8.4 — but `@agex-ts/runtime-worker` is the default and what the
  studio path targets.

- **VFS modules persist as agent-authored helpers; the cache does
  not.** Agents mutate code in `helpers/*.ts` and import from there
  in later `ts` emissions. Caching arbitrary closures or live
  references in the typed cache is unsafe (no structured-clone
  guarantee). Document the boundary clearly: "code goes in the VFS;
  data goes in the cache."

- **The bare-`except` rewrite from agex-py doesn't translate.**
  agex-py rewrites `except:` and `except Exception:` clauses to skip
  the framework's task-control raises. TS has no equivalent rewrite
  hook; agent-authored `try { ... } catch (e) { ... }` *will* swallow
  task-control exceptions. Mitigation: make `TaskFailError` /
  `TaskClarifyError` instances carry a brand symbol, document that
  agents should re-throw branded errors, and surface a
  `SystemNoteEvent` warning on first occurrence per task. Tracked
  in `design.md` §4.3 and the appendix.

- **The optional sync API was an agex-py concession, not a goal.**
  agex-py exposes both `complete()` and `acomplete()` because
  Pyodide-hosted contexts need a sync pathway. TS has no equivalent
  constraint — every storage and provider call is async from the
  start. Don't ship sync mirrors of `LLMClient` / `RuntimeAdapter`
  surface.

**Verification.**

- **Registration round-trip.** Each kind (`fn`, `cls`, `namespace`,
  `skill`, `terminal`) builds the right `Policy` entry; the
  description-presence flag tracks correctly; `include`/`exclude`
  patterns filter as expected; `agent.terminal`'s description
  requirement is enforced (it has no docstring fallback in JS).

- **Task lifecycle without an LLM.** A stub `LLMClient` returns a
  scripted sequence of emissions; a stub `RuntimeAdapter` echoes
  them as outcomes. End-to-end task call exercises the action loop,
  the emission dispatcher (`ts` → runtime, `fileWrite` → fs,
  `fileEdit` → fs, `terminal` → termish-ts via injected handlers,
  `text` / `thinking` → log only), and task-control exits
  (`taskSuccess` resolves the value, `taskFail` rejects with
  `TaskFailError`, `taskClarify` rejects with `TaskClarifyError`).

- **Event log + persistence.** With kvgit-ts as the state backend,
  events written through one `Agent` instance are readable through
  a fresh `Agent` instance pointed at the same `VersionedKV`.
  ChapterEvent rendering: a chaptered log returns the original
  events from `state.events()` but the primer (when re-rendered)
  shows the summary. `state.checkout(commitHash)` returns a
  read-only view at the historical commit.

- **Cache and VFS host APIs.** `agent.fs(session).write(...)` is
  visible to a subsequent `ts` emission's `fs.read(...)` (via the
  termish-ts VFS); `agent.cache(session).set/get` round-trips typed
  values through the kvgit-ts staging buffer; deleting and re-
  reading is idempotent; `keys()` enumerates all live entries.

- **Chaptering trigger.** `shouldTriggerChaptering(events,
  threshold)` reads the last `ActionEvent.inputTokens` (real
  provider count) and fires above threshold. The `__chapter__` task
  is invoked with the right input shape and the returned `Chapter[]`
  produces correctly-bounded `ChapterEvent`s.

- **AbortSignal propagation.** Aborting mid-task writes a
  cancellation sentinel into state; the next `RuntimeAdapter.execute`
  call raises `CancelledError`; the outer task call rejects with
  the same error and emits a `CancelledEvent` rather than a regular
  `SuccessEvent` / `FailEvent`. Worker termination is exercised as
  the fallback path.

- **Schema validation.** Task input validates against the supplied
  Standard Schema (zod / valibot / arktype examples in the test
  matrix). Output validation runs on `taskSuccess`'s value; a
  schema-rejecting value rejects the outer task call (no silent
  coercion).

- **Provider-signature round-trip.** With a recording stub provider:
  capture an `ActionEvent` carrying thinking-block signatures,
  persist it, replay through a fresh task call, and verify the
  rendered event log presents the same signatures byte-for-byte.
  Regression guard against accidental re-encoding.

- **`Dummy` LLM behavior.** A scripted response list cycles
  correctly across multiple turns (`callCount % len`); inserting an
  `Error` mid-list throws on that turn and surfaces as a
  `FailEvent` with the original cause; `allSystems` / `allEvents`
  capture every input the agent sent; `dumpConfig()` →
  `fromConfig()` produces an equivalent client (modulo `Error`
  entries, which are documented to drop); `summarize()` honors the
  configured response or throws the configured error. Plus a
  rendering-pass test: registering an unsupported image type in an
  emission triggers the same warning string the real clients
  produce, surfaced via `allRenderedMessages`.

- **Cross-package smoke.** A scripted demo constructs an Agent with
  a `MemoryFS`-backed kvgit `VersionedKV`, registers a `helloWorld`
  namespace and a custom `agent.terminal` command, runs a one-turn
  task driven by `Dummy` emitting one `ts` and one `terminal`
  action, and asserts the resulting event log + cache + VFS state.

**Build order within agex-ts core.**

The order favors building inward-out: contracts first, persistence
second, agent surface third, action loop last. A working end-to-end
smoke with stub adapters lands before any real runtime or provider
is wired.

1. Skeleton: package.json (workspace deps on `kvgit-ts` +
   `termish-ts`), tsconfig, vitest, tsup. Sub-path exports for
   anything a consumer might import without dragging the agent
   runtime in (`agex-ts/types`, `agex-ts/state`).
2. **Types module** (`src/types.ts`) — discriminated unions
   (`Emission`, `AgentEvent`, `TokenChunk`, `TaskOutcome`),
   contracts (`RuntimeAdapter`, `LLMClient`), registration record
   types. No runtime code, just the surface.
3. **`Live` state** — in-memory MutableMap analogue. No kvgit-ts
   dependency. Used as a fallback storage and for tests that don't
   want commit overhead.
4. **State adapter** — polymorphic over `Versioned` (kvgit-ts) and
   `Live`. `connectState({ type, storage, path? })` factory per
   `design.md` §6.5.
5. **`EventLog`** — append-only over the state adapter, with
   `ChapterEvent` resolution. Timestamp-based key generation
   (collision-handled), `add(event)` / `iter()` / `at(commitHash)`.
6. **VFS host API** — `agent.fs(session)` returning a `FileSystem`
   (the termish-ts protocol) backed by a kvgit `Staged` namespace
   per session.
7. **Cache host API** — `agent.cache(session)` returning a typed
   Map-shaped surface backed by a different kvgit `Staged` namespace
   per session.
8. **`Policy`** — registration table. Implement each registration
   method one-by-one with eager validation: `fn`, `cls`, `namespace`,
   `skill`, `terminal`. Pattern matching for `include`/`exclude`
   reuses termish-ts's glob helper.
9. **`Agent` class** — constructor, registration delegation,
   fingerprint computation, `state()` / `fs()` / `cache()`
   inspection methods.
10. **Stub `RuntimeAdapter`** — pure-JS evaluator that runs code in
    the same realm with policy-injected names; skips sandboxing
    entirely. Used only in tests; never shipped.
11. **`Dummy` LLM client** — first-class shipped artifact (sub-path
    export `agex-ts/llm-dummy`). Cycles through a scripted
    `Array<LLMResponse | Error>`, exposes inspection state
    (`callCount`, `allSystems`, `allEvents`, `allRenderedMessages`),
    runs the same event-rendering pass as real providers, supports
    configurable `summarize()` for chaptering tests, and round-trips
    through `dumpConfig()` / `fromConfig()` so a reconstituted
    `StateConfig` produces an equivalent client. Used by agex-ts's
    own integration tests *and* shipped to downstream consumers
    writing tests for their own agents.
12. **Task lifecycle** — `agent.task({ description, input, output })`
    factory returning a `TaskFn<I, O>`. Action loop:
    `LLMClient.complete()` → emissions → `RuntimeAdapter.execute()`
    → outcome → next turn or terminal outcome. Threads `AbortSignal`
    through both adapters.
13. **Emission dispatcher** — routes each emission type to the right
    handler: `ts` → runtime, `fileWrite` → VFS, `fileEdit` → VFS
    with diff-apply, `terminal` → registered terminal handlers (via
    termish-ts's pipeline executor + the agent's policy table),
    `text` / `thinking` → no side effect, just logged.
14. **Chaptering machinery** — `shouldTriggerChaptering` check after
    each `ActionEvent`; invokes the agent's registered `__chapter__`
    task; resolves `Chapter[]` to `ChapterEvent`s.
15. **Inspection surface** — `state.events()`, `state.checkout()`,
    `state.commitInfo(hash)` per `design.md` §6.6.
16. **End-to-end smoke** — full integration test using stub runtime
    + stub LLM + kvgit `MemoryStore` + termish-ts `MemoryFS`.
    Exercises a multi-turn task with a chaptering boundary and an
    AbortSignal cancellation.
17. **Public API surface freeze** — once the smoke passes, lock the
    `RuntimeAdapter` and `LLMClient` contracts so the runtime-worker
    and Anthropic provider packages can build against stable shapes.

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

**Concrete contracts.** Live in
`packages/runtime-worker/src/types.ts`. Major shapes:

- **`workerRuntime(opts)`** — factory returning a `RuntimeAdapter`
  (the contract from agex-ts core). Options:
  - `target?: 'auto' | 'browser' | 'node'` (default `'auto'`)
  - `workerUrl?: string | URL` (browser only; defaults to a sibling
    file the package emits)
  - `esbuild?: { wasmURL?: string; transformOptions?: TransformOptions }`
    — esbuild config for `ts` stripping. `wasmURL` only applies in
    the browser; Node uses the native binary.
  - `console?: 'capture' | 'pass'` — by default, captured `console.*`
    becomes `OutputEvent`s. Pass-through is for debugging.
  - `timeoutMs?: number` — per-emission wall-clock budget. Hitting
    it terminates the worker; the next emission gets a fresh one.
- **Worker message protocol** — small discriminated union over
  `postMessage`: `{ type: 'execute'; code; namespace; signalKey }`,
  `{ type: 'cancel' }`, `{ type: 'fs-call'; ... }`,
  `{ type: 'cache-call'; ... }`, `{ type: 'namespace-call';
  namespace; member; args; callId }` (RPC for runtime → host calls
  on registered live instances), `{ type: 'namespace-yield';
  callId; value; done }` (chunked iterator returns from the host
  side), `{ type: 'output'; ... }`, `{ type: 'result'; ... }`.
  Every payload must structured-clone.
- **Module resolution policy** — bare imports route to the policy
  table (resolved by name); relative imports route to the VFS;
  builtins (`crypto`, `text-encoding`, etc. on a small allowlist)
  are unconditional; everything else throws
  `ModuleNotAllowedError`. Policy enforcement happens in the
  worker's loader hook (Node) or import-map (browser).
- **`ExecResult`** — matches the agex-ts core contract:
  `{ error: TaskOutcome | Error | null; outputs: OutputPart[];
  elapsedMs: number }`.

**Pitfalls and lessons from agex-py.**

- **Worker termination is the only reliable kill.** There is no
  mid-instruction interrupt for either Web Workers or
  `worker_threads` — `AbortSignal` propagation requires cooperative
  checks. Bake in a pattern: the agent loop writes a cancellation
  sentinel into the session state; the runtime checks for it at
  safe points (between worker-side iterations, before injecting
  `taskSuccess`-class raises). When the timeout truly trips,
  `worker.terminate()` is the fallback; partial outputs from before
  termination still surface as `OutputEvent`s.

- **esbuild-wasm load is a multi-second startup cost.** Browsers
  download ~5MB of wasm on first transform. Preload at `Agent`
  construction (or expose a `prepareRuntime()` async hook) so the
  first task doesn't pay it. Cache the wasm in the worker's scope.

- **Structured-clone is the boundary.** Any value crossing
  `postMessage` — host → worker (namespace, fs results) or worker →
  host (outputs, exec result) — must structured-clone-able. No
  functions, no closures, no class instances with private state.
  Non-cloneable values surface as `DataCloneError`; catch and
  rethrow with a useful message identifying the offending key.

- **Browser import-map cache-busting.** Once an import-map is
  installed in a worker, mutating it requires a fresh worker. Plan
  for one worker per task call (the cost is small) rather than
  attempting in-flight policy mutation. agex-studio's worker
  reload-on-policy-change pattern is the model here.

- **Node loader hooks differ from `--experimental-vm-modules`.**
  The worker must use the loader-hook API
  (`register('./loader.mjs')`) so dynamic imports route correctly.
  Don't try to share the parent thread's module cache.

- **`console.*` capture races with `result` emit.** Without
  buffering, a worker that calls `console.log` then immediately
  `taskSuccess(...)` can have the result message overtake the
  output messages. Flush outputs before sending `result`.

- **No equivalent of CPython's instruction counting.** agex-py
  enforces a tick limit at the bytecode level via sandtrap; TS has
  no analogue. The closest substitute is wall-clock `timeoutMs`
  plus an esbuild transform that injects abort-checks at loop
  entries. Document the gap; users who need stricter caps should
  reach for a heavier sandbox (isolated-vm on Node, SES Compartments
  in the browser — both deferred per `design.md` §11).

- **Live host instances are exposed via host-side proxies, not
  serialized.** The same RPC pattern that already carries `fs` and
  `cache` calls back across the worker boundary handles
  `agent.namespace(instance, ...)`. The instance stays where it
  was registered; the worker sees a Proxy whose method invocations
  postMessage the call and await the response. Implementation
  notes specific to the runtime:
  - The proxy is built from the policy's per-member `configure`
    table — only `include`-allowed methods are reachable, and the
    proxy's `get` trap raises `MemberNotAllowedError` for the
    rest. Don't expose unknown members.
  - All methods on the proxy return `Promise<T>` regardless of the
    host method's actual return type. Document this in the
    namespace's auto-generated primer entry so the agent writes
    `await db.query(...)` instead of bare `db.query(...)`.
  - Method arguments are structured-cloned host-bound; return
    values are structured-cloned worker-bound. Surface
    `DataCloneError` with the offending parameter name.
  - For methods that return an `AsyncIterable`, the proxy uses a
    chunked-message protocol: each `yield` is its own postMessage,
    and the worker-side iterator awaits the next chunk. Test with
    a streaming registration (e.g. a database cursor).
  - Synchronous methods on the live instance are *called*
    synchronously on the host side of the bridge; only the
    worker-side wrapper is async. No re-entrancy issue.

**Verification.**

- Per-target test matrix: Vitest in Node mode for `worker_threads`,
  Vitest browser mode (Playwright) for the Web Worker path. Same
  test bodies run in both modes via shared fixtures.

- **Smoke**: a `ts` emission with `import { greet } from 'helloWorld'`
  resolves the policy entry, calls it, captures `console.log`
  output, and returns `taskSuccess(value)`. Captured output and
  result round-trip back through the worker boundary correctly.

- **Cancellation**: a long-running emission (`while (true) {}`) is
  aborted via the AbortSignal pathway; verify the worker is
  terminated within `timeoutMs` and the parent receives a
  `CancelledError` with any partial output collected before
  termination.

- **Module-policy enforcement**: unregistered bare imports
  (`import x from 'random-package'`) throw `ModuleNotAllowedError`;
  registered names resolve; relative imports against the VFS work
  for both `./helpers/x.ts` and `../something/y.ts` (rejecting
  paths that escape the session root).

- **esbuild integration**: a `ts` emission with TS-only syntax
  (interfaces, type imports, `as const`) transpiles correctly in
  both targets; a syntax error surfaces as a structured error
  rather than a silent worker crash.

- **Per-emission timeout**: a slow emission (`await sleep(10000)`)
  is killed at `timeoutMs` and the next emission in the same task
  gets a clean worker.

- **Round-trip with kvgit-ts state**: writes from a `ts` emission
  via `cache.set(...)` are visible to the next `ts` emission via
  `cache.get(...)` after the agent loop has staged + committed the
  intervening turn.

- **Live-instance namespace proxy**: register a host-side instance
  with a synchronous method (`add(a, b) => a + b`), an async method
  (`fetchUser(id) => Promise<User>`), and an async-iterable method
  (`stream() => AsyncIterable<Row>`). A `ts` emission imports the
  namespace, awaits each variant, and confirms (a) all calls work
  through the worker boundary, (b) the synchronous host method is
  await-able from the worker side, (c) the async-iterable
  round-trips chunk-by-chunk via `namespace-yield`, and (d)
  unregistered members raise `MemberNotAllowedError` rather than
  silently returning `undefined`.

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

**Note on test doubles.** No provider package ships its own dummy
or mock client. The `Dummy` LLM lives in agex-ts core
(`agex-ts/llm-dummy`) because it's provider-agnostic and pulling a
real provider SDK in just to satisfy the `LLMClient` interface is
overkill. Provider packages' own tests use canned SSE fixtures (see
Verification below) to exercise the SDK-specific stream-parsing
path; the `Dummy` covers the agent-facing `LLMClient` shape.

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

**Pitfalls and lessons from agex-py.**

- **Cache markers, not arbitrary cache keys.** Each provider has a
  specific way to flag where the prefix-cacheable boundary is.
  Anthropic uses `cache_control: { type: 'ephemeral' }` on a
  message; OpenAI relies on stable-prefix automatic caching and
  doesn't accept a marker; Gemini exposes a `cachedContent` field
  via `genai.caches`. The provider adapter places these markers at
  the right boundary (system + tools + history-prefix), and the
  agex-ts core builds the request with that ordering in mind.

- **Tool-schema-shape drift is the main porting risk.** Each
  provider names the same primitives differently (`tools` vs
  `functions` vs `function_declarations`), with subtly different
  parameter shapes and slightly different streaming event names for
  tool-call deltas. Build a translation layer (the `WireFormat`
  abstraction in agex-py) that takes agex-ts's normalized schemas
  and emits each provider's exact wire shape — and a complementary
  parser that turns the provider's streaming event sequence into
  agex-ts's `TokenChunk` stream.

- **Reasoning models change the request shape.** OpenAI's `gpt-5` /
  `o-series` use the Responses API (different endpoint, different
  request fields); Anthropic's extended thinking has a separate
  `thinking: { type: 'enabled', budget_tokens: N }` block; Gemini's
  thought parts surface as a separate content type. Auto-detect on
  model name (`gpt-5*`, `o[1-9]*` → Responses; `claude-3.5*` and
  later support extended thinking; etc.) but expose explicit
  overrides for users.

- **Don't retry inside the SDK.** agex-py disables provider-SDK
  retries (`max_retries=0`) and lets the agent loop handle
  classification (timeouts and rate-limits → transient → retry;
  parse errors and 4xx → fatal → reraise). This keeps the retry
  budget centralized and avoids exponential-backoff stacking. TS
  provider packages should set `maxRetries: 0` on each SDK and
  surface `TransientError` / `FatalError` on the way out.

- **Streaming-edge cases bite first.** Each provider emits subtly
  different event sequences when a tool call has zero arguments,
  when a reasoning-only response with no text comes back, when a
  rate-limit fires mid-stream, and when the connection drops
  without a clean end. Test these explicitly with canned SSE
  fixtures (one fixture per edge case per provider).

- **Signatures are opaque blobs that round-trip.** Don't decode
  them. Don't filter or skip emissions that carry one. Don't
  re-encode text adjacent to them. Provider signatures are
  validated server-side against a hash that includes the surrounding
  content; any perturbation breaks the next request.

- **OpenAI-compatible endpoints work via `baseUrl` override.** Don't
  ship a separate `@agex-ts/openrouter` package. Document
  `baseUrl` + `apiKey` in the OpenAI client's options as the path
  for OpenRouter, Together, Anyscale, etc.

- **Gemini's function-call argument serialization is fussy.** It
  expects strict JSON with no trailing commas or `undefined`
  fields; the SDK doesn't always normalize. Run the rendered
  arguments through `JSON.parse(JSON.stringify(...))` before
  handing them to the SDK to strip `undefined`s.

**Verification.**

- **Fixture-based streaming tests.** Per provider, capture or write
  canned SSE response sequences for: a simple text response, a
  single tool call, multiple sequential tool calls, an interleaved
  thinking + tool-use response, a zero-argument tool call, a
  cache-hit response (token counts reflect cache), and a mid-stream
  error. Each fixture round-trips through the provider client into
  agex-ts's `TokenChunk` stream and asserts the right emission
  shape and order.

- **Schema translation correctness.** A normalized agex-ts
  tool-schema input produces the right wire shape for each provider.
  Sample registrations (a function with primitives, with nested
  types, with optional fields, with array types) all translate
  without loss.

- **Cache-marker placement.** With a provider-aware mock that
  echoes the cache markers back, verify the right boundaries get
  marked: system + tools (one marker) and the history-prefix (one
  or two markers depending on provider).

- **Live integration tests** — gated on `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY` / `GOOGLE_API_KEY`. Each provider runs a tiny
  end-to-end `helloWorld` task with a real model. Workflow lives
  outside the default CI run; fires on schedule + manual trigger,
  with cost ceilings.

- **Error classification.** Inject HTTP 429, 500, network
  disconnect, and parse-error responses; verify each surfaces as
  `TransientError` (with a backoff hint) or `FatalError` (with the
  raw cause attached).

- **Reasoning-model routing.** A request to `gpt-5-mini` hits the
  Responses endpoint; a request to `gpt-4o` hits Chat Completions;
  the explicit `useResponses: true | false` override forces either
  path regardless of model.

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
