# agex-ts

An agent loop over [`@agex-ts/world`](../world): sessions and typed
tasks, with code as the action space. The TypeScript counterpart of
[agex](https://github.com/ashenfad/agex), matching its meaning.

> **Status:** being rewritten on the `rebuild` branch, step by step (the
> repo's `plan.md`, "Then agex-ts"). So far: the session loop, the run
> record, the provider protocol with a scripted provider, any AI SDK
> model as a provider, folding, delegation, and agex's shape corpus
> (`agex-ts/conformance`). Tasks come next. The published 0.5.x is the
> previous design, which this replaces.

## Sessions

```ts
const agent = new Agent({ model, primer: 'You build study apps.' })
const chat = agent.session(ws) // ws: a world Workspace

const out = await chat.say('make a flashcard app') // Outcome: status, text, head, events
for await (const event of chat.stream('add a timer')) render(event) // TurnEvents as they happen
chat.inbox.put('also add a shuffle button') // rides the next tool result
chat.cancel('stopped by the user') // the turn ends cancelled, its work kept
```

- **A turn is one run inside `ws.turn`.** The model is asked, the tools
  it calls run against the workspace (each mutating call committed), and
  the loop goes round until the model answers without calling one. The
  turn's end stores the run (agex's own record) and lands a commit
  stamped with how it ended.
- **Endings:** `completed`, `cancelled`, `failed` (an error, or
  `maxSteps` model calls) or `interrupted` (a provider error worth
  retrying), which `resume()` continues in place and `abandon(reason)`
  ends. A cancelled or failed turn keeps its work with a closing note.
  None of them throw.
- **Limits:** `maxSteps` model calls per run, and `maxToolCalls`, past
  which the model is told to reply and further calls aren't run.
- **The agent holds nothing:** a change of model or primer is a new
  `Agent` for the next turn, with the same workspace and inbox.

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
  parent's settings and profile, and nothing more.
- A `Sessions` of your own (`{ sessions: helper }`) runs every ask on
  its own runner.

## Models

Any [AI SDK](https://ai-sdk.dev) model is a model: install its provider
and hand the model to the agent. agex-ts drives its `doStream` directly,
without the AI SDK's core, and depends on `@ai-sdk/provider` alone.

```ts
import { createAnthropic } from '@ai-sdk/anthropic'

const model = createAnthropic({ apiKey })('claude-haiku-5-5')
const agent = new Agent({ model, settings: { thinking: 'medium', maxTokens: 8000 } })
```

- **Thinking** is an effort (`'minimal'` to `'xhigh'`, `true` or
  `false`), which each provider maps for its model. The model's
  reasoning, and whatever its provider attached to a part (signatures,
  encrypted reasoning), is kept in the run and sent back to that
  provider alone, so a session can change providers between turns.
- **`settings.extra`** is provider options, by provider
  (`{ anthropic: { cacheControl: { type: 'ephemeral' } } }`).
- **Errors:** a rate limit, an overload, a server error or a provider out
  of reach interrupts the turn (`resume()` continues it); a refused
  request fails it, in the provider's words.
- In a browser, Anthropic needs
  `headers: { 'anthropic-dangerous-direct-browser-access': 'true' }`.

`scripts/smoke.mjs` runs a session on each provider whose key is set
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`OPENROUTER_API_KEY`): `pnpm build && node scripts/smoke.mjs`.
