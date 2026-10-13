/**
 * Where a world keeps things in a session's branch.
 *
 * Every session is a branch of one kvgit repository on the `cbor`
 * codec, and everything a session holds is a key on that branch, so a
 * commit, a fork or a checkout carries all of it at once:
 *
 * | key | value |
 * |---|---|
 * | `__file__<abs path>` | a file's bytes |
 * | `__meta__<abs path>` | a {@link FileRecord}: a file's or a directory's metadata |
 * | `__cwd__` | the working directory, an absolute path |
 * | `__cache__/<key>` | a cache entry, any value the codec holds |
 * | `__conversation__/…` | the conversation (written by the turn) |
 * | `__compaction__/…` | compaction's record (written by the turn) |
 *
 * A file's content and its metadata are separate keys, so content that
 * doesn't change (a rename, a touch) keeps its stored blob. A
 * directory is a metadata record with no content key; `/` is always a
 * directory and has no record.
 */

import { MergeChoice, type MergeRule } from '@agex-ts/kvgit'

export const FILE_PREFIX = '__file__'
export const META_PREFIX = '__meta__'
export const CWD_KEY = '__cwd__'
export const CACHE_PREFIX = '__cache__/'
export const CONVERSATION_PREFIX = '__conversation__/'
export const COMPACTION_PREFIX = '__compaction__/'

/** The content key of the file at absolute path `abs`. */
export const fileKey = (abs: string): string => `${FILE_PREFIX}${abs}`
/** The metadata key of the file or directory at absolute path `abs`. */
export const metaKey = (abs: string): string => `${META_PREFIX}${abs}`

/** A file's or a directory's metadata. Times are ISO 8601 UTC. */
export interface FileRecord {
  readonly size: number
  readonly createdAt: string
  readonly modifiedAt: string
  readonly isDir: boolean
}

export function isFileRecord(value: unknown): value is FileRecord {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.size === 'number' &&
    typeof v.createdAt === 'string' &&
    typeof v.modifiedAt === 'string' &&
    typeof v.isDir === 'boolean'
  )
}

/**
 * Two writers changed one path's metadata: keep the later modification
 * and the earlier creation. A path one side removed and the other
 * changed, or one side made a file and the other a directory, is a
 * conflict.
 */
export const mergeFileRecords = (_old: unknown, ours: unknown, theirs: unknown): unknown => {
  if (!isFileRecord(ours) || !isFileRecord(theirs)) {
    throw new Error('one side removed this path and the other changed it')
  }
  if (ours.isDir !== theirs.isDir) {
    throw new Error('one side made this path a file and the other a directory')
  }
  const later = ours.modifiedAt >= theirs.modifiedAt ? ours : theirs
  const createdAt = ours.createdAt <= theirs.createdAt ? ours.createdAt : theirs.createdAt
  return { ...later, createdAt }
}

/** Two writers both moved the working directory: the committing one's
 *  stands. A cd only one of them made is kept either way. */
export const keepOurCwd = (): MergeChoice => MergeChoice.OURS

/** The merge rules every session's worktree carries. */
export const WORLD_MERGE_FNS: ReadonlyMap<string, MergeRule<unknown>> = new Map([
  [CWD_KEY, keepOurCwd],
])
export const WORLD_MERGE_PREFIXES: ReadonlyMap<string, MergeRule<unknown>> = new Map([
  [META_PREFIX, mergeFileRecords],
])
