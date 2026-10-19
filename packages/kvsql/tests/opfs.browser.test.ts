/**
 * The database on real OPFS files, in a dedicated worker (the only
 * place synchronous access handles exist). The scenarios live in
 * `opfs.worker.ts`; these tests run them and check the results.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let worker: Worker
let nextId = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function run<T>(scenario: string): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker.postMessage({ id, scenario })
  })
}

beforeAll(() => {
  worker = new Worker(new URL('./opfs.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const { id, result, error } = event.data
    const waiter = pending.get(id)
    pending.delete(id)
    if (error !== undefined) waiter?.reject(new Error(error))
    else waiter?.resolve(result)
  }
  worker.onerror = (event) => {
    for (const waiter of pending.values())
      waiter.reject(new Error(`worker error: ${event.message}`))
    pending.clear()
  }
})

afterAll(() => worker.terminate())

describe('openDatabase on OPFS', () => {
  it('creates, writes, closes, reopens, reads back and deletes a database', async () => {
    const got = await run<{
      rows: unknown
      journalMode: unknown
      integrity: unknown
      dbSize: number
      journalHot: boolean
      existsAfterDelete: { db: boolean; journal: boolean }
    }>('roundtrip')
    expect(got.rows).toEqual([
      { id: 1, v: 'a' },
      { id: 2, v: 'b' },
    ])
    expect(got.journalMode).toBe('persist')
    expect(got.integrity).toBe('ok')
    expect(got.dbSize).toBeGreaterThan(0)
    expect(got.journalHot).toBe(false)
    expect(got.existsAfterDelete).toEqual({ db: false, journal: false })
  })

  it("gives a large delete's pages back, shrinking the file", async () => {
    const got = await run<{
      full: number
      deleted: number
      freed: number
      reclaimed: number
      integrity: unknown
      rows: number
    }>('reclaim')
    expect(got.deleted).toBe(got.full)
    expect(got.freed).toBeGreaterThan(0)
    expect(got.reclaimed).toBeLessThan(got.full / 4)
    expect(got.integrity).toBe('ok')
    expect(got.rows).toBe(400)
  })

  it('allows one connection per database', async () => {
    const got = await run<Record<string, unknown>>('exclusive')
    console.log(`kvsql exclusive ${navigator.userAgent}: ${JSON.stringify(got)}`)
    expect(got.sameDirectory).toMatch(/already open/)
    // Another handle on the same OPFS directory can't get the files'
    // access handles while they are held.
    expect(got.otherHandle).not.toBe('succeeded')
    expect(got.reopen).toBe('succeeded')
  })

  it('pins down what deleting an open database file does', async () => {
    const got = await run<Record<string, unknown>>('exclusive')
    const webkit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome/.test(navigator.userAgent)
    // The open database keeps working either way.
    expect(got.writeAfterDelete).toBe('succeeded')
    expect(got.rowsBeforeClose).toBe(2)
    if (webkit) {
      // WebKit deletes a file whose access handle is open. The handle
      // goes on reading and writing, but the file is gone once it
      // closes: the database is lost.
      expect(got.deleteWhileOpen).toBe('succeeded')
      expect(got.existsAfterClose).toBe(false)
      expect(got.rowsAfterReopen).toBe('no table')
    } else {
      // Chromium and Firefox refuse, as the File System spec says.
      expect(got.deleteWhileOpen).toMatch(/NoModificationAllowedError/)
      expect(got.existsAfterClose).toBe(true)
      expect(got.rowsAfterReopen).toBe(2)
    }
  })

  it('recovers the last committed state from a crash on OPFS files', async () => {
    const got =
      await run<
        {
          point: unknown
          threw: boolean
          crashed: boolean
          hotAfterCrash: boolean
          hotAfterReopen: boolean
          state: string
          integrity: unknown
        }[]
      >('recovery')
    const before = '300/0'
    const after = '240/120'
    for (const r of got) {
      const label = JSON.stringify(r)
      expect(r.threw && r.crashed, label).toBe(true)
      expect(r.integrity, label).toBe('ok')
      expect(r.hotAfterReopen, label).toBe(false)
    }
    // Before the journal's header is zeroed, the transaction rolls back
    // (from a hot journal once the journal is synced).
    expect(got.slice(0, 5).map((r) => r.state)).toEqual([before, before, before, before, before])
    expect(got.map((r) => r.hotAfterCrash)).toEqual([false, false, false, true, true, false])
    // A crash at the sync after the commit write keeps the commit.
    expect(got[5]?.state).toBe(after)
  })

  // Timings are logged for a reader to compare, never asserted: a
  // loaded runner is slow, not wrong. The timeout leaves room for that.
  it('times the basics', async () => {
    const got = await run<{
      transactions: number
      rowsRead: number
      perMode: Record<string, { rows: unknown }>
    }>('timings')
    console.log(`kvsql timings ${navigator.userAgent}: ${JSON.stringify(got)}`)
    expect(got.rowsRead).toBe(10000)
    expect(Object.keys(got.perMode)).toEqual(['truncate', 'persist', 'delete'])
    for (const mode of Object.values(got.perMode)) expect(mode.rows).toBe(got.transactions)
  }, 60_000)
})
