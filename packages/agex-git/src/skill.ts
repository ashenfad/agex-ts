/**
 * Skill markdown for the `git` host command.
 *
 * Mounted at `/skills/git/SKILL.md` by `registerGit()`. Inlined here
 * as a template literal so the package ships without a separate
 * data file (tsup-bundlable, no fs-read at runtime).
 *
 * Keep in sync with agex-py's `agex/skills/git.md` — divergences
 * should be intentional and documented in commit messages.
 */
export const GIT_SKILL_MD = `---
name: git
description: Version control for your workspace files — checkpoint, branch, diff, and reset.
---

# Git — workspace version control

You have access to a \`git\` command in \`terminal_action\` that
tracks your workspace files. All file writes (via \`write_file\`,
\`edit_file\`, or shell redirection inside \`terminal_action\`) are
automatically tracked — there is no staging area and no \`git add\`
step required for a basic checkpoint.

## Quick reference

### Checkpointing
\`\`\`bash
git commit -m "describe what you just did"
git log --oneline
\`\`\`
Commit early and often. Each commit is a named checkpoint you can
return to.

### Inspecting changes
\`\`\`bash
git diff                    # diff HEAD vs working tree
git diff HEAD~2             # diff HEAD~2 vs working tree
git show HEAD:path/to/file  # view a file at a specific commit
git status                  # current branch + staged/unstaged + recent commits
\`\`\`

### Branching for experiments
\`\`\`bash
git checkout -b experiment   # create and switch to a new branch
# ... try something ...
git commit -m "attempted approach A"

git checkout main            # switch back
git checkout -b experiment2  # try another approach
# ... try something else ...
git commit -m "attempted approach B"

# keep the one that worked:
git checkout main
git merge experiment2
git branch -d experiment     # delete the failed branch
\`\`\`

### Recovering from mistakes
\`\`\`bash
git log --oneline            # find the commit you want
git reset --hard HEAD~1      # undo the last commit
git diff HEAD~1              # check what changed before resetting
\`\`\`

## Key differences from real git

- **\`git add\` is optional** — if you \`git commit\` without adding
  files first, all pending changes are committed. Use \`git add <file>\`
  when you want to commit only specific files.
- **\`git commit -m "msg"\`** checkpoints the current state with your
  message. Every commit must include \`-m\`.
- **Local only** — no \`push\`, \`pull\`, \`fetch\`, or \`remote\`.
  Your workspace is the only copy.
- **Only \`reset --hard\`** — no \`--soft\` or \`--mixed\`.
- **Merges are "source wins"** on conflict — no three-way text merge.
  When both branches changed the same file, the source's version is
  taken. Use branches for independent experiments rather than parallel
  edits to the same file.

## When to use git

- **Before risky changes**: \`git commit -m "working state before refactor"\`
- **After completing a logical unit of work**: \`git commit -m "implemented date parser"\`
- **When exploring alternatives**: create a branch, try it, merge or delete
- **When debugging**: \`git diff HEAD~1\` to see what you just changed
`
