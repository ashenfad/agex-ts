/**
 * Tiny argparse for builtin command flag parsing.
 *
 * Replaces the Python `CommandArgParser` (subclass of `argparse`). No
 * dependencies — argparse-style parsing is small enough to hand-roll
 * (~80 lines) and the surface we need is narrow.
 *
 * Supports:
 * - Short flags `-r`, with stacking (`-la` = `-l -a`)
 * - Long flags `--recursive`, with `--name=value` form
 * - Per-flag aliases (e.g. `-r`/`-R`/`--recursive` all set the same key)
 * - Boolean and value-taking flags
 * - Positional args with min/max bounds
 * - `--` terminator (everything after is positional, no flag interpretation)
 *
 * Errors throw `TerminalError` with a `<prog>:` prefix, matching
 * termish-py's `CommandArgParser.error`.
 */

import { TerminalError } from '../errors'

export interface FlagDef {
  /** All aliases for this flag (`['-r', '-R', '--recursive']`). */
  readonly aliases: readonly string[]
  /** True if the flag takes a value; default false (boolean). */
  readonly takesValue?: boolean
  /** True if the flag can be passed multiple times, accumulating
   *  values into an array. Implies `takesValue: true`. The default
   *  value in `parsed.flags` is an empty array. */
  readonly multi?: boolean
}

export interface ParseSpec {
  /** Flag definitions keyed by canonical name. The canonical name is
   *  what shows up in the parsed result (`flags.recursive`, etc.). */
  readonly flags?: Readonly<Record<string, FlagDef>>
  /** Minimum required positional args. Throws on under. */
  readonly minPositional?: number
  /** Maximum allowed positional args. Throws on over. */
  readonly maxPositional?: number
}

export interface ParsedArgs {
  /** Flag values keyed by canonical name. Booleans default to `false`
   *  if absent; value-flags are missing from the object if not passed.
   *  Multi flags default to `[]` and accumulate each occurrence. */
  readonly flags: Readonly<Record<string, boolean | string | string[]>>
  readonly positional: readonly string[]
}

/**
 * Parse argv. `prog` is used as the prefix in error messages.
 *
 * Boolean flags default to `false` for every defined flag — callers
 * can read `parsed.flags.recursive` and trust it's a boolean. Value
 * flags are absent from the object if not passed (caller checks with
 * `'name' in parsed.flags` or via a default).
 */
export function parseArgs(args: readonly string[], spec: ParseSpec, prog: string): ParsedArgs {
  const flagsByAlias = new Map<string, [string, FlagDef]>()
  const flags: Record<string, boolean | string | string[]> = {}
  for (const [name, def] of Object.entries(spec.flags ?? {})) {
    if (def.multi === true) flags[name] = []
    else if (def.takesValue !== true) flags[name] = false
    for (const alias of def.aliases) flagsByAlias.set(alias, [name, def])
  }

  const positional: string[] = []
  let i = 0
  while (i < args.length) {
    const arg = args[i] as string
    i++

    if (arg === '--') {
      while (i < args.length) positional.push(args[i++] as string)
      break
    }

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=')
      const name = eqIdx === -1 ? arg : arg.slice(0, eqIdx)
      const inlineValue = eqIdx === -1 ? null : arg.slice(eqIdx + 1)
      const entry = flagsByAlias.get(name)
      if (entry === undefined) {
        throw new TerminalError(`${prog}: unknown option: ${name}`)
      }
      const [canonical, def] = entry
      if (def.takesValue === true || def.multi === true) {
        let value: string
        if (inlineValue !== null) {
          value = inlineValue
        } else {
          if (i >= args.length) {
            throw new TerminalError(`${prog}: option ${name} requires a value`)
          }
          value = args[i++] as string
        }
        if (def.multi === true) {
          ;(flags[canonical] as string[]).push(value)
        } else {
          flags[canonical] = value
        }
      } else {
        if (inlineValue !== null) {
          throw new TerminalError(`${prog}: option ${name} does not take a value`)
        }
        flags[canonical] = true
      }
      continue
    }

    // Single `-` is a positional (often "stdin"); short flags are `-X` (X != ''/-).
    if (arg.startsWith('-') && arg.length > 1) {
      const chars = arg.slice(1)
      let chi = 0
      while (chi < chars.length) {
        const ch = chars[chi] as string
        const flagName = `-${ch}`
        const entry = flagsByAlias.get(flagName)
        if (entry === undefined) {
          throw new TerminalError(`${prog}: unknown option: ${flagName}`)
        }
        const [canonical, def] = entry
        if (def.takesValue === true || def.multi === true) {
          // -nVALUE (rest of cluster) or -n VALUE (next argv).
          const remaining = chars.slice(chi + 1)
          let value: string
          if (remaining.length > 0) {
            value = remaining
            chi = chars.length
          } else {
            if (i >= args.length) {
              throw new TerminalError(`${prog}: option ${flagName} requires a value`)
            }
            value = args[i++] as string
            chi = chars.length
          }
          if (def.multi === true) {
            ;(flags[canonical] as string[]).push(value)
          } else {
            flags[canonical] = value
          }
        } else {
          flags[canonical] = true
          chi++
        }
      }
      continue
    }

    positional.push(arg)
  }

  if (spec.minPositional !== undefined && positional.length < spec.minPositional) {
    throw new TerminalError(`${prog}: missing operand`)
  }
  if (spec.maxPositional !== undefined && positional.length > spec.maxPositional) {
    throw new TerminalError(`${prog}: too many arguments`)
  }

  return { flags, positional }
}
