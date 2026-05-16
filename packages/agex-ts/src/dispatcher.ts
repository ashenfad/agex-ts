/**
 * Per-emission dispatchers used by the task action loop.
 *
 * Each function handles one variant:
 *   - `dispatchFileWrite`  → write/append the content into the agent's
 *                            session VFS
 *   - `dispatchFileEdit`   → search/replace inside an existing file in
 *                            the VFS, honoring `matchAll`
 *   - `dispatchTerminal`   → run the commands string through termish-ts,
 *                            with the agent's registered terminal handlers
 *                            merged on top of termish-ts's builtins
 *
 * `dispatchTs` lives in `task.ts` because it threads through the
 * runtime adapter and produces the `TaskOutcome` that drives the loop.
 *
 * Errors thrown by a dispatcher surface as runtime failures — the
 * action loop converts them into a `FailEvent` so the task doesn't
 * silently spin on broken emissions.
 */

import type { CommandHandler } from 'termish-ts'
import { execute } from 'termish-ts'
import type { FileEditEmission, FileWriteEmission, Policy, VirtualFileSystem } from './types'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

export async function dispatchFileWrite(
  emission: FileWriteEmission,
  fs: VirtualFileSystem,
): Promise<void> {
  // Auto-create the parent directory (mkdir -p semantics). The
  // primer points the agent at /helpers/ for reusable code, so it
  // routinely writes the first file under a directory that doesn't
  // exist yet — making the agent run an explicit `mkdir` first
  // would be busywork.
  await ensureParentDir(emission.path, fs)
  const bytes = encoder.encode(emission.content)
  const mode = emission.mode === 'append' ? 'a' : 'w'
  await fs.write(emission.path, bytes, mode)
}

async function ensureParentDir(path: string, fs: VirtualFileSystem): Promise<void> {
  const slash = path.lastIndexOf('/')
  if (slash <= 0) return // root-level file; nothing to create
  const parent = path.slice(0, slash)
  await fs.mkdir(parent, { parents: true, existOk: true })
}

export async function dispatchFileEdit(
  emission: FileEditEmission,
  fs: VirtualFileSystem,
): Promise<void> {
  if (!(await fs.exists(emission.path))) {
    throw new Error(`fileEdit: ${emission.path}: no such file`)
  }
  // Don't catch here — IO / permission errors should surface unmasked.
  const existing = await fs.read(emission.path)
  const text = decoder.decode(existing)
  const search = emission.search
  if (search.length === 0) {
    throw new Error('fileEdit: empty search string')
  }
  const matchAll = emission.matchAll === true
  let next: string
  if (matchAll) {
    next = text.split(search).join(emission.content)
  } else {
    const idx = text.indexOf(search)
    if (idx === -1) {
      throw new Error(`fileEdit: ${emission.path}: search string not found`)
    }
    next = text.slice(0, idx) + emission.content + text.slice(idx + search.length)
  }
  await fs.write(emission.path, encoder.encode(next))
}

/** Default max-chars cap on terminal output handed back to the agent.
 *  A multi-MB blob (e.g. `cat` against a file with an embedded base64
 *  image) can otherwise blow the next turn's input window. ~200K chars
 *  is roughly 50K tokens — leaves room for normal source-file reads
 *  while bounding the worst case. termish-ts appends a marker pointing
 *  the agent at `head/tail/grep/sed` when it trips. */
const DEFAULT_TERMINAL_OUTPUT_CAP = 200_000

export async function dispatchTerminal(
  commands: string,
  fs: VirtualFileSystem,
  policy: Policy,
  signal: AbortSignal,
): Promise<string> {
  // Build the host-injected commands map from the policy's terminals.
  // termish-ts merges these on top of its own builtins.
  const hostCommands = new Map<string, CommandHandler>()
  for (const [name, reg] of policy.terminals) {
    // The agent's TerminalCommandHandler is shape-compatible with
    // termish-ts's CommandHandler; cast through unknown is safe.
    hostCommands.set(name, reg.handler as unknown as CommandHandler)
  }
  return execute(commands, fs, {
    commands: hostCommands,
    signal,
    maxOutputChars: DEFAULT_TERMINAL_OUTPUT_CAP,
  })
}
