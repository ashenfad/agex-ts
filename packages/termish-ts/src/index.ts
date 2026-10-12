export type { Command, Operator, Pipeline, Redirect, RedirectType, Script } from './ast'
export type { CommandContext, CommandHandler, CommandResult, Stdin, Stdout } from './context'
export { ParseError, TerminalError, type TerminalErrorOptions } from './errors'
export { FsError, describeFsError, type FsErrorCode } from './fs/errors'
export type { FileInfo, FileMetadata, FileSystem } from './fs/protocol'
export { compileGlob, glob, globMatch, hasGlobChars } from './glob'
export { DEV_NULL, execute, executeScript, type ExecuteOptions } from './interpreter'
export { toScript } from './parser'
export {
  maskQuotes,
  unmaskAndUnquote,
  unmaskQuotes,
  type MaskResult,
} from './quote-masker'
