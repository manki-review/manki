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

1. Write a new `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md` from the PRs merged since the last tag (`git log --oneline vPREV..main`, then each PR's title and body), grouped as Added, Changed, Fixed and Removed. Fold anything still under `## [Unreleased]` into it. Feature and fix PRs never edit `CHANGELOG.md`, and CI rejects one that does, so this is the only place entries are written.
2. Bump `version` in `package.json` to `X.Y.Z`.
3. Refresh `package-lock.json` (`npm install` will do it).
4. Open the release PR. CI runs `check-changelog-version` automatically.
5. Once merged, tag `vX.Y.Z` on `main` and push the tag once. The `Release` workflow (`.github/workflows/release.yml`) builds `dist/`, commits it on top of the tagged commit and moves `vX.Y.Z` to that build commit. It then creates the GitHub Release as a draft, publishes it, and finally moves the major tag (`vX`) to the same commit. `main` never carries `dist/`.

## Immutable releases

Immutable releases are enabled in the repository settings. Once a release is published, its tag can't be moved or deleted and its assets can't change. Deleting the release doesn't free the tag name either. This is why the workflow only publishes after `vX.Y.Z` points at the build commit. A release asset, if one is ever added, has to be uploaded to the draft before the publish step. If a published release turns out broken, cut a new patch version. Never re-push `vX.Y.Z`. The major tag `vX` has no release of its own, so the workflow can keep moving it.

If the workflow fails before publishing, rerun it. A rerun sees `dist/` on the tag and skips the rebuild, and reuses an existing draft.

## Why all three files in one commit

The published action consumers reference the major tag (`vX`), but anyone inspecting the repo via `npm`, `package.json`, or the GitHub UI expects `package.json` and `CHANGELOG.md` to agree. Splitting the bump across PRs is what allowed the `v5.0.0` / `v5.0.1` drift in the first place. The CI check makes the joint bump non-optional.
