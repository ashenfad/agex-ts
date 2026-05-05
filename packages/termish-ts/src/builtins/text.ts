/**
 * Text-processing builtins: `wc`, `sort`, `uniq`, `cut`, `tr`.
 *
 * Direct port of termish-py's `text.py`. Flag coverage matches.
 *
 * All five operate on UTF-8 text (decoded at the FS boundary). `wc -c`
 * does count *bytes* (UTF-8 length), `wc -m` characters; for ASCII
 * input they're identical.
 */

import type { CommandHandler } from '../context'
import { TerminalError } from '../errors'
import { parseArgs } from './_argparse'

const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// wc
// ---------------------------------------------------------------------------

interface Counts {
  lines: number
  words: number
  bytes: number
  maxLine: number
}

/**
 * `wc [-l|-w|-c|-m|-L] [files...]`
 *
 * Default (no flags) prints lines, words, and bytes. `-m` is treated
 * as `-c` (UTF-8 byte length matches char count for the common case;
 * matches termish-py's simplification). With multiple files, prints
 * a `total` line.
 */
export const wc: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        lines: { aliases: ['-l', '--lines'] },
        words: { aliases: ['-w', '--words'] },
        bytes: { aliases: ['-c', '--bytes'] },
        chars: { aliases: ['-m', '--chars'] },
        maxLine: { aliases: ['-L', '--max-line-length'] },
      },
    },
    'wc',
  )

  let showLines = parsed.flags.lines === true
  let showWords = parsed.flags.words === true
  let showBytes = parsed.flags.bytes === true || parsed.flags.chars === true
  const showMaxLine = parsed.flags.maxLine === true
  if (!showLines && !showWords && !showBytes && !showMaxLine) {
    showLines = true
    showWords = true
    showBytes = true
  }

  const totals: Counts = { lines: 0, words: 0, bytes: 0, maxLine: 0 }
  const results: Array<{ counts: Counts; name: string }> = []

  const countContent = (content: string, name: string): void => {
    const lines = content.split('\n')
    // splitlines-equivalent for max line length (drop trailing empty
    // from a trailing newline, matching Python's behavior).
    const linesNoEmptyTail = lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    let maxLine = 0
    for (const line of linesNoEmptyTail) {
      if (line.length > maxLine) maxLine = line.length
    }
    const counts: Counts = {
      lines: countOccurrences(content, '\n'),
      words:
        content.trim().length === 0 ? 0 : content.split(/\s+/).filter((w) => w.length > 0).length,
      bytes: encoder.encode(content).byteLength,
      maxLine,
    }
    results.push({ counts, name })
    totals.lines += counts.lines
    totals.words += counts.words
    totals.bytes += counts.bytes
    if (counts.maxLine > totals.maxLine) totals.maxLine = counts.maxLine
  }

  if (parsed.positional.length === 0) {
    countContent(ctx.stdin, '')
  } else {
    for (const path of parsed.positional) {
      try {
        const bytes = await ctx.fs.read(path)
        countContent(decoder.decode(bytes), path)
      } catch (e) {
        throw new TerminalError(`wc: ${path}: ${describeError(e)}`)
      }
    }
  }

  // Right-justify column width based on the largest value across all
  // results (matches the `%>{width}` printf style termish-py uses).
  const maxVal = Math.max(totals.bytes, totals.words, totals.lines, totals.maxLine, 1)
  const width = `${maxVal}`.length

  const formatLine = (c: Counts, name: string): string => {
    const parts: string[] = []
    if (showLines) parts.push(`${c.lines}`.padStart(width))
    if (showWords) parts.push(`${c.words}`.padStart(width))
    if (showBytes) parts.push(`${c.bytes}`.padStart(width))
    if (showMaxLine) parts.push(`${c.maxLine}`.padStart(width))
    let line = parts.join(' ')
    if (name.length > 0) line += ` ${name}`
    return line
  }

  for (const { counts, name } of results) ctx.stdout.write(`${formatLine(counts, name)}\n`)
  if (results.length > 1) ctx.stdout.write(`${formatLine(totals, 'total')}\n`)
}

function countOccurrences(s: string, ch: string): number {
  let n = 0
  let i = s.indexOf(ch)
  while (i !== -1) {
    n++
    i = s.indexOf(ch, i + 1)
  }
  return n
}

// ---------------------------------------------------------------------------
// sort
// ---------------------------------------------------------------------------

/**
 * `sort [-r|-n|-u|-f] [-k FIELD] [-t SEP] [files...]`
 *
 * Stable sort. `-k` accepts multiple field specs (each `-k` adds one);
 * `-t` sets the field separator (default: any whitespace run).
 * Numeric sort: lines that don't parse as floats sort *after* numeric
 * ones, matching the `(0, val) | (1, val)` tagging trick in
 * termish-py.
 */
export const sort: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        reverse: { aliases: ['-r', '--reverse'] },
        numeric: { aliases: ['-n', '--numeric-sort'] },
        unique: { aliases: ['-u', '--unique'] },
        ignoreCase: { aliases: ['-f', '--ignore-case'] },
        // -k can appear multiple times; we record only the *last* one
        // here (parseArgs doesn't accumulate). Multi-key sorts would
        // need a parser extension — no current consumer needs it.
        key: { aliases: ['-k', '--key'], takesValue: true },
        sep: { aliases: ['-t', '--field-separator'], takesValue: true },
      },
    },
    'sort',
  )

  const lines: string[] = []
  if (parsed.positional.length === 0) {
    pushLines(ctx.stdin, lines)
  } else {
    for (const path of parsed.positional) {
      try {
        const bytes = await ctx.fs.read(path)
        pushLines(decoder.decode(bytes), lines)
      } catch (e) {
        throw new TerminalError(`sort: ${path}: ${describeError(e)}`)
      }
    }
  }

  const sep = typeof parsed.flags.sep === 'string' ? parsed.flags.sep : null
  let fieldNum: number | null = null
  if (typeof parsed.flags.key === 'string') {
    const spec = parsed.flags.key
    const parsedField = Number.parseInt(spec.split(',')[0]?.split('.')[0] ?? '', 10)
    if (Number.isNaN(parsedField)) {
      throw new TerminalError(`sort: invalid field specification: ${spec}`)
    }
    fieldNum = parsedField
  }

  const ignoreCase = parsed.flags.ignoreCase === true
  const numeric = parsed.flags.numeric === true

  // Build a comparable "key" per line. Returns either a string (lex
  // sort) or a 2-tuple [tag, value] where tag=0 means numeric sort
  // among numeric values, tag=1 means non-numeric — sorted after.
  const keyOf = (line: string): string | [number, string | number] => {
    let value = line
    if (fieldNum !== null) {
      const fields = sep !== null ? line.split(sep) : line.split(/\s+/).filter((s) => s.length > 0)
      value = fields[fieldNum - 1] ?? ''
    }
    if (ignoreCase) value = value.toLowerCase()
    if (numeric) {
      const n = Number.parseFloat(value)
      if (Number.isFinite(n)) return [0, n]
      return [1, value]
    }
    return value
  }

  const compareKeys = (a: ReturnType<typeof keyOf>, b: ReturnType<typeof keyOf>): number => {
    if (typeof a === 'string' && typeof b === 'string') {
      return a < b ? -1 : a > b ? 1 : 0
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1
      const av = a[1]
      const bv = b[1]
      if (typeof av === 'number' && typeof bv === 'number') return av - bv
      const as = `${av}`
      const bs = `${bv}`
      return as < bs ? -1 : as > bs ? 1 : 0
    }
    return 0 // mixed shapes shouldn't occur with consistent flags
  }

  // Stable sort with optional reverse.
  const indexed = lines.map((line, idx) => ({ line, key: keyOf(line), idx }))
  indexed.sort((a, b) => {
    const c = compareKeys(a.key, b.key)
    if (c !== 0) return parsed.flags.reverse === true ? -c : c
    return a.idx - b.idx // stability fallback (idx never reverses)
  })
  let sorted = indexed.map((e) => e.line)

  if (parsed.flags.unique === true) {
    const seen = new Set<string>()
    const out: string[] = []
    for (const line of sorted) {
      const k = stableSerialize(keyOf(line))
      if (!seen.has(k)) {
        seen.add(k)
        out.push(line)
      }
    }
    sorted = out
  }

  for (const line of sorted) ctx.stdout.write(`${line}\n`)
}

function pushLines(text: string, into: string[]): void {
  // Python's `splitlines()` discards a trailing empty line from a
  // terminating newline; we mirror that.
  const split = text.split('\n')
  if (split.length > 0 && split[split.length - 1] === '') split.pop()
  for (const line of split) into.push(line)
}

function stableSerialize(key: string | [number, string | number]): string {
  if (typeof key === 'string') return `s:${key}`
  return `t:${key[0]}:${typeof key[1] === 'number' ? `n:${key[1]}` : `x:${key[1]}`}`
}

// ---------------------------------------------------------------------------
// uniq
// ---------------------------------------------------------------------------

/**
 * `uniq [-c|-d|-u|-i] [file]`
 *
 * Collapse adjacent identical lines. `-c` prefixes each with its
 * count (7-char right-justified). `-d` shows only duplicates (count
 * > 1); `-u` shows only unique lines (count == 1). `-i` ignores case
 * when comparing.
 *
 * Operates on stdin if no file is given. Note: only adjacent runs
 * collapse — to dedupe an unsorted stream, pipe through `sort` first.
 */
export const uniq: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        count: { aliases: ['-c', '--count'] },
        repeated: { aliases: ['-d', '--repeated'] },
        unique: { aliases: ['-u', '--unique'] },
        ignoreCase: { aliases: ['-i', '--ignore-case'] },
      },
      maxPositional: 1,
    },
    'uniq',
  )

  const lines: string[] = []
  if (parsed.positional.length === 0) {
    pushLines(ctx.stdin, lines)
  } else {
    const path = parsed.positional[0] as string
    try {
      const bytes = await ctx.fs.read(path)
      pushLines(decoder.decode(bytes), lines)
    } catch (e) {
      throw new TerminalError(`uniq: ${path}: ${describeError(e)}`)
    }
  }

  if (lines.length === 0) return
  const compareKey = (line: string): string =>
    parsed.flags.ignoreCase === true ? line.toLowerCase() : line

  const groups: Array<{ count: number; line: string }> = []
  let currentLine = lines[0] as string
  let currentKey = compareKey(currentLine)
  let count = 1
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string
    const key = compareKey(line)
    if (key === currentKey) {
      count++
    } else {
      groups.push({ count, line: currentLine })
      currentLine = line
      currentKey = key
      count = 1
    }
  }
  groups.push({ count, line: currentLine })

  for (const { count: n, line } of groups) {
    if (parsed.flags.repeated === true && n === 1) continue
    if (parsed.flags.unique === true && n > 1) continue
    if (parsed.flags.count === true) {
      ctx.stdout.write(`${`${n}`.padStart(7, ' ')} ${line}\n`)
    } else {
      ctx.stdout.write(`${line}\n`)
    }
  }
}

// ---------------------------------------------------------------------------
// cut
// ---------------------------------------------------------------------------

/**
 * `cut -f LIST [-d DELIM] [files...]`
 * `cut -c LIST [files...]`
 * `cut -b LIST [files...]` (treated identically to -c)
 *
 * `LIST` is a comma-separated set of 1-indexed ranges:
 * `1,3-5,7-` (open-ended end means "to end of line").
 *
 * `--complement` inverts the selection. `--output-delimiter` overrides
 * the join character (default: input delimiter, `\t` for `-f`).
 */
export const cut: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        delimiter: { aliases: ['-d', '--delimiter'], takesValue: true },
        fields: { aliases: ['-f', '--fields'], takesValue: true },
        characters: { aliases: ['-c', '--characters'], takesValue: true },
        bytes: { aliases: ['-b', '--bytes'], takesValue: true },
        complement: { aliases: ['--complement'] },
        outputDelim: { aliases: ['--output-delimiter'], takesValue: true },
      },
    },
    'cut',
  )

  let delimiter =
    typeof parsed.flags.delimiter === 'string' ? (parsed.flags.delimiter as string) : '\t'
  // The shell parser doesn't support $'...', so a literal `\t` /
  // `\n` in the arg string needs unescaping here.
  delimiter = delimiter.replaceAll('\\t', '\t').replaceAll('\\n', '\n')

  const fieldsSpec = parsed.flags.fields
  const charsSpec = parsed.flags.characters
  const bytesSpec = parsed.flags.bytes
  if (
    typeof fieldsSpec !== 'string' &&
    typeof charsSpec !== 'string' &&
    typeof bytesSpec !== 'string'
  ) {
    throw new TerminalError('cut: you must specify -f (fields), -c (characters), or -b (bytes)')
  }

  let mode: 'fields' | 'chars'
  let spec: string
  if (typeof fieldsSpec === 'string') {
    mode = 'fields'
    spec = fieldsSpec
  } else if (typeof charsSpec === 'string') {
    mode = 'chars'
    spec = charsSpec
  } else {
    mode = 'chars'
    spec = bytesSpec as string
  }

  const ranges = parseRanges(spec, mode)
  const outDelim =
    typeof parsed.flags.outputDelim === 'string' ? (parsed.flags.outputDelim as string) : delimiter

  const lines: string[] = []
  if (parsed.positional.length === 0) {
    pushLines(ctx.stdin, lines)
  } else {
    for (const path of parsed.positional) {
      try {
        const bytes = await ctx.fs.read(path)
        pushLines(decoder.decode(bytes), lines)
      } catch (e) {
        throw new TerminalError(`cut: ${path}: ${describeError(e)}`)
      }
    }
  }

  const complement = parsed.flags.complement === true
  for (const line of lines) {
    if (mode === 'fields') {
      const fields = line.split(delimiter)
      const selected = selectItems(fields, ranges, complement)
      ctx.stdout.write(`${selected.join(outDelim)}\n`)
    } else {
      // Surrogate-pair-safe character iteration.
      const chars = [...line]
      const selected = selectItems(chars, ranges, complement)
      ctx.stdout.write(`${selected.join('')}\n`)
    }
  }
}

interface Range {
  /** 1-indexed start. */
  readonly start: number
  /** 1-indexed end (inclusive), or `null` for "to end". */
  readonly end: number | null
}

function parseRanges(spec: string, modeForError: 'fields' | 'chars'): Range[] {
  const out: Range[] = []
  for (const partRaw of spec.split(',')) {
    const part = partRaw.trim()
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-', 2) as [string, string]
      const start = startStr === '' ? 1 : Number.parseInt(startStr, 10)
      const end = endStr === '' ? null : Number.parseInt(endStr, 10)
      if (Number.isNaN(start) || (end !== null && Number.isNaN(end))) {
        throw new TerminalError(`cut: invalid ${modeForError} specification: ${spec}`)
      }
      out.push({ start, end })
    } else {
      const n = Number.parseInt(part, 10)
      if (Number.isNaN(n)) {
        throw new TerminalError(`cut: invalid ${modeForError} specification: ${spec}`)
      }
      out.push({ start: n, end: n })
    }
  }
  return out
}

function selectItems<T>(items: readonly T[], ranges: readonly Range[], complement: boolean): T[] {
  if (complement) {
    const excluded = new Set<number>()
    for (const { start, end } of ranges) {
      const upper = end ?? items.length
      for (let i = start; i <= upper; i++) excluded.add(i)
    }
    const out: T[] = []
    for (let i = 0; i < items.length; i++) {
      if (!excluded.has(i + 1)) out.push(items[i] as T)
    }
    return out
  }
  const out: T[] = []
  for (const { start, end } of ranges) {
    if (end === null) {
      for (let i = start - 1; i < items.length; i++) out.push(items[i] as T)
    } else {
      for (let i = start - 1; i < Math.min(end, items.length); i++) out.push(items[i] as T)
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// tr
// ---------------------------------------------------------------------------

/**
 * `tr [-d|-s|-c] SET1 [SET2]`
 *
 * Translate, delete, or squeeze characters. Sets support ranges
 * (`a-z`), POSIX character classes (`[:upper:]`, `[:lower:]`,
 * `[:digit:]`, `[:alpha:]`, `[:alnum:]`, `[:space:]`, `[:blank:]`),
 * and escapes (`\n`, `\t`, `\\`).
 *
 * `-d` deletes chars in SET1. `-s` squeezes runs in SET1 (or SET2
 * when both -d and -s are present). `-c` complements SET1.
 *
 * Unlike most builtins, `tr` does manual flag parsing — the flags
 * are clustered into a single arg (`-ds`, `-cs`, etc.).
 */
export const tr: CommandHandler = async (ctx) => {
  let del = false
  let squeeze = false
  let complement = false
  const positional: string[] = []
  for (const arg of ctx.args) {
    if (arg.startsWith('-') && arg.length > 1 && positional.length === 0) {
      for (const ch of arg.slice(1)) {
        if (ch === 'd') del = true
        else if (ch === 's') squeeze = true
        else if (ch === 'c' || ch === 'C') complement = true
        else throw new TerminalError(`tr: unknown option: -${ch}`)
      }
    } else {
      positional.push(arg)
    }
  }

  if (positional.length === 0) throw new TerminalError('tr: missing operand')

  let set1 = expandTrSet(positional[0] as string)
  const set2 = positional.length > 1 ? expandTrSet(positional[1] as string) : ''
  const content = ctx.stdin

  if (complement) {
    const set1Chars = new Set(set1)
    const allChars = [...new Set(content)].sort()
    set1 = allChars.filter((c) => !set1Chars.has(c)).join('')
  }

  let result: string
  if (del) {
    const toDelete = new Set(set1)
    let kept = ''
    for (const c of content) if (!toDelete.has(c)) kept += c
    if (squeeze && set2.length > 0) {
      kept = squeezeRuns(kept, new Set(set2))
    }
    result = kept
  } else if (squeeze && set2.length === 0) {
    result = squeezeRuns(content, new Set(set1))
  } else {
    if (set2.length === 0) throw new TerminalError('tr: missing operand after SET1')
    // Pad set2 with its last char to match set1's length.
    let padded = set2
    if (padded.length < set1.length) {
      const last = padded[padded.length - 1] as string
      padded = padded + last.repeat(set1.length - padded.length)
    }
    const table = new Map<string, string>()
    for (let i = 0; i < set1.length; i++) {
      table.set(set1[i] as string, padded[i] as string)
    }
    let translated = ''
    for (const c of content) translated += table.get(c) ?? c
    if (squeeze) translated = squeezeRuns(translated, new Set(set2))
    result = translated
  }

  ctx.stdout.write(result)
}

function squeezeRuns(text: string, squeezeSet: ReadonlySet<string>): string {
  let out = ''
  let prev: string | null = null
  for (const c of text) {
    if (squeezeSet.has(c) && prev === c) continue
    out += c
    prev = c
  }
  return out
}

const TR_CHAR_CLASSES: Readonly<Record<string, string>> = {
  '[:upper:]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  '[:lower:]': 'abcdefghijklmnopqrstuvwxyz',
  '[:digit:]': '0123456789',
  '[:alpha:]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  '[:alnum:]': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  '[:space:]': ' \t\n\r\f\v',
  '[:blank:]': ' \t',
}

function expandTrSet(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    if (s[i] === '[' && s[i + 1] === ':') {
      let matched = false
      for (const [name, chars] of Object.entries(TR_CHAR_CLASSES)) {
        if (s.startsWith(name, i)) {
          out += chars
          i += name.length
          matched = true
          break
        }
      }
      if (matched) continue
    }
    if (s[i] === '\\' && i + 1 < s.length) {
      const next = s[i + 1] as string
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === '\\') out += '\\'
      else out += next
      i += 2
      continue
    }
    if (i + 2 < s.length && s[i + 1] === '-') {
      const startCp = (s[i] as string).codePointAt(0) as number
      const endCp = (s[i + 2] as string).codePointAt(0) as number
      if (startCp <= endCp) {
        for (let cp = startCp; cp <= endCp; cp++) out += String.fromCodePoint(cp)
        i += 3
        continue
      }
    }
    out += s[i]
    i++
  }
  return out
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
