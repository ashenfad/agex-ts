/**
 * The smallest harness the corpus's turn and conversation tiers pass:
 * the contract and nothing else, after nontainer's reference harness.
 *
 * Each run is a turn (`ws.turn`) that plays the clock's replies, calls
 * the world's own tools (each commits), and ends by handing the turn
 * its body: the messages, with a closing note when the run was
 * cancelled or failed. A provider failure ends the run interrupted, and
 * `resume` continues it in place under the same id.
 */

import type { CommitInfo } from '@agex-ts/kvgit'
import type { Clock, Harness, HarnessSession, RunView } from '../src/conformance/index'
import { type RunStatus, type Tool, type TurnEvent, type Workspace, worldTools } from '../src/index'

interface Message {
  readonly role: 'user' | 'assistant' | 'tool' | 'note'
  readonly text: string
}

const HARNESS = 'reference'

class ReferenceSession implements HarnessSession {
  readonly #ws: Workspace
  readonly #clock: Clock
  readonly #tools: Map<string, Tool>
  #cancelled = false
  #interrupted: string | null = null

  constructor(ws: Workspace, clock: Clock) {
    this.#ws = ws
    this.#clock = clock
    this.#tools = new Map(worldTools(ws).map((t) => [t.name, t]))
  }

  async turn(prompt: string): Promise<TurnEvent[]> {
    const turn = await this.#ws.turn(crypto.randomUUID(), { harness: HARNESS })
    return this.#run(turn, [{ role: 'user', text: prompt }])
  }

  async resume(): Promise<TurnEvent[]> {
    const runId = this.#interrupted
    if (runId === null) throw new Error('no interrupted run to resume')
    const body = (await this.#ws.conversation.runs([runId])).get(runId) as { messages: Message[] }
    const turn = await this.#ws.turn(runId, { resume: true, harness: HARNESS })
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

  async #run(
    turn: Awaited<ReturnType<Workspace['turn']>>,
    messages: Message[],
  ): Promise<TurnEvent[]> {
    const runId = turn.runId as string
    const events: TurnEvent[] = [{ kind: 'RunStarted', runId }]
    this.#cancelled = false
    let status: RunStatus = 'completed'
    let message: string | null = null
    let calls = 0
    for (;;) {
      const step = this.#clock.next(messages.map((m) => m.text))
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
        messages.push({ role: 'tool', text: out.text })
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
  capabilities: new Set(['resume', 'keeps-aborted-runs']),
  async open(ws, clock) {
    return new ReferenceSession(ws, clock)
  },
}
