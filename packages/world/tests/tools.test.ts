import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { CommandContext } from '@agex-ts/termish'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  type Profile,
  ReadOnlyError,
  Store,
  type Tool,
  type Workspace,
  commandFactory,
  toMcpResult,
  toolInstructions,
  worldTools,
} from '../src/index'
import { newKV } from './backends'

const WORKER = new URL('../dist/worker.node.js', import.meta.url)

beforeAll(() => {
  if (!existsSync(fileURLToPath(WORKER))) {
    throw new Error('build @agex-ts/world first: run_ts runs its built Node worker')
  }
})

async function open(profile: Profile = {}): Promise<Workspace> {
  const store = await Store.open(await newKV())
  return store.open('s', {
    profile: { ...profile, code: { worker: { target: 'node', url: WORKER }, ...profile.code } },
  })
}

const tool = (tools: Tool[], name: string): Tool => {
  const found = tools.find((t) => t.name === name)
  if (found === undefined) throw new Error(`no tool ${name}`)
  return found
}

const tools = async (ws: Workspace): Promise<unknown[]> =>
  (await ws.log()).map((c) => c.info?.tool).reverse()

describe('ws.terminal', () => {
  it('runs a script, keeps the cwd, and commits as terminal', async () => {
    const ws = await open()
    const r = await ws.terminal('mkdir -p src && cd src && echo hi > a.txt && pwd')
    expect(r).toMatchObject({ stdout: '/workspace/src\n', exitCode: 0, stderr: '' })
    expect(r.commit).toBe(ws.head)
    expect((await ws.terminal('cat a.txt')).stdout).toBe('hi\n')
    expect(await tools(ws)).toEqual(['init', 'terminal'])
    await ws.close()
  })

  it('reports failures as results: not found, parse errors, failing commands', async () => {
    const ws = await open()
    expect(await ws.terminal('nope')).toMatchObject({
      exitCode: 127,
      stderr: 'nope: command not found',
    })
    expect(await ws.terminal('for f in a b; do echo $f; done')).toMatchObject({
      exitCode: 2,
      stderr: expect.stringMatching(/^parse error: .*control flow/),
    })
    const r = await ws.terminal('echo before; cat missing.txt')
    expect(r.exitCode).toBe(1)
    expect(r.stdout).toBe('before\n')
    expect(r.stderr).toMatch(/missing\.txt/)
    await ws.close()
  })

  it('expands variables, and a secret only to a reference to itself', async () => {
    const ws = await open({ variables: { NAME: 'world' }, secrets: { TOKEN: 's3cret-value' } })
    expect((await ws.terminal('echo "hello $NAME, $TOKEN"')).stdout).toBe('hello world, ${TOKEN}\n')
    await ws.close()
  })

  it('runs host commands, made per world with the secrets', async () => {
    const seen: string[] = []
    const ws = await open({
      secrets: { KEY: 'k' },
      commands: {
        shout: async (ctx: CommandContext) => {
          ctx.stdout.write(`${ctx.args.join(' ').toUpperCase()}\n`)
        },
        whoami: commandFactory(({ ws: w, secrets }) => async (ctx) => {
          seen.push(secrets.names().join())
          ctx.stdout.write(`${w.session}\n`)
        }),
      },
    })
    expect((await ws.terminal('shout hi there | cat')).stdout).toBe('HI THERE\n')
    expect((await ws.terminal('whoami')).stdout).toBe('s\n')
    expect(seen).toEqual(['KEY'])
    await ws.close()
  })

  it('cuts long output to maxObservation', async () => {
    const ws = await open({ code: { maxObservation: 10 } })
    await ws.files.write('big.txt', 'x'.repeat(100))
    const r = await ws.terminal('cat big.txt')
    expect(r.stdout).toBe('x'.repeat(10))
    expect(r.truncated).toBe(true)
    await ws.close()
  })

  it('is interrupted between commands', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    let waiting!: () => void
    const started = new Promise<void>((r) => {
      waiting = r
    })
    const ws = await open({
      commands: {
        wait: async (ctx) => {
          ctx.stdout.write('waiting\n')
          waiting()
          await gate
        },
      },
    })
    const running = ws.terminal('wait; echo after')
    await started
    expect(ws.interrupt()).toBe(true)
    release()
    const r = await running
    expect(r.exitCode).toBe(130)
    expect(r.stdout).toBe('waiting\n')
    await ws.close()
  })

  it('on a frozen workspace, reads work and writes fail', async () => {
    const ws = await open()
    await ws.files.write('f.txt', 'v1')
    const view = await ws.store.resolve(`s@${ws.head}`)
    expect((await view.terminal('cat f.txt')).stdout).toBe('v1')
    const r = await view.terminal('echo no > g.txt')
    expect(r.exitCode).not.toBe(0)
    expect(r.commit).toBeNull()
    await ws.close()
  })
})

describe('commands and the workspace', () => {
  it("a command's workspace is part of the shell call, so it can write and commit", async () => {
    const ws = await open({
      commands: {
        note: commandFactory(({ ws: w }) => async (ctx) => {
          const out = await w.files.write('note.txt', ctx.args.join(' '))
          ctx.stdout.write(`noted (${out.commit === null ? 'pending' : 'committed'})\n`)
        }),
      },
    })
    const r = await ws.terminal('echo before > a.txt; note hello')
    expect(r.stdout).toBe('noted (committed)\n')
    expect(await ws.files.readText('note.txt')).toBe('hello')
    // The command's write committed the script's changes so far.
    expect(await tools(ws)).toEqual(['init', 'file_write'])
    await ws.close()
  })
})

describe('line numbers', () => {
  it('are the source lines, below a multi-line import', async () => {
    const ws = await open()
    await ws.files.write('m.ts', 'export const a = 1\nexport const b = 2\n')
    const out = await ws.runCode(
      "import {\n  a,\n  b,\n} from './m'\nconst c = a + b\nthrow new Error('at six')",
    )
    expect(out.error?.stack).toBe('Error: at six\n    at line 6')
    await ws.close()
  })

  it('are the source lines in a module below a multi-line re-export', async () => {
    const ws = await open()
    await ws.files.write('m.ts', 'export const a = 1\nexport const b = 2\n')
    await ws.files.write(
      'lib.ts',
      "export {\n  a,\n  b as bee,\n} from './m'\nexport function boom() {\n  throw new Error('in lib')\n}\n",
    )
    const out = await ws.runCode("import { boom } from './lib'\nboom()")
    expect(out.error?.stack).toBe('Error: in lib\n    at boom (/workspace/lib.ts:6)\n    at line 2')
    await ws.close()
  })
})

describe('the tools', () => {
  it("are nontainer's, in its order, with its schemas", async () => {
    const ws = await open()
    const list = worldTools(ws)
    expect(list.map((t) => t.name)).toEqual([
      'terminal',
      'file_write',
      'file_edit',
      'view_image',
      'run_ts',
    ])
    expect(tool(list, 'file_edit').parameters).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['path', 'old_string', 'new_string'],
    })
    expect(worldTools(ws, { vision: false }).map((t) => t.name)).not.toContain('view_image')
    await ws.close()
  })

  it('terminal renders exit codes and stderr, and marks failures', async () => {
    const ws = await open()
    const terminal = tool(worldTools(ws), 'terminal')
    expect(await terminal.call({ command: 'true' })).toEqual({
      text: '(no output)',
      images: [],
      isError: false,
    })
    const out = await terminal.call({ command: 'echo partial; nope' })
    expect(out.text).toBe('partial\n[exit code 127]\n[stderr]\nnope: command not found')
    expect(out.isError).toBe(true)
    expect(await terminal.call({ cmd: 'ls' })).toMatchObject({
      text: 'terminal: invalid arguments: command must be a string',
      isError: true,
    })
    await ws.close()
  })

  it('file_write writes and says where', async () => {
    const ws = await open()
    const out = await tool(worldTools(ws), 'file_write').call({ path: 'a/b.txt', content: 'héllo' })
    expect(out).toEqual({
      text: 'wrote a/b.txt (6 bytes)',
      images: [],
      written: 'a/b.txt',
      isError: false,
    })
    expect(await tools(ws)).toEqual(['init', 'file_write'])
    expect(toMcpResult(out).content[1]).toEqual({
      type: 'resource_link',
      uri: 'workspace://a/b.txt',
      name: 'b.txt',
    })
    await ws.close()
  })

  it('file_write refuses a path under a file, as not a directory', async () => {
    const ws = await open()
    const write = tool(worldTools(ws), 'file_write')
    await ws.files.write('notes.txt', 'n')
    for (const path of ['notes.txt/x.js', 'notes.txt/deeper/x.js']) {
      expect(await write.call({ path, content: 'x' })).toMatchObject({
        text: `write failed: ${path}: Not a directory`,
        isError: true,
      })
    }
    await ws.close()
  })

  it('file_edit replaces, reports how it matched, and says why it failed', async () => {
    const ws = await open()
    const edit = tool(worldTools(ws), 'file_edit')
    await ws.files.write('m.py', 'def f():\n    return 1\n')
    expect(
      (await edit.call({ path: 'm.py', old_string: 'return 1', new_string: 'return 2' })).text,
    ).toBe('replaced 1 occurrence(s) in m.py')
    expect(
      (
        await edit.call({
          path: 'm.py',
          old_string: 'def f():\nreturn 2',
          new_string: 'def f():\nreturn 3',
        })
      ).text,
    ).toBe('replaced 1 occurrence(s) in m.py (matched via indent_flexible)')
    expect(await ws.files.readText('m.py')).toBe('def f():\n    return 3\n')
    expect(
      (await edit.call({ path: 'm.py', old_string: 'return 9', new_string: 'return 3' })).text,
    ).toBe('no-op: replacement already present in m.py')
    const miss = await edit.call({ path: 'm.py', old_string: 'retur 3', new_string: 'x' })
    expect(miss.isError).toBe(true)
    expect(miss.text).toMatch(/^edit failed: old_string not found in m\.py\.\n\nDid you mean/)
    const none = await edit.call({ path: 'nope.py', old_string: 'a', new_string: 'b' })
    expect(none).toMatchObject({ isError: true })
    expect(none.text).toMatch(/^edit failed: cannot read nope\.py/)
    expect(await tools(ws)).toEqual(['init', 'file_write', 'file_edit', 'file_edit'])
    await ws.close()
  })

  it('view_image returns the image, and refuses what it cannot show', async () => {
    const ws = await open()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    await ws.files.write('plot.PNG', png)
    const view = tool(worldTools(ws), 'view_image')
    const out = await view.call({ path: 'plot.PNG' })
    expect(out.text).toBe('plot.PNG (png, 7 bytes)')
    expect(out.images).toEqual([
      { data: Buffer.from(png).toString('base64'), format: 'png', source: 'plot.PNG' },
    ])
    expect(toMcpResult(out).content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect((await view.call({ path: 'notes.txt' })).text).toMatch(/not a viewable image/)
    expect((await view.call({ path: 'gone.png' })).isError).toBe(true)
    await ws.close()
  })

  it('run_ts renders output, values, errors at their line, and hints', async () => {
    const ws = await open()
    const run = tool(worldTools(ws), 'run_ts')
    expect((await run.call({ code: "console.log('hi'); return 41 + 1" })).text).toBe(
      'hi\n[returned]\n42',
    )
    expect((await run.call({ code: 'const x = 1' })).text).toBe('(no output; success)')
    await ws.files.write('lib.ts', 'export function boom() {\n  throw new Error("in lib")\n}\n')
    const failed = await run.call({ code: "import { boom } from './lib.ts'\n\nboom()" })
    expect(failed.isError).toBe(true)
    expect(failed.text).toBe(
      '[error]\nError: in lib\n    at boom (/workspace/lib.ts:2)\n    at line 3',
    )
    const fsErr = await run.call({ code: "await fs.read('nope.txt')" })
    expect(fsErr.text).toBe(
      '[error]\nFsError: No such file or directory: nope.txt (resolved to /workspace/nope.txt; cwd /workspace)\n    at line 1',
    )
    const required = await run.call({ code: "const _ = require('lodash')" })
    expect(required.text).toMatch(/\[hint: code here is an ES module body/)
    const pkg = await run.call({ code: "import _ from 'lodash'" })
    expect(pkg.text).toMatch(/\[hint: packages are not available here/)
    await ws.files.write('reads.ts', "export const read = () => fs.read('lib.ts')\n")
    const unbound = await run.call({ code: "import { read } from './reads'\nawait read()" })
    expect(unbound.text).toMatch(
      /ReferenceError: fs is not defined[\s\S]*\[hint: a module imports fs, cache and env from 'host'/,
    )
    await ws.close()
  })

  it('a closed workspace throws rather than answering', async () => {
    const ws = await open()
    await ws.close()
    await expect(tool(worldTools(ws), 'terminal').call({ command: 'ls' })).rejects.toThrow(
      ReadOnlyError,
    )
  })
})

describe('descriptions', () => {
  it('name what the world grants', async () => {
    const ws = await open({
      variables: { API_URL: 'u' },
      secrets: { TOKEN: 't' },
      hostObjects: { db: { query: () => 1 } },
      commands: {
        shout: async () => undefined,
        fetchit: commandFactory(() => async () => undefined, {
          description: 'fetchit URL gets it.',
        }),
      },
      code: { resolve: () => null, timeout: 12 },
    })
    const list = worldTools(ws, { terminalPrimer: 'TERMINAL PRIMER.', codePrimer: 'CODE PRIMER.' })
    const terminal = tool(list, 'terminal').description
    expect(terminal).toContain('- variables: $API_URL')
    expect(terminal).toContain('- secrets: $TOKEN')
    expect(terminal).toContain('- also: fetchit, shout\n  fetchit URL gets it.')
    expect(terminal.endsWith('TERMINAL PRIMER.')).toBe(true)
    const code = tool(list, 'run_ts').description
    expect(code).toContain('host objects available by name: db')
    expect(code).toContain("import { db } from 'host'")
    expect(code).toContain(
      "gets `fs`, `env` and `cache` from\n  'host' (`import { fs, env } from 'host'`)",
    )
    expect(code).toContain('env.API_URL')
    expect(code).toContain('packages: import them by name')
    expect(code).toContain('stops after 12s')
    expect(code).toContain("secret('TOKEN')")
    expect(code).toContain('CODE PRIMER.\n\nMake ONE call per turn')
    expect(await toolInstructions(ws)).toContain('every mutating call is committed')
    await ws.close()
  })
})
