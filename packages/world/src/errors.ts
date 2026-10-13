/** The base of every error the world raises itself. Storage errors
 *  (kvgit's `KvgitError`s) and filesystem errors (termish's `FsError`)
 *  pass through as they are. */
export class WorldError extends Error {
  override readonly name: string = 'WorldError'
}

/** A session, tag or ref name the world doesn't accept. */
export class InvalidNameError extends WorldError {
  override readonly name: string = 'InvalidNameError'
}

/** No session by that name. */
export class UnknownSessionError extends WorldError {
  override readonly name: string = 'UnknownSessionError'
  constructor(readonly session: string) {
    super(`no session named '${session}'`)
  }
}

/** A session by that name already exists. */
export class SessionExistsError extends WorldError {
  override readonly name: string = 'SessionExistsError'
  constructor(readonly session: string) {
    super(`a session named '${session}' already exists`)
  }
}

/** A ref that names no commit of this session, or names several. */
export class UnknownRefError extends WorldError {
  override readonly name: string = 'UnknownRefError'
  constructor(
    readonly ref: string,
    reason = 'names no commit of this session',
  ) {
    super(`'${ref}' ${reason}`)
  }
}

/** A change asked of a workspace that can't take one: a frozen view of
 *  a commit, or a closed workspace. */
export class ReadOnlyError extends WorldError {
  override readonly name: string = 'ReadOnlyError'
}

/** A commit lost a race to another writer of the same session, and the
 *  two changed something in ways no merge rule settles. The changes
 *  are still pending; `discard()` drops them, or `refresh()` drops
 *  them and moves to the session's latest commit. */
export class CommitConflictError extends WorldError {
  override readonly name: string = 'CommitConflictError'
  constructor(
    readonly session: string,
    readonly keys: ReadonlySet<string>,
    options?: ErrorOptions,
  ) {
    super(
      `commit failed: a concurrent commit to session '${session}' conflicts on ${[...keys].sort().join(', ')}`,
      options,
    )
  }
}
