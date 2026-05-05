import { describe, expect, it } from 'vitest'
import { parseArgs } from '../src/builtins/_argparse'
import { TerminalError } from '../src/errors'

describe('parseArgs — boolean flags', () => {
  it('defaults all defined boolean flags to false', () => {
    const r = parseArgs([], { flags: { a: { aliases: ['-a'] }, b: { aliases: ['-b'] } } }, 'test')
    expect(r.flags).toEqual({ a: false, b: false })
  })

  it('parses a short flag', () => {
    const r = parseArgs(['-a'], { flags: { a: { aliases: ['-a'] } } }, 'test')
    expect(r.flags.a).toBe(true)
  })

  it('parses a long flag', () => {
    const r = parseArgs(['--all'], { flags: { all: { aliases: ['--all'] } } }, 'test')
    expect(r.flags.all).toBe(true)
  })

  it('parses stacked short flags (-la = -l -a)', () => {
    const r = parseArgs(
      ['-la'],
      { flags: { l: { aliases: ['-l'] }, a: { aliases: ['-a'] } } },
      'test',
    )
    expect(r.flags.l).toBe(true)
    expect(r.flags.a).toBe(true)
  })

  it('honors flag aliases', () => {
    const r = parseArgs(
      ['-R'],
      { flags: { recursive: { aliases: ['-r', '-R', '--recursive'] } } },
      'test',
    )
    expect(r.flags.recursive).toBe(true)
  })

  it('throws on unknown option', () => {
    expect(() => parseArgs(['-x'], { flags: { a: { aliases: ['-a'] } } }, 'test')).toThrow(
      TerminalError,
    )
  })
})

describe('parseArgs — value flags', () => {
  it('parses --name VALUE form', () => {
    const r = parseArgs(
      ['--out', 'file.txt'],
      { flags: { out: { aliases: ['--out'], takesValue: true } } },
      'test',
    )
    expect(r.flags.out).toBe('file.txt')
  })

  it('parses --name=VALUE form', () => {
    const r = parseArgs(
      ['--out=file.txt'],
      { flags: { out: { aliases: ['--out'], takesValue: true } } },
      'test',
    )
    expect(r.flags.out).toBe('file.txt')
  })

  it('parses -n VALUE form', () => {
    const r = parseArgs(
      ['-n', '5'],
      { flags: { lines: { aliases: ['-n'], takesValue: true } } },
      'test',
    )
    expect(r.flags.lines).toBe('5')
  })

  it('parses -nVALUE (cluster) form', () => {
    const r = parseArgs(
      ['-n5'],
      { flags: { lines: { aliases: ['-n'], takesValue: true } } },
      'test',
    )
    expect(r.flags.lines).toBe('5')
  })

  it('throws when required value is missing', () => {
    expect(() =>
      parseArgs(['--out'], { flags: { out: { aliases: ['--out'], takesValue: true } } }, 'test'),
    ).toThrow(/requires a value/)
  })

  it('throws when a boolean flag is given a value', () => {
    expect(() =>
      parseArgs(['--all=yes'], { flags: { all: { aliases: ['--all'] } } }, 'test'),
    ).toThrow(/does not take a value/)
  })
})

describe('parseArgs — positional', () => {
  it('collects positional args', () => {
    const r = parseArgs(['a', 'b', 'c'], {}, 'test')
    expect(r.positional).toEqual(['a', 'b', 'c'])
  })

  it('mixes flags and positionals', () => {
    const r = parseArgs(
      ['-l', 'foo', '-a', 'bar'],
      { flags: { l: { aliases: ['-l'] }, a: { aliases: ['-a'] } } },
      'test',
    )
    expect(r.positional).toEqual(['foo', 'bar'])
    expect(r.flags.l).toBe(true)
    expect(r.flags.a).toBe(true)
  })

  it('treats `-` as a positional (e.g. cat -)', () => {
    const r = parseArgs(['cat', '-'], {}, 'test')
    expect(r.positional).toEqual(['cat', '-'])
  })

  it('-- ends flag parsing', () => {
    const r = parseArgs(['--', '-a', '--all'], { flags: { a: { aliases: ['-a'] } } }, 'test')
    expect(r.flags.a).toBe(false)
    expect(r.positional).toEqual(['-a', '--all'])
  })

  it('throws on too few positionals', () => {
    expect(() => parseArgs([], { minPositional: 1 }, 'test')).toThrow(/missing operand/)
  })

  it('throws on too many positionals', () => {
    expect(() => parseArgs(['a', 'b'], { maxPositional: 1 }, 'test')).toThrow(/too many/)
  })
})
