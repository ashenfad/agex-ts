import { describe, expect, it } from 'vitest'
import { FsConformanceError, checkFileSystem, fsConformanceCases } from '../src/conformance'
import { MemoryFS } from '../src/fs/memory'

/** A MemoryFS whose append mode overwrites, as a careless adapter might. */
class NoAppendFS extends MemoryFS {
  override async write(path: string, content: Uint8Array): Promise<void> {
    return super.write(path, content, 'w')
  }
}

describe('checkFileSystem', () => {
  it('resolves for a conforming filesystem', async () => {
    await expect(checkFileSystem(() => new MemoryFS())).resolves.toBeUndefined()
  })

  it('names the case, the method and the expectation on a violation', async () => {
    const err = await checkFileSystem(() => new NoAppendFS()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FsConformanceError)
    expect((err as Error).message).toBe(
      `read / write round trip > appends with mode a: write: mode 'a' appends; expected bytes "v1v2", got bytes "v2"`,
    )
  })

  it('reports a method that throws on a valid call, keeping the error as cause', async () => {
    const boom = new Error('backend down')
    class BrokenFS extends MemoryFS {
      override async stat(path: string) {
        if (path === '/f') throw boom
        return super.stat(path)
      }
    }
    const err = await checkFileSystem(() => new BrokenFS()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FsConformanceError)
    expect((err as Error).message).toMatch(/^stat > returns size \+ isDir for a file: threw/)
    expect((err as Error).cause).toBe(boom)
  })
})

describe('the stat timestamps check', () => {
  it('refuses a timestamp that is not ISO 8601 UTC', async () => {
    for (const bad of [
      'unknown',
      '2026-10-13 01:47:08',
      '2026-10-13T01:47:08+02:00',
      '2026-13-45T99:99:99Z',
    ]) {
      class OddTimesFS extends MemoryFS {
        override async stat(path: string) {
          return { ...(await super.stat(path)), createdAt: bad }
        }
      }
      const err = await checkFileSystem(() => new OddTimesFS()).catch((e: unknown) => e)
      expect(err, bad).toBeInstanceOf(FsConformanceError)
      expect((err as Error).message).toContain('createdAt should be an ISO 8601 UTC timestamp')
    }
  })
})

describe('fsConformanceCases', () => {
  it('names each case uniquely within its group', () => {
    const keys = fsConformanceCases.map((c) => `${c.group} > ${c.name}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
