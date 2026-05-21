import { Staged, type Versioned, VersionedKV } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { polymorphicDecoder, polymorphicEncoder } from '@agex-ts/termish/fs/kvgit'
import { beforeEach, describe, expect, it } from 'vitest'
import { FileNotFoundError, VirtualGit } from '../src/core'
import { Metadata } from '../src/metadata'
import { InvalidRef } from '../src/refs'

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

/** Translate logical user paths to `f:`-prefixed kvgit keys, matching
 *  what `KvgitFS` would write. Tests pass logical paths (`'a'`,
 *  `'foo'`); the helper encodes. */
function fkey(path: string): string {
  return path.startsWith('/') ? `f:${path}` : `f:/${path}`
}

async function commitAgent(
  staged: Staged,
  files: Record<string, string>,
  message: string,
  opts: { branch?: string; parents?: ReadonlyArray<string> } = {},
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    staged.set(fkey(path), fileRec(content))
  }
  const result = await staged.commit({
    info: {
      message,
      virtualBranch: opts.branch ?? 'main',
      virtualParents: [...(opts.parents ?? [])],
    },
  })
  return result.commit as string
}

async function systemCommit(staged: Staged, key: string, value: string): Promise<string> {
  staged.set(key, value)
  return (await staged.commit({})).commit as string
}

async function setMeta(
  staged: Staged,
  fields: { current?: string; branches?: Record<string, string>; index?: ReadonlyArray<string> },
): Promise<void> {
  const m = new Metadata({
    ...(fields.current !== undefined && { current: fields.current }),
    ...(fields.branches !== undefined && { branches: fields.branches }),
    ...(fields.index !== undefined && { index: fields.index.map(fkey) }),
  })
  m.save(staged)
  await staged.commit({})
}

let vkv: Versioned
let staged: Staged
let vg: VirtualGit

beforeEach(async () => {
  vkv = await VersionedKV.open(new Memory())
  staged = new Staged(vkv, { encoder: polymorphicEncoder, decoder: polymorphicDecoder })
  vg = new VirtualGit(vkv, staged)
})

// ---------------------------------------------------------------------------
// Branch state
// ---------------------------------------------------------------------------

describe('VirtualGit — branch state', () => {
  it('default current branch is main', async () => {
    expect(await vg.currentBranch()).toBe('main')
  })

  it('no branches listed for unborn store', async () => {
    expect(await vg.listBranches()).toEqual([])
  })

  it('listBranches returns alphabetical', async () => {
    await setMeta(staged, { branches: { zeta: 'abc', alpha: 'def' } })
    expect(await vg.listBranches()).toEqual(['alpha', 'zeta'])
  })

  it('head is null when unborn', async () => {
    expect(await vg.head()).toBeNull()
  })

  it('head returns the current branch tip', async () => {
    const h = await commitAgent(staged, { a: '1' }, 'init')
    await setMeta(staged, { branches: { main: h } })
    expect(await vg.head()).toBe(h)
  })
})

// ---------------------------------------------------------------------------
// resolveRef delegation
// ---------------------------------------------------------------------------

describe('VirtualGit — resolveRef', () => {
  it('HEAD resolves through the current metadata', async () => {
    const h = await commitAgent(staged, { a: '1' }, 'init')
    await setMeta(staged, { branches: { main: h } })
    expect(await vg.resolveRef('HEAD')).toBe(h)
  })

  it('invalid ref raises InvalidRef', async () => {
    await expect(vg.resolveRef('nope')).rejects.toThrow(InvalidRef)
  })
})

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe('VirtualGit — status', () => {
  it('is clean on an unborn branch with no working-tree files', async () => {
    const s = await vg.status()
    expect(s.branch).toBe('main')
    expect(s.staged).toEqual([])
    expect(s.unstaged).toEqual([])
    expect(s.isClean).toBe(true)
  })

  it('shows unstaged additions on an unborn branch', async () => {
    staged.set(fkey('a'), fileRec('1'))
    const s = await vg.status()
    expect(s.unstaged).toEqual(['a'])
    expect(s.staged).toEqual([])
    expect(s.isClean).toBe(false)
  })

  it('is clean immediately after a commit', async () => {
    const h = await commitAgent(staged, { a: '1' }, 'init')
    await setMeta(staged, { branches: { main: h } })
    expect((await vg.status()).isClean).toBe(true)
  })

  it('shows an unstaged modification', async () => {
    const h = await commitAgent(staged, { a: '1' }, 'init')
    await setMeta(staged, { branches: { main: h } })
    staged.set(fkey('a'), fileRec('2'))
    const s = await vg.status()
    expect(s.unstaged).toEqual(['a'])
    expect(s.staged).toEqual([])
  })

  it('shows a staged modification', async () => {
    const h = await commitAgent(staged, { a: '1' }, 'init')
    await setMeta(staged, { branches: { main: h }, index: ['a'] })
    staged.set(fkey('a'), fileRec('2'))
    const s = await vg.status()
    expect(s.staged).toEqual(['a'])
    expect(s.unstaged).toEqual([])
  })

  it('splits between staged and unstaged', async () => {
    const h = await commitAgent(staged, { a: '1', b: '1' }, 'init')
    await setMeta(staged, { branches: { main: h }, index: ['a'] })
    staged.set(fkey('a'), fileRec('2'))
    staged.set(fkey('b'), fileRec('2'))
    const s = await vg.status()
    expect(s.staged).toEqual(['a'])
    expect(s.unstaged).toEqual(['b'])
  })

  it('shows a deleted file as modified', async () => {
    const h = await commitAgent(staged, { a: '1' }, 'init')
    await setMeta(staged, { branches: { main: h } })
    staged.delete(fkey('a'))
    const s = await vg.status()
    expect(s.unstaged).toEqual(['a'])
  })

  it('metadata blob is not flagged as a modified file', async () => {
    const h = await commitAgent(staged, { a: '1' }, 'init')
    await setMeta(staged, { branches: { main: h } })
    expect((await vg.status()).isClean).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

describe('VirtualGit — log', () => {
  it('returns [] for an unborn branch', async () => {
    expect(await vg.log()).toEqual([])
  })

  it('returns a single commit', async () => {
    const h = await commitAgent(staged, { a: '1' }, 'init')
    await setMeta(staged, { branches: { main: h } })
    const log = await vg.log()
    expect(log.length).toBe(1)
    expect(log[0]?.hash).toBe(h)
    expect(log[0]?.message).toBe('init')
    expect(log[0]?.virtualBranch).toBe('main')
    expect(log[0]?.virtualParents).toEqual([])
  })

  it('linear chain walks virtual ancestry newest-first', async () => {
    const a = await commitAgent(staged, { a: '1' }, 'first')
    const b = await commitAgent(staged, { a: '2' }, 'second', { parents: [a] })
    const c = await commitAgent(staged, { a: '3' }, 'third', { parents: [b] })
    await setMeta(staged, { branches: { main: c } })
    const log = await vg.log()
    expect(log.map((e) => e.message)).toEqual(['third', 'second', 'first'])
    expect(log.map((e) => e.hash)).toEqual([c, b, a])
  })

  it('skips system commits', async () => {
    const a = await commitAgent(staged, { a: '1' }, 'first')
    await systemCommit(staged, '_sys', 'x')
    const c = await commitAgent(staged, { a: '2' }, 'second', { parents: [a] })
    await setMeta(staged, { branches: { main: c } })
    expect((await vg.log()).map((e) => e.message)).toEqual(['second', 'first'])
  })

  it('respects maxCount', async () => {
    const a = await commitAgent(staged, { a: '1' }, 'first')
    const b = await commitAgent(staged, { a: '2' }, 'second', { parents: [a] })
    const c = await commitAgent(staged, { a: '3' }, 'third', { parents: [b] })
    await setMeta(staged, { branches: { main: c } })
    expect((await vg.log({ maxCount: 2 })).map((e) => e.message)).toEqual(['third', 'second'])
  })

  it('path filter includes the root commit when it introduced the file', async () => {
    const a = await commitAgent(staged, { a: '1' }, 'touched a')
    const b = await commitAgent(staged, { b: '2' }, 'touched b', { parents: [a] })
    await setMeta(staged, { branches: { main: b } })
    const log = await vg.log({ path: 'a' })
    expect(log.map((e) => e.message)).toEqual(['touched a'])
  })

  it("path filter excludes the root commit when it didn't introduce the file", async () => {
    const a = await commitAgent(staged, { a: '1' }, 'first')
    const b = await commitAgent(staged, { b: '2' }, 'added b', { parents: [a] })
    await setMeta(staged, { branches: { main: b } })
    const log = await vg.log({ path: 'b' })
    expect(log.map((e) => e.message)).toEqual(['added b'])
  })

  it('surfaces the files annotation when present', async () => {
    staged.set(fkey('a'), fileRec('1'))
    const result = await staged.commit({
      info: {
        message: 'selective',
        files: ['a'],
        virtualBranch: 'main',
        virtualParents: [],
      },
    })
    const h = result.commit as string
    await setMeta(staged, { branches: { main: h } })
    const log = await vg.log()
    expect(log[0]?.files).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// Show
// ---------------------------------------------------------------------------

describe('VirtualGit — show', () => {
  it('returns content at a commit', async () => {
    const h = await commitAgent(staged, { a: 'hello' }, 'init')
    await setMeta(staged, { branches: { main: h } })
    expect(dec.decode(await vg.show(h, 'a'))).toBe('hello')
  })

  it('returns historical content (not just the tip)', async () => {
    const a = await commitAgent(staged, { f: 'old' }, 'v1')
    const b = await commitAgent(staged, { f: 'new' }, 'v2', { parents: [a] })
    await setMeta(staged, { branches: { main: b } })
    expect(dec.decode(await vg.show(a, 'f'))).toBe('old')
    expect(dec.decode(await vg.show(b, 'f'))).toBe('new')
  })

  it('throws FileNotFoundError when the path is missing at the commit', async () => {
    const h = await commitAgent(staged, { a: '1' }, 'init')
    await setMeta(staged, { branches: { main: h } })
    await expect(vg.show(h, 'nope')).rejects.toThrow(FileNotFoundError)
    await expect(vg.show(h, 'nope')).rejects.toThrow(/not found/)
  })

  it('throws InvalidRef for an unknown commit hash', async () => {
    await expect(vg.show('0'.repeat(40), 'any')).rejects.toThrow(InvalidRef)
  })
})

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

describe('VirtualGit — diff', () => {
  it('diffs two commits', async () => {
    const a = await commitAgent(staged, { f: 'hello\n' }, 'v1')
    const b = await commitAgent(staged, { f: 'world\n' }, 'v2', { parents: [a] })
    await setMeta(staged, { branches: { main: b } })
    const out = await vg.diff({ a, b })
    expect(out).toContain('-hello')
    expect(out).toContain('+world')
    expect(out).toContain('a/f')
    expect(out).toContain('b/f')
  })

  it('default (no args) diffs HEAD vs working tree', async () => {
    const h = await commitAgent(staged, { f: 'old\n' }, 'v1')
    await setMeta(staged, { branches: { main: h } })
    staged.set(fkey('f'), fileRec('new\n'))
    const out = await vg.diff()
    expect(out).toContain('-old')
    expect(out).toContain('+new')
  })

  it('returns empty string when working tree matches HEAD', async () => {
    const h = await commitAgent(staged, { f: 'x' }, 'v1')
    await setMeta(staged, { branches: { main: h } })
    expect(await vg.diff()).toBe('')
  })

  it('returns empty string on an unborn branch', async () => {
    expect(await vg.diff()).toBe('')
  })

  it('shows added files', async () => {
    const a = await commitAgent(staged, { a: '1' }, 'v1')
    const b = await commitAgent(staged, { a: '1', b: 'new\n' }, 'v2', { parents: [a] })
    await setMeta(staged, { branches: { main: b } })
    const out = await vg.diff({ a, b })
    expect(out).toContain('b/b')
    expect(out).toContain('+new')
  })

  it('respects path filter', async () => {
    const a = await commitAgent(staged, { a: '1\n', b: '1\n' }, 'v1')
    const b = await commitAgent(staged, { a: '2\n', b: '2\n' }, 'v2', { parents: [a] })
    await setMeta(staged, { branches: { main: b } })
    const out = await vg.diff({ a, b, path: 'a' })
    expect(out).toContain('a/a')
    expect(out).not.toContain('b/b')
  })

  it('renders a binary-file summary when either side is binary', async () => {
    const a = await commitAgent(staged, { f: '\x00\x01\x02\x03' }, 'v1')
    const b = await commitAgent(staged, { f: '\x00\x05\x06\x07' }, 'v2', { parents: [a] })
    await setMeta(staged, { branches: { main: b } })
    const out = await vg.diff({ a, b })
    expect(out).toContain('Binary files')
  })

  it('does not crash on invalid UTF-8 (latin-1 bytes pass through replace)', async () => {
    // 'café' as latin-1: 0x63 0x61 0x66 0xe9. The 0xe9 isn't valid
    // UTF-8 but our TextDecoder uses fatal: false so it passes
    // through as a replacement char.
    staged.set(fkey('f'), {
      isDir: false,
      createdAt: '',
      modifiedAt: '',
      content: new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]),
    })
    const a = (
      await staged.commit({
        info: { message: 'v1', virtualBranch: 'main', virtualParents: [] },
      })
    ).commit as string
    staged.set(fkey('f'), {
      isDir: false,
      createdAt: '',
      modifiedAt: '',
      content: new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x21, 0x0a]),
    })
    const b = (
      await staged.commit({
        info: { message: 'v2', virtualBranch: 'main', virtualParents: [a] },
      })
    ).commit as string
    await setMeta(staged, { branches: { main: b } })
    const out = await vg.diff({ a, b })
    expect(out).toContain('caf')
    expect(out).toContain('+')
  })

  it('one-arg form (a, null) diffs ref vs working tree', async () => {
    const a = await commitAgent(staged, { f: 'old\n' }, 'v1')
    await setMeta(staged, { branches: { main: a } })
    staged.set(fkey('f'), fileRec('new\n'))
    const out = await vg.diff({ a, b: null })
    expect(out).toContain('-old')
    expect(out).toContain('+new')
  })
})

// ---------------------------------------------------------------------------
// Result type sanity
// ---------------------------------------------------------------------------

describe('result type fields', () => {
  it('AgentCommit.shortHash is the first 7 chars of the hash', async () => {
    const h = await commitAgent(staged, { a: '1' }, 'init')
    await setMeta(staged, { branches: { main: h } })
    const log = await vg.log()
    expect(log[0]?.shortHash).toBe(h.slice(0, 7))
    expect(log[0]?.shortHash.length).toBe(7)
  })

  it('Status.isClean tracks staged + unstaged emptiness', async () => {
    expect((await vg.status()).isClean).toBe(true)
    staged.set(fkey('a'), fileRec('1'))
    expect((await vg.status()).isClean).toBe(false)
  })
})
