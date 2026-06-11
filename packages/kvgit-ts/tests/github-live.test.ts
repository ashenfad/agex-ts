/**
 * Live verification against a real GitHub repo — the kvgit-remotes
 * design doc's checklist, encoded as tests.
 *
 * Skipped unless both env vars are set:
 *
 *   KVGIT_GH_TOKEN  - a PAT with contents read/write on the repo
 *   KVGIT_GH_REPO   - "owner/name" of a SCRATCH repo (tests create
 *                     orphan objects and temp branches; they clean up
 *                     refs but not objects)
 *
 * Run: KVGIT_GH_TOKEN=$(gh auth token) KVGIT_GH_REPO=you/scratch pnpm vitest run tests/github-live.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EMPTY_TREE_SHA, GithubClient, gitBlobSha1 } from '../src/github/index'

const TOKEN = process.env.KVGIT_GH_TOKEN ?? ''
const REPO = process.env.KVGIT_GH_REPO ?? ''
const LIVE = TOKEN.length > 0 && REPO.length > 0

const PERSON = { name: 'kvgit-live-test', email: 'test@agex.dev', date: '2024-06-01T12:00:00Z' }
const PERSON2 = { ...PERSON, date: '2024-06-01T12:00:01Z' }

describe.runIf(LIVE)('GitHub Git Data API (live)', () => {
  const client = new GithubClient({
    token: TOKEN,
    repo: REPO,
    // Faster than the production default; still serialized.
    writeIntervalMs: 250,
  })
  const tempBranch = `kvgit-live-${Date.now().toString(36)}`
  let baseCommit = ''
  let baseTree = ''

  beforeAll(async () => {
    const main = await client.getRef('main')
    if (main === null) throw new Error('live repo needs a main branch (create with a README)')
    baseCommit = main
    baseTree = (await client.getCommit(main)).tree
  })

  afterAll(async () => {
    await client.deleteRef(tempBranch)
    await client.deleteRef(`archived/${tempBranch}`)
  })

  it('round-trips a binary blob, and the local SHA-1 predicts the remote SHA', async () => {
    const bytes = new Uint8Array([0x62, 0x69, 0x6e, 0x00, 0x01, 0x02])
    const predicted = await gitBlobSha1(bytes)
    const sha = await client.createBlob(bytes)
    expect(sha).toBe(predicted) // the dedup premise
    expect(await client.getBlob(sha)).toEqual(bytes)
  })

  it('accepts a ~1MB binary blob (checklist: blob size floor)', async () => {
    const big = new Uint8Array(1_000_000)
    for (let i = 0; i < big.length; i++) big[i] = i % 251
    const sha = await client.createBlob(big)
    expect(sha).toBe(await gitBlobSha1(big))
  })

  it('synthesizes nested paths via base_tree, then commits with exact dates', async () => {
    const blobSha = await client.createBlob(new TextEncoder().encode('leaf'))
    const tree = await client.createTree(
      [
        {
          path: 'sessions/chat-xy/files/deep/leaf.txt',
          mode: '100644',
          type: 'blob',
          sha: blobSha,
        },
        { path: '.kvgit/commit.json', mode: '100644', type: 'blob', content: '{"format":1}' },
      ],
      baseTree,
    )
    const sha = await client.createCommit({
      message: 'live: nested tree\n\nKvgit-Hash: 0123456789012345678901234567890123456789',
      tree,
      parents: [baseCommit],
      author: PERSON,
      committer: PERSON2,
    })
    const back = await client.getCommit(sha)
    expect(back.parents).toEqual([baseCommit])
    expect(back.authorDate).toBe(PERSON.date)
    expect(back.committerDate).toBe(PERSON2.date)

    // Ref CAS lifecycle on a temp branch.
    expect(await client.createRef(tempBranch, baseCommit)).toBe(true)
    expect(await client.createRef(tempBranch, baseCommit)).toBe(false) // exists
    expect(await client.updateRef(tempBranch, sha)).toBe(true) // fast-forward
    expect(await client.updateRef(tempBranch, baseCommit)).toBe(false) // non-FF rejected
    expect(await client.getRef(tempBranch)).toBe(sha)
  })

  it('creates multi-parent merge commits', async () => {
    const head = (await client.getRef(tempBranch)) as string
    const sibling = await client.createCommit({
      message: 'live: sibling',
      tree: baseTree,
      parents: [baseCommit],
      author: PERSON,
      committer: PERSON,
    })
    const merge = await client.createCommit({
      message: 'live: merge',
      tree: baseTree,
      parents: [head, sibling],
      author: PERSON,
      committer: PERSON2,
    })
    expect((await client.getCommit(merge)).parents).toEqual([head, sibling])
    expect(await client.updateRef(tempBranch, merge)).toBe(true)
  })

  it('rejects commits whose parents do not exist (topological-order constraint)', async () => {
    await expect(
      client.createCommit({
        message: 'live: orphan',
        tree: baseTree,
        parents: [`${'0'.repeat(39)}1`],
        author: PERSON,
        committer: PERSON,
      }),
    ).rejects.toThrow(/parent/i)
  })

  it('accepts the canonical empty tree (checklist: all-keys-removed commits)', async () => {
    const sha = await client.createCommit({
      message: 'live: empty tree',
      tree: EMPTY_TREE_SHA,
      parents: [baseCommit],
      author: PERSON,
      committer: PERSON,
    })
    expect((await client.getCommit(sha)).tree).toBe(EMPTY_TREE_SHA)
  })

  it('paginates the commits list walk-back (checklist: fetch primitive)', async () => {
    const tip = (await client.getRef(tempBranch)) as string
    const page1 = await client.listCommits({ sha: tip, perPage: 2, page: 1 })
    const page2 = await client.listCommits({ sha: tip, perPage: 2, page: 2 })
    expect(page1.length).toBe(2)
    expect(page1[0]?.sha).toBe(tip)
    expect(page1[0]?.parents.length).toBeGreaterThan(0)
    expect(page2.length).toBeGreaterThan(0)
    expect(new Set([...page1, ...page2].map((c) => c.sha)).size).toBe(page1.length + page2.length)
  })

  it('lists slashed refs and renames via create+delete (checklist: archive tombstones)', async () => {
    const tip = (await client.getRef(tempBranch)) as string
    expect(await client.createRef(`archived/${tempBranch}`, tip)).toBe(true)
    expect(await client.deleteRef(tempBranch)).toBe(true)

    const refs = await client.listBranchRefs()
    const names = refs.map((r) => r.branch)
    expect(names).toContain(`archived/${tempBranch}`)
    expect(names).not.toContain(tempBranch)

    // Restore: rename back.
    expect(await client.createRef(tempBranch, tip)).toBe(true)
    expect(await client.deleteRef(`archived/${tempBranch}`)).toBe(true)
  })
})

describe.runIf(!LIVE)('GitHub live suite', () => {
  it.skip('skipped: set KVGIT_GH_TOKEN and KVGIT_GH_REPO to run', () => {})
})
