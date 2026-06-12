/**
 * Live GithubRemote.push verification — runs the real push pipeline
 * (blobs → trees → commits → ref CAS) through the sync orchestration
 * against a scratch repo. Env-gated like tests/github-live.test.ts:
 *
 *   KVGIT_GH_TOKEN=$(gh auth token) KVGIT_GH_REPO=you/scratch \
 *     pnpm vitest run tests/github-remote-live.test.ts
 */

import { afterAll, describe, expect, it } from 'vitest'
import { Memory } from '../src/backends/memory'
import {
  GithubClient,
  GithubRemote,
  SIDECAR_PATH,
  decodeSidecar,
  kvgitHashFromMessage,
} from '../src/github/index'
import { VersionedKV, pushBranch, walkDelta } from '../src/index'

const TOKEN = process.env.KVGIT_GH_TOKEN ?? ''
const REPO = process.env.KVGIT_GH_REPO ?? ''
const LIVE = TOKEN.length > 0 && REPO.length > 0

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

const RUN = Date.now().toString(36)
const BRANCH = `kvgit-push-${RUN}`
const BRANCH2 = `kvgit-resume-${RUN}`

function makeClient(fetchImpl?: typeof fetch): GithubClient {
  return new GithubClient({
    token: TOKEN,
    repo: REPO,
    writeIntervalMs: 200,
    ...(fetchImpl !== undefined && { fetchImpl, maxRetries: 0 }),
  })
}

/** Local session: linear commits, a divergence merge (carry), and a
 *  removal — the full wire-shape zoo. */
async function buildSession(store: Memory, branch: string): Promise<VersionedKV> {
  const vk = await VersionedKV.open(store, { branch })
  await vk.commit({ updates: new Map([['greeting', bytes('hello')]]), info: { title: 'greet' } })
  await vk.commit({
    updates: new Map([
      ['files/notes/a.txt', bytes('aaa')],
      ['temp', bytes('scratch')],
    ]),
  })
  const stale = await VersionedKV.open(store, { branch, commitHash: vk.currentCommit })
  await vk.commit({ updates: new Map([['ka', bytes('from-a')]]) })
  const r = await stale.commit({ updates: new Map([['kb', bytes('from-b')]]) })
  expect(r.strategy).toBe('three_way')
  const merged = await VersionedKV.open(store, { branch })
  await merged.commit({ removals: new Set(['temp']) })
  return merged
}

describe.runIf(LIVE)('GithubRemote.push (live)', () => {
  const cleanup = makeClient()

  afterAll(async () => {
    await cleanup.deleteRef(BRANCH)
    await cleanup.deleteRef(BRANCH2)
  })

  it('pushes a full session through pushBranch, with verifiable remote shape', async () => {
    const store = new Memory()
    const vk = await buildSession(store, BRANCH)
    const client = makeClient()
    const remote = new GithubRemote(client, store)

    const result = await pushBranch(store, remote, BRANCH)
    expect(result.status).toBe('created')
    expect(result.transferred).toBeGreaterThanOrEqual(6) // initial+4+merge

    // The remote tip's trailer is the kvgit head.
    const tipSha = (await client.getRef(BRANCH)) as string
    const tip = await client.getCommit(tipSha)
    expect(kvgitHashFromMessage(tip.message)).toBe(vk.currentCommit)

    // Every kvgit commit appears exactly once on the remote branch,
    // and the merge commit has two git parents.
    const localHashes: string[] = []
    for await (const wc of walkDelta(store, { want: vk.currentCommit })) {
      localHashes.push(wc.hash)
    }
    const remoteCommits = await client.listCommits({ sha: tipSha, perPage: 100 })
    const remoteHashes = remoteCommits
      .map((c) => kvgitHashFromMessage(c.message))
      .filter((h): h is string => h !== null)
    expect([...remoteHashes].sort()).toEqual([...localHashes].sort())
    expect(remoteCommits.some((c) => c.parents.length === 2)).toBe(true)

    // The tip tree renders the keyset: nested file present, removed
    // key absent, sidecar present and decodable.
    const tree = await client.getTree(tip.tree, { recursive: true })
    const paths = tree.entries.map((e) => e.path)
    expect(paths).toContain('files/notes/a.txt')
    expect(paths).toContain('greeting')
    expect(paths).toContain(SIDECAR_PATH)
    expect(paths).not.toContain('temp')

    // Tip sidecar describes the removal commit.
    const sidecarSha = tree.entries.find((e) => e.path === SIDECAR_PATH)?.sha as string
    const sidecar = decodeSidecar(await client.getBlob(sidecarSha))
    expect(sidecar.hash).toBe(vk.currentCommit)
    expect([...sidecar.removals]).toEqual(['temp'])
    expect(sidecar.kernel).toBe('ts')

    // Incremental continuation: one more turn, pushed as a delta via
    // the persisted transport state + updateRef fast-forward.
    const vk2 = await VersionedKV.open(store, { branch: BRANCH })
    await vk2.commit({ updates: new Map([['round-2', bytes('more')]]) })
    const second = await pushBranch(store, remote, BRANCH)
    expect(second.status).toBe('pushed')
    expect(second.transferred).toBe(1)
    const newTip = (await client.getRef(BRANCH)) as string
    expect(kvgitHashFromMessage((await client.getCommit(newTip)).message)).toBe(vk2.currentCommit)
    expect((await client.getCommit(newTip)).parents).toEqual([tipSha])
  }, 120_000)

  it('refuses incremental pushes without transport state for the frontier', async () => {
    // A store that never pushed this branch holds no rendering state
    // for the remote frontier — pushing blind would desync sidecar
    // paths, so the transport throws before any upload.
    const store = new Memory()
    const remote = new GithubRemote(makeClient(), store)
    const tip = (await remote.listRefs()).find((r) => r.branch === BRANCH)?.head as string
    await expect(remote.push(BRANCH, tip, tip, [])).rejects.toThrow(/transport state/)
  }, 60_000)

  it('resumes an interrupted push with identical SHAs and no duplicates', async () => {
    const store = new Memory()
    const vk = await buildSession(store, BRANCH2)

    // First attempt: a client whose fetch dies after N requests,
    // mid-pipeline (past the precheck + a couple of blob uploads).
    let remaining = 8
    const dyingFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (remaining-- <= 0) throw new Error('simulated network death')
      return globalThis.fetch(url, init)
    }) as typeof fetch
    const dyingRemote = new GithubRemote(makeClient(dyingFetch), store)
    await expect(pushBranch(store, dyingRemote, BRANCH2)).rejects.toThrow(/Network error/)

    // The ref must not exist (CAS never ran).
    const client = makeClient()
    expect(await client.getRef(BRANCH2)).toBeNull()

    // Resume with a healthy client: same store, same wire stream.
    const remote = new GithubRemote(client, store)
    const result = await pushBranch(store, remote, BRANCH2)
    expect(result.status).toBe('created')

    // No duplicate kvgit commits despite re-created objects: each
    // hash appears exactly once (determinism made the re-uploads
    // land on identical SHAs).
    const tipSha = (await client.getRef(BRANCH2)) as string
    expect(kvgitHashFromMessage((await client.getCommit(tipSha)).message)).toBe(vk.currentCommit)
    const commits = await client.listCommits({ sha: tipSha, perPage: 100 })
    const hashes = commits
      .map((c) => kvgitHashFromMessage(c.message))
      .filter((h): h is string => h !== null)
    expect(new Set(hashes).size).toBe(hashes.length)
  }, 120_000)

  it('loses the create-CAS cleanly when the ref already exists', async () => {
    const store = new Memory()
    const vk = await buildSession(store, BRANCH)
    const remote = new GithubRemote(makeClient(), store)
    // BRANCH already exists (first test) → expectedOld=null precheck
    // loses before any upload.
    expect(
      await remote.push(
        BRANCH,
        null,
        vk.currentCommit,
        walkDelta(store, { want: vk.currentCommit }),
      ),
    ).toBe(false)
  }, 60_000)
})

describe.runIf(!LIVE)('GithubRemote live suite', () => {
  it.skip('skipped: set KVGIT_GH_TOKEN and KVGIT_GH_REPO to run', () => {})
})
