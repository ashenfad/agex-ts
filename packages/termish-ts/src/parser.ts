/**
 * Parse shell script text into the AST defined in `./ast`.
 *
 * Pipeline:
 *
 *   text
 *     → extractHeredocs (replace bodies with opaque placeholders)
 *     → handleLineContinuation (strip remaining backslash-newline joins)
 *     → maskQuotes (preserve quoted spans through tokenization)
 *     → tokenize (split into words + operators + newlines)
 *     → parseTokens (build Script AST, unmasking quoted spans)
 *
 * Ports termish-py's parser without depending on Python's `shlex` —
 * the tokenizer is hand-rolled but follows the same conventions:
 * whitespace splits words, the recognized operator set is fixed,
 * masked quote placeholders behave as single tokens.
 */

import type { Command, Operator, Pipeline, Redirect, RedirectType, Script } from './ast'
import { ParseError } from './errors'
import { maskQuotes, unmaskQuotes } from './quote-masker'

/** Single-character operators recognized at the top of the tokenizer
 *  loop. Multi-char operators (`&&`, `||`, `>>`, `>&`) are matched
 *  greedily before the single-char check. */
const OPERATOR_CHARS = new Set(['|', ';', '<', '>', '&'])

/** Tokens that can never appear where a redirect target / fd is expected. */
const NON_TARGET_TOKENS = new Set(['|', ';', '<', '<<', '>', '>>', '>&', '\n', '&&', '||'])

interface HeredocEntry {
  readonly delimiter: string
  readonly body: string
}

/**
 * Parse shell script text into a `Script` AST. Throws `ParseError`
 * on invalid syntax.
 *
 * Empty or whitespace-only input returns an empty Script (no
 * pipelines), matching termish-py.
 */
export function toScript(text: string): Script {
  if (!text || !text.trim()) {
    return { pipelines: [], operators: [] }
  }
  const extracted = extractHeredocs(text)
  const joined = handleLineContinuation(extracted.text)
  const { masked, map } = maskQuotes(joined)
  const tokens = tokenize(masked)
  return parseTokens(tokens, map, extracted.heredocs)
}

/** Locate `<<` operators outside quoted spans on a command line.
 * `<<<` here-strings are deliberately unsupported and left for the
 * normal parser to reject. Backslash escapes the next character
 * outside single quotes. */
interface HeredocScan {
  readonly positions: ReadonlyArray<number>
  readonly inSingle: boolean
  readonly inDouble: boolean
}

function findHeredocOperators(
  line: string,
  initial: Pick<HeredocScan, 'inSingle' | 'inDouble'>,
): HeredocScan {
  const positions: number[] = []
  let { inSingle, inDouble } = initial
  let index = 0
  while (index < line.length) {
    const char = line[index] as string
    if (char === '\\' && !inSingle) {
      index += 2
      continue
    }
    if (char === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (char === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (
      char === '<' &&
      !inSingle &&
      !inDouble &&
      line[index + 1] === '<' &&
      line[index + 2] !== '<' &&
      line[index - 1] !== '<'
    ) {
      positions.push(index)
      index += 2
      continue
    }
    index++
  }
  return { positions, inSingle, inDouble }
}

/** Pull heredoc bodies out before tokenization so their quotes,
 * operators, redirects, and backslashes remain literal. Each command
 * line operator is replaced with an opaque key whose body is carried
 * separately into the redirect AST.
 *
 * Delimiters may be bare, single-quoted, or double-quoted. All three
 * forms have identical literal-body semantics because termish does
 * not expand heredoc bodies. A delimiter line may be indented; this
 * intentional leniency matches termish-py and agent-generated shell.
 */
function extractHeredocs(text: string): {
  readonly text: string
  readonly heredocs: ReadonlyMap<string, HeredocEntry>
} {
  if (!text.includes('<<')) return { text, heredocs: new Map() }

  const heredocs = new Map<string, HeredocEntry>()
  const outputLines: string[] = []
  const lines = text.split('\n')
  let counter = 0
  let index = 0
  let quoteState: Pick<HeredocScan, 'inSingle' | 'inDouble'> = {
    inSingle: false,
    inDouble: false,
  }

  while (index < lines.length) {
    let line = lines[index] as string

    // Join continuations on the command line before scanning it. Body
    // lines are consumed below and never pass through this operation,
    // so a trailing backslash inside a body remains literal.
    while (hasOddTrailingBackslashCount(line) && index + 1 < lines.length) {
      index++
      line = `${line.slice(0, -1)} ${(lines[index] as string).replace(/^[ \t]*/u, '')}`
    }

    const pending: Array<readonly [key: string, delimiter: string]> = []
    const scan = findHeredocOperators(line, quoteState)
    quoteState = { inSingle: scan.inSingle, inDouble: scan.inDouble }
    const operators = scan.positions
    // Rewrite right-to-left so earlier operator offsets remain valid.
    for (let operatorIndex = operators.length - 1; operatorIndex >= 0; operatorIndex--) {
      const position = operators[operatorIndex] as number
      let cursor = position + 2
      while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\t')) cursor++
      if (cursor >= line.length) throw new ParseError("Expected delimiter after '<<'")

      const quote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor] : undefined
      let delimiter: string
      let end: number
      if (quote !== undefined) {
        end = line.indexOf(quote, cursor + 1)
        if (end < 0) throw new ParseError('Unterminated quote in heredoc delimiter')
        delimiter = line.slice(cursor + 1, end)
        end++
      } else {
        end = cursor
        while (end < line.length && !/[ \t|;&<>]/u.test(line[end] as string)) end++
        delimiter = line.slice(cursor, end)
      }
      if (delimiter.length === 0) throw new ParseError("Expected delimiter after '<<'")

      const key = `__termish_heredoc_${counter++}__`
      line = `${line.slice(0, position)}<< ${key}${line.slice(end)}`
      pending.unshift([key, delimiter])
    }

    outputLines.push(line)
    index++

    for (const [key, delimiter] of pending) {
      const bodyLines: string[] = []
      let terminated = false
      while (index < lines.length) {
        const candidate = lines[index] as string
        index++
        if (candidate === delimiter || candidate.trim() === delimiter) {
          terminated = true
          break
        }
        bodyLines.push(candidate)
      }
      if (!terminated) {
        throw new ParseError(`Unterminated heredoc: expected '${delimiter}' before end of input`)
      }
      heredocs.set(key, {
        delimiter,
        body: bodyLines.length > 0 ? `${bodyLines.join('\n')}\n` : '',
      })
    }
  }

  return { text: outputLines.join('\n'), heredocs }
}

function hasOddTrailingBackslashCount(line: string): boolean {
  let count = 0
  for (let index = line.length - 1; index >= 0 && line[index] === '\\'; index--) count++
  return count % 2 === 1
}

/** Replace `\<newline><optional indent>` with a single space. Lets
 *  agents wrap long pipelines across lines without breaking parsing.  */
function handleLineContinuation(text: string): string {
  return text.replace(/\\\n[ \t]*/g, ' ')
}

/**
 * Hand-rolled tokenizer.
 *
 * After {@link maskQuotes}, quoted spans are opaque alphanumeric
 * placeholders, so the tokenizer doesn't need to track quote state.
 * It splits on plain whitespace (` `, `\t`, `\r`), emits newline as
 * its own token, recognizes the operator set, and treats everything
 * else as a word — including `*`, `?`, `[`, `]`, `=`, `:` and so on,
 * which shells normally pass through as part of arguments.
 *
 * Backslash inside a word escapes the next character (so
 * `foo\ bar` becomes the single token `foo bar`).
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  const n = text.length

  while (i < n) {
    const c = text[i] as string

    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      tokens.push('\n')
      i++
      continue
    }

    // FD-prefixed redirects (`2>`, `2>>`, `2>&1`) — must have NO
    // whitespace between the digit and the operator. Recognized at
    // word-start only so `echo 2 > file` keeps `2` as a regular arg.
    if (/[0-9]/.test(c) && text[i + 1] === '>') {
      // 2>&1
      if (text[i + 2] === '&' && i + 3 < n && /[0-9]/.test(text[i + 3] ?? '')) {
        tokens.push(`${c}>&${text[i + 3]}`)
        i += 4
        continue
      }
      // 2>>
      if (text[i + 2] === '>') {
        tokens.push(`${c}>>`)
        i += 3
        continue
      }
      // 2>
      tokens.push(`${c}>`)
      i += 2
      continue
    }

    // Multi-char operators (greedy, before single-char check).
    if (i + 1 < n) {
      const two = `${c}${text[i + 1]}`
      if (two === '&&' || two === '||' || two === '<<' || two === '>>' || two === '>&') {
        tokens.push(two)
        i += 2
        continue
      }
    }

    if (OPERATOR_CHARS.has(c)) {
      tokens.push(c)
      i++
      continue
    }

    // Word: read until whitespace, newline, or operator.
    let word = ''
    while (i < n) {
      const ch = text[i] as string
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break
      if (OPERATOR_CHARS.has(ch)) {
        // Peek for multi-char to avoid stealing the second char.
        if (i + 1 < n) {
          const peek = `${ch}${text[i + 1]}`
          if (peek === '&&' || peek === '||' || peek === '<<' || peek === '>>' || peek === '>&')
            break
        }
        break
      }
      if (ch === '\\' && i + 1 < n) {
        word += text[i + 1]
        i += 2
        continue
      }
      word += ch
      i++
    }
    if (word.length > 0) tokens.push(word)
  }

  return tokens
}

/**
 * Build a `Script` from a flat token list. Closely follows
 * termish-py's `_parse_tokens`; comments inline call out the
 * non-obvious moves.
 */
function parseTokens(
  tokens: readonly string[],
  maskMap: ReadonlyMap<string, string>,
  heredocs: ReadonlyMap<string, HeredocEntry>,
): Script {
  const pipelines: Pipeline[] = []
  const operators: Operator[] = []

  let currentPipelineCmds: Command[] = []
  let pendingOp: Operator | null = null

  // In-flight command being built.
  let cmdName: string | null = null
  let cmdArgs: string[] = []
  let cmdRedirects: Redirect[] = []

  const unmask = (token: string): string => unmaskQuotes(token, maskMap)

  const flushCommand = (): void => {
    if (cmdName !== null) {
      currentPipelineCmds.push({ name: cmdName, args: cmdArgs, redirects: cmdRedirects })
    }
    cmdName = null
    cmdArgs = []
    cmdRedirects = []
  }

  const flushPipeline = (op: Operator): void => {
    flushCommand()
    if (currentPipelineCmds.length > 0) {
      if (pendingOp !== null) operators.push(pendingOp)
      pipelines.push({ commands: currentPipelineCmds })
      pendingOp = op
    }
    currentPipelineCmds = []
  }

  let i = 0
  while (i < tokens.length) {
    const token = tokens[i] as string
    i++

    if (token === ';' || token === '\n' || token === '&&' || token === '||') {
      // Newlines act as `;` separators between pipelines.
      const op: Operator = token === '\n' ? ';' : (token as Operator)
      flushPipeline(op)
      continue
    }

    if (token === '|') {
      flushCommand()
      if (currentPipelineCmds.length === 0 && cmdName === null) {
        throw new ParseError("Unexpected pipe '|' before command")
      }
      if (i >= tokens.length) {
        throw new ParseError("Unexpected end of input after '|'")
      }
      const next = tokens[i] as string
      i++
      if (next === '|' || next === ';' || next === '\n' || next === '&&' || next === '||') {
        throw new ParseError(`Expected command after '|', got '${next}'`)
      }
      cmdName = unmask(next)
      continue
    }

    if (token === '<<') {
      if (i >= tokens.length) throw new ParseError("Expected delimiter after '<<'")
      const key = tokens[i] as string
      i++
      const heredoc = heredocs.get(key)
      if (heredoc === undefined) {
        throw new ParseError(`Expected heredoc after '<<', got '${key}'`)
      }
      cmdRedirects.push({
        type: '<<',
        target: heredoc.delimiter,
        content: heredoc.body,
      })
      continue
    }

    if (token === '>' || token === '>>' || token === '<') {
      if (i >= tokens.length) {
        throw new ParseError(`Expected filename after '${token}'`)
      }
      const target = tokens[i] as string
      i++
      if (NON_TARGET_TOKENS.has(target)) {
        throw new ParseError(`Expected filename after '${token}', got '${target}'`)
      }
      cmdRedirects.push({ type: token as RedirectType, target: unmask(target) })
      continue
    }

    // FD-prefixed redirects emitted by the tokenizer when there's
    // no whitespace between the digit and `>` (e.g. `2>file`,
    // `2>>file`). Termish has no separate stderr stream, so these
    // are vacuously discarded — but we still consume the filename
    // so it doesn't leak into args.
    if (/^[0-9]>>?$/.test(token)) {
      if (i >= tokens.length) {
        throw new ParseError(`Expected filename after '${token}'`)
      }
      const target = tokens[i] as string
      i++
      if (NON_TARGET_TOKENS.has(target)) {
        throw new ParseError(`Expected filename after '${token}', got '${target}'`)
      }
      continue
    }

    if (token === '>&') {
      // bash-style fd merge (`>&1`); fd-prefixed forms like `2>&1`
      // come pre-glued from the tokenizer (handled below).
      if (i >= tokens.length) {
        throw new ParseError("Expected fd after '>&'")
      }
      const targetFd = tokens[i] as string
      i++
      if (NON_TARGET_TOKENS.has(targetFd)) {
        throw new ParseError(`Expected fd after '>&', got '${targetFd}'`)
      }
      continue
    }

    // Pre-glued fd merge `2>&1` from the tokenizer — vacuously discarded.
    if (/^[0-9]>&[0-9]$/.test(token)) {
      continue
    }

    // Regular word: command name (first) or arg.
    const word = unmask(token)
    if (cmdName === null) cmdName = word
    else cmdArgs.push(word)
  }

  // Final flush — the dummy ';' won't be appended (no next pipeline).
  flushPipeline(';')

  return { pipelines, operators }
}
