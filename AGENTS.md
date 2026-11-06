# Manki — Agent & Contributor Guide

Manki is a GitHub Action that runs a multi-agent LLM code review on pull requests. This file captures the repo conventions that both human contributors and coding agents (Claude Code, Codex, Cursor, Aider, Continue, etc.) should follow. It's read natively by all of those tools — one file, all agents.

See `README.md` for what manki does and `docs/getting-started.md` for installing it in a repo. This file is strictly about conventions for working on manki itself.

## Pipeline order

The review stages are listed in this order: **planner, reviewer, judge, dedup**. Per-stage config keys (`models.{planner,reviewer,reviewer_pair,judge,dedup}`), logs and docs follow it, so keep new per-stage items in the same order. `reviewer_pair` is the second finder's model and sits next to `reviewer`. `fallback` is not a stage and comes last.

At run time, `runReview` in `src/review.ts` calls dedup before the judge:

1. **Planner** triages the change (`trivial`, `subtle`, `paired`) and picks the judge effort. `selectTeam` sorts the PR into a review class (`classifyPr` in `src/routing.ts`) and runs the class's review group: the trivial verifier alone, one finder, or two finders on different models with the same prompt. Security-sensitive, CI or dependency, and data contract paths are floor classes that force two finders.
2. **Finders** run in parallel and produce findings. A finder that fails after its retry makes the round incomplete.
3. **Dedup** drops findings matching memory suppressions or resolved findings from earlier rounds, first statically, then with the `dedup` model.
4. **Judge** evaluates the rest, merges same-round duplicates and classifies them by severity. `determineOutcome` then decides whether any finding blocks.
5. **Verdict reader** runs only when nothing blocks. It reads the whole diff cold on the judge's client and returns `READY` or `ADDRESS_FIRST` (`src/verdict.ts`).

## Commit messages

- Short, imperative, with backtick highlighting for identifiers (function names, types, file paths, etc.)
- Example: `` fix: handle `None` case in `parseConfig` for missing `models` field ``

## Changelog

- Never edit `CHANGELOG.md` in a feature or fix PR. CI rejects it. The release PR writes the changelog from the merged PRs, so put what users need to know in the PR title and body.

## Code style

- Imports at the top of the module. No `import` inside functions, methods, or blocks.
- Remove dead code rather than suppressing warnings (no `// eslint-disable` for unused code). Git history is the archive.
- Prefer the most restrictive visibility that compiles. Default to non-exported; only widen when required.
- Don't introduce emojis to the codebase. Don't add comments that narrate the change ("now returns...", "fixed X").

## Testing

- Before adding a new `test()`/`it()`, search for an existing test that fits the context and extend it with a new case.
- Before creating a test helper, search for existing utilities — test helpers typically live next to the code they exercise in `src/*.test.ts`.
- Never ignore or skip failing tests. Fix the root cause. If the fix is genuinely out of scope, open an issue first and link it from the skip.

## Architecture quick reference

- `src/providers/` holds the LLM integration. Every model call goes through the `LLMClient` interface (`types.ts`), built per stage by `createLLMClient` (`factory.ts`). `anthropic.ts`, `openai.ts` and `gemini.ts` implement it over each provider's SDK or CLI.
- `src/config.ts`: config schema, defaults, validation (`DEFAULT_CONFIG`, `KNOWN_KEYS`, `validateConfig`).
- `src/review.ts`: planner (`runPlanner`), team selection (`selectTeam`), parallel finder loop, dedup and judge calls, round outcome (`runReview`, `determineOutcome`).
- `src/agents.ts`: the finder prompt (`buildFinderAgent`) and the trivial verifier.
- `src/judge.ts`: judge agent (`runJudgeAgent`).
- `src/verdict.ts`: verdict reader (`runVerdictReader`).
- `src/recap.ts`: prior-round state from review threads, and dedup (static and LLM) against earlier findings.
- `src/github.ts`: GitHub API helpers (diffs, progress comments, posting reviews).
- `src/index.ts`: top-level orchestration per GitHub event.
- `action.yml`: action inputs/outputs.

The `effort` level maps to provider-specific thinking or reasoning settings inside each client's `sendMessage`.

## Where to look

- Config schema + defaults: `src/config.ts`
- Config reference: `docs/configuration.md`. A new or changed setting needs its entry in `scripts/config-reference.ts`, then `npm run config-reference`.
- Action inputs/outputs: `action.yml`
- User-facing docs: `README.md` and the pages in `docs/`
- Convention changes or open design questions: GitHub issues
