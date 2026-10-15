/**
 * `md5sum` and `sha256sum`: a digest per file, and `-c` to check a
 * list of them.
 *
 * Mirrors termish-py's `checksum.py`. MD5 is computed here (Web
 * Crypto has none); SHA-256 through `crypto.subtle`.
 */

import type { CommandContext, CommandHandler, CommandResult } from '../context'
import { TerminalError } from '../errors'
import { describeFsError } from '../fs/errors'
import { parseArgs } from './_argparse'

const decoder = new TextDecoder('utf-8', { fatal: false })

// ---------------------------------------------------------------------------
// MD5 (RFC 1321)
// ---------------------------------------------------------------------------

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]
const K = Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0,
)

/** The MD5 digest of `data`, as lowercase hex. */
export function md5Hex(data: Uint8Array): string {
  const bitLen = data.length * 8
  const padded = new Uint8Array((((data.length + 8) >>> 6) + 1) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, bitLen >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bitLen / 2 ** 32), true)

  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  const m = new Uint32Array(16)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) % 16
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) % 16
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) % 16
      }
      const sum = (a + f + (K[i] as number) + (m[g] as number)) >>> 0
      const s = S[i] as number
      a = d
      d = c
      c = b
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0
    }
    a0 = (a0 + a) >>> 0
    b0 = (b0 + b) >>> 0
    c0 = (c0 + c) >>> 0
    d0 = (d0 + d) >>> 0
  }
  const out = new DataView(new ArrayBuffer(16))
  out.setUint32(0, a0, true)
  out.setUint32(4, b0, true)
  out.setUint32(8, c0, true)
  out.setUint32(12, d0, true)
  return toHex(new Uint8Array(out.buffer))
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)
  return toHex(new Uint8Array(digest))
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

// ---------------------------------------------------------------------------
// the commands
// ---------------------------------------------------------------------------

type Digest = (data: Uint8Array) => string | Promise<string>

/** `HASH  NAME` (or `HASH *NAME`), as the commands write them. */
const LINE_RE = /^([0-9a-fA-F]+) [ *](.+)$/

function checksumCommand(prog: string, digest: Digest, hexLength: number): CommandHandler {
  return async (ctx) => {
    const parsed = parseArgs(
      ctx.args,
      {
        flags: {
          check: { aliases: ['-c', '--check'] },
          binary: { aliases: ['-b', '--binary'] },
          text: { aliases: ['-t', '--text'] },
        },
      },
      prog,
    )
    const files = parsed.positional.length === 0 ? ['-'] : parsed.positional
    if (parsed.flags.check === true) return check(ctx, prog, digest, hexLength, files)
    const errors: string[] = []
    for (const f of files) {
      const data = await readBytes(ctx, f)
      if (typeof data === 'string') {
        errors.push(`${prog}: ${f}: ${data}`)
        continue
      }
      ctx.stdout.write(`${await digest(data)}  ${f}\n`)
    }
    return errors.length === 0 ? undefined : { exitCode: 1, stderr: errors.join('\n') }
  }
}

/** A file's bytes (stdin's for `-`), or why it can't be read. */
async function readBytes(ctx: CommandContext, path: string): Promise<Uint8Array | string> {
  if (path === '-') return ctx.stdin.bytes
  try {
    if (await ctx.fs.isDir(path)) return 'Is a directory'
    return await ctx.fs.read(path)
  } catch (e) {
    return describeFsError(e)
  }
}

/** `-c`: read `HASH  NAME` lines, and say whether each file still matches. */
async function check(
  ctx: CommandContext,
  prog: string,
  digest: Digest,
  hexLength: number,
  lists: readonly string[],
): Promise<CommandResult | undefined> {
  const errors: string[] = []
  let mismatched = 0
  let unreadable = 0
  for (const list of lists) {
    const raw = await readBytes(ctx, list)
    if (typeof raw === 'string') throw new TerminalError(`${prog}: ${list}: ${raw}`)
    let wellFormed = 0
    for (const line of decoder.decode(raw).split('\n')) {
      const m = LINE_RE.exec(line.replace(/\r$/, ''))
      if (m === null || (m[1] as string).length !== hexLength) continue
      wellFormed++
      const name = m[2] as string
      const data = await readBytes(ctx, name)
      if (typeof data === 'string') {
        errors.push(`${prog}: ${name}: ${data}`)
        ctx.stdout.write(`${name}: FAILED open or read\n`)
        unreadable++
        continue
      }
      const ok = (await digest(data)) === (m[1] as string).toLowerCase()
      if (!ok) mismatched++
      ctx.stdout.write(`${name}: ${ok ? 'OK' : 'FAILED'}\n`)
    }
    if (wellFormed === 0)
      errors.push(`${prog}: ${list}: no properly formatted checksum lines found`)
  }
  if (unreadable > 0) {
    errors.push(
      `${prog}: WARNING: ${unreadable} listed file${unreadable === 1 ? '' : 's'} could not be read`,
    )
  }
  if (mismatched > 0) {
    errors.push(
      `${prog}: WARNING: ${mismatched} computed checksum${mismatched === 1 ? '' : 's'} did NOT match`,
    )
  }
  return errors.length === 0 ? undefined : { exitCode: 1, stderr: errors.join('\n') }
}

/** `md5sum [-c] [FILE...]` — each file's MD5, as `HASH  NAME`. */
export const md5sum = checksumCommand('md5sum', md5Hex, 32)

/** `sha256sum [-c] [FILE...]` — each file's SHA-256, as `HASH  NAME`. */
export const sha256sum = checksumCommand('sha256sum', sha256Hex, 64)
