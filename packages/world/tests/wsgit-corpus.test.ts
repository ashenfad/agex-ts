/**
 * ws-git against nontainer's recorded output: each script in
 * tests/wsgit-corpus/ (synced by scripts/sync-corpus.mjs) replayed on a
 * fresh store, every command's stdout, stderr and exit code compared,
 * commit ids named by first appearance as the recorder names them.
 *
 * A step known to differ is listed in KNOWN with why; it must still
 * differ, so a difference that closes is noticed.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Store, type Workspace, wsGit } from '../src/index'
import { newKV } from './backends'

interface Step {
  readonly kind: 'run' | 'open' | 'write' | 'tag' | 'delete'
  readonly session: string
  readonly command?: string
  readonly stdout?: string
  readonly stderr?: string
  readonly exit_code?: number
  readonly path?: string
  readonly text?: string | null
  readonly data?: string | null
  readonly name?: string
  readonly root?: string | null
  readonly ignore?: readonly string[]
}

interface Script {
  readonly name: string
  readonly summary: string
  readonly steps: readonly Step[]
}

/** Steps known to differ from nontainer's, `script#step` → why. */
const KNOWN: Readonly<Record<string, string>> = {
  'a-narrowed-branch#11':
    "nontainer's hint names its Python spelling (paths=None); the world's says to leave paths out",
}

const dir = new URL('./wsgit-corpus/', import.meta.url)
const scripts: Script[] = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Script)

/** A commit id as ws-git prints one, whole or short: one pattern, so a
 *  text is named left to right. */
const ID = /(?<![0-9a-f])(?:[0-9a-f]{40}|[0-9a-f]{7})(?![0-9a-f])/g
const NAMED = /<c(\d+)(\*?)>/g

/** Commit ids ↔ `<cN>`, numbered by first appearance, as the recorder
 *  numbers them. */
class Names {
  readonly known = new Set<string>()
  readonly ids: string[] = []
  readonly #number = new Map<string, number>()

  async learn(store: Store): Promise<void> {
    const repo = store.repo
    for (const branch of await repo.branches.list()) {
      for await (const c of repo.log({ branch })) this.known.add(c.hash)
    }
    for (const name of await repo.tags.list()) this.known.add(await repo.tags.get(name))
  }

  #name(commit: string): number {
    let n = this.#number.get(commit)
    if (n === undefined) {
      this.ids.push(commit)
      n = this.ids.length
      this.#number.set(commit, n)
    }
    return n
  }

  hide(text: string): string {
    return text.replace(ID, (w) => {
      if (w.length === 40) return this.known.has(w) ? `<c${this.#name(w)}*>` : w
      const found = [...this.known].filter((c) => c.startsWith(w))
      return found.length === 1 ? `<c${this.#name(found[0] as string)}>` : w
    })
  }

  fill(command: string): string {
    return command.replace(NAMED, (_, n: string, whole: string) => {
      const commit = this.ids[Number(n) - 1]
      if (commit === undefined) throw new Error(`<c${n}> is used before the output showed it`)
      return whole === '*' ? commit : commit.slice(0, 7)
    })
  }
}

/** Replay a script; the steps whose output differs, with both. */
async function replay(script: Script): Promise<Map<string, string>> {
  const store = await Store.open(await newKV())
  const sessions = new Map<string, Workspace>()
  const names = new Names()
  const session = async (
    name: string,
    opts: { root?: string; ignore?: readonly string[] } = {},
  ) => {
    let ws = sessions.get(name)
    if (ws === undefined) {
      ws = await store.open(name, {
        ...(opts.root !== undefined && { root: opts.root }),
        ...(opts.ignore !== undefined && { ignore: opts.ignore }),
        profile: { commands: { 'ws-git': wsGit } },
      })
      sessions.set(name, ws)
    }
    return ws
  }
  const differs = new Map<string, string>()
  try {
    for (const [i, step] of script.steps.entries()) {
      if (step.kind === 'run') {
        const ws = await session(step.session)
        const out = await ws.terminal(names.fill(step.command as string))
        await names.learn(store)
        const got = {
          stdout: names.hide(out.stdout),
          stderr: names.hide(out.stderr),
          exit_code: out.exitCode,
        }
        const want = { stdout: step.stdout, stderr: step.stderr, exit_code: step.exit_code }
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          differs.set(
            `${script.name}#${i}`,
            `[${script.name}#${i}] $ ${step.command}\nwant ${JSON.stringify(want)}\ngot  ${JSON.stringify(got)}`,
          )
        }
      } else if (step.kind === 'open') {
        await session(step.session, {
          ...(step.root != null && { root: step.root }),
          ...(step.ignore !== undefined && step.ignore.length > 0 && { ignore: step.ignore }),
        })
        await names.learn(store)
      } else if (step.kind === 'write') {
        const ws = await session(step.session)
        const content =
          step.data != null
            ? Uint8Array.from(atob(step.data), (c) => c.charCodeAt(0))
            : new TextEncoder().encode(step.text ?? '')
        await ws.files.write(step.path as string, content)
        await names.learn(store)
      } else if (step.kind === 'tag') {
        await store.tags.add(await session(step.session), step.name as string)
        await names.learn(store)
      } else {
        await sessions.get(step.session)?.close()
        sessions.delete(step.session)
        await store.delete(step.session, { minAge: 0 })
      }
    }
  } finally {
    for (const ws of sessions.values()) await ws.close()
  }
  return differs
}

describe("ws-git against nontainer's recorded output", () => {
  it('has the corpus', () => {
    expect(scripts.length).toBeGreaterThan(30)
  })

  for (const script of scripts) {
    it(script.name, async () => {
      const differs = await replay(script)
      if (process.env.WSGIT_CORPUS_PRINT !== undefined) {
        for (const d of differs.values()) console.log(`${d}\n`)
      }
      const known = Object.keys(KNOWN).filter((k) => k.startsWith(`${script.name}#`))
      const unexpected = [...differs].filter(([k]) => !known.includes(k)).map(([, d]) => d)
      expect(unexpected).toEqual([])
      expect(known.filter((k) => !differs.has(k))).toEqual([])
    })
  }
})
