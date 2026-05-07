# The Big Picture

Most agent frameworks ask you to define tools — JSON schemas wrapping your code, the model picking from a list, arguments serializing back and forth across the boundary on every call. agex-ts doesn't have that boundary. You define a typed function with `agent.task({...})`, and the agent fills in the body by writing TypeScript that calls into the modules you've registered. Real values flow in and out without JSON wrapping. Your existing codebase *is* the toolset.

Three structural choices follow from that — a typed-function contract, a library shape, and a worker-isolated runtime that ships with the bundle.

## Code as the medium

Agents don't choose between "using tools" and "writing code." In agex-ts, code is always central:

- Returning a result: `taskSuccess(...)`
- Calling a function: just call it
- Building data structures: native TS / JS syntax
- Debugging: `console.log` and read the output next turn
- Creating reusable logic: write helpers under `/helpers/` and import them

Agents operate in a **generate → execute → observe** loop:

1. **Generate** — the LLM emits a `ts_action` block based on the task and registered capabilities.
2. **Execute** — the runtime adapter runs the block in a Web Worker (or eval realm in tests).
3. **Observe** — output (`console.*`, errors, return values) flows back as the next turn's context.

Errors land in stdout the way they would in a normal TS session. The agent sees the stack trace, adjusts, tries again. No special "error-handling tool" needed.

## Three pillars

### 1. Typed function as the contract

You declare what the task does with a typed signature; the agent fills in the body.

```ts
import { createAgent } from 'agex-ts'

const agent = await createAgent({ /* ... */ })

agent.namespace(stats, { name: 'stats', description: 'Stats helpers.' })

const summarize = agent.task<number[], { mean: number; stdev: number }>({
  description: 'Compute mean and stdev of the input values.',
})

const result = await summarize([3, 1, 4, 1, 5, 9, 2, 6])
//   ^? { mean: number; stdev: number }
```

The line `agent.namespace(stats, ...)` is registration — the bridge between your codebase and the agent's action space. It does double duty as guidance (you choose which modules and members to expose) and security (the agent can only reach what you registered).

The return type is part of the contract. agex-ts validates the agent's `taskSuccess(...)` value against any [Standard Schema](https://standardschema.dev/) you supply via `output:`; if it doesn't match, the agent sees a validation error and tries again. Inputs (typed `I`) become the `inputs` variable inside the agent's TS, automatically validated when an `input:` schema is provided.

Since task inputs and results can carry rich values, agents do their work symbolically with code. They inspect with logs and checks rather than reading full JSON payloads — an agent can sort, filter, or transform large data structures without ever loading their contents into the conversation.

### 2. Library, not service

agex-ts is a TS library. You import it, register your existing modules, and define `agent.task({...})` calls. The agent runs alongside your application — same process for evalRuntime, isolated Worker realm for workerRuntime.

```ts
import { createAgent } from 'agex-ts'
import * as analytics from './analytics'

const agent = await createAgent({ /* ... */ })
agent.namespace(analytics, { name: 'analytics', description: 'Project analytics.' })

const report = agent.task<string, string>({
  description: 'Answer a question using the analytics module.',
})
```

There's no separate runtime to deploy, no API endpoint to call, no IPC boundary you have to design. The Worker boundary is mechanical, not architectural — the runtime adapter handles `postMessage`, RPC bridging for host-bound registrations, and structured-clone of inputs/outputs.

This is the opposite shape from standalone-agent frameworks (Claude Code, Codex CLI), which run as their own processes and communicate via text or files. agex-ts is closer in shape to a typed function library. The agent is something you *call*, not something you converse with.

### 3. Worker-isolated runtime

The default production runtime (`@agex-ts/runtime-worker`) runs the agent's TS in a Web Worker. No shared globals, no eval-in-host, no DOM access. The Worker is configured with the registered policy at startup; subsequent emissions are dispatched across the postMessage boundary.

```ts
import { workerRuntime } from '@agex-ts/runtime-worker'

const agent = await createAgent({
  /* ... */
  runtime: workerRuntime({ workerUrl: new URL('./worker.js', import.meta.url) }),
})
```

For tests and trusted-only use, `evalRuntime` (in `agex-ts/runtime-eval`) skips the worker — same agent surface, no isolation. Both implement the same `RuntimeAdapter` contract.

agex-ts also supports **URL-shipped registrations**: you give the agent a class or function by URL (any ESM-resolvable URL — `https://esm.sh/...`, `data:application/javascript;base64,...`, blob URLs). The Worker dynamic-imports the module and exposes it to the agent natively. No host RPC bridge, no per-call serialization. Useful for big libraries you want fully callable inside the worker realm.

```ts
agent.cls({ url: 'https://esm.sh/big-graph-lib' }, { name: 'Graph' })
```

## What this enables

Several capabilities fall out naturally from the three pillars.

### Multi-agent orchestration with regular control flow

Sub-agents are functions; orchestrators call them like any other.

```ts
const research = orchestrator.task<string, Report>({ description: 'Research a topic.' })
const critique = critic.task<Report, Review>({ description: 'Review a report.' })

let report = await research('AI trends in 2025')
while (true) {
  const review = await critique(report)
  if (review.approved) break
  report = await hone(review.feedback, report)
}
```

No workflow DSL, no graph builder.

### Agent-authored helpers

Agents can write helper modules to the VFS at `/helpers/utils.ts` and `import` them in subsequent turns. The runtime resolves bare imports (`import { x } from '/helpers/utils'`) against the agent's VFS. Useful for non-trivial logic that would otherwise be re-derived each call.

### Skills

Where registration tells the agent *what* it can use, skills tell it *how* to use it effectively. `agent.skill(content, { name })` mounts markdown documentation that the agent reads on-demand at `/skills/<name>/SKILL.md` — useful for libraries with non-obvious APIs.

### Terminal-shaped tooling

Most agent capabilities fit the library shape — registered modules and functions called from `ts_action` blocks. But some don't: compilers, formatters, archive utilities, anything that has a CLI surface in training rather than a TS API. `agent.terminal(handler, { name, description })` exposes these as commands the agent runs from `terminal_action` blocks, with the same `--help`-and-pipelines idioms agents already know.

The library shape stays primary — that's where work finishes, and `taskSuccess` only fires from `ts_action`. The terminal is a secondary surface for tools whose natural interface isn't a TS function.

### Time-travel via kvgit

When state is configured as `{ type: 'versioned', ... }`, every commit captures the full session world (state + VFS) atomically. You can pull up the agent's workspace at any past commit:

```ts
const head = await agent.commit('alice')               // snapshot now
// ... agent continues working ...
const log = await agent.eventsAt(head, 'alice')         // events as they were at `head`
const events: AgentEvent[] = []
for await (const e of log!.iter()) events.push(e)
```

See [State & Sessions](state-and-sessions.md) for details on the substrate.

## How agex-ts relates to other agent frameworks

A few rough comparisons in case it helps situate the project:

**JSON-tool frameworks** (LangChain, CrewAI, Vercel AI SDK tools): the agent picks from a JSON-typed tool list; arguments serialize across the boundary on each call. agex-ts doesn't have that boundary — your registered modules are the API the agent uses, and rich values pass through (subject to structured-clone for the worker boundary).

**Shell-based code agents** (Claude Code, Codex CLI, Aider): same general harness shape (stateless code execution + filesystem-as-state), different contract. They're conversational tools; agex-ts's surface is a typed function you call from your application.

**[smolagents](https://github.com/huggingface/smolagents)** and **[agex](https://github.com/ashenfad/agex)** (the Python sibling): same core thesis — agents that think in code instead of choosing tools. agex-ts is the TypeScript port of agex's library-shape, embeddable thesis. Compared to agex (Python), agex-ts trades the Python AST sandbox (sandtrap) for a Web Worker / `worker_threads` boundary, gains TypeScript's type-checking on the agent surface, and runs natively in the browser without Pyodide.

## The result

agex-ts's surface is a small set of ideas with predictable corollaries:

- The contract is a typed TypeScript function.
- The action space is sandboxed TS over your registered modules.
- The state model is a per-session kvgit substrate that captures state, cache, event log, and VFS atomically.
- The runtime is a Web Worker (production) or an eval realm (tests), behind a single `RuntimeAdapter` contract.

Multi-agent workflows become regular control flow. Data handoffs become value passing across structured-clone. Capabilities become registrations. There's no extra layer — agex-ts reuses the parts of TypeScript that already work.
