import { describe, expect, it } from 'vitest'
import { Memory } from '../src/backends/memory'
import { type BytesMergeFn, ConcurrencyError, MergeConflict, VersionedKV } from '../src/index'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
const text = (b: Uint8Array): string => dec.decode(b)

describe('VersionedKV — open', () => {
  it('creates an initial empty commit on a fresh store', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    expect(vk.currentBranch).toBe('main')
    expect(vk.currentCommit).toBeTypeOf('string')
    expect(vk.currentCommit.length).toBe(40)
    expect(vk.currentCommit).toBe(vk.baseCommit)
    expect(await vk.get('any')).toBeNull()
  })

  it('reopens an existing store at HEAD', async () => {
    const store = new Memory()
    const vk1 = await VersionedKV.open(store)
    await vk1.commit({ updates: new Map([['k', bytes('v')]]) })
    const head = vk1.currentCommit

    const vk2 = await VersionedKV.open(store)
    expect(vk2.currentCommit).toBe(head)
    expect(text((await vk2.get('k')) as Uint8Array)).toBe('v')
  })

  it('rejects an existing store with the wrong storage version', async () => {
    const store = new Memory()
    await store.set('__kvgit_version__', enc.encode('999'))
    await store.set('__branch_head__main', enc.encode('"deadbeef"'))
    await expect(VersionedKV.open(store)).rejects.toThrow(/storage version/)
  })

  it('opens a different branch independently', async () => {
    const store = new Memory()
    const main = await VersionedKV.open(store, { branch: 'main' })
    await main.commit({ updates: new Map([['k', bytes('main-v')]]) })

    const otherBranch = (await main.createBranch('feature')) as VersionedKV
    expect(otherBranch.currentBranch).toBe('feature')
    expect(text((await otherBranch.get('k')) as Uint8Array)).toBe('main-v')
  })
})

describe('VersionedKV — fast-forward commit', () => {
  it('commits a single update and advances HEAD', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    const initial = vk.currentCommit
    const r = await vk.commit({ updates: new Map([['k', bytes('v')]]) })
    expect(r.merged).toBe(true)
    expect(r.strategy).toBe('fast_forward')
    expect(r.commit).not.toBe(initial)
    expect(vk.currentCommit).toBe(r.commit)
    expect(text((await vk.get('k')) as Uint8Array)).toBe('v')
  })

  it('treats an empty commit as a no-op', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    const r = await vk.commit()
    expect(r.merged).toBe(true)
    expect(r.strategy).toBe('no_op')
    expect(r.commit).toBe(vk.currentCommit)
  })

  it('removes a key', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['k', bytes('v')]]) })
    await vk.commit({ removals: new Set(['k']) })
    expect(await vk.get('k')).toBeNull()
  })

  it('round-trips an info dict', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({
      updates: new Map([['k', bytes('v')]]),
      info: { author: 'alice', message: 'add k' },
    })
    expect(await vk.commitInfo()).toEqual({ author: 'alice', message: 'add k' })
  })

  it('history walks newest to oldest', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    const c0 = vk.currentCommit
    await vk.commit({ updates: new Map([['k', bytes('v1')]]) })
    const c1 = vk.currentCommit
    await vk.commit({ updates: new Map([['k', bytes('v2')]]) })
    const c2 = vk.currentCommit

    const seen: string[] = []
    for await (const c of vk.history()) seen.push(c)
    expect(seen).toEqual([c2, c1, c0])
  })
})

describe('VersionedKV — branches', () => {
  it('writes on a fork do not leak to parent', async () => {
    const store = new Memory()
    const main = await VersionedKV.open(store)
    await main.commit({ updates: new Map([['shared', bytes('original')]]) })

    const feature = (await main.createBranch('feature')) as VersionedKV
    await feature.commit({ updates: new Map([['shared', bytes('forked')]]) })

    // main's view didn't change in-memory
    expect(text((await main.get('shared')) as Uint8Array)).toBe('original')
    // and a fresh handle on main also sees the original
    const main2 = await VersionedKV.open(store, { branch: 'main' })
    expect(text((await main2.get('shared')) as Uint8Array)).toBe('original')
  })

  it('peek reads a key from another branch without switching', async () => {
    const store = new Memory()
    const main = await VersionedKV.open(store)
    await main.commit({ updates: new Map([['k', bytes('main-v')]]) })

    const feature = (await main.createBranch('feature')) as VersionedKV
    await feature.commit({ updates: new Map([['k', bytes('feature-v')]]) })

    expect(text((await main.peek('k', { branch: 'feature' })) as Uint8Array)).toBe('feature-v')
    // main itself didn't switch
    expect(main.currentBranch).toBe('main')
    expect(text((await main.get('k')) as Uint8Array)).toBe('main-v')
  })

  it('switchBranch updates state in place', async () => {
    const store = new Memory()
    const main = await VersionedKV.open(store)
    await main.commit({ updates: new Map([['k', bytes('main')]]) })
    const feature = (await main.createBranch('feature')) as VersionedKV
    await feature.commit({ updates: new Map([['k', bytes('feature')]]) })

    await main.switchBranch('feature')
    expect(main.currentBranch).toBe('feature')
    expect(text((await main.get('k')) as Uint8Array)).toBe('feature')
  })

  it('listBranches returns sorted names', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.createBranch('zeta')
    await vk.createBranch('alpha')
    await vk.createBranch('mu')
    expect(await vk.listBranches()).toEqual(['alpha', 'main', 'mu', 'zeta'])
  })

  it('rejects creating a branch that already exists', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.createBranch('feature')
    await expect(vk.createBranch('feature')).rejects.toThrow(/already exists/)
  })

  it('deleteBranch removes a branch', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.createBranch('toremove')
    await vk.deleteBranch('toremove')
    expect((await vk.listBranches()).includes('toremove')).toBe(false)
  })

  it('cannot delete the current branch', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await expect(vk.deleteBranch('main')).rejects.toThrow(/current branch/)
  })
})

describe('VersionedKV — three-way merge', () => {
  it('auto-merges non-overlapping changes', async () => {
    const store = new Memory()
    const a = await VersionedKV.open(store)
    await a.commit({ updates: new Map([['shared', bytes('base')]]) })

    // Two writers on the same branch, both based on the same commit.
    const b = await VersionedKV.open(store)

    await a.commit({ updates: new Map([['from-a', bytes('a-val')]]) })
    // b is now stale; b's base_commit doesn't match HEAD.
    const r = await b.commit({ updates: new Map([['from-b', bytes('b-val')]]) })
    expect(r.merged).toBe(true)
    expect(r.strategy).toBe('three_way')
    expect(text((await b.get('from-a')) as Uint8Array)).toBe('a-val')
    expect(text((await b.get('from-b')) as Uint8Array)).toBe('b-val')
    expect(text((await b.get('shared')) as Uint8Array)).toBe('base')
  })

  it('uses a per-key merge fn for contested keys', async () => {
    const store = new Memory()
    const a = await VersionedKV.open(store)
    await a.commit({ updates: new Map([['counter', bytes('0')]]) })

    const b = await VersionedKV.open(store)

    await a.commit({ updates: new Map([['counter', bytes('1')]]) })

    // Sum-merge fn: parses both sides as ints and adds the deltas to base.
    const sumMerge: BytesMergeFn = (oldV, ours, theirs) => {
      const o = oldV ? Number.parseInt(text(oldV), 10) : 0
      const u = ours ? Number.parseInt(text(ours), 10) : o
      const t = theirs ? Number.parseInt(text(theirs), 10) : o
      return bytes(String(u + t - o))
    }

    const r = await b.commit({
      updates: new Map([['counter', bytes('5')]]),
      mergeFns: new Map([['counter', sumMerge]]),
    })
    expect(r.merged).toBe(true)
    expect(r.strategy).toBe('three_way')
    expect(r.autoMergedKeys).toEqual(['counter'])
    // a wrote 1 (delta +1), b wrote 5 (delta +5), base 0 → merged should be 6.
    expect(text((await b.get('counter')) as Uint8Array)).toBe('6')
  })

  it('throws MergeConflict for a contested key with no merge fn', async () => {
    const store = new Memory()
    const a = await VersionedKV.open(store)
    await a.commit({ updates: new Map([['k', bytes('base')]]) })
    const b = await VersionedKV.open(store)

    await a.commit({ updates: new Map([['k', bytes('a')]]) })
    await expect(b.commit({ updates: new Map([['k', bytes('b')]]) })).rejects.toBeInstanceOf(
      MergeConflict,
    )
  })

  it("with onConflict 'skip', returns merged=false instead of throwing", async () => {
    const store = new Memory()
    const a = await VersionedKV.open(store)
    await a.commit({ updates: new Map([['k', bytes('base')]]) })
    const b = await VersionedKV.open(store)

    await a.commit({ updates: new Map([['k', bytes('a')]]) })
    const r = await b.commit({
      updates: new Map([['k', bytes('b')]]),
      onConflict: 'skip',
    })
    expect(r.merged).toBe(false)
    expect(r.commit).toBeNull()
    // b's in-memory base was restored (didn't move to a's commit).
    expect(text((await b.get('k')) as Uint8Array)).toBe('base')
  })

  it('default merge fn handles all contested keys', async () => {
    const store = new Memory()
    const a = await VersionedKV.open(store)
    await a.commit({ updates: new Map([['k', bytes('base')]]) })
    const b = await VersionedKV.open(store)

    await a.commit({ updates: new Map([['k', bytes('a')]]) })
    const r = await b.commit({
      updates: new Map([['k', bytes('b')]]),
      defaultMerge: (_, ours, theirs) =>
        bytes(`${text(ours ?? bytes(''))}+${text(theirs ?? bytes(''))}`),
    })
    expect(r.merged).toBe(true)
    expect(text((await b.get('k')) as Uint8Array)).toMatch(/^[ab]\+[ab]$/)
  })
})

describe('VersionedKV — diff between commits', () => {
  it('reports added/removed/modified at the key level', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({
      updates: new Map([
        ['k1', bytes('v1')],
        ['k2', bytes('v2')],
      ]),
    })
    const c1 = vk.currentCommit
    await vk.commit({
      updates: new Map([
        ['k2', bytes('v2-new')], // modified
        ['k3', bytes('v3')], // added
      ]),
      removals: new Set(['k1']), // removed
    })
    const c2 = vk.currentCommit

    const d = await vk.diff(c1, c2)
    expect([...d.added]).toEqual(['k3'])
    expect([...d.removed]).toEqual(['k1'])
    expect([...d.modified]).toEqual(['k2'])
  })
})

describe('VersionedKV — checkout and resetTo', () => {
  it('checkout returns a Versioned at a historical commit', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['k', bytes('v1')]]) })
    const c1 = vk.currentCommit
    await vk.commit({ updates: new Map([['k', bytes('v2')]]) })

    const historical = (await vk.checkout(c1)) as VersionedKV
    expect(historical.currentCommit).toBe(c1)
    expect(text((await historical.get('k')) as Uint8Array)).toBe('v1')

    // The original handle wasn't affected.
    expect(text((await vk.get('k')) as Uint8Array)).toBe('v2')
  })

  it('resetTo moves HEAD to a previous commit', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['k', bytes('v1')]]) })
    const c1 = vk.currentCommit
    await vk.commit({ updates: new Map([['k', bytes('v2')]]) })

    expect(await vk.resetTo(c1)).toBe(true)
    expect(vk.currentCommit).toBe(c1)
    expect(text((await vk.get('k')) as Uint8Array)).toBe('v1')
  })
})

describe('VersionedKV — corrupt-HEAD recovery', () => {
  it('recovers via prev-HEAD when current HEAD points to a missing commit', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['k', bytes('v1')]]) })
    const goodHead = vk.currentCommit
    await vk.commit({ updates: new Map([['k', bytes('v2')]]) })
    // The CAS that just landed wrote `goodHead` to BRANCH_HEAD_PREV.

    // Simulate corruption: overwrite current HEAD with a string that
    // points to a nonexistent commit. The prev-HEAD backup still holds
    // `goodHead`, so a fresh open should recover to it.
    await store.set(
      '__branch_head__main',
      enc.encode(JSON.stringify('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')),
    )

    const vk2 = await VersionedKV.open(store)
    expect(vk2.currentCommit).toBe(goodHead)
    expect(text((await vk2.get('k')) as Uint8Array)).toBe('v1')
  })

  it('throws when both HEAD and prev-HEAD are corrupt and no recoverer is set', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['k', bytes('v')]]) })

    // Corrupt both pointers.
    const dead = JSON.stringify('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    await store.set('__branch_head__main', enc.encode(dead))
    await store.set('__branch_head_prev__main', enc.encode(dead))

    await expect(VersionedKV.open(store)).rejects.toThrow(/corrupt and unrecoverable/)
  })

  it('uses an injected commit-scan recoverer when both HEAD pointers are bad', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['k', bytes('v1')]]) })
    const goodHead = vk.currentCommit

    // Corrupt both pointers.
    const dead = JSON.stringify('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')
    await store.set('__branch_head__main', enc.encode(dead))
    await store.set('__branch_head_prev__main', enc.encode(dead))

    const vk2 = await VersionedKV.open(store, {
      recoverFromCorruptHead: async () => goodHead,
    })
    expect(vk2.currentCommit).toBe(goodHead)
  })
})

describe('VersionedKV — sanity: ConcurrencyError import path', () => {
  it('exports ConcurrencyError as a real class', () => {
    expect(typeof ConcurrencyError).toBe('function')
    const err = new ConcurrencyError('test')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ConcurrencyError')
  })
})
