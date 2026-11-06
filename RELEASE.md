# Release process

This document captures the mechanics of cutting a Manki release. Keep it short, keep it accurate.

## Joint version bump (enforced by CI)

When you add a new `## [X.Y.Z]` heading to `CHANGELOG.md`, you MUST bump `package.json` and `package-lock.json` to the same `X.Y.Z` in the same commit.

CI enforces this: `scripts/check-changelog-version.js` runs on every PR and on `main`, and fails if `package.json` `version` does not match the most recent non-`Unreleased` `## [X.Y.Z]` heading in `CHANGELOG.md`. The check was added after `v5.0.0` and `v5.0.1` shipped with `package.json` still pinned at `4.7.0` (see [#783](https://github.com/manki-review/manki/issues/783)).

To run the check locally:

```sh
npm run check-changelog-version
```

## Release PR checklist

1. Write a new `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md` from the PRs merged since the last tag (`git log --oneline vPREV..main`, then each PR's title and body), grouped by what a Manki user notices, not by PR. Use these sections in this order and leave out any that are empty: Breaking changes and migration (or Upgrading for a minor release), Review loop and verdicts, Review format, Security, Static analysis, Reviewer groups and models, Reliability, Docs, Internal. A new feature area, such as Webhook mode, gets its own section after the first one. Each entry is one or two plain sentences on what changed for the user, ending with the PR links. Fold anything still under `## [Unreleased]` into it. Feature and fix PRs never edit `CHANGELOG.md`, and CI rejects one that does, so this is the only place entries are written.
2. Bump `version` in `package.json` to `X.Y.Z`.
3. Refresh `package-lock.json` (`npm install` will do it).
4. Open the release PR. CI runs `check-changelog-version` automatically.
5. Once merged, push the merged release commit on `main` to a release branch: `git push origin <sha>:refs/heads/release/vX.Y.Z`. The `Release` workflow (`.github/workflows/release.yml`) checks that the commit is on `main`, that it is the commit that bumps the version, and that `package.json` and `CHANGELOG.md` say `X.Y.Z`. It then builds `dist/`, commits it on top of the release commit and pushes that build commit to `release/vX.Y.Z`. It never writes tags. `main` never carries `dist/`.
6. An org admin runs `scripts/publish-release.sh vX.Y.Z` from a clone of the repo, with Node 24 and `gh` signed in. Run it with `--dry-run` first to print the commands that write tags or the release without running them. The script waits for the build commit and repeats the workflow's checks on the release commit. It then rebuilds `dist/` from the release commit and refuses unless the build commit is exactly the release commit plus that fresh `dist/`. It creates the annotated tag `vX.Y.Z` on the build commit, pushes it, publishes the GitHub Release with the `CHANGELOG.md` section as its notes, and moves the major tag (`vX`) to the same commit. It leaves `vX` alone when a newer `vX` release exists. Keep the release branch, because the script reads the build commit from it.

## Tag ruleset

An org ruleset on `refs/tags/v*` restricts creating, updating and deleting release tags, and only org admins can bypass it. GitHub can't exempt GitHub Actions from a ruleset, which is why the workflow builds on a branch and an admin writes the tags.

## Immutable releases

Immutable releases are enabled in the repository settings. Once a release is published, its tag can't be moved or deleted and its assets can't change. Deleting the release doesn't free the tag name either. This is why the script only publishes after `vX.Y.Z` points at the build commit. A release asset, if one is ever added, has to be attached in the script's `gh release create` call, because the release is published as it is created. If a published release turns out broken, cut a new patch version. Never re-push `vX.Y.Z`. The major tag `vX` has no release of its own, so the script can keep moving it.

If the workflow fails, rerun it. A rerun sees `dist/` on the release branch and skips the rebuild. The script is safe to rerun too: it skips every step that is already done, publishes an existing draft, and refuses to move a `vX.Y.Z` tag that points anywhere but the build commit.

## Why all three files in one commit

The published action consumers reference the major tag (`vX`), but anyone inspecting the repo via `npm`, `package.json`, or the GitHub UI expects `package.json` and `CHANGELOG.md` to agree. Splitting the bump across PRs is what allowed the `v5.0.0` / `v5.0.1` drift in the first place. The CI check makes the joint bump non-optional.
