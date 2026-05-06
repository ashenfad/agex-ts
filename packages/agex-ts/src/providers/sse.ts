/**
 * Server-Sent Events (SSE) line parser.
 *
 * Reads a `ReadableStream<Uint8Array>` (the body of a `fetch` response
 * with `stream: true`) and yields the payload of each `data:` line.
 * Skips comments, empty lines, and other SSE fields. Stops on
 * `[DONE]` per the SSE-with-LLMs convention.
 *
 * Buffer-bounded so a malformed stream that never emits a newline
 * can't grow unbounded.
 */

const MAX_LINE_BYTES = 1_048_576 // 1 MiB

export async function* parseSseEvents(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (value !== undefined) {
        // `stream: true` keeps multi-byte UTF-8 sequences across chunks.
        buffer += decoder.decode(value, { stream: true })
        if (buffer.length > MAX_LINE_BYTES && buffer.indexOf('\n') === -1) {
          throw new Error(`SSE line exceeded ${MAX_LINE_BYTES} bytes without a newline`)
        }
        let nl = buffer.indexOf('\n')
        while (nl !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, '')
          buffer = buffer.slice(nl + 1)
          // SSE spec: the space after `data:` is optional. Anthropic
          // always sends it, but other providers / proxies sometimes
          // don't. Strip it defensively.
          if (line.startsWith('data:')) {
            let payload = line.slice(5)
            if (payload.startsWith(' ')) payload = payload.slice(1)
            if (payload === '[DONE]') return
            yield payload
          }
          // Skip empty lines, comments (`: ...`), and other SSE fields.
          nl = buffer.indexOf('\n')
        }
      }
      if (done) break
    }
    // Flush a final line not terminated by a newline.
    buffer += decoder.decode()
    const tail = buffer.replace(/\r$/, '')
    if (tail.startsWith('data:')) {
      let payload = tail.slice(5)
      if (payload.startsWith(' ')) payload = payload.slice(1)
      if (payload !== '[DONE]') yield payload
    }
  } finally {
    reader.releaseLock()
  }
}
