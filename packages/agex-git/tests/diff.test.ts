import { describe, expect, it } from 'vitest'
import { isBinary, unifiedDiff } from '../src/diff'

describe('unifiedDiff', () => {
  it('returns empty string when contents are identical', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'foo', 'foo')).toBe('')
  })

  it('emits git-style headers (--- a/path / +++ b/path)', () => {
    const out = unifiedDiff('a\n', 'b\n', 'foo', 'foo')
    expect(out).toContain('--- a/foo')
    expect(out).toContain('+++ b/foo')
  })

  it('emits @@ hunk headers', () => {
    const out = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'foo', 'foo')
    expect(out).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m)
  })

  it('shows + and - lines for content changes', () => {
    const out = unifiedDiff('hello\n', 'world\n', 'f', 'f')
    expect(out).toContain('-hello')
    expect(out).toContain('+world')
  })

  it('preserves context lines around hunks', () => {
    const out = unifiedDiff('a\nb\nc\nd\ne\n', 'a\nb\nC\nd\ne\n', 'f', 'f')
    // 3 lines of context before and after by default
    expect(out).toContain(' a')
    expect(out).toContain(' b')
    expect(out).toContain('-c')
    expect(out).toContain('+C')
    expect(out).toContain(' d')
    expect(out).toContain(' e')
  })

  it('handles file additions (empty old)', () => {
    const out = unifiedDiff('', 'new\n', 'f', 'f')
    expect(out).toContain('+new')
    // No removed-line markers (header dashes are fine)
    const lines = out.split('\n')
    expect(lines.some((l) => l.startsWith('-') && !l.startsWith('---'))).toBe(false)
  })

  it('handles file deletions (empty new)', () => {
    const out = unifiedDiff('gone\n', '', 'f', 'f')
    expect(out).toContain('-gone')
  })

  it('every emitted line ends with a newline', () => {
    const out = unifiedDiff('a\n', 'b\n', 'f', 'f')
    expect(out.endsWith('\n')).toBe(true)
    // No double-blank lines from missing terminators in hunk lines
    for (const line of out.split('\n').slice(0, -1)) {
      expect(line.length).toBeGreaterThan(0)
    }
  })
})

describe('isBinary', () => {
  it('returns false for null / undefined', () => {
    expect(isBinary(null)).toBe(false)
    expect(isBinary(undefined)).toBe(false)
  })

  it('returns false for empty bytes', () => {
    expect(isBinary(new Uint8Array(0))).toBe(false)
  })

  it('returns false for plain text', () => {
    const text = new TextEncoder().encode('hello world\n')
    expect(isBinary(text)).toBe(false)
  })

  it('returns true when a NUL byte is present', () => {
    expect(isBinary(new Uint8Array([0x68, 0x69, 0x00, 0x21]))).toBe(true)
  })

  it('returns true for a NUL near the front of a large buffer', () => {
    const big = new Uint8Array(20_000)
    big[100] = 0
    expect(isBinary(big)).toBe(true)
  })

  it('only scans the first 8KB (NUL beyond is ignored)', () => {
    // Fill with non-NUL bytes; place a NUL outside the 8KB scan window.
    const big = new Uint8Array(20_000).fill(0x41)
    big[10_000] = 0
    expect(isBinary(big)).toBe(false)
  })
})
