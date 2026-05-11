/**
 * `VirtualGit` — agent-view git core.
 *
 * Owns the agent's virtual git semantics (branches, index, log) and is
 * the single consumer of the kvgit / `Staged` / VFS substrate. The CLI
 * in `cli.ts` is a thin parser/formatter around this class; tests and
 * library callers can drive it directly.
 *
 * This module deliberately speaks only in agent terms. Branch
 * operations never touch real kvgit branches — those would move
 * framework state (event log, REPL namespace, agent memory) the agent
 * should not see. File-content moves go through `Staged` writes (the
 * same pattern agex-py's `git reset` already used) so the next
 * substrate-level commit carries them forward as a forward commit,
 * leaving kvgit HEAD on its real path.
 */

import type { Staged, Versioned } from 'kvgit-ts'
import { isBinary, unifiedDiff as renderUnifiedDiff } from './diff'
import { Metadata } from './metadata'
import { InvalidRef, resolveRef, virtualParents, walkVirtualAncestry } from './refs'
import type { AgentCommit, Status } from './types'

/** Polymorphic-codec FileRecord shape. Defined locally because
 *  `termish-ts/fs/kvgit`'s interface isn't exported. */
interface FileRecord {
  readonly isDir: boolean
  readonly createdAt: string
  readonly modifiedAt: string
  readonly content: Uint8Array
}

const decoder = new TextDecoder('utf-8', { fatal: false })

/** Thrown when a file path resolves to a key that's missing at the
 *  requested commit. The CLI translates to a `TerminalError`. */
export class FileNotFoundError extends Error {
  override readonly name = 'FileNotFoundError'
}

/**
 * Agent-view git operations over a kvgit / `Staged` substrate.
 *
 * - `vkv` — the `Versioned` backing the agent's session. Used for
 *   commit-info reads, history walks, and hash-level diffs. Branch
 *   APIs on this object are NEVER called.
 * - `staged` — the `Staged` wrapping `vkv`. All file reads and writes
 *   go through it; this is also where the agent-git metadata blob
 *   lives.
 * - `cwdProvider` — returns the agent's current working directory at
 *   call time. The CLI binds this to `() => ctx.fs.getcwd()` so
 *   relative-path operations follow the agent's `cd` state. Defaults
 *   to `'/'` for tests and library callers that always pass absolute
 *   paths.
 */
export class VirtualGit {
  readonly #vkv: Versioned
  readonly #staged: Staged
  readonly #cwdProvider: () => string

  constructor(vkv: Versioned, staged: Staged, opts: { cwd?: () => string } = {}) {
    this.#vkv = vkv
    this.#staged = staged
    this.#cwdProvider = opts.cwd ?? (() => '/')
  }

  // -- Substrate helpers --------------------------------------------------

  async #loadMetadata(): Promise<Metadata> {
    return Metadata.load(this.#staged)
  }

  /** Internal kvgit key → user-facing path. Strips both the `f:`
   *  prefix and the leading `/` so output matches git's
   *  relative-to-root convention (`foo/bar.txt`, not `/foo/bar.txt`).
   *  The agent's "repo root" is the VFS root. */
  decode(key: string): string {
    if (!key.startsWith('f:')) return key
    const abs = key.slice(2)
    return abs.startsWith('/') ? abs.slice(1) : abs
  }

  /** User-facing path → internal kvgit key (`f:` + absolute path). */
  encode(path: string): string {
    return `f:${resolvePath(path, this.#cwdProvider())}`
  }

  /** Whether a key represents a user-visible file. Excludes `d:` dir
   *  markers, the metadata blob, and anything else outside the `f:`
   *  namespace. */
  isVisible(key: string): boolean {
    return key.startsWith('f:')
  }

  // -- Branch state ------------------------------------------------------

  async currentBranch(): Promise<string> {
    return (await this.#loadMetadata()).current
  }

  async listBranches(): Promise<string[]> {
    return [...(await this.#loadMetadata()).branches.keys()].sort()
  }

  /** Commit hash of the current branch's tip, or `null` if unborn. */
  async head(): Promise<string | null> {
    return (await this.#loadMetadata()).head
  }

  // -- Ref resolution ----------------------------------------------------

  async resolveRef(ref: string): Promise<string> {
    return resolveRef(ref, this.#vkv, await this.#loadMetadata())
  }

  // -- Status ------------------------------------------------------------

  async status(): Promise<Status> {
    const meta = await this.#loadMetadata()
    const modified = await this.#modifiedKeys(meta)
    const staged: string[] = []
    const unstaged: string[] = []
    for (const k of modified) {
      if (meta.index.has(k)) staged.push(k)
      else unstaged.push(k)
    }
    staged.sort()
    unstaged.sort()
    return {
      branch: meta.current,
      staged: staged.map((k) => this.decode(k)),
      unstaged: unstaged.map((k) => this.decode(k)),
      isClean: staged.length === 0 && unstaged.length === 0,
    }
  }

  /** Visible keys whose live content differs from the branch tip. On
   *  an unborn branch every visible working-tree key counts as modified
   *  — there is no baseline to compare against. */
  async #modifiedKeys(meta: Metadata): Promise<Set<string>> {
    const head = meta.head
    if (head === null) {
      const out = new Set<string>()
      for await (const k of this.#staged.keys()) {
        if (this.isVisible(k)) out.add(k)
      }
      return out
    }
    return this.#diffKeyset(head, null)
  }

  // -- Log ---------------------------------------------------------------

  async log(opts: { maxCount?: number; path?: string } = {}): Promise<AgentCommit[]> {
    const meta = await this.#loadMetadata()
    const head = meta.head
    if (head === null) return []

    const pathKey = opts.path !== undefined ? this.encode(opts.path) : null

    const out: AgentCommit[] = []
    for await (const h of walkVirtualAncestry(this.#vkv, head)) {
      if (pathKey !== null) {
        const vParents = await virtualParents(this.#vkv, h)
        if (vParents.length > 0) {
          const d = await this.#vkv.diff(vParents[0] as string, h)
          const touched = d.added.has(pathKey) || d.removed.has(pathKey) || d.modified.has(pathKey)
          if (!touched) continue
        } else {
          // Root agent commit (no virtual parent). Real git includes
          // the initial commit in `git log -- path` when that commit
          // introduced the file; mirror that by checking presence at
          // the commit itself.
          const snap = await this.#staged.checkout(h)
          if (snap === null || !(await snap.has(pathKey))) continue
        }
      }
      out.push(await this.#makeCommit(h))
      if (opts.maxCount !== undefined && out.length >= opts.maxCount) break
    }
    return out
  }

  async #makeCommit(commitHash: string): Promise<AgentCommit> {
    const info = (await this.#vkv.commitInfo(commitHash)) ?? {}
    const filesRaw = info.files
    const files = Array.isArray(filesRaw)
      ? filesRaw.filter((f): f is string => typeof f === 'string')
      : null
    const message = typeof info.message === 'string' ? info.message : ''
    const branch = typeof info.virtualBranch === 'string' ? info.virtualBranch : null
    const parentsRaw = info.virtualParents
    const parents = Array.isArray(parentsRaw)
      ? parentsRaw.filter((p): p is string => typeof p === 'string')
      : []
    return {
      hash: commitHash,
      shortHash: commitHash.slice(0, 7),
      message,
      virtualBranch: branch,
      virtualParents: parents,
      files,
    }
  }

  // -- Show --------------------------------------------------------------

  /** Read file content at a specific commit. Throws `InvalidRef` when
   *  the commit is unknown and `FileNotFoundError` when the path isn't
   *  present at that commit. */
  async show(commitHash: string, path: string): Promise<Uint8Array> {
    const snap = await this.#staged.checkout(commitHash)
    if (snap === null) {
      throw new InvalidRef(`commit '${commitHash.slice(0, 7)}' not found`)
    }
    const key = this.encode(path)
    const val = await snap.get<FileRecord | undefined>(key)
    if (val === undefined || val === null) {
      throw new FileNotFoundError(`path '${path}' not found at ${commitHash.slice(0, 7)}`)
    }
    if (typeof val !== 'object' || !(val.content instanceof Uint8Array)) {
      throw new FileNotFoundError(`path '${path}' is not a file at ${commitHash.slice(0, 7)}`)
    }
    return val.content
  }

  // -- Diff --------------------------------------------------------------

  /** Unified diff between two views.
   *
   *  `a` / `b` are commit hashes (already resolved by the caller via
   *  {@link resolveRef}) or `null` meaning "the live working view".
   *  Default (both `null`) diffs HEAD vs working — matching real
   *  git's plain `git diff`. */
  async diff(opts: { a?: string | null; b?: string | null; path?: string } = {}): Promise<string> {
    const meta = await this.#loadMetadata()
    let a = opts.a ?? null
    const b = opts.b ?? null

    if (a === null && b === null) {
      const head = meta.head
      if (head === null) return ''
      a = head
    }

    let keys = await this.#diffKeyset(a, b)
    if (opts.path !== undefined) {
      const target = this.encode(opts.path)
      keys = new Set([...keys].filter((k) => k === target))
    }

    const snapA = a !== null ? await this.#staged.checkout(a) : this.#staged
    const snapB = b !== null ? await this.#staged.checkout(b) : this.#staged
    if (snapA === null || snapB === null) {
      throw new InvalidRef('commit not found')
    }
    return this.#renderDiff(snapA, snapB, keys)
  }

  /** Visible keys that differ between two views. When both sides are
   *  commits, uses kvgit's hash-level diff (HAMT root comparison —
   *  O(log N)). When either side is the live working view, falls back
   *  to content comparison since there's no commit hash to compare. */
  async #diffKeyset(a: string | null, b: string | null): Promise<Set<string>> {
    if (a !== null && b !== null) {
      const d = await this.#vkv.diff(a, b)
      const out = new Set<string>()
      for (const k of d.added) if (this.isVisible(k)) out.add(k)
      for (const k of d.removed) if (this.isVisible(k)) out.add(k)
      for (const k of d.modified) if (this.isVisible(k)) out.add(k)
      return out
    }
    const snapA = a !== null ? await this.#staged.checkout(a) : this.#staged
    const snapB = b !== null ? await this.#staged.checkout(b) : this.#staged
    if (snapA === null || snapB === null) {
      throw new InvalidRef('commit not found')
    }
    const aKeys = new Set<string>()
    for await (const k of snapA.keys()) {
      if (this.isVisible(k)) aKeys.add(k)
    }
    const bKeys = new Set<string>()
    for await (const k of snapB.keys()) {
      if (this.isVisible(k)) bKeys.add(k)
    }
    const result = new Set<string>()
    for (const k of aKeys) if (!bKeys.has(k)) result.add(k)
    for (const k of bKeys) if (!aKeys.has(k)) result.add(k)
    for (const k of aKeys) {
      if (!bKeys.has(k)) continue
      const va = await snapA.get<FileRecord | undefined>(k)
      const vb = await snapB.get<FileRecord | undefined>(k)
      if (!fileContentEqual(va, vb)) result.add(k)
    }
    return result
  }

  async #renderDiff(snapA: Staged, snapB: Staged, keys: Set<string>): Promise<string> {
    const out: string[] = []
    for (const key of [...keys].sort()) {
      const display = this.decode(key)
      const recA = await snapA.get<FileRecord | undefined>(key)
      const recB = await snapB.get<FileRecord | undefined>(key)
      const oldBytes = recA?.content ?? null
      const newBytes = recB?.content ?? null

      if (isBinary(oldBytes) || isBinary(newBytes)) {
        out.push(`Binary files a/${display} and b/${display} differ\n`)
        continue
      }

      const oldText = oldBytes !== null ? decoder.decode(oldBytes) : ''
      const newText = newBytes !== null ? decoder.decode(newBytes) : ''
      out.push(renderUnifiedDiff(oldText, newText, display, display))
    }
    return out.join('')
  }
}

/** Compare two FileRecord values by their `content` bytes. Treats
 *  missing records as a non-match against present ones, and identical
 *  byte sequences as equal. Mirrors agex-py's `bytes != bytes`
 *  comparison after the polymorphic decode. */
function fileContentEqual(
  a: FileRecord | undefined | null,
  b: FileRecord | undefined | null,
): boolean {
  if (a === undefined || a === null) return b === undefined || b === null
  if (b === undefined || b === null) return false
  if (a.content.byteLength !== b.content.byteLength) return false
  for (let i = 0; i < a.content.byteLength; i++) {
    if (a.content[i] !== b.content[i]) return false
  }
  return true
}

/** Inline POSIX path resolver (parity with `termish-ts/src/fs/path`,
 *  which isn't publicly exported). Relative paths anchor to `cwd`;
 *  absolute paths normalize directly. */
function resolvePath(path: string, cwd: string): string {
  const combined = path.startsWith('/') ? path : `${cwd}/${path}`
  const segments = combined.split('/').filter((s) => s !== '' && s !== '.')
  const out: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      if (out.length > 0) out.pop()
    } else {
      out.push(seg)
    }
  }
  return `/${out.join('/')}`
}
