/**
 * Test fixture: DuckDB-WASM wrapper module shaped for URL-shipped
 * registration. Initializes the database lazily on first `getDb()`
 * call so the agent only pays the multi-MB WASM + worker spawn cost
 * if it actually reaches for DuckDB.
 *
 * This mirrors the pattern recommended to embedders (see the
 * agex-studio integration note): ship a thin wrapper that lazily
 * instantiates DuckDB and exposes a stable surface, then register the
 * wrapper's URL via `agent.namespace({ url, ... }, { name: 'duckdb' })`.
 *
 * Vite (driving Vitest browser mode) resolves the bare `@duckdb/...`
 * specifier from the worker realm. The DuckDB engine itself spawns
 * its own internal worker for SQL execution; we use the standard
 * jsDelivr-bundle pattern so URL resolution doesn't depend on Vite-
 * specific plugins.
 */

import * as duckdb from '@duckdb/duckdb-wasm'

let _db: duckdb.AsyncDuckDB | null = null
let _initPromise: Promise<duckdb.AsyncDuckDB> | null = null

/** Lazily instantiate DuckDB. First call kicks off bundle selection,
 *  worker spawn, and WASM instantiation; subsequent calls return the
 *  same instance. */
export async function getDb(): Promise<duckdb.AsyncDuckDB> {
  if (_db !== null) return _db
  if (_initPromise !== null) return _initPromise
  _initPromise = (async () => {
    const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles())
    const worker_url = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }),
    )
    const worker = new Worker(worker_url)
    const logger = new duckdb.ConsoleLogger()
    const db = new duckdb.AsyncDuckDB(logger, worker)
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker)
    URL.revokeObjectURL(worker_url)
    _db = db
    return db
  })()
  return _initPromise
}
