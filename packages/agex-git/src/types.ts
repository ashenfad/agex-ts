/**
 * Result types for `VirtualGit` operations.
 *
 * Plain interfaces — kept separate from `errors.ts` so the error
 * hierarchy stays focused. Both are re-exported from `index.ts` as
 * the public surface.
 */

/** An agent-driven commit, as the agent sees it. */
export interface AgentCommit {
  readonly hash: string
  /** First 7 chars of `hash`. Cached so the CLI can format quickly. */
  readonly shortHash: string
  readonly message: string
  /** The virtual branch the commit was made on, or `null` when the
   *  commit predates the virtual-branch annotation. */
  readonly virtualBranch: string | null
  /** Virtual parents recorded in the commit's info dict; empty for
   *  root commits. */
  readonly virtualParents: ReadonlyArray<string>
  /** User-facing paths the commit's `info.files` annotation lists, or
   *  `null` when the commit didn't carry one. */
  readonly files: ReadonlyArray<string> | null
}

/** Working-tree status against the current virtual branch. */
export interface Status {
  readonly branch: string
  /** Decoded user paths whose content differs from the branch tip AND
   *  are in the staged-file index. Sorted. */
  readonly staged: ReadonlyArray<string>
  /** Decoded user paths whose content differs but aren't staged. Sorted. */
  readonly unstaged: ReadonlyArray<string>
  /** True iff `staged` and `unstaged` are both empty. */
  readonly isClean: boolean
}
