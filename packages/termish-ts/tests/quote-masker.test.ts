import { describe, expect, it } from 'vitest'
import { maskQuotes, unmaskAndUnquote, unmaskQuotes } from '../src/quote-masker'

describe('maskQuotes', () => {
  it('replaces a single-quoted span with a placeholder', () => {
    const { masked, map } = maskQuotes("echo 'hello world'")
    expect(masked).not.toContain("'hello world'")
    expect(map.size).toBe(1)
    const [, original] = map.entries().next().value as [string, string]
    expect(original).toBe("'hello world'")
  })

  it('replaces a double-quoted span with a placeholder', () => {
    const { masked, map } = maskQuotes('echo "hello world"')
    expect(masked).not.toContain('"hello world"')
    expect(map.size).toBe(1)
  })

  it('handles multiple distinct quoted spans', () => {
    const { masked, map } = maskQuotes("a 'one' b 'two' c \"three\"")
    expect(map.size).toBe(3)
    // Round-tripping unmask gives the original
    expect(unmaskQuotes(masked, map)).toBe("a 'one' b 'two' c \"three\"")
  })

  it('preserves escaped quotes inside a quoted span', () => {
    const input = 'echo "he said \\"hi\\""'
    const { masked, map } = maskQuotes(input)
    expect(map.size).toBe(1)
    expect(unmaskQuotes(masked, map)).toBe(input)
  })

  it('does NOT mask a backslash-escaped quote outside a span', () => {
    // \" outside any quote shouldn't open a span
    const { map } = maskQuotes('echo \\"foo')
    expect(map.size).toBe(0)
  })

  it('handles empty input', () => {
    const { masked, map } = maskQuotes('')
    expect(masked).toBe('')
    expect(map.size).toBe(0)
  })

  it('handles input with no quotes', () => {
    const { masked, map } = maskQuotes('ls -la | grep foo')
    expect(masked).toBe('ls -la | grep foo')
    expect(map.size).toBe(0)
  })
})

describe('unmaskAndUnquote', () => {
  it('strips outer single quotes', () => {
    const { masked, map } = maskQuotes("echo 'hello'")
    expect(unmaskAndUnquote(masked, map)).toBe('echo hello')
  })

  it('strips outer double quotes', () => {
    const { masked, map } = maskQuotes('echo "hello"')
    expect(unmaskAndUnquote(masked, map)).toBe('echo hello')
  })

  it('unescapes escaped double quotes inside a double-quoted span', () => {
    const { masked, map } = maskQuotes('echo "he said \\"hi\\""')
    expect(unmaskAndUnquote(masked, map)).toBe('echo he said "hi"')
  })

  it('unescapes escaped single quotes inside a single-quoted span', () => {
    const { masked, map } = maskQuotes("echo 'it\\'s'")
    expect(unmaskAndUnquote(masked, map)).toBe("echo it's")
  })
})
