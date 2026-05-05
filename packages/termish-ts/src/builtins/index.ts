/**
 * Registry of bundled builtins.
 *
 * Each wave of builtins (filesystem, I/O, text, search, etc.)
 * extends this map. The interpreter looks up a command name here
 * after first checking the host-injected map — host commands
 * override builtins on name collision.
 */

import type { CommandHandler } from '../context'
import { cat, echo } from './io'

export const BUILTINS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  ['echo', echo],
  ['cat', cat],
])
