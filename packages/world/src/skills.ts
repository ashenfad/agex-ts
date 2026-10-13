/**
 * Skills: packaged instructions that live in the workspace, after
 * nontainer's `skills` module.
 *
 * The convention is Claude Code's: `<root>/skills/<name>/SKILL.md` with
 * frontmatter (`name`, `description`), and any files beside it.
 * - **Discovery** is the tool text's: {@link skillCatalog} lists each
 *   skill's name and description, and `toolInstructions` carries it.
 * - **Access** needs no tool of its own: the shell and code read skill
 *   files like any other.
 * - **Installed** skills ({@link installSkill}) are ordinary workspace
 *   files: they version, fork and rewind with the rest, and an agent may
 *   improve them.
 * - **Mounted** skills (the profile's `skills`) are the embedder's and
 *   never the agent's to change: each is mounted read-only at
 *   `<root>/skills/<name>`, beside the installed ones, on every open of
 *   a session and its forks. Not being files of the session, ws-git never
 *   sees them and no commit carries them. An agent that wants to adapt
 *   one copies it under a new name.
 */

import type { FileSystem } from '@agex-ts/termish'
import { MemoryFS } from '@agex-ts/termish/fs/memory'
import { InvalidNameError, WorldError } from './errors'
import { dirname } from './path'
import type { Workspace } from './workspace'

/** The directory skills live in, under the workspace's root. */
export const SKILLS_DIR = 'skills'

/** A skill given by its files: `SKILL.md` and anything beside it, by
 *  path relative to the skill's directory. `name` is used when the
 *  frontmatter names none. */
export interface SkillFiles {
  readonly name?: string
  readonly files: Readonly<Record<string, string | Uint8Array>>
}

/** A skill: its `SKILL.md` text alone, or its files. */
export type SkillSource = string | SkillFiles

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Where skills live in a workspace: `<root>/skills`. */
export function skillsRoot(ws: Pick<Workspace, 'root'>): string {
  return `${ws.root === '/' ? '' : ws.root}/${SKILLS_DIR}`
}

/** The top-level `key: value` pairs of a leading `---` block. Minimal
 *  on purpose: nested YAML isn't read. */
export function frontmatter(content: string | Uint8Array): Record<string, string> {
  let text = typeof content === 'string' ? content : dec.decode(content)
  if (text.startsWith('﻿')) text = text.slice(1)
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const fields: Record<string, string> = {}
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    if (line.startsWith(' ') || line.startsWith('\t')) continue
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    const key = line.slice(0, sep).trim().toLowerCase()
    if (key === '') continue
    fields[key] = line
      .slice(sep + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '')
  }
  return fields
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'skill'
  )
}

/** A skill's files, checked: `SKILL.md` is there, and every path stays
 *  inside the skill's directory. */
function filesOf(source: SkillSource): Map<string, Uint8Array> {
  const given = typeof source === 'string' ? { 'SKILL.md': source } : source.files
  const files = new Map<string, Uint8Array>()
  for (const [path, content] of Object.entries(given)) {
    const rel = path.replace(/^\.?\//, '')
    if (rel === '' || rel.split('/').some((part) => part === '..' || part === '')) {
      throw new InvalidNameError(`skill file ${JSON.stringify(path)}: a path inside the skill`)
    }
    files.set(rel, typeof content === 'string' ? enc.encode(content) : content)
  }
  if (!files.has('SKILL.md')) {
    throw new InvalidNameError('a skill needs a SKILL.md at its root')
  }
  return files
}

/** What a skill is called once installed or mounted: its frontmatter
 *  name, else the name it was given. */
export function skillName(source: SkillSource): string {
  const files = filesOf(source)
  const given = typeof source === 'string' ? undefined : source.name
  return slug(frontmatter(files.get('SKILL.md') as Uint8Array).name ?? given ?? 'skill')
}

/** A read-only filesystem holding one skill's files at its root, for
 *  mounting. */
export async function skillFS(source: SkillSource): Promise<FileSystem> {
  const fs = new MemoryFS()
  for (const [rel, content] of filesOf(source)) {
    const path = `/${rel}`
    const parent = dirname(path)
    if (parent !== '/') await fs.mkdir(parent, { parents: true, existOk: true })
    await fs.write(path, content)
  }
  return fs
}

/**
 * Install a skill into the workspace at `<root>/skills/<name>/`; its
 * name. Installing again overwrites. The files are committed
 * (`{tool: 'skill', skill}`), as the framework writing at a moment it
 * chose: an agent's ws-git measures from its own last commit, so a
 * composition in flight reads as before.
 *
 * @throws WorldError for a name the profile mounts.
 */
export async function installSkill(ws: Workspace, source: SkillSource): Promise<string> {
  const files = filesOf(source)
  const name = skillName(source)
  const root = skillsRoot(ws)
  if (ws.mountedSkills.includes(name)) {
    throw new WorldError(
      `skill '${name}' is mounted read-only at ${root}/${name}; install this one under another name`,
    )
  }
  for (const [rel, content] of files) {
    const path = `${root}/${name}/${rel}`
    await ws.files.fs.mkdir(dirname(path), { parents: true, existOk: true })
    await ws.files.fs.write(path, content)
  }
  if (ws.uncommitted) await ws.commit({ tool: 'skill', skill: name })
  return name
}

/**
 * The discovery primer: one line per skill (installed or mounted), for
 * the tool text; empty when there are none. A broken skills directory
 * never blocks a session: it reads as no skills.
 */
export async function skillCatalog(ws: Workspace): Promise<string> {
  const root = skillsRoot(ws)
  const fs = ws.files.fs
  const rows: string[] = []
  try {
    if (!(await fs.isDir(root))) return ''
    for (const name of (await fs.list(root)).sort()) {
      const path = `${root}/${name}/SKILL.md`
      if (!(await fs.isFile(path))) continue
      const description = frontmatter(await fs.read(path)).description ?? ''
      rows.push(description === '' ? `- ${name}` : `- ${name}: ${description}`)
    }
  } catch {
    return ''
  }
  if (rows.length === 0) return ''
  return `\n\nSkills — packaged guidance under ${root}; when a task matches one, read its instructions first (cat ${root}/<name>/SKILL.md):\n${rows.join('\n')}\nSkills may be added mid-session: \`ls ${root}\` to re-check.`
}
