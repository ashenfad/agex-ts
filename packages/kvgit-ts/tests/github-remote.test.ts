import { describe, expect, it } from 'vitest'
import { Memory } from '../src/backends/memory'
import { GithubClient, GithubRemote, kvgitHashFromMessage } from '../src/github/index'

interface Scripted {
  status: number
  body?: unknown
}

function makeHarness(script: Scripted[]): {
  remote: GithubRemote
  store: Memory
  calls: Array<{ method: string; url: string }>
} {
  const calls: Array<{ method: string; url: string }> = []
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url: String(url) })
    const next = script.shift() ?? { status: 500, body: { message: 'script exhausted' } }
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status })
  }) as typeof fetch
  const client = new GithubClient({
    token: 'tok',
    repo: 'o/r',
    fetchImpl,
    maxRetries: 0,
    writeIntervalMs: 0,
    sleeper: async () => {},
  })
  const store = new Memory()
  return { remote: new GithubRemote(client, store), store, calls }
}

const KV_A = 'a'.repeat(40)
const KV_B = 'b'.repeat(40)
const trailered = (hash: string): string => `title\n\nKvgit-Hash: ${hash}\nKvgit-Format: 1`

describe('kvgitHashFromMessage', () => {
  it('parses the trailer and rejects messages without one', () => {
    expect(kvgitHashFromMessage(trailered(KV_A))).toBe(KV_A)
    expect(kvgitHashFromMessage('Initial commit')).toBeNull()
    expect(kvgitHashFromMessage(`Kvgit-Hash: ${'z'.repeat(40)}`)).toBeNull() // non-hex
  })
})

describe('GithubRemote.push prechecks (no uploads on lost CAS)', () => {
  it('returns false when expectedOld=null but the ref exists', async () => {
    const { remote, calls } = makeHarness([
      { status: 200, body: { object: { sha: 'feedface' } } }, // getRef
    ])
    expect(await remote.push('chat-x', null, KV_A, [])).toBe(false)
    expect(calls.length).toBe(1) // nothing written
  })

  it('returns false when the ref vanished under a non-null expectedOld', async () => {
    const { remote, calls } = makeHarness([{ status: 404, body: { message: 'Not Found' } }])
    expect(await remote.push('chat-x', KV_A, KV_B, [])).toBe(false)
    expect(calls.length).toBe(1)
  })

  it('returns false when the remote tip trailer mismatches expectedOld', async () => {
    const { remote, calls } = makeHarness([
      { status: 200, body: { object: { sha: 'feedface' } } },
      {
        status: 200,
        body: {
          sha: 'feedface',
          tree: { sha: 't' },
          parents: [],
          message: trailered(KV_B), // tip is B, we expected A
          author: { date: 'x' },
          committer: { date: 'x' },
        },
      },
    ])
    expect(await remote.push('chat-x', KV_A, KV_A, [])).toBe(false)
    expect(calls.length).toBe(2)
  })

  it('throws on stale transport state instead of pushing blind', async () => {
    const { remote } = makeHarness([
      { status: 200, body: { object: { sha: 'feedface' } } },
      {
        status: 200,
        body: {
          sha: 'feedface',
          tree: { sha: 't' },
          parents: [],
          message: trailered(KV_A),
          author: { date: 'x' },
          committer: { date: 'x' },
        },
      },
    ])
    // Tip matches expectedOld, but the local store holds no transport
    // state for this frontier (e.g. another device pushed it).
    await expect(remote.push('chat-x', KV_A, KV_B, [])).rejects.toThrow(/transport state/)
  })
})

describe('GithubRemote.listRefs', () => {
  it('keeps trailered session branches, drops archived/* and plain branches', async () => {
    const refs = [
      { ref: 'refs/heads/main', object: { sha: 'm1' } },
      { ref: 'refs/heads/chat-ab12', object: { sha: 'c1' } },
      { ref: 'refs/heads/archived/chat-old', object: { sha: 'a1' } },
    ]
    const commit = (sha: string, message: string) => ({
      sha,
      tree: { sha: 't' },
      parents: [],
      message,
      author: { date: 'x' },
      committer: { date: 'x' },
    })
    const { remote } = makeHarness([
      { status: 200, body: refs }, // matching-refs page
      { status: 200, body: commit('m1', 'docs: readme') }, // main — no trailer
      { status: 200, body: commit('c1', trailered(KV_A)) }, // session
      // archived/* never fetched
    ])
    expect(await remote.listRefs()).toEqual([{ branch: 'chat-ab12', head: KV_A }])
  })
})
