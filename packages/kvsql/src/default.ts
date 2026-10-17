/**
 * The default way a worker keeps a database: its file in OPFS and its
 * log in a kvgit repository on IndexedDB, both named from the config.
 */

import { Repo } from '@agex-ts/kvgit'
import { IndexedDB } from '@agex-ts/kvgit/backends/idb'
import type { DatabaseStorage } from './host'
import { OpfsDirectory } from './opfs'
import type { DatabaseConfig } from './protocol'

/** A database config for {@link openDefault}. */
export interface DefaultConfig extends DatabaseConfig {
  /**
   * The OPFS directory holding the file, as names from the OPFS root.
   * Default `['kvsql', id]`, which needs `id` to be a valid file name.
   */
  directory?: string[]
  /** The IndexedDB database holding the log's repository. Default `kvsql:<id>`. */
  indexedDB?: string
}

/** The OPFS directory every default database directory is made in. */
const ROOT = 'kvsql'

/**
 * Open a database's storage: the OPFS directory `directory` (created if
 * missing) and a kvgit repository on the IndexedDB database
 * `indexedDB` (none for a detached copy, which has no log). Deleting
 * the database also removes the directory and the IndexedDB database,
 * when they are the defaults (and so the database's alone).
 */
export async function openDefault(config: DefaultConfig): Promise<DatabaseStorage> {
  const dir = await OpfsDirectory.at(...(config.directory ?? [ROOT, config.id]))
  const removeDir = async () => {
    if (config.directory !== undefined) return
    const root = await OpfsDirectory.at(ROOT)
    try {
      await root.handle.removeEntry(config.id, { recursive: true })
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'NotFoundError')) throw err
    }
  }
  if (config.detached === true) return { dir, destroy: removeDir }
  const dbName = config.indexedDB ?? `kvsql:${config.id}`
  const store = await IndexedDB.open({ dbName })
  let repo: Repo<Uint8Array>
  try {
    repo = await Repo.open(store)
  } catch (err) {
    store.close()
    throw err
  }
  return {
    dir,
    repo,
    close: () => store.close(),
    destroy: async () => {
      if (config.indexedDB === undefined) await IndexedDB.deleteDatabase(dbName)
      await removeDir()
    },
  }
}
