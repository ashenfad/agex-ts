/**
 * Registry of bundled builtins.
 *
 * Each wave of builtins (filesystem, I/O, text, search, etc.)
 * extends this map. The interpreter looks up a command name here
 * after first checking the host-injected map — host commands
 * override builtins on name collision.
 */

import type { CommandHandler } from '../context'
import { basename, cd, cp, dirname, ls, mkdir, mv, pwd, rm, touch } from './filesystem'
import { cat, echo } from './io'

export const BUILTINS: ReadonlyMap<string, CommandHandler> = new Map<string, CommandHandler>([
  // Filesystem
  ['pwd', pwd],
  ['cd', cd],
  ['ls', ls],
  ['mkdir', mkdir],
  ['touch', touch],
  ['cp', cp],
  ['mv', mv],
  ['rm', rm],
  ['basename', basename],
  ['dirname', dirname],
  // I/O
  ['echo', echo],
  ['cat', cat],
])
