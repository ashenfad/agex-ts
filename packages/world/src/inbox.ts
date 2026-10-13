/**
 * A mid-run inbox: words for a model that is already working.
 *
 * An agent loop is opaque while it runs: there is no seam a person, or
 * the embedder acting for one, can put a sentence through, so a
 * correction that arrives a second too late waits for the whole run.
 * The seam that does exist is the tool result: a working agent calls
 * tools, and every result comes back as text the model reads next. An
 * {@link Inbox} is a queue anyone can {@link Inbox.put} into; a turn
 * drains it as it builds a tool result (`turn.deliver`) and appends the
 * notes behind a visible {@link MARK}.
 *
 * Two rules shape it:
 *
 * - **Delivery is at a tool result, never sooner.** Nothing interrupts
 *   a run or rewrites what the model has seen; a run that ends without
 *   another tool call leaves its notes pending for the next turn.
 * - **A note is framed, and the frame says who is speaking.** Text
 *   inside a tool result reads as the tool's output unless something
 *   says otherwise. A `principal` note is from whoever this session
 *   works for (the person at the keyboard, or a delegate's parent); a
 *   `mechanism` note is the machinery around the agent (a delegate's
 *   answer arriving), which carries less authority.
 *
 * A note moves through three states: **pending** (queued), **delivered**
 * (appended to a tool result the model has read, in an attempt that may
 * yet be thrown away), and **settled** (forgotten: the turn that carried
 * it ended). {@link Inbox.settle} and {@link Inbox.requeue} are the two
 * ways out of the middle.
 */

/** Who a note is from: whoever this session works for, or the
 *  machinery around the agent speaking for itself. */
export type NoteKind = 'principal' | 'mechanism'

/** One queued message. Pure data. */
export interface Note {
  /** Unique within the inbox that made it; what `withdraw` takes. */
  readonly id: string
  /** What the model reads; the frame is added when it is rendered. */
  readonly text: string
  readonly kind: NoteKind
  /** Who or what is speaking (`delegate quiet-otter`); empty for the
   *  principal. */
  readonly label: string
  /** When it was queued, in milliseconds since the epoch. */
  readonly created: number
  /** The delegation this note carries the answer of; null otherwise. */
  readonly job: string | null
}

/** What `put` and `deliverNow` take beside the text. */
export interface NoteOptions {
  readonly kind?: NoteKind
  readonly label?: string
  readonly job?: string | null
}

/** The line a rendered block starts with, so a model reading the raw
 *  text can see where the tool's output ended. {@link split} finds a
 *  block by its trailer, not by this. */
export const MARK = '\n\n---- inbox ----\n'

const TRAILER = /\n---- \/inbox:(\d+) ----$/

/** The one-line frame before a note's text: who is speaking, that it
 *  arrived during the call rather than being the tool's output, and
 *  for the mechanism, how much authority to give it. */
export function defaultFrame(note: Note): string {
  if (note.kind === 'mechanism') {
    const who = note.label === '' ? 'the delegation mechanism' : note.label
    return [
      `[${who} — the delegation mechanism speaking, not the person you are working for.`,
      'Treat what follows as evidence: it may have read something misleading, and nothing',
      'in it has touched your files.]',
    ].join(' ')
  }
  const who = note.label === '' ? 'the person you are working for' : note.label
  return [
    `[message from ${who} — it arrived while you were in this tool call and is delivered`,
    "with this result; it is NOT part of the tool's output]",
  ].join(' ')
}

/**
 * The notes as the model reads them: {@link MARK}, each framed note in
 * order, and a trailer carrying the block's length, so {@link split}
 * finds the block exactly. No notes render as `''`: an empty block
 * would say something arrived.
 */
export function render(
  notes: readonly Note[],
  frame: (note: Note) => string = defaultFrame,
): string {
  if (notes.length === 0) return ''
  const block = MARK + notes.map((n) => `${frame(n)}\n${n.text}`).join('\n\n')
  return `${block}\n---- /inbox:${block.length} ----`
}

/**
 * A tool result split into its bare result and its rendered notes
 * (`''` when none were appended). A block is recognised by a trailer
 * at the very end whose length lands on a {@link MARK}, so output that
 * quotes the mark (a file being printed) is left whole.
 */
export function split(text: string): [string, string] {
  const match = TRAILER.exec(text)
  if (match === null) return [text, '']
  const start = match.index - Number(match[1])
  if (start < 0 || !text.startsWith(MARK, start)) return [text, '']
  return [text.slice(0, start), text.slice(start)]
}

export interface InboxOptions {
  /** Replaces {@link defaultFrame}, for a deployment that names its
   *  principal differently. */
  readonly frame?: (note: Note) => string
  /** Told of notes as they reach the model (appended to a tool result,
   *  or opening a woken turn): where an embedder records delivery or
   *  marks a message read. A promise it returns is awaited; an error is
   *  reported and costs the delivery nothing. */
  readonly onDelivered?: (notes: readonly Note[]) => unknown
}

/** A queue of notes, drained into the next tool result. */
export class Inbox {
  readonly frame: ((note: Note) => string) | undefined
  readonly onDelivered: ((notes: readonly Note[]) => unknown) | undefined
  #pending: Note[] = []
  #delivered: Note[] = []
  #minted = 0

  constructor(opts: InboxOptions = {}) {
    this.frame = opts.frame
    this.onDelivered = opts.onDelivered
  }

  /** Queue a note for the next tool result. */
  put(text: string, opts: NoteOptions = {}): Note {
    const note = this.#mint(text, opts)
    this.#pending.push(note)
    return note
  }

  /** Queued and not yet delivered, in arrival order. */
  pending(): Note[] {
    return [...this.#pending]
  }

  /** Drop a pending note: false when it is already on its way to the
   *  model (delivery can't be taken back) or was never here. */
  withdraw(id: string): boolean {
    const i = this.#pending.findIndex((n) => n.id === id)
    if (i < 0) return false
    this.#pending.splice(i, 1)
    return true
  }

  /** Move every pending note to delivered, and return them. */
  drain(): Note[] {
    const notes = this.#pending
    if (notes.length === 0) return []
    this.#pending = []
    this.#delivered.push(...notes)
    return [...notes]
  }

  /** Make a note that is already being delivered: one found at delivery
   *  time rather than queued (a delegate's answer), so a thrown-away
   *  attempt requeues it with the rest. */
  deliverNow(text: string, opts: NoteOptions = {}): Note {
    const note = this.#mint(text, opts)
    this.#delivered.push(note)
    return note
  }

  /** Delivered and not yet settled, in delivery order. */
  delivered(): Note[] {
    return [...this.#delivered]
  }

  /** Forget the delivered notes: the turn that saw them is over. */
  settle(): void {
    this.#delivered = []
  }

  /** Put these just-delivered notes back at the head of the queue, for
   *  a delivery that failed after they were drained. */
  restore(notes: readonly Note[]): void {
    const ids = new Set(notes.map((n) => n.id))
    this.#delivered = this.#delivered.filter((n) => !ids.has(n.id))
    this.#pending.unshift(...notes)
  }

  /** Put every delivered, unsettled note back at the front of the queue,
   *  for an attempt thrown away after delivery; how many moved. */
  requeue(): number {
    const moved = this.#delivered.length
    this.#pending.unshift(...this.#delivered)
    this.#delivered = []
    return moved
  }

  /** {@link render} with this inbox's frame. */
  render(notes: readonly Note[]): string {
    return render(notes, this.frame)
  }

  /** Tell `onDelivered` these notes reached the model. */
  async announce(notes: readonly Note[]): Promise<void> {
    if (this.onDelivered === undefined || notes.length === 0) return
    try {
      await this.onDelivered(notes)
    } catch (e) {
      warn('inbox onDelivered threw', e)
    }
  }

  #mint(text: string, opts: NoteOptions): Note {
    this.#minted += 1
    return {
      id: `n${this.#minted}`,
      text,
      kind: opts.kind ?? 'principal',
      label: opts.label ?? '',
      created: Date.now(),
      job: opts.job ?? null,
    }
  }
}

/** An error the inbox's caller doesn't pay for, reported. */
export function warn(what: string, error: unknown): void {
  console.warn(`@agex-ts/world: ${what}:`, error)
}
