/**
 * AST node types for the terminal command language.
 *
 * Mirrors termish-py's `ast.py` shapes. All nodes are plain objects
 * (frozen at construction, conventionally treated as immutable).
 *
 * Grammar:
 *
 *   Script   = Pipeline { (";" | "&&" | "||" | "\n") Pipeline }*
 *   Pipeline = Command { "|" Command }*
 *   Command  = Word { Arg | Redirect }*
 */

/** I/O redirection kinds.
 * - `'<'`  read input from a file
 * - `'>'`  write output to a file (overwrite)
 * - `'>>'` write output to a file (append)
 */
export type RedirectType = '<' | '>' | '>>'

/** Operators between pipelines.
 * - `';'`  always run the next pipeline
 * - `'&&'` run the next pipeline only if the previous succeeded
 * - `'||'` run the next pipeline only if the previous failed
 */
export type Operator = ';' | '&&' | '||'

/** A single I/O redirection on a command. */
export interface Redirect {
  readonly type: RedirectType
  readonly target: string
}

/** A single executable command invocation. */
export interface Command {
  readonly name: string
  readonly args: readonly string[]
  readonly redirects: readonly Redirect[]
}

/** A sequence of commands connected by pipes (stdout → stdin). */
export interface Pipeline {
  readonly commands: readonly Command[]
}

/** A full script: pipelines joined by operators.
 * `operators[i]` separates `pipelines[i]` and `pipelines[i+1]`;
 * `operators.length === pipelines.length - 1`. */
export interface Script {
  readonly pipelines: readonly Pipeline[]
  readonly operators: readonly Operator[]
}
