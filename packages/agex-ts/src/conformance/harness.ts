/**
 * agex-ts under nontainer's harness corpus, after Python agex's
 * `AgexHarness`: a session over a {@link ScriptedProvider} whose script
 * is the conformance runner's clock, so the corpus checks agex-ts's loop
 * against the contract every harness is held to.
 *
 *     import { SCENARIOS, check, runScenario } from '@agex-ts/world/conformance'
 *     for (const s of SCENARIOS) check(s, await runScenario(s, agexHarness))
 */

import type { CommitInfo } from '@agex-ts/kvgit'
import type { TurnEvent, Workspace } from '@agex-ts/world'
import type {
  Clock,
  Harness,
  HarnessSession,
  OpenOptions,
  RunView,
} from '@agex-ts/world/conformance'
import { Agent, CLOSING_NOTE, type Session } from '../agent'
import { type Run, messageText } from '../record'
import { ScriptedProvider } from '../scripted'

function closesEarly(run: Run): boolean {
  const last = run.messages.at(-1)
  return (
    last !== undefined && last.role === 'assistant' && messageText(last).startsWith(CLOSING_NOTE)
  )
}

async function collect(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const out: TurnEvent[] = []
  for await (const event of events) out.push(event)
  return out
}

/** One workspace, driven by an agex session over the clock's script. */
export class AgexHarnessSession implements HarnessSession {
  readonly session: Session

  constructor(ws: Workspace, clock: Clock, _opts: OpenOptions = {}) {
    const agent = new Agent({ model: new ScriptedProvider((sent) => clock.next(sent)) })
    this.session = agent.session(ws)
  }

  get inbox() {
    return this.session.inbox
  }

  turn(prompt: string): Promise<TurnEvent[]> {
    return collect(this.session.stream(prompt))
  }

  async resume(): Promise<TurnEvent[]> {
    const events: TurnEvent[] = []
    const outcome = await this.session.resume()
    events.push(...outcome.events)
    return events
  }

  async wake(): Promise<TurnEvent[]> {
    return [...(await this.session.wake()).events]
  }

  cancel(): void {
    this.session.cancel()
  }

  async runs(): Promise<RunView[]> {
    return (await this.session.runs()).map((run) => ({
      closingNote: closesEarly(run),
      toolResults: run.messages.reduce(
        (n, m) => n + m.parts.filter((p) => p.kind === 'tool_result').length,
        0,
      ),
    }))
  }

  runStatuses(info: CommitInfo | null): string[] {
    const runs = info?.runs
    return typeof runs === 'object' && runs !== null ? Object.values(runs).map(String) : []
  }

  async close(): Promise<void> {}
}

/** agex-ts as a conformance harness. */
export const agexHarness: Harness = {
  name: 'agex',
  capabilities: new Set(['resume', 'keeps-aborted-runs']),
  async open(ws, clock, opts) {
    return new AgexHarnessSession(ws, clock, opts)
  },
}
