/**
 * `sed` — stream editor.
 *
 * Direct port of termish-py's `sed.py`. Full surface:
 *
 * | Command | Meaning |
 * |---|---|
 * | `s/pat/repl/[gip]` | Substitute (g=all, i=case, p=print on match) |
 * | `y/set1/set2/`     | Transliterate chars (sets must be same length) |
 * | `p` | Print current line (paired with `-n` to print only matched lines) |
 * | `d` | Delete current line |
 * | `a TEXT` | Append TEXT after the line |
 * | `i TEXT` | Insert TEXT before the line |
 * | `c TEXT` | Change current line to TEXT |
 * | `q` | Quit after current line |
 *
 * Addresses: line numbers (`3`), last line (`$`), regex (`/pat/`),
 * or a comma-separated range (`3,5`, `/start/,/end/`).
 *
 * Replacement syntax: `&` is the whole match, `\1`-`\9` are
 * backrefs, `\&` is a literal ampersand, `\n`/`\t`/`\\` are escapes.
 * Translated to JS `$&`/`$1`-`$9` at compile time.
 */

import type { CommandHandler } from '../context'
import { TerminalError } from '../errors'
import { parseArgs } from './_argparse'

const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

interface Address {
  readonly line?: number
  readonly last?: boolean
  readonly regex?: RegExp
}

interface AddressRange {
  readonly addr1?: Address
  readonly addr2?: Address
}

interface SedCommand {
  readonly address: AddressRange
  readonly command: 's' | 'y' | 'p' | 'd' | 'a' | 'i' | 'c' | 'q'
  readonly pattern?: RegExp
  /** For substitution: JS-syntax replacement string. For `y`: set1. */
  readonly replacement?: string
  /** For substitution: flag string. For `y`: set2. */
  readonly subFlags?: string
  /** For a/i/c: the literal text to insert/append/change. */
  readonly text?: string
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/** Read forward from `pos` until an unescaped `delim`. */
function scanDelimited(text: string, pos: number, delim: string): [string, number] {
  const out: string[] = []
  let i = pos
  while (i < text.length) {
    const ch = text[i] as string
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[i + 1] as string
      if (next === delim) {
        out.push(delim)
        i += 2
      } else {
        out.push(ch + next)
        i += 2
      }
    } else if (ch === delim) {
      return [out.join(''), i + 1]
    } else {
      out.push(ch)
      i++
    }
  }
  throw new TerminalError("sed: unterminated 's' command")
}

/**
 * Translate sed replacement syntax to JS `String.replace` syntax.
 *
 * sed:    `&` (whole match), `\1`-`\9` (backref), `\&` (literal `&`)
 * JS:     `$&`,                `$1`-`$9`,           `&`
 *
 * We also escape any literal `$` (which JS treats as a reference
 * indicator) by doubling it (`$$`).
 */
function translateReplacement(repl: string): string {
  const out: string[] = []
  let i = 0
  while (i < repl.length) {
    const c = repl[i] as string
    if (c === '\\' && i + 1 < repl.length) {
      const next = repl[i + 1] as string
      if (next === '&') {
        out.push('&')
      } else if (next === 'n') {
        out.push('\n')
      } else if (next === 't') {
        out.push('\t')
      } else if (next === '\\') {
        out.push('\\')
      } else if (/[1-9]/.test(next)) {
        out.push(`$${next}`)
      } else if (next === '$') {
        // Literal `$` — must be escaped for JS replacement syntax.
        out.push('$$')
      } else {
        // Unknown escape — sed treats `\X` as literal `X`.
        out.push(next)
      }
      i += 2
    } else if (c === '&') {
      out.push('$&')
      i++
    } else if (c === '$') {
      out.push('$$')
      i++
    } else {
      out.push(c)
      i++
    }
  }
  return out.join('')
}

function parseAddress(text: string, pos: number): [Address | null, number] {
  if (pos >= text.length) return [null, pos]
  const ch = text[pos] as string

  if (/\d/.test(ch)) {
    let end = pos
    while (end < text.length && /\d/.test(text[end] as string)) end++
    return [{ line: Number.parseInt(text.slice(pos, end), 10) }, end]
  }
  if (ch === '$') return [{ last: true }, pos + 1]
  if (ch === '/') {
    const [content, newPos] = scanDelimited(text, pos + 1, '/')
    let regex: RegExp
    try {
      regex = new RegExp(content)
    } catch (e) {
      throw new TerminalError(`sed: invalid regex in address: ${describeError(e)}`)
    }
    return [{ regex }, newPos]
  }
  return [null, pos]
}

function parseSubstitution(text: string, pos: number): [RegExp, string, string, number] {
  if (pos >= text.length) throw new TerminalError("sed: unterminated 's' command")
  const delim = text[pos] as string
  if (/[a-zA-Z0-9]/.test(delim) || delim === '\\' || delim === '\n') {
    throw new TerminalError(`sed: invalid delimiter '${delim}'`)
  }
  const [pattern, afterPat] = scanDelimited(text, pos + 1, delim)
  const [rawRepl, afterRepl] = scanDelimited(text, afterPat, delim)
  let i = afterRepl

  let flags = ''
  while (i < text.length && /[gip]/.test(text[i] as string)) {
    flags += text[i] as string
    i++
  }
  if (pattern.length === 0) throw new TerminalError('sed: empty regex in substitution')

  let regex: RegExp
  try {
    // `g` is handled explicitly in the executor; here we just set `i` if present.
    // Always set the `g` flag in the compiled regex when 'g' is requested
    // so JS replaceAll can use it; otherwise omit and use replace once.
    const jsFlags = (flags.includes('i') ? 'i' : '') + (flags.includes('g') ? 'g' : '')
    regex = new RegExp(pattern, jsFlags)
  } catch (e) {
    throw new TerminalError(`sed: invalid regex: ${describeError(e)}`)
  }
  return [regex, translateReplacement(rawRepl), flags, i]
}

function parseSingleCommand(rawText: string): SedCommand {
  const text = rawText.trim()
  if (text.length === 0) throw new TerminalError('sed: empty command')
  let pos = 0

  const [addr1, p1] = parseAddress(text, pos)
  pos = p1
  let addr2: Address | null = null
  if (addr1 !== null && pos < text.length && text[pos] === ',') {
    pos++
    ;[addr2, pos] = parseAddress(text, pos)
    if (addr2 === null) throw new TerminalError('sed: invalid address range')
  }
  const addressRange: AddressRange = {
    ...(addr1 !== null && { addr1 }),
    ...(addr2 !== null && { addr2 }),
  }

  if (pos >= text.length) throw new TerminalError('sed: missing command')
  const cmdChar = text[pos] as string
  pos++

  let cmd: SedCommand

  if (cmdChar === 's') {
    const [pattern, replacement, subFlags, newPos] = parseSubstitution(text, pos)
    pos = newPos
    cmd = { address: addressRange, command: 's', pattern, replacement, subFlags }
  } else if (cmdChar === 'y') {
    if (pos >= text.length) throw new TerminalError("sed: unterminated 'y' command")
    const delim = text[pos] as string
    pos++
    let set1: string
    let set2: string
    ;[set1, pos] = scanDelimited(text, pos, delim)
    ;[set2, pos] = scanDelimited(text, pos, delim)
    if (set1.length !== set2.length) {
      throw new TerminalError(
        `sed: 'y' command sets must be same length (${set1.length} vs ${set2.length})`,
      )
    }
    cmd = { address: addressRange, command: 'y', replacement: set1, subFlags: set2 }
  } else if (cmdChar === 'p' || cmdChar === 'd' || cmdChar === 'q') {
    cmd = { address: addressRange, command: cmdChar }
  } else if (cmdChar === 'a' || cmdChar === 'i' || cmdChar === 'c') {
    let rest = text.slice(pos)
    if (rest.startsWith('\\')) rest = rest.slice(1)
    else if (rest.startsWith(' ')) rest = rest.replace(/^ +/, '')
    rest = rest.replaceAll('\\n', '\n')
    cmd = { address: addressRange, command: cmdChar, text: rest }
    pos = text.length
  } else {
    throw new TerminalError(`sed: unknown command: '${cmdChar}'`)
  }

  const trailing = text.slice(pos).trim()
  if (trailing.length > 0) throw new TerminalError(`sed: trailing characters: '${trailing}'`)
  return cmd
}

/**
 * Split a sed script on `;` / `\n`, but respect:
 * - `s` / `y` delimiter scopes (need 2 closing delims after the opener)
 * - `a` / `i` / `c` text (runs to end-of-line, only `\n` terminates)
 */
function splitScript(script: string): string[] {
  const parts: string[] = []
  let current = ''
  let i = 0
  let delimChar = ''
  let delimRemaining = 0
  let inTextCmd = false

  while (i < script.length) {
    const ch = script[i] as string

    if (inTextCmd) {
      if (ch === '\n') {
        const part = current.trim()
        if (part.length > 0) parts.push(part)
        current = ''
        inTextCmd = false
        i++
        continue
      }
      current += ch
      i++
      continue
    }

    if (delimRemaining > 0) {
      current += ch
      if (ch === '\\' && i + 1 < script.length) {
        current += script[i + 1] as string
        i += 2
        continue
      }
      if (ch === delimChar) delimRemaining--
      i++
      continue
    }

    if (ch === 's' || ch === 'y') {
      current += ch
      i++
      if (i < script.length && !/[a-zA-Z0-9]/.test(script[i] as string)) {
        delimChar = script[i] as string
        delimRemaining = 2
        current += script[i] as string
        i++
      }
      continue
    }

    if (
      (ch === 'a' || ch === 'i' || ch === 'c') &&
      (current.length === 0 ||
        ',' === current[current.length - 1] ||
        ' ' === current[current.length - 1])
    ) {
      current += ch
      i++
      inTextCmd = true
      continue
    }

    if (ch === ';' || ch === '\n') {
      const part = current.trim()
      if (part.length > 0) parts.push(part)
      current = ''
      i++
      continue
    }

    current += ch
    i++
  }
  const last = current.trim()
  if (last.length > 0) parts.push(last)
  return parts
}

function parseSedScript(script: string): SedCommand[] {
  return splitScript(script).map(parseSingleCommand)
}

// ---------------------------------------------------------------------------
// Address matching + processing
// ---------------------------------------------------------------------------

function singleAddrMatches(
  addr: Address,
  lineNum: number,
  totalLines: number,
  lineContent: string,
): boolean {
  if (addr.last === true) return lineNum === totalLines
  if (addr.line !== undefined) return lineNum === addr.line
  if (addr.regex !== undefined) return addr.regex.test(lineContent)
  return false
}

function checkAddress(
  addrRange: AddressRange,
  lineNum: number,
  totalLines: number,
  lineContent: string,
  rangeActive: boolean[],
  idx: number,
): boolean {
  if (addrRange.addr1 === undefined) return true
  if (addrRange.addr2 === undefined) {
    return singleAddrMatches(addrRange.addr1, lineNum, totalLines, lineContent)
  }
  // Range address.
  if (rangeActive[idx]) {
    if (singleAddrMatches(addrRange.addr2, lineNum, totalLines, lineContent)) {
      rangeActive[idx] = false
    }
    return true
  }
  if (singleAddrMatches(addrRange.addr1, lineNum, totalLines, lineContent)) {
    rangeActive[idx] = true
    if (singleAddrMatches(addrRange.addr2, lineNum, totalLines, lineContent)) {
      rangeActive[idx] = false
    }
    return true
  }
  return false
}

/**
 * Apply `commands` to `content`. Returns processed text.
 *
 * Trailing-newline behavior matches GNU sed: if the input ends with
 * a newline, the output does too; if not, the output strips the
 * trailing newline our processing added.
 */
function processContent(
  content: string,
  commands: readonly SedCommand[],
  suppress: boolean,
): string {
  if (content.length === 0) return ''

  const lines = splitLinesKeepEnds(content)
  const hadTrailingNewline = content.endsWith('\n')
  if (lines.length > 0 && !(lines[lines.length - 1] as string).endsWith('\n')) {
    lines[lines.length - 1] = `${lines[lines.length - 1] as string}\n`
  }

  const totalLines = lines.length
  const rangeActive: boolean[] = new Array(commands.length).fill(false)
  const outputLines: string[] = []
  let quitAfter = false

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineNum = lineIdx + 1
    let lineContent = (lines[lineIdx] as string).replace(/\n$/, '')
    let shouldPrint = !suppress
    let deleted = false
    const appendQueue: string[] = []

    for (let cmdIdx = 0; cmdIdx < commands.length; cmdIdx++) {
      if (deleted) break
      const cmd = commands[cmdIdx] as SedCommand
      if (!checkAddress(cmd.address, lineNum, totalLines, lineContent, rangeActive, cmdIdx)) {
        continue
      }

      if (cmd.command === 's') {
        const flags = cmd.subFlags ?? ''
        const regex = cmd.pattern as RegExp
        const repl = cmd.replacement ?? ''
        let numSubs = 0
        // The regex was compiled with the `g` flag in `parseSubstitution`
        // when `g` was requested, so a single `replace` call covers both
        // first-match and global cases.
        lineContent = lineContent.replace(regex, (match, ...rest) => {
          numSubs++
          return applyReplacement(repl, match, rest)
        })
        if (numSubs > 0 && flags.includes('p')) {
          outputLines.push(`${lineContent}\n`)
        }
      } else if (cmd.command === 'y') {
        const set1 = cmd.replacement as string
        const set2 = cmd.subFlags as string
        const map = new Map<string, string>()
        for (let k = 0; k < set1.length; k++) {
          map.set(set1[k] as string, set2[k] as string)
        }
        let translated = ''
        for (const c of lineContent) translated += map.get(c) ?? c
        lineContent = translated
      } else if (cmd.command === 'p') {
        outputLines.push(`${lineContent}\n`)
      } else if (cmd.command === 'd') {
        deleted = true
        shouldPrint = false
      } else if (cmd.command === 'a') {
        appendQueue.push(`${cmd.text ?? ''}\n`)
      } else if (cmd.command === 'i') {
        outputLines.push(`${cmd.text ?? ''}\n`)
      } else if (cmd.command === 'c') {
        outputLines.push(`${cmd.text ?? ''}\n`)
        deleted = true
        shouldPrint = false
      } else if (cmd.command === 'q') {
        if (shouldPrint) outputLines.push(`${lineContent}\n`)
        quitAfter = true
        shouldPrint = false
        break
      }
    }

    if (shouldPrint && !deleted) outputLines.push(`${lineContent}\n`)
    for (const a of appendQueue) outputLines.push(a)
    if (quitAfter) break
  }

  let result = outputLines.join('')
  if (!hadTrailingNewline && result.endsWith('\n')) {
    result = result.slice(0, -1)
  }
  return result
}

/**
 * Hand-evaluate the JS replacement string `repl` against the captured
 * groups of a single match. We do this manually rather than calling
 * `String.replace(regex, repl)` again because the outer replace already
 * consumed the match — we have the raw match + groups via callback args.
 */
function applyReplacement(repl: string, match: string, groups: unknown[]): string {
  // `groups` here is `[group1, group2, ..., offset, fullString]` from
  // String.replace's callback args. The trailing two are not capture
  // groups; trim them.
  const captures = groups.slice(0, -2) as string[]

  let out = ''
  let i = 0
  while (i < repl.length) {
    const c = repl[i] as string
    if (c === '$' && i + 1 < repl.length) {
      const next = repl[i + 1] as string
      if (next === '&') {
        out += match
        i += 2
        continue
      }
      if (next === '$') {
        out += '$'
        i += 2
        continue
      }
      if (/[1-9]/.test(next)) {
        const idx = Number.parseInt(next, 10) - 1
        out += captures[idx] ?? ''
        i += 2
        continue
      }
    }
    out += c
    i++
  }
  return out
}

// ---------------------------------------------------------------------------
// Public command
// ---------------------------------------------------------------------------

export const sed: CommandHandler = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        quiet: { aliases: ['-n', '--quiet', '--silent'] },
        inPlace: { aliases: ['-i', '--in-place'] },
        expression: { aliases: ['-e', '--expression'], multi: true },
        // -E/-r: extended regex; JS RegExp is ERE-flavored, so accept and ignore.
        extended: { aliases: ['-E', '-r', '--regexp-extended'] },
      },
    },
    'sed',
  )

  const explicitExprs = parsed.flags.expression as string[]
  let expressions: string[]
  let files: string[]
  if (explicitExprs.length > 0) {
    expressions = explicitExprs
    files = [...parsed.positional]
  } else {
    if (parsed.positional.length === 0) {
      throw new TerminalError('sed: no expression given')
    }
    expressions = [parsed.positional[0] as string]
    files = parsed.positional.slice(1)
  }

  const commands: SedCommand[] = []
  for (const expr of expressions) {
    for (const c of parseSedScript(expr)) commands.push(c)
  }
  if (commands.length === 0) throw new TerminalError('sed: no expression given')

  const inPlace = parsed.flags.inPlace === true
  if (inPlace && files.length === 0) {
    throw new TerminalError('sed: -i requires at least one file argument')
  }

  const quiet = parsed.flags.quiet === true

  if (files.length === 0) {
    const result = processContent(ctx.stdin, commands, quiet)
    ctx.stdout.write(result)
    return
  }

  for (const path of files) {
    let content: string
    try {
      const bytes = await ctx.fs.read(path)
      content = decoder.decode(bytes)
    } catch (e) {
      throw new TerminalError(`sed: ${path}: ${describeError(e)}`)
    }
    const result = processContent(content, commands, quiet)
    if (inPlace) {
      await ctx.fs.write(path, encoder.encode(result), 'w')
    } else {
      ctx.stdout.write(result)
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitLinesKeepEnds(text: string): string[] {
  if (text.length === 0) return []
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
