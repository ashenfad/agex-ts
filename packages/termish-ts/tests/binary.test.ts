/**
 * Binary payloads survive pipes and redirects byte for byte. Text is
 * decoded at each command's own boundary and once more for the
 * transcript; nothing that only moves content decodes it. Ported from
 * termish-py's test_binary.py (the find, zcat and stdin-gzip cases come
 * with those builtins).
 */

import { gunzipSync } from 'fflate'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { type CommandHandler, TerminalError, execute } from '../src/index'

const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i)
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const twice = (b: Uint8Array): Uint8Array => {
  const out = new Uint8Array(b.length * 2)
  out.set(b)
  out.set(b, b.length)
  return out
}

let fs: MemoryFS
beforeEach(async () => {
  fs = new MemoryFS()
  await fs.write('/bin.dat', ALL_BYTES)
})

describe('redirects and pipes carry bytes', () => {
  it('through cat, to a file and through a pipe', async () => {
    await execute('cat bin.dat > copy.dat', fs)
    expect(await fs.read('/copy.dat')).toEqual(ALL_BYTES)
    await execute('cat bin.dat | cat > c2.dat', fs)
    expect(await fs.read('/c2.dat')).toEqual(ALL_BYTES)
    await execute('cat < bin.dat > c3.dat', fs)
    expect(await fs.read('/c3.dat')).toEqual(ALL_BYTES)
  })

  it('through tee, and >>', async () => {
    await execute('cat bin.dat | tee copy.dat > /dev/null', fs)
    expect(await fs.read('/copy.dat')).toEqual(ALL_BYTES)
    await execute('cat bin.dat | tee -a both.dat > /dev/null', fs)
    await execute('cat bin.dat | tee -a both.dat > /dev/null', fs)
    expect(await fs.read('/both.dat')).toEqual(twice(ALL_BYTES))
    await execute('cat bin.dat > app.dat; cat bin.dat >> app.dat', fs)
    expect(await fs.read('/app.dat')).toEqual(twice(ALL_BYTES))
  })

  it('through head -c and tail -c, from files and stdin', async () => {
    await execute('head -c 100 bin.dat > h.dat', fs)
    expect(await fs.read('/h.dat')).toEqual(ALL_BYTES.subarray(0, 100))
    await execute('tail -c 100 bin.dat > t.dat', fs)
    expect(await fs.read('/t.dat')).toEqual(ALL_BYTES.subarray(156))
    await execute('cat bin.dat | head -c 10 > h2.dat', fs)
    expect(await fs.read('/h2.dat')).toEqual(ALL_BYTES.subarray(0, 10))
    await execute('cat bin.dat | tail -c 10 > t2.dat', fs)
    expect(await fs.read('/t2.dat')).toEqual(ALL_BYTES.subarray(246))
  })

  it('through head -n and tail -n, lines split only at \\n', async () => {
    await fs.write('/lines.dat', Uint8Array.from([0xff, 0xfe, 0x0a, 0x00, 0x01, 0x0a]))
    await execute('head -n 1 lines.dat > h.dat', fs)
    expect(await fs.read('/h.dat')).toEqual(Uint8Array.from([0xff, 0xfe, 0x0a]))
    await execute('tail -n 1 lines.dat > t.dat', fs)
    expect(await fs.read('/t.dat')).toEqual(Uint8Array.from([0x00, 0x01, 0x0a]))
  })

  it('keeps \\r\\n through a pipeline', async () => {
    await fs.write('/crlf.txt', bytes('a\r\nb\r\n'))
    await execute('cat crlf.txt | cat > copy.txt', fs)
    expect(await fs.read('/copy.txt')).toEqual(bytes('a\r\nb\r\n'))
  })

  it('through cp and mv', async () => {
    await execute('cp bin.dat copy.dat', fs)
    expect(await fs.read('/copy.dat')).toEqual(ALL_BYTES)
    await execute('mv bin.dat moved.dat', fs)
    expect(await fs.read('/moved.dat')).toEqual(ALL_BYTES)
  })

  it('writes a heredoc body as UTF-8', async () => {
    await execute('cat <<EOF > out.txt\ncafé\nEOF', fs)
    expect(await fs.read('/out.txt')).toEqual(bytes('café\n'))
  })

  it('round-trips gzip -c through a redirect', async () => {
    await execute('gzip -c bin.dat > bin.gz', fs)
    expect(gunzipSync(await fs.read('/bin.gz'))).toEqual(ALL_BYTES)
  })
})

describe('wc counts bytes', () => {
  it('of a binary file and of binary stdin', async () => {
    expect((await execute('wc -c bin.dat', fs)).trim()).toBe('256 bin.dat')
    expect((await execute('cat bin.dat | wc -c', fs)).trim()).toBe('256')
  })

  it('not characters', async () => {
    expect((await execute("printf 'é\\n' | wc -c", fs)).trim()).toBe('3')
  })
})

describe('the transcript is decoded once', () => {
  it('with undecodable bytes as U+FFFD', async () => {
    const emit: CommandHandler = async (ctx) => {
      ctx.stdout.writeBytes(Uint8Array.from([0x61, 0xff, 0x62]))
    }
    expect(await execute('emit', fs, { commands: { emit } })).toBe('a�b')
  })

  it('leaving text as it is', async () => {
    expect(await execute('echo café', fs)).toBe('café\n')
  })
})

describe('injected handlers', () => {
  it('write bytes that reach a pipe and a redirect intact', async () => {
    const emit: CommandHandler = async (ctx) => {
      ctx.stdout.writeBytes(ALL_BYTES)
    }
    expect((await execute('emit | wc -c', fs, { commands: { emit } })).trim()).toBe('256')
    await execute('emit > out.dat', fs, { commands: { emit } })
    expect(await fs.read('/out.dat')).toEqual(ALL_BYTES)
  })

  it('read bytes from stdin', async () => {
    const count: CommandHandler = async (ctx) => {
      ctx.stdout.write(`${ctx.stdin.bytes.byteLength}\n`)
    }
    expect(await execute('cat bin.dat | count', fs, { commands: { count } })).toBe('256\n')
  })

  it('interleave text and bytes in the order written', async () => {
    const mixed: CommandHandler = async (ctx) => {
      ctx.stdout.write('a')
      ctx.stdout.writeBytes(bytes('b'))
      ctx.stdout.write('c')
    }
    await execute('mixed > out.txt', fs, { commands: { mixed } })
    expect(await fs.read('/out.txt')).toEqual(bytes('abc'))
  })
})

describe('bytes change nothing about where diagnostics land', () => {
  it("decodes a failing handler's partial output", async () => {
    const emit: CommandHandler = async (ctx) => {
      ctx.stdout.writeBytes(Uint8Array.from([0xff, 0xfe]))
      return { exitCode: 1, stderr: 'boom' }
    }
    const error = (await execute('emit', fs, { commands: { emit } }).catch(
      (e: unknown) => e,
    )) as TerminalError
    expect(error).toBeInstanceOf(TerminalError)
    expect(error.partialOutput).toBe('��')
    expect(error.stderr).toBe('boom')
  })

  it('merges stderr after the bytes written first', async () => {
    const noisy: CommandHandler = async (ctx) => {
      ctx.stdout.writeBytes(bytes('out\n'))
      return { exitCode: 0, stderr: 'warn\n' }
    }
    expect(await execute('noisy 2>&1 | cat', fs, { commands: { noisy } })).toBe('out\nwarn\n')
  })

  it('writes a stderr redirect as UTF-8', async () => {
    const noisy: CommandHandler = async () => ({ exitCode: 0, stderr: 'café\n' })
    await execute('noisy 2> err.txt', fs, { commands: { noisy } })
    expect(await fs.read('/err.txt')).toEqual(bytes('café\n'))
  })
})
