import { Staged, VersionedKV } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { KvgitFS, polymorphicDecoder, polymorphicEncoder } from '@agex-ts/termish/fs/kvgit'
import { MemoryFS } from '@agex-ts/termish/fs/memory'
import type { FileSystem } from '@agex-ts/termish/fs/protocol'
import { describe, expect, it } from 'vitest'
import { VfsManager } from '../src/vfs'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Memory factory: a fresh `MemoryFS` per session, isolated. Mirrors
 *  what agex-ts wires up for `{ fs: { type: 'memory' } }`. */
const memoryFactory = async (): Promise<FileSystem> => new MemoryFS()

describe('VfsManager — memory backing', () => {
  it('returns the same instance for the same session', async () => {
    const m = new VfsManager(memoryFactory)
    const a = await m.fs('alice')
    const b = await m.fs('alice')
    expect(a).toBe(b)
  })

  it('isolates files between sessions', async () => {
    const m = new VfsManager(memoryFactory)
    const alice = await m.fs('alice')
    const bob = await m.fs('bob')
    await alice.write('/note.txt', enc.encode('hello from alice'))
    expect(await alice.exists('/note.txt')).toBe(true)
    expect(await bob.exists('/note.txt')).toBe(false)
  })

  it('persists writes across calls within a session', async () => {
    const m = new VfsManager(memoryFactory)
    const fs = await m.fs('alice')
    await fs.write('/scratch.txt', enc.encode('persisted'))
    const reread = await (await m.fs('alice')).read('/scratch.txt')
    expect(dec.decode(reread)).toBe('persisted')
  })
})

describe('VfsManager — kvgit backing', () => {
  it('uses the per-session Staged so files participate in the substrate', async () => {
    // Build a tiny per-session resolver inline: each session id is
    // a fresh Memory + VersionedKV + Staged with the polymorphic
    // encoder. agex-ts's connectState produces this same shape.
    const stages = new Map<string, Staged>()
    const factory = async (session: string): Promise<FileSystem> => {
      let staged = stages.get(session)
      if (staged === undefined) {
        const vk = await VersionedKV.open(new Memory())
        staged = new Staged(vk, { encoder: polymorphicEncoder, decoder: polymorphicDecoder })
        stages.set(session, staged)
      }
      return new KvgitFS(staged)
    }
    const m = new VfsManager(factory)

    const fs = await m.fs('alice')
    await fs.write('/scratch.txt', enc.encode('lives in kvgit'))
    expect(await fs.exists('/scratch.txt')).toBe(true)

    // The session's Staged shows the buffered file write.
    const aliceStaged = stages.get('alice')
    if (aliceStaged === undefined) throw new Error('alice staged should exist')
    expect(aliceStaged.hasChanges).toBe(true)
    await aliceStaged.commit()
    expect(aliceStaged.hasChanges).toBe(false)

    // A separate session is its own substrate.
    const bobFs = await m.fs('bob')
    expect(await bobFs.exists('/scratch.txt')).toBe(false)
  })
})
