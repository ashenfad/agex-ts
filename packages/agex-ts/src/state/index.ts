/**
 * State sub-path — backends and configuration types.
 *
 * `Live` is the in-process default; kvgit-backed adapters land in
 * a follow-up commit. The `StateBackend` / `VersionedStateBackend`
 * interfaces are the shared surface every backend implements.
 */

export { isVersioned, type StateBackend, type VersionedStateBackend } from './backend'
export { Live } from './live'
