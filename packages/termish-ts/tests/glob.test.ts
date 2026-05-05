import { describe, expect, it } from 'vitest'
import { MemoryFS } from '../src/fs/memory'
import { compileGlob, glob, globMatch, hasGlobChars } from '../src/glob'

const enc = new TextEncoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

describe('hasGlobChars', () => {
  it('detects glob metacharacters', () => {
    expect(hasGlobChars('*.ts')).toBe(true)
    expect(hasGlobChars('foo?bar')).toBe(true)
    expect(hasGlobChars('foo[abc]')).toBe(true)
    expect(hasGlobChars('plain.txt')).toBe(false)
  })
})

describe('compileGlob / globMatch', () => {
  it('matches with *', () => {
    expect(globMatch('*.ts', 'foo.ts')).toBe(true)
    expect(globMatch('*.ts', 'foo.js')).toBe(false)
    expect(globMatch('*.ts', 'a/b.ts')).toBe(false) // * doesn't cross /
  })

  it('matches with ?', () => {
    expect(globMatch('foo?', 'foo1')).toBe(true)
    expect(globMatch('foo?', 'foo')).toBe(false)
    expect(globMatch('foo?', 'foo12')).toBe(false)
  })

  it('matches char class', () => {
    expect(globMatch('foo[abc]', 'fooa')).toBe(true)
    expect(globMatch('foo[abc]', 'foox')).toBe(false)
  })

  it('matches negated char class', () => {
    expect(globMatch('foo[!abc]', 'foox')).toBe(true)
    expect(globMatch('foo[!abc]', 'fooa')).toBe(false)
  })

  it('matches with ** crossing slashes', () => {
    expect(globMatch('**/foo.ts', 'foo.ts')).toBe(true)
    expect(globMatch('**/foo.ts', 'a/foo.ts')).toBe(true)
    expect(globMatch('**/foo.ts', 'a/b/foo.ts')).toBe(true)
    expect(globMatch('**/foo.ts', 'a/foo.js')).toBe(false)
  })

  it('escapes regex metacharacters in literals', () => {
    expect(globMatch('foo.bar', 'foo.bar')).toBe(true)
    expect(globMatch('foo.bar', 'fooXbar')).toBe(false) // . is literal, not regex any
  })

  it('compiles to an anchored regex', () => {
    const r = compileGlob('*.ts')
    expect(r.source.startsWith('^')).toBe(true)
    expect(r.source.endsWith('$')).toBe(true)
  })
})

describe('glob over MemoryFS', () => {
  async function setup(): Promise<MemoryFS> {
    const fs = new MemoryFS()
    await fs.mkdir('/src/lib', { parents: true })
    await fs.mkdir('/src/cmd', { parents: true })
    await fs.mkdir('/data', { parents: true })
    await fs.write('/src/index.ts', bytes(''))
    await fs.write('/src/lib/util.ts', bytes(''))
    await fs.write('/src/lib/types.ts', bytes(''))
    await fs.write('/src/cmd/run.ts', bytes(''))
    await fs.write('/src/README.md', bytes(''))
    await fs.write('/data/users.csv', bytes(''))
    return fs
  }

  it('returns the path when there are no glob chars and the file exists', async () => {
    const fs = await setup()
    expect(await glob('/src/index.ts', fs)).toEqual(['/src/index.ts'])
  })

  it('returns empty when there are no glob chars and the file does not exist', async () => {
    const fs = await setup()
    expect(await glob('/src/nope.ts', fs)).toEqual([])
  })

  it('matches files in cwd via *.ts', async () => {
    const fs = await setup()
    await fs.chdir('/src')
    const got = await glob('*.ts', fs)
    expect(got).toEqual(['index.ts'])
  })

  it('matches files in a sub-directory', async () => {
    const fs = await setup()
    await fs.chdir('/')
    const got = await glob('src/lib/*.ts', fs)
    expect(got.sort()).toEqual(['src/lib/types.ts', 'src/lib/util.ts'])
  })

  it('matches recursively with **', async () => {
    const fs = await setup()
    await fs.chdir('/')
    const got = await glob('src/**/*.ts', fs)
    expect(got.sort()).toEqual([
      'src/cmd/run.ts',
      'src/index.ts',
      'src/lib/types.ts',
      'src/lib/util.ts',
    ])
  })

  it('matches absolute patterns', async () => {
    const fs = await setup()
    await fs.chdir('/data')
    const got = await glob('/src/lib/*.ts', fs)
    expect(got.sort()).toEqual(['/src/lib/types.ts', '/src/lib/util.ts'])
  })

  it('returns empty when nothing matches', async () => {
    const fs = await setup()
    await fs.chdir('/')
    const got = await glob('src/*.rs', fs)
    expect(got).toEqual([])
  })
})
