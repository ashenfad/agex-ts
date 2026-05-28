/**
 * Control builtins: `true`, `false`.
 *
 * POSIX no-ops. Their primary purpose is enabling shell idioms — most
 * importantly `cmd || true` to swallow a non-zero exit so a script can
 * continue. Without these, agent transcripts that include the common
 * `cmd || true` pattern fail with "true: command not found".
 *
 * Names are suffixed with `_` because `true` / `false` are reserved
 * JavaScript identifiers.
 */

import type { CommandHandler } from '../context'

/** `true` — succeed with no output. */
export const true_: CommandHandler = async () => {
  // Empty handler body = exit 0, no stdout.
}

/** `false` — fail with exit code 1, no output, no diagnostic. The
 *  interpreter turns this into `TerminalError("false: exited with code 1")`,
 *  which is correctly rescued by `||` and correctly propagates otherwise. */
export const false_: CommandHandler = async () => ({ exitCode: 1, stderr: '' })
