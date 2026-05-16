/**
 * Command context + result + handler signature.
 *
 * Every builtin and every host-injected command receives a single
 * `CommandContext` argument: parsed args, stdin / stdout strings,
 * the filesystem, an env map (reserved), and an `AbortSignal` for
 * cooperative cancellation.
 *
 * Handlers return:
 * - `void` (or omitted return) for success with no stderr
 * - `CommandResult` to signal a non-zero exit code and/or stderr
 * - they can also throw `TerminalError` for hard failures
 */

import type { FileSystem } from './fs/protocol'

export interface CommandContext {
  /** Parsed arguments — does NOT include the command name. */
  readonly args: readonly string[]
  /** Stdin: piped content from the previous pipeline stage, or
   *  empty if this is the first command. */
  readonly stdin: string
  /** Write stdout here. Pipeline captures and forwards. */
  readonly stdout: { write(s: string): void }
  /** The filesystem the command operates on. */
  readonly fs: FileSystem
  /** Reserved for future env-var support; currently always empty. */
  readonly env: Readonly<Record<string, string>>
  /** Cooperative cancellation. Loop-heavy builtins (grep, find,
   *  xargs) check this at iteration boundaries. */
  readonly signal: AbortSignal
  /** The full command registry — host overrides merged on top of
   *  builtins. Builtins that re-enter the interpreter (xargs,
   *  `find -exec`) thread this through so host-injected commands
   *  remain reachable in nested invocations. */
  readonly commands: ReadonlyMap<string, CommandHandler>
  /** True when this command's stdout will flow to the script's
   *  returned output (last command in its pipeline, no output
   *  redirect). False when the stdout will be consumed by a
   *  downstream pipe stage or shunted to a file via `>` / `>>`.
   *
   *  Builtins use this to gate diagnostics that only make sense when
   *  the output reaches a human/agent caller — e.g. `cat` refuses to
   *  dump binary content when `agentSink=true`, but stays out of the
   *  way for `cat /binary > /copy` or `cat /nul-sep | xargs -0`. */
  readonly agentSink: boolean
}

export interface CommandResult {
  /** Non-zero signals failure. Default 0 (success). */
  readonly exitCode: number
  /** Optional stderr text. */
  readonly stderr: string
}

/** A command handler. Always async — every builtin and most host
 *  commands need to await IO. Resolve to `undefined` (or just fall
 *  off the end of the function body) for "success with no stderr",
 *  or to a `CommandResult` to signal a non-zero exit code or stderr
 *  text. Throw `TerminalError` for hard failures (the pipeline
 *  aborts and the partial output reaches the caller).
 *
 *  The `void` in the union is here so that a handler body with no
 *  `return` statement (which TS infers as `Promise<void>`) satisfies
 *  the type. `void` and `undefined` are equivalent at runtime. */
// biome-ignore lint/suspicious/noConfusingVoidType: see comment above
export type CommandHandler = (ctx: CommandContext) => Promise<CommandResult | undefined | void>
