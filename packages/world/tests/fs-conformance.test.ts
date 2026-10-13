import { fsConformanceCases } from '@agex-ts/termish/conformance'
import { describe, expect, it } from 'vitest'
import { WorldFS } from '../src/index'
import { BACKENDS, newStore } from './backends'

/** Everything a filesystem holds: each path's metadata, and each
 *  file's content. */
async function tree(fs: WorldFS): Promise<unknown[]> {
  const out: unknown[] = []
  for (const info of await fs.listDetailed('/', { recursive: true })) {
    out.push(info, info.isDir ? null : [...(await fs.read(info.path))])
  }
  return out
}

describe.each(BACKENDS)('WorldFS on %s', (_, make) => {
  describe('passes the termish conformance kit', () => {
    for (const c of fsConformanceCases) {
      it(`${c.group}: ${c.name}`, async () => {
        const store = await newStore(make)
        const wt = await store.repo.worktree('kit', { create: true })
        await c.run(new WorldFS(wt))
      })
    }
  })

  describe('commits what each case left, and reads it back the same', () => {
    for (const c of fsConformanceCases) {
      it(`${c.group}: ${c.name}`, async () => {
        const store = await newStore(make)
        const wt = await store.repo.worktree('kit', { create: true })
        const fs = new WorldFS(wt)
        await c.run(fs).catch(() => undefined)
        const pending = await tree(fs)
        await wt.commit()
        expect(await tree(new WorldFS(await store.repo.worktree('kit')))).toEqual(pending)
      })
    }
  })
})
