/**
 * The per-commit sidecar: `.kvgit/commit.json`.
 *
 * Each git commit in a sync repo carries one sidecar blob — the
 * authoritative, kernel-agnostic record of the kvgit commit it
 * mirrors: identity (hash, parents, their generations, time, info)
 * plus the DELTA replay needs (changed keys → tree paths, removals).
 * Value BYTES are not here — they're tree blobs at the recorded paths;
 * a fetcher combines sidecar + blobs into a `WireCommit`.
 *
 * Deltas, not snapshots (design decision D7): sidecar size tracks the
 * change, not the keyset, at the cost of full-history replay on
 * fresh-device fetch.
 *
 * Encoding is **byte-deterministic** (fixed field order, sorted keys
 * and removals, parents in significant order, compact JSON as Python's
 * `json.dumps` writes it): the same wire commit always produces the
 * same sidecar bytes, so an interrupted push that re-creates the blob
 * gets the same git SHA. The time and info are written as recorded
 * (floats as floats), so they re-encode to the bytes the commit hash
 * covered.
 */

import { PyFloat, pyDumpsBytes, pyLoadsBytes } from '../pyjson'
import type { WireCommit } from '../types'

export const SIDECAR_FORMAT = 2

/** Sidecar fields minus value bytes — what a fetcher learns before
 *  pulling blobs. */
export interface DecodedSidecar {
  /** Encoder discriminator (`'ts'` / `'py'`): blob bytes are
   *  kernel-opaque, as in bundles. */
  kernel: string
  hash: string
  parents: readonly string[]
  parentGens: readonly number[] | null
  time: PyFloat
  info: unknown
  /** Changed key → where its value blob lives in this commit's tree. */
  updates: ReadonlyMap<string, { path: string }>
  removals: ReadonlySet<string>
}

/**
 * Encode a wire commit's sidecar. `paths` must cover every changed key
 * (the caller's `PathPlanner` assignments); anything missing throws — a
 * sidecar that can't locate its own blobs is unrecoverable later.
 */
export function encodeSidecar(
  wire: WireCommit,
  opts: { kernel: string; paths: ReadonlyMap<string, string> },
): Uint8Array {
  const updates: Array<[string, { path: string }]> = []
  for (const key of [...wire.updates.keys()].sort()) {
    const path = opts.paths.get(key)
    if (path === undefined) {
      throw new Error(`encodeSidecar: no tree path assigned for update key ${JSON.stringify(key)}`)
    }
    updates.push([key, { path }])
  }
  return pyDumpsBytes(
    new Map<string, unknown>([
      ['format', SIDECAR_FORMAT],
      ['kernel', opts.kernel],
      ['hash', wire.hash],
      ['parents', [...wire.parents]],
      ['parentGens', wire.parentGens === null ? null : [...wire.parentGens]],
      ['time', wire.time],
      ['info', wire.info ?? null],
      ['updates', new Map(updates)],
      ['removals', [...wire.removals].sort()],
    ]),
  )
}

/** Decode and validate a sidecar blob. Throws with a field-specific
 *  message on anything malformed — a bad sidecar means the commit (and
 *  everything after it) can't replay, so fail loudly. */
export function decodeSidecar(bytes: Uint8Array): DecodedSidecar {
  let raw: unknown
  try {
    raw = pyLoadsBytes(bytes)
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
  if (!(obj.time instanceof PyFloat)) throw new Error('decodeSidecar: time must be a float')
  const time = obj.time

  if (!Array.isArray(obj.parents) || obj.parents.some((p) => typeof p !== 'string')) {
    throw new Error('decodeSidecar: parents must be a string array')
  }
  const parents = obj.parents as string[]
  let parentGens: number[] | null = null
  if (obj.parentGens !== null) {
    if (
      !Array.isArray(obj.parentGens) ||
      obj.parentGens.some((g) => typeof g !== 'number' || !Number.isInteger(g))
    ) {
      throw new Error('decodeSidecar: parentGens must be an integer array or null')
    }
    parentGens = obj.parentGens as number[]
  }

  if (!Array.isArray(obj.removals) || obj.removals.some((r) => typeof r !== 'string')) {
    throw new Error('decodeSidecar: removals must be a string array')
  }
  const removals = new Set(obj.removals as string[])

  const updates = new Map<string, { path: string }>()
  for (const [key, value] of Object.entries(expectRecord(obj, 'updates'))) {
    const entry = value as Record<string, unknown>
    if (typeof entry?.path !== 'string') {
      throw new Error(`decodeSidecar: malformed update entry for ${JSON.stringify(key)}`)
    }
    updates.set(key, { path: entry.path })
  }

  return { kernel, hash, parents, parentGens, time, info: obj.info ?? null, updates, removals }
}

/** Reassemble a `WireCommit` from a decoded sidecar plus the value
 *  bytes fetched from the tree. Every changed key must have its bytes;
 *  extras are rejected (they'd silently change the hash). */
export function wireFromSidecar(
  sidecar: DecodedSidecar,
  values: ReadonlyMap<string, Uint8Array>,
): WireCommit {
  const updates = new Map<string, Uint8Array>()
  for (const key of sidecar.updates.keys()) {
    const bytes = values.get(key)
    if (bytes === undefined) {
      throw new Error(`wireFromSidecar: missing value bytes for update key ${JSON.stringify(key)}`)
    }
    updates.set(key, bytes)
  }
  if (values.size !== sidecar.updates.size) {
    throw new Error(
      `wireFromSidecar: ${values.size} values supplied for ${sidecar.updates.size} update keys`,
    )
  }
  return {
    hash: sidecar.hash,
    parents: sidecar.parents,
    parentGens: sidecar.parentGens,
    time: sidecar.time,
    info: sidecar.info,
    updates,
    removals: sidecar.removals,
  }
}

function expectString(obj: Record<string, unknown>, field: string): string {
  const value = obj[field]
  if (typeof value !== 'string') throw new Error(`decodeSidecar: ${field} must be a string`)
  return value
}

function expectRecord(obj: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = obj[field]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`decodeSidecar: ${field} must be an object`)
  }
  return value as Record<string, unknown>
}
