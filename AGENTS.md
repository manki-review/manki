# Manki — Agent & Contributor Guide

Manki is a GitHub Action that runs a multi-agent LLM code review on pull requests. This file captures the repo conventions that both human contributors and coding agents (Claude Code, Codex, Cursor, Aider, Continue, etc.) should follow. It's read natively by all of those tools — one file, all agents.

See `README.md` for what manki does and `docs/getting-started.md` for installing it in a repo. This file is strictly about conventions for working on manki itself.

## Pipeline order

The review stages are listed in this order: **planner, reviewer, judge, dedup**. Per-stage config keys (`models.{planner,reviewer,reviewer_pair,judge,refuter_pair,dedup}`), logs and docs follow it, so keep new per-stage items in the same order. `reviewer_pair` is the second finder's model and sits next to `reviewer`. `refuter_pair` is the second refuter's model and sits next to `judge`. `fallback` is not a stage and comes last.

At run time, `runReview` in `src/review.ts` calls dedup before the judge:

1. **Planner** triages the change (`trivial`, `subtle`, `paired`) and picks the judge effort. `selectTeam` sorts the PR into a review class (`classifyPr` in `src/routing.ts`) and runs the class's review group: the trivial verifier alone, one finder, or two finders on different models. Every finder gets the same `buildFinderAgent` checklist, so a pair differs only in its models. Security-sensitive, CI or dependency, and data contract paths are floor classes that force two finders.
2. **Finders** run in parallel and produce findings. A finder that fails after its retry makes the round incomplete. Alongside them, the sibling comparisons (`runComparisons` in `src/compare.ts`) ask one small call per sibling field or sibling implementation that `listUsesOutsideDiff` found, and add their findings to the finders'. So do the claim checks (`runClaimChecks` in `src/pr-claims.ts`): one small call per statement of the PR text that the change relies on, which never reads the PR description and reports only a statement the code disproves. A claim can add a check and never remove one, so no other stage reads a claim or its status.
3. **Dedup** drops findings matching resolved findings from earlier rounds, first statically, then with the `dedup` model.
4. **Judge** evaluates the rest, merges same-round duplicates and states each finding's severity table cell, from which `mapJudgedToFindings` works out the grade. For a blocker cell it doubts, the judge also states the grade the finding earns once its doubts hold (`gradeIfConfirmed`), and `warning` there keeps a confirmed finding a warning. A judge with repository tools then tries to refute the blockers and the findings it doubted (`refuteBlockers` in `src/refute.ts`). A confirmation of every doubt gives a blocker cell its blocker when a finder filed the finding as a blocker, on a security finding, or when the finding restates an earlier blocker. Any other such finding needs every check to confirm the defect and the consequence the judge names as a premise, and without that premise it stays a warning (`keepsWarning`). Memory suppressions then hide matching findings, never a blocker, a security finding or a tool alert. A warning that neither its cited lines nor a tool check proves is kept in the round record only (`hideUnprovenWarnings`), unless it would be a blocker if true. Each posted blocker and warning gets its `checkStatus` there (`checkStatus` in `src/refute.ts`). `determineOutcome` then decides whether any finding blocks.
5. **Verdict reader** runs only when nothing blocks. It reads the whole diff cold on the judge's client and returns `READY` or `ADDRESS_FIRST` (`src/verdict.ts`).

## Commit messages

- Short, imperative, with backtick highlighting for identifiers (function names, types, file paths, etc.)
- Example: `` fix: handle `None` case in `parseConfig` for missing `models` field ``

## Changelog

- Never edit `CHANGELOG.md` in a feature or fix PR. CI rejects it. The release PR writes the changelog from the merged PRs, so put what users need to know in the PR title and body.

## Docs

- A change to behavior, config, action inputs or review output updates the docs it affects in the same pull request. [Where to look](#where-to-look) says which file covers what.

## Code style

- Imports at the top of the module. No `import` inside functions, methods, or blocks.
- Remove dead code rather than suppressing warnings (no `// eslint-disable` for unused code). Git history is the archive.
- Prefer the most restrictive visibility that compiles. Default to non-exported; only widen when required.
- Don't introduce emojis to the codebase. Don't add comments that narrate the change ("now returns...", "fixed X").

## Testing

- Before adding a new `test()`/`it()`, search for an existing test that fits the context and extend it with a new case.
- Before creating a test helper, search for existing utilities — test helpers typically live next to the code they exercise in `src/*.test.ts`.
- Never ignore or skip failing tests. Fix the root cause. If the fix is genuinely out of scope, open an issue first and link it from the skip.
- Never open, search or quote the benchmark's hold-out cases in `bench/holdout/` while working on Manki. Exclude that directory from every search. Develop and debug against `bench/cases` only, since the hold-out score decides releases.

## Architecture quick reference

- `src/providers/` holds the LLM integration. Every model call goes through the `LLMClient` interface (`types.ts`), built per stage by `createLLMClient` (`factory.ts`). `anthropic.ts`, `openai.ts` and `gemini.ts` implement it over each provider's SDK or CLI.
- `src/config.ts`: config schema, defaults, validation (`DEFAULT_CONFIG`, `KNOWN_KEYS`, `validateConfig`).
- `src/review.ts`: planner (`runPlanner`), team selection (`selectTeam`), parallel finder loop, dedup and judge calls, round outcome (`runReview`, `determineOutcome`).
- `src/agents.ts`: the finder prompt (`buildFinderAgent`) and the trivial verifier.
- `src/routing.ts`: review classes, groups and floors (`classifyPr`).
- `src/judge.ts`: judge agent (`runJudgeAgent`).
- `src/refute.ts`: the refuter (`refuteBlockers`).
- `src/verdict.ts`: verdict reader (`runVerdictReader`).
- `src/compare.ts`: sibling comparisons (`runComparisons`) on the questions `listUsesOutsideDiff` (`src/symbol-uses.ts`) finds.
- `src/pr-claims.ts`: the claims of the PR text (`extractPrClaims`) and the check of each one (`runClaimChecks`).
- `src/sweep.ts`: with `review.sweep`, one search of the diff per kept finding the setting names (`startsSweep`) for other instances of its defect class (`runSweeps`).
- `src/recap.ts`: prior-round state from review threads, and dedup (static and LLM) against earlier findings.
- `src/github.ts`: GitHub API helpers (diffs, progress comments, posting reviews).
- `src/interaction.ts`: comment commands and replies in review threads.
- `src/reply-check.ts`: the code checks on a thread reply's structured answer (`checkReply`): its outcome's proof and the statements it lists.
- `src/state.ts`: the approval check after a thread or review changes.
- `src/index.ts`: top-level orchestration per dispatched event (`src/dispatch.ts`).
- `action.yml`: action inputs/outputs.

The `effort` level maps to provider-specific thinking or reasoning settings inside each client's `sendMessage`.

## Where to look

- Config schema + defaults: `src/config.ts`
- Config reference: `docs/configuration.md`. A new or changed setting needs its entry in `scripts/config-reference.ts`, then `npm run config-reference`, and its line in `.manki.yml.example`.
- Action inputs/outputs: `action.yml`
- User-facing docs, by what each covers:
  - `README.md`: overview, commands, local review. `docs/index.html`: the homepage.
  - `docs/getting-started.md`: setup, the workflow, action inputs and outputs, events, the settings block.
  - `docs/how-reviews-work.md`: pipeline, review groups, severity, review output, CI results, analyzers, related repositories, round records.
  - `docs/memory.md`: review memory. `docs/security.md`: tokens, untrusted content, reviewer tools.
  - `RELEASE.md`: release steps. This file: pipeline order and architecture.
- Convention changes or open design questions: GitHub issues
