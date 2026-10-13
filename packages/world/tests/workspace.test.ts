import { TagExistsError, UnknownTagError } from '@agex-ts/kvgit'
import { FsError } from '@agex-ts/termish'
import { describe, expect, it } from 'vitest'
import {
  CONVERSATION_PREFIX,
  CommitConflictError,
  InvalidNameError,
  ReadOnlyError,
  SessionExistsError,
  Store,
  UnknownRefError,
  UnknownSessionError,
  type Workspace,
  WorldError,
} from '../src/index'
import { BACKENDS, enc, newStore, text } from './backends'

const tools = async (ws: Workspace): Promise<unknown[]> =>
  (await ws.log()).map((c) => c.info?.tool).reverse()

describe.each(BACKENDS)('on %s', (_, make) => {
  let store: Store
  const open = async (session = 's', opts = {}) => {
    store = await newStore(make)
    return store.open(session, opts)
  }

  describe('opening a session', () => {
    it('starts a new session at its root, committed as init', async () => {
      const ws = await open()
      expect(ws.files.fs.getcwd()).toBe('/workspace')
      expect(await ws.files.fs.isDir('/workspace')).toBe(true)
      expect(await tools(ws)).toEqual(['init'])
      expect(ws.uncommitted).toBe(false)
      expect(await store.sessions()).toEqual(['s'])
    })

    it('reopens where it was, without a new commit', async () => {
      const ws = await open()
      await ws.files.fs.mkdir('/workspace/sub')
      await ws.files.fs.chdir('sub')
      await ws.commit({ tool: 'terminal' })
      const again = await store.open('s')
      expect(again.files.fs.getcwd()).toBe('/workspace/sub')
      expect(await tools(again)).toEqual(['init', 'terminal'])
    })

    it('reopens at / when that is where it was', async () => {
      const ws = await open()
      await ws.files.fs.chdir('/')
      await ws.commit({ tool: 'terminal' })
      expect((await store.open('s')).files.fs.getcwd()).toBe('/')
    })

    it('with root /, reopening commits nothing', async () => {
      const ws = await open('s', { root: '/' })
      expect(ws.files.fs.getcwd()).toBe('/')
      const again = await store.open('s', { root: '/' })
      expect(again.uncommitted).toBe(false)
      expect(await tools(again)).toEqual(['init'])
    })

    it('stores the working directory moved by renaming a directory it is in', async () => {
      const ws = await open()
      await ws.files.fs.mkdir('/workspace/old/deep', { parents: true })
      await ws.files.fs.chdir('/workspace/old/deep')
      await ws.files.fs.rename('/workspace/old', '/workspace/new')
      expect(ws.files.fs.getcwd()).toBe('/workspace/new/deep')
      await ws.commit({ tool: 'terminal' })
      expect((await store.open('s')).files.fs.getcwd()).toBe('/workspace/new/deep')
    })

    it('takes a root, and refuses a bad session id or root', async () => {
      const ws = await open('s', { root: '/home//me/' })
      expect(ws.root).toBe('/home/me')
      expect(ws.files.fs.getcwd()).toBe('/home/me')
      await expect(store.open('.hidden')).rejects.toThrow(InvalidNameError)
      await expect(store.open('a/b')).rejects.toThrow(InvalidNameError)
      await expect(store.open('t', { root: 'rel' })).rejects.toThrow(InvalidNameError)
      await expect(store.open('t', { root: '/a/../b' })).rejects.toThrow(InvalidNameError)
    })
  })

  describe('files', () => {
    it('write commits each call, creating directories', async () => {
      const ws = await open()
      const first = await ws.files.write('a/b/c.txt', 'one')
      expect(first).toMatchObject({ path: 'a/b/c.txt', size: 3, created: true })
      expect(first.commit).toBe(ws.head)
      const second = await ws.files.write('/workspace/a/b/c.txt', enc.encode('two!'))
      expect(second).toMatchObject({ size: 4, created: false })
      expect(await ws.files.readText('a/b/c.txt')).toBe('two!')
      expect(await ws.files.list('a', { recursive: true })).toEqual(['b', 'b/c.txt'])
      expect(await tools(ws)).toEqual(['init', 'file_write', 'file_write'])
    })

    it('reads a range of a file', async () => {
      const ws = await open()
      await ws.files.write('f', 'hello world')
      expect(text(await ws.files.read('f', { offset: 6 }))).toBe('world')
      expect(text(await ws.files.read('f', { offset: 0, size: 5 }))).toBe('hello')
    })

    it('remove commits, and refuses a directory or nothing', async () => {
      const ws = await open()
      await ws.files.write('d/f', 'xy')
      expect(await ws.files.remove('d/f')).toMatchObject({ path: 'd/f', size: 2 })
      expect(await ws.files.exists('d/f')).toBe(false)
      await expect(ws.files.remove('d')).rejects.toMatchObject({ code: 'EISDIR' })
      await expect(ws.files.remove('nope')).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await tools(ws)).toEqual(['init', 'file_write', 'file_remove'])
    })

    it('with autocommit off, changes wait for commit()', async () => {
      const ws = await open('s', { autocommit: false })
      const out = await ws.files.write('f', 'x')
      expect(out.commit).toBeNull()
      expect(ws.uncommitted).toBe(true)
      const commit = await ws.commit({ tool: 'turn' })
      expect(commit).toBe(ws.head)
      expect(ws.uncommitted).toBe(false)
      expect(await ws.commit()).toBe(commit)
      expect(await tools(ws)).toEqual(['init', 'turn'])
    })

    it('the filesystem writes pending changes that the next call commits', async () => {
      const ws = await open()
      await ws.files.fs.write('/workspace/raw', enc.encode('r'))
      expect(ws.uncommitted).toBe(true)
      await ws.files.write('other', 'o')
      expect(ws.uncommitted).toBe(false)
      const d = await ws.diff((await ws.log())[1]?.hash as string)
      expect(d.added).toEqual(['/workspace/other', '/workspace/raw'])
    })
  })

  describe('cache', () => {
    it('keeps rich values, copied in and out, and commits with the files', async () => {
      const ws = await open()
      const value = { n: 1, tags: new Set(['a']), bytes: new Uint8Array([1, 2]) }
      ws.cache.set('k', value)
      value.n = 2
      const got = (await ws.cache.get('k')) as typeof value
      expect(got).toEqual({ n: 1, tags: new Set(['a']), bytes: new Uint8Array([1, 2]) })
      got.n = 3
      expect(await ws.cache.get('k')).toMatchObject({ n: 1 })
      await ws.files.write('f', 'x')
      expect(await (await store.open('s')).cache.get('k')).toMatchObject({ n: 1 })
      expect(await ws.cache.keys()).toEqual(['k'])
      expect(await ws.cache.delete('k')).toBe(true)
      expect(await ws.cache.has('k')).toBe(false)
    })

    it('refuses bad keys, and is missing when turned off', async () => {
      const ws = await open()
      for (const key of ['', '__x', 'a/b']) {
        expect(() => ws.cache.set(key, 1)).toThrow(InvalidNameError)
      }
      const plain = await store.open('t', { cache: false })
      expect(() => plain.cache).toThrow(WorldError)
    })

    it('is left out of file diffs', async () => {
      const ws = await open()
      const before = ws.head
      ws.cache.set('k', 1)
      await ws.commit()
      expect(await ws.diff(before)).toMatchObject({ added: [], removed: [], modified: [] })
    })
  })

  describe('checkout', () => {
    it('restores files, cache and cwd as a new commit, keeping history', async () => {
      const ws = await open()
      await ws.files.write('a.txt', 'a')
      ws.cache.set('k', 'v1')
      await ws.commit()
      const mark = ws.head
      await ws.files.write('b.txt', 'b')
      await ws.files.write('a.txt', 'A')
      ws.cache.set('k', 'v2')
      await ws.files.fs.mkdir('d')
      await ws.files.fs.chdir('d')
      await ws.commit()
      const later = ws.head

      const restored = await ws.checkout(mark.slice(0, 10))
      expect(restored).toBe(ws.head)
      expect(await ws.files.readText('a.txt')).toBe('a')
      expect(await ws.files.exists('b.txt')).toBe(false)
      expect(await ws.cache.get('k')).toBe('v1')
      expect(ws.files.fs.getcwd()).toBe('/workspace')
      const log = await ws.log()
      expect(log[0]?.info).toEqual({ tool: 'checkout', target: mark })
      expect(log.map((c) => c.hash)).toContain(later)

      await ws.checkout(later)
      expect(await ws.files.readText('/workspace/a.txt')).toBe('A')
      expect(ws.files.fs.getcwd()).toBe('/workspace/d')
    })

    it('makes no commit when nothing differs, and drops pending changes', async () => {
      const ws = await open()
      const head = ws.head
      await ws.files.fs.write('/workspace/p', enc.encode('pending'))
      expect(await ws.checkout(head)).toBe(head)
      expect(ws.head).toBe(head)
      expect(ws.uncommitted).toBe(false)
      expect(await ws.files.exists('p')).toBe(false)
    })

    it('takes only some paths, removing what the ref lacks', async () => {
      const ws = await open()
      await ws.files.write('keep/one', '1')
      await ws.files.write('src/a', 'a1')
      const mark = ws.head
      await ws.files.write('keep/one', '2')
      await ws.files.write('src/a', 'a2')
      await ws.files.write('src/new', 'n')

      await ws.checkout(mark, { paths: ['src'] })
      expect(await ws.files.readText('src/a')).toBe('a1')
      expect(await ws.files.exists('src/new')).toBe(false)
      expect(await ws.files.readText('keep/one')).toBe('2')
      expect((await ws.log())[0]?.info).toEqual({
        tool: 'checkout',
        target: mark,
        takenFrom: `s@${mark}`,
        paths: ['/workspace/src/a'],
        removed: ['/workspace/src/new'],
      })
    })

    it('brings back a taken path whose directory is gone', async () => {
      const ws = await open()
      await ws.files.write('x/y/z', 'z')
      const mark = ws.head
      await ws.files.remove('x/y/z')
      await ws.files.fs.rmdir('/workspace/x/y')
      await ws.files.fs.rmdir('/workspace/x')
      await ws.commit()
      await ws.checkout(mark, { paths: ['x/y/z'] })
      expect(await ws.files.readText('x/y/z')).toBe('z')
      expect(await ws.files.fs.isDir('/workspace/x/y')).toBe(true)
    })

    it('names commits by hash, unique prefix or tag, and refuses others', async () => {
      const ws = await open()
      await ws.files.write('f', '1')
      await ws.tags.add('v1')
      const v1 = ws.head
      await ws.files.write('f', '2')
      expect(await ws.expandRef('v1')).toBe(v1)
      expect(await ws.expandRef(v1.slice(0, 8))).toBe(v1)
      expect(await ws.expandRef(v1)).toBe(v1)
      await expect(ws.expandRef('nope')).rejects.toThrow(UnknownRefError)
      await expect(ws.expandRef('0000000')).rejects.toThrow(UnknownRefError)
      const other = await store.open('other')
      await other.files.write('g', 'x')
      await expect(ws.expandRef(other.head)).rejects.toThrow(UnknownRefError)
    })
  })

  describe('fork', () => {
    it('branches the session, committing pending changes first', async () => {
      const ws = await open()
      await ws.files.fs.write('/workspace/f', enc.encode('pending'))
      const child = await ws.fork('child')
      expect(child.session).toBe('child')
      expect(await child.files.readText('f')).toBe('pending')
      expect((await ws.log())[0]?.info).toEqual({ tool: 'fork', child: 'child', inherit: 'full' })
      await child.files.write('only-child', 'c')
      expect(await ws.files.exists('only-child')).toBe(false)
      expect(await store.sessions()).toEqual(['child', 's'])
    })

    it('inherits settings, and the parent cwd', async () => {
      const ws = await open('s', { root: '/w', autocommit: false })
      await ws.files.fs.mkdir('d')
      await ws.files.fs.chdir('d')
      const child = await ws.fork('c')
      expect(child.root).toBe('/w')
      expect(child.autocommit).toBe(false)
      expect(child.files.fs.getcwd()).toBe('/w/d')
    })

    it("a fresh child drops the conversation and compaction's record", async () => {
      const ws = await open()
      const wt = await store.repo.worktree('s')
      wt.set(`${CONVERSATION_PREFIX}index`, { runs: [] })
      wt.set('__compaction__/1', 'fold')
      await wt.commit({ info: { tool: 'turn' } })
      await ws.refresh()

      const full = await ws.fork('full')
      expect(await (await store.repo.worktree('full')).has(`${CONVERSATION_PREFIX}index`)).toBe(
        true,
      )
      const fresh = await ws.fork('fresh', { inherit: 'fresh' })
      const keys = await (await store.repo.worktree('fresh')).keys()
      expect(keys.some((k) => k.startsWith('__conversation__/'))).toBe(false)
      expect(keys.some((k) => k.startsWith('__compaction__/'))).toBe(false)
      expect((await fresh.log())[0]?.info).toEqual({ tool: 'fork', parent: 's', inherit: 'fresh' })
      expect(await tools(full)).not.toContain(undefined)
    })

    it('passes autocommit on as it is now, not as it was opened', async () => {
      const ws = await open()
      ws.autocommit = false
      expect(ws.settings.autocommit).toBe(false)
      const child = await ws.fork('c')
      expect(child.autocommit).toBe(false)
      expect((await child.files.write('f', 'x')).commit).toBeNull()
    })

    it('forks from an earlier commit, and refuses a taken name', async () => {
      const ws = await open()
      await ws.files.write('f', '1')
      const mark = ws.head
      await ws.files.write('f', '2')
      const child = await ws.fork('old', { at: mark })
      expect(await child.files.readText('f')).toBe('1')
      await expect(ws.fork('old')).rejects.toThrow(SessionExistsError)
      await expect(ws.fork('s')).rejects.toThrow(SessionExistsError)
      await expect(ws.fork('@bad')).rejects.toThrow(InvalidNameError)
    })

    it("forks at another session's whole commit, and not at an unknown one", async () => {
      const ws = await open()
      const other = await store.open('other')
      await other.files.write('f', 'theirs')
      const theirs = other.head
      const child = await ws.fork('from-other', { at: theirs })
      expect(await child.files.readText('f')).toBe('theirs')
      await expect(ws.fork('nope', { at: 'f'.repeat(40) })).rejects.toThrow(UnknownRefError)
      await expect(ws.fork('nope', { at: theirs.slice(0, 7) })).rejects.toThrow(UnknownRefError)
      expect(await ws.resolveRef(`other@${theirs.slice(0, 7)}`)).toEqual({
        commit: theirs,
        label: `other@${theirs}`,
      })
    })

    it('forks through the store', async () => {
      const ws = await open()
      await ws.files.write('f', '1')
      const child = await store.fork('s', 't', { autocommit: false })
      expect(child.autocommit).toBe(false)
      expect(await child.files.readText('f')).toBe('1')
      await expect(store.fork('missing', 'x')).rejects.toThrow(UnknownSessionError)
    })
  })

  describe('tags', () => {
    it('name commits, never move, and open frozen views', async () => {
      const ws = await open()
      await ws.files.fs.write('/workspace/f', enc.encode('1'))
      const tagged = await ws.tags.add('v1', { info: { note: 'first' } })
      expect(tagged).toBe(ws.head)
      expect((await ws.log())[0]?.info).toEqual({ tool: 'tag', name: 'v1' })
      await expect(ws.tags.add('v1')).rejects.toThrow(TagExistsError)
      await ws.files.write('f', '2')

      expect(await ws.tags.list()).toEqual(new Map([['v1', tagged]]))
      expect(await ws.tags.info('v1')).toMatchObject({
        name: 'v1',
        commit: tagged,
        info: { note: 'first' },
      })
      expect(await ws.tags.info('v2')).toBeUndefined()

      const view = await ws.tags.at('v1')
      expect(view.frozen).toBe(true)
      expect(view.head).toBe(tagged)
      expect(await view.files.readText('f')).toBe('1')
      await expect(view.files.write('f', 'no')).rejects.toThrow(ReadOnlyError)
      await expect(view.files.fs.write('/workspace/f', enc.encode('no'))).rejects.toMatchObject({
        code: 'EROFS',
      })
      expect(() => view.cache.set('k', 1)).toThrow(ReadOnlyError)
      await expect(view.commit()).rejects.toThrow(ReadOnlyError)

      await ws.tags.delete('v1')
      expect(await ws.tags.list()).toEqual(new Map())
      await expect(ws.tags.at('v1')).rejects.toThrow(UnknownTagError)
      await expect(ws.tags.add('@x')).rejects.toThrow(InvalidNameError)
    })

    it('are scoped to their session', async () => {
      const ws = await open()
      const other = await store.open('other')
      await ws.tags.add('v1')
      await other.tags.add('v1')
      expect([...(await ws.tags.list()).keys()]).toEqual(['v1'])
      expect(await store.repo.tags.list()).toEqual(['other/v1', 's/v1'])
    })

    it('of the store outlive the session they name', async () => {
      const ws = await open()
      await ws.files.write('f', 'kept')
      const commit = await store.tags.add(ws, 'release', { info: { by: 'test' } })
      expect(await store.tags.list()).toEqual(new Map([['release', commit]]))
      expect(await store.tags.add('s', 'by-ref')).toBe(commit)
      await expect(store.tags.add(ws, 'release')).rejects.toThrow(TagExistsError)
      await expect(store.tags.add(ws, 'a:b')).rejects.toThrow(InvalidNameError)
      // Spelled like a commit id, ws-git could never reach it by name.
      await expect(store.tags.add(ws, 'deadbeef')).rejects.toThrow(InvalidNameError)
      expect(await store.tags.add(ws, 'cafe')).toBe(commit)
      await store.tags.delete('cafe')

      await store.delete('s', { minAge: 0 })
      const view = await store.tags.at('release')
      expect(await view.files.readText('f')).toBe('kept')
      expect(await (await store.resolve(`s@${commit}`)).files.readText('f')).toBe('kept')
      expect(await store.tags.info('release')).toMatchObject({ info: { by: 'test' } })
      await store.tags.delete('release')
      await store.tags.delete('by-ref')
      expect(await store.tags.list()).toEqual(new Map())
    })
  })

  describe('the store', () => {
    it('lists sessions only, and deletes them with their tags', async () => {
      const ws = await open()
      await ws.tags.add('v1')
      await store.open('b')
      await store.repo.branches.create('@internal')
      expect(await store.sessions()).toEqual(['b', 's'])
      expect(await store.exists('@internal')).toBe(false)

      await store.delete(['s'], { minAge: 0 })
      expect(await store.sessions()).toEqual(['b'])
      expect(await store.repo.tags.list()).toEqual([])
      await expect(store.delete('s')).rejects.toThrow(UnknownSessionError)
      await expect(ws.files.write('f', 'x')).rejects.toThrow()
    })

    it('resolves session@ref to a frozen view, and a session to its tip', async () => {
      const ws = await open()
      await ws.files.write('f', '1')
      const one = ws.head
      await ws.files.write('f', '2')
      expect(ws.ref).toBe(`s@${ws.head}`)
      expect(await (await store.resolve(`s@${one.slice(0, 9)}`)).files.readText('f')).toBe('1')
      const tip = await store.resolve('s')
      expect(tip.frozen).toBe(true)
      expect(await tip.files.readText('f')).toBe('2')
      await expect(store.resolve('nope@abc1234')).rejects.toThrow(UnknownSessionError)
      await expect(store.resolve('s@nope')).rejects.toThrow(UnknownRefError)
      expect(await tools(ws)).toEqual(['init', 'file_write', 'file_write'])
    })

    it('clean collects commits nothing reaches', async () => {
      let clock = 1_000_000
      store = await Store.open(await make(), { now: () => clock })
      const ws = await store.open('s')
      await ws.files.write('f', '1')
      const tmp = await ws.fork('tmp')
      await tmp.files.write('g', 'x')
      await store.repo.branches.delete('tmp')
      expect(await store.clean({ minAge: 10 })).toBe(0)
      clock += 60
      expect(await store.clean({ minAge: 10 })).toBeGreaterThan(0)
    })
  })

  describe('one call at a time', () => {
    it("never interleaves a call's writes with another's commit", async () => {
      const ws = await open()
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      const slow = ws.exclusive(async () => {
        await ws.files.fs.write('/workspace/slow', enc.encode('s'))
        await gate
        return ws.autoCommit({ tool: 'slow' })
      })
      const quick = ws.files.write('quick', 'q')
      await Promise.resolve()
      release()
      const [slowCommit, quickOut] = await Promise.all([slow, quick])
      expect(await tools(ws)).toEqual(['init', 'slow', 'file_write'])
      expect(await ws.diff(ws.head, slowCommit as string)).toMatchObject({
        added: [],
        removed: ['/workspace/quick'],
        modified: [],
      })
      expect(quickOut.commit).toBe(ws.head)
    })

    it('runs calls in the order they were made, past a failing one', async () => {
      const ws = await open()
      const calls = await Promise.allSettled([
        ws.files.write('a', '1'),
        ws.files.remove('missing'),
        ws.files.write('b', '2'),
      ])
      expect(calls.map((c) => c.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
      expect(await tools(ws)).toEqual(['init', 'file_write', 'file_write'])
    })

    it('closing waits for queued calls, then refuses more', async () => {
      const ws = await open()
      const write = ws.files.write('a', '1')
      await ws.close()
      expect((await write).commit).not.toBeNull()
      expect(ws.closed).toBe(true)
      await expect(ws.files.write('b', '2')).rejects.toThrow(ReadOnlyError)
      await expect(ws.exclusive(async () => 1)).rejects.toThrow(ReadOnlyError)
      await expect(ws.files.fs.write('/workspace/b', enc.encode('2'))).rejects.toMatchObject({
        code: 'EROFS',
      })
      await expect(ws.files.fs.mkdir('/workspace/d')).rejects.toMatchObject({ code: 'EROFS' })
      await expect(ws.files.fs.chdir('/')).rejects.toMatchObject({ code: 'EROFS' })
      expect(() => ws.cache.set('k', 1)).toThrow(ReadOnlyError)
      await expect(ws.cache.delete('k')).rejects.toThrow(ReadOnlyError)
      expect(ws.uncommitted).toBe(false)
      expect(await ws.files.readText('a')).toBe('1')
    })
  })

  describe('two workspaces on one session', () => {
    it('merge separate changes', async () => {
      const a = await open()
      const b = await store.open('s')
      await a.files.write('from-a', 'a')
      await b.files.write('from-b', 'b')
      const fresh = await store.open('s')
      expect(await fresh.files.list()).toEqual(['from-a', 'from-b'])
    })

    it("keep the committing side's cwd when both moved, and merge one file's times", async () => {
      const a = await open()
      const b = await store.open('s')
      await a.files.fs.mkdir('/workspace/x', { existOk: true })
      await a.files.fs.chdir('/workspace/x')
      await a.files.write('/workspace/same', 'v')
      await b.files.fs.mkdir('/workspace/y')
      await b.files.fs.chdir('/workspace/y')
      await b.files.write('/workspace/same', 'v')
      const fresh = await store.open('s')
      expect(fresh.files.fs.getcwd()).toBe('/workspace/y')
      const stat = await fresh.files.fs.stat('/workspace/same')
      const [sa, sb] = await Promise.all([
        a.files.fs.stat('/workspace/same'),
        b.files.fs.stat('/workspace/same'),
      ])
      expect(stat.createdAt).toBe(sa.createdAt <= sb.createdAt ? sa.createdAt : sb.createdAt)
      expect(text(await fresh.files.read('/workspace/same'))).toBe('v')
    })

    it('throw CommitConflictError when both changed a file, keeping the loser pending', async () => {
      const a = await open()
      const b = await store.open('s')
      await a.files.write('f', 'from a')
      await expect(b.files.write('f', 'from b')).rejects.toThrow(CommitConflictError)
      expect(b.uncommitted).toBe(true)
      await b.refresh()
      expect(b.uncommitted).toBe(false)
      expect(await b.files.readText('f')).toBe('from a')
    })
  })

  it('a file whose directory another writer removed still lists', async () => {
    const a = await open()
    await a.files.fs.mkdir('/workspace/d')
    await a.commit()
    const b = await store.open('s')
    await a.files.fs.rmdir('/workspace/d')
    await a.commit()
    await b.files.fs.write('/workspace/d/f', enc.encode('x'))
    await b.commit()
    const fresh = await store.open('s')
    expect(await fresh.files.list()).toEqual(['d'])
    expect(await fresh.files.readText('d/f')).toBe('x')
    await fresh.files.fs.mkdir('/workspace/d', { parents: true })
    expect(await fresh.files.fs.isDir('/workspace/d')).toBe(true)
  })

  it('FsError is what the filesystem throws', async () => {
    const ws = await open()
    await expect(ws.files.read('nope')).rejects.toBeInstanceOf(FsError)
  })
})
