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
 * masked quote placeholders behave as single tokens, and an unquoted
 * `#` at the start of a word begins a comment.
 *
 * Shell control flow, functions, variable assignment, and command and
 * arithmetic substitution are not implemented. They fail here, before
 * anything runs, each with a diagnostic that says where it is and what
 * to do instead (rather than as several "command not found" lines),
 * and every one in the script at once, so a single retry can fix them
 * all. Each stage keeps, for every character it outputs, the offset in
 * the text it read, so a token's place in the script is known.
 */

import type { Command, Operator, Pipeline, Redirect, RedirectType, Script } from './ast'
import { ParseError } from './errors'
import { maskQuotes, unmaskQuotes } from './quote-masker'

/** Single-character operators recognized at the top of the tokenizer
 *  loop. Multi-char operators (`&&`, `||`, `>>`, `>&`) are matched
 *  greedily before the single-char check. */
const OPERATOR_CHARS = new Set(['|', ';', '<', '>', '&'])

/** What a word starts after, for the heredoc scanner's comment rule:
 *  whitespace, or an operator character, as in the tokenizer. */
const WORD_BOUNDARY = new Set([' ', '\t', '|', ';', '<', '>', '&'])

/** Tokens that can never appear where a redirect target / fd is expected. */
const NON_TARGET_TOKENS = new Set(['|', ';', '<', '<<', '>', '>>', '>&', '\n', '&&', '||'])

const FUNCTION_ADVICE =
  "function definitions are not supported; inject reusable commands through execute()'s 'commands' option"

const LOOP_ADVICE = 'control flow is not supported; use xargs or find -exec for iteration'
const CONDITIONAL_ADVICE =
  'control flow is not supported; test with [ ... ] and branch with && and || instead'
const SUBSTITUTION_ADVICE =
  "Command substitution '$(...)' is not supported; run the inner command separately"
const ARITHMETIC_ADVICE = 'arithmetic expansion $((...)) is not supported; compute it in run_ts'
const ASSIGNMENT_ADVICE =
  "variable assignment is not supported; write the value where it's used, or compute it in run_ts"

/** A word that assigns a variable, as bash reads one in command
 *  position (`N=3`, `X="a b"`). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * What's wrong with a script, by where: offsets into the text given to
 * `toScript`, reported as lines and columns.
 */
class Diagnostics {
  readonly #text: string
  readonly #found: { offset: number; message: string }[] = []

  constructor(text: string) {
    this.#text = text
  }

  add(offset: number, message: string): void {
    this.#found.push({ offset, message })
  }

  /** Add a problem nothing can be parsed past, and throw them all. */
  fail(offset: number, message: string): never {
    this.add(offset, message)
    this.throwIfAny()
    throw new ParseError(message)
  }

  /** Throw every problem found, in the order they come in the script. */
  throwIfAny(): void {
    if (this.#found.length === 0) return
    const seen = new Set<string>()
    const lines: string[] = []
    for (const { offset, message } of [...this.#found].sort((a, b) => a.offset - b.offset)) {
      const line = `${this.#place(offset)}: ${message}`
      if (!seen.has(line)) lines.push(line)
      seen.add(line)
    }
    throw new ParseError(lines.join('\n'))
  }

  /** `line L, col C`, both from 1. */
  #place(offset: number): string {
    const before = this.#text.slice(0, offset)
    const line = before.split('\n').length
    return `line ${line}, col ${offset - before.lastIndexOf('\n')}`
  }
}

/** Where each `$(` and `$((` in `text` starts, unless escaped. */
function substitutions(text: string): { index: number; message: string }[] {
  const out: { index: number; message: string }[] = []
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
    } else if (text.startsWith('$((', i)) {
      out.push({ index: i, message: ARITHMETIC_ADVICE })
      i += 2
    } else if (text.startsWith('$(', i)) {
      out.push({ index: i, message: SUBSTITUTION_ADVICE })
      i += 1
    }
  }
  return out
}

/** The quote masker's placeholders. */
const QUOTED = /__Q_[0-9a-f]+_\d+__/g

/**
 * Report `$(...)` and `$((...))` in the tokens, rather than run them as
 * mangled args or pass them through unexpanded inside double quotes.
 * Checked after tokenizing, so a comment that mentions one is never
 * reported. Inside single quotes each is a harmless literal, as in bash.
 */
function reportSubstitutions(
  tokens: readonly string[],
  starts: readonly number[],
  map: ReadonlyMap<string, string>,
  toInput: (masked: number) => number,
  found: Diagnostics,
): void {
  tokens.forEach((token, t) => {
    const start = starts[t] as number
    for (const { index, message } of substitutions(token))
      found.add(toInput(start + index), message)
    for (const key of token.matchAll(QUOTED)) {
      const original = map.get(key[0])
      if (original?.[0] !== '"') continue
      const at = toInput(start + (key.index as number))
      for (const { index, message } of substitutions(original)) found.add(at + index, message)
    }
  })
}

/** A transform's output, with each character's offset in its input
 *  (and one past the end, for the end of the text). */
interface Traced {
  readonly text: string
  readonly origin: readonly number[]
}

/** `text` unchanged. */
function untraced(text: string): Traced {
  return { text, origin: Array.from({ length: text.length + 1 }, (_, i) => i) }
}

/** `text` with each match of `pattern` replaced by `by`, traced: the
 *  replacement maps to its match's start. */
function traceReplace(text: string, pattern: RegExp, by: string): Traced {
  let out = ''
  const origin: number[] = []
  let from = 0
  for (const m of text.matchAll(pattern)) {
    const at = m.index as number
    for (let i = from; i < at; i++) origin.push(i)
    out += text.slice(from, at) + by
    for (let i = 0; i < by.length; i++) origin.push(at)
    from = at + m[0].length
  }
  for (let i = from; i <= text.length; i++) origin.push(i)
  return { text: out + text.slice(from), origin }
}

/** Each character of `masked`'s offset in `before`, the text it masked:
 *  a placeholder maps to the start of the quoted span it stands for. */
function traceMask(before: string, masked: string, map: ReadonlyMap<string, string>): number[] {
  const origin: number[] = []
  const key = /__Q_[0-9a-f]+_\d+__/y
  let j = 0
  for (let i = 0; i < masked.length; ) {
    key.lastIndex = i
    const m = key.exec(masked)
    const original = m === null ? undefined : map.get(m[0])
    if (m !== null && original !== undefined) {
      for (let k = 0; k < m[0].length; k++) origin.push(j)
      i += m[0].length
      j += original.length
    } else {
      origin.push(j)
      i++
      j++
    }
  }
  origin.push(before.length)
  return origin
}

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
  const found = new Diagnostics(text)
  const extracted = extractHeredocs(text, found)
  const joined = handleLineContinuation(extracted.text)
  const { masked, map } = maskQuotes(joined.text)
  const maskOrigin = traceMask(joined.text, masked, map)
  const toInput = (i: number): number =>
    extracted.origin[joined.origin[maskOrigin[i] as number] as number] as number
  const { tokens, starts } = tokenize(masked, map)
  reportSubstitutions(tokens, starts, map, toInput, found)
  const script = parseTokens(
    tokens,
    map,
    extracted.heredocs,
    (t) => toInput(starts[t] as number),
    found,
  )
  found.throwIfAny()
  return script
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
      char === '#' &&
      !inSingle &&
      !inDouble &&
      (index === 0 || WORD_BOUNDARY.has(line[index - 1] as string))
    ) {
      // A word-start `#` begins a comment, which the tokenizer drops; a
      // `<<` inside one must not start a heredoc.
      break
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
function extractHeredocs(
  text: string,
  found: Diagnostics,
): Traced & { readonly heredocs: ReadonlyMap<string, HeredocEntry> } {
  if (!text.includes('<<')) return { ...untraced(text), heredocs: new Map() }

  const heredocs = new Map<string, HeredocEntry>()
  const outputLines: string[] = []
  const outputOrigins: number[][] = []
  const lines = text.split('\n')
  const lineStarts: number[] = []
  for (let k = 0, at = 0; k < lines.length; k++) {
    lineStarts.push(at)
    at += (lines[k] as string).length + 1
  }
  const span = (k: number, from = 0): number[] => {
    const start = lineStarts[k] as number
    return Array.from({ length: (lines[k] as string).length - from }, (_, i) => start + from + i)
  }
  let counter = 0
  let index = 0
  let quoteState: Pick<HeredocScan, 'inSingle' | 'inDouble'> = {
    inSingle: false,
    inDouble: false,
  }

  while (index < lines.length) {
    let line = lines[index] as string
    let origin = span(index)

    // Join continuations on the command line before scanning it. Body
    // lines are consumed below and never pass through this operation,
    // so a trailing backslash inside a body remains literal.
    while (hasOddTrailingBackslashCount(line) && index + 1 < lines.length) {
      index++
      const next = lines[index] as string
      const indent = (/^[ \t]*/u.exec(next) as RegExpExecArray)[0].length
      line = `${line.slice(0, -1)} ${next.slice(indent)}`
      origin = [...origin, ...span(index, indent)]
    }
    // where the command line's newline is, for the output's
    const lineEnd = (lineStarts[index] as number) + (lines[index] as string).length

    const pending: Array<readonly [key: string, delimiter: string, at: number]> = []
    const scan = findHeredocOperators(line, quoteState)
    quoteState = { inSingle: scan.inSingle, inDouble: scan.inDouble }
    const operators = scan.positions
    // Rewrite right-to-left so earlier operator offsets remain valid.
    for (let operatorIndex = operators.length - 1; operatorIndex >= 0; operatorIndex--) {
      const position = operators[operatorIndex] as number
      const at = origin[position] as number
      let cursor = position + 2
      while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\t')) cursor++
      if (cursor >= line.length) found.fail(at, "Expected delimiter after '<<'")

      const quote = line[cursor] === "'" || line[cursor] === '"' ? line[cursor] : undefined
      let delimiter: string
      let end: number
      if (quote !== undefined) {
        end = line.indexOf(quote, cursor + 1)
        if (end < 0) found.fail(origin[cursor] as number, 'Unterminated quote in heredoc delimiter')
        delimiter = line.slice(cursor + 1, end)
        end++
      } else {
        end = cursor
        while (end < line.length && !/[ \t|;&<>]/u.test(line[end] as string)) end++
        delimiter = line.slice(cursor, end)
      }
      if (delimiter.length === 0) found.fail(at, "Expected delimiter after '<<'")

      const key = `__termish_heredoc_${counter++}__`
      line = `${line.slice(0, position)}<< ${key}${line.slice(end)}`
      origin = [
        ...origin.slice(0, position),
        ...Array<number>(3 + key.length).fill(at),
        ...origin.slice(end),
      ]
      pending.unshift([key, delimiter, at])
    }

    outputLines.push(line)
    outputOrigins.push([...origin, lineEnd])
    index++

    for (const [key, delimiter, at] of pending) {
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
        found.fail(at, `Unterminated heredoc: expected '${delimiter}' before end of input`)
      }
      heredocs.set(key, {
        delimiter,
        body: bodyLines.length > 0 ? `${bodyLines.join('\n')}\n` : '',
      })
    }
  }

  // Each line's origin ends with its newline's offset. The last line's
  // newline isn't output: its entry stands for the end of the text.
  const origin = outputOrigins.flat()
  origin[origin.length - 1] = text.length
  return { text: outputLines.join('\n'), origin, heredocs }
}

function hasOddTrailingBackslashCount(line: string): boolean {
  let count = 0
  for (let index = line.length - 1; index >= 0 && line[index] === '\\'; index--) count++
  return count % 2 === 1
}

/** Replace `\<newline><optional indent>` with a single space. Lets
 *  agents wrap long pipelines across lines without breaking parsing.  */
function handleLineContinuation(text: string): Traced {
  return traceReplace(text, /\\\n[ \t]*/g, ' ')
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
/** Characters that mean something bare: operators, globs, quotes, a
 *  comment's start, brace expansion. */
const MEANINGFUL = new Set([...OPERATOR_CHARS, '*', '?', '[', ']', "'", '"', '#', '{', '}', ','])

/**
 * Split masked text into tokens. `quoted` is the quote masker's map: an
 * escaped character that means something bare is masked as the quoted
 * form of itself, so it is a literal everywhere a quoted one is (`\;`
 * is a word, never the operator; `\*` never globs).
 */
function tokenize(
  text: string,
  quoted: Map<string, string>,
): { tokens: string[]; starts: number[] } {
  const tokens: string[] = []
  /** Where each token starts in `text`. */
  const starts: number[] = []
  let i = 0
  const n = text.length
  const session = Math.floor(Math.random() * 0xffff_ffff)
    .toString(16)
    .padStart(8, '0')
  let escapes = 0
  const escaped = (char: string): string => {
    const token = `__E_${session}_${escapes++}__`
    quoted.set(token, char === "'" ? `"'"` : `'${char}'`)
    return token
  }

  while (i < n) {
    const c = text[i] as string

    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '\n') {
      starts.push(i)
      tokens.push('\n')
      i++
      continue
    }

    // A `#` at the start of a word begins a comment, to the end of the
    // line. Inside a word (`a#b`) it is literal.
    if (c === '#') {
      while (i < n && text[i] !== '\n') i++
      continue
    }

    // FD-prefixed redirects (`2>`, `2>>`, `2>&1`) — must have NO
    // whitespace between the digit and the operator. Recognized at
    // word-start only so `echo 2 > file` keeps `2` as a regular arg.
    if (/[0-9]/.test(c) && text[i + 1] === '>') {
      // 2>&1
      if (text[i + 2] === '&' && i + 3 < n && /[0-9]/.test(text[i + 3] ?? '')) {
        starts.push(i)
        tokens.push(`${c}>&${text[i + 3]}`)
        i += 4
        continue
      }
      // 2>>
      if (text[i + 2] === '>') {
        starts.push(i)
        tokens.push(`${c}>>`)
        i += 3
        continue
      }
      // 2>
      starts.push(i)
      tokens.push(`${c}>`)
      i += 2
      continue
    }

    // Multi-char operators (greedy, before single-char check).
    if (i + 1 < n) {
      const two = `${c}${text[i + 1]}`
      if (two === '&&' || two === '||' || two === '<<' || two === '>>' || two === '>&') {
        starts.push(i)
        tokens.push(two)
        i += 2
        continue
      }
    }

    if (OPERATOR_CHARS.has(c)) {
      starts.push(i)
      tokens.push(c)
      i++
      continue
    }

    // Word: read until whitespace, newline, or operator.
    const wordStart = i
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
        // An escaped `$` or backslash keeps its backslash, so expansion
        // reads `\$NAME` as a literal `$NAME`, and `\\$NAME` as a
        // backslash before an expansion. Expansion drops the backslash.
        // An escaped character that means something bare (an operator,
        // a glob, a quote, a comment) is quoted.
        const next = text[i + 1] as string
        word +=
          next === '$' || next === '\\' ? `\\${next}` : MEANINGFUL.has(next) ? escaped(next) : next
        i += 2
        continue
      }
      word += ch
      i++
    }
    if (word.length > 0) {
      starts.push(wordStart)
      tokens.push(word)
    }
  }

  return { tokens, starts }
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
  at: (token: number) => number,
  found: Diagnostics,
): Script {
  const pipelines: Pipeline[] = []
  const operators: Operator[] = []

  let currentPipelineCmds: Command[] = []
  let pendingOp: Operator | null = null

  // In-flight command being built.
  let cmdName: string | null = null
  let cmdStart = 0
  let cmdArgs: string[] = []
  let cmdRedirects: Redirect[] = []

  // The control-flow blocks open, innermost last: a block's opener is
  // reported, and the words that continue and close it (`do`, `done`,
  // `then`, `fi`, `esac`) are part of that report.
  const blocks: Array<'loop' | 'if' | 'case'> = []

  const unmask = (token: string): string => unmaskQuotes(token, maskMap)

  /** Report `word` (masked, in command position, token `t`) if it's
   *  control flow, `function`, or an assignment. Elsewhere these are
   *  ordinary arguments (`echo for`, `grep -r done .`), and a quoted
   *  word never reaches here as itself: it is an opaque placeholder. */
  const checkCommandWord = (word: string, t: number): void => {
    const top = blocks[blocks.length - 1]
    const report = (message: string): void => found.add(at(t), `${word}: ${message}`)
    if (word === 'for' || word === 'while' || word === 'until') {
      report(LOOP_ADVICE)
      blocks.push('loop')
    } else if (word === 'do' || word === 'done') {
      if (top !== 'loop') report(LOOP_ADVICE)
      else if (word === 'done') blocks.pop()
    } else if (word === 'if') {
      report(CONDITIONAL_ADVICE)
      blocks.push('if')
    } else if (word === 'then' || word === 'elif' || word === 'else' || word === 'fi') {
      if (top !== 'if') report(CONDITIONAL_ADVICE)
      else if (word === 'fi') blocks.pop()
    } else if (word === 'case') {
      report('control flow is not supported')
      blocks.push('case')
    } else if (word === 'esac') {
      if (top !== 'case') report('control flow is not supported')
      else blocks.pop()
    } else if (word === 'function') {
      report(FUNCTION_ADVICE)
    } else if (ASSIGNMENT.test(unmask(word))) {
      found.add(at(t), `${unmask(word)}: ${ASSIGNMENT_ADVICE}`)
    }
  }

  const flushCommand = (): void => {
    if (cmdName !== null) {
      // `name() { ... }`: the parens follow the name as part of it
      // (`greet()`), or as the next words (`greet ()`, `greet ( )`).
      // `greet( )` tokenizes as `greet(` and `)`.
      const parens =
        cmdName.endsWith('()') ||
        (cmdName.endsWith('(') && cmdArgs[0] === ')') ||
        cmdArgs[0] === '()' ||
        (cmdArgs[0] === '(' && cmdArgs[1] === ')')
      if (parens) {
        const name = cmdName.replace(/\(\)?$/, '')
        found.add(cmdStart, `${name}(): ${FUNCTION_ADVICE}`)
      }
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
    const here = at(i)
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
        found.fail(here, "Unexpected pipe '|' before command")
      }
      if (i >= tokens.length) {
        found.fail(here, "Unexpected end of input after '|'")
      }
      const next = tokens[i] as string
      i++
      if (next === '|' || next === ';' || next === '\n' || next === '&&' || next === '||') {
        found.fail(at(i - 1), `Expected command after '|', got '${next}'`)
      }
      checkCommandWord(next, i - 1)
      cmdName = unmask(next)
      cmdStart = at(i - 1)
      continue
    }

    if (token === '<<') {
      if (i >= tokens.length) found.fail(here, "Expected delimiter after '<<'")
      const key = tokens[i] as string
      i++
      const heredoc = heredocs.get(key)
      if (heredoc === undefined) {
        found.fail(here, `Expected heredoc after '<<', got '${key}'`)
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
        found.fail(here, `Expected filename after '${token}'`)
      }
      const target = tokens[i] as string
      i++
      if (NON_TARGET_TOKENS.has(target)) {
        found.fail(here, `Expected filename after '${token}', got '${target}'`)
      }
      cmdRedirects.push({ type: token as RedirectType, target: unmask(target) })
      continue
    }

    // FD-prefixed redirects, emitted by the tokenizer when there's no
    // whitespace between the digit and `>` (`2>file`, `2>>file`).
    // fd 2 is stderr and fd 1 is stdout; termish has no other fds, so
    // their redirects are discarded, filename and all.
    if (/^[0-9]>>?$/.test(token)) {
      if (i >= tokens.length) {
        found.fail(here, `Expected filename after '${token}'`)
      }
      const target = tokens[i] as string
      i++
      if (NON_TARGET_TOKENS.has(target)) {
        found.fail(here, `Expected filename after '${token}', got '${target}'`)
      }
      const fd = token[0]
      const append = token.endsWith('>>')
      if (fd === '2') {
        cmdRedirects.push({ type: append ? '2>>' : '2>', target: unmask(target) })
      } else if (fd === '1') {
        cmdRedirects.push({ type: append ? '>>' : '>', target: unmask(target) })
      }
      continue
    }

    if (token === '>&') {
      // A bare fd merge (`>&1`) has nothing to merge: discarded.
      // fd-prefixed forms like `2>&1` come pre-glued from the
      // tokenizer (handled below).
      if (i >= tokens.length) {
        found.fail(here, "Expected fd after '>&'")
      }
      const targetFd = tokens[i] as string
      i++
      if (NON_TARGET_TOKENS.has(targetFd)) {
        found.fail(here, `Expected fd after '>&', got '${targetFd}'`)
      }
      continue
    }

    // Pre-glued fd merge from the tokenizer. `2>&1` merges stderr into
    // stdout; the rest (`1>&2`, `2>&2`) have no separate stream to
    // merge into, and are discarded.
    if (/^[0-9]>&[0-9]$/.test(token)) {
      if (token === '2>&1') cmdRedirects.push({ type: '2>&1', target: '1' })
      continue
    }

    // Regular word: command name (first) or arg.
    if (cmdName === null) {
      checkCommandWord(token, i - 1)
      cmdName = unmask(token)
      cmdStart = here
    } else {
      cmdArgs.push(unmask(token))
    }
  }

  // Final flush — the dummy ';' won't be appended (no next pipeline).
  flushPipeline(';')

  return { pipelines, operators }
}
