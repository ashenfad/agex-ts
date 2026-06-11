import { describe, expect, it } from 'vitest'
import {
  PathPlanner,
  RELOCATION_ROOT,
  SIDECAR_PATH,
  escapeSegment,
  naturalPath,
  relocatedPath,
} from '../src/github/index'

/** Would git/GitHub accept this tree path? Mirrors the constraints the
 *  live suite pinned (`.git` rejected) plus git's own path rules. */
function isValidTreePath(path: string): boolean {
  if (path.length === 0) return false
  const segments = path.split('/')
  return segments.every(
    (seg) =>
      seg.length > 0 &&
      seg !== '.' &&
      seg !== '..' &&
      !/^\.git$/i.test(seg) &&
      !seg.endsWith('.') &&
      !seg.endsWith(' ') &&
      // biome-ignore lint/suspicious/noControlCharactersInRegex: validating their absence
      !/[\x00-\x1f\x7f]/.test(seg),
  )
}

describe('escapeSegment / naturalPath', () => {
  it('leaves ordinary segments alone and preserves nesting', () => {
    expect(naturalPath('files/notes/a.txt')).toBe('files/notes/a.txt')
    expect(naturalPath('__event_log__')).toBe('__event_log__')
    expect(naturalPath('cache/results:42')).toBe('cache/results:42')
  })

  it('escapes the dangerous segments', () => {
    expect(escapeSegment('.git')).toBe('%2Egit')
    expect(escapeSegment('.GIT')).toBe('%2EGIT')
    expect(escapeSegment('.')).toBe('%2E')
    expect(escapeSegment('..')).toBe('%2E%2E') // name AND trailing rules compose
    expect(escapeSegment('')).toBe('%')
    expect(escapeSegment('trailing.')).toBe('trailing%2E')
    expect(escapeSegment('trailing ')).toBe('trailing%20')
    expect(escapeSegment('50%off')).toBe('50%25off')
    expect(escapeSegment('.github')).toBe('.github') // NOT .git
  })

  it('reserves .kvgit and _kv at the root only', () => {
    expect(naturalPath('.kvgit/commit.json')).toBe('%2Ekvgit/commit.json')
    expect(naturalPath('_kv/anything')).toBe('%5Fkv/anything')
    expect(naturalPath('nested/_kv/x')).toBe('nested/_kv/x')
    expect(naturalPath('nested/.kvgit')).toBe('nested/.kvgit')
  })

  it('handles empty segments from slashes', () => {
    expect(naturalPath('a//b')).toBe('a/%/b')
    expect(naturalPath('/leading')).toBe('%/leading')
    expect(naturalPath('trailing/')).toBe('trailing/%')
  })

  it('relocatedPath flattens the whole key into one segment', () => {
    expect(relocatedPath('a/b/c')).toBe(`${RELOCATION_ROOT}/a%2Fb%2Fc`)
    expect(relocatedPath('100%/done.')).toBe(`${RELOCATION_ROOT}/100%25%2Fdone%2E`)
    // Special names need escaping in the flat zone too.
    expect(relocatedPath('.git')).toBe(`${RELOCATION_ROOT}/%2Egit`)
    expect(relocatedPath('..')).toBe(`${RELOCATION_ROOT}/%2E%2E`)
  })

  it('property sweep: adversarial keys yield valid, distinct paths', () => {
    // Deterministic pseudo-random keys built from hostile fragments.
    const fragments = [
      '.git',
      '..',
      '.',
      '',
      '%',
      '%2E',
      '_kv',
      '.kvgit',
      'a',
      'b.',
      'c ',
      '',
      'ok',
    ]
    const keys = new Set<string>()
    let seed = 42
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed
    }
    for (let i = 0; i < 500; i++) {
      const parts: string[] = []
      const len = 1 + (next() % 4)
      for (let j = 0; j < len; j++) parts.push(fragments[next() % fragments.length] as string)
      keys.add(parts.join('/'))
    }

    const naturals = new Map<string, string>()
    for (const key of keys) {
      const nat = naturalPath(key)
      const rel = relocatedPath(key)
      expect(isValidTreePath(nat), `natural for ${JSON.stringify(key)}: ${nat}`).toBe(true)
      expect(isValidTreePath(rel), `relocated for ${JSON.stringify(key)}: ${rel}`).toBe(true)
      expect(nat.startsWith(`${RELOCATION_ROOT}/`)).toBe(false) // zone protected
      expect(nat).not.toBe(SIDECAR_PATH)
      naturals.set(key, nat)
    }
    // Injectivity: distinct keys, distinct paths (both mappings).
    expect(new Set(naturals.values()).size).toBe(naturals.size)
    expect(new Set([...keys].map(relocatedPath)).size).toBe(keys.size)
  })
})

describe('PathPlanner', () => {
  it('gives natural paths when free, relocates on file/dir conflicts', () => {
    const planner = new PathPlanner()
    expect(planner.assign('a')).toBe('a')
    // 'a' is a file; 'a/b' needs 'a' to be a directory → relocate.
    expect(planner.assign('a/b')).toBe(`${RELOCATION_ROOT}/a%2Fb`)

    expect(planner.assign('c/d')).toBe('c/d')
    // 'c' is a directory; key 'c' wants a file there → relocate.
    expect(planner.assign('c')).toBe(`${RELOCATION_ROOT}/c`)
  })

  it('assignments are stable: re-assigning returns the same path', () => {
    const planner = new PathPlanner()
    expect(planner.assign('x/y')).toBe('x/y')
    expect(planner.assign('x/y')).toBe('x/y')
    // Even after a would-be conflict appears, the original keeps its spot.
    expect(planner.assign('x')).toBe(`${RELOCATION_ROOT}/x`)
    expect(planner.assign('x/y')).toBe('x/y')
  })

  it('remove frees file slots and refcounted directory prefixes', () => {
    const planner = new PathPlanner()
    planner.assign('a')
    planner.remove('a')
    expect(planner.assign('a/b')).toBe('a/b') // slot freed

    planner.assign('x/1')
    planner.assign('x/2')
    planner.remove('x/1')
    // 'x' still a directory (x/2 remains) → key 'x' relocates.
    expect(planner.assign('x')).toBe(`${RELOCATION_ROOT}/x`)
    planner.remove('x')
    planner.remove('x/2')
    // Directory fully empty now → 'x' is free again.
    expect(planner.assign('x')).toBe('x')
  })

  it('seeds from prior assignments (incl. relocated ones)', () => {
    const original = new PathPlanner()
    original.assign('a')
    original.assign('a/b') // relocated
    const revived = PathPlanner.fromAssignments(original.entries())
    expect(revived.get('a/b')).toBe(`${RELOCATION_ROOT}/a%2Fb`)
    // Conflict state carried over: 'a' is still a file, so a new
    // nested key under it relocates.
    expect(revived.assign('a/c')).toBe(`${RELOCATION_ROOT}/a%2Fc`)
  })

  it('replays identically for the same operation sequence', () => {
    const ops = ['m', 'm/n', 'q/r', 'q', 'm', 'z'] as const
    const run = () => {
      const p = new PathPlanner()
      return ops.map((k) => p.assign(k))
    }
    expect(run()).toEqual(run())
  })
})
