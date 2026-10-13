import { describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { runFsConformance } from './fs-conformance'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

runFsConformance('MemoryFS', () => new MemoryFS())

describe('MemoryFS — backend-specific', () => {
  it('returned bytes are isolated from internal storage', async () => {
    // Mutating the returned Uint8Array shouldn't corrupt the store.
    const fs = new MemoryFS()
    await fs.write('/k', bytes('hello'))
    const got = await fs.read('/k')
    got[0] = 0xff
    expect(text(await fs.read('/k'))).toBe('hello')
  })

  it('relative paths normalize . and ..', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/a/b', { parents: true })
    await fs.chdir('/a/b')
    await fs.write('../file', bytes('parent'))
    expect(text(await fs.read('/a/file'))).toBe('parent')
    await fs.write('./local', bytes('here'))
    expect(text(await fs.read('/a/b/local'))).toBe('here')
  })

  it('rmdir cannot remove root', async () => {
    const fs = new MemoryFS()
    await expect(fs.rmdir('/')).rejects.toThrow()
  })

  it('rename to itself is a no-op', async () => {
    const fs = new MemoryFS()
    await fs.write('/k', bytes('v'))
    await fs.rename('/k', '/k')
    expect(text(await fs.read('/k'))).toBe('v')
  })
})

describe('MemoryFS — a path is a file or a directory, never both', () => {
  it('mkdir -p below a file refuses, and leaves the file', async () => {
    const fs = new MemoryFS()
    await fs.write('/f', bytes('f'))
    await expect(fs.mkdir('/f/g', { parents: true })).rejects.toMatchObject({ code: 'ENOTDIR' })
    expect(await fs.isFile('/f')).toBe(true)
    expect(await fs.isDir('/f')).toBe(false)
  })

  it('rename follows rename(2)', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d')
    await fs.write('/d/x', bytes('x'))
    await fs.write('/f', bytes('f'))
    await fs.mkdir('/full')
    await fs.write('/full/k', bytes('k'))
    await expect(fs.rename('/d', '/f')).rejects.toMatchObject({ code: 'ENOTDIR' })
    await expect(fs.rename('/f', '/d')).rejects.toMatchObject({ code: 'EISDIR' })
    await expect(fs.rename('/d', '/full')).rejects.toMatchObject({ code: 'ENOTEMPTY' })
    await expect(fs.rename('/d', '/d/e')).rejects.toMatchObject({ code: 'EINVAL' })
    await expect(fs.rename('/d', '/nowhere/d')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(text(await fs.read('/f'))).toBe('f')
    expect(text(await fs.read('/d/x'))).toBe('x')
    expect(text(await fs.read('/full/k'))).toBe('k')
    // a directory replaces an empty one
    await fs.mkdir('/empty')
    await fs.rename('/d', '/empty')
    expect(text(await fs.read('/empty/x'))).toBe('x')
    expect(await fs.exists('/d')).toBe(false)
  })

  it('readMany reads files as given, leaving out the rest', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/a')
    await fs.write('/a/one', bytes('1'))
    await fs.chdir('/a')
    const found = await fs.readMany(['one', '/a/one', '/a', '/nope'])
    expect([...found.keys()]).toEqual(['one', '/a/one'])
    expect(text(found.get('one') as Uint8Array)).toBe('1')
  })
})
