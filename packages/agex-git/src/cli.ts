/**
 * Termish-ts adapter for {@link VirtualGit}.
 *
 * Translates `git <subcommand>` from a termish `CommandContext` into
 * method calls on a `VirtualGit` instance and formats the result
 * back to `stdout`. Argument parsing, error translation, and output
 * formatting live here; semantics live in `core.ts`.
 *
 * Public surface:
 * - {@link registerGit} — wire the skill + git terminal command onto
 *   an `Agent`. The common path; one call per agent.
 * - {@link makeGitHandler} — build a termish-compatible handler
 *   directly from a `Staged`. Used by tests and external callers
 *   that want to drive the git surface without going through
 *   `Agent`.
 */

import { TerminalError } from '@agex-ts/termish'
import { KvgitFS } from '@agex-ts/termish/fs/kvgit'
import type { Agent, TerminalCommandHandler } from 'agex-ts'
import { FileNotFoundError, VirtualGit } from './core'
import { isBinary } from './diff'
import { AgentGitError } from './errors'
import { InvalidRef } from './refs'
import { GIT_SKILL_MD } from './skill'

// `CommandContext` shape we receive from @agex-ts/termish via the agent's
// dispatcher. `TerminalCommandHandler` is the agex-ts shape; both
// are structurally compatible (`agex-ts` casts through `unknown`).
type GitCommandContext = Parameters<TerminalCommandHandler>[0]

/**
 * Register the git skill + the `git` terminal command on an agent.
 *
 * Mounts the git usage guide at `/skills/git/SKILL.md` for discovery
 * via `cat /skills/git/SKILL.md`, and registers the `git` terminal
 * command so the agent can run git operations inside
 * `terminal_action` pipelines.
 *
 * Idempotent in spirit but not in practice — calling twice on the
 * same agent throws a `RegistrationError` from the underlying
 * `agent.terminal` / `agent.skill` calls. Call once during agent
 * setup.
 */
export function registerGit(agent: Agent): void {
  agent.skill(GIT_SKILL_MD, { name: 'git' })
  agent.terminal(makeGitHandler, {
    name: 'git',
    description:
      "Git-style commit / branch / diff / merge operations on the agent's VFS. " +
      'Run `git` with no args for usage; see /skills/git/SKILL.md for details.',
  })
}

/**
 * Termish-compatible handler implementing the git CLI. Used as the
 * `agent.terminal(...)` registration directly; can also be invoked
 * through `@agex-ts/termish`'s `execute(...)` outside an agent (tests, ad-
 * hoc tooling).
 *
 * Requires `ctx.fs` to be a {@link KvgitFS} (the substrate `VirtualGit`
 * needs lives behind `KvgitFS.staged`). Errors out cleanly with a
 * `TerminalError` for non-kvgit filesystems so the agent sees a
 * descriptive message rather than a stack trace.
 */
export const makeGitHandler: TerminalCommandHandler = async (ctx) => {
  if (!(ctx.fs instanceof KvgitFS)) {
    throw new TerminalError(
      'git: requires a kvgit-backed VFS — pass `{ fs: { type: "kvgit" } }` to createAgent.',
    )
  }
  const staged = ctx.fs.staged
  const vg = new VirtualGit(staged.versioned, staged, { cwd: () => ctx.fs.getcwd() })
  await dispatch(ctx, vg)
}

const SUBCOMMANDS: Record<
  string,
  (args: string[], ctx: GitCommandContext, vg: VirtualGit) => Promise<void>
> = {
  log: gitLog,
  diff: gitDiff,
  status: gitStatus,
  branch: gitBranch,
  checkout: gitCheckout,
  commit: gitCommit,
  reset: gitReset,
  show: gitShow,
  merge: gitMerge,
  add: gitAdd,
  rm: gitRm,
}

async function dispatch(ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  const args = [...ctx.args]
  if (args.length === 0) {
    ctx.stdout.write(usage())
    return
  }
  const subcommand = args[0] as string
  const subargs = args.slice(1)
  const fn = SUBCOMMANDS[subcommand]
  if (fn === undefined) {
    throw new TerminalError(`git: '${subcommand}' is not a git command.`)
  }
  await fn(subargs, ctx, vg)
}

function usage(): string {
  return (
    'usage: git <command> [<args>]\n\n' +
    'Commands:\n' +
    '   log        Show commit log\n' +
    '   diff       Show changes between commits\n' +
    '   status     Show current branch and working-tree status\n' +
    '   branch     List, create, or delete branches\n' +
    '   checkout   Switch branches\n' +
    '   commit     Record changes with a message\n' +
    '   reset      Reset HEAD to a previous commit\n' +
    '   show       Show file content at a commit\n' +
    '   merge      Merge a branch into the current branch\n' +
    '   add        Stage files for the next commit\n' +
    '   rm         Remove files from the workspace\n'
  )
}

/** Translate any agent-git error into a termish `TerminalError`,
 *  prefixed with the subcommand for context. The git handler runs
 *  in the host realm (same process as `VirtualGit`), so prototype-
 *  chain checks against `AgentGitError` / `InvalidRef` /
 *  `FileNotFoundError` are reliable here — no serialization seam
 *  between throw and catch. */
function asTerminalError(prefix: string, e: unknown): TerminalError {
  if (e instanceof AgentGitError || e instanceof InvalidRef || e instanceof FileNotFoundError) {
    return new TerminalError(`${prefix}: ${e.message}`)
  }
  if (e instanceof TerminalError) return e
  if (e instanceof Error) return new TerminalError(`${prefix}: ${e.message}`)
  // Defensive fallback for non-Error throws. Prefer a string-typed
  // `.message` if present so an `{ message: '...' }` thrown literal
  // produces a readable line instead of `[object Object]`.
  const message =
    typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string'
      ? (e as { message: string }).message
      : String(e)
  return new TerminalError(`${prefix}: ${message}`)
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function gitLog(args: string[], ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  let oneline = false
  let maxCount: number | undefined
  let pathFilter: string | undefined

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-n' || arg === '--max-count') {
      i++
      const next = args[i]
      if (next === undefined) {
        throw new TerminalError(`git log: ${arg} requires a number`)
      }
      const n = Number.parseInt(next, 10)
      if (Number.isNaN(n) || `${n}` !== next) {
        throw new TerminalError(`git log: invalid count '${next}'`)
      }
      maxCount = n
    } else if (arg.startsWith('-n') && arg.length > 2 && /^\d+$/.test(arg.slice(2))) {
      maxCount = Number.parseInt(arg.slice(2), 10)
    } else if (arg === '--oneline') {
      oneline = true
    } else if (!arg.startsWith('-') && arg !== '--') {
      pathFilter = arg
    }
  }

  let commits: Awaited<ReturnType<VirtualGit['log']>>
  try {
    commits = await vg.log({
      ...(maxCount !== undefined && { maxCount }),
      ...(pathFilter !== undefined && { path: pathFilter }),
    })
  } catch (e) {
    throw asTerminalError('git log', e)
  }

  const branch = await vg.currentBranch()
  const head = await vg.head()

  for (const c of commits) {
    if (oneline) {
      const headMarker = c.hash === head ? ` (HEAD -> ${branch})` : ''
      ctx.stdout.write(`${c.shortHash}${headMarker} ${c.message}\n`)
    } else {
      ctx.stdout.write(`commit ${c.hash}\n`)
      if (c.hash === head) ctx.stdout.write(`  (HEAD -> ${branch})\n`)
      ctx.stdout.write(`\n    ${c.message}\n\n`)
    }
  }
}

async function gitDiff(args: string[], ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  const refs: string[] = []
  let pathFilter: string | undefined
  let pastSeparator = false
  for (const arg of args) {
    if (arg === '--') {
      pastSeparator = true
    } else if (pastSeparator) {
      pathFilter = arg
    } else if (!arg.startsWith('-')) {
      refs.push(arg)
    }
  }
  if (refs.length > 2) throw new TerminalError('git diff: too many arguments')

  let output: string
  try {
    if (refs.length === 0) {
      output = await vg.diff({ ...(pathFilter !== undefined && { path: pathFilter }) })
    } else if (refs.length === 1) {
      const a = await vg.resolveRef(refs[0] as string)
      output = await vg.diff({ a, b: null, ...(pathFilter !== undefined && { path: pathFilter }) })
    } else {
      const a = await vg.resolveRef(refs[0] as string)
      const b = await vg.resolveRef(refs[1] as string)
      output = await vg.diff({ a, b, ...(pathFilter !== undefined && { path: pathFilter }) })
    }
  } catch (e) {
    throw asTerminalError('git diff', e)
  }
  ctx.stdout.write(output)
}

async function gitStatus(_args: string[], ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  const s = await vg.status()
  ctx.stdout.write(`On branch ${s.branch}\n`)

  if (s.staged.length > 0) {
    ctx.stdout.write('\nChanges to be committed:\n')
    for (const f of s.staged) ctx.stdout.write(`  ${f}\n`)
  }

  if (s.unstaged.length > 0) {
    ctx.stdout.write('\nChanges not staged for commit:\n')
    ctx.stdout.write('  (use `git add <file>` to stage)\n')
    for (const f of s.unstaged) ctx.stdout.write(`  ${f}\n`)
  }

  if (s.isClean) {
    ctx.stdout.write('nothing to commit, working tree clean\n')
  }

  // Recent commits — best-effort; an unborn branch / corrupt store
  // should still let `git status` emit the branch header.
  let recent: Awaited<ReturnType<VirtualGit['log']>> = []
  try {
    recent = await vg.log({ maxCount: 3 })
  } catch {
    /* fall through with empty list */
  }
  if (recent.length > 0) {
    ctx.stdout.write('\nRecent commits:\n')
    for (const c of recent) ctx.stdout.write(`  ${c.shortHash} ${c.message}\n`)
  }
}

async function gitBranch(args: string[], ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  if (args.length === 0) {
    const current = await vg.currentBranch()
    for (const b of await vg.listBranches()) {
      const marker = b === current ? '* ' : '  '
      ctx.stdout.write(`${marker}${b}\n`)
    }
    return
  }

  if (args[0] === '-d' || args[0] === '-D') {
    const force = args[0] === '-D'
    const name = args[1]
    if (name === undefined) {
      throw new TerminalError('git branch: branch name required')
    }
    try {
      await vg.deleteBranch(name, { force })
    } catch (e) {
      throw asTerminalError('git branch', e)
    }
    ctx.stdout.write(`Deleted branch ${name}\n`)
    return
  }

  const name = args[0] as string
  try {
    await vg.createBranch(name)
  } catch (e) {
    throw asTerminalError('git branch', e)
  }
  ctx.stdout.write(`Created branch ${name}\n`)
}

async function gitCheckout(args: string[], ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  if (args.length === 0) {
    throw new TerminalError('git checkout: branch name required')
  }
  let create = false
  let force = false
  let name: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-b') {
      create = true
      i++
      const next = args[i]
      if (next === undefined) {
        throw new TerminalError('git checkout: branch name required after -b')
      }
      name = next
    } else if (arg === '-f') {
      force = true
    } else if (!arg.startsWith('-') && name === undefined) {
      name = arg
    }
  }
  if (name === undefined) {
    throw new TerminalError('git checkout: branch name required')
  }
  try {
    await vg.checkout(name, { create, force })
  } catch (e) {
    throw asTerminalError('git checkout', e)
  }
  ctx.stdout.write(
    create ? `Switched to a new branch '${name}'\n` : `Switched to branch '${name}'\n`,
  )
}

async function gitCommit(args: string[], ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  let message: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '-m') {
      i++
      const next = args[i]
      if (next === undefined) {
        throw new TerminalError('git commit: -m requires a message')
      }
      message = next
    } else if (arg.startsWith('-m') && arg.length > 2) {
      message = arg.slice(2)
    }
  }
  if (message === undefined || message.length === 0) {
    throw new TerminalError("git commit: please supply a message with -m 'your message'")
  }
  let c: Awaited<ReturnType<VirtualGit['commit']>>
  try {
    c = await vg.commit(message)
  } catch (e) {
    throw asTerminalError('git commit', e)
  }
  const branch = c.virtualBranch ?? (await vg.currentBranch())
  ctx.stdout.write(`[${branch} ${c.shortHash}] ${c.message}\n`)
}

async function gitReset(args: string[], ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  const hard = args.includes('--hard')
  const refs = args.filter((a) => !a.startsWith('-'))
  if (!hard) throw new TerminalError('git reset: only --hard is supported')
  if (refs.length === 0) throw new TerminalError('git reset: need a ref (e.g. HEAD~1)')

  let target: string
  try {
    target = await vg.resolveRef(refs[0] as string)
    await vg.reset(target, { hard: true })
  } catch (e) {
    throw asTerminalError('git reset', e)
  }
  ctx.stdout.write(`Restored files to ${target.slice(0, 7)}\n`)
}

async function gitShow(args: string[], ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  const refPath = args[0]
  if (refPath === undefined) {
    throw new TerminalError('git show: need a ref (e.g. HEAD:path/to/file)')
  }
  const colonAt = refPath.indexOf(':')
  if (colonAt === -1) {
    throw new TerminalError('git show: use <ref>:<path> format (e.g. HEAD:helpers/utils.ts)')
  }
  const ref = refPath.slice(0, colonAt)
  const path = refPath.slice(colonAt + 1)

  let content: Uint8Array
  try {
    const commitHash = await vg.resolveRef(ref.length > 0 ? ref : 'HEAD')
    content = await vg.show(commitHash, path)
  } catch (e) {
    throw asTerminalError('git show', e)
  }
  if (isBinary(content)) {
    ctx.stdout.write(`(binary file: ${path}, ${content.byteLength} bytes)\n`)
  } else {
    ctx.stdout.write(new TextDecoder('utf-8', { fatal: false }).decode(content))
  }
}

async function gitMerge(args: string[], ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  const source = args[0]
  if (source === undefined) {
    throw new TerminalError('git merge: branch name required')
  }
  let result: Awaited<ReturnType<VirtualGit['merge']>>
  try {
    result = await vg.merge(source)
  } catch (e) {
    throw asTerminalError('git merge', e)
  }
  if (result === null) {
    ctx.stdout.write('Already up to date.\n')
    return
  }
  ctx.stdout.write(`Merge made: ${result.shortHash} ${result.message}\n`)
}

async function gitAdd(args: string[], _ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  if (args.length === 0) throw new TerminalError('git add: nothing specified')
  try {
    await vg.add(args)
  } catch (e) {
    throw asTerminalError('git add', e)
  }
}

async function gitRm(args: string[], ctx: GitCommandContext, vg: VirtualGit): Promise<void> {
  if (args.length === 0) throw new TerminalError('git rm: nothing specified')
  const recursive = args.includes('-r')
  const paths = args.filter((a) => !a.startsWith('-'))
  if (paths.length === 0) throw new TerminalError('git rm: nothing specified')

  // Track per-path so we echo `rm 'name'` lines like real git, even
  // when one path in a multi-path call fails partway through.
  const emitted: string[] = []
  try {
    for (const path of paths) {
      await vg.rm([path], { recursive })
      emitted.push(path)
    }
  } catch (e) {
    throw asTerminalError('git rm', e)
  }
  for (const name of [...emitted].sort()) ctx.stdout.write(`rm '${name}'\n`)
}
