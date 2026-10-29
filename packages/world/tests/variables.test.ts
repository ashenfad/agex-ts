import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  InvalidNameError,
  type Profile,
  Store,
  type Workspace,
  curlCommand,
  worldTools,
} from '../src/index'
import { newKV } from './backends'

const WORKER = new URL('../dist/worker.node.js', import.meta.url)

beforeAll(() => {
  if (!existsSync(fileURLToPath(WORKER))) {
    throw new Error('build @agex-ts/world first: these tests run its built Node worker')
  }
})

async function open(extra: Profile = {}): Promise<Workspace> {
  const store = await Store.open(await newKV())
  return store.open('s', {
    profile: { code: { worker: { target: 'node', url: WORKER } }, ...extra },
  })
}

/** A host's configuration, as a person or an agent sets it. */
function config() {
  let now: Record<string, string> = {}
  return {
    variables: () => now,
    set(name: string, value: string) {
      now = { ...now, [name]: value }
    },
    remove(name: string) {
      const { [name]: _, ...rest } = now
      now = rest
    },
  }
}

describe('variables read live', () => {
  it('one set while the session is open is there for the next call, and one removed is gone', async () => {
    const live = config()
    const ws = await open({ variables: live.variables })
    expect((await ws.runCode('return env')).value).toBe('{}')
    expect(await ws.terminal('echo "$API_URL"')).toMatchObject({
      exitCode: 1,
      stderr: 'API_URL: unbound variable',
    })

    live.set('API_URL', 'https://a.test')
    expect((await ws.runCode('return env.API_URL')).value).toBe('https://a.test')
    expect((await ws.terminal('echo "$API_URL"')).stdout).toBe('https://a.test\n')

    live.set('API_URL', 'https://b.test')
    expect((await ws.runCode('return env.API_URL')).value).toBe('https://b.test')

    live.remove('API_URL')
    expect((await ws.runCode('return env')).value).toBe('{}')
    await ws.close()
  })

  it('the tools describe the variables there are now, the same tools as before', async () => {
    const live = config()
    const ws = await open({ variables: live.variables })
    const tools = worldTools(ws)
    const described = () => tools.map((t) => t.description).join('\n')
    expect(described()).not.toContain('API_URL')
    live.set('API_URL', 'https://a.test')
    expect(described()).toContain('$API_URL')
    expect(described()).toContain('env.API_URL')
    await ws.close()
  })

  it('every use checks what the function gives: code, the shell, and the descriptions', async () => {
    const live = config()
    const ws = await open({ variables: live.variables })
    const tools = worldTools(ws)
    live.set('bad-name', 'x')
    const bad = 'variable "bad-name": a name is [A-Za-z_][A-Za-z0-9_]*'
    await expect(ws.runCode('return 1')).rejects.toThrow(bad)
    await expect(ws.terminal('true')).rejects.toThrow(bad)
    for (const tool of tools.filter((t) => t.name === 'terminal' || t.name === 'run_ts')) {
      expect(() => tool.description).toThrow(bad)
    }
    await ws.close()
  })

  it("refuses a variable that comes to share a fixed secret's name, rather than shadow it", async () => {
    const seen: string[] = []
    const fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input))
      return new Response('ok')
    }) as typeof globalThis.fetch
    const live = config()
    const ws = await open({
      variables: live.variables,
      secrets: { TOKEN: { value: 'fixed-secret-3333', origins: ['https://api.good.test'] } },
      commands: { curl: curlCommand({ fetch }) },
    })
    live.set('TOKEN', 'public')
    // the host's mistake, so the call fails, as a bad profile at open does
    const clash = 'TOKEN is both a variable and a secret'
    await expect(ws.runCode('return env.TOKEN')).rejects.toThrow(clash)
    await expect(ws.terminal('echo "$TOKEN"')).rejects.toThrow(clash)
    await expect(ws.terminal('curl -s -H "X-Key: $TOKEN" https://api.good.test/x')).rejects.toThrow(
      clash,
    )
    expect(seen).toHaveLength(0)
    await ws.close()
  })

  it('fixed secrets stay as they were at open, though the variables are live', async () => {
    const seen: string[] = []
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-key') ?? '')
      return new Response('ok')
    }) as typeof globalThis.fetch
    const live = config()
    const secrets: Record<string, { value: string; origins: string[] }> = {
      TOKEN: { value: 'fixed-secret-3333', origins: ['https://api.good.test'] },
    }
    const ws = await open({
      variables: live.variables,
      secrets,
      commands: { curl: curlCommand({ fetch }) },
    })
    const token = secrets.TOKEN as { value: string }
    token.value = 'changed-secret-4444'
    await ws.terminal('curl -s -H "X-Key: $TOKEN" https://api.good.test/x')
    expect(seen).toEqual(['fixed-secret-3333'])
    await ws.close()
  })

  it('a run or a shell call reads the variables once, so what is checked is what is used', async () => {
    let reads = 0
    let flip = false
    const ws = await open({
      // a provider that changes at every read: TOKEN a variable, then not
      variables: () => {
        reads += 1
        flip = !flip
        return flip ? { TOKEN: 'public' } : {}
      },
      secrets: () =>
        flip ? {} : { TOKEN: { value: 'live-secret-6666', origins: ['https://a.test'] } },
    })
    reads = 0
    const out = await ws.runCode('return [env.TOKEN, typeof secret]')
    expect(reads).toBe(1)
    expect(out.error).toBeNull()
    reads = 0
    await ws.terminal('echo "$HOME"')
    expect(reads).toBe(1)
    await ws.close()
  })

  it('configuration() is a copy: changing it leaves the fixed secrets as they were', async () => {
    const seen: string[] = []
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('x-key') ?? '')
      return new Response('ok')
    }) as typeof globalThis.fetch
    const live = config()
    const ws = await open({
      variables: live.variables,
      secrets: { TOKEN: { value: 'fixed-secret-3333', origins: ['https://api.good.test'] } },
      commands: { curl: curlCommand({ fetch }) },
    })
    const token = ws.configuration().secrets.TOKEN as { value: string }
    token.value = 'changed-secret-4444'
    await ws.terminal('curl -s -H "X-Key: $TOKEN" https://api.good.test/x')
    expect(seen).toEqual(['fixed-secret-3333'])
    await ws.close()
  })

  it('code gets a copy: what it does to env reaches neither the host nor the next run', async () => {
    const live = config()
    live.set('API_URL', 'https://a.test')
    const ws = await open({ variables: live.variables })
    await ws.runCode(`try { (env as any).API_URL = 'changed' } catch {}`)
    expect(live.variables()).toEqual({ API_URL: 'https://a.test' })
    expect((await ws.runCode('return env.API_URL')).value).toBe('https://a.test')
    await ws.close()
  })

  it('a profile whose function gives a bad variable at open is refused, as a fixed one is', async () => {
    const store = await Store.open(await newKV())
    await expect(
      store.open('s', { profile: { variables: () => ({ 'A-B': 'x' }) } }),
    ).rejects.toThrow(InvalidNameError)
    await expect(
      store.open('t', { profile: { variables: () => ({ N: 1 as unknown as string }) } }),
    ).rejects.toThrow('variable N: a value is a string')
  })
})
