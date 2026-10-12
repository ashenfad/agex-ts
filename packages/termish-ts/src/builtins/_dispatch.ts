/**
 * Run an already-split command line against the command registry, as
 * `xargs` and `find -exec` do: no shell re-parsing, so an argument
 * holding spaces, quotes or `$` reaches the command exactly as it is,
 * and the command's output comes back as bytes.
 */

import { ByteStdin, ByteStdout } from '../bytes'
import type { CommandContext, CommandResult } from '../context'
import { TerminalError } from '../errors'
import type { FileSystem } from '../fs/protocol'

export interface Dispatched {
  /** What the command wrote to stdout, byte for byte. */
  readonly output: Uint8Array
  /** Its stderr, when it succeeded with a warning; `''` otherwise. */
  readonly stderr: string
}

/** Run `argv` (`[name, ...args]`) with empty stdin, through `ctx`'s
 *  registry, environment, signal and output sink. Throws `TerminalError` when the
 *  command is missing (127), fails, or throws. */
export async function dispatchArgv(
  ctx: CommandContext,
  argv: readonly string[],
  fs: FileSystem = ctx.fs,
): Promise<Dispatched> {
  const [name, ...args] = argv as [string, ...string[]]
  const handler = ctx.commands.get(name)
  if (handler === undefined) {
    throw new TerminalError(`${name}: command not found`, { exitCode: 127 })
  }
  const stdout = new ByteStdout()
  let result: CommandResult | undefined
  try {
    result =
      (await handler({
        args,
        stdin: new ByteStdin(),
        stdout,
        fs,
        env: ctx.env,
        signal: ctx.signal,
        commands: ctx.commands,
        // Its output goes where the caller's does, so a guard that holds
        // for the caller (cat refusing binary for the transcript) holds.
        agentSink: ctx.agentSink,
      })) ?? undefined
  } catch (e) {
    if (e instanceof TerminalError) throw e
    throw new TerminalError(
      `${name}: execution error: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  if (result !== undefined && result.exitCode !== 0) {
    throw new TerminalError(
      result.stderr ? `${name}: ${result.stderr}` : `${name}: exited with code ${result.exitCode}`,
      { exitCode: result.exitCode, stderr: result.stderr },
    )
  }
  return { output: stdout.value(), stderr: result?.stderr ?? '' }
}
