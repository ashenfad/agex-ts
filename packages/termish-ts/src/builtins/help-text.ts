/**
 * What `help` says of each builtin: a one-line summary for the list,
 * its usage for `help NAME`, and for a command that is a subset of the
 * GNU one, notes on what it reads and what it doesn't. The same text as
 * termish-py's `help_text.py`, entry for entry.
 */

export interface HelpEntry {
  readonly summary: string
  readonly usage: string
  readonly notes?: string
}

const SED_NOTES = [
  'Supported (a subset of GNU sed):',
  '  -n          print only what p (or s///p) prints',
  '  -i          edit FILEs in place (no backup suffix)',
  String.raw`  -E, -r      extended regex; without it, basic (\( \) \{ \} \| \+ \?)`,
  '  addresses   N, $, /RE/, or a range A,B of those',
  '  commands    s/RE/REPL/[gip] (any delimiter), y/SRC/DST/, p, d, q,',
  '              a TEXT, i TEXT, c TEXT; separate them with ; or newlines',
  String.raw`  REPL        & or \0 (the match), \1-\9 (groups), \n, \t`,
  'Lines are edited one at a time: a pattern never matches across a newline.',
  'For more than this, use awk, or edit the file another way.',
  'Not supported: {...} blocks, ! (negation), first~step, A,+N, 0,/RE/,',
  '  hold space (h H g G x), n N P D, branches (b t T :label), = l r w,',
  '  s flags other than g i p (N, w, I, m, e), -i SUFFIX, -s, -z',
].join('\n')

export const HELP: Readonly<Record<string, HelpEntry>> = {
  '[': { summary: 'evaluate a condition (same as test)', usage: '[ EXPRESSION ]' },
  awk: {
    summary: 'scan and process text by patterns and fields',
    usage: "awk [-F FS] [-v VAR=VALUE]... ('PROGRAM' | -f PROGFILE) [FILE...]",
  },
  basename: { summary: 'strip the directory from a path', usage: 'basename PATH [SUFFIX]' },
  cat: {
    summary: 'print files',
    usage: 'cat [-n] [-A | -e | -T] [FILE...]',
  },
  cd: { summary: 'change the working directory', usage: 'cd [DIR]' },
  command: {
    summary: 'run a command, or say whether one exists',
    usage: 'command -v NAME... | command -V NAME... | command NAME [ARG...]',
  },
  comm: {
    summary: 'compare two sorted files line by line',
    usage: 'comm [-1] [-2] [-3] FILE1 FILE2',
  },
  cp: { summary: 'copy files and directories', usage: 'cp [-r] [-a] SOURCE... DEST' },
  cut: {
    summary: 'select fields or characters from each line',
    usage: 'cut (-f LIST [-d DELIM] | -c LIST | -b LIST) [--complement] [FILE...]',
  },
  date: {
    summary: 'print the current date and time',
    usage: 'date [-u] [+FORMAT | -I[date|hours|minutes|seconds] | -R]',
  },
  diff: {
    summary: 'compare files line by line',
    usage: 'diff [-u | -U N | -c | -q] [-r] [-i] [-w] [-b] [-B] FILE1 FILE2',
  },
  dirname: { summary: 'strip the last component from a path', usage: 'dirname PATH' },
  du: {
    summary: 'sum file sizes under directories (file bytes, not disk blocks)',
    usage: 'du [-s | -a] [-c] [-h] [PATH...]',
  },
  echo: { summary: 'print arguments', usage: 'echo [-n] [-e] [ARG...]' },
  false: { summary: 'fail, doing nothing', usage: 'false' },
  file: { summary: "guess a file's type from its contents", usage: 'file FILE...' },
  find: {
    summary: 'search a directory tree',
    usage:
      'find [PATH...] [-maxdepth N] [-mindepth N] [-name P] [-iname P] [-path P] [-type f|d] [-size N] [-empty] [-print] [-delete] [-exec CMD {} ;]',
  },
  grep: {
    summary: 'search for a pattern in lines',
    usage:
      'grep [-i] [-n] [-r] [-l | -L | -c | -o | -q] [-v] [-w] [-E | -F] [-A N] [-B N] [-C N] [-m N] [-e PATTERN]... PATTERN [FILE...]',
  },
  gunzip: { summary: 'decompress .gz files', usage: 'gunzip [-k] [-f] [-c] FILE...' },
  gzcat: { summary: 'print .gz files decompressed (same as zcat)', usage: 'gzcat FILE...' },
  gzip: { summary: 'compress files', usage: 'gzip [-d] [-k] [-f] [-c] FILE...' },
  head: { summary: 'print the first lines of files', usage: 'head [-n N | -c N] [FILE...]' },
  help: {
    summary: 'list the commands, or show how one is used',
    usage: 'help [NAME]',
  },
  ls: {
    summary: 'list directory contents',
    usage: 'ls [-l] [-a] [-R] [-h] [-t | -S] [-r] [-d] [-F] [-1] [PATH...]',
  },
  md5sum: {
    summary: 'print or check MD5 checksums',
    usage: 'md5sum [-c] [FILE...]',
  },
  mkdir: { summary: 'make directories', usage: 'mkdir [-p] DIR...' },
  mv: { summary: 'move or rename files', usage: 'mv [-f | -n] SOURCE... DEST' },
  paste: {
    summary: 'join lines of files side by side',
    usage: 'paste [-s] [-d LIST] [FILE...]',
  },
  printf: { summary: 'print formatted text', usage: 'printf FORMAT [ARG...]' },
  pwd: { summary: 'print the working directory', usage: 'pwd' },
  realpath: {
    summary: 'print absolute, normalized paths (symlinks not expanded)',
    usage: 'realpath [-e | -m] [-s] PATH...',
  },
  rev: { summary: "reverse each line's characters", usage: 'rev [FILE...]' },
  rm: { summary: 'remove files and directories', usage: 'rm [-r] [-f] PATH...' },
  sed: {
    summary: 'edit text as a stream',
    usage: 'sed [-n] [-i] [-E] (-e SCRIPT)... | SCRIPT [FILE...]',
    notes: SED_NOTES,
  },
  seq: {
    summary: 'print a sequence of numbers',
    usage: 'seq [-s SEP] [-w] [FIRST [INCR]] LAST',
  },
  sha256sum: {
    summary: 'print or check SHA-256 checksums',
    usage: 'sha256sum [-c] [FILE...]',
  },
  sort: {
    summary: 'sort lines',
    usage: 'sort [-r] [-n] [-u] [-f] [-k FIELD]... [-t SEP] [FILE...]',
  },
  stat: {
    summary: "show a file's size, type and times",
    usage: 'stat [-c FORMAT] PATH...  (FORMAT: %n %s %F %y %Y %w %W %%)',
  },
  tail: { summary: 'print the last lines of files', usage: 'tail [-n N | -n +N | -c N] [FILE...]' },
  tar: {
    summary: 'create, list or extract tar archives',
    usage: 'tar (-c | -x | -t) [-z] [-v] -f ARCHIVE [-C DIR] [--strip-components N] [PATH...]',
  },
  tee: { summary: 'copy stdin to stdout and files', usage: 'tee [-a] FILE...' },
  test: { summary: 'evaluate a condition', usage: 'test EXPRESSION' },
  touch: { summary: 'create files, or update their times', usage: 'touch [-c] FILE...' },
  tr: {
    summary: 'translate, squeeze or delete characters',
    usage: 'tr [-c] [-d] [-s] SET1 [SET2]',
  },
  true: { summary: 'succeed, doing nothing', usage: 'true' },
  uniq: {
    summary: 'collapse repeated adjacent lines',
    usage: 'uniq [-c] [-d | -u] [-i] [FILE]',
  },
  unzip: {
    summary: 'list or extract zip archives',
    usage: 'unzip [-l] [-o] [-d DIR] ARCHIVE',
  },
  wc: { summary: 'count lines, words and bytes', usage: 'wc [-l] [-w] [-c] [-m] [-L] [FILE...]' },
  which: { summary: 'say whether commands exist', usage: 'which NAME...' },
  xargs: {
    summary: 'run a command with arguments read from stdin',
    usage: 'xargs [-0] [-n N | -I REPLACE] [-t] COMMAND [ARG...]',
  },
  zcat: { summary: 'print .gz files decompressed', usage: 'zcat [-f] FILE...' },
  zip: { summary: 'create zip archives', usage: 'zip [-r] ARCHIVE PATH...' },
}
