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
import type { Agent } from './agent'
import { runChaptering, shouldTriggerChaptering } from './chaptering'
import { dispatchFileEdit, dispatchFileWrite, dispatchTerminal } from './dispatcher'
import { CancelledError, SchemaError, TaskClarifyError, TaskFailError } from './errors'
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
  Policy,
  RuntimeAdapter,
  SuccessEvent,
  TaskCallOptions,
  TaskFn,
  TaskOutcome,
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

export function makeTask<I, O>(agent: Agent, def: TaskDefinition<I, O>): TaskFn<I, O> {
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
      taskName: deriveTaskName(def),
      inputs: validatedInput,
      message: taskMessage,
    }
    await emit(startEvent, eventLog, options.onEvent)

    // -- Action loop -----------------------------------------------------
    let iter = 0
    const maxIter = agent.maxIterations
    // Stable across the loop — only changes if the agent's
    // registration table mutates mid-task (it shouldn't).
    const system = buildSystemMessage({
      policy: agent.policy(),
      ...(agent.agexPrimerOverride !== undefined && {
        agexPrimerOverride: agent.agexPrimerOverride,
      }),
      ...(agent.capabilitiesPrimer !== undefined && {
        capabilitiesPrimer: agent.capabilitiesPrimer,
      }),
      ...(agent.primer !== undefined && { agentPrimer: agent.primer }),
    })

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

        // Chaptering — context compaction triggered by token budget.
        // Runs after the ActionEvent is logged (so the trigger reads
        // the just-arrived inputTokens) and before dispatch (so any
        // chapter events the chaptering machinery splices in are in
        // place before the next LLM call). The chapter task itself
        // runs in a child session (see runChaptering) so its events
        // don't pollute the parent log.
        if (agent.getChapterTask() !== undefined) {
          const allEvents = await collectEvents(eventLog)
          if (shouldTriggerChaptering(allEvents, agent.chapteringTrigger)) {
            await runChaptering(allEvents, eventLog, agent, session, signal, async (e) => {
              // Forward to the user's onEvent callback only —
              // replaceRange has already updated the index for us.
              if (options.onEvent !== undefined) await options.onEvent(e)
            })
          }
        }

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
          throw new TaskClarifyError(outcome.message)
        }
        // outcome.kind === 'continue' → next iteration
      }

      // Loop budget exhausted
      const failEvent: FailEvent = {
        type: 'fail',
        timestamp: new Date().toISOString(),
        agentName: agent.name,
        message: `Task exceeded maxIterations (${maxIter})`,
      }
      await emit(failEvent, eventLog, options.onEvent)
      throw new TaskFailError(`Task exceeded maxIterations (${maxIter})`)
    } catch (e) {
      if (e instanceof CancelledError) {
        await emit(
          {
            type: 'cancelled',
            timestamp: new Date().toISOString(),
            agentName: agent.name,
            taskName: deriveTaskName(def),
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
): Promise<TaskOutcome> {
  for (let i = 0; i < emissions.length; i++) {
    const em = emissions[i] as Emission
    if (ctx.signal.aborted) throw new CancelledError()
    const emissionId = makeToolUseId(actionTimestamp, i)

    if (em.type === 'ts') {
      const result = await runtime.execute(em.code, { ...ctx, emissionId })
      if (result.outputs.length > 0) {
        const outputEvent: OutputEvent = {
          type: 'output',
          timestamp: new Date().toISOString(),
          agentName,
          emissionId,
          parts: result.outputs,
        }
        await emit(outputEvent, eventLog, onEvent)
      }
      if (result.error !== null && result.outcome.kind === 'continue') {
        // Cancellation surfaced by the runtime: re-raise so the outer
        // catch emits CancelledEvent rather than burying it in a fail.
        if (result.error instanceof CancelledError || ctx.signal.aborted) {
          throw new CancelledError(result.error.message)
        }
        return { kind: 'fail', message: result.error.message }
      }
      if (result.outcome.kind !== 'continue') return result.outcome
      continue
    }

    if (em.type === 'fileWrite') {
      try {
        await dispatchFileWrite(em, fs)
      } catch (e) {
        return { kind: 'fail', message: describeError(e) }
      }
      continue
    }

    if (em.type === 'fileEdit') {
      try {
        await dispatchFileEdit(em, fs)
      } catch (e) {
        return { kind: 'fail', message: describeError(e) }
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
        return { kind: 'fail', message: describeError(e) }
      }
    }

    // text / thinking — already in the event log via the ActionEvent;
    // no further side effect.
  }
  return { kind: 'continue' }
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
