/**
 * The tools' descriptions: the prompt-sized contract, after nontainer's,
 * with what this world grants (host objects, variables, secrets,
 * commands) filled in.
 */

import { DEFAULT_TIMEOUT } from '../kernel/kernel'
import { commandDescriptions } from '../profile'
import type { Workspace } from '../workspace'

const TERMINAL_CORE = `\
Run shell commands in your persistent workspace (a virtual computer with
its own filesystem). Supports pipes, redirects (> >> < 2> 2>&1),
heredocs (cmd <<EOF ... EOF), && || ;, quoting, comments, $NAME
variables, and these commands: ls, cat, echo, printf, head, tail, tee,
grep, find, sed, tr, sort, uniq, cut, wc, diff, xargs, tar, gzip, gunzip,
zcat, zip, unzip, mkdir, cp, mv, rm, touch, pwd, cd, basename, dirname,
file, test. No loops, functions or variable assignments: write those in
run_ts. cwd persists between calls.

READING AND SEARCHING FILES IS THIS TOOL'S JOB. To find something:
\`grep -n 'name' file\` (add -A/-B for context, -r to search a tree). To
see a region: \`sed -n '120,160p' file\`, or \`cat -n file\` for the whole
thing with line numbers. One call each — do NOT read a file into
run_ts and loop over its lines to search it, which costs several calls
and a lot of context to answer what grep answers in one. Line numbers
make the next file_edit far likelier to land.

Make ONE terminal call per turn: batch related commands into a single
multiline script with ; or && — mutations are then safely sequential.

There is no node, npm or npx: run TypeScript with run_ts.`

const CODE_CORE = `\
Run TypeScript in a sandboxed worker attached to the same workspace as
the terminal (shared files and cwd). The code is the body of an async
function: top-level await works, and \`return value\` shows the value.
Types are stripped, not checked (no enums or namespaces). Script
semantics per call: variables do NOT persist between calls. What does
persist:
- files: \`await fs.read(path, 'utf8')\`, \`await fs.write(path, text)\`,
  and list, exists, mkdir, remove, rename (all async), visible to the
  terminal too (but to READ or SEARCH a file, use the terminal's
  grep/sed; and to CHANGE one, use file_edit, not string surgery, which
  will silently hit the wrong occurrence)
- modules: reusable code goes in workspace files you import by path
  (\`import { summarize } from './lib/stats.ts'\`); a module imports
  others relative to itself`

export const FILE_WRITE_DESCRIPTION = `\
Write a file in the workspace (parents created, overwrites). Use this
for any multiline content — modules, pages, data — instead of shell
redirects with tricky quoting. Writing several files? Issue several
file_write calls in the same turn — that's fine.`

export const FILE_EDIT_DESCRIPTION = `\
Replace an exact string in a workspace file. old_string must match the
file EXACTLY (including whitespace) and appear exactly once — include
enough surrounding context to make it unique, or set replace_all=true
to replace every occurrence. Prefer this over sed for code edits.
Edits to DIFFERENT files may share a turn; multiple edits to the SAME
file should be sequential turns (parallel order is not guaranteed).`

export const VIEW_IMAGE_DESCRIPTION = `\
View an image file from the workspace — a rendered chart, a downloaded
figure, a screenshot. Returns the image itself, so you can see what you
produced. Supported: png, jpeg, gif, webp.`

const names = (list: readonly string[]): string => list.map((n) => `$${n}`).join(', ')

/** The terminal's description for this workspace. */
export function terminalDescription(ws: Workspace, primer?: string): string {
  const profile = ws.settings.profile
  const notes: string[] = []
  const variables = Object.keys(profile.variables ?? {}).sort()
  if (variables.length > 0) notes.push(`- variables: ${names(variables)}`)
  const secrets = Object.keys(profile.secrets ?? {}).sort()
  if (secrets.length > 0) {
    notes.push(
      `- secrets: ${names(secrets)}, usable only where a command takes them (curl's URLs and headers, for the sites each is meant for); their values never appear in the workspace`,
    )
  }
  const commands = [...commandDescriptions(profile)].sort(([a], [b]) => a.localeCompare(b))
  if (commands.length > 0) {
    notes.push(`- also: ${commands.map(([name]) => name).join(', ')}`)
    for (const [, description] of commands)
      if (description !== undefined) notes.push(`  ${description}`)
  }
  let out = TERMINAL_CORE
  if (notes.length > 0) out += `\n\nIn this workspace:\n${notes.join('\n')}`
  if (primer !== undefined && primer !== '') out += `\n\n${primer}`
  return out
}

/** The run_ts tool's description for this workspace. */
export function codeDescription(ws: Workspace, primer?: string): string {
  const profile = ws.settings.profile
  const code = profile.code ?? {}
  const notes: string[] = []
  if (ws.settings.cache) {
    notes.push(
      "- cache: a persistent store for DATA: `await cache.set('key', value)`, `await cache.get('key')`; values survive across calls and sessions",
    )
  }
  const hostObjects = Object.keys(profile.hostObjects ?? {}).sort()
  if (hostObjects.length > 0) {
    notes.push(
      `- host objects available by name: ${hostObjects.join(', ')} (live host resources; call their methods with await, do not try to construct them). In a module, import them: \`import { ${hostObjects[0]} } from 'host'\`, which also works at the top level`,
    )
  }
  const variables = Object.keys(profile.variables ?? {}).sort()
  if (variables.length > 0) {
    notes.push(`- env: configuration, e.g. env.${variables[0]} (${variables.join(', ')})`)
  }
  const secrets = Object.keys(profile.secrets ?? {}).sort()
  if (secrets.length > 0) {
    notes.push(
      `- secrets: ${secrets.join(', ')}. \`secret('${secrets[0]}')\` is a reference a host object fills at a request (http.fetch fills it in a URL or header, for the sites the secret is meant for); code never sees the value`,
    )
  }
  notes.push(
    code.resolve !== undefined
      ? "- packages: import them by name (`import * as aq from 'arquero'`); they load over the network"
      : '- packages: none beyond your own modules and URLs',
  )
  if (code.routeFetch === true) notes.push("- fetch('/path') reads workspace files")
  else if (Array.isArray(code.routeFetch) && code.routeFetch.length > 0) {
    notes.push(`- fetch('/path') reads workspace files under ${code.routeFetch.join(', ')}`)
  }
  notes.push(
    `- console.log/info print; console.warn/error go to stderr; each call stops after ${code.timeout ?? DEFAULT_TIMEOUT}s`,
  )
  let out = `${CODE_CORE}\n${notes.join('\n')}`
  if (primer !== undefined && primer !== '') out += `\n\n${primer}`
  return `${out}\n\nMake ONE call per turn; put all the code for a step in a single call.`
}

/** Instructions to give with the tools: how to pace calls, and when
 *  work is committed. */
export function toolInstructions(ws: Workspace): string {
  const commits = ws.autocommit
    ? '; every mutating call is committed'
    : '; your work is committed at the end of each turn'
  return `\
You have a persistent workspace (files, shell, and TypeScript). Make ONE
terminal / run_ts call per turn, batching related commands/code within
it — mutations are then safely sequential. file_write/file_edit are
different: you MAY issue several in one turn (they execute safely), but
keep edits to the SAME file to one per turn since parallel-call order
is not guaranteed. The workspace persists across the whole
session${commits}.`
}
