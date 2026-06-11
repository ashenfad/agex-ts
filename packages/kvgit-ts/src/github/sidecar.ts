/**
 * The per-commit sidecar: `.kvgit/commit.json`.
 *
 * Each git commit in a sync repo carries one sidecar blob — the
 * authoritative, kernel-agnostic record of the kvgit commit it
 * mirrors: identity (hash, parents, time, info) plus the DELTA
 * bookkeeping replay needs (update keys → tree paths + createdAt,
 * removals, carries). Update VALUE BYTES are not here — they're tree
 * blobs at the recorded paths; a fetcher combines sidecar + blobs
 * into a `WireCommit`.
 *
 * Deltas, not snapshots (design decision D7): sidecar size tracks the
 * change, not the keyset, at the cost of full-history replay on
 * fresh-device fetch.
 *
 * Encoding is **byte-deterministic** (sorted record keys, sorted
 * removals, parents in significant order, no whitespace): the same
 * wire commit always produces the same sidecar bytes, so an
 * interrupted push that re-creates the blob gets the same git SHA —
 * resumability falls out of determinism, matching the
 * explicit-commit-dates property in `client.ts`.
 */

import type { CommitInfo, WireCommit } from '../types'

export const SIDECAR_FORMAT = 1

/** Sidecar fields minus update value bytes — what a fetcher learns
 *  before pulling blobs. */
export interface DecodedSidecar {
  /** Encoder discriminator (`'ts'` / `'py'`) — same caveat as
   *  bundles: blob bytes are kernel-opaque. */
  kernel: string
  hash: string
  parents: readonly string[]
  time: number
  info: CommitInfo | null
  /** key → where the value blob lives in this commit's tree, plus
   *  meta fidelity. */
  updates: ReadonlyMap<string, { path: string; createdAt: number }>
  removals: ReadonlySet<string>
  carries: ReadonlyMap<string, { owner: string; size: number; createdAt: number }>
}

const _encoder = new TextEncoder()
const _decoder = new TextDecoder()

/**
 * Encode a wire commit's sidecar. `paths` must cover every update key
 * (the caller's `PathPlanner` assignments); anything missing throws —
 * a sidecar that can't locate its own blobs is unrecoverable later.
 */
export function encodeSidecar(
  wire: WireCommit,
  opts: { kernel: string; paths: ReadonlyMap<string, string> },
): Uint8Array {
  const updates: Record<string, { path: string; createdAt: number }> = {}
  for (const key of [...wire.updates.keys()].sort()) {
    const path = opts.paths.get(key)
    if (path === undefined) {
      throw new Error(`encodeSidecar: no tree path assigned for update key ${JSON.stringify(key)}`)
    }
    const createdAt = wire.meta.get(key)?.createdAt ?? wire.time
    updates[key] = { path, createdAt }
  }

  const carries: Record<string, { owner: string; size: number; createdAt: number }> = {}
  for (const key of [...wire.carries.keys()].sort()) {
    const carry = wire.carries.get(key) as { owner: string; size: number; createdAt: number }
    carries[key] = { owner: carry.owner, size: carry.size, createdAt: carry.createdAt }
  }

  // Field order is fixed by construction; JSON.stringify preserves
  // insertion order, giving byte-deterministic output.
  return _encoder.encode(
    JSON.stringify({
      format: SIDECAR_FORMAT,
      kernel: opts.kernel,
      hash: wire.hash,
      parents: [...wire.parents],
      time: wire.time,
      info: wire.info,
      updates,
      removals: [...wire.removals].sort(),
      carries,
    }),
  )
}

/** Decode and validate a sidecar blob. Throws with a field-specific
 *  message on anything malformed — a bad sidecar means the commit
 *  (and everything after it) can't replay, so fail loudly. */
export function decodeSidecar(bytes: Uint8Array): DecodedSidecar {
  let raw: unknown
  try {
    raw = JSON.parse(_decoder.decode(bytes))
  } catch {
    throw new Error('decodeSidecar: not valid JSON')
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('decodeSidecar: not an object')
  }
  const obj = raw as Record<string, unknown>

  if (obj.format !== SIDECAR_FORMAT) {
    throw new Error(`decodeSidecar: unsupported format ${JSON.stringify(obj.format)}`)
  }
  const kernel = expectString(obj, 'kernel')
  const hash = expectString(obj, 'hash')
  const time = expectNumber(obj, 'time')
  const info =
    obj.info === null || obj.info === undefined ? null : (expectRecord(obj, 'info') as CommitInfo)

  if (!Array.isArray(obj.parents) || obj.parents.some((p) => typeof p !== 'string')) {
    throw new Error('decodeSidecar: parents must be a string array')
  }
  const parents = obj.parents as string[]

  if (!Array.isArray(obj.removals) || obj.removals.some((r) => typeof r !== 'string')) {
    throw new Error('decodeSidecar: removals must be a string array')
  }
  const removals = new Set(obj.removals as string[])

  const updates = new Map<string, { path: string; createdAt: number }>()
  for (const [key, value] of Object.entries(expectRecord(obj, 'updates'))) {
    const entry = value as Record<string, unknown>
    if (typeof entry?.path !== 'string' || typeof entry?.createdAt !== 'number') {
      throw new Error(`decodeSidecar: malformed update entry for ${JSON.stringify(key)}`)
    }
    updates.set(key, { path: entry.path, createdAt: entry.createdAt })
  }

  const carries = new Map<string, { owner: string; size: number; createdAt: number }>()
  for (const [key, value] of Object.entries(expectRecord(obj, 'carries'))) {
    const entry = value as Record<string, unknown>
    if (
      typeof entry?.owner !== 'string' ||
      typeof entry?.size !== 'number' ||
      typeof entry?.createdAt !== 'number'
    ) {
      throw new Error(`decodeSidecar: malformed carry entry for ${JSON.stringify(key)}`)
    }
    carries.set(key, { owner: entry.owner, size: entry.size, createdAt: entry.createdAt })
  }

  return { kernel, hash, parents, time, info, updates, removals, carries }
}

/** Reassemble a `WireCommit` from a decoded sidecar plus the update
 *  value bytes fetched from the tree. Every update key must have its
 *  bytes; extras are rejected (they'd silently change the hash). */
export function wireFromSidecar(
  sidecar: DecodedSidecar,
  values: ReadonlyMap<string, Uint8Array>,
): WireCommit {
  const updates = new Map<string, Uint8Array>()
  const meta = new Map<string, { createdAt: number }>()
  for (const [key, entry] of sidecar.updates) {
    const bytes = values.get(key)
    if (bytes === undefined) {
      throw new Error(`wireFromSidecar: missing value bytes for update key ${JSON.stringify(key)}`)
    }
    updates.set(key, bytes)
    meta.set(key, { createdAt: entry.createdAt })
  }
  if (values.size !== sidecar.updates.size) {
    throw new Error(
      `wireFromSidecar: ${values.size} values supplied for ${sidecar.updates.size} update keys`,
    )
  }
  return {
    hash: sidecar.hash,
    parents: sidecar.parents,
    time: sidecar.time,
    info: sidecar.info,
    updates,
    removals: sidecar.removals,
    meta,
    carries: sidecar.carries,
  }
}

function expectString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field]
  if (typeof value !== 'string') throw new Error(`decodeSidecar: ${field} must be a string`)
  return value
}

function expectNumber(obj: Record<string, unknown>, field: string): number {
  const value = obj[field]
  if (typeof value !== 'number') throw new Error(`decodeSidecar: ${field} must be a number`)
  return value
}

function expectRecord(obj: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = obj[field]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`decodeSidecar: ${field} must be an object`)
  }
  return value as Record<string, unknown>
}
