/**
 * The kernel, run in a Node `worker_threads` worker from the built
 * `dist/worker.node.js` (build the package before testing).
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  type CodeSettings,
  InvalidNameError,
  MAX_IMAGES,
  type Profile,
  ReadOnlyError,
  Store,
  type Workspace,
  hostFactory,
  typedHost,
  withCall,
  withStub,
} from '../src/index'
import { BACKENDS, newKV, newStore } from './backends'

const WORKER = new URL('../dist/worker.node.js', import.meta.url)

beforeAll(() => {
  if (!existsSync(fileURLToPath(WORKER))) {
    throw new Error('build @agex-ts/world first: the kernel tests run its built Node worker')
  }
})

const code = (extra: CodeSettings = {}): CodeSettings => ({
  worker: { target: 'node', url: WORKER },
  ...extra,
})

async function open(profile: Profile = {}, session = 's'): Promise<Workspace> {
  const store = await Store.open(await newKV())
  return store.open(session, { profile: { ...profile, code: code(profile.code) } })
}

const tools = async (ws: Workspace): Promise<unknown[]> =>
  (await ws.log()).map((c) => c.info?.tool).reverse()

describe('running code', () => {
  it('captures the console, a returned value, and commits nothing for no change', async () => {
    const ws = await open()
    const out = await ws.runCode(`
      console.log('hello', { n: 1 })
      console.info('info')
      console.warn('careful')
      console.error('bad', 2)
      const n: number = 40
      return n + 2
    `)
    expect(out.stdout).toBe('hello {"n":1}\ninfo')
    expect(out.stderr).toBe('careful\nbad 2')
    expect(out.value).toBe('42')
    expect(out.error).toBeNull()
    expect(out.commit).toBeNull()
    expect(out.duration).toBeGreaterThan(0)
    await ws.close()
  })

  it('writes files, committed as run_ts, with relative paths from the cwd', async () => {
    const ws = await open()
    const out = await ws.runCode(`
      await fs.write('notes.txt', 'hi')
      await fs.mkdir('sub')
      await fs.chdir('sub')
      await fs.writeText('inner.txt', 'deep')
      return [await fs.read('/workspace/notes.txt', 'utf8'), await fs.getcwd()]
    `)
    expect(out.value).toBe('["hi","/workspace/sub"]')
    expect(out.commit).toBe(ws.head)
    expect(await tools(ws)).toEqual(['init', 'run_ts'])
    expect(await ws.files.readText('/workspace/sub/inner.txt')).toBe('deep')
    expect(ws.files.fs.getcwd()).toBe('/workspace/sub')
    await ws.close()
  })

  it('reports what the code threw, and still commits what it wrote first', async () => {
    const ws = await open()
    const out = await ws.runCode(`
      await fs.write('before.txt', 'kept')
      throw new RangeError('nope')
    `)
    expect(out.error).toMatchObject({ name: 'RangeError', message: 'nope' })
    expect(out.commit).not.toBeNull()
    expect(await ws.files.readText('before.txt')).toBe('kept')
    await ws.close()
  })

  it('reports a syntax error without running anything', async () => {
    const ws = await open()
    const out = await ws.runCode('const = 1')
    expect(out.error?.name).toBe('SyntaxError')
    expect(out.commit).toBeNull()
    await ws.close()
  })

  it('keeps nothing between runs but files and cache', async () => {
    const ws = await open()
    await ws.runCode(`let x = 1; cache.set('k', { n: 1 })`)
    const out = await ws.runCode(`return [typeof x, await cache.get('k')]`)
    expect(out.value).toBe('["undefined",{"n":1}]')
    expect(await ws.cache.get('k')).toEqual({ n: 1 })
    await ws.close()
  })

  it('reads its variables as env, and never sees secrets', async () => {
    const ws = await open({
      variables: { API_URL: 'https://x.test' },
      secrets: { TOKEN: 's3cret' },
    })
    const out = await ws.runCode(`
      try { (env as any).API_URL = 'changed' } catch {}
      return env
    `)
    expect(out.value).toBe('{"API_URL":"https://x.test"}')
    await ws.close()
  })

  it('shows images, and cuts long output', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const ws = await open({ code: { maxObservation: 10 } })
    const out = await ws.runCode(`
      console.log('see', new Uint8Array(${JSON.stringify([...png])}))
      console.log('x'.repeat(50))
    `)
    expect(out.images).toEqual([{ format: 'png', data: Buffer.from(png).toString('base64') }])
    expect(out.stdout).toBe('see\nxxxxxx')
    expect(out.truncated).toBe(true)
    await ws.close()
  })
})

describe('the files from code', () => {
  it('writes and appends into directories that are missing, as file_write does', async () => {
    const ws = await open()
    const out = await ws.runCode(`
      await fs.write('app/systems/hearth/index.js', 'one')
      await fs.write('/workspace/logs/today/run.log', 'a', 'a')
      await fs.write('logs/today/run.log', 'b', 'a')
      return [
        await fs.read('app/systems/hearth/index.js', 'utf8'),
        await fs.read('logs/today/run.log', 'utf8'),
        await fs.isDir('app/systems'),
      ]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('["one","ab",true]')
    expect(await ws.files.readText('app/systems/hearth/index.js')).toBe('one')
    await ws.close()
  })

  it('refuses a write under a file, making no directories', async () => {
    const ws = await open()
    await ws.files.write('notes.txt', 'n')
    const out = await ws.runCode(`
      const codes = []
      for (const path of ['notes.txt/x.js', 'notes.txt/deeper/x.js']) {
        try { await fs.write(path, 'x') } catch (e) { codes.push([e.name, e.code]) }
      }
      return [codes, await fs.list('.')]
    `)
    expect(out.value).toBe('[[["FsError","ENOTDIR"],["FsError","ENOTDIR"]],["notes.txt"]]')
    await ws.close()
  })

  it("mkdir takes Node's recursive, and refuses options it doesn't know", async () => {
    const ws = await open()
    const out = await ws.runCode(`
      await fs.mkdir('a/b/c', { recursive: true })
      await fs.mkdir('a/b/c', { recursive: true })
      await fs.mkdir('a/b/c', { recursive: true, existOk: false })
      await fs.mkdir('r/s', { recursive: true, parents: false })
      await fs.mkdir('p/q', { parents: true })
      const errors = []
      for (const call of [
        () => fs.mkdir('a/b/c', { parents: true }),
        () => fs.mkdir('m', { mode: 0o755 }),
        () => fs.mkdir('m', { recursive: true, mode: 0o755, force: true }),
        () => fs.mkdir('m', 0o755),
        () => fs.list('.', { withFileTypes: true }),
      ]) {
        try { await call() } catch (e) { errors.push(e.name + ': ' + e.message) }
      }
      return [await fs.isDir('a/b/c') && await fs.isDir('r/s'), await fs.isDir('p/q'), await fs.exists('m'), errors]
    `)
    expect(out.error).toBeNull()
    expect(JSON.parse(out.value as string)).toEqual([
      true,
      true,
      false,
      [
        'FsError: File exists: a/b/c (resolved to /workspace/a/b/c; cwd /workspace)',
        "TypeError: fs.mkdir: unknown option 'mode' (it takes parents, existOk, recursive)",
        "TypeError: fs.mkdir: unknown options 'mode', 'force' (it takes parents, existOk, recursive)",
        'TypeError: fs.mkdir: options must be an object (it takes parents, existOk, recursive)',
        "TypeError: fs.list: unknown option 'withFileTypes' (it takes recursive)",
      ],
    ])
    await ws.close()
  })

  it("remove takes fs.rm's recursive and force, and rmdir recursive", async () => {
    const ws = await open()
    await ws.files.write('old/a.txt', 'a')
    await ws.files.write('old/deep/b.txt', 'b')
    await ws.files.write('also/c.txt', 'c')
    await ws.files.write('keep.txt', 'k')
    const out = await ws.runCode(`
      const errors = []
      for (const call of [
        () => fs.remove('old'),
        () => fs.remove('gone.txt'),
        () => fs.remove('old', { recursive: true, maxRetries: 3 }),
        () => fs.remove('/', { recursive: true }),
      ]) {
        try { await call() } catch (e) { errors.push(e.name + ': ' + e.message) }
      }
      await fs.remove('old/', { recursive: true })
      await fs.rmdir('also', { recursive: true })
      await fs.remove('gone.txt', { force: true })
      await fs.remove('keep.txt', { recursive: true })
      return [await fs.list('.'), errors]
    `)
    expect(out.error).toBeNull()
    expect(JSON.parse(out.value as string)).toEqual([
      [],
      [
        'FsError: Is a directory: old (resolved to /workspace/old; cwd /workspace)',
        'FsError: No such file or directory: gone.txt (resolved to /workspace/gone.txt; cwd /workspace)',
        "TypeError: fs.remove: unknown option 'maxRetries' (it takes recursive, force)",
        'FsError: Cannot remove the root: /',
      ],
    ])
    expect(await ws.terminal('ls -a')).toMatchObject({ stdout: '' })
    await ws.close()
  })

  it('names the resolved path and the cwd when a relative path fails', async () => {
    const ws = await open()
    await ws.files.write('app/systems/research/index.js', 'r')
    await ws.terminal('cd /workspace/app/systems')
    const out = await ws.runCode(`
      const errors = []
      for (const call of [
        () => fs.read('app/systems/research/index.js'),
        () => fs.read('/workspace/missing.js'),
        () => fs.read('research'),
        () => fs.chdir('../nowhere'),
        () => fs.mkdir('x/y'),
      ]) {
        try { await call() } catch (e) { errors.push([e.code, e.message]) }
      }
      return [await fs.read('research/index.js', 'utf8'), errors]
    `)
    expect(JSON.parse(out.value as string)).toEqual([
      'r',
      [
        [
          'ENOENT',
          'No such file or directory: app/systems/research/index.js (resolved to /workspace/app/systems/app/systems/research/index.js; cwd /workspace/app/systems)',
        ],
        ['ENOENT', 'No such file or directory: /workspace/missing.js'],
        [
          'EISDIR',
          'Is a directory: research (resolved to /workspace/app/systems/research; cwd /workspace/app/systems)',
        ],
        [
          'ENOENT',
          'No such file or directory: ../nowhere (resolved to /workspace/app/nowhere; cwd /workspace/app/systems)',
        ],
        ['ENOENT', 'No such file or directory: /workspace/app/systems/x'],
      ],
    ])
    await ws.close()
  })
})

describe('bounded output', () => {
  it('keeps no more than maxObservation of a stream while code prints', async () => {
    const ws = await open({ code: { maxObservation: 5000 } })
    const out = await ws.runCode(`
      for (let i = 0; i < 2000; i++) console.log('x'.repeat(1000))
      console.error('e')
    `)
    expect(out.stdout.length).toBe(5000)
    expect(out.stderr).toBe('e')
    expect(out.truncated).toBe(true)
    await ws.close()
  })

  it('keeps a bounded number of images', async () => {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]
    const ws = await open()
    const out = await ws.runCode(
      `for (let i = 0; i < 40; i++) console.log(new Uint8Array(${JSON.stringify(png)}))`,
    )
    expect(out.images).toHaveLength(MAX_IMAGES)
    expect(out.truncated).toBe(true)
    await ws.close()
  })
})

describe('stopping code', () => {
  it('stops a run that takes too long, keeping its writes, and runs again after', async () => {
    const ws = await open({ code: { timeout: 0.5 } })
    const out = await ws.runCode(`
      await fs.write('started.txt', 'yes')
      while (true) {}
    `)
    expect(out.error).toMatchObject({ name: 'TimeoutError' })
    expect(out.commit).not.toBeNull()
    expect(await ws.files.readText('started.txt')).toBe('yes')
    expect((await ws.runCode('return 1')).value).toBe('1')
    await ws.close()
  })

  it('interrupts a run, which commits what it wrote', async () => {
    const ws = await open()
    expect(ws.interrupt()).toBe(false)
    const running = ws.runCode(`
      // Printed before the write: messages arrive in order, so by the
      // time the file exists, the output has arrived too.
      console.log('waiting')
      await fs.write('partial.txt', 'yes')
      await new Promise((r) => setTimeout(r, 30_000))
    `)
    while (!(await ws.files.exists('partial.txt'))) await new Promise((r) => setTimeout(r, 10))
    expect(ws.interrupt()).toBe(true)
    const out = await running
    expect(out.error).toEqual({ name: 'CancelledError', message: 'cancelled' })
    expect(out.stdout).toBe('waiting')
    expect(out.commit).not.toBeNull()
    expect((await ws.runCode('return 2')).value).toBe('2')
    await ws.close()
  })

  it('a closed workspace runs nothing', async () => {
    const ws = await open()
    await ws.close()
    await expect(ws.runCode('return 1')).rejects.toThrow(ReadOnlyError)
  })
})

describe('host objects', () => {
  class Counter {
    #n = 0
    add(by: number): number {
      this.#n += by
      return this.#n
    }
    async later(v: string): Promise<string> {
      return `later ${v}`
    }
    fail(): never {
      throw new TypeError('host says no')
    }
    giveFunction(): () => void {
      return () => {}
    }
    _secret(): string {
      return 'hidden'
    }
  }

  it('are bindings, members of host, and importable from host', async () => {
    const counter = new Counter()
    const ws = await open({ hostObjects: { counter, math: { double: (x: number) => x * 2 } } })
    const out = await ws.runCode(`
      import { math as m } from 'host'
      const a = await counter.add(2)
      const b = await host.counter.add(3)
      return [a, b, await m.double(21), await counter.later('x')]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('[2,5,42,"later x"]')
    expect(counter.add(0)).toBe(5)
    await ws.close()
  })

  it('expose public methods only, and their errors reach the code', async () => {
    const ws = await open({ hostObjects: { counter: new Counter() } })
    const out = await ws.runCode(`
      const seen = []
      try { await counter.fail() } catch (e) { seen.push(e.name + ': ' + e.message) }
      try { await counter.giveFunction() } catch (e) { seen.push(e.name) }
      seen.push(typeof counter._secret)
      return seen
    `)
    expect(out.value).toBe('["TypeError: host says no","DataCloneError","undefined"]')
    await ws.close()
  })

  it('made by a factory are made per world, forks included', async () => {
    const made: string[] = []
    const ws = await open({
      hostObjects: {
        who: hostFactory((w) => {
          made.push(w.session)
          return { session: () => w.session }
        }),
      },
    })
    const child = await ws.fork('child')
    expect((await child.runCode('return await who.session()')).value).toBe('child')
    expect((await ws.runCode('return await who.session()')).value).toBe('s')
    expect(made).toEqual(['s', 'child'])
    await child.close()
    await ws.close()
  })

  it('declared withCall change the workspace as part of the code call', async () => {
    const ws = await open({
      hostObjects: {
        sessions: {
          fork: withCall(async (call, name: string) => {
            if (call === undefined) throw new Error('only from code')
            const child = await call.ws.fork(name)
            await child.files.write('from-host.txt', 'made by the host')
            await call.ws.files.write('parent-note.txt', 'noted')
            return child.session
          }),
        },
      },
    })
    const out = await ws.runCode(`
      await fs.write('before-fork.txt', 'in the fork')
      const child = await sessions.fork('delegate')
      await fs.write('after-fork.txt', 'not in the fork')
      return child
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('delegate')
    expect(await tools(ws)).toEqual(['init', 'fork', 'file_write', 'run_ts'])
    const child = await ws.store.open('delegate')
    expect(await child.files.readText('before-fork.txt')).toBe('in the fork')
    expect(await child.files.exists('after-fork.txt')).toBe(false)
    expect(await ws.files.readText('parent-note.txt')).toBe('noted')
    await expect(ws.store.open('s').then((w) => w.runCode('1'))).resolves.toBeDefined()
    await child.close()
    await ws.close()
  })

  it('refuses names code already has', async () => {
    const store = await Store.open(await newKV())
    for (const name of ['fs', 'env', 'host', 'console', 'class', '1x']) {
      await expect(store.open('s', { profile: { hostObjects: { [name]: {} } } })).rejects.toThrow(
        InvalidNameError,
      )
    }
    await expect(store.open('s', { profile: { variables: { 'A-B': 'x' } } })).rejects.toThrow(
      InvalidNameError,
    )
  })
})

describe("the code's own time", () => {
  it('leaves out a host object’s calls', async () => {
    const slow = { wait: () => new Promise((resolve) => setTimeout(() => resolve('waited'), 1500)) }
    const ws = await open({ hostObjects: { slow }, code: { timeout: 1 } })
    const out = await ws.runCode(
      'const a = await slow.wait()\nconst b = await slow.wait()\nreturn a + b',
    )
    expect([out.error, out.value]).toEqual([null, 'waitedwaited'])
    // the code's own time still counts
    const spin = await ws.runCode(
      'await slow.wait()\nconst t = Date.now(); while (Date.now() - t < 1500) {}',
    )
    expect(spin.error?.name).toBe('TimeoutError')
    await ws.close()
  }, 15_000)

  it('counts again past hostTime, so code beside a call it never awaits still stops', async () => {
    const never = { wait: () => new Promise(() => {}) }
    const ws = await open({ hostObjects: { never }, code: { timeout: 1, hostTime: 1 } })
    const started = Date.now()
    const out = await ws.runCode('never.wait()\nwhile (true) {}')
    expect(out.error?.name).toBe('TimeoutError')
    expect(Date.now() - started).toBeLessThan(4000)
    await ws.close()
  }, 15_000)
})

describe('stubs', () => {
  const STUB = `(remote) => {
    class Refused extends Error { name = 'Refused' }
    return {
      Refused,
      shout(word) {
        if (typeof word !== 'string') throw new Refused('a word, please')
        const loud = async () => (await remote.upper(word)) + '!'
        loud.twice = async () => (await loud()).repeat(2)
        return loud
      },
    }
  }`

  it('stand in front of a host object, giving code what can’t cross', async () => {
    const ws = await open({
      hostObjects: {
        words: withStub(
          typedHost(
            hostFactory(() => ({ upper: (w: string) => w.toUpperCase() })),
            {
              upper: { args: [z.string()], returns: z.string() },
            },
          ),
          STUB,
        ),
      },
    })
    const out = await ws.runCode(
      "import { words as same } from 'host'\nconst hi = words.shout('hi')\ntry { same.shout(7) } catch (e) { console.log(e instanceof words.Refused, e.message) }\nreturn [await hi(), await hi.twice()]",
    )
    expect(out.error).toBeNull()
    expect(out.stdout).toBe('true a word, please')
    expect(out.value).toBe('["HI!","HI!HI!"]')
    await ws.close()
  })

  it('a stub that throws fails the run, naming its object', async () => {
    const ws = await open({
      hostObjects: { bad: withStub({}, '() => { throw new Error("nope") }') },
    })
    const out = await ws.runCode('return 1')
    expect(out.error?.message).toBe("host object bad's stub failed: nope")
    expect((await ws.runCode('return 2')).error?.message).toMatch(/stub failed/)
    await ws.close()
    expect(() => withStub({}, '')).toThrow(/a stub is a function's source/)
  })
})

describe('values', () => {
  it('are bindings, a fresh copy in every run', async () => {
    const scores = [{ student: 'ada', total: 7 }]
    const ws = await open({ values: { scores, bytes: new Uint8Array([0, 1, 255]) } })
    const first = await ws.runCode('scores[0].total = 99; return scores[0].total')
    expect(first.value).toBe('99')
    const second = await ws.runCode('return [scores[0].total, bytes instanceof Uint8Array]')
    expect(second.value).toBe('[7,true]')
    expect(scores[0]?.total).toBe(7) // the host's is never changed
    await ws.close()
  })

  it('refuses a live part, a name code has, and a name a host object takes', async () => {
    const store = await Store.open(await newKV())
    await expect(
      store.open('s', { profile: { values: { client: { send: () => 1 } } } }),
    ).rejects.toThrow(/value client can't be sent to code by value/)
    await expect(store.open('s', { profile: { values: { fs: 1 } } })).rejects.toThrow(
      InvalidNameError,
    )
    await expect(
      store.open('s', { profile: { values: { db: 1 }, hostObjects: { db: {} } } }),
    ).rejects.toThrow(/both a value and a host object/)
  })
})

describe('imports', () => {
  it("loads the world's modules relative to the cwd and to each other", async () => {
    const ws = await open()
    await ws.files.write('lib/math.ts', 'export const double = (x: number): number => x * 2\n')
    await ws.files.write(
      'lib/index.ts',
      "import { double } from './math'\nexport const quad = (x: number) => double(double(x))\nexport default 'lib'\n",
    )
    const out = await ws.runCode(`
      import name, { quad } from './lib/index.ts'
      import * as math from '/workspace/lib/math'
      return [name, quad(2), math.double(5)]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('["lib",8,10]')
    await ws.close()
  })

  it('exports under another name', async () => {
    const ws = await open()
    await ws.files.write('alias.ts', 'const x = 1\nconst w = 2\nexport { x as y, w }\n')
    const out = await ws.runCode(`import { y, w } from './alias'; return [y, w]`)
    expect(out.error).toBeNull()
    expect(out.value).toBe('[1,2]')
    await ws.close()
  })

  it('re-exports from the host, packages and URLs', async () => {
    const pkg = `data:text/javascript,${encodeURIComponent('export const hi = () => "hi"; export const bye = () => "bye"')}`
    const ws = await open({
      hostObjects: { counter: { add: (n: number) => n + 1 } },
      code: { resolve: (name) => (name === 'greet' ? pkg : null) },
    })
    await ws.files.write(
      'barrel.ts',
      `export { counter } from 'host'\nexport { hi as hello } from 'greet'\nexport * as all from '${pkg}'\nexport * from 'greet'\n`,
    )
    const out = await ws.runCode(`
      import { counter, hello, all, bye } from './barrel.ts'
      return [await counter.add(1), hello(), all.bye(), bye()]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('[2,"hi","bye","bye"]')
    await ws.close()
  })

  it('evaluates a module once, however its imports spell it', async () => {
    let loads = 0
    const ws = await open({ hostObjects: { tally: { hit: () => ++loads } } })
    await ws.files.write(
      'dep.ts',
      "import { tally } from 'host'\nexport const n = await tally.hit()\n",
    )
    await ws.files.write('user.ts', "export { n } from './dep'\n")
    const out = await ws.runCode(`
      import * as a from './dep.ts'
      import * as b from './dep'
      import { n } from './user'
      return [a === b, a.n, n]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('[true,1,1]')
    expect(loads).toBe(1)
    await ws.close()
  })

  it('reads imports that share a line with code', async () => {
    const ws = await open()
    await ws.files.write('m.ts', 'export const x = 3\nexport const y = 4\n')
    const out = await ws.runCode(
      "import { x } from './m'; import { y } from './m.ts'; return x * y",
    )
    expect(out.error).toBeNull()
    expect(out.value).toBe('12')
    await ws.close()
  })

  it('names a missing module', async () => {
    const ws = await open()
    const out = await ws.runCode(`import { x } from './missing'`)
    expect(out.error?.message).toMatch(/Cannot find module '\/workspace\/missing'/)
    await ws.close()
  })

  it('imports URLs, and bare names through the resolver', async () => {
    const mod = `data:text/javascript,${encodeURIComponent('export const hi = (n) => "hi " + n; export default 7')}`
    const ws = await open({ code: { resolve: (name) => (name === 'greet' ? mod : null) } })
    const out = await ws.runCode(`
      import seven, { hi } from 'greet'
      import { hi as again } from '${mod}'
      return [seven, hi('a'), again('b')]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('[7,"hi a","hi b"]')
    const missing = await ws.runCode(`import { y } from 'not-there'`)
    expect(missing.error?.message).toMatch(/Cannot find module 'not-there'/)
    await ws.close()
  })

  it('without a resolver, a bare name is missing', async () => {
    const ws = await open()
    const out = await ws.runCode(`import _ from 'lodash'`)
    expect(out.error?.message).toMatch(/Cannot find module 'lodash'/)
    await ws.close()
  })

  it('resolves a dynamic import of a world path as a static import', async () => {
    const ws = await open()
    await ws.files.write('lib/math.ts', 'export const double = (x: number): number => x * 2\n')
    await ws.files.write(
      'lib/lazy.ts',
      "export const quad = async (x: number) => {\n  const { double } = await import('./math')\n  return double(double(x))\n}\n",
    )
    const out = await ws.runCode(`
      const rel = await import('./lib/math.ts')
      const abs = await import('/workspace/lib/math')
      const name = 'lazy'
      const { quad } = await import(\`./lib/\${name}.ts\`)
      return [rel === abs, rel.double(3), await quad(2)]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('[true,6,8]')
    await ws.close()
  })

  it('shares a module between static and dynamic imports', async () => {
    let loads = 0
    const ws = await open({ hostObjects: { tally: { hit: () => ++loads } } })
    await ws.files.write(
      'dep.ts',
      "import { tally } from 'host'\nexport const n = await tally.hit()\n",
    )
    const out = await ws.runCode(`
      import * as a from './dep'
      const [b, c] = await Promise.all([import('./dep.ts'), import('./dep')])
      return [a === b, b === c, b.n]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('[true,true,1]')
    expect(loads).toBe(1)
    await ws.close()
  })

  it("dynamically imports 'host', URLs and bare names", async () => {
    const mod = `data:text/javascript,${encodeURIComponent('export default 7')}`
    const ws = await open({
      hostObjects: { counter: { add: (n: number) => n + 1 } },
      code: { resolve: (name) => (name === 'seven' ? mod : null) },
    })
    await ws.files.write(
      'use.ts',
      "export const run = async () => {\n  const { counter } = await import('host')\n  return [await counter.add(1), (await import('seven')).default]\n}\n",
    )
    const out = await ws.runCode(`
      const { run } = await import('./use')
      const { counter } = await import('host')
      return [...(await run()), await counter.add(2), (await import('${mod}')).default]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('[2,7,3,7]')
    const missing = await ws.runCode(`await import('./missing')`)
    expect(missing.error?.message).toMatch(/Cannot find module '\/workspace\/missing'/)
    await ws.close()
  })

  it('leaves import() inside strings, comments and templates alone', async () => {
    const ws = await open()
    await ws.files.write('m.ts', 'export const x = 3\n')
    const out = await ws.runCode(
      "// import('./nope')\nconst s = \"import('./a')\" + ` import('./b')`\nimport('./m').then((m) => console.log(m.x))\nawait new Promise((r) => setTimeout(r, 10))\nreturn s",
    )
    expect(out.error).toBeNull()
    expect(out.stdout).toBe('3')
    expect(out.value).toBe("import('./a') import('./b')")
    await ws.close()
  })

  it('leaves methods named import alone', async () => {
    const ws = await open()
    await ws.files.write('m.ts', 'export const x = 3\n')
    await ws.files.write(
      'store.ts',
      'export class Store {\n  import(x: number) { return x + 1 }\n  static import(x: number) {\n    return x + 2\n  }\n}\nexport const loader = { import(p: string) { return import(p) } }\n',
    )
    const out = await ws.runCode(`
      import { Store, loader } from './store'
      const obj = { import(x) { return x * 2 }, get import2() { return 'got' } }
      class A {
        async import(x: number)
        {
          return x * 3
        }
      }
      const { x } = await import('./m')
      const viaLoader = await loader.import('/workspace/m.ts')
      return [obj.import(x), obj.import2, await new A().import(x), new Store().import(x), Store.import(x), viaLoader.x]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('[6,"got",9,4,5,3]')
    await ws.close()
  })

  it('keeps line numbers around a dynamic import', async () => {
    const ws = await open()
    await ws.files.write('m.ts', 'export const boom = () => {\n  throw new Error("boom")\n}\n')
    const out = await ws.runCode("const { boom } = await import(\n  './m'\n)\nboom()")
    expect(out.error?.message).toBe('boom')
    expect(out.error?.stack).toMatch(/at line 4/)
    expect(out.error?.stack).toMatch(/\/workspace\/m\.ts:2/)
    await ws.close()
  })
})

describe('fetch from the files', () => {
  it('reads world paths when routed, and 404s under a prefix', async () => {
    const ws = await open({ code: { routeFetch: ['/workspace/data/'] } })
    await ws.files.write('data/points.json', '[1,2,3]')
    const out = await ws.runCode(`
      const r = await fetch('/workspace/data/points.json')
      const miss = await fetch('/workspace/data/none.json')
      return [r.headers.get('content-type'), await r.json(), miss.status]
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('["application/json",[1,2,3],404]')
    await ws.close()
  })
})

describe.each(BACKENDS)('on %s', (_, make) => {
  it('a frozen workspace runs code that reads, and refuses writes', async () => {
    const store = await newStore(make)
    const ws = await store.open('s', { profile: { code: code() } })
    await ws.files.write('f.txt', 'v1')
    const tag = await ws.tags.add('v1')
    await ws.files.write('f.txt', 'v2')
    const view = await store.resolve(`s@${tag}`, { profile: { code: code() } })
    const out = await view.runCode(`
      const text = await fs.read('/workspace/f.txt', 'utf8')
      const codes = []
      for (const path of ['/workspace/f.txt', 'new/dir/f.txt']) {
        try { await fs.write(path, 'v3') } catch (e) { codes.push(e.code) }
      }
      return [text, codes, await fs.exists('new')]
    `)
    expect(out.value).toBe('["v1",["EROFS","EROFS"],false]')
    expect(out.commit).toBeNull()
    await view.close()
    await ws.close()
  })
})
