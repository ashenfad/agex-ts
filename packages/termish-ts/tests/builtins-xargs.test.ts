import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

describe('xargs — defaults', () => {
  it('passes all stdin items as args to a single command', async () => {
    const out = await execute("echo -e 'a\\nb\\nc' | xargs echo", new MemoryFS())
    expect(out).toBe('a b c\n')
  })

  it('defaults to echo when no command given', async () => {
    const out = await execute("echo -e 'one\\ntwo' | xargs", new MemoryFS())
    expect(out).toBe('one two\n')
  })

  it('skips when stdin is empty (no-run-if-empty default)', async () => {
    const out = await execute("echo -n '' | xargs echo X", new MemoryFS())
    expect(out).toBe('')
  })

  it('whitespace splits items', async () => {
    const out = await execute("echo 'a b   c\td' | xargs echo", new MemoryFS())
    expect(out).toBe('a b c d\n')
  })
})

describe('xargs — flags', () => {
  it('-n batches items', async () => {
    const out = await execute("echo -e 'a\\nb\\nc\\nd' | xargs -n 2 echo", new MemoryFS())
    expect(out).toBe('a b\nc d\n')
  })

  it('-n2 (attached form) works', async () => {
    const out = await execute("echo -e 'a\\nb\\nc\\nd' | xargs -n2 echo", new MemoryFS())
    expect(out).toBe('a b\nc d\n')
  })

  it('-I {} substitutes per item', async () => {
    const out = await execute(
      "echo -e 'foo\\nbar' | xargs -I {} echo prefix-{}-suffix",
      new MemoryFS(),
    )
    expect(out).toBe('prefix-foo-suffix\nprefix-bar-suffix\n')
  })

  it('-I@ (attached form) substitutes per item', async () => {
    const out = await execute("echo -e 'a\\nb' | xargs -I@ echo @@", new MemoryFS())
    expect(out).toBe('aa\nbb\n')
  })

  it('-0 splits on NUL', async () => {
    // Use printf-via-echo: build a stdin payload with NUL by piping through
    // a dummy file write. Easiest is `cat` from a file we write directly.
    const fs = new MemoryFS()
    await fs.write('/data', bytes('one\0two\0three\0'))
    const out = await execute('cat /data | xargs -0 echo', fs)
    expect(out).toBe('one two three\n')
  })

  it('-t (verbose) prints command before running', async () => {
    const out = await execute('echo a | xargs -t echo X', new MemoryFS())
    // verbose line + actual output
    expect(out).toContain('echo X a\n')
    expect(out).toContain('X a\n')
  })

  it('passes base args through to the command', async () => {
    const out = await execute("echo -e 'a\\nb' | xargs -n 1 echo prefix", new MemoryFS())
    expect(out).toBe('prefix a\nprefix b\n')
  })
})

describe('xargs — pipelining with builtins', () => {
  it('feeds find output into rm', async () => {
    const fs = new MemoryFS()
    await fs.write('/junk1.tmp', bytes('x'))
    await fs.write('/junk2.tmp', bytes('y'))
    await fs.write('/keep.txt', bytes('z'))
    await execute("find / -name '*.tmp' | xargs rm", fs)
    expect(await fs.exists('/junk1.tmp')).toBe(false)
    expect(await fs.exists('/junk2.tmp')).toBe(false)
    expect(await fs.exists('/keep.txt')).toBe(true)
  })

  it('items with spaces survive when fed via -0', async () => {
    const fs = new MemoryFS()
    await fs.write('/has space.txt', bytes('hi'))
    await fs.write('/data', bytes('/has space.txt\0'))
    await execute('cat /data | xargs -0 -I {} rm {}', fs)
    expect(await fs.exists('/has space.txt')).toBe(false)
  })
})

describe('xargs — errors', () => {
  it('errors on unknown option', async () => {
    await expect(execute('echo a | xargs --zzz echo', new MemoryFS())).rejects.toBeInstanceOf(
      TerminalError,
    )
  })

  it('errors when -I has no argument', async () => {
    await expect(execute('echo a | xargs -I', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })

  it('errors when -n has no argument', async () => {
    await expect(execute('echo a | xargs -n', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })

  it('errors when -n value is not a number', async () => {
    await expect(execute('echo a | xargs -n abc echo', new MemoryFS())).rejects.toBeInstanceOf(
      TerminalError,
    )
  })

  it('errors when invoked command is not found', async () => {
    await expect(execute('echo a | xargs nosuchcmd', new MemoryFS())).rejects.toBeInstanceOf(
      TerminalError,
    )
  })
})
