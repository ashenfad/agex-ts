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
import {
  AgentGitError,
  BranchExists,
  BranchNotFound,
  BranchNotMerged,
  NothingToCommit,
  PathSpecError,
  PendingChanges,
  UnbornBranch,
} from './errors'
import { Metadata } from './metadata'
import {
  InvalidRef,
  allAncestors,
  mergeBase,
  resolveRef,
  virtualParents,
  walkVirtualAncestry,
} from './refs'
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

  // -- Working-tree application ------------------------------------------

  /** Persist pending Staged changes as an unmessaged kvgit commit.
   *
   *  Used after checkout / reset / fast-forward merge to bring the
   *  kvgit physical chain in line with virtual semantics *before* the
   *  next agent commit. Without this, a subsequent selective
   *  `staged.commit({keys: ...})` would inherit unrelated keys from
   *  the physical parent (e.g. a file removed by checkout would
   *  re-appear in the next commit because selective flush ignores
   *  removals outside its key set).
   *
   *  Equivalent to what the agent loop's between-turns auto-commit
   *  does at task boundaries — just done synchronously so two virtual
   *  operations in the same `terminal_action` stay self-consistent. */
  async #flushAlignment(): Promise<void> {
    if (this.#staged.hasChanges) {
      await this.#staged.commit({})
    }
  }

  /** Make the live working view match `targetHash` (visible keys only).
   *
   *  Writes through `Staged` so the next substrate-level commit
   *  carries the change forward as a forward kvgit commit, leaving
   *  real kvgit HEAD on its native chain. Non-VFS keys (event log,
   *  REPL namespace, agent memory) are NOT touched. */
  async #applyFileView(targetHash: string): Promise<void> {
    const target = await this.#staged.checkout(targetHash)
    if (target === null) {
      throw new InvalidRef(`commit '${targetHash.slice(0, 7)}' not found`)
    }

    // Snapshot key sets first — `staged.keys()` and `target.keys()`
    // are async iterators, and we'll be mutating the buffer below.
    const curKeys = new Set<string>()
    for await (const k of this.#staged.keys()) {
      if (this.isVisible(k)) curKeys.add(k)
    }
    const targetKeys = new Set<string>()
    for await (const k of target.keys()) {
      if (this.isVisible(k)) targetKeys.add(k)
    }

    for (const key of curKeys) {
      if (!targetKeys.has(key)) this.#staged.delete(key)
    }
    for (const key of targetKeys) {
      const targetVal = await target.get<FileRecord | undefined>(key)
      if (targetVal === undefined) continue
      const curVal = curKeys.has(key) ? await this.#staged.get<FileRecord | undefined>(key) : null
      if (!fileContentEqual(curVal, targetVal)) {
        this.#staged.set(key, targetVal)
      }
    }
  }

  // -- add / rm ----------------------------------------------------------

  /** Stage paths for the next commit.
   *
   *  `["."]` or `["-A"]` stages every currently-modified file.
   *  Non-existent / unmodified paths raise {@link PathSpecError},
   *  matching real git's `pathspec` behaviour. Paths that are unchanged
   *  but exist (in the working tree or at HEAD) are accepted as a
   *  no-op — `git add unchanged.txt` doesn't error in real git. */
  async add(paths: ReadonlyArray<string>): Promise<void> {
    if (paths.length === 0) throw new PathSpecError('nothing specified')

    const meta = await this.#loadMetadata()
    const modified = await this.#modifiedKeys(meta)

    if (paths.length === 1 && (paths[0] === '.' || paths[0] === '-A')) {
      for (const k of modified) meta.index.add(k)
      meta.save(this.#staged)
      return
    }

    // Build the universe of "known" keys: working tree + branch tip.
    // Either is sufficient justification to `add` a path.
    const known = new Set<string>()
    for await (const k of this.#staged.keys()) {
      if (this.isVisible(k)) known.add(k)
    }
    if (meta.head !== null) {
      const headSnap = await this.#staged.checkout(meta.head)
      if (headSnap !== null) {
        for await (const k of headSnap.keys()) {
          if (this.isVisible(k)) known.add(k)
        }
      }
    }

    for (const path of paths) {
      const key = this.encode(path)
      if (!known.has(key) && !modified.has(key)) {
        throw new PathSpecError(`pathspec '${path}' did not match any files`)
      }
      meta.index.add(key)
    }
    meta.save(this.#staged)
  }

  /** Remove paths from the working tree and stage the deletion.
   *
   *  Returns silently on success. With `recursive: true`, removes every
   *  visible key whose decoded path is exactly `path` or starts with
   *  `path/`. A path that's already gone from the working tree but is
   *  still tracked at HEAD is accepted (re-stages the deletion idempotently
   *  — matches real git's behaviour after a shell `rm`). */
  async rm(paths: ReadonlyArray<string>, opts: { recursive?: boolean } = {}): Promise<void> {
    if (paths.length === 0) throw new PathSpecError('nothing specified')
    const recursive = opts.recursive === true

    const meta = await this.#loadMetadata()

    for (const path of paths) {
      const internal = this.encode(path)

      if (recursive) {
        // Snapshot keys first — we'll mutate the buffer below.
        const allKeys: string[] = []
        for await (const k of this.#staged.keys()) {
          if (this.isVisible(k)) allKeys.push(k)
        }
        const trimmed = path.replace(/\/+$/, '')
        const candidates: string[] = []
        for (const key of allKeys) {
          const decoded = this.decode(key)
          // `decoded` is repo-root relative (no leading `/`); the path
          // arg may be either form. Normalize both for comparison.
          const decodedAbs = `/${decoded}`
          const pathAbs = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
          if (decodedAbs === pathAbs || decodedAbs.startsWith(`${pathAbs}/`)) {
            candidates.push(key)
          }
        }
        if (candidates.length === 0) {
          throw new PathSpecError(`pathspec '${path}' did not match any files`)
        }
        for (const key of candidates) {
          this.#staged.delete(key)
          meta.index.add(key)
        }
      } else {
        if (await this.#staged.has(internal)) {
          this.#staged.delete(internal)
          meta.index.add(internal)
        } else {
          // File isn't in the working tree. Real git still accepts
          // `git rm` on a path tracked at HEAD that was already
          // deleted from the workspace — idempotently re-stages the
          // deletion. Without this, an agent can't `git rm` a file
          // they already removed via shell `rm`.
          let inHead = false
          if (meta.head !== null) {
            const headSnap = await this.#staged.checkout(meta.head)
            if (headSnap !== null) inHead = await headSnap.has(internal)
          }
          if (!inHead) {
            throw new PathSpecError(`pathspec '${path}' did not match any files`)
          }
          meta.index.add(internal)
        }
      }
    }
    meta.save(this.#staged)
  }

  // -- commit ------------------------------------------------------------

  /** Record a new agent commit on the current branch.
   *
   *  Selective when `meta.index` is non-empty (only those keys are
   *  flushed); full when the index is empty. Modified content is
   *  re-staged into the buffer so a selective flush picks up files
   *  that the agent loop's auto-commit already pushed through to
   *  kvgit between turns.
   *
   *  Updates the branch ref in metadata and clears the index on
   *  success. The metadata write is staged for the next substrate
   *  flush to persist. */
  async commit(message: string): Promise<AgentCommit> {
    const meta = await this.#loadMetadata()
    const modified = await this.#modifiedKeys(meta)
    if (modified.size === 0) {
      throw new NothingToCommit('nothing to commit, working tree clean')
    }

    let keysToCommit: Set<string>
    if (meta.index.size > 0) {
      keysToCommit = new Set<string>()
      for (const k of meta.index) {
        if (modified.has(k)) keysToCommit.add(k)
      }
      if (keysToCommit.size === 0) {
        throw new NothingToCommit('nothing to commit (staged files match the branch tip)')
      }
    } else {
      keysToCommit = new Set(modified)
    }

    // Re-stage current values so a selective flush picks them up even
    // when the framework's auto-commit already pushed them through to
    // kvgit between turns. Deletions that landed in kvgit remain
    // absent from the new commit naturally (parented to the latest
    // kvgit HEAD which already excludes them).
    for (const key of keysToCommit) {
      const curVal = await this.#staged.get<FileRecord | undefined>(key)
      if (curVal !== undefined) {
        this.#staged.set(key, curVal)
      } else if (await this.#staged.has(key)) {
        // Defensive: key is still in some buffered form despite
        // get() returning undefined — force the deletion so the
        // selective commit flushes it.
        this.#staged.delete(key)
      }
    }

    const info: Record<string, unknown> = {
      message,
      files: [...keysToCommit].map((k) => this.decode(k)).sort(),
      virtualBranch: meta.current,
      virtualParents: meta.head !== null ? [meta.head] : [],
    }
    const result = await this.#staged.commit({ keys: keysToCommit, info })
    const newHash = result.commit
    if (newHash === null) {
      throw new AgentGitError('commit was abandoned (conflict)')
    }

    meta.branches.set(meta.current, newHash)
    meta.index.clear()
    meta.save(this.#staged)

    return this.#makeCommit(newHash)
  }

  // -- reset -------------------------------------------------------------

  /** Restore the working tree to `target` and rewind the branch ref.
   *
   *  `target` is a commit hash already resolved by the caller. Only
   *  `--hard` is supported. This is a *virtual* reset: kvgit HEAD is
   *  not moved. The branch ref in metadata is rewound to `target` so
   *  subsequent `git log` / `HEAD~N` reflect the reset, matching real
   *  git's `reset --hard` behaviour. */
  async reset(target: string, opts: { hard?: boolean } = {}): Promise<void> {
    const hard = opts.hard ?? true
    if (!hard) throw new AgentGitError('only --hard is supported')

    const meta = await this.#loadMetadata()
    await this.#applyFileView(target)

    meta.branches.set(meta.current, target)
    meta.index.clear()
    meta.save(this.#staged)
    await this.#flushAlignment()
  }

  // -- branch operations -------------------------------------------------

  /** Create a new virtual branch pointing at the current branch's tip.
   *
   *  Throws {@link BranchExists} if `name` already names a branch and
   *  {@link UnbornBranch} if the current branch has no commits
   *  (mirroring real git's "Not a valid object name"). */
  async createBranch(name: string): Promise<void> {
    if (name.length === 0) throw new AgentGitError('branch name required')

    const meta = await this.#loadMetadata()
    if (meta.branches.has(name)) {
      throw new BranchExists(`branch '${name}' already exists`)
    }
    if (meta.head === null) {
      throw new UnbornBranch(`cannot create branch '${name}': '${meta.current}' has no commits yet`)
    }
    meta.branches.set(name, meta.head)
    meta.save(this.#staged)
  }

  /** Delete a virtual branch.
   *
   *  Without `force: true`, refuses to delete a branch whose tip
   *  isn't reachable from the current branch (i.e., would lose
   *  commits). */
  async deleteBranch(name: string, opts: { force?: boolean } = {}): Promise<void> {
    const force = opts.force === true
    const meta = await this.#loadMetadata()
    if (!meta.branches.has(name)) {
      throw new BranchNotFound(`branch '${name}' not found`)
    }
    if (name === meta.current) {
      throw new AgentGitError(`cannot delete branch '${name}' currently checked out`)
    }

    if (!force) {
      const tip = meta.branches.get(name) as string
      const reachable = await allAncestors(this.#vkv, meta.head)
      if (!reachable.has(tip)) {
        throw new BranchNotMerged(
          `branch '${name}' is not fully merged.\nUse force-delete to discard its commits.`,
        )
      }
    }

    meta.branches.delete(name)
    meta.save(this.#staged)
  }

  /** Switch the current virtual branch.
   *
   *  `create: true` creates the branch first (like `git checkout -b`).
   *  Without `force: true`, refuses if the working tree has visible
   *  modifications relative to the current branch tip — the
   *  equivalent of real git's "would be overwritten by checkout"
   *  guard, but content-based instead of buffer-based so it catches
   *  edits the framework auto-commit already flushed through kvgit.
   *
   *  On success the working tree is rewritten to match the target
   *  branch (visible keys only — non-VFS state is untouched), the
   *  branch ref in metadata advances, and the index clears. */
  async checkout(name: string, opts: { create?: boolean; force?: boolean } = {}): Promise<void> {
    if (name.length === 0) throw new AgentGitError('branch name required')
    const create = opts.create === true
    const force = opts.force === true

    const meta = await this.#loadMetadata()

    if (create) {
      if (meta.branches.has(name)) {
        throw new BranchExists(`branch '${name}' already exists`)
      }
      if (meta.head === null) {
        throw new UnbornBranch(
          `cannot create branch '${name}': '${meta.current}' has no commits yet`,
        )
      }
      meta.branches.set(name, meta.head)
    }

    if (!meta.branches.has(name)) {
      throw new BranchNotFound(`branch '${name}' does not exist`)
    }

    if (name === meta.current && !create) {
      return // no-op
    }

    if (!force) {
      const modified = await this.#modifiedKeys(meta)
      if (modified.size > 0) {
        throw new PendingChanges(
          "your local changes would be lost.\nPlease commit your changes (git commit -m '...') before switching branches.",
        )
      }
    }

    const target = meta.branches.get(name) as string
    await this.#applyFileView(target)

    meta.current = name
    meta.index.clear()
    meta.save(this.#staged)
    await this.#flushAlignment()
  }

  // -- merge -------------------------------------------------------------

  /** Merge the `source` virtual branch into the current branch.
   *
   *  Returns the merge commit (or fast-forward target) on success, or
   *  `null` when already up to date.
   *
   *  Semantics (v1):
   *  - `source` reachable from current → already up to date.
   *  - Current reachable from source → fast-forward (no merge commit;
   *    branch ref just advances to `source`).
   *  - Otherwise → "source wins" merge. Files differing between the
   *    two tips take `source`'s value; files unique to current are
   *    kept; files unique to source are added; files removed on
   *    source are removed. No three-way text merge is attempted. */
  async merge(source: string, opts: { force?: boolean } = {}): Promise<AgentCommit | null> {
    if (source.length === 0) throw new AgentGitError('branch name required')
    const force = opts.force === true

    const meta = await this.#loadMetadata()
    if (source === meta.current) {
      throw new AgentGitError('cannot merge a branch into itself')
    }
    if (!meta.branches.has(source)) {
      throw new BranchNotFound(`branch '${source}' not found`)
    }

    const sourceTip = meta.branches.get(source) as string
    const currentTip = meta.head
    if (currentTip === null) {
      throw new UnbornBranch(`current branch '${meta.current}' has no commits to merge into`)
    }

    if (sourceTip === currentTip) return null // already up to date

    // If source is an ancestor of current, current already has it.
    if ((await allAncestors(this.#vkv, currentTip)).has(sourceTip)) return null

    if (!force) {
      const modified = await this.#modifiedKeys(meta)
      if (modified.size > 0) {
        throw new PendingChanges(
          "your local changes would be overwritten.\nPlease commit your changes (git commit -m '...') before merging.",
        )
      }
    }

    // Fast-forward when current is in source's ancestry.
    if ((await allAncestors(this.#vkv, sourceTip)).has(currentTip)) {
      await this.#applyFileView(sourceTip)
      meta.branches.set(meta.current, sourceTip)
      meta.index.clear()
      meta.save(this.#staged)
      await this.#flushAlignment()
      return this.#makeCommit(sourceTip)
    }

    // True merge: apply only the changes `source` made *since the
    // merge base*. Files current changed independently of source are
    // left alone; files both branches changed (a real conflict in
    // 3-way merge terms) take source's value — v1's "theirs wins on
    // conflict" approximation.
    const base = await mergeBase(this.#vkv, currentTip, sourceTip)
    if (base === null) {
      throw new AgentGitError('merge: no common ancestor (refusing to merge unrelated histories)')
    }
    const diff = await this.#vkv.diff(base, sourceTip)
    const affected = new Set<string>()
    for (const k of diff.added) if (this.isVisible(k)) affected.add(k)
    for (const k of diff.modified) if (this.isVisible(k)) affected.add(k)
    for (const k of diff.removed) if (this.isVisible(k)) affected.add(k)

    const sourceSnap = await this.#staged.checkout(sourceTip)
    if (sourceSnap === null) {
      throw new AgentGitError(`merge: source commit '${sourceTip.slice(0, 7)}' not found`)
    }

    for (const key of affected) {
      if (diff.removed.has(key)) {
        if (await this.#staged.has(key)) this.#staged.delete(key)
      } else {
        const val = await sourceSnap.get<FileRecord | undefined>(key)
        if (val !== undefined) this.#staged.set(key, val)
      }
    }

    const info: Record<string, unknown> = {
      message: `Merge branch '${source}'`,
      files: [...affected].map((k) => this.decode(k)).sort(),
      virtualBranch: meta.current,
      virtualParents: [currentTip, sourceTip],
    }
    const result = await this.#staged.commit({ keys: affected, info })
    const newHash = result.commit
    if (newHash === null) {
      throw new AgentGitError('merge: commit was abandoned (conflict)')
    }

    meta.branches.set(meta.current, newHash)
    meta.index.clear()
    meta.save(this.#staged)

    return this.#makeCommit(newHash)
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
