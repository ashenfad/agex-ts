# agex-ts: Design

> **Status:** Draft — conceptually complete. All sections drafted;
> further refinement expected as the design contacts implementation.
> Specifics flagged as deferring to `implementation.md` will land
> there alongside the build.

## 1. Thesis

agex-ts is an embeddable library for **LLM-authored TypeScript tasks**.
You define a typed TypeScript function; an agent fills in the body at
runtime by writing TypeScript that calls the modules, files, and tools
you've registered. Real values cross the boundary — no JSON-tool
intermediate. The agent works in a familiar developer environment: a
shell over a virtual filesystem, file authoring, registered libraries,
build tools where useful. The whole thing runs in your process,
wherever TypeScript runs. A successful task is a function call that
returned the right type — not a conversation.

## 2. Target Scenarios

These sketches are the design's discipline. Every API decision in this
document has to serve at least one of them; if it doesn't, it
shouldn't exist. Scenarios are written as call-site code with realistic
context, leaving the agent's internal authoring out of frame
(it's filled at runtime).

Code uses the `agent.task` and registration shapes locked in [§4](#4-the-action-loop)
and [§5](#5-registration--capabilities). Output schemas in each
scenario are the *user's* — agex-ts doesn't ship opinionated output
shapes.

### 2.1 Embedded function in an API handler

A Hono / Express / Next.js server has an endpoint whose body is best
expressed as "look at this input and decide what to do with it" — the
kind of routing/triage logic that's tedious to specify but easy to
describe.

```typescript
import { Agent } from 'agex-ts'
import { connectLLM } from '@agex-ts/anthropic'
import { Hono } from 'hono'
import { z } from 'zod'

const agent = new Agent({
  llm: connectLLM({ model: 'claude-sonnet-4-6' }),
})

const triage = agent.task({
  description: "Triage a customer email into a routing decision.",
  input: z.object({ email: z.string() }),
  output: z.object({
    category: z.enum(['billing', 'support', 'sales', 'spam']),
    priority: z.number().int().min(1).max(5),
    reason: z.string(),
  }),
})

const app = new Hono()
app.post('/api/triage', async (c) => {
  const { email } = await c.req.json()
  const result = await triage({ email })
  return c.json(result)
})
```

What it exercises:

- The library-not-service pitch in its sharpest form: agent invocation
  is invisible from outside the server. Callers just hit a typed
  endpoint.
- Schema-first contract: `result` is fully typed at the call site;
  wrong-shape returns from the agent are framework-handled before the
  user sees them.
- No chat surface, no conversation history, no multi-turn UI. The
  agent fills a typed function body, period.

### 2.2 VS Code extension command

A VS Code extension exposes "explain the selected code" or "generate
test cases for this function" as commands the user invokes from the
editor.

```typescript
import { Agent } from 'agex-ts'
import { connectLLM } from '@agex-ts/openai'
import * as vscode from 'vscode'
import { z } from 'zod'

const agent = new Agent({
  llm: connectLLM({ model: 'gpt-5' }),
})

const explainCode = agent.task({
  description: "Explain the selected code in plain language for someone unfamiliar with it.",
  input: z.object({
    code: z.string(),
    language: z.string(),
  }),
  output: z.string(),
})

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('myExt.explainCode', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const code = editor.document.getText(editor.selection)
      const explanation = await explainCode({
        code,
        language: editor.document.languageId,
      })
      vscode.window.showInformationMessage(explanation)
    }),
  )
}
```

What it exercises:

- agex-ts in a Node.js context (extension host), no special runtime
  setup beyond the default.
- A typed task as one of many command handlers — the agent is one tool
  among many in the extension, not the extension's organizing
  principle.
- The "embed a typed primitive" framing translating directly: the
  command handler reads like any other VS Code command.

### 2.3 Browser data tool with a multi-part response

A user uploads or pastes structured data (CSV, JSON) and asks for
analysis. The result is an interleaved sequence of explanatory
markdown, tables, and Plotly charts — the agex-studio interaction
shape, but deliberately *not* a chat product. The host renders the
returned response however it likes (one shot, paginated, embedded
in a larger UI).

The shape of that response is the user's to design. agex-ts doesn't
ship opinions about part kinds, table format, or figure renderer —
those decisions belong to whatever product the user is building.

```typescript
import { Agent } from 'agex-ts'
import { connectLLM } from '@agex-ts/anthropic'
import * as Plotly from 'plotly.js-dist'
import { z } from 'zod'

const agent = new Agent({
  llm: connectLLM({ model: 'claude-sonnet-4-6' }),
  // browser-shaped runtime (e.g. Worker + IndexedDB-backed state)
})

// User-defined response shape. A different product might use
// vega-lite specs, ASCII tables, markdown only, or anything else —
// the framework doesn't care.
const ResponseSchema = z.object({
  parts: z.array(
    z.union([
      z.object({
        type: z.literal('text'),
        content: z.string(),
      }),
      z.object({
        type: z.literal('table'),
        columns: z.array(z.string()),
        rows: z.array(z.array(z.unknown())),
      }),
      z.object({
        type: z.literal('figure'),
        spec: z.unknown(),   // Plotly JSON in this app
      }),
    ]),
  ),
})

const analyze = agent.task({
  description:
    "Analyze the dataset. Produce explanatory text, summary tables, and charts as appropriate.",
  input: z.object({
    data: z.array(z.record(z.unknown())),
  }),
  output: ResponseSchema,
})

// In a UI handler:
const dataset = await loadCsv('sales.csv')
const controller = new AbortController()

const result = await analyze(
  { data: dataset },
  {
    session: conversationId,                // per-conversation state
    signal: controller.signal,              // cancellation
    onEvent: (e) => updateProgressUI(e),    // streaming progress
  },
)

for (const part of result.parts) {
  switch (part.type) {
    case 'text':
      renderMarkdown(part.content)
      break
    case 'table':
      renderTable(part.columns, part.rows)
      break
    case 'figure':
      Plotly.newPlot(plotContainer, part.spec)
      break
  }
}
```

What it exercises:

- Studio-style multi-part output as a **user-defined schema**, not
  a framework-shipped one. agex-ts has no `Response` type; this
  product happens to use one shape, another would use a different
  shape.
- Mixed-part output validated against the user's schema when the
  agent returns it. Discriminated unions in zod give the call site
  full type narrowing in the `switch`.
- Browser-native execution path. No Pyodide; the runtime is whatever
  in-browser sandbox the agent is configured with.
- **Meta-options at the call site** as a second-arg object: `session`
  for per-conversation state isolation, `signal` (AbortSignal) for
  cancellation, `onEvent` for streaming progress, `onToken` for
  token-level streaming. Orthogonal to the typed input; full
  reference in [§4](#4-the-action-loop).

### What these scenarios discipline

Reading the three together, a few constraints fall out that the rest
of the design has to honor:

- **Tasks must be cheap to define and embed** in any host context
  (server, extension, browser). No special runtime setup, no
  deployment surface.
- **The schema-first contract is doing real work**: every scenario
  uses zod input/output schemas to give the call site a typed,
  validated boundary.
- **Output schemas are entirely the user's** — even the studio-style
  multi-part shape (2.3) is the user's, not a framework-shipped type.
  agex-ts stays out of opinionated UI conventions.
- **Different scenarios want different runtimes** — server-side Node,
  extension host, browser. The runtime adapter shape
  ([§8](#8-runtime--sandbox)) has to make this trivial.

> Multi-agent composition (orchestrators, sub-agent tasks, fan-out
> patterns) is intentionally a v2 concern. v1 focuses on a single
> agent embedded in a host application.

## 3. Conceptual Pillars

agex-ts rests on four design choices. Each was decided in the context
of "what makes a typed-function-with-an-LLM-body work." When later
sections sketch APIs, these are the shapes the APIs serve.

### 3.1 Typed function as the contract

The unit of agent-ness in agex-ts is a typed function. You declare
input and output schemas; the agent fills in the body at runtime.
Schemas serve double duty: they give the call site full TypeScript
type inference, and they enforce the contract at runtime — a return
that doesn't match the output schema is a typed error the agent sees
and retries on the next turn.

Everything else — registration, persistence, runtime — exists to make
typed functions work. See [§4](#4-the-action-loop) for the call
shape.

### 3.2 Code as the action space

The agent writes TypeScript code, not JSON tool calls. Most agent
frameworks structure the agent's interface as a list of tool names
with JSON-schema parameter blocks; agex-ts doesn't. The agent's
actions are TypeScript that calls into the modules and capabilities
you've registered.

Why: TypeScript is the language the LLM has seen at scale in
training. JSON-tool indirection costs tokens, prompting effort, and
expressiveness per turn. By keeping code as the medium, agex-ts pays
none of that — the agent thinks in code, executes code, observes the
result, iterates. See [§4](#4-the-action-loop) for the loop and
[§5](#5-registration--capabilities) for how the codebase becomes
reachable.

### 3.3 Familiar working environment

The agent's environment looks like a developer's: a shell over a
virtual filesystem ([§6.2](#62-virtual-filesystem)), file authoring
(write a helper, import it later), build tools where useful,
registered libraries reached via standard ES module imports.

This is deliberate. LLMs have seen massive amounts of "edit a file,
run it, see what happens," "grep through code," "compose these
libraries together" patterns at scale. agex-ts surfaces those
patterns natively rather than inventing new abstractions for them.
The four primitive tools ([§4.2](#42-emissions)) — `ts`, `terminal`,
`fileWrite`, `fileEdit` — are exactly what a TS developer reaches
for; the agent reaches for the same things.

### 3.4 Embedded library, not service

agex-ts is a library you import into your application. The agent runs
in your process, returns typed values, integrates with your code like
any other dependency. There is no agex-ts server, no agex-ts
deployment surface. Where and how you deploy your application is
your concern, not the framework's.

This is the structural choice that distinguishes agex-ts from
standalone agent products (Claude Code, smolagents) and from
JSON-tool frameworks (LangChain, CrewAI). agex-ts is shaped like a
typed function library, not a chat product or a workflow engine.
Embed it in a Hono handler, a VS Code extension, a browser app, a
Lambda function — whatever fits.

## 4. The Action Loop

A task runs as a sequence of **turns**. Each turn is one
generate → execute → observe loop. Turns continue until the agent
signals completion (see [§4.3](#43-task-control)) or hits the
configured iteration limit.

### 4.1 The turn cycle

1. **Generate** — the LLM produces a response. The response can carry
   one or more **emissions** in stream order: thinking, prose, file
   edits, `ts`, terminal commands. Some emissions are pure information
   (thinking, text); others trigger side-effecting work (file edits,
   `ts`, terminal).
2. **Execute** — the framework processes emissions in order. File
   write/edit emissions update the VFS first. `ts` and terminal
   emissions then run in the sandbox. Output (`console.log`, thrown
   errors, return values from registered functions) is captured.
3. **Observe** — captured output becomes the next turn's context. The
   agent sees what its code did, including any errors, and adjusts on
   the next turn.

Turns continue until one of: `taskSuccess(...)`, `taskFail(...)`, or
`taskClarify(...)` is called from a `ts` emission; the host aborts via
`AbortSignal`; or the iteration limit is reached.

### 4.2 Emissions

A turn can contain multiple emissions in stream order. The framework
distinguishes **tool emissions** (the four primitive actions the agent
takes that have side effects) from **information emissions** (the two
channels carrying text the agent produced without taking an action).

The four tool emissions:

| Tool | Purpose |
|---|---|
| `ts` | TypeScript code to run in the sandbox. **Where tasks complete** — `taskSuccess` / `taskFail` / `taskClarify` and `cache` writes happen here. |
| `terminal` | Shell commands to run over the agent's VFS via the bundled terminal layer. |
| `fileWrite` | Write or append a file in the VFS. |
| `fileEdit` | Surgical search-and-replace on a VFS file. |

The two information emissions:

| Channel | Purpose |
|---|---|
| `text` | Assistant prose for the user (markdown). |
| `thinking` | Internal reasoning, surfaced for observability. |

Tool emissions surface to the LLM via its native tool-calling mechanism
(OpenAI tool calls, Anthropic tool use, Gemini function calls, etc.) —
each is one tool the LLM can invoke. Information emissions come from
the LLM's native text and reasoning channels (Claude extended thinking,
OpenAI Responses reasoning items, Gemini thought parts).

Sketch of the emission shapes:

```typescript
type Emission =
  | { type: 'ts';        code: string;     thinking?: string; title?: string }
  | { type: 'terminal';  commands: string; thinking?: string; title?: string }
  | { type: 'fileWrite'; path: string; content: string; mode: 'write' | 'append' }
  | { type: 'fileEdit';  path: string; search: string; content: string; matchAll?: boolean }
  | { type: 'text';      text: string }
  | { type: 'thinking';  text: string; redacted?: boolean }
```

Each `ts` invocation runs as its own fresh module — variables don't
carry across emissions. File write/edit emissions apply to the VFS
*before* any subsequent `ts` runs, so the agent can write a helper
file and then import from it in a later emission, even in the same
turn.

The canonical pattern is one `ts` call per turn (one action → one set
of observations on the next turn). Multiple `ts` calls in a single
turn are supported by the tool-use providers but uncommon in
practice; when they happen, each runs as an independent module.

**Reaching registered things.** Inside a `ts` emission, registered
functions, classes, and namespaces are reached via standard ES module
imports:

```typescript
import * as analytics from 'analytics'
import { calculateKPI } from 'analytics'
import { User } from 'models'
```

The runtime adapter resolves these imports against the registration
table built in [§5](#5-registration--capabilities). Imports that don't
match a registered name fail with a module-not-found error, visible to
the agent on the next turn.

Files written by the agent to the VFS are also importable by relative
path (e.g. `import { helper } from './helpers/utils'`), enabling the
agent to write its own modules and reuse them across turns.

**Output capture.** `console.log` and friends inside a `ts` emission
are captured by the sandbox. They surface as `OutputEvent`s in the
event log and become part of the next turn's observation — the same
shape an agent already expects from familiar dev work.

**Terminal emissions** are pipelines of shell commands run over the
agent's VFS via the bundled terminal layer (`termish-ts`). Custom
terminal commands registered through
[`agent.terminal`](#55-agentterminal--register-a-shell-command) compose
naturally with bundled built-ins (`ls`, `cat`, `grep`, etc.) via
pipes, redirects, and standard shell semantics.

### 4.3 Task control

Inside a `ts` emission, three globals signal task completion:

```typescript
taskSuccess(value)             // value validated against output schema
taskFail(message: string)
taskClarify(message: string)
```

- **`taskSuccess(value)`** — the value is validated against the
  task's `output` schema. If it matches, the awaited task resolves to
  `value` in the host caller's code. If validation fails, the agent
  sees a typed error on the next turn and retries.
- **`taskFail(message)`** — the awaited task in the host caller's
  code throws a `TaskFailError` with the message. Used when the agent
  determines the task can't be completed.
- **`taskClarify(message)`** — the awaited task throws a
  `TaskClarifyError`. Used when the agent needs more information from
  the caller (a human, or another agent in the v2 multi-agent case).
- **Implicit continue** — a `ts` emission that returns normally
  *without* calling any of the above triggers the next turn. There is
  no explicit `taskContinue` call.

Internally, the three task-control functions throw a distinguished
control-error class that the sandbox boundary catches and dispatches.
Agent code that catches them in a generic `try { ... } catch (e) {
... }` is buggy — the framework cannot prevent this in TS — but a
swallowed signal just means the emission completes without effect and
the loop proceeds to the next turn.

### 4.4 Per-emission namespace semantics

Each `ts` invocation executes as its own fresh TypeScript module.
Local variables, top-level imports, and helper definitions live in
that module; they **do not survive past the end of the invocation**.

Cross-emission continuity — whether between two emissions in the same
turn or across turns — goes through three durable channels, none of
them implicit:

- **Event log** — the record of what the agent did and observed.
  Rendered as the conversation history on the next turn.
- **Virtual filesystem** — files written under `helpers/`,
  `scratch/`, or anywhere else the agent decides. Persists across
  turns, sessions, and tasks.
- **Cache** — typed-object storage (`cache.set('model', fitted)` /
  `cache.get('model')`) for objects too rich to round-trip through
  the VFS.

See [§6](#6-persistence-model) for the details of each channel and
their backends.

This "fresh module per invocation" model is deliberate. It matches TS
module semantics, makes invocation boundaries clean, prevents
persistence bugs from accidentally-captured locals, and forces the
agent to be explicit about what it wants to remember.

### 4.5 The call-site contract

A typed task function returned by `agent.task(...)` has the signature:

```typescript
type TaskFn<I, O> = (input: I, options?: TaskCallOptions) => Promise<O>
```

The optional second argument bundles orthogonal call-site concerns:

```typescript
type TaskCallOptions = {
  session?: string                                       // default: "default"
  signal?: AbortSignal                                   // cancellation
  onEvent?: (event: AgentEvent) => void | Promise<void>
  onToken?: (chunk: TokenChunk) => void | Promise<void>
}
```

- **`session`** — isolates state (event log, VFS, cache) between
  callers. Defaults to `"default"`. Same agent, different sessions
  give independent state — useful for multi-tenant servers,
  multi-conversation browser apps, and any context where parallel
  task invocations should not see each other's history.
- **`signal`** — TS's standard cancellation idiom. A running task is
  cancelled at the next iteration boundary; the awaited task throws
  an `AbortError`. Wires naturally into existing AbortController
  patterns (UI cancel buttons, request timeouts, etc.).
- **`onEvent`** — fires for every event during task execution
  (`ActionEvent`, `OutputEvent`, `SuccessEvent`, etc.). Async-callable;
  the framework awaits the handler before continuing, so backpressure
  and async logging both work cleanly.
- **`onToken`** — fires for streaming chunks during LLM generation,
  with type information (thinking / `ts` / file / terminal / text).
  Optional — passing nothing means no streaming overhead.

Both callbacks compose with sub-agent task invocations once
multi-agent lands in v2; the design preserves this without API change.

### 4.6 Observability: events and tokens

**Events** are typed records of everything that happens during task
execution. They land in the event log (which becomes the agent's
rendered history) and stream via `onEvent`. v1 event types:

| Event | Fired when |
|---|---|
| `TaskStartEvent` | Task begins. |
| `ActionEvent` | One turn completes (carries all emissions). |
| `OutputEvent` | Agent code produced output (`console.log`, etc.). |
| `SuccessEvent` | Task completed via `taskSuccess(...)`. |
| `FailEvent` | Task failed via `taskFail(...)`. |
| `ClarifyEvent` | Task interrupted via `taskClarify(...)`. |
| `FileEvent` | Files added / modified / removed (agent or host). |
| `ErrorEvent` | Framework-level error (e.g. LLM API failure). |
| `CancelledEvent` | Task cancelled via `AbortSignal`. |
| `ChapterEvent` | Agent compacted prior events into a summary (see [§6.7](#67-chaptering)). |

Every event carries a UTC timestamp, the agent's name, and (when
versioned state is configured) a commit hash linking the event to a
specific point in state history. Concrete type definitions live in
implementation.md.

**`OutputEvent` carries typed parts**, not just text. The default
part type is text (from `console.log` and similar). Agents working
with vision-capable models can emit image parts via a built-in
`viewImage(bytes | { data, mimeType })` helper available inside
`ts` emissions; the part flows into the next turn's observation
context, where the LLM provider adapter renders it natively
(Anthropic image content blocks, OpenAI image_url, Gemini
inline_data). Future rich part types (audio, files, etc.) can be
added without API change.

**Tokens** are streaming fragments of the LLM's generation, useful
for progressive UI updates:

```typescript
type TokenChunk = {
  type: 'thinking' | 'title' | 'file' | 'edit' | 'terminal' | 'ts' | 'text'
  content: string
  done: boolean              // signals end of current section
  inputTokens?: number       // populated on the final chunk
  outputTokens?: number      // populated on the final chunk
}
```

Token chunks carry the structural type (thinking vs `ts` vs file
content vs terminal command) so a UI can render each section
distinctly. Streaming activates only when `onToken` is supplied —
zero overhead otherwise.

Chaptering (agent-directed context compaction) is in scope for v1.
See [§6.7](#67-chaptering) for the mechanism.

## 5. Registration & Capabilities

Registration is how the host exposes its codebase to the agent. The
registration call says two things at once: *this thing is reachable
from the agent's sandbox*, and (optionally) *this thing should be
mentioned in the primer with this description*. Distinct methods per
kind keep each registration call focused — there's no polymorphic
`agent.register()` that does different things based on what you pass
in.

The five kinds:

- `agent.fn` — register a function.
- `agent.cls` — register a class.
- `agent.namespace` — register a namespace of related callables and
  values (an ESM namespace, a plain object literal, or a class
  instance).
- `agent.skill` — mount markdown documentation that the agent reads on
  demand.
- `agent.terminal` — register a shell command callable from
  `terminal` emissions.

All five share a common options shape (`description`, `include` /
`exclude`, `configure`) where applicable. See
[§5.6](#56-common-options) for the full table.

### 5.1 `agent.fn` — register a function

The simplest registration. Pass a function reference, optionally
describe it.

```typescript
import { calculateCompoundInterest } from './finance'

agent.fn(calculateCompoundInterest, {
  description: "Calculate compound interest given principal, rate, and years.",
})
```

The agent's sandbox can then call `calculateCompoundInterest(...)`. If
you provide a description, the function is mentioned in the agent's
primer; without one, the function is reachable but not enumerated.

> **A note on type fidelity.** TypeScript erases types at runtime, so
> the framework has no signature to read from a registered function
> reference. The agent sees the function's name and the description
> you provide, and works the rest out from training priors. For
> libraries the LLM already knows (lodash, date-fns, standard browser
> APIs) this is sufficient. For unfamiliar custom code, lean on the
> description and pair with a skill if the API is non-obvious. See
> [§5.7](#57-prominence-description-presence-as-the-lever) for the
> fuller explanation.

### 5.2 `agent.cls` — register a class

Register a class along with its public method surface.

```typescript
import { User } from './models'

agent.cls(User, {
  description: "User domain model. Construct with name + email; supports save() and delete().",
})
```

The agent can `new User(...)` and call any non-`_*` method. To
restrict the surface, use `include` / `exclude`:

```typescript
agent.cls(User, {
  description: "User domain model.",
  include: ['save', 'find'],   // explicit allowlist
})
```

`configure` adds per-method descriptions. The cls-level description
sets the primer entry for the class itself; method-level descriptions
augment specific methods worth calling out:

```typescript
agent.cls(User, {
  description: "User domain model.",
  configure: {
    'find': { description: "Look up a user by id." },
    'save': { description: "Persist changes to the database." },
  },
})
```

Other notes:

- `constructable: false` blocks `new User(...)` from agent code while
  still allowing pre-constructed instances passed in as arguments.
- Static methods are accessible as if they were instance methods of
  the class.
- `#private` fields are runtime-private and inaccessible regardless of
  the registration's filter settings.

### 5.3 `agent.namespace` — register a namespace

A *namespace* is the most general registration shape: an object whose
own properties become reachable as a unit, under a name. It accepts:

- An ESM namespace import (`import * as analytics from './analytics'`).
- A plain object literal (a custom toolkit).
- A class instance (whose methods become a namespace under one name).

```typescript
import * as analytics from './analytics'

agent.namespace(analytics, {
  name: 'analytics',
  description: "Analytics helpers for KPI calculation and reporting.",
})
```

The `name` parameter is required: TS module-namespace objects don't
carry their import binding name at runtime, so the framework needs you
to specify the name the agent will use.

For deeply nested libraries, `recursive: true` walks sub-namespaces
*eagerly at registration time*:

```typescript
import _ from 'lodash'

agent.namespace(_, { name: 'lodash', recursive: true })
```

Sub-namespace recognition uses conservative heuristics: only **plain
objects** (`Object.getPrototypeOf(x) === Object.prototype`) and
**Module Namespace Objects** (`x[Symbol.toStringTag] === 'Module'`)
are recursed into. Class instances, arrays, typed arrays, primitives,
`Date` / `Map` / `Set` / etc. are treated as opaque values, not
sub-namespaces.

Filtering and per-member configuration apply at every level:

```typescript
agent.namespace(analytics, {
  name: 'analytics',
  exclude: ['_*'],   // applied at each level
  configure: {
    'calculateKPI':         { description: "Compute the KPI from sales records." },
    'utils.formatCurrency': { description: "Format a number as USD." },
  },
})
```

Dotted keys in `configure` target members of nested sub-namespaces.

> **Why "namespace" and not "module"?** "Module" tends to suggest a
> specific shape — a file or compilation unit with a known interface.
> The runtime object we accept is more general: any object with named
> properties (an ESM namespace import, a plain object literal, a class
> instance). "Namespace" describes that role accurately, and the
> ESM-spec name "Module Namespace Object" reinforces it. (The TS
> keyword `namespace Foo {}` is deprecated legacy syntax; that
> connotation has faded.)

### 5.4 `agent.skill` — mount documentation

Mount markdown documentation that the agent reads on demand.

```typescript
agent.skill('./skills/analytics.md')
```

The skill content is mounted read-only at `/skills/<name>/SKILL.md` in
the VFS. Skill names and short descriptions (from optional YAML
frontmatter) appear in the agent's primer; full content is fetched by
the agent via `cat` when needed.

Skills pair especially well with `agent.namespace(...)` of a custom
internal library: the namespace makes the API reachable, the skill
teaches the agent how to use it.

```typescript
import * as calgebra from 'calgebra-ts'

agent.namespace(calgebra, { name: 'calgebra' })
agent.skill('./skills/calgebra.md')
```

Skill sources can be a path, a URL, raw bytes/string, or any
filesystem-shaped reference. Directory skills (multiple files
including `SKILL.md`) are supported.

### 5.5 `agent.terminal` — register a shell command

Register a shell command callable from `terminal` emissions. The
handler receives a `TerminalContext` (args, stdin, stdout, fs) and
returns a `CommandResult` or `null` (success, exit 0).

```typescript
import { runEsbuild } from './esbuild-bridge'

agent.terminal({
  name: 'esbuild',
  description: "Bundle JS/TS source files via esbuild-wasm.",
  handler: async (ctx) => {
    const [entry] = ctx.args
    if (!entry) return ctx.fail("esbuild: missing entry point.")
    const result = await runEsbuild(ctx.fs, entry)
    if (result.error) return ctx.fail(result.error)
    return null
  },
})
```

Terminal commands compose with the bundled shell built-ins
(`ls`, `cat`, `grep`, etc.) via pipelines, redirects, and the same
shell semantics agents know from training. The full
`TerminalContext` / `CommandResult` type signatures land in
implementation.md.

### 5.6 Common options

Most registration calls accept the following options (where
applicable):

| Option            | Type                                | Notes                                                                |
|---|---|---|
| `description`     | `string`                            | If present, this entry appears in the primer. See [§5.7](#57-prominence-description-presence-as-the-lever). |
| `include`         | `string \| string[] \| Predicate`   | Glob, list of globs/names, or `(name) => boolean`. Default `'*'`.    |
| `exclude`         | `string \| string[] \| Predicate`   | Default `'_*'`.                                                      |
| `configure`       | `Record<string, MemberOptions>`     | Per-member overrides. Dotted keys reach into sub-namespaces.         |
| `name`            | `string`                            | Required for `namespace`; optional elsewhere.                        |
| `recursive`       | `boolean`                           | (`namespace` only) Walk nested namespaces eagerly. Default `false`.  |
| `constructable`   | `boolean`                           | (`cls` only) Allow `new` from sandbox. Default `true`.               |

Where `Predicate` is `(name: string) => boolean` and `MemberOptions`
mirrors the same shape (description, filtering, etc.) but scoped to a
single member.

### 5.7 Prominence: description-presence as the lever

Because TypeScript erases types at runtime, the framework has no
auto-rendered signatures to vary in detail across registrations. The
honest design lever is binary, with **description-presence** deciding
whether a registration appears in the primer:

- **No description** — reachable from agent code, *not* mentioned in
  the primer. Suitable for libraries the LLM already knows from
  training (lodash, date-fns, standard browser APIs).
- **With description** — reachable AND listed in the primer with the
  description. Suitable for custom code the agent needs prompt-level
  guidance about.

This generalizes naturally: skills always appear in the primer
(because they exist explicitly to teach); namespaces with no
description register silently (the user opted to expose the surface
but doesn't want every binding enumerated); per-member descriptions in
`configure` promote specific members to primer prominence even when
the parent namespace is silent.

For the rare case where you want a registration described but
deliberately *not* listed in the primer, an explicit `inPrimer: false`
flag is reserved for the future. v1 doesn't need it.

### 5.8 Enforcement model

agex-ts uses a **filter-at-the-injection-boundary** model. The runtime
adapter (Worker, SES Compartment, iframe, isolated-vm, etc.) is
responsible for one job — only the names allowed by the policy table
cross from host into the agent's runtime. Anything filtered out by
`include` / `exclude` simply isn't there in the agent's sandbox. The
agent can't reach what wasn't injected.

Two consequences of this choice:

1. **Registration is eager.** `recursive: true` walks the namespace
   object once at registration time, applies filters at each level,
   and builds the policy table. The cost is low because ESM imports
   are already loaded by the time the user has a namespace handle, and
   TS has no per-callable introspection cost. Walking a few hundred
   names is sub-millisecond; even very large surfaces (e.g. AWS SDK
   shape) are low-millisecond and one-time at startup.

2. **Late-bound exports won't auto-appear.** A package that mutates
   its namespace at runtime after registration would not have its
   late-added members reflected in the policy table. Rare in practice;
   users can re-register if needed.

For runtimes where Proxy objects survive across the host/sandbox seam
(notably SES Compartments and other same-realm sandboxes), the
runtime adapter *can* opt to use Proxy-based lazy gating — the `get`
trap intercepts every attribute read. But that's an implementation
choice the adapter makes; the user-facing API doesn't expose the
difference.

**Capability scoping (network access, filesystem access, etc.) is a
runtime concern, not a registration concern.** A registered function
carries its capabilities either lexically (closure, in same-realm
runtimes like SES Compartments) or by executing on the host (RPC, in
cross-realm runtimes like Workers or iframes). In neither case would
a per-registration flag enforce anything the runtime model isn't
already deciding. To restrict an agent from making network calls or
touching the host filesystem, configure its runtime so the sandbox
lacks those ambient globals and don't register fns whose closures or
RPC implementations use them. See [§8](#8-runtime--sandbox) for
runtime configuration.

## 6. Persistence Model

A task's mid-execution state — local variables, top-level imports,
function/class definitions inside `ts` emissions — is **turn-local**.
None of it survives past the end of an invocation. Cross-invocation
continuity goes through three durable channels, all explicit:

- **Event log** — what happened (the typed records of every action,
  output, and result).
- **Virtual filesystem** — files the agent wrote, files the host
  uploaded, mounted skills.
- **Cache** — a typed-object store for live values too rich to
  round-trip through the VFS.

These are the only persistence mechanisms. Anything else the agent
wants to remember, it has to put through one of them.

### 6.1 Event log

An append-only sequence of the typed events listed in
[§4.6](#46-observability-events-and-tokens). Each event records one
discrete thing that happened in the task: a turn beginning, a turn
completing with its emissions, output captured from a `ts` run, a
file change, a task result.

What the event log is used for:

- **Conversation history.** The agent's next turn sees the event log
  rendered as the running record of what it has done.
- **Observability.** Streamed in real time via the `onEvent`
  callback at the call site; queryable from host code after the fact.
- **Time-travel debugging.** When versioned state is configured,
  every event carries a commit hash linking it to a specific point
  in state history.

Events are immutable once written. The log grows monotonically within
a session.

### 6.2 Virtual filesystem

A filesystem-shaped namespace where the agent and host can exchange
files. Persists across invocations, turns, and tasks within a session.

Conventional layout:

| Path | Role |
|---|---|
| `/scratch/` | Agent scratch space — no expectations, throw-away work. |
| `/helpers/` | Agent-authored TS modules, importable from `ts` emissions (`import { foo } from './helpers/util'`). Compiled on demand. |
| `/skills/` | Mounted skill markdown (read-only, see [§5.4](#54-agentskill--mount-documentation)). |
| `/chapters/` | Read-only overlay of compacted history (see [§6.7](#67-chaptering)). |
| Anywhere else | Whatever the agent or host creates. |

**Agent-side access** — `ts` emissions read and write VFS files via
standard Node-style `fs` APIs, intercepted by the runtime adapter and
routed to the VFS. (See [§8](#8-runtime--sandbox) for the
interception mechanism per runtime.)

**Host-side access** — host code reads/writes the VFS via
`agent.fs(session)`, useful for uploading user files, reading
agent-produced artifacts, or inspecting state.

```typescript
const fs = agent.fs('user_alice')
await fs.write('/data/upload.csv', csvBytes)
const result = await fs.read('/scratch/analysis.txt')
```

VFS files are bytes / strings, so they serialize trivially through
any state backend.

### 6.3 Cache

The typed-object store for values too rich, too large, or too live to
round-trip through the VFS — fitted models, parsed structures, large
in-memory aggregations.

Map-shaped, async API:

```typescript
await cache.set('model', fittedModel)
const m = await cache.get<Model>('model')          // typed via generic
await cache.has('model')                           // boolean
await cache.delete('model')
const keys = await cache.keys()                    // string[]
```

Generics are opt-in: `cache.get<T>('key')` types the result; without a
generic, the result is `unknown` and the caller narrows.

Async because storage backends (IndexedDB, OPFS, Node fs) are async;
forcing sync access would mean materializing the whole cache at
invocation start, which is wasteful for backends with non-trivial
read costs.

**Caveats:**

- **Object identity is not preserved.** Values pulled back from the
  cache are reconstructed from serialized bytes. `===` across reads
  returns `false`; use structural equality.
- **Values must be structured-clone-serializable.** Plain objects,
  arrays, primitives, `Map`, `Set`, `Date`, typed arrays, and
  `ArrayBuffer` all serialize. **Functions, closures, class
  instances with live references, iterators, DOM nodes, sockets, and
  file handles do not.** The cache holds *data*, not code or live
  references.
- **For reusable agent-authored logic, use the VFS, not the cache.**
  An agent that wants to keep a helper function across turns writes
  it to `helpers/foo.ts` and imports it; files serialize trivially as
  bytes, types travel along with the source, and the helper survives
  arbitrary cache-codec choices. (This is a structural divergence
  from agex-py, which uses the cache for both purposes — see the
  appendix.)
- **For live host references**, expose them through a registered
  function so the live object stays in the host process; the agent
  reaches it through the registration.

### 6.4 Sessions

Sessions isolate the three channels between callers. Same agent,
different sessions = independent event log, VFS, and cache.

```typescript
await analyze({ data }, { session: 'user_alice' })
await analyze({ data }, { session: 'user_bob' })
// Alice's and Bob's event logs, files, and caches don't see each other.
```

Default session is `"default"`. Specifying nothing is equivalent to
`{ session: 'default' }`.

Common use cases: multi-tenant servers (one session per user),
multi-conversation browser apps (one session per chat thread),
concurrent task invocations that shouldn't see each other's history.

### 6.5 State configuration

State backend and persistence semantics are configured at agent
construction via the `connectState` factory:

```typescript
import { Agent, connectState } from 'agex-ts'

const agent = new Agent({
  state: connectState({
    type: 'versioned',           // 'versioned' | 'live'
    storage: 'opfs',             // 'memory' | 'indexeddb' | 'opfs' | 'sqlite'
    path: './agex-state',        // required for sqlite; optional for opfs
  }),
})
```

**`type`** determines the persistence model:

- **`'versioned'`** (recommended) — kvgit-ts-backed. Every action
  commits a checkpoint; sessions are branches; full history is
  retrievable; rollback is supported. The default for any non-trivial
  use.
- **`'live'`** — ephemeral, plain in-process maps. Same shape (event
  log, VFS, cache) but with no checkpointing, no branches, no
  cross-process persistence. Useful for tests and prototypes; not
  appropriate for any setup where you'd want to inspect state after
  the fact.

**`storage`** picks the backend for `'versioned'` state:

| Backend | Surface | Persistence | Typical use |
|---|---|---|---|
| `'memory'` | in-process map | none | dev, tests |
| `'indexeddb'` | browser IndexedDB | survives reload | browser apps |
| `'opfs'` | browser OPFS (mounted as file-system) | survives reload | browser apps with many or large files |
| `'sqlite'` | local SQLite (`node:sqlite` if available, else `better-sqlite3`) | persistent | server-side Node, single-process |

`'live'` always uses in-process storage; the `storage` field is
ignored.

If no `state` is configured, the agent defaults to
`connectState({ type: 'live' })` — every task invocation is fresh.

**Custom backends.** kvgit-ts exposes a `KVStore` interface; users
who need distributed storage (Redis, postgres, DynamoDB), object
storage (S3), or a niche backend (LMDB, LevelDB, etc.) implement the
interface and pass it directly:

```typescript
import { Versioned } from 'kvgit-ts'

const customStore = new MyRedisStore({ host: 'redis.local' })
const agent = new Agent({
  state: connectState({ type: 'versioned', store: new Versioned(customStore) }),
})
```

The four built-in backends cover the common cases; the escape hatch
is for everything else. Same pattern as kvgit-py's `KVStore`
protocol.

**Sessions are branches.** With `'versioned'` state, each session is
an independent branch in the underlying kvgit-ts repository. Forking
a session, deleting one, or switching between them is a branch
operation; merging two sessions is supported but rarely needed
outside multi-agent scenarios (deferred to v2).

### 6.6 Inspection and time-travel

Versioned state is inspectable from host code (async, like the rest
of the kvgit-ts surface):

```typescript
const state = agent.state('user_alice')

// All events from this session's log:
const events = await state.events()

// Find an action and check out state at that commit:
const action = events.find((e): e is ActionEvent => e.type === 'action')
const historical = await state.checkout(action.commitHash)
// historical is a read-only view of cache + VFS at that commit
```

Time-travel is read-only by default. Destructive rollback (`reset`
operations that move the session's HEAD to a previous commit) is
available but not the default — most workflows don't need it.

The full inspection surface (state.events / state.checkout / state.fs
/ state.cache) lands in implementation.md; design.md only commits to
the conceptual capabilities.

### 6.7 Chaptering

Long sessions accumulate event-log entries that eventually press
against the LLM's context window. Chaptering is agex-ts's recovery
mechanism, ported directly from agex-py: **the agent itself decides
what to compact**, writes the summary, and keeps active work intact.
Without it, any non-trivial session would hit a context ceiling with
no graceful path forward.

**Trigger.** When the most recent action's `inputTokens` exceeds the
configured `chapteringTrigger`, the framework runs a special
`__chapter__` task. The agent sees its history with task starts
numbered `[1]`, `[2]`, etc., and returns `Chapter` instances that
close out completed task ranges:

```typescript
new Chapter({
  start: 1,
  end: 3,
  name: "Data exploration",
  message: "Loaded the CSV (12,450 rows × 8 columns). Found 3% null \
            values concentrated in the `income` column. Schema: id, \
            name, age, income, city, state, signup_date, plan_type.",
})
```

**Lossless.** Each `Chapter` becomes a `ChapterEvent` that splices
the closed range out of the active event log. The originals are
preserved in state and mounted read-only at `/chapters/<slug>/` in
the VFS — the agent can browse back to detail with standard tools
(`cat /chapters/data-exploration/events/...`) when it needs more than
the summary.

**Configuration.**

```typescript
const agent = new Agent({
  llm: connectLLM({...}),
  chapteringTrigger: 100_000,   // input-token threshold; default: undefined (no chaptering)
})
```

Without `chapteringTrigger` the event log grows unbounded. With it,
the agent self-manages context as it works — the framework decides
*when* to ask, the agent decides *what* to summarize.

Chaptering is single-agent and depends on no other v2-deferred
capabilities; the `__chapter__` task uses the same task machinery as
everything else.

## 7. Composition & Multi-Agent

**Deferred to a later release.** v1 focuses on a single agent
embedded in a host application; orchestrators, sub-agent tasks, and
fan-out across agents are deliberately out of scope. See
[§11](#11-non-goals) for the deferral rationale and
[§2 closing note](#what-these-scenarios-discipline) for how this
shapes v1 scope.

## 8. Runtime & Sandbox

The **runtime adapter** is the layer that actually executes the
agent's `ts` emissions. It sits between the framework's task loop
and a specific JS sandbox primitive (Worker, SES Compartment,
isolated-vm, iframe), abstracting that primitive so the rest of
agex-ts doesn't have to know which one is in use.

The adapter is **pluggable**: agex-ts ships with one default
(`@agex-ts/runtime-worker`), and other implementations can ship as
separate packages. Users select an adapter at agent construction:

```typescript
import { Agent } from 'agex-ts'
import { connectLLM } from '@agex-ts/anthropic'
import { workerRuntime } from '@agex-ts/runtime-worker'

const agent = new Agent({
  llm: connectLLM({ model: 'claude-sonnet-4-6' }),
  runtime: workerRuntime(),
})
```

If `runtime` is omitted, agex-ts falls back to the default Worker
adapter — most applications don't need to think about runtime
selection. The runtime is **independent of the LLM provider**: the
two pluggable layers don't interact (the LLM client is host-side,
the runtime adapter governs sandbox-side execution).

### 8.1 What the adapter handles

Per `ts` emission, the adapter is responsible for:

- **Executing** the (transpiled) code in the sandbox.
- **Module resolution** — `import { x } from 'analytics'` resolves
  against the registration table built in
  [§5](#5-registration--capabilities); `import { foo } from
  './helpers/util'` resolves against the agent's VFS.
- **Filesystem routing** — `fs` operations from the agent's code
  reach the VFS, not the host filesystem.
- **Cache routing** — `await cache.get(...)` / `await cache.set(...)`
  reach the configured kvgit-ts state.
- **Output capture** — `console.log` and friends become
  `OutputEvent`s in the event log.
- **Cancellation** — honoring the call-site `AbortSignal` (see
  [§4.5](#45-the-call-site-contract)).
- **Resource limits** — best-effort timeouts and other limits, per
  the adapter's primitive (see [§8.2](#82-the-default-agex-tsruntime-worker)).
- **Transpilation** — the agent emits TypeScript; the adapter
  compiles to JS before executing.

The adapter is also where **the access boundary** described in
[§5.8](#58-enforcement-model) is enforced: only names allowed by the
policy table cross from host into the sandbox. Anything else is
either unreachable (Worker / iframe — different realm) or filtered
out (SES — same realm, Proxy-gated).

### 8.2 The default: `@agex-ts/runtime-worker`

The v1 default adapter uses the Worker primitive on both platforms:

- **Browser**: Web Worker.
- **Node**: `worker_threads`.

Platform detection happens at adapter init; users get a single API
regardless. (A few platform-specific options exist for edge cases —
documented alongside the package when it ships.)

Inside the Worker, the adapter:

- **Transpiles** TS to JS using **esbuild** — `esbuild-wasm` in
  browser environments, the native `esbuild` binary in Node.
  Standardizing on esbuild means the framework reuses the same tool
  the agent has access to in `terminal` emissions for its own
  bundling work; no second transpiler in the stack.
- **Sets up module resolution** — bare imports for registered
  namespaces resolve via an importmap (browser) or custom loader
  (Node). Imports for `helpers/*.ts` and other VFS-resident files
  go through the same path.
- **Bridges fs and cache** via message-passing back to the host
  process. Each call from agent code into a registered function is
  a structured-clone round-trip.
- **Captures `console.*`** by overriding the Worker's console
  globals; output streams back to the host as it's produced.

**Cancellation.** When the host's `AbortSignal` fires, the adapter
terminates the Worker. The awaited task throws `AbortError`.
Cancellation is checked at the next event-loop tick — synchronous
tight loops can't be interrupted mid-instruction.

**Resource limits (best-effort).** The adapter enforces per-emission
timeouts (terminating the Worker if a single emission exceeds its
time budget). Hard memory limits **aren't directly enforceable** in
the Worker model — stale Workers can be terminated on signal, but a
runaway allocation within a single emission can't be capped without
process-level isolation.

**Tradeoffs.** The Worker adapter is the least restrictive of the
candidate primitives. It's the v1 default because it's the most
universal (works in browser + Node with a thin abstraction) and the
simplest to reason about. Applications needing harder isolation
(untrusted code, strict resource caps) should reach for an
isolated-vm adapter when one ships, or write their own. Per-host-fn
message-passing also has nontrivial cost for tight call patterns —
SES Compartments avoid this but require the SES library and live
in same-realm.

### 8.3 The adapter contract

Any runtime adapter must provide a small interface. The exact
TypeScript signatures land in implementation.md; conceptually:

- **Initialization** with an agent's policy table (the registered
  names, their kinds, capability shape).
- **Execution** of one `ts` emission — receives the code string, an
  `AbortSignal`, and an output sink; returns observations and a
  task-control outcome (success / fail / clarify / implicit
  continue).
- **Disposal** — release Workers, free wasm, close handles.

The contract is **deliberately minimal** in v1 — shaped only for
what the Worker adapter needs. We are *not* pre-shaping it for SES
Compartments or isolated-vm, even though both are plausible future
adapters. If a future adapter needs different primitives
(e.g. Proxy-based lazy gating in SES, or memory-cap callbacks in
isolated-vm), the interface gets extended additively at that point.
Pretending we know the right shape now would be making the decision
with the least information we'll ever have.

### 8.4 Alternative primitives

The Worker is the v1 default; it isn't the only sensible choice. A
brief survey for context:

| Primitive | Strengths | Weaknesses | When to reach for it |
|---|---|---|---|
| **Worker** (default) | Universal (browser + Node); well-understood semantics; modest isolation | Message-passing overhead per host-fn call; no hard memory limits; cross-realm complexity | The common case; broad compatibility |
| **SES Compartment** | Same-realm (no message-passing); Proxy-gated lazy capability checks; finer control than Worker | Requires the SES library; some edge runtimes don't support it | High-frequency host-fn calls; in-browser apps |
| **isolated-vm** | Strong isolation; rich resource limits (memory, CPU); native V8-isolate primitives | Node-only; native bindings | Untrusted code in Node servers |
| **iframe** | DOM access when the agent needs it; standard browser sandboxing | Browser-only; heavier setup than Worker | When the agent must manipulate DOM directly |

None of these ship in v1. The contract is shaped around the Worker;
whether SES / isolated-vm / iframe adapters ship as
`@agex-ts/runtime-*` packages depends on demand. The user-facing API
doesn't change when a new adapter is added — only the argument to
`runtime: ...` changes.

## 9. LLM Integration

The LLM provider is host-side and pluggable. agex-ts core has **no
dependency on any LLM SDK**; users install one or more provider
packages alongside `agex-ts` and pass the configured client to the
Agent.

```typescript
import { Agent } from 'agex-ts'
import { connectLLM } from '@agex-ts/anthropic'

const agent = new Agent({
  llm: connectLLM({ model: 'claude-sonnet-4-6' }),
})
```

Each provider package exposes a `connectLLM` factory plus a
constructable client class for users who want explicit control.
Multiple providers can be installed alongside each other; agents pick
whichever they're configured with. The runtime adapter (see
[§8](#8-runtime--sandbox)) is independent — the LLM client lives
host-side, the runtime governs sandbox-side execution.

### 9.1 v1 providers

The packages shipping in v1:

| Package | Provider | Notes |
|---|---|---|
| `@agex-ts/anthropic` | Anthropic (Claude) | Extended thinking, vision, tool use |
| `@agex-ts/openai` | OpenAI + OpenAI-compatible endpoints | Reasoning models (o-series, GPT-5), tool calls. `baseUrl` supports OpenRouter, Ollama, vLLM, etc. |
| `@agex-ts/gemini` | Google (Gemini) | Function calling, thought parts |

Each provider package depends on the provider's official SDK as a
**peer dependency** — users control which SDK version they pull in,
and the package itself stays small:

```bash
npm install agex-ts @agex-ts/anthropic @anthropic-ai/sdk @agex-ts/runtime-worker
```

Per-package factories (rather than agex-py's single `connect_llm`
with a `provider` arg) means each factory can have provider-specific
options with full type inference, and unused providers tree-shake out
of the user's bundle.

**Provider-specific options pass through.** Each `connectLLM` factory
exposes the provider's native knobs as typed options — Anthropic's
`thinkingBudget`, OpenAI's `reasoningEffort`, Gemini's thought
configuration, etc. The framework doesn't try to abstract over these;
it keeps the core small and lets each provider expose its unique
surface idiomatically. Niche features the framework hasn't blessed
just pass through to the provider's SDK as kwargs.

### 9.2 Provider adapter contract

Each provider package implements a small interface; the agex-ts core
sees only this shape, not the provider's specific SDK:

- **`complete()`** — takes a request (system prompt, message history,
  tool definitions) and an `AbortSignal`; returns an async iterable
  of provider-specific token chunks (text delta, thinking delta,
  tool-use start/delta/end).
- **Tool-schema translation** — the provider receives a normalized
  tool list from the framework (the four primitive tools plus
  user-registered functions with schemas) and translates to whatever
  shape its API expects (Anthropic tool_use, OpenAI tool_calls,
  Gemini function declarations, etc.).
- **Error classification** — distinguishes transient errors (retry)
  from fatal errors (abort).

The framework consumes the iterable: normalizes provider chunks to
`TokenChunk` for `onToken` (see [§4.5](#45-the-call-site-contract)),
assembles an `ActionEvent` for `onEvent` and the event log when the
turn completes (see [§4.6](#46-observability-events-and-tokens)).

The full TypeScript signatures for the provider interface land in
implementation.md. design.md commits to the shape: streaming-first,
provider-native errors classified at the boundary, normalized tokens
flowing through to the framework.

### 9.3 Streaming, retries, errors

**Streaming.** All providers stream by default. The framework
consumes the stream, fires `onToken` for each chunk, and emits an
`ActionEvent` once the turn completes. Callers that don't pass
`onToken` get the same final result; the framework just doesn't
forward the per-chunk callbacks.

**Retries.** Configurable on the Agent:

```typescript
const agent = new Agent({
  llm: connectLLM({...}),
  maxRetries: 2,        // default
})
```

Transient errors (rate limit, network blip, 5xx) retry with
exponential backoff. Fatal errors (auth failure, malformed request,
4xx) fail immediately without consuming retry attempts. After
retries are exhausted, the framework throws `LLMFailError` —
the host caller catches it like any other thrown error.

**Cancellation.** The `AbortSignal` from the call-site
[§4.5](#45-the-call-site-contract) flows into the LLM client. The
provider adapter aborts the in-flight HTTP request; the awaited task
throws `AbortError`. Independent of runtime-adapter cancellation —
both honor the same signal without coordinating.

### 9.4 Prompt construction and provider caching

agex-ts builds LLM payloads in a **cache-friendly shape from the
ground up**. Each provider has its own caching mechanism (Anthropic's
prompt caching with `cache_control` markers, OpenAI's automatic
prompt caching on stable prefixes, Gemini's context caching);
the framework's prompt construction is structured to take maximum
advantage of all of them.

Concretely:

- **Stable prefix structure** — the system prompt, tool definitions,
  agent-level primer, and skill listings appear identically across
  every turn within a session. They form a fixed prefix that
  providers can cache.
- **Append-only history** — the event log grows monotonically.
  Earlier turns are never rewritten in subsequent calls. Chaptering
  ([§6.7](#67-chaptering)) splices in `ChapterEvent`s at well-defined
  task boundaries, so cache invalidation happens cleanly when it
  happens at all.
- **Provider adapters apply native caching** — `@agex-ts/anthropic`
  emits `cache_control` markers at the optimal positions;
  `@agex-ts/openai` ensures the automatic-prompt-cache-friendly
  prefix shape; `@agex-ts/gemini` manages explicit context caches
  when configured.

Cache hits substantially reduce input-token costs (≈90% on Anthropic,
≈50% on OpenAI). Treating caching as a first-class concern — not a
post-hoc optimization — is the only way to deliver those savings
reliably across long-running agent sessions. This is a
**load-bearing commitment**, not an opt-in feature.

## 10. Package & Repo Decomposition

agex-ts is a monorepo with workspace packages. All published
packages use the `-ts` suffix consistently — `agex-ts`, `kvgit-ts`,
`termish-ts`, and the `@agex-ts/*` LLM-provider scope. (The top-level
suffix is forced anyway because `agex` is taken on npm; consistency
wins for the rest. The suffix doubles as a clear cross-registry
disambiguator — the Python `kvgit` exists on PyPI, `kvgit-ts` is
unambiguously the TS version.)

### Workspace layout

| Workspace | Role |
|---|---|
| `agex-ts` | Top-level. The `Agent`, task definition, registration surface, event log, cache, VFS API, runtime adapter glue. No LLM SDK dependency. |
| `kvgit-ts` | Versioned KV store: branches, commits, merges, storage backends (memory, IndexedDB, OPFS, SQLite). |
| `termish-ts` | Shell parser + builtins over an `fs`-shaped surface. Powers `terminal` emissions. |
| LLM providers | One package per provider — e.g. `@agex-ts/anthropic`, `@agex-ts/openai`, `@agex-ts/gemini`. Each depends on the provider's SDK; users install only the ones they need. See [§9](#9-llm-integration). |

The runtime/sandbox layer is internal to `agex-ts` initially. If it
develops a coherent identity outside the project (reusable for other
LLM runtimes), it can be peeled out later.

Tooling: pnpm workspaces for monorepo management; Changesets (or
similar) for coordinated releases; each workspace builds
independently with workspace-protocol links between them.

### Publishing

Each package publishes to npm independently:

- **`agex-ts`** — top-level package, named to match the project.
- **`kvgit-ts`, `termish-ts`** — standalone packages, suffix
  preserved for consistency and cross-registry clarity.
- **LLM provider packages** — scoped (`@agex-ts/anthropic`, etc.)
  for clear ownership and to mirror conventional patterns in the TS
  ecosystem (Vercel AI SDK, LangChain.js, etc.).

### Discovery, not pre-mirroring

The package decomposition mirrors the agex-py stack at the level of
"what kinds of things exist," but **the specific seams will be
discovered under load, not pre-decided to match Python**:

- `kvgit-ts` is async-shaped where Python's `kvgit` is sync (see
  [appendix](#sync-vs-async-storage)). The protocol shape is
  language-driven, not a port choice.
- A `monkeyfs` analog likely doesn't earn its keep as a separate
  package — Node's `fs` is already the convergent filesystem seam,
  and any `fs`-shaped library can plug in (`memfs`, `unionfs`, etc.).
- A `reprobate` analog may or may not earn a port. TS doesn't have
  the introspection density that motivates budget-bounded reprs in
  Python; we decide if and when we actually need it.
- A `sandtrap` analog isn't planned at all — JS engines provide
  sandbox primitives directly (Worker, SES Compartment, isolated-vm,
  iframe). See [§8](#8-runtime--sandbox).

**Disposition for v1: monorepo-first; peel out packages when they
earn standalone identities under real-world load.** Pretending the
seams are pre-known would be making the decision with the least
information we'll ever have.

## 11. Non-Goals

This section gathers what agex-ts is explicitly *not* trying to be or
do. Some are **deferred** — capabilities we'd like eventually but
aren't building in v1. Others are **structural** decisions about what
agex-ts isn't.

### Deferred to a later release

- **Multi-agent composition.** Orchestrators, dual-decorated
  sub-agent tasks, fan-out across agents. v1 focuses on a single
  agent embedded in a host application. The design
  (`onEvent` / `onToken` propagation, schema validation at task
  boundaries) preserves this without API change.
  See [§2 closing note](#what-these-scenarios-discipline),
  [§7](#7-composition--multi-agent).

- **Setup parameter on tasks.** Preparatory code that runs in the
  sandbox before the agent's main loop (useful for "view this image
  first" / "examine this DataFrame head"). Trivial to add later as an
  additional field on `agent.task({...})`.

- **`jq` builtin in `termish-ts`.** agex-py's `termish` ships a
  from-scratch pure-Python jq parser/evaluator. `termish-ts` does
  not reproduce this. Agents working with JSON in `terminal`
  emissions can use standard JS approaches (registered helpers, or
  `ts` emissions with `JSON.parse` plus lodash/object navigation).
  If a strong case for shell-shaped JSON manipulation emerges, a jq
  builtin can be added later — but the implementation cost of a
  faithful jq is high, and the agent has perfectly good alternatives.

- **Custom value codecs in `kvgit-ts`.** agex-py's `kvgit` has
  opt-in chunked codecs for content-addressed deduplication of large
  numpy/pandas buffers across commits. `kvgit-ts` ships with the
  default (structured-clone-based) codec only. **The HAMT data
  structure underpinning structural sharing of the keyspace across
  commits and branches IS in scope** — that's what makes session
  forking cheap and is required for the branchable-state model in
  [§6.5](#65-state-configuration). Custom value codecs can be added
  when a clear need emerges; users with heavy-blob workloads can plug
  a custom `KVStore` backend in the meantime.

### Structurally not goals

- **Not a chat product.** agex-ts is not a chat UI, not a
  conversational agent runtime, not a chat-first surface. Users embed
  it in whatever interface their application has. The studio-style
  multi-part response pattern ([§2.3](#23-browser-data-tool-with-a-multi-part-response))
  is one application; the framework doesn't ship it.

- **Not a workflow DSL or graph builder.** No DAG editor, no
  node-graph configuration, no workflow YAML. Composition is ordinary
  TypeScript control flow — `await`, `Promise.all`, conditionals,
  loops.

- **Not API-parity with agex-py.** agex-ts shares the thesis but is a
  distinct project; the API is shaped to TS idioms, not ported from
  Python. See the [agex-py appendix](#appendix-notes-for-readers-of-agex-py)
  for the divergences in detail.

- **Not a sandbox project.** agex-py builds sandtrap (AST-rewriting
  Python sandbox) because Python's in-process options are inadequate.
  agex-ts doesn't — JS engines were designed for hostile code from
  day one. We use existing primitives (Worker, SES Compartment,
  isolated-vm, iframe) and don't reinvent.
  See [§8](#8-runtime--sandbox).

- **No host configuration.** agex-ts doesn't ship a packaged HTTP
  server, a Modal integration, or any deployment surface. The agent
  runs in the calling process; users wrap it in their own serving
  infrastructure (Hono handler, Lambda function, Worker, Modal app,
  etc.).

- **No `connect_fs`-style real-fs configuration.** The agent always
  sees a VFS. Real-fs access happens through registered functions
  whose closures or RPC implementations touch the host fs.

- **No per-registration capability flags** (`networkAccess` /
  `hostFsAccess` on `agent.fn` / `agent.cls` / `agent.namespace`).
  Capability scoping is a runtime concern, not a registration
  concern. See [§5.8](#58-enforcement-model).

- **No visibility tiers** (`high` / `medium` / `low`). The honest
  lever in TS is binary: description-presence determines primer
  inclusion. See [§5.7](#57-prominence-description-presence-as-the-lever).

- **No caching of agent-authored functions.** The cache holds data;
  the VFS holds code. Agents persist reusable logic by writing
  modules to `helpers/`, not by serializing closures.
  See [§6.3](#63-cache).

- **No top-level function decorators.** TS doesn't support them at
  the language level; agex-ts uses direct method calls and HOF-shaped
  APIs throughout. `@agent.task` / `@agent.fn` from agex-py do not
  carry over.

- **No agent-side direct LLM access.** The agent has no built-in way
  to invoke an LLM from its sandbox; the framework's LLM client
  serves the main task loop. Users who need delegated reasoning
  register a function that calls an LLM, and the agent calls that
  function like any other registered capability. Multi-agent
  composition (deferred above) is the orchestration story, not
  agent-internal LLM calls.

## 12. Open Questions

Things we **know we haven't decided** — known risks and unsettled
trajectories that will resolve under real-world load rather than
upfront design. Distinct from [§11 (Non-Goals)](#11-non-goals),
which captures things we *have* decided not to build.

### Runtime adapter contract evolution

The contract sketched in [§8.3](#83-the-adapter-contract) is
deliberately minimal — shaped around what the Worker adapter needs.
When SES Compartments, isolated-vm, or iframe adapters arrive (as
ecosystem packages or future first-party additions), the contract
may need to grow:

- **Lazy vs eager gating** — SES would naturally want Proxy-based
  per-access checks alongside Worker's eager-filter-at-injection
  model.
- **Cross-realm vs same-realm assumptions** — SES passes closures
  directly; Worker requires structured-clone. The contract may need
  to declare its realm assumptions.
- **Resource-limit primitives** — isolated-vm has rich V8 hooks
  (memory caps, instruction counts) Worker can't match. The contract
  may need optional capability declaration.

**Disposition**: accept additive extension. When new primitives need
different shapes, extend the contract with optional methods/fields —
existing adapters keep working. The contract is **explicitly not
stable** until at least one non-Worker adapter ships and validates
its shape.

### Versioning trajectory

agex-ts ships pre-1.0 with the API explicitly experimental.
Operationally:

- **`0.x`** — minor versions may include breaking changes with
  changelog notes; consumers pin to a specific minor.
- **1.0** — API surface in §4 through §6 stabilizes; breaking
  changes after 1.0 require a major-version bump per semver.
- **Provider packages and runtime adapters** version independently of
  agex-ts core; Changesets coordinates compatible releases.

What "1.0" actually requires is open — at minimum, real users have
shipped non-trivial agex-ts applications, the Worker adapter has held
up under production load, and at least one of the deferred items in
[§11](#11-non-goals) has been added or explicitly bumped to a future
major.

---

## Appendix: Notes for readers of agex-py

Readers familiar with [agex](https://github.com/ashenfad/agex) (Python)
will notice differences in agex-ts. This appendix gathers the major
divergences in one place; the main design intentionally stands on its
own without prerequisite knowledge of agex-py.

### Type fidelity at registration

agex-py uses Python's `inspect` module at registration time to read
parameter types and return annotations from registered callables, then
renders them in the agent's primer. agex-ts has no equivalent —
TypeScript types are erased at compile time. Compensating mechanisms
in agex-ts: explicit `description` strings, `configure` for per-member
descriptions, and skill markdown for unfamiliar APIs. Affects
[§5.1](#51-agentfn--register-a-function),
[§5.7](#57-prominence-description-presence-as-the-lever).

### Visibility tiers

agex-py exposes three tiers (`high` / `medium` / `low`) controlling
how much auto-rendered signature information appears in the primer.
agex-ts collapses to a single lever — description-presence — because
there are no auto-rendered signatures to vary in detail. Affects
[§5.7](#57-prominence-description-presence-as-the-lever).

### Access gating

agex-py rewrites the AST of agent code so every `obj.attr` access goes
through `__st_getattr__`, enforcing policy lazily on every access.
agex-ts has no AST rewriter; the runtime adapter filters at the
host/sandbox injection boundary. The agent can only reach what was
injected. For runtimes where Proxies survive (SES Compartments), an
adapter may opt into agex-py-style lazy gating via Proxy's `get` trap.
Affects [§5.8](#58-enforcement-model).

### Eager vs lazy registration

agex-py walks namespaces lazily because a recursive walk can trigger
expensive submodule imports and `inspect` calls. agex-ts walks
eagerly: ESM imports are already loaded by the time a namespace handle
exists, and there's no per-callable introspection cost. Affects
[§5.3](#53-agentnamespace--register-a-namespace),
[§5.8](#58-enforcement-model).

### Capability flags (network, fs)

agex-py uses per-registration `network_access` / `host_fs_access`
flags to gate process-global patches (monkeyfs, the socket patcher).
agex-ts has no equivalent global gate, so per-registration flags
would not enforce anything the runtime model isn't already deciding.
Capability scoping moves to runtime configuration. Affects
[§5.8](#58-enforcement-model), [§8](#8-runtime--sandbox).

### Module vs namespace

agex-py uses `agent.module(...)`. agex-ts uses
`agent.namespace(...)` because the registered object is more general
than a Python module — it can be an ESM namespace import, a plain
object literal, or a class instance. Affects
[§5.3](#53-agentnamespace--register-a-namespace).

### Decorators

agex-py uses `@agent.task`, `@agent.fn`, `@agent.cls` decorators in
addition to direct method calls. agex-ts uses direct method calls and
HOF-shaped APIs exclusively because TS decorators are class-only and
don't apply to top-level functions. Affects
[§4](#4-the-action-loop), [§5](#5-registration--capabilities).

### Schema-first task contract

agex-py uses Python type annotations (with optional pydantic) directly
as the task contract. agex-ts uses Standard Schema validators (zod by
default in examples) to serve the same role at the call boundary,
since TypeScript types aren't available at runtime. Affects
[§4](#4-the-action-loop).

### Naming convention

agex-py uses Python snake_case throughout (`task_success`,
`on_event`, `network_access`). agex-ts uses TypeScript camelCase
(`taskSuccess`, `onEvent`). Conventions, not semantics.

### Cancellation

agex-py exposes a `task.cancel()` method on the task wrapper, plus
sentinel-based cooperative cancellation via state. agex-ts uses
`AbortSignal`, the JS-native cancellation idiom — passed in via the
call options, propagating through any host-level abort controller
the user already has in their stack. Affects
[§4.5](#45-the-call-site-contract).

### Task-control exception handling

agex-py rewrites bare `except:` clauses in agent code to
`except Exception:`, ensuring control exceptions
(`StTimeout`, `StCancelled`, the task-success/fail signals) cannot be
silently swallowed. agex-ts has no AST rewriter, so a `try { ... }
catch (e) { ... }` in agent code can in principle swallow a
task-control signal. The framework treats a swallowed signal as an
implicit continue — the loop proceeds to the next turn rather than
breaking. Affects [§4.3](#43-task-control).

### Multi-agent composition

agex-py supports multi-agent workflows via the dual-decorator pattern
(`@orchestrator.fn` + `@specialist.task`). agex-ts defers all
multi-agent composition to v2; v1 focuses on a single agent embedded
in a host application. Affects [§2](#2-target-scenarios),
[§7](#7-composition--multi-agent).

### Sync vs async storage

kvgit (Python) implements Python's `MutableMapping` protocol —
`store[k] = v`, `store[k]`, dict-shaped iteration, all synchronous.
kvgit-ts can't match: IndexedDB and OPFS are inherently async, and
sync wrappers around async storage block the JS event loop. The TS
surface is therefore an async `Map`-shaped API
(`await store.get(k)`, `await store.set(k, v)`,
`for await (const k of store.keys())`). The async surface is uniform
across backends — `'memory'` storage wraps sync ops in resolved
promises so user code doesn't change between dev and prod
configurations. Affects [§6.3](#63-cache),
[§6.5](#65-state-configuration).

### Caching agent-authored functions

agex-py supports caching agent-defined functions, lambdas, and
classes via sandtrap's `StFunction` / `StClass` machinery — the
capability exists because lambdas and local definitions aren't
natively picklable. It's a holdover from before agents could author
VFS modules and import them across turns. agex-ts doesn't reproduce
this: JS has the same unserializability of functions, but the VFS-
as-source-of-truth pattern subsumes the use case. Agent-authored
helpers go in `helpers/*.ts` and are imported across turns; the cache
holds data, not code. Affects [§6.3](#63-cache).

### Filesystem configuration

agex-py exposes `connect_fs(...)` for choosing between `VirtualFS`,
`IsolatedFS` (real-fs access restricted to a directory), or no fs,
with a `host_fs_access` flag on registrations to escape the VFS at
specific seams. agex-ts drops this entirely. The agent always sees a
VFS; any real-fs access from the agent's perspective happens through
registered functions whose closures (or RPC implementations) touch
the host fs. The framework's layered fs (skills overlay, future
chapters overlay) is internal — not exposed as configuration. Affects
[§6.2](#62-virtual-filesystem).

### Host configuration

agex-py provides `connect_host(...)` for choosing where the agent's
ReAct loop runs (`local`, `http`, `modal`), including a packaged HTTP
server and a Modal integration with auto-deploy, container-image
inference, and GPU allocation. agex-ts drops host configuration
entirely. The agent runs in the calling process, period; users who
want to deploy to Modal, AWS Lambda, Cloudflare Workers, or anywhere
else wrap the typed task in their own serving infrastructure. The
framework doesn't try to own the deployment surface. Affects
[§1](#1-thesis), the constructor signature shown throughout
[§2](#2-target-scenarios).

### LLM configuration shape

agex-py uses a single `connect_llm(provider="anthropic", ...)`
factory, with provider chosen by string and provider-specific
options blended into the kwargs. agex-ts splits this into per-package
factories — each provider package
(`@agex-ts/anthropic`, `@agex-ts/openai`, etc.) exports its own
`connectLLM` with provider-specific options typed precisely. Reasons:
(1) full TypeScript type inference per provider, (2) tree-shakable
imports, (3) the LLM SDK is a peer dependency so users control its
version. Switching providers in agex-ts changes the import line and
the options shape; in agex-py it changes a string argument. Affects
[§9](#9-llm-integration).

---

## Appendix: Terms

A glossary of the recurring terms in this document.

- **Agent** — the configured object that owns registrations, an LLM, a
  state store, and a runtime. Constructed once per logical role.
- **Task** — a typed TS function whose body the agent fills in at call
  time. Defined on an agent.
- **Action** — one generate→execute→observe turn within a task.
- **Emission** — a single unit of output within an action: TS code, a
  terminal command, a file write/edit, text, or thinking.
- **Registration** — making a function, class, namespace, skill, or
  terminal command available to the agent's action space.
- **Namespace** — an object whose own properties are registered as a
  unit under a single name. Accepts ESM namespace imports, plain
  object literals, and class instances.
- **Primer** — the natural-language instructions that guide the agent
  (task-level or agent-level).
- **Skill** — markdown documentation mounted at `/skills/` that the
  agent reads on demand. Always listed in the primer with its
  description.
- **VFS** — the virtual filesystem the agent's code operates on.
- **Cache** — the typed-object store; per-session dict for objects too
  rich to round-trip through the VFS.
- **Runtime** — the sandbox primitive (Worker, SES Compartment,
  isolated-vm, iframe, etc.) that executes agent-emitted code.
