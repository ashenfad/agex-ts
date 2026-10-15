/**
 * Bash brace expansion, on one quote-masked word.
 *
 * `{a,b,c}` is a list and `{1..5}`, `{a..e}`, `{01..10}`, `{1..10..2}`
 * a sequence, with whatever is written around them repeated for each
 * (`src/{lib,test}` is `src/lib src/test`); lists nest (`{a,b{1,2}}`).
 * It runs before variables and globs, as in bash. A brace with neither
 * a top-level comma nor a sequence inside stays literal (`{}`, `{x}`,
 * so `find -exec cmd {} \;` keeps its `{}`), and so does `${NAME}`.
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
  for (let start = word.indexOf('{'); start >= 0; start = word.indexOf('{', start + 1)) {
    if (word[start - 1] === '$') continue
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
 *  ignored, as in bash: the ends say which way it runs. */
function sequence(inner: string): string[] | null {
  const numbers = NUMBERS.exec(inner)
  if (numbers !== null) {
    const [, a, b, s] = numbers as unknown as [string, string, string, string | undefined]
    const from = Number(a)
    const to = Number(b)
    const step = Math.abs(Number(s ?? 1)) || 1
    if (Math.abs(to - from) / step + 1 > BRACE_LIMIT) tooMany()
    // a leading zero on either end pads every item to the wider end
    const width = /^-?0\d/.test(a) || /^-?0\d/.test(b) ? Math.max(a.length, b.length) : 0
    const pad = (n: number): string => {
      const digits = String(Math.abs(n)).padStart(n < 0 ? width - 1 : width, '0')
      return n < 0 ? `-${digits}` : digits
    }
    return range(from, to, step).map(pad)
  }
  const letters = LETTERS.exec(inner)
  if (letters !== null) {
    const [, a, b, s] = letters as unknown as [string, string, string, string | undefined]
    const step = Math.abs(Number(s ?? 1)) || 1
    return range(a.charCodeAt(0), b.charCodeAt(0), step).map((c) => String.fromCharCode(c))
  }
  return null
}

function range(from: number, to: number, step: number): number[] {
  const out: number[] = []
  if (from <= to) for (let n = from; n <= to; n += step) out.push(n)
  else for (let n = from; n >= to; n -= step) out.push(n)
  return out
}
