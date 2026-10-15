/**
 * What's here: `which`, `command`, `help`.
 *
 * They read the command registry the script runs with, so a host's
 * own commands show beside the builtins. A host command describes
 * itself with a `description` string on its handler, which `help`
 * shows; one without is listed by name.
 *
 * Mirrors termish-py's `info.py`.
 */

import type { CommandContext, CommandHandler, CommandResult } from '../context'
import { TerminalError } from '../errors'
import { HELP, type HelpEntry } from './help-text'
import { BUILTINS } from './index'

/** `name`'s help: the builtin's own, a host command's `description`,
 *  or null for a host command without one. */
function helpOf(ctx: CommandContext, name: string): HelpEntry | null {
  const handler = ctx.commands.get(name)
  if (handler !== undefined && handler === BUILTINS.get(name)) return HELP[name] ?? null
  const description = (handler as { description?: unknown } | undefined)?.description
  return typeof description === 'string' ? { summary: description, usage: '' } : null
}

const isBuiltin = (ctx: CommandContext, name: string): boolean => {
  const handler = ctx.commands.get(name)
  return handler !== undefined && handler === BUILTINS.get(name)
}

/** `which NAME...` — each command that exists, by name; exit 1 if any doesn't. */
export const which: CommandHandler = async (ctx) => {
  if (ctx.args.length === 0) throw new TerminalError('which: missing operand')
  const missing: string[] = []
  for (const name of ctx.args) {
    if (ctx.commands.has(name)) ctx.stdout.write(`${name}\n`)
    else missing.push(`which: no ${name}`)
  }
  return missing.length === 0 ? undefined : { exitCode: 1, stderr: missing.join('\n') }
}

/**
 * `command -v NAME...` (each that exists, by name), `command -V
 * NAME...` (what each is), or `command NAME [ARG...]` (run it).
 */
export const command: CommandHandler = async (ctx) => {
  const [first, ...rest] = ctx.args
  if (first === undefined) return undefined
  if (first === '-v' || first === '-V') {
    if (rest.length === 0) throw new TerminalError(`command: ${first}: missing operand`)
    const missing: string[] = []
    for (const name of rest) {
      if (!ctx.commands.has(name)) missing.push(`command: ${name}: not found`)
      else if (first === '-v') ctx.stdout.write(`${name}\n`)
      else ctx.stdout.write(`${name} is ${isBuiltin(ctx, name) ? 'a builtin' : 'a host command'}\n`)
    }
    return missing.length === 0 ? undefined : { exitCode: 1, stderr: missing.join('\n') }
  }
  if (first.startsWith('-')) throw new TerminalError(`command: unknown option: ${first}`)
  const handler = ctx.commands.get(first)
  if (handler === undefined)
    throw new TerminalError(`${first}: command not found`, { exitCode: 127 })
  return handler({ ...ctx, args: rest })
}

/**
 * `help [NAME]` — every command with a line on what it does, or how
 * NAME is used.
 */
export const help: CommandHandler = async (ctx): Promise<CommandResult | undefined> => {
  if (ctx.args.length > 1) throw new TerminalError('help: too many arguments')
  const [name] = ctx.args
  if (name !== undefined) {
    if (!ctx.commands.has(name)) throw new TerminalError(`help: no such command: ${name}`)
    const entry = helpOf(ctx, name)
    if (entry === null) {
      ctx.stdout.write(`${name}: a command of this host, with no help here\n`)
      return undefined
    }
    ctx.stdout.write(`${name} - ${entry.summary}\n`)
    if (entry.usage !== '') ctx.stdout.write(`usage: ${entry.usage}\n`)
    return undefined
  }
  const names = [...ctx.commands.keys()].sort()
  const width = Math.max(...names.map((n) => n.length))
  const lines = names.map((n) => {
    const entry = helpOf(ctx, n)
    return entry === null ? n : `${n.padEnd(width)}  ${entry.summary}`
  })
  ctx.stdout.write(`Commands (help NAME shows how one is used):\n${lines.join('\n')}\n`)
  return undefined
}
