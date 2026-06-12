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
    if (next.status === 204) return new Response(null, { status: 204 })
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

describe('GithubRemote roster ops (scripted)', () => {
  const commit = (sha: string, message: string) => ({
    sha,
    tree: { sha: 't' },
    parents: [],
    message,
    author: { date: 'x' },
    committer: { date: 'x' },
  })

  it('archive renames the ref and reports false when nothing is live', async () => {
    const { remote, calls } = makeHarness([
      { status: 200, body: { object: { sha: 'live1' } } }, // getRef chat-x
      { status: 201, body: {} }, // createRef archived/chat-x
      { status: 204 }, // deleteRef chat-x
      { status: 404, body: { message: 'Not Found' } }, // getRef again
    ])
    expect(await remote.archiveBranch('chat-x')).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST', 'DELETE'])
    expect(await remote.archiveBranch('chat-x')).toBe(false) // already gone
    expect(calls.length).toBe(4) // just the second getRef
  })

  it('double-archive collapses benignly: tombstone force-updated, live ref dropped', async () => {
    const { remote, calls } = makeHarness([
      { status: 200, body: { object: { sha: 'newer' } } }, // getRef
      { status: 422, body: { message: 'Reference already exists' } }, // createRef loses
      { status: 200, body: {} }, // updateRef force
      { status: 204 }, // deleteRef live
    ])
    expect(await remote.archiveBranch('chat-x')).toBe(true)
    const patch = calls.find((c) => c.method === 'PATCH')
    expect(patch?.url).toContain('/git/refs/heads/archived/chat-x')
  })

  it('restore renames back, suffixing when the original name is retaken', async () => {
    const { remote } = makeHarness([
      { status: 200, body: { object: { sha: 'arch1' } } }, // getRef archived
      { status: 422, body: { message: 'Reference already exists' } }, // createRef chat-x loses
      { status: 201, body: {} }, // createRef chat-x-restored
      { status: 204 }, // deleteRef archived
    ])
    expect(await remote.restoreBranch('chat-x')).toBe('chat-x-restored')
  })

  it('restore-after-empty-trash throws cleanly', async () => {
    const { remote } = makeHarness([{ status: 404, body: { message: 'Not Found' } }])
    await expect(remote.restoreBranch('chat-x')).rejects.toThrow(/nothing archived/)
  })

  it('emptyTrash deletes only archived refs and counts them', async () => {
    const refs = [
      { ref: 'refs/heads/main', object: { sha: 'm' } },
      { ref: 'refs/heads/chat-live', object: { sha: 'c' } },
      { ref: 'refs/heads/archived/chat-a', object: { sha: 'a' } },
      { ref: 'refs/heads/archived/chat-b', object: { sha: 'b' } },
    ]
    const { remote, calls } = makeHarness([
      { status: 200, body: refs },
      { status: 204 }, // delete archived/chat-a
      { status: 204 }, // delete archived/chat-b
    ])
    expect(await remote.emptyTrash()).toBe(2)
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url)
    expect(deletes.every((u) => u.includes('/heads/archived/'))).toBe(true)
  })

  it('listArchivedRefs resolves trailers and strips the prefix', async () => {
    const refs = [
      { ref: 'refs/heads/chat-live', object: { sha: 'c' } },
      { ref: 'refs/heads/archived/chat-old', object: { sha: 'a1' } },
    ]
    const { remote } = makeHarness([
      { status: 200, body: refs },
      { status: 200, body: commit('a1', trailered(KV_B)) },
    ])
    expect(await remote.listArchivedRefs()).toEqual([{ branch: 'chat-old', head: KV_B }])
  })

  it('readKeyAtTip probes the natural path, then the relocation slot', async () => {
    const { remote, calls } = makeHarness([
      { status: 200, body: { object: { sha: 'tip1' } } }, // getRef
      { status: 404, body: { message: 'Not Found' } }, // natural path miss
      { status: 200, body: { content: 'aGk=', encoding: 'base64', sha: 's', size: 2 } }, // _kv hit
    ])
    const out = await remote.readKeyAtTip('chat-x', 'meta')
    expect(new TextDecoder().decode(out as Uint8Array)).toBe('hi')
    expect(calls[1]?.url).toContain('/contents/meta?ref=tip1')
    expect(calls[2]?.url).toContain('/contents/_kv/meta?ref=tip1')
  })

  it('readKeyAtTip falls back when the natural path is a DIRECTORY', async () => {
    // A key relocated because other keys nest under its natural path:
    // the contents API answers with a directory listing, which must
    // read as "no file here", not an error.
    const { remote } = makeHarness([
      { status: 200, body: { object: { sha: 'tip1' } } }, // getRef
      { status: 200, body: [{ name: 'inner', type: 'file' }] }, // directory listing
      { status: 200, body: { content: 'aGk=', encoding: 'base64', sha: 's', size: 2 } }, // _kv hit
    ])
    const out = await remote.readKeyAtTip('chat-x', 'conf')
    expect(new TextDecoder().decode(out as Uint8Array)).toBe('hi')
  })
})
