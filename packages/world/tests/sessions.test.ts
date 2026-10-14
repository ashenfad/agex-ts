/**
 * The host-side delegation helper, after nontainer's sessions tests.
 *
 * The runners here are scripted rather than a model: they open the
 * child by name, as an embedder's loop would, write files, sometimes
 * commit, and answer. What this pins is the helper's half: the name it
 * mints, the fork point it takes, the commit it makes for a delegate's
 * remainder, the paths it reports, where it forks from, and that no job
 * is lost however its run ends.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type Answer,
  type AnswerStatus,
  BranchExpiredError,
  Inbox,
  JobRunningError,
  type RunOptions,
  SEPARATOR,
  type SessionRunner,
  Sessions,
  SessionsError,
  Store,
  type Workspace,
  answerNotes,
  coercePaths,
  deliveredNote,
  petName,
  renderAnswer,
  runAction,
  sessionsTool,
  untilSettled,
  withCall,
  worldTools,
} from '../src/index'
import { newKV } from './backends'

const WORKER = new URL('../dist/worker.node.js', import.meta.url)

let store: Store
let parent: Workspace

beforeEach(async () => {
  store = await Store.open(await newKV())
  parent = await store.open('analyst')
  await parent.files.write('/workspace/report.md', '# Rates\n\nnorth 4, south 7\n')
  await parent.files.write('/workspace/main.py', "print('rates')\n")
  await parent.index.commit('seed')
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A runner that commits part of its work and leaves the rest: the
 *  delegate whose remainder is committed for it. */
const halfDone: SessionRunner = {
  async run(session) {
    const child = await store.open(session)
    await child.files.write('/workspace/report.md', 'polished\n')
    await child.index.commit('the part I finished')
    await child.files.write('/workspace/notes.md', 'wip\n')
    await child.close()
    return 'half done'
  },
}

const remainders = async (session: string) => {
  const child = await store.open(session)
  const log = await child.index.log()
  await child.close()
  return log.filter((c) => c.info?.committedFor !== undefined).length
}

/** A runner that opens the child, writes to it, and answers. */
class Scripted implements SessionRunner {
  readonly seen: { session: string; task: string; budget: unknown; forkedAt: string | null }[] = []
  constructor(
    readonly writes: Record<string, string>,
    readonly text = 'done',
    readonly opts: { commits?: boolean; status?: AnswerStatus } = {},
  ) {}

  async run(session: string, task: string, { budget, forkedAt }: RunOptions) {
    this.seen.push({ session, task, budget, forkedAt })
    const child = await store.open(session)
    try {
      for (const [path, content] of Object.entries(this.writes)) {
        await child.files.write(path, content)
      }
      if (this.opts.commits === true) await child.index.commit("the delegate's own commit")
    } finally {
      await child.close()
    }
    return this.opts.status === undefined
      ? this.text
      : { text: this.text, status: this.opts.status }
  }
}

/** A runner held until the test lets it go; it stops on its signal. */
class Held implements SessionRunner {
  readonly started: string[] = []
  readonly #release: (() => void)[] = []
  running = 0
  most = 0

  async run(session: string, task: string, { signal }: RunOptions) {
    this.started.push(session)
    this.running += 1
    this.most = Math.max(this.most, this.running)
    try {
      await new Promise<void>((resolve, reject) => {
        this.#release.push(resolve)
        signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })
      })
      return `did ${task}`
    } finally {
      this.running -= 1
    }
  }

  /** Let the oldest held run go. */
  release(): void {
    this.#release.shift()?.()
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

async function read(session: string, path: string): Promise<string> {
  const ws = await store.open(session)
  try {
    return await ws.files.readText(path)
  } finally {
    await ws.close()
  }
}

describe('names', () => {
  it('a pet name is two words', () => {
    for (let i = 0; i < 20; i++) expect(petName()).toMatch(/^[a-z]+-[a-z]+$/)
  })

  it('a child is scoped under its parent', async () => {
    const sessions = new Sessions(parent, new Scripted({}))
    const job = await sessions.ask('go')
    expect(job.name.startsWith(`analyst${SEPARATOR}`)).toBe(true)
    expect(await store.exists(job.name)).toBe(true)
    await sessions.close()
  })

  it('a minted name is suffixed past a collision', async () => {
    const sessions = new Sessions(parent, new Scripted({}))
    await sessions.ask('one', { name: 'otter' })
    // a minted name colliding: forced by asking for the same pet twice
    const real = Math.random
    Math.random = () => 0
    try {
      const a = await sessions.ask('two')
      const b = await sessions.ask('three')
      expect(a.name).toBe('analyst.amber-badger')
      expect(b.name).toBe('analyst.amber-badger.2')
    } finally {
      Math.random = real
    }
    await sessions.close()
  })

  it('a name asked for that is taken is refused, pointing at resume', async () => {
    const sessions = new Sessions(parent, new Scripted({}))
    await sessions.ask('one', { name: 'editor', wait: true })
    await expect(sessions.ask('two', { name: 'editor' })).rejects.toThrow(
      /'analyst\.editor' already exists.*resume='editor'/,
    )
    await sessions.close()
  })

  it("a name that can't be a session id is refused", async () => {
    const sessions = new Sessions(parent, new Scripted({}))
    await expect(sessions.ask('go', { name: 'a/b' })).rejects.toThrow(SessionsError)
    await sessions.close()
  })
})

describe('asking', () => {
  it('ask, then list, then result', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner)
    const job = await sessions.ask('find the rates', { name: 'scout' })
    expect(job).toMatchObject({ name: 'analyst.scout', status: 'running', ref: null })
    expect(sessions.list().map((j) => j.status)).toEqual(['running'])
    expect(() => sessions.result('scout')).toThrow(JobRunningError)
    runner.release()
    await sessions.wait()
    const answer = sessions.result('scout')
    expect(answer.text).toBe('did find the rates')
    expect(answer.branch).toBe('analyst.scout')
    expect(sessions.list()[0]?.status).toBe('answered')
    await sessions.close()
  })

  it('wait returns the answer', async () => {
    const sessions = new Sessions(parent, new Scripted({}, 'found it'))
    const answer = await sessions.ask('go', { wait: true })
    expect(answer.text).toBe('found it')
    expect(answer.status).toBe('answered')
    await sessions.close()
  })

  it('the runner is given the child, the task, the budget and the fork point', async () => {
    const runner = new Scripted({})
    const sessions = new Sessions(parent, runner, { budget: 10 })
    const head = parent.head
    const job = await sessions.ask('go', { wait: true })
    await sessions.ask('again', { budget: 3, wait: true })
    expect(runner.seen[0]).toEqual({ session: job.branch, task: 'go', budget: 10, forkedAt: head })
    expect(runner.seen[1]?.budget).toBe(3)
    expect(sessions.base(job.branch as string)).toBe(head)
    await sessions.close()
  })

  it('an unknown name is refused, listing the jobs there are', async () => {
    const sessions = new Sessions(parent, new Scripted({}))
    await sessions.ask('go', { name: 'scout', wait: true })
    expect(() => sessions.result('nobody')).toThrow(/no job named 'nobody'.*analyst\.scout/)
    expect(() => sessions.cancel('nobody')).toThrow(SessionsError)
    await sessions.close()
  })

  it('declined and capped pass through; a raising runner answers failed', async () => {
    for (const status of ['declined', 'capped'] as const) {
      const sessions = new Sessions(parent, new Scripted({}, 'no', { status }))
      expect((await sessions.ask('go', { wait: true })).status).toBe(status)
      await sessions.close()
    }
    const sessions = new Sessions(parent, {
      run() {
        throw new TypeError('the model went away')
      },
    })
    const answer = await sessions.ask('go', { wait: true })
    expect(answer).toMatchObject({ status: 'failed', text: 'TypeError: the model went away' })
    expect(sessions.list()[0]?.status).toBe('failed')
    await sessions.close()
  })

  it('the fork point is a commit even when the parent has pending writes', async () => {
    await parent.files.fs.write('/workspace/draft.md', new TextEncoder().encode('draft\n'))
    expect(parent.uncommitted).toBe(true)
    const sessions = new Sessions(parent, new Scripted({}))
    const answer = await sessions.ask('go', { wait: true })
    const name = answer.branch as string
    expect(parent.uncommitted).toBe(false)
    expect(sessions.base(name)).toBe(parent.head)
    expect(await read(name, '/workspace/draft.md')).toBe('draft\n')
    await sessions.close()
  })

  it('an empty view forks from the last commit, landing nothing', async () => {
    await parent.files.fs.write('/workspace/draft.md', new TextEncoder().encode('draft\n'))
    const head = parent.head
    const sessions = new Sessions(parent, new Scripted({ '/workspace/new.md': 'n\n' }))
    const answer = await sessions.ask('go', { paths: [], wait: true })
    expect(parent.uncommitted).toBe(true)
    expect(sessions.base(answer.branch as string)).toBe(head)
    expect(answer.changed).toEqual({ seed: [], elsewhere: ['/workspace/new.md'] })
    await sessions.close()
  })

  it('several delegates run at once, up to maxWorkers', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner, { maxWorkers: 2 })
    for (const n of ['a', 'b', 'c']) await sessions.ask(n, { name: n })
    await until(() => runner.started.length === 2)
    await settle()
    expect(runner.started).toHaveLength(2)
    runner.release()
    await until(() => runner.started.length === 3)
    runner.release()
    runner.release()
    await sessions.close()
    expect(runner.most).toBe(2)
    expect(sessions.list().every((j) => j.status === 'answered')).toBe(true)
  })
})

describe('what an answer names', () => {
  it('a delegate that never used ws-git answers at its head, and merges', async () => {
    const sessions = new Sessions(
      parent,
      new Scripted({ '/workspace/report.md': '# Rates\n\nNorth 4, South 7.\n' }, 'capitalized'),
    )
    const answer = await sessions.ask('polish the report', { wait: true })
    const child = await store.open(answer.branch as string)
    expect(await child.index.head()).toBeNull()
    expect(answer.ref).toBe(`${answer.branch}@${child.head}`)
    await child.close()
    expect(answer.uncommitted).toBe(false)
    const out = await parent.merge(answer.branch as string)
    expect(out.merged).toBe(true)
    expect(await parent.files.readText('/workspace/report.md')).toMatch(/South 7\.\n$/)
    await sessions.close()
  })

  it('a delegate that committed is named at its own commit', async () => {
    const sessions = new Sessions(
      parent,
      new Scripted({ '/workspace/report.md': 'own\n' }, 'done', { commits: true }),
    )
    const answer = await sessions.ask('polish', { wait: true })
    const child = await store.open(answer.branch as string)
    expect((await child.index.log()).map((c) => c.info?.message)).toEqual([
      "the delegate's own commit",
    ])
    expect(answer.ref).toBe(`${answer.branch}@${await child.index.head()}`)
    await child.close()
    expect((await parent.merge(answer.branch as string)).merged).toBe(true)
    await sessions.close()
  })

  it('what a delegate left uncommitted is committed for it', async () => {
    const sessions = new Sessions(parent, {
      async run(session) {
        const child = await store.open(session)
        await child.files.write('/workspace/report.md', 'polished\n')
        await child.index.commit('the part I finished')
        await child.terminal('echo wip > /workspace/notes.md')
        await child.close()
        return 'polished the report; the notes are rough'
      },
    })
    const answer = await sessions.ask('polish the report', { wait: true })
    expect(answer.uncommitted).toBe(false)
    const child = await store.open(answer.branch as string)
    expect(answer.ref).toBe(`${answer.branch}@${await child.index.head()}`)
    const log = await child.index.log()
    expect(String(log[0]?.info?.message)).toMatch(/^Work the delegate had not committed/)
    expect(log[0]?.info?.committedFor).toBe(answer.branch)
    expect(log.map((c) => c.info?.message)).toContain('the part I finished')
    expect((await child.index.status()).unstaged).toEqual([])
    await child.close()
    expect(answer.changed.seed).toEqual(['/workspace/notes.md', '/workspace/report.md'])
    expect(renderAnswer(answer)).not.toContain('left work uncommitted')
    expect((await parent.merge(answer.branch as string)).merged).toBe(true)
    expect(await parent.files.readText('/workspace/notes.md')).toBe('wip\n')
    await sessions.close()
  })

  it('a delegate answering mid-merge is not committed for, and its merge refuses', async () => {
    const sessions = new Sessions(parent, {
      async run(session) {
        const child = await store.open(session)
        await child.files.write('/workspace/report.md', '# Rates\n\nnorth 5\n')
        await child.index.commit('north is 5')
        const side = await child.fork(`${session}-side`)
        await side.files.write('/workspace/report.md', '# Rates\n\nnorth 6\n')
        await side.index.commit('north is 6')
        await side.close()
        await child.files.write('/workspace/report.md', '# Rates\n\nnorth 7\n')
        await child.index.commit('north is 7')
        expect((await child.merge(`${session}-side`)).conflicts.length).toBeGreaterThan(0)
        await child.files.write('/workspace/notes.md', 'still deciding\n')
        await child.close()
        return 'two figures for north'
      },
    })
    const answer = await sessions.ask('settle north', { wait: true })
    expect(answer.uncommitted).toBe(true)
    const child = await store.open(answer.branch as string)
    const log = (await child.index.log()).map((c) => String(c.info?.message ?? ''))
    expect(log.some((m) => m.startsWith('Work the delegate'))).toBe(false)
    await child.close()
    expect(renderAnswer(answer)).toContain('left work uncommitted')
    await expect(parent.merge(answer.branch as string)).rejects.toThrow(
      /uncommitted ws-git work on/,
    )
    await sessions.close()
  })

  it('changed groups seed and elsewhere', async () => {
    const sessions = new Sessions(
      parent,
      new Scripted({ '/workspace/report.md': 'polished\n', '/workspace/notes.md': 'why\n' }),
    )
    const answer = await sessions.ask('polish', { paths: ['report.md'], wait: true })
    expect(answer.changed).toEqual({
      seed: ['/workspace/report.md'],
      elsewhere: ['/workspace/notes.md'],
    })
    expect(sessions.list()[0]?.changed).toEqual(answer.changed)
    await sessions.close()
  })

  it('a child with the whole tree reports everything as seed', async () => {
    const sessions = new Sessions(parent, new Scripted({ '/workspace/main.py': "print('x')\n" }))
    const answer = await sessions.ask('edit main', { wait: true })
    expect(answer.changed).toEqual({ seed: ['/workspace/main.py'], elsewhere: [] })
    await sessions.close()
  })

  it('a resumed answer lists only what is new since the merge', async () => {
    const byTask: SessionRunner = {
      async run(session, task) {
        const child = await store.open(session)
        await child.files.write(`/workspace/${task}`, `${task}\n`)
        await child.close()
        return 'done'
      },
    }
    const sessions = new Sessions(parent, byTask)
    const first = await sessions.ask('api.py', { wait: true })
    expect(first.changed.seed).toEqual(['/workspace/api.py'])
    expect((await parent.merge(first.branch as string)).merged).toBe(true)
    const second = await sessions.ask('export.py', { resume: first.branch as string, wait: true })
    expect(second.changed).toEqual({ seed: ['/workspace/export.py'], elsewhere: [] })
    await sessions.close()
  })

  it('an unmerged resume still lists everything since the fork', async () => {
    const byTask: SessionRunner = {
      async run(session, task) {
        const child = await store.open(session)
        await child.files.write(`/workspace/${task}`, `${task}\n`)
        await child.close()
        return 'done'
      },
    }
    const sessions = new Sessions(parent, byTask)
    const first = await sessions.ask('api.py', { wait: true })
    const second = await sessions.ask('export.py', { resume: first.branch as string, wait: true })
    expect(second.changed.seed).toEqual(['/workspace/api.py', '/workspace/export.py'])
    await sessions.close()
  })

  it("a delegate is judged by the parent's ignore patterns", async () => {
    const other = await store.open('ignorer', { ignore: ['scratch/**'] })
    await other.files.write('/workspace/report.md', '# Rates\n')
    const sessions = new Sessions(
      other,
      new Scripted({ '/workspace/notes.md': 'n', '/workspace/scratch/log': 'noise' }),
    )
    const answer = await sessions.ask('go', { wait: true })
    expect(answer.changed).toEqual({ seed: ['/workspace/notes.md'], elsewhere: [] })
    await sessions.close()
    await other.close()
  })

  it('provenance names the chain, not the last hop', async () => {
    const sessions = new Sessions(parent, new Scripted({ '/workspace/notes.md': 'n\n' }), {
      chain: ['boss@aaaaaa'],
    })
    const answer = await sessions.ask('go', { wait: true })
    const chain = answer.provenance.chain as string[]
    expect(chain[0]).toBe('boss@aaaaaa')
    expect(chain[1]).toBe(`analyst@${sessions.base(answer.branch as string)}`)
    expect(chain[2]).toBe(answer.ref)
    expect(answer.provenance.session).toBe(answer.branch)
    expect(answer.provenance.finished as number).toBeGreaterThanOrEqual(
      answer.provenance.started as number,
    )
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer)
    await sessions.close()
  })

  it("a runner's own provenance and artifacts are kept", async () => {
    const sessions = new Sessions(parent, {
      run: () => ({
        text: 'drew it',
        artifacts: [['chart', '/workspace/chart.png']],
        provenance: { model: 'scripted' },
      }),
    })
    const answer = await sessions.ask('draw', { wait: true })
    expect(answer.artifacts).toEqual([['chart', '/workspace/chart.png']])
    expect(answer.provenance.model).toBe('scripted')
    await sessions.close()
  })

  it('a landing that fails answers failed, with the reply kept', async () => {
    const sessions = new Sessions(parent, {
      async run(session) {
        await store.delete(session, { minAge: 0 })
        return 'all done'
      },
    })
    const answer = await sessions.ask('go', { wait: true })
    expect(answer.status).toBe('failed')
    expect(answer.text).toMatch(
      /^all done\n\n\[the delegate answered, and its work could not be landed: SessionsError: the branch 'analyst\.[a-z-]+' is gone\]$/,
    )
    await sessions.close()
  })
})

describe('cancel, keep and close', () => {
  it('cancel discards the answer, stops the run, and leaves the branch', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner)
    const job = await sessions.ask('go', { name: 'scout' })
    await until(() => runner.started.length === 1)
    const cancelled = sessions.cancel('scout')
    expect(cancelled.status).toBe('cancelled')
    await sessions.close()
    expect(() => sessions.result('scout')).toThrow(/was cancelled.*ws-git diff analyst\.scout/)
    expect(sessions.take()).toEqual([])
    expect(await store.exists(job.name)).toBe(true)
  })

  it('cancelling a finished job changes nothing', async () => {
    const sessions = new Sessions(parent, new Scripted({}))
    const answer = await sessions.ask('go', { wait: true })
    expect(sessions.cancel(answer.branch as string).status).toBe('answered')
    await sessions.close()
  })

  it('a job cancelled before it ran frees its child', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner, { maxWorkers: 1 })
    await sessions.ask('first', { name: 'a' })
    await sessions.ask('second', { name: 'b' })
    sessions.cancel('b')
    runner.release()
    await sessions.wait()
    expect(runner.started).toEqual(['analyst.a'])
    // b's branch is free for its next task
    await sessions.ask('again', { resume: 'b' })
    await until(() => runner.started.length === 2)
    runner.release()
    await sessions.close()
    expect(sessions.result('b').text).toBe('did again')
  })

  it('keep records a flag and touches the job', async () => {
    let now = 1_000
    const sessions = new Sessions(parent, new Scripted({}), { now: () => now })
    const answer = await sessions.ask('go', { wait: true })
    now = 5_000
    const kept = sessions.keep(answer.branch as string)
    expect(kept).toMatchObject({ kept: true, touched: 5_000 })
    await sessions.close()
  })

  it('a cancel while the answer is landing commits nothing for the delegate', async () => {
    const sessions = new Sessions(parent, halfDone)
    const exists = store.exists.bind(store)
    let cancelled: string | null = null
    vi.spyOn(store, 'exists').mockImplementation(async (name) => {
      const out = await exists(name)
      // the landing has begun (the fork looked before the job was
      // asked): its first look at the branch
      const asked = sessions.list().some((j) => j.name === name)
      if (name === 'analyst.half' && asked && cancelled === null) {
        cancelled = sessions.cancel(name).status
      }
      return out
    })
    const job = await sessions.ask('polish', { name: 'half' })
    await until(() => cancelled !== null)
    await sessions.close()
    expect(cancelled).toBe('cancelled')
    expect(() => sessions.result(job.name)).toThrow(/was cancelled/)
    expect(await remainders(job.name)).toBe(0)
  })

  it('a cancel while the remainder is being committed finds the job answering', async () => {
    const sessions = new Sessions(parent, halfDone)
    const open = store.open.bind(store)
    let seen: string | null = null
    vi.spyOn(store, 'open').mockImplementation(async (name, opts) => {
      const ws = await open(name, opts)
      if (name !== 'analyst.half' || opts === undefined) return ws
      // the helper's own landing handle: cancel as its commit starts
      const commit = ws.index.commit.bind(ws.index)
      ws.index.commit = async (...args: Parameters<typeof commit>) => {
        seen = sessions.cancel(name).status
        expect(await runAction(sessions, { action: 'cancel', name: 'half' })).toBe(
          'analyst.half is already answering: its work is being landed, so there is nothing to stop.',
        )
        return commit(...args)
      }
      return ws
    })
    const job = await sessions.ask('polish', { name: 'half' })
    await sessions.close()
    expect(seen).toBe('running')
    expect(sessions.result(job.name).status).toBe('answered')
    expect(await remainders(job.name)).toBe(1)
  })

  it("close waits for an earlier run's onAnswer, past a resume of its branch", async () => {
    let release = () => {}
    const hook = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    let heardFirst = false
    const sessions = new Sessions(parent, new Scripted({}), {
      async onAnswer() {
        calls += 1
        if (calls === 1) {
          await hook
          heardFirst = true
        }
      },
    })
    await sessions.ask('one', { name: 'a' })
    await until(() => sessions.list()[0]?.status === 'answered')
    // the first run's hook is still running; its branch is already free
    await sessions.ask('two', { resume: 'a', wait: true })
    let closed = false
    const closing = sessions.close().then(() => {
      closed = true
    })
    await settle()
    expect(closed).toBe(false)
    release()
    await closing
    expect(heardFirst).toBe(true)
  })

  it('close waits for the runs, and keeps the branches', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner)
    const job = await sessions.ask('go')
    expect(Sessions.of(parent)).toBe(sessions)
    let closed = false
    const closing = sessions.close().then(() => {
      closed = true
    })
    await settle()
    expect(closed).toBe(false)
    expect(sessions.closed).toBe(true)
    expect(Sessions.of(parent)).toBeNull()
    await expect(sessions.ask('more')).rejects.toThrow(/is closed/)
    runner.release()
    await closing
    expect(await store.exists(job.name)).toBe(true)
    expect(sessions.result(job.name).status).toBe('answered')
  })
})

describe('forking from elsewhere', () => {
  async function forkPoint(): Promise<{ sage: Workspace; commit: string }> {
    const sage = await store.open('sage')
    await sage.files.write('/workspace/rates.md', 'north 4\n')
    const commit = await store.tags.add(sage, 'rates-2026')
    await sage.files.write('/workspace/rates.md', 'north 5\n')
    return { sage, commit }
  }

  it('a store tag forks that state', async () => {
    const { sage, commit } = await forkPoint()
    const runner = new Scripted({ '/workspace/summary.md': 'north is 4\n' })
    const sessions = new Sessions(parent, runner)
    const answer = await sessions.ask('read it', { forkFrom: 'rates-2026', wait: true })
    expect(answer.changed).toEqual({ seed: ['/workspace/summary.md'], elsewhere: [] })
    expect(await read(answer.branch as string, '/workspace/rates.md')).toBe('north 4\n')
    expect(runner.seen[0]?.forkedAt).toBe(commit)
    const job = sessions.list()[0]
    expect(job?.origin).toEqual(['rates-2026', commit])
    expect(answer.provenance.from).toBe('rates-2026')
    expect(answer.provenance.outside).toBe(true)
    expect((answer.provenance.chain as string[])[0]).toBe(commit)
    expect(renderAnswer(answer)).toContain('which your history does not hold')
    await sessions.close()
    await sage.close()
  })

  it('a session ref, a short id, and a bare session name', async () => {
    const { sage, commit } = await forkPoint()
    const sessions = new Sessions(parent, new Scripted({}))
    const full = await sessions.ask('a', { forkFrom: `sage@${commit}`, wait: true })
    const short = await sessions.ask('b', { forkFrom: `sage@${commit.slice(0, 7)}`, wait: true })
    const now = await sessions.ask('c', { forkFrom: 'sage', wait: true })
    expect(await read(full.branch as string, '/workspace/rates.md')).toBe('north 4\n')
    expect(await read(short.branch as string, '/workspace/rates.md')).toBe('north 4\n')
    expect(await read(now.branch as string, '/workspace/rates.md')).toBe('north 5\n')
    expect((short.provenance.chain as string[])[0]).toBe(`sage@${commit}`)
    expect((now.provenance.chain as string[])[0]).toBe(`sage@${sage.head}`)
    await sessions.close()
    await sage.close()
  })

  it('a store tag wins over a session of the same name', async () => {
    const { sage, commit } = await forkPoint()
    await store.tags.add(sage, 'sage-tag')
    const twin = await store.open('rates-2026')
    await twin.files.write('/workspace/rates.md', 'twin\n')
    const sessions = new Sessions(parent, new Scripted({}))
    const answer = await sessions.ask('a', { forkFrom: 'rates-2026', wait: true })
    expect(sessions.base(answer.branch as string)).toBe(commit)
    await sessions.close()
    await twin.close()
    await sage.close()
  })

  it('a fork point nothing names is refused, listing what there is', async () => {
    const { sage } = await forkPoint()
    const sessions = new Sessions(parent, new Scripted({}))
    await expect(sessions.ask('a', { forkFrom: 'nowhere' })).rejects.toThrow(
      /nothing named 'nowhere' on this store \(sessions: analyst, sage; store tags: rates-2026\)/,
    )
    await sessions.close()
    await sage.close()
  })

  it('carries the conversation by default, and starts fresh when asked', async () => {
    const { sage } = await forkPoint()
    const turn = await sage.turn('r1', { harness: 'h' })
    await turn.end('completed', { body: { said: 'north is 4' } })
    const sessions = new Sessions(parent, new Scripted({}))
    const full = await sessions.ask('a', { forkFrom: 'sage', wait: true })
    const fresh = await sessions.ask('b', { forkFrom: 'sage', inherit: 'fresh', wait: true })
    const mine = await sessions.ask('c', { wait: true })
    const index = async (name: string) => {
      const ws = await store.open(name)
      const out = await ws.conversation.index()
      await ws.close()
      return out
    }
    expect(await index(full.branch as string)).toMatchObject({
      session: full.branch,
      forkedFrom: 'sage',
    })
    expect((await index(fresh.branch as string))?.runs ?? []).toEqual([])
    expect((await index(mine.branch as string))?.runs ?? []).toEqual([])
    await sessions.close()
    await sage.close()
  })

  it('a fork point in the asker’s history is not outside', async () => {
    const commit = await store.tags.add(parent, 'seeded')
    await parent.files.write('/workspace/later.md', 'later\n')
    const sessions = new Sessions(parent, new Scripted({ '/workspace/x.md': 'x\n' }))
    const answer = await sessions.ask('go', { forkFrom: 'seeded', inherit: 'fresh', wait: true })
    expect(sessions.base(answer.branch as string)).toBe(commit)
    expect(answer.provenance.outside).toBeUndefined()
    expect(renderAnswer(answer)).toContain(`ws-git merge ${answer.branch} (take all of it)`)
    await sessions.close()
  })

  it('the source branch is untouched by an ask from it', async () => {
    const { sage } = await forkPoint()
    const before = sage.head
    const sessions = new Sessions(parent, new Scripted({ '/workspace/rates.md': 'changed\n' }))
    await sessions.ask('a', { forkFrom: 'sage', wait: true })
    expect(await store.repo.branches.get('sage')).toBe(before)
    await sessions.close()
    await sage.close()
  })
})

describe('resume', () => {
  it('continues the child: one branch, the conversation kept, a new run', async () => {
    const runner = new Scripted({})
    const sessions = new Sessions(parent, runner)
    const first = await sessions.ask('one', { name: 'editor', wait: true })
    const second = await sessions.ask('two', { resume: 'editor', wait: true })
    expect(second.branch).toBe(first.branch)
    expect(runner.seen.map((s) => [s.session, s.task])).toEqual([
      ['analyst.editor', 'one'],
      ['analyst.editor', 'two'],
    ])
    expect(sessions.list()).toHaveLength(1)
    expect(sessions.list()[0]?.task).toBe('two')
    await sessions.close()
  })

  it('refuses what it would replace: a full inherit, another fork point, no such job', async () => {
    const sessions = new Sessions(parent, new Scripted({}))
    await sessions.ask('one', { name: 'editor', wait: true })
    await expect(sessions.ask('x', { resume: 'editor', inherit: 'full' })).rejects.toThrow(
      /inherit must be 'fresh' when resuming/,
    )
    await expect(sessions.ask('x', { resume: 'editor', forkFrom: 'sage' })).rejects.toThrow(
      /was forked from this session, not from 'sage'/,
    )
    await expect(sessions.ask('x', { resume: 'nobody' })).rejects.toThrow(/no job named/)
    await sessions.close()
  })

  it('is refused while the run it continues is in flight, a cancelled one too', async () => {
    let runs = 0
    const runner: SessionRunner & { go?: () => void } = {
      run() {
        runs += 1
        if (runs > 1) return 'done'
        return new Promise((resolve) => {
          runner.go = () => resolve('done')
        })
      },
    }
    const sessions = new Sessions(parent, runner)
    await sessions.ask('one', { name: 'editor' })
    await expect(sessions.ask('two', { resume: 'editor' })).rejects.toThrow(/still finishing/)
    sessions.cancel('editor')
    // the runner ignores its signal: the branch is held until it returns
    await expect(sessions.ask('two', { resume: 'editor' })).rejects.toThrow(/still finishing/)
    await until(() => runner.go !== undefined)
    runner.go?.()
    await until(() => sessions.outstanding().length === 0)
    await settle()
    const next = await sessions.ask('two', { resume: 'editor', wait: true })
    expect(next.text).toBe('done')
    await sessions.close()
  })

  it('a resumed job keeps what belongs to the child', async () => {
    const sessions = new Sessions(parent, new Scripted({}))
    const first = await sessions.ask('one', { name: 'editor', wait: true })
    const base = sessions.base(first.branch as string)
    sessions.keep('editor')
    await parent.files.write('/workspace/later.md', 'later\n')
    await sessions.ask('two', { resume: 'editor', wait: true })
    expect(sessions.list()[0]?.kept).toBe(true)
    expect(sessions.base(first.branch as string)).toBe(base)
    await sessions.close()
  })
})

describe('collecting answers', () => {
  it('take hands each answer over once, in landing order, sharing result’s mark', async () => {
    let now = 0
    const sessions = new Sessions(parent, new Scripted({}), { now: () => ++now })
    const landed = () => sessions.list().every((j) => j.status !== 'running')
    // An ask that waits collects its answer, as result does.
    await sessions.ask('zero', { name: 'z', wait: true })
    await sessions.ask('one', { name: 'a' })
    await until(landed)
    await sessions.ask('two', { name: 'b' })
    await sessions.ask('three', { name: 'c' })
    await until(landed)
    sessions.result('b')
    const taken = sessions.take()
    expect(taken.map(([name]) => name)).toEqual(['analyst.a', 'analyst.c'])
    expect(sessions.take()).toEqual([])
    await sessions.ask('four', { resume: 'a' })
    await until(landed)
    expect(sessions.take().map(([n, a]) => [n, a.text])).toEqual([['analyst.a', 'done']])
    await sessions.close()
  })

  it('take touches the job as result does', async () => {
    let now = 1_000
    const sessions = new Sessions(parent, new Scripted({}), { now: () => now })
    await sessions.ask('one', { name: 'a' })
    await sessions.wait()
    now = 9_000
    expect(sessions.take()).toHaveLength(1)
    expect(sessions.list()[0]?.touched).toBe(9_000)
    await sessions.close()
  })

  it('outstanding runs from asked to collected', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner)
    await sessions.ask('one', { name: 'a' })
    expect(sessions.outstanding()).toEqual(['analyst.a'])
    runner.release()
    expect(await sessions.wait()).toEqual(['analyst.a'])
    expect(sessions.outstanding()).toEqual(['analyst.a'])
    sessions.take()
    expect(sessions.outstanding()).toEqual([])
    await sessions.close()
  })

  it('wait ends on a timeout, a cancel, or nothing to wait for', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner)
    expect(await sessions.wait()).toEqual([])
    await sessions.ask('one', { name: 'a' })
    expect(await sessions.wait(5)).toEqual([])
    const waiting = sessions.wait()
    sessions.cancel('a')
    expect(await waiting).toEqual([])
    await sessions.close()
  })

  it('onAnswer is called once the job has settled, not for a cancel', async () => {
    const heard: [string, string, string][] = []
    const sessions = new Sessions(parent, new Scripted({}))
    sessions.onAnswer = (name, answer) => {
      heard.push([name, answer.status, sessions.list().find((j) => j.name === name)?.status ?? ''])
    }
    await sessions.ask('one', { name: 'a', wait: true })
    expect(heard).toEqual([['analyst.a', 'answered', 'answered']])
    const held = new Held()
    const job = await sessions.ask('two', { name: 'b', runner: held })
    sessions.cancel(job.name)
    await sessions.close()
    expect(heard).toHaveLength(1)
  })

  it('a hook that throws leaves the job alone', async () => {
    const sessions = new Sessions(parent, new Scripted({}), {
      onAnswer() {
        throw new Error('hook broke')
      },
    })
    const warn = console.warn
    console.warn = () => {}
    try {
      const answer = await sessions.ask('one', { wait: true })
      expect(sessions.result(answer.branch as string)).toEqual(answer)
    } finally {
      console.warn = warn
    }
    await sessions.close()
  })

  it('answers() yields each answer once, until the helper closes', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner)
    await sessions.ask('one', { name: 'a' })
    await sessions.ask('two', { name: 'b' })
    const seen: string[] = []
    const reading = (async () => {
      for await (const [name] of sessions.answers()) seen.push(name)
    })()
    runner.release()
    runner.release()
    await until(() => seen.length === 2)
    await sessions.close()
    await reading
    expect(seen.sort()).toEqual(['analyst.a', 'analyst.b'])
  })

  it("a turn's source delivers an answer on the next tool result, answer and all", async () => {
    const sessions = new Sessions(parent, new Scripted({ '/workspace/n.md': 'n\n' }, 'found it'))
    await sessions.ask('go', { name: 'scout' })
    await sessions.wait()
    const inbox = new Inbox()
    const turn = await parent.turn('r1', {
      harness: 'h',
      inbox,
      sources: [(box) => answerNotes(sessions, box)],
    })
    const { text, notes } = await turn.deliver('wrote a.txt')
    expect(text.startsWith('wrote a.txt\n\n---- inbox ----\n[delegate analyst.scout')).toBe(true)
    expect(notes.map(deliveredNote)).toEqual([
      {
        id: notes[0]?.id,
        text: notes[0]?.text,
        kind: 'mechanism',
        label: 'delegate analyst.scout',
        job: 'analyst.scout',
        answer: expect.objectContaining({ text: 'found it', branch: 'analyst.scout' }),
      },
    ])
    expect((await turn.deliver('again')).notes).toEqual([])
    await turn.end('completed')
    await sessions.close()
  })

  it('answerNotes delivers each landed answer as a mechanism note', async () => {
    const sessions = new Sessions(parent, new Scripted({ '/workspace/n.md': 'n\n' }, 'found it'))
    const answer = await sessions.ask('go', { name: 'scout', wait: true })
    const inbox = new Inbox()
    expect(answerNotes(sessions, inbox)).toEqual([])
    await sessions.ask('again', { resume: 'scout' })
    await sessions.wait()
    const notes = answerNotes(sessions, inbox)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({
      kind: 'mechanism',
      label: 'delegate analyst.scout',
      job: 'analyst.scout',
    })
    expect(notes[0]?.text).toBe(renderAnswer(notes[0]?.answer as Answer))
    expect(notes[0]?.text.startsWith('found it\n\n-- analyst.scout answered at')).toBe(true)
    expect(inbox.delivered()).toEqual(notes)
    expect(answerNotes(sessions, inbox)).toEqual([])
    expect(answer.branch).toBe('analyst.scout')
    await sessions.close()
  })
})

describe('the retention sweep', () => {
  it('takes finished, unkept jobs past idle, and leaves the rest', async () => {
    let now = 0
    const held = new Held()
    const sessions = new Sessions(parent, new Scripted({}), { now: () => now })
    await sessions.ask('one', { name: 'old', wait: true })
    await sessions.ask('two', { name: 'kept', wait: true })
    sessions.keep('kept')
    await sessions.ask('three', { name: 'busy', runner: held })
    now = 3_600_000
    await sessions.ask('four', { name: 'fresh', wait: true })
    now = 3_700_000
    expect(await sessions.sweep(3600, { minAge: 0 })).toEqual(['analyst.old'])
    expect(await store.exists('analyst.old')).toBe(false)
    expect(await store.exists('analyst.kept')).toBe(true)
    const old = sessions.list().find((j) => j.name === 'analyst.old')
    expect(old).toMatchObject({ status: 'expired', finished: 0 })
    expect(() => sessions.result('old')).toThrow(BranchExpiredError)
    expect(() => sessions.keep('old')).toThrow(BranchExpiredError)
    await expect(sessions.ask('x', { resume: 'old' })).rejects.toThrow(BranchExpiredError)
    expect(sessions.base('analyst.old')).not.toBeNull()
    expect(await sessions.sweep(3600, { minAge: 0 })).toEqual([])
    expect(await runAction(sessions, { action: 'list' })).toContain(
      'analyst.old  expired  one  (branch swept; sessions ask to run it again)',
    )
    expect(await runAction(sessions, { action: 'result', name: 'old' })).toMatch(
      /^sessions result failed: job 'analyst\.old' expired/,
    )
    held.release()
    await sessions.close()
  })

  it("reading an answer touches the job, and a delegate's own delegates aren't swept", async () => {
    let now = 0
    const sessions = new Sessions(parent, new Scripted({}), { now: () => now })
    const answer = await sessions.ask('one', { name: 'read', wait: true })
    const own = await store.open('analyst.notes')
    await own.close()
    now = 3_600_000
    sessions.result('read')
    expect(await sessions.sweep(3600, { minAge: 0 })).toEqual([])
    now = 7_200_000
    expect(await sessions.sweep(3600, { minAge: 0 })).toEqual([answer.branch])
    expect(await store.exists('analyst.notes')).toBe(true)
    await sessions.close()
  })
})

describe('untilSettled', () => {
  it('settles at once with nothing outstanding', async () => {
    const out = await untilSettled(async () => 'done', null, null, { prompt: 'go' })
    expect(out).toEqual({ reply: 'done', wakes: 0, unread: [], notes: 0, text: 'done' })
  })

  it('wakes for a note left after the last tool call', async () => {
    const inbox = new Inbox()
    const prompts: (string | null)[] = []
    const out = await untilSettled(
      async (prompt) => {
        prompts.push(prompt)
        if (prompt !== null) {
          inbox.put('also date it')
          return 'drafted'
        }
        inbox.drain()
        return 'drafted, and dated'
      },
      null,
      inbox,
      { prompt: 'go' },
    )
    expect(prompts).toEqual(['go', null])
    expect(out).toMatchObject({ reply: 'drafted, and dated', wakes: 1 })
  })

  it('waits for its own delegate, then wakes to read it', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner)
    const out = await untilSettled(
      async (prompt) => {
        if (prompt !== null) {
          await sessions.ask('check north', { name: 'helper' })
          setTimeout(() => runner.release(), 5)
          return 'waiting on the helper'
        }
        return `read: ${sessions.take().map(([, a]) => a.text)}`
      },
      sessions,
      null,
      { prompt: 'go', poll: 5 },
    )
    expect(out).toMatchObject({ reply: 'read: did check north', wakes: 1, unread: [] })
    await sessions.close()
  })

  it('out of wakes, answers with what it has, naming who it did not hear from', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner)
    const out = await untilSettled(
      async () => {
        await sessions.ask('check north', { name: 'helper' })
        return 'waiting'
      },
      sessions,
      null,
      { prompt: 'go', maxWakes: 0 },
    )
    expect(out.unread).toEqual(['analyst.helper'])
    expect(out.text).toBe(
      'waiting\n\n[answered before hearing back from analyst.helper, whose work is on their own branches]',
    )
    runner.release()
    await sessions.close()
  })

  it('a closed helper ends the wait', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner)
    const out = await untilSettled(
      async () => {
        await sessions.ask('check north', { name: 'helper' })
        void sessions.close()
        return 'waiting'
      },
      sessions,
      null,
      { prompt: 'go', poll: 5 },
    )
    expect(out.unread).toEqual(['analyst.helper'])
    runner.release()
    await sessions.close()
  })
})

describe('the sessions tool', () => {
  it('is offered only with a helper', async () => {
    expect(worldTools(parent).map((t) => t.name)).not.toContain('sessions')
    const sessions = new Sessions(parent, new Scripted({}))
    const tool = worldTools(parent, { sessions }).find((t) => t.name === 'sessions')
    expect(tool?.description).toMatch(/^Delegate work to a fork of this session/)
    expect(tool?.parameters).toMatchObject({ required: ['action'] })
    await sessions.close()
  })

  it('asks, lists, collects, keeps and cancels', async () => {
    const runner = new Held()
    const sessions = new Sessions(parent, runner)
    const tool = sessionsTool(sessions)
    const asked = await tool.call({
      action: 'ask',
      task: '# Find the rates\nall of them',
      name: 'scout',
    })
    expect(asked).toEqual({
      text: 'delegated to analyst.scout: Find the rates\nthe answer arrives on a later turn; `sessions list` shows progress and `sessions result analyst.scout` collects it.',
      images: [],
      isError: false,
    })
    expect((await tool.call({ action: 'list' })).text).toBe(
      '1 job(s):\n  analyst.scout  running  Find the rates  (no answer yet)',
    )
    expect((await tool.call({ action: 'result', name: 'scout' })).text).toMatch(
      /^job 'analyst\.scout' is still running/,
    )
    runner.release()
    await sessions.wait()
    const result = await tool.call({ action: 'result', name: 'scout' })
    expect(result.text).toBe(
      `did # Find the rates\nall of them\n\n-- analyst.scout answered at ${sessions.result('scout').ref}\nit changed no files; its answer is the whole result.`,
    )
    expect((await tool.call({ action: 'keep', name: 'scout' })).text).toBe(
      'analyst.scout kept: the retention sweep will leave its branch alone from now on.',
    )
    expect((await tool.call({ action: 'cancel', name: 'scout' })).text).toBe(
      'analyst.scout had already finished (answered); nothing to stop.',
    )
    expect((await tool.call({ action: 'list' })).text).toBe(
      '1 job(s):\n  analyst.scout  answered  Find the rates  (0 path(s); sessions result analyst.scout) [kept]',
    )
    await sessions.close()
  })

  it('resume is the ask that continues a delegate', async () => {
    const sessions = new Sessions(parent, new Scripted({}))
    const tool = sessionsTool(sessions)
    await tool.call({ action: 'ask', task: 'one', name: 'editor', wait: true })
    const again = await tool.call({ action: 'resume', name: 'editor', task: 'two', wait: true })
    expect(again.text).toMatch(/^done\n\n-- analyst\.editor answered/)
    expect(sessions.list()[0]?.task).toBe('two')
    await sessions.close()
  })

  it('runs an ask on the runner the call brings', async () => {
    const own = new Scripted({}, 'the helper’s')
    const brought = new Scripted({}, 'the call’s')
    const sessions = new Sessions(parent, own)
    const tool = worldTools(parent, { sessions, runner: brought }).find(
      (t) => t.name === 'sessions',
    )
    const asked = await tool?.call({ action: 'ask', task: 'one', name: 'a', wait: true })
    expect(asked?.text).toMatch(/^the call’s\n/)
    await runAction(sessions, { action: 'resume', name: 'a', task: 'two', wait: true })
    expect(await runAction(sessions, { action: 'result', name: 'a' })).toMatch(/^the helper’s\n/)
    expect([own.seen.length, brought.seen.length]).toEqual([1, 1])
    await sessions.close()
  })

  it('says what an ask cannot do, as an error result', async () => {
    const sessions = new Sessions(parent, new Scripted({}))
    const tool = sessionsTool(sessions)
    expect(await tool.call({ action: 'ask' })).toMatchObject({
      text: 'sessions ask needs a task: what should the delegate do?',
      isError: true,
    })
    expect(await tool.call({ action: 'result' })).toMatchObject({ isError: true })
    expect(await tool.call({ action: 'merge' })).toMatchObject({
      text: expect.stringMatching(/^unknown action 'merge' — sessions takes ask/),
      isError: true,
    })
    expect(await tool.call({ action: 'ask', task: 'x', fork_from: 'nowhere' })).toMatchObject({
      text: expect.stringMatching(/^sessions ask failed: nothing named 'nowhere'/),
      isError: true,
    })
    expect(await tool.call({ action: 'ask', task: 'x', paths: 7 })).toMatchObject({
      text: expect.stringMatching(/^sessions ask failed: paths must be a list/),
      isError: true,
    })
    await sessions.close()
  })

  it('takes paths as a list, a JSON string, or one path', () => {
    expect(coercePaths(['a', '', 'b'])).toEqual(['a', 'b'])
    expect(coercePaths('["a", "b"]')).toEqual(['a', 'b'])
    expect(coercePaths(' report.md ')).toEqual(['report.md'])
    expect(coercePaths('')).toBeNull()
    expect(() => coercePaths('[oops')).toThrow(/JSON list/)
  })
})

describe('asking from code', () => {
  it('a host method declared withCall asks and waits inside the code call', async () => {
    if (!existsSync(fileURLToPath(WORKER))) throw new Error('build @agex-ts/world first')
    const ws = await store.open('coder', {
      profile: {
        code: { worker: { target: 'node', url: WORKER } },
        hostObjects: {
          team: {
            ask: withCall(async (call, task: string) => {
              if (call === undefined) throw new Error('only from code')
              const sessions = Sessions.of(call.ws)
              if (sessions === null) throw new Error('no helper')
              return (await sessions.ask(task, { call, wait: true })).text
            }),
          },
        },
      },
    })
    const sessions = new Sessions(ws, new Scripted({ '/workspace/found.md': 'f\n' }, 'north is 4'))
    const out = await ws.runCode(`
      await fs.write('/workspace/before.md', 'b')
      return await team.ask('find north')
    `)
    expect(out.error).toBeNull()
    expect(out.value).toBe('north is 4')
    const job = sessions.list()[0]
    expect(await read(job?.name as string, '/workspace/before.md')).toBe('b')
    await sessions.close()
    await ws.close()
  })
})
