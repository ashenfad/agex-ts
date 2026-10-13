/**
 * The inbox: notes queued for the next tool result, delivered by the
 * turn, settled when it ends.
 */

import { Memory } from '@agex-ts/kvgit/backends/memory'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Inbox,
  MARK,
  type Note,
  Store,
  type Workspace,
  defaultFrame,
  renderNotes,
  splitNotes,
} from '../src/index'

const open = async (): Promise<Workspace> => (await Store.open(new Memory())).open('s')

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rendering', () => {
  it('frames each note by who is speaking, behind a mark', () => {
    const inbox = new Inbox()
    const from = inbox.put('and b')
    const answer = inbox.put('the rates are 4 and 7', {
      kind: 'mechanism',
      label: 'delegate scout',
    })
    const text = renderNotes([from, answer])
    expect(text.startsWith(MARK)).toBe(true)
    expect(text).toContain(`${defaultFrame(from)}\nand b`)
    expect(defaultFrame(from)).toMatch(/^\[message from the person you are working for — /)
    expect(defaultFrame(answer)).toMatch(
      /^\[delegate scout — the delegation mechanism speaking, not the person you are working for/,
    )
    expect(renderNotes([])).toBe('')
  })

  it('splits a result from its notes by the trailer, not the mark', () => {
    const inbox = new Inbox()
    const notes = [inbox.put('one'), inbox.put(`quoting ${MARK} inside`)]
    const result = `file says:${MARK}not a block`
    const delivered = result + renderNotes(notes)
    expect(splitNotes(delivered)).toEqual([result, renderNotes(notes)])
    expect(splitNotes(result)).toEqual([result, ''])
  })

  it("uses the inbox's own frame", () => {
    const inbox = new Inbox({ frame: (n: Note) => `[${n.kind}]` })
    expect(inbox.render([inbox.put('hi')])).toContain('[principal]\nhi')
  })
})

describe('the queue', () => {
  it('moves notes from pending to delivered to settled', () => {
    const inbox = new Inbox()
    const a = inbox.put('a')
    const b = inbox.put('b')
    expect([a.id, b.id]).toEqual(['n1', 'n2'])
    expect(inbox.withdraw(b.id)).toBe(true)
    expect(inbox.drain().map((n) => n.text)).toEqual(['a'])
    expect(inbox.withdraw(a.id)).toBe(false)
    expect(inbox.drain()).toEqual([])
    expect(inbox.delivered().map((n) => n.text)).toEqual(['a'])
    inbox.settle()
    expect([inbox.pending(), inbox.delivered()]).toEqual([[], []])
  })

  it('requeues a thrown-away attempt ahead of what came since', () => {
    const inbox = new Inbox()
    inbox.put('first')
    inbox.drain()
    inbox.deliverNow('found', { kind: 'mechanism', job: 'scout' })
    inbox.put('later')
    expect(inbox.requeue()).toBe(2)
    expect(inbox.pending().map((n) => n.text)).toEqual(['first', 'found', 'later'])
    expect(inbox.pending()[1]?.job).toBe('scout')
  })
})

describe('delivery on a turn', () => {
  it('appends what is queued to a tool result, and the end settles it', async () => {
    const ws = await open()
    const seen: string[][] = []
    const inbox = new Inbox({ onDelivered: (notes) => seen.push(notes.map((n) => n.text)) })
    const turn = await ws.turn('r', { inbox })
    expect(await turn.deliver('ok')).toEqual({ text: 'ok', notes: [] })
    inbox.put('and b')
    const { text, notes } = await turn.deliver('ok')
    expect(splitNotes(text)).toEqual(['ok', inbox.render(notes)])
    expect(seen).toEqual([['and b']])
    expect(inbox.delivered()).toHaveLength(1)
    await turn.end('completed')
    expect(inbox.delivered()).toEqual([])
    await ws.close()
  })

  it('settles on a cancelled end too', async () => {
    const ws = await open()
    const inbox = new Inbox()
    const turn = await ws.turn('r', { inbox })
    inbox.put('stop soon')
    await turn.deliver('ok')
    await turn.end('cancelled', { message: 'stopped' })
    expect([inbox.pending(), inbox.delivered()]).toEqual([[], []])
    await ws.close()
  })

  it("adds what each source makes, and puts back a throwing source's notes", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = await open()
    const inbox = new Inbox()
    const sources = [
      (box: Inbox) => [box.deliverNow('scout answered', { kind: 'mechanism', job: 'scout' })],
      (box: Inbox) => {
        box.deliverNow('half made')
        throw new Error('boom')
      },
    ]
    const turn = await ws.turn('r', { inbox, sources })
    const { notes } = await turn.deliver('ok')
    expect(notes.map((n) => n.text)).toEqual(['scout answered'])
    expect(inbox.pending().map((n) => n.text)).toEqual(['half made'])
    expect(console.warn).toHaveBeenCalledOnce()
    await turn.end('completed')
    await ws.close()
  })

  it('puts back the notes of several failing sources in source order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = await open()
    const inbox = new Inbox()
    const failing = (text: string) => (box: Inbox) => {
      box.deliverNow(text)
      throw new Error(text)
    }
    const turn = await ws.turn('r', { inbox, sources: [failing('first'), failing('second')] })
    expect((await turn.deliver('ok')).notes).toEqual([])
    expect(inbox.pending().map((n) => n.text)).toEqual(['first', 'second'])
    await turn.end('completed')
    await ws.close()
  })

  it('requeues what it delivered when the run cannot be stored', async () => {
    const ws = await open()
    const inbox = new Inbox()
    const turn = await ws.turn(null, { inbox })
    inbox.put('a correction')
    await turn.deliver('ok')
    await expect(turn.end('completed', { body: { messages: [] } })).rejects.toThrow(
      'storing a run needs its id',
    )
    expect(turn.open).toBe(false)
    expect(inbox.delivered()).toEqual([])
    expect(inbox.pending().map((n) => n.text)).toEqual(['a correction'])
    const next = await ws.turn('r2', { inbox, harness: 'h' })
    expect((await next.deliver('ok')).notes.map((n) => n.text)).toEqual(['a correction'])
    await next.end('completed', { body: { messages: [] } })
    expect([inbox.pending(), inbox.delivered()]).toEqual([[], []])
    await ws.close()
  })

  it('leaves the result as it was when the notes cannot be rendered', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = await open()
    const inbox = new Inbox({
      frame: () => {
        throw new Error('bad frame')
      },
    })
    const turn = await ws.turn('r', { inbox })
    inbox.put('a')
    expect(await turn.deliver('ok')).toEqual({ text: 'ok', notes: [] })
    expect(inbox.pending().map((n) => n.text)).toEqual(['a'])
    await turn.end('completed')
    await ws.close()
  })

  it('awaits onDelivered, and a throwing one costs the delivery nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ws = await open()
    const order: string[] = []
    const inbox = new Inbox({
      onDelivered: async () => {
        await new Promise((r) => setTimeout(r, 5))
        order.push('heard')
        throw new Error('recorder down')
      },
    })
    const turn = await ws.turn('r', { inbox })
    inbox.put('a')
    const { notes } = await turn.deliver('ok')
    order.push('delivered')
    expect(order).toEqual(['heard', 'delivered'])
    expect(notes).toHaveLength(1)
    await turn.end('completed')
    await ws.close()
  })

  it('opens a woken turn with what is waiting, or with nothing', async () => {
    const ws = await open()
    const inbox = new Inbox()
    const quiet = await ws.turn('r1', { inbox })
    expect(await quiet.opening()).toBeNull()
    await quiet.end('completed')
    inbox.put('and b')
    const woken = await ws.turn('r2', { inbox })
    const opening = await woken.opening()
    expect(splitNotes(opening ?? '')).toEqual(['', opening])
    expect(inbox.delivered().map((n) => n.text)).toEqual(['and b'])
    await woken.end('completed')
    await ws.close()
  })

  it('delivers nothing on a turn without an inbox', async () => {
    const ws = await open()
    const turn = await ws.turn('r')
    expect(turn.collect()).toEqual([])
    expect(await turn.deliver('ok')).toEqual({ text: 'ok', notes: [] })
    expect(await turn.opening()).toBeNull()
    await turn.end('completed')
    await ws.close()
  })
})
