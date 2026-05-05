/**
 * Pure three-way merge resolution.
 *
 * `resolveMerge` takes a fully-decoded snapshot of the merge state
 * (LCA / ours / theirs keysets, the diffs from LCA to each, a blob
 * reader, the merge fns) and returns a `MergeResolution` ready to be
 * persisted as a merge commit.
 *
 * The function is pure with respect to storage — the only IO is the
 * injected `blobReader`. `VersionedBase` calls it inside the merge
 * orchestration; users implementing custom backends call it the same
 * way.
 */

import { type BytesMergeFn, type DiffResult, MergeConflict } from '../types'

/** Read a blob's bytes by its content identifier (versioned key). */
export type BlobReader = (id: string) => Promise<Uint8Array | null>

/**
 * Result of a successful merge resolution.
 *
 * `mergedKeyset` is the new commit's flat keyset (key → blob pointer).
 * Existing pointers are reused for keys that didn't move; merged-value
 * keys still hold a placeholder pointer (the caller resolves these to
 * `<merge_hash>:<key>` when materializing the merge commit).
 *
 * `mergedValues` holds the bytes for keys that the merge fns produced
 * — these get written as fresh blobs at commit time.
 *
 * `autoMergedKeys` lists the keys a merge fn resolved (for reporting).
 */
export interface MergeResolution {
  readonly mergedKeyset: Map<string, string>
  readonly mergedValues: Map<string, Uint8Array>
  readonly autoMergedKeys: readonly string[]
}

export interface ResolveMergeOptions {
  lcaKeyset: ReadonlyMap<string, string>
  ourKeyset: ReadonlyMap<string, string>
  theirKeyset: ReadonlyMap<string, string>
  ourDiff: DiffResult
  theirDiff: DiffResult
  blobReader: BlobReader
  mergeFns: ReadonlyMap<string, BytesMergeFn>
  defaultMerge: BytesMergeFn | null
}

/**
 * Resolve a three-way merge between two diverged keysets.
 *
 * Does NOT create commits or advance HEAD — the caller handles
 * persistence. Throws `MergeConflict` if any contested key is
 * unresolvable (no merge fn, or the fn threw).
 */
export async function resolveMerge(opts: ResolveMergeOptions): Promise<MergeResolution> {
  const {
    lcaKeyset,
    ourKeyset,
    theirKeyset,
    ourDiff,
    theirDiff,
    blobReader,
    mergeFns,
    defaultMerge,
  } = opts

  const ourChanged = union(ourDiff.added, ourDiff.removed, ourDiff.modified)
  const theirChanged = union(theirDiff.added, theirDiff.removed, theirDiff.modified)
  const allChanged = union(ourChanged, theirChanged)

  const mergedKeyset = new Map<string, string>()
  const mergedValues = new Map<string, Uint8Array>()
  const autoMerged: string[] = []
  const conflicts = new Set<string>()
  const mergeErrors = new Map<string, unknown>()

  // Unchanged keys: carry from theirs (HEAD).
  const allKeys = new Set<string>([...ourKeyset.keys(), ...theirKeyset.keys()])
  for (const key of allKeys) {
    if (allChanged.has(key)) continue
    const fromTheirs = theirKeyset.get(key)
    if (fromTheirs !== undefined) {
      mergedKeyset.set(key, fromTheirs)
    } else {
      const fromOurs = ourKeyset.get(key)
      if (fromOurs !== undefined) mergedKeyset.set(key, fromOurs)
    }
  }

  // Changed only by us.
  for (const key of ourChanged) {
    if (theirChanged.has(key)) continue
    if (!ourDiff.removed.has(key)) {
      const ptr = ourKeyset.get(key)
      if (ptr !== undefined) {
        mergedKeyset.set(key, ptr)
        autoMerged.push(key)
      }
    }
  }

  // Changed only by them.
  for (const key of theirChanged) {
    if (ourChanged.has(key)) continue
    if (!theirDiff.removed.has(key)) {
      const ptr = theirKeyset.get(key)
      if (ptr !== undefined) mergedKeyset.set(key, ptr)
    }
  }

  // Contested: changed by both sides.
  const contested = intersection(ourChanged, theirChanged)
  for (const key of contested) {
    const ourRemoved = ourDiff.removed.has(key)
    const theirRemoved = theirDiff.removed.has(key)

    if (ourRemoved && theirRemoved) continue // both deleted — drop

    // Same change on both sides → use either (use theirs).
    if (!ourRemoved && !theirRemoved && ourKeyset.get(key) === theirKeyset.get(key)) {
      const ptr = theirKeyset.get(key)
      if (ptr !== undefined) mergedKeyset.set(key, ptr)
      continue
    }

    // Try a merge fn.
    const fn = mergeFns.get(key) ?? defaultMerge
    if (fn === null || fn === undefined) {
      conflicts.add(key)
      continue
    }

    const lcaPtr = lcaKeyset.get(key)
    const ourPtr = ourKeyset.get(key)
    const theirPtr = theirKeyset.get(key)

    const oldVal = lcaPtr !== undefined ? await blobReader(lcaPtr) : null
    const ourVal = ourRemoved || ourPtr === undefined ? null : await blobReader(ourPtr)
    const theirVal = theirRemoved || theirPtr === undefined ? null : await blobReader(theirPtr)
    try {
      const result = fn(oldVal, ourVal, theirVal)
      mergedValues.set(key, result)
      autoMerged.push(key)
    } catch (e) {
      conflicts.add(key)
      mergeErrors.set(key, e)
    }
  }

  if (conflicts.size > 0) {
    throw new MergeConflict(conflicts, mergeErrors)
  }

  return {
    mergedKeyset,
    mergedValues,
    autoMergedKeys: autoMerged,
  }
}

function union(...sets: Iterable<string>[]): Set<string> {
  const out = new Set<string>()
  for (const s of sets) for (const k of s) out.add(k)
  return out
}

function intersection(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set<string>()
  for (const k of a) if (b.has(k)) out.add(k)
  return out
}
