/**
 * I/O builtins (`echo`, `cat` to start; `head`, `tail`, `tee` follow
 * in a later commit).
 *
 * These are intentionally minimal in this commit — just enough to
 * give the interpreter something to chew on for end-to-end tests.
 * Full flag coverage lands when the rest of the I/O group is ported.
 */

import type { CommandContext, CommandHandler } from '../context'
import { TerminalError } from '../errors'

const decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * `echo [args...]` — writes args joined by single spaces, trailing
 * newline. No flag handling in this commit; `-n` (suppress newline)
 * and `-e` (interpret escapes) come with the I/O wave.
 */
export const echo: CommandHandler = async (ctx: CommandContext) => {
  ctx.stdout.write(ctx.args.join(' '))
  ctx.stdout.write('\n')
}

/**
 * `cat [files...]` — concatenate files to stdout. With no arguments,
 * pass stdin through (so `echo hi | cat` works). Decodes file bytes
 * as UTF-8 (replacement char on invalid sequences).
 */
export const cat: CommandHandler = async (ctx: CommandContext) => {
  if (ctx.args.length === 0) {
    ctx.stdout.write(ctx.stdin)
    return
  }
  for (const arg of ctx.args) {
    if (ctx.signal.aborted) throw new TerminalError('cat: aborted')
    try {
      const bytes = await ctx.fs.read(arg)
      ctx.stdout.write(decoder.decode(bytes))
    } catch (e) {
      throw new TerminalError(`cat: ${arg}: ${describeError(e)}`)
    }
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
