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

export interface TerminalErrorOptions {
  /** The transcript before the failure: stdout, plus diagnostics from
   *  failures execution continued past. */
  readonly partialOutput?: string
  /** The failing command's exit code. Default 1; 127 when the
   *  command was not found. */
  readonly exitCode?: number
  /** The command's own stderr text, when it gave one. `undefined`
   *  means the message is the diagnostic; `''` means the failure was
   *  silent (its stderr went to a redirect, or there was none). */
  readonly stderr?: string | undefined
}

export class TerminalError extends Error {
  override readonly name = 'TerminalError'
  readonly partialOutput: string
  readonly exitCode: number
  readonly stderr: string | undefined

  constructor(message: string, opts: TerminalErrorOptions = {}) {
    super(message)
    this.partialOutput = opts.partialOutput ?? ''
    this.exitCode = opts.exitCode ?? 1
    this.stderr = opts.stderr
  }
}

export class ParseError extends Error {
  override readonly name = 'ParseError'
}
