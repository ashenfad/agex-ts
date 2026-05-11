/**
 * Operation errors raised by `VirtualGit`.
 *
 * The CLI translates these into termish `TerminalError` instances so
 * the agent sees a clean `git: <message>` line. Direct callers can
 * catch `AgentGitError` (or specific subclasses) to react
 * programmatically.
 */

export class AgentGitError extends Error {
  override readonly name: string = 'AgentGitError'
}

export class BranchExists extends AgentGitError {
  override readonly name = 'BranchExists'
}

export class BranchNotFound extends AgentGitError {
  override readonly name = 'BranchNotFound'
}

/** Operation requires at least one commit on the current branch. */
export class UnbornBranch extends AgentGitError {
  override readonly name = 'UnbornBranch'
}

/** Refused because the working tree has uncommitted visible changes. */
export class PendingChanges extends AgentGitError {
  override readonly name = 'PendingChanges'
}

export class NothingToCommit extends AgentGitError {
  override readonly name = 'NothingToCommit'
}

/** A user-supplied path didn't match any known file. */
export class PathSpecError extends AgentGitError {
  override readonly name = 'PathSpecError'
}

/** Refused to delete a branch whose tip isn't reachable from HEAD. */
export class BranchNotMerged extends AgentGitError {
  override readonly name = 'BranchNotMerged'
}
