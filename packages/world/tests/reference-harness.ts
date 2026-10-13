/**
 * The smallest harness the corpus's turn and conversation tiers pass:
 * the contract and nothing else, after nontainer's reference harness.
 *
 * Each run is a turn (`ws.turn`) that plays the clock's replies, calls
 * the world's own tools (each commits), delivers the inbox's notes on
 * each tool result (`turn.deliver`), and ends by handing the turn its
 * body: the messages, with a closing note when the run was cancelled
 * or failed. A provider failure ends the run interrupted, and `resume`
 * continues it in place under the same id.
 */

import type { CommitInfo } from '@agex-ts/kvgit'
import {
  type Clock,
  CorpusDelegates,
  type Harness,
  type HarnessSession,
  type RunView,
} from '../src/conformance/index'
import {
  Inbox,
  type RunStatus,
  type Sessions,
  type Tool,
  type Turn,
  type TurnEvent,
  type Workspace,
  answerNotes,
  deliveredNote,
  worldTools,
} from '../src/index'

interface Message {
  readonly role: 'user' | 'assistant' | 'tool' | 'note'
  readonly text: string
}

const HARNESS = 'reference'

class ReferenceSession implements HarnessSession {
  readonly inbox = new Inbox()
  readonly #ws: Workspace
  readonly #clock: Clock
  readonly #tools: Map<string, Tool>
  readonly #sessions: Sessions | undefined
  #cancelled = false
  #interrupted: string | null = null

  constructor(ws: Workspace, clock: Clock, sessions?: Sessions) {
    this.#ws = ws
    this.#clock = clock
    this.#sessions = sessions
    this.#tools = new Map(
      worldTools(ws, sessions === undefined ? {} : { sessions }).map((t) => [t.name, t]),
    )
  }

  async turn(prompt: string): Promise<TurnEvent[]> {
    const turn = await this.#begin()
    return this.#run(turn, [{ role: 'user', text: prompt }])
  }

  /** A woken turn: it opens with what is waiting to be delivered. */
  async wake(): Promise<TurnEvent[]> {
    const turn = await this.#begin()
    return this.#run(turn, [{ role: 'user', text: (await turn.opening()) ?? '' }])
  }

  #begin(): Promise<Turn> {
    return this.#ws.turn(crypto.randomUUID(), {
      harness: HARNESS,
      inbox: this.inbox,
      sources: this.#sources(),
    })
  }

  /** A delegate's answers, delivered as they land. */
  #sources() {
    const sessions = this.#sessions
    return sessions === undefined ? [] : [(inbox: Inbox) => answerNotes(sessions, inbox)]
  }

  async resume(): Promise<TurnEvent[]> {
    const runId = this.#interrupted
    if (runId === null) throw new Error('no interrupted run to resume')
    const body = (await this.#ws.conversation.runs([runId])).get(runId) as { messages: Message[] }
    const turn = await this.#ws.turn(runId, {
      resume: true,
      harness: HARNESS,
      inbox: this.inbox,
      sources: this.#sources(),
    })
    return this.#run(turn, [...body.messages])
  }

  cancel(): void {
    this.#cancelled = true
  }

  async runs(): Promise<RunView[]> {
    return [...(await this.#ws.conversation.runs()).values()].map((body) => {
      const messages = (body as { messages: Message[] }).messages
      return {
        closingNote: messages.at(-1)?.role === 'note',
        toolResults: messages.filter((m) => m.role === 'tool').length,
      }
    })
  }

  runStatuses(info: CommitInfo | null): string[] {
    const runs = info?.runs
    return typeof runs === 'object' && runs !== null ? Object.values(runs).map(String) : []
  }

  async close(): Promise<void> {}

  async #run(turn: Turn, messages: Message[]): Promise<TurnEvent[]> {
    const runId = turn.runId as string
    const events: TurnEvent[] = [{ kind: 'RunStarted', runId }]
    this.#cancelled = false
    let status: RunStatus = 'completed'
    let message: string | null = null
    let calls = 0
    for (;;) {
      const step = await this.#clock.next(messages.map((m) => m.text))
      if (this.#cancelled) {
        status = 'cancelled'
        message = 'stopped'
        break
      }
      if (step.fail !== '') {
        status = step.fail === 'provider' ? 'interrupted' : 'failed'
        message = `${step.fail} error`
        break
      }
      if (step.thinking !== '') events.push({ kind: 'ThinkingDelta', text: step.thinking })
      if (step.text !== '') {
        events.push({ kind: 'TextDelta', text: step.text })
        messages.push({ role: 'assistant', text: step.text })
      }
      if (step.tool_calls.length === 0) break
      for (const call of step.tool_calls) {
        const callId = `${runId}-${++calls}`
        events.push({ kind: 'ToolStarted', callId, name: call.name, args: call.args })
        const tool = this.#tools.get(call.name)
        const out =
          tool === undefined
            ? { text: `no tool named ${call.name}`, isError: true }
            : await tool.call(call.args)
        const { text, notes } = await turn.deliver(out.text)
        if (notes.length > 0) events.push({ kind: 'Delivered', notes: notes.map(deliveredNote) })
        messages.push({ role: 'tool', text })
        events.push({
          kind: 'ToolEnded',
          callId,
          name: call.name,
          result: out.text,
          isError: out.isError,
        })
      }
    }
    if (status === 'cancelled' || status === 'failed') {
      messages.push({ role: 'note', text: `ended early: ${message}` })
    }
    await turn.end(status, { body: { messages }, ...(message !== null && { message }) })
    this.#interrupted = status === 'interrupted' ? runId : null
    events.push({ kind: 'RunEnded', status, message })
    return events
  }
}

export const referenceHarness: Harness = {
  name: HARNESS,
  capabilities: new Set(['resume', 'keeps-aborted-runs', 'delegation']),
  async open(ws, clock, opts = {}) {
    return new ReferenceSession(ws, clock, opts.sessions)
  },
  delegation(store, scenario) {
    return new CorpusDelegates(this, store, scenario)
  },
}
