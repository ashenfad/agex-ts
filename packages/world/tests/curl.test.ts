import { describe, expect, it } from 'vitest'
import { type CurlOptions, Store, type Workspace, curlCommand } from '../src/index'
import { newKV } from './backends'

interface Seen {
  url: string
  method: string
  headers: Record<string, string>
  body: string | null
  redirect: string | undefined
  mode: string | undefined
}

/** A fetch answering from `handler`, recording each request. */
function fakeFetch(
  handler: (req: Seen, signal: AbortSignal | undefined) => Response | Promise<Response>,
): { fetch: typeof globalThis.fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : null,
      redirect: init?.redirect,
      mode: init?.mode,
    }
    seen.push(req)
    return handler(req, init?.signal ?? undefined)
  }) as typeof globalThis.fetch
  return { fetch, seen }
}

async function open(curl: CurlOptions, secrets: Record<string, string> = {}): Promise<Workspace> {
  const store = await Store.open(await newKV())
  return store.open('s', { profile: { secrets, commands: { curl: curlCommand(curl) } } })
}

describe('curl', () => {
  it('fetches to the transcript', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('hello\n'))
    const ws = await open({ fetch })
    expect(await ws.terminal('curl https://example.test/a?b=1')).toMatchObject({
      stdout: 'hello\n',
      exitCode: 0,
    })
    expect(seen[0]).toMatchObject({
      url: 'https://example.test/a?b=1',
      method: 'GET',
      redirect: 'manual',
    })
    await ws.close()
  })

  it('saves with -o into the world, committed with the call', async () => {
    const { fetch } = fakeFetch(() => new Response(new Uint8Array([1, 2, 3])))
    const ws = await open({ fetch })
    await ws.files.fs.mkdir('/workspace/data')
    const r = await ws.terminal('cd data && curl -sL -o out.bin example.test/x')
    expect(r.exitCode).toBe(0)
    expect([...(await ws.files.read('/workspace/data/out.bin'))]).toEqual([1, 2, 3])
    expect(r.commit).not.toBeNull()
    await ws.close()
  })

  it('sends headers, a method and data; @file reads the world', async () => {
    const { fetch, seen } = fakeFetch(() => new Response('ok'))
    const ws = await open({ fetch })
    await ws.files.write('body.txt', 'a=1')
    await ws.terminal(
      `curl -X PUT -H 'X-One: 1' --header "X-Two: 2" -d @body.txt -d b=2 https://h.test`,
    )
    expect(seen[0]).toMatchObject({
      method: 'PUT',
      body: 'a=1&b=2',
      headers: { 'x-one': '1', 'x-two': '2', 'content-type': 'application/x-www-form-urlencoded' },
    })
    await ws.terminal(`curl --json '{"n":1}' https://h.test`)
    expect(seen[1]).toMatchObject({
      method: 'POST',
      body: '{"n":1}',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
    })
    await ws.close()
  })

  it('fills secrets into URLs and headers only, and scrubs them from answers', async () => {
    const { fetch, seen } = fakeFetch(
      (req) => new Response(`you sent ${req.headers.authorization} via ${req.url}`),
    )
    const ws = await open({ fetch }, { TOKEN: 'tok-123456', KEY: 'key-abcdef' })
    const r = await ws.terminal(
      `curl -H "Authorization: Bearer $TOKEN" 'https://h.test/?k=$KEY' -d 'x=$TOKEN'`,
    )
    expect(seen[0]?.headers.authorization).toBe('Bearer tok-123456')
    expect(seen[0]?.url).toBe('https://h.test/?k=key-abcdef')
    expect(seen[0]?.body).toBe('x=$TOKEN')
    expect(r.stdout).toBe('you sent Bearer ${TOKEN} via https://h.test/?k=${KEY}')
    expect(r.stdout).not.toContain('tok-123456')
    await ws.close()
  })

  it('-f fails on an HTTP error; without it the body prints', async () => {
    const { fetch } = fakeFetch(() => new Response('missing', { status: 404 }))
    const ws = await open({ fetch })
    expect(await ws.terminal('curl https://h.test/x')).toMatchObject({
      stdout: 'missing',
      exitCode: 0,
    })
    const r = await ws.terminal('curl -f https://h.test/x')
    expect(r).toMatchObject({ exitCode: 22 })
    expect(r.stderr).toBe('curl: (22) The requested URL returned error: 404')
    expect((await ws.terminal('curl -fs https://h.test/x')).stderr).toBe(
      'curl: exited with code 22',
    )
    await ws.close()
  })

  it('follows redirects only with -L', async () => {
    const { fetch, seen } = fakeFetch((req) => {
      if (req.redirect === 'follow') return new Response('landed')
      const r = new Response(null, { status: 200 })
      Object.defineProperty(r, 'type', { value: 'opaqueredirect' })
      return r
    })
    const ws = await open({ fetch })
    expect((await ws.terminal('curl https://h.test')).stdout).toBe('')
    expect((await ws.terminal('curl -L https://h.test')).stdout).toBe('landed')
    expect(seen.map((s) => s.redirect)).toEqual(['manual', 'follow'])
    await ws.close()
  })

  it('refuses a response over the cap', async () => {
    const { fetch } = fakeFetch(() => new Response('x'.repeat(100)))
    const ws = await open({ fetch, maxBytes: 10 })
    expect(await ws.terminal('curl https://h.test')).toMatchObject({
      exitCode: 63,
      stderr: 'curl: (63) Maximum file size exceeded (10 bytes)',
    })
    await ws.close()
  })

  it('tells CORS from a dead network', async () => {
    const cors = fakeFetch((req) => {
      if (req.mode === 'no-cors') return new Response(null, { status: 200 })
      throw new TypeError('Failed to fetch')
    })
    let ws = await open({ fetch: cors.fetch })
    let r = await ws.terminal('curl https://api.test/data')
    expect(r.exitCode).toBe(7)
    expect(r.stderr).toMatch(/api\.test answered, but its CORS policy/)
    await ws.close()

    const dead = fakeFetch(() => {
      throw new TypeError('Failed to fetch')
    })
    ws = await open({ fetch: dead.fetch })
    r = await ws.terminal('curl https://api.test/data')
    expect(r.exitCode).toBe(6)
    expect(r.stderr).toMatch(/Could not reach api\.test/)
    await ws.close()
  })

  it('times out with -m', async () => {
    const { fetch } = fakeFetch(
      (_req, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const ws = await open({ fetch })
    expect(await ws.terminal('curl -m 0.05 https://slow.test')).toMatchObject({
      exitCode: 28,
      stderr: 'curl: (28) Operation timed out after 0.05 seconds',
    })
    await ws.close()
  })

  it('refuses what it does not understand', async () => {
    const { fetch } = fakeFetch(() => new Response(''))
    const ws = await open({ fetch })
    expect((await ws.terminal('curl --frobnicate https://h.test')).stderr).toBe(
      'curl: option --frobnicate: is unknown',
    )
    expect((await ws.terminal('curl')).stderr).toBe('curl: no URL specified')
    expect((await ws.terminal('curl -H nocolon https://h.test')).exitCode).toBe(2)
    expect((await ws.terminal("curl 'http://[bad'")).exitCode).toBe(3)
    await ws.close()
  })
})
