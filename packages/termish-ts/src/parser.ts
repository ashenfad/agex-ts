/**
 * Parse shell script text into the AST defined in `./ast`.
 *
 * Pipeline:
 *
 *   text
 *     → handleLineContinuation (strip backslash-newline joins)
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
const NON_TARGET_TOKENS = new Set(['|', ';', '<', '>', '>>', '>&', '\n', '&&', '||'])

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
  const joined = handleLineContinuation(text)
  const { masked, map } = maskQuotes(joined)
  const tokens = tokenize(masked)
  return parseTokens(tokens, map)
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
      if (two === '&&' || two === '||' || two === '>>' || two === '>&') {
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
          if (peek === '&&' || peek === '||' || peek === '>>' || peek === '>&') break
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
function parseTokens(tokens: readonly string[], maskMap: ReadonlyMap<string, string>): Script {
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
