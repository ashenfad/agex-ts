/**
 * The worker's half of `ui` artifacts: each value code put in `ui`,
 * turned into a file's content while the value is still itself.
 *
 * It runs in the worker because some values can't leave it as they
 * are (an Arrow table loses its methods to structured clone, an
 * `OffscreenCanvas` can't be cloned at all). What crosses to the host
 * is bytes or text and a file extension, a path the code named, or a
 * note saying why a value renders as nothing; the host writes the
 * files (see `ui.ts`).
 *
 * The set that renders is closed: a Plotly spec (a chart), an array of
 * row objects or an Arrow table (a table), image bytes (a picture), and
 * a row of stat and callout cards. Anything else is data, and is not
 * written: announcing a file nothing renders would tell the agent its
 * figure arrived.
 */

import { repr } from '../repr'

/** A `ui` value as it crosses to the host. */
export type UiEntry =
  | { readonly name: string; readonly ext: string; readonly data: Uint8Array | string }
  /** A string naming a file the code saved itself. */
  | { readonly name: string; readonly pointer: string }

/** What a run's `ui` gave: the entries, and why some values gave none. */
export interface UiHarvest {
  readonly entries: readonly UiEntry[]
  readonly notes: readonly string[]
}

/** Bytes past which an artifact is refused, and a note written in its
 *  place: a renderer's limit, which also bounds what one artifact adds
 *  to the session's history. */
export const MAX_ARTIFACT_BYTES = 8_000_000

/** The most entries of `ui` one run materializes. */
export const MAX_UI_ENTRIES = 20

/** The most rows a table artifact keeps; `total` says how many there were. */
export const MAX_TABLE_ROWS = 200

/** The most cards a card row keeps: past two dozen it is noise. */
const MAX_CARDS = 24

/** A `ui` value no tier renders, carrying the note the agent reads. */
class NotRenderable extends Error {}

/**
 * The entries for `ui` as the run left it. `declared` is that the code
 * declared a `ui` of its own, which hides the binding: a run that did
 * and left the binding empty is told so.
 */
export async function harvestUi(ui: unknown, declared: boolean): Promise<UiHarvest> {
  const entries: UiEntry[] = []
  const notes: string[] = []
  // the run failed before the code began
  if (ui === undefined) return { entries, notes }
  let named: Record<string, unknown>
  if (isPlainObject(ui)) {
    named = ui
  } else if (Array.isArray(ui) && ui.length > 0 && ui.every(isCard)) {
    // A card row assigned straight to `ui`: the items are right, only
    // the object around them is missing.
    named = { cards: ui }
  } else {
    const nearMiss = cardRowNearMiss('ui', ui)
    notes.push(
      nearMiss ??
        `ui is ${kindOf(ui)}, not an object of named values, so nothing was rendered: assign ui.name = value instead`,
    )
    return { entries, notes }
  }
  const keys = Object.keys(named)
  if (keys.length === 0) {
    if (declared) {
      notes.push(
        'the code declares its own `ui`, which hides the one whose values are rendered, so nothing was: assign ui.name = value without declaring it',
      )
    }
    return { entries, notes }
  }
  const taken = new Set<string>()
  for (const raw of keys.slice(0, MAX_UI_ENTRIES)) {
    const value = named[raw]
    // A near-miss is a card row with a mistake in it, not a table or
    // data: the note names the item to fix, and nothing is written.
    const nearMiss = cardRowNearMiss(raw, value)
    if (nearMiss !== null) {
      notes.push(nearMiss)
      continue
    }
    const name = unique(artifactName(raw), taken)
    try {
      const entry = await materialize(name, value)
      const size = typeof entry === 'object' && 'data' in entry ? byteLength(entry.data) : 0
      if (size > MAX_ARTIFACT_BYTES) {
        const note = tooLargeNote(raw, size, 'ext' in entry && entry.ext === 'plotly.json')
        notes.push(note)
        entries.push({ name, ext: 'txt', data: note })
      } else {
        entries.push(entry)
      }
    } catch (e) {
      if (e instanceof NotRenderable) {
        notes.push(e.message)
      } else {
        notes.push(
          `${repr(raw)} could not be rendered: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}. Fix what it holds, or write the file yourself and assign its path.`,
        )
      }
    }
  }
  if (keys.length > MAX_UI_ENTRIES) {
    notes.push(`ui holds ${keys.length} values; only the first ${MAX_UI_ENTRIES} were rendered`)
  }
  return { entries, notes }
}

/** A `ui` key as a file name: runs of anything but word characters,
 *  dots and dashes become one dash. */
export function artifactName(raw: string): string {
  return raw.replace(/[^\w.-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'artifact'
}

/** `name`, or the first of `name-2`, `name-3`, … not yet taken (two
 *  keys can sanitize to one name); taken from then on. */
function unique(name: string, taken: Set<string>): string {
  let out = name
  for (let n = 2; taken.has(out); n++) out = `${name}-${n}`
  taken.add(out)
  return out
}

async function materialize(name: string, value: unknown): Promise<UiEntry> {
  // A string naming a file is a pointer to an artifact the code saved.
  if (typeof value === 'string' && value.startsWith('/')) return { name, pointer: value }

  // spec tier: the studio renders it, and themes it
  if (looksLikePlotly(value)) return { name, ext: 'plotly.json', data: toJson(value) }
  const cards = Array.isArray(value) ? value : isCallout(value) ? [value] : null
  if (cards !== null && cards.length > 0 && cards.every(isCard)) {
    const items = cards.slice(0, MAX_CARDS).map(normalizeCard)
    return { name, ext: 'cards.json', data: toJson({ items }) }
  }
  const table = arrowRows(value) ?? (isRecords(value) ? value : null)
  if (table !== null) return { name, ext: 'table.json', data: toJson(tableSpec(table)) }

  // pixel tier
  const image = await imageBytes(value)
  if (image !== null) return { name, ext: image.ext, data: image.bytes }

  throw new NotRenderable(notAnArtifact(name, value))
}

// ---------- charts ----------

/** A Plotly figure spec: `data` an array and `layout` an object. The
 *  rule a consumer sniffs a bare `.json` artifact by, too. */
export function looksLikePlotly(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return Array.isArray(value.data) && isPlainObject(value.layout)
}

// ---------- cards ----------

/** A stat: any object with a label and a value. */
function isStat(v: unknown): boolean {
  return isPlainObject(v) && 'label' in v && 'value' in v
}

/** A callout: tagged `type: 'callout'`, with a title or a body. The tag
 *  is required: an untagged `{title, body}` is too ordinary to claim. */
function isCallout(v: unknown): boolean {
  return isPlainObject(v) && v.type === 'callout' && ('title' in v || 'body' in v)
}

const isCard = (v: unknown): boolean => isStat(v) || isCallout(v)

function normalizeCard(i: Record<string, unknown>): Record<string, unknown> {
  if (isCallout(i)) {
    // never inferred from the words: unknown or absent is info
    const tone = i.tone === 'success' || i.tone === 'warning' ? i.tone : 'info'
    return {
      type: 'callout',
      title: 'title' in i ? String(i.title) : '',
      body: 'body' in i ? String(i.body) : '',
      tone,
    }
  }
  const card: Record<string, unknown> = {
    type: 'stat',
    label: String(i.label),
    value: cell(i.value),
  }
  if ('sublabel' in i) card.sublabel = String(i.sublabel)
  return card
}

/** Why an almost-card-row renders nothing, naming the item that broke
 *  it; null when the value isn't card-shaped enough to say. */
function cardRowNearMiss(name: string, value: unknown): string | null {
  if (isStat(value) && !isCallout(value)) {
    return `${repr(name)} looks like a single stat, but a card row is an ARRAY: wrap it as [{...}] to render it as a card. On its own it is a plain object, which renders nothing.`
  }
  if (!Array.isArray(value) || value.length === 0) return null
  const matched = value.filter(isCard).length
  if (matched === value.length || matched * 2 < value.length) return null
  const bad = value.find((i) => !isCard(i))
  return `${repr(name)} looks like a card row, but this item is neither a stat (needs label and value) nor a tagged callout (needs type: 'callout' and a title or body): ${preview(bad)}. Fix that item to render cards.`
}

// ---------- tables ----------

/** Rows as objects: a non-empty array of plain objects. */
function isRecords(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject)
}

/** An Arrow table's rows as objects, duck-typed (no import): a
 *  `schema` with `fields`, and `toArray()`. Null for anything else. */
function arrowRows(value: unknown): Record<string, unknown>[] | null {
  if (typeof value !== 'object' || value === null) return null
  const t = value as {
    schema?: { fields?: unknown }
    toArray?: unknown
    slice?: unknown
    numRows?: unknown
  }
  if (!Array.isArray(t.schema?.fields) || typeof t.toArray !== 'function') return null
  const fields = (t.schema.fields as { name?: unknown }[]).map((f) => String(f.name))
  const head =
    typeof t.slice === 'function' && typeof t.numRows === 'number' && t.numRows > MAX_TABLE_ROWS
      ? (t.slice as (a: number, b: number) => typeof t)(0, MAX_TABLE_ROWS)
      : t
  const rows = (head.toArray as () => unknown[])().map((row) => {
    const out: Record<string, unknown> = {}
    for (const f of fields) out[f] = (row as Record<string, unknown>)[f]
    return out
  })
  const total = typeof t.numRows === 'number' ? t.numRows : rows.length
  return Object.assign(rows, { [TOTAL]: total })
}

/** An Arrow table's row count, past the rows read from it. */
const TOTAL = Symbol('total')

type ColumnType = 'number' | 'boolean' | 'datetime' | 'string'

/**
 * Rows as a table artifact: `columns`, `data` (each row's cells, in
 * column order), `total` (the rows there were; at most
 * {@link MAX_TABLE_ROWS} are kept), and `columnTypes`, so a consumer
 * aligns and sorts a column by what it holds. Every cell is JSON: a
 * date as ISO text, a nested value as JSON text.
 */
function tableSpec(rows: Record<string, unknown>[]): Record<string, unknown> {
  const total = (rows as { [TOTAL]?: number })[TOTAL] ?? rows.length
  const kept = rows.slice(0, MAX_TABLE_ROWS)
  const columns: string[] = []
  const seen = new Set<string>()
  for (const row of kept) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k)
        columns.push(k)
      }
    }
  }
  const columnTypes = columns.map((c) => columnType(kept.map((r) => r[c])))
  const data = kept.map((r) => columns.map((c) => cell(r[c])))
  return { columns, data, total, columnTypes }
}

function columnType(values: unknown[]): ColumnType {
  const present = values.filter((v) => v !== null && v !== undefined)
  if (present.length === 0) return 'string'
  if (present.every((v) => typeof v === 'number' || typeof v === 'bigint')) return 'number'
  if (present.every((v) => typeof v === 'boolean')) return 'boolean'
  if (present.every((v) => v instanceof Date)) return 'datetime'
  return 'string'
}

/** One cell as JSON: a scalar as itself, a date as ISO text, a bigint
 *  as a number when it fits, anything else as JSON text. */
function cell(v: unknown): unknown {
  if (v === undefined) return null
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v)
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : String(v)
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  try {
    return toJson(v)
  } catch {
    return String(v)
  }
}

// ---------- images ----------

const IMAGE_MAGIC: readonly [readonly number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'png'],
  [[0xff, 0xd8, 0xff], 'jpg'],
  [[0x47, 0x49, 0x46, 0x38], 'gif'],
]

/** An image's file extension from its first bytes; null for none. */
function imageExt(b: Uint8Array): string | null {
  for (const [magic, ext] of IMAGE_MAGIC) {
    if (magic.every((x, i) => b[i] === x)) return ext
  }
  const riff = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
  if (riff && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  return null
}

/** A value's image bytes: bytes with an image's signature, a
 *  `data:image/…;base64,` URL, `{format, data}` (as the console shows
 *  an image), a Blob, or an `OffscreenCanvas`. Null for anything else. */
async function imageBytes(value: unknown): Promise<{ ext: string; bytes: Uint8Array } | null> {
  let bytes: Uint8Array | null = null
  if (value instanceof Uint8Array) bytes = value
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
  else if (typeof value === 'string') {
    const m = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(value)
    if (m !== null) bytes = fromBase64(m[1] as string)
  } else if (typeof Blob !== 'undefined' && value instanceof Blob) {
    bytes = new Uint8Array(await value.arrayBuffer())
  } else if (typeof OffscreenCanvas !== 'undefined' && value instanceof OffscreenCanvas) {
    bytes = new Uint8Array(await (await value.convertToBlob({ type: 'image/png' })).arrayBuffer())
  } else if (isPlainObject(value) && typeof value.format === 'string') {
    const data = value.data
    if (data instanceof Uint8Array) bytes = data
    else if (typeof data === 'string') {
      try {
        bytes = fromBase64(data)
      } catch {
        bytes = null
      }
    }
  }
  if (bytes === null) return null
  const ext = imageExt(bytes)
  return ext === null ? null : { ext, bytes }
}

function fromBase64(s: string): Uint8Array {
  const binary = atob(s)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// ---------- notes ----------

/** Why a value is data rather than an artifact, and what to assign. */
function notAnArtifact(name: string, value: unknown): string {
  return `${repr(name)} is ${kindOf(value)}, which is data and not a UI artifact: nothing renders it, so no file was written: ${preview(value)}. To show it, assign a Plotly spec ({data: [...], layout: {...}}, a chart), an array of row objects (a table), image bytes or a data:image URL (a picture), or a card row ([{label: ..., value: ...}]). To keep it as data, print it or write it to a file yourself.`
}

function tooLargeNote(name: string, size: number, chart: boolean): string {
  const note = `ui artifact ${repr(name)} NOT rendered: too large (${(size / 1e6).toFixed(1)}MB > ${MAX_ARTIFACT_BYTES / 1e6}MB cap).`
  return chart
    ? `${note} The usual culprit is per-point customdata or hover text: drop or aggregate it. WebGL traces (scattergl) draw 100k+ points, but the spec must still fit the cap.`
    : `${note} Downsample or aggregate before assigning it to ui.`
}

function kindOf(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return v.length === 0 ? 'an empty array' : 'a plain array'
  if (isPlainObject(v)) return 'a plain object'
  if (typeof v === 'object') return `a ${(v as object).constructor?.name ?? 'object'}`
  return `a ${typeof v}`
}

function preview(v: unknown): string {
  let text: string
  try {
    text = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v, jsonValue) ?? String(v))
  } catch {
    text = String(v)
  }
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

// ---------- helpers ----------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** JSON for a spec: typed arrays as arrays, bigints as numbers, dates
 *  as ISO text. */
function toJson(v: unknown): string {
  return JSON.stringify(v, jsonValue)
}

function jsonValue(this: unknown, _key: string, v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v)
  if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return Array.from(v as unknown as ArrayLike<number | bigint>, (x) =>
      typeof x === 'bigint' ? Number(x) : x,
    )
  }
  return v
}

function byteLength(data: Uint8Array | string): number {
  return typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength
}
