/**
 * Compaction's record: keeping a long conversation inside the model's
 * window, after nontainer's `compaction` module.
 *
 * Past a token budget, a loop replaces every earlier turn, in what the
 * model is sent, by one summary. The stored conversation is never
 * rewritten; only the model's view changes. Each fold is recorded under
 * `__compaction__/` in the session, so a rewind takes it back with the
 * turns it folded, a full fork carries it with the conversation, and a
 * fresh fork starts without it.
 *
 * This is the harness-neutral half: the record and where it lives, the
 * policy, the texts, and the shrinking and chunking a fold too large
 * for one request needs. It knows ids, token counts and text. When to
 * fold, what to splice and how the summary is written are each loop's.
 *
 * **Anchors.** A fold names the last message it covers by that
 * message's id in the harness ({@link Fold.through}). A fold whose
 * anchor isn't in the history a loop is building from isn't in force,
 * and an earlier one whose anchor is takes its place; with none, the
 * full history is sent. A cut in the wrong place would hand the model a
 * summary of turns that, as far as the person can see, never happened,
 * while a request that's too long is visible and corrects itself at the
 * next fold.
 */

import { ReadOnlyError } from './errors'
import type { KeyReader, KeyWriter } from './fs'
import { COMPACTION_PREFIX } from './layout'

/** Where each fold is kept: `__compaction__/fold/000001` and on. */
export const FOLD_PREFIX = `${COMPACTION_PREFIX}fold/`

/** The prefix on the id of every message a loop inserts for a fold, so
 *  it knows its own summary pair when it meets it again, and keeps it
 *  out of what it stores. */
export const MARK = 'compaction:'

/** Whether `id` names a message compaction inserted. */
export function isOurs(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(MARK)
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/**
 * One fold: the earlier turns through message `through`, replaced by
 * `summary` in what the model is sent.
 *
 * `first` is null for a fold from the start of the conversation, which
 * is every fold basic compaction makes: each covers what the one before
 * it did and more. It's there for chaptering, a fold over a range in
 * the middle.
 */
export interface Fold {
  /** Id of the last message the fold covers, as the harness names it. */
  readonly through: string
  readonly summary: string
  /** How many turns it covers, for a person reading the record. */
  readonly runs: number
  /** The size of the request that crossed the budget, in tokens. */
  readonly tokensBefore: number
  /** The same request with the fold applied, estimated. */
  readonly tokensAfter: number
  /** What wrote the summary. */
  readonly model: string
  /** When it was made, in milliseconds since the epoch. */
  readonly at: number
  readonly first: string | null
}

/** A fold as a loop records it: the anchor and the summary, the rest
 *  defaulted. */
export type FoldInput = Pick<Fold, 'through' | 'summary'> &
  Partial<Omit<Fold, 'through' | 'summary'>>

function foldOf(value: unknown): Fold | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.through !== 'string' || typeof v.summary !== 'string') return null
  const num = (x: unknown) => (typeof x === 'number' ? x : 0)
  return {
    through: v.through,
    summary: v.summary,
    runs: num(v.runs),
    tokensBefore: num(v.tokensBefore),
    tokensAfter: num(v.tokensAfter),
    model: typeof v.model === 'string' ? v.model : '',
    at: num(v.at),
    first: typeof v.first === 'string' ? v.first : null,
  }
}

/** The fold to apply to a history whose message ids are `ids`: the
 *  latest whose anchor is among them, or null (send the full history). */
export function inForce(folds: readonly Fold[], ids: Iterable<string>): Fold | null {
  const present = new Set(ids)
  for (let i = folds.length - 1; i >= 0; i--) {
    const fold = folds[i] as Fold
    if (present.has(fold.through)) return fold
  }
  return null
}

/**
 * A session's compaction record (`ws.compaction`): its folds, read with
 * what's pending, and the way a loop adds one.
 */
export class WorkspaceCompaction {
  readonly #view: KeyReader
  readonly #writable: () => boolean
  #recording: Promise<unknown> = Promise.resolve()

  /** @internal Made by the workspace. */
  constructor(view: KeyReader, writable: () => boolean = () => true) {
    this.#view = view
    this.#writable = writable
  }

  /** Every fold recorded, oldest first. */
  async folds(): Promise<Fold[]> {
    const keys = (await this.#view.keys()).filter((k) => k.startsWith(FOLD_PREFIX)).sort()
    const out: Fold[] = []
    for (const key of keys) {
      const fold = foldOf(await this.#view.get(key))
      if (fold !== null) out.push(fold)
    }
    return out
  }

  /** The fold in force for a history whose message ids are `ids`. */
  async inForce(ids: Iterable<string>): Promise<Fold | null> {
    return inForce(await this.folds(), ids)
  }

  /**
   * Add a fold; its key. One key per fold, never rewritten: the latest
   * is the one in force, and the earlier ones say what the agent
   * remembered at any commit. The write is left for the next commit to
   * carry, which is the turn's own: a rewind to before that turn takes
   * the fold back with it.
   *
   * @throws ReadOnlyError on a frozen or closed workspace.
   */
  record(fold: FoldInput): Promise<string> {
    const view = this.#view as Partial<KeyWriter>
    if (typeof view.set !== 'function' || !this.#writable()) {
      return Promise.reject(new ReadOnlyError('this workspace cannot record a fold'))
    }
    const writer = this.#view as KeyWriter
    // One at a time, so two folds never take one key.
    const recorded = this.#recording.then(async () => {
      const n = (await writer.keys()).filter((k) => k.startsWith(FOLD_PREFIX)).length
      const key = `${FOLD_PREFIX}${String(n + 1).padStart(6, '0')}`
      const stored: Fold = {
        runs: 0,
        tokensBefore: 0,
        tokensAfter: 0,
        model: '',
        at: Date.now(),
        first: null,
        ...fold,
      }
      writer.set(key, { ...stored })
      return key
    })
    this.#recording = recorded.catch(() => undefined)
    return recorded
  }
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * When to fold, and whether a request fits at all. `budget` is the
 * request size, in tokens, past which every earlier turn is folded.
 * `window` is the model's context length, when known: a fold whose
 * summary request wouldn't fit in it is made from a reduced history
 * ({@link reduce}, {@link chunks}).
 */
export class Policy {
  readonly budget: number
  readonly window: number | null

  constructor(budget: number, window: number | null = null) {
    if (!(budget > 0)) throw new RangeError(`budget must be positive, got ${budget}`)
    if (window !== null && window < budget) {
      throw new RangeError(
        `window (${window}) is smaller than budget (${budget}): a fold would only happen after the provider refused a request`,
      )
    }
    this.budget = budget
    this.window = window
  }

  due(tokens: number): boolean {
    return tokens >= this.budget
  }

  fits(tokens: number): boolean {
    return this.window === null || tokens < this.window
  }
}

/** About four characters a token: for the part of a request the
 *  provider hasn't measured yet. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ---------------------------------------------------------------------------
// The texts
// ---------------------------------------------------------------------------

const WHAT_TO_KEEP = `Write it for yourself: it is what you will continue from, and the person \
should not have to repeat anything. Keep:
- the person's goals, requests and preferences, in their own words where \
the wording matters;
- decisions made, and why; what was tried and ruled out;
- what has been done: files written or changed (with paths), commands \
run and what came of them, what works and what does not yet;
- work handed to other agents, and what came back;
- the task in progress, open questions, and the next steps;
- anything the person asked you to remember.
Leave out routine tool output and plans that were superseded. If the \
conversation already begins with an earlier summary, carry forward what \
still matters from it: there is only ever one summary.`

const REQUEST = `Your context is nearly full. Everything above this message is about to be \
replaced by a summary that you write now. After it you will have the \
summary, the latest message, and whatever you have done since that \
message, to work from.

${WHAT_TO_KEEP}

Do not call any tools. Reply with the summary alone, without a preamble.`

const fromTranscript = (
  what: string,
) => `Below is ${what} of a conversation between a person and an AI agent \
working in a persistent workspace. Summarise it for that agent, which \
will continue from your summary in place of the conversation.

${WHAT_TO_KEEP}

Reply with the summary alone, without a preamble.`

/** What the model says after the summary, so roles still alternate. */
export const ACK = "Understood. I'll continue from this summary."

/**
 * The instruction that asks for a summary. With no transcript, the
 * cache-friendly request, sent after the agent's own messages, which
 * the provider has already seen. With one, the reduced path's, where
 * the conversation arrives as text: `prior` is the summary so far, when
 * chunks are folded in one at a time, and `part` says which chunk.
 */
export function summaryRequest(
  transcriptText?: string,
  opts: { readonly prior?: string; readonly part?: string } = {},
): string {
  if (transcriptText === undefined) return REQUEST
  let text = fromTranscript(
    opts.part === undefined ? 'a transcript' : `${opts.part} of a transcript`,
  )
  if (opts.prior !== undefined && opts.prior !== '') {
    text += `\n\nThe earlier part of the conversation is already summarised here; fold the transcript into it and reply with one summary covering both:\n\n<summary>\n${opts.prior}\n</summary>`
  }
  return `${text}\n\n<transcript>\n${transcriptText}\n</transcript>`
}

/** What the model is sent in place of the turns a fold covers. */
export function summaryMessage(summary: string): string {
  return `[The conversation before this point was compacted to fit the context window. This is the summary you wrote then. The person still sees the whole conversation.]\n\n${summary}`
}

// ---------------------------------------------------------------------------
// A fold too large for one request
// ---------------------------------------------------------------------------

/** One message of a history, as text: what the reduced path works on.
 *  `kind` is `tool_call` for an assistant's call (its name and
 *  arguments), `tool_result` for what came back, `text` otherwise. */
export interface Item {
  readonly role: string
  readonly text: string
  readonly kind?: 'text' | 'tool_call' | 'tool_result'
}

/** The items as one plain-text transcript. */
export function transcript(items: Iterable<Item>): string {
  const labels: Record<string, string> = { tool_call: 'tool call', tool_result: 'tool result' }
  return [...items]
    .map((item) => `[${labels[item.kind ?? 'text'] ?? item.role}]\n${item.text}`)
    .join('\n\n')
}

const thousands = (n: number) => n.toLocaleString('en-US')

/** The items with tool output cut down: each tool result to a short
 *  placeholder that keeps its opening, each long tool-call argument to
 *  its first `argumentChars` characters. What a person or agent said is
 *  kept whole. */
export function reduce(
  items: Iterable<Item>,
  opts: { readonly resultChars?: number; readonly argumentChars?: number } = {},
): Item[] {
  const resultChars = opts.resultChars ?? 300
  const argumentChars = opts.argumentChars ?? 2000
  return [...items].map((item) => {
    if (item.kind === 'tool_result' && item.text.length > resultChars) {
      const head = item.text.slice(0, resultChars).trimEnd()
      return {
        ...item,
        text: `[${thousands(item.text.length)} characters; it began:]\n${head}\n[…]`,
      }
    }
    if (item.kind === 'tool_call' && item.text.length > argumentChars) {
      const cut = item.text.length - argumentChars
      return {
        ...item,
        text: `${item.text.slice(0, argumentChars)}\n[… ${thousands(cut)} more characters]`,
      }
    }
    return item
  })
}

/** `items` in order, packed into lists each estimated under `limit`
 *  tokens, split only between items. An item over the limit on its own
 *  is cut to fit. */
export function chunks(items: readonly Item[], limit: number): Item[][] {
  if (!(limit > 0)) throw new RangeError(`limit must be positive, got ${limit}`)
  const out: Item[][] = []
  let current: Item[] = []
  let size = 0
  for (const original of items) {
    let item = original
    let cost = estimateTokens(item.text) + 4
    if (cost > limit) {
      const keep = Math.max(0, (limit - 4) * 4 - 40)
      item = { ...item, text: `${item.text.slice(0, keep)}\n[… cut to fit]` }
      cost = estimateTokens(item.text) + 4
    }
    if (current.length > 0 && size + cost > limit) {
      out.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += cost
  }
  if (current.length > 0) out.push(current)
  return out
}
