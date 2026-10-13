# agex-ts

An agent loop over [`@agex-ts/world`](../world): sessions and typed
tasks, with code as the action space. The TypeScript counterpart of
[agex](https://github.com/ashenfad/agex), matching its meaning.

> **Status:** being rewritten on the `rebuild` branch, step by step (the
> repo's `plan.md`, "Then agex-ts"). So far: the session loop, the run
> record, the provider protocol with a scripted provider, and agex's
> shape corpus (`agex-ts/conformance`). Real providers, folding,
> delegation and tasks come next. The published 0.5.x is the previous
> design, which this replaces.

## Sessions

```ts
const agent = new Agent({ model: provider, primer: 'You build study apps.' })
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
