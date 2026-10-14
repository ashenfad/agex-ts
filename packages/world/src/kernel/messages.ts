/**
 * The messages between the host and the kernel's worker.
 *
 * One run at a time: the host sends `run`, the worker answers with
 * `output`s and `call`s while the code runs, and ends with `done`.
 * Every worker message carries the run's id, so anything a terminated
 * worker sent late is recognised and dropped.
 */

import type { UiHarvest } from './ui-values'

/** An error as it crosses the worker boundary. */
export interface SerializedError {
  readonly name: string
  readonly message: string
  /** A string `code` the error carried (an `FsError`'s `ENOENT`). */
  readonly code?: string
  readonly stack?: string
}

/** One image the code showed, base64-encoded. */
export interface Image {
  readonly format: 'png' | 'jpeg' | 'webp'
  readonly data: string
}

/** A host object as the worker sees it: a name and the methods code
 *  may call on it. */
export interface HostObjectSurface {
  readonly name: string
  readonly methods: readonly string[]
  /** Its stub's source: `(remote) => object`, run in the worker. */
  readonly stub?: string
}

/** A module from the world's files, compiled for the worker: the body
 *  of `async (__exports, __modules, __registered, __load) => …`, which
 *  returns the module's exports. */
export interface CompiledModule {
  readonly path: string
  readonly body: string
}

export type Host2Worker =
  | {
      readonly type: 'run'
      readonly runId: number
      /** The prepared code: imports rewritten, types stripped. */
      readonly code: string
      /** World modules the code imports, dependencies first. */
      readonly modules: readonly CompiledModule[]
      readonly hostObjects: readonly HostObjectSurface[]
      /** The profile's values, each bound by name: a copy per run. */
      readonly values: Readonly<Record<string, unknown>>
      readonly env: Readonly<Record<string, string>>
      /** The profile's secrets' names (never their values), for
       *  `secret(name)`. */
      readonly secrets: readonly string[]
      readonly hasCache: boolean
      /** Whether bare imports are resolved by the host. */
      readonly hasResolver: boolean
      /** `fetch('/path')` reads the world's files: everywhere (true),
       *  under these prefixes, or not at all (false). */
      readonly routeFetch: boolean | readonly string[]
      /** Bind `ui`, and send back what the code put in it. */
      readonly ui: boolean
    }
  | {
      readonly type: 'reply'
      readonly runId: number
      readonly callId: number
      readonly ok: true
      readonly value: unknown
    }
  | {
      readonly type: 'reply'
      readonly runId: number
      readonly callId: number
      readonly ok: false
      readonly error: SerializedError
    }

export type Worker2Host =
  | { readonly type: 'ready' }
  | {
      readonly type: 'output'
      readonly runId: number
      readonly part:
        | { readonly type: 'text'; readonly stream: 'stdout' | 'stderr'; readonly text: string }
        | ({ readonly type: 'image' } & Image)
    }
  | {
      /** A call the code made to the host. `target` is the binding:
       *  `fs`, `cache`, a host object (`host`, with `subject` its
       *  name), or `resolve` (a bare import specifier to a URL). */
      readonly type: 'call'
      readonly runId: number
      readonly callId: number
      readonly target: 'fs' | 'cache' | 'host' | 'resolve'
      readonly subject?: string
      readonly method: string
      readonly args: readonly unknown[]
    }
  | {
      readonly type: 'done'
      readonly runId: number
      /** What a top-level `return` gave, shown as text; null for none. */
      readonly value: string | null
      readonly error: SerializedError | null
      /** What the code put in `ui`, for a run that binds it. */
      readonly ui?: UiHarvest
    }

/** The filesystem methods code may call, as termish's `FileSystem`
 *  names them. */
export const FS_METHODS = [
  'getcwd',
  'chdir',
  'read',
  'write',
  'exists',
  'isFile',
  'isDir',
  'stat',
  'mkdir',
  'remove',
  'rmdir',
  'rename',
  'list',
  'listDetailed',
] as const

/** The cache methods code may call. */
export const CACHE_METHODS = ['get', 'set', 'has', 'delete', 'keys'] as const

export function serializeError(e: unknown): SerializedError {
  if (e instanceof Error) {
    const { code, path } = e as { code?: unknown; path?: unknown }
    // An FsError keeps its path apart from its message; code needs both.
    const message =
      typeof path === 'string' && path !== '' && !e.message.includes(path)
        ? `${e.message}: ${path}`
        : e.message
    return {
      name: e.name,
      message,
      ...(typeof code === 'string' && { code }),
      ...(e.stack !== undefined && { stack: e.stack }),
    }
  }
  return { name: 'Error', message: String(e) }
}
