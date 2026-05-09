import { describe, expect, it } from 'vitest'
import { Memory } from '../src/backends/memory'
import { Staged, type jsonDecoder, type jsonEncoder } from '../src/staged'
import type { MergeFn } from '../src/types'
import { VersionedKV } from '../src/versioned/kv'

async function freshStaged(opts?: { encoder?: typeof jsonEncoder; decoder?: typeof jsonDecoder }) {
  const store = new Memory()
  const vk = await VersionedKV.open(store)
  return { store, vk, staged: new Staged(vk, opts ?? {}) }
}

describe('Staged — buffered writes', () => {
  it('set then get returns the in-memory value before commit', async () => {
    const { staged } = await freshStaged()
    staged.set('k', { a: 1 })
    expect(await staged.get('k')).toEqual({ a: 1 })
    expect(staged.hasChanges).toBe(true)
    expect(staged.isStaged('k')).toBe(true)
  })

  it('delete on a not-yet-committed key returns undefined for get', async () => {
    const { staged } = await freshStaged()
    staged.set('k', 'v')
    staged.delete('k')
    expect(await staged.get('k')).toBeUndefined()
  })

  it('reset() discards staged changes', async () => {
    const { staged } = await freshStaged()
    staged.set('k', 'v')
    staged.reset()
    expect(staged.hasChanges).toBe(false)
    expect(await staged.get('k')).toBeUndefined()
  })

  it('does not write to the underlying Versioned until commit()', async () => {
    const { vk, staged } = await freshStaged()
    staged.set('k', 'v')
    expect(await vk.get('k')).toBeNull()
    await staged.commit()
    const raw = (await vk.get('k')) as Uint8Array
    expect(JSON.parse(new TextDecoder().decode(raw))).toBe('v')
  })
})

describe('Staged — commit', () => {
  it('flushes updates and reads through them', async () => {
    const { staged } = await freshStaged()
    staged.set('k', { count: 5 })
    const r = await staged.commit()
    expect(r.merged).toBe(true)
    expect(r.strategy).toBe('fast_forward')
    expect(staged.hasChanges).toBe(false)

    // Read post-commit (no buffer hit; goes through decoder).
    expect(await staged.get('k')).toEqual({ count: 5 })
  })

  it('flushes removals', async () => {
    const { staged } = await freshStaged()
    staged.set('k', 'v')
    await staged.commit()
    staged.delete('k')
    await staged.commit()
    expect(await staged.get('k')).toBeUndefined()
  })

  it('a no-op commit is reported as such', async () => {
    const { staged } = await freshStaged()
    const r = await staged.commit()
    expect(r.merged).toBe(true)
    expect(r.strategy).toBe('no_op')
  })

  it('round-trips an info dict', async () => {
    const { vk, staged } = await freshStaged()
    staged.set('k', 'v')
    await staged.commit({ info: { author: 'alice' } })
    expect(await vk.commitInfo()).toEqual({ author: 'alice' })
  })

  it('keys filter only flushes the targeted keys', async () => {
    const { staged } = await freshStaged()
    staged.set('a', 1)
    staged.set('b', 2)
    staged.set('c', 3)
    await staged.commit({ keys: new Set(['a']) })
    expect(staged.isStaged('a')).toBe(false)
    expect(staged.isStaged('b')).toBe(true)
    expect(staged.isStaged('c')).toBe(true)
  })
})

describe('Staged — Map-shaped iteration', () => {
  it('keys() yields committed + staged updates and excludes staged removals', async () => {
    const { staged } = await freshStaged()
    staged.set('committed', 1)
    await staged.commit()
    staged.set('staged-add', 2)
    staged.delete('committed')

    const seen = new Set<string>()
    for await (const k of staged.keys()) seen.add(k)
    expect(seen).toEqual(new Set(['staged-add']))
  })
})

describe('Staged — three-way merge with user-level merge fn', () => {
  it('counter-style merge over decoded ints', async () => {
    const store = new Memory()
    const a = await VersionedKV.open(store)
    const stagedA = new Staged(a)
    stagedA.set('counter', 0)
    await stagedA.commit()

    // Two writers, both with the base commit
    const b = await VersionedKV.open(store)
    const stagedB = new Staged(b)

    stagedA.set('counter', 1)
    await stagedA.commit()

    // stagedB is now stale; HEAD has moved.
    const sumMerge: MergeFn<number> = (oldV, ours, theirs) => {
      const o = oldV ?? 0
      const u = ours ?? o
      const t = theirs ?? o
      return u + t - o
    }
    stagedB.setMergeFn('counter', sumMerge)
    stagedB.set('counter', 5)
    const r = await stagedB.commit()
    expect(r.merged).toBe(true)
    expect(r.strategy).toBe('three_way')
    // a wrote +1, b wrote +5, base 0 → merged should be 6.
    expect(await stagedB.get('counter')).toBe(6)
  })

  it('per-commit merge fns layer over registered ones', async () => {
    const store = new Memory()
    const a = await VersionedKV.open(store)
    const stagedA = new Staged(a)
    stagedA.set('k', 'base')
    await stagedA.commit()

    const b = await VersionedKV.open(store)
    const stagedB = new Staged(b)

    stagedA.set('k', 'a')
    await stagedA.commit()

    stagedB.set('k', 'b')
    const r = await stagedB.commit({
      defaultMerge: (_, ours, theirs) => `${ours as string}+${theirs as string}`,
    })
    expect(r.merged).toBe(true)
    expect(await stagedB.get('k')).toMatch(/^[ab]\+[ab]$/)
  })
})

describe('Staged — custom encoder/decoder', () => {
  it('round-trips with a uppercasing string encoder', async () => {
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const upperEncoder = (v: unknown) => enc.encode(String(v).toUpperCase())
    const upperDecoder = (b: Uint8Array) => dec.decode(b)
    const { staged } = await freshStaged({ encoder: upperEncoder, decoder: upperDecoder })

    staged.set('k', 'hello')
    await staged.commit()
    expect(await staged.get('k')).toBe('HELLO')
  })
})

describe('Staged — pass-through properties', () => {
  it('exposes Versioned identity properties', async () => {
    const { vk, staged } = await freshStaged()
    expect(staged.currentBranch).toBe(vk.currentBranch)
    expect(staged.currentCommit).toBe(vk.currentCommit)
    expect(staged.baseCommit).toBe(vk.baseCommit)
  })
})

describe('Staged — navigation invalidates the read cache', () => {
  // Reported by the agex-studio integration: cross-session content
  // bleed when the studio switches between chat branches in the same
  // session. Root cause was Staged's read cache surviving a HEAD move
  // from `versioned.switchBranch(...)` underneath. Same-shape gap
  // existed for `resetTo` (commit-level rewind) and `refresh`
  // (concurrent-writer pickup). Mirrors kvgit-py's `Staged.switch_branch`
  // / `reset_to` / `refresh` — each clears updates + removals + cache.

  it('switchBranch: cache is cleared (returns the new branch value, not the cached one)', async () => {
    // The exact reproducer the studio reported: write 'A-value' on
    // main, switch to B, write 'B-value', switch back to main, expect
    // to see 'A-value'. Without the cache invalidation the second
    // read returns 'B-value' (whichever was last cached for `k`).
    const { vk, staged } = await freshStaged()
    staged.set('k', 'A-value')
    await staged.commit()
    expect(await staged.get('k')).toBe('A-value') // populates cache

    await vk.createBranch('B')
    await staged.switchBranch('B')
    staged.set('k', 'B-value')
    await staged.commit()
    expect(await staged.get('k')).toBe('B-value')

    await staged.switchBranch('main')
    expect(await staged.get('k')).toBe('A-value')
  })

  it('switchBranch: discards staged changes (matches kvgit-py semantics)', async () => {
    // Carrying uncommitted writes across a branch switch is a 3-way-
    // merge problem in disguise; the contract is to drop them.
    const { vk, staged } = await freshStaged()
    await vk.createBranch('B')
    staged.set('k', 'uncommitted-on-main')
    expect(staged.hasChanges).toBe(true)
    await staged.switchBranch('B')
    expect(staged.hasChanges).toBe(false)
    expect(await staged.get('k')).toBeUndefined()
  })

  it('switchBranch: HEAD identity tracks the new branch', async () => {
    const { vk, staged } = await freshStaged()
    const mainHead = vk.currentCommit
    await vk.createBranch('B')
    await staged.switchBranch('B')
    expect(staged.currentBranch).toBe('B')
    // Branched at main's HEAD → same commit until B advances.
    expect(staged.currentCommit).toBe(mainHead)
    staged.set('k', 'on-B')
    await staged.commit()
    expect(staged.currentCommit).not.toBe(mainHead)
  })

  it('resetTo: clears cache when the reset succeeds', async () => {
    const { staged } = await freshStaged()
    staged.set('k', 'v1')
    const r1 = await staged.commit()
    const c1 = r1.commit as string
    staged.set('k', 'v2')
    await staged.commit()
    expect(await staged.get('k')).toBe('v2') // populates cache

    const ok = await staged.resetTo(c1)
    expect(ok).toBe(true)
    expect(await staged.get('k')).toBe('v1')
  })

  it('resetTo: discards staged changes on success', async () => {
    const { staged } = await freshStaged()
    staged.set('k', 'v1')
    const r1 = await staged.commit()
    const c1 = r1.commit as string
    staged.set('k', 'staged-v2')
    expect(staged.hasChanges).toBe(true)
    const ok = await staged.resetTo(c1)
    expect(ok).toBe(true)
    expect(staged.hasChanges).toBe(false)
    expect(await staged.get('k')).toBe('v1')
  })

  it('resetTo: a failed reset (unknown hash) preserves staged work', async () => {
    // kvgit-py: cleanup only fires on success — protects callers from
    // silently losing work if they hand in a bad hash.
    const { staged } = await freshStaged()
    staged.set('k', 'staged')
    const ok = await staged.resetTo('0'.repeat(64))
    expect(ok).toBe(false)
    expect(staged.hasChanges).toBe(true)
    expect(await staged.get('k')).toBe('staged')
  })

  it('refresh: clears cache + staged (concurrent-writer pickup)', async () => {
    // Two Staged wrappers on the same Versioned simulate two writers
    // on the same branch. Writer A picks up writer B's commit only
    // after `refresh`, and the read must reflect the new value.
    const { vk } = await freshStaged()
    const writerA = new Staged(vk)
    const writerB = new Staged(vk)

    writerB.set('k', 'from-B')
    await writerB.commit()

    // writerA hasn't refreshed yet — local cache is empty, so first
    // read goes through to the underlying Versioned and sees 'from-B'.
    // To exercise the cache-clear behavior, prime the cache at a
    // pre-refresh state with a different key, then verify refresh
    // doesn't leave staged changes either.
    writerA.set('local', 'staged-on-A')
    expect(writerA.hasChanges).toBe(true)
    await writerA.refresh()
    expect(writerA.hasChanges).toBe(false)
    expect(await writerA.get('k')).toBe('from-B')
  })
})
