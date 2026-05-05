import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
const text = (b: Uint8Array): string => dec.decode(b)

describe('echo', () => {
  it('writes args joined by spaces with a trailing newline', async () => {
    expect(await execute('echo hello world', new MemoryFS())).toBe('hello world\n')
  })

  it('-n suppresses the trailing newline', async () => {
    expect(await execute('echo -n hello', new MemoryFS())).toBe('hello')
  })

  it('-e interprets \\n', async () => {
    expect(await execute("echo -e 'a\\nb'", new MemoryFS())).toBe('a\nb\n')
  })

  it('-e interprets \\t', async () => {
    expect(await execute("echo -e 'a\\tb'", new MemoryFS())).toBe('a\tb\n')
  })

  it('-e interprets \\\\ as a single backslash', async () => {
    expect(await execute("echo -e 'a\\\\b'", new MemoryFS())).toBe('a\\b\n')
  })

  it('-e leaves unknown escapes as a backslash followed by the char', async () => {
    expect(await execute("echo -e 'a\\xb'", new MemoryFS())).toBe('a\\xb\n')
  })

  it('-ne combines suppress-newline + interpret-escapes', async () => {
    expect(await execute("echo -ne 'a\\nb'", new MemoryFS())).toBe('a\nb')
  })

  it('-en is equivalent to -ne', async () => {
    expect(await execute("echo -en 'a\\nb'", new MemoryFS())).toBe('a\nb')
  })

  it('treats unknown flags as literal text (POSIX echo permissiveness)', async () => {
    expect(await execute('echo --help', new MemoryFS())).toBe('--help\n')
  })

  it('writes just newline with no args', async () => {
    expect(await execute('echo', new MemoryFS())).toBe('\n')
  })
})

describe('cat', () => {
  it('reads stdin when no files', async () => {
    expect(await execute('echo hi | cat', new MemoryFS())).toBe('hi\n')
  })

  it('reads files in order', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('A'))
    await fs.write('/b', bytes('B'))
    expect(await execute('cat /a /b', fs)).toBe('AB')
  })

  it('treats - as stdin', async () => {
    const fs = new MemoryFS()
    await fs.write('/file', bytes('FILE\n'))
    expect(await execute('echo STDIN | cat /file -', fs)).toBe('FILE\nSTDIN\n')
  })

  it('-n numbers lines (1-based, padded)', async () => {
    const fs = new MemoryFS()
    await fs.write('/multi', bytes('one\ntwo\nthree'))
    const out = await execute('cat -n /multi', fs)
    // Lines are right-padded to width 6
    expect(out).toBe('     1  one\n     2  two\n     3  three')
  })

  it('-T shows tabs as ^I', async () => {
    const fs = new MemoryFS()
    await fs.write('/tabs', bytes('a\tb'))
    expect(await execute('cat -T /tabs', fs)).toBe('a^Ib')
  })

  it('-e shows $ at end of each line', async () => {
    const fs = new MemoryFS()
    await fs.write('/lines', bytes('a\nb\n'))
    expect(await execute('cat -e /lines', fs)).toBe('a$\nb$\n')
  })

  it('-A is shorthand for -eT', async () => {
    const fs = new MemoryFS()
    await fs.write('/mix', bytes('a\tb\n'))
    expect(await execute('cat -A /mix', fs)).toBe('a^Ib$\n')
  })

  it('errors on a missing file', async () => {
    await expect(execute('cat /nope', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })
})

describe('head', () => {
  async function setup(): Promise<MemoryFS> {
    const fs = new MemoryFS()
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    await fs.write('/multi', bytes(lines))
    return fs
  }

  it('returns first 10 lines by default', async () => {
    const fs = await setup()
    const out = await execute('head /multi', fs)
    expect(out.startsWith('line 1\n')).toBe(true)
    expect(out.endsWith('line 10\n')).toBe(true)
    expect(out.includes('line 11')).toBe(false)
  })

  it('-n N limits to first N lines', async () => {
    const fs = await setup()
    const out = await execute('head -n 3 /multi', fs)
    expect(out).toBe('line 1\nline 2\nline 3\n')
  })

  it('-N shorthand for -n N', async () => {
    const fs = await setup()
    const out = await execute('head -3 /multi', fs)
    expect(out).toBe('line 1\nline 2\nline 3\n')
  })

  it('-c N takes first N bytes', async () => {
    const fs = new MemoryFS()
    await fs.write('/data', bytes('abcdefghij'))
    expect(await execute('head -c 5 /data', fs)).toBe('abcde')
  })

  it('reads stdin when no files', async () => {
    const out = await execute(`echo "alpha" | head`, new MemoryFS())
    expect(out).toBe('alpha\n')
  })

  it('multi-file mode prints headers', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('A1\nA2\n'))
    await fs.write('/b', bytes('B1\nB2\n'))
    const out = await execute('head -n 1 /a /b', fs)
    expect(out.includes('==> /a <==\n')).toBe(true)
    expect(out.includes('==> /b <==\n')).toBe(true)
    expect(out.includes('A1')).toBe(true)
    expect(out.includes('B1')).toBe(true)
  })
})

describe('tail', () => {
  async function setup(): Promise<MemoryFS> {
    const fs = new MemoryFS()
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    await fs.write('/multi', bytes(lines))
    return fs
  }

  it('returns last 10 lines by default', async () => {
    const fs = await setup()
    const out = await execute('tail /multi', fs)
    expect(out.startsWith('line 11\n')).toBe(true)
    expect(out.endsWith('line 20')).toBe(true)
  })

  it('-n N limits to last N lines', async () => {
    const fs = await setup()
    const out = await execute('tail -n 3 /multi', fs)
    expect(out).toBe('line 18\nline 19\nline 20')
  })

  it('-N shorthand for -n N', async () => {
    const fs = await setup()
    const out = await execute('tail -3 /multi', fs)
    expect(out).toBe('line 18\nline 19\nline 20')
  })

  it('+N starts from line N onwards', async () => {
    const fs = await setup()
    const out = await execute('tail -n +18 /multi', fs)
    expect(out).toBe('line 18\nline 19\nline 20')
  })

  it('-c N takes last N bytes', async () => {
    const fs = new MemoryFS()
    await fs.write('/data', bytes('abcdefghij'))
    expect(await execute('tail -c 3 /data', fs)).toBe('hij')
  })

  it('reads stdin when no files', async () => {
    const out = await execute(`echo "tail-stdin" | tail`, new MemoryFS())
    expect(out).toBe('tail-stdin\n')
  })

  it('multi-file mode prints headers', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('a1\na2\n'))
    await fs.write('/b', bytes('b1\nb2\n'))
    const out = await execute('tail -n 1 /a /b', fs)
    expect(out.includes('==> /a <==\n')).toBe(true)
    expect(out.includes('==> /b <==\n')).toBe(true)
  })
})

describe('tee', () => {
  it('writes stdin to both stdout and a file', async () => {
    const fs = new MemoryFS()
    const out = await execute('echo hello | tee /out.txt', fs)
    expect(out).toBe('hello\n')
    expect(text(await fs.read('/out.txt'))).toBe('hello\n')
  })

  it('writes to multiple files', async () => {
    const fs = new MemoryFS()
    await execute('echo data | tee /a /b', fs)
    expect(text(await fs.read('/a'))).toBe('data\n')
    expect(text(await fs.read('/b'))).toBe('data\n')
  })

  it('-a appends instead of overwriting', async () => {
    const fs = new MemoryFS()
    await fs.write('/log', bytes('first\n'))
    await execute('echo second | tee -a /log', fs)
    expect(text(await fs.read('/log'))).toBe('first\nsecond\n')
  })

  it('without -a overwrites', async () => {
    const fs = new MemoryFS()
    await fs.write('/log', bytes('first\n'))
    await execute('echo only | tee /log', fs)
    expect(text(await fs.read('/log'))).toBe('only\n')
  })
})
