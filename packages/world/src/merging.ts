/**
 * The rules a three-way over a session resolves by, for the verbs that
 * bring work across: `ws.merge`, `ws.revert` and `ws.cherryPick`.
 *
 * - **File content merges as text,** with git-style conflict markers
 *   where both sides changed the same lines; the markers land in the
 *   commit, for the agent to resolve with ordinary edits.
 * - **A file's record merges field by field** (the later modification,
 *   the earliest creation), and carries the size of the bytes the
 *   content merge produced. A file deleted on one side and changed on
 *   the other keeps the surviving record.
 * - **A directory keeps its record** while this side still has files
 *   in it, whatever the other side did to the record.
 * - **The session's own state takes ours:** the working directory, the
 *   agent's git, and, whole, the cache, the conversation and
 *   compaction's record, including keys the other side only added. A
 *   merge brings files and nothing else.
 *
 * Anything else contested (a file on one side and a directory on the
 * other, state no rule covers) is a conflict no rule settles: the verb
 * refuses, and nothing changes.
 */

import {
  MergeChoice,
  MergeConflict,
  type MergeResult,
  type MergeRule,
  ROOT_COMMIT,
  type Repo,
  textMerge,
  textMergeResult,
} from '@agex-ts/kvgit'
import { BLOB_KEY, type MergeOutcome, sameBytes } from './agentgit'
import {
  CACHE_PREFIX,
  COMPACTION_PREFIX,
  CONVERSATION_PREFIX,
  CWD_KEY,
  FILE_PREFIX,
  type FileRecord,
  META_PREFIX,
  fileKey,
  isFileRecord,
} from './layout'

const mergeText = textMerge()

/** A file's record, merged field by field, sized to the merged bytes
 *  when they're known. */
function mergeRecord(size: number | undefined) {
  return (old: unknown, ours: unknown, theirs: unknown): unknown => {
    const o = isFileRecord(old) ? old : null
    const u = isFileRecord(ours) ? ours : null
    const t = isFileRecord(theirs) ? theirs : null
    if (u === null && t === null) throw new Error('no record on either side')
    if (u === null || t === null) {
      const survivor = (u ?? t) as FileRecord
      return size === undefined || survivor.isDir ? survivor : { ...survivor, size }
    }
    if (u.isDir !== t.isDir) throw new Error('a file on one side and a directory on the other')
    const winner = u.modifiedAt >= t.modifiedAt ? u : t
    const created = [o, u, t].flatMap((r) =>
      r === null || r.createdAt === '' ? [] : [r.createdAt],
    )
    return {
      ...winner,
      createdAt: created.sort()[0] ?? winner.createdAt,
      ...(size !== undefined && !winner.isDir && { size }),
    }
  }
}

/** The length of the bytes the content merge makes of one file's
 *  three sides; undefined where that isn't known (bytes no marker merge
 *  can mark). */
function mergedSize(base: unknown, ours: unknown, theirs: unknown): number | undefined {
  let merged: unknown
  if (sameBytes(ours, theirs)) merged = ours
  else if (sameBytes(ours, base)) merged = theirs
  else if (sameBytes(theirs, base)) merged = ours
  else {
    try {
      merged = mergeText(base ?? null, ours ?? null, theirs ?? null)
    } catch {
      return undefined
    }
  }
  return merged instanceof Uint8Array ? merged.length : undefined
}

/** Whether the text merge of one file's three sides marked conflicts:
 *  only where all three differ, as the merge consults its rule only
 *  there. */
function marked(base: unknown, ours: unknown, theirs: unknown): boolean {
  if (sameBytes(ours, theirs) || sameBytes(ours, base) || sameBytes(theirs, base)) return false
  const bytes = (v: unknown) => (v instanceof Uint8Array ? v : null)
  try {
    return textMergeResult(bytes(base), bytes(ours), bytes(theirs))[1]
  } catch {
    return false
  }
}

/** The rules a three-way of `ours` and `theirs` over `base` resolves
 *  by (`base` null: no shared history, the empty tree). */
export async function threeWayRules(
  repo: Repo<unknown>,
  sides: { base: string | null; ours: string; theirs: string },
): Promise<{
  mergeFns: Map<string, MergeRule<unknown>>
  mergePrefixes: Map<string, MergeRule<unknown>>
}> {
  const base = sides.base ?? ROOT_COMMIT
  const [ours, theirs] = await Promise.all([
    repo.diff(base, sides.ours),
    repo.diff(base, sides.theirs),
  ])
  const changed = (d: typeof ours) => new Set([...d.added, ...d.removed, ...d.modified])
  const [oursChanged, theirsChanged] = [changed(ours), changed(theirs)]
  // A record both sides changed is the one a merge function decides,
  // and it needs the size of what the content merge makes beside it.
  const contested = [...oursChanged].filter(
    (k) => k.startsWith(META_PREFIX) && theirsChanged.has(k),
  )
  const paths = contested.map((k) => k.slice(META_PREFIX.length))
  const read = async (commit: string) =>
    (await repo.snapshot({ commit })).getMany(paths.map(fileKey))
  const [atBase, atOurs, atTheirs] = await Promise.all([
    read(base),
    read(sides.ours),
    read(sides.theirs),
  ])
  const mergeFns = new Map<string, MergeRule<unknown>>([
    [CWD_KEY, MergeChoice.OURS],
    [BLOB_KEY, MergeChoice.OURS],
  ])
  // A directory record the other side removed stays while ours has
  // files under it: they'd be left without one.
  const goneDirs = [...theirs.removed].filter((k) => k.startsWith(META_PREFIX))
  if (goneDirs.length > 0) {
    const ourTree = await repo.snapshot({ commit: sides.ours })
    const [ourKeys, ourRecords] = await Promise.all([ourTree.keys(), ourTree.getMany(goneDirs)])
    const theirRemovals = new Set(
      [...theirs.removed]
        .filter((k) => k.startsWith(FILE_PREFIX))
        .map((k) => k.slice(FILE_PREFIX.length)),
    )
    for (const key of goneDirs) {
      const record = ourRecords.get(key)
      if (!isFileRecord(record) || !record.isDir) continue
      const dir = `${key.slice(META_PREFIX.length)}/`
      // A file stays unless theirs removed it and ours left it alone.
      const kept = ourKeys.some(
        (k) =>
          k.startsWith(FILE_PREFIX + dir) &&
          (!theirRemovals.has(k.slice(FILE_PREFIX.length)) || oursChanged.has(k)),
      )
      if (kept) mergeFns.set(key, MergeChoice.OURS)
    }
  }
  for (const path of paths) {
    const key = fileKey(path)
    const size = mergedSize(atBase.get(key), atOurs.get(key), atTheirs.get(key))
    mergeFns.set(META_PREFIX + path, mergeRecord(size))
  }
  const mergePrefixes = new Map<string, MergeRule<unknown>>([
    [FILE_PREFIX, mergeText],
    [META_PREFIX, mergeRecord(undefined)],
    [CACHE_PREFIX, MergeChoice.OURS],
    [CONVERSATION_PREFIX, MergeChoice.OURS],
    [COMPACTION_PREFIX, MergeChoice.OURS],
  ])
  return { mergeFns, mergePrefixes }
}

/** A key as a path where it is a file's, and as itself otherwise. */
function display(key: string): string {
  if (key.startsWith(FILE_PREFIX)) return key.slice(FILE_PREFIX.length)
  if (key.startsWith(META_PREFIX)) return key.slice(META_PREFIX.length)
  return key
}

/**
 * The records a landed three-way left describing other bytes than its
 * files hold: where both sides changed a record alike (in the same
 * millisecond) and the content merged to something else, no merge rule
 * was asked. Corrected in the verb's own bookkeeping commit.
 */
export async function staleRecords(
  repo: Repo<unknown>,
  commit: string,
  paths: readonly string[],
): Promise<Map<string, unknown>> {
  const snapshot = await repo.snapshot({ commit })
  const values = await snapshot.getMany(paths.flatMap((p) => [fileKey(p), META_PREFIX + p]))
  const out = new Map<string, unknown>()
  for (const path of paths) {
    const content = values.get(fileKey(path))
    const record = values.get(META_PREFIX + path)
    if (content instanceof Uint8Array && isFileRecord(record) && record.size !== content.length) {
      out.set(META_PREFIX + path, { ...record, size: content.length })
    }
  }
  return out
}

/**
 * Run a three-way verb and say what came of it. `run` makes the commit
 * (a kvgit merge or apply) from `before`, over `base`; `theirs` is the
 * side the work came from. A conflict no rule settles comes back as
 * `merged: false` with the contested paths; a landed one names the
 * paths the text merge marked, asked of the merge itself, so a file
 * that already held marker text is neither hidden nor flagged by it.
 * A verb with nothing to do lands nothing: a merge of what this side
 * holds already is merged at the commit it was (`held`), anything else
 * not merged.
 */
export async function threeWay(
  repo: Repo<unknown>,
  sides: { base: string | null; before: string; theirs: string },
  run: () => Promise<MergeResult>,
  opts: { held?: boolean } = {},
): Promise<MergeOutcome> {
  const { before, theirs } = sides
  let result: MergeResult
  try {
    result = await run()
  } catch (e) {
    if (!(e instanceof MergeConflict)) throw e
    return {
      merged: false,
      commit: null,
      conflicts: [...new Set([...e.keys].map(display))].sort(),
      autoMerged: [],
    }
  }
  if (result.strategy === 'no_op' || result.commit === null || result.commit === before) {
    return opts.held === true
      ? { merged: true, commit: before, conflicts: [], autoMerged: [] }
      : { merged: false, commit: null, conflicts: [], autoMerged: [] }
  }
  const d = await repo.diff(before, result.commit)
  const brought = [...new Set([...d.added, ...d.removed, ...d.modified])]
    .filter((k) => k.startsWith(FILE_PREFIX))
    .map((k) => k.slice(FILE_PREFIX.length))
    .sort()
  const read = async (commit: string) =>
    (await repo.snapshot({ commit })).getMany(brought.map(fileKey))
  const [old, ours, other] = await Promise.all([
    read(sides.base ?? ROOT_COMMIT),
    read(before),
    read(theirs),
  ])
  const conflicts = brought.filter((p) => {
    const key = fileKey(p)
    return marked(old.get(key), ours.get(key), other.get(key))
  })
  return {
    merged: true,
    commit: result.commit,
    conflicts,
    autoMerged: brought.filter((p) => !conflicts.includes(p)),
  }
}
