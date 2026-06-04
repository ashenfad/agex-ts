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
 *   5. Resolve the task on `taskSuccess` / `taskFail`;
 *      otherwise loop until `maxIterations`.
 *
 * Cancellation: the host `AbortSignal` is threaded into both the
 * runtime and the LLM client; aborting writes a `CancelledEvent`
 * and rejects with `CancelledError`.
 */

import { TerminalError } from '@agex-ts/termish'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Agent } from './agent'
import {
  getLastFiredActionTimestamp,
  markChapteringFired,
  runChaptering,
  shouldTriggerChaptering,
} from './chaptering'
import { dispatchFileEdit, dispatchFileWrite, dispatchTerminal } from './dispatcher'
import { CancelledError, SchemaError, TaskFailError, isCancelledError } from './errors'
import type { EventLogImpl } from './event-log'
import { buildSystemMessage, buildTaskMessage, makeToolUseId, renderEvents } from './render'
import { createSpawn } from './spawn'
import type {
  ActionEvent,
  AgentEvent,
  Cache,
  Emission,
  ExecuteContext,
  FailEvent,
  LLMClient,
  OutputEvent,
  OutputPart,
  Policy,
  RuntimeAdapter,
  SuccessEvent,
  SystemNoteEvent,
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

/** Host-internal substrate override for a single task run. Empty on the
 *  normal path. `spawn` (see `docs/roadmap/spawn.md`) supplies one to run
 *  an ephemeral clone on throwaway state without touching the parent's
 *  configured per-session substrate. Never agent-reachable. */
export interface RunContext {
  /** Pre-built event log / VFS / cache. When set, the loop uses these
   *  instead of `agent.events/fs/cache(session)`, and skips the
   *  agent-VFS skills-overlay refresh — the caller is expected to have
   *  composed the VFS (including any `/skills` overlay) itself. */
  readonly resources?: {
    readonly eventLog: EventLogImpl
    readonly fs: VirtualFileSystem
    readonly cache: Cache
  }
}

/** `TaskFn` plus the host-internal `runCtx` third argument. The public
 *  `TaskFn` type deliberately hides it; `spawn` casts to this to inject a
 *  `RunContext`. The returned closure really does accept the argument, so
 *  the cast is sound. */
export type TaskFnInternal<I, O> = (
  input: I,
  options?: TaskCallOptions,
  runCtx?: RunContext,
) => Promise<O>

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
  return async (input: I, options: TaskCallOptions = {}, runCtx: RunContext = {}): Promise<O> => {
    const llmClient = agent.llm ?? throwMissing('llm')
    const runtimeAdapter = agent.runtime ?? throwMissing('runtime')

    const session = options.session ?? DEFAULT_SESSION
    const signal = options.signal ?? new AbortController().signal
    // Per-session host APIs are async — the underlying state /
    // VFS / cache may need to open an IndexedDB or SQLite store.
    // Resolve them up front so the loop body can use them
    // synchronously. `runCtx.resources`, when supplied, replaces the
    // agent's configured substrate with caller-built throwaway instances
    // (an ephemeral spawn clone) so nothing lands in the parent session.
    const resources = runCtx.resources
    const eventLog = resources?.eventLog ?? (await agent.events(session))
    const fs = resources?.fs ?? (await agent.fs(session))
    const cache = resources?.cache ?? (await agent.cache(session))
    // A run on injected resources is an ephemeral spawn clone: it owns no
    // durable session, so it both skips the agent-VFS skills refresh (the
    // caller composed the VFS) and never chapters (a throwaway log has
    // nothing to compact, and chaptering would pointlessly run the chapter
    // task). Both behaviors key off this one invariant, not separate flags.
    const usesAgentSubstrate = resources === undefined

    // -- Validate input ---------------------------------------------------
    let validatedInput: I = input
    if (def.input !== undefined) {
      validatedInput = await validateOrThrow(def.input, input, 'input')
    }

    // -- Initialize runtime ----------------------------------------------
    // Always init — a spawn clone may be the first run to touch the
    // adapter (the public seam can be invoked directly), and re-init is
    // cheap and atomic (the eval runtime's init body is synchronous, so
    // concurrent fan-out inits don't interleave).
    await runtimeAdapter.init(agent.policy(), {
      ...(agent.namespaceResolver !== undefined && {
        namespaceResolver: agent.namespaceResolver,
      }),
    })

    // Make sure registered skills are visible at /skills/<name>/SKILL.md
    // before the agent starts running. With injected resources the caller
    // composed the VFS (including any skills overlay), so leave the
    // agent's per-session VFS untouched.
    if (usesAgentSubstrate) {
      await agent.refreshSkillsOverlay(session)
    }

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
    // `spawn` is offered only to a spawn-enabled top-level run: this must
    // be the agent's own substrate (not an ephemeral clone — depth-1), the
    // runtime must inject it, and `maxSpawns` must allow at least one. When
    // off, the capability isn't built and the primer doesn't teach it, so
    // the agent never sees a `spawn` it can't call.
    const spawnEnabled =
      usesAgentSubstrate && agent.maxSpawns > 0 && runtimeAdapter.injectsSpawn === true
    const spawnCapability = spawnEnabled
      ? createSpawn(agent, signal, options.onEvent, agent.maxSpawns)
      : undefined
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
      ...(spawnEnabled && { spawnEnabled: true }),
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
          ...(spawnCapability !== undefined && { spawn: spawnCapability }),
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

        // No-action nudge. If the model emitted only text/thinking
        // (no ts/terminal/write_file/edit_file) the task can't
        // advance — the next iteration would replay the same context
        // and the model tends to loop on its own narration. Surface
        // a synthetic OutputEvent with no emissionId so the renderer
        // routes it into the next user turn as plain text. Bracketed
        // `[System reminder]` framing parallels the assistant-side
        // `[Task complete]` / `[Task failed]` closure markers so the
        // model reads it as meta, not as caller content.
        if (outcome.kind === 'continue' && !hasActionableEmission(emissions)) {
          const reminderEvent: OutputEvent = {
            type: 'output',
            timestamp: new Date().toISOString(),
            agentName: agent.name,
            parts: [
              {
                type: 'text',
                text: '[System reminder] The previous turn produced only narration — no action tool was dispatched. Call taskSuccess(...) (or taskFail(...)) inside ts_action to finish the task, or dispatch an action tool (ts_action / terminal_action / write_file / edit_file) to keep working. Text alone does not advance the task.',
              },
            ],
          }
          await emit(reminderEvent, eventLog, options.onEvent)
        }

        // Terminal outcomes
        if (outcome.kind === 'success') {
          let result = outcome.value as O
          if (def.output !== undefined) {
            try {
              result = await validateOrThrow(def.output, result, 'output')
            } catch (e) {
              // Output validation is enforced but *recoverable*: rather than
              // hard-failing the whole task, surface the mismatch as a system
              // reminder the agent reads next turn and let it re-issue
              // taskSuccess with a corrected value. This costs one iteration,
              // so a persistent mismatch is bounded by maxIterations and the
              // loop's exhaust path turns it into the terminal failure.
              // Mirrors agex-py, where a return-type mismatch is a
              // recoverable_error counted against the loop, not a hard fail.
              // Synthetic OutputEvent with no emissionId — same routing as the
              // no-action nudge above (lands as plain text in the next user
              // turn), and `[System reminder]` framing reads as meta.
              const message = describeError(e)
              const reminderEvent: OutputEvent = {
                type: 'output',
                timestamp: new Date().toISOString(),
                agentName: agent.name,
                parts: [
                  {
                    type: 'text',
                    text: `[System reminder] The value passed to taskSuccess did not match the task's required output shape — ${message}. Call taskSuccess(...) again with a value that satisfies the schema.`,
                  },
                ],
              }
              await emit(reminderEvent, eventLog, options.onEvent)
              lastError = message
              continue
            }
          }
          const successEvent: SuccessEvent = {
            type: 'success',
            timestamp: new Date().toISOString(),
            agentName: agent.name,
            result,
          }
          await emit(successEvent, eventLog, options.onEvent)
          if (usesAgentSubstrate) {
            await maybeFireBoundaryChaptering(agent, session, eventLog, signal, options.onEvent)
          }
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
          if (usesAgentSubstrate) {
            await maybeFireBoundaryChaptering(agent, session, eventLog, signal, options.onEvent)
          }
          throw new TaskFailError(outcome.message)
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
      if (usesAgentSubstrate) {
        await maybeFireBoundaryChaptering(agent, session, eventLog, signal, options.onEvent)
      }
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
 * `TaskOutcome` for terminal cases (success / fail) and
 * extends `continue` with an optional `lastError` carried up to the
 * outer loop so a later `maxIterations` exhaust can surface "the most
 * recent error before we gave up" — matches agex-py's `last_error`.
 */
type DispatchResult =
  | { readonly kind: 'success'; readonly value: unknown }
  | { readonly kind: 'fail'; readonly message: string }
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
        // The trailing emissions queued behind this one assume state the
        // failed call was supposed to produce, so running them would
        // cascade; instead mark them skipped so the agent sees exactly
        // which calls didn't run.
        await emitSkippedMarkers(emissions, i + 1, actionTimestamp, agentName, eventLog, onEvent)
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
        await emitSkippedMarkers(emissions, i + 1, actionTimestamp, agentName, eventLog, onEvent)
        return { kind: 'continue', lastError: describeError(e) }
      }
      await emitFileAck(`✓ write_file: ${em.path}`, agentName, eventLog, onEvent)
      continue
    }

    if (em.type === 'fileEdit') {
      try {
        await dispatchFileEdit(em, fs)
      } catch (e) {
        await emitErrorOutput(e, agentName, emissionId, eventLog, onEvent)
        await emitSkippedMarkers(emissions, i + 1, actionTimestamp, agentName, eventLog, onEvent)
        return { kind: 'continue', lastError: describeError(e) }
      }
      await emitFileAck(`✓ edit_file: ${em.path}`, agentName, eventLog, onEvent)
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
        await emitSkippedMarkers(emissions, i + 1, actionTimestamp, agentName, eventLog, onEvent)
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

/** Notice rendered into the tool_result for emissions that never ran
 *  because an earlier emission in the same action raised a recoverable
 *  error and truncated the batch. Without it those calls render as
 *  "(no observation)" — silent, indistinguishable from "ran and
 *  produced nothing" — or, for file ops, as a misleading synthesized
 *  "wrote /path" success line. Naming the skip lets the agent re-issue
 *  only the calls that didn't run instead of replaying the whole batch
 *  (which silently double-applies the ones that did). */
const SKIPPED_NOTICE =
  'Not executed — an earlier action in this turn raised an error, so the remaining actions in the batch were skipped. Re-issue this action if you still need it.'

/** Emit a skip-notice OutputEvent for every actionable emission at or
 *  after `fromIndex`, stamped with that emission's emissionId so the
 *  renderer pairs it to the right tool_use. Called from each
 *  recoverable-error truncation point. Text/thinking emissions are not
 *  tool_use parts, so they need no skip result. */
async function emitSkippedMarkers(
  emissions: ReadonlyArray<Emission>,
  fromIndex: number,
  actionTimestamp: string,
  agentName: string,
  eventLog: { add(e: AgentEvent): Promise<string> },
  onEvent: ((e: AgentEvent) => void | Promise<void>) | undefined,
): Promise<void> {
  for (let k = fromIndex; k < emissions.length; k++) {
    if (!isActionEmission(emissions[k] as Emission)) continue
    const outputEvent: OutputEvent = {
      type: 'output',
      timestamp: new Date().toISOString(),
      agentName,
      emissionId: makeToolUseId(actionTimestamp, k),
      parts: [{ type: 'text', text: SKIPPED_NOTICE }],
    }
    await emit(outputEvent, eventLog, onEvent)
  }
}

/** Confirm a successful file op with a SystemNote, mirroring agex
 *  (Python) `sync_loop.py`. The renderer skips `systemNote` events, so
 *  this stays out of the LLM's view — the per-emission tool_result
 *  already synthesizes a success line there — but it reaches the
 *  embedder via `onEvent`, so a host UI can show "✓ wrote …" in-turn
 *  instead of nothing (the gap that made a silent success look like a
 *  failure worth retrying). */
async function emitFileAck(
  message: string,
  agentName: string,
  eventLog: { add(e: AgentEvent): Promise<string> },
  onEvent: ((e: AgentEvent) => void | Promise<void>) | undefined,
): Promise<void> {
  const note: SystemNoteEvent = {
    type: 'systemNote',
    timestamp: new Date().toISOString(),
    agentName,
    message,
  }
  await emit(note, eventLog, onEvent)
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
 *  outcome path (success / fail, including the budget-
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
  const lastFiredTs = getLastFiredActionTimestamp(eventLog)
  if (!shouldTriggerChaptering(allEvents, agent.chapteringTrigger, lastFiredTs)) return
  await runChaptering(allEvents, eventLog, agent, session, signal, async (e) => {
    if (onEvent !== undefined) await onEvent(e)
  })
  // Stamp the latest action in the (possibly mutated) log so that any
  // subsequent boundary check skips re-firing until a NEW action has
  // landed. Catches:
  //   - the triggering action itself (e.g. a parent task whose
  //     boundary fires right after a sub-task's chaptering completes,
  //     where its most-recent action was measured pre-fold);
  //   - the chapter task's own actions (measured during the chapter
  //     task's LLM call, against the parent's pre-fold context, so
  //     stale-high post-fold).
  // Stamp unconditionally — also covers runChaptering early bails
  // (no completable boundary, signal aborted) so we don't re-fire on
  // the same triggering action next boundary.
  const postEvents = await collectEvents(eventLog)
  for (let i = postEvents.length - 1; i >= 0; i--) {
    const e = postEvents[i] as AgentEvent
    if (e.type === 'action') {
      markChapteringFired(eventLog, e.timestamp)
      break
    }
  }
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

/** Did the action emit at least one tool call that drives the task?
 *  Text and thinking are pure narration — they're in the event log
 *  for the agent's own use but produce no side effects, so an action
 *  composed entirely of them leaves the loop in the same state it
 *  started. */
function hasActionableEmission(emissions: ReadonlyArray<Emission>): boolean {
  return emissions.some(isActionEmission)
}

/** True for emission types that become a `tool_use` part (and thus need
 *  a paired tool_result). Text / thinking are pure narration. */
function isActionEmission(em: Emission): boolean {
  return (
    em.type === 'ts' || em.type === 'terminal' || em.type === 'fileWrite' || em.type === 'fileEdit'
  )
}
