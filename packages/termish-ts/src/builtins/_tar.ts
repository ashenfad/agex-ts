/**
 * Minimal USTAR reader/writer.
 *
 * Tar format is simple enough to implement directly: 512-byte header
 * blocks, content padded to 512-byte boundaries, archive terminated
 * by two zero blocks. We only need files and directories; symlinks
 * and other special types aren't part of our use cases.
 */

const BLOCK = 512
const ZERO_BLOCK = new Uint8Array(BLOCK)

export type TarEntryType = 'file' | 'dir' | 'other'

export interface TarEntry {
  readonly name: string
  readonly type: TarEntryType
  readonly content: Uint8Array
  readonly mode: number
  readonly mtime: number
}

export function readTar(bytes: Uint8Array): TarEntry[] {
  const entries: TarEntry[] = []
  let offset = 0
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK)
    if (isZero(header)) break
    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name
    const mode = readOctal(header, 100, 8)
    const size = readOctal(header, 124, 12)
    const mtime = readOctal(header, 136, 12)
    const typeflag = String.fromCharCode(header[156] as number)

    const type: TarEntryType =
      typeflag === '5' ? 'dir' : typeflag === '0' || typeflag === '\0' ? 'file' : 'other'

    const contentStart = offset + BLOCK
    const content = bytes.subarray(contentStart, contentStart + size)
    entries.push({ name: fullName, type, content, mode, mtime })

    offset = contentStart + roundUp(size, BLOCK)
  }
  return entries
}

export function writeTar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const e of entries) {
    blocks.push(buildHeader(e))
    if (e.type === 'file' && e.content.length > 0) {
      blocks.push(e.content)
      const pad = roundUp(e.content.length, BLOCK) - e.content.length
      if (pad > 0) blocks.push(new Uint8Array(pad))
    }
  }
  // Trailer: two zero blocks.
  blocks.push(ZERO_BLOCK)
  blocks.push(ZERO_BLOCK)

  let total = 0
  for (const b of blocks) total += b.length
  const out = new Uint8Array(total)
  let pos = 0
  for (const b of blocks) {
    out.set(b, pos)
    pos += b.length
  }
  return out
}

function buildHeader(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(BLOCK)
  let name = entry.name
  if (entry.type === 'dir' && !name.endsWith('/')) name = `${name}/`

  // Long-name handling: split into prefix + name when needed. For now,
  // require names ≤ 100 chars (sufficient for our test cases).
  if (name.length > 100) {
    throw new Error(`tar: name too long (>100 chars): ${name}`)
  }

  writeString(header, name, 0, 100)
  writeOctal(header, entry.mode & 0o7777, 100, 8)
  writeOctal(header, 0, 108, 8) // uid
  writeOctal(header, 0, 116, 8) // gid
  writeOctal(header, entry.type === 'file' ? entry.content.length : 0, 124, 12)
  writeOctal(header, entry.mtime, 136, 12)
  // Checksum field initialized to spaces for the sum.
  for (let i = 148; i < 156; i++) header[i] = 0x20
  header[156] = entry.type === 'dir' ? 0x35 /* '5' */ : 0x30 /* '0' */
  // magic "ustar\0" + version "00"
  const magic = encoder.encode('ustar\0' + '00')
  header.set(magic, 257)

  let sum = 0
  for (const b of header) sum += b
  writeOctal(header, sum, 148, 7)
  header[155] = 0x20 // space after octal in checksum

  return header
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

function readString(buf: Uint8Array, offset: number, length: number): string {
  const end = (() => {
    for (let i = offset; i < offset + length; i++) {
      if (buf[i] === 0) return i
    }
    return offset + length
  })()
  return decoder.decode(buf.subarray(offset, end))
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  let s = ''
  for (let i = offset; i < offset + length; i++) {
    const c = buf[i] as number
    if (c === 0 || c === 0x20) {
      if (s.length > 0) break
      continue
    }
    s += String.fromCharCode(c)
  }
  if (s.length === 0) return 0
  return Number.parseInt(s, 8)
}

function writeString(buf: Uint8Array, s: string, offset: number, length: number): void {
  const enc = encoder.encode(s)
  const n = Math.min(enc.length, length)
  for (let i = 0; i < n; i++) buf[offset + i] = enc[i] as number
}

function writeOctal(buf: Uint8Array, n: number, offset: number, length: number): void {
  const s = n.toString(8).padStart(length - 1, '0')
  for (let i = 0; i < length - 1; i++) buf[offset + i] = s.charCodeAt(i)
  buf[offset + length - 1] = 0
}

function isZero(buf: Uint8Array): boolean {
  for (const b of buf) if (b !== 0) return false
  return true
}

function roundUp(n: number, mod: number): number {
  return Math.ceil(n / mod) * mod
}
