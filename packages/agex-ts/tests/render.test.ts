import { describe, expect, it } from 'vitest'
import { PolicyBuilder } from '../src/policy'
import {
  BUILTIN_PRIMER,
  type NeutralTurn,
  TOOL_EDIT_FILE,
  TOOL_TERMINAL,
  TOOL_TS,
  TOOL_WRITE_FILE,
  buildSystemMessage,
  buildTaskMessage,
  extractJsonSchema,
  hasObjectProperties,
  makeToolUseId,
  objectPropertyNames,
  renderEvents,
  renderRegistrations,
  toolSchemas,
} from '../src/render'
import type {
  ActionEvent,
  AgentEvent,
  ChapterEvent,
  OutputEvent,
  TaskStartEvent,
} from '../src/types'

// ---------------------------------------------------------------------------
// extractJsonSchema
// ---------------------------------------------------------------------------

describe('extractJsonSchema', () => {
  it('returns null when the schema exposes no recognized method', () => {
    // Hand-rolled Standard Schema without introspection
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'custom',
        validate: (v: unknown) => ({ value: v }),
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: minimal bare schema
    expect(extractJsonSchema(schema as any)).toBeNull()
  })

  it('uses toJSONSchema if present (zod-style)', () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'zod',
        validate: (v: unknown) => ({ value: v }),
      },
      toJSONSchema: () => ({ type: 'object', properties: { name: { type: 'string' } } }),
    }
    // biome-ignore lint/suspicious/noExplicitAny: hand-rolled schema
    const out = extractJsonSchema(schema as any) as { type: string; properties: object }
    expect(out.type).toBe('object')
    expect(out.properties).toEqual({ name: { type: 'string' } })
  })

  it('uses .json if present (arktype-style)', () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'arktype',
        validate: (v: unknown) => ({ value: v }),
      },
      json: { type: 'string' },
    }
    // biome-ignore lint/suspicious/noExplicitAny: hand-rolled schema
    expect(extractJsonSchema(schema as any)).toEqual({ type: 'string' })
  })
})

describe('hasObjectProperties / objectPropertyNames', () => {
  it('detects an object schema with properties', () => {
    expect(hasObjectProperties({ type: 'object', properties: { a: {}, b: {} } })).toBe(true)
    expect(objectPropertyNames({ type: 'object', properties: { a: {}, b: {} } })).toEqual([
      'a',
      'b',
    ])
  })

  it('rejects non-object schemas and missing properties', () => {
    expect(hasObjectProperties({ type: 'string' })).toBe(false)
    expect(hasObjectProperties({ type: 'object' })).toBe(false)
    expect(hasObjectProperties(null)).toBe(false)
    expect(objectPropertyNames(null)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// renderRegistrations
// ---------------------------------------------------------------------------

describe('renderRegistrations', () => {
  it('skips entries without a description', () => {
    const p = new PolicyBuilder()
    p.registerFn('describedFn', { fn: () => null, description: 'Has desc.' })
    p.registerFn('hiddenFn', { fn: () => null }) // no description
    const out = renderRegistrations(p.snapshot())
    expect(out).toContain('describedFn')
    expect(out).not.toContain('hiddenFn')
  })

  it('groups by kind and lists members for namespaces', () => {
    const p = new PolicyBuilder()
    p.registerFn('greet', { fn: () => null, description: 'Greet a user.' })
    p.registerNamespace('db', {
      target: { query: () => null, insert: () => null, _internal: () => null },
      description: 'Project database.',
    })
    p.registerTerminal('beep', { description: 'Beep noise.', handler: async () => undefined })
    const out = renderRegistrations(p.snapshot())
    expect(out).toContain('## Functions')
    expect(out).toContain('## Namespaces')
    expect(out).toContain('## Terminal Commands')
    expect(out).toContain('greet')
    expect(out).toContain('Greet a user.')
    expect(out).toContain('db')
    expect(out).toContain('query')
    expect(out).toContain('insert')
    // Default `_*` exclusion hides the underscore-prefixed member
    expect(out).not.toContain('_internal')
    expect(out).toContain('beep')
  })

  it('returns empty string when no described entries', () => {
    const p = new PolicyBuilder()
    p.registerFn('hidden', { fn: () => null })
    expect(renderRegistrations(p.snapshot())).toBe('')
  })
})

// ---------------------------------------------------------------------------
// buildSystemMessage
// ---------------------------------------------------------------------------

describe('buildSystemMessage', () => {
  it('always includes BUILTIN_PRIMER first', () => {
    const p = new PolicyBuilder()
    const msg = buildSystemMessage({ policy: p.snapshot() })
    expect(msg.startsWith('# Agex Agent Environment')).toBe(true)
  })

  it('agexPrimerOverride replaces the builtin primer', () => {
    const p = new PolicyBuilder()
    const msg = buildSystemMessage({
      policy: p.snapshot(),
      agexPrimerOverride: 'CUSTOM PRIMER',
    })
    expect(msg.startsWith('CUSTOM PRIMER')).toBe(true)
    expect(msg).not.toContain('Agex Agent Environment')
  })

  it('capabilitiesPrimer replaces auto-rendered registrations', () => {
    const p = new PolicyBuilder()
    p.registerFn('uniquelyRegisteredName', { fn: () => null, description: 'A registered fn.' })
    const msg = buildSystemMessage({
      policy: p.snapshot(),
      capabilitiesPrimer: 'curated stuff here',
    })
    expect(msg).toContain('# Capabilities Primer')
    expect(msg).toContain('curated stuff here')
    expect(msg).not.toContain('# Registered Resources')
    expect(msg).not.toContain('uniquelyRegisteredName')
  })

  it('lists skills with first-line descriptions', () => {
    const p = new PolicyBuilder()
    p.registerSkill('db_howto', '# Database How-To\n\nUse db.query for SELECTs...')
    const msg = buildSystemMessage({ policy: p.snapshot() })
    expect(msg).toContain('## Skills')
    expect(msg).toContain('db_howto')
    expect(msg).toContain('Database How-To')
    expect(msg).toContain('cat /skills/<name>/SKILL.md')
  })

  it('appends agentPrimer last', () => {
    const p = new PolicyBuilder()
    const msg = buildSystemMessage({ policy: p.snapshot(), agentPrimer: 'I am Tom.' })
    expect(msg.endsWith('I am Tom.')).toBe(true)
  })

  it('omits empty sections cleanly', () => {
    const p = new PolicyBuilder()
    const msg = buildSystemMessage({ policy: p.snapshot() })
    // Just BUILTIN_PRIMER, no other sections. We match the section
    // headers exactly with newline anchors so the BUILTIN_PRIMER's
    // own `### Skills` subsection (a substring of `## Skills`)
    // doesn't trip us up.
    expect(msg).not.toMatch(/^# Registered Resources$/m)
    expect(msg).not.toMatch(/^# Capabilities Primer$/m)
    expect(msg).not.toMatch(/^## Skills$/m)
  })
})

// ---------------------------------------------------------------------------
// buildTaskMessage
// ---------------------------------------------------------------------------

describe('buildTaskMessage', () => {
  it('uses the description and a single-blob fallback when no schema is given', () => {
    const msg = buildTaskMessage({ description: 'Greet the user.' }, { name: 'Ada' })
    expect(msg).toContain('Task: Greet the user.')
    expect(msg).toContain('inputs')
    expect(msg).toContain('Ada')
  })

  it('per-field renders when an object schema is available', () => {
    const inputJsonSchema = {
      type: 'object',
      properties: { name: { type: 'string' }, tone: { type: 'string' } },
    }
    const msg = buildTaskMessage(
      { description: 'Greet.', inputJsonSchema },
      { name: 'Ada', tone: 'casual' },
    )
    expect(msg).toContain('inputs.name = Ada')
    expect(msg).toContain('inputs.tone = casual')
    expect(msg).toContain('Access these values with patterns like `inputs.name`')
  })

  it('renders no-input tasks cleanly', () => {
    const msg = buildTaskMessage({ description: 'Just go.' }, undefined)
    expect(msg).toContain('Task: Just go.')
    expect(msg).toContain('takes no inputs')
  })

  it('renders the expected return from outputJsonSchema', () => {
    const msg = buildTaskMessage(
      { description: 'Sum.', outputJsonSchema: { type: 'number' } },
      undefined,
    )
    expect(msg).toContain('taskSuccess(result)')
    expect(msg).toContain('"type": "number"')
  })

  it('falls back to outputDescription prose', () => {
    const msg = buildTaskMessage(
      {
        description: 'Sum.',
        outputDescription: 'a single number — the sum of inputs',
      },
      undefined,
    )
    expect(msg).toContain('a single number — the sum of inputs')
  })

  it('generic fallback when no shape info available', () => {
    const msg = buildTaskMessage({ description: 'Open ended.' }, undefined)
    expect(msg).toContain('whatever value satisfies the task')
  })
})

// ---------------------------------------------------------------------------
// renderEvents
// ---------------------------------------------------------------------------

const ts = '2026-05-05T00:00:00.000Z'
const action = (idx: number, code: string): ActionEvent => ({
  type: 'action',
  timestamp: `2026-05-05T00:00:0${idx}.000Z`,
  agentName: 'a',
  emissions: [{ type: 'ts', code }],
})

describe('renderEvents', () => {
  it('skips TaskStartEvent (handled by buildTaskMessage)', () => {
    const events: AgentEvent[] = [
      {
        type: 'taskStart',
        timestamp: ts,
        agentName: 'a',
        taskName: 't',
        inputs: null,
      } as TaskStartEvent,
    ]
    expect(renderEvents(events)).toEqual([])
  })

  it('renders ActionEvent as an assistant turn with toolUse parts + synth tool_result', () => {
    const turns = renderEvents([action(1, 'one')])
    // Two turns: the assistant tool_use, plus the user tool_result
    // ("(no observation)" for a silent ts emission). Every tool_use
    // must have a paired tool_result, so the renderer never leaves
    // the trailing tool_use unmatched.
    expect(turns.length).toBe(2)
    expect(turns[0]?.role).toBe('assistant')
    const part = turns[0]?.content[0]
    expect(part?.type).toBe('toolUse')
    if (part?.type === 'toolUse') {
      expect(part.toolName).toBe('ts_action')
      expect(part.input.code).toBe('one')
    }
    expect(turns[1]?.role).toBe('user')
    const result = turns[1]?.content[0]
    expect(result?.type).toBe('toolResult')
    if (result?.type === 'toolResult' && result.content[0]?.type === 'text') {
      expect(result.content[0].text).toBe('ts_action: (no observation)')
    }
  })

  it('ties OutputEvent back to its emissionId as a tool_result', () => {
    const actionTs = '2026-05-05T00:00:01.000Z'
    const emissionId = makeToolUseId(actionTs, 0)
    const events: AgentEvent[] = [
      action(1, 'one'),
      {
        type: 'output',
        timestamp: '2026-05-05T00:00:02.000Z',
        agentName: 'a',
        emissionId,
        parts: [{ type: 'text', text: 'stdout' }],
      } as OutputEvent,
    ]
    const turns = renderEvents(events)
    expect(turns.length).toBe(2)
    const result = turns[1]?.content[0]
    expect(result?.type).toBe('toolResult')
    if (result?.type === 'toolResult') {
      expect(result.toolUseId).toBe(emissionId)
      const text = result.content[0]
      if (text?.type === 'text') expect(text.text).toContain('stdout')
    }
  })

  it('falls back to the most recent tool_use when output has no emissionId', () => {
    // Legacy / unstamped OutputEvents still pair to *something*, so
    // providers don't see a dangling tool_use.
    const events: AgentEvent[] = [
      action(1, 'one'),
      {
        type: 'output',
        timestamp: '2026-05-05T00:00:02.000Z',
        agentName: 'a',
        parts: [{ type: 'text', text: 'unstamped' }],
      } as OutputEvent,
    ]
    const turns = renderEvents(events)
    expect(turns.length).toBe(2)
    const result = turns[1]?.content[0]
    if (result?.type === 'toolResult') {
      expect(result.toolUseId).toBe(makeToolUseId('2026-05-05T00:00:01.000Z', 0))
    }
  })

  it('renders ChapterEvent as an assistant text turn with the path hint', () => {
    const events: AgentEvent[] = [
      {
        type: 'chapter',
        timestamp: ts,
        agentName: 'a',
        name: 'Phase 1',
        message: 'did stuff',
        slug: 'phase-1',
        eventRefs: ['ref-a', 'ref-b'],
      } as ChapterEvent,
    ]
    const turns = renderEvents(events)
    expect(turns[0]?.role).toBe('assistant')
    const part = turns[0]?.content[0]
    expect(part?.type).toBe('text')
    if (part?.type === 'text') {
      expect(part.text).toContain('📖 Chapter')
      expect(part.text).toContain('Phase 1')
      expect(part.text).toContain('did stuff')
      expect(part.text).toContain('/chapters/phase-1/')
    }
  })

  it('skips terminal/metadata events', () => {
    const events: AgentEvent[] = [
      { type: 'success', timestamp: ts, agentName: 'a', result: 1 },
      { type: 'fail', timestamp: ts, agentName: 'a', message: 'nope' },
      { type: 'systemNote', timestamp: ts, agentName: 'a', message: 'noted' },
      {
        type: 'cancelled',
        timestamp: ts,
        agentName: 'a',
        taskName: 't',
        iterationsCompleted: 0,
      },
    ]
    expect(renderEvents(events)).toEqual([])
  })
})

describe('renderEvents — emission variants', () => {
  it('terminal emission becomes a terminal_action toolUse', () => {
    const ev: ActionEvent = {
      type: 'action',
      timestamp: ts,
      agentName: 'a',
      emissions: [{ type: 'terminal', commands: 'ls /', thinking: 'glance' }],
    }
    const turns = renderEvents([ev])
    const part = turns[0]?.content[0]
    expect(part?.type).toBe('toolUse')
    if (part?.type === 'toolUse') {
      expect(part.toolName).toBe('terminal_action')
      expect(part.input.commands).toBe('ls /')
      expect(part.input.thinking).toBe('glance')
    }
  })

  it('fileWrite + fileEdit become write_file / edit_file toolUses', () => {
    const ev: ActionEvent = {
      type: 'action',
      timestamp: ts,
      agentName: 'a',
      emissions: [
        { type: 'fileWrite', path: '/n.txt', content: 'hi', mode: 'write' },
        { type: 'fileEdit', path: '/n.txt', search: 'hi', content: 'bye', matchAll: true },
      ],
    }
    const turn = renderEvents([ev])[0]
    expect(turn?.content.length).toBe(2)
    const w = turn?.content[0]
    const e = turn?.content[1]
    if (w?.type === 'toolUse') {
      expect(w.toolName).toBe('write_file')
      expect(w.input.mode).toBe('write')
    } else throw new Error('expected toolUse')
    if (e?.type === 'toolUse') {
      expect(e.toolName).toBe('edit_file')
      expect(e.input.matchAll).toBe(true)
    } else throw new Error('expected toolUse')
  })

  it('text emission becomes a text part', () => {
    const ev: ActionEvent = {
      type: 'action',
      timestamp: ts,
      agentName: 'a',
      emissions: [{ type: 'text', text: 'aside to the user' }],
    }
    const part = renderEvents([ev])[0]?.content[0]
    expect(part?.type).toBe('text')
    if (part?.type === 'text') expect(part.text).toBe('aside to the user')
  })

  it('thinking emission becomes a thinking part with redacted + signature', () => {
    const sig = new Uint8Array([1, 2, 3])
    const ev: ActionEvent = {
      type: 'action',
      timestamp: ts,
      agentName: 'a',
      emissions: [{ type: 'thinking', text: 'hmm', redacted: false, signature: sig }],
    }
    const part = renderEvents([ev])[0]?.content[0]
    expect(part?.type).toBe('thinking')
    if (part?.type === 'thinking') {
      expect(part.text).toBe('hmm')
      expect(part.redacted).toBe(false)
      expect(part.signature).toBe(sig)
    }
  })

  it('OutputEvent without a prior ActionEvent renders as a plain user message', () => {
    const events: AgentEvent[] = [
      {
        type: 'output',
        timestamp: ts,
        agentName: 'a',
        parts: [
          { type: 'text', text: 'orphan output' },
          { type: 'image', format: 'png', data: 'b64stuff', altText: 'a chart' },
        ],
      } as OutputEvent,
    ]
    const turn = renderEvents(events)[0]
    expect(turn?.role).toBe('user')
    expect(turn?.content[0]?.type).toBe('text')
    expect(turn?.content[1]?.type).toBe('image')
  })
})

describe('renderEvents — tool_use ↔ tool_result pairing', () => {
  // Provider invariant: every tool_use part in an assistant turn must
  // have a tool_result part with the matching id in the *next* user
  // turn, and providers reject multiple consecutive user turns of
  // tool_results. These tests pin those invariants down so the
  // upcoming Anthropic provider doesn't have to relearn them.

  function collectToolUseIds(turns: ReturnType<typeof renderEvents>): Set<string> {
    const ids = new Set<string>()
    for (const t of turns) {
      if (t.role !== 'assistant') continue
      for (const p of t.content) {
        if (p.type === 'toolUse') ids.add(p.toolUseId)
      }
    }
    return ids
  }

  function collectToolResultIds(turns: ReturnType<typeof renderEvents>): Set<string> {
    const ids = new Set<string>()
    for (const t of turns) {
      if (t.role !== 'user') continue
      for (const p of t.content) {
        if (p.type === 'toolResult') ids.add(p.toolUseId)
      }
    }
    return ids
  }

  it('every tool_use gets a matching tool_result, even with no output', () => {
    const ev: ActionEvent = {
      type: 'action',
      timestamp: ts,
      agentName: 'a',
      emissions: [
        { type: 'thinking', text: 'plan' },
        { type: 'fileWrite', path: '/n', content: 'hi', mode: 'write' },
        { type: 'terminal', commands: 'ls /' },
        { type: 'ts', code: '/* silent */' },
      ],
    }
    const turns = renderEvents([ev])
    const useIds = collectToolUseIds(turns)
    const resultIds = collectToolResultIds(turns)
    expect(useIds.size).toBe(3) // thinking is not a tool_use
    expect(resultIds).toEqual(useIds)
  })

  it('multiple OutputEvents collapse into one user turn (no split tool_results)', () => {
    const t0 = '2026-05-05T00:00:01.000Z'
    const ev: ActionEvent = {
      type: 'action',
      timestamp: t0,
      agentName: 'a',
      emissions: [
        { type: 'terminal', commands: 'echo a' },
        { type: 'terminal', commands: 'echo b' },
      ],
    }
    const events: AgentEvent[] = [
      ev,
      {
        type: 'output',
        timestamp: '2026-05-05T00:00:02.000Z',
        agentName: 'a',
        emissionId: makeToolUseId(t0, 0),
        parts: [{ type: 'text', text: 'a' }],
      },
      {
        type: 'output',
        timestamp: '2026-05-05T00:00:03.000Z',
        agentName: 'a',
        emissionId: makeToolUseId(t0, 1),
        parts: [{ type: 'text', text: 'b' }],
      },
    ]
    const turns = renderEvents(events)
    // Exactly: assistant (action) + user (both tool_results)
    expect(turns.length).toBe(2)
    expect(turns[1]?.role).toBe('user')
    const userParts = turns[1]?.content ?? []
    const toolResultCount = userParts.filter((p) => p.type === 'toolResult').length
    expect(toolResultCount).toBe(2)
  })

  it('fileWrite/fileEdit get synthesized "wrote /path" tool_results on success', () => {
    const ev: ActionEvent = {
      type: 'action',
      timestamp: ts,
      agentName: 'a',
      emissions: [
        { type: 'fileWrite', path: '/a.txt', content: 'x', mode: 'write' },
        { type: 'fileWrite', path: '/b.txt', content: 'y', mode: 'append' },
        { type: 'fileEdit', path: '/c.txt', search: 'old', content: 'new', matchAll: true },
      ],
    }
    const turns = renderEvents([ev])
    const userTurn = turns[1]
    expect(userTurn?.role).toBe('user')
    const texts = (userTurn?.content ?? [])
      .flatMap((p) => (p.type === 'toolResult' ? p.content : []))
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
    expect(texts.some((t) => t.includes('write_file: wrote /a.txt'))).toBe(true)
    expect(texts.some((t) => t.includes('write_file: appended to /b.txt'))).toBe(true)
    expect(texts.some((t) => t.includes('edit_file: replace applied to /c.txt (matchAll)'))).toBe(
      true,
    )
  })

  it('real observations override the synth fallback (failed file ops)', () => {
    // If a fileEdit fails and its error lands as an OutputEvent on
    // the same emissionId, the renderer must NOT also paste in the
    // synth "success" line — that would tell the agent the edit
    // succeeded when it didn't.
    const t0 = '2026-05-05T00:00:01.000Z'
    const ev: ActionEvent = {
      type: 'action',
      timestamp: t0,
      agentName: 'a',
      emissions: [{ type: 'fileEdit', path: '/c.txt', search: 'old', content: 'new' }],
    }
    const events: AgentEvent[] = [
      ev,
      {
        type: 'output',
        timestamp: '2026-05-05T00:00:02.000Z',
        agentName: 'a',
        emissionId: makeToolUseId(t0, 0),
        parts: [{ type: 'text', text: 'edit_file: search not found' }],
      },
    ]
    const turns = renderEvents(events)
    const result = turns[1]?.content[0]
    if (result?.type === 'toolResult' && result.content[0]?.type === 'text') {
      expect(result.content[0].text).toContain('search not found')
      expect(result.content[0].text).not.toContain('replace applied')
    } else {
      throw new Error('expected toolResult with text content')
    }
  })

  it('chapter forces a flush so tool_results land before the chapter turn', () => {
    const t0 = '2026-05-05T00:00:01.000Z'
    const events: AgentEvent[] = [
      {
        type: 'action',
        timestamp: t0,
        agentName: 'a',
        emissions: [{ type: 'terminal', commands: 'echo hi' }],
      },
      {
        type: 'output',
        timestamp: '2026-05-05T00:00:02.000Z',
        agentName: 'a',
        emissionId: makeToolUseId(t0, 0),
        parts: [{ type: 'text', text: 'hi' }],
      },
      {
        type: 'chapter',
        timestamp: '2026-05-05T00:00:03.000Z',
        agentName: 'a',
        name: 'P1',
        message: 'm',
        slug: 'p1',
        eventRefs: [],
      },
    ]
    const turns = renderEvents(events)
    // assistant(action), user(toolResult), assistant(chapter)
    expect(turns.map((t) => t.role)).toEqual(['assistant', 'user', 'assistant'])
  })
})

describe('renderRegistrations — classes with members', () => {
  it('lists class methods with descriptions from configure', () => {
    class MyClass {
      run(): number {
        return 1
      }
      reset(): void {
        // empty
      }
    }
    const p = new PolicyBuilder()
    p.registerCls('MyClass', {
      cls: MyClass as unknown as new (...args: unknown[]) => unknown,
      description: 'A demo class.',
      configure: { run: { description: 'Run once.' } },
    })
    const out = renderRegistrations(p.snapshot())
    expect(out).toContain('## Classes')
    expect(out).toContain('MyClass')
    expect(out).toContain('A demo class.')
    expect(out).toContain('run')
    expect(out).toContain('Run once.')
    expect(out).toContain('reset')
  })

  it('non-constructable classes get a hint', () => {
    class StaticOnly {}
    const p = new PolicyBuilder()
    p.registerCls('StaticOnly', {
      cls: StaticOnly as unknown as new (...args: unknown[]) => unknown,
      description: 'Static API.',
      constructable: false,
    })
    expect(renderRegistrations(p.snapshot())).toContain('not constructable')
  })

  it('live: true namespace gets a proxy hint', () => {
    const p = new PolicyBuilder()
    p.registerNamespace('db', {
      target: { query: () => null },
      description: 'Live db.',
      live: true,
    })
    expect(renderRegistrations(p.snapshot())).toContain('live host instance')
  })
})

describe('extractJsonSchema — error paths', () => {
  it('catches a throwing toJSONSchema and falls back to null', () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'broken',
        validate: (v: unknown) => ({ value: v }),
      },
      toJSONSchema: () => {
        throw new Error('unsupported')
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: hand-rolled schema
    expect(extractJsonSchema(schema as any)).toBeNull()
  })

  it('catches a throwing toJsonSchema (lowercase variant)', () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'broken',
        validate: (v: unknown) => ({ value: v }),
      },
      toJsonSchema: () => {
        throw new Error('unsupported')
      },
    }
    // biome-ignore lint/suspicious/noExplicitAny: hand-rolled schema
    expect(extractJsonSchema(schema as any)).toBeNull()
  })

  it('uses toJsonSchema (lowercase) when present', () => {
    const schema = {
      '~standard': {
        version: 1 as const,
        vendor: 'valibot-ish',
        validate: (v: unknown) => ({ value: v }),
      },
      toJsonSchema: () => ({ type: 'array' }),
    }
    // biome-ignore lint/suspicious/noExplicitAny: hand-rolled schema
    expect(extractJsonSchema(schema as any)).toEqual({ type: 'array' })
  })
})

describe('makeToolUseId', () => {
  it('is stable across calls', () => {
    expect(makeToolUseId(ts, 0)).toBe(makeToolUseId(ts, 0))
    expect(makeToolUseId(ts, 0)).not.toBe(makeToolUseId(ts, 1))
  })

  it('replaces ISO separators with underscores', () => {
    const id = makeToolUseId('2026-05-05T00:00:00.000Z', 3)
    expect(id).not.toContain(':')
    expect(id).not.toContain('.')
    expect(id).not.toContain('-')
    expect(id.endsWith('_3')).toBe(true)
  })
})

describe('BUILTIN_PRIMER', () => {
  it('mentions the load-bearing concepts', () => {
    expect(BUILTIN_PRIMER).toContain('ts_action')
    expect(BUILTIN_PRIMER).toContain('terminal_action')
    expect(BUILTIN_PRIMER).toContain('taskSuccess')
    expect(BUILTIN_PRIMER).toContain('taskFail')
    expect(BUILTIN_PRIMER).toContain('taskClarify')
    expect(BUILTIN_PRIMER).toContain('viewImage')
    expect(BUILTIN_PRIMER).toContain('cache')
    expect(BUILTIN_PRIMER).toContain('inputs')
    expect(BUILTIN_PRIMER).toContain('/chapters/')
    expect(BUILTIN_PRIMER).toContain('/skills/')
  })
})

// ---------------------------------------------------------------------------
// Type-level: NeutralTurn shape compiles
// ---------------------------------------------------------------------------

describe('NeutralTurn type', () => {
  it('discriminated parts narrow as expected', () => {
    const turn: NeutralTurn = {
      role: 'user',
      content: [{ type: 'text', text: 'hi' }],
    }
    const part = turn.content[0]
    if (part?.type === 'text') {
      expect(part.text).toBe('hi')
    } else {
      throw new Error('did not narrow')
    }
  })
})

// ---------------------------------------------------------------------------
// toolSchemas
// ---------------------------------------------------------------------------

describe('toolSchemas', () => {
  function findSchema(name: string, schemas: ReturnType<typeof toolSchemas>) {
    const s = schemas.find((x) => x.name === name)
    if (s === undefined) throw new Error(`schema ${name} not found`)
    return s
  }

  function getProps(name: string, schemas: ReturnType<typeof toolSchemas>): string[] {
    const params = findSchema(name, schemas).parameters as {
      properties?: Record<string, unknown>
    }
    return Object.keys(params.properties ?? {})
  }

  function getRequired(name: string, schemas: ReturnType<typeof toolSchemas>): string[] {
    const params = findSchema(name, schemas).parameters as { required?: string[] }
    return params.required ?? []
  }

  it('returns the four agex action tools in stable order', () => {
    const schemas = toolSchemas()
    expect(schemas.map((s) => s.name)).toEqual([
      TOOL_TS,
      TOOL_TERMINAL,
      TOOL_WRITE_FILE,
      TOOL_EDIT_FILE,
    ])
  })

  it('non-native variant keeps the thinking parameter on action tools', () => {
    const schemas = toolSchemas()
    expect(getProps(TOOL_TS, schemas)).toContain('thinking')
    expect(getRequired(TOOL_TS, schemas)).toContain('thinking')
    expect(getProps(TOOL_TERMINAL, schemas)).toContain('thinking')
    expect(getRequired(TOOL_TERMINAL, schemas)).toContain('thinking')
  })

  it('nativeThinking strips thinking from action tools but keeps title + code/commands', () => {
    const schemas = toolSchemas({ nativeThinking: true })
    expect(getProps(TOOL_TS, schemas)).not.toContain('thinking')
    expect(getRequired(TOOL_TS, schemas)).not.toContain('thinking')
    expect(getProps(TOOL_TS, schemas)).toEqual(expect.arrayContaining(['title', 'code']))
    expect(getRequired(TOOL_TS, schemas)).toEqual(expect.arrayContaining(['title', 'code']))
    expect(getProps(TOOL_TERMINAL, schemas)).not.toContain('thinking')
    expect(getProps(TOOL_TERMINAL, schemas)).toEqual(expect.arrayContaining(['title', 'commands']))
  })

  it('file tools are identical between native and non-native modes', () => {
    const plain = toolSchemas()
    const native = toolSchemas({ nativeThinking: true })
    expect(findSchema(TOOL_WRITE_FILE, plain)).toEqual(findSchema(TOOL_WRITE_FILE, native))
    expect(findSchema(TOOL_EDIT_FILE, plain)).toEqual(findSchema(TOOL_EDIT_FILE, native))
  })

  it('edit_file uses content (not replace) and matchAll (camelCase) to match the renderer', () => {
    // Tool input keys MUST match what render/index.ts puts into tool_use
    // input objects, otherwise the model emits a tool call the renderer
    // can't roundtrip. This pins down the contract.
    const props = getProps(TOOL_EDIT_FILE, toolSchemas())
    expect(props).toEqual(expect.arrayContaining(['path', 'search', 'content', 'matchAll']))
    expect(props).not.toContain('replace')
    expect(props).not.toContain('match_all')
  })

  it('write_file declares the mode enum', () => {
    const write = findSchema(TOOL_WRITE_FILE, toolSchemas())
    const params = write.parameters as { properties: { mode: { enum: string[] } } }
    expect(params.properties.mode.enum).toEqual(['write', 'append'])
  })
})
