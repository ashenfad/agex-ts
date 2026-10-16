/**
 * Bash brace expansion, on one quote-masked word.
 *
 * `{a,b,c}` is a list and `{1..5}`, `{a..e}`, `{01..10}`, `{1..10..2}`
 * a sequence, with whatever is written around them repeated for each
 * (`src/{lib,test}` is `src/lib src/test`); lists nest (`{a,b{1,2}}`).
 * It runs before variables and globs, as in bash. A brace with neither
 * a top-level comma nor a sequence inside stays literal (`{}`, `{x}`,
 * so `find -exec cmd {} \;` keeps its `{}`), and so does a whole
 * `${...}` with what's inside it (`${X:-a{b,c}}` gives `a{b,c}`), while
 * braces after one still expand (`${N}{a,b}`).
 * Quoted text is a placeholder by now, so a brace inside quotes never
 * expands, nor an escaped one (the tokenizer quotes it).
 */

import { TerminalError } from './errors'

/** The most words one word may expand to. */
export const BRACE_LIMIT = 100_000

/** `word`'s brace expansion: `[word]` when it has none. */
export function expandBraces(word: string): string[] {
  if (!word.includes('{')) return [word]
  const out = expand(word)
  if (out.length > BRACE_LIMIT) tooMany()
  return out
}

function tooMany(): never {
  throw new TerminalError(`brace expansion: more than ${BRACE_LIMIT} words`)
}

function expand(word: string): string[] {
  const found = firstBrace(word)
  if (found === null) return [word]
  const prefix = word.slice(0, found.start)
  const tails = expand(word.slice(found.end + 1))
  const out: string[] = []
  for (const item of found.items) {
    for (const head of found.sequence ? [item] : expand(item)) {
      for (const tail of tails) {
        out.push(prefix + head + tail)
        if (out.length > BRACE_LIMIT) tooMany()
      }
    }
  }
  return out
}

interface Brace {
  readonly start: number
  readonly end: number
  readonly items: readonly string[]
  /** The items are a sequence's, already literal. */
  readonly sequence: boolean
}

/** The leftmost brace that expands: its span and its items. */
function firstBrace(word: string): Brace | null {
  for (let start = 0; start < word.length; start++) {
    if (word[start] === '$' && word[start + 1] === '{') {
      // A `${...}` never brace-expands, nor anything inside it; one
      // left open keeps just its own `{` literal.
      const close = parameterEnd(word, start)
      start = close >= 0 ? close : start + 1
      continue
    }
    if (word[start] !== '{') continue
    const end = matching(word, start)
    if (end < 0) continue
    const inner = word.slice(start + 1, end)
    const items = splitTop(inner)
    if (items.length > 1) return { start, end, items, sequence: false }
    const seq = sequence(inner)
    if (seq !== null) return { start, end, items: seq, sequence: true }
  }
  return null
}

/**
 * The index of the `}` closing the `${` at `dollar`, or -1. As in bash,
 * only a nested `${` pairs with a `}` inside one, so `${X:-a{b}c}` ends
 * after `b`; a backslash keeps the character after it from counting.
 */
export function parameterEnd(text: string, dollar: number): number {
  let depth = 0
  for (let i = dollar; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') i++
    else if (c === '$' && text[i + 1] === '{') {
      depth++
      i++
    } else if (c === '}' && --depth === 0) return i
  }
  return -1
}

/** The index of the `}` closing the `{` at `open`, or -1. */
function matching(word: string, open: number): number {
  let depth = 0
  for (let i = open; i < word.length; i++) {
    if (word[i] === '{') depth++
    else if (word[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** `inner` split at its top-level commas. */
function splitTop(inner: string): string[] {
  const items: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === ',' && depth === 0) {
      items.push(inner.slice(from, i))
      from = i + 1
    }
  }
  items.push(inner.slice(from))
  return items
}

const NUMBERS = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/
const LETTERS = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/

/** A sequence's items, or null when `inner` isn't one. A step's sign is
 *  ignored, as in bash: the ends say which way it runs. The ends and the
 *  step are exact integers, however long. */
function sequence(inner: string): string[] | null {
  const numbers = NUMBERS.exec(inner)
  if (numbers !== null) {
    const [, a, b, s] = numbers as unknown as [string, string, string, string | undefined]
    const from = BigInt(a)
    const to = BigInt(b)
    const step = stepOf(s)
    if ((to >= from ? to - from : from - to) / step + 1n > BigInt(BRACE_LIMIT)) tooMany()
    // a leading zero on either end pads every item to the wider end
    const width = /^-?0\d/.test(a) || /^-?0\d/.test(b) ? Math.max(a.length, b.length) : 0
    const pad = (n: bigint): string => {
      const digits = String(n < 0n ? -n : n).padStart(n < 0n ? width - 1 : width, '0')
      return n < 0n ? `-${digits}` : digits
    }
    return range(from, to, step).map(pad)
  }
  const letters = LETTERS.exec(inner)
  if (letters !== null) {
    const [, a, b, s] = letters as unknown as [string, string, string, string | undefined]
    return range(BigInt(a.charCodeAt(0)), BigInt(b.charCodeAt(0)), stepOf(s)).map((c) =>
      String.fromCharCode(Number(c)),
    )
  }
  return null
}

/** A sequence's step: its size, 1 when absent or zero. */
function stepOf(text: string | undefined): bigint {
  const step = BigInt(text ?? 1)
  return step < 0n ? -step : step === 0n ? 1n : step
}

function range(from: bigint, to: bigint, step: bigint): bigint[] {
  const out: bigint[] = []
  if (from <= to) for (let n = from; n <= to; n += step) out.push(n)
  else for (let n = from; n >= to; n -= step) out.push(n)
  return out
}
