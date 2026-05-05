/**
 * Content-addressable Hash Array Mapped Trie.
 *
 * A persistent `string -> Uint8Array` map laid out in a `KVStore` so that
 * unchanged subtrees are shared across versions by hash equality. Each
 * node is JSON-serialized (sorted keys, no whitespace, base64-encoded
 * values inline in leaves) and stored under its SHA-256 hash. A HAMT is
 * identified by its root node hash; mutations produce a new root and a
 * set of pending node bytes that the caller persists (atomically, if
 * desired) by writing them through the underlying store.
 *
 * Layering: this module knows nothing about kvgit's commit semantics —
 * it is a generic content-addressable map. The `Keyset` wrapper (TBD)
 * adds blob-pointer + meta-entry semantics on top.
 */

import type { HamtDiff, KVStore } from './types'

/** SHA-256 hex digest length. Bounds the maximum trie depth. */
const HASH_LEN = 64

interface LeafNode {
  readonly kind: 'leaf'
  /** user key -> base64-encoded value */
  readonly items: Record<string, string>
}

interface BranchNode {
  readonly kind: 'branch'
  /** hex nibble (`'0'..'f'`) -> child node hash */
  readonly children: Record<string, string>
}

type Node = LeafNode | BranchNode

const EMPTY_LEAF: LeafNode = { items: {}, kind: 'leaf' }

let _emptyHashPromise: Promise<string> | null = null

/**
 * Hash of the canonical empty leaf. Computed lazily on first use and
 * cached. The empty leaf itself is never written to the store; reads
 * short-circuit on this hash.
 */
function emptyHash(): Promise<string> {
  if (_emptyHashPromise === null) {
    _emptyHashPromise = sha256Hex(nodeBytes(EMPTY_LEAF))
  }
  return _emptyHashPromise
}

// ---------------------------------------------------------------------------
// Serialization & hashing
// ---------------------------------------------------------------------------

const _encoder = new TextEncoder()
const _decoder = new TextDecoder()

/**
 * Serialize a node deterministically: keys sorted at every depth, no
 * whitespace. Two HAMTs with the same logical contents will produce
 * byte-for-byte identical node bytes — which is what makes content
 * addressing work.
 */
function nodeBytes(node: Node): Uint8Array {
  return _encoder.encode(canonicalJson(node))
}

function parseNode(bytes: Uint8Array): Node {
  return JSON.parse(_decoder.decode(bytes)) as Node
}

/** JSON serializer with sorted object keys and no whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
  return `{${parts.join(',')}}`
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  // SubtleCrypto's `BufferSource` excludes `SharedArrayBuffer`-backed views.
  // All our inputs are `ArrayBuffer`-backed in practice; narrow the cast.
  const buf = await globalThis.crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)
  const bytes = new Uint8Array(buf)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    hex += (b < 16 ? '0' : '') + b.toString(16)
  }
  return hex
}

function keyHash(key: string): Promise<string> {
  return sha256Hex(_encoder.encode(key))
}

// ---------------------------------------------------------------------------
// Base64 codec for leaf values
// ---------------------------------------------------------------------------

function encodeValue(value: Uint8Array): string {
  let binary = ''
  // Chunked to avoid exceeding the apply-args limit on very large values.
  const chunkSize = 0x8000
  for (let i = 0; i < value.length; i += chunkSize) {
    const slice = value.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

function decodeValue(s: string): Uint8Array {
  const binary = atob(s)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

// ---------------------------------------------------------------------------
// Hamt
// ---------------------------------------------------------------------------

export interface HamtOptions {
  /** Storage-key prefix. Two HAMTs sharing a backing store should use
   * different prefixes to avoid node collisions. */
  prefix?: string
  /** Max entries in a leaf before it splits into a branch. */
  bucketMax?: number
  /** Initial pending node bytes (for reconstructing in-progress state). */
  pending?: Map<string, Uint8Array>
}

export interface UpdatedOptions {
  updates?: Iterable<readonly [string, Uint8Array]>
  removals?: Iterable<string>
}

/**
 * Immutable, content-addressable HAMT view over a `KVStore`.
 *
 * Mutating methods (`updated`, `persist`) return a new `Hamt`. The
 * returned view's `pending` map contains any new node bytes not yet
 * flushed to the store. Reads on the new view resolve through `pending`
 * first, falling back to the store. Use `flush()` to persist all
 * pending nodes, or merge `pending` into a larger write batch.
 *
 * Two HAMTs with the same logical contents and the same `bucketMax`
 * have the same root hash, regardless of how they were constructed —
 * this invariant is what enables structural sharing across versions.
 *
 * `bucketMax` controls how many entries fit in a leaf before it splits
 * into a branch. Larger buckets mean fewer nodes but larger leaves;
 * smaller buckets mean more nodes with finer-grained sharing. A HAMT
 * built with one `bucketMax` will hash differently from the same
 * logical contents built with another.
 */
export class Hamt {
  readonly store: KVStore
  readonly root: string
  readonly prefix: string
  readonly bucketMax: number
  readonly pending: Map<string, Uint8Array>

  constructor(store: KVStore, root: string, opts: HamtOptions = {}) {
    const bucketMax = opts.bucketMax ?? 8
    if (bucketMax < 1) {
      throw new RangeError(`bucketMax must be >= 1, got ${bucketMax}`)
    }
    this.store = store
    this.root = root
    this.prefix = opts.prefix ?? 'hamt:'
    this.bucketMax = bucketMax
    this.pending = opts.pending ?? new Map()
  }

  /** Construct a fresh, empty HAMT. */
  static async empty(store: KVStore, opts: HamtOptions = {}): Promise<Hamt> {
    return new Hamt(store, await emptyHash(), opts)
  }

  /** The hash of the canonical empty leaf. Useful for tests. */
  static emptyHash(): Promise<string> {
    return emptyHash()
  }

  // ---------- Internal load / store ----------

  /**
   * Load a node by hash. Checks the supplied transient pending dict
   * first (used during in-progress batch updates), then `this.pending`,
   * then the store. Returns null if not found.
   */
  private async load(nodeHash: string, pending?: Map<string, Uint8Array>): Promise<Node | null> {
    if (nodeHash === (await emptyHash())) return EMPTY_LEAF
    const prefixed = this.prefix + nodeHash
    const fromPending = pending?.get(prefixed) ?? this.pending.get(prefixed)
    if (fromPending !== undefined) return parseNode(fromPending)
    const raw = await this.store.get(prefixed)
    if (raw === null) return null
    return parseNode(raw)
  }

  private async storeLeaf(
    items: Record<string, string>,
    pending: Map<string, Uint8Array>,
  ): Promise<string> {
    const node: LeafNode = { items, kind: 'leaf' }
    const bytes = nodeBytes(node)
    const hash = await sha256Hex(bytes)
    pending.set(this.prefix + hash, bytes)
    return hash
  }

  private async storeBranch(
    children: Record<string, string>,
    pending: Map<string, Uint8Array>,
  ): Promise<string> {
    const node: BranchNode = { children, kind: 'branch' }
    const bytes = nodeBytes(node)
    const hash = await sha256Hex(bytes)
    pending.set(this.prefix + hash, bytes)
    return hash
  }

  // ---------- Reads ----------

  /** Look up a key. Returns null if absent. */
  async get(key: string): Promise<Uint8Array | null> {
    const empty = await emptyHash()
    if (this.root === empty) return null
    const kh = await keyHash(key)
    let nodeHash = this.root
    let depth = 0
    while (true) {
      const node = await this.load(nodeHash)
      if (node === null) return null
      if (node.kind === 'leaf') {
        const encoded = node.items[key]
        return encoded === undefined ? null : decodeValue(encoded)
      }
      const chunk = kh[depth] as string
      const nextHash = node.children[chunk]
      if (nextHash === undefined) return null
      nodeHash = nextHash
      depth++
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null
  }

  /**
   * Iterate over all `(key, value)` pairs lazily. One store read per
   * visited node. Use `materialize()` if you want the whole map and the
   * underlying store has non-trivial per-call latency.
   */
  async *items(): AsyncIterable<readonly [string, Uint8Array]> {
    const empty = await emptyHash()
    if (this.root === empty) return
    yield* this.itemsFrom(this.root)
  }

  private async *itemsFrom(nodeHash: string): AsyncIterable<readonly [string, Uint8Array]> {
    const node = await this.load(nodeHash)
    if (node === null) return
    if (node.kind === 'leaf') {
      for (const [k, v] of Object.entries(node.items)) {
        yield [k, decodeValue(v)] as const
      }
    } else {
      for (const childHash of Object.values(node.children)) {
        yield* this.itemsFrom(childHash)
      }
    }
  }

  async *keys(): AsyncIterable<string> {
    for await (const [k] of this.items()) yield k
  }

  async *values(): AsyncIterable<Uint8Array> {
    for await (const [, v] of this.items()) yield v
  }

  /** Walk the entire HAMT and return its contents as a Map. */
  async materialize(): Promise<Map<string, Uint8Array>> {
    const [items] = await this.walk()
    return items
  }

  /**
   * Walk the entire HAMT, returning `[items, nodeHashes]`.
   *
   * Single batched BFS that collects both the key→value entries and
   * the set of every visited node hash. Used by GC mark phases that
   * want both, like `cleanOrphans`.
   *
   * `skipNodes` is an optional set of node hashes to treat as
   * already-visited. Skipped subtrees are not fetched, not recursed
   * into, and not included in the returned `nodes` set. Items beneath
   * skipped subtrees are also omitted. Pass a cumulative seen-set
   * across multiple `walk()` calls (e.g. across the commits of a
   * branch's history) to share work where the underlying HAMTs share
   * structure.
   */
  async walk(skipNodes?: ReadonlySet<string>): Promise<[Map<string, Uint8Array>, Set<string>]> {
    const empty = await emptyHash()
    const items = new Map<string, Uint8Array>()
    const nodes = new Set<string>()
    if (this.root === empty || skipNodes?.has(this.root)) return [items, nodes]

    let currentLevel: string[] = [this.root]

    while (currentLevel.length > 0) {
      // Partition: cached in pending vs needs fetch. Drop skipped.
      const cachedNodes = new Map<string, Node>()
      const toFetch: string[] = []
      for (const h of currentLevel) {
        if (h === empty || skipNodes?.has(h)) continue
        const prefixed = this.prefix + h
        const fromPending = this.pending.get(prefixed)
        if (fromPending !== undefined) {
          cachedNodes.set(h, parseNode(fromPending))
        } else {
          toFetch.push(prefixed)
        }
      }

      const fetched = toFetch.length > 0 ? await this.store.getMany(toFetch) : new Map()

      const nextLevel: string[] = []
      for (const h of currentLevel) {
        if (h === empty || skipNodes?.has(h)) continue
        const cached = cachedNodes.get(h)
        let node: Node
        if (cached !== undefined) {
          node = cached
        } else {
          const raw = fetched.get(this.prefix + h)
          if (raw === undefined) continue // missing — skip rather than crash
          node = parseNode(raw)
        }
        nodes.add(h)
        if (node.kind === 'leaf') {
          for (const [k, v] of Object.entries(node.items)) {
            items.set(k, decodeValue(v))
          }
        } else {
          nextLevel.push(...Object.values(node.children))
        }
      }
      currentLevel = nextLevel
    }
    return [items, nodes]
  }

  /** Total entry count. O(N) — walks the tree. */
  async size(): Promise<number> {
    let n = 0
    for await (const _ of this.items()) n++
    return n
  }

  // ---------- Writes ----------

  /**
   * Apply updates and removals. Returns a new `Hamt` whose `pending`
   * map contains any new node bytes not yet flushed.
   */
  async updated(opts: UpdatedOptions = {}): Promise<Hamt> {
    const pending = new Map(this.pending)
    let currentRoot = this.root

    for (const [key, value] of opts.updates ?? []) {
      currentRoot = await this.insert(currentRoot, key, value, pending)
    }
    for (const key of opts.removals ?? []) {
      currentRoot = await this.delete(currentRoot, key, pending)
    }

    // Drop any pending node no longer reachable from the new root
    // (intermediate nodes superseded by later updates).
    const reachablePending = await this.filterPending(currentRoot, pending)

    return new Hamt(this.store, currentRoot, {
      prefix: this.prefix,
      bucketMax: this.bucketMax,
      pending: reachablePending,
    })
  }

  /**
   * Apply updates and write any new nodes to the store immediately.
   * Returns a fresh `Hamt` with empty pending.
   */
  async persist(opts: UpdatedOptions = {}): Promise<Hamt> {
    const next = await this.updated(opts)
    if (next.pending.size > 0) {
      await this.store.setMany(next.pending)
    }
    return new Hamt(this.store, next.root, {
      prefix: this.prefix,
      bucketMax: this.bucketMax,
    })
  }

  /** Persist any pending node writes. Returns a fresh `Hamt`. */
  async flush(): Promise<Hamt> {
    if (this.pending.size > 0) {
      await this.store.setMany(this.pending)
    }
    return new Hamt(this.store, this.root, {
      prefix: this.prefix,
      bucketMax: this.bucketMax,
    })
  }

  // ---------- Insert ----------

  private async insert(
    rootHash: string,
    key: string,
    value: Uint8Array,
    pending: Map<string, Uint8Array>,
  ): Promise<string> {
    const empty = await emptyHash()
    if (rootHash === empty) {
      return this.storeLeaf({ [key]: encodeValue(value) }, pending)
    }
    const kh = await keyHash(key)
    return this.insertAt(rootHash, 0, kh, key, value, pending)
  }

  private async insertAt(
    nodeHash: string,
    depth: number,
    kh: string,
    key: string,
    value: Uint8Array,
    pending: Map<string, Uint8Array>,
  ): Promise<string> {
    const node = await this.load(nodeHash, pending)
    if (node === null) {
      // Dangling reference — treat as missing and materialize a leaf.
      return this.storeLeaf({ [key]: encodeValue(value) }, pending)
    }

    if (node.kind === 'leaf') {
      const encoded = encodeValue(value)
      const existing = node.items[key]
      if (existing === encoded) return nodeHash // no-op
      const newItems: Record<string, string> = { ...node.items, [key]: encoded }
      if (Object.keys(newItems).length <= this.bucketMax) {
        return this.storeLeaf(newItems, pending)
      }
      return this.splitLeaf(newItems, depth, pending)
    }

    // Branch
    const chunk = kh[depth] as string
    const existingChildren = node.children
    const existingChildHash = existingChildren[chunk]
    if (existingChildHash !== undefined) {
      const newChildHash = await this.insertAt(
        existingChildHash,
        depth + 1,
        kh,
        key,
        value,
        pending,
      )
      if (newChildHash === existingChildHash) return nodeHash
      const newChildren = { ...existingChildren, [chunk]: newChildHash }
      return this.storeBranch(newChildren, pending)
    }
    const newLeafHash = await this.storeLeaf({ [key]: encodeValue(value) }, pending)
    const newChildren = { ...existingChildren, [chunk]: newLeafHash }
    return this.storeBranch(newChildren, pending)
  }

  /** Convert an overflowing leaf at `depth` into a branch. */
  private async splitLeaf(
    encodedItems: Record<string, string>,
    depth: number,
    pending: Map<string, Uint8Array>,
  ): Promise<string> {
    if (depth >= HASH_LEN) {
      // Hash exhausted — full SHA-256 collision. Astronomically rare;
      // keep them in one (over-sized) leaf to avoid recursing forever.
      return this.storeLeaf(encodedItems, pending)
    }

    const groups = new Map<string, Record<string, string>>()
    for (const [k, v] of Object.entries(encodedItems)) {
      const nibble = (await keyHash(k))[depth] as string
      let group = groups.get(nibble)
      if (group === undefined) {
        group = {}
        groups.set(nibble, group)
      }
      group[k] = v
    }

    if (groups.size === 1) {
      // All entries share the next nibble too — recurse deeper, then
      // wrap in a single-child branch at this depth.
      const [nibble, groupItems] = groups.entries().next().value as [string, Record<string, string>]
      const childHash = await this.splitLeaf(groupItems, depth + 1, pending)
      return this.storeBranch({ [nibble]: childHash }, pending)
    }

    const children: Record<string, string> = {}
    for (const [nibble, groupItems] of groups) {
      if (Object.keys(groupItems).length <= this.bucketMax) {
        children[nibble] = await this.storeLeaf(groupItems, pending)
      } else {
        children[nibble] = await this.splitLeaf(groupItems, depth + 1, pending)
      }
    }
    return this.storeBranch(children, pending)
  }

  // ---------- Delete ----------

  private async delete(
    rootHash: string,
    key: string,
    pending: Map<string, Uint8Array>,
  ): Promise<string> {
    const empty = await emptyHash()
    if (rootHash === empty) return empty
    const kh = await keyHash(key)
    const result = await this.deleteAt(rootHash, 0, kh, key, pending)
    return result === null ? empty : result
  }

  /** Returns the new node hash, or null if the subtree is now empty. */
  private async deleteAt(
    nodeHash: string,
    depth: number,
    kh: string,
    key: string,
    pending: Map<string, Uint8Array>,
  ): Promise<string | null> {
    const node = await this.load(nodeHash, pending)
    if (node === null) return nodeHash

    if (node.kind === 'leaf') {
      if (!(key in node.items)) return nodeHash
      const newItems: Record<string, string> = {}
      for (const [k, v] of Object.entries(node.items)) {
        if (k !== key) newItems[k] = v
      }
      if (Object.keys(newItems).length === 0) return null
      return this.storeLeaf(newItems, pending)
    }

    // Branch
    const chunk = kh[depth] as string
    const existingChildren = node.children
    const existingChildHash = existingChildren[chunk]
    if (existingChildHash === undefined) return nodeHash

    const newChildHash = await this.deleteAt(existingChildHash, depth + 1, kh, key, pending)
    if (newChildHash === existingChildHash) return nodeHash

    const newChildren: Record<string, string> = { ...existingChildren }
    if (newChildHash === null) {
      delete newChildren[chunk]
    } else {
      newChildren[chunk] = newChildHash
    }

    if (Object.keys(newChildren).length === 0) return null

    // Canonicalization: if all children are leaves and their combined
    // entries fit in a single bucket, collapse the whole branch into one
    // leaf. This preserves the invariant that the same logical contents
    // always produce the same root hash.
    const collapsed = await this.tryCollapse(newChildren, pending)
    if (collapsed !== null) return collapsed

    return this.storeBranch(newChildren, pending)
  }

  /**
   * If every child is a leaf and the union of their entries fits in
   * `bucketMax`, return the merged leaf hash. Otherwise null.
   */
  private async tryCollapse(
    children: Record<string, string>,
    pending: Map<string, Uint8Array>,
  ): Promise<string | null> {
    const merged: Record<string, string> = {}
    let count = 0
    for (const childHash of Object.values(children)) {
      const child = await this.load(childHash, pending)
      if (child === null || child.kind !== 'leaf') return null
      for (const [k, v] of Object.entries(child.items)) {
        if (!(k in merged)) {
          merged[k] = v
          count++
        }
        if (count > this.bucketMax) return null
      }
    }
    return this.storeLeaf(merged, pending)
  }

  // ---------- Pending management ----------

  /**
   * Walk from `root`, returning only pending entries actually reachable.
   * Drops orphans created by superseded inserts.
   */
  private async filterPending(
    root: string,
    pending: Map<string, Uint8Array>,
  ): Promise<Map<string, Uint8Array>> {
    const empty = await emptyHash()
    const result = new Map<string, Uint8Array>()
    if (root === empty) return result
    const queue = [root]
    while (queue.length > 0) {
      const h = queue.pop() as string
      const prefixed = this.prefix + h
      if (result.has(prefixed) || !pending.has(prefixed)) continue
      const bytes = pending.get(prefixed) as Uint8Array
      result.set(prefixed, bytes)
      const node = parseNode(bytes)
      if (node.kind === 'branch') {
        queue.push(...Object.values(node.children))
      }
    }
    return result
  }

  // ---------- Structural ops ----------

  /**
   * Yield every node hash reachable from this root. Used by GC layers
   * to mark live nodes. Includes pending nodes — works on a Hamt that
   * hasn't been flushed.
   */
  async *reachableNodes(): AsyncIterable<string> {
    const empty = await emptyHash()
    if (this.root === empty) return
    const seen = new Set<string>()
    const queue = [this.root]
    while (queue.length > 0) {
      const h = queue.pop() as string
      if (seen.has(h)) continue
      seen.add(h)
      yield h
      const node = await this.load(h)
      if (node === null) continue
      if (node.kind === 'branch') {
        queue.push(...Object.values(node.children))
      }
    }
  }

  /**
   * Structural diff against `other`. Cost is O(changes + log N), not
   * O(N), because identical subtrees (same hash) are skipped wholesale.
   * The primary payoff of structural sharing.
   */
  async diff(other: Hamt): Promise<HamtDiff> {
    const added = new Map<string, Uint8Array>()
    const removed = new Map<string, Uint8Array>()
    const modified = new Map<string, readonly [Uint8Array, Uint8Array]>()
    await this.diffWalk(this.root, other.root, other, added, removed, modified)
    return { added, removed, modified }
  }

  private async diffWalk(
    aHash: string,
    bHash: string,
    other: Hamt,
    added: Map<string, Uint8Array>,
    removed: Map<string, Uint8Array>,
    modified: Map<string, readonly [Uint8Array, Uint8Array]>,
  ): Promise<void> {
    if (aHash === bHash) return // identical subtrees

    const empty = await emptyHash()

    if (aHash === empty) {
      for await (const [k, v] of other.itemsFrom(bHash)) added.set(k, v)
      return
    }
    if (bHash === empty) {
      for await (const [k, v] of this.itemsFrom(aHash)) removed.set(k, v)
      return
    }

    const aNode = await this.load(aHash)
    const bNode = await other.load(bHash)
    if (aNode === null || bNode === null) {
      // Missing node — fall back to full walk for whichever side is intact.
      if (aNode !== null) {
        for await (const [k, v] of this.itemsFrom(aHash)) removed.set(k, v)
      }
      if (bNode !== null) {
        for await (const [k, v] of other.itemsFrom(bHash)) added.set(k, v)
      }
      return
    }

    if (aNode.kind === 'leaf' && bNode.kind === 'leaf') {
      const aItems = aNode.items
      const bItems = bNode.items
      for (const [k, v] of Object.entries(aItems)) {
        if (!(k in bItems)) {
          removed.set(k, decodeValue(v))
        } else if (bItems[k] !== v) {
          modified.set(k, [decodeValue(v), decodeValue(bItems[k] as string)] as const)
        }
      }
      for (const [k, v] of Object.entries(bItems)) {
        if (!(k in aItems)) added.set(k, decodeValue(v))
      }
      return
    }

    if (aNode.kind === 'branch' && bNode.kind === 'branch') {
      const chunks = new Set([...Object.keys(aNode.children), ...Object.keys(bNode.children)])
      for (const chunk of chunks) {
        const aChild = aNode.children[chunk] ?? empty
        const bChild = bNode.children[chunk] ?? empty
        await this.diffWalk(aChild, bChild, other, added, removed, modified)
      }
      return
    }

    // Mixed kinds. Walk both fully and reconcile.
    const aItems = new Map<string, Uint8Array>()
    const bItems = new Map<string, Uint8Array>()
    for await (const [k, v] of this.itemsFrom(aHash)) aItems.set(k, v)
    for await (const [k, v] of other.itemsFrom(bHash)) bItems.set(k, v)
    for (const [k, v] of aItems) {
      const bv = bItems.get(k)
      if (bv === undefined) {
        removed.set(k, v)
      } else if (!bytesEqual(v, bv)) {
        modified.set(k, [v, bv] as const)
      }
    }
    for (const [k, v] of bItems) {
      if (!aItems.has(k)) added.set(k, v)
    }
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
