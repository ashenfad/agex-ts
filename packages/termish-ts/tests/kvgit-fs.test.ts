import { Staged, VersionedKV } from 'kvgit-ts'
import { Memory } from 'kvgit-ts/backends/memory'
import { describe, expect, it } from 'vitest'
import {
  KvgitFS,
  fileRecordDecoder,
  fileRecordEncoder,
  polymorphicDecoder,
  polymorphicEncoder,
} from '../src/fs/kvgit'
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

describe('polymorphic encoder/decoder', () => {
  it('round-trips a FileRecord (file)', () => {
    const rec = {
      isDir: false,
      createdAt: '2026-05-06T00:00:00.000Z',
      modifiedAt: '2026-05-06T00:00:00.000Z',
      content: new TextEncoder().encode('hello'),
    }
    const bytes = polymorphicEncoder(rec)
    const decoded = polymorphicDecoder(bytes) as typeof rec
    expect(decoded.isDir).toBe(false)
    expect(decoded.createdAt).toBe(rec.createdAt)
    expect(decoded.modifiedAt).toBe(rec.modifiedAt)
    expect(new TextDecoder().decode(decoded.content)).toBe('hello')
  })

  it('round-trips a FileRecord (dir)', () => {
    const rec = {
      isDir: true,
      createdAt: '2026-05-06T00:00:00.000Z',
      modifiedAt: '2026-05-06T00:00:00.000Z',
      content: new Uint8Array(0),
    }
    const bytes = polymorphicEncoder(rec)
    const decoded = polymorphicDecoder(bytes) as typeof rec
    expect(decoded.isDir).toBe(true)
    expect(decoded.content.byteLength).toBe(0)
  })

  it('round-trips arbitrary JSON values (object)', () => {
    const value = { name: 'agex', branches: { main: 'abc123' }, count: 42 }
    const bytes = polymorphicEncoder(value)
    expect(bytes[0]).toBe(0x4a) // 'J'
    expect(polymorphicDecoder(bytes)).toEqual(value)
  })

  it('round-trips arbitrary JSON values (array, primitive)', () => {
    expect(polymorphicDecoder(polymorphicEncoder([1, 2, 3]))).toEqual([1, 2, 3])
    expect(polymorphicDecoder(polymorphicEncoder('hello'))).toBe('hello')
    expect(polymorphicDecoder(polymorphicEncoder(null))).toBe(null)
    expect(polymorphicDecoder(polymorphicEncoder(true))).toBe(true)
  })

  it('rejects an empty record on decode', () => {
    expect(() => polymorphicDecoder(new Uint8Array(0))).toThrow(/empty record/)
  })

  it('rejects an unknown type tag on decode', () => {
    expect(() => polymorphicDecoder(new Uint8Array([0x99]))).toThrow(/unknown record tag/)
  })

  it('routes FileRecord-shape values through the file encoder, not JSON', () => {
    // The structural check requires all four FileRecord keys (isDir,
    // createdAt, modifiedAt, content) so JSON values that happen to
    // carry a Uint8Array under `content` are not misrouted.
    const rec = {
      isDir: false,
      createdAt: '2026-05-06T00:00:00.000Z',
      modifiedAt: '2026-05-06T00:00:00.000Z',
      content: new Uint8Array([1, 2, 3]),
    }
    const bytes = polymorphicEncoder(rec)
    expect(bytes[0]).toBe(0x46) // 'F'
  })

  it('treats a partial-shape value (Uint8Array content but missing other fields) as JSON', () => {
    // Defends against the false-positive Gemini flagged: a state value
    // that has `content: <bytes>` but no createdAt/modifiedAt/isDir
    // would crash inside fileRecordEncoder if it slipped through. The
    // tightened predicate routes it to the JSON branch instead, where
    // JSON.stringify drops the Uint8Array harmlessly (serializes to
    // `{}`). The point is no crash on encode.
    const partial = { content: new Uint8Array([1, 2, 3]), tag: 'partial' }
    const bytes = polymorphicEncoder(partial)
    expect(bytes[0]).toBe(0x4a) // 'J' — routed as JSON, not file
  })

  it('shares one Staged for both shapes — atomic mixed-keys commit', async () => {
    // The unified-substrate scenario: one Staged with the polymorphic
    // encoder accepting both file records (via KvgitFS writes) and
    // arbitrary JSON state values (via direct staged.set). One commit
    // captures both atomically, which is the whole point.
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    const staged = new Staged(vk, {
      encoder: polymorphicEncoder,
      decoder: polymorphicDecoder,
    })
    const fs = new KvgitFS(staged)

    await fs.write('/data.txt', new TextEncoder().encode('payload'))
    staged.set('cache/answer', { kind: 'success', value: 42 })

    expect(staged.hasChanges).toBe(true)
    const result = await staged.commit()
    expect(result.merged).toBe(true)
    expect(staged.hasChanges).toBe(false)

    // Both visible after commit through their respective surfaces.
    expect(new TextDecoder().decode(await fs.read('/data.txt'))).toBe('payload')
    expect(await staged.get('cache/answer')).toEqual({ kind: 'success', value: 42 })
  })
})
