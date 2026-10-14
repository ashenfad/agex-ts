/**
 * PackRemote (spike) against an in-memory GitHub: one pack per push,
 * fetched by manifest, with CAS on `expectedHeadOid`.
 */

import { describe, expect, it } from 'vitest'
import { Memory } from '../src/backends/memory'
import { MANIFEST_PATH, PackRemote, decodePack, encodePack } from '../src/github/index'
import { VersionedKV, applyWire, pullBranch, pushBranch, walkDelta } from '../src/index'
import type { WireCommit } from '../src/types'
import { FakePackGithub } from './fake-pack-github'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
const text = (b: Uint8Array | null | undefined): string | null => (b == null ? null : dec.decode(b))

const BRANCH = 'chat-1'

async function device(gh: FakePackGithub, opts: ConstructorParameters<typeof PackRemote>[2] = {}) {
  const store = new Memory()
  const remote = new PackRemote(gh.client(), store, opts)
  return { store, remote }
}

async function commitN(store: Memory, n: number, prefix: string): Promise<VersionedKV> {
  const vk = await VersionedKV.open(store, { branch: BRANCH })
  for (let i = 0; i < n; i++) {
    await vk.commit({
      updates: new Map([
        [`files/${prefix}${i}.txt`, bytes(`${prefix} ${i} `.repeat(20))],
        ['index', bytes(`${prefix}${i}`)],
      ]),
      info: { tool: 'file_write', t: 1.5 },
    })
  }
  return vk
}

async function collect(iter: AsyncIterable<WireCommit>): Promise<WireCommit[]> {
  const out: WireCommit[] = []
  for await (const wc of iter) out.push(wc)
  return out
}

describe('pack codec', () => {
  it('round-trips wire commits so applyWire re-derives every hash', async () => {
    const src = new Memory()
    const vk = await commitN(src, 4, 'a')
    await vk.commit({ updates: new Map(), removals: new Set(['files/a0.txt']) })
    const commits = await collect(walkDelta(src, { want: vk.currentCommit }))
    const pack = await encodePack(commits, { kernel: 'ts', base: null })
    expect(pack[0]).toBe(0x1f) // gzip
    const decoded = await decodePack(pack)
    expect(decoded.tip).toBe(vk.currentCommit)
    const dst = new Memory()
    const res = await applyWire(dst, decoded.commits, { createBranch: BRANCH })
    expect(res.head).toBe(vk.currentCommit)
    const copy = await VersionedKV.open(dst, { branch: BRANCH })
    expect(text(await copy.get('files/a3.txt'))).toContain('a 3')
    expect(await copy.get('files/a0.txt')).toBeNull()
  })

  it('stores a value repeated across commits once', async () => {
    const src = new Memory()
    const vk = await VersionedKV.open(src, { branch: BRANCH })
    const big = bytes('x'.repeat(5000))
    await vk.commit({ updates: new Map([['a', big]]) })
    await vk.commit({ updates: new Map([['b', big]]) })
    const commits = await collect(walkDelta(src, { want: vk.currentCommit }))
    const raw = await encodePack(commits, { kernel: 'ts', base: null, compress: false })
    expect(raw.length).toBeLessThan(5000 * 1.5)
  })
})

describe('PackRemote push / fetch', () => {
  it('first push is one roster query and one mutation; fresh pull one query and one read', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh)
    const vk = await commitN(a.store, 5, 'a')

    expect((await pushBranch(a.store, a.remote, BRANCH)).status).toBe('created')
    expect(gh.count('graphql-query')).toBe(1)
    expect(gh.count('graphql-mutation')).toBe(1)
    expect(gh.filesAt(BRANCH)).toContain(MANIFEST_PATH)

    gh.calls.length = 0
    const b = await device(gh)
    const pulled = await pullBranch(b.store, b.remote, BRANCH)
    expect(pulled.status).toBe('created')
    expect(pulled.localHead).toBe(vk.currentCommit)
    expect(pulled.transferred).toBe(6) // root + 5
    expect(gh.count('graphql-query')).toBe(1)
    expect(gh.count('raw')).toBe(1)
    const bVk = await VersionedKV.open(b.store, { branch: BRANCH })
    expect(text(await bVk.get('index'))).toBe('a4')
  })

  it('incremental push adds one pack; incremental pull reads only it', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh)
    await commitN(a.store, 3, 'a')
    await pushBranch(a.store, a.remote, BRANCH)
    const b = await device(gh)
    await pullBranch(b.store, b.remote, BRANCH)

    const vk = await commitN(a.store, 4, 'b')
    gh.calls.length = 0
    const pushed = await pushBranch(a.store, a.remote, BRANCH)
    expect(pushed.status).toBe('pushed')
    expect(pushed.transferred).toBe(4)
    expect(gh.count('graphql-mutation')).toBe(1)
    expect(gh.count('graphql-query')).toBe(1) // the sync layer's listRefs; push reuses it

    gh.calls.length = 0
    const pulled = await pullBranch(b.store, b.remote, BRANCH)
    expect(pulled.status).toBe('fast-forwarded')
    expect(pulled.transferred).toBe(4)
    expect(gh.count('raw')).toBe(1)
    expect(pulled.localHead).toBe(vk.currentCommit)
  })

  it('a pull that has part of a pack applies only what it lacks', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh)
    await commitN(a.store, 2, 'a')
    await pushBranch(a.store, a.remote, BRANCH)
    // B pulls, then A pushes twice more: B needs two packs.
    const b = await device(gh)
    await pullBranch(b.store, b.remote, BRANCH)
    await commitN(a.store, 2, 'b')
    await pushBranch(a.store, a.remote, BRANCH)
    await commitN(a.store, 2, 'c')
    await pushBranch(a.store, a.remote, BRANCH)
    gh.calls.length = 0
    const pulled = await pullBranch(b.store, b.remote, BRANCH)
    expect(pulled.transferred).toBe(4)
    expect(gh.count('raw')).toBe(2)
  })

  it('a stale expectedHeadOid loses cleanly: diverged, remote unchanged', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh)
    await commitN(a.store, 2, 'a')
    await pushBranch(a.store, a.remote, BRANCH)
    const b = await device(gh)
    await pullBranch(b.store, b.remote, BRANCH)

    await commitN(a.store, 1, 'a2')
    await commitN(b.store, 1, 'b2')
    expect((await pushBranch(a.store, a.remote, BRANCH)).status).toBe('pushed')
    const before = gh.refs.get(`refs/heads/${BRANCH}`)
    expect((await pushBranch(b.store, b.remote, BRANCH)).status).toBe('diverged')
    expect(gh.refs.get(`refs/heads/${BRANCH}`)).toBe(before)
  })

  it('a race inside the CAS window returns false from push (no partial write)', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh)
    const vk = await commitN(a.store, 2, 'a')
    await pushBranch(a.store, a.remote, BRANCH)
    await a.remote.listRefs()
    const old = vk.currentCommit
    await commitN(a.store, 1, 'x')
    // Someone moves the ref between our roster read and our mutation.
    gh.beforeMutation = () => {
      gh.refs.set(`refs/heads/${BRANCH}`, gh.refs.get('refs/heads/main') as string)
      gh.beforeMutation = null
    }
    const commits = walkDelta(a.store, {
      want: (await VersionedKV.open(a.store, { branch: BRANCH })).currentCommit,
      have: [old],
    })
    const ok = await a.remote.push(
      BRANCH,
      old,
      (await VersionedKV.open(a.store, { branch: BRANCH })).currentCommit,
      commits,
    )
    expect(ok).toBe(false)
  })

  it('the FORBIDDEN shape of a lost race (ref moved mid-request) is a lost CAS too', async () => {
    const gh = new FakePackGithub()
    gh.raceStyle = 'forbidden'
    const a = await device(gh)
    const old = (await commitN(a.store, 1, 'a')).currentCommit
    await pushBranch(a.store, a.remote, BRANCH)
    await a.remote.listRefs()
    const head = (await commitN(a.store, 1, 'x')).currentCommit
    gh.beforeMutation = () => {
      gh.refs.set(`refs/heads/${BRANCH}`, gh.refs.get('refs/heads/main') as string)
      gh.beforeMutation = null
    }
    const pushed = a.remote.push(BRANCH, old, head, walkDelta(a.store, { want: head, have: [old] }))
    expect(await pushed).toBe(false)
  })

  it('creation races: the second device to create loses', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh)
    const b = await device(gh)
    await commitN(a.store, 1, 'a')
    await commitN(b.store, 1, 'b')
    expect((await pushBranch(a.store, a.remote, BRANCH)).status).toBe('created')
    expect((await pushBranch(b.store, b.remote, BRANCH)).status).toBe('diverged')
  })

  it('splits a push larger than maxPackBytes into several CAS-chained commits', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh, { maxPackBytes: 150 })
    const vk = await commitN(a.store, 6, 'a') // ~80 bytes of values per commit
    expect((await pushBranch(a.store, a.remote, BRANCH)).status).toBe('created')
    expect(gh.count('graphql-mutation')).toBeGreaterThan(1)
    const b = await device(gh)
    const pulled = await pullBranch(b.store, b.remote, BRANCH)
    expect(pulled.localHead).toBe(vk.currentCommit)
  })
})

describe('PackRemote packs over time', () => {
  it('folds older packs once a push would exceed maxPacks, still one mutation', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh, { maxPacks: 4, keepRecent: 2 })
    let vk: VersionedKV | null = null
    for (let i = 0; i < 8; i++) {
      vk = await commitN(a.store, 2, `t${i}-`)
      gh.calls.length = 0
      await pushBranch(a.store, a.remote, BRANCH)
      expect(gh.count('graphql-mutation')).toBe(1)
    }
    const packs = gh.filesAt(BRANCH).filter((p) => p.endsWith('.pack'))
    expect(packs.length).toBeLessThanOrEqual(4)
    const b = await device(gh)
    const pulled = await pullBranch(b.store, b.remote, BRANCH)
    expect(pulled.localHead).toBe(vk?.currentCommit)
    expect(pulled.transferred).toBe(17)
  })

  it('repack folds everything into one pack; a fresh pull is one query + one read', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh)
    for (let i = 0; i < 5; i++) {
      await commitN(a.store, 2, `t${i}-`)
      await pushBranch(a.store, a.remote, BRANCH)
    }
    expect(await a.remote.repack(BRANCH)).toBe(true)
    expect(gh.filesAt(BRANCH).filter((p) => p.endsWith('.pack'))).toHaveLength(1)
    gh.calls.length = 0
    const b = await device(gh)
    const pulled = await pullBranch(b.store, b.remote, BRANCH)
    expect(pulled.transferred).toBe(11)
    expect(gh.count('graphql-query')).toBe(1)
    expect(gh.count('raw')).toBe(1)
    // A device that had the pre-repack history pulls on as before.
    await commitN(a.store, 1, 'after')
    await pushBranch(a.store, a.remote, BRANCH)
    expect((await pullBranch(b.store, b.remote, BRANCH)).status).toBe('fast-forwarded')
  })
})

describe('PackRemote roster and lifecycle', () => {
  it('roster carries stub metadata from the manifest, in one query', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh, { meta: (branch) => ({ title: `Title of ${branch}` }) })
    await commitN(a.store, 1, 'a')
    await pushBranch(a.store, a.remote, BRANCH)
    const b = await device(gh)
    gh.calls.length = 0
    const roster = await b.remote.roster()
    expect(roster).toEqual([
      expect.objectContaining({
        branch: BRANCH,
        meta: { title: `Title of ${BRANCH}` },
        archived: false,
      }),
    ])
    expect(gh.calls).toHaveLength(1)
  })

  it('archive / restore / empty trash are single atomic updateRefs', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh)
    await commitN(a.store, 1, 'a')
    await pushBranch(a.store, a.remote, BRANCH)
    const b = await device(gh)
    await pullBranch(b.store, b.remote, BRANCH)

    gh.calls.length = 0
    expect(await a.remote.archiveBranch(BRANCH)).toBe(true)
    expect(gh.count('graphql-mutation')).toBe(1)
    expect(await a.remote.listRefs()).toEqual([])
    expect((await a.remote.roster())[0]).toMatchObject({ branch: BRANCH, archived: true })
    // The other device sees the lifecycle conflict.
    expect((await pullBranch(b.store, b.remote, BRANCH)).status).toBe('remote-gone')
    // Archiving again: nothing live to archive.
    expect(await a.remote.archiveBranch(BRANCH)).toBe(false)

    expect(await a.remote.restoreBranch(BRANCH)).toBe(true)
    expect((await a.remote.listRefs()).map((r) => r.branch)).toEqual([BRANCH])
    expect(await a.remote.archiveBranch(BRANCH)).toBe(true)
    expect(await a.remote.emptyTrash()).toBe(1)
    expect(await a.remote.roster()).toEqual([])
  })

  it('archive loses cleanly when the branch moved after it was read', async () => {
    const gh = new FakePackGithub()
    const a = await device(gh)
    await commitN(a.store, 1, 'a')
    await pushBranch(a.store, a.remote, BRANCH)
    gh.beforeMutation = () => {
      gh.refs.set(`refs/heads/${BRANCH}`, gh.refs.get('refs/heads/main') as string)
      gh.beforeMutation = null
    }
    expect(await a.remote.archiveBranch(BRANCH)).toBe(false)
    expect(gh.refs.has(`refs/heads/archived/${BRANCH}`)).toBe(false)
  })
})
