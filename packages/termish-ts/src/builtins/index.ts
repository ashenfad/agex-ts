/**
 * Registry of bundled builtins.
 *
 * Each wave of builtins (filesystem, I/O, text, search, etc.)
 * extends this map. The interpreter looks up a command name here
 * after first checking the host-injected map — host commands
 * override builtins on name collision.
 */

import type { CommandHandler } from '../context'
import { gunzip, gzip, tar, unzip, zip } from './archive'
import { diff } from './diff'
import { basename, cd, cp, dirname, ls, mkdir, mv, pwd, rm, touch } from './filesystem'
import { cat, echo, head, tail, tee } from './io'
import { find, grep } from './search'
import { sed } from './sed'
import { cut, sort, tr, uniq, wc } from './text'
import { xargs } from './xargs'

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
  ['head', head],
  ['tail', tail],
  ['tee', tee],
  // Text
  ['wc', wc],
  ['sort', sort],
  ['uniq', uniq],
  ['cut', cut],
  ['tr', tr],
  // Search
  ['grep', grep],
  ['find', find],
  // Diff
  ['diff', diff],
  // Sed
  ['sed', sed],
  // Meta
  ['xargs', xargs],
  // Archive
  ['gzip', gzip],
  ['gunzip', gunzip],
  ['tar', tar],
  ['zip', zip],
  ['unzip', unzip],
])
