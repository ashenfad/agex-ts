import { Staged, VersionedKV } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { polymorphicDecoder, polymorphicEncoder } from '@agex-ts/termish/fs/kvgit'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BRANCH, METADATA_KEY, Metadata } from '../src/metadata'

async function makeStaged(): Promise<Staged> {
  const vk = await VersionedKV.open(new Memory())
  return new Staged(vk, { encoder: polymorphicEncoder, decoder: polymorphicDecoder })
}

describe('Metadata', () => {
  it('defaults — fresh state has main / no branches / empty index', () => {
    const m = new Metadata()
    expect(m.current).toBe(DEFAULT_BRANCH)
    expect(m.branches.size).toBe(0)
    expect(m.index.size).toBe(0)
    expect(m.head).toBeNull()
  })

  it('head reflects the current branch tip', () => {
    const m = new Metadata({
      current: 'feature',
      branches: { main: 'aaaaaaa', feature: 'bbbbbbb' },
    })
    expect(m.head).toBe('bbbbbbb')
  })

  it('head is null when current is unborn (no entry in branches)', () => {
    const m = new Metadata({ current: 'feature', branches: { main: 'aaaaaaa' } })
    expect(m.head).toBeNull()
  })

  it('round-trips through Staged: save then load', async () => {
    const s = await makeStaged()
    const m = new Metadata({
      current: 'feature',
      branches: { main: '1111111', feature: '2222222' },
      index: ['f:/a', 'f:/b', 'f:/c'],
    })
    m.save(s)
    await s.commit()

    const loaded = await Metadata.load(s)
    expect(loaded.current).toBe('feature')
    expect([...loaded.branches.entries()].sort()).toEqual([
      ['feature', '2222222'],
      ['main', '1111111'],
    ])
    expect([...loaded.index].sort()).toEqual(['f:/a', 'f:/b', 'f:/c'])
    expect(loaded.head).toBe('2222222')
  })

  it('load on a fresh store returns defaults', async () => {
    const s = await makeStaged()
    const loaded = await Metadata.load(s)
    expect(loaded.current).toBe(DEFAULT_BRANCH)
    expect(loaded.branches.size).toBe(0)
    expect(loaded.index.size).toBe(0)
  })

  it('load is tolerant of partial / malformed blobs', async () => {
    const s = await makeStaged()
    // Simulate an older / partial blob: only `current` set.
    s.set(METADATA_KEY, { current: 'odd' })
    await s.commit()
    const loaded = await Metadata.load(s)
    expect(loaded.current).toBe('odd')
    expect(loaded.branches.size).toBe(0)
    expect(loaded.index.size).toBe(0)
  })

  it('load coerces missing current to DEFAULT_BRANCH', async () => {
    const s = await makeStaged()
    // Blob with branches but no current — older shape from before
    // current became required.
    s.set(METADATA_KEY, { branches: { main: 'abc1234' } })
    await s.commit()
    const loaded = await Metadata.load(s)
    expect(loaded.current).toBe(DEFAULT_BRANCH)
    expect(loaded.branches.get('main')).toBe('abc1234')
  })

  it('save serialises index as a sorted array (stable round-trips)', async () => {
    const s = await makeStaged()
    const m = new Metadata({ index: ['f:/c', 'f:/a', 'f:/b'] })
    m.save(s)
    const blob = await s.get<{ index: string[] }>(METADATA_KEY)
    expect(blob?.index).toEqual(['f:/a', 'f:/b', 'f:/c'])
  })

  it('METADATA_KEY does not collide with KvgitFS f:/d: prefixes', () => {
    expect(METADATA_KEY.startsWith('f:')).toBe(false)
    expect(METADATA_KEY.startsWith('d:')).toBe(false)
  })
})
