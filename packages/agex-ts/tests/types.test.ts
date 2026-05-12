import { describe, expect, it } from 'vitest'
import { CancelledError, TaskFailError, TransientError, isTaskControlError } from '../src/errors'
import type { AgentEvent, Emission, ExecResult, TokenChunk } from '../src/types'

describe('errors — task-control brand', () => {
  it('marks task-control variants', () => {
    expect(isTaskControlError(new TaskFailError('nope'))).toBe(true)
    expect(isTaskControlError(new CancelledError())).toBe(true)
  })

  it('rejects ordinary errors', () => {
    expect(isTaskControlError(new Error('plain'))).toBe(false)
    expect(isTaskControlError(new TransientError('flaky'))).toBe(false)
    expect(isTaskControlError(null)).toBe(false)
    expect(isTaskControlError({})).toBe(false)
  })

  it('detects branded errors across realms (synthetic plain object)', () => {
    // Worker-thrown errors arrive as plain objects after structured-clone;
    // the brand survives because it's an own-enumerable string property.
    const planeWreck = { name: 'TaskFailError', message: 'gone', __agex_task_control__: 'fail' }
    expect(isTaskControlError(planeWreck)).toBe(true)
  })
})

describe('errors — cause + retry hint', () => {
  it('TransientError carries cause and retryAfterMs', () => {
    const cause = new Error('socket timeout')
    const e = new TransientError('rate limited', { cause, retryAfterMs: 1500 })
    expect(e.retryAfterMs).toBe(1500)
    expect(e.cause).toBe(cause)
  })
})

describe('types — discriminated unions are usable', () => {
  it('Emission.type narrows correctly', () => {
    const em: Emission = { type: 'ts', code: 'console.log(1)' }
    if (em.type === 'ts') {
      expect(em.code).toBe('console.log(1)')
    } else {
      throw new Error('did not narrow')
    }
  })

  it('AgentEvent.type narrows correctly', () => {
    const ev: AgentEvent = {
      type: 'success',
      timestamp: '2026-05-05T00:00:00.000Z',
      agentName: 'test',
      result: 42,
    }
    if (ev.type === 'success') {
      expect(ev.result).toBe(42)
    } else {
      throw new Error('did not narrow')
    }
  })

  it('ExecResult outcome union narrows', () => {
    const r: ExecResult = {
      outcome: { kind: 'success', value: 'done' },
      outputs: [],
      error: null,
      elapsedMs: 12,
    }
    if (r.outcome.kind === 'success') {
      expect(r.outcome.value).toBe('done')
    } else {
      throw new Error('did not narrow')
    }
  })

  it('TokenChunk shape compiles', () => {
    const t: TokenChunk = {
      type: 'thinking',
      content: 'hmm',
      done: false,
      emissionIndex: 0,
    }
    expect(t.content).toBe('hmm')
  })
})
