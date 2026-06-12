/**
 * Live roster lifecycle: archive → trash view → restore → empty
 * trash, against a real repo. Env-gated like the other live suites:
 *
 *   KVGIT_GH_TOKEN=$(gh auth token) KVGIT_GH_REPO=you/scratch \
 *     pnpm vitest run tests/github-roster-live.test.ts
 */

import { afterAll, describe, expect, it } from 'vitest'
import { Memory } from '../src/backends/memory'
import { GithubClient, GithubRemote } from '../src/github/index'
import { VersionedKV, pullBranch, pushBranch } from '../src/index'

const TOKEN = process.env.KVGIT_GH_TOKEN ?? ''
const REPO = process.env.KVGIT_GH_REPO ?? ''
const LIVE = TOKEN.length > 0 && REPO.length > 0

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

const BRANCH = `kvgit-roster-${Date.now().toString(36)}`

describe.runIf(LIVE)('roster lifecycle (live)', () => {
  const store = new Memory()
  const remote = new GithubRemote(
    new GithubClient({ token: TOKEN, repo: REPO, writeIntervalMs: 200 }),
    store,
  )

  afterAll(async () => {
    await remote.client.deleteRef(BRANCH)
    await remote.client.deleteRef(`archived/${BRANCH}`)
    await remote.client.deleteRef(`${BRANCH}-restored`)
  })

  it('pushes a session and reads stub metadata at the tip', async () => {
    const vk = await VersionedKV.open(store, { branch: BRANCH })
    await vk.commit({
      updates: new Map([
        ['__branch_meta__', bytes(JSON.stringify({ title: 'Roster test session' }))],
        ['payload', bytes('content')],
      ]),
    })
    expect((await pushBranch(store, remote, BRANCH)).status).toBe('created')

    // The cloud-stub primitive: one key's bytes, no materialization.
    const meta = await remote.readKeyAtTip(BRANCH, '__branch_meta__')
    expect(JSON.parse(dec.decode(meta as Uint8Array))).toEqual({ title: 'Roster test session' })
    expect(await remote.readKeyAtTip(BRANCH, 'no-such-key')).toBeNull()
  }, 60_000)

  it('archive moves the session from roster to trash; double-archive is benign', async () => {
    expect(await remote.archiveBranch(BRANCH)).toBe(true)
    expect(await remote.archiveBranch(BRANCH)).toBe(false) // live ref gone

    const roster = await remote.listRefs()
    expect(roster.map((r) => r.branch)).not.toContain(BRANCH)
    const trash = await remote.listArchivedRefs()
    const entry = trash.find((r) => r.branch === BRANCH)
    expect(entry).toBeDefined()

    // Archived sessions don't sync (the orchestration sees remote-gone
    // territory): pull from a fresh store finds no live ref.
    const fresh = new Memory()
    const freshRemote = new GithubRemote(
      new GithubClient({ token: TOKEN, repo: REPO, writeIntervalMs: 200 }),
      fresh,
    )
    expect((await pullBranch(fresh, freshRemote, BRANCH)).status).toBe('up-to-date')
  }, 60_000)

  it('restore brings the session back, and a fresh device can pull it', async () => {
    expect(await remote.restoreBranch(BRANCH)).toBe(BRANCH)

    const fresh = new Memory()
    const freshRemote = new GithubRemote(
      new GithubClient({ token: TOKEN, repo: REPO, writeIntervalMs: 200 }),
      fresh,
    )
    const pulled = await pullBranch(fresh, freshRemote, BRANCH)
    expect(pulled.status).toBe('created')
    const vk = await VersionedKV.open(fresh, { branch: BRANCH })
    expect(dec.decode((await vk.get('payload')) as Uint8Array)).toBe('content')
  }, 60_000)

  it('empty trash hard-deletes tombstones; restore afterwards throws', async () => {
    expect(await remote.archiveBranch(BRANCH)).toBe(true)
    expect(await remote.emptyTrash()).toBeGreaterThanOrEqual(1)
    expect(await remote.listArchivedRefs()).toEqual([])
    await expect(remote.restoreBranch(BRANCH)).rejects.toThrow(/nothing archived/)
  }, 60_000)
})

describe.runIf(!LIVE)('roster lifecycle', () => {
  it.skip('skipped: set KVGIT_GH_TOKEN and KVGIT_GH_REPO to run', () => {})
})
