/**
 * An in-memory stand-in for the slice of GitHub the pack transport
 * uses: the GraphQL documents `PackRemote` sends (roster / one-ref
 * queries, `createRef` + `createCommitOnBranch`, `updateRefs`) and the
 * contents API's raw reads. Commits are flat path → bytes snapshots;
 * oids are hashes of their own records, not git's.
 *
 * Dispatch is by the operation's shape (which root fields the document
 * names), which is enough for the documents the transport sends.
 */

import { GithubClient } from '../src/github/index'

interface Commit {
  oid: string
  parent: string | null
  files: Map<string, Uint8Array>
}

export interface FakeCall {
  kind: 'graphql-query' | 'graphql-mutation' | 'raw'
  detail: string
}

const ZERO = '0'.repeat(40)
const enc = new TextEncoder()
const dec = new TextDecoder()
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'base64'))

let counter = 0
const nextOid = (): string => (++counter).toString(16).padStart(40, 'c')

export class FakePackGithub {
  readonly commits = new Map<string, Commit>()
  /** Full ref name (`refs/heads/x`) → oid. */
  readonly refs = new Map<string, string>()
  readonly calls: FakeCall[] = []
  /** Called before a mutation applies: lets a test move refs under it. */
  beforeMutation: (() => void) | null = null

  constructor() {
    const root: Commit = {
      oid: nextOid(),
      parent: null,
      files: new Map([['README.md', enc.encode('# sync\n')]]),
    }
    this.commits.set(root.oid, root)
    this.refs.set('refs/heads/main', root.oid)
  }

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

  count(kind: FakeCall['kind']): number {
    return this.calls.filter((c) => c.kind === kind).length
  }

  /** Paths of the files at a branch's head. */
  filesAt(branch: string): string[] {
    const oid = this.refs.get(`refs/heads/${branch}`)
    return oid === undefined ? [] : [...(this.commits.get(oid) as Commit).files.keys()].sort()
  }

  private async handle(url: string, init?: RequestInit): Promise<Response> {
    if (url.endsWith('/graphql')) {
      const { query, variables } = JSON.parse(init?.body as string) as {
        query: string
        variables: Record<string, unknown>
      }
      return json(200, this.graphql(query, variables))
    }
    const m = /\/repos\/o\/r\/contents\/(.+)\?ref=(.+)$/.exec(url)
    if (m !== null) {
      const path = decodeURIComponent(m[1] as string)
      const ref = decodeURIComponent(m[2] as string)
      this.calls.push({ kind: 'raw', detail: path })
      const bytes = this.commits.get(ref)?.files.get(path)
      if (bytes === undefined) return json(404, { message: 'Not Found' })
      return new Response(bytes, { status: 200 })
    }
    return json(404, { message: `no route for ${url}` })
  }

  private graphql(query: string, vars: Record<string, unknown>): unknown {
    if (query.trimStart().startsWith('mutation')) {
      this.beforeMutation?.()
      if (query.includes('updateRefs(')) {
        this.calls.push({ kind: 'graphql-mutation', detail: 'updateRefs' })
        return this.updateRefs(vars.updates as Array<Record<string, string>>)
      }
      this.calls.push({ kind: 'graphql-mutation', detail: 'commit' })
      return this.commitMutation(query, vars)
    }
    if (query.includes('refs(refPrefix')) {
      this.calls.push({ kind: 'graphql-query', detail: 'roster' })
      const nodes = [...this.refs]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => this.refNode(name, oid))
      return {
        data: {
          repository: {
            ...this.header(),
            refs: { pageInfo: { hasNextPage: false, endCursor: 'x' }, nodes },
          },
        },
      }
    }
    if (query.includes('ref(qualifiedName')) {
      this.calls.push({ kind: 'graphql-query', detail: 'ref' })
      const name = vars.q as string
      const oid = this.refs.get(name)
      return {
        data: {
          repository: {
            ...this.header(),
            ref: oid === undefined ? null : this.refNode(name, oid),
          },
        },
      }
    }
    throw new Error(`FakePackGithub: unhandled query ${query.slice(0, 80)}`)
  }

  private header(): unknown {
    return { id: 'R_1', defaultBranchRef: { target: { oid: this.refs.get('refs/heads/main') } } }
  }

  private refNode(name: string, oid: string): unknown {
    const manifest = this.commits.get(oid)?.files.get('kvgit/manifest.json')
    return {
      id: `REF_${name}`,
      name: name.slice('refs/heads/'.length),
      target: {
        oid,
        file: manifest === undefined ? null : { object: { text: dec.decode(manifest) } },
      },
    }
  }

  private commitMutation(query: string, vars: Record<string, unknown>): unknown {
    const errors: Array<Record<string, unknown>> = []
    const data: Record<string, unknown> = {}
    if (query.includes('createRef(')) {
      const ref = vars.ref as string
      if (this.refs.has(ref)) {
        errors.push({
          type: 'UNPROCESSABLE',
          path: ['create'],
          message: `A ref named "${ref}" already exists in the repository.`,
        })
        data.create = null
      } else {
        this.refs.set(ref, vars.oid as string)
        data.create = { ref: { id: `REF_${ref}` } }
      }
    }
    const ref = `refs/heads/${vars.branch as string}`
    const head = this.refs.get(ref)
    if (head === undefined || head !== vars.oid) {
      errors.push({
        type: 'STALE_DATA',
        path: ['commit'],
        message: `Expected branch to point to "${vars.oid as string}" but it did not.  Pull and try again.`,
      })
      data.commit = null
      return { data, errors }
    }
    const files = new Map((this.commits.get(head) as Commit).files)
    for (const d of (vars.deletions ?? []) as Array<{ path: string }>) files.delete(d.path)
    for (const a of (vars.additions ?? []) as Array<{ path: string; contents: string }>) {
      files.set(a.path, fromB64(a.contents))
    }
    const commit: Commit = { oid: nextOid(), parent: head, files }
    this.commits.set(commit.oid, commit)
    this.refs.set(ref, commit.oid)
    data.commit = { commit: { oid: commit.oid }, ref: { id: `REF_${ref}` } }
    return errors.length > 0 ? { data, errors } : { data }
  }

  private updateRefs(updates: Array<Record<string, string>>): unknown {
    for (const u of updates) {
      const current = this.refs.get(u.name as string) ?? ZERO
      if (current !== u.beforeOid) {
        return { errors: [{ message: 'Something went wrong while executing your query.' }] }
      }
    }
    for (const u of updates) {
      if (u.afterOid === ZERO) this.refs.delete(u.name as string)
      else this.refs.set(u.name as string, u.afterOid as string)
    }
    return { data: { updateRefs: { clientMutationId: null } } }
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}
