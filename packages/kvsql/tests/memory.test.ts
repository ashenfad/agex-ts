import { describe, expect, it } from 'vitest'
import { MemoryDirectory, MemoryFile } from '../src/index'

const bytes = (...xs: number[]) => new Uint8Array(xs)

function readAll(file: { size(): number; read(into: Uint8Array, at: number): number }) {
  const out = new Uint8Array(file.size())
  file.read(out, 0)
  return out
}

describe('MemoryFile', () => {
  it('reads what was written, short at the end, and fills gaps with zeros', () => {
    const f = new MemoryFile()
    f.write(bytes(1, 2, 3), 0)
    f.write(bytes(9), 5)
    expect(f.size()).toBe(6)
    expect(readAll(f)).toEqual(bytes(1, 2, 3, 0, 0, 9))
    const into = new Uint8Array(4).fill(7)
    expect(f.read(into, 4)).toBe(2)
    expect(into).toEqual(bytes(0, 9, 7, 7))
    expect(f.read(into, 100)).toBe(0)
  })

  it('truncates and grows, and a gap after a truncate reads as zeros', () => {
    const f = new MemoryFile()
    f.write(bytes(1, 2, 3, 4), 0)
    f.truncate(1)
    expect(readAll(f)).toEqual(bytes(1))
    f.write(bytes(5), 3)
    expect(readAll(f)).toEqual(bytes(1, 0, 0, 5))
    f.truncate(6)
    expect(readAll(f)).toEqual(bytes(1, 0, 0, 5, 0, 0))
  })

  it('refuses use after close', () => {
    const f = new MemoryFile()
    f.close()
    expect(() => f.size()).toThrow(/closed/)
  })
})

describe('MemoryDirectory', () => {
  it('keeps files across close and reopen, and copies them in and out as images', async () => {
    const dir = new MemoryDirectory()
    expect(await dir.exists('a')).toBe(false)
    const a = await dir.open('a')
    a.write(bytes(1, 2), 0)
    a.close()
    expect(await dir.exists('a')).toBe(true)
    expect(readAll(await dir.open('a'))).toEqual(bytes(1, 2))

    const copy = new MemoryDirectory(dir.image())
    expect(copy.names()).toEqual(['a'])
    const b = await copy.open('a')
    b.write(bytes(3), 0)
    expect(dir.image().get('a')).toEqual(bytes(1, 2))
  })

  it('opens a file once at a time and refuses to delete an open file', async () => {
    const dir = new MemoryDirectory()
    const f = await dir.open('a')
    await expect(dir.open('a')).rejects.toThrow(/already open/)
    await expect(dir.delete('a')).rejects.toThrow(/open/)
    f.close()
    await dir.delete('a')
    await dir.delete('a')
    expect(await dir.exists('a')).toBe(false)
  })
})
