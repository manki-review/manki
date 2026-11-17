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

`main` holds source only. `dist/` is in `.gitignore`, so never commit it. For a release, the `Release` workflow builds `dist/` and commits it on top of the release commit on a `release/vX.Y.Z` branch. After an approval, the `Publish release` workflow points the `vX.Y.Z` tag and the floating `vX` tag at that build commit, see [`RELEASE.md`](RELEASE.md). Consumers pinned to `manki-review/manki@v7` or an exact `@v7.x.y` get a tree that contains `dist/`. Pinning to `@main` or a commit SHA on `main` is not supported.

Locally, `npm run build` writes `dist/` for testing. The repo's own `Manki dispatch` workflow builds it before running the action from the checkout.

## Changing the blocker rubric

A change to how findings are graded can shift grades on real PRs in ways no unit test shows. Change a grade only after 3 real cases that the change fixes. What else a PR has to show depends on where the grade is decided. The release gate in [`RELEASE.md`](RELEASE.md) measures the change in the end. This section is about what a single PR shows before that.

### The judge prompt and the severity table

A change to the judge's prompt (`buildJudgeSystemPrompt` in `src/judge.ts`, with `SEVERITY_TABLE` and `GRADE_DEFINITIONS` in `src/writing-rules.ts`) or to the grade of a table cell (`CELL_GRADES` in `src/types.ts`) changes what the judge answers. It needs two checks.

First, the live replay of the grading fixtures in [`src/judge.fixtures/grading`](src/judge.fixtures/grading). It sends each fixture through `runJudgeAgent` and checks that the grade is one the fixture allows. It runs on the Claude CLI's own login, and `JUDGE_LIVE_MODEL` picks another model than the default judge:

```sh
RUN_JUDGE_LIVE_FIXTURES=1 npx jest src/judge.test.ts -t 'live judge grades'
```

Second, a judge replay over a labelled set of real findings, per repository:

```sh
npm run review-history -- <owner/repo> > history.jsonl
npm run calibration -- history.jsonl --fix-rate fix-rate.jsonl --export set.jsonl > report.md
```

The report gives the blocker precision per repository (real blockers divided by blockers raised), the labels by severity and where they came from, and the findings graded below blocker that were fixed, which are candidate missed blockers. `--fix-rate` takes the repository's `metrics/fix-rate.jsonl` from the memory repo and is optional. `--export` writes up to 60 labelled findings (`--limit`) for a judge replay. The format and the first set are in [`src/judge.fixtures/calibration`](src/judge.fixtures/calibration).

No script runs the replay. It is done by hand, one judge call per finding of the set, 3 times with the old code and 3 times with the new. Each call is the one the live grading replay in `src/judge.test.ts` makes: `runJudgeAgent` with a single finding whose `file`, `line`, `title` and `description` are the set's `file`, `lineStart`, `title` and `comment`, and the PR's diff at `commitSha`, which `git diff $(git merge-base <base branch> <commitSha>) <commitSha>` prints in a clone of the repository. Never show the judge the set's `severity` or `judgeNotes`, since both name the old grade. Compare the blocker precision and the findings that changed grade. The target is a blocker precision of at least 80%.

### A grading step after the judge

The judge replay runs no step after the judge, so a rule that decides there gives the same grades with the old and the new code. Such rules are the refuter's checks in `refuteBlockers` and `keepsWarning` in `src/refute.ts`, and `hideUnprovenWarnings` in `src/review.ts`. A change to one of them is shown by a route replay over a stored bench report instead.

Each finding of a bench report stores how it got its grade as its `route` (`gradeRoute` in `src/bench.ts`): the finder's grade, the cell the judge stated, `gradeIfConfirmed`, the doubts of each kind, the refuter's outcome and the check status. [`bench/README.md`](bench/README.md#the-route-of-each-blocker) lists every field. Download the `bench-report` artifact of a `tuning` run with `gh run download <run id> -n bench-report`. For each blocker and warning, work out the grade the new rule gives from its route, then list the findings whose grade changes, with the key item each matches. No script does this either. Use a `tuning` run only. A hold-out report holds the findings of the hold-out cases, which are never read while working on Manki.

The labelled set records only the posted finding and the judge's grade, and it stays that way. A replay of the refuter needs its tools in the repository at `commitSha`, which a set of findings cannot give, while the bench reports already record each finding's finder grade, doubts and refuter outcome next to the key item it matches.

## Commit and PR conventions

- Commit messages and PR titles use [Conventional Commits](https://www.conventionalcommits.org/) (`feat`, `fix`, `refactor`, `build`, `ci`, `chore`, `docs`, `test`). PR titles are enforced by CI.
- Do not edit `CHANGELOG.md` in a PR. CI fails any PR that does unless it bumps the `package.json` version, which only release PRs do, or rewrites the notes of a release that is not published yet and changes no other file (see [`RELEASE.md`](RELEASE.md#changing-a-release-that-is-not-published)). Give the PR a clear title and say in its body what changes for users. The release PR writes the changelog from the merged PRs.
- Open the PR against `main`. CI must be green before merge.
