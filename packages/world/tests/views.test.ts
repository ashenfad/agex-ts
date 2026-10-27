/**
 * What a session's files show, and what counts as its work: narrowed
 * forks (views), paths taken from other sessions, attachments, and
 * ignore patterns.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { FsError, execute } from '@agex-ts/termish'
import { MemoryFS } from '@agex-ts/termish/fs/memory'
import { describe, expect, it } from 'vitest'
import { Patterns, isIgnored, whyIgnored } from '../src/ignore'
import { Store, UnknownRefError, VIEW_KEY, type Workspace, WorldFS } from '../src/index'
import { ViewFS, parseView } from '../src/views'
import { newKV } from './backends'

const enc = new TextEncoder()

const fresh = async () => Store.open(await newKV())

async function seeded(store: Store, files: Record<string, string>, opts = {}): Promise<Workspace> {
  const ws = await store.open('main', opts)
  for (const [name, text] of Object.entries(files)) await ws.files.write(name, text)
  await ws.index.commit('seed')
  return ws
}

const viewOf = async (ws: Workspace) =>
  parseView(await (await ws.store.repo.snapshot({ commit: ws.head })).get(VIEW_KEY))

describe('a narrowed fork', () => {
  it('reads only its view, and stays narrowed when reopened', async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'auth.py': 'auth\n', 'billing.py': 'billing\n' })
    const child = await ws.fork('child', { paths: ['auth.py'] })
    expect(child.view).toEqual(['/workspace/auth.py'])
    expect(await child.files.list('/workspace')).toEqual(['auth.py'])
    expect(await child.files.exists('billing.py')).toBe(false)
    await expect(child.files.read('billing.py')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await child.terminal('ls /workspace')).stdout).toBe('auth.py\n')
    expect((await child.terminal('cat /workspace/billing.py')).exitCode).not.toBe(0)
    // the branch holds everything: the merge back stays ordinary
    const at = await ws.store.repo.snapshot({ commit: child.head })
    expect(await at.get('__file__/workspace/billing.py')).toBeDefined()
    expect((await viewOf(child))?.paths).toEqual(['/workspace/auth.py'])
    await child.close()
    const again = await store.open('child')
    expect(await again.files.list('/workspace')).toEqual(['auth.py'])
    await again.close()
    await ws.close()
  })

  it('creates anywhere, joining the view, but never changes what it cannot see', async () => {
    const ws = await seeded(await fresh(), { 'auth.py': 'auth\n', 'billing.py': 'billing\n' })
    const child = await ws.fork('child', { paths: ['auth.py'] })
    await child.files.write('auth.py', 'refactored\n')
    await child.files.write('notes/why.md', 'because\n')
    expect(await child.files.readText('notes/why.md')).toBe('because\n')
    expect(child.view).toContain('/workspace/notes/why.md')
    expect((await viewOf(child))?.paths).toContain('/workspace/notes/why.md')
    await expect(child.files.write('billing.py', 'sneaky\n')).rejects.toThrow(
      "outside this session's view",
    )
    await expect(child.files.fs.remove('/workspace/billing.py')).rejects.toMatchObject({
      code: 'EACCES',
    })
    expect((await child.terminal('echo sneaky > /workspace/billing.py')).exitCode).not.toBe(0)
    const at = await ws.store.repo.snapshot({ commit: child.head })
    expect(
      new TextDecoder().decode((await at.get('__file__/workspace/billing.py')) as Uint8Array),
    ).toBe('billing\n')
    await child.close()
    await ws.close()
  })

  it("can't stage what it can't see", async () => {
    const ws = await seeded(await fresh(), { 'a.py': 'a\n', 'b.py': 'b\n' })
    const child = await ws.fork('child', { paths: ['a.py'] })
    await expect(child.index.stage(['/workspace/b.py'])).rejects.toThrow('unknown path')
    await child.files.write('a.py', 'A\n')
    expect(await child.index.stage(['/workspace/a.py'])).toEqual(['/workspace/a.py'])
    await child.close()
    await ws.close()
  })

  it("doesn't pass its view to a fork given the whole tree, or to a merge", async () => {
    const ws = await seeded(await fresh(), { 'a.py': 'a\n', 'b.py': 'b\n' })
    const child = await ws.fork('child', { paths: ['a.py'] })
    const grand = await child.fork('grand')
    expect(grand.view).toBeNull()
    expect(await grand.files.exists('b.py')).toBe(true)
    await child.files.write('a.py', 'done\n')
    await child.index.commit('done')
    expect((await ws.merge('child')).merged).toBe(true)
    expect(ws.view).toBeNull()
    expect(await viewOf(ws)).toBeNull()
    expect(await ws.files.exists('b.py')).toBe(true)
    await grand.close()
    await child.close()
    await ws.close()
  })

  it("refuses '/' as a view, and shows the whole tree for the root", async () => {
    const ws = await seeded(await fresh(), { 'a.py': 'a\n', 'deep/b.py': 'b\n' })
    for (const spelling of ['/', '//', '/.']) {
      await expect(ws.fork('kid', { paths: [spelling] })).rejects.toThrow('not a view')
    }
    expect(await ws.store.exists('kid')).toBe(false)
    const child = await ws.fork('child', { paths: ['/workspace'] })
    expect(child.view).toEqual(['/workspace'])
    expect(await child.files.readText('deep/b.py')).toBe('b\n')
    await child.files.write('a.py', 'changed\n')
    await child.close()
    await ws.close()
  })

  it('is empty with no paths, forked from the last commit leaving the pending', async () => {
    const ws = await seeded(await fresh(), { 'a.py': 'a\n' })
    await ws.files.fs.write('/workspace/pending.py', enc.encode('p'))
    const child = await ws.fork('child', { paths: [] })
    expect(ws.uncommitted).toBe(true)
    expect(await child.files.list('/workspace')).toEqual([])
    await child.files.write('mine.md', 'mine\n')
    expect(await child.files.list('/workspace')).toEqual(['mine.md'])
    await child.close()
    await ws.close()
  })

  it('groups a diff by its seed, so collateral shows', async () => {
    const ws = await seeded(await fresh(), { 'auth.py': 'auth\n', 'main.py': 'main\n' })
    const point = ws.head
    const child = await ws.fork('child', { paths: ['auth.py'] })
    await child.files.write('auth.py', 'refactored\n')
    await child.files.write('notes/why.md', 'and here is why\n')
    const work = await child.index.commit('work')
    const d = await ws.diff(point, work)
    expect(d.seed).toEqual(['/workspace/auth.py'])
    expect(d.inSeed).toEqual(['/workspace/auth.py'])
    expect(d.elsewhere).toEqual(['/workspace/notes/why.md'])
    const full = await ws.diff(point, ws.head)
    expect(full).toMatchObject({ seed: [], elsewhere: [] })
    await child.close()
    await ws.close()
  })

  it('follows the tree when it moves', async () => {
    const ws = await seeded(await fresh(), { 'a.py': 'a\n', 'b.py': 'b\n' })
    const before = ws.head
    const child = await ws.fork('child', { paths: ['a.py'] })
    expect(await child.files.exists('b.py')).toBe(false)
    await child.checkout(before)
    expect(child.view).toBeNull()
    expect(await child.files.exists('b.py')).toBe(true)
    await child.close()
    await ws.close()
  })

  it('puts all an empty view changed elsewhere', async () => {
    const ws = await seeded(await fresh(), { 'a.py': 'a\n' })
    const point = ws.head
    const child = await ws.fork('child', { paths: [] })
    await child.files.write('mine.md', 'mine\n')
    const d = await ws.diff(point, await child.index.commit('mine'))
    expect(d).toMatchObject({ seed: [], inSeed: [], elsewhere: ['/workspace/mine.md'] })
    await child.close()
    await ws.close()
  })

  it('comes from store.fork too', async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'a.py': 'a\n', 'b.py': 'b\n' })
    await ws.close()
    const child = await store.fork('main', 'child', { inherit: 'fresh', paths: ['a.py'] })
    expect(await child.files.list('/workspace')).toEqual(['a.py'])
    await child.close()
  })
})

describe('taking paths from a ref', () => {
  it("copies files from another session at its agent's last commit", async () => {
    const ws = await seeded(await fresh(), { 'a.txt': 'mine\n' })
    const child = await ws.fork('child')
    await child.files.write('a.txt', 'theirs\n')
    await child.files.write('only_theirs.txt', 'theirs\n')
    await child.files.write('not_asked_for.txt', 'theirs\n')
    const work = await child.index.commit('work')
    await child.terminal('echo in-flight > /workspace/a.txt')
    const landed = await ws.checkout('child', { paths: ['a.txt', 'only_theirs.txt'] })
    expect(await ws.files.readText('a.txt')).toBe('theirs\n')
    expect(await ws.files.readText('only_theirs.txt')).toBe('theirs\n')
    expect(await ws.files.exists('not_asked_for.txt')).toBe(false)
    expect(landed).toBe(ws.head)
    expect((await ws.log({ limit: 1 }))[0]?.info).toEqual({
      tool: 'checkout',
      target: work,
      takenFrom: `child@${work}`,
      paths: ['/workspace/a.txt', '/workspace/only_theirs.txt'],
    })
    await child.close()
    await ws.close()
  })

  it('mirrors a directory, and moves one file alone', async () => {
    const ws = await (await fresh()).open('main')
    await ws.files.write('pkg/keep.py', 'keep\n')
    await ws.files.write('pkg/deleted.py', 'doomed\n')
    await ws.files.write('pkg/beside.py', 'mine\n')
    await ws.files.write('outside.py', 'mine\n')
    await ws.index.commit('seed')
    const child = await ws.fork('child')
    await child.files.remove('pkg/deleted.py')
    await child.files.remove('pkg/beside.py')
    await child.files.write('pkg/new.py', 'new\n')
    await child.index.commit('work')
    await ws.checkout('child', { paths: ['pkg/new.py'] })
    expect(await ws.files.exists('pkg/beside.py')).toBe(true)
    expect((await ws.log({ limit: 1 }))[0]?.info).not.toHaveProperty('removed')
    await ws.checkout('child', { paths: ['pkg'] })
    expect(await ws.files.exists('pkg/deleted.py')).toBe(false)
    expect(await ws.files.exists('pkg/beside.py')).toBe(false)
    expect(await ws.files.readText('outside.py')).toBe('mine\n')
    expect((await ws.log({ limit: 1 }))[0]?.info).toMatchObject({
      paths: ['/workspace/pkg/keep.py', '/workspace/pkg/new.py'],
      removed: ['/workspace/pkg/beside.py', '/workspace/pkg/deleted.py'],
    })
    await child.close()
    await ws.close()
  })

  it('takes a ref of its own, and refuses one with nothing there', async () => {
    const ws = await seeded(await fresh(), { 'a.txt': 'one\n' })
    const first = ws.ref
    await ws.files.write('a.txt', 'two\n')
    await ws.checkout(first, { paths: ['a.txt'] })
    expect(await ws.files.readText('a.txt')).toBe('one\n')
    await expect(ws.checkout(first, { paths: ['ghost.txt'] })).rejects.toThrow('nothing at')
    await expect(ws.checkout('nobody', { paths: ['a.txt'] })).rejects.toThrow(UnknownRefError)
    await ws.close()
  })

  it('is refused whole where the view would refuse any of it', async () => {
    const ws = await (await fresh()).open('main')
    await ws.files.write('pkg/seen.py', 'S1\n')
    await ws.files.write('pkg/hidden.py', 'H1\n')
    await ws.index.commit('seed')
    const src = await ws.fork('src')
    const child = await ws.fork('child', { paths: ['pkg/seen.py'] })
    await src.files.write('pkg/seen.py', 'S2\n')
    await src.files.write('pkg/hidden.py', 'H2\n')
    await src.index.commit('theirs')
    await expect(
      child.checkout('src', { paths: ['pkg/seen.py', 'pkg/hidden.py'] }),
    ).rejects.toThrow("outside this session's view")
    expect(await child.files.readText('pkg/seen.py')).toBe('S1\n')
    expect(child.uncommitted).toBe(false)
    await src.files.remove('pkg/hidden.py')
    await src.index.commit('dropped')
    await expect(child.checkout('src', { paths: ['pkg'] })).rejects.toThrow(
      "outside this session's view",
    )
    expect(await ws.files.readText('pkg/hidden.py')).toBe('H1\n')
    await src.close()
    await child.close()
    await ws.close()
  })
})

describe('attachments', () => {
  async function reviewer(store: Store): Promise<string> {
    const other = await store.open('reviewer')
    await other.files.write('review.md', 'looks fine\n')
    const ref = other.ref
    await other.close()
    return ref
  }

  it("mount another session's tree read-only, outside the session's own", async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'a.txt': 'mine\n' })
    const ref = await reviewer(store)
    expect(await ws.files.attach(ref, '/reviews')).toBe(ref)
    expect(ws.files.attachments()).toEqual({ '/reviews': ref })
    expect(await ws.files.readText('/reviews/review.md')).toBe('looks fine\n')
    expect((await ws.terminal('cat /reviews/review.md')).stdout).toBe('looks fine\n')
    expect((await ws.terminal('ls /reviews')).stdout).toContain('review.md')
    expect((await ws.terminal('ls /')).stdout).toContain('reviews')
    await expect(ws.files.fs.write('/reviews/review.md', enc.encode('nope'))).rejects.toMatchObject(
      {
        code: 'EROFS',
      },
    )
    expect(ws.uncommitted).toBe(false)
    await ws.files.detach('/reviews')
    expect(ws.files.attachments()).toEqual({})
    expect(await ws.files.exists('/reviews/review.md')).toBe(false)
    await ws.close()
  })

  it("don't move the session, and leave it at home when detached from inside", async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'a.txt': 'mine\n' })
    await reviewer(store)
    await ws.terminal('mkdir -p deep; cd deep')
    await ws.files.attach('reviewer', 'reviews')
    expect((await ws.terminal('pwd')).stdout.trim()).toBe('/workspace/deep')
    expect((await ws.terminal('cat ../a.txt')).stdout).toBe('mine\n')
    expect((await ws.terminal('cat ../reviews/review.md')).stdout).toBe('looks fine\n')
    await ws.terminal('cd /workspace/reviews')
    expect((await ws.terminal('cat review.md')).stdout).toBe('looks fine\n')
    await ws.files.detach('reviews')
    expect((await ws.terminal('pwd')).stdout.trim()).toBe('/workspace')
    await ws.close()
  })

  it('reach code in the kernel, as a view does', async () => {
    const worker = new URL('../dist/worker.node.js', import.meta.url)
    if (!existsSync(fileURLToPath(worker))) throw new Error('build @agex-ts/world first')
    const store = await fresh()
    const ws = await store.open('main', {
      profile: { code: { worker: { target: 'node', url: worker } } },
    })
    await reviewer(store)
    await ws.files.attach('reviewer', 'reviews')
    const out = await ws.runCode(
      "return new TextDecoder().decode(await fs.read('/workspace/reviews/review.md'))",
    )
    await ws.files.write('a.txt', 'mine')
    const child = await ws.fork('child', { paths: ['nothing.md'] })
    const refused = await child.runCode("await fs.write('/workspace/a.txt', new Uint8Array([1]))")
    expect(refused.error?.message).toContain("outside this session's view")
    await child.close()
    expect(out.value).toBe('looks fine\n')
    await ws.close()
  })

  it('show in recursive listings, under their own names', async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'a.txt': 'needle here\n' })
    const other = await store.open('reviewer')
    await other.files.write('sub/deep.md', 'needle there\n')
    await other.close()
    await ws.files.attach('reviewer', 'reviews')
    expect((await ws.terminal('grep -r needle /workspace')).stdout.split('\n').sort()).toEqual([
      '',
      '/workspace/a.txt:needle here',
      '/workspace/reviews/sub/deep.md:needle there',
    ])
    expect((await ws.terminal('find /workspace/reviews/sub')).stdout).toBe(
      '/workspace/reviews/sub/deep.md\n',
    )
    expect((await ws.terminal('cd reviews && grep -r needle sub')).stdout).toBe(
      'sub/deep.md:needle there\n',
    )
    await ws.close()
  })

  it('close with the session', async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'a.txt': 'mine\n' })
    await reviewer(store)
    await ws.files.attach('reviewer', '/reviews')
    await ws.close()
    expect(ws.files.attachments()).toEqual({})
    expect(await ws.files.exists('/reviews/review.md')).toBe(false)
  })

  it('may sit below a directory the session lacks, which then reads as one', async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'a.txt': 'mine\n' })
    await reviewer(store)
    await ws.files.attach('reviewer', '/reviews/alice')
    expect(await ws.files.fs.isDir('/reviews')).toBe(true)
    expect((await ws.terminal('ls /reviews')).stdout).toBe('alice\n')
    expect((await ws.terminal('cd /reviews && ls alice')).stdout).toBe('review.md\n')
    expect((await ws.terminal('find /reviews -type f')).stdout).toBe('/reviews/alice/review.md\n')
    await ws.files.detach('/reviews/alice')
    expect(await ws.files.fs.exists('/reviews')).toBe(false)
    await ws.close()
  })

  it('may sit inside another, and show in its listings', async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'a.txt': 'mine\n' })
    const other = await store.open('reviewer')
    await other.files.write('review.md', 'looks fine\n')
    await other.files.write('.notes/hidden.md', 'covered\n')
    await other.files.write('sub/deep.md', 'deep\n')
    await other.close()
    const writer = await store.open('writer')
    await writer.files.write('draft.md', 'a draft\n')
    await writer.close()
    await ws.files.attach('reviewer', '/reviews')
    // over a directory the mount holds, and below one it lacks
    await ws.files.attach('writer', '/reviews/.notes')
    await ws.files.attach('writer', '/reviews/more/drafts')
    expect((await ws.terminal('ls -a /reviews')).stdout.split('\n')).toEqual(
      expect.arrayContaining(['.notes', 'more', 'review.md', 'sub']),
    )
    expect((await ws.terminal('ls /reviews/.notes')).stdout).toBe('draft.md\n')
    expect((await ws.terminal('ls /reviews/more')).stdout).toBe('drafts\n')
    expect(await ws.files.fs.isDir('/reviews/more')).toBe(true)
    expect((await ws.terminal('cd /reviews/more && ls')).stdout).toBe('drafts\n')
    expect((await ws.terminal('find /reviews -type f')).stdout.split('\n').sort()).toEqual([
      '',
      '/reviews/.notes/draft.md',
      '/reviews/more/drafts/draft.md',
      '/reviews/review.md',
      '/reviews/sub/deep.md',
    ])
    expect((await ws.files.fs.list('/reviews', { recursive: true })).sort()).toEqual([
      '.notes',
      '.notes/draft.md',
      'more',
      'more/drafts',
      'more/drafts/draft.md',
      'review.md',
      'sub',
      'sub/deep.md',
    ])
    await ws.files.detach('/reviews/.notes')
    expect((await ws.terminal('ls /reviews/.notes')).stdout).toBe('hidden.md\n')
    await ws.close()
  })

  it('refuse a taken point, writes, and a detach of nothing', async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'a.txt': 'mine\n' })
    await reviewer(store)
    await ws.files.attach('reviewer', '/reviews')
    await expect(ws.files.attach('reviewer', '/reviews')).rejects.toThrow('already taken')
    await expect(ws.files.attach('reviewer', '/other', { readonly: false })).rejects.toThrow(
      'accepts no writes',
    )
    await expect(ws.files.attach('reviewer', 'a.txt')).rejects.toThrow('a path of this session')
    await expect(ws.files.detach('/nowhere')).rejects.toThrow('nothing attached')
    await ws.close()
  })

  it('may cover an empty directory, not a full one', async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'full/a.txt': 'mine\n' })
    await reviewer(store)
    await ws.terminal('mkdir empty')
    await ws.files.attach('reviewer', 'empty')
    expect(await ws.files.readText('empty/review.md')).toBe('looks fine\n')
    await expect(ws.files.attach('reviewer', 'full')).rejects.toThrow('a path of this session')
    await ws.close()
  })

  it("don't travel to a fork", async () => {
    const store = await fresh()
    const ws = await seeded(store, { 'a.txt': 'mine\n' })
    await reviewer(store)
    await ws.files.attach('reviewer', '/reviews')
    const child = await ws.fork('child')
    expect(child.files.attachments()).toEqual({})
    expect(await child.files.exists('/reviews/review.md')).toBe(false)
    await child.close()
    await ws.close()
  })
})

describe('ignore patterns', () => {
  it.each([
    ['__pycache__/', ['__pycache__/m.pyc', 'pkg/__pycache__/m.pyc'], ['__pycache__.txt']],
    ['*.log', ['a.log', 'deep/b.log'], ['a.log.txt', 'logs/x']],
    ['/build/', ['build/out.js'], ['src/build/out.js']],
    ['data/raw', ['data/raw/x.csv', 'data/raw'], ['other/data/raw/x.csv']],
    ['docs/**/*.tmp', ['docs/a.tmp', 'docs/x/y/b.tmp'], ['a.tmp']],
    ['cache?', ['cache1/x', 'cacheA'], ['cache12/x']],
    ['[ab].txt', ['a.txt', 'x/b.txt'], ['c.txt']],
  ])('follow .gitignore: %s', (pattern, ignored, kept) => {
    const p = new Patterns([pattern])
    for (const rel of ignored) expect(p.match(rel)).toBe(true)
    for (const rel of kept) expect(p.match(rel)).toBe(false)
  })

  it('match a directory pattern to directories only, and refuse negation', () => {
    expect(new Patterns(['build/']).match('build')).toBe(false)
    expect(new Patterns(['build']).match('build')).toBe(true)
    expect(new Patterns(['', '# a comment', '*.log']).source).toEqual(['*.log'])
    expect(new Patterns('*.log\n\n# c\n*.tmp').source).toEqual(['*.log', '*.tmp'])
    expect(() => new Patterns(['*.log', '!keep.log'])).toThrow('negation')
  })

  it('name why a path is never work', () => {
    expect(whyIgnored('/tmp/x', '/workspace')).toBe('it is outside the workspace root (/workspace)')
    expect(whyIgnored('/workspace/a.py', '/workspace')).toBeNull()
    expect(whyIgnored('/workspace', '/workspace')).toBeNull()
    expect(whyIgnored('/tmp/x', '/')).toBeNull()
    expect(isIgnored('/workspace/run.log', '/workspace', new Patterns(['*.log']))).toBe(true)
  })

  it('are refused at open when bad, and inherited by a fork', async () => {
    const store = await fresh()
    await expect(store.open('bad', { ignore: ['!x'] })).rejects.toThrow('negation')
    const ws = await store.open('main', { ignore: ['__pycache__/', '*.log'] })
    expect(ws.ignore).toEqual(['__pycache__/', '*.log'])
    const kid = await ws.fork('kid')
    expect(kid.ignore).toEqual(['__pycache__/', '*.log'])
    await kid.close()
    await ws.close()
  })

  it("keep matched paths, and anything outside the root, out of the agent's git", async () => {
    const ws = await (await fresh()).open('main', { ignore: ['*.log'] })
    await ws.files.write('app.py', 'x = 1\n')
    await ws.index.commit('start')
    await ws.files.write('run.log', 'ran\n')
    await ws.terminal('echo scratch > /tmp/t.mjs')
    await ws.files.write('app.py', 'x = 2\n')
    expect((await ws.index.status()).unstaged).toEqual(['/workspace/app.py'])
    await expect(ws.index.stage(['/workspace/run.log'])).rejects.toThrow(
      "matches the session's ignore patterns",
    )
    await expect(ws.index.stage(['/tmp/t.mjs'])).rejects.toThrow('outside the workspace root')
    await ws.index.commit('two')
    expect((await ws.index.status()).unstaged).toEqual([])
    expect(await ws.files.readText('run.log')).toBe('ran\n')
    await ws.files.write('again.log', 'more\n')
    await expect(ws.index.commit('only logs')).rejects.toThrow('nothing to commit')
    await ws.close()
  })

  it("are left alone by the agent's checkout", async () => {
    const ws = await (await fresh()).open('main', { ignore: ['*.log'] })
    await ws.files.write('app.py', 'v1\n')
    await ws.files.write('run.log', 'first\n')
    const first = await ws.index.commit('first')
    await ws.files.write('app.py', 'v2\n')
    await ws.files.write('later.log', 'later\n')
    await ws.index.commit('second')
    await ws.files.write('run.log', 'newer\n')
    await ws.terminal('mkdir -p /tmp && echo scratch > /tmp/t.txt')
    await ws.index.checkout(first)
    expect(await ws.files.readText('app.py')).toBe('v1\n')
    expect(await ws.files.readText('run.log')).toBe('newer\n')
    expect(await ws.files.readText('later.log')).toBe('later\n')
    expect(await ws.files.readText('/tmp/t.txt')).toBe('scratch\n')
    await ws.close()
  })

  it('keep matched paths out of diffs', async () => {
    const ws = await (await fresh()).open('main', { ignore: ['*.log'] })
    const before = ws.head
    await ws.files.write('run.log', 'ran\n')
    await ws.files.write('app.py', 'x\n')
    const d = await ws.diff(before)
    expect([...d.added, ...d.modified]).toEqual(['/workspace/app.py'])
    await ws.close()
  })

  it("keep this side's copies in a merge and a cherry-pick", async () => {
    const ws = await (await fresh()).open('main', { ignore: ['*.log'] })
    await ws.files.write('app.py', 'v1\n')
    await ws.files.write('ours.log', 'ours\n')
    await ws.index.commit('start')
    const other = await ws.fork('other')
    await other.files.write('app.py', 'theirs\n')
    await other.files.write('ours.log', 'changed there\n')
    await other.files.write('new.log', 'new\n')
    const theirs = await other.index.commit('their work')
    await other.files.write('late.log', 'late\n')
    await other.commit()
    const out = await ws.merge('other')
    expect(out).toMatchObject({ merged: true, conflicts: [] })
    expect(await ws.files.readText('app.py')).toBe('theirs\n')
    expect(await ws.files.readText('ours.log')).toBe('ours\n')
    expect(await ws.files.exists('new.log')).toBe(false)
    expect(await ws.files.exists('late.log')).toBe(false)
    expect(out.autoMerged).not.toContain('/workspace/new.log')
    await other.files.write('app.py', 'picked\n')
    await other.files.write('pick.log', 'with it\n')
    const pick = await other.index.commit('more')
    expect((await ws.cherryPick(`other@${pick}`)).merged).toBe(true)
    expect(await ws.files.readText('app.py')).toBe('picked\n')
    expect(await ws.files.exists('pick.log')).toBe(false)
    expect(theirs).not.toBe(pick)
    await other.close()
    await ws.close()
  })

  it('are skipped when a directory is taken, and taken when named', async () => {
    const ws = await (await fresh()).open('main', { ignore: ['*.log'] })
    await ws.files.write('app/index.html', 'v1\n')
    await ws.files.write('app/mine.log', 'mine\n')
    await ws.index.commit('start')
    const other = await ws.fork('other')
    await other.files.remove('app/mine.log')
    await other.files.write('app/index.html', 'taken\n')
    await other.files.write('app/theirs.log', 'theirs\n')
    await other.index.commit('theirs')
    await ws.checkout('other', { paths: ['app'] })
    expect(await ws.files.readText('app/index.html')).toBe('taken\n')
    expect(await ws.files.exists('app/theirs.log')).toBe(false)
    expect(await ws.files.readText('app/mine.log')).toBe('mine\n')
    await ws.checkout('other', { paths: ['app/theirs.log'] })
    expect(await ws.files.readText('app/theirs.log')).toBe('theirs\n')
    await other.close()
    await ws.close()
  })
})

describe('reading many files at once', () => {
  it('grep -r reads through a narrowed view and an attachment, as given', async () => {
    const store = await fresh()
    const ws = await seeded(store, {
      'auth.py': 'token = 1\n',
      'billing.py': 'token = 2\n',
      'lib/util.py': 'token = 3\n',
    })
    const other = await store.open('reviewer')
    await other.files.write('notes/review.md', 'token looks fine\n')
    await other.close()
    await ws.files.attach('reviewer', '/reviews')
    const out = await ws.terminal('grep -r token . /reviews')
    expect(out.stdout).toBe(
      './auth.py:token = 1\n./billing.py:token = 2\n./lib/util.py:token = 3\n/reviews/notes/review.md:token looks fine\n',
    )
    const child = await ws.fork('child', { paths: ['auth.py', 'lib'] })
    expect((await child.terminal('grep -rl token /workspace')).stdout).toBe(
      '/workspace/auth.py\n/workspace/lib/util.py\n',
    )
    const found = await child.files.fs.readMany?.(['auth.py', 'billing.py', '/workspace/lib'])
    expect([...(found?.keys() ?? [])]).toEqual(['auth.py'])
    await ws.close()
    await child.close()
  })

  it('a refused read through a view is an error, not a missing file', async () => {
    // A filesystem without readMany, refusing one file: the batch read
    // through a view must not pass the refusal off as an absence.
    const inner = new MemoryFS()
    Object.defineProperty(inner, 'readMany', { value: undefined })
    await inner.mkdir('/workspace/d', { parents: true })
    await inner.write('/workspace/d/open.txt', enc.encode('token\n'))
    await inner.write('/workspace/d/secret.txt', enc.encode('token\n'))
    const read = inner.read.bind(inner)
    inner.read = async (path: string) => {
      if (path.endsWith('secret.txt')) throw new FsError('EACCES', path)
      return read(path)
    }
    const view = new ViewFS(inner, '/workspace')
    await expect(
      view.readMany(['/workspace/d/open.txt', '/workspace/d/secret.txt']),
    ).rejects.toMatchObject({ code: 'EACCES' })
    expect([
      ...(
        await view.readMany(['/workspace/d/open.txt', '/workspace/d/nope', '/workspace/d'])
      ).keys(),
    ]).toEqual(['/workspace/d/open.txt'])
    await expect(execute('grep -r token /workspace/d', view)).rejects.toMatchObject({
      message: 'grep: /workspace/d/secret.txt: Permission denied',
      exitCode: 2,
    })
  })

  it("WorldFS reads a batch in two of the store's reads, one per file never", async () => {
    const store = await fresh()
    const ws = await store.open('s')
    for (let i = 0; i < 50; i++) await ws.files.fs.write(`/workspace/f${i}`, enc.encode(`${i}`))
    await ws.files.fs.mkdir('/workspace/d')
    const wt = await store.repo.worktree('s')
    let gets = 0
    let batches = 0
    const counting = {
      get: (k: string) => {
        gets++
        return wt.get(k)
      },
      getMany: (keys: Iterable<string>) => {
        batches++
        return wt.getMany(keys)
      },
      keys: () => wt.keys(),
    }
    // what the session committed, read through a counting view of it
    await ws.commit()
    await wt.refresh()
    const fs = new WorldFS(counting)
    const paths = [...Array.from({ length: 50 }, (_, i) => `/workspace/f${i}`), '/workspace/d', '/']
    const found = await fs.readMany(paths)
    expect(found.size).toBe(50)
    expect(new TextDecoder().decode(found.get('/workspace/f7'))).toBe('7')
    expect([gets, batches]).toEqual([0, 2])
    await ws.close()
  })
})
