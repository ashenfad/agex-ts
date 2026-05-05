/**
 * Error types for termish-ts.
 *
 * `TerminalError` is the catch-all for command execution failures —
 * it carries any partial output captured before the failure so a
 * caller can still surface what made it through the pipeline.
 *
 * `ParseError` is raised by the parser for invalid syntax.
 */

export class TerminalError extends Error {
  override readonly name = 'TerminalError'
  /** Whatever was written to stdout before the failure, captured so
   *  the host can still surface partial pipeline output. */
  readonly partialOutput: string

  constructor(message: string, partialOutput = '') {
    super(message)
    this.partialOutput = partialOutput
  }
}

export class ParseError extends Error {
  override readonly name = 'ParseError'
}
