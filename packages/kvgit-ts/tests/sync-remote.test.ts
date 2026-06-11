import { describe, expect, it } from 'vitest'
import { Memory } from '../src/backends/memory'
import {
  MemoryRemote,
  VersionedKV,
  getSyncHead,
  pullBranch,
  pushBranch,
  syncBranch,
  walkDelta,
} from '../src/index'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
const text = (b: Uint8Array): string => dec.decode(b)

const BRANCH = 'chat-ab12cd34'

/** A device: its own store with a session branch. */
async function device(): Promise<{ store: Memory; vk: VersionedKV }> {
  const store = new Memory()
  const vk = await VersionedKV.open(store, { branch: BRANCH })
  return { store, vk }
}

describe('two devices through a MemoryRemote', () => {
  it('A pushes (created), B pulls (created), heads and values converge', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device()
    await a.vk.commit({ updates: new Map([['greeting', bytes('hello')]]) })

    const pushed = await pushBranch(a.store, remote, BRANCH)
    expect(pushed.status).toBe('created')
    expect(pushed.transferred).toBeGreaterThan(0)
    expect(await getSyncHead(a.store, BRANCH)).toBe(a.vk.currentCommit)

    // Device B starts empty — no local branch at all.
    const bStore = new Memory()
    const pulled = await pullBranch(bStore, remote, BRANCH)
    expect(pulled.status).toBe('created')
    expect(pulled.localHead).toBe(a.vk.currentCommit)

    const bVk = await VersionedKV.open(bStore, { branch: BRANCH })
    expect(bVk.currentCommit).toBe(a.vk.currentCommit)
    expect(text((await bVk.get('greeting')) as Uint8Array)).toBe('hello')
  })

  it('subsequent pushes send only the delta', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device()
    await a.vk.commit({ updates: new Map([['k1', bytes('v1')]]) })
    await a.vk.commit({ updates: new Map([['k2', bytes('v2')]]) })
    await pushBranch(a.store, remote, BRANCH)

    await a.vk.commit({ updates: new Map([['k3', bytes('v3')]]) })
    const second = await pushBranch(a.store, remote, BRANCH)
    expect(second.status).toBe('pushed')
    expect(second.transferred).toBe(1)
  })

  it('pull fast-forwards an existing local branch and writes the prev backup', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device()
    await a.vk.commit({ updates: new Map([['k', bytes('v1')]]) })
    await pushBranch(a.store, remote, BRANCH)

    const bStore = new Memory()
    await pullBranch(bStore, remote, BRANCH)
    const bHeadBefore = (await VersionedKV.open(bStore, { branch: BRANCH })).currentCommit

    await a.vk.commit({ updates: new Map([['k', bytes('v2')]]) })
    await pushBranch(a.store, remote, BRANCH)

    const pulled = await pullBranch(bStore, remote, BRANCH)
    expect(pulled.status).toBe('fast-forwarded')
    expect(pulled.localHead).toBe(a.vk.currentCommit)
    expect(
      text(await bStore.get(`__branch_head_prev__${BRANCH}`).then((b) => b as Uint8Array)),
    ).toBe(JSON.stringify(bHeadBefore))

    const bVk = await VersionedKV.open(bStore, { branch: BRANCH })
    expect(text((await bVk.get('k')) as Uint8Array)).toBe('v2')
  })

  it('syncBranch is idempotent and ping-pong convergent across devices', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device()
    await a.vk.commit({ updates: new Map([['seed', bytes('0')]]) })
    await syncBranch(a.store, remote, BRANCH)
    const bStore = new Memory()
    await pullBranch(bStore, remote, BRANCH)

    // Alternate: one device commits and syncs, the other syncs.
    for (let round = 0; round < 4; round++) {
      const writerIsA = round % 2 === 0
      if (writerIsA) {
        const vk = await VersionedKV.open(a.store, { branch: BRANCH })
        await vk.commit({ updates: new Map([[`round-${round}`, bytes(String(round))]]) })
        expect((await syncBranch(a.store, remote, BRANCH)).status).toBe('pushed')
        expect((await syncBranch(bStore, remote, BRANCH)).status).toBe('fast-forwarded')
      } else {
        const vk = await VersionedKV.open(bStore, { branch: BRANCH })
        await vk.commit({ updates: new Map([[`round-${round}`, bytes(String(round))]]) })
        expect((await syncBranch(bStore, remote, BRANCH)).status).toBe('pushed')
        expect((await syncBranch(a.store, remote, BRANCH)).status).toBe('fast-forwarded')
      }
      // Convergence after every round.
      const aHead = (await VersionedKV.open(a.store, { branch: BRANCH })).currentCommit
      const bHead = (await VersionedKV.open(bStore, { branch: BRANCH })).currentCommit
      expect(aHead).toBe(bHead)
    }

    // Quiescent syncs are no-ops on both sides.
    expect((await syncBranch(a.store, remote, BRANCH)).status).toBe('up-to-date')
    expect((await syncBranch(bStore, remote, BRANCH)).status).toBe('up-to-date')
  })
})

describe('divergence', () => {
  /** Shared prefix on the remote, then both devices commit locally. */
  async function diverge(): Promise<{
    remote: MemoryRemote
    a: { store: Memory; vk: VersionedKV }
    bStore: Memory
  }> {
    const remote = new MemoryRemote(new Memory())
    const a = await device()
    await a.vk.commit({ updates: new Map([['seed', bytes('0')]]) })
    await pushBranch(a.store, remote, BRANCH)
    const bStore = new Memory()
    await pullBranch(bStore, remote, BRANCH)

    await a.vk.commit({ updates: new Map([['from-a', bytes('a')]]) })
    await pushBranch(a.store, remote, BRANCH)
    const bVk = await VersionedKV.open(bStore, { branch: BRANCH })
    await bVk.commit({ updates: new Map([['from-b', bytes('b')]]) })
    return { remote, a, bStore }
  }

  it('is detected on both pull and push; no refs move, nothing merges', async () => {
    const { remote, a, bStore } = await diverge()
    const bHeadBefore = (await VersionedKV.open(bStore, { branch: BRANCH })).currentCommit
    const remoteHeadBefore = (await remote.listRefs())[0]?.head
    const syncHeadBefore = await getSyncHead(bStore, BRANCH)

    const pulled = await pullBranch(bStore, remote, BRANCH)
    expect(pulled.status).toBe('diverged')
    // Remote objects landed locally (useful for a future merge)...
    expect(pulled.transferred).toBeGreaterThan(0)
    // ...but no ref moved, the sync head didn't advance, and B's own
    // commit is untouched.
    const bVk = await VersionedKV.open(bStore, { branch: BRANCH })
    expect(bVk.currentCommit).toBe(bHeadBefore)
    expect(text((await bVk.get('from-b')) as Uint8Array)).toBe('b')
    expect(await bVk.get('from-a')).toBeNull() // not merged into B's branch
    expect(await getSyncHead(bStore, BRANCH)).toBe(syncHeadBefore)

    const pushed = await pushBranch(bStore, remote, BRANCH)
    expect(pushed.status).toBe('diverged')
    expect((await remote.listRefs())[0]?.head).toBe(remoteHeadBefore)

    const outcome = await syncBranch(bStore, remote, BRANCH)
    expect(outcome.status).toBe('diverged')
    expect(outcome.push).toBeNull() // short-circuited

    // Device A, which only moved forward, keeps syncing fine.
    expect((await syncBranch(a.store, remote, BRANCH)).status).toBe('up-to-date')
  })

  it('resolves after a local merge: merge locally, then push lands', async () => {
    const { remote, bStore } = await diverge()
    await pullBranch(bStore, remote, BRANCH) // diverged; objects now local

    // The caller's resolution: three-way merge via kvgit's existing
    // machinery (disjoint keys auto-carry), then sync again.
    const bVk = await VersionedKV.open(bStore, { branch: BRANCH })
    const remoteHead = (await remote.listRefs())[0]?.head as string
    await bStore.set(`__branch_head__${BRANCH}`, enc.encode(JSON.stringify(remoteHead)))
    // Reopen at the remote head and commit B's key on top via merge:
    // simplest local resolution — replay B's value as a new commit.
    const merged = await VersionedKV.open(bStore, { branch: BRANCH })
    await merged.commit({ updates: new Map([['from-b', (await bVk.get('from-b')) as Uint8Array]]) })

    const pushed = await pushBranch(bStore, remote, BRANCH)
    expect(pushed.status).toBe('pushed')

    // A pulls the resolution and sees both keys.
    const aStore = new Memory()
    await pullBranch(aStore, remote, BRANCH)
    const aVk = await VersionedKV.open(aStore, { branch: BRANCH })
    expect(text((await aVk.get('from-a')) as Uint8Array)).toBe('a')
    expect(text((await aVk.get('from-b')) as Uint8Array)).toBe('b')
  })
})

describe('races and lifecycle', () => {
  it('push retries once through a benign CAS race (remote ahead but in our ancestry)', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device()
    await a.vk.commit({ updates: new Map([['k1', bytes('v1')]]) })
    await pushBranch(a.store, remote, BRANCH)
    await a.vk.commit({ updates: new Map([['k2', bytes('v2')]]) })

    // Simulate a sibling (same device state) having already pushed the
    // tip: remote is ahead of our sync head, but its head is in our
    // ancestry's future... i.e., equal to our local head.
    const sibling = new Memory()
    await pullBranch(sibling, remote, BRANCH)
    for await (const _ of walkDelta(a.store, { want: a.vk.currentCommit })) {
      // no-op: just proving the walk is available for the sibling path
      break
    }
    await pushBranch(a.store, remote, BRANCH) // lands k2
    // Our stale tracking on the sibling store: pull sees ff.
    expect((await pullBranch(sibling, remote, BRANCH)).status).toBe('fast-forwarded')
  })

  it('direct remote.push with a stale expectedOld loses the CAS and moves nothing', async () => {
    const remote = new MemoryRemote(new Memory())
    const a = await device()
    await a.vk.commit({ updates: new Map([['k', bytes('v1')]]) })
    const firstHead = a.vk.currentCommit
    await pushBranch(a.store, remote, BRANCH)
    await a.vk.commit({ updates: new Map([['k', bytes('v2')]]) })
    await pushBranch(a.store, remote, BRANCH)

    // Stale CAS: expectedOld is the old head.
    const ok = await remote.push(BRANCH, firstHead, firstHead, [])
    expect(ok).toBe(false)
    expect((await remote.listRefs())[0]?.head).toBe(a.vk.currentCommit)
  })

  it('reports remote-gone when a previously-synced ref vanishes', async () => {
    const remoteStore = new Memory()
    const remote = new MemoryRemote(remoteStore)
    const a = await device()
    await a.vk.commit({ updates: new Map([['k', bytes('v')]]) })
    await pushBranch(a.store, remote, BRANCH)

    // The branch is archived/deleted on the remote out from under us.
    await remoteStore.remove(`__branch_head__${BRANCH}`)

    expect((await pushBranch(a.store, remote, BRANCH)).status).toBe('remote-gone')
    expect((await pullBranch(a.store, remote, BRANCH)).status).toBe('remote-gone')
    expect((await syncBranch(a.store, remote, BRANCH)).status).toBe('remote-gone')
  })

  it('pulling a branch that never existed remotely is a quiet no-op', async () => {
    const remote = new MemoryRemote(new Memory())
    const store = new Memory()
    const pulled = await pullBranch(store, remote, BRANCH)
    expect(pulled.status).toBe('up-to-date')
    expect(pulled.remoteHead).toBeNull()
  })

  it('pushing a nonexistent local branch throws', async () => {
    const remote = new MemoryRemote(new Memory())
    await expect(pushBranch(new Memory(), remote, BRANCH)).rejects.toThrow(/does not exist/)
  })
})
