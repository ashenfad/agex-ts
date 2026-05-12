/**
 * `ChaptersOverlay` — read-only `FileSystem` materializing
 * `ChapterEvent`s as a virtual directory tree.
 *
 * Layout:
 *   /chapters/<slug>/summary.md             — chapter name + message
 *   /chapters/<slug>/events/NNN-<type>.md   — each chaptered event,
 *                                              rendered as markdown
 *
 * Mirrors agex-py's `chapters_vfs.py`. Mounted by the `MountFS` at
 * the agent's per-session FS root, so the agent can `cat` and `ls`
 * chaptered work using the same shell tools it uses everywhere
 * else (no separate "browse chapters" surface needed).
 *
 * v1 is a flat tree — nested chapters are listed as separate
 * top-level entries rather than recursed into. Recursive
 * `/chapters/<outer>/chapters/<inner>/` lands when nested chaptering
 * becomes a real concern; the design supports it.
 *
 * Build mechanism: takes a `Map<string, Uint8Array>` of materialized
 * paths and serves it. The action loop calls `buildChaptersOverlay`
 * after each chapter is added to refresh the map; the overlay swaps
 * its backing map atomically.
 */

import type { FileInfo, FileMetadata, FileSystem } from 'termish-ts'
import type { AgentEvent, ChapterEvent, Emission } from '../types'

const enc = new TextEncoder()
const EPOCH_ISO = new Date(0).toISOString()

export class ChaptersOverlay implements FileSystem {
  #files: Map<string, Uint8Array>
  /** All directory paths implied by the file map, computed on swap.
   *  Lets `isDir()` answer for synthetic intermediate dirs. */
  #dirs: Set<string>

  constructor(files: Map<string, Uint8Array> = new Map()) {
    this.#files = files
    this.#dirs = computeDirs(files)
  }

  /** Replace the backing file map. Used by the action loop after a
   *  new chapter lands. */
  swap(files: Map<string, Uint8Array>): void {
    this.#files = files
    this.#dirs = computeDirs(files)
  }

  // ---------- cwd (no-op for read-only overlays) ----------

  getcwd(): string {
    return '/'
  }

  async chdir(path: string): Promise<void> {
    void path
    throw new Error('ChaptersOverlay: chdir is not supported on read-only overlay')
  }

  // ---------- reads ----------

  async read(path: string): Promise<Uint8Array> {
    const norm = normalize(path)
    const bytes = this.#files.get(norm)
    if (bytes === undefined) {
      if (this.#dirs.has(norm)) throw new Error(`read: is a directory: ${path}`)
      throw new Error(`read: no such file: ${path}`)
    }
    return new Uint8Array(bytes)
  }

  async exists(path: string): Promise<boolean> {
    const norm = normalize(path)
    return this.#files.has(norm) || this.#dirs.has(norm)
  }

  async isFile(path: string): Promise<boolean> {
    return this.#files.has(normalize(path))
  }

  async isDir(path: string): Promise<boolean> {
    return this.#dirs.has(normalize(path))
  }

  async stat(path: string): Promise<FileMetadata> {
    const norm = normalize(path)
    const file = this.#files.get(norm)
    if (file !== undefined) {
      return { size: file.byteLength, createdAt: EPOCH_ISO, modifiedAt: EPOCH_ISO, isDir: false }
    }
    if (this.#dirs.has(norm)) {
      return { size: 0, createdAt: EPOCH_ISO, modifiedAt: EPOCH_ISO, isDir: true }
    }
    throw new Error(`stat: no such file or directory: ${path}`)
  }

  // ---------- writes (read-only) ----------

  async write(): Promise<void> {
    throw new Error('ChaptersOverlay: write not supported (read-only overlay)')
  }
  async mkdir(): Promise<void> {
    throw new Error('ChaptersOverlay: mkdir not supported (read-only overlay)')
  }
  async remove(): Promise<void> {
    throw new Error('ChaptersOverlay: remove not supported (read-only overlay)')
  }
  async rmdir(): Promise<void> {
    throw new Error('ChaptersOverlay: rmdir not supported (read-only overlay)')
  }
  async rename(): Promise<void> {
    throw new Error('ChaptersOverlay: rename not supported (read-only overlay)')
  }

  // ---------- iteration ----------

  async list(path = '.', opts: { recursive?: boolean } = {}): Promise<string[]> {
    const norm = path === '.' ? '/' : normalize(path)
    if (!this.#dirs.has(norm)) throw new Error(`list: no such directory: ${path}`)
    const prefix = norm === '/' ? '/' : `${norm}/`
    const direct = new Set<string>()
    const all = new Set<string>()
    for (const k of this.#files.keys()) {
      if (!k.startsWith(prefix)) continue
      const rest = k.slice(prefix.length)
      if (opts.recursive) {
        all.add(rest)
      } else {
        const slash = rest.indexOf('/')
        direct.add(slash === -1 ? rest : rest.slice(0, slash))
      }
    }
    for (const d of this.#dirs) {
      if (d === norm) continue
      if (!d.startsWith(prefix)) continue
      const rest = d.slice(prefix.length)
      if (opts.recursive) {
        all.add(rest)
      } else {
        const slash = rest.indexOf('/')
        direct.add(slash === -1 ? rest : rest.slice(0, slash))
      }
    }
    return [...(opts.recursive ? all : direct)].sort()
  }

  async listDetailed(path = '.', opts: { recursive?: boolean } = {}): Promise<FileInfo[]> {
    const names = await this.list(path, opts)
    const norm = path === '.' ? '/' : normalize(path)
    const userPrefix = path === '/' ? '/' : path === '.' ? '/' : path.replace(/\/$/, '')
    const out: FileInfo[] = []
    for (const name of names) {
      const childAbs = norm === '/' ? `/${name}` : `${norm}/${name}`
      const userPath = userPrefix === '/' ? `/${name}` : `${userPrefix}/${name}`
      const file = this.#files.get(childAbs)
      if (file !== undefined) {
        out.push({
          name: lastSegment(name),
          path: userPath,
          size: file.byteLength,
          createdAt: EPOCH_ISO,
          modifiedAt: EPOCH_ISO,
          isDir: false,
        })
      } else if (this.#dirs.has(childAbs)) {
        out.push({
          name: lastSegment(name),
          path: userPath,
          size: 0,
          createdAt: EPOCH_ISO,
          modifiedAt: EPOCH_ISO,
          isDir: true,
        })
      }
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Build helpers — turn a list of events into the path → bytes map
// ---------------------------------------------------------------------------

/** Build the file map for the chapters overlay from an event-log
 *  iteration plus a resolver that fetches the original event by its
 *  state key.
 *
 *  Nested chapters: when an event in a chapter's `eventRefs` is
 *  itself a `ChapterEvent` (because the chapter task chose to
 *  chapter a range that included a prior chapter), it recurses into
 *  `<base>/chapters/<inner-slug>/...` rather than flattening it to
 *  a single event file. The hierarchy mirrors agex-py's
 *  `chapters_vfs._build_chapter_entries`. */
export async function buildChaptersOverlay(
  events: AsyncIterable<AgentEvent>,
  resolveEvent: (ref: string) => Promise<AgentEvent | undefined>,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  for await (const e of events) {
    if (e.type !== 'chapter') continue
    // Paths are relative to the overlay's root. The MountFS that
    // hosts this overlay strips its mount prefix before reads, so
    // the overlay never sees `/chapters/...` as input.
    await renderChapterAt(e, '', out, resolveEvent)
  }
  return out
}

/** Render `chapter` and its nested children into `out` at `parentPath`
 *  (e.g. `''` for top-level, or `'/<outer>/chapters'` when recursing). */
async function renderChapterAt(
  chapter: ChapterEvent,
  parentPath: string,
  out: Map<string, Uint8Array>,
  resolveEvent: (ref: string) => Promise<AgentEvent | undefined>,
): Promise<void> {
  const base = `${parentPath}/${chapter.slug}`
  out.set(`${base}/summary.md`, enc.encode(`# ${chapter.name}\n\n${chapter.message}\n`))
  let eventIdx = 1
  for (const ref of chapter.eventRefs) {
    const original = await resolveEvent(ref)
    if (original === undefined) continue
    if (original.type === 'chapter') {
      // Nested chapter — recurse one level deeper.
      await renderChapterAt(original, `${base}/chapters`, out, resolveEvent)
    } else {
      const pad = eventIdx.toString().padStart(3, '0')
      const path = `${base}/events/${pad}-${original.type}.md`
      out.set(path, enc.encode(renderEventMarkdown(original)))
      eventIdx++
    }
  }
}

function renderEventMarkdown(e: AgentEvent): string {
  // Minimal but informative per-event rendering. The wire-format
  // renderer in provider packages will produce richer markdown for
  // LLM consumption; this version is for the agent's `cat` use.
  const header = `# ${e.type} @ ${e.timestamp}`
  switch (e.type) {
    case 'taskStart':
      return `${header}\n\nTask: ${e.taskName}\n\nInputs:\n\n\`\`\`\n${safeJson(e.inputs)}\n\`\`\`\n`
    case 'action': {
      const blocks = e.emissions.map((em, i) => {
        return `## Emission ${i + 1}: ${em.type}\n\n${describeEmission(em)}`
      })
      return `${header}\n\n${blocks.join('\n\n')}\n`
    }
    case 'output': {
      const parts = e.parts.map((p) => {
        if (p.type === 'text') return `\`\`\`\n${p.text}\n\`\`\``
        if (p.type === 'error') return `**${p.errorName}**: ${p.errorMessage}`
        return `*[image: ${p.format}, ${p.data.length} bytes base64]*`
      })
      return `${header}\n\n${parts.join('\n\n')}\n`
    }
    case 'success':
      return `${header}\n\nResult:\n\n\`\`\`\n${safeJson(e.result)}\n\`\`\`\n`
    case 'fail':
      return `${header}\n\n${e.message}\n`
    case 'cancelled':
      return `${header}\n\n${e.taskName}: cancelled after ${e.iterationsCompleted} iterations\n`
    case 'error':
      return `${header}\n\n${e.errorName}: ${e.errorMessage}\n`
    case 'file':
      return `${header}\n\nadded: ${e.added.join(', ')}\nmodified: ${e.modified.join(', ')}\nremoved: ${e.removed.join(', ')}\n`
    case 'systemNote':
      return `${header}\n\n${e.message}\n`
    case 'chapter':
      return `${header}\n\n# ${e.name}\n\n${e.message}\n`
    default: {
      const exhaustive: never = e
      void exhaustive
      return header
    }
  }
}

function describeEmission(em: Emission): string {
  switch (em.type) {
    case 'ts':
      return `\`\`\`ts\n${em.code}\n\`\`\``
    case 'terminal':
      return `\`\`\`sh\n${em.commands}\n\`\`\``
    case 'fileWrite':
      return `**${em.path}** (${em.mode})\n\n\`\`\`\n${em.content}\n\`\`\``
    case 'fileEdit':
      return `**${em.path}**\n\nsearch:\n\n\`\`\`\n${em.search}\n\`\`\`\n\nreplace:\n\n\`\`\`\n${em.content}\n\`\`\``
    case 'text':
      return em.text
    case 'thinking':
      return `*thinking:* ${em.text}`
    default: {
      const exhaustive: never = em
      void exhaustive
      return ''
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalize(path: string): string {
  const abs = path.startsWith('/') ? path : `/${path}`
  const segments = abs.split('/').filter((s) => s !== '' && s !== '.')
  const out: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      if (out.length > 0) out.pop()
    } else out.push(seg)
  }
  return `/${out.join('/')}`
}

function lastSegment(path: string): string {
  const idx = path.lastIndexOf('/')
  return idx < 0 ? path : path.slice(idx + 1)
}

function computeDirs(files: Map<string, Uint8Array>): Set<string> {
  const dirs = new Set<string>(['/'])
  for (const k of files.keys()) {
    let cur = k
    while (true) {
      const idx = cur.lastIndexOf('/')
      if (idx <= 0) break
      cur = cur.slice(0, idx)
      dirs.add(cur)
    }
  }
  return dirs
}
