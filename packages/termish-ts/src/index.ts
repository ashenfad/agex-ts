// Core types — implementations land in subsequent sub-commits.
export type { Command, Operator, Pipeline, Redirect, RedirectType, Script } from './ast'
export type { CommandContext, CommandHandler, CommandResult } from './context'
export { ParseError, TerminalError } from './errors'
export type { FileInfo, FileMetadata, FileSystem } from './fs/protocol'
