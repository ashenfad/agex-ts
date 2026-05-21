import { Staged, type Versioned, VersionedKV } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { type CommandHandler, TerminalError, execute } from '@agex-ts/termish'
import { KvgitFS, polymorphicDecoder, polymorphicEncoder } from '@agex-ts/termish/fs/kvgit'
import { beforeEach, describe, expect, it } from 'vitest'
import { makeGitHandler } from '../src/cli'

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

interface FileRecord {
  isDir: boolean
  createdAt: string
  modifiedAt: string
  content: Uint8Array
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function fileRec(content: string): FileRecord {
  const now = new Date().toISOString()
  return { isDir: false, createdAt: now, modifiedAt: now, content: enc.encode(content) }
}

function fkey(path: string): string {
  return path.startsWith('/') ? `f:${path}` : `f:/${path}`
}

let vkv: Versioned
let staged: Staged
let fs: KvgitFS

beforeEach(async () => {
  vkv = await VersionedKV.open(new Memory())
  staged = new Staged(vkv, { encoder: polymorphicEncoder, decoder: polymorphicDecoder })
  fs = new KvgitFS(staged)
})

/** Run a git CLI string against the test fixtures and return stdout. */
async function git(script: string): Promise<string> {
  // The agex-ts handler shape is structurally compatible with
  // @agex-ts/termish's CommandHandler — both packages cast through unknown
  // at the dispatcher seam, so the same cast holds in tests.
  const handler = makeGitHandler as unknown as CommandHandler
  return execute(script, fs, { commands: new Map([['git', handler]]) })
}

/** Make a commit through the CLI. */
async function commit(files: Record<string, string>, message: string): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    staged.set(fkey(path), fileRec(content))
  }
  await git(`git commit -m '${message}'`)
}

/** Read decoded content at a path in the live working view. */
async function readContent(path: string): Promise<string | null> {
  const rec = await staged.get<FileRecord | undefined>(fkey(path))
  if (rec === undefined || rec === null) return null
  return dec.decode(rec.content)
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

describe('git CLI — top level', () => {
  it('no args prints usage', async () => {
    const out = await git('git')
    expect(out).toContain('usage: git <command>')
    expect(out).toContain('commit')
    expect(out).toContain('log')
  })

  it("rejects an unknown subcommand with a 'not a git command' error", async () => {
    await expect(git('git nope')).rejects.toThrow(TerminalError)
    await expect(git('git nope')).rejects.toThrow(/not a git command/)
  })

  it('errors clearly when ctx.fs is not a KvgitFS', async () => {
    const { MemoryFS } = await import('@agex-ts/termish/fs/memory')
    const memFs = new MemoryFS()
    const handler = makeGitHandler as unknown as CommandHandler
    await expect(
      execute('git status', memFs, { commands: new Map([['git', handler]]) }),
    ).rejects.toThrow(/kvgit-backed VFS/)
  })
})

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('git CLI — status', () => {
  it('shows the branch and clean state on a fresh store', async () => {
    const out = await git('git status')
    expect(out).toContain('On branch main')
    expect(out).toContain('nothing to commit, working tree clean')
  })

  it('lists unstaged changes', async () => {
    await commit({ a: '1' }, 'init')
    staged.set(fkey('a'), fileRec('2'))
    const out = await git('git status')
    expect(out).toContain('Changes not staged for commit:')
    expect(out).toContain('a')
  })

  it('lists staged changes separately', async () => {
    await commit({ a: '1' }, 'init')
    staged.set(fkey('a'), fileRec('2'))
    await git('git add a')
    const out = await git('git status')
    expect(out).toContain('Changes to be committed:')
    expect(out).toContain('a')
    expect(out).not.toContain('Changes not staged for commit:')
  })

  it('lists recent commits at the bottom', async () => {
    await commit({ a: '1' }, 'first')
    await commit({ a: '2' }, 'second')
    const out = await git('git status')
    expect(out).toContain('Recent commits:')
    expect(out).toContain('second')
    expect(out).toContain('first')
  })
})

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

describe('git CLI — commit', () => {
  it("requires -m 'message'", async () => {
    staged.set(fkey('a'), fileRec('1'))
    await expect(git('git commit')).rejects.toThrow(/please supply a message/)
  })

  it("formats output as '[branch shorthash] message'", async () => {
    staged.set(fkey('a'), fileRec('1'))
    const out = await git("git commit -m 'init'")
    expect(out).toMatch(/^\[main [a-f0-9]{7}\] init\n$/)
  })

  it('supports -mMSG (no space)', async () => {
    staged.set(fkey('a'), fileRec('1'))
    const out = await git("git commit -m'compact'")
    expect(out).toContain('compact')
  })

  it('errors on a clean working tree', async () => {
    staged.set(fkey('a'), fileRec('1'))
    await git("git commit -m 'init'")
    await expect(git("git commit -m 'nothing'")).rejects.toThrow(/nothing to commit/)
  })
})

// ---------------------------------------------------------------------------
// log
// ---------------------------------------------------------------------------

describe('git CLI — log', () => {
  it('shows full log entries by default', async () => {
    await commit({ a: '1' }, 'first')
    await commit({ a: '2' }, 'second')
    const out = await git('git log')
    expect(out).toContain('first')
    expect(out).toContain('second')
    expect(out).toMatch(/commit [a-f0-9]{40}/)
  })

  it('--oneline emits short-hash lines', async () => {
    await commit({ a: '1' }, 'first')
    await commit({ a: '2' }, 'second')
    const out = await git('git log --oneline')
    const lines = out.trim().split('\n')
    expect(lines.length).toBe(2)
    for (const l of lines) expect(l).toMatch(/^[a-f0-9]{7}/)
    expect(lines[0]).toContain('second') // newest first
    expect(lines[0]).toContain('(HEAD -> main)')
    expect(lines[1]).toContain('first')
  })

  it('-n caps the output count', async () => {
    await commit({ a: '1' }, 'first')
    await commit({ a: '2' }, 'second')
    await commit({ a: '3' }, 'third')
    const out = await git('git log --oneline -n 2')
    expect(out.trim().split('\n').length).toBe(2)
  })

  it('-nN (no space) is accepted', async () => {
    await commit({ a: '1' }, 'first')
    await commit({ a: '2' }, 'second')
    const out = await git('git log --oneline -n1')
    expect(out.trim().split('\n').length).toBe(1)
  })

  it('positional path filters', async () => {
    await commit({ a: '1' }, 'touched a')
    await commit({ b: '2' }, 'touched b')
    const out = await git('git log --oneline a')
    expect(out).toContain('touched a')
    expect(out).not.toContain('touched b')
  })
})

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

describe('git CLI — diff', () => {
  it('default diffs HEAD vs working tree', async () => {
    await commit({ f: 'old\n' }, 'v1')
    staged.set(fkey('f'), fileRec('new\n'))
    const out = await git('git diff')
    expect(out).toContain('-old')
    expect(out).toContain('+new')
  })

  it('one-arg diffs ref vs working tree', async () => {
    await commit({ f: 'old\n' }, 'v1')
    staged.set(fkey('f'), fileRec('new\n'))
    const out = await git('git diff HEAD')
    expect(out).toContain('-old')
    expect(out).toContain('+new')
  })

  it('two-arg diffs ref vs ref', async () => {
    await commit({ f: 'old\n' }, 'v1')
    await commit({ f: 'new\n' }, 'v2')
    const out = await git('git diff HEAD~1 HEAD')
    expect(out).toContain('-old')
    expect(out).toContain('+new')
  })

  it("'--' separates refs from path filter", async () => {
    await commit({ a: '1\n', b: '1\n' }, 'v1')
    await commit({ a: '2\n', b: '2\n' }, 'v2')
    const out = await git('git diff HEAD~1 HEAD -- a')
    expect(out).toContain('a/a')
    expect(out).not.toContain('b/b')
  })

  it('rejects more than two refs', async () => {
    await commit({ a: '1' }, 'v1')
    await expect(git('git diff HEAD HEAD~0 HEAD')).rejects.toThrow(/too many arguments/)
  })
})

// ---------------------------------------------------------------------------
// branch / checkout
// ---------------------------------------------------------------------------

describe('git CLI — branch / checkout', () => {
  it("'git branch' lists branches with current marker", async () => {
    await commit({ a: '1' }, 'init')
    await git('git branch feature')
    const out = await git('git branch')
    expect(out).toContain('* main')
    expect(out).toContain('  feature')
  })

  it('creates a branch', async () => {
    await commit({ a: '1' }, 'init')
    const out = await git('git branch feature')
    expect(out).toContain('Created branch feature')
  })

  it('-d deletes a branch', async () => {
    await commit({ a: '1' }, 'init')
    await git('git branch temp')
    const out = await git('git branch -d temp')
    expect(out).toContain('Deleted branch temp')
  })

  it('-d refuses unmerged branches', async () => {
    await commit({ a: '1' }, 'init')
    await git('git checkout -b feature')
    await commit({ b: '1' }, 'feat work')
    await git('git checkout main')
    await expect(git('git branch -d feature')).rejects.toThrow(/not fully merged/)
  })

  it('-D force-deletes unmerged branches', async () => {
    await commit({ a: '1' }, 'init')
    await git('git checkout -b feature')
    await commit({ b: '1' }, 'feat work')
    await git('git checkout main')
    await git('git branch -D feature')
    expect(await git('git branch')).not.toContain('feature')
  })

  it("'checkout -b' creates and switches", async () => {
    await commit({ a: '1' }, 'init')
    const out = await git('git checkout -b feature')
    expect(out).toContain("Switched to a new branch 'feature'")
  })

  it("'checkout' switches to an existing branch", async () => {
    await commit({ a: '1' }, 'init')
    await git('git branch feature')
    const out = await git('git checkout feature')
    expect(out).toContain("Switched to branch 'feature'")
  })

  it('checkout refuses on pending changes', async () => {
    await commit({ a: '1' }, 'init')
    await git('git branch feature')
    staged.set(fkey('a'), fileRec('dirty'))
    await expect(git('git checkout feature')).rejects.toThrow(/local changes/)
  })

  it('-f discards pending and switches', async () => {
    await commit({ a: '1' }, 'init')
    await git('git branch feature')
    staged.set(fkey('a'), fileRec('dirty'))
    await git('git checkout -f feature')
    expect(await readContent('a')).toBe('1')
  })
})

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe('git CLI — reset', () => {
  it('rewinds the branch ref and restores files', async () => {
    await commit({ f: 'v1' }, 'first')
    await commit({ f: 'v2' }, 'second')
    const out = await git('git reset --hard HEAD~1')
    expect(out).toMatch(/^Restored files to [a-f0-9]{7}\n$/)
    expect(await readContent('f')).toBe('v1')
  })

  it('rejects without --hard', async () => {
    await commit({ f: 'v1' }, 'first')
    await expect(git('git reset HEAD~1')).rejects.toThrow(/only --hard/)
  })

  it('rejects without a ref', async () => {
    await expect(git('git reset --hard')).rejects.toThrow(/need a ref/)
  })
})

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

describe('git CLI — show', () => {
  it('returns content at a commit via ref:path', async () => {
    await commit({ f: 'hello\n' }, 'init')
    const out = await git('git show HEAD:f')
    expect(out).toBe('hello\n')
  })

  it('default ref is HEAD when the colon prefix is empty', async () => {
    await commit({ f: 'hello\n' }, 'init')
    const out = await git('git show :f')
    expect(out).toBe('hello\n')
  })

  it('requires the <ref>:<path> format', async () => {
    await commit({ f: '1' }, 'init')
    await expect(git('git show HEAD')).rejects.toThrow(/<ref>:<path>/)
  })

  it('errors when the path is missing at the commit', async () => {
    await commit({ f: '1' }, 'init')
    await expect(git('git show HEAD:nope')).rejects.toThrow(/not found/)
  })

  it('renders a binary-file summary instead of dumping bytes', async () => {
    staged.set(fkey('blob'), {
      isDir: false,
      createdAt: '',
      modifiedAt: '',
      content: new Uint8Array([0x00, 0x01, 0x02, 0x03]),
    })
    await git("git commit -m 'init'")
    const out = await git('git show HEAD:blob')
    expect(out).toMatch(/^\(binary file: blob, 4 bytes\)\n$/)
  })
})

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

describe('git CLI — merge', () => {
  it('emits "Already up to date." when source is the same', async () => {
    await commit({ a: '1' }, 'init')
    await git('git branch feature')
    const out = await git('git merge feature')
    expect(out).toBe('Already up to date.\n')
  })

  it('fast-forwards', async () => {
    await commit({ a: '1' }, 'init')
    await git('git checkout -b feature')
    await commit({ b: '2' }, 'feat work')
    await git('git checkout main')
    const out = await git('git merge feature')
    expect(out).toMatch(/^Merge made: [a-f0-9]{7}/)
    expect(await readContent('b')).toBe('2')
  })

  it('creates a true merge commit on diverged branches', async () => {
    await commit({ a: '1' }, 'init')
    await git('git checkout -b feature')
    await commit({ b: 'feat' }, 'feat work')
    await git('git checkout main')
    await commit({ a: 'main_v2' }, 'main work')
    const out = await git('git merge feature')
    expect(out).toContain('Merge made:')
    expect(out).toContain("Merge branch 'feature'")
    expect(await readContent('a')).toBe('main_v2')
    expect(await readContent('b')).toBe('feat')
  })

  it('errors without a branch arg', async () => {
    await expect(git('git merge')).rejects.toThrow(/branch name required/)
  })
})

// ---------------------------------------------------------------------------
// add / rm
// ---------------------------------------------------------------------------

describe('git CLI — add', () => {
  it('errors with no args', async () => {
    await expect(git('git add')).rejects.toThrow(/nothing specified/)
  })

  it('stages a path', async () => {
    await commit({ a: '1' }, 'init')
    staged.set(fkey('a'), fileRec('2'))
    await git('git add a')
    const status = await git('git status')
    expect(status).toContain('Changes to be committed:')
    expect(status).toContain('a')
  })

  it("'.' stages everything modified", async () => {
    await commit({ a: '1' }, 'init')
    staged.set(fkey('a'), fileRec('2'))
    staged.set(fkey('b'), fileRec('new'))
    await git('git add .')
    const status = await git('git status')
    expect(status).toContain('a')
    expect(status).toContain('b')
  })
})

describe('git CLI — rm', () => {
  it('errors with no args', async () => {
    await expect(git('git rm')).rejects.toThrow(/nothing specified/)
  })

  it("removes the file and emits 'rm' lines", async () => {
    await commit({ a: '1' }, 'init')
    const out = await git('git rm a')
    expect(out).toBe("rm 'a'\n")
    expect(await staged.has(fkey('a'))).toBe(false)
  })

  it('-r removes recursively', async () => {
    await commit({ 'foo/a': '1', 'foo/b': '2', 'bar/c': '3' }, 'init')
    await git('git rm -r foo')
    expect(await staged.has(fkey('foo/a'))).toBe(false)
    expect(await staged.has(fkey('foo/b'))).toBe(false)
    expect(await staged.has(fkey('bar/c'))).toBe(true)
  })
})
