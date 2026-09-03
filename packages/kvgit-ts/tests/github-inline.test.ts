import { describe, expect, it } from 'vitest'
import { INLINE_LIMIT, INLINE_TREE_BUDGET, inlinable, inlineCost } from '../src/github/inline'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

describe('inlinable', () => {
  it('accepts the value shapes a session actually stores', () => {
    // Compact JSON is what sidecars and meta keys look like.
    const json = '{"format":1,"hash":"3728","parents":["8dac"],"time":1788}'
    expect(inlinable(bytes(json))).toBe(json)
    expect(inlinable(bytes('hello'))).toBe('hello')
    expect(inlinable(bytes(''))).toBe('')
  })

  it('preserves what GitHub was probed to preserve', () => {
    // Each of these round-trips byte-identically through a real tree
    // call, so refusing them here would cost requests for nothing.
    for (const s of [
      'hello', // no trailing newline
      'hello\n',
      'a\r\nb', // CRLF
      'a\rb', // lone CR
      'a\tb',
      '   padded   ',
      'héllo · 世界 🌳 ﬁ',
      'a\u0000b', // NUL
      'a\u0001\u0002\u001fb', // C0 controls
    ]) {
      expect(inlinable(bytes(s))).toBe(s)
    }
  })

  it('refuses bytes with no UTF-8 spelling', () => {
    expect(inlinable(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull()
    expect(inlinable(new Uint8Array([0xc3]))).toBeNull() // truncated 2-byte seq
    expect(inlinable(new Uint8Array([0x80]))).toBeNull() // stray continuation
    // A PNG header — the realistic case for a VFS value.
    expect(inlinable(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull()
  })

  it('refuses an unpaired surrogate rather than silently substituting', () => {
    // TextEncoder turns a lone surrogate into U+FFFD, so inlining one
    // would store different bytes than we hashed. The round-trip
    // comparison is what catches it — decoding alone would not.
    const lone = enc.encode('a\uD800b') // already U+FFFD'd by encode
    expect(new TextDecoder().decode(lone)).toBe('a�b')
    // Feed the encoder's own output back: that IS valid UTF-8 and may
    // inline. The guard matters for bytes that decode leniently.
    const raw = new Uint8Array([0x61, 0xed, 0xa0, 0x80, 0x62]) // CESU-8 surrogate
    expect(inlinable(raw)).toBeNull()
  })

  it('gates on size, and the gate is a parameter', () => {
    const big = bytes('x'.repeat(INLINE_LIMIT + 1))
    expect(inlinable(big)).toBeNull()
    const atLimit = bytes('x'.repeat(INLINE_LIMIT))
    expect(inlinable(atLimit)).toBe('x'.repeat(INLINE_LIMIT))
    expect(inlinable(bytes('hello'), 4)).toBeNull()
    expect(inlinable(bytes('hello'), 5)).toBe('hello')
  })

  it('measures the gate in bytes, not characters', () => {
    // Four UTF-16 code units, sixteen bytes: a character-based gate
    // would let this through a byte-sized budget four times over.
    const emoji = '🌳🌳🌳🌳'
    expect(bytes(emoji).length).toBe(16)
    expect(inlinable(bytes(emoji), 15)).toBeNull()
    expect(inlinable(bytes(emoji), 16)).toBe(emoji)
  })
})

describe('inlineCost', () => {
  it('measures the JSON body cost, not the value length', () => {
    // Plain ASCII: the two quotes are the only overhead.
    expect(inlineCost('hello')).toBe(7)
    expect(inlineCost('')).toBe(2)
  })

  it('accounts for escape expansion, which raw length would miss', () => {
    // A control byte is one byte on disk and six inside JSON. Budgeting
    // on raw length would undercount this by 6x — exactly the content
    // most able to blow a request body past its limit.
    expect(inlineCost('\u0000')).toBe(2 + 6)
    expect(inlineCost('\u0000'.repeat(100))).toBe(2 + 600)
    // Quote and backslash double.
    expect(inlineCost('"')).toBe(2 + 2)
    expect(inlineCost('\\')).toBe(2 + 2)
  })

  it('counts UTF-8 bytes, not code units', () => {
    // One emoji: two UTF-16 units, four bytes on the wire.
    expect('🌳'.length).toBe(2)
    expect(inlineCost('🌳')).toBe(2 + 4)
  })

  it('keeps the per-value gate well inside the aggregate budget', () => {
    // A sanity check on the two constants relating sensibly: the budget
    // must admit a meaningful number of maximum-size values, or the
    // per-value gate is doing nothing.
    expect(INLINE_TREE_BUDGET / INLINE_LIMIT).toBeGreaterThanOrEqual(16)
  })
})
