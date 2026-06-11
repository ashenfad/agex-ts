export { base64ToBytes, bytesToBase64 } from './base64'
export {
  GithubClient,
  type GitCommit,
  type GitPerson,
  type GithubClientOptions,
  type TreeEntry,
} from './client'
export { GithubError, type GithubErrorKind } from './errors'
export { EMPTY_TREE_SHA, gitBlobSha1 } from './git-hash'
export {
  PathPlanner,
  RELOCATION_ROOT,
  SIDECAR_PATH,
  escapeSegment,
  naturalPath,
  relocatedPath,
} from './paths'
export {
  SIDECAR_FORMAT,
  decodeSidecar,
  encodeSidecar,
  wireFromSidecar,
  type DecodedSidecar,
} from './sidecar'
