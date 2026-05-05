/**
 * `connectState(config)` — factory that turns a `StateConfig` into a
 * concrete `StateBackend`.
 *
 * Storage-specific backends are loaded via dynamic `import()` so the
 * agex-ts state module doesn't pull `node:sqlite` into a browser
 * bundle (or `idb` into a Node-only bundle). Tree-shaking handles
 * the unused branches per environment.
 *
 * `'live'` returns a `Live` directly — no kvgit dependency needed.
 * `'versioned'` wires `<backend> → VersionedKV → Staged → KvgitState`.
 */

import type { StateConfig } from '../types'
import type { StateBackend } from './backend'
import { Live } from './live'

export async function connectState(config: StateConfig = { type: 'live' }): Promise<StateBackend> {
  if (config.type === 'live') return new Live()

  // Lazy imports keep the unused storage backends out of the bundle.
  const { Staged, VersionedKV } = await import('kvgit-ts')

  let store: import('kvgit-ts').KVStore
  switch (config.storage) {
    case 'memory': {
      const { Memory } = await import('kvgit-ts/backends/memory')
      store = new Memory()
      break
    }
    case 'indexeddb': {
      const { IndexedDB } = await import('kvgit-ts/backends/idb')
      store = await IndexedDB.open()
      break
    }
    case 'sqlite': {
      if (config.path === undefined) {
        throw new Error('connectState: storage "sqlite" requires a `path` option')
      }
      const { Sqlite } = await import('kvgit-ts/backends/sqlite')
      store = await Sqlite.open({ path: config.path })
      break
    }
    default: {
      const exhaustive: never = config.storage
      throw new Error(`connectState: unknown storage type: ${exhaustive as string}`)
    }
  }

  const vk = await VersionedKV.open(store)
  const staged = new Staged(vk)
  const { KvgitState } = await import('./kvgit')
  return new KvgitState(staged)
}
