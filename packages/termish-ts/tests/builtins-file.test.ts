import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()

/** Build a Uint8Array from a prefix and pad with zeros to `total` bytes. */
function padTo(prefix: readonly number[], total: number): Uint8Array {
  const buf = new Uint8Array(total)
  for (let i = 0; i < prefix.length; i++) buf[i] = prefix[i] as number
  return buf
}

describe('file', () => {
  it('detects gzip via 1f 8b magic', async () => {
    const fs = new MemoryFS()
    await fs.write('/data.csv.gz', new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]))
    expect(await execute('file /data.csv.gz', fs)).toBe('/data.csv.gz: gzip compressed data\n')
  })

  it('detects zip via PK\\x03\\x04', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))
    expect(await execute('file /a.zip', fs)).toBe('/a.zip: Zip archive data\n')
  })

  it('detects PDF via %PDF-', async () => {
    const fs = new MemoryFS()
    await fs.write('/doc.pdf', enc.encode('%PDF-1.7\n...'))
    expect(await execute('file /doc.pdf', fs)).toBe('/doc.pdf: PDF document\n')
  })

  it('detects PNG via the 8-byte signature', async () => {
    const fs = new MemoryFS()
    await fs.write(
      '/img.png',
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    )
    expect(await execute('file /img.png', fs)).toBe('/img.png: PNG image data\n')
  })

  it('detects JPEG via ff d8 ff', async () => {
    const fs = new MemoryFS()
    await fs.write('/photo.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]))
    expect(await execute('file /photo.jpg', fs)).toBe('/photo.jpg: JPEG image data\n')
  })

  it('detects ELF via the 4-byte magic', async () => {
    const fs = new MemoryFS()
    await fs.write('/bin', new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]))
    expect(await execute('file /bin', fs)).toBe('/bin: ELF binary\n')
  })

  it('detects POSIX tar via "ustar" at offset 257', async () => {
    const fs = new MemoryFS()
    const buf = new Uint8Array(512)
    // Fill the name field with something innocuous + the ustar magic.
    buf.set(enc.encode('archive.txt'), 0)
    buf.set(enc.encode('ustar'), 257)
    await fs.write('/a.tar', buf)
    expect(await execute('file /a.tar', fs)).toBe('/a.tar: POSIX tar archive\n')
  })

  it('detects HTML via <!DOCTYPE html', async () => {
    const fs = new MemoryFS()
    await fs.write('/page.html', enc.encode('<!DOCTYPE html><html><body>hi</body></html>'))
    expect(await execute('file /page.html', fs)).toBe('/page.html: HTML document\n')
  })

  it('detects HTML via leading <html (case-insensitive, tolerates whitespace)', async () => {
    const fs = new MemoryFS()
    await fs.write('/page.html', enc.encode('\n  <HTML>\n<body>x</body>\n</HTML>\n'))
    expect(await execute('file /page.html', fs)).toBe('/page.html: HTML document\n')
  })

  it('reports empty for a zero-byte file', async () => {
    const fs = new MemoryFS()
    await fs.write('/zero', new Uint8Array(0))
    expect(await execute('file /zero', fs)).toBe('/zero: empty\n')
  })

  it('reports ASCII text for printable-ASCII content', async () => {
    const fs = new MemoryFS()
    await fs.write('/hello.txt', enc.encode('hello\nworld\n'))
    expect(await execute('file /hello.txt', fs)).toBe('/hello.txt: ASCII text\n')
  })

  it('reports UTF-8 Unicode text for multi-byte UTF-8 content', async () => {
    const fs = new MemoryFS()
    await fs.write('/greet.txt', enc.encode('héllo\n'))
    expect(await execute('file /greet.txt', fs)).toBe('/greet.txt: UTF-8 Unicode text\n')
  })

  it('reports data for content that trips the binary heuristic (NUL byte)', async () => {
    const fs = new MemoryFS()
    // Five printable chars with a NUL — no magic match, binary fallback.
    await fs.write('/blob', new Uint8Array([0x61, 0x62, 0x00, 0x63, 0x64]))
    expect(await execute('file /blob', fs)).toBe('/blob: data\n')
  })

  it('reports directory for a directory path', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d')
    expect(await execute('file /d', fs)).toBe('/d: directory\n')
  })

  it('errors on a missing path', async () => {
    await expect(execute('file /missing', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })

  it('errors with no operands', async () => {
    await expect(execute('file', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })

  it('handles multiple paths in order', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.gz', new Uint8Array([0x1f, 0x8b, 0x00]))
    await fs.write('/b.txt', enc.encode('hello'))
    expect(await execute('file /a.gz /b.txt', fs)).toBe(
      '/a.gz: gzip compressed data\n/b.txt: ASCII text\n',
    )
  })

  it('the agent post-download pattern (file FOO || true) survives a missing FOO', async () => {
    // This is the exact transcript that prompted the work — make sure
    // the combination works end to end.
    expect(await execute('file /Electric_Vehicle.csv.gz || true', new MemoryFS())).toBe('')
  })
})
