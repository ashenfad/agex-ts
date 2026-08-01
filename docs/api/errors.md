# Errors

agex-ts has two distinct error categories: **task-control errors** the agent raises to end its task, and **framework errors** for misconfigurations and unexpected failures.

## Task-control errors

These two are raised by the framework on the caller's side when the agent calls `taskFail` or the task is cancelled. Each maps to one event in the log.

### `TaskFailError`

```ts
class TaskFailError extends Error {
  readonly name: 'TaskFailError'
  readonly message: string
}
```

The agent decided the task is impossible — technical impossibility, security violation, unrecoverable infrastructure error. Distinct from "code crashed" — when agent code throws, the agent sees the stack trace next turn and can adjust. `taskFail` is for "this can't be done."

```ts
try {
  await summarize(items)
} catch (e) {
  if (e instanceof TaskFailError) {
    console.log('agent gave up:', e.message)
  }
}
```

The agent's message is preserved as `e.message`. A `FailEvent` lands in the session's log.

### `CancelledError`

```ts
class CancelledError extends Error {
  readonly name: 'CancelledError'
  readonly message: string
}
```

Raised when the task's `AbortSignal` fires. Distinct from `TaskFailError` — cancellation is the caller's decision, not the agent's.

```ts
const ac = new AbortController()
setTimeout(() => ac.abort(), 5_000)

try {
  await longTask(input, { signal: ac.signal })
} catch (e) {
  if (e instanceof CancelledError) {
    console.log('cancelled after timeout')
  }
}
```

A `CancelledEvent` lands in the log with the iteration count completed before the abort. The substrate is left in whatever state the last fully-applied turn produced.

### `isTaskControlError`

```ts
import { isTaskControlError } from 'agex-ts'

if (isTaskControlError(e)) {
  // e is TaskFailError | CancelledError
}
```

Use to handle both in one branch.

## Framework errors

### `RegistrationError`

```ts
class RegistrationError extends Error {
  readonly name: 'RegistrationError'
}
```

Eagerly thrown at `agent.fn` / `agent.cls` / `agent.namespace` / `agent.skill` / `agent.terminal` / `agent.chapterTask` time. Validates:

- Name shape (`[A-Za-z_][A-Za-z0-9_]*`).
- Name uniqueness across all registration kinds.
- Live value xor URL spec (exactly one).
- URL non-empty.
- `paramsSchema` not combined with `url` on `fn`.
- `constructable: false` not combined with `url` on `cls`.
- `include` / `exclude` / `configure` not combined with `url` on `cls` / `namespace`.

Surfaces immediately — the misconfiguration throws on the registration call, not on the first task.

### `SchemaError`

```ts
class SchemaError extends Error {
  readonly name: 'SchemaError'
}
```

Standard Schema validation failure. Two paths:

- **Input validation** (host-side, before the task starts): thrown to the caller immediately — agent never runs.
- **Output validation** (when agent calls `taskSuccess(...)`): the agent sees a runtime error inside its TS and tries again.

### `CancelledError` (also raised from worker timeouts)

`CancelledError` is the same class shown in the task-control section above. It's worth noting it surfaces from two paths: the agent loop's abort path (the caller cancelled via `AbortSignal`) and worker termination on timeout (the runtime adapter killed the worker after `timeoutMs`).

## Errors that don't bubble

Two classes of errors stay inside the agent's view rather than surfacing to the caller:

| What | Where it goes |
|---|---|
| Agent code throws (TS error, runtime exception) | Captured as part of the next turn's context. Agent sees the stack trace and adjusts. |
| `paramsSchema` validation fails for a fn call | Surfaces as a runtime error inside the agent's TS. Agent retries. |
| `output:` schema validation fails | Same — agent sees and retries. |

This is intentional — wrapping every potential failure in a `try/catch` would make the agent feel like it's running a brittle harness. Letting errors land in stdout-style observations lets the agent debug and adjust.

## `FatalError` / `TransientError`

```ts
class FatalError extends Error {
  readonly name: 'FatalError'
}
class TransientError extends Error {
  readonly name: 'TransientError'
}
```

Distinguish failures worth retrying (`TransientError` — network blip, 429) from ones that aren't (`FatalError` — auth failure, malformed request).

These are an **extension point, not a path the bundled providers take**: `@agex-ts/anthropic`, `@agex-ts/openai` and `@agex-ts/gemini` classify retryable failures with `isTransientNetworkError` (exported from `agex-ts/providers`) and re-throw the original error rather than wrapping it. Nothing in agex-ts throws either class today. They're exported for embedders writing their own `LLMClient` who want a typed retry signal — `TransientError`'s optional `retryAfterMs` is the hint a custom client can carry.

## `AgentError`

```ts
class AgentError extends Error {
  readonly name: 'AgentError'
}
```

Base class for agex-ts's error hierarchy. `instanceof AgentError` matches all framework errors but not `TaskFailError` / `CancelledError` (which are control flow, not framework failures).

## Patterns

### Distinguishing agent decision vs framework failure

```ts
try {
  await myTask(input)
} catch (e) {
  if (e instanceof TaskFailError)     handleAgentFail(e)
  else if (e instanceof CancelledError)   handleCancel(e)
  else if (e instanceof RegistrationError) reportConfigBug(e)
  else if (e instanceof SchemaError)       reportInputBug(e)
  else throw e  // unexpected — let it bubble
}
```
