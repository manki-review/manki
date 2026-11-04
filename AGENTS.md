# Manki — Agent & Contributor Guide

Manki is a GitHub Action that runs a multi-agent LLM code review on pull requests. This file captures the repo conventions that both human contributors and coding agents (Claude Code, Codex, Cursor, Aider, Continue, etc.) should follow. It's read natively by all of those tools — one file, all agents.

See `README.md` for what manki does and `SETUP.md` for installing it in a repo. This file is strictly about conventions for working on manki itself.

## Pipeline order

The review stages are listed in this order: **planner, reviewer, judge, dedup**. Per-stage config keys (`models.{planner,reviewer,judge,dedup}`), logs and docs follow it, so keep new per-stage items in the same order.

At run time, `runReview` in `src/review.ts` calls dedup before the judge:

1. **Planner** picks team size, agents and effort levels.
2. **Reviewer** agents run in parallel and produce findings.
3. **Dedup** drops findings matching memory suppressions or resolved findings from earlier rounds, first statically, then with the `dedup` model.
4. **Judge** evaluates the rest, merges same-round duplicates and classifies them by severity. `determineVerdict` then picks the verdict.

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
- `src/review.ts`: planner (`runPlanner`), team selection (`selectTeam`), parallel reviewer loop, dedup and judge calls, verdict (`runReview`, `determineVerdict`).
- `src/judge.ts`: judge agent (`runJudgeAgent`).
- `src/recap.ts`: prior-round state from review threads, and dedup (static and LLM) against earlier findings.
- `src/github.ts`: GitHub API helpers (diffs, progress comments, posting reviews).
- `src/index.ts`: top-level orchestration per GitHub event.
- `action.yml`: action inputs/outputs.

The `effort` level maps to provider-specific thinking or reasoning settings inside each client's `sendMessage`.

## Where to look

- Config schema + defaults: `src/config.ts`
- Action inputs/outputs: `action.yml`
- User-facing docs: `README.md`, `SETUP.md`
- Convention changes or open design questions: GitHub issues
