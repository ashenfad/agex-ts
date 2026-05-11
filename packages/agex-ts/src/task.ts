/**
 * Task lifecycle — `agent.task({ description, input?, output? })`
 * returns a typed callable that drives the action loop.
 *
 * Per turn:
 *   1. Build `LLMRequest` from system prompt + event log.
 *   2. Stream from `LLMClient.complete()`. Forward chunks to
 *      `onToken`. Assemble full `Emission`s from `done` boundaries.
 *   3. Append an `ActionEvent` carrying the ordered emissions (with
 *      provider signatures intact).
 *   4. Dispatch each emission. `ts` runs through `RuntimeAdapter`;
 *      richer dispatch (file ops, terminal) lands in the next commit.
 *   5. Resolve the task on `taskSuccess` / `taskFail` / `taskClarify`;
 *      otherwise loop until `maxIterations`.
 *
 * Cancellation: the host `AbortSignal` is threaded into both the
 * runtime and the LLM client; aborting writes a `CancelledEvent`
 * and rejects with `CancelledError`.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec'
import { TerminalError } from 'termish-ts'
import type { Agent } from './agent'
import { runChaptering, shouldTriggerChaptering } from './chaptering'
import { dispatchFileEdit, dispatchFileWrite, dispatchTerminal } from './dispatcher'
import {
  CancelledError,
  SchemaError,
  TaskClarifyError,
  TaskFailError,
  isCancelledError,
} from './errors'
import type { EventLogImpl } from './event-log'
import { buildSystemMessage, buildTaskMessage, makeToolUseId, renderEvents } from './render'
import type {
  ActionEvent,
  AgentEvent,
  ClarifyEvent,
  Emission,
  ExecuteContext,
  FailEvent,
  LLMClient,
  OutputEvent,
  OutputPart,
  Policy,
  RuntimeAdapter,
  SuccessEvent,
  TaskCallOptions,
  TaskFn,
  TaskStartEvent,
  TokenChunk,
  VirtualFileSystem,
} from './types'

const DEFAULT_SESSION = 'default'

export interface TaskDefinition<I, O> {
  /** What this task does — surfaced in the per-task user message. */
  readonly description: string
  /** Optional Standard Schema for input validation. The renderer
   *  also tries to extract a JSON Schema from this for shape
   *  presentation; supply `inputJsonSchema` to override. */
  readonly input?: StandardSchemaV1<I, I>
  /** Optional Standard Schema for output validation. */
  readonly output?: StandardSchemaV1<O, O>
  /** Optional override for the JSON Schema sent to the agent for
   *  inputs. Use when your validator's introspection isn't picked
   *  up automatically, or when you want a stripped-down shape. */
  readonly inputJsonSchema?: object
  /** Optional override for the JSON Schema sent to the agent for
   *  the expected output. Same use cases as `inputJsonSchema`. */
  readonly outputJsonSchema?: object
  /** Optional prose description of the input shape. Surfaced when
   *  no JSON Schema is available; useful for handwritten guidance
   *  beyond what schema introspection can express. */
  readonly inputDescription?: string
  /** Optional prose description of the expected output. Same role
   *  as `inputDescription` but for the return value. */
  readonly outputDescription?: string
  /** Optional task-specific addendum surfaced after the
   *  description in the per-task user message. */
  readonly primer?: string
}

/** Build a task function. The optional `taskName` overrides the
 *  default of deriving the name from the description's first line —
 *  used internally by `agent.chapterTask` to stamp chapter-task events
 *  with the reserved `__chapter__` name so the renderer / chaptering
 *  index builder can recognise them. End-user tasks should leave
 *  `taskName` undefined and let `deriveTaskName` produce a stable key. */
export function makeTask<I, O>(
  agent: Agent,
  def: TaskDefinition<I, O>,
  taskName?: string,
): TaskFn<I, O> {
  return async (input: I, options: TaskCallOptions = {}): Promise<O> => {
    const llmClient = agent.llm ?? throwMissing('llm')
    const runtimeAdapter = agent.runtime ?? throwMissing('runtime')

    const session = options.session ?? DEFAULT_SESSION
    const signal = options.signal ?? new AbortController().signal
    // Per-session host APIs are async — the underlying state /
    // VFS / cache may need to open an IndexedDB or SQLite store.
    // Resolve them up front so the loop body can use them
    // synchronously.
    const eventLog = await agent.events(session)
    const fs = await agent.fs(session)
    const cache = await agent.cache(session)

    // -- Validate input ---------------------------------------------------
    let validatedInput: I = input
    if (def.input !== undefined) {
      validatedInput = await validateOrThrow(def.input, input, 'input')
    }

    // -- Initialize runtime ----------------------------------------------
    await runtimeAdapter.init(agent.policy())

    // Make sure registered skills are visible at /skills/<name>/SKILL.md
    // before the agent starts running.
    await agent.refreshSkillsOverlay(session)

    // -- Log TaskStartEvent ----------------------------------------------
    // The full task message lives on the event so renderEvents can
    // place it correctly in the conversation. Without this, sessions
    // that span multiple tasks would render task 2's prompt before
    // task 1's actions — confusing the model into thinking it
    // misread the task.
    const taskMessage = buildTaskMessage(def, validatedInput)
    const startEvent: TaskStartEvent = {
      type: 'taskStart',
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      taskName: taskName ?? deriveTaskName(def),
      inputs: validatedInput,
      message: taskMessage,
    }
    await emit(startEvent, eventLog, options.onEvent)

    // -- Action loop -----------------------------------------------------
    let iter = 0
    const maxIter = agent.maxIterations
    // Stable across the loop — only changes if the agent's
    // registration table mutates mid-task (it shouldn't).
    // Optional addendum from the runtime adapter — e.g.
    // workerRuntime contributes a note when `routeFetchToVfs` is on
    // so the agent knows VFS is reachable via `fetch`.
    const runtimeAddendum = runtimeAdapter.primerAddendum?.()
    const system = buildSystemMessage({
      policy: agent.policy(),
      ...(agent.agexPrimerOverride !== undefined && {
        agexPrimerOverride: agent.agexPrimerOverride,
      }),
      ...(agent.capabilitiesPrimer !== undefined && {
        capabilitiesPrimer: agent.capabilitiesPrimer,
      }),
      ...(agent.primer !== undefined && { agentPrimer: agent.primer }),
      ...(runtimeAddendum !== undefined && { runtimeAddendum }),
    })

    // Most recent recoverable error from agent code, surfaced in the
    // maxIterations exhaust message so callers can see "loop ran out
    // while still erroring." Cleared whenever an emission completes
    // without erroring — only the *last* error counts for the message.
    let lastError: string | undefined
    try {
      while (iter < maxIter) {
        if (signal.aborted) throw new CancelledError()
        iter++

        // Stream + assemble emissions
        const events = await collectEvents(eventLog)
        // renderEvents emits the TaskStartEvent as a user turn (using
        // the message stamped on the event), so we don't prepend
        // anything — the current task's opening message lands at the
        // correct position in the conversation, after any prior
        // task's events.
        const turns = renderEvents(events)
        const emissions: Emission[] = []
        let inputTokens: number | undefined
        let outputTokens: number | undefined

        for await (const chunk of llmClient.complete({ system, turns }, signal)) {
          if (signal.aborted) throw new CancelledError()
          if (options.onToken !== undefined) await options.onToken(chunk)
          if (chunk.done && chunk.emission !== undefined) emissions.push(chunk.emission)
          if (chunk.inputTokens !== undefined) inputTokens = chunk.inputTokens
          if (chunk.outputTokens !== undefined) outputTokens = chunk.outputTokens
        }

        // Log ActionEvent — order + signatures are immutable from here.
        const actionEvent: ActionEvent = {
          type: 'action',
          timestamp: new Date().toISOString(),
          agentName: agent.name,
          emissions,
          ...(inputTokens !== undefined && { inputTokens }),
          ...(outputTokens !== undefined && { outputTokens }),
        }
        await emit(actionEvent, eventLog, options.onEvent)

        // Dispatch
        const ctx: ExecuteContext = {
          fs,
          cache,
          signal,
          ...(validatedInput !== undefined && { inputs: validatedInput }),
        }
        const outcome = await dispatchEmissions(
          emissions,
          actionEvent.timestamp,
          runtimeAdapter,
          ctx,
          fs,
          agent.policy(),
          agent.name,
          eventLog,
          options.onEvent,
        )

        // Terminal outcomes
        if (outcome.kind === 'success') {
          let result = outcome.value as O
          if (def.output !== undefined) {
            result = await validateOrThrow(def.output, result, 'output')
          }
          const successEvent: SuccessEvent = {
            type: 'success',
            timestamp: new Date().toISOString(),
            agentName: agent.name,
            result,
          }
          await emit(successEvent, eventLog, options.onEvent)
          await maybeFireBoundaryChaptering(agent, session, eventLog, signal, options.onEvent)
          return result
        }
        if (outcome.kind === 'fail') {
          const failEvent: FailEvent = {
            type: 'fail',
            timestamp: new Date().toISOString(),
            agentName: agent.name,
            message: outcome.message,
          }
          await emit(failEvent, eventLog, options.onEvent)
          await maybeFireBoundaryChaptering(agent, session, eventLog, signal, options.onEvent)
          throw new TaskFailError(outcome.message)
        }
        if (outcome.kind === 'clarify') {
          const clarifyEvent: ClarifyEvent = {
            type: 'clarify',
            timestamp: new Date().toISOString(),
            agentName: agent.name,
            message: outcome.message,
          }
          await emit(clarifyEvent, eventLog, options.onEvent)
          await maybeFireBoundaryChaptering(agent, session, eventLog, signal, options.onEvent)
          throw new TaskClarifyError(outcome.message)
        }
        // outcome.kind === 'continue' → next iteration
        lastError = outcome.lastError
      }

      // Loop budget exhausted — surface the last recoverable error if
      // any, so callers can tell "the agent ran out of turns while still
      // erroring" apart from "the agent ran out of turns silently."
      const exhaustMessage =
        lastError !== undefined
          ? `Task exceeded maxIterations (${maxIter})\nLast error: ${lastError}`
          : `Task exceeded maxIterations (${maxIter})`
      const failEvent: FailEvent = {
        type: 'fail',
        timestamp: new Date().toISOString(),
        agentName: agent.name,
        message: exhaustMessage,
      }
      await emit(failEvent, eventLog, options.onEvent)
      await maybeFireBoundaryChaptering(agent, session, eventLog, signal, options.onEvent)
      throw new TaskFailError(exhaustMessage)
    } catch (e) {
      if (isCancelledError(e)) {
        await emit(
          {
            type: 'cancelled',
            timestamp: new Date().toISOString(),
            agentName: agent.name,
            taskName: taskName ?? deriveTaskName(def),
            iterationsCompleted: iter,
          },
          eventLog,
          options.onEvent,
        )
      }
      throw e
    }
    // No dispose() per-task — the runtime adapter is meant to be
    // long-lived across task calls (a worker stays warm, eval-runtime
    // keeps its policy ref). dispose() is for agent shutdown, not for
    // per-task cleanup. Disposing here would also break nested task
    // calls (parent task → chapter task): the inner task's finally
    // would tear down the runtime out from under the outer task.
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Internal result of walking an action's emissions. Mirrors
 * `TaskOutcome` for terminal cases (success / fail / clarify) and
 * extends `continue` with an optional `lastError` carried up to the
 * outer loop so a later `maxIterations` exhaust can surface "the most
 * recent error before we gave up" — matches agex-py's `last_error`.
 */
type DispatchResult =
  | { readonly kind: 'success'; readonly value: unknown }
  | { readonly kind: 'fail'; readonly message: string }
  | { readonly kind: 'clarify'; readonly message: string }
  | { readonly kind: 'continue'; readonly lastError?: string }

async function dispatchEmissions(
  emissions: ReadonlyArray<Emission>,
  actionTimestamp: string,
  runtime: RuntimeAdapter,
  ctx: ExecuteContext,
  fs: VirtualFileSystem,
  policy: Policy,
  agentName: string,
  eventLog: { add(e: AgentEvent): Promise<string> },
  onEvent: ((e: AgentEvent) => void | Promise<void>) | undefined,
): Promise<DispatchResult> {
  for (let i = 0; i < emissions.length; i++) {
    const em = emissions[i] as Emission
    if (ctx.signal.aborted) throw new CancelledError()
    const emissionId = makeToolUseId(actionTimestamp, i)

    if (em.type === 'ts') {
      const result = await runtime.execute(em.code, { ...ctx, emissionId })

      // Cancellation surfaced by the runtime: re-raise so the outer
      // catch emits CancelledEvent rather than swallowing it.
      // `isCancelledError` (not `instanceof`) — worker-originated
      // cancellations come back as plain Errors with the right `name`
      // but no `CancelledError` prototype.
      if (result.error !== null && result.outcome.kind === 'continue') {
        if (isCancelledError(result.error) || ctx.signal.aborted) {
          throw new CancelledError(result.error.message)
        }
      }

      // Bundle any captured stdout with the error part (if any) into a
      // single OutputEvent for this emission. Pairing them keeps the
      // emissionId-tagged tool_result stream dense.
      //
      // Direct `.message` access (not `describeError`) is intentional:
      // `result.error` is typed `Error | null` per the RuntimeAdapter
      // contract, and even for a loose third-party adapter that hands
      // back a non-Error object with a `.message` property, the direct
      // read extracts the right string — `describeError` would fall to
      // its `String(e)` branch and produce `"[object Object]"`.
      const parts: OutputPart[] = [...result.outputs]
      if (result.error !== null && result.outcome.kind === 'continue') {
        parts.push({
          type: 'error',
          errorName: result.error.name || 'Error',
          errorMessage: result.error.message,
        })
      }
      if (parts.length > 0) {
        const outputEvent: OutputEvent = {
          type: 'output',
          timestamp: new Date().toISOString(),
          agentName,
          emissionId,
          parts,
        }
        await emit(outputEvent, eventLog, onEvent)
      }

      if (result.error !== null && result.outcome.kind === 'continue') {
        // Recoverable: stop walking emissions for this action — the
        // agent gets to read the error on its next iteration and decide
        // what to do. Matches agex-py's `break` after `recoverable_error`.
        return { kind: 'continue', lastError: describeError(result.error) }
      }
      if (result.outcome.kind !== 'continue') return result.outcome
      continue
    }

    if (em.type === 'fileWrite') {
      try {
        await dispatchFileWrite(em, fs)
      } catch (e) {
        await emitErrorOutput(e, agentName, emissionId, eventLog, onEvent)
        return { kind: 'continue', lastError: describeError(e) }
      }
      continue
    }

    if (em.type === 'fileEdit') {
      try {
        await dispatchFileEdit(em, fs)
      } catch (e) {
        await emitErrorOutput(e, agentName, emissionId, eventLog, onEvent)
        return { kind: 'continue', lastError: describeError(e) }
      }
      continue
    }

    if (em.type === 'terminal') {
      try {
        const stdout = await dispatchTerminal(em.commands, fs, policy, ctx.signal)
        if (stdout.length > 0) {
          const outputEvent: OutputEvent = {
            type: 'output',
            timestamp: new Date().toISOString(),
            agentName,
            emissionId,
            parts: [{ type: 'text', text: stdout }],
          }
          await emit(outputEvent, eventLog, onEvent)
        }
      } catch (e) {
        // TerminalError carries any partial stdout captured before the
        // failing pipeline (`interpreter.ts` accumulates output across
        // pipelines and stashes it on `partialOutput`). Surface it
        // alongside the error so the agent can see what made it
        // through — otherwise multi-step terminal scripts that fail
        // late look like atomic-all-or-nothing.
        const partial = e instanceof TerminalError ? e.partialOutput : ''
        await emitErrorOutput(e, agentName, emissionId, eventLog, onEvent, partial)
        return { kind: 'continue', lastError: describeError(e) }
      }
    }

    // text / thinking — already in the event log via the ActionEvent;
    // no further side effect.
  }
  return { kind: 'continue' }
}

async function emitErrorOutput(
  e: unknown,
  agentName: string,
  emissionId: string,
  eventLog: { add(e: AgentEvent): Promise<string> },
  onEvent: ((e: AgentEvent) => void | Promise<void>) | undefined,
  precedingStdout = '',
): Promise<void> {
  const errorName = e instanceof Error ? e.name || 'Error' : 'Error'
  const errorMessage = e instanceof Error ? e.message : String(e)
  const parts: OutputPart[] = []
  if (precedingStdout.length > 0) {
    parts.push({ type: 'text', text: precedingStdout })
  }
  parts.push({ type: 'error', errorName, errorMessage })
  const outputEvent: OutputEvent = {
    type: 'output',
    timestamp: new Date().toISOString(),
    agentName,
    emissionId,
    parts,
  }
  await emit(outputEvent, eventLog, onEvent)
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function collectEvents(log: { iter(): AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of log.iter()) out.push(e)
  return out
}

async function emit(
  event: AgentEvent,
  log: { add(e: AgentEvent): Promise<string> },
  onEvent: ((e: AgentEvent) => void | Promise<void>) | undefined,
): Promise<void> {
  await log.add(event)
  if (onEvent !== undefined) await onEvent(event)
}

/** Fire chaptering at a task boundary. Called from each terminal-
 *  outcome path (success / fail / clarify, including the budget-
 *  exhaustion fail) after the terminal event lands in the log but
 *  before the task call returns or throws.
 *
 *  Skipped on caller-cancellation (`signal.aborted`) — if the user
 *  is signaling they want out, we don't add work. Errors that escape
 *  the task loop never reach here at all (the catch path re-throws
 *  before we'd run).
 *
 *  Per-action chaptering used to live inside the loop and fire
 *  whenever the latest `inputTokens` exceeded the threshold. Moving
 *  to task-boundary firing keeps chapter events out of the middle
 *  of an in-progress task's render and gives the chapter task a
 *  cleanly closed parent to fold. Single long tasks with no
 *  completed sub-tasks aren't helped by chaptering at all (their
 *  only boundary is in-progress until they end); the deferred
 *  overflow-protection mechanism in roadmap.md covers that case. */
async function maybeFireBoundaryChaptering(
  agent: Agent,
  session: string,
  eventLog: EventLogImpl,
  signal: AbortSignal,
  onEvent: ((e: AgentEvent) => void | Promise<void>) | undefined,
): Promise<void> {
  if (agent.getChapterTask() === undefined) return
  if (signal.aborted) return
  const allEvents = await collectEvents(eventLog)
  if (!shouldTriggerChaptering(allEvents, agent.chapteringTrigger)) return
  await runChaptering(allEvents, eventLog, agent, session, signal, async (e) => {
    if (onEvent !== undefined) await onEvent(e)
  })
}

function deriveTaskName<I, O>(def: TaskDefinition<I, O>): string {
  // First sentence of the description, capped, as a stable key for
  // event logging. Tasks don't have explicit names in v1.
  const firstLine = def.description.split('\n')[0] ?? def.description
  return firstLine.slice(0, 80)
}

async function validateOrThrow<T>(
  schema: StandardSchemaV1<T, T>,
  value: unknown,
  side: 'input' | 'output',
): Promise<T> {
  const result = await schema['~standard'].validate(value)
  if ('issues' in result && result.issues !== undefined) {
    const issues = result.issues.map((i) => ({
      path: (i.path ?? []).map((p) =>
        typeof p === 'object' && p !== null ? (p.key as PropertyKey) : p,
      ),
      message: i.message,
    }))
    throw new SchemaError(
      `${side} validation failed: ${issues.map((i) => i.message).join('; ')}`,
      issues,
    )
  }
  return (result as { value: T }).value
}

function throwMissing(field: 'llm' | 'runtime'): never {
  throw new Error(`agent.task: missing required ${field} (pass via createAgent({ ${field}: ... }))`)
}
