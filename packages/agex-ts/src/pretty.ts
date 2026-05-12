/**
 * Drop-in console formatters for `TaskCallOptions.onToken` and
 * `TaskCallOptions.onEvent`, mirroring agex-py's `pprint_tokens` and
 * `pprint_events`.
 *
 *   - `prettyTokens` — stateless callback that streams a
 *     `TokenChunk` (per-character flow as the model writes). Use
 *     when you want a fire-and-forget streaming view and don't
 *     mind the occasional repeated label on `filePath` /
 *     `fileSearch` if a value spans multiple chunks.
 *   - `createPrettyTokens()` — factory returning a stateful
 *     callback that buffers single-line fields (`title` /
 *     `filePath` / `fileSearch`) so labels emit once per emission
 *     even when content streams in many chunks. Better default
 *     for production console output.
 *   - `prettyEvents` — formats a discrete `AgentEvent` (one section
 *     per action / output / outcome). Use when you want a chunkier
 *     after-the-fact log instead of streaming.
 *
 * Pass either directly to the corresponding callback. For UIs that
 * want different formatting (HTML, color, etc.) write your own
 * against the same `TokenChunk` / `AgentEvent` shapes.
 */

import type { AgentEvent, TokenChunk } from './types'

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
      // Title chunks stream like other string values: content arrives
      // in one or more `done: false` deltas, then a `done: true,
      // content: ''` closes. Stream the content inline; close with a
      // newline so the title sits on its own line right after the
      // toolStart header.
      if (token.done) write('\n')
      else if (token.content.length > 0) write(token.content)
      return
    case 'thinking':
    case 'text':
    case 'ts':
    case 'terminal':
      write(token.content)
      return
    case 'filePath':
    case 'fileSearch': {
      // Content arrives in `done: false` chunks; the closing
      // `done: true` carries empty content (same shape as `title`).
      // Stream chunks with a one-time per-chunk label so the user
      // can tell what they're looking at; close with a newline.
      // Typical case (path fits one chunk): one labeled line.
      // Split case: label repeats per chunk (rare; tolerable).
      const label = token.type === 'filePath' ? 'path' : 'search'
      if (token.done) write('\n')
      else if (token.content.length > 0) write(`\n${label}: ${token.content}`)
      return
    }
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

/** Factory returning a stateful version of `prettyTokens` that
 *  buffers single-line fields (`title` / `filePath` / `fileSearch`)
 *  per emission so labels like `path:` only print once even when
 *  the value streams across multiple chunks.
 *
 *  Stateless `prettyTokens` repeats the label on every chunk for
 *  these fields (visible regression when a path streams in pieces);
 *  the factory variant is the cleaner default for production
 *  console output. Trade-off: titles / paths land at the close of
 *  the field rather than streaming character-by-character — fine
 *  because they're short. Streaming fields (`thinking`, `text`,
 *  `ts`, `terminal`, `fileContent`) still flow live.
 *
 *  Use one factory per task call (state is per-emission keyed by
 *  emissionIndex; running multiple agents through the same callback
 *  would interleave).
 */
export function createPrettyTokens(opts: PrettyOptions = {}): (token: TokenChunk) => void {
  const write = opts.write ?? defaultWrite
  // Per-emission buffers for fields where we want the label to
  // appear once. Keyed by emissionIndex so concurrent streaming of
  // multiple emissions doesn't conflict.
  const buffered = new Map<number, { title: string; filePath: string; fileSearch: string }>()
  function slot(idx: number) {
    let s = buffered.get(idx)
    if (s === undefined) {
      s = { title: '', filePath: '', fileSearch: '' }
      buffered.set(idx, s)
    }
    return s
  }
  return (token: TokenChunk): void => {
    switch (token.type) {
      case 'toolStart':
        write(`\n[${token.content}]\n`)
        return
      case 'thinking':
      case 'text':
      case 'ts':
      case 'terminal':
      case 'fileContent':
        write(token.content)
        return
      case 'title': {
        const s = slot(token.emissionIndex)
        if (token.done) {
          if (s.title.length > 0) write(`${s.title}\n`)
          buffered.delete(token.emissionIndex)
        } else {
          s.title += token.content
        }
        return
      }
      case 'filePath': {
        const s = slot(token.emissionIndex)
        if (token.done) {
          if (s.filePath.length > 0) write(`\npath: ${s.filePath}\n`)
        } else {
          s.filePath += token.content
        }
        return
      }
      case 'fileSearch': {
        const s = slot(token.emissionIndex)
        if (token.done) {
          if (s.fileSearch.length > 0) write(`\nsearch: ${s.fileSearch}\n`)
        } else {
          s.fileSearch += token.content
        }
        return
      }
      case 'emission':
        write('\n')
        buffered.delete(token.emissionIndex)
        return
      case 'signature':
        return
    }
  }
}

interface PrettyEventOptions {
  /** Per-line writer. Defaults to `console.log` (each call emits its
   *  own newline). Set this if you want to capture or redirect. */
  readonly write?: (line: string) => void
  /** Cap the per-emission code/text body at N chars when printing.
   *  Set to `Infinity` for no cap. Defaults to `2_000`. */
  readonly maxBody?: number
}

/** Pretty-print a single `AgentEvent` as a compact block. Drop in as
 *  `onEvent`. Each event writes one or more lines via the configured
 *  writer (default: `console.log`). */
export function prettyEvents(event: AgentEvent, opts: PrettyEventOptions = {}): void {
  const write = opts.write ?? ((s: string) => console.log(s))
  const maxBody = opts.maxBody ?? 2_000
  switch (event.type) {
    case 'taskStart':
      write(`[taskStart] ${event.taskName}`)
      return
    case 'action':
      for (const em of event.emissions) {
        switch (em.type) {
          case 'ts': {
            const head = em.title !== undefined && em.title.length > 0 ? `[ts] ${em.title}` : '[ts]'
            write(`${head}\n${indent(cap(em.code, maxBody))}`)
            break
          }
          case 'terminal': {
            const head =
              em.title !== undefined && em.title.length > 0
                ? `[terminal] ${em.title}`
                : '[terminal]'
            write(`${head} ${cap(em.commands, maxBody)}`)
            break
          }
          case 'thinking':
            write(`[thinking] ${cap(em.text, maxBody)}`)
            break
          case 'text':
            write(`[text] ${cap(em.text, maxBody)}`)
            break
          case 'fileWrite':
            write(`[fileWrite] ${em.path} (${em.mode})`)
            break
          case 'fileEdit':
            write(`[fileEdit] ${em.path}`)
            break
        }
      }
      return
    case 'output':
      for (const p of event.parts) {
        if (p.type === 'text') write(`[stdout] ${cap(p.text.trim(), maxBody)}`)
        else if (p.type === 'error')
          write(`[stderr] ${cap(`${p.errorName}: ${p.errorMessage}`, maxBody)}`)
        else write(`[stdout] <image ${p.format}>`)
      }
      return
    case 'success':
      write('[success]')
      return
    case 'fail':
      write(`[fail] ${event.message}`)
      return
    case 'cancelled':
      write(`[cancelled] ${event.taskName} after ${event.iterationsCompleted} iterations`)
      return
    case 'error':
      write(`[error] ${event.errorName}: ${event.errorMessage}`)
      return
    case 'chapter':
      write(`[chapter] ${event.name} — ${cap(event.message, maxBody)}`)
      return
    case 'file':
      write(
        `[file:${event.source}] +${event.added.length} ~${event.modified.length} -${event.removed.length}`,
      )
      return
    case 'systemNote':
      write(`[systemNote] ${event.message}`)
      return
  }
}

function cap(s: string, n: number): string {
  if (n === Number.POSITIVE_INFINITY || s.length <= n) return s
  return `${s.slice(0, n)}…(${s.length - n} more)`
}

function indent(s: string, by = '  '): string {
  return s
    .split('\n')
    .map((l) => by + l)
    .join('\n')
}
