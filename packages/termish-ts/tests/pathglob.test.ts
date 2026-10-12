/**
 * Pathname expansion and `ls` operands, as bash and GNU do them. Ported
 * from termish-py's test_pathglob.py; the reference results are Python's
 * `glob(recursive=True)` over the same tree, which follows bash's
 * globstar, dotfile and trailing-slash rules.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { TerminalError, execute } from '../src/index'
import { hasMagic } from '../src/pathglob'

let fs: MemoryFS
beforeEach(async () => {
  fs = new MemoryFS()
  await execute(
    'mkdir -p a/bg a/cards a/.git; touch a/bg/x.png a/bg/y.png a/cards/z.png a/top.txt a/.hid',
    fs,
  )
})

describe('expansion', () => {
  it.each([
    // * stays within a segment, directories included
    ['echo a/*', 'a/bg a/cards a/top.txt'],
    ['echo /a/*', '/a/bg /a/cards /a/top.txt'],
    ['echo a/*/*.png', 'a/bg/x.png a/bg/y.png a/cards/z.png'],
    // a trailing / matches directories only, and is kept
    ['echo a/*/', 'a/bg/ a/cards/'],
    // ** crosses directories, zero or more of them
    ['echo a/**/*.png', 'a/bg/x.png a/bg/y.png a/cards/z.png'],
    ['echo a/**/top.txt', 'a/top.txt'],
    // a final ** names everything below, files included
    ['echo a/**', 'a/ a/bg a/bg/x.png a/bg/y.png a/cards a/cards/z.png a/top.txt'],
    ['echo a/**/', 'a/ a/bg/ a/cards/'],
    // a relative **/ is the directories below, never the root
    ['echo **/', 'a/ a/bg/ a/cards/'],
    ['cd a; echo **/', 'bg/ cards/'],
    // dotfiles only for a pattern that starts with a dot
    ['echo a/.*', 'a/.git a/.hid'],
    ['echo a/.h*', 'a/.hid'],
    // ? and classes, negated classes too, all one word
    ['echo a/?g', 'a/bg'],
    ['echo a/[bc]*', 'a/bg a/cards'],
    ['echo a/[!b]*', 'a/cards a/top.txt'],
    // relative to the working directory, and kept relative
    ['cd a; echo *', 'bg cards top.txt'],
    ['cd a; echo bg/*', 'bg/x.png bg/y.png'],
    ['cd a; echo ../a/top*', '../a/top.txt'],
    // no match: the word stays as typed
    ['echo nope/*', 'nope/*'],
    ['echo a/*.zip', 'a/*.zip'],
    // quoted: never expanded
    ["echo 'a/*'", 'a/*'],
    ['echo x[0]', 'x[0]'],
  ])('%s', async (command, expected) => {
    expect((await execute(command, fs)).trim()).toBe(expected)
  })

  it.each(
    Object.entries({
      'a/*': ['a/bg', 'a/cards', 'a/top.txt'],
      'a/*/': ['a/bg/', 'a/cards/'],
      'a/*/*.png': ['a/bg/x.png', 'a/bg/y.png', 'a/cards/z.png'],
      'a/**': ['a/', 'a/bg', 'a/bg/x.png', 'a/bg/y.png', 'a/cards', 'a/cards/z.png', 'a/top.txt'],
      'a/**/': ['a/', 'a/bg/', 'a/cards/'],
      'a/**/*.png': ['a/bg/x.png', 'a/bg/y.png', 'a/cards/z.png'],
      'a/**/top.txt': ['a/top.txt'],
      'a/.*': ['a/.git', 'a/.hid'],
      'a/?g': ['a/bg'],
      'a/[bc]*': ['a/bg', 'a/cards'],
      'a/[!b]*': ['a/cards', 'a/top.txt'],
      '*': ['a'],
      '**': ['a', 'a/bg', 'a/bg/x.png', 'a/bg/y.png', 'a/cards', 'a/cards/z.png', 'a/top.txt'],
      'a/nope*': ['a/nope*'],
    }),
  )("agrees with Python's glob on %s", async (pattern, expected) => {
    expect((await execute(`printf '%s\\n' ${pattern}`, fs)).split(/\s+/).filter(Boolean)).toEqual(
      expected,
    )
  })

  it('counts a word as a pattern only for *, ? or a closed [ ]', () => {
    expect(hasMagic('*.py') && hasMagic('a?') && hasMagic('[ab]')).toBe(true)
    expect(hasMagic('plain') || hasMagic('[') || hasMagic('x[]')).toBe(false)
  })
})

describe('ls operands', () => {
  it.each([
    // files first, by name, no headers; then each directory under one
    ['ls a/*', 'a/top.txt\n\na/bg:\nx.png\ny.png\n\na/cards:\nz.png\n'],
    ['ls a/top.txt a/bg/x.png', 'a/bg/x.png\na/top.txt\n'],
    ['ls a/bg a/cards', 'a/bg:\nx.png\ny.png\n\na/cards:\nz.png\n'],
    // one directory operand: its contents, no header
    ['ls a/bg', 'x.png\ny.png\n'],
    // -d lists the directories themselves
    ['ls -d a/*', 'a/bg\na/cards\na/top.txt\n'],
  ])('%s', async (command, expected) => {
    expect(await execute(command, fs)).toBe(expected)
  })

  it('reports a missing operand, lists the rest, and exits 2', async () => {
    const out = await execute('ls a/top.txt nope; echo st=$?', fs)
    expect(out).toContain('a/top.txt\n')
    expect(out).toContain("ls: cannot access 'nope': No such file or directory")
    expect(out.endsWith('st=2\n')).toBe(true)
  })

  it('fails with nothing to list', async () => {
    const error = await execute('ls nope', fs).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(TerminalError)
    expect((error as TerminalError).message).toContain("cannot access 'nope'")
    expect((error as TerminalError).exitCode).toBe(2)
  })

  it('orders operands by size under -S, reversed by -r, and by name otherwise', async () => {
    await fs.write('/small.txt', new TextEncoder().encode('x'))
    await fs.write('/big.txt', new TextEncoder().encode('x'.repeat(100)))
    expect(await execute('ls -S small.txt big.txt', fs)).toBe('big.txt\nsmall.txt\n')
    expect(await execute('ls -Sr small.txt big.txt', fs)).toBe('small.txt\nbig.txt\n')
    expect(await execute('ls small.txt big.txt', fs)).toBe('big.txt\nsmall.txt\n')
  })
})
