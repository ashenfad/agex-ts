/**
 * grep and sed read POSIX basic regexes without -E, as GNU's do, and
 * grep's exit status says whether it matched. Ported from termish-py's
 * test_bre.py.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { breToJs } from '../src/builtins/_regex'
import { MemoryFS } from '../src/fs/memory'
import { TerminalError, execute } from '../src/index'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

let fs: MemoryFS
beforeEach(async () => {
  fs = new MemoryFS()
  await fs.write('/f.txt', bytes('aa bb\nfoo  bar\nbeta (x)\n'))
})

describe('BRE', () => {
  it.each([
    ["sed 's/a\\+/X/' f.txt", 'X bb\nfoo  bXr\nbetX (x)\n'],
    ["sed 's/o\\{2\\}/X/' f.txt", 'aa bb\nfX  bar\nbeta (x)\n'],
    ["sed 's/fo\\?o/X/' f.txt", 'aa bb\nX  bar\nbeta (x)\n'],
    ["sed 's/\\(foo\\) *bar/\\1-bar/' f.txt", 'aa bb\nfoo-bar\nbeta (x)\n'],
    ["sed 's/beta (x/B/' f.txt", 'aa bb\nfoo  bar\nB)\n'],
    ["sed '/fo\\+/d' f.txt", 'aa bb\nbeta (x)\n'],
    ["grep 'o\\+' f.txt", 'foo  bar\n'],
    ["grep 'a\\{2\\}' f.txt", 'aa bb\n'],
    ["grep 'beta (x' f.txt", 'beta (x)\n'],
    ["grep 'bb\\|bar' f.txt", 'aa bb\nfoo  bar\n'],
    ["grep '\\<bar\\>' f.txt", 'foo  bar\n'],
  ])('reads as GNU does: %s', async (command, expected) => {
    expect(await execute(command, fs)).toBe(expected)
  })

  it.each([
    ["sed -E 's/a+/X/' f.txt", 'X bb\nfoo  bXr\nbetX (x)\n'],
    ["sed -E 's/(foo) *bar/\\1-bar/' f.txt", 'aa bb\nfoo-bar\nbeta (x)\n'],
    ["grep -E 'o+' f.txt", 'foo  bar\n'],
    ["grep -E 'bb|bar' f.txt", 'aa bb\nfoo  bar\n'],
    ["grep -E 'beta \\(x' f.txt", 'beta (x)\n'],
    ["grep -F 'beta (x' f.txt", 'beta (x)\n'],
  ])('leaves ERE and fixed strings alone: %s', async (command, expected) => {
    expect(await execute(command, fs)).toBe(expected)
  })

  it('reads a bare operator as a literal character', async () => {
    await fs.write('/g.txt', bytes('a+b\naab\n'))
    expect(await execute("grep 'a+b' g.txt", fs)).toBe('a+b\n')
    expect(await execute("sed 's/a+b/X/' g.txt", fs)).toBe('X\naab\n')
  })

  it.each([
    ['a\\+', 'a+'],
    ['o\\{2,3\\}', 'o{2,3}'],
    ['\\(a\\|b\\)*', '(a|b)*'],
    ['a+b?c|d(e){f}', 'a\\+b\\?c\\|d\\(e\\)\\{f\\}'],
    ['*x', '\\*x'],
    ['^*x', '^\\*x'],
    ['\\(*x\\)', '(\\*x)'],
    ['x\\|*y', 'x|\\*y'],
    ['a^b$c', 'a\\^b\\$c'],
    ['^ab$', '^ab$'],
    ['\\(ab$\\)', '(ab$)'],
    ['[\\.]x', '[\\\\.]x'],
    ['[]a]', '[\\]a]'],
    ['[^]a]', '[^\\]a]'],
    ['\\(x\\)\\1', '(x)\\1'],
    ['a\\.b\\*', 'a\\.b\\*'],
    ['trail\\', 'trail\\\\'],
  ])('translates %s', (bre, js) => {
    expect(breToJs(bre)).toBe(js)
  })
})

describe('word boundaries', () => {
  it('keep \\< to the start of a word and \\> to its end', async () => {
    await fs.write('/w.txt', bytes('xfoo\nfoo\nfoox\n'))
    expect(await execute("grep '\\<foo\\>' w.txt", fs)).toBe('foo\n')
    expect(await execute("grep '\\<foo' w.txt", fs)).toBe('foo\nfoox\n')
    expect(await execute("grep 'foo\\>' w.txt", fs)).toBe('xfoo\nfoo\n')
    expect(await execute("grep '\\>foo' w.txt; echo $?", fs)).toBe('1\n')
    expect(await execute("grep 'foo\\<' w.txt; echo $?", fs)).toBe('1\n')
  })

  it('translate to lookarounds', () => {
    expect(breToJs('\\<a\\>')).toBe('\\b(?=\\w)a\\b(?<=\\w)')
  })
})

describe("grep's exit status", () => {
  it('is 1 when nothing matches', async () => {
    expect(await execute('grep zzz f.txt; echo $?', fs)).toBe('1\n')
    expect(await execute('grep foo f.txt > /dev/null; echo $?', fs)).toBe('0\n')
    expect(await execute('grep zzz f.txt || echo none', fs)).toBe('none\n')
  })

  it('is 1 for a count of zero, which still prints', async () => {
    expect(await execute('grep -c zzz f.txt; echo $?', fs)).toBe('0\n1\n')
  })

  it('follows the same rule under -q', async () => {
    expect(await execute('grep -q foo f.txt && echo yes', fs)).toBe('yes\n')
    expect(await execute('grep -q zzz f.txt || echo no', fs)).toBe('no\n')
  })

  it('is 2 for an error', async () => {
    for (const script of ["grep '[' f.txt", 'grep foo /missing.txt']) {
      const error = await execute(script, fs).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(TerminalError)
      expect((error as TerminalError).exitCode).toBe(2)
    }
  })

  it('lets a pipeline count no matches as zero', async () => {
    expect(
      (await execute('grep zzz f.txt | wc -l; echo st=$?', fs)).split(/\s+/).filter(Boolean),
    ).toEqual(['0', 'st=0'])
    expect((await execute('false | wc -l', fs)).trim()).toBe('0')
  })
})
