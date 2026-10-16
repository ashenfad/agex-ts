import { describe, expect, it } from 'vitest'
import { CrashingDirectory, MemoryDirectory, SimulatedCrash } from '../src/index'

const bytes = (...xs: number[]) => new Uint8Array(xs)

async function setup() {
  const mem = new MemoryDirectory()
  const dir = new CrashingDirectory(mem)
  return { mem, dir, a: await dir.open('a'), b: await dir.open('b') }
}

describe('CrashingDirectory', () => {
  it('passes operations through and counts them across files', async () => {
    const { mem, dir, a, b } = await setup()
    a.write(bytes(1), 0)
    b.write(bytes(2, 3), 0)
    b.truncate(1)
    a.sync()
    expect(dir.ops).toEqual({ write: 2, truncate: 1, sync: 1 })
    expect(mem.image().get('a')).toEqual(bytes(1))
    expect(mem.image().get('b')).toEqual(bytes(2))
    expect(b.size()).toBe(1)
    expect(await dir.exists('a')).toBe(true)
  })

  it('crashes at the nth write, leaving the files as they were', async () => {
    const { mem, dir, a, b } = await setup()
    a.write(bytes(1), 0)
    dir.crashAt({ op: 'write', n: 2 })
    a.write(bytes(2), 1)
    expect(() => b.write(bytes(3), 0)).toThrow(SimulatedCrash)
    expect(dir.crashed).toEqual({ op: 'write', n: 2 })
    expect(mem.image().get('a')).toEqual(bytes(1, 2))
    expect(mem.image().get('b')).toEqual(bytes())
  })

  it('lands a torn write in part', async () => {
    const { mem, dir, a } = await setup()
    a.write(bytes(0, 0, 0, 0), 0)
    dir.crashAt({ op: 'write', n: 1, torn: 2 })
    expect(() => a.write(bytes(1, 2, 3, 4), 0)).toThrow(SimulatedCrash)
    expect(mem.image().get('a')).toEqual(bytes(1, 2, 0, 0))
  })

  it('crashes at a truncate or sync before it happens', async () => {
    const { mem, dir, a } = await setup()
    a.write(bytes(1, 2), 0)
    dir.crashAt({ op: 'truncate', n: 1 })
    expect(() => a.truncate(0)).toThrow(SimulatedCrash)
    expect(mem.image().get('a')).toEqual(bytes(1, 2))

    const again = await setup()
    again.dir.crashAt({ op: 'sync', n: 2 })
    again.a.sync()
    expect(() => again.b.sync()).toThrow(SimulatedCrash)
    expect(again.dir.crashed).toEqual({ op: 'sync', n: 2 })
  })

  it('stays dead after a crash, except that files still close', async () => {
    const { mem, dir, a } = await setup()
    a.write(bytes(1), 0)
    dir.crashAt({ op: 'sync', n: 1 })
    expect(() => a.sync()).toThrow(SimulatedCrash)
    expect(() => a.write(bytes(9), 0)).toThrow(SimulatedCrash)
    expect(() => a.truncate(0)).toThrow(SimulatedCrash)
    expect(() => a.read(new Uint8Array(1), 0)).toThrow(SimulatedCrash)
    expect(() => a.size()).toThrow(SimulatedCrash)
    await expect(dir.open('c')).rejects.toThrow(SimulatedCrash)
    await expect(dir.exists('a')).rejects.toThrow(SimulatedCrash)
    expect(() => dir.crashAt({ op: 'write', n: 1 })).toThrow(SimulatedCrash)
    a.close()
    // The underlying file was released.
    ;(await mem.open('a')).close()
    expect(mem.image().get('a')).toEqual(bytes(1))
  })

  it('refuses a crash point before the first operation', () => {
    const dir = new CrashingDirectory(new MemoryDirectory())
    expect(() => dir.crashAt({ op: 'write', n: 0 })).toThrow(RangeError)
  })
})
