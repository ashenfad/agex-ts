# agex-ts

An agent loop over [`@agex-ts/world`](../world): sessions and typed
tasks, with code as the action space. The TypeScript counterpart of
[agex](https://github.com/ashenfad/agex), matching its meaning.

> **Status:** being rewritten on the `rebuild` branch, step by step (the
> repo's `plan.md`, "Then agex-ts"). So far: the session loop, the run
> record, the provider protocol with a scripted provider, any AI SDK
> model as a provider, and agex's shape corpus (`agex-ts/conformance`).
> Folding, delegation and tasks come next. The published 0.5.x is the
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
