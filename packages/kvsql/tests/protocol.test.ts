/** Errors across a message boundary: serialized, structured-cloned, rebuilt. */

import { describe, expect, it } from 'vitest'
import { configKey } from '../src/host'
import {
  ConnectionLostError,
  CorruptEntryError,
  KvsqlError,
  LogError,
  RebaseRequiredError,
  RefusedError,
  ReplayError,
  SqliteError,
  StatementError,
  reviveError,
  serializeError,
} from '../src/index'

/** What the other side of a postMessage gets. */
function roundTrip(err: unknown): Error {
  return reviveError(structuredClone(serializeError(err)))
}

describe('errors across messages', () => {
  it("rebuild kvsql's errors as their classes, with their fields", () => {
    const sqlite = Object.assign(new Error('UNIQUE constraint failed: t.id'), {
      name: 'SQLite3Error',
      resultCode: 1555,
    })
    const cases: [Error, new (...args: never[]) => Error, Record<string, unknown>][] = [
      [new KvsqlError('plain'), KvsqlError, {}],
      [new SqliteError('sqlite3_open', 14, 'SQLITE_CANTOPEN'), SqliteError, { rc: 14 }],
      [new RefusedError('no BEGIN', { cause: sqlite }), RefusedError, {}],
      [new StatementError(2, sqlite), StatementError, { index: 2 }],
      [new LogError('diverged'), LogError, {}],
      [new CorruptEntryError('abc', 'bad digest'), CorruptEntryError, { commit: 'abc' }],
      [new ReplayError('abc', 7, 'conflict'), ReplayError, { commit: 'abc', seq: 7 }],
      [
        new RebaseRequiredError(3, 1, {
          conflicts: [
            {
              kind: 'DATA',
              action: 'abort',
              op: 'UPDATE',
              table: 't',
              columns: 2,
              indirect: false,
              pk: [1],
            },
          ],
        }),
        RebaseRequiredError,
        { pending: 3, entries: 1, schemaChange: null, conflicts: [{ kind: 'DATA', pk: [1] }] },
      ],
      [
        new RebaseRequiredError(2, 1, { schemaChange: 'theirs' }),
        RebaseRequiredError,
        { schemaChange: 'theirs', conflicts: [] },
      ],
      [new ConnectionLostError('gone'), ConnectionLostError, {}],
    ]
    for (const [original, Class, fields] of cases) {
      const got = roundTrip(original)
      expect(got, original.name).toBeInstanceOf(Class)
      expect(got).toBeInstanceOf(KvsqlError)
      expect(got).toBeInstanceOf(Error)
      expect(got.name).toBe(original.name)
      expect(got.message).toBe(original.message)
      expect(got.stack).toBe(original.stack)
      expect(Object.prototype.toString.call(got)).toBe('[object Error]')
      expect(got).toMatchObject(fields)
    }
    const statement = roundTrip(
      new StatementError(1, new RefusedError('refused', { cause: sqlite })),
    )
    expect(statement.cause).toBeInstanceOf(RefusedError)
    const sqliteCause = (statement.cause as Error).cause as Error & { resultCode?: number }
    expect(sqliteCause.name).toBe('SQLite3Error')
    expect(sqliteCause.message).toBe('UNIQUE constraint failed: t.id')
    expect(sqliteCause.resultCode).toBe(1555)
  })

  it("rebuild JavaScript's errors and DOMExceptions; others keep their name", () => {
    expect(roundTrip(new TypeError('bad'))).toBeInstanceOf(TypeError)
    expect(roundTrip(new RangeError('far')).name).toBe('RangeError')
    const quota = roundTrip(new DOMException('full', 'QuotaExceededError'))
    expect(quota).toBeInstanceOf(DOMException)
    expect(quota.name).toBe('QuotaExceededError')
    class Custom extends Error {
      override name = 'Custom'
      readonly head = 'c1'
    }
    const custom = roundTrip(new Custom('mine'))
    expect(custom.constructor).toBe(Error)
    expect(custom).toMatchObject({ name: 'Custom', message: 'mine', head: 'c1' })
    expect(roundTrip('a string')).toMatchObject({ name: 'Error', message: 'a string' })
    // A name that only looks like a class's own property isn't one.
    expect(reviveError({ name: 'constructor', message: 'x' }).constructor).toBe(Error)
  })
})

describe('configKey', () => {
  const key = (config: Record<string, unknown>) => configKey({ id: 'a', ...config } as never)

  it('ignores key order and members that are undefined', () => {
    expect(configKey({ id: 'a', flush: { every: 1, maxAgeMs: 2 } })).toBe(
      configKey({ flush: { maxAgeMs: 2, every: 1 }, id: 'a' }),
    )
    expect(key({ label: undefined })).toBe(key({}))
  })

  it('keeps values of different kinds apart, even when their text matches', () => {
    const distinct: Record<string, unknown>[] = [
      { n: 1n },
      { n: '1n' },
      { n: 1 },
      { n: '1' },
      { n: true },
      { n: 'true' },
      { n: null },
      { n: 'null' },
      { n: [1] },
      { n: '[1]' },
      { n: { x: 1 } },
      { n: { x: '1' } },
      { n: { x: 1n } },
      { n: [[1n]] },
      { n: [['1n']] },
      { n: [undefined] },
      { n: [null] },
      { n: new Uint8Array([1]) },
      { n: { 0: 1 } },
    ]
    const keys = distinct.map(key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
