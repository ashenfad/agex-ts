/**
 * Registry of bundled builtins.
 *
 * Each wave of builtins (filesystem, I/O, text, search, etc.)
 * extends this map. The interpreter looks up a command name here
 * after first checking the host-injected map — host commands
 * override builtins on name collision.
 */

import type { CommandHandler } from '../context'
import { gunzip, gzip, tar, unzip, zcat, zip } from './archive'
import { md5sum, sha256sum } from './checksum'
import { date } from './clock'
import { bracket, test } from './conditional'
import { false_, true_ } from './control'
import { diff } from './diff'
import { file } from './file'
import { basename, cd, cp, dirname, ls, mkdir, mv, pwd, rm, touch } from './filesystem'
import { du, realpath, stat } from './fsinfo'
import { command, help, which } from './info'
import { cat, echo, head, printf, tail, tee } from './io'
import { comm, paste, rev, seq } from './lines'
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
  ['printf', printf],
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
  ['zcat', zcat],
  ['gzcat', zcat],
  ['tar', tar],
  ['zip', zip],
  ['unzip', unzip],
  // Inspection
  ['file', file],
  ['du', du],
  ['stat', stat],
  ['realpath', realpath],
  ['md5sum', md5sum],
  ['sha256sum', sha256sum],
  // Lines
  ['seq', seq],
  ['paste', paste],
  ['comm', comm],
  ['rev', rev],
  // Time
  ['date', date],
  // What's here
  ['which', which],
  ['command', command],
  ['help', help],
  // Control
  ['true', true_],
  ['false', false_],
  ['test', test],
  ['[', bracket],
])
