# Changelog

All notable changes to Manki will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [7.0.1] - 2026-11-07

### Review loop and verdicts

- The verdict line on a follow-up round says how many blockers are new and how many are still open from earlier reviews, such as "1 new blocker and 2 still open". The summary under it no longer says nothing blocks while an earlier blocker is open, and a round with a new blocker also lists the earlier blockers still open ([#1095](https://github.com/manki-review/manki/pull/1095)).

Also: the Manki service now runs a thread reply before a review that arrives at the same time, so a push and a reply on a Manki thread no longer get a request for changes that the reply withdraws a minute later. The service is updated live, with no Manki release needed ([manki-review/token-service#48](https://github.com/manki-review/token-service/pull/48)).

## [7.0.0] - 2026-11-07

Manki 7 checks its findings against the code before it posts them. Reviewers on a Claude or Codex subscription read the PR beyond the diff with read-only tools, every blocker must cite the lines that prove it, and the judge tries to refute each blocker before it blocks. Only blockers block. Drafts, very large PRs and PRs you name in `.manki.yml` get no automatic review. This release is tracked in [#1036](https://github.com/manki-review/manki/issues/1036).

### Breaking changes and migration

1. Pin the action to `manki-review/manki@v7`.
2. Manki runs only as the `workflow_dispatch` run the Manki service starts. Make `.github/workflows/manki.yml` the dispatched workflow from Step 3 of `docs/getting-started.md`, and delete the event-driven workflow and any `manki-dispatch.yml`. The service serves only the accounts it lists, so the repository's account must be one of them ([#1084](https://github.com/manki-review/manki/pull/1084)).
3. Remove `concurrency_lock_ttl_seconds` from the workflow and from `.manki.yml`. The service orders each PR's runs, so the in-app lock is gone ([#1084](https://github.com/manki-review/manki/pull/1084)).
4. Drafts get no automatic review. Set `drafts: review` to review them automatically. A draft review never approves ([#1061](https://github.com/manki-review/manki/pull/1061)).
5. Only blockers block, in every round. Warnings, security warnings included, are listed as smaller fixes, so a round with only warnings left approves ([#1047](https://github.com/manki-review/manki/pull/1047)).
6. A PR over 8,000 reviewable lines gets no automatic review, only a request to split it with a Force review box, and Manki never reviews one over 15,000 lines. The old limit was 50,000. Raise `auto_review_max_lines` and `max_diff_lines` on the base branch to review larger PRs ([#1062](https://github.com/manki-review/manki/pull/1062)).
7. Provider CLIs get only the environment variables they need, their own documented settings and their own credential. Any other variable in the Manki step's `env:` no longer reaches them ([#1051](https://github.com/manki-review/manki/pull/1051), [#1064](https://github.com/manki-review/manki/pull/1064)).
8. Codex reviewers run without a shell, the image reader or web search ([#1048](https://github.com/manki-review/manki/pull/1048)).
9. `stats` is ignored. The round record is always a hidden comment in the review ([#1049](https://github.com/manki-review/manki/pull/1049)).
10. The `BUDGET` outcome is gone. A clean last round is `READY` with a successful `Manki` check ([#1050](https://github.com/manki-review/manki/pull/1050)).
11. `models.agents` is removed. A config that sets it gets an unknown-key warning, and the key no longer sets the second finder's model. Set `models.reviewer_pair`, or name models in a review group ([#1093](https://github.com/manki-review/manki/pull/1093)).

### Dispatched runs

- The Manki service orders every run of a PR, applies the skip rules, and drops pushes to drafts and to PRs with Pause ticked before it dispatches. The Action's in-app locks and its own skip checks are gone, and the PR's `.manki.yml` always comes from the head commit through the API ([#1084](https://github.com/manki-review/manki/pull/1084), [#1090](https://github.com/manki-review/manki/pull/1090)).
- A dispatched review shows a `Manki` check on the PR head with the round's result ([#1009](https://github.com/manki-review/manki/pull/1009)).
- After each review, Manki tells the service the reviewed commit, the approval and whether automatic review is paused. A push to a paused PR starts no run ([#1088](https://github.com/manki-review/manki/pull/1088)).
- Once a review posts its verdict, a failed progress comment from any earlier commit reads as superseded. A run that stops early marks its own progress comment "Review cancelled: the run stopped before the review finished" ([#1089](https://github.com/manki-review/manki/pull/1089), [#1090](https://github.com/manki-review/manki/pull/1090)).

### Reviewer tools

- Finders on the Claude CLI (`claude_code_oauth_token`) and the Codex CLI (`openai_oauth_token`) read the PR beyond the diff. Manki fetches the PR head with 500 commits of history into a folder that holds no credential, and gives each finder read, grep and glob confined to it, plus Manki's own `git_history` and `ast_grep` tools. A finder has no shell, no web access and no other tool. Finders on an API key or on Gemini still review the diff only ([#1054](https://github.com/manki-review/manki/pull/1054), [#1055](https://github.com/manki-review/manki/pull/1055), [#1059](https://github.com/manki-review/manki/pull/1059), [#1066](https://github.com/manki-review/manki/pull/1066)).
- Each finder gets a budget of tool calls by risk: 8 for the quick check of a trivial PR, 15 for a single finder, and 30 for a paired PR or one in a floor class such as `security`. It is told to wrap up three calls before the end, so its findings always arrive ([#1069](https://github.com/manki-review/manki/pull/1069)).
- Every finding carries the evidence behind it, and a blocker must cite the lines that prove it. A finding a finder ran out of steps on is marked "not checked yet", and what it was still checking comes back as an open lead. The judge settles a lead that could block, and the progress comment lists the others ([#1070](https://github.com/manki-review/manki/pull/1070)).
- The judge tries to refute every blocker and open lead with the same tools, and drops one the code rules out, with the reason in the progress comment. A blocker the judge cannot settle no longer blocks ([#1076](https://github.com/manki-review/manki/pull/1076)).
- A reply to a Manki thread is checked against the PR head with the same tools. The answer starts with Fixed, Withdrawn, Agreed, Kept or Unverified. A withdrawn finding saves a learning for its file only, and a security finding never saves one ([#1079](https://github.com/manki-review/manki/pull/1079)).
- Once Manki has answered a thread, a later round that finds the same problem never opens a new thread. It replies in that thread only when the code there got worse, and the review body lists the findings Manki agreed to leave for later as follow-ups ([#1082](https://github.com/manki-review/manki/pull/1082), [#1085](https://github.com/manki-review/manki/pull/1085)).
- These tools make a review on a subscription take longer and use more of it.

### Related repositories

- New `related_repos` setting: public repositories the review may read as context, as a `reference` this repository implements or a `consumer` that depends on it. Manki reads it from the base branch only ([#1052](https://github.com/manki-review/manki/pull/1052)).
- Finders with tools read these repositories through the same confined tools. A repository is fetched shallow, path-limited and without credentials the first time a finder names it. A change that breaks a consumer is a warning that lists its call sites ([#1068](https://github.com/manki-review/manki/pull/1068)).
- A finding that cites a related repository line that does not exist is graded like any claim the judge cannot check ([#1074](https://github.com/manki-review/manki/pull/1074)).

### Which PRs get reviewed

- New `skip_labels`, `skip_authors` and `skip_branches` settings name PRs that get no automatic review, such as bot dependency bumps. Manki reads them from the base branch only, so a PR cannot skip itself ([#1060](https://github.com/manki-review/manki/pull/1060)).
- Drafts are skipped by default, see the migration list above ([#1061](https://github.com/manki-review/manki/pull/1061)).
- A forced review of a large PR reads the diff in slices of `slice_lines` (default 1,500), four at a time, so it covers every line ([#1062](https://github.com/manki-review/manki/pull/1062)).

### Settings block

- Once the token service sends a PR's settings, Manki's newest progress comment ends with a settings block. It holds a status line and the boxes that apply: Pause automatic reviews, Full review, Deeper review, Cancel this review, Review this draft and Force review. The skipped, paused, draft and too-big notices move into it ([#1067](https://github.com/manki-review/manki/pull/1067), [#1077](https://github.com/manki-review/manki/pull/1077)).
- Every Force review box lives in the settings block. A head Manki already reviewed shows as up to date instead of getting a "Review skipped" comment, and the pause and too-big notices take over the progress comment ([#1080](https://github.com/manki-review/manki/pull/1080)).

### Review loop and verdicts

- The judge grades every finding against one blocker definition with five tests: the PR causes it, the failure can be named, the damage is serious, the code proves it with cited lines, and the author would fix it. Missing tests, style, performance without a crash, checks on trusted internal values and claims nobody can verify never block ([#1040](https://github.com/manki-review/manki/pull/1040)).
- The `review` block can name critical areas, say what counts as outside input, and give worked examples of how findings are graded ([#1044](https://github.com/manki-review/manki/pull/1044)).
- From the second round, each finding is new or previously missed. A smaller finding on code already reviewed gets no thread and is listed under "Previously missed", and Manki no longer objects to a fix it asked for ([#1057](https://github.com/manki-review/manki/pull/1057)).
- Only rounds that reviewed a new change count toward the automatic review pause, and the pause notice lists the blocking threads still open. An auto-approval resets the count like any approval ([#1041](https://github.com/manki-review/manki/pull/1041), [#1045](https://github.com/manki-review/manki/pull/1045)).
- A reply that Manki cannot check against the code gets "Unverified", and its thread stays open for a maintainer ([#1006](https://github.com/manki-review/manki/pull/1006)).
- Threads Manki resolves carry a resolution reason on GitHub: fixed, withdrawn or accepted ([#1037](https://github.com/manki-review/manki/pull/1037)).
- A finding that resembles an earlier fixed one goes to the judge with a note instead of being dropped, and the progress comment says how many findings were dropped before the judge and why ([#1011](https://github.com/manki-review/manki/pull/1011), [#1012](https://github.com/manki-review/manki/pull/1012)).
- Manki reads only the hidden round record. A round that only has the visible `Manki context` block of older releases no longer counts toward the round history or the round cap ([#1086](https://github.com/manki-review/manki/pull/1086)).
- Reviewers read the root `AGENTS.md` and the nearest one above each changed file, like `CLAUDE.md` ([#1039](https://github.com/manki-review/manki/pull/1039)).

### Review format

- The review body leads with the verdict and the findings. An approval's "What this does" follows in at most two sentences, and "What to test" is collapsed. Inline findings stay under about 700 visible characters with the rest collapsed, and nitpicks no longer get threads ([#1063](https://github.com/manki-review/manki/pull/1063)).
- A finding backed by evidence, inline or in the review body, has a collapsed "How this was checked" with up to five one-line entries. The fix-rate record notes whether a finding had evidence and whether the judge checked it ([#1081](https://github.com/manki-review/manki/pull/1081), [#1083](https://github.com/manki-review/manki/pull/1083)).
- Every finding opens with its severity, category and the effort of the fix, such as **Warning** · Concurrency · Moderate ([#1065](https://github.com/manki-review/manki/pull/1065)).
- Each finding in the review body lists is its own collapsed fold with a code preview, under a heading per list ([#1073](https://github.com/manki-review/manki/pull/1073)).
- A suggested fix in the review body shows its code as a fenced block under a **Suggested fix** label, and a block that names no language is highlighted by the file's extension, in the body and in inline comments ([#1087](https://github.com/manki-review/manki/pull/1087)).
- A PR whose files are all filtered out, or whose diff is too large, no longer shows "Review failed" on its progress comment ([#1007](https://github.com/manki-review/manki/pull/1007)).

### Security

- Manki redacts its own secret values from everything it posts to GitHub and writes to the memory repo ([#1042](https://github.com/manki-review/manki/pull/1042), [#1053](https://github.com/manki-review/manki/pull/1053)).
- Provider CLIs run with an allow list of environment variables. Claude on Bedrock, on Vertex or behind a gateway gets its credentials only while that setup is on ([#1051](https://github.com/manki-review/manki/pull/1051), [#1064](https://github.com/manki-review/manki/pull/1064)).
- `minimatch` is updated to 11 for advisory GHSA-g3hv-75wg-m249, a denial of service through glob patterns ([#1072](https://github.com/manki-review/manki/pull/1072)).

### Static analysis

- Manki runs actionlint and zizmor on changed workflows and ShellCheck on changed shell scripts, unless CI already runs the same tool. Turn one off with `static_analysis.analyzers.<name>: false` ([#1043](https://github.com/manki-review/manki/pull/1043)).
- Manki ships ast-grep rules for Rust that run in a Cargo repository and post hints the judge keeps as suggestions. Turn them off with `static_analysis.analyzers.ast_grep: false` ([#1046](https://github.com/manki-review/manki/pull/1046)).

### Reliability

- Saving a learning or suppression at the same time as another memory write no longer loses either change ([#1038](https://github.com/manki-review/manki/pull/1038)).
- A round record that does not fit the review is compressed instead of cut, and it keeps the raw finder findings and the findings the judge dropped ([#1049](https://github.com/manki-review/manki/pull/1049)).

### Docs

- The setup guide is split into pages under `docs/`: getting started, how reviews work, configuration, memory and the security model. `docs/configuration.md` has a reference of every setting, generated from the defaults ([#1075](https://github.com/manki-review/manki/pull/1075), [#1078](https://github.com/manki-review/manki/pull/1078)).
- `docs/migrating-to-v7.md` is a short checklist for moving from v6, with the setting that brings back each changed default. Getting started covers only the dispatched setup ([#1092](https://github.com/manki-review/manki/pull/1092)).

### Internal

- Each review and reply records every LLM call with its tokens, duration and an estimated cost. `npm run review-history` exports the records of a PR or repository, and `npm run calibration` measures blocker precision from them ([#1056](https://github.com/manki-review/manki/pull/1056), [#1058](https://github.com/manki-review/manki/pull/1058)).
- The `Release` workflow builds `dist/` on a release branch and writes no tags. An org admin tags and publishes the build ([#1008](https://github.com/manki-review/manki/pull/1008)).
- Manki's own workflow writes review memory with the App's memory token ([#1014](https://github.com/manki-review/manki/pull/1014)), and three comment trigger tests set their own API key input ([#1010](https://github.com/manki-review/manki/pull/1010)).

## [6.1.0] - 2026-11-06

### Upgrading

1. Pin the action to `manki-review/manki@v6`.
2. Copy the new job `if` from Step 3 of `SETUP.md`. The comment rules changed: the workflow no longer filters on `author_association`, and the action checks write access itself before it reads any secret ([#991](https://github.com/manki-review/manki/pull/991), [#995](https://github.com/manki-review/manki/pull/995)).
3. Review memory with the shared Manki App needs 6.1, because 6.0.x can no longer write memory through the App token. Otherwise set `memory_repo_token`. A memory repo with a name other than `<owner>/review-memory` needs `memory_repo_token` or your own App ([#994](https://github.com/manki-review/manki/pull/994), [#999](https://github.com/manki-review/manki/pull/999), [#1000](https://github.com/manki-review/manki/pull/1000)).
4. A review command no longer reviews a commit again when it already has a complete review. Manki replies with a Force review box instead, and only ticking it reviews the same commit again ([#1002](https://github.com/manki-review/manki/pull/1002)).

### Webhook mode (preview)

- New opt-in webhook mode. The Manki App receives the events and starts a dispatch-only workflow, `manki-dispatch.yml`, on your default branch, while every decision stays in the action. It is a preview for repositories on the service's allowlist, and every other repository keeps the event-driven workflow ([#987](https://github.com/manki-review/manki/pull/987), [#988](https://github.com/manki-review/manki/pull/988), [#1000](https://github.com/manki-review/manki/pull/1000)).
- Events run in order in two queues per PR, and several pushes during a review become one review of the newest head. Events Manki ignores start no run, and missed deliveries are picked up again every 5 minutes ([#988](https://github.com/manki-review/manki/pull/988)).
- Resolving the last open thread by hand runs the auto-approve check at once, which GitHub Actions cannot trigger on its own ([#987](https://github.com/manki-review/manki/pull/987)).
- The service adds the eyes reaction as soon as it queues a command. Manki now tracks the comments it answered with a hidden marker, so editing a comment to add a command still runs it ([#1003](https://github.com/manki-review/manki/pull/1003)).
- In webhook mode every run belongs to the default branch, so the PR shows no Manki check yet ([#1004](https://github.com/manki-review/manki/issues/1004)). Do not require a Manki status check while you use this mode.

### Review loop and verdicts

- Manki never approves a PR that conflicts with its base. A ready round posts its full verdict as a COMMENT with an "Approval held" line on top, and auto-approve posts one held notice per head instead of approving ([#998](https://github.com/manki-review/manki/pull/998)).
- Each run posts exactly one verdict review. Manki resolves the threads it counts as fixed before it posts, so a thread that cannot be resolved no longer leads to an approval followed by a request for changes on the same commit ([#998](https://github.com/manki-review/manki/pull/998)).
- An incomplete or failed review no longer counts as a review of its commit, so the next run reviews that commit normally. Its progress comment is marked superseded once a later verdict on the same head is posted ([#1002](https://github.com/manki-review/manki/pull/1002)).
- The review command reviews the current head when it has no complete review, and still bypasses the round cap and a pause ([#1002](https://github.com/manki-review/manki/pull/1002)).

### Security

- Starting Manki from a comment needs write access, and the action checks it before it requests a token or reads a provider credential. Organization members with a private membership work again. A contributor without write access and the author of a fork PR are refused without a reply ([#991](https://github.com/manki-review/manki/pull/991), [#995](https://github.com/manki-review/manki/pull/995)).
- A collaborator who is not the PR author can now tick Force review. The tick is checked against the editor, not the author of Manki's comment ([#991](https://github.com/manki-review/manki/pull/991)).
- With your own GitHub App, the review token is limited to the reviewed repo, and memory gets a second token limited to the memory repo with only `contents: write` ([#999](https://github.com/manki-review/manki/pull/999)).
- Memory writes use their own token: `memory_repo_token` first, then the App's memory token. They never fall back to the review token or `github_token`, and Manki logs one warning when no memory token is available ([#994](https://github.com/manki-review/manki/pull/994)).
- Provider CLIs start with a filtered environment. They get no `INPUT_*` variables, no OIDC request URL and no `*_TOKEN`, `*_KEY` or `*_SECRET` variables other than their own credential ([#994](https://github.com/manki-review/manki/pull/994)).

### Reliability

- A failed review always names its cause. A 5xx from GitHub reads as a transient failure with the status, the failing call, the request id and a retry hint, and an empty error names its status or type ([#992](https://github.com/manki-review/manki/pull/992)).

### Docs

- `SETUP.md` documents webhook mode, adds "Upgrading to 6.1", and explains the trade-off of running Manki under your own GitHub App, whose private key can mint tokens for the whole installation. The security notes say memory commands need write access ([#988](https://github.com/manki-review/manki/pull/988), [#1000](https://github.com/manki-review/manki/pull/1000)).

### Internal

- Manki reviews its own PRs in webhook mode. The event-driven workflow moves to `docs/examples/manki.yml`, which the snippet test keeps in step with `SETUP.md` ([#989](https://github.com/manki-review/manki/pull/989), [#997](https://github.com/manki-review/manki/pull/997)).

## [6.0.1] - 2026-11-06

### Review format

- Reviewers are named by the model they run on and the effort they ran at, plus the group's `focus` when one is set, such as "Claude Sonnet 5.5 · high". The "Finder" and "Pair finder" labels are gone, and the Trivial Change Verifier shows as "Quick check" ([#983](https://github.com/manki-review/manki/pull/983)).
- The progress comment's review header names the class and group the PR was routed to, such as "Review (security · pair)" ([#983](https://github.com/manki-review/manki/pull/983)).
- The fix-rate `specialist` field records the new reviewer names. Per-reviewer rows from before and after this release land in separate rows of `metrics/fix-rate.jsonl` and the report ([#983](https://github.com/manki-review/manki/pull/983)).

### Reliability

- A used-up provider quota, subscription limit or rate limit is no longer retried or sent to the fallback model. The round ends `INCOMPLETE` at once with a plain message that names the provider limit, the reviewers it stopped and the reset time when the provider gives one ([#984](https://github.com/manki-review/manki/pull/984)).

### Internal

- The workflow examples in `SETUP.md`, `docs/index.html` and `CONTRIBUTING.md` pin `@v6`, and `.manki.yml.example` matches the v6 defaults: `stats.hidden` is `true`, the memory repo no longer mentions patterns, and `static_analysis.analyzers` is listed ([#980](https://github.com/manki-review/manki/pull/980)).

## [6.0.0] - 2026-11-05

Manki 6 gives one clear verdict per round and stops a review loop that is not converging. Every round ends in a named outcome, a failed or partial run never approves, and the bar for blocking lives in code. One or two generalist finders replace the specialist team, and a final verdict reader checks the whole change before Manki approves. This release is tracked in [#859](https://github.com/manki-review/manki/issues/859).

### Breaking changes and migration

To upgrade from v5:

1. Pin the action to `manki-review/manki@v6`, or to the commit SHA of a `v6.x.y` release tag.
2. Replace `.github/workflows/manki.yml` with the snippet in `SETUP.md`. It carries the new `permissions`, the per-PR `concurrency` queues, the job-level `if` and `timeout-minutes: 30`.
3. Review the optional settings below: `models`, the `review` block, `static_analysis`, `metrics.fix_rate` and `stats.hidden`.

- Pin Manki to a release tag such as `manki-review/manki@v6`. `dist/` is no longer committed to `main`. The `Release` workflow builds it when a `vX.Y.Z` tag is pushed and moves the tag to the build commit, so `@main` and commit SHAs from `main` no longer run ([#842](https://github.com/manki-review/manki/pull/842)).
- The default Claude models are now `claude-haiku-5-5` for the planner and dedup, `claude-sonnet-5-5` for the reviewer, and `claude-opus-5-5` for the judge and the verdict reader. A repo that does not set `models` moves to these models and their cost. A repo that pins 4.x models keeps them ([#945](https://github.com/manki-review/manki/pull/945)).
- The specialist team is gone. Each round runs one generalist finder, or two finders on different models when the planner marks the change as paired, or the Trivial Change Verifier alone for a trivial change. Each `reviewers:` entry is now one extra focus line in the finder prompt instead of its own agent ([#934](https://github.com/manki-review/manki/pull/934)).
- `review_level` and `review_thresholds` are deprecated and ignored, with a warning. The planner now sizes the review from the nature of the change, not its line count ([#934](https://github.com/manki-review/manki/pull/934)).
- `models.agents` is deprecated and will be removed in the next major release. It still loads with a warning, and unless `models.reviewer_pair` is set, its first model that differs from `models.reviewer` becomes the second finder's model ([#934](https://github.com/manki-review/manki/pull/934), [#960](https://github.com/manki-review/manki/pull/960)).
- A failed or partial run never approves. A provider failure, an unparseable or truncated reply, a failed judge or a failed GitHub call ends the round `INCOMPLETE`. Manki posts a COMMENT with the reason, leaves the previous review standing and fails the job ([#893](https://github.com/manki-review/manki/pull/893), [#890](https://github.com/manki-review/manki/pull/890), [#897](https://github.com/manki-review/manki/pull/897), [#898](https://github.com/manki-review/manki/pull/898), [#915](https://github.com/manki-review/manki/pull/915)).
- A finder that still fails after its retry makes the round `INCOMPLETE`. The quorum path that let a round continue with the remaining agents is removed ([#934](https://github.com/manki-review/manki/pull/934)).
- Before Manki approves, a final verdict reader reads the whole diff once and can request changes on its own. A PR with no blocking findings therefore costs one more model call ([#915](https://github.com/manki-review/manki/pull/915)).
- From round 3 only blockers block. Warnings still standing become follow-ups listed in the review body, so a round with only warnings left can approve. Security findings are the exception and block at every round ([#922](https://github.com/manki-review/manki/pull/922), [#931](https://github.com/manki-review/manki/pull/931)).
- A blocker that comes back after a real fix claim ends the round `NOT_CONVERGING`. A fix claim is a resolved thread, a reply in the thread, or a fix Manki confirmed. A rebase with the thread still open and unanswered is not one, and the round stays `ADDRESS_FIRST`. On `NOT_CONVERGING` Manki keeps REQUEST_CHANGES, lists the blocker under "Needs a human" and pauses automatic review until someone comments `@manki review` ([#924](https://github.com/manki-review/manki/pull/924), [#965](https://github.com/manki-review/manki/pull/965)).
- Only blockers and warnings become review threads that hold up approval. Suggestions and nitpicks are posted inline as "not blocking" (at most five per review) or listed in a collapsed body section, and auto-approve ignores them, including old open suggestion and nitpick threads ([#917](https://github.com/manki-review/manki/pull/917), [#925](https://github.com/manki-review/manki/pull/925)).
- The PR author can no longer clear a security finding alone, unless the author is a repo admin. Agreeing with it or resolving its thread does not retire it. A maintainer other than the author has to resolve it or agree, or the judge has to find it addressed. If the author resolves the thread anyway, Manki reopens it once and explains why ([#942](https://github.com/manki-review/manki/pull/942), [#968](https://github.com/manki-review/manki/pull/968)).
- A `.manki.yml` with a YAML or schema error now fails the run and posts the error on the PR. Before, Manki reviewed with the defaults, which include `auto_approve: true` ([#909](https://github.com/manki-review/manki/pull/909)).
- The `review` and `static_analysis` blocks are read from the base branch only. A PR that changes them is reviewed with the base branch's copy, and the change applies after merge ([#938](https://github.com/manki-review/manki/pull/938), [#954](https://github.com/manki-review/manki/pull/954)).
- `stats.hidden` now defaults to `true`. The `Manki context` block sits in an HTML comment, and the visible stats line becomes a hidden `manki-stats` comment. Set `stats.hidden: false` to keep the visible block ([#925](https://github.com/manki-review/manki/pull/925)).
- Repeated findings are no longer escalated to blockers. Manki stops reading and writing `patterns.yml` in the memory repo, and existing files can be deleted ([#914](https://github.com/manki-review/manki/pull/914)).
- `noise_level` no longer changes the judge prompt. It still shapes the reviewer prompts, so existing configs keep working ([#907](https://github.com/manki-review/manki/pull/907)).
- The Claude CLI ignores user, project and local settings files and loads no MCP servers. Configure it only through its environment, such as `CLAUDE_CODE_OAUTH_TOKEN` ([#911](https://github.com/manki-review/manki/pull/911)).
- Personal Google accounts can no longer use `gemini_oauth_token`, because Google ended Login with Google for the Gemini CLI on consumer tiers. Switch to `gemini_api_key` ([#919](https://github.com/manki-review/manki/pull/919)).
- API-key users of Anthropic now run on API version `2026-10-21`, and the key is sent as `Authorization: Bearer`. This only matters if you put a proxy in front of the API through `ANTHROPIC_BASE_URL` ([#916](https://github.com/manki-review/manki/pull/916)).
- Recommended workflow changes, all in the `SETUP.md` snippet:
  - Action required: use the new `concurrency` block. Each PR gets two queues with `queue: max` and no `cancel-in-progress`: `manki-review-<pr>` for pushes and review commands, and `manki-reply-<pr>` for thread replies and other commands. Runs in a queue start in order and are never cancelled from outside. A running review stops on its own when a new commit lands ([#977](https://github.com/manki-review/manki/pull/977), [#978](https://github.com/manki-review/manki/pull/978)).
  - Add the job-level `if`, so GitHub skips events Manki ignores, such as bot comments, dismissals of Manki's own reviews and every fork PR event, before a runner starts. Add `timeout-minutes: 30` in place of the 6 hour default ([#977](https://github.com/manki-review/manki/pull/977)).
  - Drop `cache: 'npm'` from `actions/setup-node`. It fails the job in a repository without a lockfile, and the snippet runs no npm install that would use it ([#977](https://github.com/manki-review/manki/pull/977)).
  - The workflow needs only `actions: read` instead of `actions: write` ([#967](https://github.com/manki-review/manki/pull/967)). Add `checks: read` and `security-events: read` so Manki can read CI and code scanning results ([#938](https://github.com/manki-review/manki/pull/938)).
  - Add `closed` to the `pull_request` types to get the merge-time fix rate ([#932](https://github.com/manki-review/manki/pull/932)).
  - Pin the Claude, Codex and Gemini CLI installs to the versions in `SETUP.md`, and install Gemini with `--ignore-scripts` ([#894](https://github.com/manki-review/manki/pull/894), [#911](https://github.com/manki-review/manki/pull/911), [#918](https://github.com/manki-review/manki/pull/918)).
  - `github_token` no longer needs to be passed, since it defaults to the workflow token ([#909](https://github.com/manki-review/manki/pull/909)).
  - To pin by commit SHA, take the commit a release tag points to, or keep `@v6` and record it in a workflow lockfile. From v6.0.0 releases are immutable, so the SHA behind `v6.x.y` never changes ([#976](https://github.com/manki-review/manki/pull/976), [#977](https://github.com/manki-review/manki/pull/977)).
  - If a ruleset restricts who may dismiss reviews, allow the Manki app, or GitHub Actions when Manki runs without the app. Otherwise the old REQUEST_CHANGES keeps blocking the merge after Manki approves ([#977](https://github.com/manki-review/manki/pull/977), [#978](https://github.com/manki-review/manki/pull/978)).

### Review loop and verdicts

- Each round ends in one outcome: `READY` posts APPROVE, `ADDRESS_FIRST` and `NOT_CONVERGING` post REQUEST_CHANGES, `INCOMPLETE` posts COMMENT, and `BUDGET` posts APPROVE on the last automatic round when nothing blocks. The outcome is stored in the round context ([#915](https://github.com/manki-review/manki/pull/915), [#924](https://github.com/manki-review/manki/pull/924)).
- The last round `max_auto_rounds` allows blocks on blockers only. It ends `BUDGET` with an approval and the remaining warnings listed, or `NOT_CONVERGING` with a "Needs a human" list. A PR no longer sits at a stale REQUEST_CHANGES after the round cap ([#924](https://github.com/manki-review/manki/pull/924)).
- A push that leaves the PR's own change as it was, such as a clean rebase or an empty commit, keeps the previous verdict and runs no model. A previous approval is posted again on the new head, so a ruleset that dismisses approvals on push gets it back ([#921](https://github.com/manki-review/manki/pull/921)).
- Reviewers see the same filtered full PR diff every round, with no round number or earlier findings. Only the judge sees the history. This replaces the inter-round delta and follow-up planner context from 5.3.0 ([#908](https://github.com/manki-review/manki/pull/908), [#913](https://github.com/manki-review/manki/pull/913)).
- The judge re-grades every finding against a fixed rubric and no longer sees the reviewer's severity. Missing test coverage, unverifiable claims, untouched code and commit messages no longer block ([#907](https://github.com/manki-review/manki/pull/907), [#957](https://github.com/manki-review/manki/pull/957)).
- The judge now gets the full PR diff, so it can check a finding against the actual change ([#901](https://github.com/manki-review/manki/pull/901)).
- A judged severity can no longer land on the wrong finding when the model reorders its output, and a finding the judge leaves out stays visible ([#906](https://github.com/manki-review/manki/pull/906)).
- A blocker the judge marks `hypothetical` keeps its blocker severity. Only warnings and suggestions are still capped at nitpick ([#891](https://github.com/manki-review/manki/pull/891)).
- Resolving a Manki thread, or replying that you agree, now clears the matching earlier finding from the verdict. A finding reported only in the review body stops blocking once the PR no longer touches its file ([#912](https://github.com/manki-review/manki/pull/912)).
- When the judge finds that a fix addressed an open thread, the review no longer requests changes for it ([#910](https://github.com/manki-review/manki/pull/910)).
- Manki no longer closes its own threads just because the code moved. Threads the judge did not confirm fixed stay open, and findings that match them are no longer suppressed ([#920](https://github.com/manki-review/manki/pull/920)).
- A paused PR gets its pause notice once, and later pushes update it instead of posting another. The reply on a reopened security thread of a paused PR says to comment `@manki review` after pushing the fix ([#966](https://github.com/manki-review/manki/pull/966)).
- A blocker that matches an earlier blocker with an open thread gets no duplicate thread. The review links it under "Still open from earlier reviews" instead ([#965](https://github.com/manki-review/manki/pull/965)).
- A round that confirms a blocker fixed resolves Manki's thread with a `Fixed in <sha>.` reply and no longer blocks on it. A fix counts as confirmed only when the push changed the thread's file and the round does not name the blocker again ([#965](https://github.com/manki-review/manki/pull/965)).
- The round cap counts only the rounds since Manki last approved the PR, so rebases after an approval no longer use it up and pause an approved PR ([#965](https://github.com/manki-review/manki/pull/965)).
- The "Auto-approve withheld" notice appears only when no automatic review will run on the head, because review is paused or `auto_review` is off, and it says which. Withheld and pause notices are cleaned up once a round posts its verdict ([#969](https://github.com/manki-review/manki/pull/969)).
- A rebase-only push can auto-approve once its threads are resolved, and the `check` command explains why a commit is not approved yet ([#969](https://github.com/manki-review/manki/pull/969)).
- Manki never posts a verdict on a superseded commit. It checks the PR head between stages and before posting, and when the head moved it posts no review, resolves no threads and marks the progress comment as superseded by the new commit ([#967](https://github.com/manki-review/manki/pull/967)).
- A review in progress only holds back runs for the same commit, so a push during a `@manki review` run of the older commit gets its own review instead of "Review skipped" ([#967](https://github.com/manki-review/manki/pull/967)).

### Review format

- A review opens with a short verdict line: Approved, Changes requested, Review incomplete or Needs a human. A request for changes says what goes wrong in practice, and an approval says what the change does and what to test as numbered steps ([#925](https://github.com/manki-review/manki/pull/925), [#915](https://github.com/manki-review/manki/pull/915)).
- Finding comments open with the severity label, and a low-confidence finding says Manki is not sure it applies. Identifiers and paths from the diff are always shown as code, and a `suggestion` block only ever holds code that applies as is ([#925](https://github.com/manki-review/manki/pull/925)).
- Thread replies start with Fixed, Agreed, Withdrawn or Still open and stay within three sentences. On Fixed, Agreed or Withdrawn from the PR author or a collaborator, Manki resolves the thread ([#929](https://github.com/manki-review/manki/pull/929)).
- Review text from the judge, verdict reader and reviewers follows shared writing rules: plain words, the practical consequence first, no praise or filler ([#929](https://github.com/manki-review/manki/pull/929)).
- Hidden markers sit at the end of every comment, so notifications and previews start with the actual message ([#961](https://github.com/manki-review/manki/pull/961)).
- The progress comment drops its dash separators and decorative emoji and shows one status symbol per agent ([#925](https://github.com/manki-review/manki/pull/925)).
- File-level threads in the "Still open from earlier reviews" list show the path without `:0` ([#963](https://github.com/manki-review/manki/pull/963)).

### Security

- Security findings block at every round. The judge treats a reachable defect on attacker-controlled input, such as prompt injection, auth bypass or token exposure, as a blocker, or refutes it when the attacker gains nothing new ([#931](https://github.com/manki-review/manki/pull/931)).
- Provider CLIs run in an empty temp directory instead of the PR checkout. A PR can no longer add hooks, MCP servers, settings or context files that run during the review ([#911](https://github.com/manki-review/manki/pull/911)).
- A security-sensitive path always gets two finders, whatever the planner or the config say ([#934](https://github.com/manki-review/manki/pull/934)).
- A repo admin who authored the PR can clear a security finding on it, by resolving the thread or commenting `@manki dismiss` in it. Manki replies once in the thread, and every override is recorded in the round context and in the approval that relies on it ([#968](https://github.com/manki-review/manki/pull/968)).
- `@manki dismiss` in a Manki thread resolves it. Clearing a security finding this way needs write access, checked through the API ([#968](https://github.com/manki-review/manki/pull/968)).
- A Manki command quoted in inline code or a code block is treated as text and no longer runs ([#968](https://github.com/manki-review/manki/pull/968)).
- Stateless GitHub App tokens are now redacted in full from error text Manki posts, along with `ghu_` and `ghr_` tokens ([#905](https://github.com/manki-review/manki/pull/905)).

### Static analysis

- Manki reads check-run annotations, open code scanning alerts and vulnerable packages from the dependency review on the PR head, and gives reviewers the results on changed lines. A suggestion or nitpick that repeats a tool result on the same line is dropped. Configure the sources with `static_analysis` ([#938](https://github.com/manki-review/manki/pull/938)).
- Tool results on changed lines also reach the judge as candidate findings, and a kept one is posted with the tool in its label. Each reviewer finding is checked against the code first, and the judge sees whether a tool confirmed or contradicted it ([#943](https://github.com/manki-review/manki/pull/943), [#946](https://github.com/manki-review/manki/pull/946)).
- New opt-in `static_analysis.analyzers` runs `ast-grep` with Manki's own rules on changed JavaScript, TypeScript and Python files, for repos without CI checks. Turn it on with `ast_grep: true` or `analyzers: all`. No PR code runs ([#959](https://github.com/manki-review/manki/pull/959)).
- New `static_analysis.wait_for_checks` and `wait_timeout_seconds` let Manki wait for named CI checks in another workflow before it reads their results ([#959](https://github.com/manki-review/manki/pull/959)).
- Three more opt-in analyzers: `secrets` runs gitleaks on the added lines, `dependencies` runs OSV-Scanner on every changed lockfile, and `semgrep: { rules: [...] }` runs your own Semgrep-compatible rule files from the base branch with Opengrep. The binaries are pinned and checksum-verified, they use Manki's own config, and they never run PR code or see a token. All are off by default, and `analyzers: all` turns on `secrets` and `dependencies` but not `semgrep` ([#962](https://github.com/manki-review/manki/pull/962)).
- A changed lockfile is scanned even when `exclude_paths` hides it from the reviewers, such as `yarn.lock` under the default `*.lock`. Its results are listed in the review body ([#962](https://github.com/manki-review/manki/pull/962)).

### Reviewer groups and models

- New `review` block in `.manki.yml` with `groups`, `classes`, `routing`, `default_group` and `allow_weaker`. Each PR is sorted into a review class from its paths and the planner triage, and the class picks the group of finders that reads it. Without the block the built-in groups apply ([#952](https://github.com/manki-review/manki/pull/952), [#954](https://github.com/manki-review/manki/pull/954)).
- Security, supply chain and data contract changes are floor classes. They always get two finders on two models, and a group that would read them weaker fails the run unless `allow_weaker` names the class ([#952](https://github.com/manki-review/manki/pull/952), [#954](https://github.com/manki-review/manki/pull/954)).
- A tests-only change is no longer trivial and gets a full finder instead of the Trivial Change Verifier ([#952](https://github.com/manki-review/manki/pull/952)).
- New `models.reviewer_pair` sets the second finder's model. Without it, the second finder runs on the other Claude tier, so Sonnet pairs with Opus ([#933](https://github.com/manki-review/manki/pull/933), [#934](https://github.com/manki-review/manki/pull/934)).
- New `planner.paired` (`auto`, `always` or `never`) pins whether a second finder runs. It is already deprecated in favour of `review.routing` and logs a warning, but it still works ([#934](https://github.com/manki-review/manki/pull/934), [#954](https://github.com/manki-review/manki/pull/954)).
- Reviewer `effort` accepts `max` ([#954](https://github.com/manki-review/manki/pull/954)).
- GPT-5 and later models now honour the effort tiers, and `max` reaches `xhigh` or `max` where the model allows it. The Codex CLI is pinned to 0.166.0 ([#918](https://github.com/manki-review/manki/pull/918)).
- Gemini runs on `@google/genai`, and Gemini 3 models get the effort tier as `thinkingLevel` ([#919](https://github.com/manki-review/manki/pull/919)).
- The Anthropic API path sends adaptive thinking to Opus 4.6 and later, which reject the budget form. Before, every API-key run with the default judge failed ([#892](https://github.com/manki-review/manki/pull/892)).
- `claude_code_oauth_token` is no longer deprecated and no longer logs a warning on every run. The Claude Code CLI is pinned, so a future default of `--bare` cannot break it ([#888](https://github.com/manki-review/manki/pull/888), [#894](https://github.com/manki-review/manki/pull/894)).
- On merge, Manki records how many of its posted findings were fixed, dismissed or left untouched, in the job summary and in `metrics/fix-rate.jsonl` when memory is on. Turn it off with `metrics.fix_rate: false`. A new `npm run fix-rate-report` script turns these files into tables ([#932](https://github.com/manki-review/manki/pull/932), [#957](https://github.com/manki-review/manki/pull/957), [#960](https://github.com/manki-review/manki/pull/960), [#964](https://github.com/manki-review/manki/pull/964)).
- The `Manki context` block records the finder models, which finders raised each kept finding, and a `routing` object with the class, group and a digest of the review config ([#933](https://github.com/manki-review/manki/pull/933), [#960](https://github.com/manki-review/manki/pull/960)).

### Reliability

- Claude CLI output is capped at 32768 tokens, so a runaway reply ends as a truncated reply that the stage retries once. Each stage has its own time budget: the judge stops after 300 s and the verdict reader after 900 s, instead of 1,200 s ([#958](https://github.com/manki-review/manki/pull/958)).
- The judge and the verdict reader are asked once more when a reply does not parse, so one malformed reply no longer costs the round ([#928](https://github.com/manki-review/manki/pull/928)).
- JSON is read from the shape each stage expects, so a bracket in prose before the JSON no longer breaks parsing ([#927](https://github.com/manki-review/manki/pull/927)).
- Transient GitHub errors and rate limits are retried. A persistent error fails the run instead of turning REQUEST_CHANGES into a COMMENT ([#898](https://github.com/manki-review/manki/pull/898)).
- Long PRs with more than 100 comments or threads, or more than 30 reviews, keep their round state, lock and auto-approve behaviour ([#926](https://github.com/manki-review/manki/pull/926)).
- Runs on the workflow token, a custom GitHub App or a personal access token now recognise their own comments and reviews, so round state, the concurrency lock and the round cap work across rounds. With a personal access token, use a dedicated account ([#923](https://github.com/manki-review/manki/pull/923), [#941](https://github.com/manki-review/manki/pull/941)).
- Excluded and generated files no longer reach any prompt, and an oversized diff gives every file a fair share of the budget instead of cutting from the top ([#904](https://github.com/manki-review/manki/pull/904)).
- A draft marked ready for review is now reviewed ([#909](https://github.com/manki-review/manki/pull/909)).
- Replies and `@manki` commands on a Manki thread are no longer dropped with a "Review skipped" comment ([#889](https://github.com/manki-review/manki/pull/889)).
- A stage the provider refuses is retried once on a fallback model: `models.fallback` if set, else the reviewer model, or the other Claude tier when the stage already runs on it. A second refusal ends the round `INCOMPLETE`, and each fallback is recorded in the round context ([#955](https://github.com/manki-review/manki/pull/955)).
- A running review checks the PR head every 30 seconds and stops within about 30 s when a new commit lands, aborting the model call in flight. After a cancel signal it makes no GitHub writes, so a cancelled run never posts or dismisses a review ([#978](https://github.com/manki-review/manki/pull/978)).
- A progress comment from an old run that GitHub deleted under its retention rules counts as finished and no longer blocks reviews. A failed dismissal of an earlier review is logged as a warning ([#978](https://github.com/manki-review/manki/pull/978)).
- When GitHub refuses an approval, Manki logs GitHub's real error and names the repo setting only when the error does. Before, it always blamed the "Allow GitHub Actions to create and approve pull requests" setting ([#967](https://github.com/manki-review/manki/pull/967)).

### Internal

- `runFullReview` is split into named stages, `runReview` takes one options object, and a new end-to-end test runs a round against a fake GitHub ([#947](https://github.com/manki-review/manki/pull/947), [#948](https://github.com/manki-review/manki/pull/948), [#949](https://github.com/manki-review/manki/pull/949)).
- The release workflow runs on current actions and publishes with immutable releases in mind. It builds `dist/`, publishes the release, and only then moves the floating `vX` tag ([#976](https://github.com/manki-review/manki/pull/976)).
- Feature and fix PRs no longer edit `CHANGELOG.md`, and CI enforces it. The release PR writes the entries ([#900](https://github.com/manki-review/manki/pull/900)).
- `@anthropic-ai/sdk` moves to 1.4, `npm audit` findings are fixed and the workflows use the Node 24 actions ([#916](https://github.com/manki-review/manki/pull/916), [#896](https://github.com/manki-review/manki/pull/896)).
- `AGENTS.md` has a current architecture map, and a test fix restored `main` CI ([#895](https://github.com/manki-review/manki/pull/895), [#902](https://github.com/manki-review/manki/pull/902)).

## [5.3.0] - 2026-05-25

### Added

- `RunReviewerAgentOptions` now accepts an optional `interRoundDiff` field, threaded through all four call sites in the review pipeline. On follow-up rounds with a non-empty `interRoundDiff`, the `## Pull Request Diff` block in the reviewer prompt becomes `## Pull Request Diff (delta since prior review round)` populated with the delta instead of the full PR diff, so reviewers focus exclusively on what changed since they last looked. The `## Changed Files` block continues to carry full-PR file contents for reference. Closes [#820](https://github.com/manki-review/manki/issues/820), [#821](https://github.com/manki-review/manki/issues/821) ([PR #853](https://github.com/manki-review/manki/pull/853), [PR #854](https://github.com/manki-review/manki/pull/854)).
- On follow-up rounds (round > 1), the planner system prompt now includes a `## Follow-Up Round Context` block with the current round number, the inter-round delta line count (counting only `+`/`-` lines, not headers or context lines, via a new `countChangedLines` helper), and the pinned team that will be unioned with the planner's picks, along with guidance to default to the prior team when the delta is small. Closes [#822](https://github.com/manki-review/manki/issues/822) ([PR #855](https://github.com/manki-review/manki/pull/855)).

### Fixed

- `isPriorLikelyUnresolved` now retires threadless priors (handover entries without a `threadId`, produced before the `threadId` field was introduced) when no review threads are currently open on the PR. Previously, these legacy priors triggered a false `Blocking unresolved review threads:` header on long-running PRs whose round 1 ran on a pre-`threadId` handover format, even though all threads had since been resolved. Closes [#847](https://github.com/manki-review/manki/issues/847) ([PR #851](https://github.com/manki-review/manki/pull/851)).

## [5.2.0] - 2026-05-24

### Added

- `RoundPlanner` now carries full team-selection provenance: `source` (`planner` / `heuristic` / `heuristic_fallback` / `disabled`, replacing the ambiguous `used: boolean` which is preserved as a derived alias), `fallbackReason` (short tag when the planner failed: `timeout`, `invalid_teamSize`, `invalid_judgeEffort`, `agents_teamSize_mismatch`, `exception`), `language` and `context` (the sanitized hints the planner emitted), `agents` (the picks with per-agent effort), `coreAgentInjections` (names the team-builder reinjected after the planner omitted them, e.g., Security & Safety on sensitive paths), and `priorRoundEffortDowngrades` (effort steps applied by the safety net when the previous round dismissed all of a specialist's findings). `RoundAgentMetric` gains `model` (the resolved per-agent model, from `config.models.agents` or `models.reviewer`), `effort` (the run-time effort after planner pick plus downgrade), and `multiPassConsistency` (`{ consistent, totalRaw }` from `intersectFindings` on `review_passes > 1` rounds). Replay tooling can now answer "why did this round pick these agents at this effort?" from the persisted context alone ([#793](https://github.com/manki-review/manki/issues/793)).
- Every Manki review body now ends with a `Reviewed commit [`<short-sha>`](…)` footer linking to the exact commit reviewed, removing ambiguity about which SHA a verdict applies to and giving a stable human-visible anchor for every review across `APPROVED` / `COMMENTED` / `CHANGES_REQUESTED` ([#807](https://github.com/manki-review/manki/issues/807)).
- `RoundMeta` now carries `cap` (`priorRoundCount`, `maxAutoRounds`, `skipCap`, `forceReview`, `bypassReason`) and `trigger` (`event`, `sender`) provenance, so a round-cap progression like `5/5 -> 6/5` is attributable to the exact tickbox or comment that admitted each round ([#791](https://github.com/manki-review/manki/issues/791), [PR #815](https://github.com/manki-review/manki/pull/815)).
- `RoundContext.usage` now ships per-stage token counts (`planner`, `reviewer`, `judge`, `dedup`) and round-level rollups (`inputTokens`, `outputTokens`, `totalTokens`) sourced directly from each provider's SDK/CLI usage block. `LLMResponse` carries `usage` (`inputTokens`, `outputTokens`, `cachedTokens`, `reasoningTokens`) and `latencyMs` on every call. `RoundAgentMetric` is populated with `durationMs`, `inputTokens`, `outputTokens`, `retryCount`, `status`, and `failureReason` (threaded from `ReviewResult.agentFailureReasons`). `RoundJudge.retryCount` is wired through. Replay tooling can now reconstruct token cost and per-stage latency from metadata alone ([#792](https://github.com/manki-review/manki/issues/792)).
- `runFullReview` now refetches the PR's current `head.sha` via `octokit.rest.pulls.get` after config load and bails with a `core.info` line (`Event SHA <a> != head SHA <b> — bailing out`) when the head has advanced past the event SHA the run was triggered with. The check sits before `postProgressComment` so a stale-SHA bail leaves no progress marker behind to block a sibling run, complements the existing `pull_request_review` stale-SHA guard in `handleReviewStateCheck`, and is fail-open: a transient `pulls.get` error logs `Head SHA lookup failed, proceeding: <error>` and the review continues so an API hiccup never disables reviews ([#826](https://github.com/manki-review/manki/issues/826), [PR #831](https://github.com/manki-review/manki/pull/831)).
- `RoundContext` now carries dedup, recap, and diff-prep attribution that was previously lost between pipeline stages. `RoundDedup` gains `sameRoundLlmDropped` (the judge's same-round merge count, previously rolled into `mergedDuplicates` via subtraction), `duplicateMatches[]` (per-drop `{ droppedTitle, matchedTitle, matchType }` for both `deduplicateFindings` and `llmDeduplicateFindings`, with `matchType` ∈ `'exact' | 'substring' | 'word_overlap' | 'llm'`), and `testNitSuppressedCount` (returned from `runReview` but previously never written into the context). `RoundDiff` gains `excludedFiles` (path + matched glob), `binarySkipped` (paths dropped by `isBinaryFile` during `parsePRDiff`), `oversizedHandled` (always `false` on the success path, recorded explicitly so replay tooling can tell oversize-bail rounds apart from regular ones), and `perFile` (lossless `{ path, additions, deletions, changeType }` rollup that replaces the lossy `fileTypes` aggregate). `RoundMemory` gains `loadStatus` (`'loaded' | 'disabled' | 'no_token' | 'failed'`) and `loadError` (truncated message on failure), so a silently-collapsed memory load is no longer indistinguishable from "memory disabled". `RoundContext` gains a `recap` sub-section recording `priorRoundCount` (priors actually loaded), `reclassifiedPriorCount` (fingerprints whose `authorReplyClass` flipped during `refreshAuthorReplyClass`), and `reclassifiedPriors[]` (capped attribution by `threadId`). All new fields are optional so older context blocks parse cleanly ([#794](https://github.com/manki-review/manki/issues/794)).

### Fixed

- `checkAndAutoApprove` no longer posts an empty placeholder review when the `APPROVE` event fails. The previous fallback emitted a `COMMENT` review whose body was a bare `<!-- manki -->` HTML comment (rendered by the API as `body_length: 0`), which then tripped the head-SHA dedupe gate (`hasBotReviewOnCommit`) and broke the round-cap force-review tickbox loop — every subsequent tick bailed with "Review skipped — a review has already been posted for this commit". The `APPROVE` body now carries visible content (`**Manki** — Auto-approved (all findings resolved).`) so it does not register as an empty review, and the no-permission fallback path posts a plain issue comment instructing the user to enable "Allow GitHub Actions to create and approve pull requests" instead of creating a placeholder review on the head SHA ([#840](https://github.com/manki-review/manki/issues/840)).
- `checkAndAutoApprove` now bails when the latest non-`DISMISSED` `manki-review[bot]` review's `commit_id` does not match the current `pr.head.sha`, so a thread-reply `pull_request_review` event from a third party (which fires with `commit_id = head.sha` and slips past the event-level stale guard in `handleReviewStateCheck`) can no longer trigger an undeserved `APPROVED` review on a HEAD manki has never actually reviewed. The bail emits a structured `core.warning` carrying both SHAs and posts a single explanatory PR comment (idempotent per HEAD via a `manki-stale-approve:<sha>` marker) instructing the user to re-trigger with `@manki review` ([#838](https://github.com/manki-review/manki/issues/838)).
- `fetchBotReviews` now filters out empty-body `pull_request_review` wrapper objects that GitHub's REST API auto-creates when `createReplyForReviewComment` is called. These wrappers (body: `""`) are not real reviews but were indistinguishable from bot reviews to `hasBotReviewOnCommit` and `isApprovedOnCommit`, causing the dedupe gate to fire incorrectly on commits that had only received reply comments, not a full manki review ([#843](https://github.com/manki-review/manki/issues/843), [PR #844](https://github.com/manki-review/manki/pull/844)).
- The heuristic-fallback and planner-enabled `planning` progress events no longer carry an explicit `rawFindingCount: 0`. The field is optional on `ReviewProgress`, so omitting it is semantically equivalent for all consumers (which already default via `?? 0`), but emitting an explicit zero was misleading: it implied zero findings had been collected when in fact the review has not started yet ([#765](https://github.com/manki-review/manki/issues/765)).

- Removed tautological `perTeamSum` assertion in `github.test.ts` that summed a hardcoded literal array and compared it to the equally hardcoded `rawFindingCount` fixture value, testing the test author's arithmetic rather than `buildDashboard`. The individual `toContain` assertions for each per-team count and the `'**Review** — 18 findings'` header already cover the meaningful behavior ([#764](https://github.com/manki-review/manki/issues/764), [PR #835](https://github.com/manki-review/manki/pull/835)).
- `baseOpenThreads` in `src/index.ts` now uses a type-predicate filter `(f): f is PreviousFinding & { threadId: string }` instead of a truthy guard followed by a `!` non-null assertion, making the narrowing explicit and compiler-verified ([#769](https://github.com/manki-review/manki/issues/769), [PR #836](https://github.com/manki-review/manki/pull/836)).
- `checkAndAutoApprove` now posts its own in-progress marker comment before calling `pulls.createReview`, transitions it to a "Review complete" terminal body on success, and to a labeled failure body if both the `APPROVE` and `COMMENT` fallback calls throw. The marker reuses the same `BOT_MARKERS` + `manki-run-id` envelope as the full-review path so `findInProgressLock` and `checkConcurrentSubmissionLock` treat it as a live lock, closing the defense-in-depth gap where two concurrent auto-approve runs could both pass the existing `listReviews` precondition (which only sees finalized reviews, not in-flight ones) and race into a duplicate approval. The bail paths (sibling marker detected, `isReviewInProgress`, prior `APPROVED` on this SHA) all exit before the marker is posted, so an aborted invocation never leaves a stale lock behind ([#827](https://github.com/manki-review/manki/issues/827), [PR #830](https://github.com/manki-review/manki/pull/830)).
- `.manki.yml` is now sourced from the PR head's local checkout (`process.cwd()`) instead of the base ref, so a PR that adds or modifies its own config (e.g., extending `exclude_paths`) takes effect on the same PR rather than only after merge. User-supplied `exclude_paths` are also unioned with `DEFAULT_CONFIG.exclude_paths` (deduped) instead of replacing them, so adding a single pattern no longer silently drops the built-in `*.lock`, `dist/**`, `*.generated.*` skips. Closes the chicken-and-egg observed on [PR #810](https://github.com/manki-review/manki/pull/810) where the dist/-on-main migration tripped the PR-size gate because main's `.manki.yml` lacked `dist/**` and the PR's local override was never consulted ([#813](https://github.com/manki-review/manki/issues/813)).
- State-based head-SHA dedupe gate: `manki-review[bot]` now bails before any LLM call when a non-`DISMISSED` bot review already exists on the current head SHA. Closes the serialized-sibling race observed on [PR #805](https://github.com/manki-review/manki/pull/805) where one human review fanned out into a `pull_request_review` and `pull_request_review_comment` event pair, the workflow `concurrency` group serialized them, and the in-progress marker from #796 had already been cleared by the time run #2 scanned. The new `hasBotReviewOnCommit` helper in `src/github.ts` is consulted by `handlePullRequest`, `handleCommentTrigger`, `handleReviewCommentInteraction`, and `runFullReview` (defense in depth, right after `checkConcurrentSubmissionLock`). When the gate fires the run posts a `**Review skipped** for `<short-sha>` — a review has already been posted for this commit` comment so the user sees nothing was silently dropped. `@manki review` (force-review) still bypasses the gate so explicit re-review on the same SHA proceeds. `postReviewSkippedComment` takes a `SkipReason` (`'in_progress'` | `'already_reviewed'`) and always includes the short head SHA on both paths ([#806](https://github.com/manki-review/manki/issues/806)).
- The PR-size gate (`max_diff_lines`) now applies `exclude_paths` before counting, so generated artifacts the user has opted out of (`dist/**`, `*.lock`, `*.generated.*` by default) no longer trip the "PR too large for automated review" abort. Previously the raw diff was counted, which caused PRs that commit a build bundle (e.g., `dist/index.js` on `main`) to short-circuit review even when the reviewable source delta was small.
- The judge now enforces one `threadEvaluations` entry per open review thread. Missing entries trigger a single retry with a stricter reminder, any still-missing entries after retry are synthesized as `uncertain` with a `core.warning`, and the system prompt pins an explicit `You MUST return exactly N entries` constraint. When the verdict gate fires on `prior_unaddressed`, the PR comment body now lists each blocking thread inline with file, line, original severity, and a direct GitHub link instead of silently blocking. Closes [#808](https://github.com/manki-review/manki/issues/808).

### Changed

- `openai.ts` no longer defines its own `buildTimeoutDiagnostics`; it now imports the function directly from `cli-utils`, matching how `anthropic.ts` and `gemini.ts` already consume it. The local copy was structurally identical to the exported one, so this is a pure deduplication with no behaviour change ([#722](https://github.com/manki-review/manki/issues/722)).
- Extracted `AGENT_POOL`, `TRIVIAL_VERIFIER_AGENT`, and `buildAgentPool` from `src/review.ts` into a new low-level `src/agents.ts` module, breaking the layering inversion where `src/config.ts` (low layer) imported from `src/review.ts` (orchestration layer) just to validate `reviewers` names against the agent pool. `src/config.ts`, `src/index.ts`, and the test files now import these primitives directly from `./agents`, and `src/review.ts` consumes them from the same module so the agent-pool primitives have a single canonical home decoupled from review orchestration ([#676](https://github.com/manki-review/manki/issues/676), [PR #833](https://github.com/manki-review/manki/pull/833)).
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

[Unreleased]: https://github.com/manki-review/manki/compare/v5.3.0...HEAD
[5.3.0]: https://github.com/manki-review/manki/compare/v5.2.0...v5.3.0
[5.2.0]: https://github.com/manki-review/manki/compare/v5.1.1...v5.2.0
[5.1.1]: https://github.com/manki-review/manki/compare/v5.1.0...v5.1.1
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
