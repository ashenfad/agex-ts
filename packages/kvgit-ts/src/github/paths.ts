/**
 * Key → git tree path planning for the GitHub transport.
 *
 * Tree paths are a RENDERING of the keyset — the sidecar
 * (`sidecar.ts`) is the authoritative record of where each key's blob
 * lives, so readers never re-derive paths. What this module must
 * guarantee is therefore not invertibility but:
 *
 * 1. **Validity** — every produced path is a git tree path GitHub
 *    accepts: no empty / `.` / `..` / `.git` segments (the live suite
 *    pinned `.git` rejection), no Windows-hostile trailing dot/space.
 * 2. **Injectivity** — distinct keys never produce the same path
 *    (tree entries would collide). Guaranteed per-segment: `%` always
 *    escapes to `%25`, so no raw segment can collide with another's
 *    escaped form.
 * 3. **File/dir conflict resolution** — git trees can't hold a file
 *    and a directory at the same path (keys `a` and `a/b`). The
 *    planner gives the natural nested path when free and relocates
 *    the newcomer to the flat `_kv/<escaped-full-key>` zone when
 *    occupied. First-come-keeps-the-spot: assignments are stable for
 *    a key's lifetime and the rule replays identically given the same
 *    history (pushers assign in deterministic order; replays read
 *    paths from sidecars and never recompute).
 *
 * Root-level `.kvgit` (sidecar home) and `_kv` (relocation zone) are
 * reserved: user keys landing there get their first character
 * percent-escaped.
 */

/** Where the per-commit sidecar lives in every tree. */
export const SIDECAR_PATH = '.kvgit/commit.json'

/** Root directory for keys whose natural path is unavailable. */
export const RELOCATION_ROOT = '_kv'

const HEX = '0123456789ABCDEF'

function pct(char: string): string {
  const code = char.charCodeAt(0)
  // Multi-byte chars never need escaping here (only ASCII triggers);
  // charCodeAt(0) is safe for every char this module escapes.
  return `%${HEX[(code >> 4) & 0xf]}${HEX[code & 0xf]}`
}

/** Shared segment finalizer: empty marker, special-name first-char
 *  escape, then Windows-hostile trailing dot/space escape. The rules
 *  COMPOSE — `..` needs both the name escape and the trailing fix
 *  (`%2E.` still ends in a dot). */
function finalizeSegment(out: string): string {
  if (out.length === 0) return '%'
  let result = out
  if (result === '.' || result === '..' || /^\.git$/i.test(result)) {
    result = pct(result[0] as string) + result.slice(1)
  }
  // Windows-hostile endings would break checkouts of the sync repo.
  const last = result[result.length - 1]
  if (last === '.' || last === ' ') {
    result = result.slice(0, -1) + pct(last)
  }
  return result
}

/** Escape one raw path segment (no slashes). Injective: `%` always
 *  becomes `%25`, so escaped forms can't collide with raw ones; the
 *  bare `%` marker for the empty segment is distinguishable because
 *  every other output `%` begins a `%XX` triple. */
export function escapeSegment(seg: string): string {
  let out = ''
  for (const ch of seg) {
    const code = ch.charCodeAt(0)
    out += ch === '%' || code < 0x20 || code === 0x7f ? pct(ch) : ch
  }
  return finalizeSegment(out)
}

/** A key's natural (nested) tree path. Reserved root segments are
 *  escaped so user keys can't invade `.kvgit/` or `_kv/`. */
export function naturalPath(key: string): string {
  const segments = key.split('/').map(escapeSegment)
  const root = segments[0] as string
  if (root === RELOCATION_ROOT || root === '.kvgit') {
    segments[0] = pct(root[0] as string) + root.slice(1)
  }
  return segments.join('/')
}

/** The flat fallback path: full key as one escaped segment under
 *  `_kv/` (slashes escaped too, so the zone never nests). */
export function relocatedPath(key: string): string {
  let seg = ''
  for (const ch of key) {
    const code = ch.charCodeAt(0)
    seg += ch === '%' || ch === '/' || code < 0x20 || code === 0x7f ? pct(ch) : ch
  }
  return `${RELOCATION_ROOT}/${finalizeSegment(seg)}`
}

/**
 * Stateful path assignment for one branch's evolving tree.
 *
 * Seed with the parent state's assignments, `assign` new/updated keys
 * (in a deterministic order — callers sort), `remove` deleted ones.
 * Existing keys keep their path for life ("first-come-keeps-the-spot"),
 * so sidecar paths recorded by older commits never go stale.
 */
export class PathPlanner {
  /** key → assigned path */
  readonly #byKey = new Map<string, string>()
  /** occupied file paths */
  readonly #files = new Set<string>()
  /** directory prefix → number of files beneath it */
  readonly #dirs = new Map<string, number>()

  static fromAssignments(entries: Iterable<readonly [string, string]>): PathPlanner {
    const planner = new PathPlanner()
    for (const [key, path] of entries) planner.#record(key, path)
    return planner
  }

  /** The path currently assigned to `key`, if any. */
  get(key: string): string | undefined {
    return this.#byKey.get(key)
  }

  entries(): IterableIterator<[string, string]> {
    return this.#byKey.entries()
  }

  /**
   * Assign a tree path to `key`: its existing assignment if present
   * (updates never move a key), else the natural path if free, else
   * the `_kv/` relocation slot.
   */
  assign(key: string): string {
    const existing = this.#byKey.get(key)
    if (existing !== undefined) return existing
    const natural = naturalPath(key)
    const path = this.#conflicts(natural) ? relocatedPath(key) : natural
    this.#record(key, path)
    return path
  }

  /** Release a removed key's path (frees its slot and any directory
   *  prefixes that drop to zero files). */
  remove(key: string): void {
    const path = this.#byKey.get(key)
    if (path === undefined) return
    this.#byKey.delete(key)
    this.#files.delete(path)
    for (const dir of dirPrefixes(path)) {
      const count = (this.#dirs.get(dir) ?? 1) - 1
      if (count <= 0) this.#dirs.delete(dir)
      else this.#dirs.set(dir, count)
    }
  }

  /** A file at `path` conflicts when the slot is a directory, or any
   *  parent slot is a file. */
  #conflicts(path: string): boolean {
    if (this.#files.has(path) || this.#dirs.has(path)) return true
    for (const dir of dirPrefixes(path)) {
      if (this.#files.has(dir)) return true
    }
    return false
  }

  #record(key: string, path: string): void {
    this.#byKey.set(key, path)
    this.#files.add(path)
    for (const dir of dirPrefixes(path)) {
      this.#dirs.set(dir, (this.#dirs.get(dir) ?? 0) + 1)
    }
  }
}

function* dirPrefixes(path: string): Iterable<string> {
  let idx = path.indexOf('/')
  while (idx !== -1) {
    yield path.slice(0, idx)
    idx = path.indexOf('/', idx + 1)
  }
}
