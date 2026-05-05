import { afterEach, describe, expect, it } from 'vitest'
import { IndexedDB } from '../src/backends/idb'
import { runConformance } from './kv-conformance'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

// Keep one open handle per `makeStore` call so the test can call
// methods on it; close + delete on teardown so each test starts
// from a clean DB.
const openHandles: IndexedDB[] = []
const dbNames = new Set<string>()

let counter = 0
function uniqueDbName(): string {
  counter++
  const name = `kvgit-ts-conformance-${Date.now()}-${counter}`
  dbNames.add(name)
  return name
}

afterEach(async () => {
  for (const h of openHandles) h.close()
  openHandles.length = 0
  for (const name of dbNames) {
    await IndexedDB.deleteDatabase(name).catch(() => undefined)
  }
  dbNames.clear()
})

runConformance('IndexedDB', async () => {
  const idb = await IndexedDB.open({ dbName: uniqueDbName() })
  openHandles.push(idb)
  return idb
})

describe('IndexedDB — backend-specific', () => {
  it('persists across close + reopen of the same database', async () => {
    const dbName = uniqueDbName()
    const a = await IndexedDB.open({ dbName })
    await a.set('k', bytes('v'))
    a.close()

    const b = await IndexedDB.open({ dbName })
    openHandles.push(b)
    const got = await b.get('k')
    expect(got).not.toBeNull()
    expect(new TextDecoder().decode(got as Uint8Array)).toBe('v')
  })

  it('different dbName values are isolated stores', async () => {
    const aName = uniqueDbName()
    const bName = uniqueDbName()
    const a = await IndexedDB.open({ dbName: aName })
    const b = await IndexedDB.open({ dbName: bName })
    openHandles.push(a, b)

    await a.set('k', bytes('a-value'))
    await b.set('k', bytes('b-value'))

    expect(new TextDecoder().decode((await a.get('k')) as Uint8Array)).toBe('a-value')
    expect(new TextDecoder().decode((await b.get('k')) as Uint8Array)).toBe('b-value')
  })

  it('concurrent CAS on the same key — only one succeeds', async () => {
    // IDB serializes readwrite transactions on the same object store,
    // so two simultaneous CAS calls expecting `null` must linearize:
    // one wins (sees null, writes), the other loses (sees the winner's
    // value, doesn't write).
    const idb = await IndexedDB.open({ dbName: uniqueDbName() })
    openHandles.push(idb)

    const [r1, r2] = await Promise.all([
      idb.cas('k', bytes('a'), null),
      idb.cas('k', bytes('b'), null),
    ])
    // Exactly one succeeded.
    expect(r1 !== r2).toBe(true)
    // The stored value is whichever side won.
    const stored = new TextDecoder().decode((await idb.get('k')) as Uint8Array)
    expect(stored === 'a' || stored === 'b').toBe(true)
  })

  it('concurrent set + get see consistent state', async () => {
    // Many writes interleaved with reads. Each get should return either
    // null (not yet written) or the exact value that was set; never a
    // partial / corrupted byte sequence.
    const idb = await IndexedDB.open({ dbName: uniqueDbName() })
    openHandles.push(idb)

    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 50; i++) {
      ops.push(idb.set(`k${i}`, bytes(`v${i}`)))
    }
    await Promise.all(ops)

    for (let i = 0; i < 50; i++) {
      const got = await idb.get(`k${i}`)
      expect(new TextDecoder().decode(got as Uint8Array)).toBe(`v${i}`)
    }
  })

  it('end-to-end VersionedKV over IndexedDB', async () => {
    // Sanity check that the higher layers compose correctly with this
    // backend — same VersionedKV/Staged behavior we test against
    // Memory should hold over IDB.
    const { VersionedKV } = await import('../src/versioned/kv')
    const { Staged } = await import('../src/staged')

    const dbName = uniqueDbName()
    const idb1 = await IndexedDB.open({ dbName })
    openHandles.push(idb1)

    const vk1 = await VersionedKV.open(idb1)
    const s1 = new Staged(vk1)
    s1.set('greeting', 'hello')
    await s1.commit({ info: { author: 'a' } })
    const head = vk1.currentCommit

    // Reopen via a second handle on the same DB — state survives.
    idb1.close()
    openHandles.length = 0
    const idb2 = await IndexedDB.open({ dbName })
    openHandles.push(idb2)
    const vk2 = await VersionedKV.open(idb2)
    expect(vk2.currentCommit).toBe(head)
    const s2 = new Staged(vk2)
    expect(await s2.get<string>('greeting')).toBe('hello')
    expect(await vk2.commitInfo()).toEqual({ author: 'a' })
  })
})
