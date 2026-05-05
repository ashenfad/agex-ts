import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

describe('gzip / gunzip', () => {
  it('round-trips a file', async () => {
    const fs = new MemoryFS()
    await fs.write('/data.txt', bytes('hello world'))
    await execute('gzip /data.txt', fs)
    expect(await fs.exists('/data.txt')).toBe(false)
    expect(await fs.exists('/data.txt.gz')).toBe(true)
    await execute('gunzip /data.txt.gz', fs)
    expect(await fs.exists('/data.txt.gz')).toBe(false)
    expect(dec.decode(await fs.read('/data.txt'))).toBe('hello world')
  })

  it('-k keeps the original', async () => {
    const fs = new MemoryFS()
    await fs.write('/data.txt', bytes('x'))
    await execute('gzip -k /data.txt', fs)
    expect(await fs.exists('/data.txt')).toBe(true)
    expect(await fs.exists('/data.txt.gz')).toBe(true)
  })

  it('refuses to overwrite without -f', async () => {
    const fs = new MemoryFS()
    await fs.write('/data.txt', bytes('x'))
    await fs.write('/data.txt.gz', bytes('preexisting'))
    await expect(execute('gzip /data.txt', fs)).rejects.toBeInstanceOf(TerminalError)
  })

  it('-f overwrites', async () => {
    const fs = new MemoryFS()
    await fs.write('/data.txt', bytes('hello'))
    await fs.write('/data.txt.gz', bytes('preexisting'))
    await execute('gzip -f /data.txt', fs)
    // Output should be a valid gzip — not 'preexisting'.
    const out = await fs.read('/data.txt.gz')
    expect(out[0]).toBe(0x1f)
    expect(out[1]).toBe(0x8b)
  })

  it('errors on .gz suffix when compressing', async () => {
    const fs = new MemoryFS()
    await fs.write('/already.gz', bytes('x'))
    await expect(execute('gzip /already.gz', fs)).rejects.toBeInstanceOf(TerminalError)
  })

  it('errors on missing .gz suffix when decompressing', async () => {
    const fs = new MemoryFS()
    await fs.write('/plain.txt', bytes('x'))
    await expect(execute('gunzip /plain.txt', fs)).rejects.toBeInstanceOf(TerminalError)
  })
})

describe('tar', () => {
  it('creates and lists an archive', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes('alpha'))
    await fs.write('/b.txt', bytes('bravo'))
    await execute('tar -cf /out.tar /a.txt /b.txt', fs)
    const list = await execute('tar -tf /out.tar', fs)
    expect(list).toContain('a.txt')
    expect(list).toContain('b.txt')
  })

  it('extracts an archive into -C target dir', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes('alpha'))
    await execute('tar -cf /out.tar /a.txt', fs)
    await fs.mkdir('/extracted')
    await execute('tar -xf /out.tar -C /extracted', fs)
    // Path inside the archive starts with /a.txt → safe form is "a.txt".
    expect(await fs.exists('/extracted/a.txt')).toBe(true)
    expect(dec.decode(await fs.read('/extracted/a.txt'))).toBe('alpha')
  })

  it('round-trips a directory tree', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/src/sub', { parents: true })
    await fs.write('/src/top.txt', bytes('top'))
    await fs.write('/src/sub/inner.txt', bytes('inner'))
    await execute('tar -cf /tree.tar /src', fs)
    await fs.mkdir('/dst')
    await execute('tar -xf /tree.tar -C /dst', fs)
    expect(dec.decode(await fs.read('/dst/src/top.txt'))).toBe('top')
    expect(dec.decode(await fs.read('/dst/src/sub/inner.txt'))).toBe('inner')
  })

  it('-z creates a gzipped archive that auto-decompresses on read', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes('alpha'))
    await execute('tar -czf /out.tgz /a.txt', fs)
    // Magic bytes prove it's gzip.
    const archive = await fs.read('/out.tgz')
    expect(archive[0]).toBe(0x1f)
    expect(archive[1]).toBe(0x8b)
    // Auto-detect on extract.
    await fs.mkdir('/out')
    await execute('tar -xf /out.tgz -C /out', fs)
    expect(dec.decode(await fs.read('/out/a.txt'))).toBe('alpha')
  })

  it('--strip-components removes leading path segments', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/proj/src', { parents: true })
    await fs.write('/proj/src/main.ts', bytes('m'))
    await execute('tar -cf /a.tar /proj', fs)
    await fs.mkdir('/dst')
    await execute('tar -xf /a.tar -C /dst --strip-components 1', fs)
    expect(await fs.exists('/dst/src/main.ts')).toBe(true)
    expect(await fs.exists('/dst/proj')).toBe(false)
  })

  it('dashless mode form (czf) works', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes('alpha'))
    await execute('tar czf /out.tgz /a.txt', fs)
    expect(await fs.exists('/out.tgz')).toBe(true)
  })

  it('errors when no mode is given', async () => {
    await expect(execute('tar -f /x.tar', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })

  it('errors when -f is missing', async () => {
    await expect(execute('tar -c /a.txt', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })
})

describe('zip / unzip', () => {
  it('round-trips files', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes('alpha'))
    await fs.write('/b.txt', bytes('bravo'))
    await execute('zip /out.zip /a.txt /b.txt', fs)
    expect(await fs.exists('/out.zip')).toBe(true)
    await fs.mkdir('/out')
    const log = await execute('unzip -d /out /out.zip', fs)
    expect(log).toContain('inflating')
    expect(dec.decode(await fs.read('/out/a.txt'))).toBe('alpha')
    expect(dec.decode(await fs.read('/out/b.txt'))).toBe('bravo')
  })

  it('-r recurses into directories', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d/sub', { parents: true })
    await fs.write('/d/top.txt', bytes('t'))
    await fs.write('/d/sub/inner.txt', bytes('i'))
    await execute('zip -r /out.zip /d', fs)
    await fs.mkdir('/x')
    await execute('unzip -d /x /out.zip', fs)
    expect(dec.decode(await fs.read('/x/d/top.txt'))).toBe('t')
    expect(dec.decode(await fs.read('/x/d/sub/inner.txt'))).toBe('i')
  })

  it('zip without -r errors on directories', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/dir')
    await fs.write('/dir/a', bytes('x'))
    await expect(execute('zip /out.zip /dir', fs)).rejects.toBeInstanceOf(TerminalError)
  })

  it('appends .zip suffix if missing', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes('alpha'))
    await execute('zip /out /a.txt', fs)
    expect(await fs.exists('/out.zip')).toBe(true)
  })

  it('unzip -l lists contents', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes('alpha'))
    await execute('zip /out.zip /a.txt', fs)
    const out = await execute('unzip -l /out.zip', fs)
    expect(out).toContain('a.txt')
    expect(out).toContain('Length')
  })

  it('unzip skips existing files without -o', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes('alpha'))
    await execute('zip /out.zip /a.txt', fs)
    await fs.mkdir('/x')
    await fs.write('/x/a.txt', bytes('preexisting'))
    const log = await execute('unzip -d /x /out.zip', fs)
    expect(log).toContain('skipping')
    expect(dec.decode(await fs.read('/x/a.txt'))).toBe('preexisting')
  })

  it('unzip -o overwrites', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes('alpha'))
    await execute('zip /out.zip /a.txt', fs)
    await fs.mkdir('/x')
    await fs.write('/x/a.txt', bytes('preexisting'))
    await execute('unzip -o -d /x /out.zip', fs)
    expect(dec.decode(await fs.read('/x/a.txt'))).toBe('alpha')
  })

  it('unzip rejects missing archive', async () => {
    await expect(execute('unzip /missing.zip', new MemoryFS())).rejects.toBeInstanceOf(
      TerminalError,
    )
  })
})
