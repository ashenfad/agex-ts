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
 *
 * **The inbox.** A turn opened with an `inbox` delivers its notes on
 * tool results: `turn.deliver(result)` appends what is queued (and what
 * each of its `sources` adds, a delegate's answer, say), and the end
 * settles them. A turn woken for what is waiting rather than by a
 * prompt opens with `turn.opening()`.
 */

import type { CommitInfo, Worktree } from '@agex-ts/kvgit'
import { readIndex, storeRun } from './conversation'
import { WorldError } from './errors'
import { type Inbox, type Note, type NoteKind, warn } from './inbox'

export const RUN_STATUSES = ['completed', 'cancelled', 'interrupted', 'failed'] as const
export type RunStatus = (typeof RUN_STATUSES)[number]

/** A turn opened while another is open on the same workspace: its run
 *  would land in the other's commit. */
export class TurnInProgressError extends WorldError {
  override readonly name: string = 'TurnInProgressError'
}

/** Adds notes at each delivery: given the inbox, returns notes it made
 *  delivered there (`inbox.deliverNow`). */
export type Source = (inbox: Inbox) => Note[]

export interface TurnOptions {
  /** Continue the run `runId`, which the conversation must hold. */
  readonly resume?: boolean
  /** The harness's name, for storing the run (default: the name the
   *  conversation already has). */
  readonly harness?: string
  /** The session's inbox, whose notes `deliver` hands the model and the
   *  end settles. */
  readonly inbox?: Inbox
  /** Add notes of their own at each delivery. */
  readonly sources?: readonly Source[]
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
  readonly inbox: Inbox | null
  readonly sources: readonly Source[]
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
    this.inbox = opts.inbox ?? null
    this.sources = [...(opts.sources ?? [])]
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

  // ---------- delivery ----------

  /**
   * The notes to deliver on the tool result landing now: the inbox's
   * queue, then what each source adds. They are delivered, not
   * settled. Empty without an inbox. A source that throws is reported
   * and skipped, and the notes it had made go back to the queue.
   *
   * For a result that isn't text (one with images), call this, attach
   * `inbox.render(notes)` yourself, and `inbox.restore(notes)` if they
   * can't be attached; otherwise use {@link deliver}.
   */
  collect(): Note[] {
    const inbox = this.inbox
    if (inbox === null) return []
    const notes = inbox.drain()
    for (const source of this.sources) {
      const before = new Set(inbox.delivered().map((n) => n.id))
      try {
        notes.push(...source(inbox))
      } catch (e) {
        warn('a delivery source threw; its notes wait for the next tool result', e)
        const stray = inbox.delivered().filter((n) => !before.has(n.id))
        if (stray.length > 0) inbox.restore(stray)
      }
    }
    return notes
  }

  /**
   * `result` with the notes waiting for it appended, and those notes.
   * Call it on each tool result before the model sees it (not on one
   * that threw, so the notes wait for the next). The end settles them;
   * a loop that throws an attempt away puts them back with
   * `inbox.requeue()`. Notes that can't be rendered (a frame that
   * throws) go back to the queue, and the result goes on as it was.
   */
  async deliver(result: string): Promise<{ text: string; notes: Note[] }> {
    const [rendered, notes] = this.#render()
    if (rendered === null) return { text: result, notes: [] }
    await this.inbox?.announce(notes)
    return { text: result + rendered, notes }
  }

  /**
   * What a WOKEN turn opens with: a turn started for what is waiting
   * (its delegates' answers, a queued note) rather than by a prompt
   * sends this as its first message. The notes are delivered as
   * `deliver` delivers them. Null when nothing is waiting.
   */
  async opening(): Promise<string | null> {
    const [rendered, notes] = this.#render()
    if (rendered === null) return null
    await this.inbox?.announce(notes)
    return rendered
  }

  #render(): [string | null, Note[]] {
    const notes = this.collect()
    if (notes.length === 0 || this.inbox === null) return [null, []]
    try {
      return [this.inbox.render(notes), notes]
    } catch (e) {
      warn(`${notes.length} note(s) could not be rendered; they wait for the next delivery`, e)
      this.inbox.restore(notes)
      return [null, []]
    }
  }

  // ---------- ending ----------

  complete(opts: Omit<EndOptions, 'message'> = {}): Promise<string | null> {
    return this.end('completed', opts)
  }

  interrupt(message: string, opts: Omit<EndOptions, 'message'> = {}): Promise<string | null> {
    return this.end('interrupted', { ...opts, message })
  }

  /**
   * End the turn: store the run's body (and record) if given, settle
   * the inbox's delivered notes, and commit what's pending, stamped
   * with the status. Returns the commit, or null when nothing was
   * pending.
   *
   * A turn ends once, and once the end has begun the turn is released
   * whatever happens, so an end that throws doesn't leave the workspace
   * refusing turns. What it stored then stays pending, as after any
   * failed commit: `ws.refresh()` drops it and moves to the session's
   * latest commit, and a new turn can store the run again. Left
   * pending, it lands in the next call's commit without the turn's
   * stamp.
   *
   * @throws WorldError when the turn already ended, or a body comes
   *   with no run id or no harness name.
   * @throws CommitConflictError when a concurrent commit to the session
   *   conflicts (two workspaces ending turns, say).
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
        this.inbox?.settle()
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

/** A note as it reached the model, for a transcript. */
export interface DeliveredNote {
  readonly id: string
  readonly text: string
  readonly kind: NoteKind
  readonly label: string
  readonly job: string | null
}

/** A delivered note as a {@link TurnEvent} carries it. */
export function deliveredNote(note: Note): DeliveredNote {
  return { id: note.id, text: note.text, kind: note.kind, label: note.label, job: note.job }
}

/** What a harness streams while a run goes on, for its caller and for
 *  the conformance corpus: `RunStarted` first and `RunEnded` last,
 *  always. `Delivered` comes before the `ToolEnded` whose result
 *  carried its notes (and the result there leaves them out). Never
 *  stored. */
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
  | { readonly kind: 'Delivered'; readonly notes: readonly DeliveredNote[] }
  | { readonly kind: 'Usage'; readonly inputTokens: number; readonly cachedTokens?: number }
  | { readonly kind: 'RunEnded'; readonly status: RunStatus; readonly message: string | null }
