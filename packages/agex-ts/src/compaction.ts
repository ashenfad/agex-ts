/**
 * Compaction: agex folds its own conversations, within a run as well,
 * after Python agex's `agex.compaction`.
 *
 * The world owns the record of a fold and its rules (`ws.compaction`):
 * a {@link Fold} in the session's `__compaction__/` plane, in force
 * while the message it ends at is in the history, taken back by a
 * rewind, carried by a full fork, and never in a stored run. How a loop
 * folds is its own, and this is agex's:
 *
 * - **What the model is sent.** The fold in force replaces the messages
 *   it covers, `first` through `through` (from the start, with `first`
 *   unset), with the summary pair ({@link summaryMessage} and
 *   {@link ACK}). When `through` is inside a run, that run's opening
 *   message (the person's prompt, or a task's brief) is sent again after
 *   the pair, so the model always has the request it is working on, and
 *   the roles still alternate. Everything else is sent as it is.
 * - **When it folds.** Before each model call, when the agent has a
 *   {@link Policy} and the request would reach its budget. A request is
 *   measured from the provider's report for the latest reply, adjusted
 *   for any change of fold since (each reply says which fold its request
 *   had, `Message.fold`), plus an estimate for what came after it.
 * - **What a fold covers.** Everything before the latest step of the run
 *   in progress, from the start: the earlier runs, and the run's own
 *   earlier steps, so a long task folds within its run. A fold ends at a
 *   tool result or at the end of an earlier run, never between a tool
 *   call and its result.
 * - **Who writes the summary.** The agent's own model, sent the request
 *   it was about to be sent up to the fold's end, the same tools, and
 *   the instruction to summarise: almost all of that is in the
 *   provider's cache. A reply with no text, or a request that fails,
 *   falls back to a transcript with tool output cut down, in chunks when
 *   even that is too large, sent without tools. Summary calls count
 *   against the agent's `maxSteps` (a fold is made only with a call to
 *   spare for the request after it), and their usage is streamed and
 *   stored with the run (`Run.compaction`).
 *
 * The budget should sit well above what no fold can take out (the
 * system prompt, the tools, the opening message): a request still over
 * it after a fold folds again at the next step, a summary call each
 * time.
 */

import {
  ACK,
  type Fold,
  type Item,
  COMPACTION_MARK as MARK,
  Policy,
  type TurnEvent,
  type Workspace,
  chunks,
  estimateTokens,
  inForce,
  reduce,
  summaryMessage,
  summaryRequest,
  transcript,
} from '@agex-ts/world'
import type { Provider, Settings, ToolSpec } from './provider'
import { type Message, type Usage, addUsage, messageText, newId } from './record'

const SUMMARY_ID = `${MARK}summary:`
const ACK_ID = `${MARK}ack:`

/** What a fold covers: its anchor, and where its range begins (null:
 *  the start). A reply records only the anchor, which is read back as
 *  the recorded fold that ends there. */
type Range = Pick<Fold, 'through' | 'first'>

/** The conversation as one sequence: the earlier runs' messages, then
 *  the run in progress's, each with the index of its run. */
class Seq {
  readonly messages: Message[] = []
  readonly runs: number[] = []
  readonly current: number

  constructor(earlier: readonly (readonly Message[])[], current: readonly Message[]) {
    earlier.forEach((run, n) => {
      for (const m of run) {
        this.messages.push(m)
        this.runs.push(n)
      }
    })
    for (const m of current) {
      this.messages.push(m)
      this.runs.push(earlier.length)
    }
    this.current = earlier.length
  }

  index(id: string | null | undefined): number | null {
    if (id === null || id === undefined) return null
    const i = this.messages.findIndex((m) => m.id === id)
    return i < 0 ? null : i
  }

  /** Where `fold` begins and ends in the sequence; null when its anchor
   *  isn't in it (it isn't in force). */
  span(fold: Range | null): [number, number] | null {
    if (fold === null) return null
    const end = this.index(fold.through)
    if (end === null) return null
    const start = fold.first === null ? 0 : (this.index(fold.first) ?? 0)
    return start <= end ? [start, end] : null
  }

  /** What `fold` keeps out of a request: every message of its range,
   *  but the opening message of a run it ends inside. */
  removed(fold: Range | null): Set<number> {
    const span = this.span(fold)
    if (span === null) return new Set()
    const [start, end] = span
    const run = this.#run(this.runs[end] as number)
    const kept = end !== run.at(-1) ? run[0] : undefined
    const out = new Set<number>()
    for (let i = start; i <= end; i++) if (i !== kept) out.add(i)
    return out
  }

  /** Where a new fold would end: the latest tool result before the
   *  run's latest step, else the end of the earlier runs. */
  cut(): number | null {
    const current = this.#run(this.current)
    const replies = current.filter((i) => this.messages[i]?.role === 'assistant')
    const latest = replies.at(-1)
    const steps = current
      .slice(1)
      .filter((i) => this.messages[i]?.role === 'tool' && (latest === undefined || i < latest))
    if (steps.length > 0) return steps.at(-1) as number
    let last: number | null = null
    this.runs.forEach((r, i) => {
      if (r !== this.current) last = i
    })
    return last
  }

  #run(n: number): number[] {
    const out: number[] = []
    this.runs.forEach((r, i) => {
      if (r === n) out.push(i)
    })
    return out
  }
}

function pair(fold: Pick<Fold, 'through' | 'summary'>): Message[] {
  return [
    {
      id: SUMMARY_ID + fold.through,
      role: 'user',
      parts: [{ kind: 'text', text: summaryMessage(fold.summary) }],
    },
    { id: ACK_ID + fold.through, role: 'assistant', parts: [{ kind: 'text', text: ACK }] },
  ]
}

/** What the model is sent of the conversation with `fold` in force, up
 *  to message `upto` when given: the summary pair where the fold's
 *  range began, in place of what it keeps out. */
function view(seq: Seq, fold: Fold | null, upto: number | null = null): Message[] {
  const span = seq.span(fold)
  const removed = seq.removed(fold)
  const out: Message[] = []
  seq.messages.forEach((m, i) => {
    if (upto !== null && i > upto) return
    if (fold !== null && span !== null && i === span[0]) out.push(...pair(fold))
    if (!removed.has(i)) out.push(m)
  })
  return out
}

function textOf(message: Message): string {
  return message.parts
    .map((p) => {
      switch (p.kind) {
        case 'text':
        case 'thinking':
          return p.text
        case 'tool_call':
          return JSON.stringify({ name: p.name, args: p.args })
        case 'tool_result':
          return p.content
      }
    })
    .join('\n')
}

function size(messages: readonly Message[]): number {
  return messages.reduce((n, m) => n + estimateTokens(textOf(m)) + 4, 0)
}

/**
 * The size, in tokens, of the request `fold` gives: the provider's
 * report for the latest reply, adjusted for the fold its request had
 * and this one has, plus an estimate for the messages from that reply
 * on; all estimated when no reply reported one.
 */
function measure(
  seq: Seq,
  fold: Fold | null,
  recorded: readonly Fold[],
  system: Message,
  specs: readonly ToolSpec[],
): number {
  let latest: number | null = null
  for (let i = seq.messages.length - 1; i >= 0; i--) {
    const m = seq.messages[i] as Message
    if (m.role === 'assistant' && (m.usage?.inputTokens ?? 0) > 0) {
      latest = i
      break
    }
  }
  if (latest === null) {
    const tools = JSON.stringify(specs.map((s) => s.parameters))
    return size([system, ...view(seq, fold)]) + estimateTokens(tools)
  }
  const msgs = seq.messages
  const reply = msgs[latest] as Message
  const then: Fold | null =
    reply.fold === null || reply.fold === undefined
      ? null
      : ([...recorded].reverse().find((f) => f.through === reply.fold) ?? {
          through: reply.fold,
          first: null,
          summary: '',
          runs: 0,
          tokensBefore: 0,
          tokensAfter: 0,
          model: '',
          at: 0,
        })
  const goneThen = new Set([...seq.removed(then)].filter((i) => i < latest))
  const goneNow = seq.removed(fold)
  const only = (a: Set<number>, b: Set<number>) =>
    [...a]
      .filter((i) => !b.has(i))
      .sort((x, y) => x - y)
      .map((i) => msgs[i] as Message)
  let total = (reply.usage?.inputTokens ?? 0) + size(msgs.slice(latest))
  total -= size(only(goneNow, goneThen))
  total += size(only(goneThen, goneNow))
  total += size(fold ? pair(fold) : []) - size(then ? pair(then) : [])
  return Math.max(total, 0)
}

function items(messages: readonly Message[]): Item[] {
  const out: Item[] = []
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.kind === 'text' && p.text !== '') out.push({ role: m.role, text: p.text })
      else if (p.kind === 'tool_call') {
        const text = JSON.stringify({ name: p.name, args: p.args })
        out.push({ role: m.role, text, kind: 'tool_call' })
      } else if (p.kind === 'tool_result') {
        out.push({ role: m.role, text: p.content, kind: 'tool_result' })
      }
    }
  }
  return out
}

/** No model call is left for a summary. */
class Spent extends Error {}

/** The summary calls a fold may make: at most `spare`, each one's usage
 *  emitted as it ends and added up. */
class Calls {
  made = 0
  usage: Usage | null = null

  constructor(
    readonly provider: Provider,
    readonly settings: Settings,
    readonly spare: number,
    readonly emit: (event: TurnEvent) => void,
    readonly signal: AbortSignal | undefined,
  ) {}

  /** The text of the model's reply to `messages`; {@link Spent} when no
   *  call is left. */
  async reply(messages: readonly Message[], specs: readonly ToolSpec[]): Promise<string> {
    if (this.made >= this.spare) throw new Spent()
    this.made += 1
    const opts = this.signal === undefined ? {} : { signal: this.signal }
    for await (const event of this.provider.stream(messages, specs, this.settings, opts)) {
      if (event.kind !== 'Reply') continue
      const usage = event.message.usage
      if (usage) {
        this.usage = this.usage === null ? usage : addUsage(this.usage, usage)
        this.emit({
          kind: 'Usage',
          inputTokens: usage.inputTokens,
          cachedTokens: usage.cacheReadTokens,
        })
      }
      return messageText(event.message).trim()
    }
    return ''
  }
}

const user = (text: string): Message => ({
  id: newId(),
  role: 'user',
  parts: [{ kind: 'text', text }],
})

/** The summary of `prefix`, or `''` when none could be written within
 *  the calls left. A cancel isn't a failed summary: it ends the turn. */
async function summarize(
  calls: Calls,
  policy: Policy,
  specs: readonly ToolSpec[],
  system: Message,
  prefix: readonly Message[],
  tokens: number,
): Promise<string> {
  const cancelled = () => calls.signal?.aborted === true
  const ask = user(summaryRequest())
  if (policy.fits(tokens + estimateTokens(summaryRequest()))) {
    let text = ''
    try {
      text = await calls.reply([system, ...prefix, ask], specs)
    } catch (e) {
      if (e instanceof Spent) return ''
      // the reduced path is the answer, unless the turn was stopped
      if (cancelled()) throw e
    }
    if (text !== '') return text
  }
  const room = Math.floor((policy.window ?? policy.budget) / 2)
  const parts = chunks(reduce(items(prefix)), room)
  let summary: string | undefined
  for (const [n, part] of parts.entries()) {
    const label = parts.length === 1 ? undefined : `part ${n + 1} of ${parts.length}`
    const text = summaryRequest(transcript(part), {
      ...(summary !== undefined && { prior: summary }),
      ...(label !== undefined && { part: label }),
    })
    try {
      summary = (await calls.reply([user(text)], [])) || summary
    } catch (e) {
      // no fold this time
      if (cancelled()) throw e
      return ''
    }
  }
  return summary ?? ''
}

/** The request for the next model call, and what preparing it took: the
 *  anchor of the fold in force in it (null: none is), which the reply
 *  carries as its `fold`, and the summary calls made, with their usage
 *  summed (null: none was reported). */
export interface Prepared {
  readonly messages: Message[]
  readonly fold: string | null
  readonly calls: number
  readonly usage: Usage | null
}

export interface PrepareOptions {
  readonly ws: Workspace
  readonly policy: Policy | null
  readonly provider: Provider
  readonly specs: readonly ToolSpec[]
  readonly settings: Settings
  readonly system: Message
  /** The earlier runs' messages, a list per run, oldest first. */
  readonly earlier: readonly (readonly Message[])[]
  /** The run in progress's messages. */
  readonly current: readonly Message[]
  readonly emit: (event: TurnEvent) => void
  /** The model calls a fold may make for its summary. */
  readonly spare: number
  readonly signal?: AbortSignal
  /** Fold now, whatever the budget (and with no policy): a fold the
   *  embedder asked for between turns. */
  readonly force?: boolean
}

/**
 * The size of the next request, in tokens, as a fold's policy measures
 * it, and the fold in force: what an embedder shows of the context.
 */
export async function measureContext(opts: {
  readonly ws: Workspace
  readonly specs: readonly ToolSpec[]
  readonly system: Message
  readonly earlier: readonly (readonly Message[])[]
  readonly current: readonly Message[]
}): Promise<{ tokens: number; fold: Fold | null }> {
  const seq = new Seq(opts.earlier, opts.current)
  const recorded = await opts.ws.compaction.folds()
  const fold = inForce(
    recorded,
    seq.messages.map((m) => m.id),
  )
  return { tokens: measure(seq, fold, recorded, opts.system, opts.specs), fold }
}

/**
 * The request for the next model call. Over the budget, it folds first,
 * the summary written in at most `spare` model calls (none folds when
 * they don't suffice): the fold is recorded in `ws` (landing with the
 * workspace's next commit) and emitted as `Compacted`.
 */
export async function prepare(opts: PrepareOptions): Promise<Prepared> {
  const { ws, policy, provider, specs, settings, system, emit } = opts
  const calls = new Calls(provider, settings, opts.spare, emit, opts.signal)
  const seq = new Seq(opts.earlier, opts.current)
  const recorded = await ws.compaction.folds()
  let fold = inForce(
    recorded,
    seq.messages.map((m) => m.id),
  )
  if (policy !== null || opts.force === true) {
    const tokens = measure(seq, fold, recorded, system, specs)
    const end = seq.cut()
    const start = fold === null ? null : seq.index(fold.through)
    const due = opts.force === true || (policy as Policy).due(tokens)
    if (due && end !== null && (start === null || end > start)) {
      const prefix = view(seq, fold, end)
      // a forced fold with no policy summarizes as one whose budget it reached
      const using = policy ?? new Policy(Math.max(1, tokens))
      const summary = await summarize(calls, using, specs, system, prefix, tokens)
      if (summary !== '') {
        const through = (seq.messages[end] as Message).id
        const gone = seq.removed({ through, first: null })
        const made: Fold = {
          through,
          first: null,
          summary,
          runs: new Set([...gone].map((i) => seq.runs[i])).size,
          tokensBefore: tokens,
          tokensAfter: 0,
          model: provider.name,
          at: Date.now(),
        }
        const next: Fold = {
          ...made,
          tokensAfter: measure(seq, made, [...recorded, made], system, specs),
        }
        await ws.compaction.record(next)
        emit({
          kind: 'Compacted',
          through: next.through,
          runs: next.runs,
          first: next.first,
          summary: next.summary,
          tokensBefore: next.tokensBefore,
          tokensAfter: next.tokensAfter,
        })
        fold = next
      }
    }
  }
  return {
    messages: [system, ...view(seq, fold)],
    fold: fold?.through ?? null,
    calls: calls.made,
    usage: calls.usage,
  }
}
