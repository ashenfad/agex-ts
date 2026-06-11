/**
 * Storage layout and commit-identity primitives for `VersionedKV` (v1).
 *
 * Single source of truth for the reserved storage keys and the
 * content-hash that defines commit identity. `VersionedKV` consumes
 * these to read/write commits; the sync layer (`sync/walk.ts`, and
 * eventually `applyWire`) consumes them to translate commits to and
 * from wire form. Keeping both on one module means a layout change
 * breaks loudly in one place instead of silently skewing the two.
 *
 * Layout (see `versioned/kv.ts` for the full picture):
 *
 *   `__kvgit_version__`              — storage version sentinel (1 in v1)
 *   `__branch_head__<branch>`        — current HEAD commit hash
 *   `__branch_head_prev__<branch>`   — previous HEAD (recovery backup)
 *   `__commit_root__<commit>`        — keyset HAMT root hash
 *   `__parent_commit__<commit>`      — JSON list of parent commit hashes
 *   `__commit_time__<commit>`        — wall time epoch ms
 *   `__info__<commit>`               — optional caller-supplied info dict
 *   `kvgit:keyset:<node_hash>`       — HAMT node bytes (via Keyset)
 *   `<commit_hash>:<user_key>`       — blob value bytes
 */

import type { CommitInfo, KVStore } from '../types'

export const STORAGE_VERSION = 1
export const STORAGE_VERSION_KEY = '__kvgit_version__'

export const BRANCH_HEAD = (branch: string): string => `__branch_head__${branch}`
export const BRANCH_HEAD_PREV = (branch: string): string => `__branch_head_prev__${branch}`
export const COMMIT_ROOT = (commit: string): string => `__commit_root__${commit}`
export const PARENT_COMMIT = (commit: string): string => `__parent_commit__${commit}`
export const COMMIT_TIME = (commit: string): string => `__commit_time__${commit}`
export const INFO_KEY = (commit: string): string => `__info__${commit}`
export const BRANCH_HEAD_PREFIX = '__branch_head__'

/** Remote-tracking state for the sync layer: the last remote commit a
 *  branch is known to be synced to. Reserved here so the layout is
 *  complete in one place; written by the sync orchestration layer.
 *  (Deliberately NOT under `__branch_head__` so branch prefix scans
 *  don't see it.) */
export const SYNC_HEAD = (branch: string): string => `__sync_head__${branch}`

/** Length of a commit hash in hex chars (sha-256 truncated to 40). */
export const COMMIT_HASH_LEN = 40

/**
 * Blob pointers are versioned keys of the form `<commitHash>:<userKey>`.
 * The hash is fixed-width, so parsing is positional — user keys may
 * themselves contain `:`.
 */
export function blobPointer(commitHash: string, key: string): string {
  return `${commitHash}:${key}`
}

/** The commit that wrote a blob, extracted from its pointer. */
export function blobPointerOwner(pointer: string): string {
  return pointer.slice(0, COMMIT_HASH_LEN)
}

/**
 * Read a branch's HEAD commit hash, or null if absent/malformed.
 *
 * Plain read — no prev-HEAD recovery (that's `VersionedKV.open`'s
 * job). For the sync layer, a corrupt head reads as "no head" and the
 * orchestration surfaces it rather than repairing it.
 */
export async function readBranchHead(store: KVStore, branch: string): Promise<string | null> {
  const raw = await store.get(BRANCH_HEAD(branch))
  if (raw === null) return null
  const parsed = safeLoads(raw)
  return typeof parsed === 'string' ? parsed : null
}

// ---------------------------------------------------------------------------
// Storage version
// ---------------------------------------------------------------------------

/**
 * Validate (or stamp) the storage version sentinel.
 *
 * Every writer entry point — `VersionedKV.open`, `applyWire` — must
 * call this before touching the store: an existing sentinel of another
 * version is rejected, a fresh store gets the sentinel written, and a
 * store with branch heads but no sentinel is treated as a pre-v1
 * format and rejected.
 */
export async function checkStorageVersion(store: KVStore): Promise<void> {
  const raw = await store.get(STORAGE_VERSION_KEY)
  if (raw !== null) {
    const version = safeLoads(raw)
    if (version !== STORAGE_VERSION) {
      throw new Error(
        `Store has kvgit storage version ${JSON.stringify(version)}, ` +
          `this code supports ${STORAGE_VERSION}. Use a fresh store.`,
      )
    }
    return
  }

  // No version sentinel. Either fresh, or pre-v1.
  let hasExisting = false
  for await (const _k of store.keys(BRANCH_HEAD_PREFIX)) {
    hasExisting = true
    break
  }
  if (hasExisting) {
    throw new Error(
      `Store appears to use an older kvgit storage format. This version requires storage v${STORAGE_VERSION}. Use a fresh store.`,
    )
  }
  await store.set(STORAGE_VERSION_KEY, dumps(STORAGE_VERSION))
}

// ---------------------------------------------------------------------------
// JSON byte helpers
// ---------------------------------------------------------------------------

const _encoder = new TextEncoder()
const _decoder = new TextDecoder()

export function dumps(value: unknown): Uint8Array {
  return _encoder.encode(JSON.stringify(value))
}

export function loads(raw: Uint8Array): unknown {
  return JSON.parse(_decoder.decode(raw))
}

export function safeLoads(raw: Uint8Array): unknown {
  try {
    return loads(raw)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Content hashing
// ---------------------------------------------------------------------------

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    hex += (b < 16 ? '0' : '') + b.toString(16)
  }
  return hex
}

/** Placeholder pointer used in the keyset preview for keys whose real
 *  blob pointer depends on the commit hash being computed. */
export function pendingPointer(key: string): string {
  return `<pending:${key}>`
}

/**
 * Compute a content-addressable commit hash.
 *
 * Hashes the parent pointers, sorted keyset preview, sorted update
 * blob bytes, and optional info to produce a deterministic 40-hex-char
 * commit hash. Truncating to 40 keeps commits visually compact while
 * leaving plenty of collision resistance.
 *
 * The preview uses `pendingPointer` placeholders for keys updated in
 * this commit (their real pointers embed the hash being computed).
 * Anything that replays a commit — locally or from the wire — must
 * reconstruct this exact preview to reproduce the hash; that is the
 * integrity check the sync layer leans on.
 */
export async function contentHash(
  parents: readonly string[],
  keyset: ReadonlyMap<string, string>,
  updates: ReadonlyMap<string, Uint8Array>,
  info: CommitInfo | null,
): Promise<string> {
  // Concatenate the inputs into a single byte stream, then hash.
  const parts: Uint8Array[] = []
  parts.push(_encoder.encode(JSON.stringify(parents)))
  const sortedKeyset = [...keyset.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  parts.push(_encoder.encode(JSON.stringify(sortedKeyset)))
  const sortedUpdateKeys = [...updates.keys()].sort()
  for (const key of sortedUpdateKeys) {
    parts.push(_encoder.encode(key))
    parts.push(updates.get(key) as Uint8Array)
  }
  if (info !== null) {
    parts.push(_encoder.encode(canonicalJson(info)))
  }

  let total = 0
  for (const p of parts) total += p.length
  const flat = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    flat.set(p, off)
    off += p.length
  }
  const hex = await sha256Hex(flat)
  return hex.slice(0, COMMIT_HASH_LEN)
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
  return `{${parts.join(',')}}`
}
