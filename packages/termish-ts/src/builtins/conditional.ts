/**
 * `test` and `[`: the conditionals agents write before `&&` and `||`.
 * Ported from termish-py's `conditional`.
 *
 * `[ -f x ] && ...`, `test -d out || mkdir out` and `[ -z "$VAR" ]` are
 * how a script asks a question. The subset is the POSIX one agents use:
 *
 * - file tests: `-e` `-f` `-d` `-s` `-r` `-w` `-x`
 * - string tests: `-z` `-n`, `=` (and bash's `==`) `!=`, and a bare
 *   string, true when it is not empty
 * - integer tests: `-eq` `-ne` `-lt` `-le` `-gt` `-ge`
 * - `!`, `-a`, `-o` and parentheses
 *
 * True exits 0, false exits 1 with nothing written, and a malformed
 * expression or a non-integer operand exits 2 with a diagnostic, as in
 * bash. Nothing is ever written to stdout.
 *
 * The filesystem has no permission bits, so `-r` and `-w` are true for
 * any path that exists, and `-x` is true for a directory, which can be
 * entered, and false for a file, which nothing here can run. Out of
 * scope: `[[ ]]`, `-nt`/`-ot`, `-L`, pattern matching.
 */

import type { CommandHandler, CommandResult } from '../context'
import { resolve } from '../fs/path'
import type { FileSystem } from '../fs/protocol'

const UNARY = new Set(['-e', '-f', '-d', '-s', '-r', '-w', '-x', '-z', '-n'])
const BINARY = new Set(['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge'])
const INTEGER = /^\s*[+-]?\d+\s*$/
// bash's integers are signed 64-bit; past either end is not an integer.
const INT_MIN = -(2n ** 63n)
const INT_MAX = 2n ** 63n - 1n

/** A malformed expression or a bad operand: exit 2, with this text. */
class Usage extends Error {}

/** `test EXPRESSION`: exit 0 when it holds, 1 when it does not. */
export const test: CommandHandler = async (ctx) => run('test', [...ctx.args], ctx.fs)

/** `[ EXPRESSION ]`: `test`, with a closing `]` required. */
export const bracket: CommandHandler = async (ctx) => {
  const args = [...ctx.args]
  if (args.length === 0 || args[args.length - 1] !== ']') {
    return { exitCode: 2, stderr: "[: missing `]'" }
  }
  return run('[', args.slice(0, -1), ctx.fs)
}

async function run(
  name: string,
  args: string[],
  fs: FileSystem,
): Promise<CommandResult | undefined> {
  let held: boolean
  try {
    held = await evaluate(args, fs)
  } catch (e) {
    if (e instanceof Usage) return { exitCode: 2, stderr: `${name}: ${e.message}` }
    throw e
  }
  return held ? undefined : { exitCode: 1, stderr: '' }
}

/** POSIX reads one to four arguments by their count, which is what makes
 *  `[ -n ]` (a bare string) and `[ ! = x ]` mean what they do; longer
 *  expressions go to the general parser. */
async function evaluate(args: string[], fs: FileSystem): Promise<boolean> {
  const n = args.length
  const [a0, a1, a2, a3] = args as [string, string, string, string]
  if (n === 0) return false
  if (n === 1) return a0 !== ''
  if (n === 2) {
    if (a0 === '!') return !(await evaluate(args.slice(1), fs))
    if (UNARY.has(a0)) return unary(a0, a1, fs)
    throw new Usage(`${a0}: unary operator expected`)
  }
  if (n === 3) {
    if (BINARY.has(a1)) return binary(a0, a1, a2)
    if (a0 === '!') return !(await evaluate(args.slice(1), fs))
    if (a0 === '(' && a2 === ')') return evaluate(args.slice(1, 2), fs)
    if (a1 === '-a' || a1 === '-o') return new Parser(args, fs).parse()
    throw new Usage(`${a1}: binary operator expected`)
  }
  if (n === 4) {
    if (a0 === '!') return !(await evaluate(args.slice(1), fs))
    if (a0 === '(' && a3 === ')') return evaluate(args.slice(1, 3), fs)
  }
  return new Parser(args, fs).parse()
}

/** `-o` binds loosest, then `-a`, then `!`; a primary is a parenthesised
 *  expression, a unary test, a binary test or a bare string. */
class Parser {
  readonly #args: string[]
  readonly #fs: FileSystem
  #i = 0

  constructor(args: string[], fs: FileSystem) {
    this.#args = args
    this.#fs = fs
  }

  async parse(): Promise<boolean> {
    const value = await this.#or()
    if (this.#i < this.#args.length) {
      throw new Usage(`${this.#args[this.#i]}: unexpected argument`)
    }
    return value
  }

  #peek(ahead = 0): string | undefined {
    return this.#args[this.#i + ahead]
  }

  async #or(): Promise<boolean> {
    let value = await this.#and()
    while (this.#peek() === '-o') {
      this.#i++
      const right = await this.#and()
      value = value || right
    }
    return value
  }

  async #and(): Promise<boolean> {
    let value = await this.#not()
    while (this.#peek() === '-a') {
      this.#i++
      const right = await this.#not()
      value = value && right
    }
    return value
  }

  async #not(): Promise<boolean> {
    if (this.#peek() === '!') {
      this.#i++
      return !(await this.#not())
    }
    return this.#primary()
  }

  async #primary(): Promise<boolean> {
    const token = this.#peek()
    if (token === undefined) throw new Usage('argument expected')
    if (token === '(') {
      this.#i++
      const value = await this.#or()
      if (this.#peek() !== ')') throw new Usage("')' expected")
      this.#i++
      return value
    }
    if (UNARY.has(token) && this.#peek(1) !== undefined) {
      this.#i += 2
      return unary(token, this.#args[this.#i - 1] as string, this.#fs)
    }
    const op = this.#peek(1)
    if (op !== undefined && BINARY.has(op) && this.#peek(2) !== undefined) {
      const right = this.#args[this.#i + 2] as string
      this.#i += 3
      return binary(token, op, right)
    }
    this.#i++
    return token !== ''
  }
}

async function unary(op: string, operand: string, fs: FileSystem): Promise<boolean> {
  if (op === '-z') return operand === ''
  if (op === '-n') return operand !== ''
  // No path at all, not the current directory: an unset variable in
  // `[ -d "$OUT" ]` must not test whatever the shell stands in.
  if (operand === '') return false
  const path = resolve(operand, fs.getcwd())
  if (!(await fs.exists(path))) return false
  if (op === '-e' || op === '-r' || op === '-w') return true
  if (op === '-f') return fs.isFile(path)
  if (op === '-d' || op === '-x') return fs.isDir(path)
  // -s: exists and is not empty; a directory counts as not empty, as a
  // real directory's own size does.
  if (await fs.isDir(path)) return true
  return (await fs.stat(path)).size > 0
}

function binary(left: string, op: string, right: string): boolean {
  if (op === '=' || op === '==') return left === right
  if (op === '!=') return left !== right
  const a = integer(left)
  const b = integer(right)
  if (op === '-eq') return a === b
  if (op === '-ne') return a !== b
  if (op === '-lt') return a < b
  if (op === '-le') return a <= b
  if (op === '-gt') return a > b
  return a >= b // -ge
}

function integer(text: string): bigint {
  const value = INTEGER.test(text) ? BigInt(text.trim()) : null
  if (value === null || value < INT_MIN || value > INT_MAX) {
    throw new Usage(`${text}: integer expression expected`)
  }
  return value
}
