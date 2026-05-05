/**
 * `xargs` — build and execute commands from stdin.
 *
 * Reads stdin, splits into items (whitespace by default, NUL with `-0`),
 * then runs the trailing command once per batch (default: all items in
 * one call; `-n N` for batches of N; `-I {}` for one call per item with
 * placeholder substitution).
 *
 * Recursion guard: xargs invocations are bounded to `MAX_DEPTH` levels
 * deep via a module-local counter — `echo x | xargs xargs xargs ...`
 * can otherwise stack arbitrarily.
 *
 * Implementation note: like `find -exec`, we re-enter the interpreter
 * via a shell-quoted command string. This loses the host command map
 * and the parent's AbortSignal scope, matching how find -exec behaves
 * today.
 */

import type { CommandHandler } from '../context'
import { TerminalError } from '../errors'

const MAX_DEPTH = 16
let xargsDepth = 0

interface ParsedXargs {
  readonly replace: string | null
  readonly maxArgs: number | null
  readonly nullDelim: boolean
  readonly verbose: boolean
  readonly cmdName: string
  readonly cmdBaseArgs: readonly string[]
}

function parseXargsArgs(args: readonly string[]): ParsedXargs {
  let replace: string | null = null
  let maxArgs: number | null = null
  let nullDelim = false
  let verbose = false

  let i = 0
  while (i < args.length) {
    const arg = args[i] as string
    if (arg === '-I' || arg === '--replace') {
      i++
      if (i >= args.length) throw new TerminalError('xargs: option -I requires an argument')
      replace = args[i] as string
    } else if (arg.startsWith('-I') && arg.length > 2) {
      replace = arg.slice(2)
    } else if (arg === '-n' || arg === '--max-args') {
      i++
      if (i >= args.length) throw new TerminalError('xargs: option -n requires an argument')
      const n = Number.parseInt(args[i] as string, 10)
      if (!Number.isFinite(n)) throw new TerminalError(`xargs: invalid number: ${args[i]}`)
      maxArgs = n
    } else if (arg.startsWith('-n') && arg.length > 2 && /^\d+$/.test(arg.slice(2))) {
      maxArgs = Number.parseInt(arg.slice(2), 10)
    } else if (arg === '-0' || arg === '--null') {
      nullDelim = true
    } else if (arg === '-t' || arg === '--verbose') {
      verbose = true
    } else if (arg === '-r' || arg === '--no-run-if-empty') {
      // Default already matches -r semantics (skip when no input).
    } else if (arg.startsWith('-')) {
      throw new TerminalError(`xargs: unknown option: ${arg}`)
    } else {
      return {
        replace,
        maxArgs,
        nullDelim,
        verbose,
        cmdName: arg,
        cmdBaseArgs: args.slice(i + 1),
      }
    }
    i++
  }

  return { replace, maxArgs, nullDelim, verbose, cmdName: 'echo', cmdBaseArgs: [] }
}

/** Single-quote-escape an arg for safe re-parsing by the shell. */
function shellQuote(s: string): string {
  if (s.length === 0) return "''"
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return `'${s.replaceAll("'", "'\\''")}'`
}

export const xargs: CommandHandler = async (ctx) => {
  if (xargsDepth >= MAX_DEPTH) {
    throw new TerminalError(`xargs: maximum recursion depth exceeded (${MAX_DEPTH})`)
  }

  const { replace, maxArgs, nullDelim, verbose, cmdName, cmdBaseArgs } = parseXargsArgs(ctx.args)

  const inputText = ctx.stdin
  if (inputText.trim().length === 0) return

  const items = nullDelim
    ? inputText.split('\0').filter((s) => s.length > 0)
    : inputText.split(/\s+/).filter((s) => s.length > 0)

  if (items.length === 0) return

  const { execute } = await import('../interpreter')

  const runOne = async (cmdArgs: readonly string[]): Promise<void> => {
    const cmdStr = [cmdName, ...cmdArgs].map(shellQuote).join(' ')
    if (verbose) ctx.stdout.write(`${cmdName} ${cmdArgs.join(' ')}\n`)
    xargsDepth++
    let out: string
    try {
      out = await execute(cmdStr, ctx.fs, { signal: ctx.signal })
    } catch (e) {
      throw e instanceof TerminalError
        ? e
        : new TerminalError(`xargs: ${cmdName}: execution error: ${describeError(e)}`)
    } finally {
      xargsDepth--
    }
    ctx.stdout.write(out)
  }

  if (replace !== null) {
    for (const item of items) {
      if (ctx.signal.aborted) throw new TerminalError('xargs: aborted')
      const subbed = cmdBaseArgs.map((a) => a.replaceAll(replace, item))
      await runOne(subbed)
    }
  } else if (maxArgs !== null) {
    for (let i = 0; i < items.length; i += maxArgs) {
      if (ctx.signal.aborted) throw new TerminalError('xargs: aborted')
      const batch = items.slice(i, i + maxArgs)
      await runOne([...cmdBaseArgs, ...batch])
    }
  } else {
    await runOne([...cmdBaseArgs, ...items])
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
