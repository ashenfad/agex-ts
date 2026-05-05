import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

describe('diff — basics', () => {
  it('produces no output when files are identical', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('one\ntwo\nthree\n'))
    await fs.write('/b', bytes('one\ntwo\nthree\n'))
    expect(await execute('diff /a /b', fs)).toBe('')
  })

  it('emits unified diff for differing files', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('one\ntwo\nthree\n'))
    await fs.write('/b', bytes('one\nTWO\nthree\n'))
    const out = await execute('diff /a /b', fs)
    expect(out.startsWith('--- /a\n+++ /b\n')).toBe(true)
    expect(out.includes('@@')).toBe(true)
    expect(out.includes('-two\n')).toBe(true)
    expect(out.includes('+TWO\n')).toBe(true)
  })

  it('handles pure insertions', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('one\ntwo\n'))
    await fs.write('/b', bytes('one\ntwo\nthree\n'))
    const out = await execute('diff /a /b', fs)
    expect(out.includes('+three\n')).toBe(true)
    // No deletion lines (a `-` prefix that isn't the `---` file header).
    const hasDeletion = out
      .split('\n')
      .some((line) => line.startsWith('-') && !line.startsWith('---'))
    expect(hasDeletion).toBe(false)
  })

  it('handles pure deletions', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('one\ntwo\nthree\n'))
    await fs.write('/b', bytes('one\nthree\n'))
    const out = await execute('diff /a /b', fs)
    expect(out.includes('-two\n')).toBe(true)
    const hasInsertion = out
      .split('\n')
      .some((line) => line.startsWith('+') && !line.startsWith('+++'))
    expect(hasInsertion).toBe(false)
  })
})

describe('diff — flags', () => {
  it('-q (brief) just reports difference', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('A\n'))
    await fs.write('/b', bytes('B\n'))
    const out = await execute('diff -q /a /b', fs)
    expect(out).toBe('Files /a and /b differ\n')
  })

  it('-q is silent on identical files', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('same\n'))
    await fs.write('/b', bytes('same\n'))
    expect(await execute('diff -q /a /b', fs)).toBe('')
  })

  it('-i ignores case differences', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('Hello\nWorld\n'))
    await fs.write('/b', bytes('hello\nworld\n'))
    expect(await execute('diff -i /a /b', fs)).toBe('')
  })

  it('-w ignores all whitespace differences', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('hello world\n'))
    await fs.write('/b', bytes('hello    world\n'))
    expect(await execute('diff -w /a /b', fs)).toBe('')
  })

  it('-b ignores changes in amount of whitespace', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('a  b  c\n'))
    await fs.write('/b', bytes('a b c\n'))
    expect(await execute('diff -b /a /b', fs)).toBe('')
  })

  it('-B ignores blank-line changes', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('one\n\ntwo\n'))
    await fs.write('/b', bytes('one\ntwo\n'))
    expect(await execute('diff -B /a /b', fs)).toBe('')
  })

  it('-U N changes context line count', async () => {
    const fs = new MemoryFS()
    const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => `${s}\n`).join('')
    const b = ['a', 'b', 'c', 'X', 'e', 'f', 'g'].map((s) => `${s}\n`).join('')
    await fs.write('/a', bytes(a))
    await fs.write('/b', bytes(b))
    const out = await execute('diff -U 1 /a /b', fs)
    // With 1 line of context, hunk should include c, -d, +X, e (4 lines total)
    expect(out.includes(' c\n')).toBe(true)
    expect(out.includes('-d\n')).toBe(true)
    expect(out.includes('+X\n')).toBe(true)
    expect(out.includes(' e\n')).toBe(true)
    expect(out.includes(' b\n')).toBe(false) // outside context
  })

  it('-c context format uses *** / --- markers', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('one\ntwo\nthree\n'))
    await fs.write('/b', bytes('one\nTWO\nthree\n'))
    const out = await execute('diff -c /a /b', fs)
    expect(out.startsWith('*** /a\n--- /b\n')).toBe(true)
    expect(out.includes('***************\n')).toBe(true)
  })
})

describe('diff — recursive directory diff', () => {
  it('-r diffs files present in both, calls out unique files', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/a/sub', { parents: true })
    await fs.mkdir('/b/sub', { parents: true })
    await fs.write('/a/common.txt', bytes('hello\n'))
    await fs.write('/b/common.txt', bytes('hello modified\n'))
    await fs.write('/a/only-a.txt', bytes('a\n'))
    await fs.write('/b/only-b.txt', bytes('b\n'))
    await fs.write('/a/sub/inside.txt', bytes('inside\n'))
    await fs.write('/b/sub/inside.txt', bytes('inside\n'))

    const out = await execute('diff -r /a /b', fs)
    expect(out.includes('Only in /a: only-a.txt')).toBe(true)
    expect(out.includes('Only in /b: only-b.txt')).toBe(true)
    expect(out.includes('--- /a/common.txt')).toBe(true)
    expect(out.includes('hello modified')).toBe(true)
    // Identical sub/inside.txt produces no output
    expect(out.includes('sub/inside.txt')).toBe(false)
  })
})

describe('diff — errors', () => {
  it('errors with fewer than two files', async () => {
    await expect(execute('diff /one', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })

  it('errors when one file is missing', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes(''))
    await expect(execute('diff /a /missing', fs)).rejects.toBeInstanceOf(TerminalError)
  })
})
