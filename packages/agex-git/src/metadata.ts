/**
 * Schema and I/O for the agent-view git metadata blob.
 *
 * Holds the agent's "virtual" git state — current branch, branch
 * refs, staged-file index — in a single value at a reserved kvgit
 * key. Deliberately separate from kvgit's own branch state: real
 * kvgit branches own the entire keyspace (event log, REPL, VFS) and
 * must never be moved by an agent `git` command, so the agent layer
 * keeps its own bookkeeping here.
 *
 * The blob is a plain object round-tripped through whatever encoder
 * the surrounding `Staged` is configured with — in production agex-ts
 * setups that's the polymorphic codec from `termish-ts/fs/kvgit`,
 * which routes plain objects through `superjson`. The blob doesn't
 * start with the `f:` / `d:` `KvgitFS` prefixes, so the agent's VFS
 * never treats it as a file.
 */

import type { Staged } from 'kvgit-ts'

/**
 * Reserved kvgit key. Plain object value, encoded via the surrounding
 * `Staged`'s encoder. The leading/trailing dunders are stylistic —
 * the isolation contract is "must not collide with any KvgitFS-encoded
 * path", which holds because `KvgitFS` only treats keys with the `f:`
 * (file) or `d:` (dir) prefix as file-system entries.
 */
export const METADATA_KEY = '__agex_git__'

export const DEFAULT_BRANCH = 'main'

/**
 * Persisted shape stored under {@link METADATA_KEY}. Loaders are
 * tolerant of partial / older blobs so a load can never crash the
 * git CLI on a degraded store.
 */
interface MetadataBlob {
  readonly current?: string
  readonly branches?: Readonly<Record<string, string>>
  /** Stored as a sorted array for stable serialisation; loaders coerce
   *  back into a `Set`. */
  readonly index?: ReadonlyArray<string>
}

/**
 * Agent-view git state.
 *
 * - `current` — name of the currently checked-out virtual branch.
 *   Always set; defaults to `"main"`. May refer to a branch that has
 *   no entry in `branches` yet — that's the "unborn" state of a
 *   fresh store before the first commit, mirroring real `git init`.
 * - `branches` — branch name → kvgit commit hash. An entry exists
 *   for every virtual branch that has at least one commit. Empty for
 *   a fresh store.
 * - `index` — internal kvgit keys (encoded VFS keys) the agent has
 *   explicitly staged via `git add`. The next `git commit` flushes
 *   only these keys when the set is non-empty.
 */
export class Metadata {
  current: string
  readonly branches: Map<string, string>
  readonly index: Set<string>

  constructor(opts?: {
    current?: string
    branches?: Iterable<readonly [string, string]> | Readonly<Record<string, string>>
    index?: Iterable<string>
  }) {
    this.current = opts?.current ?? DEFAULT_BRANCH
    if (opts?.branches === undefined) {
      this.branches = new Map()
    } else if (Symbol.iterator in (opts.branches as object)) {
      this.branches = new Map(opts.branches as Iterable<readonly [string, string]>)
    } else {
      this.branches = new Map(Object.entries(opts.branches as Record<string, string>))
    }
    this.index = new Set(opts?.index ?? [])
  }

  /** Commit hash for {@link current}, or `null` if unborn. */
  get head(): string | null {
    return this.branches.get(this.current) ?? null
  }

  /** Read metadata from `staged`. Returns defaults if absent. */
  static async load(staged: Staged): Promise<Metadata> {
    const raw = (await staged.get<MetadataBlob>(METADATA_KEY)) ?? null
    if (raw === null) return new Metadata()
    return new Metadata({
      current: typeof raw.current === 'string' ? raw.current : DEFAULT_BRANCH,
      branches: raw.branches ?? {},
      index: raw.index ?? [],
    })
  }

  /** Write metadata back to `staged` as a fresh blob. */
  save(staged: Staged): void {
    staged.set(METADATA_KEY, {
      current: this.current,
      branches: Object.fromEntries(this.branches),
      // Sorted array for stable serialisation; load() coerces back to Set.
      index: [...this.index].sort(),
    } satisfies MetadataBlob)
  }
}
