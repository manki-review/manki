# Changelog

All notable changes to Manki will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Every Manki review body now ends with a `Reviewed commit [`<short-sha>`](…)` footer linking to the exact commit reviewed, removing ambiguity about which SHA a verdict applies to and giving a stable human-visible anchor for every review across `APPROVED` / `COMMENTED` / `CHANGES_REQUESTED` ([#807](https://github.com/manki-review/manki/issues/807)).
- `RoundMeta` now carries `cap` (`priorRoundCount`, `maxAutoRounds`, `skipCap`, `forceReview`, `bypassReason`) and `trigger` (`event`, `sender`) provenance, so a round-cap progression like `5/5 -> 6/5` is attributable to the exact tickbox or comment that admitted each round ([#791](https://github.com/manki-review/manki/issues/791), [PR #815](https://github.com/manki-review/manki/pull/815)).
- `RoundContext.usage` now ships per-stage token counts (`planner`, `reviewer`, `judge`, `dedup`) and round-level rollups (`inputTokens`, `outputTokens`, `totalTokens`) sourced directly from each provider's SDK/CLI usage block. `LLMResponse` carries `usage` (`inputTokens`, `outputTokens`, `cachedTokens`, `reasoningTokens`) and `latencyMs` on every call. `RoundAgentMetric` is populated with `durationMs`, `inputTokens`, `outputTokens`, `retryCount`, `status`, and `failureReason` (threaded from `ReviewResult.agentFailureReasons`). `RoundJudge.retryCount` is wired through. Replay tooling can now reconstruct token cost and per-stage latency from metadata alone ([#792](https://github.com/manki-review/manki/issues/792)).
### Fixed

- `.manki.yml` is now sourced from the PR head's local checkout (`process.cwd()`) instead of the base ref, so a PR that adds or modifies its own config (e.g., extending `exclude_paths`) takes effect on the same PR rather than only after merge. User-supplied `exclude_paths` are also unioned with `DEFAULT_CONFIG.exclude_paths` (deduped) instead of replacing them, so adding a single pattern no longer silently drops the built-in `*.lock`, `dist/**`, `*.generated.*` skips. Closes the chicken-and-egg observed on [PR #810](https://github.com/manki-review/manki/pull/810) where the dist/-on-main migration tripped the PR-size gate because main's `.manki.yml` lacked `dist/**` and the PR's local override was never consulted ([#813](https://github.com/manki-review/manki/issues/813)).
- State-based head-SHA dedupe gate: `manki-review[bot]` now bails before any LLM call when a non-`DISMISSED` bot review already exists on the current head SHA. Closes the serialized-sibling race observed on [PR #805](https://github.com/manki-review/manki/pull/805) where one human review fanned out into a `pull_request_review` and `pull_request_review_comment` event pair, the workflow `concurrency` group serialized them, and the in-progress marker from #796 had already been cleared by the time run #2 scanned. The new `hasBotReviewOnCommit` helper in `src/github.ts` is consulted by `handlePullRequest`, `handleCommentTrigger`, `handleReviewCommentInteraction`, and `runFullReview` (defense in depth, right after `checkConcurrentSubmissionLock`). When the gate fires the run posts a `**Review skipped** for `<short-sha>` — a review has already been posted for this commit` comment so the user sees nothing was silently dropped. `@manki review` (force-review) still bypasses the gate so explicit re-review on the same SHA proceeds. `postReviewSkippedComment` takes a `SkipReason` (`'in_progress'` | `'already_reviewed'`) and always includes the short head SHA on both paths ([#806](https://github.com/manki-review/manki/issues/806)).
- The PR-size gate (`max_diff_lines`) now applies `exclude_paths` before counting, so generated artifacts the user has opted out of (`dist/**`, `*.lock`, `*.generated.*` by default) no longer trip the "PR too large for automated review" abort. Previously the raw diff was counted, which caused PRs that commit a build bundle (e.g., `dist/index.js` on `main`) to short-circuit review even when the reviewable source delta was small.
- The judge now enforces one `threadEvaluations` entry per open review thread. Missing entries trigger a single retry with a stricter reminder, any still-missing entries after retry are synthesized as `uncertain` with a `core.warning`, and the system prompt pins an explicit `You MUST return exactly N entries` constraint. When the verdict gate fires on `prior_unaddressed`, the PR comment body now lists each blocking thread inline with file, line, original severity, and a direct GitHub link instead of silently blocking. Closes [#808](https://github.com/manki-review/manki/issues/808).

### Changed

- Switched to the canonical TypeScript-Action release model: the compiled `dist/` is committed to `main` so both floating (`manki-review/manki@v5`) and immutable exact-version (`manki-review/manki@v5.x.y`) pins resolve to a runnable action. Previously, `release.yml` committed `dist/` onto a one-off SHA and force-updated only the major tag, leaving exact-version tags pointing at source-only commits that failed with `File not found: dist/index.js` on the runner. A new [`check-dist.yml`](.github/workflows/check-dist.yml) workflow runs on every PR and `push` to `main`, rebuilds `dist/`, and fails if the committed copy drifts from a fresh build. `release.yml` is simplified to just force-update the floating major tag and publish the GitHub Release. `dist/**` is added to `.gitattributes` (`linguist-generated=true`, plus `-diff` on the minified entry) so the GitHub PR Files view collapses the bundle diff, and to `.manki.yml` / `codecov.yml` so manki self-reviews and coverage reports skip it. [`CONTRIBUTING.md`](CONTRIBUTING.md) documents the local `npm run build` step contributors must run before opening a PR. Historical `v5.0.0` and `v5.0.1` tags remain source-only and continue to require pinning to `@v5` ([#800](https://github.com/manki-review/manki/issues/800)).

## [5.1.1] - 2026-05-22

### Fixed

- `checkAndAutoApprove` now consults the same TTL-based in-progress-marker scan as the full-review path, so it cannot auto-approve while a parallel `runFullReview` is still mid-flight. Closes the silent verdict-flip seen on [patchly-gold/patchly#69](https://github.com/patchly-gold/patchly/pull/69) where an APPROVED landed during an in-flight review that later posted CHANGES_REQUESTED. `checkConcurrentSubmissionLock`, `readConcurrencyLockTtlSeconds`, and `DEFAULT_CONCURRENCY_LOCK_TTL_SECONDS` moved from `index.ts` to `github.ts` so both entry points share the scan. `config` threaded through the three `checkAndAutoApprove` call sites so the guard honors `concurrency_lock_ttl_seconds` from `.manki.yml` (#801, [PR #802](https://github.com/manki-review/manki/pull/802)).
- CLI exit-non-zero diagnostics now capture the last 500 chars of stdout, elapsed runtime, model, effort, prompt size, stderr length, and signal across all three providers (`anthropic.ts`, `openai.ts`, `gemini.ts`) via a new `buildExitDiagnostics` helper in `cli-utils.ts`. For the Claude path, the terminal stream-json `result` event (`is_error`, `subtype`, message text) is parsed and rendered as comma-joined `result.*` ctx entries, so failures like `Claude CLI failed (exit 1: )` with empty stderr now surface the actual reason (e.g., `error_during_execution`, `error_max_turns`) instead of an opaque blank (#803, [PR #805](https://github.com/manki-review/manki/pull/805)).

## [5.1.0] - 2026-05-22

### Added

- In-app concurrent-submission lock: `manki-review[bot]` bails out at the review pipeline entry point when another run already holds a fresh in-progress marker with a different `manki-run-id` within the configurable TTL. New action input `concurrency_lock_ttl_seconds` (default 600, max 3600) (#779, [PR #796](https://github.com/manki-review/manki/pull/796)).
- `noise_level` config knob (`low` / `medium` / `high`, default `medium`) suppresses nit-volume noise at the source. At `low`, reviewer agents are instructed to surface only blockers and warnings; at `high`, all findings including nitpicks are encouraged. Replaces the deprecated `nit_handling: 'issues'` routing (#739, #740, #741).
- Judge calibration honors `noise_level` — the judge's acceptance threshold for nitpick findings scales with the configured level so the gate stays consistent with the reviewer signal (#761).
- Reviewer-agent prompts honor `noise_level` — the effort-level and finding-count guidance in each reviewer's system prompt adapts to the configured level (#760).

### Changed

- New CI check fails when `package.json` version does not match the most recent non-Unreleased CHANGELOG heading, preventing version drift. Adds top-level `RELEASE.md` (#783, [PR #795](https://github.com/manki-review/manki/pull/795)).
- `nit_handling: 'issues'` is deprecated and has no effect. The `nit_handling` config key is now ignored. Migrate to `noise_level` instead (#742, #771).
- `/manki triage` command removed. The triage flow relied on `nit_handling: 'issues'` routing, which is gone. No replacement command is needed: `noise_level` controls nit volume at the source (#771).

### Fixed

- Judge `threadEvaluations.status === 'addressed'` is now wired through `determineVerdict` and `applyCrossRoundSuppression`, so a thread the judge knows the author silently fixed no longer blocks APPROVE (#787, [PR #797](https://github.com/manki-review/manki/pull/797)).
- `PLANNER_TIMEOUT_MS` bumped from 30s to 60s to absorb normal API tail latency without masking genuine hangs ([PR #786](https://github.com/manki-review/manki/pull/786)).
- `ready_for_review` webhook event now correctly triggers a review when a draft PR is converted to ready (#717, #744).
- Planner timeout race eliminated by eagerly warming up the Claude CLI during action startup, before the planner call (#735, #749).
- Review-summary timings on planner fallback now sourced from agent completion timestamps rather than a missing planner field (#736, #748).
- Planner PR-type vocabulary aligned to Conventional Commits (`feat`, `fix`, `refactor`, etc.) so planner decisions are consistent with the project's commit taxonomy (#737, #750).
- Skip-ack comment now posts a fresh comment instead of editing the prior one, preventing stale edit-based ack from showing for the wrong commit (#664, #759).
- `determineVerdict` now grounds its addressed/not-addressed decision in the GitHub `isResolved` state, preventing zero-diff force-pushes from auto-resolving open warnings incorrectly (#758).
- `Judge` kept counts and test-nit suppression surface accurately in the stats block (#773).
- CI test flake in `plannerDurationMs` assertion resolved by relaxing the assertion to `>= 0` (#781).
- The planner's team selection is now trusted. `selectTeam` no longer post-injects `{Security, Architecture, Correctness}` on top of the planner's picks, so a 3-agent plan stays a 3-agent review. The dashboard `Planner` line reports the actual resolved roster size instead of the planner-requested `teamSize`, matching the per-category breakdown. When the planner is unavailable, manki falls back to a conservative fixed `{Security, Architecture, Correctness}` roster. Closes [#784](https://github.com/manki-review/manki/issues/784).

### Action required for downstream installs

- Update the `concurrency:` block in your `.github/workflows/manki.yml` to drop `github.event_name` from the `group` key and set `cancel-in-progress: false`. See [SETUP.md](SETUP.md#step-3-add-the-workflow) for the new snippet. Without this change, concurrent runs triggered by different event types (e.g. `pull_request` + `pull_request_review`) can race and submit conflicting reviews on the same commit. Closes [#776](https://github.com/manki-review/manki/issues/776).

## [5.0.1] - 2026-05-20

### Fixed

- `action.yml` description shortened to fit GitHub Marketplace's 125-character limit so the action can be published / re-published to the Marketplace. No runtime behavior change.

### Docs

- CHANGELOG entry for `v5.0.0` stamped with its actual release date (was `unreleased`).

## [5.0.0] - 2026-05-20

### Added

- `stats.hidden` config (default `false`). When `true`, the per-round `Manki context` payload renders as an HTML comment (`<!-- manki-context: ... -->`) instead of a `<details>` block, keeping the payload machine-readable while hiding it from the rendered review (#711).

### Changed (BREAKING)

- `openai_oauth_token` and `gemini_oauth_token` inputs now expect the **base64-encoded contents of the CLI's auth JSON file**, not a single-string token. Both CLIs read OAuth credentials from disk (`$CODEX_HOME/auth.json` for Codex, `~/.gemini/oauth_creds.json` for Gemini) and there is no portable single-string equivalent that the spawned subprocesses honor with refresh-token semantics. On invocation the action seeds the file with mode `0600` only when absent, so refreshed tokens written by the CLI on persistent runners are preserved across runs. Re-bootstrap when the `refresh_token` expires (#695).
  - Bootstrap (Codex): ``codex login`` then ``cat ~/.codex/auth.json | base64 | gh secret set OPENAI_OAUTH_TOKEN``
  - Bootstrap (Gemini): sign in with ``gemini`` then ``cat ~/.gemini/oauth_creds.json | base64 | gh secret set GEMINI_OAUTH_TOKEN``
  - The legacy single-token shape is rejected fast with an error pointing to the bootstrap command. No fallback or compat shim.
- Per-round state moved from the memory repo (`prs/{n}/handover.json`) to a `Manki context` block embedded in each review summary on the PR itself. The memory repo now retains only cross-PR data (`learnings.yml`, `patterns.yml`, `suppressions.yml`), so `memory_repo_token` no longer needs write access to `prs/{n}/handover.json`. Existing `handover.json` files in memory repos are orphaned but harmless and require no migration. In-flight PRs upgrading mid-review see one round of regressed prior-round context (round cap, cross-round suppression, planner team carry-over, etc.) until the next manki comment lands the embedded block. Parent: #684. Implementation: #706 (emit), #712 (aggregate), #723 (consumers), #728 (drop write path).
- `Force review` tickbox on the round-cap notice now only bypasses the round cap, not other gating. `forceReview` and `skipCap` are now distinct flags on `ReviewConfig`, so ticking the box re-enables a single follow-up review without disabling other safeguards (#727).

## [4.7.0] - 2026-04-28

### Added

- Review convergence mechanisms gated by a new `convergence` block in `ReviewConfig`. Round-count hard cap (`max_auto_rounds`, default 5) skips automatic re-reviews after the cap with a posted notice, while `@manki review` bypasses it. Test-file nit suppression (`test_path_patterns`) drops `suggestion` and `nitpick` findings on test files from round 2 onward, keeping `blocker` and `warning` findings. Resolved-thread cross-round suppression (`suppress_resolved_threads`) ratchets prior-round findings whose GitHub threads are now resolved to `ignore`, with `blocker` findings still protected (#646)
- Review team is pinned across rounds with monotonic growth. Round 1's resolved agents persist on `HandoverRound.agents`, and from round 2 onward `selectTeam` unions prior-round agents with the planner's picks (or the heuristic team) before injecting core agents. The planner may add agents but never remove them, and the audit log distinguishes inherited from newly added agents (#643)

### Fixed

- `selectTeam` planner path now prepends any missing `CORE_AGENTS` (Security, Architecture, Correctness) to the resolved team in `CORE_AGENTS` order, fixing silent core-agent drops when the planner omitted them (#641)

## [4.6.1] - 2026-04-27

### Fixed

- Judge thread auto-resolution now grounds its addressed/not-addressed decision in the inter-round diff plus the current code at each thread region, preventing zero-diff force-pushes (rebases with identical trees) from auto-resolving open warnings (#624)
- Verdict layer now blocks `APPROVE` when a prior-round `warning` or `blocker` is still unresolved (no `agree` reply, thread not resolved on GitHub), surfacing the new `prior_unaddressed` reason. Multi-round priors are deduped by fingerprint with the latest round winning (#625)

## [4.6.0] - 2026-04-27

### Added

- Judge multi-round cross-round suppression: ratchet detector (won't re-raise findings the author has already addressed) and contradiction detector (demotes findings that contradict previously accepted guidance) (#561)
- Judge cross-round state infrastructure: fingerprints and author-reply parsing for round-to-round comparison (#555)
- Judge practical-reachability check: caps hypothetical findings at `nitpick` severity (#553)
- Judge verdict approval ceiling: when all remaining findings are dismissed suggestions, returns `APPROVE` (#562)
- Judge own-proposal caveat rule: demotes findings where the reviewer is flagging code it suggested itself (#566)
- Planner per-round summary for agent budget allocation (#565)
- Reviewer factual provenance note for prior-suggestion diff regions (#594)
- Open-thread references rendered as clickable GitHub links in judge prompt (#610)
- In-PR finding suppression: skips re-raising findings that match an already-resolved review thread or an author agree-reply (#584)
- Warning banner on PR when the GitHub App is not installed (#541)

### Changed (BREAKING)

- Renamed severity tiers from `required`/`suggestion`/`nit` to `blocker`/`warning`/`suggestion`/`nitpick` (#598). The `severity` field of every entry in the `findings_json` action output now uses the new values, and the `severity_counts` action output is now `{blocker, warning, suggestion, nitpick}`. Downstream workflow steps that switch on these values must be updated. Persisted handover and review markers from older versions are migrated automatically on read (`required` → `blocker`, `nit` → `nitpick`).
- Replaced `<sub>[high confidence]</sub>` text with a traffic-light dot prefix in review comment headers: 🔴 (high), 🟠 (medium), 🟡 (low) (#598).
- `determineVerdict` now only requests changes for `blocker` and `warning` findings; `suggestion` and `nitpick` findings produce `APPROVE` (#604, #612).

### Changed

- Default judge model updated to `claude-opus-4-7` (#606)

### Fixed

- Cancel in-progress review run when `@manki review` is re-requested (#542)
- Guard all-ignore prior rounds in judge prompt (#591)
- Restore review-in-progress tickbox for `@manki review` requests (#601)
- `contradictionMatch` now cites the most-recent agreeing round rather than the earliest (#618)

## [4.5.3] - 2026-04-10

### Fixed

- LLM-triggering commands (`review`, `explain`, generic questions, inline reply handling) now require `OWNER`, `MEMBER`, `COLLABORATOR`, or `CONTRIBUTOR` association — or be the PR author — preventing arbitrary users from consuming API quota on public repos (#530)
- PR-author bypass correctly guarded against absent payload fields with diagnostic logging (#530)

## [4.5.2] - 2026-04-07

### Changed

- Default judge model changed from Opus to Sonnet (~5x cost reduction per review)
- Team sizes 2, 4, and 6 now available — planner can pick more granular team sizes
- Planner prompt updated with guidance for 2-agent and 4-agent teams

## [4.5.1] - 2026-04-07

### Changed

- Renamed action from "Manki" to "Manki Review" for GitHub Marketplace uniqueness
- Updated action description to highlight the planner/agent/judge pipeline
- Changed marketplace branding color from orange to green

## [4.5.0] - 2026-04-07

### Added

- Smarter planner: picks specific agents from the pool with per-agent effort levels (#498)
- Language/framework auto-detection injected into reviewer prompts (#498)
- Planner prompt includes agent focus descriptions for better selection (#498)
- Retry failed reviewer agents with majority quorum — 1 retry, proceeds if `ceil(teamSize/2)` agents succeed (#499)
- Progress dashboard shows planner and judge runtime duration (#501)
- Telemetry: distinguish empty vs malformed reviewer responses, suspicious-fast warning (#502)
- Per-agent `failureReason` in Review Stats JSON (#509)
- Stale CLI process detection (90s no stdout) with streaming JSON mode (#512)
- CLI output sanitization against workflow-command injection (#512)

### Changed

- Planner effort bumped from `low` to `high` for more consistent decisions (#498)
- Planner defaults to 3 agents; scales to 5 for multi-subsystem or security-critical PRs (#498)
- CLI timeout increased from 300s to 20 minutes (#509, #518)
- CLI switched from `--output-format text` to `stream-json` with `--include-partial-messages` for progress monitoring (#512)
- Judge summary prompt includes anti-pattern guidance to avoid generic openers (#519)
- `MAX_AGENT_RETRIES` set to 1 (2 total attempts per agent) (#499)
- `SUSPICIOUS_FAST_THRESHOLD_MS` extracted as named constant (#513)

### Fixed

- Dashboard done count no longer decreases when failed agent transitions to retrying (#499)
- `partialNote` surfaced in review summary when agents fail after retries (#499)
- `typeof null` no longer produces misleading "got object" warning in `parseFindings` (#513)
- Docs footer attribution updated from `xdustinface` to `manki-review` (#503)
- `dist/` removed from git tracking — only committed by release workflow (#508)

### Chores

- Planner output sanitization: `language` and `context` fields stripped of injection patterns (#498)
- `buildAgentPool` helper extracted to deduplicate pool-building logic (#498)

## [4.4.0] - 2026-04-06

### Added

- Embed manki version in `manki-bot` comment marker for debugging (#468)
- `trivial` review level variant for `teamSize=1` reviews (#465)
- Landing page for GitHub Pages docs site (#478)

### Changed

- Redesign progress dashboard with stage grouping and unified icons (#476)
- Run dedup before judge to fix stale summary on follow-up reviews (#472)
- Migrate token service URL from `manki.dustinface.me` to `manki-api.dustinface.me` (#481)
- Move repo to `manki-review` GitHub organization, update all references (#484)

### Fixed

- Progress dashboard stage grouping, icon consistency, and flicker on updates (#469)
- Stale `review-in-progress` comments via Actions API verification (#466)

### Docs

- Add permission comments to workflow examples in SETUP.md (#480)
- Restructure README for scannability (#456)

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

[Unreleased]: https://github.com/manki-review/manki/compare/v5.1.0...HEAD
[5.1.0]: https://github.com/manki-review/manki/compare/v5.0.1...v5.1.0
[5.0.1]: https://github.com/manki-review/manki/compare/v5.0.0...v5.0.1
[5.0.0]: https://github.com/manki-review/manki/compare/v4.7.0...v5.0.0
[4.7.0]: https://github.com/manki-review/manki/compare/v4.6.1...v4.7.0
[4.6.1]: https://github.com/manki-review/manki/compare/v4.6.0...v4.6.1
[4.6.0]: https://github.com/manki-review/manki/compare/v4.5.3...v4.6.0
[4.5.3]: https://github.com/manki-review/manki/compare/v4.5.2...v4.5.3
[4.5.2]: https://github.com/manki-review/manki/compare/v4.5.1...v4.5.2
[4.5.1]: https://github.com/manki-review/manki/compare/v4.5.0...v4.5.1
[4.5.0]: https://github.com/manki-review/manki/compare/v4.4.0...v4.5.0
[4.4.0]: https://github.com/manki-review/manki/compare/v4.3.0...v4.4.0
[4.3.0]: https://github.com/manki-review/manki/compare/v4.2.0...v4.3.0
[4.2.0]: https://github.com/manki-review/manki/compare/v4.1.0...v4.2.0
[4.1.0]: https://github.com/manki-review/manki/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/manki-review/manki/compare/v3.1.0...v4.0.0
[3.1.0]: https://github.com/manki-review/manki/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/manki-review/manki/compare/v2.4.0...v3.0.0
[2.4.0]: https://github.com/manki-review/manki/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/manki-review/manki/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/manki-review/manki/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/manki-review/manki/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/manki-review/manki/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/manki-review/manki/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/manki-review/manki/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/manki-review/manki/releases/tag/v1.0.0
