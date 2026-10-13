/**
 * The GitHub transport sends a value once: a push references a value
 * the repo already holds by its git SHA, and a fetch reads a value the
 * local store already holds instead of downloading it.
 */

import { describe, expect, it } from 'vitest'
import { Memory } from '../src/backends/memory'
import { gitBlobSha1 } from '../src/github/git-hash'
import { GithubRemote, decodeSidecar } from '../src/github/index'
import { SIDECAR_PATH } from '../src/github/paths'
import { VersionedKV, pullBranch, pushBranch } from '../src/index'
import { sha256Hex } from '../src/versioned/layout'
import { type FakeCall, FakeGithub } from './fake-github'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
/** A value with no UTF-8 spelling, so it can't ride inline in a tree:
 *  sending it is a `createBlob` POST. */
const binary = (seed: number): Uint8Array =>
  new Uint8Array(Array.from({ length: 64 }, (_, i) => ((i * 37 + seed) % 256) | 0x80))

/** One device: a local store, a handle on main, and a remote on `gh`. */
async function device(gh: FakeGithub) {
  const store = new Memory()
  const vk = await VersionedKV.open(store)
  const remote = new GithubRemote(gh.client(), store)
  return { store, vk, remote }
}

/** A device with no branches yet, whose first pull creates main. */
function freshDevice(gh: FakeGithub) {
  const store = new Memory()
  return { store, remote: new GithubRemote(gh.client(), store) }
}

const treePosts = (gh: FakeGithub): FakeCall[] =>
  gh.calls.filter((c) => c.method === 'POST' && c.path === 'git/trees')

const entryAt = (call: FakeCall | undefined, path: string) =>
  ((call?.body?.tree ?? []) as Array<{ path: string; sha?: string | null; content?: string }>).find(
    (e) => e.path === path,
  )

/** Value downloads: contents reads other than sidecars. */
const valueReads = (calls: FakeCall[]): FakeCall[] =>
  calls.filter(
    (c) =>
      c.method === 'GET' &&
      c.path.startsWith('contents/') &&
      !decodeURIComponent(c.path).startsWith(`contents/${SIDECAR_PATH}`),
  )

describe('push sends each value once', () => {
  it('references a renamed value by its SHA instead of uploading it again', async () => {
    const gh = new FakeGithub()
    const a = await device(gh)
    const value = binary(1)
    await a.vk.commit({ updates: new Map([['old/name', value]]) })
    expect((await pushBranch(a.store, a.remote, 'main')).status).toBe('created')
    expect(gh.count('POST', 'git/blobs')).toBe(1)

    await a.vk.commit({
      updates: new Map([['new/name', value]]),
      removals: new Set(['old/name']),
    })
    const before = gh.calls.length
    expect((await pushBranch(a.store, a.remote, 'main')).status).toBe('pushed')
    const after = gh.calls.slice(before)
    expect(after.filter((c) => c.path === 'git/blobs')).toEqual([])
    const entry = entryAt(treePosts(gh).at(-1), 'new/name')
    expect(entry?.sha).toBe(await gitBlobSha1(value))
    expect(entry?.content).toBeUndefined()
  })

  it('references a value restored after it left the tree', async () => {
    const gh = new FakeGithub()
    const a = await device(gh)
    const original = binary(7)
    await a.vk.commit({ updates: new Map([['k', original]]) })
    await pushBranch(a.store, a.remote, 'main')
    await a.vk.commit({ updates: new Map([['k', binary(8)]]) })
    await pushBranch(a.store, a.remote, 'main')
    expect(gh.count('POST', 'git/blobs')).toBe(2)

    // A revert, through a fresh remote on the same store: the value is
    // in no branch's current tree, but the repo still holds it.
    const later = new GithubRemote(gh.client(), a.store)
    await a.vk.commit({ updates: new Map([['k', original]]) })
    expect((await pushBranch(a.store, later, 'main')).status).toBe('pushed')
    expect(gh.count('POST', 'git/blobs')).toBe(2)
    expect(entryAt(treePosts(gh).at(-1), 'k')?.sha).toBe(await gitBlobSha1(original))
  })

  it("references what a merge takes from another branch's push", async () => {
    const gh = new FakeGithub()
    const a = await device(gh)
    await a.vk.commit({ updates: new Map([['base', bytes('b')]]) })
    await pushBranch(a.store, a.remote, 'main')
    const dev = (await a.vk.createBranch('dev')) as VersionedKV
    const value = binary(2)
    await dev.commit({ updates: new Map([['from-dev', value]]) })
    await pushBranch(a.store, a.remote, 'dev')
    expect(gh.count('POST', 'git/blobs')).toBe(1)

    await a.vk.commit({ updates: new Map([['m', bytes('main')]]) })
    const merged = await a.vk.mergeHeads(dev.currentCommit)
    expect(merged.strategy).toBe('three_way')
    expect((await pushBranch(a.store, a.remote, 'main')).status).toBe('pushed')
    // Pushing main sends its own commit and the merge; dev's value is
    // referenced, not sent again.
    expect(gh.count('POST', 'git/blobs')).toBe(1)
    expect(entryAt(treePosts(gh).at(-1), 'from-dev')?.sha).toBe(await gitBlobSha1(value))
  })

  it('sends the bytes after all when the repo no longer has the blob', async () => {
    const gh = new FakeGithub()
    const a = await device(gh)
    const value = binary(3)
    await a.vk.commit({ updates: new Map([['k', value]]) })
    await pushBranch(a.store, a.remote, 'main')
    gh.collect(await gitBlobSha1(value))

    await a.vk.commit({ updates: new Map([['copy', value]]) })
    const before = gh.calls.length
    expect((await pushBranch(a.store, a.remote, 'main')).status).toBe('pushed')
    // The tree referencing the missing blob was refused, then rebuilt
    // with the value uploaded.
    const after = gh.calls.slice(before)
    expect(after.filter((c) => c.method === 'POST' && c.path === 'git/trees').length).toBe(2)
    expect(after.filter((c) => c.method === 'POST' && c.path === 'git/blobs').length).toBe(1)
    expect(gh.blobs.has(await gitBlobSha1(value))).toBe(true)
  })

  it("records each value's hash in the sidecar", async () => {
    const gh = new FakeGithub()
    const a = await device(gh)
    await a.vk.commit({ updates: new Map([['k', bytes('v')]]) })
    await pushBranch(a.store, a.remote, 'main')
    const sidecar = decodeSidecar(
      bytes(entryAt(treePosts(gh).at(-1), SIDECAR_PATH)?.content as string),
    )
    expect(sidecar.updates.get('k')).toEqual({ path: 'k', blob: await sha256Hex(bytes('v')) })
  })
})

describe('fetch reads held values locally', () => {
  it('downloads a renamed value only the first time', async () => {
    const gh = new FakeGithub()
    const a = await device(gh)
    const b = freshDevice(gh)
    const value = binary(4)
    await a.vk.commit({ updates: new Map([['old/name', value]]) })
    await pushBranch(a.store, a.remote, 'main')

    let before = gh.calls.length
    expect((await pullBranch(b.store, b.remote, 'main')).status).toBe('created')
    expect(valueReads(gh.calls.slice(before)).length).toBe(1)

    await a.vk.commit({
      updates: new Map([['new/name', value]]),
      removals: new Set(['old/name']),
    })
    await pushBranch(a.store, a.remote, 'main')
    before = gh.calls.length
    expect((await pullBranch(b.store, b.remote, 'main')).status).toBe('fast-forwarded')
    expect(valueReads(gh.calls.slice(before))).toEqual([])

    const reopened = await VersionedKV.open(b.store)
    expect(await reopened.get('new/name')).toEqual(value)
    expect(await reopened.get('old/name')).toBeNull()
  })

  it('downloads a value several commits share once', async () => {
    const gh = new FakeGithub()
    const a = await device(gh)
    const b = freshDevice(gh)
    const value = binary(5)
    await a.vk.commit({ updates: new Map([['one', value]]) })
    await a.vk.commit({ updates: new Map([['two', value]]) })
    await a.vk.commit({ updates: new Map([['three', value]]) })
    await pushBranch(a.store, a.remote, 'main')

    const before = gh.calls.length
    await pullBranch(b.store, b.remote, 'main')
    expect(valueReads(gh.calls.slice(before)).length).toBe(1)
    const reopened = await VersionedKV.open(b.store)
    for (const k of ['one', 'two', 'three']) expect(await reopened.get(k)).toEqual(value)
  })

  it('a pulled device references what it fetched when it pushes', async () => {
    const gh = new FakeGithub()
    const a = await device(gh)
    const b = freshDevice(gh)
    const value = binary(6)
    await a.vk.commit({ updates: new Map([['k', value]]) })
    await pushBranch(a.store, a.remote, 'main')
    await pullBranch(b.store, b.remote, 'main')

    const vkB = await VersionedKV.open(b.store)
    await vkB.commit({ updates: new Map([['copy', value]]) })
    const blobsBefore = gh.count('POST', 'git/blobs')
    expect((await pushBranch(b.store, b.remote, 'main')).status).toBe('pushed')
    expect(gh.count('POST', 'git/blobs')).toBe(blobsBefore)
    expect(entryAt(treePosts(gh).at(-1), 'copy')?.sha).toBe(await gitBlobSha1(value))
  })
})
