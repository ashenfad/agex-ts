/**
 * Agents, and the sessions they drive, after Python agex's `agex.agent`.
 *
 * An {@link Agent} is a loop: a model (a {@link Provider}, or an AI SDK
 * model), a primer and
 * the settings it calls the model with. It holds no state and owns no
 * world. A session gives it one: `agent.session(ws)` drives a workspace
 * turn by turn, its conversation stored in the session's branch, so a
 * checkout rewinds the agent's memory with the files and a fork carries
 * it.
 *
 * Each turn is one run inside `ws.turn`. The model is asked; the tools
 * it calls run against the workspace (each mutating call committed as it
 * lands); notes queued mid-turn ride the tool results; and the loop goes
 * round until the model answers without calling a tool. The turn's end
 * stores the run (agex's own record), settles the inbox, and lands one
 * commit stamped with how the run ended.
 */

import {
  HarnessMismatchError,
  Inbox,
  type Policy,
  type RunStatus,
  Sessions,
  type Tool,
  type ToolOptions,
  type ToolOutput,
  type TurnEvent,
  type Workspace,
  answerNotes,
  deliveredNote,
  sessionsTool,
  toolInstructions,
  worldTools,
} from '@agex-ts/world'
import type { LanguageModelV4 } from '@ai-sdk/provider'
import { AiSdkProvider, isLanguageModel } from './ai-sdk'
import { prepare } from './compaction'
import { Runner } from './delegation'
import { type Provider, type Settings, type ToolSpec, toolSpec } from './provider'
import {
  type Image,
  type Message,
  type Run,
  type ToolCall,
  type ToolResult,
  type Usage,
  addUsage,
  dumpRun,
  loadRun,
  messageText,
  newId,
} from './record'

/** The name agex's conversations are stored under, in the workspace's
 *  conversation index. */
export const HARNESS = 'agex'

/** How many model calls a run may make before it is stopped. */
export const MAX_STEPS = 100

/** How the note closing a cancelled or failed run begins: the run keeps
 *  the work it did, and the model reads that it was cut short. */
export const CLOSING_NOTE = '[turn ended early:'

/** Why a turn `cancel` stopped ended, when the cancel gave no reason. */
export const STOPPED = 'stopped'

/** What a woken turn opens with when nothing is waiting after all. */
export const WOKEN = '(You were woken, and nothing new is waiting.)'

/** The result a tool call gets when its turn ended before running it,
 *  saying why (`note`, the run's closing note). */
export function unanswered(note: string): string {
  return `not run: the turn ended before this call started (${note})`
}

/** The result a tool call gets when its turn ended while it ran. Told
 *  only that the turn ended, a model guesses at why. */
export function cutOff(note: string): string {
  return `no result: the turn ended while this call was running (${note}); it may have finished anyway, so check the workspace before repeating it`
}

/** What the model reads once its run has made `limit` tool calls. */
export function limitReached(limit: number): string {
  return `this turn has made its ${limit} tool calls: reply now with what you have, without calling a tool`
}

const notice = (limit: number) => `[${limitReached(limit)}]`

/** The assistant message closing a cancelled or failed run. */
export function closingNote(reason: string): Message {
  return {
    id: newId(),
    role: 'assistant',
    parts: [
      {
        kind: 'text',
        text: `${CLOSING_NOTE} ${reason}. The work above this point is real and done.]`,
      },
    ],
  }
}

/** How a run ended: a run status, or for a task, `success` (it handed
 *  back its value) or `needs_input`. */
export type Status = RunStatus | 'success' | 'needs_input'

/**
 * How a run went: `status` is how it ended, `text` the model's last
 * reply, `head` the commit the workspace stands at afterwards, `events`
 * what the run streamed, and `message` why it didn't complete, when it
 * didn't.
 */
export interface Outcome {
  readonly status: Status
  readonly text: string
  readonly runId: string
  readonly head: string
  readonly events: readonly TurnEvent[]
  readonly message: string | null
}

export interface AgentOptions {
  /** A {@link Provider}, or an AI SDK model (`anthropic('claude-...')`
   *  and the like), driven through {@link AiSdkProvider}. */
  readonly model: Provider | LanguageModelV4
  /** Opens every request, ahead of the workspace's own tool
   *  instructions. */
  readonly primer?: string
  readonly settings?: Settings
  /** The model calls one run may make (default {@link MAX_STEPS}). */
  readonly maxSteps?: number
  /** The tool calls one run may make: once reached the model is told to
   *  reply, each call past it is answered without running, and a reply
   *  that calls a tool after the model was told fails the run. */
  readonly maxToolCalls?: number | null
  /** When to fold the conversation into a summary, within a run too
   *  (see `compaction.ts`); without one, nothing is folded, though a
   *  fold already recorded is still sent. */
  readonly compaction?: Policy | null
}

/** A loop over a model. It holds no state: a change of model or primer
 *  is a new agent for the next turn. */
export class Agent {
  readonly provider: Provider
  readonly primer: string
  readonly settings: Settings
  readonly maxSteps: number
  readonly maxToolCalls: number | null
  readonly compaction: Policy | null

  constructor(opts: AgentOptions) {
    this.provider = isLanguageModel(opts.model) ? new AiSdkProvider(opts.model) : opts.model
    this.primer = opts.primer ?? ''
    this.settings = opts.settings ?? {}
    this.maxSteps = opts.maxSteps ?? MAX_STEPS
    this.maxToolCalls = opts.maxToolCalls ?? null
    this.compaction = opts.compaction ?? null
  }

  toString(): string {
    return `<Agent ${this.provider.name}>`
  }

  /** A session driving `ws`, which may already hold an agex
   *  conversation (it continues) or none (it starts one). */
  session(ws: Workspace, opts: SessionOptions = {}): Session {
    return new Session(this, ws, opts)
  }
}

export interface SessionOptions {
  /** Notes for the running turn, each landing on the next tool result.
   *  The embedder's, so it outlives an agent replaced between turns. */
  readonly inbox?: Inbox
  /** Tools of the embedder's own, in the world's tool shape; one named
   *  like a world tool replaces it. */
  readonly tools?: readonly Tool[]
  /** How the world's tools are offered (`vision` is off unless given). */
  readonly toolOptions?: ToolOptions
  /**
   * Let the agent delegate, through the `sessions` tool. `true` asks
   * through the workspace's helper (the open one `Sessions.of(ws)`
   * finds, or a new one), and each ask runs its delegate as a session
   * of this agent ({@link Runner}): a new agent for the next turn finds
   * the same jobs, its delegates run on it, and those in flight finish
   * on theirs. Or pass a `Sessions` of your own, whose runner runs
   * every ask.
   */
  readonly sessions?: boolean | Sessions
}

/**
 * An agent driving one workspace, turn by turn.
 *
 * `say` runs a turn and returns its {@link Outcome}; `stream` starts one
 * and hands back its events as they happen. A turn belongs to the
 * session, not to whoever watches it: leaving a stream early stops
 * watching, and the turn goes on to its end; `cancel` stops it.
 *
 * A turn ends `completed`, `cancelled`, `failed` (an error, or `maxSteps`
 * model calls) or `interrupted` (a provider error worth retrying), which
 * `resume` continues in place and `abandon` ends. A cancelled or failed
 * turn keeps its work with a closing note, so the model remembers what
 * it did; none of the endings throw.
 */
export class Session {
  readonly agent: Agent
  readonly ws: Workspace
  readonly inbox: Inbox
  /** The outcome of the last turn that ended. */
  last: Outcome | null = null
  readonly #tools: Map<string, Tool>
  readonly #specs: ToolSpec[]
  readonly #vision: boolean
  /** What each ask runs on, for `sessions: true`. */
  readonly #runner: Runner | null = null
  /** The names of the embedder's own tools, which no tool replaces. */
  readonly #embedded: ReadonlySet<string>
  #helper: Sessions | null = null
  #turn: TurnState | null = null
  /** The tool call running now, settling when it's done. */
  #calling: Promise<unknown> | null = null

  constructor(agent: Agent, ws: Workspace, opts: SessionOptions = {}) {
    this.agent = agent
    this.ws = ws
    this.inbox = opts.inbox ?? new Inbox()
    this.#vision = opts.toolOptions?.vision ?? false
    if (opts.sessions === true) this.#runner = new Runner(agent, ws)
    else if (opts.sessions instanceof Sessions) this.#helper = opts.sessions
    this.#embedded = new Set((opts.tools ?? []).map((t) => t.name))
    this.#tools = new Map(
      worldTools(ws, {
        ...opts.toolOptions,
        vision: this.#vision,
        ...(this.#helper !== null && { sessions: this.#helper }),
      }).map((t) => [t.name, t]),
    )
    this.#delegation()
    for (const tool of opts.tools ?? []) this.#tools.set(tool.name, tool)
    this.#specs = [...this.#tools.values()].map(toolSpec)
  }

  toString(): string {
    return `<Session ${this.ws.session} of ${this.agent}>`
  }

  /** Whether a turn is running. */
  get running(): boolean {
    return this.#turn !== null
  }

  /** The helper the agent delegates through, if it can. */
  get sessions(): Sessions | null {
    return this.#helper
  }

  /**
   * Close the helper the agent delegates through, which waits for its
   * delegates' runs; one passed in is its owner's to close. For when
   * the workspace is done with, not between agents: a session for the
   * next turn finds the helper open, its jobs with it.
   */
  async close(): Promise<void> {
    if (this.#runner !== null) await this.#helper?.close()
  }

  /** The helper for the turn starting, with `sessions: true`: the
   *  workspace's, or a new one once it was closed. Each ask runs on this
   *  agent. */
  #delegation(): Sessions | null {
    if (this.#runner === null) return this.#helper
    if (this.#helper === null || this.#helper.closed) {
      this.#helper = Sessions.of(this.ws) ?? new Sessions(this.ws, this.#runner)
      if (!this.#embedded.has('sessions')) {
        this.#tools.set('sessions', sessionsTool(this.#helper, { runner: this.#runner }))
      }
    }
    return this.#helper
  }

  /** The runs the workspace holds, oldest first. */
  async runs(): Promise<Run[]> {
    const index = await this.ws.conversation.index()
    if (index === null) return []
    const bodies = await this.ws.conversation.runs(index.runs)
    return index.runs.filter((id) => bodies.has(id)).map((id) => loadRun(bodies.get(id)))
  }

  /** Run one turn; its outcome. */
  say(prompt: string, opts: { onEvent?: (event: TurnEvent) => void } = {}): Promise<Outcome> {
    return this.stream(prompt, opts).wait()
  }

  /** Continue the last turn in place, which an interruption cut short. */
  resume(): Promise<Outcome> {
    return new RunStream(this, { resume: true }).wait()
  }

  /** Run a woken turn: one with no prompt, which opens with what is
   *  waiting to be delivered. */
  wake(): Promise<Outcome> {
    return new RunStream(this, { wake: true }).wait()
  }

  /** A turn on `prompt`, started when first iterated or waited on; its
   *  events as they happen. */
  stream(prompt: string, opts: { onEvent?: (event: TurnEvent) => void } = {}): RunStream {
    return new RunStream(this, { prompt, ...(opts.onEvent && { onEvent: opts.onEvent }) })
  }

  /**
   * End the last turn, which an interruption cut short, without resuming
   * it; the run as it now stands, `status` and closed with a note saying
   * `reason`, so the next turn's model reads that its work stopped there.
   */
  async abandon(reason: string, opts: { status?: 'cancelled' | 'failed' } = {}): Promise<Run> {
    const status = opts.status ?? 'failed'
    if (status !== 'cancelled' && status !== 'failed') {
      throw new TypeError(
        `an abandoned run ends cancelled or failed, not ${JSON.stringify(status)}`,
      )
    }
    const prior = await this.#lastInterrupted()
    const run: Run = {
      ...prior,
      status,
      messages: [...prior.messages, closingNote(reason)],
      endedAt: Date.now(),
    }
    const turn = await this.ws.turn(prior.runId, { resume: true, harness: HARNESS })
    await turn.end(status, { body: dumpRun(run), message: reason })
    return run
  }

  /**
   * Stop the turn that is running; whether one was. It stops at the
   * next point it can (between calls, or by interrupting the model call
   * or the code in flight) and ends `cancelled`, its work kept with a
   * closing note. `reason` is why, in that note and the outcome; when a
   * turn is cancelled more than once, the first reason stands.
   */
  cancel(reason?: string): boolean {
    const turn = this.#turn
    if (turn === null) return false
    if (reason !== undefined && turn.reason === null) turn.reason = reason
    turn.abort.abort()
    this.ws.interrupt()
    return true
  }

  async #lastInterrupted(): Promise<Run> {
    const runs = await this.runs()
    const last = runs.at(-1)
    if (last === undefined || last.status !== 'interrupted') {
      const ended = last === undefined ? 'never ran' : `ended ${last.status}`
      throw new Error(`there is no interrupted turn to resume: the last turn ${ended}`)
    }
    return last
  }

  async #system(): Promise<Message> {
    const instructions = await toolInstructions(this.ws)
    const text = [this.agent.primer, instructions].filter((t) => t !== '').join('\n\n')
    return { id: 'system', role: 'system', parts: [{ kind: 'text', text }] }
  }

  /** @internal One turn, start to end; every event goes to `emit` as it
   *  happens. Throws only for a turn that couldn't begin. */
  async _run(
    opts: { prompt?: string; resume?: boolean; wake?: boolean },
    emit: (event: TurnEvent) => void,
  ): Promise<Outcome> {
    if (this.#turn !== null) throw new Error('a turn is already running on this session')
    // registered before anything is awaited, so a cancel made as the turn
    // starts reaches it at its first check
    const state: TurnState = { abort: new AbortController(), reason: null }
    this.#turn = state
    try {
      const index = await this.ws.conversation.index()
      if (index !== null && index.harness !== HARNESS) {
        throw new HarnessMismatchError(
          `session '${this.ws.session}' holds a conversation '${index.harness}' wrote; agex reads only its own`,
        )
      }
      return await this.#turnBody(opts, emit, state)
    } finally {
      this.#turn = null
    }
  }

  async #turnBody(
    opts: { prompt?: string; resume?: boolean; wake?: boolean },
    emit: (event: TurnEvent) => void,
    state: TurnState,
  ): Promise<Outcome> {
    const signal = state.abort.signal
    const events: TurnEvent[] = []
    const push = (event: TurnEvent) => {
      events.push(event)
      emit(event)
    }
    let runId: string
    let started: number
    let messages: Message[]
    let compaction: Usage | null = null
    // the summary calls this run made, a resumed run's before it stopped
    // among them
    let summaries = 0
    let earlier: (readonly Message[])[]
    const runs = await this.runs()
    if (opts.resume === true) {
      const prior = await this.#lastInterrupted()
      runId = prior.runId
      started = prior.startedAt ?? Date.now()
      messages = [...prior.messages]
      compaction = prior.compaction ?? null
      summaries = prior.compactionCalls ?? 0
      earlier = runs.slice(0, -1).map((r) => r.messages)
    } else {
      runId = newId()
      started = Date.now()
      messages =
        opts.wake === true
          ? []
          : [{ id: newId(), role: 'user', parts: [{ kind: 'text', text: opts.prompt ?? '' }] }]
      earlier = runs.map((r) => r.messages)
    }
    const system = await this.#system()
    let status: RunStatus = 'completed'
    let message: string | null = null
    let text = ''
    let calls: ToolCall[] = []
    let results: ToolResult[] = []
    // the ToolEnded a call still owes the stream, while it runs
    let unended: Extract<TurnEvent, { kind: 'ToolEnded' }> | null = null
    // the call running now, whose result is cut off if the turn ends
    let cutting: ToolCall | null = null
    let inRequest = false
    const helper = this.#delegation()
    const turn = await this.ws.turn(runId, {
      ...(opts.resume === true && { resume: true }),
      inbox: this.inbox,
      harness: HARNESS,
      // a delegate's answer that lands mid-turn rides the next tool
      // result, as a note does; one that lands between turns waits for
      // the next
      ...(helper !== null && { sources: [(inbox: Inbox) => answerNotes(helper, inbox)] }),
    })
    const checkCancel = () => {
      if (signal.aborted) throw new Cancelled()
    }
    try {
      push({ kind: 'RunStarted', runId })
      if (opts.wake === true) {
        const opening = await turn.opening()
        messages.push({
          id: newId(),
          role: 'user',
          parts: [{ kind: 'text', text: opening ?? WOKEN }],
        })
      }
      // every model call counts against maxSteps, summaries too; a
      // resumed run's replies and summaries were calls of this run, made
      // before it stopped
      let made = messages.filter((m) => m.role === 'assistant').length + summaries
      const limit = this.agent.maxToolCalls
      let spent = messages.reduce(
        (n, m) => n + m.parts.filter((p) => p.kind === 'tool_call').length,
        0,
      )
      let told =
        limit !== null &&
        messages.some((m) => m.role === 'user' && messageText(m) === notice(limit))
      let finished = false
      while (made < this.agent.maxSteps) {
        checkCancel()
        let reply: Message | null = null
        inRequest = true
        const sendable = (m: Message) => (this.#vision ? m : withoutImages(m))
        const prepared = await prepare({
          ws: this.ws,
          policy: this.agent.compaction,
          provider: this.agent.provider,
          specs: this.#specs,
          settings: this.agent.settings,
          system,
          earlier: earlier.map((run) => run.map(sendable)),
          current: messages.map(sendable),
          emit: push,
          spare: this.agent.maxSteps - made - 1,
          signal,
        })
        made += prepared.calls + 1
        summaries += prepared.calls
        if (prepared.usage !== null) {
          compaction = compaction === null ? prepared.usage : addUsage(compaction, prepared.usage)
        }
        const request = prepared.messages
        const afterNotice = told
        for await (const event of this.agent.provider.stream(
          request,
          this.#specs,
          this.agent.settings,
          {
            signal,
          },
        )) {
          checkCancel()
          if (event.kind === 'Reply') reply = event.message
          else push(event)
        }
        inRequest = false
        if (reply === null) throw new Error("the provider's stream ended without a reply")
        if (prepared.fold !== null) reply = { ...reply, fold: prepared.fold }
        messages.push(reply)
        if (reply.usage) {
          push({
            kind: 'Usage',
            inputTokens: reply.usage.inputTokens,
            cachedTokens: reply.usage.cacheReadTokens,
          })
        }
        calls = reply.parts.filter((p): p is ToolCall => p.kind === 'tool_call')
        if (calls.length === 0) {
          text = messageText(reply)
          finished = true
          break
        }
        results = []
        for (const call of calls) {
          checkCancel()
          push({
            kind: 'ToolStarted',
            callId: call.callId,
            name: call.name,
            args: { ...call.args },
          })
          unended = {
            kind: 'ToolEnded',
            callId: call.callId,
            name: call.name,
            result: '',
            isError: true,
          }
          cutting = call
          let called: ToolOutput
          if (limit !== null && spent >= limit) {
            called = { text: `not run: ${limitReached(limit)}`, images: [], isError: true }
          } else {
            spent += 1
            called = await this.#call(call, signal)
          }
          cutting = null
          // the tool ran, and may have changed the workspace: its result
          // stands from here, however the turn ends
          unended = {
            kind: 'ToolEnded',
            callId: call.callId,
            name: call.name,
            result: called.text,
            isError: called.isError,
          }
          results.push({
            kind: 'tool_result',
            callId: call.callId,
            name: call.name,
            content: called.text,
            isError: called.isError,
            images: this.#vision ? imagesOf(called) : [],
          })
          const delivered = await turn.deliver(called.text)
          if (delivered.notes.length > 0) {
            push({ kind: 'Delivered', notes: delivered.notes.map(deliveredNote) })
            results[results.length - 1] = {
              ...(results.at(-1) as ToolResult),
              content: delivered.text,
            }
          }
          push(unended)
          unended = null
        }
        if (afterNotice) {
          status = 'failed'
          message = `the model kept calling tools past its ${limit} tool calls`
          break
        }
        messages.push({ id: newId(), role: 'tool', parts: results })
        calls = []
        if (limit !== null && spent >= limit && !told) {
          // a message of the person's, not a tool's result: models read a
          // tool's output as data, and carry on
          messages.push({
            id: newId(),
            role: 'user',
            parts: [{ kind: 'text', text: notice(limit) }],
          })
          told = true
        }
      }
      if (!finished && status === 'completed') {
        status = 'failed'
        message = `the model made ${this.agent.maxSteps} calls without finishing the turn`
      }
    } catch (e) {
      if (e instanceof Cancelled || signal.aborted) {
        status = 'cancelled'
        message = state.reason ?? STOPPED
      } else {
        const transient = inRequest && this.agent.provider.transient(e)
        status = transient ? 'interrupted' : 'failed'
        message = (inRequest ? this.agent.provider.describe?.(e) : null) ?? describe(e)
      }
    } finally {
      if (turn.open) {
        const note = message ?? status
        if (unended !== null && cutting !== null) unended = { ...unended, result: cutOff(note) }
        if (unended !== null) push(unended)
        if (calls.length > 0) {
          // every tool call needs its result, or the next request is
          // refused: the ones the turn never answered say so
          const answered = new Set(results.map((r) => r.callId))
          const left: ToolResult[] = calls
            .filter((c) => !answered.has(c.callId))
            .map((c) => ({
              kind: 'tool_result',
              callId: c.callId,
              name: c.name,
              content: c.callId === cutting?.callId ? cutOff(note) : unanswered(note),
              isError: true,
            }))
          messages.push({ id: newId(), role: 'tool', parts: [...results, ...left] })
        }
        if (status === 'cancelled' || status === 'failed') messages.push(closingNote(note))
        if (cutting !== null && this.#calling !== null) await this.#stopCall(this.#calling)
        const run: Run = {
          format: 1,
          runId,
          status,
          messages,
          startedAt: started,
          endedAt: Date.now(),
          compaction,
          ...(summaries > 0 && { compactionCalls: summaries }),
        }
        await turn.end(status, { body: dumpRun(run), ...(message !== null && { message }) })
      }
    }
    push({ kind: 'RunEnded', status, message })
    this.last = { status, text, runId, head: this.ws.head, events, message }
    return this.last
  }

  /** What the tool returned. A tool the model made up, or one that
   *  throws, is a failed call the model reads, not an error out of the
   *  turn. A stop while it runs interrupts it and ends the turn at once;
   *  the call's own end follows on the workspace's queue, and one that
   *  waits on something else (a delegate) stops waiting on the turn's
   *  signal. */
  async #call(call: ToolCall, signal: AbortSignal): Promise<ToolOutput> {
    const tool = this.#tools.get(call.name)
    if (tool === undefined) {
      const known = [...this.#tools.keys()].sort().join(', ')
      return {
        text: `there is no tool named '${call.name}'; the tools are ${known}`,
        images: [],
        isError: true,
      }
    }
    const running = tool
      .call(call.args, { signal })
      .catch((e): ToolOutput => ({ text: describe(e), images: [], isError: true }))
    this.#calling = running
    running.then(() => {
      if (this.#calling === running) this.#calling = null
    })
    const stopped = new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Cancelled())
      signal.addEventListener('abort', () => reject(new Cancelled()), { once: true })
    })
    stopped.catch(() => {})
    return Promise.race([running, stopped])
  }

  /** Interrupt the call a stop cut off until it lets go of the
   *  workspace: one that hadn't reached its kernel when the stop came
   *  would otherwise run on to its timeout, holding up the turn's end. */
  async #stopCall(running: Promise<unknown>): Promise<void> {
    let settled = false
    running.then(() => {
      settled = true
    })
    while (!settled) {
      this.ws.interrupt()
      await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 100))])
    }
  }
}

interface TurnState {
  readonly abort: AbortController
  /** Why it was stopped: the first reason a cancel gave. */
  reason: string | null
}

/** One turn's events, as they happen. The turn starts on the first
 *  iteration or `wait()`; leaving an iteration early stops watching, and
 *  the turn goes on to its end. */
export class RunStream implements AsyncIterable<TurnEvent> {
  readonly #session: Session
  readonly #opts: { prompt?: string; resume?: boolean; wake?: boolean }
  readonly #onEvent: ((event: TurnEvent) => void) | undefined
  readonly #queued: TurnEvent[] = []
  #wakeup: (() => void) | null = null
  #ended = false
  #outcome: Promise<Outcome> | null = null

  constructor(
    session: Session,
    opts: {
      prompt?: string
      resume?: boolean
      wake?: boolean
      onEvent?: (event: TurnEvent) => void
    },
  ) {
    this.#session = session
    this.#opts = opts
    this.#onEvent = opts.onEvent
  }

  #start(): Promise<Outcome> {
    if (this.#outcome === null) {
      const settle = () => {
        this.#ended = true
        this.#wakeup?.()
      }
      this.#outcome = this.#session._run(this.#opts, (event) => {
        this.#queued.push(event)
        this.#onEvent?.(event)
        this.#wakeup?.()
      })
      this.#outcome.then(settle, settle)
    }
    return this.#outcome
  }

  /** Run the turn to its end, if it isn't running already; its
   *  outcome. */
  wait(): Promise<Outcome> {
    return this.#start()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<TurnEvent> {
    const outcome = this.#start()
    let seen = 0
    for (;;) {
      if (seen < this.#queued.length) {
        yield this.#queued[seen++] as TurnEvent
        continue
      }
      if (this.#ended) {
        await outcome // a turn that couldn't begin throws here
        return
      }
      await new Promise<void>((resolve) => {
        this.#wakeup = () => {
          this.#wakeup = null
          resolve()
        }
      })
    }
  }
}

/** A stop asked for, reaching the loop. */
class Cancelled extends Error {
  override readonly name = 'Cancelled'
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message === '' ? e.name : `${e.name}: ${e.message}`
  return String(e)
}

function imagesOf(output: ToolOutput): Image[] {
  return output.images.map((image) => ({
    kind: 'image',
    data: image.data,
    mediaType: `image/${image.format}`,
  }))
}

function withoutImages(message: Message): Message {
  if (!message.parts.some((p) => p.kind === 'tool_result' && (p.images?.length ?? 0) > 0)) {
    return message
  }
  return {
    ...message,
    parts: message.parts.map((p) => (p.kind === 'tool_result' ? { ...p, images: [] } : p)),
  }
}
