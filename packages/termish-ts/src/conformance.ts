/**
 * Executable form of the `FileSystem` protocol's documented behavior.
 *
 * Every adapter (MemoryFS, RealFS, KvgitFS, or one a host writes) must
 * pass these checks. They need no test framework:
 *
 *     import { checkFileSystem } from '@agex-ts/termish/conformance'
 *
 *     await checkFileSystem(() => new MyFS())   // throws FsConformanceError, or resolves
 *
 * `checkFileSystem` runs every case and throws on the first violation,
 * naming the case, the method and what was expected. To see each check
 * as its own test, register `fsConformanceCases` with your runner
 * instead; `checkFileSystem` is a loop over them.
 *
 * Each case gets a *fresh, empty* filesystem from the factory, with its
 * cwd at `/`, and works at absolute paths from the root.
 */

import type { FileSystem } from './fs/protocol'
import { glob } from './glob'

/** Returns a fresh, empty filesystem whose cwd is `/`. */
export type FsFactory = () => FileSystem | Promise<FileSystem>

/** One named check. `run` throws on a violation and resolves otherwise. */
export interface FsConformanceCase {
  /** The area it covers, such as `'mkdir'` or `'error codes'`. */
  readonly group: string
  /** What it checks; unique within its group. */
  readonly name: string
  run(fs: FileSystem): Promise<void>
}

/** A filesystem that answered a check wrongly. */
export class FsConformanceError extends Error {
  override readonly name = 'FsConformanceError'
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

function show(value: unknown): string {
  if (value instanceof Uint8Array) return `bytes ${JSON.stringify(dec.decode(value))}`
  if (value === undefined) return 'undefined'
  return JSON.stringify(value)
}

function fail(method: string, message: string): never {
  throw new FsConformanceError(`${method}: ${message}`)
}

function same(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Uint8Array && expected instanceof Uint8Array) {
    return actual.length === expected.length && actual.every((b, i) => b === expected[i])
  }
  return JSON.stringify(actual) === JSON.stringify(expected)
}

function expectEqual(method: string, what: string, actual: unknown, expected: unknown): void {
  if (!same(actual, expected)) {
    fail(method, `${what}; expected ${show(expected)}, got ${show(actual)}`)
  }
}

function expectText(method: string, what: string, actual: Uint8Array, expected: string): void {
  expectEqual(method, what, actual, bytes(expected))
}

function expectSorted(method: string, what: string, actual: string[], expected: string[]): void {
  expectEqual(method, what, [...actual].sort(), [...expected].sort())
}

/** `call` must reject, with `code` when one is given. */
async function expectRejects(
  method: string,
  what: string,
  call: () => Promise<unknown>,
  code?: string,
): Promise<void> {
  let result: unknown
  try {
    result = await call()
  } catch (err) {
    if (code === undefined) return
    const got = (err as { code?: unknown } | null)?.code
    if (got === code) return
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    fail(method, `${what}; expected an error with code ${code}, got code ${show(got)} (${detail})`)
  }
  fail(
    method,
    `${what}; expected ${code === undefined ? 'an error' : `an error with code ${code}`}, but it resolved to ${show(result)}`,
  )
}

function check(group: string, name: string, run: (fs: FileSystem) => Promise<void>) {
  return { group, name, run }
}

/** Every check, in the order `checkFileSystem` runs them. */
export const fsConformanceCases: readonly FsConformanceCase[] = Object.freeze([
  // cwd / chdir
  check('cwd / chdir', 'cwd defaults to /', async (fs) => {
    expectEqual('getcwd', 'a fresh filesystem', fs.getcwd(), '/')
  }),
  check('cwd / chdir', 'chdir to an existing directory updates cwd', async (fs) => {
    await fs.mkdir('/foo', { parents: true })
    await fs.chdir('/foo')
    expectEqual('getcwd', 'the directory chdir was just given', fs.getcwd(), '/foo')
    await fs.chdir('/')
    expectEqual('getcwd', 'back at the root', fs.getcwd(), '/')
  }),
  check('cwd / chdir', 'chdir to a missing directory throws', async (fs) => {
    await expectRejects('chdir', 'changing to a directory that does not exist', () =>
      fs.chdir('/nope'),
    )
  }),
  check('cwd / chdir', 'relative paths resolve against cwd', async (fs) => {
    await fs.mkdir('/base', { parents: true })
    await fs.chdir('/base')
    await fs.write('relfile', bytes('hi'))
    expectText(
      'write',
      'a relative path is written under cwd',
      await fs.read('/base/relfile'),
      'hi',
    )
    expectText('read', 'a relative path is read from cwd', await fs.read('relfile'), 'hi')
  }),
  check('cwd / chdir', 'list and listDetailed default to cwd', async (fs) => {
    await fs.mkdir('/here', { parents: true })
    await fs.write('/here/a', bytes('1'))
    await fs.write('/here/b', bytes('2'))
    await fs.write('/elsewhere', bytes('3'))
    await fs.chdir('/here')
    expectSorted('list', 'listing cwd when given no path', await fs.list(), ['a', 'b'])
    expectSorted(
      'listDetailed',
      'listing cwd when given no path',
      (await fs.listDetailed()).map((e) => e.name),
      ['a', 'b'],
    )
  }),

  // read / write round trip
  check('read / write round trip', 'writes and reads back bytes', async (fs) => {
    await fs.write('/k', bytes('v'))
    expectText('read', 'reading back what write stored', await fs.read('/k'), 'v')
  }),
  check('read / write round trip', 'overwrites with mode w (default)', async (fs) => {
    await fs.write('/k', bytes('v1'))
    await fs.write('/k', bytes('v2'))
    expectText('write', 'the default mode replaces the file', await fs.read('/k'), 'v2')
    await fs.write('/k', bytes('v3'), 'w')
    expectText('write', "mode 'w' replaces the file", await fs.read('/k'), 'v3')
  }),
  check('read / write round trip', 'appends with mode a', async (fs) => {
    await fs.write('/k', bytes('v1'))
    await fs.write('/k', bytes('v2'), 'a')
    expectText('write', "mode 'a' appends", await fs.read('/k'), 'v1v2')
  }),
  check('read / write round trip', 'mode a creates a missing file', async (fs) => {
    await fs.write('/new', bytes('start'), 'a')
    expectText(
      'write',
      "mode 'a' on a file that does not exist yet creates it",
      await fs.read('/new'),
      'start',
    )
  }),
  check('read / write round trip', 'read on missing file throws', async (fs) => {
    await expectRejects('read', 'reading a path that does not exist', () => fs.read('/nope'))
  }),
  check('read / write round trip', 'read on a directory throws', async (fs) => {
    await fs.mkdir('/dir', { parents: true })
    await expectRejects('read', 'reading a directory', () => fs.read('/dir'))
  }),
  check(
    'read / write round trip',
    'write to a path whose parent does not exist throws',
    async (fs) => {
      await expectRejects('write', 'writing under a missing directory', () =>
        fs.write('/nope/k', bytes('v')),
      )
    },
  ),

  // exists / isFile / isDir
  check('exists / isFile / isDir', 'reflects file existence', async (fs) => {
    expectEqual('exists', '/k was never written', await fs.exists('/k'), false)
    await fs.write('/k', bytes('v'))
    expectEqual('exists', '/k was just written', await fs.exists('/k'), true)
    expectEqual('isFile', '/k was just written', await fs.isFile('/k'), true)
    expectEqual('isDir', '/k is a file', await fs.isDir('/k'), false)
  }),
  check('exists / isFile / isDir', 'reflects directory existence', async (fs) => {
    await fs.mkdir('/d', { parents: true })
    await fs.write('/d/file', bytes('x'))
    expectEqual('exists', '/d was just created', await fs.exists('/d'), true)
    expectEqual('isDir', '/d was just created', await fs.isDir('/d'), true)
    expectEqual('isFile', '/d is a directory', await fs.isFile('/d'), false)
  }),
  check('exists / isFile / isDir', 'all report false for a missing path', async (fs) => {
    expectEqual('exists', '/nope was never created', await fs.exists('/nope'), false)
    expectEqual('isFile', '/nope was never created', await fs.isFile('/nope'), false)
    expectEqual('isDir', '/nope was never created', await fs.isDir('/nope'), false)
  }),

  // mkdir
  check('mkdir', 'creates a directory', async (fs) => {
    await fs.mkdir('/newdir')
    expectEqual('isDir', '/newdir was just created by mkdir', await fs.isDir('/newdir'), true)
  }),
  check('mkdir', 'errors on existing dir without existOk', async (fs) => {
    await fs.mkdir('/d')
    await expectRejects('mkdir', 'creating a directory that already exists', () => fs.mkdir('/d'))
  }),
  check('mkdir', 'is a no-op on existing dir with existOk', async (fs) => {
    await fs.mkdir('/d')
    await fs.mkdir('/d', { existOk: true })
    expectEqual('isDir', '/d after a second mkdir with existOk', await fs.isDir('/d'), true)
  }),
  check('mkdir', 'errors without parents when intermediate dir is missing', async (fs) => {
    await expectRejects('mkdir', 'creating /a/b/c when /a is missing', () => fs.mkdir('/a/b/c'))
  }),
  check('mkdir', 'creates intermediates with parents: true', async (fs) => {
    await fs.mkdir('/a/b/c', { parents: true })
    for (const path of ['/a', '/a/b', '/a/b/c']) {
      expectEqual('mkdir', `parents: true should have created ${path}`, await fs.isDir(path), true)
    }
  }),

  // remove / rmdir
  check('remove / rmdir', 'remove deletes a file', async (fs) => {
    await fs.write('/k', bytes('v'))
    await fs.remove('/k')
    expectEqual('remove', '/k was just removed', await fs.exists('/k'), false)
  }),
  check('remove / rmdir', 'remove on a missing file throws', async (fs) => {
    await expectRejects('remove', 'removing a path that does not exist', () => fs.remove('/nope'))
  }),
  check('remove / rmdir', 'remove on a directory throws', async (fs) => {
    await fs.mkdir('/d')
    await expectRejects('remove', 'removing a directory', () => fs.remove('/d'))
  }),
  check('remove / rmdir', 'rmdir deletes an empty directory', async (fs) => {
    await fs.mkdir('/d')
    await fs.rmdir('/d')
    expectEqual('rmdir', '/d was just removed', await fs.exists('/d'), false)
  }),
  check('remove / rmdir', 'rmdir errors on a non-empty directory', async (fs) => {
    await fs.mkdir('/d')
    await fs.write('/d/file', bytes('x'))
    await expectRejects('rmdir', 'removing a directory that still has children', () =>
      fs.rmdir('/d'),
    )
  }),

  // rename
  check('rename', 'renames a file', async (fs) => {
    await fs.write('/a', bytes('v'))
    await fs.rename('/a', '/b')
    expectEqual('rename', 'the source is gone afterwards', await fs.exists('/a'), false)
    expectText('rename', 'contents survive the move', await fs.read('/b'), 'v')
  }),
  check('rename', 'renames a directory and its contents', async (fs) => {
    await fs.mkdir('/old', { parents: true })
    await fs.write('/old/file', bytes('hi'))
    await fs.mkdir('/old/sub', { parents: true })
    await fs.write('/old/sub/inner', bytes('inner'))
    await fs.rename('/old', '/new')
    expectEqual('rename', 'the source directory is gone', await fs.exists('/old'), false)
    expectEqual('rename', 'the destination directory exists', await fs.isDir('/new'), true)
    expectText('rename', 'children move with their directory', await fs.read('/new/file'), 'hi')
    expectText('rename', 'grandchildren move too', await fs.read('/new/sub/inner'), 'inner')
    expectEqual('rename', 'subdirectories move too', await fs.isDir('/new/sub'), true)
  }),
  check('rename', 'rename on a missing source throws', async (fs) => {
    await expectRejects('rename', 'moving a path that does not exist', () =>
      fs.rename('/nope', '/new'),
    )
  }),

  // list / listDetailed
  check('list / listDetailed', 'list returns direct children', async (fs) => {
    await fs.mkdir('/d', { parents: true })
    await fs.write('/d/a', bytes('1'))
    await fs.write('/d/b', bytes('2'))
    await fs.mkdir('/d/sub', { parents: true })
    await fs.write('/d/sub/inner', bytes('3'))
    expectSorted('list', 'entries of /d relative to it', await fs.list('/d'), ['a', 'b', 'sub'])
  }),
  check('list / listDetailed', 'list recursive returns all descendants', async (fs) => {
    await fs.mkdir('/d', { parents: true })
    await fs.write('/d/a', bytes('1'))
    await fs.mkdir('/d/sub', { parents: true })
    await fs.write('/d/sub/inner', bytes('2'))
    expectSorted(
      'list',
      'recursive entries of /d relative to it',
      await fs.list('/d', { recursive: true }),
      ['a', 'sub', 'sub/inner'],
    )
  }),
  check('list / listDetailed', 'listDetailed reports name, path, size and isDir', async (fs) => {
    await fs.mkdir('/d', { parents: true })
    await fs.write('/d/file', bytes('hello'))
    await fs.mkdir('/d/sub', { parents: true })
    const got = await fs.listDetailed('/d')
    expectSorted(
      'listDetailed',
      'path is the queried directory joined to the entry',
      got.map((e) => e.path),
      ['/d/file', '/d/sub'],
    )
    const file = got.find((e) => e.path === '/d/file')
    const sub = got.find((e) => e.path === '/d/sub')
    expectEqual('listDetailed', 'name is the basename', file?.name, 'file')
    expectEqual('listDetailed', 'isDir for a file', file?.isDir, false)
    expectEqual('listDetailed', 'size of a 5-byte file', file?.size, 5)
    expectEqual('listDetailed', 'name is the basename', sub?.name, 'sub')
    expectEqual('listDetailed', 'isDir for a directory', sub?.isDir, true)
  }),
  check(
    'list / listDetailed',
    'listDetailed recursive keeps the queried prefix and basenames',
    async (fs) => {
      await fs.mkdir('/d/sub', { parents: true })
      await fs.write('/d/one', bytes('1'))
      await fs.write('/d/sub/two', bytes('22'))
      const got = await fs.listDetailed('/d', { recursive: true })
      expectSorted(
        'listDetailed',
        'recursive paths keep the queried directory as their prefix',
        got.map((e) => e.path),
        ['/d/one', '/d/sub', '/d/sub/two'],
      )
      const nested = got.find((e) => e.path === '/d/sub/two')
      expectEqual(
        'listDetailed',
        'name is the basename, not the relative path',
        nested?.name,
        'two',
      )
      expectEqual('listDetailed', 'size of a 2-byte file', nested?.size, 2)
    },
  ),
  check('list / listDetailed', 'list on a missing path throws', async (fs) => {
    await expectRejects('list', 'listing a path that does not exist', () => fs.list('/nope'))
  }),

  // glob, the standalone helper, over the filesystem
  check('glob', 'glob() matches only the files the pattern names', async (fs) => {
    await fs.mkdir('/g', { parents: true })
    for (const name of ['a.txt', 'b.txt', 'c.md']) await fs.write(`/g/${name}`, bytes(name))
    expectSorted(
      'glob',
      "'/g/*.txt' should match the two .txt files and nothing else",
      await glob('/g/*.txt', fs),
      ['/g/a.txt', '/g/b.txt'],
    )
  }),

  // error codes: a builtin words its diagnostic by the code
  // (`describeFsError`), so every adapter reports the POSIX one.
  check('error codes', 'reports ENOENT, EISDIR, ENOTDIR, EEXIST and ENOTEMPTY', async (fs) => {
    await fs.mkdir('/d/sub', { parents: true })
    await fs.write('/f', bytes('x'))
    await expectRejects('read', 'a missing path', () => fs.read('/nope'), 'ENOENT')
    await expectRejects('stat', 'a missing path', () => fs.stat('/nope'), 'ENOENT')
    await expectRejects('remove', 'a missing path', () => fs.remove('/nope'), 'ENOENT')
    await expectRejects('list', 'a missing path', () => fs.list('/nope'), 'ENOENT')
    await expectRejects('chdir', 'a missing path', () => fs.chdir('/nope'), 'ENOENT')
    await expectRejects('read', 'a directory', () => fs.read('/d'), 'EISDIR')
    await expectRejects('chdir', 'a file', () => fs.chdir('/f'), 'ENOTDIR')
    await expectRejects('mkdir', 'an existing directory', () => fs.mkdir('/d'), 'EEXIST')
    await expectRejects('rmdir', 'a non-empty directory', () => fs.rmdir('/d'), 'ENOTEMPTY')
  }),
  check(
    'a parent that is not a directory',
    'is ENOTDIR when it is a file, ENOENT when it is missing',
    async (fs) => {
      await fs.write('/file', bytes('x'))
      const y = bytes('y')
      await expectRejects('write', 'under a file', () => fs.write('/file/child', y), 'ENOTDIR')
      await expectRejects('write', 'deep under a file', () => fs.write('/file/a/b', y), 'ENOTDIR')
      await expectRejects('mkdir', 'under a file', () => fs.mkdir('/file/sub'), 'ENOTDIR')
      await expectRejects(
        'rename',
        'onto a path under a file',
        () => fs.rename('/file', '/file/moved'),
        'ENOTDIR',
      )
      await expectRejects(
        'write',
        'under a missing dir',
        () => fs.write('/nope/child', y),
        'ENOENT',
      )
      await expectRejects('mkdir', 'under a missing dir', () => fs.mkdir('/nope/sub'), 'ENOENT')
    },
  ),

  // stat
  check('stat', 'returns size + isDir for a file', async (fs) => {
    await fs.write('/f', bytes('hello'))
    const s = await fs.stat('/f')
    expectEqual('stat', 'size of a 5-byte file', s.size, 5)
    expectEqual('stat', 'isDir for a file', s.isDir, false)
    for (const field of ['createdAt', 'modifiedAt'] as const) {
      if (typeof s[field] !== 'string') {
        fail('stat', `${field} should be an ISO 8601 string, got ${show(s[field])}`)
      }
    }
  }),
  check('stat', 'returns isDir true for a directory', async (fs) => {
    await fs.mkdir('/d')
    const s = await fs.stat('/d')
    expectEqual('stat', 'isDir for a directory', s.isDir, true)
    expectEqual('stat', 'size of a directory', s.size, 0)
  }),
  check('stat', 'throws on a missing path', async (fs) => {
    await expectRejects('stat', 'a path that does not exist', () => fs.stat('/nope'))
  }),
])

/**
 * Run every case in `fsConformanceCases`, each against a fresh
 * filesystem from `makeFs`, and throw an `FsConformanceError` on the
 * first one that fails. Its message reads `group > case: method: what;
 * expected ..., got ...`. A filesystem method that throws on a valid
 * call is reported the same way, with the original error as `cause`.
 */
export async function checkFileSystem(makeFs: FsFactory): Promise<void> {
  for (const c of fsConformanceCases) {
    try {
      await c.run(await makeFs())
    } catch (err) {
      const where = `${c.group} > ${c.name}`
      if (err instanceof FsConformanceError) {
        throw new FsConformanceError(`${where}: ${err.message}`, { cause: err })
      }
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      throw new FsConformanceError(`${where}: threw on a valid call (${detail})`, { cause: err })
    }
  }
}
