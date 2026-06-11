import { describe, expect, it } from 'vitest'
import { GithubClient, GithubError } from '../src/github/index'

interface Scripted {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

interface Harness {
  client: GithubClient
  calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }>
  sleeps: number[]
}

/** Client wired to a scripted fetch, a recording sleeper, and a clock
 *  that only advances via sleeps — fully deterministic. */
function makeClient(
  script: Scripted[],
  opts: { writeIntervalMs?: number; maxRetries?: number } = {},
): Harness {
  const calls: Harness['calls'] = []
  const sleeps: number[] = []
  let clock = 1_000_000

  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k.toLowerCase()] = v as string
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      body: init?.body !== undefined ? JSON.parse(init.body as string) : undefined,
      headers,
    })
    const next = script.shift() ?? { status: 500, body: { message: 'script exhausted' } }
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: next.headers ?? {},
    })
  }) as typeof fetch

  const client = new GithubClient({
    token: 'tok',
    repo: 'o/r',
    fetchImpl,
    retryBaseMs: 100,
    sleeper: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    ...(opts.writeIntervalMs !== undefined && { writeIntervalMs: opts.writeIntervalMs }),
    ...(opts.maxRetries !== undefined && { maxRetries: opts.maxRetries }),
  })
  return { client, calls, sleeps }
}

describe('request shaping', () => {
  it('sends auth, accept, and api-version headers to the repo-scoped URL', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { ok: true } }])
    await client.request('GET', 'git/ref/heads/main')
    const call = calls[0]
    expect(call?.url).toBe('https://api.github.com/repos/o/r/git/ref/heads/main')
    expect(call?.headers.authorization).toBe('Bearer tok')
    expect(call?.headers.accept).toBe('application/vnd.github+json')
    expect(call?.headers['x-github-api-version']).toBe('2022-11-28')
  })

  it('serializes mutations with the write interval; reads are unthrottled', async () => {
    const { client, sleeps } = makeClient(
      [
        { status: 201, body: { sha: 'a' } },
        { status: 201, body: { sha: 'b' } },
        { status: 200, body: {} },
      ],
      { writeIntervalMs: 750 },
    )
    await client.createBlob(new Uint8Array([1]))
    await client.createBlob(new Uint8Array([2]))
    // Exactly one throttle wait, of the full interval (clock advances
    // only via sleeps, so the second write sees zero elapsed time).
    expect(sleeps).toEqual([750])
    await client.request('GET', 'git/trees/x')
    expect(sleeps).toEqual([750]) // GET added no waits
  })
})

describe('retry and taxonomy', () => {
  it('retries 5xx with exponential backoff, then succeeds', async () => {
    const { client, calls, sleeps } = makeClient([
      { status: 502, body: { message: 'bad gateway' } },
      { status: 502, body: { message: 'bad gateway' } },
      { status: 200, body: { object: { sha: 'abc' } } },
    ])
    expect(await client.getRef('main')).toBe('abc')
    expect(calls.length).toBe(3)
    expect(sleeps).toEqual([100, 200])
  })

  it('honors Retry-After on secondary rate limits', async () => {
    const { client, sleeps } = makeClient([
      {
        status: 403,
        body: { message: 'You have exceeded a secondary rate limit.' },
        headers: { 'retry-after': '2' },
      },
      { status: 200, body: { object: { sha: 'abc' } } },
    ])
    expect(await client.getRef('main')).toBe('abc')
    expect(sleeps).toEqual([2000])
  })

  it('never retries auth/permission/validation failures', async () => {
    for (const [status, body, kind] of [
      [401, { message: 'Bad credentials' }, 'auth'],
      [403, { message: 'Resource not accessible by personal access token' }, 'permission'],
      [422, { message: 'Validation Failed' }, 'validation'],
    ] as const) {
      const { client, calls } = makeClient([{ status, body }])
      const err = await client.request('POST', 'git/blobs', {}).catch((e) => e)
      expect(err).toBeInstanceOf(GithubError)
      expect((err as GithubError).kind).toBe(kind)
      expect(calls.length).toBe(1)
    }
  })

  it('gives up after maxRetries on persistent 5xx', async () => {
    const { client, calls } = makeClient(
      [
        { status: 500, body: { message: 'boom' } },
        { status: 500, body: { message: 'boom' } },
        { status: 500, body: { message: 'boom' } },
      ],
      { maxRetries: 2 },
    )
    const err = await client.request('GET', 'x').catch((e) => e)
    expect((err as GithubError).kind).toBe('server')
    expect(calls.length).toBe(3)
  })
})

describe('ref CAS semantics', () => {
  it('getRef returns null on 404', async () => {
    const { client } = makeClient([{ status: 404, body: { message: 'Not Found' } }])
    expect(await client.getRef('missing')).toBeNull()
  })

  it('createRef returns false when the ref already exists', async () => {
    const { client } = makeClient([{ status: 422, body: { message: 'Reference already exists' } }])
    expect(await client.createRef('chat-x', 'a'.repeat(40))).toBe(false)
  })

  it('createRef throws on other validation failures', async () => {
    const { client } = makeClient([{ status: 422, body: { message: 'Object does not exist' } }])
    await expect(client.createRef('chat-x', 'a'.repeat(40))).rejects.toThrow(/does not exist/)
  })

  it('updateRef returns false only on the non-fast-forward rejection', async () => {
    const { client } = makeClient([
      { status: 422, body: { message: 'Update is not a fast forward' } },
    ])
    expect(await client.updateRef('chat-x', 'a'.repeat(40))).toBe(false)
  })

  it('deleteRef tolerates an already-gone ref', async () => {
    const { client } = makeClient([{ status: 422, body: { message: 'Reference does not exist' } }])
    expect(await client.deleteRef('chat-x')).toBe(false)
  })

  it('encodes slashed branch names as path segments', async () => {
    const { client, calls } = makeClient([{ status: 200, body: { object: { sha: 'x' } } }])
    await client.getRef('archived/chat-ab12')
    expect(calls[0]?.url).toContain('/git/ref/heads/archived/chat-ab12')
  })
})

describe('blob round-trip plumbing', () => {
  it('createBlob posts base64; getBlob decodes newline-wrapped base64', async () => {
    const bytes = new Uint8Array([104, 105, 0, 1])
    const { client, calls } = makeClient([
      { status: 201, body: { sha: 'deadbeef' } },
      { status: 200, body: { content: 'aGk\nAAQ==\n', encoding: 'base64' } },
    ])
    await client.createBlob(bytes)
    expect((calls[0]?.body as { encoding: string }).encoding).toBe('base64')
    const back = await client.getBlob('deadbeef')
    expect(back).toEqual(bytes)
  })
})
