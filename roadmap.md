# agex-ts: Roadmap

Tracks deferred work — items we know we want, scoped well enough to
pick up later without re-deriving the analysis. Live priorities go
here; once an item is in flight, it moves out (PR description carries
the detail). Once shipped, delete the entry.

`design.md` is the source of truth for *what* we're building;
`implementation.md` is the original bottom-up build plan. This
document is for items that survived past those phases.

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
adoption makes server-side isolation a credible asks.
