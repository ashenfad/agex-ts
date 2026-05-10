# Runtime

The runtime adapter is what executes the agent's `ts_action` emissions. It's the boundary between the agent's code and the host realm. agex-ts ships two; embedders can implement their own. See [Sandboxing](../concepts/sandboxing.md) for the architectural picture.

## `RuntimeAdapter`

```ts
interface RuntimeAdapter {
  init(policy: Policy): Promise<void>
  execute(code: string, ctx: ExecuteContext): Promise<ExecResult>
  dispose(): Promise<void>
}

interface ExecuteContext {
  readonly fs: VirtualFileSystem
  readonly cache: Cache
  readonly signal: AbortSignal
  readonly inputs?: unknown
  readonly emissionId?: string
}

interface ExecResult {
  readonly outcome: TaskOutcome
  readonly outputs: ReadonlyArray<OutputPart>
  readonly error: Error | null
  readonly elapsedMs: number
  readonly inputTokens?: number
  readonly outputTokens?: number
}

type TaskOutcome =
  | { kind: 'success'; value: unknown }
  | { kind: 'fail';    message: string }
  | { kind: 'clarify'; message: string }
  | { kind: 'continue' }
```

`init(policy)` is called once per task call — the adapter sees the registration table and configures itself (worker realm, eval scope, etc.). `execute(code, ctx)` runs one emission. `dispose()` releases resources (the worker, etc.).

## `evalRuntime`

```ts
import { evalRuntime } from 'agex-ts/runtime-eval'

interface EvalRuntimeOptions {
  readonly timeoutMs?: number      // default 5000
  readonly passConsole?: boolean   // default false
}

function evalRuntime(opts?: EvalRuntimeOptions): RuntimeAdapter
```

In-process, no isolation. Runs the agent's TS in the host realm via `new AsyncFunction(...)`. TypeScript type annotations stripped in-place by `ts-blank-space` (whitespace-preserving — line numbers in stack traces match the original code).

Use for tests, prototypes, and trusted-only embedders. Not for untrusted user-driven sessions.

| Option | Purpose |
|---|---|
| `timeoutMs` | Per-emission wall-clock budget. Aborting raises `CancelledError`. |
| `passConsole` | When true, `console.*` from the agent also passes through to the host's console (useful for debugging tests). Default `false` — captured into the result's `outputs`. |

```ts
import { createAgent } from 'agex-ts'
import { evalRuntime } from 'agex-ts/runtime-eval'

const agent = await createAgent({
  name: 't',
  llm: /* ... */,
  runtime: evalRuntime({ timeoutMs: 10_000 }),
})
```

### What `evalRuntime` does and doesn't strip

`ts-blank-space` strips type annotations only — interfaces, type aliases, `as` casts, generics, parameter types, return types. A few TypeScript features that aren't pure type-erasure throw a syntax error and surface as a runtime error the agent can adjust to:

- `enum` (use `const X = { A: 'a' } as const` instead)
- `namespace` (use modules / imports)
- Parameter properties (`constructor(private x: number)`)
- Decorators

The built-in primer flags these so the agent doesn't reach for them.

## `workerRuntime` (`@agex-ts/runtime-worker`)

```ts
import { workerRuntime } from '@agex-ts/runtime-worker'

interface WorkerRuntimeOptions {
  readonly workerUrl?: string | URL
  readonly transform?: (src: string) => string | Promise<string>
  readonly timeoutMs?: number                                  // default 5000
  readonly routeFetchToVfs?: boolean | ReadonlyArray<string>   // default false
}

function workerRuntime(opts?: WorkerRuntimeOptions): RuntimeAdapter
```

Web Worker isolation. The host spawns a worker, sends `configure` at boot, then dispatches each `execute` over postMessage. The worker has its own globals, no DOM access, no shared scope with the host.

| Option | Purpose |
|---|---|
| `workerUrl` | URL the host hands to `new Worker(...)`. Defaults to a sibling file the package ships. |
| `transform` | Source pre-processor. Default: `ts-blank-space`. Embedders can swap in `esbuild-wasm` for richer TS support. |
| `timeoutMs` | Per-emission wall-clock budget. Hitting it terminates the worker; the next emission spawns a fresh one. |
| `routeFetchToVfs` | Route the agent's `fetch(...)` calls for path-shaped URLs to the agent's VFS. See [routeFetchToVfs](#routefetchtovfs) below. |

### `routeFetchToVfs`

Recovers agex-py's "registered libraries see the VFS" property by routing path-shaped GET/HEAD `fetch` calls through the bridged VFS. Without it, library functions that internally call `fetch` (Arquero's `loadCSV`, Plotly's loaders, JSON/URL fetchers in any data lib) hit the worker's HTTP origin instead of the agent's VFS — surprising and easy to miss. With it, the agent's mental model unifies: `fs.read` and registered library loaders read from the same place.

```ts
workerRuntime({
  workerUrl: ...,
  routeFetchToVfs: true,                    // every path-absolute URL → VFS first
  // OR
  routeFetchToVfs: ['/data/', '/scratch/'], // only these prefixes → VFS
  // OR
  routeFetchToVfs: false,                   // default — no routing, all fetch hits network
})
```

| Form | Behavior |
|---|---|
| `true` | Every path-absolute URL (`/foo`, `/data/x.csv`) is tried against VFS first; falls through to real network on miss. Use when the agent doesn't talk to a same-origin API. |
| `string[]` | Only paths under the listed prefixes are routed to VFS. Match-but-miss returns a 404 Response (not a fall-through). Use when your app serves an API the agent might also want to call (e.g. `/api/...` should pass through; agent VFS lives under `/data/`). |
| `false` (default) | Current behavior. Agent uses `fs.read` explicitly for VFS access; `fetch` always hits the network. |

**What's routed:**
- Only **path-absolute URLs** (`/foo` style). Scheme URLs (`https://...`), scheme-relative (`//host/...`), and relative (`./foo`, `foo`) all pass through to real `fetch` unchanged.
- Only **GET and HEAD** methods. Other methods (POST, PUT, etc.) always pass through — writing to VFS via `fetch` isn't supported (use `fs.write`).

**Content-Type:** the synthesized `Response` has its `content-type` header inferred from the file extension (`.csv` → `text/csv`, `.json` → `application/json`, `.parquet` → `application/vnd.apache.parquet`, etc., default `application/octet-stream`).

**Primer integration:** when `routeFetchToVfs` is enabled, a short addendum is appended to the agent's system primer so the agent knows the VFS is reachable through `fetch`. Embedders don't need to document this themselves.

**Example: agex-studio with Arquero**

```ts
const agent = await createAgent({
  name: 'analyst',
  llm: connectAnthropic({ model: 'claude-sonnet-4-6' }),
  runtime: workerRuntime({
    workerUrl: new URL('./worker.js', import.meta.url),
    routeFetchToVfs: true,
  }),
  state: { type: 'versioned', storage: 'indexeddb' },
})
agent.namespace({ url: 'https://esm.sh/arquero@7' }, { name: 'arquero' })

// Agent code: loadCSV reads from VFS — no bytes-shuttling needed.
//   import { loadCSV } from 'arquero'
//   const dt = await loadCSV('/data/sales.csv')
```

```ts
import { createAgent } from 'agex-ts'
import { workerRuntime } from '@agex-ts/runtime-worker'

const agent = await createAgent({
  name: 'a',
  llm: /* ... */,
  runtime: workerRuntime({
    workerUrl: new URL('./worker.js', import.meta.url),
    timeoutMs: 30_000,
  }),
})
```

The worker bundle ships with the package — your bundler resolves `./worker.js` to it.

> **Vite users:** add `'agex-runtime-worker'` to `optimizeDeps.exclude` in your `vite.config`, or the worker fails to boot. See [Using with Vite](../../README.md#using-with-vite) in the top-level README.

### How the boundary works

Three patterns connect the host realm and the worker realm:

1. **Host-bound registrations (RPC bridge).** A live JS reference registered via `agent.fn(myFn, ...)` becomes a stub in the worker that round-trips each call to the host. Args + return value cross via structured-clone.
2. **URL-shipped registrations (worker-realm native).** `agent.cls({ url: '...' }, ...)` triggers a dynamic import in the worker realm at boot. The agent calls native JS — no per-call serialization.
3. **Bridged services (fs, cache).** The agent's `fs` and `cache` are RPC-bridged; the host owns the underlying state. Same `agent.fs(session)` view in your host code sees what the agent wrote.

See [Registration — URL-shipped registrations](registration.md#url-shipped-registrations) for what to use when.

### Helpers ESM in the worker

Agent-authored helpers under `/helpers/*.ts` work transparently:

```ts
// agent's TS
import { sum } from '/helpers/utils'
taskSuccess(sum([1, 2, 3]))
```

The runtime walks the import graph at host time, transforms each helper file, and ships the (rewritten) code to the worker as part of the `execute` payload. The worker AsyncFunction-evaluates each helper and exposes the exports under `__modules['/helpers/utils']`. Sub-helpers, `import * as`, default exports, and `export *` all work; circular imports throw a clear error.

### Per-emission lifecycle

```
host                             worker
─────────────────────────────────────────────────────────────
                                 (boot, send `ready`)
←─────────────  ready  ──────────
─── configure(policy) ──────────→
                                 (build registration stubs)
─── execute({ code, helpers }) ─→
                                 ts-blank-space transform
                                 AsyncFunction-eval helpers
                                 AsyncFunction-eval main code
                                 emit outputs / outcome
←─── result + outputs ───────────
```

A worker is spawned lazily on first `execute` and held across consecutive successful executes. Hard kills (timeout, abort) terminate the worker; the next execute spawns a fresh one. `dispose()` terminates without spawning.

## Implementing your own `RuntimeAdapter`

```ts
import type { RuntimeAdapter, Policy, ExecuteContext, ExecResult } from 'agex-ts'

class MyRuntime implements RuntimeAdapter {
  async init(policy: Policy): Promise<void> {
    // configure transform, set up sandbox, etc.
  }
  async execute(code: string, ctx: ExecuteContext): Promise<ExecResult> {
    // run `code` somewhere, capture outputs, decode outcome
    return {
      outcome: { kind: 'continue' },
      outputs: [],
      error: null,
      elapsedMs: 0,
    }
  }
  async dispose(): Promise<void> {
    // release resources
  }
}
```

The contract is small. Implementations of interest:

- A more restrictive Worker (Service Worker fetch interceptor, etc.).
- A subprocess-based Node runtime (Node `worker_threads` is on the [roadmap](https://github.com/ashenfad/agex-ts/blob/main/roadmap.md)).
- A WASM-only runtime for stricter sandboxing.
- A remote-execution runtime that runs the agent's code on dedicated infrastructure.

The `Policy` shape is exported from `agex-ts/types` — lets adapters introspect what's registered to wire up appropriate stubs / bridges. agex-ts core only reaches the contract surface; everything inside is your decision.
