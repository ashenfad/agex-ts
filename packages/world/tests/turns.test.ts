import { describe, expect, it } from 'vitest'
import {
  CommitConflictError,
  HarnessMismatchError,
  ReadOnlyError,
  Store,
  TurnInProgressError,
  type Workspace,
  WorldError,
} from '../src/index'
import { newKV } from './backends'

const open = async (session = 's'): Promise<Workspace> =>
  (await Store.open(await newKV())).open(session)

const infos = async (ws: Workspace) => (await ws.log()).map((c) => c.info).reverse()

describe('a turn', () => {
  it('ends with one commit stamped with the run and its status', async () => {
    const ws = await open()
    const turn = await ws.turn('r1', { harness: 'h' })
    await ws.files.write('a.txt', 'a')
    const commit = await turn.end('completed', { body: { said: 'hi' } })
    expect(commit).toBe(ws.head)
    expect(turn.status).toBe('completed')
    expect(await infos(ws)).toEqual([
      { tool: 'init' },
      { tool: 'file_write' },
      { tool: 'turn', runs: { r1: 'completed' } },
    ])
    expect(await ws.conversation.index()).toEqual({
      format: 1,
      harness: 'h',
      session: 's',
      runs: ['r1'],
      forkedFrom: null,
    })
    expect(await ws.conversation.runs()).toEqual(new Map([['r1', { said: 'hi' }]]))
    await ws.close()
  })

  it('makes no commit when nothing changed; an unnamed turn stamps no run', async () => {
    const ws = await open()
    const head = ws.head
    expect(await (await ws.turn()).end('completed')).toBeNull()
    expect(ws.head).toBe(head)
    const turn = await ws.turn()
    await ws.files.fs.write('/workspace/x', new TextEncoder().encode('x'))
    await turn.end('failed', { message: 'boom' })
    expect((await infos(ws)).at(-1)).toEqual({ tool: 'turn', message: 'boom' })
    await ws.close()
  })

  it('is one at a time per workspace, and a fork has its own', async () => {
    const ws = await open()
    const turn = await ws.turn('a')
    expect(ws.currentTurn).toBe(turn)
    await expect(ws.turn('b')).rejects.toThrow(TurnInProgressError)
    const child = await ws.fork('child')
    const other = await child.turn('c')
    await other.end('completed')
    await turn.end('completed')
    expect(ws.currentTurn).toBeNull()
    await (await ws.turn('b')).end('completed')
    await child.close()
    await ws.close()
  })

  it('ends once, with a real status', async () => {
    const ws = await open()
    const turn = await ws.turn('a')
    await expect(turn.end('done' as 'completed')).rejects.toThrow(TypeError)
    expect(turn.open).toBe(true)
    await turn.end('completed')
    await expect(turn.end('completed')).rejects.toThrow("this turn already ended 'completed'")
    await ws.close()
  })

  it('stores a body only with a run id and a harness, and only its own harness', async () => {
    const ws = await open()
    await expect((await ws.turn()).end('completed', { body: {} })).rejects.toThrow(
      'storing a run needs its id',
    )
    await expect((await ws.turn('a')).end('completed', { body: {} })).rejects.toThrow(
      "storing a run needs the harness's name",
    )
    await (await ws.turn('a', { harness: 'one' })).end('completed', { body: 1 })
    // The conversation's harness is the default after that.
    await (await ws.turn('b')).end('completed', { body: 2 })
    await expect(
      (await ws.turn('c', { harness: 'two' })).end('completed', { body: 3 }),
    ).rejects.toThrow(HarnessMismatchError)
    expect((await ws.conversation.index())?.runs).toEqual(['a', 'b'])
    await ws.close()
  })

  it('binds its run id once', async () => {
    const ws = await open()
    const turn = await ws.turn(null, { harness: 'h' })
    turn.bind('late')
    turn.bind('late')
    expect(() => turn.bind('other')).toThrow(WorldError)
    await turn.end('completed', { body: 'x' })
    expect((await ws.conversation.index())?.runs).toEqual(['late'])
    await ws.close()
  })

  it('resumes a run the conversation holds, replacing its body in place', async () => {
    const ws = await open()
    await expect(ws.turn('r', { resume: true })).rejects.toThrow("holds no run 'r' to resume")
    await (await ws.turn('r', { harness: 'h' })).interrupt('provider down', { body: { n: 1 } })
    const resumed = await ws.turn('r', { resume: true })
    expect(resumed.resume).toBe(true)
    await resumed.complete({ body: { n: 2 } })
    expect((await ws.conversation.index())?.runs).toEqual(['r'])
    expect(await ws.conversation.runs()).toEqual(new Map([['r', { n: 2 }]]))
    expect((await infos(ws)).slice(1)).toEqual([
      { tool: 'turn', runs: { r: 'interrupted' }, message: 'provider down' },
      { tool: 'turn', runs: { r: 'completed' } },
    ])
    await ws.close()
  })

  it('is released when its commit conflicts, leaving the stored run pending', async () => {
    const store = await Store.open(await newKV())
    const a = await store.open('s')
    const b = await store.open('s')
    const lost = await b.turn('r2', { harness: 'h' })
    await (await a.turn('r1', { harness: 'h' })).end('completed', { body: 'one' })
    await expect(lost.end('completed', { body: 'two' })).rejects.toThrow(CommitConflictError)
    expect(lost.status).toBe('completed')
    expect(lost.commit).toBeNull()
    expect(b.currentTurn).toBeNull()
    expect(b.uncommitted).toBe(true)
    await b.refresh()
    await (await b.turn('r2', { harness: 'h' })).end('completed', { body: 'two' })
    expect((await b.conversation.index())?.runs).toEqual(['r1', 'r2'])
    expect((await infos(b)).at(-1)).toEqual({ tool: 'turn', runs: { r2: 'completed' } })
    await a.close()
    await b.close()
  })

  it('is refused on a frozen workspace', async () => {
    const ws = await open()
    const view = await ws.store.resolve(`s@${ws.head}`)
    await expect(view.turn('a')).rejects.toThrow(ReadOnlyError)
    await ws.close()
  })
})

describe('runTurn', () => {
  it('completes, or ends as the error says, and throws the error on', async () => {
    const ws = await open()
    expect(await ws.runTurn(async () => 7, { runId: 'ok', harness: 'h' })).toBe(7)
    const abort = Object.assign(new Error('stop'), { name: 'AbortError' })
    await expect(
      ws.runTurn(
        async () => {
          await ws.files.write('half.txt', 'x')
          throw abort
        },
        { runId: 'cut' },
      ),
    ).rejects.toBe(abort)
    await expect(
      ws.runTurn(
        async () => {
          await ws.files.write('more.txt', 'y')
          throw new RangeError('boom')
        },
        { runId: 'bad' },
      ),
    ).rejects.toThrow('boom')
    const turns = (await infos(ws)).filter((i) => i?.tool === 'turn')
    expect(turns).toEqual([])
    const stamps = (await infos(ws)).map((i) => i?.tool)
    expect(stamps).toEqual(['init', 'file_write', 'file_write'])
    await ws.close()
  })

  it('stamps the status when the run leaves something to commit', async () => {
    const ws = await open()
    await expect(
      ws.runTurn(
        async () => {
          await ws.files.fs.write('/workspace/p', new TextEncoder().encode('p'))
          throw new RangeError('boom')
        },
        { runId: 'bad' },
      ),
    ).rejects.toThrow('boom')
    expect((await infos(ws)).at(-1)).toEqual({
      tool: 'turn',
      runs: { bad: 'failed' },
      message: 'RangeError: boom',
    })
    await ws.runTurn(
      async (turn) => {
        await turn.end('interrupted', { message: 'mine' })
      },
      { runId: 'self' },
    )
    expect(ws.currentTurn).toBeNull()
    await ws.close()
  })
})

describe('the conversation across forks and checkouts', () => {
  const seed = async () => {
    const ws = await open('parent')
    await (await ws.turn('r1', { harness: 'h' })).end('completed', { body: 'first' })
    return ws
  }

  it("a full fork carries it, as the child's, forked from the parent", async () => {
    const ws = await seed()
    const child = await ws.fork('child')
    expect(await child.conversation.index()).toMatchObject({
      session: 'child',
      forkedFrom: 'parent',
      runs: ['r1'],
    })
    expect(await child.conversation.runs()).toEqual(new Map([['r1', 'first']]))
    expect((await ws.conversation.index())?.session).toBe('parent')
    await child.close()
    await ws.close()
  })

  it('a fresh fork starts without it', async () => {
    const ws = await seed()
    const child = await ws.fork('child', { inherit: 'fresh' })
    expect(await child.conversation.index()).toBeNull()
    await child.close()
    await ws.close()
  })

  it('a checkout rewinds it, and reclaims a pre-fork commit for this session', async () => {
    const ws = await seed()
    const beforeFork = ws.head
    const child = await ws.fork('child')
    await (await child.turn('r2')).end('completed', { body: 'second' })
    expect((await child.conversation.index())?.runs).toEqual(['r1', 'r2'])

    await child.checkout(beforeFork)
    expect(await child.conversation.index()).toMatchObject({
      session: 'child',
      forkedFrom: 'parent',
      runs: ['r1'],
    })
    await child.close()
    await ws.close()
  })
})
