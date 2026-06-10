import { MemoryFS } from '@agex-ts/termish/fs/memory'
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

  it('write auto-creates missing parent directories (mkdir -p)', async () => {
    // The backing FS itself rejects writes into nonexistent dirs —
    // MountFS papers over that so every agent-facing write path has
    // the same semantics as `file_write` emissions.
    const backing = new MemoryFS()
    const fs = new MountFS(backing, [{ prefix: '/chapters', fs: makeOverlay() }])
    await fs.write('/app/components/Chart.jsx', enc.encode('export {}'))
    expect(await backing.isDir('/app/components')).toBe(true)
    expect(dec.decode(await backing.read('/app/components/Chart.jsx'))).toBe('export {}')
    // Relative path resolves against the backing cwd the same way.
    await fs.write('helpers/util/math.js', enc.encode('export const x = 1'))
    expect(await backing.isFile('/helpers/util/math.js')).toBe(true)
  })

  it('write surfaces a clear error when the parent path is a file', async () => {
    const backing = new MemoryFS()
    const fs = new MountFS(backing, [{ prefix: '/chapters', fs: makeOverlay() }])
    await fs.write('/blocker', enc.encode('x'))
    await expect(fs.write('/blocker/child.txt', enc.encode('y'))).rejects.toThrow(
      /file exists at path/,
    )
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

  it('most-specific (longest) prefix wins on overlapping mounts', async () => {
    const outer = makeOverlay({ '/x.md': 'from outer' })
    const inner = makeOverlay({ '/x.md': 'from inner' })
    // Register the shorter prefix first to make sure ordering matters
    const fs = new MountFS(new MemoryFS(), [
      { prefix: '/a', fs: outer },
      { prefix: '/a/b', fs: inner },
    ])
    expect(dec.decode(await fs.read('/a/x.md'))).toBe('from outer')
    expect(dec.decode(await fs.read('/a/b/x.md'))).toBe('from inner')
    // And in the opposite registration order — same result
    const fs2 = new MountFS(new MemoryFS(), [
      { prefix: '/a/b', fs: inner },
      { prefix: '/a', fs: outer },
    ])
    expect(dec.decode(await fs2.read('/a/b/x.md'))).toBe('from inner')
  })

  it('listDetailed splices in mount points as virtual subdirs', async () => {
    const overlay = makeOverlay({ '/a/x.md': 'hi' })
    const fs = new MountFS(new MemoryFS(), [{ prefix: '/chapters', fs: overlay }])
    // Top-level listDetailed should show the /chapters mount point
    const top = await fs.listDetailed('/')
    const names = top.map((e) => e.name).sort()
    expect(names).toContain('chapters')
    const chaptersEntry = top.find((e) => e.name === 'chapters')
    expect(chaptersEntry?.isDir).toBe(true)
    expect(chaptersEntry?.path).toBe('/chapters')
  })

  it('listDetailed under a mount routes to the overlay', async () => {
    const overlay = makeOverlay({ '/a/summary.md': 'sum', '/a/events/1.md': 'e' })
    const fs = new MountFS(new MemoryFS(), [{ prefix: '/chapters', fs: overlay }])
    const inside = await fs.listDetailed('/chapters/a')
    const names = inside.map((e) => e.name).sort()
    expect(names).toEqual(['events', 'summary.md'])
    expect(inside.find((e) => e.name === 'summary.md')?.isDir).toBe(false)
    expect(inside.find((e) => e.name === 'events')?.isDir).toBe(true)
  })

  it('listDetailed recursive includes mount contents', async () => {
    const overlay = makeOverlay({ '/a/summary.md': 'sum' })
    const fs = new MountFS(new MemoryFS(), [{ prefix: '/chapters', fs: overlay }])
    const all = await fs.listDetailed('/', { recursive: true })
    const paths = all.map((e) => e.path).sort()
    expect(paths).toContain('/chapters')
    expect(paths.some((p) => p.includes('chapters/a'))).toBe(true)
  })

  it('rename rejects when src or dst would cross a mount', async () => {
    const fs = new MountFS(new MemoryFS(), [{ prefix: '/chapters', fs: makeOverlay() }])
    await fs.write('/foo.txt', enc.encode('hi'))
    await expect(fs.rename('/foo.txt', '/chapters/a.txt')).rejects.toThrow(
      /cannot rename across or under read-only mounts/,
    )
    await expect(fs.rename('/chapters/x', '/foo.txt')).rejects.toThrow(/cannot rename/)
  })

  it('mkdir/remove/rmdir under a mount throw clearly', async () => {
    const fs = new MountFS(new MemoryFS(), [{ prefix: '/chapters', fs: makeOverlay() }])
    await expect(fs.mkdir('/chapters/new')).rejects.toThrow(/cannot mkdir under read-only mount/)
    await expect(fs.remove('/chapters/x')).rejects.toThrow(/cannot remove under read-only mount/)
    await expect(fs.rmdir('/chapters/x')).rejects.toThrow(/cannot rmdir under read-only mount/)
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
