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
import { dispatchFileEdit, dispatchFileWrite, dispatchTerminal } from './dispatcher'
import { CancelledError, SchemaError, TaskClarifyError, TaskFailError } from './errors'
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
  /** What this task does — surfaced in the system prompt. */
  readonly description: string
  /** Optional Standard Schema for input validation. */
  readonly input?: StandardSchemaV1<I, I>
  /** Optional Standard Schema for output validation. */
  readonly output?: StandardSchemaV1<O, O>
  /** Optional task-specific addendum to the system prompt. */
  readonly primer?: string
}

export function makeTask<I, O>(agent: Agent, def: TaskDefinition<I, O>): TaskFn<I, O> {
  return async (input: I, options: TaskCallOptions = {}): Promise<O> => {
    const llmClient = agent.llm ?? throwMissing('llm')
    const runtimeAdapter = agent.runtime ?? throwMissing('runtime')

    const session = options.session ?? DEFAULT_SESSION
    const signal = options.signal ?? new AbortController().signal
    const eventLog = agent.events(session)
    const fs = agent.fs(session)
    const cache = agent.cache(session)

    // -- Validate input ---------------------------------------------------
    let validatedInput: I = input
    if (def.input !== undefined) {
      validatedInput = await validateOrThrow(def.input, input, 'input')
    }

    // -- Initialize runtime ----------------------------------------------
    await runtimeAdapter.init(agent.policy())

    // -- Log TaskStartEvent ----------------------------------------------
    const startEvent: TaskStartEvent = {
      type: 'taskStart',
      timestamp: new Date().toISOString(),
      agentName: agent.name,
      taskName: deriveTaskName(def),
      inputs: validatedInput,
    }
    await emit(startEvent, eventLog, options.onEvent)

    // -- Action loop -----------------------------------------------------
    let iter = 0
    const maxIter = agent.maxIterations
    const system = buildSystemPrompt(agent, def)

    try {
      while (iter < maxIter) {
        if (signal.aborted) throw new CancelledError()
        iter++

        // Stream + assemble emissions
        const events = await collectEvents(eventLog)
        const emissions: Emission[] = []
        let inputTokens: number | undefined
        let outputTokens: number | undefined

        for await (const chunk of llmClient.complete({ system, events }, signal)) {
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
        const ctx: ExecuteContext = { fs, cache, signal }
        const outcome = await dispatchEmissions(
          emissions,
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
    } finally {
      await runtimeAdapter.dispose()
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function dispatchEmissions(
  emissions: ReadonlyArray<Emission>,
  runtime: RuntimeAdapter,
  ctx: ExecuteContext,
  fs: VirtualFileSystem,
  policy: Policy,
  agentName: string,
  eventLog: { add(e: AgentEvent): Promise<string> },
  onEvent: ((e: AgentEvent) => void | Promise<void>) | undefined,
): Promise<TaskOutcome> {
  for (const em of emissions) {
    if (ctx.signal.aborted) throw new CancelledError()

    if (em.type === 'ts') {
      const result = await runtime.execute(em.code, ctx)
      if (result.outputs.length > 0) {
        const outputEvent: OutputEvent = {
          type: 'output',
          timestamp: new Date().toISOString(),
          agentName,
          parts: result.outputs,
        }
        await emit(outputEvent, eventLog, onEvent)
      }
      if (result.error !== null && result.outcome.kind === 'continue') {
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

function buildSystemPrompt<I, O>(agent: Agent, def: TaskDefinition<I, O>): string {
  // v1 system prompt is intentionally minimal: agent primer +
  // task description + per-task primer. The richer renderer (registered
  // namespace help, skill markdown, primer composition) lands once the
  // wire-format module exists in the provider packages.
  const parts: string[] = []
  if (agent.primer !== undefined && agent.primer.length > 0) parts.push(agent.primer)
  parts.push(`Task: ${def.description}`)
  if (def.primer !== undefined && def.primer.length > 0) parts.push(def.primer)
  return parts.join('\n\n')
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
