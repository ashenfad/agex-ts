/**
 * Command context + result + handler signature.
 *
 * Every builtin and every host-injected command receives a single
 * `CommandContext` argument: parsed args, stdin and stdout, the
 * filesystem, the environment, and an `AbortSignal` for cooperative
 * cancellation.
 *
 * Pipes and redirects carry bytes. A handler reads its input as text
 * (`stdin.text()`, UTF-8 with U+FFFD for undecodable bytes) or as bytes
 * (`stdin.bytes`), and writes text (`stdout.write`, encoded UTF-8) or
 * bytes (`stdout.writeBytes`), in any order. A handler that only moves
 * content (copying stdin out, writing a file) should stay on bytes:
 * decoding and re-encoding corrupts anything that is not valid UTF-8.
 *
 * Handlers return:
 * - `void` (or omitted return) for success with no stderr
 * - `CommandResult` to signal a non-zero exit code and/or stderr
 * - they can also throw `TerminalError` for hard failures
 */

import type { FileSystem } from './fs/protocol'

/** A command's input: what the previous pipeline stage wrote, or the
 *  file or heredoc a redirect named. Empty for the first command. */
export interface Stdin {
  /** The input, byte for byte. */
  readonly bytes: Uint8Array
  /** The input decoded as UTF-8; undecodable bytes become U+FFFD. */
  text(): string
}

/** A command's output. What is written goes to the next pipeline
 *  stage, to a redirect's file, or to the transcript. */
export interface Stdout {
  /** Write text, encoded UTF-8. */
  write(text: string): void
  /** Write bytes, unchanged. */
  writeBytes(data: Uint8Array): void
}

export interface CommandContext {
  /** Parsed arguments — does NOT include the command name. */
  readonly args: readonly string[]
  readonly stdin: Stdin
  readonly stdout: Stdout
  /** The filesystem the command operates on. */
  readonly fs: FileSystem
  /** Environment variables backing `$VAR` expansion. Shared across the
   *  script's commands and with the caller's object passed as
   *  `execute(..., { env })`, so a change is visible to later commands
   *  and to the caller. */
  readonly env: Record<string, string>
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
  /** Optional stderr text. On success it is a warning, shown in the
   *  transcript; on failure it is the diagnostic. */
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
