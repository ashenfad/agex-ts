/**
 * The `ws-git` terminal command: the agent's git, as verbs. A port of
 * nontainer's `wsgit.py`, word for word where it prints: what it prints
 * is text a model reads, and nontainer's recorded output
 * (tests/wsgit-corpus) is what it is checked against. The model is
 * `ws.index` (see `agentgit.ts`); this is the parser and the formatter.
 *
 * Where ws-git deviates from git, and why, is nontainer's own record:
 * the module docstring of `nontainer/wsgit.py`.
 */

import { type Commit, KvgitError } from '@agex-ts/kvgit'
import {
  type CommandContext,
  type CommandHandler,
  type CommandResult,
  FsError,
} from '@agex-ts/termish'
import {
  HASH_RE,
  MERGE_TOOL,
  type MergeOutcome,
  PICK_TOOL,
  type WorkspaceIndex,
  changeBase,
  parseBlob,
  virtualParents,
} from '../agentgit'
import { SessionExistsError, UnknownRefError, UnknownSessionError, WorldError } from '../errors'
import { Patterns, whyIgnored } from '../ignore'
import { FILE_PREFIX, GIT_KEY, VIEW_KEY } from '../layout'
import { normalize, resolve } from '../path'
import { type CommandFactory, commandFactory } from '../profile'
import { repr } from '../repr'
import { parseView } from '../views'
import type { Workspace } from '../workspace'
import { splitLinesKeepEnds, unifiedDiff } from './difflib'
import { EDGE, FORMS, HELP, USAGE, VERBS, WORKTREE_FORMS } from './texts'

/** A refusal in ws-git's own words: exit 1, the message on stderr. */
class Refusal extends Error {}

const enc = new TextEncoder()
const dec = new TextDecoder()

type Out = CommandResult | undefined

const fail = (exitCode: number, stderr = ''): CommandResult => ({ exitCode, stderr })
/** A verb given arguments it doesn't take: what was wrong and the
 *  verb's synopsis, on one line. `ws-git help` has the rest. */
const usage = (verb: string, detail: string): CommandResult =>
  fail(2, `${detail} usage: ws-git ${FORMS[verb]}; see 'ws-git help'`)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One verb call's view of its session. */
class Verb {
  readonly ws: Workspace
  readonly git: WorkspaceIndex
  readonly ctx: CommandContext

  constructor(ws: Workspace, ctx: CommandContext) {
    this.ws = ws
    this.git = ws.index
    this.ctx = ctx
  }

  get repo() {
    return this.ws.store.repo
  }

  write(text: string): void {
    this.ctx.stdout.write(text)
  }

  /** Shell spelling → absolute path, from the shell's cwd. */
  abspath(arg: string): string {
    return normalize(resolve(arg, this.ctx.fs.getcwd()))
  }

  /** A path as the agent can type it back: relative to the root under
   *  it, absolute elsewhere. */
  show(path: string): string {
    const root = this.ws.root.replace(/\/+$/, '')
    return root !== '' && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
  }

  #patterns: Patterns | null = null

  /** Whether a path is never work (outside the root, or ignored). */
  ignores(path: string): boolean {
    this.#patterns ??= new Patterns(this.ws.ignore)
    return whyIgnored(path, this.ws.root, this.#patterns) !== null
  }

  dropIgnored(paths: Iterable<string>): string[] {
    return [...paths].filter((p) => !this.ignores(p))
  }

  async sessions(): Promise<string[]> {
    return this.ws.store.sessions()
  }

  async isSession(name: string): Promise<boolean> {
    return name !== this.ws.session && (await this.sessions()).includes(name)
  }

  /** The commit a store tag of this name names, or null. */
  async storeTag(name: string): Promise<string | null> {
    if (name === '' || name.includes('@') || name.startsWith('@')) return null
    const stored = `@store/${name}`
    return (await this.repo.tags.has(stored)) ? this.repo.tags.get(stored) : null
  }

  /** A word's reading as a store tag: never one with an `@`, and a
   *  session's name is the session's. */
  async storeTagRef(word: string): Promise<string | null> {
    if (word.includes('@') || (await this.isSession(word))) return null
    return this.storeTag(word)
  }

  noSuchRef(name: string): string {
    return `unknown session or store tag ${repr(name)}: this store holds no session and no store tag of that name (ws-git branch lists the sessions; a store tag is a name given to a commit so that it outlives its session)`
  }

  async requireSession(name: string): Promise<void> {
    if (name === this.ws.session) return
    if ((await this.sessions()).includes(name)) return
    throw new Refusal(`unknown session ${repr(name)} (ws-git branch lists them)`)
  }

  notARef(session: string, word: string): string {
    const where =
      session === this.ws.session
        ? 'ws-git log, ws-git tag'
        : `ws-git log ${session}, where its commits and its tags both show`
    if (word === 'HEAD') {
      return `HEAD is not a ref in this position: it takes one exact commit on session ${repr(session)}, spelled as a commit id, a short id or a tag of that session (${where})`
    }
    return `${word} is not a commit, a short id or a tag on session ${repr(session)} (${where})`
  }

  /** The commit half of `session@x`: that session's own tag, or a
   *  commit id expanded against its history. */
  async refCommit(session: string, word: string): Promise<string> {
    await this.requireSession(session)
    const head = session === this.ws.session ? this.ws.head : await this.repo.branches.get(session)
    const blob = parseBlob(await (await this.repo.snapshot({ commit: head })).get(GIT_KEY))
    const tagged = blob.tags[word]
    if (tagged !== undefined) return tagged
    const whole = await this.expandIn(head, word, `on session ${repr(session)}`)
    if (!HASH_RE.test(whole)) throw new Refusal(this.notARef(session, word))
    return whole
  }

  /** A short id → the whole one it names among the commits `head`
   *  reaches; anything else as it came. */
  async expandIn(head: string, word: string, where: string): Promise<string> {
    if (!/^[0-9a-f]{7,40}$/.test(word)) return word
    const found = new Set<string>()
    for await (const c of this.repo.log({ commit: head })) {
      if (c.hash.startsWith(word)) found.add(c.hash)
    }
    const matches = [...found].sort()
    if (matches.length === 1) return matches[0] as string
    if (matches.length === 0) return word
    throw new Refusal(
      `ambiguous commit ${repr(word)} ${where}: it names ${matches.length} commits (${matches.map((c) => c.slice(0, 12)).join(', ')}) — type more of the id.`,
    )
  }

  /** Another session, or the state a store tag names, opened frozen
   *  for one verb. The caller closes it. */
  async other(name: string): Promise<Workspace> {
    const tagged = await this.storeTagRef(name)
    const settings = { ...this.ws.settings, root: this.ws.root }
    if (tagged !== null) return this.ws.store._frozenView(`@store/tag/${name}`, tagged, settings)
    if (!name.includes('@') && !(await this.isSession(name))) {
      throw new Refusal(this.noSuchRef(name))
    }
    await this.requireSession(name)
    return this.ws.store.resolve(name, settings)
  }

  async seedPaths(): Promise<string[]> {
    const view = parseView(await this.git.viewRecord())
    const out: string[] = []
    for (const path of view?.seed ?? []) {
      out.push(this.show(path) + ((await this.isDir(path)) ? '/' : ''))
    }
    return out
  }

  async isDir(path: string): Promise<boolean> {
    try {
      return await this.ws.files.fs.isDir(path)
    } catch {
      return false
    }
  }

  /** Commit what this call has written so far, before a verb that lands
   *  a commit of its own (its writes would otherwise refuse it). */
  async settle(): Promise<void> {
    if (this.ws.uncommitted && !this.ws.frozen) await this.ws.commit({ tool: 'terminal' })
  }

  /** The files that differ between two commits, by path. */
  async diffPaths(a: string, b: string): Promise<string[]> {
    const d = await this.repo.diff(a, b)
    return [...d.added, ...d.removed, ...d.modified]
      .filter((k) => k.startsWith(FILE_PREFIX))
      .map((k) => k.slice(FILE_PREFIX.length))
  }

  async filesAt(commit: string | null): Promise<Map<string, unknown>> {
    return this.git.filesAt(commit)
  }
}

// ---------- the command ----------

/** The `ws-git` command, for a profile's `commands` (`{'ws-git':
 *  wsGit}`): the agent's git over its session and its neighbours. */
export const wsGit: CommandFactory = commandFactory(({ ws }) => makeWsGit(ws), {
  description:
    "the agent's git over this session and its neighbours: ws-git (stage|add|unstage|commit|reset|status|diff|log|show|checkout|tag|stash|branch|merge|revert|cherry-pick|worktree|sparse-checkout) [...]; ws-git help for the whole surface",
})

function makeWsGit(ws: Workspace): CommandHandler {
  return async (ctx) => {
    const args = [...ctx.args]
    if (args.length === 0 || ['-h', '--help', 'help'].includes(args[0] as string)) {
      if (args.length === 0) return fail(2, USAGE)
      ctx.stdout.write(`${HELP}\n`)
      return
    }
    const verb = args[0] as string
    const rest = args.slice(1)
    const edge = EDGE[verb]
    if (edge !== undefined) return fail(1, edge)
    if (!VERBS.includes(verb)) {
      return fail(2, `${repr(verb)} is not a ws-git command. ${USAGE}; see 'ws-git help'`)
    }
    const v = new Verb(ws, ctx)
    try {
      return await dispatch(v, verb, rest)
    } catch (e) {
      if (
        e instanceof Refusal ||
        e instanceof WorldError ||
        e instanceof FsError ||
        e instanceof KvgitError
      ) {
        return fail(1, e.message)
      }
      throw e
    }
  }
}

function dispatch(v: Verb, verb: string, rest: string[]): Promise<Out> {
  switch (verb) {
    case 'status':
      return status(v, rest)
    case 'stage':
    case 'add':
      return stage(v, verb, rest)
    case 'unstage':
      return unstage(v, rest)
    case 'commit':
      return commit(v, rest)
    case 'reset':
      return reset(v, rest)
    case 'diff':
      return diff(v, rest)
    case 'log':
      return log(v, rest)
    case 'show':
      return showVerb(v, rest)
    case 'checkout':
      return checkout(v, rest)
    case 'tag':
      return tag(v, rest)
    case 'stash':
      return stash(v, rest)
    case 'branch':
      return branch(v, rest)
    case 'merge':
      return merge(v, rest)
    case 'revert':
      return revert(v, rest)
    case 'cherry-pick':
      return cherryPick(v, rest)
    case 'worktree':
      return worktree(v, rest)
    default:
      return sparseCheckout(v, rest)
  }
}

// ---------- status and the index ----------

async function mergeHash(v: Verb, source: string): Promise<string | null> {
  for (const entry of await v.git.history()) {
    if (entry.info?.tool === MERGE_TOOL && entry.info.source === source) {
      return entry.hash.slice(0, 7)
    }
  }
  return null
}

async function status(v: Verb, rest: string[]): Promise<Out> {
  for (const flag of rest) {
    if (!['--porcelain', '-s', '--short'].includes(flag)) {
      return usage('status', `status takes no ${repr(flag)} (porcelain is the default).`)
    }
  }
  const st = await v.git.status()
  const lines: string[] = []
  const seed = await v.seedPaths()
  if (seed.length > 0) lines.push(`view: ${seed.join(', ')}`)
  if (st.mergeSource !== null) {
    const short = await mergeHash(v, st.mergeSource)
    const at = short !== null ? `@${short}` : ''
    lines.push(`## merging ${st.mergeSource}${at} (${st.mergeUnresolved.length} unresolved)`)
  }
  const staged = new Set(st.staged)
  const unstaged = new Set(st.unstaged)
  const unresolved = new Set(st.mergeUnresolved)
  const added = new Set(st.added)
  const removed = new Set(st.removed)
  for (const path of [...new Set([...staged, ...unstaged, ...unresolved])].sort()) {
    if (unresolved.has(path)) {
      lines.push(`UU ${v.show(path)}`)
      continue
    }
    const kind = added.has(path) ? 'A' : removed.has(path) ? 'D' : 'M'
    lines.push(`${staged.has(path) ? kind : ' '}${unstaged.has(path) ? kind : ' '} ${v.show(path)}`)
  }
  const worktrees = await worktreeLines(v)
  if (worktrees.length > 0) lines.push('worktrees:', ...worktrees)
  if (lines.length > 0) v.write(`${lines.join('\n')}\n`)
  return
}

/**
 * `stage`, and `add`, git's name for it and the one agents type: one
 * verb under two names. A directory (`.` included) stages what is
 * modified under it, deletions too; `-A` (`--all`) with no path stages
 * everything modified, and with paths it is those paths, as in git.
 * The index takes file paths only, so both expand to the modified
 * paths they cover, and a directory with nothing modified under it
 * stages nothing, silently, as git does.
 */
async function stage(v: Verb, verb: string, rest: string[]): Promise<Out> {
  let every = false
  const named: string[] = []
  for (const arg of rest) {
    if (arg === '-A' || arg === '--all') every = true
    else if (arg.startsWith('-')) return usage(verb, `${verb} takes no ${repr(arg)}.`)
    else named.push(v.abspath(arg))
  }
  if (!every && named.length === 0) return usage(verb, `${verb} needs at least one path, or -A.`)
  const st = await v.git.status()
  const modified = [...new Set([...st.unstaged, ...st.staged])].sort()
  let wanted: string[]
  if (named.length === 0) wanted = modified
  else {
    const root = v.ws.root.replace(/\/+$/, '')
    wanted = []
    for (const path of named) {
      if (root !== '' && path !== root && !path.startsWith(`${root}/`)) {
        // Outside the root, `/` included: never expanded, so the index
        // refuses it in its own words.
        wanted.push(path)
        continue
      }
      const prefix = path === '/' ? '/' : `${path.replace(/\/+$/, '')}/`
      const under = modified.filter((m) => m.startsWith(prefix))
      if (under.length > 0 || (await v.ws.files.fs.isDir(path))) {
        wanted.push(...under)
        // A file now where the head has a directory, or the other way
        // round: the path itself changed too, and git stages it with
        // what was under it.
        if (modified.includes(path)) wanted.push(path)
      } else wanted.push(path)
    }
  }
  // Even with nothing to stage: a frozen view still refuses.
  await v.git.stage(wanted)
  return
}

async function unstage(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length === 0 || rest.some((a) => a.startsWith('-'))) {
    return usage('unstage', 'unstage needs at least one path.')
  }
  await v.git.unstage(rest.map((a) => v.abspath(a)))
  return
}

async function commit(v: Verb, rest: string[]): Promise<Out> {
  let message: string | null = null
  const args = [...rest]
  while (args.length > 0) {
    const flag = args.shift() as string
    if ((flag === '-m' || flag === '--message') && args.length > 0) message = args.shift() as string
    else if (flag === '-a')
      return usage('commit', 'commit stages nothing itself (no -a) — stage first, then commit.')
    else return usage('commit', 'commit takes the staged set only (no pathspec; try: -m MSG).')
  }
  const { commit: id, files } = await v.git.commitFiles(message)
  v.write(
    `[${v.ws.session} ${id.slice(0, 7)}] ${message ?? 'ws-git'} (${plural(files.length, 'file')})\n`,
  )
  return
}

async function reset(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length > 0) {
    return usage(
      'reset',
      'reset is mixed-only (no --soft/--hard) — going back to a commit is: ws-git checkout <ref>.',
    )
  }
  await v.git.discard()
  return
}

// ---------- checkout ----------

async function checkout(v: Verb, rest: string[]): Promise<Out> {
  const cut = rest.indexOf('--')
  if (cut >= 0) {
    const head = rest.slice(0, cut)
    const paths = rest.slice(cut + 1)
    if (head.length > 1 || head.some((a) => a.startsWith('-'))) {
      return usage('checkout', 'checkout takes one ref before --.')
    }
    if (paths.length === 0) return usage('checkout', 'checkout -- needs at least one path.')
    const want = head[0] ?? 'HEAD'
    const base = await v.git.base()
    const ref =
      want === 'HEAD' && (await v.git.head()) === null && base !== null
        ? base
        : await takeRef(v, want)
    await v.git.requireUnmerged('checkout -- <paths>')
    await v.ws.checkout(ref, { paths: paths.map((a) => v.abspath(a)) })
    v.write(`Updated ${paths.length} path${paths.length === 1 ? '' : 's'} from ${ref}\n`)
    return
  }
  if (rest.length !== 1 || (rest[0] as string).startsWith('-')) {
    return usage('checkout', 'checkout takes one ref (a commit from ws-git log).')
  }
  const id = await v.git.resolve(rest[0] as string)
  await v.git.requireUnmerged('checkout')
  await v.git.checkout(id)
  v.write(`[${v.ws.session}] restored to ${id.slice(0, 7)}\n`)
  return
}

/** This session's own spellings (HEAD, a hash, a bookmark) go through
 *  its own resolution; anything else (a session, `session@commit`, a
 *  store tag) is for the take to read. */
async function takeRef(v: Verb, ref: string): Promise<string> {
  if (ref === 'HEAD' || HASH_RE.test(ref) || ref in (await v.git.tags.list())) {
    return v.git.resolve(ref)
  }
  return ref
}

// ---------- tags ----------

async function tag(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length === 0) {
    const tags = await v.git.tags.list()
    const lines = Object.entries(tags)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, id]) => `${name} -> ${id.slice(0, 7)}`)
    v.write(`${(lines.length > 0 ? lines : ['(none)']).join('\n')}\n`)
    return
  }
  if (rest[0] === '-d') {
    if (rest.length !== 2 || (rest[1] as string).startsWith('-'))
      return usage('tag', 'tag -d takes one name.')
    const id = await v.git.tags.delete(rest[1] as string)
    v.write(`Deleted tag ${repr(rest[1] as string)} (was ${id.slice(0, 7)})\n`)
    return
  }
  const force = rest[0] === '-f'
  const args = force ? rest.slice(1) : rest
  if (args.length < 1 || args.length > 2 || args.some((a) => a.startsWith('-'))) {
    return usage(
      'tag',
      'tag takes a name and optionally a commit (try: -f to move a name that is taken, -d to drop one).',
    )
  }
  await v.git.tags.add(args[0] as string, {
    ...(args[1] !== undefined && { at: args[1] }),
    force,
  })
  return
}

// ---------- stash ----------

const STASH_REF_RE = /^stash@\{(\d+)\}$/
const STASH_BRANCH_RE = /\.stash-(\d+)$/

async function stashNames(v: Verb): Promise<[number, string][]> {
  const prefix = `${v.ws.session}.`
  const out: [number, string][] = []
  for (const name of await v.sessions()) {
    if (!name.startsWith(prefix)) continue
    const found = STASH_BRANCH_RE.exec(name.slice(prefix.length - 1))
    if (found !== null && name.slice(0, name.length - found[0].length) === v.ws.session) {
      out.push([Number(found[1]), name])
    }
  }
  return out.sort((a, b) => b[0] - a[0])
}

async function stashes(v: Verb): Promise<[string, string][]> {
  const out: [string, string][] = []
  for (const [, name] of await stashNames(v)) {
    try {
      const head = await v.repo.branches.get(name)
      const record = parseBlob(await (await v.repo.snapshot({ commit: head })).get(GIT_KEY)).stash
      if (record !== null && record.of === v.ws.session) out.push([name, record.message])
    } catch {
      // unreadable is not a stash
    }
  }
  return out
}

async function stashPick(v: Verb, word: string | null): Promise<[number, string, string]> {
  let index = 0
  if (word !== null) {
    const found = STASH_REF_RE.exec(word)
    if (found === null) {
      throw new Refusal(
        `${repr(word)} is not a stash: one is spelled stash@{N} (ws-git stash list lists them).`,
      )
    }
    index = Number(found[1])
  }
  const all = await stashes(v)
  const picked = all[index]
  if (picked !== undefined) return [index, picked[0], picked[1]]
  if (all.length === 0) throw new Refusal(`no stash@{${index}}: this session has no stashes`)
  throw new Refusal(
    `no stash@{${index}}: this session has ${all.length} (ws-git stash list lists them)`,
  )
}

async function stash(v: Verb, rest: string[]): Promise<Out> {
  let sub: string
  let args: string[]
  if (rest.length === 0 || (rest[0] as string).startsWith('-')) {
    sub = 'push'
    args = [...rest]
  } else {
    sub = rest[0] as string
    args = rest.slice(1)
  }
  if (!['push', 'list', 'pop', 'drop', 'show'].includes(sub)) {
    return usage('stash', `stash takes no ${repr(sub)} (push, list, pop, drop, show).`)
  }
  if (sub === 'push') return stashPush(v, args)
  if (args.length > 1 || args.some((a) => a.startsWith('-'))) {
    return usage('stash', `stash ${sub} takes one stash at most.`)
  }
  if (sub === 'list') {
    if (args.length > 0) return usage('stash', 'stash list takes no arguments.')
    const lines = (await stashes(v)).map(([, message], i) => `stash@{${i}}: ${message}`)
    v.write(`${(lines.length > 0 ? lines : ['(none)']).join('\n')}\n`)
    return
  }
  const word = args[0] ?? null
  if (sub === 'pop') return stashPop(v, word)
  if (sub === 'drop') return stashDrop(v, word)
  return stashShow(v, word)
}

async function stashPush(v: Verb, rest: string[]): Promise<Out> {
  const args = [...rest]
  let message: string | null = null
  while (args.length > 0) {
    const flag = args.shift() as string
    if ((flag === '-m' || flag === '--message') && args.length > 0) message = args.shift() as string
    else return usage('stash', 'stash push takes a message only (-m MSG).')
  }
  await v.git.requireUnmerged('stash')
  const head = await v.git.head()
  if (head === null) return fail(1, 'You do not have the initial commit yet')
  const st = await v.git.status()
  const modified = [...new Set([...st.staged, ...st.unstaged])].sort()
  if (modified.length === 0) return fail(1, 'No local changes to save')
  if (message === null) {
    const entry = await v.git.entry(head)
    const said = entry?.info?.message
    message = typeof said === 'string' && said !== '' ? said : head.slice(0, 7)
  }
  const names = await stashNames(v)
  const taken = names.length > 0 ? Math.max(...names.map(([n]) => n)) + 1 : 0
  const branchName = `${v.ws.session}.stash-${taken}`
  const live = await v.git.workingFiles()
  const files = new Map(modified.map((p) => [p, live.get(p)] as const))
  const child = await v.ws.fork(branchName, { at: head, inherit: 'fresh' })
  try {
    await child.index.writeStash(v.ws.session, message, files)
  } finally {
    await child.close()
  }
  await v.git.checkout(head)
  v.write(`Saved working directory and index state stash@{0}: ${message}\n`)
  return
}

async function stashPop(v: Verb, word: string | null): Promise<Out> {
  await v.git.requireUnmerged('stash pop')
  const [index, name] = await stashPick(v, word)
  await v.settle()
  const result = merged(
    v,
    await v.ws.merge(name),
    name,
    ` The stash is kept as stash@{${index}}: drop it (ws-git stash drop) once you are done with it.`,
  )
  if (result !== undefined) return result
  await v.ws.store.delete(name, { minAge: 0 })
  v.write(`Dropped stash@{${index}} (${name})\n`)
  return
}

async function stashDrop(v: Verb, word: string | null): Promise<Out> {
  const [index, name] = await stashPick(v, word)
  await v.ws.store.delete(name, { minAge: 0 })
  v.write(`Dropped stash@{${index}} (${name})\n`)
  return
}

async function stashShow(v: Verb, word: string | null): Promise<Out> {
  const [, name] = await stashPick(v, word)
  const stashed = await v.repo.branches.get(name)
  const after = await v.filesAt(stashed)
  const before = await v.git.headFiles()
  const head = await v.git.head()
  const changed = (head !== null ? await v.diffPaths(head, stashed) : [...after.keys()]).sort()
  const body = renderDiff(v, changed, before, after)
  if (body.length > 0) v.write(`${body.join('\n')}\n`)
  return
}

// ---------- branches and merges ----------

async function branch(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length === 0) {
    const mine = v.ws.session
    const lines = (await v.sessions()).sort().map((n) => `${n === mine ? '*' : ' '} ${n}`)
    if (lines.length > 0) v.write(`${lines.join('\n')}\n`)
    return
  }
  const name = rest[0] as string
  if (name.startsWith('-')) return usage('branch', 'branch takes a name first.')
  let at: string | undefined
  let fresh = false
  let paths: string[] | undefined
  const args = rest.slice(1)
  while (args.length > 0) {
    const flag = args.shift() as string
    if (flag === '--at' && args.length > 0) at = args.shift() as string
    else if (flag === '--fresh') fresh = true
    else if (flag === '--paths') {
      paths = []
      while (args.length > 0 && !(args[0] as string).startsWith('-'))
        paths.push(args.shift() as string)
      if (paths.length === 0) return usage('branch', '--paths needs at least one path.')
    } else {
      return usage(
        'branch',
        `branch takes no ${repr(flag)} (try: --at <ref>, --fresh, --paths <paths>).`,
      )
    }
  }
  try {
    const child = await v.ws.fork(name, {
      ...(at !== undefined && { at }),
      inherit: fresh ? 'fresh' : 'full',
      ...(paths !== undefined && { paths: paths.map((a) => v.abspath(a)) }),
    })
    await child.close()
  } catch (e) {
    if (e instanceof SessionExistsError) throw new Refusal(`Branch already exists: ${repr(name)}`)
    throw e
  }
  return
}

async function merge(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length === 1 && rest[0] === '--abort') {
    const { source, commit: id } = await v.git.abortMerge()
    v.write(`[${v.ws.session}] aborted merge of ${source}, restored to ${id.slice(0, 7)}\n`)
    return
  }
  if (rest.length !== 1 || (rest[0] as string).startsWith('-')) {
    return usage('merge', 'merge takes one session name (ws-git branch lists them), or --abort.')
  }
  const source = rest[0] as string
  await v.settle()
  let out: MergeOutcome
  try {
    out = await v.ws.merge(source)
  } catch (e) {
    if (e instanceof UnknownSessionError) throw new Refusal(`unknown branch ${repr(source)}`)
    throw e
  }
  return merged(v, out, source)
}

/** What a merge did, in one shape for every merge; undefined: clean. */
function merged(v: Verb, out: MergeOutcome, source: string, note = ''): Out {
  if (!out.merged) {
    const lines = out.conflicts.map((p) => `CONFLICT: ${v.show(p)}`)
    lines.push(`Merge of ${source} refused: contested state no rule resolves. Nothing changed.`)
    return fail(1, lines.join('\n'))
  }
  for (const p of out.autoMerged) v.write(`Auto-merging ${v.show(p)}\n`)
  for (const p of out.conflicts) v.write(`CONFLICT (content): Merge conflict in ${v.show(p)}\n`)
  const n = out.autoMerged.length + out.conflicts.length
  v.write(
    `[${v.ws.session} ${(out.commit as string).slice(0, 7)}] merge ${source} (${plural(n, 'file')})\n`,
  )
  if (out.conflicts.length > 0) {
    return fail(
      1,
      `Merge landed with conflict markers in ${out.conflicts.length} file(s): fix them and commit (ws-git status shows them as UU).${note}`,
    )
  }
  return
}

async function revert(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length !== 1 || (rest[0] as string).startsWith('-')) {
    return usage('revert', 'revert takes one commit (a commit from ws-git log).')
  }
  const id = await v.git.resolve(rest[0] as string)
  await v.settle()
  return applied(v, await v.ws.revert(id), 'revert', id.slice(0, 7), 'Revert')
}

async function cherryPick(v: Verb, rest: string[]): Promise<Out> {
  if (
    rest.length !== 1 ||
    (rest[0] as string).startsWith('-') ||
    !(rest[0] as string).includes('@')
  ) {
    const named = rest[0] !== undefined && !rest[0].startsWith('-') ? rest[0] : '<session>'
    return usage(
      'cherry-pick',
      `cherry-pick takes one commit of another session, spelled <session>@<commit> (ws-git log ${named} lists them).`,
    )
  }
  const word = rest[0] as string
  const at = word.lastIndexOf('@')
  const session = word.slice(0, at)
  const id = await v.refCommit(session, word.slice(at + 1))
  await v.settle()
  return applied(
    v,
    await v.ws.cherryPick(`${session}@${id}`),
    'cherry-pick',
    `${session}@${id.slice(0, 7)}`,
    'Cherry-pick',
  )
}

/** What applying one commit's change did, in merge's shapes. */
function applied(v: Verb, out: MergeOutcome, verb: string, what: string, noun: string): Out {
  if (!out.merged && out.conflicts.length === 0) {
    return fail(
      1,
      `nothing to ${verb}: ${what} changes nothing this tree does not already hold. Nothing changed.`,
    )
  }
  if (!out.merged) {
    const lines = out.conflicts.map((p) => `CONFLICT: ${v.show(p)}`)
    lines.push(`${noun} of ${what} refused: contested state no rule resolves. Nothing changed.`)
    return fail(1, lines.join('\n'))
  }
  for (const p of out.autoMerged) v.write(`Auto-merging ${v.show(p)}\n`)
  for (const p of out.conflicts) v.write(`CONFLICT (content): Merge conflict in ${v.show(p)}\n`)
  const n = out.autoMerged.length + out.conflicts.length
  v.write(
    `[${v.ws.session} ${(out.commit as string).slice(0, 7)}] ${verb} ${what} (${plural(n, 'file')})\n`,
  )
  if (out.conflicts.length > 0) {
    return fail(
      1,
      `${noun} landed with conflict markers in ${out.conflicts.length} file(s): fix them and commit (ws-git status shows them as UU).`,
    )
  }
  return
}

// ---------- worktrees and views ----------

async function worktree(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length === 0) {
    v.write(`${WORKTREE_FORMS}\n`)
    return
  }
  const sub = rest[0] as string
  const args = rest.slice(1)
  if (sub === 'add') return worktreeAdd(v, args)
  if (sub === 'list') {
    if (args.length > 0) return usage('worktree', 'worktree list takes no arguments.')
    const lines = await worktreeLines(v)
    v.write(`${(lines.length > 0 ? lines : ['(none)']).join('\n')}\n`)
    return
  }
  if (sub === 'remove') return worktreeRemove(v, args)
  return usage('worktree', `worktree takes no ${repr(sub)} (add, list, remove).`)
}

/** `session@commit` → the session and seven characters of the commit;
 *  a store tag's ref keeps its tag. */
function shortRef(ref: string): string {
  const at = ref.lastIndexOf('@')
  return at <= 0 ? ref : `${ref.slice(0, at)}@${ref.slice(at + 1, at + 8)}`
}

async function worktreeLines(v: Verb): Promise<string[]> {
  return Object.entries(v.ws.files.attachments())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([at, ref]) => `worktree ${v.show(at)}: ${shortRef(ref)} (read-only)`)
}

async function worktreeAdd(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length !== 2 || rest.some((a) => a.startsWith('-'))) {
    return usage(
      'worktree',
      'worktree add takes a directory and a session (ws-git branch lists them) or a store tag.',
    )
  }
  const [where, ref] = rest as [string, string]
  const point = v.abspath(where)
  const at = ref.lastIndexOf('@')
  const session = at > 0 ? ref.slice(0, at) : ref
  if (session === v.ws.session) {
    return fail(
      1,
      `cannot add a worktree of ${repr(session)}: a worktree reads another session, and this one is already your own tree.`,
    )
  }
  // What is being read first: a name nothing holds is the answer.
  let wanted: string
  if (at > 0) wanted = `${session}@${await v.refCommit(session, ref.slice(at + 1))}`
  else if (await v.isSession(ref)) wanted = `${ref}@${await v.repo.branches.get(ref)}`
  else {
    if ((await v.storeTag(ref)) === null) throw new Refusal(v.noSuchRef(ref))
    wanted = ref
  }
  const held = v.ws.files.attachments()
  if (point in held) {
    return fail(
      1,
      `there is already a worktree at ${repr(where)}: it is pinned at a commit, so seeing newer work means taking it down and putting it up again (ws-git worktree remove ${where}).`,
    )
  }
  for (const h of Object.keys(held).sort()) {
    if (point.startsWith(`${h}/`)) {
      return fail(
        1,
        `cannot add a worktree at ${repr(where)}: that is inside the worktree ${v.show(h)}.`,
      )
    }
  }
  const fs = v.ws.files.fs
  if (await fs.exists(point)) {
    let reason: string | null = null
    if (!(await fs.isDir(point))) reason = 'a file is already there'
    else if ((await fs.list(point)).length > 0) {
      reason = 'that directory is not empty (a worktree needs a new or empty one)'
    }
    if (reason !== null) return fail(1, `cannot add a worktree at ${repr(where)}: ${reason}.`)
  }
  const landed = await v.ws.files.attach(wanted, point)
  v.write(`worktree ${v.show(point)}: ${shortRef(landed)} (read-only)\n`)
  return
}

async function worktreeRemove(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length !== 1 || (rest[0] as string).startsWith('-')) {
    return usage('worktree', 'worktree remove takes one directory.')
  }
  const where = rest[0] as string
  const point = v.abspath(where)
  const held = Object.keys(v.ws.files.attachments()).sort()
  if (!held.includes(point)) {
    const known = held.map((p) => v.show(p)).join(', ')
    return usage(
      'worktree',
      `no worktree at ${repr(where)} (${held.length > 0 ? `worktrees here: ${known}` : 'no worktrees here'}).`,
    )
  }
  await v.ws.files.detach(point)
  return
}

async function sparseCheckout(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length > 0 && rest[0] !== 'list') {
    return usage(
      'sparse-checkout',
      `sparse-checkout takes no ${repr(rest[0] as string)} (list is all there is): a view is given when the session is forked (ws-git branch <name> --paths <paths>) and cannot be changed here.`,
    )
  }
  if (rest.length > 1) return usage('sparse-checkout', 'sparse-checkout list takes no arguments.')
  const seed = await v.seedPaths()
  v.write(`${(seed.length > 0 ? seed : ['(full)']).join('\n')}\n`)
  return
}

// ---------- show ----------

async function showVerb(v: Verb, rest: string[]): Promise<Out> {
  if (rest.length !== 1 || (rest[0] as string).startsWith('-')) {
    return usage(
      'show',
      'show takes one ref (a commit from ws-git log), or <ref>:<path> for one file at that state.',
    )
  }
  const word = rest[0] as string
  const colon = word.indexOf(':')
  if (colon >= 0) return showPath(v, word.slice(0, colon), word.slice(colon + 1))
  if (word.includes('@')) return showElsewhere(v, word)
  if (word !== 'HEAD' && !HASH_RE.test(word) && !(word in (await v.git.tags.list()))) {
    if (word === v.ws.session) {
      throw new Refusal(
        `${repr(word)} is this session, not a commit: ws-git show HEAD shows your last commit, and ws-git log lists the others.`,
      )
    }
    if (await v.isSession(word)) {
      throw new Refusal(
        `${repr(word)} is a session, not a commit: ws-git log ${word} lists its commits, and ws-git show ${word}@<commit> shows one.`,
      )
    }
    const tagged = await v.storeTagRef(word)
    if (tagged !== null) return showTagged(v, word, tagged)
  }
  return showCommit(v, v.git, await v.git.resolve(word), word)
}

async function showElsewhere(v: Verb, word: string): Promise<Out> {
  const at = word.lastIndexOf('@')
  const session = word.slice(0, at)
  const part = word.slice(at + 1)
  if (session.startsWith('@store/tag/')) {
    return showTagged(v, session.slice('@store/tag/'.length), await tagCommit(v, session, part))
  }
  if (session === v.ws.session) return showCommit(v, v.git, await v.git.resolve(part), word)
  const whole = await v.refCommit(session, part)
  const other = await v.other(session)
  try {
    let id: string
    try {
      id = await other.index.resolve(whole)
    } catch (e) {
      if (!(e instanceof WorldError) || e instanceof UnknownRefError) throw e
      throw new Refusal(
        `${part} is a commit on ${repr(session)} that its agent did not make (ws-git log ${session} lists the ones it did); ws-git show ${word}:<path> reads a file at it.`,
      )
    }
    return showCommit(v, other.index, id, word, ` (session: ${session})`)
  } finally {
    await other.close()
  }
}

async function tagCommit(v: Verb, session: string, part: string): Promise<string> {
  const name = session.slice('@store/tag/'.length)
  const tagged = await v.storeTag(name)
  if (tagged === null || !tagged.startsWith(part)) {
    throw new Refusal(
      `no store tag ${repr(name)} at ${part}: ws-git log ${name} shows the commit it names`,
    )
  }
  return tagged
}

async function showPath(v: Verb, ref: string, path: string): Promise<Out> {
  if (ref === '') {
    return usage(
      'show',
      'show :<path> needs a ref before the colon (HEAD:<path> for your last commit).',
    )
  }
  const id = await commitForRead(v, ref)
  const target = refPath(v, path)
  const files = await v.filesAt(id)
  const spelled = `${ref}:${path}`
  if (files.has(target)) {
    const data = files.get(target)
    let text: string | null = null
    if (data instanceof Uint8Array && !data.includes(0)) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data)
      } catch {
        text = null
      }
    }
    if (text === null) {
      const size = data instanceof Uint8Array ? `${data.length} bytes` : 'not bytes'
      v.write(`binary file ${spelled} (${size})\n`)
      return
    }
    v.write(text)
    return
  }
  const prefix = `${target.replace(/\/+$/, '')}/`
  const entries = new Set<string>()
  for (const held of files.keys()) {
    if (!held.startsWith(prefix)) continue
    const rest = held.slice(prefix.length)
    const slash = rest.indexOf('/')
    entries.add(slash < 0 ? rest : rest.slice(0, slash + 1))
  }
  if (entries.size === 0) {
    let hint = ''
    if (!ref.includes('@') && (ref === v.ws.session || (await v.isSession(ref)))) {
      hint = ` (a session reads at its last ws-git commit; ws-git log ${ref} --all lists every commit it holds)`
    }
    throw new Refusal(`path ${repr(path)} does not exist in ${repr(ref)}${hint}`)
  }
  v.write(`tree ${spelled}\n\n${[...entries].sort().join('\n')}\n`)
  return
}

async function commitForRead(v: Verb, ref: string): Promise<string> {
  if (ref === 'HEAD') return v.git.resolve('HEAD')
  if (ref.includes('@')) {
    const at = ref.lastIndexOf('@')
    const session = ref.slice(0, at)
    if (session.startsWith('@store/tag/')) return tagCommit(v, session, ref.slice(at + 1))
    return v.refCommit(session, ref.slice(at + 1))
  }
  if (HASH_RE.test(ref) || ref in (await v.git.tags.list())) return v.refCommit(v.ws.session, ref)
  if (ref === v.ws.session || (await v.isSession(ref))) {
    const head = ref === v.ws.session ? v.ws.head : await v.repo.branches.get(ref)
    return (await v.git.sourceState(ref, head)).commit
  }
  const tagged = await v.storeTagRef(ref)
  if (tagged !== null) return tagged
  throw new Refusal(v.noSuchRef(ref))
}

/** The path half of `<ref>:<path>`, from the root (as git reads
 *  `rev:path`); `./` and `../` from the cwd. */
function refPath(v: Verb, path: string): string {
  if (path === '.' || path === '..' || path.startsWith('./') || path.startsWith('../')) {
    return v.abspath(path)
  }
  const root = v.ws.root.replace(/\/+$/, '')
  if (root !== '' && (path === root || path.startsWith(`${root}/`))) return normalize(path)
  const rel = path.replace(/^\/+|\/+$/g, '')
  if (rel === '') return root === '' ? '/' : root
  return normalize(`${root}/${rel}`)
}

async function showCommit(
  v: Verb,
  git: WorkspaceIndex,
  id: string,
  spelled: string,
  decoration = '',
): Promise<Out> {
  const entry = await git.entry(id)
  if (entry === null) return fail(1, `no commit ${repr(spelled)} here`)
  // Measured from the state it was composed on, as revert and
  // cherry-pick measure it: a fork's first commit has no parent in the
  // agent's graph, and its change is from the fork's base.
  const parent = await changeBase(v.ws.store, entry)
  const files = entry.info?.files
  const after = await git.filesAt(id)
  const before = await git.filesAt(parent)
  const want = Array.isArray(files)
    ? new Set(files.filter((f): f is string => typeof f === 'string'))
    : new Set([...after.keys(), ...before.keys()])
  const lines = [`commit ${entry.hash}${decoration}`]
  const message = entry.info?.message
  if (typeof message === 'string' && message !== '') lines.push('', `    ${message}`)
  lines.push('')
  v.write(`${lines.join('\n')}\n`)
  const body = renderDiff(v, [...want].sort(), before, after)
  if (body.length > 0) v.write(`${body.join('\n')}\n`)
  return
}

async function showTagged(v: Verb, name: string, id: string): Promise<Out> {
  const blob = parseBlob(await (await v.repo.snapshot({ commit: id })).get(GIT_KEY))
  const head = blob.head ?? id
  const entry = await v.repo.getCommit(head)
  const base = await changeBase(v.ws.store, entry)
  const after = await v.filesAt(entry.hash)
  const before = await v.filesAt(base)
  const lines = [`commit ${entry.hash} (tag: ${name})`]
  const message = entry.info?.message
  if (typeof message === 'string' && message !== '') lines.push('', `    ${message}`)
  lines.push('')
  v.write(`${lines.join('\n')}\n`)
  const changed = base !== null ? await v.diffPaths(base, entry.hash) : [...after.keys()]
  const body = renderDiff(v, changed.sort(), before, after)
  if (body.length > 0) v.write(`${body.join('\n')}\n`)
  const tail = (await v.diffPaths(entry.hash, id)).sort()
  if (tail.length > 0) {
    const rest = renderDiff(v, tail, after, await v.filesAt(id))
    if (rest.length > 0) {
      v.write('changes at the tag after its last ws-git commit:\n')
      v.write(`${rest.join('\n')}\n`)
    }
  }
  return
}

// ---------- diff ----------

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return enc.encode(value)
  return null
}

/** Unified diff lines for these paths between two trees; ignored paths
 *  aren't shown. */
function renderDiff(
  v: Verb,
  paths: readonly string[],
  before: ReadonlyMap<string, unknown>,
  after: ReadonlyMap<string, unknown>,
): string[] {
  const out: string[] = []
  for (const path of paths) {
    if (v.ignores(path)) continue
    const shown = v.show(path)
    const a = before.has(path) ? bytesOf(before.get(path)) : new Uint8Array()
    const b = after.has(path) ? bytesOf(after.get(path)) : new Uint8Array()
    if (a === null || b === null || a.includes(0) || b.includes(0)) {
      out.push(`Binary files a/${shown} and b/${shown} differ`)
      continue
    }
    if (a.length === b.length && a.every((x, i) => x === b[i])) continue
    out.push(`diff --git a/${shown} b/${shown}`)
    out.push(...unifiedWithNewlineMarkers(dec.decode(a), dec.decode(b), shown))
  }
  return out
}

/** difflib's unified diff with git's end-of-file newline markers. */
function unifiedWithNewlineMarkers(before: string, after: string, shown: string): string[] {
  const lines: string[] = []
  const chunks = unifiedDiff(
    splitLinesKeepEnds(before),
    splitLinesKeepEnds(after),
    `a/${shown}`,
    `b/${shown}`,
  )
  for (const chunk of chunks) {
    const ended = chunk.endsWith('\n')
    const body = ended ? chunk.slice(0, -1) : chunk
    lines.push(body)
    if (
      !ended &&
      ['-', '+', ' '].includes(body.slice(0, 1)) &&
      !['---', '+++'].includes(body.slice(0, 3))
    ) {
      lines.push('\\ No newline at end of file')
    }
  }
  return lines
}

const underAny = (path: string, pathspec: readonly string[]) =>
  pathspec.some((p) => path === p || path.startsWith(`${p}/`))

async function namesAPath(v: Verb, path: string): Promise<boolean> {
  const live = await v.git.workingFiles()
  if (live.has(path)) return true
  if ((await v.git.headFiles()).has(path)) return true
  try {
    return await v.ws.files.fs.isDir(path)
  } catch {
    return false
  }
}

async function diff(v: Verb, rest: string[]): Promise<Out> {
  let cached = false
  let check = false
  let stat = false
  let words: string[] = []
  let after: string[] | null = null
  for (const flag of rest) {
    if (after !== null) after.push(flag)
    else if (flag === '--') after = []
    else if (flag === '--cached') cached = true
    else if (flag === '--check') check = true
    else if (flag === '--stat') stat = true
    else if (flag.startsWith('-')) return usage('diff', `diff takes no ${repr(flag)}.`)
    else words.push(flag)
  }
  if (after !== null) {
    if (words.length > 1) return usage('diff', 'diff takes one ref before --.')
    const ref = words[0] ?? null
    words = after
    if (ref !== null) {
      const tagged = await v.storeTagRef(ref)
      if (tagged === null && !(await v.isSession(ref))) {
        return usage(
          'diff',
          `diff ${ref} -- <paths>: ${repr(ref)} is not a session or a store tag.`,
        )
      }
      if (cached || check) {
        return usage(
          'diff',
          'diff <session> takes no --cached or --check: those read your own composition.',
        )
      }
      return diffBranch(
        v,
        ref,
        tagged,
        words.map((w) => v.abspath(w)),
        stat,
      )
    }
  }
  const paths = words.map((w) => v.abspath(w))
  if (words.length > 0 && !(await namesAPath(v, paths[0] as string))) {
    const tagged = await v.storeTagRef(words[0] as string)
    if (tagged !== null || (await v.isSession(words[0] as string))) {
      if (cached || check) {
        return usage(
          'diff',
          'diff <session> takes no --cached or --check: those read your own composition.',
        )
      }
      return diffBranch(v, words[0] as string, tagged, paths.slice(1), stat)
    }
  }
  for (const [i, path] of paths.entries()) {
    if (!(await namesAPath(v, path))) {
      return fail(
        1,
        `ambiguous argument ${repr(words[i] as string)}: unknown session, store tag or path. ws-git branch lists the sessions; a pathspec has to name something in your tree.`,
      )
    }
  }
  const st = await v.git.status()
  if (check) return diffCheck(v, st, paths, cached)
  let want = new Set(cached ? st.staged : st.unstaged)
  if (paths.length > 0) want = new Set([...want].filter((p) => underAny(p, paths)))
  if (want.size === 0) return
  const render = stat ? renderStat : renderDiff
  const out = render(v, [...want].sort(), await v.git.headFiles(), await v.git.workingFiles())
  if (out.length > 0) v.write(`${out.join('\n')}\n`)
  return
}

const MARKERS = ['<<<<<<< ', '=======', '>>>>>>> ']

async function diffCheck(
  v: Verb,
  st: Awaited<ReturnType<WorkspaceIndex['status']>>,
  paths: string[],
  cached: boolean,
): Promise<Out> {
  const live = await v.git.workingFiles()
  const base = new Set(cached ? st.staged : st.unstaged)
  let want = [...new Set([...base, ...st.mergeUnresolved])].filter((p) => live.has(p))
  if (paths.length > 0) want = want.filter((p) => underAny(p, paths))
  const hits: string[] = []
  for (const path of want.sort()) {
    const value = bytesOf(live.get(path))
    if (value === null) continue
    const text = dec.decode(value)
    text.split('\n').forEach((line, i) => {
      if (MARKERS.some((m) => line.startsWith(m))) {
        hits.push(`${v.show(path)}:${i + 1}: leftover conflict marker`)
      }
    })
  }
  if (hits.length > 0) {
    v.write(`${hits.join('\n')}\n`)
    return fail(2)
  }
  return
}

async function diffBranch(
  v: Verb,
  name: string,
  tagged: string | null,
  paths: string[],
  stat: boolean,
): Promise<Out> {
  const repo = v.repo
  const theirHead = tagged === null ? await repo.branches.get(name) : null
  const theirs = tagged ?? (await v.git.sourceState(name, theirHead as string)).commit
  const ours = (await v.git.head()) ?? v.ws.head
  let base: string | null = null
  let unrelated = false
  let began: string | null = null
  if (tagged === null) {
    base = await repo.mergeBase(ours, theirs)
    unrelated = base === null
    began = await beganElsewhere(v, name, theirHead as string, base)
  }
  let changed: string[]
  let startFiles: Map<string, unknown>
  let seed: readonly string[]
  let here: Set<string>
  let header: string
  let bothLabel: string
  let bothNote: string
  const seedOf = async (commit: string) =>
    parseView(await (await repo.snapshot({ commit })).get(VIEW_KEY))?.seed ?? []
  if (began !== null) {
    changed = v.dropIgnored(await v.diffPaths(began, theirs)).sort()
    startFiles = await v.filesAt(began)
    seed = await seedOf(theirs)
    here = new Set(
      v.dropIgnored(base !== null ? await v.diffPaths(base, ours) : (await v.filesAt(ours)).keys()),
    )
    const brought = new Set(
      v.dropIgnored(
        base !== null ? await v.diffPaths(base, began) : (await v.filesAt(began)).keys(),
      ),
    )
    for (const p of changed) brought.delete(p)
    const besides =
      brought.size > 0
        ? `would also bring ${brought.size} other path(s) from that state`
        : 'brings these and nothing else'
    header = `# what ${name} changed since it began at ${began.slice(0, 7)}, a state this session's history does not hold: \`ws-git merge ${name}\` ${besides}, and \`ws-git checkout ${name} -- <paths>\` takes only these`
    bothLabel = base !== null ? '# also changed here' : '# also here'
    bothNote = '(a checkout of it replaces yours; a merge combines both sides, or marks a conflict)'
  } else if (unrelated) {
    changed = v.dropIgnored((await v.filesAt(theirs)).keys()).sort()
    startFiles = new Map()
    seed = await seedOf(theirs)
    here = new Set(v.dropIgnored((await v.filesAt(ours)).keys()))
    header = `# ${name} shares no history with this session: all it holds is what \`ws-git merge ${name}\` brings`
    bothLabel = '# also here'
    bothNote = '(the merge combines both sides, or marks a conflict)'
  } else {
    const start = base ?? ours
    changed = v.dropIgnored(await v.diffPaths(start, theirs)).sort()
    startFiles = await v.filesAt(start)
    seed = await seedOf(theirs)
    here = new Set(base !== null ? v.dropIgnored(await v.diffPaths(base, ours)) : [])
    header =
      base !== null
        ? `# what ${name} changed since ${base.slice(0, 7)}, where the two last met: what \`ws-git merge ${name}\` brings`
        : ''
    bothLabel = '# also changed here since then'
    bothNote = '(the merge combines both sides, or marks a conflict)'
  }
  if (paths.length > 0) changed = changed.filter((p) => underAny(p, paths))
  if (changed.length === 0) return
  const lines: string[] = []
  if (header !== '') {
    lines.push(header)
    const both = changed.filter((p) => here.has(p))
    if (both.length > 0)
      lines.push(`${bothLabel}: ${both.map((p) => v.show(p)).join(', ')} ${bothNote}`)
  }
  const after = await v.filesAt(theirs)
  const render = stat ? renderStat : renderDiff
  if (seed.length === 0) lines.push(...render(v, changed, startFiles, after))
  else {
    const seeded = (p: string) => seed.some((e) => p === e || p.startsWith(`${e}/`))
    for (const [label, group] of [
      [`in ${name}'s seed`, changed.filter(seeded)],
      ['elsewhere', changed.filter((p) => !seeded(p))],
    ] as const) {
      if (group.length === 0) continue
      lines.push(`# ${group.length} path(s) ${label}`)
      lines.push(...render(v, group, startFiles, after))
    }
  }
  if (lines.length > 0) v.write(`${lines.join('\n')}\n`)
  return
}

/** Where session `name` began, when that is a state this session's
 *  history doesn't hold; else null. */
async function beganElsewhere(
  v: Verb,
  name: string,
  theirHead: string,
  met: string | null,
): Promise<string | null> {
  const began = (await v.git.sourceState(name, theirHead)).began
  if (began === null) return null
  if (met === null) return began
  if (began === met || (await v.repo.mergeBase(met, began)) !== met) return null
  if (v.dropIgnored(await v.diffPaths(met, began)).length === 0) return null
  return began
}

/** Python's `round`: halves to even. */
function pyRound(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

/** git's `--stat`. */
function renderStat(
  v: Verb,
  paths: readonly string[],
  before: ReadonlyMap<string, unknown>,
  after: ReadonlyMap<string, unknown>,
): string[] {
  const rows: [string, number, number, boolean][] = []
  for (const path of paths) {
    if (v.ignores(path)) continue
    const a = before.get(path)
    const b = after.get(path)
    let ta: string
    let tb: string
    try {
      const strict = new TextDecoder('utf-8', { fatal: true })
      ta = a === undefined ? '' : strict.decode(bytesOf(a) ?? undefined)
      tb = b === undefined ? '' : strict.decode(bytesOf(b) ?? undefined)
      if ((a !== undefined && bytesOf(a) === null) || (b !== undefined && bytesOf(b) === null)) {
        throw new Error('not bytes')
      }
    } catch {
      rows.push([v.show(path), 0, 0, true])
      continue
    }
    let plus = 0
    let minus = 0
    for (const line of unifiedDiff(splitLinesKeepEnds(ta), splitLinesKeepEnds(tb), '', '')) {
      if (line.startsWith('+') && !line.startsWith('+++')) plus += 1
      else if (line.startsWith('-') && !line.startsWith('---')) minus += 1
    }
    rows.push([v.show(path), plus, minus, false])
  }
  if (rows.length === 0) return []
  const width = Math.max(...rows.map((r) => r[0].length))
  const most = Math.max(0, ...rows.map((r) => r[1] + r[2]))
  const scale = most > 0 ? Math.min(1, 40 / most) : 1
  const out: string[] = []
  for (const [shown, plus, minus, binary] of rows) {
    if (binary) {
      out.push(` ${shown.padEnd(width)} | Bin`)
      continue
    }
    const bar = '+'.repeat(pyRound(plus * scale)) + '-'.repeat(pyRound(minus * scale))
    out.push(` ${shown.padEnd(width)} | ${plus + minus} ${bar}`.trimEnd())
  }
  const ins = rows.reduce((n, r) => n + r[1], 0)
  const dels = rows.reduce((n, r) => n + r[2], 0)
  out.push(
    ` ${rows.length} file${rows.length !== 1 ? 's' : ''} changed, ${ins} insertion${ins !== 1 ? 's' : ''}(+), ${dels} deletion${dels !== 1 ? 's' : ''}(-)`,
  )
  return out
}

// ---------- log ----------

async function log(v: Verb, rest: string[]): Promise<Out> {
  let limit: number | null = null
  let session: string | null = null
  let needle: string | null = null
  let every = false
  const args = [...rest]
  while (args.length > 0) {
    const flag = args.shift() as string
    if (
      (flag === '-n' || flag === '--max-count') &&
      args.length > 0 &&
      /^\d+$/.test(args[0] as string)
    ) {
      limit = Number(args.shift())
    } else if (flag.startsWith('-') && /^\d+$/.test(flag.slice(1))) limit = Number(flag.slice(1))
    else if (flag === '--oneline') {
      // git's name for the format this already prints
    } else if (flag === '-S' && args.length > 0) needle = args.shift() as string
    else if (flag === '--all') every = true
    else if (!flag.startsWith('-') && session === null) session = flag
    else {
      return usage(
        'log',
        `log takes no ${repr(flag)} (try: -n N, -N, --oneline, --all, -S <string>).`,
      )
    }
  }
  if (session !== null && session !== v.ws.session) {
    const other = await v.other(session)
    try {
      return await logOut(v, other.index, limit, every, needle, session)
    } finally {
      await other.close()
    }
  }
  return logOut(v, v.git, limit, every, needle, null)
}

/** `(commit, its parent)` newest first: the agent's graph (a fork's
 *  first commit measured from its base, as show measures it), or with
 *  `every` the session's own line. */
async function walk(
  v: Verb,
  git: WorkspaceIndex,
  every: boolean,
): Promise<[Commit, string | null][]> {
  if (every) return (await git.history()).map((c) => [c, c.parents[0] ?? null])
  const out: [Commit, string | null][] = []
  for (const c of await git.log()) out.push([c, await changeBase(v.ws.store, c)])
  return out
}

async function logOut(
  v: Verb,
  git: WorkspaceIndex,
  limit: number | null,
  every: boolean,
  needle: string | null,
  named: string | null,
): Promise<Out> {
  const steps = await walk(v, git, every)
  const tags = byCommit(await git.tags.list())
  const capped = <T>(list: T[]): T[] =>
    limit !== null && limit <= 0 ? [] : limit === null ? list : list.slice(0, limit)
  if (needle === null) {
    const entries = capped(steps).map(([c]) => c)
    if (entries.length === 0 && !every && (limit === null || limit > 0)) {
      if ((await walk(v, git, true)).length > 0) {
        const where = named !== null ? `in ${named}` : 'in this session'
        const spelled = named !== null ? `ws-git log ${named} --all` : 'ws-git log --all'
        v.write(
          `# no ws-git commits ${where}: \`${spelled}\` lists every commit it holds, turn commits included\n`,
        )
        return
      }
    }
    logLines(v, entries, tags, null)
    return
  }
  const found: [Commit, string][] = []
  if (!(limit !== null && limit <= 0)) {
    for (const [entry, parent] of steps) {
      const sign = await pickaxe(v, entry, parent, needle)
      if (sign !== null) found.push([entry, sign])
      if (limit !== null && found.length >= limit) break
    }
  }
  logLines(
    v,
    found.map(([c]) => c),
    tags,
    new Map(found.map(([c, s]) => [c.hash, s])),
  )
  return
}

function byCommit(tags: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const [name, id] of Object.entries(tags).sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.set(id, [...(out.get(id) ?? []), name])
  }
  return out
}

/** git's pickaxe: "+" or "-" where the count of `needle` in the tree
 *  changed; null where it didn't. */
async function pickaxe(
  v: Verb,
  entry: Commit,
  parent: string | null,
  needle: string,
): Promise<string | null> {
  const after = await v.filesAt(entry.hash)
  const before = await v.filesAt(parent)
  const changed = parent === null ? [...after.keys()] : await v.diffPaths(parent, entry.hash)
  const count = (value: unknown) => {
    const raw = bytesOf(value)
    if (raw === null) return 0
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
      return text.split(needle).length - 1
    } catch {
      return 0
    }
  }
  let delta = 0
  for (const p of changed) delta += count(after.get(p)) - count(before.get(p))
  return delta === 0 ? null : delta > 0 ? '+' : '-'
}

function logLines(
  v: Verb,
  entries: readonly Commit[],
  tags: Map<string, string[]>,
  signs: Map<string, string> | null,
): void {
  const lines: string[] = []
  for (const entry of entries) {
    const info = entry.info ?? {}
    const tool = typeof info.tool === 'string' ? info.tool : '?'
    const subject = typeof info.message === 'string' && info.message !== '' ? info.message : tool
    const mark = signs !== null ? `${signs.get(entry.hash)} ` : ''
    const named = tags.get(entry.hash)
    const deco = named !== undefined ? ` (tag: ${named.join(', ')})` : ''
    let line = `${entry.hash.slice(0, 7)}${deco} ${mark}${subject}`
    if (tool === MERGE_TOOL && typeof info.source === 'string' && info.source !== '') {
      line += ` from ${info.source}`
      if (info.sizes) line += ' (sizes)'
    } else if (tool === PICK_TOOL && typeof info.pickedFrom === 'string') {
      line += ` from ${shortRef(info.pickedFrom)}`
    }
    lines.push(line)
  }
  if (lines.length > 0) v.write(`${lines.join('\n')}\n`)
}
