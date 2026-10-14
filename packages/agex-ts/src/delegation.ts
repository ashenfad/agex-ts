/**
 * Delegation: agex sessions as the world's delegates, after Python
 * agex's `agex.delegation`.
 *
 * A session made with `sessions: true` can delegate through its
 * `sessions` tool. Each delegate is a fork of the session's world, run
 * as a session of the asking agent by a {@link Runner}: it opens the
 * fork with its parent's settings (a delegate holds no more than its
 * parent), runs the task as the delegate's first turn, and wakes it
 * until nothing it waits on is outstanding ({@link untilSettled}). A
 * delegate can delegate in turn, the same way.
 *
 *     const chat = agent.session(ws, { sessions: true })
 *     await chat.say('ask a delegate to write the tests while you fix the bug')
 *     await chat.close() // waits for the delegates still running
 */

import {
  type Reply,
  type RunOptions,
  type SessionRunner,
  Sessions,
  type Workspace,
  type WorkspaceSettings,
  untilSettled,
} from '@agex-ts/world'
import type { Agent, Outcome } from './agent'

/** How many woken turns a delegate gets, when its ask sets no budget. */
export const MAX_WAKES = 10

/** A delegate's turn ended without a reply to settle on. */
class Ended extends Error {
  constructor(readonly reply: Reply) {
    super(typeof reply === 'string' ? reply : reply.text)
  }
}

function failed(outcome: Outcome): Reply {
  const said = outcome.text !== '' ? `${outcome.text}\n\n` : ''
  const why = outcome.message ?? outcome.status
  return {
    text: `${said}[the delegate's turn ended ${outcome.status}: ${why}]`,
    status: 'failed',
  }
}

function cancelRunning(helper: Sessions): void {
  for (const job of helper.list()) {
    if (job.status !== 'running') continue
    try {
      helper.cancel(job.name)
    } catch {
      // the rest still stop
    }
  }
}

/**
 * Runs `agent` as the delegates of the session on `ws`: a
 * {@link SessionRunner}, which a session that delegates hands to each
 * ask, so new delegates run on the agent asking.
 *
 * Each delegate opens its fork with `ws`'s settings, so it holds what
 * its parent holds and no more, and is a session that can delegate
 * too. Its answer is the reply it gives once nothing it waits on is
 * outstanding: its own delegates have answered, and no note is
 * queued. A turn that ends any other way than completed ends the
 * delegate, `failed`, saying how. `budget`, when an ask passes a
 * number, is the most woken turns the delegate gets, `maxWakes` by
 * default.
 *
 * A delegate that answers with its own delegates still out (its wakes
 * spent) waits for them before its answer lands, since closing its
 * helper waits for their runs; a cancelled one cancels them.
 */
export class Runner implements SessionRunner {
  readonly agent: Agent
  readonly settings: WorkspaceSettings
  readonly maxWakes: number
  readonly #ws: Workspace

  constructor(agent: Agent, ws: Workspace, opts: { maxWakes?: number } = {}) {
    this.agent = agent
    this.#ws = ws
    this.settings = ws.settings
    this.maxWakes = opts.maxWakes ?? MAX_WAKES
  }

  toString(): string {
    return `<Runner of ${this.agent}>`
  }

  async run(session: string, task: string, { budget, signal }: RunOptions): Promise<Reply> {
    const wakes = typeof budget === 'number' ? budget : this.maxWakes
    const child = await this.#ws.store.open(session, this.settings)
    try {
      const helper = new Sessions(child, new Runner(this.agent, child, { maxWakes: this.maxWakes }))
      const delegate = this.agent.session(child, { sessions: helper })
      // stopped: its turn stops, and its own delegates with it, rather
      // than be waited for by a run nobody is waiting for; a closed
      // helper ends the wait for them
      const stop = () => {
        delegate.cancel()
        cancelRunning(helper)
        void helper.close()
      }
      signal.addEventListener('abort', stop, { once: true })
      try {
        if (signal.aborted) stop()
        const settled = await untilSettled(
          async (prompt) => {
            if (signal.aborted) throw new Ended({ text: 'stopped', status: 'failed' })
            const outcome = prompt !== null ? await delegate.say(prompt) : await delegate.wake()
            if (outcome.status !== 'completed') throw new Ended(failed(outcome))
            return outcome.text
          },
          helper,
          delegate.inbox,
          { prompt: task, maxWakes: wakes },
        )
        return settled.text
      } catch (e) {
        if (e instanceof Ended) return e.reply
        throw e
      } finally {
        signal.removeEventListener('abort', stop)
        await helper.close()
      }
    } finally {
      await child.close()
    }
  }
}
