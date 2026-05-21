# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs across its 8 published packages. Each user-visible change ships with a markdown file in `.changeset/` describing what changed and how to bump the affected packages' versions.

## Day-to-day: adding a changeset to a PR

After making a change that affects one or more published packages:

```bash
pnpm changeset
```

The interactive prompt asks:

1. **Which packages changed?** (space to toggle, enter to confirm)
2. **For each package, what's the bump?**
   - `patch` — bug fix, internal refactor with no API impact
   - `minor` — backward-compatible feature OR (pre-1.0 only) a breaking change
   - `major` — breaking change (post-1.0)
3. **A one-line summary** — goes into the package's `CHANGELOG.md` verbatim. Write it from a consumer's perspective ("Added X", "Fixed Y when Z").

Commit the generated `.changeset/<random-name>.md` file with the rest of your PR.

### Semver in 0.x

While we're pre-1.0, the convention is:

- `minor` (0.1.0 → 0.2.0) = **breaking change**
- `patch` (0.1.0 → 0.1.1) = backward-compatible (features OR fixes)

Once a package hits 1.0, the prompts behave as standard semver:

- `major` = breaking, `minor` = additive, `patch` = fixes

## Cutting a release

When you're ready to publish whatever changesets are pending on `main`:

```bash
# Bump versions + update CHANGELOG.md per package + delete consumed changeset files
pnpm changeset version

# Inspect the resulting diff:
git diff

# Publish newly-bumped packages and create git tags
pnpm changeset publish
git push --follow-tags
```

`pnpm changeset publish` runs `pnpm publish -r` under the hood — it respects the workspace dependency graph, so packages publish in topological order (`@agex-ts/kvgit` → `@agex-ts/termish` → `agex-ts` → providers).

### What gets re-published when an internal dep bumps

Config (`updateInternalDependencies: "patch"`): when an internal dep minor-bumps, dependents get a patch-bump and re-publish with the updated dep. Example: a `minor` change to `agex-ts` causes `@agex-ts/anthropic`, `@agex-ts/openai`, etc. to ship a patch release pointing at the new `agex-ts`.

## What does *not* need a changeset

- Documentation-only changes (READMEs, `docs/`)
- CI / tooling changes that don't affect package consumers
- Internal refactors that don't change any package's public surface
- Changes to `examples/` (they're private, not published)

If unsure, add one — `patch` with a short description is fine.

## Initial publish (one-time, before Changesets governs)

The packages are already at `0.1.0` in their manifests. The very first publish does not go through `changeset version` — versions are already set. Just run:

```bash
pnpm publish -r --no-git-checks
```

Every release after that uses the standard flow above.
