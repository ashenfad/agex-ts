/**
 * Ref resolution and virtual ancestry walks.
 *
 * Agent commits record their *virtual* parent(s) in `commitInfo`
 * (`virtualParents`) — these point to the previous tip of the same
 * virtual branch (one parent for a normal commit, two for a merge).
 * That graph is independent of kvgit's physical commit chain, which
 * also includes framework commits (turn-boundary auto-commits) and is
 * therefore not what the agent should walk for `git log` / `HEAD~N` /
 * merge-base.
 *
 * This module provides the navigation primitives over that virtual
 * graph. It does not depend on termish or any CLI plumbing — the CLI
 * translates {@link InvalidRef} into a `TerminalError`.
 */

import type { Versioned } from 'kvgit-ts'
import type { Metadata } from './metadata'

/** Minimum hash prefix length accepted by {@link resolveRef}. Matches
 *  common git tooling and the prior behaviour of agex-py's git CLI. */
export const HASH_PREFIX_MIN_LEN = 7

export class InvalidRef extends Error {
  override readonly name = 'InvalidRef'
}

// ---------------------------------------------------------------------------
// Agent-commit identification
// ---------------------------------------------------------------------------

/** Whether `commitHash` was created by an explicit `git commit -m`.
 *  Framework commits (turn-boundary auto-commits) carry no `message`
 *  in their info dict; agent-driven commits always do. */
export async function isAgentCommit(vkv: Versioned, commitHash: string): Promise<boolean> {
  const info = await vkv.commitInfo(commitHash)
  if (info === null) return false
  const msg = info.message
  return typeof msg === 'string' && msg.length > 0
}

/** All agent-driven commits across the kvgit store, newest-first.
 *  Used as the search space for hash-prefix resolution and for sanity
 *  checks; *not* used for `git log` output, which walks per-branch
 *  virtual ancestry instead. */
export async function allAgentCommits(vkv: Versioned): Promise<string[]> {
  const out: string[] = []
  for await (const h of vkv.history()) {
    if (await isAgentCommit(vkv, h)) out.push(h)
  }
  return out
}

// ---------------------------------------------------------------------------
// Virtual ancestry
// ---------------------------------------------------------------------------

/** Virtual parents recorded in `commitInfo` for `commitHash`.
 *  Returns the empty list if the commit has no recorded virtual
 *  parents (root commit on a branch, or a commit predating the
 *  virtual-branch system). */
export async function virtualParents(vkv: Versioned, commitHash: string): Promise<string[]> {
  const info = (await vkv.commitInfo(commitHash)) ?? {}
  const parents = info.virtualParents
  if (!Array.isArray(parents) || parents.length === 0) return []
  // Defensive — superjson preserves arrays, but a malformed blob
  // could carry non-strings. Filter to strings.
  return parents.filter((p): p is string => typeof p === 'string')
}

/** Lowest common ancestor of two commits in the virtual DAG.
 *
 *  Returns `null` when either input is `null` or the two histories
 *  share no ancestor (unrelated trees). When `a === b` or one is
 *  reachable from the other, returns the deeper of the two (matching
 *  real git's `git merge-base` behaviour). */
export async function mergeBase(
  vkv: Versioned,
  a: string | null,
  b: string | null,
): Promise<string | null> {
  if (a === null || b === null) return null
  if (a === b) return a

  const aAncestors = await allAncestors(vkv, a)
  if (aAncestors.has(b)) return b

  // BFS from b — the first ancestor we hit that's also in aAncestors
  // is the LCA. BFS guarantees the *closest* common ancestor first.
  const seen = new Set<string>()
  const queue: string[] = [b]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    if (seen.has(cur)) continue
    seen.add(cur)
    if (aAncestors.has(cur)) return cur
    queue.push(...(await virtualParents(vkv, cur)))
  }
  return null
}

/** All virtual ancestors of `head` reachable via either parent.
 *
 *  Unlike {@link walkVirtualAncestry} this is a full DAG walk: merge
 *  commits expose *both* parents, so the result is the closure needed
 *  to answer "is X reachable from HEAD?" — used by `branch -d` to
 *  decide whether a branch is fully merged.
 *
 *  Returns the empty set for an unborn branch. Includes `head` itself
 *  in the result. */
export async function allAncestors(vkv: Versioned, head: string | null): Promise<Set<string>> {
  const seen = new Set<string>()
  if (head === null) return seen
  const stack: string[] = [head]
  while (stack.length > 0) {
    const h = stack.pop() as string
    if (seen.has(h)) continue
    seen.add(h)
    stack.push(...(await virtualParents(vkv, h)))
  }
  return seen
}

/** Yield commits along the first-parent virtual ancestry from `head`.
 *
 *  Linear walk via `virtualParents[0]`; for merge commits this follows
 *  the "into" branch (the branch the merge was made on), matching
 *  real git's first-parent log convention.
 *
 *  Yields nothing when `head` is `null` (unborn branch). Defensive
 *  against pathological cycles via a visited-set guard; cycles
 *  shouldn't be reachable through content-addressed commits but a
 *  corrupt store shouldn't deadlock the CLI. */
export async function* walkVirtualAncestry(
  vkv: Versioned,
  head: string | null,
): AsyncIterableIterator<string> {
  if (head === null) return
  const seen = new Set<string>()
  let cur: string | null = head
  while (cur !== null && !seen.has(cur)) {
    seen.add(cur)
    yield cur
    const parents = await virtualParents(vkv, cur)
    cur = parents[0] ?? null
  }
}

// ---------------------------------------------------------------------------
// Ref resolution
// ---------------------------------------------------------------------------

/** Resolve an agent-supplied ref string to a commit hash.
 *
 *  Resolution order:
 *
 *  1. `HEAD`: the tip of `metadata.current`.
 *  2. `HEAD~N` (`N >= 0`): walk N steps back through virtual
 *     ancestry from `HEAD`.
 *  3. Branch name: lookup in `metadata.branches`.
 *  4. Hash prefix (>= 7 chars): match against any agent-tagged commit.
 *
 *  Throws {@link InvalidRef} for empty input, unborn `HEAD`, `HEAD~N`
 *  exceeding ancestry length, unknown branch names, or unmatched /
 *  ambiguous hash prefixes. */
export async function resolveRef(ref: string, vkv: Versioned, metadata: Metadata): Promise<string> {
  if (ref.length === 0) throw new InvalidRef('empty ref')

  if (ref === 'HEAD') {
    const head = metadata.head
    if (head === null) {
      throw new InvalidRef(`HEAD is unborn (branch '${metadata.current}' has no commits)`)
    }
    return head
  }

  if (ref.startsWith('HEAD~')) {
    const tail = ref.slice('HEAD~'.length)
    const n = Number.parseInt(tail, 10)
    if (Number.isNaN(n) || `${n}` !== tail || n < 0) {
      throw new InvalidRef(`invalid ref '${ref}'`)
    }
    const ancestry: string[] = []
    for await (const h of walkVirtualAncestry(vkv, metadata.head)) {
      ancestry.push(h)
    }
    if (ancestry.length === 0) {
      throw new InvalidRef(`HEAD is unborn (branch '${metadata.current}' has no commits)`)
    }
    if (n >= ancestry.length) {
      const plural = ancestry.length === 1 ? '' : 's'
      throw new InvalidRef(
        `'${ref}' is beyond the history (${ancestry.length} commit${plural} on branch '${metadata.current}')`,
      )
    }
    return ancestry[n] as string
  }

  // Branch names take precedence over hash prefixes — matches real git.
  const branchHash = metadata.branches.get(ref)
  if (branchHash !== undefined) return branchHash

  if (ref.length >= HASH_PREFIX_MIN_LEN) {
    const matches = (await allAgentCommits(vkv)).filter((h) => h.startsWith(ref))
    if (matches.length === 1) return matches[0] as string
    if (matches.length > 1) {
      throw new InvalidRef(`ambiguous ref '${ref}' matches ${matches.length} commits`)
    }
  }

  throw new InvalidRef(`'${ref}' is not a valid ref`)
}
