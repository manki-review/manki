# Manki — Agent & Contributor Guide

Manki is a GitHub Action that runs a multi-agent LLM code review on pull requests. This file captures the repo conventions that both human contributors and coding agents (Claude Code, Codex, Cursor, Aider, Continue, etc.) should follow. It's read natively by all of those tools — one file, all agents.

See `README.md` for what manki does and `SETUP.md` for installing it in a repo. This file is strictly about conventions for working on manki itself.

## Pipeline order

Manki's review pipeline runs in this order:

1. **Planner** — picks team size and effort levels (pre-review)
2. **Reviewer** — parallel specialist agents produce findings
3. **Judge** — evaluates, filters, and classifies findings by severity
4. **Dedup** — filters findings that match previously-dismissed ones (post-judge)

When listing per-stage items anywhere — code, docs, logs, config keys — **use this order**. Config key order should mirror the pipeline mental model.

## Commit messages

- Short, imperative, with backtick highlighting for identifiers (function names, types, file paths, etc.)
- Example: `` fix: handle `None` case in `parseConfig` for missing `models` field ``

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

- `src/claude.ts` — the **single LLM integration point** (`ClaudeClient.sendMessage`). All model calls go through here.
- `src/config.ts` — config schema, defaults, validation (`DEFAULT_CONFIG`, `KNOWN_KEYS`, `validateConfig`).
- `src/review.ts` — team selection (`selectTeam`), planner, parallel reviewer loop.
- `src/judge.ts` — judge agent (filters + classifies findings by severity).
- `src/recap.ts` — dedup (static + LLM) against previously-dismissed findings.
- `src/index.ts` — top-level orchestration and GitHub API I/O.
- `action.yml` — action inputs/outputs.

Per-stage models are configured via `config.models.{planner,reviewer,judge,dedup}` (see pipeline order). The reviewer `effort` parameter maps to provider-specific thinking budgets inside `ClaudeClient.sendMessage`.

## Where to look

- Config schema + defaults: `src/config.ts`
- Action inputs/outputs: `action.yml`
- User-facing docs: `README.md`, `SETUP.md`
- Convention changes or open design questions: GitHub issues
