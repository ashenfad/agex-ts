import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import * as nodePath from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RealFS } from '../src/fs/real'
import { runFsConformance } from './fs-conformance'

const tempRoots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await fsp.mkdtemp(nodePath.join(tmpdir(), 'realfs-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const r = tempRoots.pop() as string
    await fsp.rm(r, { recursive: true, force: true })
  }
})

runFsConformance('RealFS', async () => {
  const root = await makeRoot()
  return new RealFS({ root })
})

describe('RealFS — sandbox semantics', () => {
  it('rejects relative root paths', () => {
    expect(() => new RealFS({ root: 'relative/path' })).toThrow()
  })

  it('virtual paths cannot escape the root via ..', async () => {
    const root = await makeRoot()
    await fsp.writeFile(nodePath.join(root, 'inside.txt'), 'in')
    const outside = nodePath.join(root, '..', 'outside.txt')
    await fsp.writeFile(outside, 'out').catch(() => {
      // already exists or permission — fine; we just need a target.
    })
    const fs = new RealFS({ root })
    // resolve() collapses `..` against `/`, so we end up at `/outside.txt`,
    // which maps to `${root}/outside.txt` — never outside `root`.
    expect(await fs.exists('/../outside.txt')).toBe(false)
    expect(await fs.exists('/inside.txt')).toBe(true)
    await fsp.rm(outside, { force: true })
  })

  it('writes hit the host filesystem', async () => {
    const root = await makeRoot()
    const fs = new RealFS({ root })
    await fs.write('/note.txt', new TextEncoder().encode('hello'))
    const real = await fsp.readFile(nodePath.join(root, 'note.txt'), 'utf8')
    expect(real).toBe('hello')
  })

  it('listDetailed paths reflect the queried prefix', async () => {
    const root = await makeRoot()
    const fs = new RealFS({ root })
    await fs.mkdir('/d', { parents: true })
    await fs.write('/d/a', new Uint8Array([1]))
    const got = await fs.listDetailed('/d')
    expect(got.find((e) => e.name === 'a')?.path).toBe('/d/a')
  })
})
