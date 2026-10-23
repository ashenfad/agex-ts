/**
 * The agent's git over a session (`ws.index`): the index, agent
 * commits, the graph. What these pin, beyond the verbs, is the two
 * properties the fiction exists for: a framework commit never disturbs
 * what the agent is composing, and an agent commit's tree holds exactly
 * what the agent committed, not the work in progress it left out.
 */

import { Worktree } from '@agex-ts/kvgit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseBlob } from '../src/agentgit'
import {
  CHECKOUT_TOOL,
  FILE_PREFIX,
  GIT_KEY,
  MERGE_RECORD_TOOL,
  RESTORE_TOOL,
  ReadOnlyError,
  Store,
  type Workspace,
  wsGit,
} from '../src/index'
import { newKV } from './backends'

const enc = new TextEncoder()
const dec = new TextDecoder()

async function open(store?: Store, opts: { autocommit?: boolean } = {}): Promise<Workspace> {
  return (store ?? (await Store.open(await newKV()))).open('s', opts)
}

/** Write a file without committing it (as code in the kernel does). */
const put = (ws: Workspace, path: string, text: string) => ws.files.fs.write(path, enc.encode(text))

/** The files of one commit, by path. */
async function at(ws: Workspace, commit: string): Promise<Record<string, string>> {
  const snapshot = await ws.store.repo.snapshot({ commit })
  const keys = (await snapshot.keys()).filter((k) => k.startsWith(FILE_PREFIX))
  const values = await snapshot.getMany(keys)
  return Object.fromEntries(
    keys.map((k) => [k.slice(FILE_PREFIX.length), dec.decode(values.get(k) as Uint8Array)]),
  )
}

const messages = async (ws: Workspace) => (await ws.index.log()).map((c) => c.info?.message ?? null)
const tools = (commits: { info: Record<string, unknown> | null }[]) =>
  commits.map((c) => c.info?.tool)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the index', () => {
  it('splits staged from unstaged, and commits nothing', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.txt', 'one')
    await put(ws, '/workspace/b.txt', 'two')
    expect(await ws.index.stage(['/workspace/a.txt'])).toEqual(['/workspace/a.txt'])
    const st = await ws.index.status()
    expect(st).toMatchObject({
      branch: 's',
      staged: ['/workspace/a.txt'],
      unstaged: ['/workspace/b.txt'],
      mergeSource: null,
      mergeUnresolved: [],
    })
    expect(await ws.index.head()).toBeNull()
    await ws.close()
  })

  it('reports only what a second stage added, and takes paths from the root', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.txt', 'one')
    await put(ws, '/workspace/b.txt', 'two')
    expect(await ws.index.stage(['a.txt'])).toEqual(['/workspace/a.txt'])
    expect(await ws.index.stage(['/workspace/b.txt'])).toEqual(['/workspace/b.txt'])
    expect(await ws.index.stage(['/workspace/a.txt'])).toEqual([])
    await ws.close()
  })

  it('refuses unknown paths and directories', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.txt', 'one')
    await ws.commit()
    await expect(ws.index.stage(['/workspace/nope.txt'])).rejects.toThrow('unknown path')
    await ws.terminal('mkdir sub')
    await expect(ws.index.stage(['/workspace/sub'])).rejects.toThrow('not directories')
    expect(await ws.index.unstage(['/workspace/a.txt'])).toEqual([])
    await expect(ws.index.unstage(['/workspace/nope.txt'])).rejects.toThrow('unknown path')
    await ws.close()
  })

  it('unstage and discard leave the files alone', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.txt', 'one')
    await put(ws, '/workspace/b.txt', 'two')
    await ws.index.stage(['/workspace/a.txt', '/workspace/b.txt'])
    expect(await ws.index.unstage(['/workspace/a.txt'])).toEqual(['/workspace/a.txt'])
    expect((await ws.index.status()).staged).toEqual(['/workspace/b.txt'])
    await ws.index.discard()
    expect(await ws.index.status()).toMatchObject({
      staged: [],
      unstaged: ['/workspace/a.txt', '/workspace/b.txt'],
    })
    expect(await ws.files.readText('a.txt')).toBe('one')
    await ws.close()
  })

  it("isn't changed by the framework's commits", async () => {
    const ws = await open()
    await put(ws, '/workspace/a.txt', 'one')
    await put(ws, '/workspace/b.txt', 'two')
    await ws.index.stage(['/workspace/a.txt'])
    const before = await ws.index.status()
    for (let i = 0; i < 3; i++) {
      await ws.commit({ tool: 'turn' })
      expect(await ws.index.status()).toEqual(before)
    }
    expect(ws.uncommitted).toBe(false)
    expect(before).toMatchObject({ staged: ['/workspace/a.txt'], unstaged: ['/workspace/b.txt'] })
    await ws.close()
  })

  it('is untouched by ws.commit, which takes everything', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.txt', 'one')
    await put(ws, '/workspace/b.txt', 'two')
    await ws.index.stage(['/workspace/a.txt'])
    const head = await ws.commit()
    expect(ws.uncommitted).toBe(false)
    expect(Object.keys(await at(ws, head))).toEqual(
      expect.arrayContaining(['/workspace/a.txt', '/workspace/b.txt']),
    )
    expect(await ws.index.status()).toMatchObject({
      staged: ['/workspace/a.txt'],
      unstaged: ['/workspace/b.txt'],
    })
    await ws.close()
  })

  it("isn't inherited by a fork", async () => {
    const ws = await open()
    await put(ws, '/workspace/a.txt', 'one')
    await ws.index.commit('base')
    await put(ws, '/workspace/a.txt', 'one-main')
    await ws.index.stage(['/workspace/a.txt'])
    const fork = await ws.fork('worker')
    expect((await fork.index.status()).staged).toEqual([])
    expect(await fork.index.head()).toBeNull()
    expect(await fork.index.base()).not.toBeNull()
    expect((await ws.index.status()).staged).toEqual(['/workspace/a.txt'])
    await ws.index.commit('main')
    expect((await ws.index.status()).staged).toEqual([])
    await fork.close()
    await ws.close()
  })
})

describe('an agent commit', () => {
  it('holds exactly the committed paths, keeping the rest in progress', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.py', 'A = 1\n')
    await put(ws, '/workspace/b.py', 'B = 1\n')
    const base = await ws.index.commit('base')
    await ws.index.stage(['/workspace/a.py'])
    await put(ws, '/workspace/a.py', 'A = 2\n')
    await put(ws, '/workspace/b.py', 'B = 2\n')
    await ws.commit({ tool: 'turn' })

    const commit = await ws.index.commit('just a')
    expect(await ws.index.status()).toMatchObject({ staged: [], unstaged: ['/workspace/b.py'] })
    const tree = await at(ws, commit)
    expect(tree['/workspace/a.py']).toBe('A = 2\n')
    expect(tree['/workspace/b.py']).toBe('B = 1\n')
    expect((await at(ws, base))['/workspace/b.py']).toBe('B = 1\n')
    expect(await ws.files.readText('b.py')).toBe('B = 2\n')
    expect((await at(ws, ws.head))['/workspace/b.py']).toBe('B = 2\n')
    expect(await messages(ws)).toEqual(['just a', 'base'])
    expect(await ws.index.head()).toBe(commit)
    await ws.close()
  })

  it('takes everything modified when nothing is staged', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.txt', 'one')
    await put(ws, '/workspace/b.txt', 'two')
    const commit = await ws.index.commit('all of it')
    expect(Object.keys(await at(ws, commit)).sort()).toEqual([
      '/workspace/a.txt',
      '/workspace/b.txt',
    ])
    expect((await ws.index.status()).unstaged).toEqual([])
    await ws.close()
  })

  it('is refused with nothing to commit, or a staged set that matches', async () => {
    const ws = await open()
    await expect(ws.index.commit()).rejects.toThrow('nothing to commit')
    await ws.terminal('echo one > a.txt')
    await ws.index.commit('one')
    await ws.terminal('echo two > b.txt')
    await ws.index.stage(['/workspace/a.txt'])
    await expect(ws.index.commit()).rejects.toThrow('staged paths match')
    await ws.close()
  })

  it('commits a staged deletion', async () => {
    const ws = await open()
    await ws.terminal('echo one > a.txt')
    await ws.terminal('echo two > b.txt')
    await ws.index.commit('both')
    await ws.files.fs.remove('/workspace/a.txt')
    await ws.index.stage(['/workspace/a.txt'])
    expect((await ws.index.status()).staged).toEqual(['/workspace/a.txt'])
    const commit = await ws.index.commit('drop a')
    expect(Object.keys(await at(ws, commit))).toEqual(['/workspace/b.txt'])
    expect((await ws.index.status()).unstaged).toEqual([])
    await ws.close()
  })

  it("takes each file's record with its content, and only the committed one's", async () => {
    const ws = await open()
    await put(ws, '/workspace/a.txt', 'one')
    await put(ws, '/workspace/b.txt', 'two!')
    await ws.index.stage(['/workspace/a.txt'])
    const commit = await ws.index.commit('a only')
    const snapshot = await ws.store.repo.snapshot({ commit })
    expect(await snapshot.get('__meta__/workspace/a.txt')).toMatchObject({ size: 3 })
    expect(await snapshot.get('__meta__/workspace/b.txt')).toBeUndefined()
    expect((await ws.files.fs.stat('/workspace/b.txt')).size).toBe(4)
    await ws.close()
  })

  it('takes a new directory along with the file in it', async () => {
    const ws = await open()
    await ws.files.fs.mkdir('/workspace/src')
    await put(ws, '/workspace/src/a.ts', 'x')
    const commit = await ws.index.commit('a')
    const frozen = await ws.store.resolve(`s@${commit}`)
    expect(await frozen.files.fs.isDir('/workspace/src')).toBe(true)
    await ws.close()
  })

  it('commits itself, and its bookkeeping, without autocommit', async () => {
    const store = await Store.open(await newKV())
    const ws = await open(store, { autocommit: false })
    await put(ws, '/workspace/a.py', 'A = 1\n')
    await put(ws, '/workspace/b.py', 'B = 1\n')
    await ws.index.stage(['/workspace/a.py'])
    const commit = await ws.index.commit('just a')
    expect(ws.uncommitted).toBe(false)
    await ws.close()
    const again = await open(store, { autocommit: false })
    expect(await again.index.head()).toBe(commit)
    expect(await messages(again)).toEqual(['just a'])
    expect(await again.files.readText('b.py')).toBe('B = 1\n')
    expect((await again.index.status()).unstaged).toEqual(['/workspace/b.py'])
    expect(await at(again, commit)).not.toHaveProperty('/workspace/b.py')
    await again.close()
  })

  it('leaves the files and the index as they were when it fails', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.py', 'A = 1\n')
    await put(ws, '/workspace/b.py', 'B = 1\n')
    await ws.index.commit('base')
    await put(ws, '/workspace/a.py', 'A = 2\n')
    await put(ws, '/workspace/b.py', 'B = 2\n')
    await put(ws, '/workspace/c.py', 'C = 1\n')
    await ws.index.stage(['/workspace/a.py'])
    const status = await ws.index.status()
    const head = await ws.index.head()
    vi.spyOn(Worktree.prototype, 'commit').mockRejectedValueOnce(new Error('commit failed (CAS)'))
    await expect(ws.index.commit('doomed')).rejects.toThrow('CAS')
    vi.restoreAllMocks()
    expect(await ws.index.status()).toEqual(status)
    expect(await ws.index.head()).toBe(head)
    expect(await ws.files.readText('a.py')).toBe('A = 2\n')
    expect(await ws.files.readText('b.py')).toBe('B = 2\n')
    expect((await ws.files.fs.stat('/workspace/b.py')).size).toBe(6)
    const commit = await ws.index.commit('second try')
    expect(await at(ws, commit)).toMatchObject({
      '/workspace/a.py': 'A = 2\n',
      '/workspace/b.py': 'B = 1\n',
    })
    await ws.close()
  })

  it('lands its bookkeeping beside a concurrent writer', async () => {
    const store = await Store.open(await newKV())
    const ws = await open(store)
    const other = await open(store)
    await put(ws, '/workspace/a.py', 'A = 1\n')
    await put(ws, '/workspace/b.py', 'B = 1\n')
    await ws.index.stage(['/workspace/a.py'])
    const real = Worktree.prototype.commit
    let raced = false
    vi.spyOn(Worktree.prototype, 'commit').mockImplementation(async function (
      this: Worktree<unknown>,
      opts,
    ) {
      const out = await real.call(this, opts)
      if (!raced && this !== undefined) {
        raced = true
        await other.refresh()
        await put(other, '/workspace/elsewhere.txt', 'theirs\n')
        await other.commit({ tool: 'turn' })
      }
      return out
    })
    const commit = await ws.index.commit('just a')
    vi.restoreAllMocks()
    expect(await ws.index.head()).toBe(commit)
    expect(await ws.files.readText('b.py')).toBe('B = 1\n')
    await ws.close()
    await other.close()
    const again = await open(store)
    expect(await again.index.head()).toBe(commit)
    expect(await again.files.readText('b.py')).toBe('B = 1\n')
    expect(await again.files.readText('elsewhere.txt')).toBe('theirs\n')
    await again.close()
  })

  it("can't be forged by the host's commit", async () => {
    const ws = await open()
    await put(ws, '/workspace/a.txt', 'a\n')
    for (const tool of ['ws-git', 'ws-git.merge', 'ws-git.restore', 'ws-git.anything']) {
      await expect(ws.commit({ tool })).rejects.toThrow('is reserved')
    }
    expect(ws.uncommitted).toBe(true)
    await ws.commit({ tool: 'ws-gitish' })
    expect(await ws.index.log()).toEqual([])
    await ws.close()
  })
})

describe('the log', () => {
  it("is the agent's own graph, starting afresh in a fork", async () => {
    const ws = await open()
    await ws.terminal('echo one > a.txt')
    const first = await ws.index.commit('first')
    await ws.terminal('echo two > b.txt')
    const second = await ws.index.commit('second')
    expect((await ws.index.log()).map((c) => c.hash)).toEqual([second, first])
    expect((await ws.log({ kind: 'all' })).length).toBeGreaterThan(3)
    expect((await ws.index.log({ limit: 1 })).map((c) => c.hash)).toEqual([second])
    const fork = await ws.fork('worker')
    expect(await fork.index.log()).toEqual([])
    await fork.terminal('echo three > c.txt')
    const third = await fork.index.commit('third')
    expect(await messages(fork)).toEqual(['third'])
    expect(await fork.index.head()).toBe(third)
    await fork.close()
    await ws.close()
  })

  it("hides the agent's git's bookkeeping from ws.log by default", async () => {
    const ws = await open()
    await put(ws, '/workspace/a.py', 'A = 1\n')
    await put(ws, '/workspace/b.py', 'B = 1\n')
    await ws.index.stage(['/workspace/a.py'])
    const commit = await ws.index.commit('just a')
    const all = await ws.log({ kind: 'all' })
    expect(all[0]?.info).toEqual({ tool: RESTORE_TOOL, restoreOf: commit })
    expect(tools(await ws.log())).toEqual(['ws-git', 'init'])
    expect(tools(await ws.log({ kind: 'agent' }))).toEqual(['ws-git'])
    expect((await ws.log({ kind: 'all', limit: 2 })).length).toBe(2)
    expect(await ws.log({ limit: 0 })).toEqual([])
    await expect(ws.log({ kind: 'plumbing' as 'all' })).rejects.toThrow('unknown log kind')
    for (const tool of [RESTORE_TOOL, CHECKOUT_TOOL, MERGE_RECORD_TOOL]) {
      expect(tool.startsWith('ws-git.')).toBe(true)
    }
    await ws.close()
  })
})

describe('checkout', () => {
  it('puts the files back and appends, clearing the index', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.py', 'A = 1\n')
    await put(ws, '/workspace/b.py', 'B = 1\n')
    const first = await ws.index.commit('first')
    await put(ws, '/workspace/b.py', 'B = 2\n')
    await put(ws, '/workspace/c.py', 'C = 1\n')
    await ws.index.commit('second')
    const before = (await ws.log({ kind: 'all' })).length
    expect(await ws.index.checkout(first)).toBe(first)
    expect(await ws.files.readText('b.py')).toBe('B = 1\n')
    expect(await ws.files.exists('c.py')).toBe(false)
    expect(await ws.index.head()).toBe(first)
    expect(await ws.index.status()).toMatchObject({ staged: [], unstaged: [] })
    expect((await ws.log({ kind: 'all' })).length).toBe(before + 1)
    expect(ws.head).not.toBe(first)
    await ws.close()
  })

  it('refuses a commit a merge brought in, or one from before its fork', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.py', 'A = 1\n')
    const parents = await ws.index.commit('parent work')
    const fork = await ws.fork('worker')
    await put(fork, '/workspace/b.py', 'B = 1\n')
    const theirs = await fork.index.commit('worker work')
    await expect(fork.index.checkout(parents)).rejects.toThrow('no commit')
    await put(ws, '/workspace/c.py', 'C = 1\n')
    await ws.index.commit('more')
    await ws.merge('worker')
    await expect(ws.index.checkout(theirs)).rejects.toThrow('no commit')
    await expect(ws.index.resolve(theirs.slice(0, 7))).rejects.toThrow('no commit')
    await fork.close()
    await ws.close()
  })

  it("takes a short id or a tag, and refuses a commit that isn't the agent's", async () => {
    const ws = await open()
    await put(ws, '/workspace/a.py', 'A = 1\n')
    const first = await ws.index.commit('first')
    await ws.terminal('echo framework > f.txt')
    const framework = ws.head
    await expect(ws.index.checkout(framework)).rejects.toThrow('not one of yours')
    await expect(ws.index.checkout('worker')).rejects.toThrow('sessions are branches')
    await ws.index.tags.add('v1')
    await put(ws, '/workspace/a.py', 'A = 2\n')
    await ws.index.commit('second')
    expect(await ws.index.checkout('v1')).toBe(first)
    expect(await ws.index.checkout(first.slice(0, 7))).toBe(first)
    await ws.close()
  })

  it('turns a directory back into a file, and a file into a directory', async () => {
    const ws = await open()
    await put(ws, '/workspace/x', 'a file\n')
    const asFile = await ws.index.commit('x is a file')
    await ws.files.fs.remove('/workspace/x')
    await ws.files.fs.mkdir('/workspace/x')
    await put(ws, '/workspace/x/child', 'inside\n')
    const asDir = await ws.index.commit('x is a directory')
    await ws.index.checkout(asFile)
    expect(await ws.files.readText('x')).toBe('a file\n')
    expect(await ws.files.fs.isFile('/workspace/x')).toBe(true)
    await ws.index.checkout(asDir)
    expect(await ws.files.readText('x/child')).toBe('inside\n')
    expect(await ws.index.status()).toMatchObject({ staged: [], unstaged: [] })
    await ws.close()
  })

  it('leaves the directories its target has, and drops those it emptied', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.py', 'A = 1\n')
    const first = await ws.index.commit('first')
    await ws.files.fs.mkdir('/workspace/src/deep', { parents: true })
    await put(ws, '/workspace/src/deep/b.py', 'B = 1\n')
    await ws.index.commit('second')
    await ws.index.checkout(first)
    expect(await ws.files.fs.exists('/workspace/src')).toBe(false)
    expect(await ws.files.fs.isDir('/workspace')).toBe(true)
    await ws.close()
  })

  it('leaves everything as it was when it fails', async () => {
    const ws = await open()
    await put(ws, '/workspace/a.py', 'A = 1\n')
    const first = await ws.index.commit('first')
    await put(ws, '/workspace/a.py', 'A = 2\n')
    await put(ws, '/workspace/b.py', 'B = 1\n')
    await ws.index.commit('second')
    const status = await ws.index.status()
    const head = await ws.index.head()
    vi.spyOn(Worktree.prototype, 'commit').mockRejectedValue(new Error('commit failed (CAS)'))
    await expect(ws.index.checkout(first)).rejects.toThrow('CAS')
    vi.restoreAllMocks()
    expect(await ws.index.head()).toBe(head)
    expect(await ws.index.status()).toEqual(status)
    expect(await ws.files.readText('a.py')).toBe('A = 2\n')
    expect(await ws.files.readText('b.py')).toBe('B = 1\n')
    await ws.close()
  })

  it("on the host rewinds the agent's git with the files", async () => {
    const ws = await open()
    await put(ws, '/workspace/a.py', 'A = 1\n')
    const first = await ws.index.commit('first')
    const atFirst = ws.head
    await put(ws, '/workspace/b.py', 'B = 1\n')
    const second = await ws.index.commit('second')
    const landed = await ws.checkout(atFirst)
    expect(await ws.index.head()).toBe(first)
    expect(await messages(ws)).toEqual(['first'])
    expect(await ws.index.status()).toMatchObject({ staged: [], unstaged: [] })
    expect(await ws.files.exists('b.py')).toBe(false)
    const all = new Set((await ws.log({ kind: 'all' })).map((c) => c.hash))
    for (const c of [first, second, atFirst, landed]) expect(all.has(c)).toBe(true)
    await ws.close()
  })
})

describe('tags of the index', () => {
  it("bookmark the agent's commits, are its own, and aren't inherited", async () => {
    const ws = await open()
    await put(ws, '/workspace/a.py', 'A = 1\n')
    const first = await ws.index.commit('first')
    expect(await ws.index.tags.add('v1')).toBe(first)
    await expect(ws.index.tags.add('v1')).rejects.toThrow('already exists')
    await put(ws, '/workspace/a.py', 'A = 2\n')
    const second = await ws.index.commit('second')
    expect(await ws.index.tags.add('v1', { force: true })).toBe(second)
    expect(await ws.index.tags.add('old', { at: first.slice(0, 7) })).toBe(first)
    expect(await ws.index.tags.list()).toEqual({ old: first, v1: second })
    expect(await ws.index.resolve('old')).toBe(first)
    await expect(ws.index.tags.add('abcdef0')).rejects.toThrow('commit id')
    await expect(ws.index.tags.add('a..b')).rejects.toThrow('not a tag name')
    const fork = await ws.fork('worker')
    expect(await fork.index.tags.list()).toEqual({})
    expect(await ws.index.tags.delete('old')).toBe(first)
    await expect(ws.index.tags.delete('old')).rejects.toThrow('not found')
    expect(await ws.index.tags.get('v1')).toBe(second)
    await fork.close()
    await ws.close()
  })
})

describe('a frozen view', () => {
  it('reads the index and refuses to change it', async () => {
    const ws = await open()
    await ws.terminal('echo one > a.txt')
    await ws.index.commit('one')
    await ws.tags.add('v1')
    const snap = await ws.tags.at('v1')
    await expect(snap.index.stage(['/workspace/a.txt'])).rejects.toThrow(ReadOnlyError)
    await expect(snap.index.commit()).rejects.toThrow(ReadOnlyError)
    await expect(snap.index.discard()).rejects.toThrow(ReadOnlyError)
    expect((await snap.index.status()).unstaged).toEqual([])
    expect(await snap.index.head()).toBe(await ws.index.head())
    await ws.close()
  })

  it('refuses ws-git stage even when there is nothing to stage', async () => {
    const store = await Store.open(await newKV())
    const ws = await store.open('s', { profile: { commands: { 'ws-git': wsGit } } })
    await ws.terminal('mkdir src && echo one > src/a.txt')
    await ws.index.commit('one')
    await ws.tags.add('v1')
    const snap = await ws.tags.at('v1')
    for (const args of ['-A', 'src']) {
      const out = await snap.terminal(`ws-git stage ${args}`)
      expect(out.exitCode).toBe(1)
      expect(out.stderr).toMatch(/frozen view/)
    }
    await ws.close()
  })

  it('reads a blob of another layout as a fresh state', () => {
    const fresh = parseBlob(null)
    expect(parseBlob({ version: 99, head: 'abc', staged: ['/a'] })).toEqual(fresh)
    expect(parseBlob('not a blob')).toEqual(fresh)
    expect(
      parseBlob({ version: 1, head: 'abc', staged: ['/b', 7, '/a'], tags: { v: 'c', w: 3 } }),
    ).toMatchObject({ head: 'abc', staged: ['/a', '/b'], tags: { v: 'c' } })
    expect(GIT_KEY).toBe('__ws_git__')
  })
})
