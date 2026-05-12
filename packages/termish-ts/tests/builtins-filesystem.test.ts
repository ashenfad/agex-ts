import { describe, expect, it } from 'vitest'
import { TerminalError } from '../src/errors'
import { MemoryFS } from '../src/fs/memory'
import { execute } from '../src/interpreter'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)
const text = (b: Uint8Array): string => dec.decode(b)

describe('pwd', () => {
  it('prints the current working directory', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/foo', { parents: true })
    await fs.chdir('/foo')
    expect(await execute('pwd', fs)).toBe('/foo\n')
  })

  it('defaults to /', async () => {
    expect(await execute('pwd', new MemoryFS())).toBe('/\n')
  })
})

describe('cd', () => {
  it('changes the current directory', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/dir', { parents: true })
    await execute('cd /dir', fs)
    expect(fs.getcwd()).toBe('/dir')
  })

  it('cd with no args goes to /', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/dir', { parents: true })
    await fs.chdir('/dir')
    await execute('cd', fs)
    expect(fs.getcwd()).toBe('/')
  })

  it('throws on missing directory', async () => {
    await expect(execute('cd /nope', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })
})

describe('mkdir', () => {
  it('creates a directory', async () => {
    const fs = new MemoryFS()
    await execute('mkdir /new', fs)
    expect(await fs.isDir('/new')).toBe(true)
  })

  it('-p creates intermediate directories', async () => {
    const fs = new MemoryFS()
    await execute('mkdir -p /a/b/c', fs)
    expect(await fs.isDir('/a/b/c')).toBe(true)
  })

  it('without -p errors on existing dir', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d')
    await expect(execute('mkdir /d', fs)).rejects.toBeInstanceOf(TerminalError)
  })

  it('-p is silent on existing dir', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d')
    await execute('mkdir -p /d', fs) // no throw
  })
})

describe('ls', () => {
  async function setup(): Promise<MemoryFS> {
    const fs = new MemoryFS()
    await fs.mkdir('/dir', { parents: true })
    await fs.write('/dir/a.txt', bytes('AAA'))
    await fs.write('/dir/b.txt', bytes('BBBB'))
    await fs.write('/dir/.hidden', bytes('hidden'))
    await fs.mkdir('/dir/sub', { parents: true })
    return fs
  }

  it('lists direct children sorted', async () => {
    const fs = await setup()
    const out = await execute('ls /dir', fs)
    expect(out.trim().split('\n').sort()).toEqual(['a.txt', 'b.txt', 'sub'])
  })

  it('omits hidden files by default', async () => {
    const fs = await setup()
    const out = await execute('ls /dir', fs)
    expect(out.includes('.hidden')).toBe(false)
  })

  it('-a includes hidden files', async () => {
    const fs = await setup()
    const out = await execute('ls -a /dir', fs)
    expect(out.includes('.hidden')).toBe(true)
  })

  it('-l shows long format including size and type', async () => {
    const fs = await setup()
    const out = await execute('ls -l /dir', fs)
    // Three entries; each should have "rw-r--r--" perms and the file's name
    expect(out.includes('a.txt')).toBe(true)
    expect(out.includes('-rw-r--r--')).toBe(true)
    expect(out.includes('drw-r--r--')).toBe(true)
  })

  it('-S sorts by size descending', async () => {
    const fs = await setup()
    const out = await execute('ls -lS /dir', fs)
    // b.txt (4 bytes) should appear before a.txt (3 bytes)
    expect(out.indexOf('b.txt')).toBeLessThan(out.indexOf('a.txt'))
  })

  it('-h human-readable size in -l mode', async () => {
    const fs = await setup()
    const out = await execute('ls -lh /dir', fs)
    // 3-byte file shows as "3B"
    expect(out.includes('3B')).toBe(true)
  })

  it('-R recursively lists subdirectories', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d/sub', { parents: true })
    await fs.write('/d/top.txt', bytes(''))
    await fs.write('/d/sub/inner.txt', bytes(''))
    const out = await execute('ls -R /d', fs)
    expect(out.includes('sub/inner.txt')).toBe(true)
  })

  it('lists a single file when given a file path', async () => {
    const fs = new MemoryFS()
    await fs.write('/foo.txt', bytes(''))
    expect(await execute('ls /foo.txt', fs)).toBe('/foo.txt\n')
  })

  it('lists multiple file paths inline (no `path:` headers, no blank lines)', async () => {
    const fs = new MemoryFS()
    await fs.write('/a.txt', bytes(''))
    await fs.write('/b.txt', bytes(''))
    expect(await execute('ls /a.txt /b.txt', fs)).toBe('/a.txt\n/b.txt\n')
  })

  it('separates multiple directory listings with a blank line and `dir:` headers', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d1')
    await fs.mkdir('/d2')
    await fs.write('/d1/a', bytes(''))
    await fs.write('/d2/b', bytes(''))
    expect(await execute('ls /d1 /d2', fs)).toBe('/d1:\na\n\n/d2:\nb\n')
  })

  it('-d lists the directory entry itself', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d')
    expect(await execute('ls -d /d', fs)).toBe('/d\n')
  })

  it('-F appends / to directories', async () => {
    const fs = await setup()
    const out = await execute('ls -F /dir', fs)
    expect(out.includes('sub/')).toBe(true)
  })
})

describe('touch', () => {
  it('creates an empty file when missing', async () => {
    const fs = new MemoryFS()
    await execute('touch /new', fs)
    expect(await fs.isFile('/new')).toBe(true)
    expect((await fs.read('/new')).byteLength).toBe(0)
  })

  it('-c does not create a missing file', async () => {
    const fs = new MemoryFS()
    await execute('touch -c /new', fs)
    expect(await fs.exists('/new')).toBe(false)
  })

  it('updates an existing file', async () => {
    const fs = new MemoryFS()
    await fs.write('/k', bytes('content'))
    await execute('touch /k', fs)
    expect(text(await fs.read('/k'))).toBe('content')
  })

  it('throws without arguments', async () => {
    await expect(execute('touch', new MemoryFS())).rejects.toThrow(/missing operand/)
  })
})

describe('cp', () => {
  it('copies a file to a new path', async () => {
    const fs = new MemoryFS()
    await fs.write('/src', bytes('hello'))
    await execute('cp /src /dst', fs)
    expect(text(await fs.read('/dst'))).toBe('hello')
    expect(await fs.exists('/src')).toBe(true)
  })

  it('copies a file into an existing directory', async () => {
    const fs = new MemoryFS()
    await fs.write('/src.txt', bytes('hello'))
    await fs.mkdir('/dir', { parents: true })
    await execute('cp /src.txt /dir', fs)
    expect(text(await fs.read('/dir/src.txt'))).toBe('hello')
  })

  it('refuses to copy a directory without -r', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d', { parents: true })
    await expect(execute('cp /d /e', fs)).rejects.toThrow(/-r not specified/)
  })

  it('-r copies a directory tree', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/src', { parents: true })
    await fs.write('/src/a', bytes('A'))
    await fs.mkdir('/src/sub', { parents: true })
    await fs.write('/src/sub/b', bytes('B'))
    await execute('cp -r /src /dst', fs)
    expect(text(await fs.read('/dst/a'))).toBe('A')
    expect(text(await fs.read('/dst/sub/b'))).toBe('B')
  })

  it('multiple sources require an existing directory destination', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('A'))
    await fs.write('/b', bytes('B'))
    await expect(execute('cp /a /b /nope', fs)).rejects.toThrow(/not a directory/)
  })

  it('refuses to copy a directory into itself', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/src', { parents: true })
    await fs.write('/src/a', bytes('A'))
    await expect(execute('cp -r /src /src/inside', fs)).rejects.toThrow(/into itself/)
  })
})

describe('mv', () => {
  it('renames a file', async () => {
    const fs = new MemoryFS()
    await fs.write('/old', bytes('v'))
    await execute('mv /old /new', fs)
    expect(await fs.exists('/old')).toBe(false)
    expect(text(await fs.read('/new'))).toBe('v')
  })

  it('-n skips when destination exists', async () => {
    const fs = new MemoryFS()
    await fs.write('/old', bytes('a'))
    await fs.write('/new', bytes('b'))
    await execute('mv -n /old /new', fs)
    expect(text(await fs.read('/new'))).toBe('b') // unchanged
    expect(text(await fs.read('/old'))).toBe('a') // not moved
  })

  it('errors on missing source', async () => {
    await expect(execute('mv /nope /dst', new MemoryFS())).rejects.toBeInstanceOf(TerminalError)
  })

  it('errors with no destination', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('v'))
    await expect(execute('mv /a', fs)).rejects.toThrow(/missing operand/)
  })

  it('moves a file INTO an existing directory (single source, dir destination)', async () => {
    // Bug repro: previously `mv /file /dir/` overwrote the path
    // `/dir` instead of placing the file under it, because the
    // handler called `rename(src, dst)` without inspecting whether
    // `dst` was a directory.
    const fs = new MemoryFS()
    await fs.write('/file.txt', bytes('content'))
    await fs.mkdir('/dir', { parents: true })
    await execute('mv /file.txt /dir/', fs)
    expect(await fs.exists('/file.txt')).toBe(false)
    expect(text(await fs.read('/dir/file.txt'))).toBe('content')
  })

  it('moves multiple sources into a directory', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('A'))
    await fs.write('/b', bytes('B'))
    await fs.write('/c', bytes('C'))
    await fs.mkdir('/dst', { parents: true })
    await execute('mv /a /b /c /dst', fs)
    expect(text(await fs.read('/dst/a'))).toBe('A')
    expect(text(await fs.read('/dst/b'))).toBe('B')
    expect(text(await fs.read('/dst/c'))).toBe('C')
    expect(await fs.exists('/a')).toBe(false)
  })

  it('rejects multi-source when destination is not a directory', async () => {
    const fs = new MemoryFS()
    await fs.write('/a', bytes('A'))
    await fs.write('/b', bytes('B'))
    await fs.write('/dst', bytes('existing'))
    await expect(execute('mv /a /b /dst', fs)).rejects.toThrow(/not a directory/)
    // Nothing should have moved.
    expect(text(await fs.read('/a'))).toBe('A')
    expect(text(await fs.read('/b'))).toBe('B')
  })

  it("rejects a trailing-slash target that doesn't exist as a directory", async () => {
    // POSIX-strict: `mv a b/` where `b` is missing (or a file)
    // should fail rather than silently rename to `b`. Protects
    // against the original bug shape.
    const fs = new MemoryFS()
    await fs.write('/a', bytes('A'))
    await expect(execute('mv /a /nope/', fs)).rejects.toThrow(/Not a directory/)
    expect(text(await fs.read('/a'))).toBe('A')

    await fs.write('/file', bytes('F'))
    await expect(execute('mv /a /file/', fs)).rejects.toThrow(/Not a directory/)
  })

  it('refuses to move a directory into itself', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d/sub', { parents: true })
    await expect(execute('mv /d /d/sub', fs)).rejects.toThrow(/subdirectory of itself/)
  })

  it('-f overrides -n (force wins)', async () => {
    // POSIX: when both are given, -f takes precedence.
    const fs = new MemoryFS()
    await fs.write('/src', bytes('new'))
    await fs.write('/dst', bytes('old'))
    await execute('mv -n -f /src /dst', fs)
    expect(text(await fs.read('/dst'))).toBe('new')
    expect(await fs.exists('/src')).toBe(false)
  })
})

describe('rm', () => {
  it('removes a file', async () => {
    const fs = new MemoryFS()
    await fs.write('/k', bytes('v'))
    await execute('rm /k', fs)
    expect(await fs.exists('/k')).toBe(false)
  })

  it('refuses a directory without -r', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d', { parents: true })
    await expect(execute('rm /d', fs)).rejects.toThrow(/Is a directory/)
  })

  it('-r removes a directory tree', async () => {
    const fs = new MemoryFS()
    await fs.mkdir('/d/sub', { parents: true })
    await fs.write('/d/a', bytes('A'))
    await fs.write('/d/sub/b', bytes('B'))
    await execute('rm -r /d', fs)
    expect(await fs.exists('/d')).toBe(false)
  })

  it('-f silently ignores missing files', async () => {
    const fs = new MemoryFS()
    await execute('rm -f /nope', fs) // no throw
  })

  it('without -f errors on missing files', async () => {
    await expect(execute('rm /nope', new MemoryFS())).rejects.toThrow(/No such file/)
  })

  it('refuses to remove root', async () => {
    const fs = new MemoryFS()
    await expect(execute('rm -r /', fs)).rejects.toThrow(/root directory/)
  })
})

describe('basename', () => {
  it('returns the last path component', async () => {
    expect(await execute('basename /a/b/c.txt', new MemoryFS())).toBe('c.txt\n')
  })

  it('strips trailing slash', async () => {
    expect(await execute('basename /a/b/', new MemoryFS())).toBe('b\n')
  })

  it('returns the path itself when there are no slashes', async () => {
    expect(await execute('basename name.txt', new MemoryFS())).toBe('name.txt\n')
  })

  it('strips a trailing suffix when given', async () => {
    expect(await execute('basename /a/b/file.txt .txt', new MemoryFS())).toBe('file\n')
  })

  it('does NOT strip when name == suffix', async () => {
    expect(await execute('basename .txt .txt', new MemoryFS())).toBe('.txt\n')
  })
})

describe('dirname', () => {
  it('returns the parent path', async () => {
    expect(await execute('dirname /a/b/c.txt', new MemoryFS())).toBe('/a/b\n')
  })

  it('returns "." for paths with no slash', async () => {
    expect(await execute('dirname file.txt', new MemoryFS())).toBe('.\n')
  })

  it('returns "/" for top-level paths', async () => {
    expect(await execute('dirname /file', new MemoryFS())).toBe('/\n')
  })

  it('strips trailing slash before computing parent', async () => {
    expect(await execute('dirname /a/b/', new MemoryFS())).toBe('/a\n')
  })
})
