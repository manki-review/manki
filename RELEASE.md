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
5. Once merged, tag `vX.Y.Z` on `main`. The `Release` workflow (`.github/workflows/release.yml`) builds `dist/`, commits it on top of the tagged commit, moves `vX.Y.Z` and the major tag (`vX`) to that build commit, and publishes the GitHub Release. `main` never carries `dist/`.

## Why all three files in one commit

The published action consumers reference the major tag (`vX`), but anyone inspecting the repo via `npm`, `package.json`, or the GitHub UI expects `package.json` and `CHANGELOG.md` to agree. Splitting the bump across PRs is what allowed the `v5.0.0` / `v5.0.1` drift in the first place. The CI check makes the joint bump non-optional.
