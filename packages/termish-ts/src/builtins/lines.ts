/**
 * Line builtins: `seq`, `paste`, `comm`, `rev`.
 *
 * Mirrors termish-py's `lines.py`. A file's lines are its text split
 * at `\n`, a final newline ending the last line rather than starting
 * an empty one.
 */

import type { CommandContext, CommandHandler } from '../context'
import { TerminalError } from '../errors'
import { describeFsError } from '../fs/errors'
import { parseArgs } from './_argparse'

const decoder = new TextDecoder('utf-8', { fatal: false })

/** The most numbers one `seq` writes. */
export const SEQ_MAX = 1_000_000

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** A file's text, or stdin's for `-`. */
async function readText(ctx: CommandContext, prog: string, path: string): Promise<string> {
  if (path === '-') return ctx.stdin.text()
  try {
    return decoder.decode(await ctx.fs.read(path))
  } catch (e) {
    throw new TerminalError(`${prog}: ${path}: ${describeFsError(e)}`)
  }
}

// ---------------------------------------------------------------------------
// seq
// ---------------------------------------------------------------------------

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

/** The largest exponent `seq` takes, so `1e999999999` can't build a
 *  billion-digit number. */
export const SEQ_MAX_EXPONENT = 1000

/** A number exactly as written: `digits` times 10^`exp`. */
interface Exact {
  digits: bigint
  exp: number
  /** Digits after the decimal point, as written. */
  places: number
}

function parseNumber(text: string): Exact {
  const m = NUMBER_RE.exec(text)
  if (m === null) throw new TerminalError(`seq: invalid floating point argument: '${text}'`)
  const mantissa = m[1] as string
  const exp = m[2] === undefined ? 0 : Number(m[2].slice(1))
  if (Math.abs(exp) > SEQ_MAX_EXPONENT) throw new TerminalError(`seq: out of range: '${text}'`)
  const dot = mantissa.indexOf('.')
  const frac = dot === -1 ? 0 : mantissa.length - dot - 1
  const magnitude = BigInt(mantissa.replace('.', '') || '0')
  return {
    digits: text.startsWith('-') ? -magnitude : magnitude,
    exp: exp - frac,
    places: Math.max(0, frac - exp),
  }
}

/** `x` as an integer count of 10^-`places`; `places` is at least `x.places`. */
function scaleTo(x: Exact, places: number): bigint {
  return x.digits * 10n ** BigInt(x.exp + places)
}

/** `n` (in units of 10^-`places`) as decimal text. */
function formatScaled(n: bigint, places: number): string {
  const sign = n < 0n ? '-' : ''
  const digits = (n < 0n ? -n : n).toString().padStart(places + 1, '0')
  if (places === 0) return sign + digits
  return `${sign}${digits.slice(0, -places)}.${digits.slice(-places)}`
}

/** `-s`/`-w` and the numbers, read by hand: `-1` is a number, not a flag. */
function seqArgs(args: readonly string[]): { sep: string; equal: boolean; operands: string[] } {
  let sep = '\n'
  let equal = false
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (NUMBER_RE.test(arg)) operands.push(arg)
    else if (arg === '-w' || arg === '--equal-width') equal = true
    else if (arg === '-s' || arg === '--separator') {
      if (i + 1 >= args.length) throw new TerminalError(`seq: option ${arg} requires a value`)
      sep = args[++i] as string
    } else if (arg.startsWith('--separator=')) sep = arg.slice('--separator='.length)
    else if (arg.startsWith('-s')) sep = arg.slice(2)
    else if (arg === '--') {
      operands.push(...args.slice(i + 1))
      break
    } else if (arg.startsWith('-')) throw new TerminalError(`seq: unknown option: ${arg}`)
    else operands.push(arg)
  }
  return { sep, equal, operands }
}

/**
 * `seq [-s SEP] [-w] [FIRST [INCR]] LAST`
 *
 * Numbers from FIRST (default 1) by INCR (default 1) up to LAST, one
 * per line or joined by SEP. Shown with as many decimals as FIRST or
 * INCR has; `-w` zero-pads them to one width. At most `SEQ_MAX`.
 */
export const seq: CommandHandler = async (ctx) => {
  const { sep, equal, operands } = seqArgs(ctx.args)
  if (operands.length === 0) throw new TerminalError('seq: missing operand')
  if (operands.length > 3) throw new TerminalError(`seq: extra operand '${operands[3]}'`)
  const nums = operands.map(parseNumber)
  const one: Exact = { digits: 1n, exp: 0, places: 0 }
  const first = operands.length > 1 ? (nums[0] as Exact) : one
  const incr = operands.length === 3 ? (nums[1] as Exact) : one
  const last = nums[nums.length - 1] as Exact
  if (incr.digits === 0n)
    throw new TerminalError(`seq: invalid Zero increment value: '${operands[1]}'`)

  // Exact integers in LAST's precision too, so it compares exactly;
  // shown with FIRST's and INCR's decimals only.
  const places = Math.max(first.places, incr.places)
  const exact = Math.max(places, last.places)
  const unit = 10n ** BigInt(exact - places)
  const start = scaleTo(first, exact)
  const step = scaleTo(incr, exact)
  const end = scaleTo(last, exact)
  const within = (n: bigint): boolean => (step > 0n ? n <= end : n >= end)

  const out: string[] = []
  for (let n = start; within(n); n += step) {
    if (out.length >= SEQ_MAX) {
      throw new TerminalError(`seq: too many numbers (the limit is ${SEQ_MAX})`)
    }
    if (out.length % 10_000 === 0 && ctx.signal.aborted) throw new TerminalError('aborted')
    out.push(formatScaled(n / unit, places))
  }
  if (out.length === 0) return
  if (equal) {
    const width = Math.max(...out.map((s) => s.length))
    for (let i = 0; i < out.length; i++) {
      const s = out[i] as string
      out[i] = s.startsWith('-')
        ? `-${s.slice(1).padStart(width - 1, '0')}`
        : s.padStart(width, '0')
    }
  }
  ctx.stdout.write(`${out.join(sep)}\n`)
}

// ---------------------------------------------------------------------------
// paste
// ---------------------------------------------------------------------------

/** `-d`'s list, with `\n`, `\t`, `\\` and `\0` (no delimiter) read.
 *  One delimiter per character, not per UTF-16 unit. */
function delimiters(spec: string): string[] {
  const chars = Array.from(spec)
  const out: string[] = []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    if (ch === '\\' && i + 1 < chars.length) {
      const next = chars[++i] as string
      out.push(next === 'n' ? '\n' : next === 't' ? '\t' : next === '0' ? '' : next)
    } else out.push(ch)
  }
  if (out.length === 0) throw new TerminalError("paste: delimiter list can't be empty")
  return out
}

/**
 * `paste [-s] [-d LIST] [FILE...]`
 *
 * Each output line joins the files' lines at that position, by a tab
 * or LIST's delimiters in turn; `-s` joins each file's lines into one
 * line instead. `-` (or no file) is stdin, read a line at a time by
 * each `-` in turn.
 */
export const paste: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        serial: { aliases: ['-s', '--serial'] },
        delimiters: { aliases: ['-d', '--delimiters'], takesValue: true },
      },
    },
    'paste',
  )
  const delims =
    typeof parsed.flags.delimiters === 'string' ? delimiters(parsed.flags.delimiters) : ['\t']
  const files = parsed.positional.length === 0 ? ['-'] : [...parsed.positional]
  const stdinLines = files.includes('-') ? splitLines(ctx.stdin.text()) : []
  const join = (cells: readonly string[]): string =>
    cells.reduce(
      (acc, cell, i) => (i === 0 ? cell : acc + (delims[(i - 1) % delims.length] as string) + cell),
      '',
    )

  if (parsed.flags.serial === true) {
    let stdinTaken = false
    for (const f of files) {
      let lines: string[]
      if (f === '-') {
        lines = stdinTaken ? [] : stdinLines
        stdinTaken = true
      } else lines = splitLines(await readText(ctx, 'paste', f))
      ctx.stdout.write(`${join(lines)}\n`)
    }
    return
  }

  const columns: Array<string[] | null> = []
  for (const f of files)
    columns.push(f === '-' ? null : splitLines(await readText(ctx, 'paste', f)))
  const stdinCols = columns.filter((c) => c === null).length
  let rows = 0
  for (const c of columns) if (c !== null) rows = Math.max(rows, c.length)
  if (stdinCols > 0) rows = Math.max(rows, Math.ceil(stdinLines.length / stdinCols))
  let next = 0
  for (let r = 0; r < rows; r++) {
    const cells = columns.map((c) => (c === null ? (stdinLines[next++] ?? '') : (c[r] ?? '')))
    ctx.stdout.write(`${join(cells)}\n`)
  }
}

// ---------------------------------------------------------------------------
// comm
// ---------------------------------------------------------------------------

/**
 * `comm [-1] [-2] [-3] FILE1 FILE2`
 *
 * Compares two sorted files: lines only in FILE1, lines only in FILE2,
 * and lines in both, in three tab-indented columns. `-1`, `-2` and
 * `-3` leave a column out. Either file may be `-`, for stdin.
 */
export const comm: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        one: { aliases: ['-1'] },
        two: { aliases: ['-2'] },
        three: { aliases: ['-3'] },
      },
      minPositional: 2,
      maxPositional: 2,
    },
    'comm',
  )
  const [p1, p2] = parsed.positional as [string, string]
  if (p1 === '-' && p2 === '-') throw new TerminalError('comm: only one file may be stdin')
  const a = splitLines(await readText(ctx, 'comm', p1))
  const b = splitLines(await readText(ctx, 'comm', p2))
  const show1 = parsed.flags.one !== true
  const show2 = parsed.flags.two !== true
  const show3 = parsed.flags.three !== true
  const pre2 = show1 ? '\t' : ''
  const pre3 = pre2 + (show2 ? '\t' : '')
  let i = 0
  let j = 0
  let out = ''
  while (i < a.length || j < b.length) {
    const x = a[i]
    const y = b[j]
    if (y === undefined || (x !== undefined && x < y)) {
      if (show1) out += `${x}\n`
      i++
    } else if (x === undefined || y < x) {
      if (show2) out += `${pre2}${y}\n`
      j++
    } else {
      if (show3) out += `${pre3}${x}\n`
      i++
      j++
    }
  }
  ctx.stdout.write(out)
}

// ---------------------------------------------------------------------------
// rev
// ---------------------------------------------------------------------------

/** `rev [FILE...]` — each line's characters in reverse order. */
export const rev: CommandHandler = async (ctx) => {
  const files = ctx.args.length === 0 ? ['-'] : ctx.args
  for (const f of files) {
    const text = await readText(ctx, 'rev', f)
    ctx.stdout.write(
      text
        .split('\n')
        .map((line) => Array.from(line).reverse().join(''))
        .join('\n'),
    )
  }
}
