# Events

Every meaningful moment in an agent's run lands in the session's event log: task lifecycle, model emissions, tool outputs, errors, chapter compactions. Events drive both the LLM-rendered conversation and the live `onEvent` stream embedders use for UIs.

## Stream + log

Two views of the same data:

- **Live stream** — pass `onEvent` to a task call. Fires for every event written to the log, in order.
- **Persisted log** — `await agent.events(session)`, then iterate. Yields events from the log, including ones written across multiple task calls in the same session.

```ts
// Live (during a single task call)
await myTask(input, {
  onEvent: (e) => console.log(e.type),
})

// Persisted (across task calls)
const log = await agent.events('alice')
for await (const e of log.iter()) {
  console.log(e.type)
}
```

The persisted log honors chapter splicing: chaptered ranges yield the `ChapterEvent` in place of the originals.

## `EventBase`

```ts
interface EventBase {
  readonly type: string
  readonly timestamp: string         // ISO 8601 UTC
  readonly agentName: string
}
```

Every event extends this. `timestamp` is set at write time; `agentName` is the agent that produced the event.

## Event types

### `TaskStartEvent`

```ts
interface TaskStartEvent extends EventBase {
  readonly type: 'taskStart'
  readonly taskName: string
  readonly inputs: unknown
  readonly message?: string  // pre-rendered task user message
}
```

Marks the start of a task. `taskName` is the task's stable identifier — derived from the task description's first line, or `__chapter__` for the chapter task. The renderer uses `message` (the per-task user message) as the user turn for this task.

### `ActionEvent`

```ts
interface ActionEvent extends EventBase {
  readonly type: 'action'
  readonly emissions: ReadonlyArray<Emission>
  readonly inputTokens?: number
  readonly outputTokens?: number
}
```

One LLM turn's worth of emissions. The agent loop appends one `ActionEvent` per turn after the LLM stream completes. Emissions are tool-use-shaped: `ts` (TypeScript code), `terminal` (shell command), `fileWrite`, `fileEdit`, plus narrative `text` and `thinking` parts.

`inputTokens` is the prompt-token count from the provider; the chaptering trigger reads this.

### `OutputEvent`

```ts
interface OutputEvent extends EventBase {
  readonly type: 'output'
  readonly parts: ReadonlyArray<OutputPart>
  readonly emissionId?: string  // pairs with the source emission
}

type OutputPart =
  | { type: 'text';  text: string }
  | { type: 'image'; format: 'png' | 'jpeg' | 'webp'; data: string; altText?: string }
```

What the agent's tool emissions produced as observable output. `console.log` calls become `text` parts by default; image-shaped values (`{format,data}` objects, `data:image/...;base64,...` strings, or PNG/JPEG/WebP `Uint8Array`s) split out into `image` parts; terminal stdout becomes `text`. The renderer pairs `emissionId` back to the originating tool-use block when building tool-result turns.

### `SuccessEvent`

```ts
interface SuccessEvent extends EventBase {
  readonly type: 'success'
  readonly result: unknown
}
```

The agent called `taskSuccess(result)`. Closes out the task.

### `FailEvent`

```ts
interface FailEvent extends EventBase {
  readonly type: 'fail'
  readonly message: string
}
```

The agent called `taskFail(message)`. The framework throws `TaskFailError` to the caller.

### `ClarifyEvent`

```ts
interface ClarifyEvent extends EventBase {
  readonly type: 'clarify'
  readonly message: string
}
```

The agent called `taskClarify(message)` — needs human input. Distinct from `fail`. The framework throws `TaskClarifyError`.

### `CancelledEvent`

```ts
interface CancelledEvent extends EventBase {
  readonly type: 'cancelled'
  readonly taskName: string
  readonly iterationsCompleted: number
}
```

The task was aborted via its `AbortSignal`. The framework throws `CancelledError`.

### `ErrorEvent`

```ts
interface ErrorEvent extends EventBase {
  readonly type: 'error'
  readonly errorName: string
  readonly errorMessage: string
}
```

Unexpected error: parse failure, transform error, runtime crash, etc. Distinct from task-control errors (fail / clarify / cancelled), which surface as their own event types. `error` events are filtered out of the LLM render.

### `FileEvent`

```ts
interface FileEvent extends EventBase {
  readonly type: 'file'
  readonly added: ReadonlyArray<string>
  readonly modified: ReadonlyArray<string>
  readonly removed: ReadonlyArray<string>
  readonly fileSource: string
}
```

Recap of a batch of filesystem changes (e.g. from a single action's `fileWrite` / `fileEdit` emissions). Useful for live UIs showing the agent's VFS edits.

### `SystemNoteEvent`

```ts
interface SystemNoteEvent extends EventBase {
  readonly type: 'systemNote'
  readonly message: string
}
```

Framework-emitted note that crosses into the agent's render. Currently used for chaptering failures: when the chapter task throws, a `systemNote` lands in the log with the failure message.

### `ChapterEvent`

```ts
interface ChapterEvent extends EventBase {
  readonly type: 'chapter'
  readonly name: string
  readonly message: string
  readonly slug: string                       // URL-safe, unique within session
  readonly eventRefs: ReadonlyArray<string>   // state keys of folded events
}
```

The result of one chaptering — a contiguous range of events folded into a single summary in the active log. The originals stay at their state keys (referenced by `eventRefs`) and are browseable via the `/chapters/<slug>/` VFS overlay.

See [Chapters](../concepts/chapters.md) for the model.

## `AgentEvent` union

```ts
type AgentEvent =
  | TaskStartEvent
  | ActionEvent
  | OutputEvent
  | SuccessEvent
  | FailEvent
  | ClarifyEvent
  | CancelledEvent
  | ErrorEvent
  | FileEvent
  | SystemNoteEvent
  | ChapterEvent
```

`onEvent` and `EventLog.iter()` both yield this union.

## `EventLog`

```ts
interface EventLog {
  add(event: AgentEvent): Promise<string>
  iter(): AsyncIterable<AgentEvent>
  at(commitHash: string): Promise<EventLog | null>
}
```

The append-only log surface. `add(event)` writes and returns the storage key. `iter()` yields events in chronological order — with chapter splicing applied (chaptered ranges show up as `ChapterEvent`). For historical views (the log as it was at a past commit), use `agent.eventsAt(hash, session)` instead of `at()` on a live log instance.

`EventLogImpl` (the concrete class returned by `agent.events(session)`) adds `refs()` (read-only access to the index) and `replaceRange(refs, chapterEvent)` (used by the chaptering machinery).

## Live-stream patterns

### Filter by type

```ts
await myTask(input, {
  onEvent: (e) => {
    switch (e.type) {
      case 'taskStart': ui.startTask(e.taskName); break
      case 'output':    ui.appendOutput(e.parts); break
      case 'chapter':   ui.showChapter(e); break
      case 'success':   ui.completeTask(e.result); break
    }
  },
})
```

### Stream with persistence

```ts
await myTask(input, {
  onEvent: async (e) => {
    ui.update(e)               // live UI
    await db.recordEvent(e)    // persistent record
  },
})
```

### Token streaming + event streaming together

```ts
await myTask(input, {
  onToken: (chunk) => ui.appendStreamingText(chunk.text),
  onEvent: (e) => ui.handleEvent(e),
})
```

## Pretty-printing

```ts
import { prettyEvents } from 'agex-ts'

const log = await agent.events('alice')
const events: AgentEvent[] = []
for await (const e of log.iter()) events.push(e)

console.log(prettyEvents(events))
```

`prettyEvents` produces a human-readable transcript — useful for debugging and CLI tools. `prettyTokens` renders a token stream similarly.

## Inspecting historical events

When state is versioned, `agent.eventsAt(hash, session)` opens the log as it was at a historical commit:

```ts
const log = await agent.eventsAt(commitHash, 'alice')
const events: AgentEvent[] = []
for await (const e of log!.iter()) events.push(e)
```

This is how you implement time-travel debugging or reconstruct what the agent saw at a past decision point.
