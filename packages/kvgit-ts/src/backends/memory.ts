import type { KVStore } from '../types'

/**
 * In-process KV store backed by a `Map`. Useful for tests, dev-mode
 * agents, and as the reference implementation against which other
 * backends are tested.
 *
 * Operations are synchronous internally but exposed as `async` to
 * match the `KVStore` interface — user code is uniform across
 * backends.
 */
export class Memory implements KVStore {
  readonly #data = new Map<string, Uint8Array>()

  async get(key: string): Promise<Uint8Array | null> {
    const v = this.#data.get(key)
    return v === undefined ? null : v
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    this.#data.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.#data.delete(key)
  }

  async has(key: string): Promise<boolean> {
    return this.#data.has(key)
  }

  async getMany(keys: Iterable<string>): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>()
    for (const k of keys) {
      const v = this.#data.get(k)
      if (v !== undefined) out.set(k, v)
    }
    return out
  }

  async setMany(items: Iterable<readonly [string, Uint8Array]>): Promise<void> {
    for (const [k, v] of items) {
      this.#data.set(k, v)
    }
  }

  async removeMany(keys: Iterable<string>): Promise<void> {
    for (const k of keys) {
      this.#data.delete(k)
    }
  }

  async cas(key: string, value: Uint8Array, expected: Uint8Array | null): Promise<boolean> {
    const current = this.#data.get(key) ?? null
    if (!bytesEqual(current, expected)) return false
    this.#data.set(key, value)
    return true
  }

  async *keys(prefix?: string): AsyncIterable<string> {
    if (prefix === undefined) {
      for (const k of this.#data.keys()) yield k
    } else {
      for (const k of this.#data.keys()) {
        if (k.startsWith(prefix)) yield k
      }
    }
  }

  async *items(prefix?: string): AsyncIterable<readonly [string, Uint8Array]> {
    if (prefix === undefined) {
      for (const entry of this.#data.entries()) yield entry
    } else {
      for (const entry of this.#data.entries()) {
        if (entry[0].startsWith(prefix)) yield entry
      }
    }
  }

  async clear(): Promise<void> {
    this.#data.clear()
  }
}

function bytesEqual(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
