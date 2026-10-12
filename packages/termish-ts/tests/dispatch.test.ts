/**
 * `xargs` and `find -exec` run their commands from argv, never re-parsed
 * as shell text, and pass the output through as bytes. Ported from
 * termish-py's test_find.py, test_command_injection.py and
 * test_binary.py.
 */

import { gzipSync } from 'fflate'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { type CommandHandler, execute } from '../src/index'

const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i)
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const PATHS = [
  '/amp&capture',
  '/pipe|capture',
  '/redirect>owned',
  '/semi;capture',
  '/space name.txt',
]

let fs: MemoryFS
beforeEach(() => {
  fs = new MemoryFS()
})

function capturing(): { calls: string[][]; capture: CommandHandler } {
  const calls: string[][] = []
  return {
    calls,
    capture: async (ctx) => {
      calls.push([...ctx.args])
    },
  }
}

describe('find -exec', () => {
  it('passes each metacharacter path as one argument', async () => {
    for (const p of PATHS) await fs.write(p, bytes(''))
    const { calls, capture } = capturing()
    await execute("find / -type f -exec capture '{}' ';'", fs, { commands: { capture } })
    expect(calls.length).toBe(PATHS.length)
    expect(calls.every((a) => a.length === 1)).toBe(true)
    expect(calls.map((a) => a[0]).sort()).toEqual([...PATHS].sort())
    expect(await fs.exists('/owned')).toBe(false)
  })

  it('passes the batch as distinct arguments', async () => {
    for (const p of PATHS) await fs.write(p, bytes(''))
    const { calls, capture } = capturing()
    await execute("find / -type f -exec capture '{}' '+'", fs, { commands: { capture } })
    expect(calls.length).toBe(1)
    expect([...(calls[0] as string[])].sort()).toEqual([...PATHS].sort())
  })

  it('puts a warning ahead of the output', async () => {
    await fs.write('/a.txt', bytes(''))
    const warn: CommandHandler = async (ctx) => {
      ctx.stdout.write('output\n')
      return { exitCode: 0, stderr: 'warning' }
    }
    expect(await execute("find / -type f -exec warn '{}' ';'", fs, { commands: { warn } })).toBe(
      'warning\noutput\n',
    )
  })

  it('keeps bytes, one at a time and batched', async () => {
    await fs.mkdir('/d', { parents: true })
    await fs.write('/d/one.dat', ALL_BYTES)
    await execute("find d -type f -exec cat '{}' '+' > copy.dat", fs)
    expect(await fs.read('/copy.dat')).toEqual(ALL_BYTES)
    await execute("find d -type f -exec cat '{}' ';' | cat > copy2.dat", fs)
    expect(await fs.read('/copy2.dat')).toEqual(ALL_BYTES)
  })
})

describe('xargs', () => {
  it('reaches an injected command, and batches with -n', async () => {
    const shout: CommandHandler = async (ctx) => {
      ctx.stdout.write(`${ctx.args.join(' ').toUpperCase()}\n`)
    }
    expect(await execute("echo 'hello world' | xargs shout", fs, { commands: { shout } })).toBe(
      'HELLO WORLD\n',
    )
    expect(await execute("echo 'a b c' | xargs -n 1 shout", fs, { commands: { shout } })).toBe(
      'A\nB\nC\n',
    )
  })

  it('passes an item with metacharacters as one argument', async () => {
    const { calls, capture } = capturing()
    await execute("printf '%s\\0' 'a;b' 'c|d' '$HOME' | xargs -0 capture", fs, {
      commands: { capture },
    })
    expect(calls).toEqual([['a;b', 'c|d', '$HOME']])
  })

  it("passes the command's bytes through", async () => {
    await fs.write('/bin.dat', ALL_BYTES)
    await execute('echo bin.dat | xargs cat > copy.dat', fs)
    expect(await fs.read('/copy.dat')).toEqual(ALL_BYTES)
  })

  it('reports a missing command with 127', async () => {
    expect(await execute('echo x | xargs nosuch; echo $?', fs)).toBe(
      'xargs: nosuch: command not found\n127\n',
    )
  })
})

describe('gzip and zcat over pipes', () => {
  beforeEach(async () => {
    await fs.write('/bin.dat', ALL_BYTES)
  })

  it('round-trips through a pipeline', async () => {
    await execute('cat bin.dat | gzip -c | zcat > out.dat', fs)
    expect(await fs.read('/out.dat')).toEqual(ALL_BYTES)
  })

  it('reads stdin with zcat, gzip -d and gunzip -c', async () => {
    await fs.write('/bin.gz', gzipSync(ALL_BYTES))
    await execute('cat bin.gz | zcat > a.dat', fs)
    expect(await fs.read('/a.dat')).toEqual(ALL_BYTES)
    await execute('cat bin.gz | gzip -d > b.dat', fs)
    expect(await fs.read('/b.dat')).toEqual(ALL_BYTES)
    await fs.write('/hi.gz', gzipSync(bytes('hello\n')))
    expect(await execute('cat hi.gz | gunzip -c', fs)).toBe('hello\n')
  })

  it('counts decompressed bytes, and gzcat is zcat', async () => {
    await fs.write('/bin.gz', gzipSync(ALL_BYTES))
    expect((await execute('zcat bin.gz | wc -c', fs)).trim()).toBe('256')
    expect((await execute('gzcat bin.gz | wc -c', fs)).trim()).toBe('256')
  })

  it('refuses empty stdin, and input that is not gzip', async () => {
    expect(await execute('zcat < /dev/null; echo $?', fs)).toBe('zcat: no files specified\n1\n')
    expect(await execute('echo nope | zcat; echo $?', fs)).toBe(
      'zcat: stdin: not in gzip format\n1\n',
    )
  })
})
