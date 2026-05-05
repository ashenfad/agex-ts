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
  const bytes = encoder.encode(emission.content)
  const mode = emission.mode === 'append' ? 'a' : 'w'
  await fs.write(emission.path, bytes, mode)
}

export async function dispatchFileEdit(
  emission: FileEditEmission,
  fs: VirtualFileSystem,
): Promise<void> {
  const existing = await fs.read(emission.path).catch(() => null)
  if (existing === null) {
    throw new Error(`fileEdit: ${emission.path}: no such file`)
  }
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
  return execute(commands, fs, { commands: hostCommands, signal })
}
