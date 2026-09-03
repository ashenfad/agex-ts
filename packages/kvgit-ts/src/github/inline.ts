/**
 * Inline-content eligibility for tree entries.
 *
 * GitHub's Create Tree endpoint accepts a `content` string on an entry
 * instead of a blob `sha` — "GitHub will write this blob out and use
 * that SHA for this entry" — which folds a would-be `createBlob` POST
 * into a call the pusher was making anyway. That is the whole of the
 * per-key request cost, so it is worth being exact about when it is
 * safe.
 *
 * Two conditions, and only two:
 *
 *   1. The bytes must survive a UTF-8 round trip unchanged. `content`
 *      is a JSON string, so bytes with no Unicode spelling cannot be
 *      expressed. Decoding then re-encoding and comparing is the exact
 *      test — it also rejects lone surrogates for free, since encoding
 *      one yields U+FFFD rather than the original.
 *   2. The value must be small enough that batching many of them into
 *      one request body stays sane. This is a policy gate, not a known
 *      API limit; see `INLINE_LIMIT`.
 *
 * Deliberately NOT conditions: line endings and control bytes. Probing
 * the live API showed CRLF, a lone CR, NUL and C0 controls all stored
 * verbatim, with no trailing newline appended and the empty string
 * yielding git's canonical empty blob. Anything that fails here fails
 * the round trip, so there is no separate character carve-out to keep
 * in sync.
 */

const _decoder = new TextDecoder('utf-8', { fatal: true })
const _encoder = new TextEncoder()

/**
 * Largest value we will inline, in bytes.
 *
 * Not a documented ceiling. A tree call carries every inlined value in
 * one JSON body, so the real risk is an unbounded aggregate rather than
 * any single entry, and the cost of guessing low is one ordinary
 * `createBlob` for an outsized value — the path everything took before.
 * 64 KiB sits well above a session's meta and event-log values and well
 * under any plausible request limit.
 */
export const INLINE_LIMIT = 64 * 1024

/**
 * The string to inline for `bytes`, or `null` when they must go through
 * `createBlob` instead.
 *
 * @param bytes value to place in a tree entry
 * @param limit size gate in bytes; defaults to `INLINE_LIMIT`
 */
export function inlinable(bytes: Uint8Array, limit: number = INLINE_LIMIT): string | null {
  if (bytes.length > limit) return null
  let text: string
  try {
    text = _decoder.decode(bytes)
  } catch {
    return null // not valid UTF-8
  }
  // Decoding can succeed while re-encoding differs (lone surrogates,
  // and any future decoder leniency). Compare rather than trust.
  const round = _encoder.encode(text)
  if (round.length !== bytes.length) return null
  for (let i = 0; i < round.length; i++) {
    if (round[i] !== bytes[i]) return null
  }
  return text
}
