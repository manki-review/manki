# Contributing to Manki

Thanks for your interest in contributing. This document covers the local development workflow.

## Prerequisites

- Node.js 24.x (matches the runner version used by CI and the action itself)
- `npm` (ships with Node)

## Setup

```sh
npm ci
```

## Local checks

Run the same checks CI does, in order:

```sh
npm run lint
npm run typecheck
npm test
npm run build
```

The `all` script runs all four in one command:

```sh
npm run all
```

## `dist/` is built at release time

`main` holds source only. `dist/` is in `.gitignore`, so never commit it. For a release, the `Release` workflow builds `dist/` and commits it on top of the release commit on a `release/vX.Y.Z` branch. An org admin then points the `vX.Y.Z` tag and the floating `vX` tag at that build commit, see [`RELEASE.md`](RELEASE.md). Consumers pinned to `manki-review/manki@v6` or an exact `@v6.x.y` get a tree that contains `dist/`. Pinning to `@main` or a commit SHA on `main` is not supported.

Locally, `npm run build` writes `dist/` for testing. The repo's own `Manki dispatch` workflow builds it before running the action from the checkout.

## Commit and PR conventions

- Commit messages and PR titles use [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `refactor`, `build`, `ci`, `chore`, `docs`, `test`). PR titles are enforced by CI.
- Do not edit `CHANGELOG.md` in a PR. CI fails any PR that does unless it bumps the `package.json` version, which only release PRs do. Give the PR a clear title and say in its body what changes for users. The release PR writes the changelog from the merged PRs.
- Open the PR against `main`. CI must be green before merge.
