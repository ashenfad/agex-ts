import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

describe('sed — substitution', () => {
  it('basic s/old/new/ replaces first occurrence per line', async () => {
    const out = await execute("echo -e 'foo foo\\nbar foo' | sed 's/foo/X/'", new MemoryFS())
    expect(out).toBe('X foo\nbar X\n')
  })

  it('g flag replaces all occurrences', async () => {
    const out = await execute("echo 'foo foo foo' | sed 's/foo/X/g'", new MemoryFS())
    expect(out).toBe('X X X\n')
  })

  it('i flag is case-insensitive', async () => {
    const out = await execute("echo 'Foo FOO foo' | sed 's/foo/X/gi'", new MemoryFS())
    expect(out).toBe('X X X\n')
  })

  it('p flag prints matched lines twice (with -n only matched)', async () => {
    const out = await execute("echo -e 'aaa\\nbbb\\naaa' | sed -n 's/a/X/gp'", new MemoryFS())
    expect(out).toBe('XXX\nXXX\n')
  })

  it('alternative delimiters work', async () => {
    const out = await execute("echo '/usr/bin' | sed 's|/usr|/opt|'", new MemoryFS())
    expect(out).toBe('/opt/bin\n')
  })

  it('& refers to whole match', async () => {
    const out = await execute("echo 'foo' | sed 's/foo/[&]/'", new MemoryFS())
    expect(out).toBe('[foo]\n')
  })

  it('\\1 backref (with -E for parens)', async () => {
    const out = await execute(
      "echo 'hello world' | sed -E 's/(hello) (world)/\\2 \\1/'",
      new MemoryFS(),
    )
    expect(out).toBe('world hello\n')
  })

  it('\\& is a literal ampersand', async () => {
    const out = await execute("echo 'foo' | sed 's/foo/\\&/'", new MemoryFS())
    expect(out).toBe('&\n')
  })

  it('\\n in replacement becomes a newline', async () => {
    const out = await execute("echo 'a,b' | sed 's/,/\\n/'", new MemoryFS())
    expect(out).toBe('a\nb\n')
  })

  it('escapes literal $ in replacement', async () => {
    const out = await execute("echo 'price' | sed 's/price/\\$10/'", new MemoryFS())
    expect(out).toBe('$10\n')
  })
})

describe('sed — addresses', () => {
  it('numeric address selects single line', async () => {
    const out = await execute("echo -e 'a\\nb\\nc' | sed '2s/./X/'", new MemoryFS())
    expect(out).toBe('a\nX\nc\n')
  })

  it('$ matches last line', async () => {
    const out = await execute("echo -e 'a\\nb\\nc' | sed '$s/./X/'", new MemoryFS())
    expect(out).toBe('a\nb\nX\n')
  })

  it('regex address selects matching lines', async () => {
    const out = await execute("echo -e 'foo\\nbar\\nfooz' | sed '/foo/s/o/0/g'", new MemoryFS())
    expect(out).toBe('f00\nbar\nf00z\n')
  })

  it('numeric range', async () => {
    const out = await execute("echo -e 'a\\nb\\nc\\nd\\ne' | sed '2,4s/./X/'", new MemoryFS())
    expect(out).toBe('a\nX\nX\nX\ne\n')
  })

  it('regex range', async () => {
    const out = await execute(
      "echo -e 'a\\nSTART\\nb\\nEND\\nc' | sed '/START/,/END/d'",
      new MemoryFS(),
    )
    expect(out).toBe('a\nc\n')
  })
})

describe('sed — commands', () => {
  it('d deletes lines', async () => {
    const out = await execute("echo -e 'a\\nb\\nc' | sed '/b/d'", new MemoryFS())
    expect(out).toBe('a\nc\n')
  })

  it('p with -n prints only matched lines', async () => {
    const out = await execute("echo -e 'a\\nb\\nc' | sed -n '/b/p'", new MemoryFS())
    expect(out).toBe('b\n')
  })

  it('q quits after current line', async () => {
    const out = await execute("echo -e 'a\\nb\\nc\\nd' | sed '2q'", new MemoryFS())
    expect(out).toBe('a\nb\n')
  })

  it('y transliterates characters', async () => {
    const out = await execute("echo 'abcabc' | sed 'y/abc/xyz/'", new MemoryFS())
    expect(out).toBe('xyzxyz\n')
  })

  it('y mismatched set lengths errors', async () => {
    await expect(execute("echo 'a' | sed 'y/abc/xy/'", new MemoryFS())).rejects.toBeInstanceOf(
      TerminalError,
    )
  })

  it('a appends text after matching line', async () => {
    const out = await execute("echo -e 'a\\nb' | sed '/a/a APPENDED'", new MemoryFS())
    expect(out).toBe('a\nAPPENDED\nb\n')
  })

  it('i inserts text before matching line', async () => {
    const out = await execute("echo -e 'a\\nb' | sed '/b/i INSERTED'", new MemoryFS())
    expect(out).toBe('a\nINSERTED\nb\n')
  })

  it('c changes matching line', async () => {
    const out = await execute("echo -e 'a\\nb\\nc' | sed '/b/c CHANGED'", new MemoryFS())
    expect(out).toBe('a\nCHANGED\nc\n')
  })
})

describe('sed — flags', () => {
  it('-n suppresses default output', async () => {
    const out = await execute("echo -e 'a\\nb\\nc' | sed -n '/b/p'", new MemoryFS())
    expect(out).toBe('b\n')
  })

  it('-e allows multiple expressions', async () => {
    const out = await execute("echo 'foo' | sed -e 's/f/F/' -e 's/o/O/g'", new MemoryFS())
    expect(out).toBe('FOO\n')
  })

  it('-E (extended regex) is accepted', async () => {
    const out = await execute("echo 'abc123' | sed -E 's/[0-9]+/X/'", new MemoryFS())
    expect(out).toBe('abcX\n')
  })

  it('-i edits file in place', async () => {
    const fs = new MemoryFS()
    await fs.write('/f.txt', bytes('hello\nworld\n'))
    const out = await execute("sed -i 's/hello/HI/' /f.txt", fs)
    expect(out).toBe('')
    const after = new TextDecoder().decode(await fs.read('/f.txt'))
    expect(after).toBe('HI\nworld\n')
  })

  it('-i requires a file argument', async () => {
    await expect(execute("echo x | sed -i 's/x/y/'", new MemoryFS())).rejects.toBeInstanceOf(
      TerminalError,
    )
  })
})

describe('sed — file input', () => {
  it('reads from a file when given as positional', async () => {
    const fs = new MemoryFS()
    await fs.write('/f.txt', bytes('hello\n'))
    const out = await execute("sed 's/hello/HI/' /f.txt", fs)
    expect(out).toBe('HI\n')
  })

  it('preserves missing trailing newline', async () => {
    const fs = new MemoryFS()
    await fs.write('/f.txt', bytes('no-newline'))
    const out = await execute("sed 's/no/yes/' /f.txt", fs)
    expect(out).toBe('yes-newline')
  })

  it('errors on missing file', async () => {
    await expect(execute("sed 's/x/y/' /missing", new MemoryFS())).rejects.toBeInstanceOf(
      TerminalError,
    )
  })
})

describe('sed — errors', () => {
  it('errors on missing expression', async () => {
    await expect(execute('sed', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })

  it('errors on unknown command character', async () => {
    await expect(execute("echo x | sed 'Z'", new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })

  it('errors on unterminated s command', async () => {
    await expect(execute("echo x | sed 's/foo/bar'", new MemoryFS())).rejects.toBeInstanceOf(
      TerminalError,
    )
  })
})
