export type { Command, Operator, Pipeline, Redirect, RedirectType, Script } from './ast'
export type { CommandContext, CommandHandler, CommandResult } from './context'
export { ParseError, TerminalError } from './errors'
export type { FileInfo, FileMetadata, FileSystem } from './fs/protocol'
export { toScript } from './parser'
export {
  maskQuotes,
  unmaskAndUnquote,
  unmaskQuotes,
  type MaskResult,
} from './quote-masker'
