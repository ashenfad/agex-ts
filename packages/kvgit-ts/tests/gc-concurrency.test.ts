/**
 * Concurrency and scoping guarantees of the orphan sweep.
 *
 * `cleanOrphans` must be safe to run while another writer commits.
 * The property that buys that safety is *scoping*: every deletion
 * candidate is discovered by walking an orphan commit's own keyset,
 * never by scanning a namespace. A commit that lands after the mark
 * phase is in nobody's orphan tree, so nothing it wrote can end up on
 * the removal list.
 *
 * That argument only holds because blobs and HAMT nodes are
 * commit-scoped — see the "commit-scoping premise" block below, which
 * measures it rather than assuming it. `deepClean` deliberately breaks
 * the property (namespace scans) and is therefore quiescent-store only.
 */

import { describe, expect, it } from 'vitest'
import { Memory } from '../src/backends/memory'
import { Keyset } from '../src/keyset'
import { decodeEntry } from '../src/keyset'
import type { KeysetEntry } from '../src/types'
import { VersionedKV } from '../src/versioned/kv'
import { COMMIT_ROOT, blobPointerOwner, loads } from '../src/versioned/layout'

const enc = new TextEncoder()
const dec = new TextDecoder()
const bytes = (s: string): Uint8Array => enc.encode(s)

/** minAge=-1 puts the cutoff just past `Date.now()`, so every commit
 *  written before the call counts as old enough to sweep. */
const SWEEP_ALL = { minAge: -1 } as const

// ---------------------------------------------------------------------------
// Test seam
// ---------------------------------------------------------------------------

/**
 * A `Memory` that can be interrupted at a chosen point, deterministically.
 *
 * Every `await` inside the sweep is a yield point another task can land
 * a commit in — `store.keys(prefix)` is an async iterable, so even a
 * single-threaded JS context interleaves there. Rather than hope for
 * the interleaving, register a one-shot hook: `beforeScan` fires before
 * the first `keys(prefix)` scan of a given prefix, `beforeGet` before
 * the first `get(key)` of a given key. No sleeps, no timing luck.
 */
class HookedMemory extends Memory {
  readonly beforeScan = new Map<string, () => Promise<void>>()
  readonly beforeGet = new Map<string, () => Promise<void>>()

  override async *keys(prefix?: string): AsyncIterable<string> {
    if (prefix !== undefined) await this.fire(this.beforeScan, prefix)
    yield* super.keys(prefix)
  }

  override async get(key: string): Promise<Uint8Array | null> {
    await this.fire(this.beforeGet, key)
    return super.get(key)
  }

  private async fire(hooks: Map<string, () => Promise<void>>, key: string): Promise<void> {
    const hook = hooks.get(key)
    if (hook === undefined) return
    hooks.delete(key)
    await hook()
  }
}

/** Land a commit on `main` from an independent handle. */
async function landCommit(
  store: Memory,
  key: string,
  value: string,
): Promise<{ commit: string; root: string; blob: string }> {
  const writer = await VersionedKV.open(store)
  await writer.commit({ updates: new Map([[key, bytes(value)]]) })
  const commit = writer.currentCommit
  return { commit, root: await rootOf(store, commit), blob: `${commit}:${key}` }
}

async function nodeKeys(store: Memory): Promise<Set<string>> {
  const out = new Set<string>()
  for await (const k of store.keys(Keyset.DEFAULT_PREFIX)) out.add(k)
  return out
}

async function blobKeys(store: Memory, commits: Iterable<string>): Promise<Set<string>> {
  const owners = new Set(commits)
  const out = new Set<string>()
  for await (const k of store.keys()) {
    if (k.startsWith('__') || k.startsWith(Keyset.DEFAULT_PREFIX)) continue
    if (owners.has(blobPointerOwner(k))) out.add(k)
  }
  return out
}

async function rootOf(store: Memory, commit: string): Promise<string> {
  const raw = await store.get(COMMIT_ROOT(commit))
  if (raw === null) throw new Error(`commit ${commit} has no root`)
  return loads(raw) as string
}

/** Every entry reachable from `root`, plus the node hashes visited. */
async function readTree(
  store: Memory,
  root: string,
): Promise<{ entries: Map<string, KeysetEntry>; nodes: Set<string>; missing: Set<string> }> {
  const entries = new Map<string, KeysetEntry>()
  const nodes = new Set<string>()
  const missing = new Set<string>()
  const queue = [root]
  while (queue.length > 0) {
    const h = queue.pop() as string
    if (nodes.has(h) || missing.has(h)) continue
    const raw = await store.get(Keyset.DEFAULT_PREFIX + h)
    if (raw === null) {
      missing.add(h)
      continue
    }
    nodes.add(h)
    const node = JSON.parse(dec.decode(raw)) as
      | { kind: 'leaf'; items: Record<string, string> }
      | { kind: 'branch'; children: Record<string, string> }
    if (node.kind === 'leaf') {
      for (const [k, b64] of Object.entries(node.items)) {
        const binary = atob(b64)
        const buf = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i)
        entries.set(k, decodeEntry(buf))
      }
    } else {
      queue.push(...Object.values(node.children))
    }
  }
  return { entries, nodes, missing }
}

// ---------------------------------------------------------------------------
// Commit-scoping premise
// ---------------------------------------------------------------------------

describe('commit-scoping premise', () => {
  it('two unrelated histories with identical final content share no nodes and no blobs', async () => {
    // Same logical end state ({x: 1, y: 2}), reached by different
    // commit sequences in different stores. If either class deduped on
    // content, these would collide.
    const storeA = new Memory()
    const a = await VersionedKV.open(storeA)
    await a.commit({ updates: new Map([['x', bytes('1')]]) })
    await a.commit({ updates: new Map([['y', bytes('2')]]) })

    const storeB = new Memory()
    const b = await VersionedKV.open(storeB)
    await b.commit({ updates: new Map([['y', bytes('2')]]) })
    await b.commit({ updates: new Map([['x', bytes('1')]]) })

    expect(await a.get('x')).toEqual(await b.get('x'))
    expect(await a.get('y')).toEqual(await b.get('y'))

    const nodesA = await nodeKeys(storeA)
    const nodesB = await nodeKeys(storeB)
    expect(nodesA.size).toBeGreaterThan(0)
    expect(nodesB.size).toBeGreaterThan(0)
    const sharedNodes = [...nodesA].filter((k) => nodesB.has(k))
    expect(sharedNodes, `HAMT nodes deduped across unrelated histories: ${sharedNodes}`).toEqual([])

    const commitsA: string[] = []
    for await (const c of a.history()) commitsA.push(c)
    const commitsB: string[] = []
    for await (const c of b.history()) commitsB.push(c)
    const bA = await blobKeys(storeA, commitsA)
    const bB = await blobKeys(storeB, commitsB)
    expect(bA.size).toBeGreaterThan(0)
    const sharedBlobs = [...bA].filter((k) => bB.has(k))
    expect(sharedBlobs, `blob keys deduped across unrelated histories: ${sharedBlobs}`).toEqual([])
  })

  it('every stored node transitively embeds a pointer owned by a commit in its own history', async () => {
    // The structural reason the sweep can be scoped: a leaf payload is
    // `[blobPointer, meta]` and a blob pointer is `<commitHash>:<key>`,
    // so a node hash can only be shared between commits that share the
    // ancestry that wrote the pointer. Branch nodes only name child
    // hashes, so the property is transitive to the root.
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    for (let i = 0; i < 40; i++) {
      await vk.commit({ updates: new Map([[`key${i}`, bytes(`v${i}`)]]) })
    }
    const history = new Set<string>()
    for await (const c of vk.history()) history.add(c)

    const { entries, nodes, missing } = await readTree(store, await rootOf(store, vk.currentCommit))
    expect(missing.size).toBe(0)
    expect(nodes.size).toBeGreaterThan(1)
    expect(entries.size).toBe(40)
    for (const [key, entry] of entries) {
      const owner = blobPointerOwner(entry.blob)
      expect(history.has(owner), `blob for '${key}' owned by ${owner}, outside this history`).toBe(
        true,
      )
    }

    // No node in the store belongs to two disjoint commits by accident:
    // the whole node namespace here is reachable from this one history.
    const all = await nodeKeys(store)
    expect(all.size).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

describe('cleanOrphans — concurrent writers', () => {
  /**
   * The hazardous window: the mark phase has finished, the
   * `__commit_root__` scan has finished, and the sweep is now
   * collecting what to delete. A commit that lands here was never
   * marked and is not in the orphan list — so a sweep that finds its
   * deletion candidates by scanning a namespace will delete the
   * artifacts of a commit that is, by then, the live branch HEAD.
   *
   * Seam: the first `get` of the orphan's `__commit_root__`, which is
   * the first read of the orphan-collection loop.
   */
  it('keeps HAMT nodes written by a commit that lands mid-sweep', async () => {
    const store = new HookedMemory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['seed', bytes('s')]]) })
    const keep = vk.currentCommit
    await vk.commit({ updates: new Map([['garbage', bytes('g')]]) })
    const orphan = vk.currentCommit
    await vk.resetTo(keep)

    let lateCommit = ''
    let lateRoot = ''
    store.beforeGet.set(COMMIT_ROOT(orphan), async () => {
      const landed = await landCommit(store, 'late', 'landed')
      lateCommit = landed.commit
      lateRoot = landed.root
    })

    const removed = await vk.cleanOrphans(SWEEP_ALL)

    // The seam fired where we think it did.
    expect(lateCommit, 'seam never fired — the orphan loop did not read the orphan root').not.toBe(
      '',
    )
    expect(removed).toBe(1)
    const headRaw = await store.get('__branch_head__main')
    expect(headRaw === null ? null : (loads(headRaw) as string)).toBe(lateCommit)
    expect(await store.get(COMMIT_ROOT(lateCommit))).not.toBeNull()

    // ...and the keyset that live HEAD points at is intact.
    const { missing, entries } = await readTree(store, lateRoot)
    expect(
      [...missing],
      `live HEAD ${lateCommit} of branch 'main' has keyset root ${lateRoot}, but the sweep deleted HAMT node(s) it needs`,
    ).toEqual([])
    expect([...entries.keys()].sort()).toEqual(['late', 'seed'])

    const reopened = await VersionedKV.open(store)
    expect(reopened.currentCommit).toBe(lateCommit)
    expect(await reopened.get('late')).toEqual(bytes('landed'))
    expect(await reopened.get('seed')).toEqual(bytes('s'))

    // The orphan was still collected — the sweep did not become a no-op.
    expect(await store.get(COMMIT_ROOT(orphan))).toBeNull()
    expect(await store.get(`${orphan}:garbage`)).toBeNull()
  })

  it('keeps blobs written by a commit that lands mid-sweep', async () => {
    const store = new HookedMemory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['seed', bytes('s')]]) })
    const keep = vk.currentCommit
    await vk.commit({ updates: new Map([['garbage', bytes('g')]]) })
    const orphan = vk.currentCommit
    await vk.resetTo(keep)

    let lateBlob = ''
    store.beforeGet.set(COMMIT_ROOT(orphan), async () => {
      lateBlob = (await landCommit(store, 'late', 'landed')).blob
    })

    await vk.cleanOrphans(SWEEP_ALL)

    expect(lateBlob).not.toBe('')
    expect(await store.get(lateBlob), `blob ${lateBlob} of the live HEAD was swept`).not.toBeNull()
  })

  // Controls. These isolate *why* the cases above are the dangerous
  // ones: it is the mark-phase ordering, not GC deleting things.

  it('control: a commit landing before the mark phase is marked and survives', async () => {
    const store = new HookedMemory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['seed', bytes('s')]]) })
    const keep = vk.currentCommit
    await vk.commit({ updates: new Map([['garbage', bytes('g')]]) })
    await vk.resetTo(keep)

    // Seam at the branch-head scan that opens the mark phase, so the
    // commit is on main before marking begins.
    let earlyRoot = ''
    store.beforeScan.set('__branch_head__', async () => {
      earlyRoot = (await landCommit(store, 'early', 'landed')).root
    })

    await vk.cleanOrphans(SWEEP_ALL)
    expect(earlyRoot).not.toBe('')
    expect([...(await readTree(store, earlyRoot)).missing]).toEqual([])
  })

  it('control: a sweep that finds no orphans deletes nothing', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['seed', bytes('s')]]) })
    const before = await nodeKeys(store)

    expect(await vk.cleanOrphans(SWEEP_ALL)).toBe(0)
    expect(await nodeKeys(store)).toEqual(before)
  })
})

// ---------------------------------------------------------------------------
// The sweep still sweeps
// ---------------------------------------------------------------------------

describe('cleanOrphans — still collects ordinary garbage', () => {
  it("removes an orphan's commit metadata, blobs and exclusively-owned nodes", async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    const seeds = new Map<string, Uint8Array>()
    for (let i = 0; i < 40; i++) seeds.set(`key${i}`, bytes(`v${i}`))
    await vk.commit({ updates: seeds })
    const keep = vk.currentCommit
    const keepNodes = (await readTree(store, await rootOf(store, keep))).nodes

    await vk.commit({ updates: new Map([['garbage', bytes('g')]]) })
    const orphan = vk.currentCommit
    const orphanRoot = await rootOf(store, orphan)
    const orphanNodes = (await readTree(store, orphanRoot)).nodes
    const exclusive = [...orphanNodes].filter((h) => !keepNodes.has(h))
    expect(exclusive.length, 'orphan should own nodes the live commit does not').toBeGreaterThan(0)

    await vk.resetTo(keep)
    expect(await vk.cleanOrphans(SWEEP_ALL)).toBe(1)

    // Commit metadata gone.
    expect(await store.get(COMMIT_ROOT(orphan))).toBeNull()
    expect(await store.get(`__parent_commit__${orphan}`)).toBeNull()
    expect(await store.get(`__commit_time__${orphan}`)).toBeNull()
    // Blob gone.
    expect(await store.get(`${orphan}:garbage`)).toBeNull()
    // Every node the orphan uniquely owned is gone...
    for (const h of exclusive) {
      expect(await store.get(Keyset.DEFAULT_PREFIX + h), `orphan node ${h} survived`).toBeNull()
    }
    // ...and every node the live commit needs survived.
    const live = await readTree(store, await rootOf(store, keep))
    expect([...live.missing]).toEqual([])
    for (let i = 0; i < 40; i++) {
      expect(await vk.get(`key${i}`)).toEqual(bytes(`v${i}`))
    }
  })

  it('collects an orphan chain, not just its tip', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['k', bytes('v0')]]) })
    const keep = vk.currentCommit
    await vk.commit({ updates: new Map([['k', bytes('v1')]]) })
    await vk.commit({ updates: new Map([['k', bytes('v2')]]) })
    await vk.commit({ updates: new Map([['k', bytes('v3')]]) })
    await vk.resetTo(keep)

    expect(await vk.cleanOrphans(SWEEP_ALL)).toBe(3)

    // Nothing but the surviving commit's own nodes is left in the
    // namespace — the chain took its whole tree with it.
    const survivors = (await readTree(store, await rootOf(store, keep))).nodes
    const expected = new Set([...survivors].map((h) => Keyset.DEFAULT_PREFIX + h))
    expect(await nodeKeys(store)).toEqual(expected)
    expect(await vk.get('k')).toEqual(bytes('v0'))
  })
})

describe('cleanOrphans — structural sharing', () => {
  it('a subtree shared between a live commit and an orphan survives', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    const seeds = new Map<string, Uint8Array>()
    for (let i = 0; i < 60; i++) seeds.set(`key${i}`, bytes(`v${i}`))
    await vk.commit({ updates: seeds })
    const base = vk.currentCommit

    // A branch that adds one key: most subtrees stay shared with base.
    const feature = (await vk.createBranch('feature')) as VersionedKV
    await feature.commit({ updates: new Map([['feature-only', bytes('fv')]]) })
    const featureCommit = feature.currentCommit
    const featureNodes = (await readTree(store, await rootOf(store, featureCommit))).nodes
    const baseNodes = (await readTree(store, await rootOf(store, base))).nodes
    const shared = [...featureNodes].filter((h) => baseNodes.has(h))
    expect(shared.length, 'expected structural sharing between base and feature').toBeGreaterThan(0)

    await vk.deleteBranch('feature')
    expect(await vk.cleanOrphans(SWEEP_ALL)).toBe(1)

    for (const h of shared) {
      expect(
        await store.get(Keyset.DEFAULT_PREFIX + h),
        `shared node ${h} was swept`,
      ).not.toBeNull()
    }
    const live = await readTree(store, await rootOf(store, base))
    expect([...live.missing]).toEqual([])
    expect(live.entries.size).toBe(60)
  })

  it('two orphans sharing a subtree both get collected without double-delete trouble', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['seed', bytes('s')]]) })
    const keep = vk.currentCommit

    const seeds = new Map<string, Uint8Array>()
    for (let i = 0; i < 40; i++) seeds.set(`key${i}`, bytes(`v${i}`))
    const a = (await vk.createBranch('a', { at: keep })) as VersionedKV
    await a.commit({ updates: seeds })
    const forkPoint = a.currentCommit
    await a.commit({ updates: new Map([['a-only', bytes('av')]]) })
    const b = (await vk.createBranch('b', { at: forkPoint })) as VersionedKV
    await b.commit({ updates: new Map([['b-only', bytes('bv')]]) })

    await vk.deleteBranch('a')
    await vk.deleteBranch('b')
    expect(await vk.cleanOrphans(SWEEP_ALL)).toBe(3)

    const live = await readTree(store, await rootOf(store, keep))
    expect([...live.missing]).toEqual([])
    expect(await vk.get('seed')).toEqual(bytes('s'))
  })
})

describe('cleanOrphans — damaged orphans', () => {
  it('does not crash on an orphan whose HAMT nodes are already missing', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['seed', bytes('s')]]) })
    const keep = vk.currentCommit
    await vk.commit({ updates: new Map([['garbage', bytes('g')]]) })
    const orphan = vk.currentCommit
    const orphanRoot = await rootOf(store, orphan)
    await vk.resetTo(keep)

    // Simulate a half-swept / interrupted store: the orphan's commit
    // metadata is there but its keyset nodes are gone.
    const orphanNodes = (await readTree(store, orphanRoot)).nodes
    const keepNodes = (await readTree(store, await rootOf(store, keep))).nodes
    await store.removeMany(
      [...orphanNodes].filter((h) => !keepNodes.has(h)).map((h) => Keyset.DEFAULT_PREFIX + h),
    )

    expect(await vk.cleanOrphans(SWEEP_ALL)).toBe(1)
    expect(await store.get(COMMIT_ROOT(orphan))).toBeNull()
    expect(await vk.get('seed')).toEqual(bytes('s'))

    // Documented limitation, pinned here so it isn't rediscovered as a
    // surprise: the orphan's blob is leaked permanently. Nothing scans
    // blobs by namespace, so a blob is only ever found through the
    // keyset that points at it — and that keyset is gone. `deepClean`
    // does not help; it scans nodes, not blobs. This is exactly the
    // state a namespace-scanning node sweep used to create on its own,
    // which is why nodes and blobs are now collected in one walk.
    expect(await store.get(`${orphan}:garbage`)).not.toBeNull()
  })

  it('does not crash on an orphan whose root is corrupt', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['seed', bytes('s')]]) })
    const keep = vk.currentCommit
    await vk.commit({ updates: new Map([['garbage', bytes('g')]]) })
    const orphan = vk.currentCommit
    await vk.resetTo(keep)

    await store.set(COMMIT_ROOT(orphan), bytes('not json'))
    expect(await vk.cleanOrphans(SWEEP_ALL)).toBe(1)
    expect(await store.get(COMMIT_ROOT(orphan))).toBeNull()
    expect(await vk.get('seed')).toEqual(bytes('s'))
  })
})

// ---------------------------------------------------------------------------
// deepClean
// ---------------------------------------------------------------------------

describe('deepClean', () => {
  it('reclaims stray nodes that no commit points at, which cleanOrphans leaves', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['seed', bytes('s')]]) })

    // A keyset written but never committed — an interrupted write, or a
    // crash between the node write and the CAS. No orphan commit points
    // at it, so no orphan keyset walk can find it.
    const stray = await (await Keyset.empty(store)).persist({
      updates: [['stranded', { blob: 'deadbeef:stranded', meta: { size: 1, createdAt: 0 } }]],
    })
    const strayKey = Keyset.DEFAULT_PREFIX + stray.root
    expect(await store.get(strayKey)).not.toBeNull()

    // The incremental path cannot see it.
    await vk.cleanOrphans(SWEEP_ALL)
    expect(
      await store.get(strayKey),
      'cleanOrphans is scoped to orphan keysets and must leave commit-less nodes alone',
    ).not.toBeNull()

    // The quiescent-store path does.
    await vk.deepClean(SWEEP_ALL)
    expect(await store.get(strayKey)).toBeNull()

    // Live state is untouched.
    expect(await vk.get('seed')).toEqual(bytes('s'))
  })

  it('collects orphan commits too, and reports the same count', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['seed', bytes('s')]]) })
    const keep = vk.currentCommit
    await vk.commit({ updates: new Map([['garbage', bytes('g')]]) })
    const orphan = vk.currentCommit
    await vk.resetTo(keep)

    expect(await vk.deepClean(SWEEP_ALL)).toBe(1)
    expect(await store.get(COMMIT_ROOT(orphan))).toBeNull()
    expect(await store.get(`${orphan}:garbage`)).toBeNull()
    expect(await vk.get('seed')).toEqual(bytes('s'))
  })

  it('protects nodes of young orphans from the namespace scan', async () => {
    const store = new Memory()
    const vk = await VersionedKV.open(store)
    await vk.commit({ updates: new Map([['seed', bytes('s')]]) })
    const keep = vk.currentCommit
    await vk.commit({ updates: new Map([['young', bytes('y')]]) })
    const young = vk.currentCommit
    const youngNodes = (await readTree(store, await rootOf(store, young))).nodes
    await vk.resetTo(keep)

    expect(await vk.deepClean({ minAge: 60_000_000 })).toBe(0)
    for (const h of youngNodes) {
      expect(
        await store.get(Keyset.DEFAULT_PREFIX + h),
        `young orphan node ${h} swept`,
      ).not.toBeNull()
    }
  })
})
