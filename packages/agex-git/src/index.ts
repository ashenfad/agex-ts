// Public surface.
export { makeGitHandler, registerGit } from './cli'
export { FileNotFoundError, VirtualGit } from './core'
export { isBinary, unifiedDiff } from './diff'
export {
  AgentGitError,
  BranchExists,
  BranchNotFound,
  BranchNotMerged,
  NothingToCommit,
  PathSpecError,
  PendingChanges,
  UnbornBranch,
} from './errors'
export { DEFAULT_BRANCH, METADATA_KEY, Metadata } from './metadata'
export {
  HASH_PREFIX_MIN_LEN,
  InvalidRef,
  allAgentCommits,
  allAncestors,
  isAgentCommit,
  mergeBase,
  resolveRef,
  virtualParents,
  walkVirtualAncestry,
} from './refs'
export type { AgentCommit, Status } from './types'
