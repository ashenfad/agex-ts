# Releasing

This monorepo uses [Changesets](https://github.com/changesets/changesets) to manage versioning and per-package CHANGELOGs across its 8 published packages, and publishes from GitHub Actions with npm OIDC provenance (see `.github/workflows/release.yml`). Each user-visible change ships with a markdown file in `.changeset/` describing what changed and how to bump the affected packages' versions.

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

Releases publish from CI. The local sequence is:

1. **Consume pending changesets.** Bumps each affected package's `version`, generates a per-package `CHANGELOG.md` entry from the changeset bodies, and deletes the consumed changeset files.
   ```bash
   pnpm changeset version
   ```

2. **Review the diff.** Sanity-check that the version bumps and CHANGELOG additions match your intent. This is the last chance to catch a bump that's the wrong size.
   ```bash
   git diff
   ```

3. **Commit and push to `main`.**
   ```bash
   git add .
   git commit -m "release: <human-readable description>"
   git push
   ```

4. **Tag and push the tag.** The release workflow fires on tag push and runs the full lint / typecheck / test gate before publishing.
   ```bash
   # Use the highest bumped version as the tag name. The tag is a pointer for humans;
   # CI publishes whichever packages have versions not yet on npm, regardless of tag.
   git tag v0.1.1
   git push --tags
   ```

5. **Watch the workflow run** at https://github.com/ashenfad/agex-ts/actions/workflows/release.yml. Success → packages live on npm with Sigstore provenance attached (the "verified" badge on each package page).

6. **Create a GitHub Release** attached to the tag, for the announcement-ready URL.
   ```bash
   gh release create v0.1.1 --title "v0.1.1" --notes "<summary; reference the per-package CHANGELOG sections>"
   ```

### What gets re-published when an internal dep bumps

Config (`updateInternalDependencies: "patch"`): when an internal dep minor-bumps, dependents get a patch-bump and re-publish with the updated dep. Example: a `minor` change to `agex-ts` causes `@agex-ts/anthropic`, `@agex-ts/openai`, etc. to ship a patch release pointing at the new `agex-ts`.

### What the release workflow does

On `v*` tag push (or manual dispatch from the Actions UI):

1. Checks out the tagged commit on a clean Ubuntu runner.
2. Runs `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm check:dist`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. Any failure aborts before publishing.
3. Runs `pnpm publish -r --provenance --no-git-checks`. The `--provenance` flag triggers the OIDC handshake: GitHub Actions issues a short-lived JWT, npm verifies it against each package's Trusted Publisher config, and the published tarball is attested via Sigstore.
4. pnpm publishes in topological order (`@agex-ts/kvgit` → `@agex-ts/termish` → `agex-ts` → providers) and skips any package whose current version is already on the registry — so partial-publish recovery is safe (re-running the workflow only ships what's actually new).

## What does *not* need a changeset

- Documentation-only changes (READMEs, `docs/`)
- CI / tooling changes that don't affect package consumers
- Internal refactors that don't change any package's public surface
- Changes to `examples/` (they're private, not published)

If unsure, add one — `patch` with a short description is fine.

## Manual fallback (CI down / urgent hotfix / etc.)

If the release workflow is broken and you need to ship anyway, the local-laptop publish path still works as a backup. Requires either the interactive 2FA flow (passkey browser prompt) or an [automation token](https://docs.npmjs.com/creating-and-viewing-access-tokens) exported as `NODE_AUTH_TOKEN`:

```bash
# Same `changeset version` + commit/push/tag steps as above, then:
pnpm publish -r --no-git-checks
git push --tags
```

The manual publish *skips the provenance attestation* — packages ship without the "verified" badge until the next OIDC-published release re-attests them. Acceptable as an emergency escape hatch; not the steady state.
