/**
 * `SkillsOverlay` — read-only `FileSystem` materializing each
 * registered skill as `/skills/<name>/SKILL.md`.
 *
 * Mirrors agex-py's `/skills/<name>/SKILL.md` layout. Skills are
 * not embedded in the system prompt (would bloat tokens); only
 * their names + first-line descriptions appear in the primer's
 * "Skills" listing, telling the agent to `cat /skills/<name>/SKILL.md`
 * for the full content.
 *
 * Built from the agent's policy. Refreshes whenever a new skill is
 * registered (via the same VfsManager.refreshSkillsOverlay path
 * the chapters overlay uses).
 */

import type { FileInfo, FileMetadata, FileSystem } from 'termish-ts'
import type { RegisteredSkill } from '../types'

const enc = new TextEncoder()
const EPOCH_ISO = new Date(0).toISOString()

export class SkillsOverlay implements FileSystem {
  #files: Map<string, Uint8Array>
  #dirs: Set<string>

  constructor(skills: ReadonlyMap<string, RegisteredSkill> = new Map()) {
    this.#files = buildFiles(skills)
    this.#dirs = computeDirs(this.#files)
  }

  /** Replace the backing skills map. Called by VfsManager when the
   *  agent's policy changes. */
  swap(skills: ReadonlyMap<string, RegisteredSkill>): void {
    this.#files = buildFiles(skills)
    this.#dirs = computeDirs(this.#files)
  }

  // ---------- cwd ----------

  getcwd(): string {
    return '/'
  }

  async chdir(path: string): Promise<void> {
    void path
    throw new Error('SkillsOverlay: chdir is not supported on read-only overlay')
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
    throw new Error('SkillsOverlay: write not supported (read-only overlay)')
  }
  async mkdir(): Promise<void> {
    throw new Error('SkillsOverlay: mkdir not supported (read-only overlay)')
  }
  async remove(): Promise<void> {
    throw new Error('SkillsOverlay: remove not supported (read-only overlay)')
  }
  async rmdir(): Promise<void> {
    throw new Error('SkillsOverlay: rmdir not supported (read-only overlay)')
  }
  async rename(): Promise<void> {
    throw new Error('SkillsOverlay: rename not supported (read-only overlay)')
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
// Helpers
// ---------------------------------------------------------------------------

function buildFiles(skills: ReadonlyMap<string, RegisteredSkill>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  for (const [name, skill] of skills) {
    out.set(`/${name}/SKILL.md`, enc.encode(skill.content))
  }
  return out
}

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

/** Build the listing block for the system prompt. Each line:
 *  `- <name>: <first-line-of-content>` or just `- <name>`. */
export function renderSkillsListing(skills: ReadonlyMap<string, RegisteredSkill>): string {
  if (skills.size === 0) return ''
  const lines: string[] = ['## Skills', '']
  lines.push(
    'Skills carry project-specific knowledge — read the full content with `cat /skills/<name>/SKILL.md` from `terminal_action` before guessing.',
  )
  lines.push('')
  lines.push('Available skills:')
  const sortedSkills = [...skills.values()].sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const s of sortedSkills) {
    const firstLine = s.content.split('\n').find((l) => l.trim().length > 0) ?? ''
    const summary = firstLine.replace(/^#+\s*/, '').slice(0, 80)
    if (summary.length > 0) lines.push(`- \`${s.name}\`: ${summary}`)
    else lines.push(`- \`${s.name}\``)
  }
  return lines.join('\n')
}
