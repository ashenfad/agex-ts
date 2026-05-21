import { Staged, type Versioned, VersionedKV } from '@agex-ts/kvgit'
import { Memory } from '@agex-ts/kvgit/backends/memory'
import { polymorphicDecoder, polymorphicEncoder } from '@agex-ts/termish/fs/kvgit'
import { beforeEach, describe, expect, it } from 'vitest'
import { Metadata } from '../src/metadata'
import {
  InvalidRef,
  allAgentCommits,
  allAncestors,
  isAgentCommit,
  mergeBase,
  resolveRef,
  virtualParents,
  walkVirtualAncestry,
} from '../src/refs'

async function makeStore(): Promise<{ vkv: Versioned; staged: Staged }> {
  const vkv = await VersionedKV.open(new Memory())
  const staged = new Staged(vkv, { encoder: polymorphicEncoder, decoder: polymorphicDecoder })
  return { vkv, staged }
}

/** Make an agent commit with virtualBranch / virtualParents annotations. */
async function agentCommit(
  staged: Staged,
  key: string,
  value: string,
  message: string,
  opts: { virtualBranch?: string; virtualParents?: ReadonlyArray<string> } = {},
): Promise<string> {
  staged.set(key, value)
  const result = await staged.commit({
    info: {
      message,
      virtualBranch: opts.virtualBranch ?? 'main',
      virtualParents: [...(opts.virtualParents ?? [])],
    },
  })
  return result.commit as string
}

/** Make a framework-style commit (no message in info). */
async function systemCommit(staged: Staged, key: string, value: string): Promise<string> {
  staged.set(key, value)
  const result = await staged.commit({})
  return result.commit as string
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of it) out.push(v)
  return out
}

let vkv: Versioned
let staged: Staged
beforeEach(async () => {
  ;({ vkv, staged } = await makeStore())
})

describe('isAgentCommit / allAgentCommits', () => {
  it('messaged commit is an agent commit', async () => {
    const h = await agentCommit(staged, 'a', '1', 'hello')
    expect(await isAgentCommit(vkv, h)).toBe(true)
  })

  it('unmessaged commit is not an agent commit', async () => {
    const h = await systemCommit(staged, 'a', '1')
    expect(await isAgentCommit(vkv, h)).toBe(false)
  })

  it('allAgentCommits filters out system commits, newest-first', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    await systemCommit(staged, 'b', '2')
    const c = await agentCommit(staged, 'c', '3', 'second')
    const all = await allAgentCommits(vkv)
    expect(new Set(all)).toEqual(new Set([a, c]))
    expect(all.indexOf(c)).toBeLessThan(all.indexOf(a))
  })
})

describe('virtualParents', () => {
  it('returns [] for a commit with no recorded parents', async () => {
    const h = await agentCommit(staged, 'a', '1', 'init')
    expect(await virtualParents(vkv, h)).toEqual([])
  })

  it('returns the single recorded parent', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const b = await agentCommit(staged, 'a', '2', 'second', { virtualParents: [a] })
    expect(await virtualParents(vkv, b)).toEqual([a])
  })

  it('returns both parents for a merge commit', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const b = await agentCommit(staged, 'b', '2', 'branch', { virtualParents: [a] })
    const merge = await agentCommit(staged, 'c', '3', 'merge', { virtualParents: [b, a] })
    expect(await virtualParents(vkv, merge)).toEqual([b, a])
  })

  it('system commits have no virtual parents', async () => {
    const h = await systemCommit(staged, 'a', '1')
    expect(await virtualParents(vkv, h)).toEqual([])
  })
})

describe('walkVirtualAncestry', () => {
  it('unborn HEAD yields nothing', async () => {
    expect(await collect(walkVirtualAncestry(vkv, null))).toEqual([])
  })

  it('root-only chain yields just the root', async () => {
    const a = await agentCommit(staged, 'a', '1', 'init')
    expect(await collect(walkVirtualAncestry(vkv, a))).toEqual([a])
  })

  it('linear chain yields newest-first', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const b = await agentCommit(staged, 'a', '2', 'second', { virtualParents: [a] })
    const c = await agentCommit(staged, 'a', '3', 'third', { virtualParents: [b] })
    expect(await collect(walkVirtualAncestry(vkv, c))).toEqual([c, b, a])
  })

  it('skips system commits between agent commits', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    await systemCommit(staged, 'b', 'sys')
    const c = await agentCommit(staged, 'a', '2', 'third', { virtualParents: [a] })
    expect(await collect(walkVirtualAncestry(vkv, c))).toEqual([c, a])
  })

  it('follows first-parent only through a merge', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const b = await agentCommit(staged, 'b', '1', 'branch', { virtualParents: [a] })
    const c = await agentCommit(staged, 'a', '2', 'main2', { virtualParents: [a] })
    const merge = await agentCommit(staged, 'c', '3', 'merge', { virtualParents: [c, b] })
    expect(await collect(walkVirtualAncestry(vkv, merge))).toEqual([merge, c, a])
  })

  it('does not loop forever on a synthesised cycle', async () => {
    // Real stores can't produce a cycle (content addressing forbids
    // it), but a corrupt store shouldn't deadlock the CLI. Build a
    // fake Versioned whose commitInfo simulates a → b → a → ...
    const fakeVkv: Pick<Versioned, 'commitInfo'> = {
      async commitInfo(h?: string) {
        if (h === 'a') return { message: 'a', virtualParents: ['b'] }
        if (h === 'b') return { message: 'b', virtualParents: ['a'] }
        return null
      },
    }
    const result = await collect(walkVirtualAncestry(fakeVkv as Versioned, 'a'))
    expect(new Set(result)).toEqual(new Set(['a', 'b']))
  })
})

describe('resolveRef', () => {
  it('rejects empty input', async () => {
    await expect(resolveRef('', vkv, new Metadata())).rejects.toThrow(InvalidRef)
    await expect(resolveRef('', vkv, new Metadata())).rejects.toThrow(/empty/)
  })

  it('rejects HEAD when unborn', async () => {
    await expect(resolveRef('HEAD', vkv, new Metadata())).rejects.toThrow(/unborn/)
  })

  it('HEAD resolves to the current branch tip', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const meta = new Metadata({ branches: { main: a } })
    expect(await resolveRef('HEAD', vkv, meta)).toBe(a)
  })

  it('HEAD~0 is the same as HEAD', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const meta = new Metadata({ branches: { main: a } })
    expect(await resolveRef('HEAD~0', vkv, meta)).toBe(a)
  })

  it('HEAD~N walks virtual ancestry', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const b = await agentCommit(staged, 'a', '2', 'second', { virtualParents: [a] })
    const c = await agentCommit(staged, 'a', '3', 'third', { virtualParents: [b] })
    const meta = new Metadata({ branches: { main: c } })
    expect(await resolveRef('HEAD~1', vkv, meta)).toBe(b)
    expect(await resolveRef('HEAD~2', vkv, meta)).toBe(a)
  })

  it('HEAD~N beyond history raises with the count in the message', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const meta = new Metadata({ branches: { main: a } })
    await expect(resolveRef('HEAD~5', vkv, meta)).rejects.toThrow(/beyond/)
    // The error preserves the ancestry length even though the walk
    // exits early — important for the agent to know "you wanted N
    // but there are only K".
    await expect(resolveRef('HEAD~5', vkv, meta)).rejects.toThrow(/1 commit /)
  })

  it('HEAD~N walks lazily — exits as soon as the N-th ancestor is found', async () => {
    // The walk should not visit ancestors beyond the requested
    // index. Build a 5-deep chain, then count how many times the
    // fake `commitInfo` is queried while resolving `HEAD~1`. Once
    // we've returned `b`, no further commit-info calls should fire.
    const a = await agentCommit(staged, 'a', '1', 'first')
    const b = await agentCommit(staged, 'a', '2', 'second', { virtualParents: [a] })
    const c = await agentCommit(staged, 'a', '3', 'third', { virtualParents: [b] })
    const d = await agentCommit(staged, 'a', '4', 'fourth', { virtualParents: [c] })
    const e = await agentCommit(staged, 'a', '5', 'fifth', { virtualParents: [d] })
    const meta = new Metadata({ branches: { main: e } })

    // Resolve HEAD~1 and observe how far the walk got by counting
    // commitInfo invocations on a spy.
    let calls = 0
    const spy: Pick<Versioned, 'commitInfo' | 'history'> = {
      async commitInfo(h?: string) {
        calls++
        return vkv.commitInfo(h)
      },
      history(hash?: string, opts?: { allParents?: boolean }) {
        return vkv.history(hash, opts)
      },
    }
    const result = await resolveRef('HEAD~1', spy as Versioned, meta)
    expect(result).toBe(d)
    // Walking from HEAD requires: commitInfo(e) to find e's parent
    // (1 call), then we have HEAD~0 = e, advance to HEAD~1 = d and
    // return. Should be at most ~2 calls, definitely not 5.
    expect(calls).toBeLessThanOrEqual(2)
  })

  it('HEAD~ with non-integer raises', async () => {
    await expect(resolveRef('HEAD~abc', vkv, new Metadata())).rejects.toThrow(/invalid ref/)
  })

  it('HEAD~-1 raises', async () => {
    await expect(resolveRef('HEAD~-1', vkv, new Metadata())).rejects.toThrow(/invalid ref/)
  })

  it('branch name resolves', async () => {
    const a = await agentCommit(staged, 'a', '1', 'main')
    const b = await agentCommit(staged, 'a', '2', 'feat', {
      virtualBranch: 'feature',
      virtualParents: [a],
    })
    const meta = new Metadata({ branches: { main: a, feature: b } })
    expect(await resolveRef('main', vkv, meta)).toBe(a)
    expect(await resolveRef('feature', vkv, meta)).toBe(b)
  })

  it('branch takes precedence over hash prefix', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const b = await agentCommit(staged, 'a', '2', 'second', { virtualParents: [a] })
    // Branch named with a's prefix points to b — name lookup wins.
    const prefix = a.slice(0, 7)
    const meta = new Metadata({ branches: { main: a, [prefix]: b } })
    expect(await resolveRef(prefix, vkv, meta)).toBe(b)
  })

  it('hash prefix matches an agent commit', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const meta = new Metadata({ branches: { main: a } })
    expect(await resolveRef(a.slice(0, 7), vkv, meta)).toBe(a)
    expect(await resolveRef(a.slice(0, 10), vkv, meta)).toBe(a)
  })

  it('hash prefix works across branches', async () => {
    const a = await agentCommit(staged, 'a', '1', 'main')
    const b = await agentCommit(staged, 'a', '2', 'feat', {
      virtualBranch: 'feature',
      virtualParents: [a],
    })
    // feature is NOT in metadata.branches but b is still addressable.
    const meta = new Metadata({ branches: { main: a } })
    expect(await resolveRef(b.slice(0, 7), vkv, meta)).toBe(b)
  })

  it('hash prefix does not match system commits', async () => {
    const sysHash = await systemCommit(staged, 'a', '1')
    await expect(resolveRef(sysHash.slice(0, 7), vkv, new Metadata())).rejects.toThrow(
      /not a valid ref/,
    )
  })

  it('hash prefix below minimum length raises', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const meta = new Metadata({ branches: { main: a } })
    await expect(resolveRef(a.slice(0, 6), vkv, meta)).rejects.toThrow(/not a valid ref/)
  })

  it('unknown ref raises', async () => {
    await expect(resolveRef('nope', vkv, new Metadata())).rejects.toThrow(/not a valid ref/)
  })
})

describe('allAncestors', () => {
  it('unborn returns empty set', async () => {
    expect((await allAncestors(vkv, null)).size).toBe(0)
  })

  it('includes self', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    expect(await allAncestors(vkv, a)).toEqual(new Set([a]))
  })

  it('walks both parents through a merge (unlike walkVirtualAncestry)', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const b = await agentCommit(staged, 'b', '1', 'branch', { virtualParents: [a] })
    const c = await agentCommit(staged, 'a', '2', 'main2', { virtualParents: [a] })
    const merge = await agentCommit(staged, 'c', '3', 'merge', { virtualParents: [c, b] })
    expect(await allAncestors(vkv, merge)).toEqual(new Set([merge, c, b, a]))
  })
})

describe('mergeBase', () => {
  it('returns null when either input is null', async () => {
    expect(await mergeBase(vkv, null, 'abc')).toBeNull()
    expect(await mergeBase(vkv, 'abc', null)).toBeNull()
  })

  it('a commit is its own merge-base', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    expect(await mergeBase(vkv, a, a)).toBe(a)
  })

  it('an ancestor is the merge-base of itself and a descendant', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const b = await agentCommit(staged, 'a', '2', 'second', { virtualParents: [a] })
    expect(await mergeBase(vkv, a, b)).toBe(a)
    expect(await mergeBase(vkv, b, a)).toBe(a)
  })

  it('finds the LCA for two diverged branches', async () => {
    const a = await agentCommit(staged, 'a', '1', 'first')
    const featTip = await agentCommit(staged, 'b', '1', 'feat', { virtualParents: [a] })
    const mainTip = await agentCommit(staged, 'a', '2', 'main2', { virtualParents: [a] })
    expect(await mergeBase(vkv, mainTip, featTip)).toBe(a)
  })

  it('returns null for unrelated histories', async () => {
    const a = await agentCommit(staged, 'a', '1', 'rootA')
    const b = await agentCommit(staged, 'b', '1', 'rootB')
    expect(await mergeBase(vkv, a, b)).toBeNull()
  })
})
