/**
 * `file` — minimal magic-byte sniffer.
 *
 * For each path argument, write one line of the form `<path>: <description>`
 * to stdout. Covers the handful of types that agents care about when
 * verifying a downloaded blob is what its extension claims (gzip, zip,
 * tar, PDF, PNG, JPEG, ELF, HTML), with a UTF-8/ASCII/binary fallback.
 *
 * Not a libmagic re-implementation. No `--mime` / `-b` flags; no
 * symlink handling (the FS protocol doesn't model symlinks).
 */

import type { CommandContext, CommandHandler } from '../context'
import { TerminalError } from '../errors'
import { looksLikeBinary } from './_util'

/** How many leading bytes to read for classification. tar's `ustar`
 *  magic lives at offset 257, so we need at least 262; 1024 gives
 *  headroom and is still tiny. */
const SNIFF_LEN = 1024

export const file: CommandHandler = async (ctx: CommandContext) => {
  if (ctx.args.length === 0) {
    throw new TerminalError('file: missing operand')
  }

  for (const path of ctx.args) {
    if (ctx.signal.aborted) throw new TerminalError('file: aborted')

    let isDir: boolean
    try {
      const meta = await ctx.fs.stat(path)
      isDir = meta.isDir
    } catch (e) {
      throw new TerminalError(`file: ${path}: ${describeError(e)}`)
    }

    if (isDir) {
      ctx.stdout.write(`${path}: directory\n`)
      continue
    }

    let bytes: Uint8Array
    try {
      bytes = await ctx.fs.read(path)
    } catch (e) {
      throw new TerminalError(`file: ${path}: ${describeError(e)}`)
    }

    ctx.stdout.write(`${path}: ${classify(bytes)}\n`)
  }
}

/** Classify a byte buffer using magic prefixes, then fall back to a
 *  text/binary sniff. Returned strings deliberately mirror the most
 *  recognizable shape of GNU `file`'s output so transcripts read
 *  the way a developer expects. */
function classify(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) return 'empty'

  const head = bytes.subarray(0, Math.min(bytes.byteLength, SNIFF_LEN))

  // gzip: 1f 8b
  if (startsWith(head, [0x1f, 0x8b])) return 'gzip compressed data'

  // zip: PK\x03\x04 (local file header), PK\x05\x06 (empty),
  //      PK\x07\x08 (spanned).
  if (
    startsWith(head, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(head, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(head, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'Zip archive data'
  }

  // PDF: %PDF-
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'PDF document'

  // PNG: 89 50 4e 47 0d 0a 1a 0a
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'PNG image data'
  }

  // JPEG: ff d8 ff
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'JPEG image data'

  // ELF: 7f 45 4c 46
  if (startsWith(head, [0x7f, 0x45, 0x4c, 0x46])) return 'ELF binary'

  // POSIX tar: `ustar` at offset 257.
  if (
    head.byteLength >= 262 &&
    head[257] === 0x75 &&
    head[258] === 0x73 &&
    head[259] === 0x74 &&
    head[260] === 0x61 &&
    head[261] === 0x72
  ) {
    return 'POSIX tar archive'
  }

  // HTML: leading `<!DOCTYPE html` or `<html` (case-insensitive,
  // tolerating leading whitespace).
  const asciiPrefix = decodeAsciiPrefix(head, 64).trimStart().toLowerCase()
  if (asciiPrefix.startsWith('<!doctype html') || asciiPrefix.startsWith('<html')) {
    return 'HTML document'
  }

  // No magic match → text/binary fallback. Both checks scan the full
  // buffer (not just `head`) so we don't misclassify a file as text
  // when its first 1024 bytes are clean but trailing content isn't.
  // `looksLikeBinary` already samples the first 4KB; the extra cost
  // here is one linear pass over data we've already loaded.
  if (looksLikeBinary(bytes)) return 'data'

  if (isAsciiOnly(bytes)) return 'ASCII text'

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'UTF-8 Unicode text'
  } catch {
    // Not valid UTF-8 but didn't trip the binary heuristic — call it
    // "data" rather than misclassify as text.
    return 'data'
  }
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.byteLength < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (bytes[i] !== prefix[i]) return false
  }
  return true
}

function isAsciiOnly(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) {
    if ((bytes[i] as number) >= 0x80) return false
  }
  return true
}

/** Decode the leading printable-ASCII run as a string for the HTML
 *  sniff. Stops at the first non-ASCII byte; returns up to `max` chars. */
function decodeAsciiPrefix(bytes: Uint8Array, max: number): string {
  const end = Math.min(bytes.byteLength, max)
  let out = ''
  for (let i = 0; i < end; i++) {
    const b = bytes[i] as number
    if (b >= 0x80) break
    out += String.fromCharCode(b)
  }
  return out
}

function describeError(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}
