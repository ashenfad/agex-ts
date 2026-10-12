/**
 * Byte streams for pipes and redirects, and byte-level helpers.
 *
 * A pipeline stage's input and output are bytes; text is a view, decoded
 * as UTF-8 with U+FFFD for undecodable bytes, and encoded as UTF-8 on
 * the way out. The transcript is decoded once, at the end.
 */

import type { Stdin, Stdout } from './context'

const decoder = new TextDecoder('utf-8', { fatal: false })
const encoder = new TextEncoder()

export const EMPTY = new Uint8Array(0)

/** UTF-8 text as bytes. */
export function encode(text: string): Uint8Array {
  return encoder.encode(text)
}

/** Bytes as UTF-8 text; undecodable bytes become U+FFFD. */
export function decode(data: Uint8Array): string {
  return decoder.decode(data)
}

/** One array holding `parts` in order. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 0) return EMPTY
  if (parts.length === 1) return parts[0] as Uint8Array
  let size = 0
  for (const p of parts) size += p.byteLength
  const out = new Uint8Array(size)
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.byteLength
  }
  return out
}

/** Split at `\n`, keeping the newline on each line. Splitting bytes
 *  leaves every other byte as it was, and breaks lines only where a
 *  shell does (not at a lone `\r`, `\x0b` or U+2028). Trailing content
 *  with no final newline is its own line; empty input has no lines. */
export function splitLines(data: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = []
  let start = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      lines.push(data.subarray(start, i + 1))
      start = i + 1
    }
  }
  if (start < data.length) lines.push(data.subarray(start))
  return lines
}

/** A stage's input over fixed bytes. */
export class ByteStdin implements Stdin {
  readonly bytes: Uint8Array
  #text: string | undefined

  constructor(bytes: Uint8Array = EMPTY) {
    this.bytes = bytes
  }

  text(): string {
    if (this.#text === undefined) this.#text = decode(this.bytes)
    return this.#text
  }
}

/** A stage's output, collected in the order it was written. */
export class ByteStdout implements Stdout {
  readonly #parts: Uint8Array[] = []

  write(text: string): void {
    if (text.length > 0) this.#parts.push(encode(text))
  }

  writeBytes(data: Uint8Array): void {
    if (data.byteLength > 0) this.#parts.push(data)
  }

  /** Everything written so far. */
  value(): Uint8Array {
    return concat(this.#parts)
  }
}
