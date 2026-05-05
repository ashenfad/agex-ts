import { Staged, VersionedKV } from 'kvgit-ts'
import { Memory } from 'kvgit-ts/backends/memory'
import { describe, expect, it } from 'vitest'
import { KvgitFS, fileRecordDecoder, fileRecordEncoder } from '../src/fs/kvgit'
import { runFsConformance } from './fs-conformance'

async function makeFs(): Promise<KvgitFS> {
  const store = new Memory()
  const vk = await VersionedKV.open(store)
  const staged = new Staged(vk, {
    encoder: fileRecordEncoder,
    decoder: fileRecordDecoder,
  })
  return new KvgitFS(staged)
}

runFsConformance('KvgitFS', makeFs)

describe('KvgitFS — kvgit integration', () => {
  it('writes accumulate in staging until commit', async () => {
    const fs = await makeFs()
    const startCommit = fs.staged.currentCommit
    await fs.write('/note', new TextEncoder().encode('hi'))
    expect(fs.staged.hasChanges).toBe(true)
    expect(fs.staged.currentCommit).toBe(startCommit)
    await fs.staged.commit()
    expect(fs.staged.hasChanges).toBe(false)
    expect(fs.staged.currentCommit).not.toBe(startCommit)
  })

  it('survives a commit + reopen with the same VersionedKV', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    const staged = new Staged(vk, {
      encoder: fileRecordEncoder,
      decoder: fileRecordDecoder,
    })
    const fs1 = new KvgitFS(staged)
    await fs1.write('/persist', new TextEncoder().encode('alpha'))
    await fs1.staged.commit()

    // Re-open: a fresh Staged on the same vk sees the committed file.
    const staged2 = new Staged(vk, {
      encoder: fileRecordEncoder,
      decoder: fileRecordDecoder,
    })
    const fs2 = new KvgitFS(staged2)
    expect(await fs2.exists('/persist')).toBe(true)
    expect(new TextDecoder().decode(await fs2.read('/persist'))).toBe('alpha')
  })

  it('exposes the underlying Staged via the staged getter', async () => {
    const fs = await makeFs()
    expect(fs.staged).toBeDefined()
    expect(typeof fs.staged.commit).toBe('function')
  })
})
