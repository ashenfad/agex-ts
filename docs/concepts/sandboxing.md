# Sandboxing

The agent's action surface is TypeScript code emitted by the LLM. agex-ts runs that code in an isolated context behind a small, swappable contract — `RuntimeAdapter` — so embedders can pick the isolation level that fits their threat model.

## The contract

```ts
interface RuntimeAdapter {
  init(policy: Policy): Promise<void>
  execute(code: string, ctx: ExecuteContext): Promise<ExecResult>
  dispose(): Promise<void>
}
```

`policy` is the registration table — every fn / cls / namespace / skill / terminal the agent has access to, plus capability flags (`hostFsAccess`, `networkAccess`). `ExecuteContext` carries the per-emission VFS, cache, signal, and validated inputs. `ExecResult` carries the outcome, captured outputs (`console.*`, image views), and timing.

agex-ts ships two adapters; embedders can implement their own.

## `evalRuntime` — same-realm, no isolation

`agex-ts/runtime-eval` runs the agent's TS in the host realm via `new AsyncFunction(...)`. TypeScript type annotations are stripped in-place by `ts-blank-space`, so line numbers in stack traces match the original code. There's no boundary between the agent's code and your host process.

Use this for:

- Tests
- Trusted code paths where you want zero overhead
- Quick prototyping

Don't use this for:

- Untrusted user-driven sessions
- Anything where the agent shouldn't see the rest of your runtime

```ts
import { evalRuntime } from 'agex-ts/runtime-eval'
const agent = await createAgent({ runtime: evalRuntime(), /* ... */ })
```

## `workerRuntime` — Web Worker isolation

`@agex-ts/runtime-worker` runs the agent's TS in a Web Worker. The worker has its own globals, no DOM access, no shared scope with the host. The host sends a `configure` message at boot listing the policy; subsequent `execute` messages dispatch one emission at a time.

Three boundaries make this work:

1. **postMessage / structured-clone.** Inputs and outputs cross the worker boundary as structured-clone-able values. Functions, closures, DOM nodes, and class instances with private state don't cross. agex-ts has bridges for the common cases — see "Crossing the boundary" below.
2. **Per-emission timeout.** `workerRuntime({ timeoutMs })` sets a wall-clock budget per emission. Hitting it terminates the worker; the next emission spawns a fresh one.
3. **AbortSignal honoring.** `ctx.signal` is threaded into the LLM client and the worker's run path. Aborting writes a `CancelledEvent` and rejects with `CancelledError`.

```ts
import { workerRuntime } from '@agex-ts/runtime-worker'

const agent = await createAgent({
  runtime: workerRuntime({
    workerUrl: new URL('./worker.js', import.meta.url),
    timeoutMs: 30_000,
  }),
  /* ... */
})
```

The worker bundle ships with the package; you point `workerUrl` at the file the bundler produced.

## Crossing the worker boundary

Three patterns connect the host realm and the worker realm.

### 1. Host-bound registrations (RPC bridge)

When you register a fn / cls / namespace by passing a live JS reference, the worker sees a stub that round-trips each call back to the host via postMessage. The host runs the actual code and sends the result back. Same surface for the agent, but each call is async.

```ts
agent.fn(myExpensiveFn, { name: 'process', description: 'Process a record.' })
// In the worker, the agent calls `await process(...)`. The host runs the
// real fn; structured-clone moves args + return across.
```

This is the most flexible pattern (any host code, any state) and the slowest (RPC per call). Best for: low-frequency calls, host-only side effects (DB writes, network requests, etc.).

### 2. URL-shipped registrations (worker-realm native)

When you register by URL, the worker dynamic-imports the module and exposes the value to the agent natively. No RPC, no per-call serialization — the agent calls native JS in its own realm.

```ts
agent.cls(
  { url: 'https://esm.sh/big-graph-lib' },
  { name: 'Graph', description: 'Graph data structure.' },
)
```

URLs that work: any ESM-resolvable URL (esm.sh, jsdelivr, Skypack, your own CDN), `data:application/javascript;base64,...` payloads, blob URLs. Useful for shipping pure-JS libraries directly into the worker without piping every call through `postMessage`.

### 3. Bridged services (fs, cache)

The agent's filesystem and per-session cache are RPC-bridged to the host. Reads and writes cross the boundary, but the host owns the underlying state — so the same `agent.fs(session)` view in your host code sees what the agent wrote. This is how the VFS overlays (`/skills`, `/chapters`) work transparently.

## What's enforced where

| Concern | Enforced by |
|---|---|
| No access to host globals | Worker realm boundary |
| No DOM access | Worker realm (browser default) |
| No filesystem outside VFS | The agent only has `fs` (the bridged VFS); raw `node:fs` not exposed |
| No network outside what's allowed | The agent only has what's registered; no global `fetch` shim by default |
| Per-emission wall-clock budget | `workerRuntime`'s timeout, terminating the worker |
| Cancellation | AbortSignal threaded through every async path |
| Type validation on `taskSuccess(...)` | Schema attached via `output:` (Standard Schema) |
| Member visibility (`include`/`exclude`) | Policy filters at registration time |
| Structured-clone failures | Caught and surfaced as a clear error with the offending arg name |

## What's NOT enforced

agex-ts is honest about what's outside its scope:

- **CPU / memory caps.** The Web Worker shares the browser's V8 heap and CPU. `timeoutMs` is wall-clock, not instruction-counted. There's no equivalent of CPython's `sys.setrecursionlimit` or sandtrap's tick limit. Adversarial tight loops will hit the timeout, but a tight loop *can* run for ~timeoutMs before the host can stop it.
- **Side-channel leaks.** A worker that knows your registration policy is a worker that's seen your registration policy. Don't ship secrets in the policy.
- **Worker-internal crashes.** A throw inside the worker propagates as `error` on the result; persistent corrupting state would have to be deliberate. The next emission spawns a fresh worker after a kill.

For stronger isolation, the natural next step would be process-level (Node `worker_threads` with permissions, or a separate process). The current package is browser-focused; Node `worker_threads` is on the [roadmap](https://github.com/ashenfad/agex-ts/blob/main/roadmap.md).

## Implementing your own RuntimeAdapter

The contract is small enough that swapping in a custom runtime is reasonable. Implementations of interest:

- A more restrictive Worker (e.g. with a Service Worker fetch interceptor)
- A subprocess-based Node runtime
- A WASM-only runtime for stricter sandboxing
- An out-of-band runtime (e.g. a remote service that runs the agent's code on dedicated infrastructure)

All you need is `init` / `execute` / `dispose`. agex-ts's core never reaches past that interface.
