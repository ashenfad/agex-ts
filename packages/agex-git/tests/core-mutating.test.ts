import { Staged, type Versioned, VersionedKV } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { polymorphicDecoder, polymorphicEncoder } from '@agex-ts/termish/fs/kvgit'
import { beforeEach, describe, expect, it } from 'vitest'
import { VirtualGit } from '../src/core'
import {
  AgentGitError,
  BranchExists,
  BranchNotFound,
  BranchNotMerged,
  NothingToCommit,
  PathSpecError,
  PendingChanges,
  UnbornBranch,
} from '../src/errors'
import { Metadata } from '../src/metadata'

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
let vg: VirtualGit

beforeEach(async () => {
  vkv = await VersionedKV.open(new Memory())
  staged = new Staged(vkv, { encoder: polymorphicEncoder, decoder: polymorphicDecoder })
  vg = new VirtualGit(vkv, staged)
})

/** Stage files and commit through VirtualGit (returns the new hash). */
async function commitWith(
  vg: VirtualGit,
  staged: Staged,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    staged.set(fkey(path), fileRec(content))
  }
  return (await vg.commit(message)).hash
}

/** Read decoded content at a key in the live working view. Returns
 *  null when the key isn't present. */
async function getContent(staged: Staged, path: string): Promise<string | null> {
  const rec = await staged.get<FileRecord | undefined>(fkey(path))
  if (rec === undefined || rec === null) return null
  return dec.decode(rec.content)
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe('VirtualGit — add', () => {
  it('rejects empty path list', async () => {
    await expect(vg.add([])).rejects.toThrow(PathSpecError)
    await expect(vg.add([])).rejects.toThrow(/nothing/)
  })

  it('stages a modified existing file', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    staged.set(fkey('a'), fileRec('2'))
    await vg.add(['a'])
    const meta = await Metadata.load(staged)
    expect(meta.index.has(fkey('a'))).toBe(true)
  })

  it('accepts an unchanged file (real git is permissive)', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.add(['a']) // no modification — must not raise
    const meta = await Metadata.load(staged)
    expect(meta.index.has(fkey('a'))).toBe(true)
  })

  it('rejects a nonexistent path', async () => {
    await expect(vg.add(['ghost.py'])).rejects.toThrow(PathSpecError)
    await expect(vg.add(['ghost.py'])).rejects.toThrow(/did not match/)
  })

  it("'.' stages every modified file", async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    staged.set(fkey('a'), fileRec('2'))
    staged.set(fkey('b'), fileRec('new'))
    await vg.add(['.'])
    const meta = await Metadata.load(staged)
    expect([...meta.index].sort()).toEqual([fkey('a'), fkey('b')].sort())
  })

  it("'-A' stages every modified file (alias for '.')", async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    staged.set(fkey('a'), fileRec('2'))
    await vg.add(['-A'])
    expect((await Metadata.load(staged)).index.has(fkey('a'))).toBe(true)
  })

  it('persists across VirtualGit instances (metadata-backed)', async () => {
    // The agex-py refactor that introduced metadata-backed index was
    // motivated by closure-based `_tracked` losing state between
    // terminal_action invocations. This test guards against
    // regression to that pattern.
    const vg1 = new VirtualGit(vkv, staged)
    staged.set(fkey('a'), fileRec('1'))
    await vg1.commit('init')
    staged.set(fkey('a'), fileRec('2'))
    await vg1.add(['a'])

    const vg2 = new VirtualGit(vkv, staged)
    expect((await vg2.status()).staged).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// rm
// ---------------------------------------------------------------------------

describe('VirtualGit — rm', () => {
  it('rejects empty path list', async () => {
    await expect(vg.rm([])).rejects.toThrow(PathSpecError)
    await expect(vg.rm([])).rejects.toThrow(/nothing/)
  })

  it('removes the file from the working tree', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.rm(['a'])
    expect(await staged.has(fkey('a'))).toBe(false)
  })

  it('stages the deletion in the index', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.rm(['a'])
    expect((await Metadata.load(staged)).index.has(fkey('a'))).toBe(true)
  })

  it('rejects a path that never existed', async () => {
    await expect(vg.rm(['nope'])).rejects.toThrow(PathSpecError)
    await expect(vg.rm(['nope'])).rejects.toThrow(/did not match/)
  })

  it('is idempotent for files already removed from the workspace', async () => {
    // Real git: `rm foo && git rm foo` succeeds — file gone but
    // tracked at HEAD, deletion just gets re-staged.
    await commitWith(vg, staged, { a: '1' }, 'init')
    staged.delete(fkey('a'))
    await vg.rm(['a']) // must not raise
    expect((await Metadata.load(staged)).index.has(fkey('a'))).toBe(true)
  })

  it('rejects a path that is neither in working tree nor at HEAD', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await expect(vg.rm(['never-existed'])).rejects.toThrow(PathSpecError)
  })

  it('recursive removes everything under a directory prefix', async () => {
    await commitWith(vg, staged, { 'foo/a': '1', 'foo/b': '2', 'bar/c': '3' }, 'init')
    await vg.rm(['foo'], { recursive: true })
    expect(await staged.has(fkey('foo/a'))).toBe(false)
    expect(await staged.has(fkey('foo/b'))).toBe(false)
    // Sibling directory untouched
    expect(await staged.has(fkey('bar/c'))).toBe(true)
  })

  it('recursive errors when no files match the prefix', async () => {
    await commitWith(vg, staged, { 'foo/a': '1' }, 'init')
    await expect(vg.rm(['nope'], { recursive: true })).rejects.toThrow(PathSpecError)
  })
})

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

describe('VirtualGit — commit', () => {
  it('records the message', async () => {
    staged.set(fkey('a'), fileRec('1'))
    const c = await vg.commit('hello')
    expect(c.message).toBe('hello')
  })

  it('advances the branch ref and creates the main branch', async () => {
    staged.set(fkey('a'), fileRec('1'))
    const c = await vg.commit('init')
    expect(await vg.head()).toBe(c.hash)
    expect(await vg.listBranches()).toEqual(['main'])
  })

  it('records virtualBranch and virtualParents', async () => {
    staged.set(fkey('a'), fileRec('1'))
    const a = await vg.commit('first')
    staged.set(fkey('a'), fileRec('2'))
    const b = await vg.commit('second')

    expect(a.virtualBranch).toBe('main')
    expect(a.virtualParents).toEqual([])
    expect(b.virtualBranch).toBe('main')
    expect(b.virtualParents).toEqual([a.hash])
  })

  it('raises NothingToCommit when working tree matches HEAD', async () => {
    staged.set(fkey('a'), fileRec('1'))
    await vg.commit('first')
    await expect(vg.commit('nothing')).rejects.toThrow(NothingToCommit)
  })

  it('clears the index after commit', async () => {
    staged.set(fkey('a'), fileRec('1'))
    staged.set(fkey('b'), fileRec('1'))
    await vg.add(['a'])
    await vg.commit('partial')
    expect((await Metadata.load(staged)).index.size).toBe(0)
  })

  it('selective commit when index is non-empty', async () => {
    staged.set(fkey('a'), fileRec('1'))
    staged.set(fkey('b'), fileRec('1'))
    await vg.add(['a'])
    const c = await vg.commit('just a')
    expect(c.files).toEqual(['a'])
    // b should still show as unstaged
    expect((await vg.status()).unstaged).toEqual(['b'])
  })

  it('full commit when index is empty (every modified file flushed)', async () => {
    staged.set(fkey('a'), fileRec('1'))
    staged.set(fkey('b'), fileRec('1'))
    const c = await vg.commit('both')
    expect([...(c.files ?? [])].sort()).toEqual(['a', 'b'])
  })

  it('survives an intervening framework auto-commit between virtual commits', async () => {
    // Mirrors what the agent loop does between turns: a system commit
    // (no message) flushes pending Staged writes. The next git commit
    // must still produce a virtual commit that captures those changes
    // even though the buffer is empty.
    staged.set(fkey('a'), fileRec('v1'))
    await vg.commit('init')

    staged.set(fkey('a'), fileRec('v2'))
    await staged.commit({}) // framework system commit
    expect(staged.hasChanges).toBe(false)

    const c = await vg.commit('real commit')
    expect(c.message).toBe('real commit')
    expect(c.files).toEqual(['a'])

    // And the new branch tip should reflect the v2 content.
    expect(dec.decode(await vg.show(c.hash, 'a'))).toBe('v2')
  })

  it('records a deletion as a commit', async () => {
    staged.set(fkey('a'), fileRec('1'))
    staged.set(fkey('b'), fileRec('1'))
    await vg.commit('init')
    await vg.rm(['a'])
    const c = await vg.commit('remove a')
    const snap = await staged.checkout(c.hash)
    expect(snap).not.toBeNull()
    expect(await snap?.has(fkey('a'))).toBe(false)
  })

  it('raises NothingToCommit when index points only at unchanged paths', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.add(['a']) // unchanged, but added
    await expect(vg.commit('nothing real')).rejects.toThrow(NothingToCommit)
  })
})

// ---------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------

describe('VirtualGit — reset', () => {
  it('rejects --soft (only --hard supported)', async () => {
    await expect(vg.reset('anything', { hard: false })).rejects.toThrow(AgentGitError)
    await expect(vg.reset('anything', { hard: false })).rejects.toThrow(/hard/)
  })

  it('restores file content to the target commit', async () => {
    const a = await commitWith(vg, staged, { f: 'v1' }, 'v1')
    await commitWith(vg, staged, { f: 'v2' }, 'v2')
    await vg.reset(a)
    expect(await getContent(staged, 'f')).toBe('v1')
  })

  it('rewinds the branch ref to target', async () => {
    const a = await commitWith(vg, staged, { f: 'v1' }, 'v1')
    await commitWith(vg, staged, { f: 'v2' }, 'v2')
    await vg.reset(a)
    expect(await vg.head()).toBe(a)
  })

  it('clears the index', async () => {
    const a = await commitWith(vg, staged, { f: 'v1' }, 'v1')
    staged.set(fkey('f'), fileRec('v2'))
    await vg.add(['f'])
    await vg.reset(a)
    expect((await Metadata.load(staged)).index.size).toBe(0)
  })

  it('does NOT rewind kvgit physical chain — only virtual ref moves', async () => {
    // The whole point of virtual reset: agent's branch ref rewinds,
    // but every pre-reset kvgit commit remains in physical history
    // (so any non-VFS state captured in those commits is still
    // recoverable).
    const a = await commitWith(vg, staged, { f: 'v1' }, 'v1')
    const b = await commitWith(vg, staged, { f: 'v2' }, 'v2')
    const historyBefore: string[] = []
    for await (const h of vkv.history()) historyBefore.push(h)

    await vg.reset(a)

    expect(await vg.head()).toBe(a)
    const historyAfter: string[] = []
    for await (const h of vkv.history()) historyAfter.push(h)
    // Every pre-reset commit is still reachable in kvgit history.
    for (const h of historyBefore) expect(historyAfter).toContain(h)
    expect(historyAfter).toContain(b)
  })
})

// ---------------------------------------------------------------------------
// Isolation: non-VFS keys survive virtual operations
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// createBranch / deleteBranch
// ---------------------------------------------------------------------------

describe('VirtualGit — createBranch', () => {
  it('creates a branch pointing at the current branch tip', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    const meta = await Metadata.load(staged)
    expect(meta.branches.has('feature')).toBe(true)
    expect(meta.branches.get('feature')).toBe(meta.branches.get('main'))
  })

  it('does not switch to the created branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    expect(await vg.currentBranch()).toBe('main')
  })

  it('rejects a duplicate name', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await expect(vg.createBranch('feature')).rejects.toThrow(BranchExists)
  })

  it('rejects creation from an unborn branch', async () => {
    await expect(vg.createBranch('feature')).rejects.toThrow(UnbornBranch)
  })

  it('rejects an empty name', async () => {
    await expect(vg.createBranch('')).rejects.toThrow(AgentGitError)
  })
})

describe('VirtualGit — deleteBranch', () => {
  it('deletes an existing branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('temp')
    await vg.deleteBranch('temp')
    expect(await vg.listBranches()).not.toContain('temp')
  })

  it('rejects a missing branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await expect(vg.deleteBranch('ghost')).rejects.toThrow(BranchNotFound)
  })

  it('rejects deleting the current branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await expect(vg.deleteBranch('main')).rejects.toThrow(/currently checked out/)
  })

  it('rejects deleting an unmerged branch (safety)', async () => {
    // Branch advances independently of main; safe-delete must refuse.
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await vg.checkout('feature')
    await commitWith(vg, staged, { b: 'new' }, 'feature work')
    await vg.checkout('main')
    await expect(vg.deleteBranch('feature')).rejects.toThrow(BranchNotMerged)
  })

  it('force-deletes an unmerged branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await vg.checkout('feature')
    await commitWith(vg, staged, { b: 'new' }, 'feature work')
    await vg.checkout('main')
    await vg.deleteBranch('feature', { force: true })
    expect(await vg.listBranches()).not.toContain('feature')
  })
})

// ---------------------------------------------------------------------------
// checkout
// ---------------------------------------------------------------------------

describe('VirtualGit — checkout', () => {
  it('switches to an existing branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await vg.checkout('feature')
    expect(await vg.currentBranch()).toBe('feature')
  })

  it('is a no-op when checking out the current branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.checkout('main')
    expect(await vg.currentBranch()).toBe('main')
  })

  it('-b creates and switches', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.checkout('feature', { create: true })
    expect(await vg.currentBranch()).toBe('feature')
    expect(await vg.listBranches()).toContain('feature')
  })

  it('-b on an existing branch raises', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await expect(vg.checkout('feature', { create: true })).rejects.toThrow(BranchExists)
  })

  it('rejects switching to a missing branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await expect(vg.checkout('ghost')).rejects.toThrow(BranchNotFound)
  })

  it('rejects switching with pending changes', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    staged.set(fkey('a'), fileRec('modified'))
    await expect(vg.checkout('feature')).rejects.toThrow(PendingChanges)
  })

  it('--force discards pending changes and switches', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    staged.set(fkey('a'), fileRec('modified'))
    await vg.checkout('feature', { force: true })
    expect(await getContent(staged, 'a')).toBe('1')
  })

  it('rewrites the working view to match the target branch', async () => {
    await commitWith(vg, staged, { a: 'main_a' }, 'init')
    await vg.createBranch('feature')
    await vg.checkout('feature')
    await commitWith(vg, staged, { a: 'feat_a', b: 'feat_b' }, 'feat work')

    await vg.checkout('main')
    expect(await getContent(staged, 'a')).toBe('main_a')
    expect(await staged.has(fkey('b'))).toBe(false)
  })

  it('clears the index on switch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    staged.set(fkey('a'), fileRec('2'))
    await vg.add(['a'])
    await vg.checkout('feature', { force: true })
    expect((await Metadata.load(staged)).index.size).toBe(0)
  })

  it('still catches pending changes after a framework auto-commit drained the buffer', async () => {
    // Pending = content differs from branch tip, regardless of buffer
    // state. A framework auto-commit between turns drains Staged but
    // doesn't change the modified-vs-tip relationship.
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')

    staged.set(fkey('a'), fileRec('2'))
    await staged.commit({}) // framework system commit
    expect(staged.hasChanges).toBe(false)

    await expect(vg.checkout('feature')).rejects.toThrow(PendingChanges)
  })
})

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

describe('VirtualGit — merge', () => {
  it('rejects merging a branch into itself', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await expect(vg.merge('main')).rejects.toThrow(/itself/)
  })

  it('rejects merging a missing branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await expect(vg.merge('ghost')).rejects.toThrow(BranchNotFound)
  })

  it('returns null when already up to date', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('same')
    expect(await vg.merge('same')).toBeNull()
  })

  it('fast-forwards when current is in source ancestry', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await vg.checkout('feature')
    await commitWith(vg, staged, { b: '2' }, 'feat work')
    const featTip = await vg.head()
    await vg.checkout('main')

    const result = await vg.merge('feature')
    expect(result).not.toBeNull()
    expect(result?.hash).toBe(featTip)
    expect(await vg.head()).toBe(featTip)
    expect(await getContent(staged, 'b')).toBe('2')
  })

  it('creates a merge commit on diverged branches', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await vg.checkout('feature')
    await commitWith(vg, staged, { b: 'feat' }, 'feat work')
    const featTip = (await vg.head()) as string
    await vg.checkout('main')
    await commitWith(vg, staged, { a: 'main_v2' }, 'main work')
    const mainTip = (await vg.head()) as string

    const result = await vg.merge('feature')
    expect(result).not.toBeNull()
    expect(result?.hash).not.toBe(featTip)
    expect(result?.hash).not.toBe(mainTip)
    expect(new Set(result?.virtualParents)).toEqual(new Set([mainTip, featTip]))
    // Both branches' files visible in the working view
    expect(await getContent(staged, 'a')).toBe('main_v2')
    expect(await getContent(staged, 'b')).toBe('feat')
  })

  it('preserves main-only changes (3-way diff against base, not against current)', async () => {
    // Regression: a naive merge that diffed (current, source) and
    // overwrote current's independent edits with source's old value
    // would corrupt main's `a`. Proper diff(base, source) leaves it
    // alone.
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await vg.checkout('feature')
    await commitWith(vg, staged, { b: 'feat' }, 'feat work') // feature touches b only
    await vg.checkout('main')
    await commitWith(vg, staged, { a: 'main_v2' }, 'main work') // main touches a only

    await vg.merge('feature')
    expect(await getContent(staged, 'a')).toBe('main_v2')
    expect(await getContent(staged, 'b')).toBe('feat')
  })

  it('source wins on a 3-way conflict', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await vg.checkout('feature')
    await commitWith(vg, staged, { a: 'from_feat' }, 'feat work')
    await vg.checkout('main')
    await commitWith(vg, staged, { a: 'from_main' }, 'main work')
    await vg.merge('feature')
    expect(await getContent(staged, 'a')).toBe('from_feat')
  })

  it('rejects a merge with pending changes', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await vg.checkout('feature')
    await commitWith(vg, staged, { b: 'feat' }, 'feat work')
    await vg.checkout('main')
    staged.set(fkey('a'), fileRec('dirty'))
    await expect(vg.merge('feature')).rejects.toThrow(PendingChanges)
  })
})

describe('VirtualGit — isolation', () => {
  // Stand-in for the framework's event log / REPL state. Non-`f:`-prefixed
  // keys must survive every virtual operation untouched, mirroring how
  // the unified substrate keeps file content and agent state in the
  // same kvgit store.
  function seedSubstrate(s: Staged): void {
    s.set('__event_log__/0', 'event-A')
    s.set('__event_log__/1', 'event-B')
    s.set('repl/x', 'some-namespace-value')
  }

  it('reset preserves non-VFS substrate keys', async () => {
    const a = await commitWith(vg, staged, { f: '1' }, 'init')
    await commitWith(vg, staged, { f: '2' }, 'v2')

    seedSubstrate(staged)
    await vg.reset(a)

    expect(await staged.get('__event_log__/0')).toBe('event-A')
    expect(await staged.get('__event_log__/1')).toBe('event-B')
    expect(await staged.get('repl/x')).toBe('some-namespace-value')
  })

  it('commit only flushes f:-prefixed keys, leaving substrate alone', async () => {
    seedSubstrate(staged)
    staged.set(fkey('a'), fileRec('1'))
    const c = await vg.commit('init')
    // Substrate keys still present in the live view
    expect(await staged.get('repl/x')).toBe('some-namespace-value')
    // Files annotation only includes the `f:` file
    expect(c.files).toEqual(['a'])
  })

  it('checkout preserves substrate state across branches', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    seedSubstrate(staged)
    await vg.checkout('feature')
    expect(await staged.get('__event_log__/0')).toBe('event-A')
    expect(await staged.get('repl/x')).toBe('some-namespace-value')
  })

  it('checkout does not move kvgit current branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    const branchBefore = vkv.currentBranch
    await vg.checkout('feature')
    expect(vkv.currentBranch).toBe(branchBefore)
  })

  it('createBranch does not create a kvgit branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    const before = await vkv.listBranches()
    await vg.createBranch('experiment')
    expect(await vkv.listBranches()).toEqual(before)
    // …but the virtual branch shows up
    expect(await vg.listBranches()).toContain('experiment')
  })

  it('deleteBranch does not delete a kvgit branch', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('temp')
    const before = await vkv.listBranches()
    await vg.deleteBranch('temp')
    expect(await vkv.listBranches()).toEqual(before)
  })

  it('merge preserves substrate state', async () => {
    await commitWith(vg, staged, { a: '1' }, 'init')
    await vg.createBranch('feature')
    await vg.checkout('feature')
    await commitWith(vg, staged, { b: 'feat' }, 'feat work')
    await vg.checkout('main')
    seedSubstrate(staged)
    await vg.merge('feature')
    expect(await staged.get('__event_log__/0')).toBe('event-A')
    expect(await staged.get('repl/x')).toBe('some-namespace-value')
  })

  it('reset does not move kvgit current branch', async () => {
    const a = await commitWith(vg, staged, { f: '1' }, 'init')
    await commitWith(vg, staged, { f: '2' }, 'v2')
    const branchBefore = vkv.currentBranch
    await vg.reset(a)
    expect(vkv.currentBranch).toBe(branchBefore)
  })
})
