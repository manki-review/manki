# Changelog

All notable changes to Manki will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.3.0] - 2026-04-05

> **Rename note**: references to `@manki-labs` and `manki-labs[bot]` in the 4.0.0–4.2.0 entries below refer to the old command prefix and bot login, which were removed/renamed in 4.3.0. The current prefix is `@manki` and the bot login is `manki-review[bot]`.

### Added

- Pre-review planner stage with content-aware team and effort selection (#412)
- `teamSize=1` with `Trivial Change Verifier` agent for trivial PRs (#438)
- New config keys `planner.enabled` (default `true`) and `models.planner` (default `claude-haiku-4-5`) (#412)

### Changed

- **Breaking (soft)**: `@manki-labs` command prefix removed — use `@manki` (#403)
- **Breaking (soft)**: bot login renamed `manki-labs[bot]` → `manki-review[bot]` and centralized as `BOT_LOGIN` (#394)
- Planner output simplified to team-size + effort-level only (#418)
- Auto-approve now requires all findings resolved before approving (#406)
- Judge always runs; review fails on agent or judge errors (#430)
- Judge summaries more opinionated with examples and anti-patterns (#428)
- Skip redundant review after recent approval (#421, #425)
- Follow-up review recap uses delta since last review (#410, #382)
- Static dedup only matches resolved findings, not open or replied (#379)
- Recap simplified to judge-only natural summary, finding-counting machinery removed (#415)
- Reorder `models` config keys by pipeline order — planner, reviewer, judge, dedup (#450)

### Fixed

- Prevent premature auto-approve and stale progress comment blocking (#390)
- Fail fast when no API key is configured (#429)
- Show full description in collapsed duplicate findings (#397)
- Handle confidence tag in finding title regex and improve dedup details (#376)

### Docs

- Overhaul SETUP.md with quick start and GitHub App installation (#400)
- Replace README quick start with link to SETUP.md (#404)
- Align README, SETUP, and example config with v4.3.0 state (#446)
- Introduce `AGENTS.md` with repo conventions (#452)

### Chores

- Raise patch coverage target from 80% to 90% (#387)
- Ignore `.claude/` and `coverage/` directories (#435)

## [4.2.0] - 2026-03-31

### Added

- Live per-agent progress updates in review comment — shows real-time agent completion with timing and finding counts (#357)
- LLM-based deduplication for dismissed findings using Haiku — catches semantically similar findings that static matching misses (#364)
- Collapsed `<details>` section in review report showing deduplicated findings with matched titles (#372)
- Configurable `dedup` model in `.manki.yml` via `models.dedup` (defaults to `claude-haiku-4-5`) (#364)

### Fixed

- Fuzzy word-overlap matching in recap dedup to catch rephrased findings (#361)
- Prevent parallel review runs by checking for in-progress reviews before starting new ones (#371)
- Skip self-triggered workflow events from `manki-labs[bot]` to reduce runner waste (#371)

### Changed

- Consolidate `titlesRelated` in judge.ts with shared `titlesOverlap` from recap.ts (#364)
- Refactor `buildDashboard` to single linear rendering path — 52 → 36 lines (#369)
- Simplify `completeDashboard` construction using spread from accumulated dashboard object (#369)

### Chores

- Guard `majorityThreshold` for `agentCount < 2`, harden bot review filter, add language annotation to suggested fix code blocks, narrow `recapSummary` scope, conditional `confidenceDistribution`, encapsulate `octokitCache`, export and test `scopeDiffToFile`, realistic test data in `determineVerdict` tests (#366)

## [4.1.0] - 2026-03-31

### Added

- Per-agent, judge, and file metrics in `ReviewStats` JSON (`agentMetrics`, `judgeMetrics`, `fileMetrics`, split `reviewerModel`/`judgeModel`) (#348)
- PR diff context included in conversational replies to review comments (#346)
- Confidence-weighted verdict threshold and anti-leniency calibration in judge prompt (#343)

### Fixed

- Remove top-level `model` action input that silently overrode `.manki.yml` config (#354)
- Lower `HIGH_CONF_SUGGESTION_THRESHOLD` to 1 — single high-confidence suggestion triggers REQUEST_CHANGES (#351)
- Use `comment.id` in concurrency group to prevent review comment cancellation (#345)
- Skip duplicate approval in `checkAndAutoApprove` (#340)
- Route `/manki` commands from review comment replies (#337)

### Docs

- Update SETUP.md action references from v3 to v4 (#336)

## [4.0.0] - 2026-03-30

### Added

- Live-updating dashboard progress comment with text status lines
- AI-generated review summaries from judge agent
- Review event body with collapsed stats JSON for future analysis
- Progress comment as frozen audit log with review metadata (config, judge decisions, timing)
- Auto-detect GitHub App installation and use app token (`manki-labs[bot]` identity)
- `/manki` and `@manki-labs` command prefixes alongside `@manki`
- Token service authentication with GitHub Actions OIDC (no secrets needed)
- Judge validates PR scope — flags unrelated file changes
- Judge consensus weighting — multi-reviewer findings get more weight
- Judge acceptance criteria enforcement — unmet criteria flagged as required
- Judge impact x likelihood severity matrix (inspired by SonarQube)
- Dynamic consensus thresholds relative to team size
- Support for edited comments (`/manki` added via edit)
- Triage-created issues with proper prefixes and structured format
- Post-judge dedup pass for duplicate findings
- Logo added to repo and README

### Changed

- `resolvedToken` made explicit — `createAuthenticatedOctokit` returns token alongside Octokit, `getMemoryToken` is now a pure function
- Action always exits 0 — event filtering moved inside, SIGTERM handled gracefully
- Concurrency group includes event name to prevent cross-event cancellation
- Nit issues redesigned with collapsible `<details>` and GitHub permalink embeds
- Inline comments use structured AI context JSON instead of duplicated "Fix prompt"
- All command responses restyled with `**Manki** —` branding
- Silent auto-approve (no visible message body)
- Default `models.reviewer` to Sonnet, `models.judge` to Opus
- `max_diff_lines` bumped from 10k to 50k
- Universal bot filter using `sender.type === 'Bot'`
- Removed `DEFAULT_REVIEWERS` — `AGENT_POOL` is single source of truth
- Team size label shows actual agent count
- README overhauled with logo, updated features, simplified config

### Fixed

- Code fences in nit issues render at column 0 for GitHub compat
- Triage parser matches new `<details>` nit issue format
- Serialize concurrent `ensureCLI` calls with shared install promise
- Remove blockquote from review summary, separate recap text
- `isReviewRequest` and `hasBotMention` support all command prefixes
- Bot self-triggering prevention for `pull_request_review` events
- Stale commit SHA guard for auto-approve
- Judge `required` severity bar loosened and calibrated with project memory
- Codecov checks made informational, then enforced at 95%
- Bot skip log message now shows review author login when `reviewAuthorType` triggers the skip

### Tests

- Test coverage for missing `sender.type` field on webhook payloads
- Test coverage for POST method assertion on OIDC token exchange

## [3.1.0] - 2026-03-25

### Added

- Extended thinking for judge agent
- Full file content as reviewer context
- PR context (title, description, base branch) in prompts
- Memory context (learnings, suppressions) for reviewers
- Resolve `@rules/` references in `CLAUDE.md`
- Pre-filter suppressions before judge
- Code coverage with Codecov
- Severity examples in prompts
- Auto-resolve stale threads after force-push
- Check suppressions in recap dedup
- Linked issue context in prompts
- `@manki forget` command
- Subdirectory `CLAUDE.md` files
- Multi-pass review verification

### Changed

- Default reviewer to Sonnet, judge to Opus
- Renamed nit issues to "triage: findings from PR #N"

### Fixed

- Judge merges duplicate findings
- Prevent duplicate findings via resolved thread dedup

## [3.0.0] - 2026-03-25

### Added

- Dynamic review teams (3/5/7 agents scaled by diff size)
- Judge agent with prompt, parser, and context curation
- 4-tier severity system (required/suggestion/nit/ignore)
- Per-stage model selection (`models.reviewer` / `models.judge`)
- `nit_handling` config (issues vs comments)
- Triage acceptance pattern tracking and auto-escalation
- AGPL-3.0 license

### Changed

- README rewrite and SETUP.md update

### Fixed

- `COMMENT` fallback drops inline comments
- Graceful fallback without `github_token`

## [2.4.0] - 2026-03-24

### Added

- `@manki triage` command for nit issue processing
- Richer nit issues with code snippets and fix prompts

### Fixed

- Renamed `need-human` to `needs-human` label

## [2.3.0] - 2026-03-24

### Added

- `@manki check` command and auto-approve on thread resolution

## [2.2.0] - 2026-03-24

### Added

- Collapsible suggested fixes and AI agent prompts in comments

## [2.1.0] - 2026-03-24

### Changed

- Stripped backwards compatibility, rewrote README with Manki personality

### Fixed

- Consolidation fallback, JSON extraction, and warning annotations

## [2.0.0] - 2026-03-24

### Added

- Rebranded from claude-review to Manki
- `@manki remember` command to teach the reviewer

## [1.2.0] - 2026-03-24

### Added

- Emoji reactions to acknowledge triggers

### Fixed

- Cancel in-progress review runs on PR update

## [1.1.0] - 2026-03-24

### Added

- Memory write path (patterns, suppressions, learnings)
- GitHub App identity support
- Review recap phase (dedup, track resolved)
- Conversation lifecycle (auto-approve, reply handling)
- Nit issues with `needs-human` label
- SETUP.md installation guide

### Fixed

- Auto-resolve addressed findings with validation
- Consolidation failure returns `COMMENT` not `APPROVE`

## [1.0.0] - 2026-03-24

### Added

- Initial release: multi-agent Claude Code PR review
- Specialist reviewer agents
- Basic review posting with inline comments
- Configuration via `.manki.yml`

[4.3.0]: https://github.com/xdustinface/manki/compare/v4.2.0...v4.3.0
[4.2.0]: https://github.com/xdustinface/manki/compare/v4.1.0...v4.2.0
[4.1.0]: https://github.com/xdustinface/manki/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/xdustinface/manki/compare/v3.1.0...v4.0.0
[3.1.0]: https://github.com/xdustinface/manki/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/xdustinface/manki/compare/v2.4.0...v3.0.0
[2.4.0]: https://github.com/xdustinface/manki/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/xdustinface/manki/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/xdustinface/manki/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/xdustinface/manki/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/xdustinface/manki/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/xdustinface/manki/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/xdustinface/manki/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/xdustinface/manki/releases/tag/v1.0.0
