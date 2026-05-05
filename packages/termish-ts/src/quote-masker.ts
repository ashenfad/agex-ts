/**
 * Mask quoted substrings so the tokenizer can treat them as opaque
 * single tokens.
 *
 * Why: shell tokenization needs to distinguish between quoted
 * wildcards (literal `*`) and unquoted wildcards (glob pattern).
 * Without masking, the tokenizer would see `'*'` as the operator
 * sequence `'`, `*`, `'` and lose the quoting semantics.
 *
 * Algorithm: each quoted span is replaced with a unique placeholder
 * token (`__Q_<sessionHex>_<n>__`) before tokenization. The parser
 * unmasks back to the original quoted form at parse time; the
 * interpreter calls `unmaskAndUnquote` (which strips the outer
 * quotes and unescapes) when actually executing.
 *
 * Ported from termish-py's `quote_masker.py`.
 */

/**
 * Match a quoted span:
 *   - opening `'` or `"`, captured as `quote`
 *   - content: backslash-escaped char OR any char that isn't the
 *     matching closing quote
 *   - closing `'` or `"` (must match the opener via backreference)
 *
 * The `(?<!\\)` lookbehind prevents matching a quote that's itself
 * escaped (e.g. inside an outer quoted span). The `s` flag lets `.`
 * span newlines so heredoc-style multi-line quotes round-trip.
 */
const QUOTE_RX = /(?<!\\)(?<quote>["'])(?<content>(?:\\.|(?!\k<quote>).)*)\k<quote>/gs

export interface MaskResult {
  /** Text with every quoted span replaced by a unique placeholder. */
  readonly masked: string
  /** Placeholder → original quoted span (including the outer quotes). */
  readonly map: Map<string, string>
}

export function maskQuotes(text: string): MaskResult {
  const map = new Map<string, string>()
  const session = randomHex(8)
  let counter = 0
  const masked = text.replace(QUOTE_RX, (match) => {
    const token = `__Q_${session}_${counter++}__`
    map.set(token, match)
    return token
  })
  return { masked, map }
}

/** Restore placeholders to their full original quoted form (with quotes). */
export function unmaskQuotes(text: string, map: ReadonlyMap<string, string>): string {
  let result = text
  for (const [token, original] of map) {
    result = result.replaceAll(token, original)
  }
  return result
}

/**
 * Restore placeholders but **strip the outer quotes** and unescape
 * any escaped quote characters inside.
 *
 * Used at execution time when the interpreter expands command args:
 * the agent typed `'hello world'` to mean the literal string
 * `hello world`, so when we hand the arg to a builtin we want the
 * unquoted form.
 */
export function unmaskAndUnquote(text: string, map: ReadonlyMap<string, string>): string {
  let result = text
  for (const [token, original] of map) {
    if (original.length >= 2) {
      const quoteChar = original[0]
      let inner = original.slice(1, -1)
      if (quoteChar === '"') inner = inner.replaceAll('\\"', '"')
      else if (quoteChar === "'") inner = inner.replaceAll("\\'", "'")
      result = result.replaceAll(token, inner)
    } else {
      result = result.replaceAll(token, original)
    }
  }
  return result
}

/** Non-cryptographic random hex — collision avoidance only. */
function randomHex(length: number): string {
  let out = ''
  while (out.length < length) {
    out += Math.floor(Math.random() * 0xffff_ffff)
      .toString(16)
      .padStart(8, '0')
  }
  return out.slice(0, length)
}
