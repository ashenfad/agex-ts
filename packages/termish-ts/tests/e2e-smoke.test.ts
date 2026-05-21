/**
 * End-to-end smoke: run a realistic shell pipeline against each FS
 * adapter and prove they all behave identically.
 *
 * If a builtin or interpreter regression specifically affects one
 * backend (path semantics, list ordering, async ordering), this
 * suite catches it before CI.
 */

import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { Staged, VersionedKV } from '@agex-ts/kvgit'
import { Memory as KvgitMemoryStore } from '@agex-ts/kvgit/backends/memory'
import { afterEach, describe, expect, it } from 'vitest'
import { KvgitFS, fileRecordDecoder, fileRecordEncoder } from '../src/fs/kvgit'
import { MemoryFS } from '../src/fs/memory'
import type { FileSystem } from '../src/fs/protocol'
import { RealFS } from '../src/fs/real'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

const tempRoots: string[] = []
afterEach(async () => {
  while (tempRoots.length > 0) {
    const r = tempRoots.pop() as string
    await fsp.rm(r, { recursive: true, force: true })
  }
})

type Backend = { name: string; make: () => Promise<FileSystem> }

const backends: Backend[] = [
  { name: 'MemoryFS', make: async () => new MemoryFS() },
  {
    name: 'RealFS',
    make: async () => {
      const root = await fsp.mkdtemp(nodePath.join(tmpdir(), 'e2e-'))
      tempRoots.push(root)
      return new RealFS({ root })
    },
  },
  {
    name: 'KvgitFS',
    make: async () => {
      const store = new KvgitMemoryStore()
      const vk = await VersionedKV.open(store)
      const staged = new Staged(vk, {
        encoder: fileRecordEncoder,
        decoder: fileRecordDecoder,
      })
      return new KvgitFS(staged)
    },
  },
]

for (const { name, make } of backends) {
  describe(`E2E pipeline — ${name}`, () => {
    it('seeds, transforms, archives, and round-trips', async () => {
      const fs = await make()
      // Seed a small project tree.
      await fs.mkdir('/proj/src', { parents: true })
      await fs.write('/proj/README.md', bytes('# project\n\nhello world\n'))
      await fs.write('/proj/src/a.ts', bytes('export const a = 1\n'))
      await fs.write('/proj/src/b.ts', bytes('export const b = 2\n'))
      await fs.write('/proj/src/c.txt', bytes('not source\n'))

      // grep + wc through a pipeline
      const lineCount = await execute("grep -r 'export' /proj/src | wc -l", fs)
      expect(lineCount.trim()).toBe('2')

      // find -name | xargs cat
      const concatenated = await execute("find /proj/src -name '*.ts' | xargs cat", fs)
      expect(concatenated).toContain('export const a = 1')
      expect(concatenated).toContain('export const b = 2')

      // sed in-place edit
      await execute("sed -i 's/hello world/HELLO/' /proj/README.md", fs)
      expect(dec.decode(await fs.read('/proj/README.md'))).toContain('HELLO')

      // tar round-trip with gzip + extract elsewhere
      await execute('tar -czf /proj.tgz /proj', fs)
      await fs.mkdir('/restore')
      await execute('tar -xf /proj.tgz -C /restore', fs)
      expect(dec.decode(await fs.read('/restore/proj/src/a.ts'))).toBe('export const a = 1\n')
      expect(dec.decode(await fs.read('/restore/proj/README.md'))).toContain('HELLO')

      // diff between original and restored README — should match.
      const diffOut = await execute('diff /proj/README.md /restore/proj/README.md', fs)
      expect(diffOut).toBe('')

      // sort + uniq pipeline
      await fs.write('/lines.txt', bytes('banana\napple\nbanana\ncherry\napple\n'))
      const dedup = await execute('sort /lines.txt | uniq', fs)
      expect(dedup).toBe('apple\nbanana\ncherry\n')

      // && / || control flow
      const branched = await execute('echo first && echo second || echo skipped', fs)
      expect(branched).toBe('first\nsecond\n')

      // Output redirection writes to FS, returns nothing on stdout.
      const redirected = await execute('echo logged > /log.txt', fs)
      expect(redirected).toBe('')
      expect(dec.decode(await fs.read('/log.txt'))).toBe('logged\n')

      // Append + cat
      await execute('echo more >> /log.txt', fs)
      expect(dec.decode(await fs.read('/log.txt'))).toBe('logged\nmore\n')

      // zip round-trip
      await execute('zip -r /proj.zip /proj', fs)
      await fs.mkdir('/zrestore')
      await execute('unzip -d /zrestore /proj.zip', fs)
      expect(dec.decode(await fs.read('/zrestore/proj/src/b.ts'))).toBe('export const b = 2\n')
    })

    it('honors AbortSignal mid-pipeline', async () => {
      const fs = await make()
      await fs.write('/a.txt', bytes('hi'))
      const controller = new AbortController()
      controller.abort()
      await expect(execute('cat /a.txt', fs, { signal: controller.signal })).rejects.toThrow()
    })
  })
}
