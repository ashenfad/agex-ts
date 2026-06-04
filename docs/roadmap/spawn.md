# Spawn: agent-authored sub-tasks for agex-ts

**Status: design.** Grounded against agex-ts source (`task.ts` task loop,
`runtime/eval.ts` and `agex-runtime-worker` injection + bridge protocol,
`agent.ts` registration). Translates the shipped agex-py `spawn` API
(`agex/agent/spawn.py`) into idioms that fit agex-ts's eval framework, which
differs from agex-py's substantially. This is a *translation*, not a port: the
two pillars that make the Python surface elegant (runtime type annotations and
a synchronous Futures shim) don't survive the move, and the ts execution model
hands us simpler replacements.

## Summary

Let an agent decompose its own work at runtime — define an ad-hoc sub-task and
run it (or fan many out) as an ephemeral, memoryless clone of itself — without
the host wiring a sub-agent ahead of time:

```ts
// one-shot, prose contract
const summary = await spawn("Summarize /docs/spec.md in three bullets")

// structured contract when validation/shape matters
const tile = await spawn({
  task: "Produce a 64×64 SVG tile",
  input: { prompt: "a small castle" },
  output: { type: "object", properties: { svg: { type: "string" } } },
})

// fan-out is native — no custom map/submit surface
const tiles = await Promise.all(
  prompts.map((p) => spawn({ task: "Produce a tile", input: { prompt: p } })),
)
```

A clone runs the **same** `makeTask` loop, with the **same** registered
capabilities (policy), on **fresh ephemeral state** (blank VFS, no cache, no
durable log), with `spawn` itself stripped from its namespace so clones are
depth-1 leaf workers.

## Why

agex-ts already supports *host-wired* sub-agents: a task function returned by
`agent.task({...})` is a plain `async (input) => Promise<O>`, so you can
register one agent's task as another agent's capability with
`orchestrator.fn(subTask, { name, description, paramsSchema })`. That covers
**static** delegation — the topology is fixed by the host at build time.

What it can't do is let the agent decide, mid-run, to split a problem into N
pieces it only just discovered and fan them out. That ad-hoc, self-similar
decomposition is the whole reason `spawn` exists. Two concrete shapes it
unlocks:

- **Fan-out over discovered work** — the agent reads a directory, finds 30
  files, and runs one sub-task per file concurrently.
- **Context isolation** — a self-contained sub-task (draft an artifact,
  research one point) runs in a clean context and returns just its result, so
  the parent's working context isn't polluted by the sub-task's intermediate
  reasoning.

## Three agex-ts differences that reshape the Python design

The Python design rests on two things agex-ts doesn't have, and is constrained
by a third it does. Each one changes the surface.

### 1. Type annotations are erased at runtime

agex-py's `@spawn.task def make(p) -> Tile: ...` works because Python keeps
`-> Tile` as a live, introspectable annotation. The *entire*
`_collect_seed_classes` machinery — finding the sandbox-defined classes named
in the signature, injecting the real class objects into the clone, rejecting
quoted forward-refs — exists to exploit that.

agex-ts strips types with `ts-blank-space` before the runtime ever sees the
code (`runtime/eval.ts`). `-> Tile` is whitespace by execution time. There is
no signature to introspect, no return-type class to find.

**Consequence:** the typed-decorator shape — the thing that made Python
`spawn` ergonomic — has no analogue. The contract must be expressed as a
*value*: a description string, plus (optionally) a plain JSON-schema object.
The agent still writes `const tiles: Tile[] = await ...` for its own
reasoning, but that annotation does not participate in the mechanism, and we do
**not** port the seed-class machinery.

### 2. Agents already live in `async`/`await`

agex-py built the whole `submit` / `.result()` / `map` / `Future` surface
specifically to *hide* async from the model. agex-ts agents emit `await`
natively — the runtime even has dedicated "you forgot to `await` your
terminator" handling (`makeMissingAwaitError` in `runtime/eval.ts`).

**Consequence:** the Futures shim is pure overhead. `Promise.all` *is*
`spawn.map`. We drop `submit`/`Future`/`map` entirely; fan-out comes from the
language. The only reason to bound concurrency is resource control, handled
invisibly with a semaphore (see [Concurrency](#concurrency)).

### 3. The production runtime boundary is data-only

agex-ts's production runtime is `@agex-ts/runtime-worker`. Anything crossing
the worker boundary is structured-cloned — it **cannot** carry class identity.
Python's "the real `Tile` class flows into the clone by reference" only worked
because Python clones run in-process.

**Consequence:** sub-agent results cross as plain structured data, validated
against the optional `output` schema when one is supplied. This isn't a
limitation we're accepting so much as one the execution model already imposes —
and it reinforces (1):
there's nothing to inject because there's nothing that survives the boundary
anyway.

## Agent-facing surface

`spawn` is a single injected builtin, callable two ways:

```ts
// prose form — returns the sub-agent's taskSuccess value (unknown)
function spawn(task: string): Promise<unknown>

// spec form
function spawn(spec: {
  task: string                 // the sub-task description (the contract)
  input?: unknown              // bound to the clone's `inputs`
  output?: object              // JSON schema; enforced (see Contract & validation)
  outputDescription?: string   // prose shape hint
  primer?: string              // sub-task-specific framing
  view?: string | string[]     // mount a read-only view of the parent's VFS
                               //   into the clone (e.g. "explore these files")
}): Promise<unknown>
```

`view` lets the parent hand the clone a **read-only** window onto its own VFS —
the "explore these files" case. It is *not* a new filesystem type: it compiles
to a `MountFS` mount of the parent session's backing FS at a fixed prefix
(e.g. `/workspace`), and `MountFS` already rejects writes to a mounted overlay,
so read-only falls out for free. Reads under the prefix see the parent's files;
all clone writes go to its throwaway scratch (see Clone construction). Omitting
`view` gives a fully blank clone FS.

It joins the existing injected builtins (`taskSuccess`, `taskFail`, `cache`,
`fs`, `inputs`, `__load`) in both `runtime/eval.ts` and the worker. Fan-out is
plain `Promise.all`. There is intentionally no `spawn.map` / `spawn.submit` /
`spawn.all`.

The spec maps directly onto an on-the-fly `TaskDefinition`
(`task` → `description`, `input` → validated input, `output` →
`outputJsonSchema`, etc.), so a clone is just `makeTask(clone, def)` invoked
with a fresh session — no new execution path.

## Execution model

The agent-facing surface above is **identical** on both runtimes. Only the wire
between the agent's code and the host-side loop differs.

### eval runtime (same realm)

Agent code runs in the host realm, so `spawn` calls the loop directly:

```
agent code: await spawn(spec)
  └─ makeTask(clone, def)(input, { session: ephemeral, signal, onEvent })  // in-process
```

Zero new wire. This is why a v1 / prototype can live here first.

### worker runtime (production)

This is the part worth being precise about, because "RPC" sounds heavier than
it is. Under the worker runtime, **the task loop is not in the worker.**
`makeTask` (LLM calls, event log, state, `taskSuccess` resolution) runs
host-side; the worker's only job is `RuntimeAdapter.execute(code, ctx)` — run
one emission and return its outputs. The LLM client, event log, state backend,
and `Agent` object are all deliberately host-resident.

So the worker already proxies every host capability the agent touches.
`await fs.read('/x')` and `await cache.get(...)` don't run in the worker — they
post a `bridgeCall` to the host and await a `bridgeResponse`. `BridgeTarget` is
already `'fs' | 'cache' | 'fn' | 'namespace' | 'cls'`.

`spawn` needs the LLM client + loop + state — i.e. exactly the host-only
resources. In-worker code physically can't launch an agent loop, for the same
reason it can't open the SQLite store. So worker-side `spawn` is **one more
bridge target**:

```
WORKER                                    HOST
  agent code: await spawn(spec)
  bridgeCall{ target:'spawn', spec } ───▶ run clone makeTask loop
                                           (LLM calls, events, state — all here)
  ◀────────── bridgeResponse{ result } ──
  resume the await
```

It rides the exact channel `fs`/`cache` already use. The only new work vs. an
`fs` call: the host-side handler runs a whole sub-task loop before replying,
and — if we want live sub-agent events streamed to the parent's `onEvent`
mid-flight rather than only at completion — a worker→host event-forward message
(the message protocol's comments already anticipate follow-up message types).

**Recommended sequencing:** prototype the surface on the eval runtime (no
wire), then expose the same host-side `spawn` function over `bridgeCall`. The
ergonomics — `await spawn(...)`, the semaphore, rejection-as-error, the
contract shape — are runtime-agnostic and get validated for free on eval.

## Clone construction (DECIDED: caller-injected run-resource bundle)

agex-ts has **no `clone_registrations` analogue** (Python's clone primitive).
This is an opportunity: because `makeTask(agent, def)` already runs against
`agent.policy()` and resolves state per-session, a clone needn't be a separate
`Agent` at all — policy is shared automatically. The clone differs from the
parent only in its *state, VFS, capabilities, and lifecycle hooks*.

The trap: the per-session resolver is driven by the agent's configured
`StateConfig`. If that's `{ type: 'versioned' }` (kvgit), a naive "fresh
session" would still write **durably**, violating the ephemeral,
stream-don't-store contract (agex-py clones run on a throwaway `Live` with a
blank VFS). So the clone needs state that **bypasses the configured backend
entirely** — always in-memory `Live`, plus a clone-specific VFS — regardless of
how the parent agent is configured. The current `agent.events/fs/cache(session)`
path can't express that today.

**Why not a boolean `ephemeral` flag.** The obvious move is an internal
`ephemeral?: boolean` on `makeTask` that derives a fixed throwaway state. But
the `view` field (read-only parent VFS, see below) means the clone's FS is
**not one fixed thing** — it's blank, or scratch-plus-read-only-parent-mount,
or (later) scratch-plus-snapshot. A boolean can't carry that; it would grow
into a config object that re-derives FS composition *inside* the loop, which is
worse. The clone's resources vary per call, so the loop should **accept** them,
not derive them.

**Decision: a caller-injected run-resource bundle.** Give the loop an optional
host-only parameter carrying the run's resources + capability flags:

```ts
makeTaskCore(agent, def, {
  resources: { eventLog, fs, cache },  // pre-built by the caller
  spawnEnabled: false,                 // depth-1: no spawn cap, no spawn primer
  chaptering: false,                   // no durable log to compact
})
```

When the bundle is absent, the loop behaves exactly as today (acquire from
`agent.*(session)`, chaptering on, `spawn` on), so this lands as a **single
optional parameter** rather than a big-bang rewrite. But note the shape: once
the caller composes the FS and injects the trio, the loop is decoupled from
session-acquisition — i.e. this is the "extract a shared loop-core" (Option C)
seam, introduced incrementally. It keeps the single-loop property (the
truncation / skip-marker correctness stays in one place) while gaining the
flexibility `view` needs. A standalone parallel runner (Option B) is rejected:
it would duplicate emission dispatch and error handling and drift from the
canonical loop.

**The spawn host handler owns composition.** For each `spawn` call it builds:

- `eventLog`: `new EventLogImpl(new Live(), "spawn:<name>:<idx>")` — throwaway,
  never touches the parent's durable session;
- `cache`: a `CacheImpl` over that same throwaway `Live`;
- `fs`: a `MountFS` over a fresh `MemoryFS` scratch backing, with overlays —
  always the `/skills` overlay (a clone has the parent's capabilities, so it
  sees the same skills), and, when `spec.view` is set, a read-only mount of the
  parent session's **backing** FS at the view prefix;
- flags: `spawnEnabled: false`, `chaptering: false`.

**Read-only VFS sharing is not a new FS type.** `fs/mount.ts` already composes
a writable backing with read-only overlays at path prefixes, and writes to a
mounted overlay already throw a `TypeError`. So `spec.view` compiles to a
`MountFS` mount of the parent's backing FS: reads under the prefix see the
parent's files, writes there are rejected, and all other clone writes land in
the throwaway scratch — exactly the machinery `VfsManager` uses for `/chapters`
and `/skills`. (Mount the parent's *backing*, not its whole `MountFS`, so the
clone doesn't inherit a nested `/view/skills`. A versioned backend can later
serve a *snapshot* view via the `checkoutAt` path used by `agent.eventsAt` —
frozen reads instead of live ones; a follow-up, not v1.)

**Depth-1 suppression falls out of the same lever.** Capabilities reach the
runtime by riding `ExecuteContext` (`task.ts` builds `{ fs, cache, signal,
inputs? }` per emission). `spawn` becomes one more context capability —
host-constructed, passed direct under eval, bridge-proxied under worker. A
top-level run gets `ctx.spawn`; an ephemeral clone run (`spawnEnabled: false`)
simply doesn't — which makes it depth-1 *and* keeps `spawn` out of its primer,
with no separate flag. (agex-py achieves the same with `_spawn_enabled=False`.)

## Contract & validation (DECIDED: enforced, recoverable, agex idiom)

Output validation is **always enforced** and follows agex-py's idiom: a
mismatch is a **recoverable error** the agent sees and retries, **counting
against the iteration cap**; only when the loop exhausts does it become a
terminal fail. This requires a change to the main task loop *and* a small new
dependency for spawn — two independent pieces.

### Piece 1 — make main-loop output validation recoverable (precursor change)

Today `task.ts:251` validates a `taskSuccess` value with
`validateOrThrow(def.output, result, 'output')` and, on failure, lets the error
propagate to the outer `catch` — which **hard-rejects the whole task** with a
`SchemaError`. The agent never sees the mismatch; there is no retry. That's the
weaker behavior.

agex-py instead validates at the `task_success` call site and a mismatch becomes
a `recoverable_error` captured in the loop (`async_loop.py`) → surfaced to the
agent → counted against the iteration cap → terminal fail only on exhaustion.

**Change:** on output-validation failure, emit a recoverable **error
observation** (the same `💥 …` shape any runtime error gets, paired to the
`taskSuccess` emission), set `lastError`, and `continue` to the next iteration
instead of throwing out. The agent re-issues `taskSuccess` with a corrected
value; `maxIterations` bounds it; the existing exhaust path produces the
terminal fail. No separate retry budget — it's just another recoverable error.

Implementation note: keep validation **host-side** (where `def.output` already
lives), not in the sandbox `taskSuccess` builtin. The host has the schema, and
the worker boundary should stay data-only — shipping a validator into the worker
would violate that. The agent can't tell the difference: a host-side mismatch
rendered as an error observation in the same turn is observationally identical
to agex-py's in-sandbox raise.

This is a self-contained improvement to the task loop that stands on its own
merits and **de-risks spawn**, so it should land as its own commit/PR *before*
the spawn work.

### Piece 2 — compile the agent's JSON-schema `output` for spawn

A spawn clone runs the same loop, so it inherits Piece 1's enforce-and-retry for
free. The only gap: the agent hands `spawn` a JSON-schema **object**, but
`validateOrThrow` wants a `StandardSchemaV1` **validator**. So the spawn host
handler compiles the agent's `output` object into a StandardSchema-shaped
validator and sets it as the clone def's `def.output`. The clone then validates
itself and retries on mismatch; on clone exhaustion, `spawn` rejects to the
parent via the existing `TaskFail` → Promise-rejection → parent-recoverable-error
path.

Compiling a JSON-schema object to a validator needs a JSON-schema validator,
which the framework doesn't currently bundle. Pick a **lightweight** one
(e.g. `@cfworker/json-schema`) over heavyweight ajv — agex-ts is bundle-size
conscious (see the sub-path export design in `index.ts`).

## Concurrency

Add `maxSpawns?: number` to `AgentOptions` (mirrors agex-py's `max_spawns`,
default 8). Because fan-out is plain `Promise.all`, the bound can't live in a
`map` helper — it must be enforced **inside** each `spawn` call via a semaphore
shared across the injected `spawn` object for one task run. The agent writes
idiomatic `Promise.all([...50 spawns])` and concurrency is transparently capped
at `maxSpawns`; excess calls queue. No thread pool (single-threaded event
loop) — this is purely an admission gate on concurrent in-flight clone loops.

## Failure, cancellation, observability

These all fall out of existing machinery — no Python-style special wrapping
(`_wrap_sub_agent_task`, `contextvars`, manual pool teardown) is needed.

- **Failure = Promise rejection.** A clone's `TaskFailError` naturally rejects
  `await spawn(...)`. Uncaught, it flows through the existing recoverable-error
  output path in `dispatchEmissions` and the agent reads it next turn; or the
  agent can `try/catch` it natively. A clone can't suspend for a human grant
  (ephemeral, no durable state), so a clarify/permission request rejects with a
  clear "ephemeral clone can't suspend" message — matching agex-py.
- **Cancellation composes.** The parent's `AbortSignal` (already threaded
  through `TaskCallOptions` into both the runtime and the LLM client) is passed
  as the clone's `signal`. Aborting the parent aborts in-flight clones.
- **Observability via `agentName`.** Every agex-ts event carries `agentName`.
  Run the clone with `agentName = "<parent>:spawn"` and forward its events to
  the parent's `options.onEvent` — demux is free, no `Namespaced` state-tag
  analogue required. Clone events are **not** written to the parent's durable
  log (they live only on the throwaway ephemeral state): stream, don't store.

## What we drop from the Python version

- **Futures / `submit` / `.result()` / `map`** → native `Promise` +
  `Promise.all`.
- **Seed-class / quoted-annotation machinery** → no runtime types; data-only
  boundary.
- **`contextvars` propagation + thread-pool teardown** → no threads; context
  and cancellation flow through the explicit `options` object and `AbortSignal`
  the loop already threads.

## Non-goals / follow-ups

- **Recursive spawn** — clones are depth-1; deeper trees are out of scope.
- **Streaming sub-agent events mid-flight** under the worker runtime — v1 can
  return events at completion; live forwarding is a follow-up worker→host
  message type.
- **Snapshot (frozen) read-only VFS views** — v1 `spec.view` mounts a *live*
  read-only view of the parent's backing FS; a versioned-backend snapshot via
  `checkoutAt` is a follow-up. (Live read-only sharing itself is **in** v1 — see
  Clone construction.)

## Open decisions recap

1. **Clone-state mechanism** — DECIDED: a caller-injected run-resource bundle
   (`{ resources: { eventLog, fs, cache }, spawnEnabled, chaptering }`) as an
   optional `makeTask` parameter — the Option-C seam landed incrementally, not a
   boolean flag. The spawn host handler composes throwaway `Live`-backed
   log/cache + a `MountFS` (scratch + `/skills` + optional read-only parent
   `view`). Depth-1 and read-only VFS sharing both fall out of this. Standalone
   runner (Option B) rejected.
2. **Validation depth** — DECIDED: always enforced, agex idiom — a mismatch is a
   recoverable error that counts against the iteration cap and hard-fails only on
   exhaustion. Two pieces: (1) make main-loop output validation recoverable
   (replaces today's hard-reject at `task.ts:251`) — a precursor change landing
   before spawn; (2) compile the agent's JSON-schema `output` into a validator
   (lightweight lib, e.g. `@cfworker/json-schema`) so spawn clones inherit
   enforce-and-retry from the shared loop.

## Implementation plan

Clean dependency DAG: three independent **foundation** changes, a
**convergence** PR where spawn first appears, then two **extensions** that fan
out. Shape: **PR1 ∥ PR2 ∥ PR3 → PR4 → (PR5 ∥ PR6)**. Each PR is independently
mergeable, reviewable, and tested.

### Foundation (independent — any order, parallelizable)

**PR 1 — Recoverable output validation** (decision #2, Piece 1)
- *Touches:* `task.ts` success-handling (`:249–263`).
- *Change:* output mismatch → recoverable error observation + `continue`
  (counts against `maxIterations`), replacing today's hard-reject.
- *Tests:* mismatch retries and burns an iteration; exhaustion fails with the
  validation message; valid output still returns; existing success tests green.
- *Why first:* ships standalone value, no spawn dependency, de-risks the clone
  path.

**PR 2 — Run-resource bundle seam** (decision #1 refactor, *no behavior change*)
- *Touches:* `task.ts` resource acquisition (`:105–107`) + capability flags.
- *Change:* `makeTask` accepts optional `{ resources: { eventLog, fs, cache },
  spawnEnabled, chaptering }`. Absent → today's behavior exactly.
- *Tests:* all existing tests pass unchanged; new test injects a throwaway
  `Live`+`MemoryFS` bundle and asserts nothing lands in the configured backend.

**PR 3 — JSON-schema → validator utility** (decision #2, Piece 2 groundwork)
- *Touches:* new util + a lightweight dep (`@cfworker/json-schema` or similar).
- *Change:* compile a JSON-schema *object* into a `StandardSchemaV1` validator.
- *Tests:* compile + validate/refute sample values; bundle-size sanity.

### Convergence

**PR 4 — Spawn core on the eval runtime** (decisions #1 + #2)
- *Depends on:* PR 1, 2, 3.
- *Touches:* `AgentOptions` (`maxSpawns` + `reconfigure`), `ExecuteContext`
  (optional `spawn` capability), `runtime/eval.ts` injection, a new `spawn.ts`,
  the system-message primer section.
- *Brings together:* the `spawn` builtin (semaphore bound by `maxSpawns`); clone
  construction via PR2's bundle; spec→`TaskDefinition` mapping with PR3 compiling
  `output`; event forwarding (`agentName = "<parent>:spawn"` → `onEvent`);
  rejection-as-recoverable-error.
- *Tests:* direct `await spawn(...)`; `Promise.all` fan-out; semaphore cap;
  depth-1 (clone has no `spawn`); ephemeral isolation (no durable writes); event
  forwarding tagged; failure → rejection → parent recoverable; output
  enforce-and-retry inside the clone.
- *Test-infra note:* the `Dummy` LLM serves canned responses off a counter;
  concurrent clones pull them interleaved. Fan-out tests need order-independent
  canned responses or a keyed `Dummy` (the TS analogue of agex-py's `SafeDummy`
  — no locking needed single-threaded, but response *assignment* must be
  deterministic).
- *Size:* the big one; if it runs large, split into **4a** (capability plumbing
  + direct call + primer) and **4b** (semaphore + fan-out).

### Extensions (independent — parallel after PR 4)

**PR 5 — Read-only `view`** (MountFS mount)
- *Touches:* spawn spec `view` field; `VfsManager` (expose the session's
  *backing* FS); compile `view` → `MountFS` mount.
- *Tests:* clone reads parent files under the prefix; writes there throw; clone
  scratch writes don't touch the parent.

**PR 6 — Worker-runtime bridge** (`'spawn'` `BridgeTarget`)
- *Touches:* `agex-runtime-worker` messages/worker/host handler; reuses PR4's
  host-side spawn function.
- *Change:* add `'spawn'` to `BridgeTarget`; worker-side proxy posts
  `bridgeCall`; host handler runs the clone loop and replies.
- *Tests:* in the worker package — spawn under worker isolation returns/rejects
  correctly.
