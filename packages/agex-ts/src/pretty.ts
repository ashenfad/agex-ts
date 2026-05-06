/**
 * Convenience callback for `TaskCallOptions.onToken` — prints
 * streaming `TokenChunk`s to the console as they arrive, mirroring
 * agex-py's `pprint_tokens`.
 *
 * Each emission starts with a small `[<toolName>]` header, then the
 * content of each token streams inline so the model's `thinking`,
 * `code`, `commands`, and other text channels appear as the model
 * writes them. Emission boundaries get a newline separator.
 *
 * Designed to be drop-in: pass `prettyTokens` directly to
 * `onToken`. For UIs that want different formatting (HTML, color,
 * etc.) write your own callback against the same `TokenChunk` shape.
 */

import type { TokenChunk } from './types'

interface PrettyOptions {
  /** Where to write. Defaults to `console.log` (no buffering). When
   *  set, individual chunks are appended without a trailing newline
   *  so streaming reads as one continuous flow. */
  readonly write?: (s: string) => void
}

/** Default token writer: prefer a non-buffered `process.stdout.write`
 *  in Node so character-level streaming is visible; fall back to
 *  `console.log` (which adds a newline per call) in environments
 *  that don't expose `process.stdout`. */
const defaultWrite = (s: string): void => {
  // biome-ignore lint/suspicious/noExplicitAny: feature-detect process.stdout
  const proc: any = typeof globalThis !== 'undefined' ? (globalThis as any).process : undefined
  if (proc?.stdout?.write !== undefined) proc.stdout.write(s)
  else console.log(s)
}

/** Stream a single `TokenChunk` to the configured writer.
 *
 *  Prefixes:
 *    - `toolStart` → `\n[<toolName>]\n` so the next chunk burst is
 *      visually attached to the tool that's emitting it.
 *    - `title` → `\n# title: <content>` (one-line label).
 *    - `thinking` → content streamed inline (model's reasoning).
 *    - `text` → content streamed inline (model-facing prose).
 *    - `ts` / `terminal` → content streamed inline (code / commands).
 *    - `filePath` / `fileSearch` / `fileContent` → labeled, inline.
 *    - `emission` → trailing newline so the next emission starts
 *      cleanly.
 *    - `signature` → skipped (opaque binary). */
export function prettyTokens(token: TokenChunk, opts: PrettyOptions = {}): void {
  const write = opts.write ?? defaultWrite
  switch (token.type) {
    case 'toolStart':
      write(`\n[${token.content}]\n`)
      return
    case 'title':
      // Title is one short string; print it whole when it lands.
      if (token.done) write(`# ${token.content}\n`)
      return
    case 'thinking':
    case 'text':
    case 'ts':
    case 'terminal':
      write(token.content)
      return
    case 'filePath':
      if (token.done) write(`\npath: ${token.content}\n`)
      return
    case 'fileSearch':
      if (token.done) write(`\nsearch: ${token.content}\n`)
      return
    case 'fileContent':
      // Streams as the model writes; print inline.
      write(token.content)
      return
    case 'emission':
      write('\n')
      return
    case 'signature':
      // Opaque round-trip blob; not human-readable.
      return
  }
}
