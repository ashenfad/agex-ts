/**
 * Throttled, retrying GitHub REST client scoped to one repo.
 *
 * Three concerns live here so the transport layers above (push /
 * fetch / roster) stay pure mapping logic:
 *
 * 1. **Mutation throttling.** GitHub's secondary rate limits cap
 *    content-creating requests (documented ~80/min) and dislike
 *    concurrent writes. All non-GET requests are serialized through
 *    one chain with a minimum spacing (`writeIntervalMs`, default
 *    750ms ≈ 80/min). Reads are not throttled (primary limit is
 *    5,000/hr with a PAT).
 * 2. **Retry/backoff.** `server` and `rate-limit` failures (and
 *    network errors) retry up to `maxRetries` with exponential
 *    backoff, honoring `Retry-After` / `x-ratelimit-reset` when
 *    present. `auth` / `permission` / `validation` never retry.
 * 3. **Error taxonomy.** Failures surface as `GithubError` with a
 *    `kind` callers can branch on (see `errors.ts`).
 *
 * The Git Data API surface is exposed as thin typed methods
 * (blobs/trees/commits/refs) — the kvgit↔git mapping happens above
 * this layer. Ref CAS semantics: `createRef`/`updateRef` return
 * `false` for the lost-race cases ("already exists" / "not a fast
 * forward") and throw for everything else.
 */

import { base64ToBytes, bytesToBase64 } from './base64'
import { GithubError, classify, errorMessage } from './errors'

export interface GithubClientOptions {
  /** PAT with contents read/write on the repo (fine-grained preferred). */
  token: string
  /** `owner/name`. */
  repo: string
  apiBase?: string
  /** Minimum ms between mutating requests. Default 750 (~80/min). */
  writeIntervalMs?: number
  /** Retries for retryable failures. Default 3. */
  maxRetries?: number
  /** Base backoff ms, doubling per attempt. Default 1000. */
  retryBaseMs?: number
  /** Injection seams (tests): fetch, sleep, clock. */
  fetchImpl?: typeof fetch
  sleeper?: (ms: number) => Promise<void>
  now?: () => number
}

export interface TreeEntry {
  path: string
  mode: '100644' | '100755' | '040000' | '160000' | '120000'
  type: 'blob' | 'tree' | 'commit'
  /** Blob/tree SHA; `null` deletes the path (with `base_tree`). */
  sha?: string | null
  /** Inline UTF-8 content (small text files only; blobs go via createBlob). */
  content?: string
}

export interface GitPerson {
  name: string
  email: string
  /** ISO 8601. */
  date: string
}

export interface GitCommit {
  sha: string
  tree: string
  parents: string[]
  message: string
  authorDate: string
  committerDate: string
}

const MAX_BACKOFF_MS = 60_000

const defaultSleeper = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class GithubClient {
  readonly repo: string
  readonly #token: string
  readonly #apiBase: string
  readonly #writeIntervalMs: number
  readonly #maxRetries: number
  readonly #retryBaseMs: number
  readonly #fetch: typeof fetch
  readonly #sleep: (ms: number) => Promise<void>
  readonly #now: () => number

  #writeChain: Promise<unknown> = Promise.resolve()
  #lastWriteAt = Number.NEGATIVE_INFINITY

  constructor(opts: GithubClientOptions) {
    this.repo = opts.repo
    this.#token = opts.token
    this.#apiBase = opts.apiBase ?? 'https://api.github.com'
    this.#writeIntervalMs = opts.writeIntervalMs ?? 750
    this.#maxRetries = opts.maxRetries ?? 3
    this.#retryBaseMs = opts.retryBaseMs ?? 1000
    this.#fetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.#sleep = opts.sleeper ?? defaultSleeper
    this.#now = opts.now ?? Date.now
  }

  // -------------------------------------------------------------------------
  // Transport core
  // -------------------------------------------------------------------------

  /**
   * Issue one request against the repo (`path` is relative to
   * `/repos/<owner>/<name>/`). GETs run immediately and concurrently;
   * mutations are serialized and spaced by `writeIntervalMs`.
   */
  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    if (method === 'GET') return this.#attempt<T>(method, path, body)

    const run = this.#writeChain.then(async () => {
      const wait = this.#writeIntervalMs - (this.#now() - this.#lastWriteAt)
      if (wait > 0) await this.#sleep(wait)
      try {
        return await this.#attempt<T>(method, path, body)
      } finally {
        this.#lastWriteAt = this.#now()
      }
    })
    // Keep the chain alive through failures; errors surface via `run`.
    this.#writeChain = run.catch(() => undefined)
    return run as Promise<T>
  }

  async #attempt<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.#apiBase}/repos/${this.repo}/${path}`
    const init: RequestInit = {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.#token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    }

    for (let attempt = 0; ; attempt++) {
      let resp: Response
      try {
        resp = await this.#fetch(url, init)
      } catch (err) {
        if (attempt >= this.#maxRetries) {
          const detail = err instanceof Error ? err.message : String(err)
          throw new GithubError('network', 0, `Network error contacting GitHub: ${detail}`)
        }
        await this.#sleep(this.#backoff(attempt))
        continue
      }

      if (resp.ok) {
        if (resp.status === 204) return undefined as T
        return (await resp.json()) as T
      }

      const raw = await resp.text()
      const message = errorMessage(raw, resp.status)
      const kind = classify(resp.status, message, resp.headers)
      const retryable = kind === 'server' || kind === 'rate-limit'
      if (retryable && attempt < this.#maxRetries) {
        const hinted = retryAfterMs(resp.headers, this.#now)
        await this.#sleep(Math.min(hinted ?? this.#backoff(attempt), MAX_BACKOFF_MS))
        continue
      }
      throw new GithubError(kind, resp.status, message, raw)
    }
  }

  #backoff(attempt: number): number {
    return this.#retryBaseMs * 2 ** attempt
  }

  // -------------------------------------------------------------------------
  // Git Data API
  // -------------------------------------------------------------------------

  /** Store a blob (binary-safe via base64); returns its git SHA. */
  async createBlob(bytes: Uint8Array): Promise<string> {
    const data = await this.request<{ sha: string }>('POST', 'git/blobs', {
      content: bytesToBase64(bytes),
      encoding: 'base64',
    })
    return data.sha
  }

  /** Fetch a blob's bytes (handles GitHub's newline-wrapped base64). */
  async getBlob(sha: string): Promise<Uint8Array> {
    const data = await this.request<{ content: string; encoding: string }>(
      'GET',
      `git/blobs/${sha}`,
    )
    if (data.encoding !== 'base64') {
      throw new GithubError('validation', 200, `unexpected blob encoding: ${data.encoding}`)
    }
    return base64ToBytes(data.content)
  }

  /** Create a tree, optionally layered on `baseTree`. Nested `a/b/c`
   *  paths are accepted (intermediate trees are synthesized). */
  async createTree(entries: TreeEntry[], baseTree?: string): Promise<string> {
    const data = await this.request<{ sha: string }>('POST', 'git/trees', {
      tree: entries,
      ...(baseTree !== undefined && { base_tree: baseTree }),
    })
    return data.sha
  }

  async getTree(
    sha: string,
    opts: { recursive?: boolean } = {},
  ): Promise<{ entries: Array<{ path: string; type: string; sha: string }>; truncated: boolean }> {
    const suffix = opts.recursive ? '?recursive=1' : ''
    const data = await this.request<{
      tree: Array<{ path: string; type: string; sha: string }>
      truncated: boolean
    }>('GET', `git/trees/${sha}${suffix}`)
    return { entries: data.tree, truncated: data.truncated }
  }

  /** Create a commit. Explicit dates keep git SHAs deterministic —
   *  the property push resumability rests on. Parents must exist. */
  async createCommit(opts: {
    message: string
    tree: string
    parents: string[]
    author: GitPerson
    committer: GitPerson
  }): Promise<string> {
    const data = await this.request<{ sha: string }>('POST', 'git/commits', opts)
    return data.sha
  }

  async getCommit(sha: string): Promise<GitCommit> {
    const data = await this.request<{
      sha: string
      tree: { sha: string }
      parents: Array<{ sha: string }>
      message: string
      author: { date: string }
      committer: { date: string }
    }>('GET', `git/commits/${sha}`)
    return {
      sha: data.sha,
      tree: data.tree.sha,
      parents: data.parents.map((p) => p.sha),
      message: data.message,
      authorDate: data.author.date,
      committerDate: data.committer.date,
    }
  }

  /** One page of the commits list walking back from `sha` —
   *  parents, messages (Kvgit-Hash trailers), tree SHAs, and dates
   *  included; 1-indexed pages. The walk-back primitive for fetch and
   *  for kvgit↔git SHA resolution. */
  async listCommits(opts: {
    sha: string
    perPage?: number
    page?: number
  }): Promise<
    Array<{ sha: string; parents: string[]; message: string; treeSha: string; date: string }>
  > {
    const perPage = opts.perPage ?? 100
    const page = opts.page ?? 1
    const data = await this.request<
      Array<{
        sha: string
        parents: Array<{ sha: string }>
        commit: { message: string; tree: { sha: string }; committer: { date: string } }
      }>
    >('GET', `commits?sha=${encodeURIComponent(opts.sha)}&per_page=${perPage}&page=${page}`)
    return data.map((c) => ({
      sha: c.sha,
      parents: c.parents.map((p) => p.sha),
      message: c.commit.message,
      treeSha: c.commit.tree.sha,
      date: c.commit.committer.date,
    }))
  }

  /**
   * A file's bytes at a ref, in one request via the contents API
   * (inline base64 up to ~1MB; larger files arrive truncated with
   * `encoding: "none"` and fall back to the blob endpoint, which
   * serves up to 100MB). Returns null when the path doesn't exist at
   * that ref.
   */
  async getContent(path: string, ref: string): Promise<Uint8Array | null> {
    const encoded = path.split('/').map(encodeURIComponent).join('/')
    interface ContentResponse {
      content?: string
      encoding?: string
      sha: string
      size: number
    }
    let data: ContentResponse
    try {
      data = await this.request<ContentResponse>(
        'GET',
        `contents/${encoded}?ref=${encodeURIComponent(ref)}`,
      )
    } catch (err) {
      if (err instanceof GithubError && err.kind === 'not-found') return null
      throw err
    }
    // Boundary guard: request<T> casts blindly, and a pathological
    // response would otherwise escape as a raw TypeError instead of a
    // classified error.
    if (data === null || typeof data !== 'object') {
      throw new GithubError('validation', 200, `getContent: unexpected response shape for ${path}`)
    }
    if (Array.isArray(data)) {
      throw new GithubError('validation', 200, `getContent: ${path} is a directory`)
    }
    if (data.encoding === 'base64' && typeof data.content === 'string') {
      if (data.content.length > 0 || data.size === 0) return base64ToBytes(data.content)
    }
    // Truncated (>1MB) or unexpected encoding — fetch via blob SHA.
    return this.getBlob(data.sha)
  }

  // -------------------------------------------------------------------------
  // Refs
  // -------------------------------------------------------------------------

  /** Branch tip SHA, or null if the ref doesn't exist. */
  async getRef(branch: string): Promise<string | null> {
    try {
      const data = await this.request<{ object: { sha: string } }>(
        'GET',
        `git/ref/${refPath(branch)}`,
      )
      return data.object.sha
    } catch (err) {
      if (err instanceof GithubError && err.kind === 'not-found') return null
      throw err
    }
  }

  /** All refs under `heads/` (paginated). Branch names may contain
   *  slashes (`archived/chat-x`). */
  async listBranchRefs(): Promise<Array<{ branch: string; sha: string }>> {
    const out: Array<{ branch: string; sha: string }> = []
    for (let page = 1; ; page++) {
      const data = await this.request<Array<{ ref: string; object: { sha: string } }>>(
        'GET',
        `git/matching-refs/heads/?per_page=100&page=${page}`,
      )
      for (const r of data) {
        out.push({ branch: r.ref.slice('refs/heads/'.length), sha: r.object.sha })
      }
      if (data.length < 100) return out
    }
  }

  /** CAS "branch must not exist": false if it already does. */
  async createRef(branch: string, sha: string): Promise<boolean> {
    try {
      await this.request('POST', 'git/refs', { ref: `refs/heads/${branch}`, sha })
      return true
    } catch (err) {
      if (
        err instanceof GithubError &&
        err.kind === 'validation' &&
        /already exists/i.test(err.message)
      ) {
        return false
      }
      throw err
    }
  }

  /** CAS fast-forward (`force: false`): false on the non-fast-forward
   *  rejection, i.e. the ref moved under us. */
  async updateRef(branch: string, sha: string, opts: { force?: boolean } = {}): Promise<boolean> {
    try {
      await this.request('PATCH', `git/refs/${refPath(branch)}`, {
        sha,
        force: opts.force ?? false,
      })
      return true
    } catch (err) {
      if (
        err instanceof GithubError &&
        err.kind === 'validation' &&
        /fast forward/i.test(err.message)
      ) {
        return false
      }
      throw err
    }
  }

  /** Delete a ref; false if it was already gone. */
  async deleteRef(branch: string): Promise<boolean> {
    try {
      await this.request('DELETE', `git/refs/${refPath(branch)}`)
      return true
    } catch (err) {
      if (
        err instanceof GithubError &&
        (err.kind === 'not-found' ||
          (err.kind === 'validation' && /does not exist/i.test(err.message)))
      ) {
        return false
      }
      throw err
    }
  }
}

/** Encode a branch name for a ref URL path, preserving `/` segments
 *  (branch names like `archived/chat-x` are path-structured refs). */
function refPath(branch: string): string {
  return `heads/${branch.split('/').map(encodeURIComponent).join('/')}`
}

/** Server-hinted retry delay: `Retry-After` (seconds) or
 *  `x-ratelimit-reset` (epoch seconds), whichever is present. */
function retryAfterMs(headers: Headers, now: () => number): number | null {
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  }
  const reset = headers.get('x-ratelimit-reset')
  if (reset !== null) {
    const epochSeconds = Number(reset)
    if (Number.isFinite(epochSeconds)) return Math.max(0, epochSeconds * 1000 - now())
  }
  return null
}
