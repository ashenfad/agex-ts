/**
 * Turns: how a harness frames one agent run against a workspace.
 *
 * A turn is opened with `ws.turn(runId)`, the run goes on (its tool
 * calls commit one per call, as always), and the turn ends with the
 * run's status: `turn.end(status, {body, message})` stores the run's
 * body in the conversation and commits what's left, stamped
 * `{tool: 'turn', runs: {[runId]: status}}`. A turn whose run changed
 * nothing makes no commit.
 *
 * - **completed:** the run ran to its end.
 * - **cancelled:** stopped from outside.
 * - **interrupted:** an error the harness may resume from (a provider
 *   failure). The run is kept as it stood, and `ws.turn(runId,
 *   {resume: true})` continues it in place, under the same id.
 * - **failed:** any other error.
 *
 * A cancelled or failed run is an interrupt, not a rollback: its files
 * stay, and the harness keeps the run with a closing note in its body,
 * so the model remembers the work it did before the cut.
 *
 * One turn at a time per workspace; a fork has its own.
 */

import type { CommitInfo, Worktree } from '@agex-ts/kvgit'
import { readIndex, storeRun } from './conversation'
import { WorldError } from './errors'

export const RUN_STATUSES = ['completed', 'cancelled', 'interrupted', 'failed'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** A turn opened while another is open on the same workspace: its run
 *  would land in the other's commit. */
export class TurnInProgressError extends WorldError {
  override readonly name: string = 'TurnInProgressError'
}

export interface TurnOptions {
  /** Continue the run `runId`, which the conversation must hold. */
  readonly resume?: boolean
  /** The harness's name, for storing the run (default: the name the
   *  conversation already has). */
  readonly harness?: string
}

export interface EndOptions {
  /** The run's body, in the harness's format, stored under its id. */
  readonly body?: unknown
  /** The harness's record of the session: a value, or null to delete
   *  it; omitted leaves it as it is. */
  readonly record?: unknown
  /** Why the run ended as it did; recorded on the commit. */
  readonly message?: string
}

/** What a turn reaches in its workspace. */
export interface TurnHost {
  readonly session: string
  /** Run `fn` as one call of the workspace. */
  run<T>(op: string, fn: (wt: Worktree<unknown>) => Promise<T>): Promise<T>
  /** Commit what's pending, if anything; the new commit or null. */
  commitPending(info: CommitInfo): Promise<string | null>
  /** The turn is over: another may open. */
  release(turn: Turn): void
}

export class Turn {
  readonly resume: boolean
  readonly harness: string | null
  /** How the run ended; null while the turn is open. */
  status: RunStatus | null = null
  /** The commit the end made; null when it made none. */
  commit: string | null = null
  #runId: string | null
  #ending = false
  readonly #host: TurnHost

  /** @internal Opened by `ws.turn`. */
  constructor(host: TurnHost, runId: string | null, opts: TurnOptions) {
    this.#host = host
    this.#runId = runId
    this.resume = opts.resume ?? false
    this.harness = opts.harness ?? null
  }

  get runId(): string | null {
    return this.#runId
  }

  /** The turn hasn't ended. */
  get open(): boolean {
    return this.status === null && !this.#ending
  }

  /** Name the run once its id is known, for a loop that mints it after
   *  the run starts. */
  bind(runId: string): void {
    if (this.#runId !== null && this.#runId !== runId) {
      throw new WorldError(`this turn's run is ${this.#runId}; it can't be ${runId} too`)
    }
    this.#runId = runId
  }

  complete(opts: Omit<EndOptions, 'message'> = {}): Promise<string | null> {
    return this.end('completed', opts)
  }

  interrupt(message: string, opts: Omit<EndOptions, 'message'> = {}): Promise<string | null> {
    return this.end('interrupted', { ...opts, message })
  }

  /**
   * End the turn: store the run's body (and record) if given, and
   * commit what's pending, stamped with the status. Returns the commit,
   * or null when nothing was pending.
   *
   * @throws WorldError when the turn already ended, or a body comes
   *   with no run id or no harness name.
   */
  async end(status: RunStatus, opts: EndOptions = {}): Promise<string | null> {
    if (!(RUN_STATUSES as readonly string[]).includes(status)) {
      throw new TypeError(`not a run status: ${JSON.stringify(status)}`)
    }
    if (this.status !== null) throw new WorldError(`this turn already ended '${this.status}'`)
    if (this.#ending) throw new WorldError('this turn already ended: another end is landing it')
    this.#ending = true
    try {
      return await this.#host.run('turn', async (wt) => {
        if (opts.body !== undefined || 'record' in opts) await this.#store(wt, opts)
        const runId = this.#runId
        const info: CommitInfo = {
          tool: 'turn',
          ...(runId !== null && { runs: { [runId]: status } }),
          ...(opts.message !== undefined && opts.message !== '' && { message: opts.message }),
        }
        this.commit = await this.#host.commitPending(info)
        return this.commit
      })
    } finally {
      this.status = status
      this.#ending = false
      this.#host.release(this)
    }
  }

  async #store(wt: Worktree<unknown>, opts: EndOptions): Promise<void> {
    if (this.#runId === null) throw new WorldError('storing a run needs its id: bind it first')
    const harness = this.harness ?? (await readIndex(wt))?.harness
    if (harness === undefined || harness === '') {
      throw new WorldError("storing a run needs the harness's name: harness")
    }
    await storeRun(wt, this.#host.session, harness, this.#runId, {
      ...(opts.body !== undefined && { body: opts.body }),
      ...('record' in opts && { record: opts.record }),
    })
  }
}

/** The status an error ends a run with: an abort is `cancelled`,
 *  anything else `failed`. */
export function statusOf(error: unknown): RunStatus {
  const name = (error as { name?: unknown } | null)?.name
  return name === 'AbortError' || name === 'CancelledError' ? 'cancelled' : 'failed'
}

// ---------- the events a harness streams ----------

/** What a harness streams while a run goes on, for its caller and for
 *  the conformance corpus: `RunStarted` first and `RunEnded` last,
 *  always. Never stored. */
export type TurnEvent =
  | { readonly kind: 'RunStarted'; readonly runId: string }
  | { readonly kind: 'TextDelta'; readonly text: string }
  | { readonly kind: 'ThinkingDelta'; readonly text: string }
  | {
      readonly kind: 'ToolStarted'
      readonly callId: string
      readonly name: string
      readonly args: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'ToolEnded'
      readonly callId: string
      readonly name: string
      readonly result: string
      readonly isError: boolean
    }
  | { readonly kind: 'Usage'; readonly inputTokens: number; readonly cachedTokens?: number }
  | { readonly kind: 'RunEnded'; readonly status: RunStatus; readonly message: string | null }
