/**
 * A logged database between two devices, through kvgit's pack sync
 * and a fake GitHub: an epoch whose snapshot takes several requests,
 * each within the size one request may be, and the old epoch deleted
 * remotely once nothing was pushed to it since.
 */

import { deleteRemoteBranch, pullBranch, pushBranch } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { PackRemote } from '@agex-ts/kvgit/github'
import { FakeGithub } from '@agex-ts/kvgit/github/fake'
import { describe, expect, it } from 'vitest'
import { MemoryDirectory, SNAPSHOT_CHUNK } from '../src/index'
import { BRANCH, open, quietSqliteWarnings, replica, repoOver } from './log-helpers'

quietSqliteWarnings()

const NEXT = 'db/test/1'

/** Every row of `b`, as `[id, bytes]`. */
async function rows(db: Awaited<ReturnType<typeof open>>): Promise<Array<[number, Uint8Array]>> {
  const result = await db.query('SELECT id, v FROM b ORDER BY id')
  return result.rows.map((r) => [r.id as number, r.v as Uint8Array])
}

describe('a logged database through pack sync', () => {
  it('sends an epoch too large for one request in several, and deletes the old one', async () => {
    // GitHub refuses bodies over about 45 MB; the fake refuses less
    const gh = new FakeGithub({ maxBodyBytes: 31 << 20 })
    const aStore = new Memory()
    const aRemote = new PackRemote(gh.client(), aStore)
    const a = await open(new MemoryDirectory(), await repoOver(aStore), { epochs: false })
    await a.query('CREATE TABLE b (id INTEGER PRIMARY KEY NOT NULL, v BLOB)')
    await a.query("INSERT INTO b VALUES (0, x'00')")
    await a.flush()
    expect((await pushBranch(aStore, aRemote, BRANCH)).status).toBe('created')

    const bStore = new Memory()
    const bRemote = new PackRemote(gh.client(), bStore)
    expect((await pullBranch(bStore, bRemote, BRANCH)).status).toBe('created')

    // random bytes don't compress: five chunks gzipped, two to a commit
    for (let i = 1; i <= 9; i++) {
      await a.query('INSERT INTO b VALUES (?, randomblob(?))', [i, SNAPSHOT_CHUNK / 2])
    }
    const epoch = await a.newEpoch()
    expect(epoch.branch).toBe(NEXT)
    expect(epoch.chunks).toBe(5)
    await a.query("INSERT INTO b VALUES (10, x'0a')")
    await a.flush()

    gh.calls.length = 0
    const pushed = await pushBranch(aStore, aRemote, NEXT)
    expect(pushed.status).toBe('created')
    // 16 MiB of values to a pack at most: the snapshot's three commits
    // (two chunks, two chunks, one) and the entry after it take three
    expect(gh.count('graphql-mutation')).toBe(3)
    expect(gh.filesAt(NEXT).filter((p) => p.endsWith('.pack'))).toHaveLength(3)

    // nothing was pushed to the old epoch since: it goes
    expect((await deleteRemoteBranch(aStore, aRemote, BRANCH)).status).toBe('deleted')
    expect((await aRemote.listRefs()).map((r) => r.branch)).toEqual([NEXT])

    expect((await pullBranch(bStore, bRemote, BRANCH)).status).toBe('remote-gone')
    expect((await pullBranch(bStore, bRemote, NEXT)).status).toBe('created')
    const b = await replica(await repoOver(bStore), { branch: NEXT, epochs: false })
    expect(b.branch).toBe(NEXT)
    const want = await rows(a)
    const got = await rows(b)
    expect(got.map(([id]) => id)).toEqual(want.map(([id]) => id))
    for (const [i, [, bytes]] of got.entries()) {
      expect(Buffer.from(bytes).equals(Buffer.from((want[i] as [number, Uint8Array])[1]))).toBe(
        true,
      )
    }
    await b.close()
    await a.close()
  }, 180_000)
})
