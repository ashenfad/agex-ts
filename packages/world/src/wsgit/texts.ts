// Generated from nontainer's nontainer/wsgit.py (e8d8522); keep it word for word.
// What ws-git prints is text a model reads, checked against nontainer's
// recorded output (tests/wsgit-corpus).

export const USAGE =
  'usage: ws-git (stage|add|unstage|commit|reset|status|diff|log|show|checkout|tag|stash|branch|merge|revert|cherry-pick|worktree|sparse-checkout) [...]'

/** Each verb's synopsis, for the one line a verb given arguments it
 *  doesn't take prints; the whole surface is `ws-git help`. */
export const FORMS: Readonly<Record<string, string>> = {
  stage: 'stage (<paths> | -A)',
  add: 'add (<paths> | -A)',
  unstage: 'unstage <paths>',
  commit: 'commit [-m MSG]',
  reset: 'reset',
  status: 'status [--porcelain | -s | --short]',
  diff: 'diff [<session>] [--cached] [--check] [--stat] [[--] <paths>]',
  log: 'log [<session>] [-n N] [--all] [-S <string>]',
  show: 'show <ref>[:<path>]',
  checkout: 'checkout <ref> [-- <paths>]',
  tag: 'tag [[-f] <name> [<commit>] | -d <name>]',
  stash: 'stash [push [-m MSG] | list | pop [stash@{N}] | drop [stash@{N}] | show [stash@{N}]]',
  branch: 'branch [<name> [--at <ref>] [--fresh] [--paths <paths>]]',
  merge: 'merge (<session> | --abort)',
  revert: 'revert <commit>',
  'cherry-pick': 'cherry-pick <session>@<commit>',
  worktree: 'worktree (add [--trace [--since <ref>]] <dir> <ref> | list | remove <dir>)',
  'sparse-checkout': 'sparse-checkout [list]',
}

export const WORKTREE_FORMS =
  'usage: ws-git worktree add [--trace [--since <ref>]] <dir> (<session>[@<commit>] | <tag>)\n       ws-git worktree list\n       ws-git worktree remove <dir>'

export const HELP =
  "ws-git: the agent's git over this session.\n\nusage: ws-git (stage|add|unstage|commit|reset|status|diff|log|show|\n               checkout|tag|stash|branch|merge|revert|cherry-pick|\n               worktree|sparse-checkout) [...]\n  stage <paths> | -A\n                    add paths to the index; a directory (or .) stages\n                    what is modified under it, -A everything modified\n  add               stage under git's name, the same verb\n  unstage <paths>   drop paths from the index\n  commit [-m MSG]   commit the staged set, or everything modified when\n                    nothing is staged. No -a and no pathspec: what you\n                    left out stays in the tree, uncommitted\n  reset             abandon the composition and keep the tree\n  status [--porcelain | -s | --short]\n                    a view: line, a ## merging line while one is\n                    outstanding, the staged and modified rows in git's\n                    XY columns (M changed, A new, D deleted), then a\n                    worktrees: block\n  diff [<session>] [--cached] [--check] [--stat] [[--] paths...]\n                    unified diff against your last commit; --cached the\n                    staged set; --check finds leftover conflict markers;\n                    --stat a summary per file. A session name shows what\n                    that session changed since the two last met, which\n                    is what `merge <session>` brings (git's A...B), or\n                    since it began when it was forked from a state you\n                    don't hold; a store tag diffs against the state it\n                    names\n  log [<session>] [-n N] [--all] [-S <string>]\n                    your own commits, newest first; a session name\n                    shows that session's and a store tag the tagged\n                    state's; --all every commit the selected session\n                    holds; -S the commits where <string> appeared (+)\n                    or vanished (-)\n  show <ref>        one commit: its message and its diff. A store tag\n                    shows the state it names: the commit it stands on,\n                    then anything written after it. <session>@<commit>\n                    shows one of that session's commits\n  show <ref>:<path> one file at that state, the path from the root; a\n                    directory lists what is in it. For another session\n                    or a store tag, .trace/<path> reads its conversation\n                    as worktree add --trace shows it\n  checkout <ref>    restore the tree to a commit of yours (the restore\n                    is a new commit)\n  checkout <ref> -- <paths>\n                    make just those paths match that ref, which may\n                    name another session or a store tag. A directory is\n                    mirrored\n  tag               your bookmarks, one \"name -> commit\" per line\n  tag [-f] <name> [<commit>]\n                    bookmark a commit of yours, your head by default.\n                    -f moves a name that is taken\n  tag -d <name>     drop a bookmark. The commit stays where it is\n  stash [push [-m MSG]]\n                    put everything you have modified on a branch of its\n                    own (<session>.stash-N) and restore your tree to\n                    your last commit\n  stash list        your stashes, newest first, as stash@{N}: message\n  stash pop [stash@{N}]\n                    merge one back and delete its branch; a pop that\n                    conflicts keeps the stash\n  stash drop [stash@{N}]\n                    delete one without bringing it back\n  stash show [stash@{N}]\n                    what one holds, as a diff against your last commit\n  branch            the sessions on this store, yours marked *\n  branch <name> [--at <ref>] [--fresh] [--paths <paths>]\n                    fork a session; it does not switch. --fresh starts\n                    it with no conversation, --paths narrows what it\n                    can SEE\n  merge <session>   merge that session's last commit into yours.\n                    Conflicts land as markers in the merge commit and\n                    show as UU in status: fix them and commit\n  merge --abort     restore the tree to the commit the merge landed on\n                    and clear the merge\n  revert <commit>   a new commit undoing that commit's change\n  cherry-pick <session>@<commit>\n                    a new commit applying one commit's change from\n                    another session\n  worktree add [--trace [--since <ref>]] <dir> (<session>[@<commit>] | <tag>)\n                    check another session's tree, or a tagged state,\n                    out under <dir>, read-only, and read it with cat,\n                    ls and grep. It is pinned at a commit: to see newer\n                    work, remove it and add it again. --trace adds the\n                    conversation stored at that commit, as markdown\n                    under <dir>/.trace (start at its README.md); each\n                    run's changed.md lists the files it changed.\n                    --since marks the runs new since a state you have\n                    read (a ref, or a commit of that session) with +\n  worktree list     the worktrees here, one line each\n  worktree remove <dir>\n                    take one down\n  sparse-checkout list\n                    the paths this session was given to see, or (full)\n  help              this text\n\nA ref is HEAD, a commit id of seven hex characters or more, a session\nname, <session>@<commit>, a tag of yours, or a store tag — a name the\nhost gave a commit so that it outlives its session. A store tag reads\nfrozen at that commit, and the verbs that read take one: diff, log,\nshow, checkout <ref> -- <paths>, worktree add.\n\nWhile a merge is outstanding nothing else moves the tree: resolve the\nmarkers and commit, or ws-git merge --abort.\n\nNo rebase: history is append-only. There is no .git — branches are\nsessions, history is commits. The workspace commits on its own as you\nwork; ws-git log shows only the commits you made."

/** Corners git has and ws-git doesn't, with what to do instead. */
export const EDGE: Readonly<Record<string, string>> = {
  rebase:
    'no rebase here — history is append-only. Branch from the commit you want (ws-git branch <name> --at <ref>) and merge forward; ws-git checkout <ref> goes back.',
}

export const VERBS: readonly string[] = [
  'stage',
  'add',
  'unstage',
  'commit',
  'reset',
  'status',
  'diff',
  'log',
  'show',
  'checkout',
  'tag',
  'stash',
  'branch',
  'merge',
  'revert',
  'cherry-pick',
  'worktree',
  'sparse-checkout',
  'help',
]
