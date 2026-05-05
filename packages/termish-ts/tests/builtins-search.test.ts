import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

describe('grep — basics', () => {
  it('finds matching lines from stdin', async () => {
    const out = await execute("echo -e 'apple\\nbanana\\ncherry' | grep an", new MemoryFS())
    expect(out).toBe('banana\n')
  })

  it('returns empty when no match', async () => {
    const out = await execute('echo apple | grep zzz', new MemoryFS())
    expect(out).toBe('')
  })

  it('reads a file', async () => {
    const fs = new MemoryFS()
    await fs.write('/data', bytes('one\ntwo\nthree\n'))
    expect(await execute('grep two /data', fs)).toBe('two\n')
  })

  it('errors on missing pattern', async () => {
    await expect(execute('grep', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })
})

describe('grep — flags', () => {
  it('-i ignores case', async () => {
    const out = await execute("echo -e 'Apple\\nBANANA' | grep -i banana", new MemoryFS())
    expect(out).toBe('BANANA\n')
  })

  it('-n adds line numbers', async () => {
    const out = await execute("echo -e 'a\\nb\\na' | grep -n a", new MemoryFS())
    expect(out).toBe('1:a\n3:a\n')
  })

  it('-v inverts the match', async () => {
    const out = await execute("echo -e 'a\\nb\\nc' | grep -v b", new MemoryFS())
    expect(out).toBe('a\nc\n')
  })

  it('-c counts matches', async () => {
    const out = await execute("echo -e 'a\\nab\\nab\\nc' | grep -c a", new MemoryFS())
    expect(out).toBe('3\n')
  })

  it('-w word boundary', async () => {
    const out = await execute("echo -e 'foo\\nfoobar\\nfoo bar' | grep -w foo", new MemoryFS())
    expect(out).toBe('foo\nfoo bar\n')
  })

  it('-o only matching prints just the match', async () => {
    const out = await execute("echo -e 'aXa\\nbXb' | grep -o X", new MemoryFS())
    expect(out).toBe('X\nX\n')
  })

  it('-F treats pattern as fixed string (no regex)', async () => {
    const out = await execute("echo 'a.b' | grep -F .", new MemoryFS())
    expect(out).toBe('a.b\n')
  })

  it('-E uses extended regex (| as alternation, no escaping needed)', async () => {
    const out = await execute("echo -e 'apple\\nbanana' | grep -E 'apple|banana'", new MemoryFS())
    expect(out).toBe('apple\nbanana\n')
  })

  it('default mode treats \\| as alternation (BRE)', async () => {
    const out = await execute("echo -e 'apple\\nbanana' | grep 'apple\\|banana'", new MemoryFS())
    expect(out).toBe('apple\nbanana\n')
  })

  it('-m N stops after N matches', async () => {
    const out = await execute("echo -e 'a\\na\\na\\na' | grep -m 2 a", new MemoryFS())
    expect(out).toBe('a\na\n')
  })

  it('-e PATTERN can be repeated for multiple patterns', async () => {
    const out = await execute(
      "echo -e 'apple\\nbanana\\ncherry' | grep -e apple -e cherry",
      new MemoryFS(),
    )
    expect(out).toBe('apple\ncherry\n')
  })
})

describe('grep — context', () => {
  it('-A N shows N lines after each match', async () => {
    const out = await execute(
      "echo -e 'one\\ntwo\\nMATCH\\nfour\\nfive' | grep -A 2 MATCH",
      new MemoryFS(),
    )
    expect(out).toBe('MATCH\nfour\nfive\n')
  })

  it('-B N shows N lines before each match', async () => {
    const out = await execute(
      "echo -e 'one\\ntwo\\nMATCH\\nfour' | grep -B 1 MATCH",
      new MemoryFS(),
    )
    expect(out).toBe('two\nMATCH\n')
  })

  it('-C N shows N lines around each match', async () => {
    const out = await execute(
      "echo -e 'one\\ntwo\\nMATCH\\nfour\\nfive' | grep -C 1 MATCH",
      new MemoryFS(),
    )
    expect(out).toBe('two\nMATCH\nfour\n')
  })
})

describe('grep — multiple files / -r / -l / -L', () => {
  async function setup(): Promise<MemoryFS> {
    const fs = new MemoryFS()
    await fs.mkdir('/src', { parents: true })
    await fs.write('/src/a.ts', bytes('export const TODO = 1\n'))
    await fs.write('/src/b.ts', bytes('export const ok = 2\n'))
    await fs.mkdir('/src/sub', { parents: true })
    await fs.write('/src/sub/c.ts', bytes('// TODO inner\n'))
    return fs
  }

  it('multiple files prefix each line with the filename', async () => {
    const fs = await setup()
    const out = await execute('grep TODO /src/a.ts /src/b.ts', fs)
    expect(out).toContain('/src/a.ts:export const TODO = 1')
    expect(out.includes('/src/b.ts')).toBe(false) // no match
  })

  it('-r recurses into directories', async () => {
    const fs = await setup()
    const out = await execute('grep -r TODO /src', fs)
    expect(out.includes('/src/a.ts')).toBe(true)
    expect(out.includes('/src/sub/c.ts')).toBe(true)
  })

  it('-l shows files-with-matches only', async () => {
    const fs = await setup()
    const out = await execute('grep -rl TODO /src', fs)
    const files = out.trim().split('\n').sort()
    expect(files).toEqual(['/src/a.ts', '/src/sub/c.ts'])
  })

  it('-L shows files-without-matches', async () => {
    const fs = await setup()
    const out = await execute('grep -rL TODO /src', fs)
    expect(out.trim()).toBe('/src/b.ts')
  })

  it('--include filters by glob', async () => {
    const fs = await setup()
    await fs.write('/src/notes.md', bytes('TODO from md\n'))
    const out = await execute("grep -rl TODO /src --include='*.ts'", fs)
    expect(out.includes('/src/notes.md')).toBe(false)
    expect(out.includes('.ts')).toBe(true)
  })

  it('--exclude filters out by glob', async () => {
    const fs = await setup()
    const out = await execute("grep -rl TODO /src --exclude='*.ts'", fs)
    expect(out.trim()).toBe('') // all matches were .ts
  })
})

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

describe('find — basics', () => {
  async function setup(): Promise<MemoryFS> {
    const fs = new MemoryFS()
    await fs.mkdir('/proj', { parents: true })
    await fs.write('/proj/a.ts', bytes('A'))
    await fs.write('/proj/b.ts', bytes('BB'))
    await fs.write('/proj/notes.md', bytes('NOTES'))
    await fs.mkdir('/proj/src', { parents: true })
    await fs.write('/proj/src/inner.ts', bytes('INNER'))
    await fs.write('/proj/src/util.js', bytes('UTIL'))
    return fs
  }

  it('lists everything under the path by default', async () => {
    const fs = await setup()
    const out = await execute('find /proj', fs)
    const paths = out.trim().split('\n').sort()
    expect(paths.length).toBeGreaterThanOrEqual(5) // 4 files + 1 subdir
    expect(paths.includes('/proj/a.ts')).toBe(true)
    expect(paths.includes('/proj/src/inner.ts')).toBe(true)
  })

  it('-name pattern filters by basename', async () => {
    const fs = await setup()
    const out = await execute("find /proj -name '*.ts'", fs)
    const paths = out.trim().split('\n').sort()
    expect(paths).toEqual(['/proj/a.ts', '/proj/b.ts', '/proj/src/inner.ts'])
  })

  it('-iname is case-insensitive name match', async () => {
    const fs = await setup()
    const out = await execute("find /proj -iname 'A.TS'", fs)
    expect(out.trim()).toBe('/proj/a.ts')
  })

  it('-type f matches only files', async () => {
    const fs = await setup()
    const out = await execute('find /proj -type f', fs)
    const lines = out.trim().split('\n')
    expect(lines.includes('/proj/src')).toBe(false) // src is the dir, not the file
    expect(lines.includes('/proj/a.ts')).toBe(true)
  })

  it('-type d matches only directories', async () => {
    const fs = await setup()
    const out = await execute('find /proj -type d', fs)
    expect(out.trim()).toBe('/proj/src')
  })

  it('-size +N (bytes via c suffix) filters by size', async () => {
    const fs = await setup()
    // a.ts is 1 byte, b.ts is 2 bytes, notes.md is 5 bytes
    const out = await execute('find /proj -type f -size +2c', fs)
    const paths = out.trim().split('\n').sort()
    expect(paths.includes('/proj/notes.md')).toBe(true)
    expect(paths.includes('/proj/src/util.js')).toBe(true) // 4 bytes
    expect(paths.includes('/proj/a.ts')).toBe(false)
    expect(paths.includes('/proj/b.ts')).toBe(false)
  })

  it('-empty matches empty files', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d', { parents: true })
    await fs.write('/d/empty', bytes(''))
    await fs.write('/d/full', bytes('x'))
    const out = await execute('find /d -type f -empty', fs)
    expect(out.trim()).toBe('/d/empty')
  })
})

describe('find — operators', () => {
  async function setup(): Promise<MemoryFS> {
    const fs = new MemoryFS()
    await fs.mkdir('/p', { parents: true })
    await fs.write('/p/a.ts', bytes(''))
    await fs.write('/p/b.js', bytes(''))
    await fs.write('/p/c.md', bytes(''))
    return fs
  }

  it('implicit AND combines predicates', async () => {
    const fs = await setup()
    const out = await execute("find /p -type f -name 'a.*'", fs)
    expect(out.trim()).toBe('/p/a.ts')
  })

  it('-or matches either predicate', async () => {
    const fs = await setup()
    const out = await execute("find /p -name '*.ts' -or -name '*.js'", fs)
    const paths = out.trim().split('\n').sort()
    expect(paths).toEqual(['/p/a.ts', '/p/b.js'])
  })

  it('! negates a predicate', async () => {
    const fs = await setup()
    const out = await execute("find /p -type f ! -name '*.md'", fs)
    const paths = out.trim().split('\n').sort()
    expect(paths).toEqual(['/p/a.ts', '/p/b.js'])
  })
})

describe('find — actions', () => {
  it('-print is explicit (without it the default already prints)', async () => {
    // -print suppresses the default printer when present (otherwise
    // we'd see each path twice). Verify that the output with -print
    // matches the output without it.
    const fs = new MemoryFS()
    await fs.mkdir('/d', { parents: true })
    await fs.write('/d/k', bytes('v'))
    const withPrint = await execute('find /d -print', fs)
    const withoutPrint = await execute('find /d', fs)
    expect(withPrint).toBe(withoutPrint)
  })

  it('-delete removes matched files', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d', { parents: true })
    await fs.write('/d/a.tmp', bytes(''))
    await fs.write('/d/b.tmp', bytes(''))
    await fs.write('/d/keep.md', bytes(''))
    await execute("find /d -type f -name '*.tmp' -delete", fs)
    expect(await fs.exists('/d/a.tmp')).toBe(false)
    expect(await fs.exists('/d/b.tmp')).toBe(false)
    expect(await fs.exists('/d/keep.md')).toBe(true)
  })

  it("-exec ... ';' runs a command per match (single-quoted ; literal)", async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d', { parents: true })
    await fs.write('/d/a.txt', bytes('AAA'))
    await fs.write('/d/b.txt', bytes('BBBB'))
    // `;` is a shell pipeline operator; quote it (or backslash-escape) so
    // it reaches find as a literal arg rather than ending the command.
    const out = await execute("find /d -type f -exec cat {} ';'", fs)
    expect(out.includes('AAA')).toBe(true)
    expect(out.includes('BBBB')).toBe(true)
  })
})

describe('find — depth', () => {
  it('-maxdepth limits recursion', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/p/a/b/c', { parents: true })
    await fs.write('/p/x', bytes(''))
    await fs.write('/p/a/y', bytes(''))
    await fs.write('/p/a/b/z', bytes(''))
    const out = await execute('find /p -maxdepth 2', fs)
    expect(out.includes('/p/x')).toBe(true)
    expect(out.includes('/p/a/y')).toBe(true)
    expect(out.includes('/p/a/b/z')).toBe(false)
  })
})
