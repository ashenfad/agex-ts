/**
 * An in-memory stand-in for the slice of GitHub's REST API the GitHub
 * transport uses: blobs, trees, commits, the commits list, the
 * contents API and refs. Enough to push from one store and fetch into
 * another, and to count what each request carried.
 *
 * Trees are flat path → blob maps and tree / commit SHAs are hashes of
 * their own records, not git's; blob SHAs are git's, since the
 * transport computes them locally and references them.
 */

import { gitBlobSha1 } from '../src/github/git-hash'
import { GithubClient } from '../src/github/index'

interface Commit {
  sha: string
  message: string
  tree: string
  parents: string[]
  date: string
}

export interface FakeCall {
  method: string
  path: string
  body?: Record<string, unknown>
}

const enc = new TextEncoder()
const toB64 = (b: Uint8Array): string => Buffer.from(b).toString('base64')
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

async function sha1Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', enc.encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export class FakeGithub {
  readonly blobs = new Map<string, Uint8Array>()
  readonly trees = new Map<string, Map<string, string>>()
  readonly commits = new Map<string, Commit>()
  readonly refs = new Map<string, string>()
  readonly calls: FakeCall[] = []

  /** A client bound to this fake. */
  client(): GithubClient {
    return new GithubClient({
      token: 'tok',
      repo: 'o/r',
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) =>
        this.handle(String(url), init)) as typeof fetch,
      maxRetries: 0,
      writeIntervalMs: 0,
      sleeper: async () => {},
    })
  }

  /** Forget a blob, as GitHub's GC would once nothing reaches it. */
  collect(sha: string): void {
    this.blobs.delete(sha)
  }

  count(method: string, prefix: string): number {
    return this.calls.filter((c) => c.method === method && c.path.startsWith(prefix)).length
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET'
    const path = url.slice(url.indexOf('/repos/o/r/') + '/repos/o/r/'.length)
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined
    this.calls.push({ method, path, ...(body !== undefined && { body }) })
    try {
      return await this.route(method, path, body ?? {})
    } catch (e) {
      if (e instanceof Reply) return e.response()
      throw e
    }
  }

  private async route(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    const [route, query = ''] = path.split('?') as [string, string?]
    const params = new URLSearchParams(query)

    if (method === 'POST' && route === 'git/blobs') {
      const bytes = fromB64(body.content as string)
      const sha = await gitBlobSha1(bytes)
      this.blobs.set(sha, bytes)
      return json(201, { sha })
    }
    if (method === 'GET' && route.startsWith('git/blobs/')) {
      const bytes = this.blobs.get(route.slice('git/blobs/'.length))
      if (bytes === undefined) throw new Reply(404, 'Not Found')
      return json(200, { content: toB64(bytes), encoding: 'base64' })
    }
    if (method === 'POST' && route === 'git/trees') {
      const base = body.base_tree as string | undefined
      const files = new Map(base === undefined ? [] : (this.trees.get(base) ?? []))
      for (const entry of body.tree as Array<Record<string, unknown>>) {
        const p = entry.path as string
        if (typeof entry.content === 'string') {
          const bytes = enc.encode(entry.content)
          const sha = await gitBlobSha1(bytes)
          this.blobs.set(sha, bytes)
          files.set(p, sha)
        } else if (entry.sha === null) {
          files.delete(p)
        } else {
          const sha = entry.sha as string
          if (!this.blobs.has(sha)) throw new Reply(422, `tree.sha ${sha} is not a valid blob`)
          files.set(p, sha)
        }
      }
      const sha = await sha1Hex(`tree:${JSON.stringify([...files].sort())}`)
      this.trees.set(sha, files)
      return json(201, { sha })
    }
    if (method === 'POST' && route === 'git/commits') {
      const parents = body.parents as string[]
      for (const p of parents) if (!this.commits.has(p)) throw new Reply(422, 'Parent not found')
      const record = {
        message: body.message as string,
        tree: body.tree as string,
        parents,
        date: (body.committer as { date: string }).date,
      }
      const sha = await sha1Hex(`commit:${JSON.stringify(record)}`)
      this.commits.set(sha, { sha, ...record })
      return json(201, { sha })
    }
    if (method === 'GET' && route.startsWith('git/commits/')) {
      const c = this.commits.get(route.slice('git/commits/'.length))
      if (c === undefined) throw new Reply(404, 'Not Found')
      return json(200, {
        sha: c.sha,
        tree: { sha: c.tree },
        parents: c.parents.map((sha) => ({ sha })),
        message: c.message,
        author: { date: c.date },
        committer: { date: c.date },
      })
    }
    if (method === 'GET' && route === 'commits') {
      const order = this.ancestry(params.get('sha') as string)
      const perPage = Number(params.get('per_page') ?? 100)
      const page = Number(params.get('page') ?? 1)
      const slice = order.slice((page - 1) * perPage, page * perPage)
      return json(
        200,
        slice.map((c) => ({
          sha: c.sha,
          parents: c.parents.map((sha) => ({ sha })),
          commit: { message: c.message, tree: { sha: c.tree }, committer: { date: c.date } },
        })),
      )
    }
    if (method === 'GET' && route.startsWith('contents/')) {
      const file = decodeURIComponent(route.slice('contents/'.length))
      const commit = this.commits.get(params.get('ref') as string)
      const files = commit === undefined ? undefined : this.trees.get(commit.tree)
      const sha = files?.get(file)
      if (sha === undefined) {
        if (files !== undefined && [...files.keys()].some((p) => p.startsWith(`${file}/`))) {
          return json(200, [])
        }
        throw new Reply(404, 'Not Found')
      }
      const bytes = this.blobs.get(sha) as Uint8Array
      return json(200, { content: toB64(bytes), encoding: 'base64', sha, size: bytes.length })
    }
    if (method === 'GET' && route.startsWith('git/ref/heads/')) {
      const sha = this.refs.get(decodeURIComponent(route.slice('git/ref/heads/'.length)))
      if (sha === undefined) throw new Reply(404, 'Not Found')
      return json(200, { object: { sha } })
    }
    if (method === 'GET' && route === 'git/matching-refs/heads/') {
      return json(
        200,
        [...this.refs].map(([branch, sha]) => ({ ref: `refs/heads/${branch}`, object: { sha } })),
      )
    }
    if (method === 'POST' && route === 'git/refs') {
      const branch = (body.ref as string).slice('refs/heads/'.length)
      if (this.refs.has(branch)) throw new Reply(422, 'Reference already exists')
      this.refs.set(branch, body.sha as string)
      return json(201, {})
    }
    if (method === 'PATCH' && route.startsWith('git/refs/heads/')) {
      const branch = decodeURIComponent(route.slice('git/refs/heads/'.length))
      const current = this.refs.get(branch)
      const next = body.sha as string
      if (current === undefined) throw new Reply(422, 'Reference does not exist')
      if (body.force !== true && !this.ancestry(next).some((c) => c.sha === current)) {
        throw new Reply(422, 'Update is not a fast forward')
      }
      this.refs.set(branch, next)
      return json(200, {})
    }
    throw new Reply(404, `FakeGithub: no route for ${method} ${route}`)
  }

  /** Every commit reachable from `sha`, newest first. */
  private ancestry(sha: string): Commit[] {
    const out: Commit[] = []
    const seen = new Set<string>()
    const queue = [sha]
    while (queue.length > 0) {
      const next = queue.shift() as string
      if (seen.has(next)) continue
      seen.add(next)
      const c = this.commits.get(next)
      if (c === undefined) continue
      out.push(c)
      queue.push(...c.parents)
    }
    return out
  }
}

class Reply extends Error {
  constructor(
    readonly status: number,
    readonly text: string,
  ) {
    super(text)
  }

  response(): Response {
    return json(this.status, { message: this.text })
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}
