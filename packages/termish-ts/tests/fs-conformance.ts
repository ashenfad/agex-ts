/**
 * `FileSystem` conformance suite — backend-agnostic tests every
 * adapter (Memory, Node, Kvgit, host-defined) must satisfy.
 *
 * Consumers call `runFsConformance(name, makeFs)` from a `*.test.ts`
 * file; the suite registers `describe`/`it` blocks in their test
 * environment.
 *
 * `makeFs` should return a *fresh* `FileSystem` on each call (one
 * per top-level test for isolation).
 */

import { describe, expect, it } from 'vitest'
import type { FileSystem } from '../src/fs/protocol'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
const text = (b: Uint8Array): string => new TextDecoder().decode(b)

export type FsFactory = () => FileSystem | Promise<FileSystem>

export function runFsConformance(name: string, makeFs: FsFactory): void {
  describe(`${name} — FileSystem conformance`, () => {
    describe('cwd / chdir', () => {
      it('cwd defaults to /', async () => {
        const fs = await makeFs()
        expect(fs.getcwd()).toBe('/')
      })

      it('chdir to an existing directory updates cwd', async () => {
        const fs = await makeFs()
        await fs.mkdir('/foo', { parents: true })
        await fs.chdir('/foo')
        expect(fs.getcwd()).toBe('/foo')
      })

      it('chdir to a missing directory throws', async () => {
        const fs = await makeFs()
        await expect(fs.chdir('/nope')).rejects.toThrow()
      })

      it('relative paths resolve against cwd', async () => {
        const fs = await makeFs()
        await fs.mkdir('/base', { parents: true })
        await fs.chdir('/base')
        await fs.write('relfile', bytes('hi'))
        expect(text(await fs.read('/base/relfile'))).toBe('hi')
      })
    })

    describe('read / write round trip', () => {
      it('writes and reads back bytes', async () => {
        const fs = await makeFs()
        await fs.write('/k', bytes('v'))
        expect(text(await fs.read('/k'))).toBe('v')
      })

      it('overwrites with mode w (default)', async () => {
        const fs = await makeFs()
        await fs.write('/k', bytes('v1'))
        await fs.write('/k', bytes('v2'))
        expect(text(await fs.read('/k'))).toBe('v2')
      })

      it('appends with mode a', async () => {
        const fs = await makeFs()
        await fs.write('/k', bytes('v1'))
        await fs.write('/k', bytes('v2'), 'a')
        expect(text(await fs.read('/k'))).toBe('v1v2')
      })

      it('read on missing file throws', async () => {
        const fs = await makeFs()
        await expect(fs.read('/nope')).rejects.toThrow()
      })

      it('read on a directory throws', async () => {
        const fs = await makeFs()
        await fs.mkdir('/dir', { parents: true })
        await expect(fs.read('/dir')).rejects.toThrow()
      })

      it('write to a path whose parent does not exist throws', async () => {
        const fs = await makeFs()
        await expect(fs.write('/nope/k', bytes('v'))).rejects.toThrow()
      })
    })

    describe('exists / isFile / isDir', () => {
      it('reflects file existence', async () => {
        const fs = await makeFs()
        expect(await fs.exists('/k')).toBe(false)
        await fs.write('/k', bytes('v'))
        expect(await fs.exists('/k')).toBe(true)
        expect(await fs.isFile('/k')).toBe(true)
        expect(await fs.isDir('/k')).toBe(false)
      })

      it('reflects directory existence (implicit, via files under it)', async () => {
        const fs = await makeFs()
        await fs.mkdir('/d', { parents: true })
        await fs.write('/d/file', bytes('x'))
        expect(await fs.isDir('/d')).toBe(true)
        expect(await fs.isFile('/d')).toBe(false)
      })
    })

    describe('mkdir', () => {
      it('creates a directory', async () => {
        const fs = await makeFs()
        await fs.mkdir('/newdir')
        expect(await fs.isDir('/newdir')).toBe(true)
      })

      it('errors on existing dir without existOk', async () => {
        const fs = await makeFs()
        await fs.mkdir('/d')
        await expect(fs.mkdir('/d')).rejects.toThrow()
      })

      it('is a no-op on existing dir with existOk', async () => {
        const fs = await makeFs()
        await fs.mkdir('/d')
        await expect(fs.mkdir('/d', { existOk: true })).resolves.toBeUndefined()
      })

      it('errors without parents when intermediate dir is missing', async () => {
        const fs = await makeFs()
        await expect(fs.mkdir('/a/b/c')).rejects.toThrow()
      })

      it('creates intermediates with parents: true', async () => {
        const fs = await makeFs()
        await fs.mkdir('/a/b/c', { parents: true })
        expect(await fs.isDir('/a')).toBe(true)
        expect(await fs.isDir('/a/b')).toBe(true)
        expect(await fs.isDir('/a/b/c')).toBe(true)
      })
    })

    describe('remove / rmdir', () => {
      it('remove deletes a file', async () => {
        const fs = await makeFs()
        await fs.write('/k', bytes('v'))
        await fs.remove('/k')
        expect(await fs.exists('/k')).toBe(false)
      })

      it('remove on a missing file throws', async () => {
        const fs = await makeFs()
        await expect(fs.remove('/nope')).rejects.toThrow()
      })

      it('remove on a directory throws', async () => {
        const fs = await makeFs()
        await fs.mkdir('/d')
        await expect(fs.remove('/d')).rejects.toThrow()
      })

      it('rmdir deletes an empty directory', async () => {
        const fs = await makeFs()
        await fs.mkdir('/d')
        await fs.rmdir('/d')
        expect(await fs.exists('/d')).toBe(false)
      })

      it('rmdir errors on a non-empty directory', async () => {
        const fs = await makeFs()
        await fs.mkdir('/d')
        await fs.write('/d/file', bytes('x'))
        await expect(fs.rmdir('/d')).rejects.toThrow()
      })
    })

    describe('rename', () => {
      it('renames a file', async () => {
        const fs = await makeFs()
        await fs.write('/a', bytes('v'))
        await fs.rename('/a', '/b')
        expect(await fs.exists('/a')).toBe(false)
        expect(text(await fs.read('/b'))).toBe('v')
      })

      it('renames a directory and its contents', async () => {
        const fs = await makeFs()
        await fs.mkdir('/old', { parents: true })
        await fs.write('/old/file', bytes('hi'))
        await fs.mkdir('/old/sub', { parents: true })
        await fs.write('/old/sub/inner', bytes('inner'))
        await fs.rename('/old', '/new')
        expect(await fs.exists('/old')).toBe(false)
        expect(text(await fs.read('/new/file'))).toBe('hi')
        expect(text(await fs.read('/new/sub/inner'))).toBe('inner')
        expect(await fs.isDir('/new/sub')).toBe(true)
      })

      it('rename on a missing source throws', async () => {
        const fs = await makeFs()
        await expect(fs.rename('/nope', '/new')).rejects.toThrow()
      })
    })

    describe('list / listDetailed', () => {
      it('list returns direct children', async () => {
        const fs = await makeFs()
        await fs.mkdir('/d', { parents: true })
        await fs.write('/d/a', bytes('1'))
        await fs.write('/d/b', bytes('2'))
        await fs.mkdir('/d/sub', { parents: true })
        await fs.write('/d/sub/inner', bytes('3'))
        const got = await fs.list('/d')
        expect(got.sort()).toEqual(['a', 'b', 'sub'])
      })

      it('list recursive returns all descendants', async () => {
        const fs = await makeFs()
        await fs.mkdir('/d', { parents: true })
        await fs.write('/d/a', bytes('1'))
        await fs.mkdir('/d/sub', { parents: true })
        await fs.write('/d/sub/inner', bytes('2'))
        const got = await fs.list('/d', { recursive: true })
        expect(got.sort()).toEqual(['a', 'sub', 'sub/inner'])
      })

      it('listDetailed reports size + isDir', async () => {
        const fs = await makeFs()
        await fs.mkdir('/d', { parents: true })
        await fs.write('/d/file', bytes('hello'))
        await fs.mkdir('/d/sub', { parents: true })
        const got = await fs.listDetailed('/d')
        expect(got.length).toBe(2)
        const file = got.find((e) => e.name === 'file')
        const sub = got.find((e) => e.name === 'sub')
        expect(file?.isDir).toBe(false)
        expect(file?.size).toBe(5)
        expect(sub?.isDir).toBe(true)
      })

      it('list on a missing path throws', async () => {
        const fs = await makeFs()
        await expect(fs.list('/nope')).rejects.toThrow()
      })
    })

    describe('stat', () => {
      it('returns size + isDir for a file', async () => {
        const fs = await makeFs()
        await fs.write('/f', bytes('hello'))
        const s = await fs.stat('/f')
        expect(s.size).toBe(5)
        expect(s.isDir).toBe(false)
        expect(typeof s.createdAt).toBe('string')
        expect(typeof s.modifiedAt).toBe('string')
      })

      it('returns isDir true for a directory', async () => {
        const fs = await makeFs()
        await fs.mkdir('/d')
        const s = await fs.stat('/d')
        expect(s.isDir).toBe(true)
        expect(s.size).toBe(0)
      })

      it('throws on a missing path', async () => {
        const fs = await makeFs()
        await expect(fs.stat('/nope')).rejects.toThrow()
      })
    })
  })
}
