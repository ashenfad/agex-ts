/**
 * The changeset log's entry format, version 1.
 *
 * The log is a kvgit branch whose commits each hold one entry under
 * {@link ENTRY_KEY}: the transactions one flush moved out of the
 * database file, numbered consecutively across the whole log from 1.
 * The key is overwritten by every flush, so the branch's first-parent
 * chain of commits is the log.
 *
 * An entry is a format byte ({@link ENTRY_FORMAT}) followed by CBOR
 * (RFC 8949): an array of pieces, oldest first, each
 * `[kind, from, to, schema, body]`:
 *
 * - kind 0, a changeset: `body` is what transactions `from` to `to`
 *   changed. One transaction (`from === to`) keeps it as a restore
 *   point; a run of several is one changeset combined from theirs.
 * - kind 1, a schema change: `body` is CBOR `{foreignKeys, statements}`,
 *   the SQL of one transaction (`from === to`) as it ran, with the
 *   `PRAGMA foreign_keys` setting it ran under. Replay runs it again.
 *
 * `schema` is the schema version the piece was written under: the
 * number of schema changes before it in the log. A schema change
 * moves the next piece to `schema + 1`.
 *
 * CBOR carries byte strings, bigints and nested values without base64
 * or a hand-written framing, other languages read it (Python's
 * `cbor2`), and kvgit's codec for it is already a dependency. The
 * format byte comes first so a reader can refuse a format it doesn't
 * know before decoding anything.
 *
 * Each entry's commit records, as its info, {@link EntryInfo}: the
 * range, the entry's byte length and SHA-256, and the schema version
 * after it. Readers check the length and digest before decoding.
 */

import { cborCodec } from '@agex-ts/kvgit'
import type { BindableValue, Sqlite3Static } from '@sqlite.org/sqlite-wasm'
import { combineChangesets } from './changeset'

/** The key each log commit holds its entry under. */
export const ENTRY_KEY = 'entry'

/** The format byte that starts every entry this version writes. */
export const ENTRY_FORMAT = 1

/**
 * A run of consecutive changesets is stored merged when the merged
 * changeset is at most this fraction of their combined size. Merging
 * drops the run's inner restore points, which is worth it when the run
 * mostly rewrites the same rows (a game saving its state, a counter):
 * those collapse to a fraction of their size, while a run of distinct
 * edits (a calendar) shrinks by about a tenth, too little to give up
 * restoring to each of them.
 */
export const MERGE_RATIO = 0.5

/** Statement parameters: positional, or named (`{ ':id': 1 }`). */
export type Params = readonly BindableValue[] | { readonly [name: string]: BindableValue }

/** One statement of a call: its SQL, and its parameters if any. */
export type Statement = readonly [sql: string, params?: Params | null]

/** What a logged transaction recorded. */
export type ItemKind = 'changeset' | 'sql'

/** A transaction recorded in the database file, not yet in the log. */
export interface PendingItem {
  /** The transaction's number in the log. */
  seq: number
  kind: ItemKind
  /** The changeset, or the encoded {@link SqlBody}. */
  body: Uint8Array
  /** The schema version it was written under. */
  schema: number
}

/** One piece of an entry: a transaction, or a merged run of them. */
export interface Piece {
  kind: ItemKind
  from: number
  to: number
  schema: number
  body: Uint8Array
}

/** A schema change as logged: re-executed, in order, on replay. */
export interface SqlBody {
  /** The `PRAGMA foreign_keys` setting it ran under. */
  foreignKeys: boolean
  statements: Statement[]
}

/** What each log commit records about its entry, as its commit info. */
export interface EntryInfo {
  /** The entry format version. */
  v: 1
  /** The first and last transactions it holds. */
  from: number
  to: number
  /** The entry's length in bytes. */
  length: number
  /** The SHA-256 of the entry's bytes, lowercase hex. */
  digest: string
  /** The schema version after the entry. */
  schema: number
  /**
   * The bytes of every entry of its epoch through this one (see
   * `epoch.ts`), which tells when the log has grown enough, next to the
   * epoch's snapshot, to start the next. Absent from entries written
   * before epochs were.
   */
  total?: number
}

const KIND_CODES: Record<ItemKind, number> = { changeset: 0, sql: 1 }

export function encodeSqlBody(body: SqlBody): Uint8Array {
  return cborCodec.encode({
    foreignKeys: body.foreignKeys,
    statements: body.statements.map(([sql, params]) => [sql, params ?? null]),
  })
}

/** Decode a schema change's body. Throws on anything malformed. */
export function decodeSqlBody(bytes: Uint8Array): SqlBody {
  const raw = cborCodec.decode(bytes) as { foreignKeys?: unknown; statements?: unknown }
  if (raw === null || typeof raw !== 'object' || typeof raw.foreignKeys !== 'boolean') {
    throw new Error('a schema change without its foreign_keys setting')
  }
  if (!Array.isArray(raw.statements)) throw new Error('a schema change without its statements')
  const statements = raw.statements.map((s: unknown): Statement => {
    if (!Array.isArray(s) || typeof s[0] !== 'string') throw new Error('a malformed statement')
    const params = s[1] as Params | null | undefined
    if (params !== null && params !== undefined && typeof params !== 'object') {
      throw new Error('malformed statement parameters')
    }
    return [s[0], params ?? null]
  })
  return { foreignKeys: raw.foreignKeys, statements }
}

/** The schema version after `piece`. */
export function schemaAfter(piece: Piece): number {
  return piece.kind === 'sql' ? piece.schema + 1 : piece.schema
}

/**
 * Encode consecutive pending transactions as one entry. Runs of
 * changesets under one schema version are merged where that makes them
 * at most {@link MERGE_RATIO} of their size; everything else is packed
 * one piece per transaction.
 *
 * The same items always encode to the same bytes (under the same
 * SQLite build), which is how a database recognizes its own flush in
 * the log after a crash.
 */
export function encodeEntry(
  sqlite3: Sqlite3Static,
  items: readonly PendingItem[],
): { bytes: Uint8Array; pieces: Piece[] } {
  if (items.length === 0) throw new RangeError('an entry needs at least one transaction')
  items.forEach((item, i) => {
    const prev = items[i - 1]
    if (prev && item.seq !== prev.seq + 1) {
      throw new RangeError(`transactions ${prev.seq} and ${item.seq} aren't consecutive`)
    }
  })
  const pieces: Piece[] = []
  let run: PendingItem[] = []
  const endRun = () => {
    const first = run[0]
    const last = run[run.length - 1]
    if (first && last && run.length > 1) {
      const packed = run.reduce((n, item) => n + item.body.byteLength, 0)
      const merged = combineChangesets(
        sqlite3,
        run.map((item) => item.body),
      )
      if (merged.byteLength <= packed * MERGE_RATIO) {
        pieces.push({
          kind: 'changeset',
          from: first.seq,
          to: last.seq,
          schema: first.schema,
          body: merged,
        })
        run = []
        return
      }
    }
    for (const item of run) pieces.push(pieceOf(item))
    run = []
  }
  for (const item of items) {
    if (item.kind === 'sql') {
      endRun()
      pieces.push(pieceOf(item))
    } else {
      if (run[0] && run[0].schema !== item.schema) endRun()
      run.push(item)
    }
  }
  endRun()
  return { bytes: encodePieces(pieces), pieces }
}

/** Encode `pieces`, consecutive and oldest first, as one entry, as they are. */
export function encodePieces(pieces: readonly Piece[]): Uint8Array {
  if (pieces.length === 0) throw new RangeError('an entry needs at least one piece')
  pieces.forEach((p, i) => {
    const prev = pieces[i - 1]
    if (prev && p.from !== prev.to + 1) {
      throw new RangeError(
        `pieces ending at ${prev.to} and starting at ${p.from} aren't consecutive`,
      )
    }
  })
  const body = cborCodec.encode(
    pieces.map((p) => [KIND_CODES[p.kind], p.from, p.to, p.schema, p.body]),
  )
  const bytes = new Uint8Array(body.byteLength + 1)
  bytes[0] = ENTRY_FORMAT
  bytes.set(body, 1)
  return bytes
}

/** `pieces` numbered `by` transactions later (earlier, for a negative `by`). */
export function renumber(pieces: readonly Piece[], by: number): Piece[] {
  return pieces.map((p) => ({ ...p, from: p.from + by, to: p.to + by }))
}

/** A pending transaction as an entry's piece. */
export function pieceOf(item: PendingItem): Piece {
  return {
    kind: item.kind,
    from: item.seq,
    to: item.seq,
    schema: item.schema,
    body: item.body,
  }
}

const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0

/**
 * Decode an entry's pieces, checking their shape and that they cover
 * consecutive transactions. Throws on anything malformed.
 */
export function decodeEntry(bytes: Uint8Array): Piece[] {
  if (bytes.byteLength === 0) throw new Error('the entry is empty')
  if (bytes[0] !== ENTRY_FORMAT) {
    throw new Error(`entry format ${bytes[0]}, which this version doesn't read`)
  }
  const raw = cborCodec.decode(bytes.subarray(1))
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('an entry without pieces')
  const pieces = raw.map((p: unknown, i): Piece => {
    if (!Array.isArray(p) || p.length !== 5) throw new Error(`piece ${i} is malformed`)
    const [code, from, to, schema, body] = p as unknown[]
    const kind = code === 0 ? 'changeset' : code === 1 ? 'sql' : undefined
    if (
      kind === undefined ||
      !isCount(from) ||
      !isCount(to) ||
      from < 1 ||
      to < from ||
      (kind === 'sql' && to !== from) ||
      !isCount(schema) ||
      !(body instanceof Uint8Array)
    ) {
      throw new Error(`piece ${i} is malformed`)
    }
    return { kind, from, to, schema, body }
  })
  pieces.forEach((p, i) => {
    const prev = pieces[i - 1]
    if (prev && p.from !== prev.to + 1) throw new Error(`piece ${i} doesn't follow piece ${i - 1}`)
  })
  return pieces
}

/** Lowercase hex SHA-256 of `bytes`. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>),
  )
  let out = ''
  for (const b of hash) out += b.toString(16).padStart(2, '0')
  return out
}

/** The commit info for an entry, `total` the bytes of its epoch's entries through it. */
export function entryInfo(
  pieces: readonly Piece[],
  bytes: Uint8Array,
  digest: string,
  total?: number,
): EntryInfo {
  const first = pieces[0]
  const last = pieces[pieces.length - 1]
  if (!first || !last) throw new RangeError('an entry needs at least one piece')
  return {
    v: 1,
    from: first.from,
    to: last.to,
    length: bytes.byteLength,
    digest,
    schema: schemaAfter(last),
    ...(total !== undefined && { total }),
  }
}

/** A commit's info as an {@link EntryInfo}, or undefined if it isn't one. */
export function parseEntryInfo(info: unknown): EntryInfo | undefined {
  if (info === null || typeof info !== 'object') return undefined
  const { v, from, to, length, digest, schema, total } = info as Record<string, unknown>
  if (
    v !== 1 ||
    !isCount(from) ||
    !isCount(to) ||
    from < 1 ||
    to < from ||
    !isCount(length) ||
    typeof digest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    !isCount(schema) ||
    (total !== undefined && !isCount(total))
  ) {
    return undefined
  }
  return { v, from, to, length, digest, schema, ...(total !== undefined && { total }) }
}
