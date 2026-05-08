/**
 * Helpers for working with `OutputPart`s in a way that's robust to the
 * older agex-py convention of representing agent-code errors as a text
 * part starting with `💥 {ErrorName}: {message}`.
 *
 * agex-ts's idiom is the typed `{ type: 'error', errorName, errorMessage }`
 * variant — but we may consume event logs that originated on the agex-py
 * side, where errors are encoded by convention. These helpers let
 * downstream consumers (renderer, pretty-printer, embedders' own UIs)
 * detect and unpack errors without caring which form they're in.
 *
 * Once agex-py adopts the typed variant (or we stop reading legacy py
 * event logs), the convention branch can be deleted; the helpers stay
 * useful as the canonical place to ask "is this part an error".
 */

import type { OutputPart } from './types'

/**
 * Pattern matching the legacy convention: `💥 ErrorName: message`.
 *
 * The error-name capture group stops at the first `:` for two reasons:
 * (a) error class names can't contain `:`, (b) error messages often do
 * (URLs, key:value pairs, etc.). The `[\s\S]*` body intentionally
 * permits multi-line messages — agex-py's traceback formatter joins
 * the message and stack with newlines.
 */
const CONVENTION_PATTERN = /^💥 ([^:]+): ([\s\S]*)$/

/**
 * Returns true when the part represents an agent-code error, in either
 * the typed form or the legacy `💥 ...` text-prefix convention.
 */
export function isErrorPart(part: OutputPart): boolean {
  if (part.type === 'error') return true
  if (part.type === 'text') return CONVENTION_PATTERN.test(part.text.trimEnd())
  return false
}

/**
 * Unpack `(errorName, errorMessage)` from an error part — typed or
 * convention-encoded — or return `null` if it isn't one.
 */
export function errorPartInfo(
  part: OutputPart,
): { readonly errorName: string; readonly errorMessage: string } | null {
  if (part.type === 'error') {
    return { errorName: part.errorName, errorMessage: part.errorMessage }
  }
  if (part.type === 'text') {
    const m = CONVENTION_PATTERN.exec(part.text.trimEnd())
    if (m !== null) {
      return { errorName: m[1] as string, errorMessage: m[2] as string }
    }
  }
  return null
}

/**
 * Render an error part as the `💥 ErrorName: message` text the LLM sees.
 * Used by the render layer and tests; embedders building richer UIs
 * (color, expand-to-stack, etc.) should switch on `part.type === 'error'`
 * directly rather than calling this.
 */
export function formatErrorPart(errorName: string, errorMessage: string): string {
  return `💥 ${errorName}: ${errorMessage}`
}
