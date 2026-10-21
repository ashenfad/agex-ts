/**
 * Error types for @agex-ts/termish.
 *
 * `TerminalError` is the catch-all for command execution failures. It
 * carries the exit code, the command's own stderr (when it gave one),
 * and the transcript captured before the failure, so a caller can
 * still show what made it through.
 *
 * `ParseError` is raised by the parser for invalid syntax.
 */

import type { CommandResult } from './context'

export interface TerminalErrorOptions {
  /** The transcript before the failure: stdout, plus diagnostics from
   *  failures execution continued past. */
  readonly partialOutput?: string
  /** The failing command's exit code. Default 1; 127 when the
   *  command was not found. */
  readonly exitCode?: number
  /** The command's own stderr text, when it gave one. `undefined`
   *  means the message is the diagnostic; `''` means nothing reached
   *  the screen: the command failed silently (`false`, `grep` with no
   *  match) or its stderr was redirected (`2>&1`, `2>/dev/null`,
   *  `2>file`). */
  readonly stderr?: string | undefined
  /** What the screen shows, for a failure whose screen text is not its
   *  description, such as `xargs` showing its earlier runs' warnings and
   *  then a command that failed silently. */
  readonly displayStderr?: string | undefined
}

/**
 * A failed command or script. `message` always describes the failure,
 * even a silent one (`grep: exited with code 1`); a command's own stderr
 * appears in it once, prefixed with the command's name only when it
 * doesn't already start with it. To show a failure the way a terminal
 * would, use `displayStderr`.
 */
export class TerminalError extends Error {
  override readonly name = 'TerminalError'
  readonly partialOutput: string
  readonly exitCode: number
  readonly stderr: string | undefined
  readonly #displayStderr: string | undefined

  constructor(message: string, opts: TerminalErrorOptions = {}) {
    super(message)
    this.partialOutput = opts.partialOutput ?? ''
    this.exitCode = opts.exitCode ?? 1
    this.stderr = opts.stderr
    this.#displayStderr = opts.displayStderr
  }

  /** The stderr a terminal shows for this failure: the `displayStderr`
   *  it was made with, when one was given; otherwise `''` when the
   *  command failed silently or its stderr was redirected, and `message`
   *  when it didn't. */
  get displayStderr(): string {
    if (this.#displayStderr !== undefined) return this.#displayStderr
    return this.stderr === '' ? '' : this.message
  }
}

/**
 * The error for command `name`, whose `result` exited non-zero. Its
 * stderr is kept verbatim; the message is that stderr prefixed with
 * `name: ` unless the command already began it with its name (`ls:
 * cannot access ...`), so the name is never doubled. A command that
 * failed silently keeps `stderr === ''`, and its message only says how
 * it exited.
 */
export function commandFailure(name: string, result: CommandResult): TerminalError {
  const err = result.stderr ?? ''
  const message = !err
    ? `${name}: exited with code ${result.exitCode}`
    : err.startsWith(`${name}:`)
      ? err
      : `${name}: ${err}`
  return new TerminalError(message, { exitCode: result.exitCode, stderr: err })
}

export class ParseError extends Error {
  override readonly name = 'ParseError'
}
