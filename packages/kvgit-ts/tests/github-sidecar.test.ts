import { describe, expect, it } from 'vitest'
import { SIDECAR_FORMAT, decodeSidecar, encodeSidecar, wireFromSidecar } from '../src/github/index'
import type { WireCommit } from '../src/index'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

function sampleWire(): WireCommit {
  return {
    hash: 'a'.repeat(40),
    parents: ['b'.repeat(40), 'c'.repeat(40)], // order significant
    time: 1_760_000_000_000,
    info: { title: 'turn 7', nested: { ok: true } },
    updates: new Map([
      ['greeting', bytes('hello')],
      ['files/a.txt', bytes('aaa')],
    ]),
    removals: new Set(['old-key']),
    meta: new Map([
      ['greeting', { createdAt: 1_759_999_999_000 }],
      ['files/a.txt', { createdAt: 1_760_000_000_000 }],
    ]),
    carries: new Map([['kb', { owner: 'd'.repeat(40), size: 6, createdAt: 1_759_000_000_000 }]]),
  }
}

const PATHS = new Map([
  ['greeting', 'greeting'],
  ['files/a.txt', 'files/a.txt'],
])

describe('sidecar round-trip', () => {
  it('encodes and decodes every field faithfully', () => {
    const wire = sampleWire()
    const decoded = decodeSidecar(encodeSidecar(wire, { kernel: 'ts', paths: PATHS }))

    expect(decoded.kernel).toBe('ts')
    expect(decoded.hash).toBe(wire.hash)
    expect(decoded.parents).toEqual([...wire.parents]) // order preserved
    expect(decoded.time).toBe(wire.time)
    expect(decoded.info).toEqual(wire.info)
    expect(decoded.removals).toEqual(wire.removals)
    expect(decoded.updates.get('greeting')).toEqual({
      path: 'greeting',
      createdAt: 1_759_999_999_000,
    })
    expect(decoded.updates.get('files/a.txt')).toEqual({
      path: 'files/a.txt',
      createdAt: 1_760_000_000_000,
    })
    expect(decoded.carries.get('kb')).toEqual({
      owner: 'd'.repeat(40),
      size: 6,
      createdAt: 1_759_000_000_000,
    })
  })

  it('reassembles a WireCommit byte-identically via wireFromSidecar', () => {
    const wire = sampleWire()
    const decoded = decodeSidecar(encodeSidecar(wire, { kernel: 'ts', paths: PATHS }))
    const values = new Map([
      ['greeting', bytes('hello')],
      ['files/a.txt', bytes('aaa')],
    ])
    const rebuilt = wireFromSidecar(decoded, values)
    expect(rebuilt.hash).toBe(wire.hash)
    expect(rebuilt.parents).toEqual([...wire.parents])
    expect(rebuilt.info).toEqual(wire.info)
    expect(rebuilt.removals).toEqual(wire.removals)
    expect(dec.decode(rebuilt.updates.get('greeting') as Uint8Array)).toBe('hello')
    expect(rebuilt.meta.get('greeting')?.createdAt).toBe(1_759_999_999_000)
    expect(rebuilt.carries.get('kb')?.owner).toBe('d'.repeat(40))
  })

  it('is byte-deterministic regardless of map insertion order', () => {
    const wire = sampleWire()
    const shuffled: WireCommit = {
      ...wire,
      updates: new Map([...wire.updates].reverse()),
      carries: new Map([...wire.carries].reverse()),
      removals: new Set([...wire.removals].reverse()),
    }
    const a = encodeSidecar(wire, { kernel: 'ts', paths: PATHS })
    const b = encodeSidecar(shuffled, { kernel: 'ts', paths: PATHS })
    expect(dec.decode(a)).toBe(dec.decode(b))
  })

  it('records carry paths when the planner assigned one', () => {
    const wire = sampleWire()
    const paths = new Map([...PATHS, ['kb', '_kv/kb']])
    const decoded = decodeSidecar(encodeSidecar(wire, { kernel: 'ts', paths }))
    expect(decoded.carries.get('kb')?.path).toBe('_kv/kb')
    // Absent from the paths map → omitted, not null.
    const bare = decodeSidecar(encodeSidecar(wire, { kernel: 'ts', paths: PATHS }))
    expect('path' in (bare.carries.get('kb') as object)).toBe(false)
  })

  it('handles the empty commit (no updates/removals/carries, null info)', () => {
    const wire: WireCommit = {
      hash: 'e'.repeat(40),
      parents: [],
      time: 1,
      info: null,
      updates: new Map(),
      removals: new Set(),
      meta: new Map(),
      carries: new Map(),
    }
    const decoded = decodeSidecar(encodeSidecar(wire, { kernel: 'ts', paths: new Map() }))
    expect(decoded.parents).toEqual([])
    expect(decoded.info).toBeNull()
    expect(decoded.updates.size).toBe(0)
    expect(wireFromSidecar(decoded, new Map()).hash).toBe(wire.hash)
  })
})

describe('sidecar refusals', () => {
  it('encode throws when an update key has no assigned path', () => {
    expect(() => encodeSidecar(sampleWire(), { kernel: 'ts', paths: new Map() })).toThrow(
      /no tree path assigned/,
    )
  })

  it('decode rejects non-JSON, non-objects, and wrong formats', () => {
    expect(() => decodeSidecar(bytes('not json'))).toThrow(/not valid JSON/)
    expect(() => decodeSidecar(bytes('null'))).toThrow(/not an object/)
    expect(() => decodeSidecar(bytes('[1,2]'))).toThrow(/not an object/)
    expect(() => decodeSidecar(bytes(`{"format":${SIDECAR_FORMAT + 1}}`))).toThrow(
      /unsupported format/,
    )
  })

  it('decode rejects field-level malformations with specific messages', () => {
    const good = JSON.parse(
      dec.decode(encodeSidecar(sampleWire(), { kernel: 'ts', paths: PATHS })),
    ) as Record<string, unknown>

    const broken = (patch: Record<string, unknown>): Uint8Array =>
      bytes(JSON.stringify({ ...good, ...patch }))

    expect(() => decodeSidecar(broken({ hash: 7 }))).toThrow(/hash must be a string/)
    expect(() => decodeSidecar(broken({ time: 'late' }))).toThrow(/time must be a number/)
    expect(() => decodeSidecar(broken({ parents: [1] }))).toThrow(/parents/)
    expect(() => decodeSidecar(broken({ removals: 'x' }))).toThrow(/removals/)
    expect(() => decodeSidecar(broken({ updates: { k: { path: 1 } } }))).toThrow(
      /malformed update entry/,
    )
    expect(() => decodeSidecar(broken({ carries: { k: { owner: 'x' } } }))).toThrow(
      /malformed carry entry/,
    )
  })

  it('wireFromSidecar rejects missing and surplus value bytes', () => {
    const decoded = decodeSidecar(encodeSidecar(sampleWire(), { kernel: 'ts', paths: PATHS }))
    expect(() => wireFromSidecar(decoded, new Map())).toThrow(/missing value bytes/)
    const surplus = new Map([
      ['greeting', bytes('hello')],
      ['files/a.txt', bytes('aaa')],
      ['sneaky', bytes('extra')],
    ])
    expect(() => wireFromSidecar(decoded, surplus)).toThrow(/3 values supplied for 2/)
  })
})
