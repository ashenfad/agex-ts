/**
 * I/O builtins: `echo`, `cat`, `head`, `tail`, `tee`.
 *
 * Direct port of termish-py's `io.py`. Flag coverage matches.
 */

import type { CommandContext, CommandHandler } from '../context'
import { TerminalError } from '../errors'
import { parseArgs } from './_argparse'

const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// echo
// ---------------------------------------------------------------------------

/**
 * `echo [-n] [-e] [args...]` — write args joined by single spaces.
 *
 * Parses `-n` (suppress trailing newline), `-e` (interpret escape
 * sequences), and the combined `-ne` / `-en` from the *front* of
 * argv. Anything else (including `-x`) is treated as literal text,
 * matching POSIX `echo` permissiveness — `echo --help` writes
 * `--help`, not an error. Unlike most builtins, `echo` does not
 * use the shared argparse helper.
 */
export const echo: CommandHandler = async (ctx: CommandContext) => {
  let newline = true
  let interpretEscapes = false
  let textStart = 0
  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i] as string
    if (arg === '-n') {
      newline = false
      textStart = i + 1
    } else if (arg === '-e') {
      interpretEscapes = true
      textStart = i + 1
    } else if (arg === '-ne' || arg === '-en') {
      newline = false
      interpretEscapes = true
      textStart = i + 1
    } else {
      break
    }
  }

  let text = ctx.args.slice(textStart).join(' ')
  if (interpretEscapes) text = expandEscapes(text)
  ctx.stdout.write(text + (newline ? '\n' : ''))
}

function expandEscapes(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (c === '\\' && i + 1 < text.length) {
      const next = text[i + 1] as string
      switch (next) {
        case 'n':
          out += '\n'
          break
        case 't':
          out += '\t'
          break
        case '\\':
          out += '\\'
          break
        case 'a':
          out += '\x07'
          break
        case 'b':
          out += '\b'
          break
        default:
          out += `\\${next}`
      }
      i++
    } else {
      out += c
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// cat
// ---------------------------------------------------------------------------

/**
 * `cat [-A | -e | -T | -n] [files...]`
 *
 * `-A`/`--show-all` is `-eT`. `-e` appends `$` at line end. `-T`/
 * `--show-tabs` shows tabs as `^I`. `-n`/`--number` adds line numbers.
 *
 * With no files (or `-` as a file), reads stdin. Files are decoded
 * UTF-8 with the replacement char on invalid sequences.
 */
export const cat: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        showAll: { aliases: ['-A', '--show-all'] },
        showEnds: { aliases: ['-e'] },
        showTabs: { aliases: ['-T', '--show-tabs'] },
        number: { aliases: ['-n', '--number'] },
      },
    },
    'cat',
  )
  const showEnds = parsed.flags.showEnds === true || parsed.flags.showAll === true
  const showTabs = parsed.flags.showTabs === true || parsed.flags.showAll === true
  const showNumbers = parsed.flags.number === true
  const formatting = showEnds || showTabs || showNumbers

  const format = (content: string): string =>
    formatting ? formatCatContent(content, { showEnds, showTabs, showNumbers }) : content

  if (parsed.positional.length === 0) {
    ctx.stdout.write(format(ctx.stdin))
    return
  }

  for (const path of parsed.positional) {
    if (path === '-') {
      ctx.stdout.write(format(ctx.stdin))
      continue
    }
    if (ctx.signal.aborted) throw new TerminalError('cat: aborted')
    try {
      const bytes = await ctx.fs.read(path)
      ctx.stdout.write(format(decoder.decode(bytes)))
    } catch (e) {
      throw new TerminalError(`cat: ${path}: ${describeError(e)}`)
    }
  }
}

function formatCatContent(
  content: string,
  opts: { showEnds: boolean; showTabs: boolean; showNumbers: boolean },
): string {
  const lines = splitLinesKeepEnds(content)
  const result: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i] as string
    const hasNewline = original.endsWith('\n')
    let line = hasNewline ? original.slice(0, -1) : original
    if (opts.showTabs) line = line.replaceAll('\t', '^I')
    if (opts.showEnds) line = `${line}$`
    if (opts.showNumbers) line = `${`${i + 1}`.padStart(6, ' ')}  ${line}`
    if (hasNewline) line = `${line}\n`
    result.push(line)
  }
  return result.join('')
}

// ---------------------------------------------------------------------------
// head
// ---------------------------------------------------------------------------

/**
 * `head [-n N | -c N] [files...]` — first N lines (default 10) or
 * first N bytes. `-N` is a shorthand for `-n N`. With no files,
 * reads stdin. Multiple files print a `==> path <==` header.
 */
export const head: CommandHandler = async (ctx) => {
  const args = preprocessLineShorthand(ctx.args)
  const parsed = parseArgs(
    args,
    {
      flags: {
        lines: { aliases: ['-n', '--lines'], takesValue: true },
        bytes: { aliases: ['-c', '--bytes'], takesValue: true },
      },
    },
    'head',
  )
  const linesLimit = parseIntegerFlag(parsed.flags.lines, 10, 'head', '-n')
  const bytesLimit = parseIntegerFlag(parsed.flags.bytes, 0, 'head', '-c')
  const byteMode = bytesLimit > 0
  const limit = byteMode ? bytesLimit : linesLimit

  const writeFromContent = (content: string): void => {
    if (byteMode) {
      ctx.stdout.write(content.slice(0, limit))
      return
    }
    const lines = splitLinesKeepEnds(content)
    for (let i = 0; i < Math.min(limit, lines.length); i++) {
      ctx.stdout.write(lines[i] as string)
    }
  }

  if (parsed.positional.length === 0) {
    writeFromContent(ctx.stdin)
    return
  }

  for (let i = 0; i < parsed.positional.length; i++) {
    const path = parsed.positional[i] as string
    if (parsed.positional.length > 1) ctx.stdout.write(`==> ${path} <==\n`)
    try {
      const bytes = await ctx.fs.read(path)
      writeFromContent(decoder.decode(bytes))
    } catch (e) {
      throw new TerminalError(`head: cannot open '${path}': ${describeError(e)}`)
    }
    if (i < parsed.positional.length - 1) ctx.stdout.write('\n')
  }
}

// ---------------------------------------------------------------------------
// tail
// ---------------------------------------------------------------------------

/**
 * `tail [-n N | -n +N | -c N] [files...]` — last N lines (default 10),
 * from-line-N (`+N`), or last N bytes. `-N` is a shorthand for
 * `-n N`. Multi-file headers as in `head`.
 */
export const tail: CommandHandler = async (ctx) => {
  const args = preprocessLineShorthand(ctx.args)
  const parsed = parseArgs(
    args,
    {
      flags: {
        lines: { aliases: ['-n', '--lines'], takesValue: true },
        bytes: { aliases: ['-c', '--bytes'], takesValue: true },
      },
    },
    'tail',
  )
  const bytesLimit = parseIntegerFlag(parsed.flags.bytes, 0, 'tail', '-c')
  const byteMode = bytesLimit > 0

  const writeFromContent = (content: string): void => {
    if (byteMode) {
      ctx.stdout.write(content.slice(-bytesLimit))
      return
    }
    const linesValue = (parsed.flags.lines as string | undefined) ?? '10'
    const fromStart = linesValue.startsWith('+')
    const limit = Number.parseInt(fromStart ? linesValue.slice(1) : linesValue, 10)
    if (Number.isNaN(limit) || limit < 0) {
      throw new TerminalError(`tail: invalid number of lines: '${linesValue}'`)
    }
    const lines = splitLinesKeepEnds(content)
    const selected = fromStart ? lines.slice(limit - 1) : lines.slice(-limit)
    for (const line of selected) ctx.stdout.write(line)
  }

  if (parsed.positional.length === 0) {
    writeFromContent(ctx.stdin)
    return
  }

  for (let i = 0; i < parsed.positional.length; i++) {
    const path = parsed.positional[i] as string
    if (parsed.positional.length > 1) ctx.stdout.write(`==> ${path} <==\n`)
    try {
      const bytes = await ctx.fs.read(path)
      writeFromContent(decoder.decode(bytes))
    } catch (e) {
      throw new TerminalError(`tail: cannot open '${path}': ${describeError(e)}`)
    }
    if (i < parsed.positional.length - 1) ctx.stdout.write('\n')
  }
}

// ---------------------------------------------------------------------------
// tee
// ---------------------------------------------------------------------------

/**
 * `tee [-a] [files...]` — read stdin, write to stdout AND to each
 * named file. `-a` appends; default overwrites.
 */
export const tee: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: { append: { aliases: ['-a', '--append'] } },
    },
    'tee',
  )
  const content = ctx.stdin
  ctx.stdout.write(content)
  const mode = parsed.flags.append === true ? 'a' : 'w'
  for (const path of parsed.positional) {
    try {
      await ctx.fs.write(path, encoder.encode(content), mode)
    } catch (e) {
      throw new TerminalError(`tee: ${path}: ${describeError(e)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Rewrite a leading `-N` (digits) into `-n N` so head/tail accept
 *  `head -5 file` as well as `head -n 5 file`. */
function preprocessLineShorthand(args: readonly string[]): string[] {
  if (args.length === 0) return [...args]
  const first = args[0] as string
  if (first.startsWith('-') && first.length > 1 && /^\d+$/.test(first.slice(1))) {
    return ['-n', first.slice(1), ...args.slice(1)]
  }
  return [...args]
}

function parseIntegerFlag(
  raw: string | boolean | string[] | undefined,
  fallback: number,
  prog: string,
  flag: string,
): number {
  if (raw === undefined || typeof raw === 'boolean' || Array.isArray(raw)) return fallback
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n)) throw new TerminalError(`${prog}: invalid value for ${flag}: '${raw}'`)
  return n
}

/**
 * Split a string into lines, *keeping* the trailing line terminator
 * on each line. Mirrors Python's `str.splitlines(keepends=True)`.
 *
 * Recognizes `\n`, `\r\n`, and bare `\r` as line endings.
 */
function splitLinesKeepEnds(text: string): string[] {
  const lines: string[] = []
  let i = 0
  let lineStart = 0
  while (i < text.length) {
    const c = text[i] as string
    if (c === '\n') {
      lines.push(text.slice(lineStart, i + 1))
      i++
      lineStart = i
    } else if (c === '\r') {
      // \r\n is one line terminator; bare \r is also a terminator.
      const end = text[i + 1] === '\n' ? i + 2 : i + 1
      lines.push(text.slice(lineStart, end))
      i = end
      lineStart = end
    } else {
      i++
    }
  }
  if (lineStart < text.length) lines.push(text.slice(lineStart))
  return lines
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
