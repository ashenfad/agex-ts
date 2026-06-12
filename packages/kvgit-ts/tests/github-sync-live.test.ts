/**
 * The full multi-device loop, live: device A and device B sync one
 * session through a real GitHub repo using the complete stack —
 * walkDelta/applyWire + pullBranch/pushBranch + GithubRemote
 * push/fetch. Env-gated like the other live suites:
 *
 *   KVGIT_GH_TOKEN=$(gh auth token) KVGIT_GH_REPO=you/scratch \
 *     pnpm vitest run tests/github-sync-live.test.ts
 */

import { afterAll, describe, expect, it } from 'vitest'
import { Memory } from '../src/backends/memory'
import { GithubClient, GithubRemote } from '../src/github/index'
import { VersionedKV, getSyncHead, pullBranch, pushBranch } from '../src/index'

const TOKEN = process.env.KVGIT_GH_TOKEN ?? ''
const REPO = process.env.KVGIT_GH_REPO ?? ''
const LIVE = TOKEN.length > 0 && REPO.length > 0

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
const text = (b: Uint8Array): string => dec.decode(b)

const BRANCH = `kvgit-loop-${Date.now().toString(36)}`

function makeRemote(store: Memory): GithubRemote {
  return new GithubRemote(
    new GithubClient({ token: TOKEN, repo: REPO, writeIntervalMs: 200 }),
    store,
  )
}

describe.runIf(LIVE)('multi-device sync loop (live)', () => {
  // Two devices, two stores, one branch name.
  const aStore = new Memory()
  const bStore = new Memory()
  const aRemote = makeRemote(aStore)
  const bRemote = makeRemote(bStore)

  afterAll(async () => {
    await aRemote.client.deleteRef(BRANCH)
  })

  it('A pushes, B pulls from scratch: heads, values, and history converge', async () => {
    const vk = await VersionedKV.open(aStore, { branch: BRANCH })
    await vk.commit({ updates: new Map([['greeting', bytes('hello')]]), info: { title: 'greet' } })
    await vk.commit({
      updates: new Map([['files/notes/plan.md', bytes('# plan')]]),
    })

    expect((await pushBranch(aStore, aRemote, BRANCH)).status).toBe('created')

    const pulled = await pullBranch(bStore, bRemote, BRANCH)
    expect(pulled.status).toBe('created')
    expect(pulled.localHead).toBe(vk.currentCommit)

    const bVk = await VersionedKV.open(bStore, { branch: BRANCH })
    expect(bVk.currentCommit).toBe(vk.currentCommit)
    expect(text((await bVk.get('greeting')) as Uint8Array)).toBe('hello')
    expect(text((await bVk.get('files/notes/plan.md')) as Uint8Array)).toBe('# plan')

    // History (and commit info) replayed, not just the tip state.
    const history: string[] = []
    for await (const c of bVk.history()) history.push(c)
    expect(history.length).toBe(3) // initial + greet + plan
    expect(await bVk.commitInfo(history[1] as string)).toEqual({ title: 'greet' })
  }, 120_000)

  it("B extends and pushes — fetch armed B's transport state", async () => {
    const bVk = await VersionedKV.open(bStore, { branch: BRANCH })
    await bVk.commit({ updates: new Map([['from-b', bytes('b-turn')]]) })

    const pushed = await pushBranch(bStore, bRemote, BRANCH)
    expect(pushed.status).toBe('pushed')
    expect(pushed.transferred).toBe(1)
    expect(await getSyncHead(bStore, BRANCH)).toBe(bVk.currentCommit)
  }, 60_000)

  it("A pulls B's turn: the loop closes", async () => {
    const pulled = await pullBranch(aStore, aRemote, BRANCH)
    expect(pulled.status).toBe('fast-forwarded')
    expect(pulled.transferred).toBe(1) // delta only

    const aVk = await VersionedKV.open(aStore, { branch: BRANCH })
    expect(text((await aVk.get('from-b')) as Uint8Array)).toBe('b-turn')
    expect(text((await aVk.get('greeting')) as Uint8Array)).toBe('hello')
  }, 60_000)

  it('ping-pong continues: A extends, pushes, B pulls incrementally', async () => {
    const aVk = await VersionedKV.open(aStore, { branch: BRANCH })
    await aVk.commit({ updates: new Map([['from-a-2', bytes('a-again')]]) })
    // A pulled B's commits, so A's transport state was armed by fetch
    // too — its incremental push must work.
    expect((await pushBranch(aStore, aRemote, BRANCH)).status).toBe('pushed')

    const pulled = await pullBranch(bStore, bRemote, BRANCH)
    expect(pulled.status).toBe('fast-forwarded')
    expect(pulled.transferred).toBe(1)
    const bVk = await VersionedKV.open(bStore, { branch: BRANCH })
    expect(bVk.currentCommit).toBe(aVk.currentCommit)
  }, 60_000)

  it('rebuildTransportState recovers a lost-state device', async () => {
    // Wipe B's transport state, extend B locally → push hits the
    // stale-state guard → rebuild from remote sidecars → push lands.
    await bStore.remove(`__ghsync__${REPO}__${BRANCH}`)
    const bVk = await VersionedKV.open(bStore, { branch: BRANCH })
    await bVk.commit({ updates: new Map([['recovered', bytes('yes')]]) })

    await expect(pushBranch(bStore, bRemote, BRANCH)).rejects.toThrow(/transport state/)
    await bRemote.rebuildTransportState(BRANCH)
    const pushed = await pushBranch(bStore, bRemote, BRANCH)
    expect(pushed.status).toBe('pushed')

    // And A can still pull the result.
    const pulled = await pullBranch(aStore, aRemote, BRANCH)
    expect(pulled.status).toBe('fast-forwarded')
    const aVk = await VersionedKV.open(aStore, { branch: BRANCH })
    expect(text((await aVk.get('recovered')) as Uint8Array)).toBe('yes')
  }, 120_000)
})

describe.runIf(!LIVE)('multi-device sync loop', () => {
  it.skip('skipped: set KVGIT_GH_TOKEN and KVGIT_GH_REPO to run', () => {})
})
