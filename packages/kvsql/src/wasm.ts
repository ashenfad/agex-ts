/**
 * Moving bytes and out-parameters across the wasm boundary.
 *
 * Every buffer SQLite allocates is freed here, on success and on error,
 * and every byte array handed to SQLite is a copy in wasm memory that
 * lives only for the call that needs it.
 */

import type { Sqlite3Static, WasmPointer } from '@sqlite.org/sqlite-wasm'
import { SqliteError } from './errors'

/** Throw a {@link SqliteError} unless `rc` is `SQLITE_OK`. */
export function check(sqlite3: Sqlite3Static, rc: number, what: string): void {
  if (rc !== 0) throw new SqliteError(what, rc, sqlite3.capi.sqlite3_js_rc_str(rc) ?? '')
}

/**
 * Call `fn(pn, pp)`, which sets `*pn` to a length and `*pp` to a buffer
 * SQLite allocated, and return a copy of that buffer. The buffer is
 * freed whether or not `fn` succeeded.
 */
export function outBytes(
  sqlite3: Sqlite3Static,
  what: string,
  fn: (pn: WasmPointer, pp: WasmPointer) => number,
): Uint8Array {
  const { wasm, capi } = sqlite3
  const sp = wasm.pstack.pointer
  try {
    const pn = wasm.pstack.alloc(4)
    const pp = wasm.pstack.allocPtr()
    wasm.poke32(pn, 0)
    wasm.pokePtr(pp, 0)
    const rc = fn(pn, pp)
    const p = Number(wasm.peekPtr(pp))
    try {
      check(sqlite3, rc, what)
      const n = wasm.peek32(pn)
      return n > 0 ? wasm.heap8u().slice(p, p + n) : new Uint8Array(0)
    } finally {
      if (p) capi.sqlite3_free(p)
    }
  } finally {
    wasm.pstack.restore(sp)
  }
}

/**
 * Call `fn(pp)`, which sets `*pp` to a handle SQLite created, and
 * return the handle. On failure nothing was created (SQLite leaves
 * `*pp` null when it fails), so there is nothing to release.
 */
export function outHandle(
  sqlite3: Sqlite3Static,
  what: string,
  fn: (pp: WasmPointer) => number,
): WasmPointer {
  const { wasm } = sqlite3
  const sp = wasm.pstack.pointer
  try {
    const pp = wasm.pstack.allocPtr()
    wasm.pokePtr(pp, 0)
    check(sqlite3, fn(pp), what)
    return Number(wasm.peekPtr(pp))
  } finally {
    wasm.pstack.restore(sp)
  }
}

/** Copy `bytes` into wasm memory for the duration of `fn(p)`. */
export function withBytes<T>(
  sqlite3: Sqlite3Static,
  bytes: Uint8Array,
  fn: (p: WasmPointer) => T,
): T {
  const { wasm } = sqlite3
  const p = wasm.alloc(Math.max(1, bytes.byteLength))
  try {
    wasm.heap8u().set(bytes, Number(p))
    return fn(p)
  } finally {
    wasm.dealloc(p)
  }
}

/** Read an `int` out-parameter set by `fn(p)`. */
export function outInt(sqlite3: Sqlite3Static, fn: (p: WasmPointer) => number): [number, number] {
  const { wasm } = sqlite3
  const sp = wasm.pstack.pointer
  try {
    const p = wasm.pstack.alloc(4)
    wasm.poke32(p, 0)
    const rc = fn(p)
    return [rc, wasm.peek32(p)]
  } finally {
    wasm.pstack.restore(sp)
  }
}
