import { describe, expect, it } from 'vitest'
import { PolicyBuilder } from '../src/policy'
import {
  BUILTIN_PRIMER,
  type NeutralTurn,
  buildSystemMessage,
  buildTaskMessage,
  extractJsonSchema,
  hasObjectProperties,
  makeToolUseId,
  objectPropertyNames,
  renderEvents,
  renderRegistrations,
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

  it('renders ActionEvent as an assistant turn with toolUse parts', () => {
    const turns = renderEvents([action(1, 'one')])
    expect(turns.length).toBe(1)
    expect(turns[0]?.role).toBe('assistant')
    const part = turns[0]?.content[0]
    expect(part?.type).toBe('toolUse')
    if (part?.type === 'toolUse') {
      expect(part.toolName).toBe('ts_action')
      expect(part.input.code).toBe('one')
    }
  })

  it('ties OutputEvent back to the prior tool_use as a tool_result', () => {
    const events: AgentEvent[] = [
      action(1, 'one'),
      {
        type: 'output',
        timestamp: '2026-05-05T00:00:02.000Z',
        agentName: 'a',
        parts: [{ type: 'text', text: 'stdout' }],
      } as OutputEvent,
    ]
    const turns = renderEvents(events)
    expect(turns.length).toBe(2)
    const result = turns[1]?.content[0]
    expect(result?.type).toBe('toolResult')
    if (result?.type === 'toolResult') {
      // Same tool-use id derivation as the corresponding action
      expect(result.toolUseId).toBe(makeToolUseId('2026-05-05T00:00:01.000Z', 0))
      expect(result.content[0]?.type).toBe('text')
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
