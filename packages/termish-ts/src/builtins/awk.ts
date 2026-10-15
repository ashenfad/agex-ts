/**
 * `awk`: a bounded awk, read by a small lexer and parser and run by a
 * tree-walking interpreter. termish-py's `awk.py` is its twin, and the
 * two run the same cases (`tests/cases/awk.json`).
 *
 * What it runs: `awk [-F fs] [-v var=value]... ('program' | -f file)
 * [file | var=value]...`, reading stdin when no file is named. Patterns
 * (BEGIN, END, expressions, `/re/`, ranges `p1, p2`); statements
 * (`print`, `printf`, `if`/`else`, `while`, `do`, `for`, `for (k in a)`,
 * `break`, `continue`, `next`, `exit`, `delete`); `print > file` and
 * `>>`; fields, assignment to fields and `NF`; associative arrays; the
 * usual variables (NR NF FNR FS OFS ORS RS FILENAME SUBSEP RSTART
 * RLENGTH CONVFMT OFMT ENVIRON ARGV ARGC); and the builtins length,
 * substr, index, split, sub, gsub, match, sprintf, tolower, toupper,
 * int, sqrt, exp, log, sin, cos, atan2, close and fflush.
 *
 * Refused, with an error naming it: `getline`, `system()`, `rand()` and
 * `srand()`, user-defined functions, and pipes in `print`.
 *
 * Values follow awk: a number, a string, or a string from input (a
 * field, a `-v` value, a `split` element) that compares as a number
 * when it looks like one; an unset variable is both "" and 0. Numbers
 * print as integers when integral and through `%.6g` otherwise, rounded
 * as C rounds (exactly, half to even).
 *
 * Loops yield now and then, and stop when the context's signal aborts.
 */

import type { CommandContext, CommandHandler } from '../context'
import { TerminalError } from '../errors'
import { describeFsError } from '../fs/errors'

// ---------------------------------------------------------------------------
// Errors and control flow
// ---------------------------------------------------------------------------

/** A program that can't run: a syntax error, or something refused. */
class AwkSyntaxError extends Error {}

/** A fatal error while running (division by zero, an unreadable file). */
class AwkRuntimeError extends Error {}

class NextSignal {}
class ExitSignal {
  /** null: `exit` with no status, which keeps the one set before. */
  constructor(readonly code: number | null) {}
}
class BreakSignal {}
class ContinueSignal {}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind =
  | 'num'
  | 'str'
  | 'ere'
  | 'name'
  | 'funcname'
  | 'builtin'
  | 'kw'
  | 'op'
  | 'nl'
  | 'eof'

interface Token {
  readonly kind: TokenKind
  readonly value: string
  readonly num: number
  readonly pos: number
}

const KEYWORDS = new Set([
  'BEGIN',
  'END',
  'function',
  'func',
  'if',
  'else',
  'while',
  'for',
  'do',
  'break',
  'continue',
  'next',
  'nextfile',
  'exit',
  'return',
  'delete',
  'in',
  'getline',
  'print',
  'printf',
])

const BUILTINS = new Set([
  'length',
  'substr',
  'index',
  'split',
  'sub',
  'gsub',
  'match',
  'sprintf',
  'tolower',
  'toupper',
  'int',
  'sqrt',
  'exp',
  'log',
  'sin',
  'cos',
  'atan2',
  'close',
  'fflush',
  'system',
  'rand',
  'srand',
])

/** Builtins refused by name. */
const REFUSED_CALLS = new Set(['system', 'rand', 'srand'])

/** Operators, longest first so `**=` wins over `**` and `*`. */
const OPERATORS = [
  '**=',
  '&&',
  '||',
  '==',
  '<=',
  '>=',
  '!=',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '^=',
  '>>',
  '!~',
  '**',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ';',
  ',',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '!',
  '>',
  '<',
  '|',
  '?',
  ':',
  '~',
  '$',
  '=',
]

/** Tokens after which a `/` divides; after anything else it starts a regex. */
function divides(prev: Token | null): boolean {
  if (prev === null) return false
  if (['num', 'str', 'ere', 'name', 'builtin'].includes(prev.kind)) return true
  return prev.kind === 'op' && [')', ']', '$', '++', '--'].includes(prev.value)
}

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '\\': '\\',
  '"': '"',
  '/': '/',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
}

/**
 * Read awk's escapes in `text` (a string literal's inside, a `-v` value,
 * `-F`): `\n \t \r \\ \" \/ \a \b \f \v` and octal `\ooo`. Any other
 * escape keeps its backslash, so `"\."` reaches a regex as `\.`.
 */
function readEscapes(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch !== '\\' || i + 1 >= text.length) {
      out += ch
      i++
      continue
    }
    const next = text.charAt(i + 1)
    if (next in ESCAPES) {
      out += ESCAPES[next]
      i += 2
    } else if (next >= '0' && next <= '7') {
      let j = i + 1
      let code = 0
      while (j < text.length && j < i + 4 && text.charAt(j) >= '0' && text.charAt(j) <= '7') {
        code = code * 8 + Number(text.charAt(j))
        j++
      }
      out += String.fromCharCode(code)
      i = j
    } else {
      out += `\\${next}`
      i += 2
    }
  }
  return out
}

const NUMBER_RE = /^(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const push = (kind: TokenKind, value: string, pos: number, num = 0): void => {
    tokens.push({ kind, value, num, pos })
  }
  const last = (): Token | null => tokens[tokens.length - 1] ?? null
  while (i < src.length) {
    const ch = src.charAt(i)
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++
      continue
    }
    if (ch === '\\' && src.charAt(i + 1) === '\n') {
      i += 2
      continue
    }
    if (ch === '\\' && src.charAt(i + 1) === '\r' && src.charAt(i + 2) === '\n') {
      i += 3
      continue
    }
    if (ch === '#') {
      while (i < src.length && src.charAt(i) !== '\n') i++
      continue
    }
    if (ch === '\n') {
      if (last()?.kind !== 'nl') push('nl', '\n', i)
      i++
      continue
    }
    if (ch === '"') {
      const start = i
      i++
      let raw = ''
      while (i < src.length && src.charAt(i) !== '"') {
        if (src.charAt(i) === '\n') throw syntaxAt(src, start, 'unterminated string')
        if (src.charAt(i) === '\\' && i + 1 < src.length) {
          raw += src.slice(i, i + 2)
          i += 2
          continue
        }
        raw += src.charAt(i)
        i++
      }
      if (i >= src.length) throw syntaxAt(src, start, 'unterminated string')
      i++
      push('str', readEscapes(raw), start)
      continue
    }
    if (ch === '/' && !divides(last())) {
      const start = i
      i++
      let raw = ''
      let inBracket = false
      while (i < src.length) {
        const c = src.charAt(i)
        if (c === '\n') break
        if (c === '\\' && i + 1 < src.length) {
          // `\/` is a slash; every other escape is the regex's own
          raw += src.charAt(i + 1) === '/' ? '/' : src.slice(i, i + 2)
          i += 2
          continue
        }
        if (inBracket) {
          if (c === ']') inBracket = false
        } else if (c === '[') {
          inBracket = true
          raw += c
          i++
          // a `]` (after an optional `^`) first in a bracket is a member
          if (src.charAt(i) === '^') {
            raw += '^'
            i++
          }
          if (src.charAt(i) === ']') {
            raw += ']'
            i++
          }
          continue
        } else if (c === '/') {
          break
        }
        raw += c
        i++
      }
      if (src.charAt(i) !== '/') throw syntaxAt(src, start, 'unterminated regex')
      i++
      push('ere', raw, start)
      continue
    }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && /[0-9]/.test(src.charAt(i + 1)))) {
      const m = NUMBER_RE.exec(src.slice(i)) as RegExpExecArray
      push('num', m[0], i, Number(m[0]))
      i += m[0].length
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i
      while (i < src.length && /[A-Za-z0-9_]/.test(src.charAt(i))) i++
      const word = src.slice(start, i)
      if (KEYWORDS.has(word)) push('kw', word, start)
      else if (BUILTINS.has(word)) push('builtin', word, start)
      else if (src.charAt(i) === '(') push('funcname', word, start)
      else push('name', word, start)
      continue
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i))
    if (op === undefined) throw syntaxAt(src, i, `unexpected character '${ch}'`)
    push('op', op, i)
    i += op.length
  }
  push('eof', '', src.length)
  return tokens
}

function syntaxAt(src: string, pos: number, what: string): AwkSyntaxError {
  const before = src.slice(0, pos)
  const line = before.split('\n').length
  const column = pos - before.lastIndexOf('\n')
  return new AwkSyntaxError(`awk: syntax error at line ${line}, column ${column}: ${what}`)
}

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ere'; src: string }
  | { t: 'var'; name: string }
  | { t: 'idx'; name: string; subs: Expr[] }
  | { t: 'field'; e: Expr }
  | { t: 'assign'; op: string; target: Expr; e: Expr }
  | { t: 'cond'; c: Expr; a: Expr; b: Expr }
  | { t: 'and' | 'or'; a: Expr; b: Expr }
  | { t: 'in'; subs: Expr[]; name: string }
  | { t: 'match'; neg: boolean; a: Expr; re: Expr }
  | { t: 'cmp'; op: string; a: Expr; b: Expr }
  | { t: 'concat'; a: Expr; b: Expr }
  | { t: 'bin'; op: string; a: Expr; b: Expr }
  | { t: 'neg' | 'pos' | 'not'; e: Expr }
  | { t: 'incr'; op: '++' | '--'; prefix: boolean; target: Expr }
  | { t: 'call'; name: string; args: Expr[] }
  | { t: 'group'; e: Expr }

interface Dest {
  readonly mode: '>' | '>>'
  readonly e: Expr
}

type Stmt =
  | { t: 'block'; body: Stmt[] }
  | { t: 'expr'; e: Expr }
  | { t: 'print' | 'printf'; args: Expr[]; dest: Dest | null }
  | { t: 'if'; c: Expr; then: Stmt; else: Stmt | null }
  | { t: 'while'; c: Expr; body: Stmt }
  | { t: 'do'; body: Stmt; c: Expr }
  | { t: 'for'; init: Expr | null; c: Expr | null; step: Expr | null; body: Stmt }
  | { t: 'forin'; name: string; arr: string; body: Stmt }
  | { t: 'break' | 'continue' | 'next' }
  | { t: 'exit'; e: Expr | null }
  | { t: 'delete'; name: string; subs: Expr[] | null }

interface Item {
  readonly kind: 'begin' | 'end' | 'main'
  readonly pattern: Expr | null
  readonly until: Expr | null
  readonly action: Stmt | null
  inRange: boolean
}

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=', '**='])
const COMPARE_OPS = new Set(['<', '<=', '==', '!=', '>=', '>'])

function isLvalue(e: Expr): boolean {
  return e.t === 'var' || e.t === 'idx' || e.t === 'field'
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class Parser {
  readonly #src: string
  readonly #tokens: Token[]
  #i = 0
  /** Within `print`'s arguments, outside parentheses: `>` redirects. */
  #printArgs = false

  constructor(src: string) {
    this.#src = src
    this.#tokens = tokenize(src)
  }

  parse(): Item[] {
    const items: Item[] = []
    this.#skipTerminators()
    while (!this.#at('eof')) {
      items.push(this.#item())
      this.#skipTerminators()
    }
    return items
  }

  // -- token helpers --------------------------------------------------------

  #peek(offset = 0): Token {
    return this.#tokens[Math.min(this.#i + offset, this.#tokens.length - 1)] as Token
  }

  #next(): Token {
    const tok = this.#peek()
    if (this.#i < this.#tokens.length - 1) this.#i++
    return tok
  }

  #at(kind: TokenKind, value?: string): boolean {
    const tok = this.#peek()
    return tok.kind === kind && (value === undefined || tok.value === value)
  }

  #atOp(value: string): boolean {
    return this.#at('op', value)
  }

  #atKw(value: string): boolean {
    return this.#at('kw', value)
  }

  #expectOp(value: string): Token {
    if (!this.#atOp(value)) throw this.#unexpected(`expected '${value}'`)
    return this.#next()
  }

  #skipNewlines(): void {
    while (this.#at('nl')) this.#next()
  }

  #skipTerminators(): void {
    while (this.#at('nl') || this.#atOp(';')) this.#next()
  }

  #error(tok: Token, what: string): AwkSyntaxError {
    return syntaxAt(this.#src, tok.pos, what)
  }

  #unexpected(expected?: string): AwkSyntaxError {
    const tok = this.#peek()
    if (tok.kind === 'kw' && tok.value === 'getline') return refused('getline is not supported')
    if (tok.kind === 'op' && tok.value === '|') {
      return refused(
        this.#peek(1).kind === 'kw' && this.#peek(1).value === 'getline'
          ? 'getline is not supported'
          : 'pipes are not supported',
      )
    }
    const shown =
      tok.kind === 'eof' ? 'end of program' : tok.kind === 'nl' ? 'newline' : `'${tok.value}'`
    return this.#error(tok, `unexpected ${shown}${expected ? ` (${expected})` : ''}`)
  }

  // -- program --------------------------------------------------------------

  #item(): Item {
    const tok = this.#peek()
    if (tok.kind === 'kw' && (tok.value === 'BEGIN' || tok.value === 'END')) {
      this.#next()
      this.#skipNewlines()
      if (!this.#atOp('{')) throw this.#error(tok, `${tok.value} needs an action`)
      const action = this.#block()
      return {
        kind: tok.value === 'BEGIN' ? 'begin' : 'end',
        pattern: null,
        until: null,
        action,
        inRange: false,
      }
    }
    if (tok.kind === 'kw' && (tok.value === 'function' || tok.value === 'func')) {
      throw refused('user-defined functions are not supported')
    }
    if (this.#atOp('{')) {
      return { kind: 'main', pattern: null, until: null, action: this.#block(), inRange: false }
    }
    const pattern = this.#expr()
    let until: Expr | null = null
    if (this.#atOp(',')) {
      this.#next()
      this.#skipNewlines()
      until = this.#expr()
    }
    if (this.#atOp('{')) {
      return { kind: 'main', pattern, until, action: this.#block(), inRange: false }
    }
    if (!(this.#at('nl') || this.#atOp(';') || this.#at('eof'))) throw this.#unexpected()
    return { kind: 'main', pattern, until, action: null, inRange: false }
  }

  #block(): Stmt {
    this.#expectOp('{')
    const body: Stmt[] = []
    for (;;) {
      this.#skipTerminators()
      if (this.#atOp('}')) break
      if (this.#at('eof')) throw this.#unexpected("expected '}'")
      body.push(this.#statement())
      // a statement ends at a newline, `;` or `}`, or right after a block
      const prev = this.#tokens[this.#i - 1] as Token
      const closed = prev.kind === 'op' && prev.value === '}'
      if (!(closed || this.#at('nl') || this.#atOp(';') || this.#atOp('}'))) {
        throw this.#unexpected()
      }
    }
    this.#next()
    return { t: 'block', body }
  }

  /** The statement a loop or `if` runs: a lone `;` is an empty one. */
  #body(): Stmt {
    this.#skipNewlines()
    if (this.#atOp(';')) {
      this.#next()
      return { t: 'block', body: [] }
    }
    return this.#statement()
  }

  #statement(): Stmt {
    const tok = this.#peek()
    if (tok.kind === 'op' && tok.value === '{') return this.#block()
    if (tok.kind === 'op' && tok.value === ';') {
      this.#next()
      return { t: 'block', body: [] }
    }
    if (tok.kind === 'kw') {
      switch (tok.value) {
        case 'if': {
          this.#next()
          this.#expectOp('(')
          const c = this.#expr()
          this.#expectOp(')')
          const then = this.#body()
          // `else` may follow a newline or `;`
          let j = 0
          while (
            this.#peek(j).kind === 'nl' ||
            (this.#peek(j).kind === 'op' && this.#peek(j).value === ';')
          )
            j++
          if (this.#peek(j).kind === 'kw' && this.#peek(j).value === 'else') {
            this.#i += j + 1
            return { t: 'if', c, then, else: this.#body() }
          }
          return { t: 'if', c, then, else: null }
        }
        case 'while': {
          this.#next()
          this.#expectOp('(')
          const c = this.#expr()
          this.#expectOp(')')
          if (this.#atOp(';')) {
            this.#next()
            return { t: 'while', c, body: { t: 'block', body: [] } }
          }
          return { t: 'while', c, body: this.#body() }
        }
        case 'do': {
          this.#next()
          const body = this.#body()
          this.#skipTerminators()
          if (!this.#atKw('while')) throw this.#unexpected("expected 'while'")
          this.#next()
          this.#expectOp('(')
          const c = this.#expr()
          this.#expectOp(')')
          return { t: 'do', body, c }
        }
        case 'for':
          return this.#for()
        case 'break':
        case 'continue':
        case 'next':
          this.#next()
          return { t: tok.value }
        case 'nextfile':
          throw refused('nextfile is not supported')
        case 'return':
          throw refused('return is not supported: there are no user-defined functions')
        case 'getline':
          throw refused('getline is not supported')
        case 'exit': {
          this.#next()
          const ends = this.#at('nl') || this.#atOp(';') || this.#atOp('}') || this.#at('eof')
          return { t: 'exit', e: ends ? null : this.#expr() }
        }
        case 'delete': {
          this.#next()
          const name = this.#peek()
          if (name.kind !== 'name') throw this.#unexpected('expected an array name')
          this.#next()
          if (!this.#atOp('[')) return { t: 'delete', name: name.value, subs: null }
          return { t: 'delete', name: name.value, subs: this.#subscripts() }
        }
        case 'print':
        case 'printf':
          return this.#print(tok.value)
      }
    }
    return { t: 'expr', e: this.#expr() }
  }

  #for(): Stmt {
    this.#next()
    this.#expectOp('(')
    const [a, b, c, d] = [this.#peek(), this.#peek(1), this.#peek(2), this.#peek(3)]
    if (
      a.kind === 'name' &&
      b.kind === 'kw' &&
      b.value === 'in' &&
      c.kind === 'name' &&
      d.kind === 'op' &&
      d.value === ')'
    ) {
      this.#i += 4
      return { t: 'forin', name: a.value, arr: c.value, body: this.#body() }
    }
    const init = this.#atOp(';') ? null : this.#expr()
    this.#expectOp(';')
    this.#skipNewlines()
    const cond = this.#atOp(';') ? null : this.#expr()
    this.#expectOp(';')
    this.#skipNewlines()
    const step = this.#atOp(')') ? null : this.#expr()
    this.#expectOp(')')
    if (this.#atOp(';')) {
      this.#next()
      return { t: 'for', init, c: cond, step, body: { t: 'block', body: [] } }
    }
    return { t: 'for', init, c: cond, step, body: this.#body() }
  }

  #print(kind: 'print' | 'printf'): Stmt {
    this.#next()
    let args: Expr[] = []
    const ends = (): boolean =>
      this.#at('nl') ||
      this.#at('eof') ||
      this.#atOp(';') ||
      this.#atOp('}') ||
      this.#atOp('>') ||
      this.#atOp('>>') ||
      this.#atOp('|')
    if (!ends()) {
      // `print (a, b) > "f"`: a parenthesized list is the arguments
      let grouped = false
      if (this.#atOp('(')) {
        const save = this.#i
        this.#next()
        const list = this.#exprList()
        if (this.#atOp(')')) {
          this.#next()
          if (ends()) {
            args = list
            grouped = true
          }
        }
        if (!grouped) this.#i = save
      }
      if (!grouped) {
        const outer = this.#printArgs
        this.#printArgs = true
        try {
          args = this.#exprList()
        } finally {
          this.#printArgs = outer
        }
      }
    }
    if (kind === 'printf' && args.length === 0) throw this.#unexpected('printf needs a format')
    let dest: Dest | null = null
    if (this.#atOp('>') || this.#atOp('>>')) {
      const mode = this.#next().value as '>' | '>>'
      dest = { mode, e: this.#concat() }
    } else if (this.#atOp('|')) {
      throw refused('pipes in print are not supported')
    }
    return { t: kind, args, dest }
  }

  #exprList(): Expr[] {
    const list = [this.#expr()]
    while (this.#atOp(',')) {
      this.#next()
      this.#skipNewlines()
      list.push(this.#expr())
    }
    return list
  }

  #subscripts(): Expr[] {
    this.#expectOp('[')
    const outer = this.#printArgs
    this.#printArgs = false
    try {
      const subs = this.#exprList()
      this.#expectOp(']')
      return subs
    } finally {
      this.#printArgs = outer
    }
  }

  // -- expressions, lowest precedence first --------------------------------

  #expr(): Expr {
    const left = this.#ternary()
    if (this.#peek().kind === 'op' && ASSIGN_OPS.has(this.#peek().value)) {
      if (!isLvalue(left)) throw this.#unexpected('assignment to a non-variable')
      const op = this.#next().value
      this.#skipNewlines()
      return { t: 'assign', op, target: left, e: this.#expr() }
    }
    return left
  }

  #ternary(): Expr {
    const c = this.#or()
    if (!this.#atOp('?')) return c
    this.#next()
    this.#skipNewlines()
    const a = this.#expr()
    this.#skipNewlines()
    this.#expectOp(':')
    this.#skipNewlines()
    return { t: 'cond', c, a, b: this.#expr() }
  }

  #or(): Expr {
    let a = this.#and()
    while (this.#atOp('||')) {
      this.#next()
      this.#skipNewlines()
      a = { t: 'or', a, b: this.#and() }
    }
    return a
  }

  #and(): Expr {
    let a = this.#in()
    while (this.#atOp('&&')) {
      this.#next()
      this.#skipNewlines()
      a = { t: 'and', a, b: this.#in() }
    }
    return a
  }

  #in(): Expr {
    let a = this.#match()
    while (this.#atKw('in')) {
      this.#next()
      const name = this.#peek()
      if (name.kind !== 'name') throw this.#unexpected('expected an array name')
      this.#next()
      a = { t: 'in', subs: [a], name: name.value }
    }
    return a
  }

  #match(): Expr {
    let a = this.#compare()
    while (this.#atOp('~') || this.#atOp('!~')) {
      const neg = this.#next().value === '!~'
      a = { t: 'match', neg, a, re: this.#compare() }
    }
    return a
  }

  #compare(): Expr {
    const a = this.#concat()
    const tok = this.#peek()
    if (tok.kind !== 'op' || !COMPARE_OPS.has(tok.value)) return a
    if (tok.value === '>' && this.#printArgs) return a
    this.#next()
    return { t: 'cmp', op: tok.value, a, b: this.#concat() }
  }

  /** Whether the next token starts an operand of concatenation. */
  #startsConcat(): boolean {
    const tok = this.#peek()
    if (['num', 'str', 'ere', 'name', 'funcname', 'builtin'].includes(tok.kind)) return true
    if (tok.kind === 'kw') return tok.value === 'getline'
    return tok.kind === 'op' && (tok.value === '$' || tok.value === '(')
  }

  #concat(): Expr {
    let a = this.#additive()
    while (this.#startsConcat()) {
      a = { t: 'concat', a, b: this.#additive() }
    }
    return a
  }

  #additive(): Expr {
    let a = this.#multiplicative()
    while (this.#atOp('+') || this.#atOp('-')) {
      const op = this.#next().value
      a = { t: 'bin', op, a, b: this.#multiplicative() }
    }
    return a
  }

  #multiplicative(): Expr {
    let a = this.#unary()
    while (this.#atOp('*') || this.#atOp('/') || this.#atOp('%')) {
      const op = this.#next().value
      a = { t: 'bin', op, a, b: this.#unary() }
    }
    return a
  }

  #unary(): Expr {
    if (this.#atOp('!')) {
      this.#next()
      return { t: 'not', e: this.#unary() }
    }
    if (this.#atOp('-')) {
      this.#next()
      return { t: 'neg', e: this.#unary() }
    }
    if (this.#atOp('+')) {
      this.#next()
      return { t: 'pos', e: this.#unary() }
    }
    return this.#power()
  }

  #power(): Expr {
    const a = this.#incr()
    if (this.#atOp('^') || this.#atOp('**')) {
      this.#next()
      // right-associative, and `2^-1` takes its sign
      return { t: 'bin', op: '^', a, b: this.#unary() }
    }
    return a
  }

  #incr(): Expr {
    if (this.#atOp('++') || this.#atOp('--')) {
      const op = this.#next().value as '++' | '--'
      const target = this.#incr()
      if (!isLvalue(target)) throw this.#unexpected(`${op} needs a variable`)
      return { t: 'incr', op, prefix: true, target }
    }
    const e = this.#field()
    if (isLvalue(e) && (this.#atOp('++') || this.#atOp('--'))) {
      const op = this.#next().value as '++' | '--'
      return { t: 'incr', op, prefix: false, target: e }
    }
    return e
  }

  #field(): Expr {
    if (!this.#atOp('$')) return this.#primary()
    this.#next()
    if (this.#atOp('++') || this.#atOp('--')) {
      const op = this.#next().value as '++' | '--'
      const target = this.#field()
      if (!isLvalue(target)) throw this.#unexpected(`${op} needs a variable`)
      return { t: 'field', e: { t: 'incr', op, prefix: true, target } }
    }
    if (this.#atOp('-')) {
      this.#next()
      return { t: 'field', e: { t: 'neg', e: this.#field() } }
    }
    return { t: 'field', e: this.#field() }
  }

  #primary(): Expr {
    const tok = this.#peek()
    switch (tok.kind) {
      case 'num':
        this.#next()
        return { t: 'num', v: tok.num }
      case 'str':
        this.#next()
        return { t: 'str', v: tok.value }
      case 'ere':
        this.#next()
        return { t: 'ere', src: tok.value }
      case 'name':
        this.#next()
        if (this.#atOp('[')) return { t: 'idx', name: tok.value, subs: this.#subscripts() }
        return { t: 'var', name: tok.value }
      case 'funcname':
        throw refused(
          `calling undefined function ${tok.value}: user-defined functions are not supported`,
        )
      case 'builtin':
        return this.#call()
      case 'op':
        if (tok.value === '(') {
          this.#next()
          const outer = this.#printArgs
          this.#printArgs = false
          try {
            const list = this.#exprList()
            this.#expectOp(')')
            if (list.length > 1) {
              if (!this.#atKw('in'))
                throw this.#unexpected("expected 'in' after a parenthesized list")
              this.#next()
              const name = this.#peek()
              if (name.kind !== 'name') throw this.#unexpected('expected an array name')
              this.#next()
              return { t: 'in', subs: list, name: name.value }
            }
            return { t: 'group', e: list[0] as Expr }
          } finally {
            this.#printArgs = outer
          }
        }
        if (tok.value === '-' || tok.value === '+' || tok.value === '!') return this.#unary()
        break
    }
    throw this.#unexpected()
  }

  #call(): Expr {
    const tok = this.#next()
    const name = tok.value
    if (REFUSED_CALLS.has(name)) throw refused(`${name}() is not supported`)
    if (!this.#atOp('(')) {
      if (name === 'length') return { t: 'call', name, args: [] }
      throw this.#unexpected(`expected '(' after ${name}`)
    }
    this.#next()
    const outer = this.#printArgs
    this.#printArgs = false
    let args: Expr[] = []
    try {
      this.#skipNewlines()
      if (!this.#atOp(')')) args = this.#exprList()
      this.#skipNewlines()
      this.#expectOp(')')
    } finally {
      this.#printArgs = outer
    }
    const arity: Record<string, [number, number]> = {
      length: [0, 1],
      substr: [2, 3],
      index: [2, 2],
      split: [2, 3],
      sub: [2, 3],
      gsub: [2, 3],
      match: [2, 2],
      sprintf: [1, Number.POSITIVE_INFINITY],
      tolower: [1, 1],
      toupper: [1, 1],
      int: [1, 1],
      sqrt: [1, 1],
      exp: [1, 1],
      log: [1, 1],
      sin: [1, 1],
      cos: [1, 1],
      atan2: [2, 2],
      close: [1, 1],
      fflush: [0, 1],
    }
    const [min, max] = arity[name] as [number, number]
    if (args.length < min || args.length > max) {
      throw this.#error(tok, `${name}() takes ${min === max ? min : `${min} to ${max}`} arguments`)
    }
    if (name === 'split' && (args[1] as Expr).t !== 'var') {
      throw this.#error(tok, "split()'s second argument must be an array name")
    }
    if ((name === 'sub' || name === 'gsub') && args.length === 3 && !isLvalue(args[2] as Expr)) {
      throw this.#error(tok, `${name}()'s third argument must be a variable or field`)
    }
    return { t: 'call', name, args }
  }
}

function refused(what: string): AwkSyntaxError {
  return new AwkSyntaxError(`awk: ${what}`)
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** A string from input (a field, a `-v` value, a `split` element): it
 *  compares as a number when it looks like one. */
class StrNum {
  constructor(readonly s: string) {}
}

/** An unset variable or element: both "" and 0. */
const UNINIT = Object.freeze({ uninit: true as const })

type Val = number | string | StrNum | typeof UNINIT
type AwkArray = Map<string, Val>

const LEADING_NUMBER = /^[ \t\n\r\f\v]*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/
const WHOLE_NUMBER =
  /^[ \t\n\r\f\v]*[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[ \t\n\r\f\v]*$/

/** The number a string starts with, as `strtod` reads it; 0 for none. */
function strToNum(s: string): number {
  const m = LEADING_NUMBER.exec(s)
  return m === null ? 0 : Number(m[0])
}

function looksNumeric(v: Val): boolean {
  if (typeof v === 'number' || v === UNINIT) return true
  return v instanceof StrNum && WHOLE_NUMBER.test(v.s)
}

function toNum(v: Val): number {
  if (typeof v === 'number') return v
  if (v === UNINIT) return 0
  return strToNum(typeof v === 'string' ? v : (v as StrNum).s)
}

/** A number as text: an integral one as an integer, any other through `fmt`. */
function numToStr(n: number, fmt: string): string {
  if (Number.isInteger(n)) return BigInt(n).toString()
  return formatPrintf(fmt, [n])
}

function isTrue(v: Val): boolean {
  if (typeof v === 'number') return v !== 0
  if (v === UNINIT) return false
  if (typeof v === 'string') return v !== ''
  const s = (v as StrNum).s
  return WHOLE_NUMBER.test(s) ? strToNum(s) !== 0 : s !== ''
}

// ---------------------------------------------------------------------------
// Number formatting, as C's printf formats (exact, half to even)
// ---------------------------------------------------------------------------

/** `|x|` as `m * 2^e`, exactly. */
function decompose(x: number): [bigint, number] {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, Math.abs(x))
  const hi = view.getUint32(0)
  const lo = view.getUint32(4)
  const expBits = (hi >>> 20) & 0x7ff
  const mantissa = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  if (expBits === 0) return [mantissa, -1074]
  return [mantissa | (1n << 52n), expBits - 1075]
}

/** `m * 2^e * 10^k`, rounded half to even to an integer. */
function roundScaled(m: bigint, e: number, k: number): bigint {
  let num = m
  let den = 1n
  if (e >= 0) num <<= BigInt(e)
  else den <<= BigInt(-e)
  if (k >= 0) num *= 10n ** BigInt(k)
  else den *= 10n ** BigInt(-k)
  let q = num / den
  const twice = 2n * (num % den)
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n
  return q
}

/** `|x|` with `p` digits after the point. */
function fixedDigits(x: number, p: number): string {
  const ax = Math.abs(x)
  let digits: string
  if (ax === 0) digits = '0'.repeat(p + 1)
  else {
    const [m, e] = decompose(ax)
    digits = roundScaled(m, e, p)
      .toString()
      .padStart(p + 1, '0')
  }
  if (p === 0) return digits
  return `${digits.slice(0, digits.length - p)}.${digits.slice(digits.length - p)}`
}

/** `|x|` as `p + 1` significant digits and the power of ten of the first. */
function expDigits(x: number, p: number): [string, number] {
  const ax = Math.abs(x)
  if (ax === 0) return ['0'.repeat(p + 1), 0]
  const [m, e] = decompose(ax)
  let exp = Math.floor(Math.log10(ax))
  const low = 10n ** BigInt(p)
  const high = 10n ** BigInt(p + 1)
  let q = roundScaled(m, e, p - exp)
  while (q >= high) {
    exp++
    q = roundScaled(m, e, p - exp)
  }
  while (q < low) {
    exp--
    q = roundScaled(m, e, p - exp)
  }
  return [q.toString(), exp]
}

function expForm(digits: string, exp: number, p: number, alt: boolean, upper: boolean): string {
  const mant = p > 0 || alt ? `${digits.charAt(0)}.${digits.slice(1)}` : digits
  const sign = exp < 0 ? '-' : '+'
  const tail = `${upper ? 'E' : 'e'}${sign}${String(Math.abs(exp)).padStart(2, '0')}`
  return mant + tail
}

function stripZeros(s: string): string {
  if (!s.includes('.')) return s
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

/** A float conversion's body (no sign): `e E f F g G`. */
function floatBody(x: number, conv: string, prec: number | null, alt: boolean): string {
  const upper = conv === 'E' || conv === 'F' || conv === 'G'
  if (!Number.isFinite(x)) {
    const word = Number.isNaN(x) ? 'nan' : 'inf'
    return upper ? word.toUpperCase() : word
  }
  const lower = conv.toLowerCase()
  if (lower === 'f') {
    const p = prec ?? 6
    const body = fixedDigits(x, p)
    return alt && p === 0 ? `${body}.` : body
  }
  if (lower === 'e') {
    const p = prec ?? 6
    const [digits, exp] = expDigits(x, p)
    return expForm(digits, exp, p, alt, upper)
  }
  // g: %e's exponent picks the style; trailing zeros go unless `#`
  const P = prec === null ? 6 : prec === 0 ? 1 : prec
  const [digits, exp] = expDigits(x, P - 1)
  let body: string
  if (exp < -4 || exp >= P) body = expForm(digits, exp, P - 1, alt, upper)
  else {
    body = fixedDigits(x, P - 1 - exp)
    if (alt && !body.includes('.')) body += '.'
  }
  if (alt) return body
  if (exp < -4 || exp >= P) {
    const at = body.search(/[eE]/)
    return stripZeros(body.slice(0, at)) + body.slice(at)
  }
  return stripZeros(body)
}

const TWO_64 = 1n << 64n

/** An integer conversion's body (no sign): `d i u o x X`. A negative
 *  number under `o u x X` is read as unsigned, 64 bits, as C reads it. */
function intBody(n: number, conv: string, prec: number | null, alt: boolean): string {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 'nan' : 'inf'
  const whole = BigInt(Math.trunc(n))
  const signed = conv === 'd' || conv === 'i'
  const mag = signed ? (whole < 0n ? -whole : whole) : ((whole % TWO_64) + TWO_64) % TWO_64
  let digits =
    conv === 'o'
      ? mag.toString(8)
      : conv === 'x'
        ? mag.toString(16)
        : conv === 'X'
          ? mag.toString(16).toUpperCase()
          : mag.toString()
  if (prec !== null) digits = prec === 0 && mag === 0n ? '' : digits.padStart(prec, '0')
  if (alt && conv === 'o' && !digits.startsWith('0')) digits = `0${digits}`
  return digits
}

/** `printf`'s and `sprintf`'s formatting of `args` by `fmt`. */
function formatPrintf(fmt: string, args: readonly Val[], convfmt = '%.6g'): string {
  let out = ''
  let argi = 0
  const nextArg = (): Val => {
    if (argi >= args.length) {
      throw new AwkRuntimeError(`awk: not enough arguments for the format ${JSON.stringify(fmt)}`)
    }
    return args[argi++] as Val
  }
  let i = 0
  while (i < fmt.length) {
    const ch = fmt.charAt(i)
    if (ch !== '%') {
      out += ch
      i++
      continue
    }
    const start = i
    i++
    if (fmt.charAt(i) === '%') {
      out += '%'
      i++
      continue
    }
    let flags = ''
    while ('-+ #0'.includes(fmt.charAt(i)) && i < fmt.length) flags += fmt.charAt(i++)
    let width: number | null = null
    if (fmt.charAt(i) === '*') {
      i++
      width = Math.trunc(toNum(nextArg()))
      if (width < 0) {
        flags += '-'
        width = -width
      }
    } else {
      let w = ''
      while (/[0-9]/.test(fmt.charAt(i))) w += fmt.charAt(i++)
      if (w !== '') width = Number(w)
    }
    let prec: number | null = null
    if (fmt.charAt(i) === '.') {
      i++
      if (fmt.charAt(i) === '*') {
        i++
        const p = Math.trunc(toNum(nextArg()))
        prec = p < 0 ? null : p
      } else {
        let p = ''
        while (/[0-9]/.test(fmt.charAt(i))) p += fmt.charAt(i++)
        prec = p === '' ? 0 : Number(p)
      }
    }
    const conv = fmt.charAt(i)
    if (conv === '' || !'diouxXeEfFgGcs'.includes(conv)) {
      // not a conversion: kept as written
      out += fmt.slice(start, i)
      continue
    }
    i++
    const left = flags.includes('-')
    // widths count characters, not UTF-16 units
    const pad = (body: string, sign: string, zero: boolean): string => {
      const room = width === null ? 0 : width - [...sign].length - [...body].length
      if (room <= 0) return sign + body
      if (left) return sign + body + ' '.repeat(room)
      if (zero) return sign + '0'.repeat(room) + body
      return ' '.repeat(room) + sign + body
    }
    // `0` pads strings and characters with zeros too, as C's printf does
    const zeroText = flags.includes('0') && !left
    if (conv === 's') {
      let s = valToStr(nextArg(), convfmt)
      if (prec !== null) s = [...s].slice(0, prec).join('')
      out += pad(s, '', zeroText)
      continue
    }
    if (conv === 'c') {
      const v = nextArg()
      let s: string
      if (typeof v === 'number' || (v instanceof StrNum && looksNumeric(v))) {
        const code = Math.trunc(toNum(v))
        const ok = code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        s = ok ? String.fromCodePoint(code) : ''
      } else s = [...valToStr(v, convfmt)][0] ?? ''
      out += pad(s, '', zeroText)
      continue
    }
    const n = toNum(nextArg())
    const plus = flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : ''
    const alt = flags.includes('#')
    if ('diouxX'.includes(conv)) {
      const signed = conv === 'd' || conv === 'i'
      const negative = signed ? Math.trunc(n) < 0 : n === Number.NEGATIVE_INFINITY
      const intSign = negative ? '-' : signed && !Number.isNaN(n) ? plus : ''
      let body = intBody(n, conv, prec, alt)
      let prefix = ''
      if (
        alt &&
        (conv === 'x' || conv === 'X') &&
        Math.trunc(Math.abs(n)) !== 0 &&
        Number.isFinite(n)
      ) {
        prefix = conv === 'x' ? '0x' : '0X'
      }
      const zero = flags.includes('0') && !left && prec === null && Number.isFinite(n)
      if (zero && width !== null) body = body.padStart(width - intSign.length - prefix.length, '0')
      out += pad(prefix + body, intSign, false)
      continue
    }
    const body = floatBody(n, conv, prec, alt)
    const sign = n < 0 || Object.is(n, -0) ? '-' : plus
    out += pad(body, sign, flags.includes('0') && !left && Number.isFinite(n))
  }
  return out
}

function valToStr(v: Val, convfmt: string): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return numToStr(v, convfmt)
  if (v === UNINIT) return ''
  return (v as StrNum).s
}

// ---------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  cntrl: '\\x00-\\x1f\\x7f',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
}

/** An awk ERE as a JavaScript regex source: POSIX classes such as
 *  `[[:digit:]]` read as their ranges; the rest is already in the
 *  syntax `RegExp` speaks. */
function ereToJs(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const ch = src.charAt(i)
    if (ch === '\\' && i + 1 < src.length) {
      out += src.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch !== '[') {
      out += ch
      i++
      continue
    }
    out += '['
    i++
    if (src.charAt(i) === '^') {
      out += '^'
      i++
    }
    if (src.charAt(i) === ']') {
      out += '\\]'
      i++
    }
    while (i < src.length && src.charAt(i) !== ']') {
      const c = src.charAt(i)
      if (c === '[' && src.charAt(i + 1) === ':') {
        const end = src.indexOf(':]', i + 2)
        const name = end === -1 ? '' : src.slice(i + 2, end)
        if (name in POSIX_CLASSES) {
          out += POSIX_CLASSES[name]
          i = end + 2
          continue
        }
      }
      if (c === '\\' && i + 1 < src.length) {
        out += src.slice(i, i + 2)
        i += 2
        continue
      }
      out += c === '[' ? '\\[' : c
      i++
    }
    if (i < src.length) {
      out += ']'
      i++
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

interface Output {
  base: 'truncate' | 'append'
  text: string
  open: boolean
}

/** How many loop turns or records between yields to the event loop. */
const YIELD_EVERY = 1024

class Interp {
  readonly #ctx: CommandContext
  readonly #vars = new Map<string, Val | AwkArray>()
  readonly #regexes = new Map<string, RegExp>()
  #record = ''
  #fields: string[] = []
  #out = ''
  #err = ''
  readonly #files = new Map<string, Output>()
  #ticks = 0
  #inEnd = false
  #inBegin = false

  constructor(ctx: CommandContext) {
    this.#ctx = ctx
    const env: AwkArray = new Map()
    for (const [k, v] of Object.entries(ctx.env)) env.set(k, new StrNum(v))
    const defaults: Record<string, Val> = {
      FS: ' ',
      OFS: ' ',
      ORS: '\n',
      RS: '\n',
      NR: 0,
      FNR: 0,
      FILENAME: '',
      SUBSEP: '\x1c',
      RSTART: 0,
      RLENGTH: -1,
      CONVFMT: '%.6g',
      OFMT: '%.6g',
    }
    for (const [k, v] of Object.entries(defaults)) this.#vars.set(k, v)
    this.#vars.set('ENVIRON', env)
  }

  // -- variables ------------------------------------------------------------

  #scalar(name: string): Val {
    if (name === 'NF') return this.#fields.length
    const v = this.#vars.get(name)
    if (v === undefined) return UNINIT
    if (v instanceof Map)
      throw new AwkRuntimeError(`awk: can't use array ${name} in a scalar context`)
    return v
  }

  setScalar(name: string, v: Val): void {
    if (name === 'NF') {
      this.#setNF(Math.trunc(toNum(v)))
      return
    }
    if (this.#vars.get(name) instanceof Map) {
      throw new AwkRuntimeError(`awk: can't assign to ${name}: it's an array`)
    }
    this.#vars.set(name, v)
  }

  array(name: string): AwkArray {
    const v = this.#vars.get(name)
    if (v instanceof Map) return v
    if (v !== undefined && v !== UNINIT) {
      throw new AwkRuntimeError(`awk: can't use scalar ${name} as an array`)
    }
    const arr: AwkArray = new Map()
    this.#vars.set(name, arr)
    return arr
  }

  #str(v: Val): string {
    return valToStr(v, this.#convfmt())
  }

  #convfmt(): string {
    return this.#str2(this.#scalar('CONVFMT'))
  }

  /** A special variable's text, without recursing through CONVFMT. */
  #str2(v: Val): string {
    return valToStr(v, '%.6g')
  }

  #outStr(v: Val): string {
    if (typeof v === 'number') return numToStr(v, this.#str2(this.#scalar('OFMT')))
    return this.#str(v)
  }

  #key(subs: readonly Expr[]): string {
    if (subs.length === 1) return this.#str(this.eval(subs[0] as Expr))
    const sep = this.#str2(this.#scalar('SUBSEP'))
    return subs.map((s) => this.#str(this.eval(s))).join(sep)
  }

  // -- records and fields ---------------------------------------------------

  setRecord(text: string): void {
    this.#record = text
    this.#fields = this.split(text, this.#scalar('FS'))
  }

  #setNF(n: number): void {
    if (n < 0) throw new AwkRuntimeError('awk: NF set to a negative value')
    if (n < this.#fields.length) this.#fields = this.#fields.slice(0, n)
    while (this.#fields.length < n) this.#fields.push('')
    this.#rebuild()
  }

  #rebuild(): void {
    this.#record = this.#fields.join(this.#str2(this.#scalar('OFS')))
  }

  #getField(i: number): Val {
    if (i < 0) throw new AwkRuntimeError(`awk: trying to access out of range field ${i}`)
    if (i === 0) return new StrNum(this.#record)
    const f = this.#fields[i - 1]
    return f === undefined ? UNINIT : new StrNum(f)
  }

  #setField(i: number, v: Val): void {
    if (i < 0) throw new AwkRuntimeError(`awk: trying to access out of range field ${i}`)
    const text = this.#str(v)
    if (i === 0) {
      this.setRecord(text)
      return
    }
    while (this.#fields.length < i) this.#fields.push('')
    this.#fields[i - 1] = text
    this.#rebuild()
  }

  /** `s` split as fields are: on runs of blanks for " ", on a single
   *  character literally, into characters for "", on a regex otherwise. */
  split(s: string, sep: Val | RegExp): string[] {
    if (s === '') return []
    if (sep instanceof RegExp) return this.#splitRegex(s, sep)
    const fs = this.#str(sep)
    if (fs === ' ')
      return s
        .split(/[ \t\n]+/)
        .filter((f, i, all) => !(f === '' && (i === 0 || i === all.length - 1)))
    if (fs === '') return [...s]
    if (fs.length === 1 && fs !== '\\') return s.split(fs)
    return this.#splitRegex(s, this.#regex(fs))
  }

  #splitRegex(s: string, re: RegExp): string[] {
    const g = new RegExp(re.source, 'g')
    const out: string[] = []
    let pos = 0
    let from = 0
    while (from <= s.length) {
      g.lastIndex = from
      const m = g.exec(s)
      if (m === null) break
      if (m[0].length === 0) {
        from = m.index + 1
        continue
      }
      out.push(s.slice(pos, m.index))
      pos = m.index + m[0].length
      from = pos
    }
    out.push(s.slice(pos))
    return out
  }

  // -- regexes --------------------------------------------------------------

  #regex(src: string): RegExp {
    let re = this.#regexes.get(src)
    if (re === undefined) {
      try {
        re = new RegExp(ereToJs(src))
      } catch {
        throw new AwkRuntimeError(`awk: invalid regex: /${src}/`)
      }
      this.#regexes.set(src, re)
    }
    return re
  }

  /** A regex argument: a `/re/` literal as itself, anything else as the text of one. */
  #regexOf(e: Expr): RegExp {
    if (e.t === 'ere') return this.#regex(e.src)
    return this.#regex(this.#str(this.eval(e)))
  }

  // -- lvalues --------------------------------------------------------------

  #get(target: Expr): Val {
    return this.eval(target)
  }

  #set(target: Expr, v: Val): void {
    if (target.t === 'var') this.setScalar(target.name, v)
    else if (target.t === 'idx') this.array(target.name).set(this.#key(target.subs), v)
    else if (target.t === 'field') this.#setField(Math.trunc(toNum(this.eval(target.e))), v)
  }

  // -- expressions ----------------------------------------------------------

  eval(e: Expr): Val {
    switch (e.t) {
      case 'num':
        return e.v
      case 'str':
        return e.v
      case 'ere':
        return this.#regex(e.src).test(this.#record) ? 1 : 0
      case 'group':
        return this.eval(e.e)
      case 'var':
        return this.#scalar(e.name)
      case 'idx': {
        const arr = this.array(e.name)
        const key = this.#key(e.subs)
        const v = arr.get(key)
        if (v !== undefined) return v
        arr.set(key, UNINIT)
        return UNINIT
      }
      case 'field':
        return this.#getField(Math.trunc(toNum(this.eval(e.e))))
      case 'assign': {
        if (e.op === '=') {
          const v = this.eval(e.e)
          this.#set(e.target, v)
          return v
        }
        const rhs = toNum(this.eval(e.e))
        const n = arith(e.op.slice(0, -1), toNum(this.#get(e.target)), rhs)
        this.#set(e.target, n)
        return n
      }
      case 'cond':
        return isTrue(this.eval(e.c)) ? this.eval(e.a) : this.eval(e.b)
      case 'and':
        return isTrue(this.eval(e.a)) && isTrue(this.eval(e.b)) ? 1 : 0
      case 'or':
        return isTrue(this.eval(e.a)) || isTrue(this.eval(e.b)) ? 1 : 0
      case 'in': {
        const key = this.#key(e.subs)
        return this.array(e.name).has(key) ? 1 : 0
      }
      case 'match': {
        const s = this.#str(this.eval(e.a))
        const hit = this.#regexOf(e.re).test(s)
        return hit !== e.neg ? 1 : 0
      }
      case 'cmp':
        return this.#compare(e.op, this.eval(e.a), this.eval(e.b)) ? 1 : 0
      case 'concat':
        return this.#str(this.eval(e.a)) + this.#str(this.eval(e.b))
      case 'bin':
        return arith(e.op, toNum(this.eval(e.a)), toNum(this.eval(e.b)))
      case 'neg':
        return -toNum(this.eval(e.e))
      case 'pos':
        return toNum(this.eval(e.e))
      case 'not':
        return isTrue(this.eval(e.e)) ? 0 : 1
      case 'incr': {
        const old = toNum(this.#get(e.target))
        const now = e.op === '++' ? old + 1 : old - 1
        this.#set(e.target, now)
        return e.prefix ? now : old
      }
      case 'call':
        return this.#call(e.name, e.args)
    }
  }

  #compare(op: string, a: Val, b: Val): boolean {
    let c: number
    if (looksNumeric(a) && looksNumeric(b)) {
      const x = toNum(a)
      const y = toNum(b)
      c = x < y ? -1 : x > y ? 1 : x === y ? 0 : Number.NaN
    } else {
      const x = this.#str(a)
      const y = this.#str(b)
      c = x < y ? -1 : x > y ? 1 : 0
    }
    switch (op) {
      case '<':
        return c < 0
      case '<=':
        return c <= 0
      case '==':
        return c === 0
      case '!=':
        return c !== 0
      case '>=':
        return c >= 0
      default:
        return c > 0
    }
  }

  #call(name: string, args: readonly Expr[]): Val {
    const arg = (i: number): Val => this.eval(args[i] as Expr)
    const num = (i: number): number => toNum(arg(i))
    switch (name) {
      case 'length': {
        if (args.length === 0) return this.#record.length
        const a = args[0] as Expr
        if (a.t === 'var' && this.#vars.get(a.name) instanceof Map)
          return (this.#vars.get(a.name) as AwkArray).size
        return this.#str(arg(0)).length
      }
      case 'substr': {
        const s = this.#str(arg(0))
        const m = Math.trunc(num(1))
        const start = Math.max(m, 1)
        let end = s.length + 1
        if (args.length === 3) end = Math.min(end, m + Math.trunc(num(2)))
        return end <= start ? '' : s.slice(start - 1, end - 1)
      }
      case 'index': {
        const s = this.#str(arg(0))
        return s.indexOf(this.#str(arg(1))) + 1
      }
      case 'split': {
        const s = this.#str(arg(0))
        const target = this.array((args[1] as Expr & { name: string }).name)
        let sep: Val | RegExp = this.#scalar('FS')
        if (args.length === 3) {
          const a = args[2] as Expr
          sep = a.t === 'ere' ? this.#regex(a.src) : this.eval(a)
        }
        const parts = this.split(s, sep)
        target.clear()
        parts.forEach((p, i) => target.set(String(i + 1), new StrNum(p)))
        return parts.length
      }
      case 'sub':
      case 'gsub': {
        const re = this.#regexOf(args[0] as Expr)
        const repl = this.#str(arg(1))
        const target: Expr =
          args.length === 3 ? (args[2] as Expr) : { t: 'field', e: { t: 'num', v: 0 } }
        const [text, count] = substitute(re, repl, this.#str(this.#get(target)), name === 'gsub')
        if (count > 0) this.#set(target, text)
        return count
      }
      case 'match': {
        const s = this.#str(arg(0))
        const m = this.#regexOf(args[1] as Expr).exec(s)
        const start = m === null ? 0 : m.index + 1
        this.#vars.set('RSTART', start)
        this.#vars.set('RLENGTH', m === null ? -1 : m[0].length)
        return start
      }
      case 'sprintf':
        return formatPrintf(
          this.#str(arg(0)),
          args.slice(1).map((a) => this.eval(a)),
          this.#convfmt(),
        )
      case 'tolower':
        return this.#str(arg(0)).toLowerCase()
      case 'toupper':
        return this.#str(arg(0)).toUpperCase()
      case 'int':
        return Math.trunc(num(0))
      case 'sqrt':
        return Math.sqrt(num(0))
      case 'exp':
        return Math.exp(num(0))
      case 'log':
        return Math.log(num(0))
      case 'sin':
        return Math.sin(num(0))
      case 'cos':
        return Math.cos(num(0))
      case 'atan2':
        return Math.atan2(num(0), num(1))
      case 'close': {
        const out = this.#files.get(this.#str(arg(0)))
        if (out === undefined || !out.open) return -1
        out.open = false
        return 0
      }
      case 'fflush':
        return 0
    }
    throw new AwkRuntimeError(`awk: ${name}() is not supported`)
  }

  // -- statements -----------------------------------------------------------

  /** One more loop turn or record: yield now and then, and stop when aborted. */
  async tick(): Promise<void> {
    this.#ticks++
    if (this.#ticks % YIELD_EVERY === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    if (this.#ctx.signal.aborted) throw new TerminalError('awk: aborted')
  }

  async exec(s: Stmt): Promise<void> {
    switch (s.t) {
      case 'block':
        for (const b of s.body) await this.exec(b)
        return
      case 'expr':
        this.eval(s.e)
        return
      case 'print': {
        const text =
          s.args.length === 0
            ? this.#record
            : s.args.map((a) => this.#outStr(this.eval(a))).join(this.#str2(this.#scalar('OFS')))
        this.#emit(s.dest, text + this.#str2(this.#scalar('ORS')))
        return
      }
      case 'printf': {
        const [fmt, ...rest] = s.args.map((a) => this.eval(a))
        this.#emit(s.dest, formatPrintf(this.#str(fmt as Val), rest, this.#convfmt()))
        return
      }
      case 'if':
        if (isTrue(this.eval(s.c))) await this.exec(s.then)
        else if (s.else !== null) await this.exec(s.else)
        return
      case 'while':
        while (isTrue(this.eval(s.c))) {
          await this.tick()
          if (await this.#loopBody(s.body)) break
        }
        return
      case 'do':
        do {
          await this.tick()
          if (await this.#loopBody(s.body)) break
        } while (isTrue(this.eval(s.c)))
        return
      case 'for':
        if (s.init !== null) this.eval(s.init)
        while (s.c === null || isTrue(this.eval(s.c))) {
          await this.tick()
          if (await this.#loopBody(s.body)) break
          if (s.step !== null) this.eval(s.step)
        }
        return
      case 'forin': {
        const arr = this.array(s.arr)
        for (const key of [...arr.keys()]) {
          if (!arr.has(key)) continue
          await this.tick()
          this.setScalar(s.name, key)
          if (await this.#loopBody(s.body)) break
        }
        return
      }
      case 'break':
        throw new BreakSignal()
      case 'continue':
        throw new ContinueSignal()
      case 'next':
        if (this.#inBegin || this.#inEnd)
          throw new AwkRuntimeError('awk: next used in BEGIN or END')
        throw new NextSignal()
      case 'exit':
        throw new ExitSignal(s.e === null ? null : Math.trunc(toNum(this.eval(s.e))))
      case 'delete': {
        const arr = this.array(s.name)
        if (s.subs === null) arr.clear()
        else arr.delete(this.#key(s.subs))
        return
      }
    }
  }

  /** Run a loop's body: whether it broke out. */
  async #loopBody(body: Stmt): Promise<boolean> {
    try {
      await this.exec(body)
    } catch (e) {
      if (e instanceof BreakSignal) return true
      if (e instanceof ContinueSignal) return false
      throw e
    }
    return false
  }

  #emit(dest: Dest | null, text: string): void {
    if (dest === null) {
      this.#out += text
      return
    }
    const path = this.#str(this.eval(dest.e))
    if (path === '/dev/stdout' || path === '-') {
      this.#out += text
      return
    }
    if (path === '/dev/stderr') {
      this.#err += text
      return
    }
    let out = this.#files.get(path)
    if (out === undefined) {
      out = { base: dest.mode === '>' ? 'truncate' : 'append', text: '', open: true }
      this.#files.set(path, out)
    } else if (!out.open) {
      // closed, then opened again: `>` starts the file over
      if (dest.mode === '>') {
        out.base = 'truncate'
        out.text = ''
      }
      out.open = true
    }
    out.text += text
  }

  // -- the run --------------------------------------------------------------

  async run(items: Item[], operands: string[], assigns: string[]): Promise<number> {
    for (const a of assigns) this.#assignArg(a)
    const argv: AwkArray = new Map([['0', 'awk' as Val]])
    operands.forEach((o, i) => argv.set(String(i + 1), new StrNum(o)))
    this.#vars.set('ARGV', argv)
    this.#vars.set('ARGC', operands.length + 1)

    const begins = items.filter((i) => i.kind === 'begin')
    const mains = items.filter((i) => i.kind === 'main')
    const ends = items.filter((i) => i.kind === 'end')
    let code: number | null = null

    this.#inBegin = true
    try {
      for (const item of begins) await this.exec(item.action as Stmt)
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e
      code = e.code ?? 0
    }
    this.#inBegin = false

    if (code === null && (mains.length > 0 || ends.length > 0)) {
      try {
        await this.#readInput(mains, operands)
      } catch (e) {
        if (!(e instanceof ExitSignal)) throw e
        code = e.code ?? 0
      }
    }

    this.#inEnd = true
    try {
      for (const item of ends) await this.exec(item.action as Stmt)
    } catch (e) {
      if (!(e instanceof ExitSignal)) throw e
      code = e.code ?? code ?? 0
    }
    return code ?? 0
  }

  /** `var=value` from `-v` or a file operand. */
  #assignArg(a: string): void {
    const eq = a.indexOf('=')
    this.setScalar(a.slice(0, eq), new StrNum(readEscapes(a.slice(eq + 1))))
  }

  async #readInput(mains: Item[], operands: string[]): Promise<void> {
    // with no file named, stdin is read after the assignments
    const files = operands.filter((o) => !isAssignment(o))
    const sources = files.length === 0 ? [...operands, '-'] : operands
    for (const src of sources) {
      if (isAssignment(src)) {
        this.#assignArg(src)
        continue
      }
      let text: string
      if (src === '-' || src === '/dev/stdin') text = this.#ctx.stdin.text()
      else {
        try {
          text = new TextDecoder().decode(await this.#ctx.fs.read(src))
        } catch (e) {
          throw new AwkRuntimeError(`awk: can't open file ${src}: ${describeFsError(e)}`)
        }
      }
      this.#vars.set('FILENAME', src === '-' ? '' : src)
      this.#vars.set('FNR', 0)
      for (const record of this.#records(text)) {
        await this.tick()
        this.#vars.set('NR', toNum(this.#scalar('NR')) + 1)
        this.#vars.set('FNR', toNum(this.#scalar('FNR')) + 1)
        this.setRecord(record)
        try {
          for (const item of mains) {
            if (!this.#matches(item)) continue
            if (item.action === null) this.#out += this.#record + this.#str2(this.#scalar('ORS'))
            else await this.exec(item.action)
          }
        } catch (e) {
          if (!(e instanceof NextSignal)) throw e
        }
      }
    }
  }

  *#records(text: string): Generator<string> {
    const rs = this.#str2(this.#scalar('RS'))
    if (rs === '') {
      // paragraph mode: records are separated by blank lines
      const paras = text.replace(/^\n+/, '').split(/\n\n+/)
      if (paras.length > 0 && (paras[paras.length - 1] as string).replace(/\n+$/, '') === '')
        paras.pop()
      for (const p of paras) yield p.replace(/\n+$/, '')
      return
    }
    const parts = rs.length === 1 ? text.split(rs) : text.split(this.#regex(rs))
    if (parts[parts.length - 1] === '') parts.pop()
    yield* parts
  }

  #matches(item: Item): boolean {
    if (item.pattern === null) return true
    if (item.until === null) return isTrue(this.eval(item.pattern))
    if (!item.inRange) {
      if (!isTrue(this.eval(item.pattern))) return false
      item.inRange = true
    }
    if (isTrue(this.eval(item.until))) item.inRange = false
    return true
  }

  /** Write what the run printed: stdout, then the files it printed to. */
  async flush(): Promise<void> {
    if (this.#out !== '') this.#ctx.stdout.write(this.#out)
    this.#out = ''
    const encoder = new TextEncoder()
    for (const [path, out] of this.#files) {
      try {
        await this.#ctx.fs.write(
          path,
          encoder.encode(out.text),
          out.base === 'truncate' ? 'w' : 'a',
        )
      } catch (e) {
        throw new AwkRuntimeError(`awk: can't write to ${path}: ${describeFsError(e)}`)
      }
    }
    this.#files.clear()
  }

  get stderr(): string {
    return this.#err
  }
}

function arith(op: string, a: number, b: number): number {
  switch (op) {
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      if (b === 0) throw new AwkRuntimeError('awk: division by zero')
      return a / b
    case '%':
      if (b === 0) throw new AwkRuntimeError('awk: division by zero in %')
      return a % b
    default:
      return a ** b
  }
}

/**
 * `sub`/`gsub` on `s`: the text after, and how many matches were
 * replaced. In `repl`, `&` is the match and `\&` a literal `&`; an empty
 * match right after a replaced one is skipped, as awk skips it.
 */
function substitute(re: RegExp, repl: string, s: string, global: boolean): [string, number] {
  const g = new RegExp(re.source, 'g')
  let out = ''
  let pos = 0
  let count = 0
  let lastEnd = -1
  while (pos <= s.length) {
    g.lastIndex = pos
    const m = g.exec(s)
    if (m === null) break
    const at = m.index
    const len = m[0].length
    if (len === 0 && at === lastEnd) {
      if (at >= s.length) break
      out += s.charAt(at)
      pos = at + 1
      continue
    }
    out += s.slice(pos, at) + expandRepl(repl, m[0])
    count++
    lastEnd = at + len
    if (len === 0) {
      if (at < s.length) out += s.charAt(at)
      pos = at + 1
    } else pos = at + len
    if (!global) break
  }
  if (pos <= s.length) out += s.slice(pos)
  return [out, count]
}

function expandRepl(repl: string, matched: string): string {
  let out = ''
  for (let i = 0; i < repl.length; i++) {
    const c = repl.charAt(i)
    if (c === '\\' && (repl.charAt(i + 1) === '&' || repl.charAt(i + 1) === '\\')) {
      out += repl.charAt(i + 1)
      i++
    } else out += c === '&' ? matched : c
  }
  return out
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

function isAssignment(operand: string): boolean {
  return ASSIGNMENT.test(operand)
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

const USAGE = 'usage: awk [-F fs][-v var=value][prog | -f progfile][file ...]'

/**
 * `awk [-F fs] [-v var=value]... ('program' | -f progfile) [file | var=value]...`
 */
export const awk: CommandHandler = async (ctx) => {
  const assigns: string[] = []
  const progFiles: string[] = []
  let fs: string | null = null
  let i = 0
  const args = ctx.args
  while (i < args.length) {
    const a = args[i] as string
    if (a === '--') {
      i++
      break
    }
    if (a === '-' || !a.startsWith('-')) break
    const flag = a.slice(0, 2)
    const inline = a.slice(2)
    if (flag !== '-F' && flag !== '-v' && flag !== '-f') {
      return { exitCode: 2, stderr: `awk: unknown option ${a}\n${USAGE}` }
    }
    let value: string
    if (inline !== '') value = inline
    else {
      if (i + 1 >= args.length)
        return { exitCode: 2, stderr: `awk: ${flag} needs a value\n${USAGE}` }
      value = args[++i] as string
    }
    if (flag === '-F') fs = value === 't' ? '\t' : readEscapes(value)
    else if (flag === '-v') {
      if (!isAssignment(value))
        return { exitCode: 2, stderr: `awk: -v needs var=value, not '${value}'` }
      assigns.push(value)
    } else progFiles.push(value)
    i++
  }

  let program: string
  if (progFiles.length > 0) {
    const texts: string[] = []
    for (const p of progFiles) {
      try {
        texts.push(new TextDecoder().decode(await ctx.fs.read(p)))
      } catch (e) {
        return { exitCode: 2, stderr: `awk: can't open program file ${p}: ${describeFsError(e)}` }
      }
    }
    program = texts.join('\n')
  } else {
    if (i >= args.length) return { exitCode: 2, stderr: USAGE }
    program = args[i++] as string
  }
  const operands = args.slice(i)

  let items: Item[]
  try {
    items = new Parser(program).parse()
  } catch (e) {
    if (e instanceof AwkSyntaxError) return { exitCode: 2, stderr: e.message }
    throw e
  }

  const interp = new Interp(ctx)
  if (fs !== null) interp.setScalar('FS', fs)
  try {
    const code = await interp.run(items, operands, assigns)
    await interp.flush()
    if (code !== 0 || interp.stderr !== '') return { exitCode: code, stderr: interp.stderr }
    return undefined
  } catch (e) {
    if (e instanceof AwkRuntimeError) {
      await interp.flush().catch(() => undefined)
      return { exitCode: 2, stderr: interp.stderr + e.message }
    }
    if (e instanceof TerminalError) {
      await interp.flush().catch(() => undefined)
    }
    throw e
  }
}
