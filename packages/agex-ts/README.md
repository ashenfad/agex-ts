# agex-ts

Agents that act by writing TypeScript and running a shell, in a
versioned world. The TypeScript counterpart of
[agex](https://github.com/ashenfad/agex), matching its meaning.

An agent works in a workspace from
[`@agex-ts/world`](../world): files, a shell, a code kernel in a
worker, and the conversation, all on one branch of a versioned store.
A rewind is a checkout, a fork is cheap, and everything the agent did
is a commit. agex-ts is the loop over it:

- **Sessions:** chat with an agent over a workspace, turn by turn,
  streaming as it goes.
- **Tasks:** a typed call (`rank({ scores })`) that runs an agent on a
  world of its own and hands back a checked value.
- **Agent-defined tasks:** the agent's own code hands work to helper
  agents (`agex.task(...)`).
- **Delegation:** an agent asks delegates, each on a fork of its world.
- **Folding:** a long conversation is summarised as it grows, within a
  task as well as across turns.
- **Any [AI SDK](https://ai-sdk.dev) model,** in Node or a browser.

## Install

```bash
npm install agex-ts @agex-ts/world @agex-ts/kvgit @ai-sdk/anthropic
```

Any AI SDK provider works in place of `@ai-sdk/anthropic`. Node 22 or
later.

## Quick start

```ts
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { Store } from '@agex-ts/world'
import { createAnthropic } from '@ai-sdk/anthropic'
import { Agent } from 'agex-ts'
import { z } from 'zod'

const model = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })('claude-haiku-5-5')
const agent = new Agent({ model, primer: 'You work in a sandboxed workspace. Be brief.' })

// a session: the agent works in a workspace, turn by turn
const store = await Store.open(new Memory())
const ws = await store.open('notes')
const chat = agent.session(ws)
const out = await chat.say('Write a haiku about rivers to /workspace/haiku.txt')
console.log(out.status, out.text)
console.log(await ws.files.readText('/workspace/haiku.txt'))

// a task: a typed call on a world of its own
const factor = agent.task({
  name: 'factor',
  instructions: 'Factor n into its primes, smallest first.',
  params: { n: z.number().int() },
  returns: z.array(z.number().int()),
})
console.log(await factor({ n: 391 })) // [17, 23]
```

`examples/quickstart.mjs` is this as a script, and
`examples/helpers.mjs` has an agent hand work to helpers
(`pnpm build`, then `node examples/<name>.mjs` with a key set).

## Worlds

A workspace is one session of a `Store`, which keeps every session as a
branch of one versioned key-value store: in memory, in SQLite
(`@agex-ts/kvgit/backends/sqlite`, Node) or in IndexedDB
(`@agex-ts/kvgit/backends/idb`, browsers). The workspace's README
covers what an agent can do there and what the host can grant it: host
objects, values, secrets, terminal commands and skills, given as a
`profile` when a session opens.

## Sessions

```ts
const chat = agent.session(ws)

const out = await chat.say('make a flashcard app') // Outcome: status, text, head, events
for await (const event of chat.stream('add a timer')) render(event) // TurnEvents as they happen
chat.inbox.put('also add a shuffle button') // rides the next tool result
chat.cancel('stopped by the user') // the turn ends cancelled, its work kept
```

- **A turn is one run.** The model is asked, the tools it calls run
  against the workspace (each change committed as it lands), and the
  loop goes round until the model answers without calling one. The
  turn's end stores the run and lands a commit stamped with how it
  ended.
- **The tools** are the world's: `terminal`, `run_ts`, `file_write`,
  `file_edit`, and `view_image` with `toolOptions: { vision: true }`,
  plus any of your own (`tools`, in the same shape; one named like a
  built-in replaces it).
- **Endings:** `completed`, `cancelled`, `failed` (an error, or
  `maxSteps` model calls) or `interrupted` (a provider error worth
  retrying), which `resume()` continues in place and `abandon(reason)`
  ends. A cancelled or failed turn keeps its work with a closing note.
  None of them throw.
- **Limits:** `maxSteps` model calls per run, and `maxToolCalls`, past
  which the model is told to reply and further calls aren't run.
- **The record:** `chat.runs()` reads the stored runs, oldest first,
  each message with its parts and usage (`runUsage(run)` sums it). A
  checkout of the workspace rewinds them with the files.
- **The agent holds nothing:** a change of model or primer is a new
  `Agent` for the next turn, over the same workspace and inbox.

## Models

Any AI SDK model is a model: install its provider and hand the model to
the agent. agex-ts drives its `doStream` directly, without the AI SDK's
core, and depends on `@ai-sdk/provider` alone.

```ts
const agent = new Agent({ model, settings: { thinking: 'medium', maxTokens: 8000 } })
```

- **Thinking** is an effort (`'minimal'` to `'xhigh'`, `true` or
  `false`), which each provider maps for its model. The model's
  reasoning, and whatever its provider attached to a part (signatures,
  encrypted reasoning), is kept in the run and sent back to that
  provider alone, so a session can change providers between turns.
- **`settings.extra`** is provider options, by provider
  (`{ anthropic: { cacheControl: { type: 'ephemeral' } } }`).
- **Errors:** a rate limit, an overload, a server error or a provider
  out of reach interrupts the turn (`resume()` continues it); a refused
  request fails it, in the provider's words.
- **A `Provider` of your own** works too: `stream(messages, tools,
  settings, { signal })` yields deltas and one `Reply`. `ScriptedProvider`
  replies from a script, for tests.

## Tasks

```ts
const rank = agent.task({
  name: 'rank',
  instructions: 'Rank the scores, best first.',
  params: { scores: z.array(Score) }, // Standard Schemas: zod, valibot, arktype
  returns: Ranking,
})

const ranking = await rank({ scores }) // the value, or TaskFailed / NeedsInput / TaskInterrupted
const out = await rank.run({ scores }, { world: ws, keep: true }) // an Outcome: .value, .ref
const next = await out.resume?.('by total') // a task that asked carries on from the answer
```

A task runs the agent on a world of its own and hands back a typed
value. The caller's world is never touched.

- **Its world:** a scratch world built from the agent's `profile`, or a
  fork of `world`'s last commit, deleted when the task ends unless
  `keep`. Scratch worlds go on a memory store, or on
  `new Agent({ scratch: store })`.
- **Inside it,** agent code sees each input by name and `task`:
  `await task.success(value)`, `task.fail(reason)` and
  `task.needsInput(question)`. A value that doesn't fit the return type
  is a `TypeError` at the call, which the agent can fix. The call that
  settles the task ends the script it's in.
- **Inputs are checked at the call** and reach the code as a copy each
  run. A `live()` input is an object on the host whose methods the code
  calls; data with a live part in it is refused, as is a live return
  type.
- **The model reads TypeScript,** never a schema: the brief shows each
  input's type and a preview of it, the declarations of the types they
  name, and a live input's methods.
- **A task that asks** keeps its world, and its `__task__` plane holds
  what it is, its inputs and how it stands. It resumes through the
  outcome, or by ref with `rank.resume(ref, answer, { world })`, after
  a restart too where its store persists (a live input is passed again).
- **A model that stops without finishing** is sent back twice, then the
  task fails. `signal` stops a task; it ends `cancelled`.

`fromJsonSchema(schema)` makes a Standard Schema of a JSON Schema
literal, for types written that way.

## Agent-defined tasks

Grant `agex` and the agent's own code can hand work to helper agents:

```ts
const ws = await store.open('lead', {
  profile: { hostObjects: { agex: agentTasks(agent) } },
})
const chat = agent.session(ws, { sessions: true, toolOptions: { codePrimer: AGEX_GUIDE } })
```

```ts
// the agent's code, in run_ts
const factor = agex.task({
  name: 'factor',
  instructions: 'Factor n into its primes, smallest first.',
  params: { n: { type: 'integer' } }, // JSON Schema, or a Standard Schema that makes it
  returns: { type: 'array', items: { type: 'integer' } },
})
const primes = await factor({ n: 391 })
const all = await factor.map([{ n: 391 }, { n: 403 }]) // at most 4 at once
```

- **A definition is checked where it's written,** in the worker, by
  `agex`'s stub: a missing type or instructions, a reserved parameter
  name or a live type is a `TypeError` there. Inputs are checked at the
  call, and the value against the return type, as a task's are.
- **Each call is a helper:** a task run by the calling agent, given the
  task's `primer` too. A helper that fails throws `agex.TaskFailed` in
  the calling code, and one that asks throws `agex.TaskNeedsInput`.
- **Helpers are delegates** of the calling world, forked with an empty
  view inside the code's call and listed with its other delegates;
  their answers go to the call, never to the caller's model. A world
  with no delegation helper open, or `agentTasks(agent, { scratch: true })`,
  puts them on scratch worlds instead.
- **A helper holds what its caller holds,** without `agex`; a task's
  `objects` narrows that to the host objects it names. A helper's time
  doesn't count against the calling script's timeout (up to the
  profile's `code.hostTime`), and a cancel of the caller's turn stops
  its helpers.
- **`standInTasks(answer?)`** answers every call at once, without a
  model: by `answer(name, inputs)`, or with the simplest value of the
  return type, for a page check or a handler test.
- **`AGEX_GUIDE`** tells the model how to use `agex`, for the code
  tool's description.

## Delegation

```ts
const chat = agent.session(ws, { sessions: true })
await chat.say('ask a delegate to write the tests while you fix the bug')
chat.sessions?.list() // the jobs: running, answered, failed...
await chat.close() // done with the workspace: waits for the delegates
```

With `sessions: true` the model gets the world's `sessions` tool: each
ask forks the session, and a delegate works on its own branch, as a
session of the asking agent.

- **A delegate runs until it has nothing outstanding.** Its task is its
  first turn. If it ends that turn waiting on delegates of its own, or
  with a note unread, it is woken when they come in. Its reply then is
  its answer, and a turn that doesn't complete answers `failed`.
- **Answers come back like notes.** One that lands during a turn rides
  the next tool result; one that lands between turns waits for the
  next, and `wake()` runs a turn that opens with it.
- **The jobs are the workspace's, not the agent's.** A new `Agent` for
  the next turn finds the same helper (`Sessions.of(ws)`): its new
  delegates run on it, and those in flight finish on the agent that
  asked. Close the session only when done with the workspace.
- **A delegate holds what its parent holds:** its fork opens with the
  parent's settings and profile, and nothing more. Its work stays on
  its branch until the asking agent merges or takes it (`ws-git`).
- A `Sessions` of your own (`{ sessions: helper }`) runs every ask on
  its own runner.

## Folding

```ts
import { Policy } from 'agex-ts'

const agent = new Agent({ model, compaction: new Policy(120_000) })
```

Past the budget, the conversation is folded into a summary in what the
model is sent, within a run too, so a long task keeps going. The stored
runs are never rewritten: the person still sees everything.

- **The agent's own model writes the summary,** asked with nearly the
  request it was about to send, which is mostly in the provider's
  cache. A reply with no text falls back to a transcript with tool
  output cut down.
- **A fold covers everything before the run's latest step,** and never
  falls between a tool call and its result. The run's opening message
  is sent again after the summary.
- **Each fold is recorded in the workspace** (`ws.compaction`) and
  streamed as `Compacted`. A checkout before it takes it back, and a
  full fork carries it.
- **Summary calls count** against `maxSteps` and in the run's usage
  (`Run.compaction`).

Set the budget well above what no fold can take out (the system prompt,
the tools, the opening message).

## In a browser

The same code runs in a browser, with the store on IndexedDB and the
code kernel in a Web Worker (the world's built `worker.js`; bundlers
need it served, or `profile.code.worker.url` pointing at it). Anthropic
needs `headers: { 'anthropic-dangerous-direct-browser-access': 'true' }`
for a key in the page.

## Conformance

`agex-ts/conformance` runs agex-ts against the Python projects'
corpora, so the two stay aligned on meaning: nontainer's harness corpus
(sessions, endings, the inbox, folding and delegation; `agexHarness`)
and agex's shape corpus (tasks, `AgexTasks`; agent-defined tasks,
`runCodeScenario`). Every scenario that applies passes; tables and
arrays aren't carried yet.

`scripts/smoke.mjs` runs sessions, folding, delegation, tasks and
agent-defined tasks on each real provider whose key is set
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`): `pnpm build && node scripts/smoke.mjs`.

## License

MIT
