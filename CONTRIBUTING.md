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

## Building `dist/` before opening a PR

Manki follows the canonical TypeScript-Action release model: the compiled bundle in `dist/` is committed to `main` so consumers can pin to `manki-review/manki@v5` or `manki-review/manki@v5.x.y` and have a runnable action without any extra setup on their side.

Any change under `src/` (or anything that affects the bundle output, including dependency bumps) requires a fresh `dist/`:

```sh
npm run build
git add dist/
git commit
```

The `.github/workflows/check-dist.yml` workflow is the backstop. It runs on every PR and on `push` to `main`, rebuilds `dist/`, and fails if the committed copy differs from the freshly built one. If you forget the rebuild, this check will tell you and upload the expected `dist/` as a workflow artifact for easy recovery.

`dist/` is marked `linguist-generated=true` in `.gitattributes`, so GitHub collapses its diff in the PR Files view by default. Reviewers can expand it on demand. The minified `dist/index.js` is additionally marked `-diff` to skip the textual diff entirely.

## Commit and PR conventions

- Commit messages and PR titles use [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `refactor`, `build`, `ci`, `chore`, `docs`, `test`). PR titles are enforced by CI.
- Add a CHANGELOG entry under `## [Unreleased]` for any user-visible change.
- Open the PR against `main`. CI must be green before merge.
