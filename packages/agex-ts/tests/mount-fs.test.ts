import { MemoryFS } from 'termish-ts/fs/memory'
import { describe, expect, it } from 'vitest'
import { ChaptersOverlay } from '../src/fs/chapters-overlay'
import { MountFS } from '../src/fs/mount'

const enc = new TextEncoder()
const dec = new TextDecoder()

function makeOverlay(files: Record<string, string> = {}): ChaptersOverlay {
  const m = new Map<string, Uint8Array>()
  for (const [k, v] of Object.entries(files)) m.set(k, enc.encode(v))
  return new ChaptersOverlay(m)
}

describe('MountFS — routing', () => {
  it('reads under mount go to the overlay', async () => {
    const overlay = makeOverlay({ '/a/summary.md': 'hello' })
    const fs = new MountFS(new MemoryFS(), [{ prefix: '/chapters', fs: overlay }])
    expect(dec.decode(await fs.read('/chapters/a/summary.md'))).toBe('hello')
  })

  it('reads outside mounts go to the backing FS', async () => {
    const backing = new MemoryFS()
    await backing.write('/data.txt', enc.encode('backing'))
    const fs = new MountFS(backing, [{ prefix: '/chapters', fs: makeOverlay() }])
    expect(dec.decode(await fs.read('/data.txt'))).toBe('backing')
  })

  it('writes under a mount throw a TypeError naming the mount', async () => {
    const fs = new MountFS(new MemoryFS(), [{ prefix: '/chapters', fs: makeOverlay() }])
    await expect(fs.write('/chapters/x', enc.encode('nope'))).rejects.toThrow(
      /read-only mount \/chapters/,
    )
  })

  it('writes outside mounts go to the backing FS', async () => {
    const backing = new MemoryFS()
    const fs = new MountFS(backing, [{ prefix: '/chapters', fs: makeOverlay() }])
    await fs.write('/note.txt', enc.encode('agent wrote this'))
    expect(dec.decode(await backing.read('/note.txt'))).toBe('agent wrote this')
  })

  it('list() includes mount points as virtual subdirs of the parent', async () => {
    const fs = new MountFS(new MemoryFS(), [
      { prefix: '/chapters', fs: makeOverlay() },
      { prefix: '/skills', fs: makeOverlay() },
    ])
    const top = await fs.list('/')
    expect(top).toContain('chapters')
    expect(top).toContain('skills')
  })

  it('isDir() reports true for mount points', async () => {
    const fs = new MountFS(new MemoryFS(), [{ prefix: '/chapters', fs: makeOverlay() }])
    expect(await fs.isDir('/chapters')).toBe(true)
  })

  it('rejects bad mount prefixes', () => {
    expect(() => new MountFS(new MemoryFS(), [{ prefix: 'chapters', fs: makeOverlay() }])).toThrow(
      /must start with '\/'/,
    )
    expect(() => new MountFS(new MemoryFS(), [{ prefix: '/', fs: makeOverlay() }])).toThrow(
      /cannot mount at root/,
    )
    expect(
      () => new MountFS(new MemoryFS(), [{ prefix: '/chapters/', fs: makeOverlay() }]),
    ).toThrow(/must not end with/)
  })

  it('mount() and unmount() update the active mounts', async () => {
    const fs = new MountFS(new MemoryFS())
    expect(fs.mounts.length).toBe(0)
    fs.mount('/chapters', makeOverlay({ '/x.md': 'x' }))
    expect(fs.mounts.length).toBe(1)
    expect(dec.decode(await fs.read('/chapters/x.md'))).toBe('x')
    expect(fs.unmount('/chapters')).toBe(true)
    expect(fs.unmount('/chapters')).toBe(false)
  })
})

describe('ChaptersOverlay — read-only file map (paths relative to mount root)', () => {
  it('reads files materialized at construction', async () => {
    const o = makeOverlay({ '/a/summary.md': 'hello a' })
    expect(dec.decode(await o.read('/a/summary.md'))).toBe('hello a')
  })

  it('exists / isFile / isDir reflect both files and synthesized dirs', async () => {
    const o = makeOverlay({ '/a/summary.md': 's', '/a/events/001-action.md': 'a' })
    expect(await o.exists('/a/summary.md')).toBe(true)
    expect(await o.isFile('/a/summary.md')).toBe(true)
    expect(await o.isDir('/a')).toBe(true)
    expect(await o.isDir('/a/events')).toBe(true)
    expect(await o.isDir('/')).toBe(true)
    expect(await o.exists('/missing')).toBe(false)
  })

  it('list() returns immediate-child names', async () => {
    const o = makeOverlay({
      '/a/summary.md': 's',
      '/a/events/001-action.md': 'e1',
      '/b/summary.md': 's',
    })
    expect(await o.list('/')).toEqual(['a', 'b'])
    expect((await o.list('/a')).sort()).toEqual(['events', 'summary.md'])
    expect(await o.list('/a/events')).toEqual(['001-action.md'])
  })

  it('list({ recursive: true }) walks the whole subtree', async () => {
    const o = makeOverlay({
      '/a/summary.md': 's',
      '/a/events/001-action.md': 'e1',
    })
    const all = await o.list('/', { recursive: true })
    expect(all).toEqual(['a', 'a/events', 'a/events/001-action.md', 'a/summary.md'])
  })

  it('write methods throw clearly', async () => {
    const o = makeOverlay()
    await expect(o.write()).rejects.toThrow(/read-only/)
    await expect(o.mkdir()).rejects.toThrow(/read-only/)
    await expect(o.remove()).rejects.toThrow(/read-only/)
    await expect(o.rmdir()).rejects.toThrow(/read-only/)
    await expect(o.rename()).rejects.toThrow(/read-only/)
  })

  it('swap() replaces the backing map atomically', async () => {
    const o = makeOverlay({ '/chapters/a/summary.md': 'old' })
    o.swap(new Map([['/chapters/b/summary.md', enc.encode('new')]]))
    await expect(o.read('/chapters/a/summary.md')).rejects.toThrow(/no such file/)
    expect(dec.decode(await o.read('/chapters/b/summary.md'))).toBe('new')
  })
})
