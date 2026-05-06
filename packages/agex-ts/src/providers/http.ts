/**
 * Small HTTP / streaming helpers shared by every LLM provider
 * package. Lifted out of each provider's `client.ts` so bug fixes
 * (and the SSE-payload-parsing convention) live in one place.
 */

/** Walk an SSE-line iterator (each yielded string is one `data:`
 *  payload), JSON-parse each non-empty payload, and yield the
 *  resulting object. Drops payloads that fail to parse — providers
 *  occasionally emit keep-alive comments or unexpected text frames
 *  that aren't worth crashing the stream over. */
export async function* sseLinesToEventDicts(lines: AsyncIterable<string>): AsyncIterable<unknown> {
  for await (const payload of lines) {
    if (payload.length === 0) continue
    try {
      yield JSON.parse(payload)
    } catch {
      // Skip unparseable payloads.
    }
  }
}

/** Read a `fetch` response body as text without throwing. Used to
 *  surface error-response bodies in thrown errors when an API call
 *  fails. */
export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** Best-effort heuristic for "is this a transient network error
 *  worth retrying?" `fetch` rejects on connection errors with a
 *  `TypeError` whose message names the cause; DNS failures, RST
 *  resets, and TLS errors all surface as TypeError. `AbortError`
 *  comes from timeouts and explicit cancellation — those are NOT
 *  transient (caller intent is "stop"). */
export function isTransientNetworkError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return false
    if (err.name === 'TypeError') return true
    const msg = err.message.toLowerCase()
    if (msg.includes('network') || msg.includes('socket') || msg.includes('econnreset')) {
      return true
    }
  }
  return false
}

/** Promise-based sleep that honors an AbortSignal. Used between
 *  retry attempts. Rejects with an aborted error if the signal
 *  fires; otherwise resolves after `ms`. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'))
      return
    }
    const t = setTimeout(resolve, ms)
    if (signal !== undefined) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t)
          reject(new Error('aborted'))
        },
        { once: true },
      )
    }
  })
}
