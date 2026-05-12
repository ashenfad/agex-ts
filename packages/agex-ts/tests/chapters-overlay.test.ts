/**
 * Targeted tests for chapters-overlay's per-event markdown
 * rendering — each event type that can show up in a chapter's
 * `eventRefs` should produce sensible markdown when the agent
 * does `cat /chapters/<slug>/events/NNN-<type>.md`.
 *
 * The overlay's read/list/swap behavior is exercised via
 * mount-fs.test.ts and the integration smoke; these focus on
 * `buildChaptersOverlay` + `renderEventMarkdown`.
 */

import { describe, expect, it } from 'vitest'
import { buildChaptersOverlay } from '../src/fs/chapters-overlay'
import type { AgentEvent, ChapterEvent } from '../src/types'

const dec = new TextDecoder()

const ts = '2026-05-05T00:00:00.000Z'

/** Build the overlay file map from a chapter event whose `eventRefs`
 *  point at the supplied original events (resolver dispatches by ref). */
async function overlayFor(
  chapter: ChapterEvent,
  byRef: Record<string, AgentEvent>,
): Promise<Map<string, Uint8Array>> {
  async function* iter() {
    yield chapter
  }
  return buildChaptersOverlay(iter(), async (ref) => byRef[ref])
}

describe('buildChaptersOverlay — per-event markdown', () => {
  it('writes summary.md from the chapter name + message', async () => {
    const ch: ChapterEvent = {
      type: 'chapter',
      timestamp: ts,
      agentName: 'a',
      name: 'Phase 1',
      message: 'planned then executed',
      slug: 'phase-1',
      eventRefs: [],
    }
    const files = await overlayFor(ch, {})
    const summary = files.get('/phase-1/summary.md')
    expect(summary).toBeDefined()
    expect(dec.decode(summary as Uint8Array)).toContain('# Phase 1')
    expect(dec.decode(summary as Uint8Array)).toContain('planned then executed')
  })

  it('renders taskStart events with task name + inputs', async () => {
    const ch: ChapterEvent = {
      type: 'chapter',
      timestamp: ts,
      agentName: 'a',
      name: 'p1',
      message: 'm',
      slug: 'p1',
      eventRefs: ['ref-a'],
    }
    const files = await overlayFor(ch, {
      'ref-a': {
        type: 'taskStart',
        timestamp: ts,
        agentName: 'a',
        taskName: 'Greet',
        inputs: { name: 'Ada' },
      },
    })
    const evFile = files.get('/p1/events/001-taskStart.md')
    expect(evFile).toBeDefined()
    const text = dec.decode(evFile as Uint8Array)
    expect(text).toContain('taskStart')
    expect(text).toContain('Greet')
    expect(text).toContain('Ada')
  })

  it('renders action events with each emission described', async () => {
    const ch: ChapterEvent = {
      type: 'chapter',
      timestamp: ts,
      agentName: 'a',
      name: 'p',
      message: 'm',
      slug: 'p',
      eventRefs: ['act-1'],
    }
    const files = await overlayFor(ch, {
      'act-1': {
        type: 'action',
        timestamp: ts,
        agentName: 'a',
        emissions: [
          { type: 'ts', code: 'taskSuccess(1)' },
          { type: 'terminal', commands: 'ls /' },
          { type: 'fileWrite', path: '/n', content: 'hi', mode: 'write' },
          { type: 'fileEdit', path: '/n', search: 'hi', content: 'bye' },
          { type: 'text', text: 'aside' },
          { type: 'thinking', text: 'reasoning' },
        ],
      },
    })
    const evFile = files.get('/p/events/001-action.md')
    expect(evFile).toBeDefined()
    const text = dec.decode(evFile as Uint8Array)
    expect(text).toContain('Emission 1: ts')
    expect(text).toContain('taskSuccess(1)')
    expect(text).toContain('Emission 2: terminal')
    expect(text).toContain('ls /')
    expect(text).toContain('Emission 3: fileWrite')
    expect(text).toContain('Emission 4: fileEdit')
    expect(text).toContain('Emission 5: text')
    expect(text).toContain('aside')
    expect(text).toContain('Emission 6: thinking')
    expect(text).toContain('reasoning')
  })

  it('renders output / success / fail / cancelled / error', async () => {
    const ch: ChapterEvent = {
      type: 'chapter',
      timestamp: ts,
      agentName: 'a',
      name: 'p',
      message: 'm',
      slug: 'p',
      eventRefs: ['o', 's', 'f', 'x', 'e'],
    }
    const files = await overlayFor(ch, {
      o: {
        type: 'output',
        timestamp: ts,
        agentName: 'a',
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'image', format: 'png', data: 'b64' },
        ],
      },
      s: { type: 'success', timestamp: ts, agentName: 'a', result: { ok: true } },
      f: { type: 'fail', timestamp: ts, agentName: 'a', message: 'nope' },
      x: {
        type: 'cancelled',
        timestamp: ts,
        agentName: 'a',
        taskName: 't',
        iterationsCompleted: 3,
      },
      e: {
        type: 'error',
        timestamp: ts,
        agentName: 'a',
        errorName: 'TypeError',
        errorMessage: 'oops',
        recoverable: false,
      },
    })

    const out = (path: string): string => dec.decode(files.get(path) as Uint8Array)
    expect(out('/p/events/001-output.md')).toContain('hello')
    expect(out('/p/events/001-output.md')).toContain('image: png')
    expect(out('/p/events/002-success.md')).toContain('"ok": true')
    expect(out('/p/events/003-fail.md')).toContain('nope')
    expect(out('/p/events/004-cancelled.md')).toContain('after 3 iterations')
    expect(out('/p/events/005-error.md')).toContain('TypeError: oops')
  })

  it('skips refs that the resolver returns undefined for', async () => {
    const ch: ChapterEvent = {
      type: 'chapter',
      timestamp: ts,
      agentName: 'a',
      name: 'p',
      message: 'm',
      slug: 'p',
      eventRefs: ['missing', 'present'],
    }
    const files = await overlayFor(ch, {
      present: { type: 'success', timestamp: ts, agentName: 'a', result: 1 },
    })
    expect(files.get('/p/events/001-success.md')).toBeDefined()
    expect(files.get('/p/events/002-success.md')).toBeUndefined()
  })
})
