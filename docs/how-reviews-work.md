# How reviews work

What Manki does on each round, how it picks its readers, how it grades findings, and what it reads besides the diff.

## Review pipeline

Manki reviews run in these stages:

1. **Planner** (pre-review) -- A fast Haiku pass answers three questions about the nature of the change, never its line count, plus the judge effort and PR type. `trivial`: could a defect hide here at all? A trivial change (docs, a rename or move, a repeated mechanical edit, dead code, fixtures) is read by a single **quick check**. The planner sees only the list of changed files, never the PR title, description or diff text, and Manki believes a `trivial` answer only when every changed file is docs, snapshots or generated, deleted, or renamed without edits. A change to tests alone is not trivial: one finder reads it. `subtle`: does judging it need reasoning about behavior? That sets the finders' effort to high, otherwise medium. `paired`: could a defect reach a user if every reader missed it? That adds a second finder. A missing or unclear answer, a timeout or a disabled planner takes the side that adds review: two finders at high effort. A diff that touches a security-sensitive path (auth, tokens, secrets, crypto, sessions, permissions and similar), CI or automation (`.github/workflows/**`, `.github/actions/**`, `action.yml`), a dependency or toolchain manifest (`package.json`, lockfiles, `Cargo.toml`, `go.mod`, `pyproject.toml`, `requirements*.txt`, `Gemfile`, `*.gemspec`, `rust-toolchain*`, `.nvmrc`, `Dockerfile*`), or a data contract (`migrations/**`, `*.sql`, `*.proto`, `schema.*`, `openapi*.yml`, `openapi*.yaml`, `openapi*.json`) is never trivial and always paired, whatever the planner or `planner.paired` say. Each round is triaged fresh. See [Review groups](#review-groups) for how the answers and paths pick the readers.
2. **Finders** -- One finder on `models.reviewer`, plus on paired rounds a second on `models.reviewer_pair`, read the diff in parallel with the same prompt: correctness first, then security, error paths, tests that cannot fail and contract breaks, plus any `reviewers:` entries. Every round, each finder searches the whole PR: it reports every blocker and security issue it finds, follows the callers of changed code and other routes to the same outcome, and for each defect checks the whole PR for the same kind, reporting one finding that lists every place. Without `models.reviewer_pair` the second finder runs on the other Claude tier (Sonnet with Opus), which needs no extra credential. Another provider is used only when you set it. If either finder fails after its retry, the round ends incomplete and never approves.
3. **Dedup**: A two-tier dedup pass filters findings already posted on the PR before judge evaluation. A static matcher handles exact/near-exact matches, then an LLM dedup pass (Haiku) catches semantic duplicates.
4. **Judge agent**: A single agent evaluates the deduplicated reviewer findings for accuracy, actionability, and severity. It filters out noise, merges any remaining overlap, and assigns a 4-tier severity to each surviving finding. It reads each finding's code and the diff of every file with a finding, a line a finding cites as proof, or an open thread, cut to 50,000 characters when those files are larger.
5. **Verdict reader**: Runs only when no finding blocks. It reads the whole diff cold on the judge's model, without the PR description or earlier rounds' findings, and looks for a reason not to merge. A large diff is read in the same slices as the finders, one call each, and the PR is `READY` only when every slice is. Each call is told which slice it reads and which changed files only the other slices hold, so code missing from its slice is no defect. The blockers of all slices are posted. From the second round it also gets the files changed since the last reviewed round, as the finders do. `READY` approves with "What this does" and "What to test" sections. `ADDRESS_FIRST` requests changes and posts its blockers as inline comments, each with what the reader checked and the lines that prove it. When the judge has repository tools, it first tries to refute each of these blockers as it does its own, and the outcome shows under "How this was checked". Output that cannot be parsed ends the round as incomplete, never as an approval.
6. **Recap** -- Surviving findings are posted as inline PR comments with a summary review.

No finder or verdict reader prompt cuts the diff. They read it in slices of at most `slice_lines` changed lines and 50,000 characters, and each call is told which slice it reads. A file over that is split between its hunks, or inside a hunk between lines. A changed line over 20,000 characters cannot be shown in full, so a round whose reviewed diff holds one ends incomplete before any model runs, and names each such file and line. Split the line, or exclude its file in `exclude_paths` on the base branch. Lines in excluded files do not count. A longer unchanged line is shortened. Each slice costs one call per reader, so the size of the reviewable diff is also capped in characters, next to `auto_review_max_lines` and `max_diff_lines`. A PR over 2,000,000 characters gets no automatic review, only the too-big notice with Force review in its settings block, and one over 4,000,000 is never reviewed, even when forced. These two limits are fixed.
When a provider's safety filter refuses a stage, Manki sends that stage once more on `models.fallback`, which defaults to `models.reviewer`. A stage already on that model goes to its other Claude tier instead. The round context records the stage, the fallback model and the refusal reason under `models.fallbacks`. A second refusal ends the round incomplete, and other errors are never retried on the fallback model. A used-up subscription limit, quota or rate limit, or an overloaded provider, is neither retried nor sent to the fallback model. The round ends incomplete and names the limit, with its reset time when the provider gives one.

An incomplete round posts a comment, fails the `Manki` check and keeps an earlier request for changes. It dismisses Manki's approval of an older commit, since no model approved the code pushed since. An approval of the same commit stays.

## Review groups

Each round sorts the PR into a **review class**, and the class picks a **review group**: the readers that run as finders. The class with the highest rank among those that match wins.

| Class | Rank | Matches | Built-in group |
|-------|------|---------|----------------|
| `security` | 100 | a security-sensitive path (`@security_paths`) | `pair` |
| `supply_chain` | 90 | CI, automation, a dependency or toolchain manifest, a file that fetches or builds code such as `.gitmodules`, `.gitattributes`, `.npmrc`, `build.rs`, `setup.py`, a `Makefile` or a `.husky` hook, or a `.manki.yml` or `manki.yml` anywhere (`@ci_dependency_paths`) | `pair` |
| `data_contract` | 80 | migrations, `*.sql`, `*.proto`, `schema.*`, OpenAPI files (`@data_contract_paths`) | `pair` |
| `behavior` | 50 | the planner answered `paired: true` | `pair` |
| `internal` | 30 | the planner answered `paired: false` | `solo` |
| `docs` | 20 | the planner answered `trivial: true` and every file is prose (Markdown, reStructuredText, AsciiDoc or a license), a snapshot or generated, deleted, or renamed without edits. Agent instructions such as `AGENTS.md`, `CLAUDE.md` or files under `.claude/`, `.cursor/` or `.github/instructions/` never count as prose here | `trivial` |

The built-in groups are `trivial` (the quick check on `models.reviewer` at medium effort), `solo` (one finder on `models.reviewer`) and `pair` (a finder on `models.reviewer` and one on `models.reviewer_pair`). Their effort is `auto`: high when the planner answers `subtle: true`, otherwise medium.

The progress comment names the class and group in its review header, such as `Review (security · pair)`. It names each reader by its model, the effort it ran at and the group's `focus` when one is set, such as `Claude Sonnet 5.5 · high` or `Claude Opus 5.5 · high · consensus rules`. The quick check shows as `Quick check · Claude Haiku 5.5`. A second reader with the same name gets ` #2`. The same names appear in failure lines, logs and the `Manki context` block.

`security`, `supply_chain` and `data_contract` are **floor classes**. Path rules decide them, so nothing in the PR's text can change them. A PR in a floor class always gets at least two finders on two distinct models, none at `low` effort. The floor is checked after routing: if the routed group misses it, the PR moves up to the floor class's own group, then to the built-in `pair` group. So a class of your own that outranks `security` cannot pull a PR that also touches auth into a weaker group.

The `review` block changes the groups and the routing:

```yaml
review:
  groups:
    deep:
      reviewers:
        - { model: claude-opus-5-5, effort: high }
        - { model: gpt-5.5, effort: high }
  routing:
    security: deep
    data_contract: deep
```

That minimal example sends security and data contract PRs to two strong readers on two providers and keeps the built-ins for the rest. A fuller one:

```yaml
review:
  default_group: pair
  groups:
    solo:
      reviewers: [{ model: "@reviewer", effort: auto }]
    pair:
      reviewers:
        - { model: "@reviewer", effort: auto }
        - { model: "@reviewer_pair", effort: auto }
    deep:
      reviewers:
        - { model: claude-opus-5-5, effort: high, focus: "authz, injection, secret handling" }
        - { model: gemini-3-pro, effort: high }
        - { model: claude-sonnet-5-5, effort: medium, focus: "error paths and rollback" }
  classes:
    security:                      # adds paths to the built-in rule, never narrows it
      match: { paths_any: ["src/billing/**"] }
    hot_path:
      rank: 85
      match: { paths_any: ["src/consensus/**", "src/net/**"] }
  routing:
    security: deep
    hot_path: deep
    internal: solo
```

- **`groups`**: each group lists its `reviewers`. A reviewer takes `model` (a model id, `provider/model`, or `@reviewer` and `@reviewer_pair`, which resolve through `models`; unset means `@reviewer`), `effort` (`low`, `medium`, `high`, `max` or `auto`, the default), an optional `focus` line added to that finder's prompt, and `role` (`finder`, the default, or `verifier` for the quick check). A group with the name of a built-in replaces it.
- **`classes`**: a new class needs a `rank` no other class has, and a `match` with `paths_any` (globs, or the `@security_paths`, `@ci_dependency_paths` and `@data_contract_paths` aliases), `triage` (`trivial`, `subtle` or `paired` set to true or false), or both. Every condition must hold. On `security`, `supply_chain` and `data_contract`, `match.paths_any` adds paths to the built-in rule. The other built-in classes cannot be changed.
- **`routing`**: the group per class. Classes you leave out keep their built-in group. When you set `groups` but no `routing`, every class goes to `default_group`, and the floors still apply.
- **`default_group`**: the group for a class with no route (default `pair`).
- **`allow_weaker`**: floor classes allowed to route to a group below the floor, such as `allow_weaker: [security]`. Without it, routing a floor class to a weaker group fails the run with the reason. Every round that runs below the floor logs a warning.
- **`critical`**: on a class of your own, marks its `match.paths_any` as a critical area, where any wrong result is severe even in a rare internal edge case. The judge sees which findings sit in a critical area and grades a wrong result there as severe damage, which blocks when the other blocker tests hold. A critical class takes paths only, no `triage`.
- **`outside_input`**: what counts as outside input in your repository, in a sentence or two. The judge treats a failure that this input can trigger as reachable, never as a rare internal case.
- **`examples`**: worked examples from your repository, one string each, under `blocker` for findings that block and `not_blocker` for findings that do not. Set either side or both. The judge reads them next to its built-in examples on the same two sides.

The last three only change how the judge grades findings. A repository with consensus code might set them like this:

```yaml
review:
  classes:
    consensus:
      rank: 70
      critical: true
      match: { paths_any: ["dash/src/consensus/**", "dash/src/blockdata/**"] }
  outside_input: >-
    Anything a network peer sends: P2P messages, blocks, transactions, headers
    and the length prefixes inside them.
  examples:
    blocker:
      - "Indexing `buf[len]` with a length read from a peer message panics on a short message."
      - "Changing the field order in a `consensus_encode` implementation changes the bytes on the wire, even when every test passes."
      - "An inverted weight comparison picks the wrong quorum member on every block."
    not_blocker:
      - "A debug log of a decoded message that leaves out the peer address: `suggestion`."
```

Each review's `Manki context` block records a `routing` object: the class, its rank and source, every matched class, the group and why it was picked, any floor and escalation, where the `review` block came from, a `configDigest` of the classes, groups and routes, and each reader's model, provider and effort. `reviewers.keptOnlyBy` counts the kept findings only one finder raised, per finder, and `keptByMany` those two or more raised.

Manki reads the `review` block, like every other setting, from the PR's base branch only, so a PR cannot weaken its own review. A PR that changes the block is reviewed with the base branch's, and the change applies after merge. A PR whose own block misses a floor fails, so a broken block never lands. When the base branch's config cannot be read, or does not load because its block is invalid or misses a floor, Manki uses the built-ins and the default settings with a warning, never the PR's copy, and does not approve. The PR that fixes it still gets reviewed. The models behind `@reviewer` and `@reviewer_pair` come from the base branch's `models` block.

`planner.paired` still works and is deprecated in favour of `routing`: `always` turns `paired` on before the PR is classified, and `never` turns it off, which routes `behavior` changes to the `internal` class and its group.

## Severity tiers

The judge assigns one of five severity levels to each finding:

| Severity | Meaning | Effect |
|----------|---------|--------|
| `required` | Must fix before merge | Blocks approval (REQUEST_CHANGES), posted as a review thread |
| `warning` | Should fix, but not blocking | Listed under "smaller fixes in this PR" in the review body, PR can still be approved |
| `suggestion` | Should fix, but not blocking | Listed in a collapsed section of the review body, PR can still be approved |
| `nit` | Minor style or preference issue | Listed in a collapsed "nitpicks" list in the review body, never as a thread, PR can still be approved |
| `ignore` | False positive or irrelevant | Dropped silently |

A finding is a blocker only when it passes five tests: the PR causes it (lines it adds, changes or removes), the failure can be named ("when X happens, Y goes wrong"), the damage is serious, the code proves it with cited lines, and the author would fix it (it is not a declared placeholder or a tracked TODO). Serious damage is wrong behaviour in normal use or from outside input, lost or corrupted data, a crash, hang or resource exhaustion from outside input, a security defect, memory unsafety or undefined behaviour, or a broken public contract with no migration. Wrong behaviour in a rare internal edge case is a warning. Degraded but correct behaviour is a warning, or a suggestion when rare. Missing tests, style, naming, docs, commit messages, performance without a crash, checks on trusted internal values and claims nobody could verify never block. Behaviour that is intended but surprising becomes a suggestion that asks about it. A later round keeps a finding's grade unless the code or the evidence changed.

When the judge has repository tools, it also tries to refute each blocker and each open lead that could block. Its answer never clears a blocker: a disproved blocker keeps its grade, whether it came in as a finding or an open lead, and is posted with the reason the refuter gave, so a maintainer can weigh it. Text in the PR could steer the refuter, so only a person can let such a blocker go. A disproof still drops a finding graded below blocker, such as an open lead or a finding capped at warning for want of proof, when it cites a line of the finding's own file or of the diff. See [security](security.md) for the tools.

Only `required` findings block, in every round. A `warning` is listed under "smaller fixes in this PR" in the review body instead of becoming a thread, so the round can approve. A blocker from the verdict reader blocks too. A security finding blocks only as a blocker: the judge grades a security defect that outside input can trigger as a blocker, and one it cannot settle stays a `warning`, which does not block.

Every round reviews the whole diff as thoroughly as the first. From the second round, the finders and the verdict reader also get the files the author changed since the last reviewed round, listed ahead of everything else, and check that new code first. A rebase onto the base branch changes no file, and when the change since the last round is unknown, the list is left out.

From the second round, each finding is tagged as new or previously missed: new when it sits within a few lines of code the PR added since the last reviewed round, previously missed when an earlier round already reviewed that code. Manki compares the PR's own change at both rounds by line text, so a rebase or moved lines do not make reviewed code new. A blocker blocks wherever it sits. A smaller finding on reviewed code gets no thread and is listed under "Previously missed" in the review body. Each finding's `origin` in the round record says which it is. Manki also does not object to a change it asked for: a smaller finding on code that applies a fix an earlier round suggested is dropped, unless the judge finds the new code worse. A finding that repeats a problem Manki already answered in a thread, with Fixed, Withdrawn, Agreed, Kept or Unverified, never gets a new thread. It is dropped when its file did not change since the last round. Otherwise the judge keeps it only when the code there got worse, and Manki then replies in that thread and reopens it if it was closed. When the finding is now a blocker, that thread blocks approval from then on, whatever its first comment's severity. Findings Manki agreed to leave for later work are listed in every later review body under a collapsed "follow-ups agreed for later" section.

The review body leads with the verdict, then the findings. On an approval, "What this does" follows in at most two sentences, and "What to test" is collapsed. Every finding opens with one line: its severity, then the category and the effort the judge set, such as **Warning** · Concurrency · Moderate. The categories are correctness, security, reliability, data integrity, concurrency, performance, compatibility, testing, maintainability, documentation and style. The effort is a quick fix, moderate or a larger change. An inline finding then shows its title, up to three sentences of what goes wrong and the fix, about 700 characters at most, and collapses the rest under "Details". A finding that cites evidence also gets a collapsed "How this was checked" section, inline or in the review body: at most five plain lines on what was read or searched, the lines that prove it, and for a blocker the outcome of the judge's attempt to refute it first. It never shows raw tool output. Up to five warnings and suggestions on changed lines get inline threads, and the rest are listed in the body. Nitpicks never get a thread. Each review's round record stores `output.bodyLength` and `output.commentLengths`, the length of the body and of each comment as Manki composed them, before GitHub accepted or refused any comment.

The PR author cannot dismiss a blocker, or a security finding of any severity. Their own "agree" reply, a reply that gets Manki to answer Fixed or Agreed, or resolving the thread leaves it blocking, and auto-approve waits for it. When the author resolves the thread, the next round reopens it once and replies to say why. It is cleared when someone else with write access resolves the thread or replies in agreement, or when the judge marks the thread addressed. A later round never drops a new blocker as a repeat of a thread that was not cleared this way.

A PR author who is a repo admin may clear such a finding on their own PR, so a repo with a single maintainer is not stuck. They resolve the thread in the GitHub UI, or comment `@manki dismiss` in the thread. Manki checks admin and write permission through the GitHub API, because comments show an org owner, and an org member with read access, as a plain member. Every such override is recorded: Manki replies once in the thread with "Finding dismissed by @<login> (repo admin).", the round context lists it under `recap.securityOverrides`, and an approval that relies on it names it in the review body. When Manki answers Fixed, Agreed or Withdrawn on a blocking or security thread that the replier may not clear, the answer says that the thread stays open and who can close it.

Each round checks the open Manki threads against the push. The push counts only for what it changed in the PR's own change, so a rebase onto the base branch changes no file. When it confirms a fix in a file the push changed, it resolves the thread with a short "Fixed in" reply and the thread stops blocking. A thread gets one Manki fix confirmation per head commit: when Manki already answered a reply there with "Fixed." on that commit, the round resolves the thread without its own line, and a reply answered after the round's line gets no second "Fixed.". A blocker that a round names again while its thread is still open stays in that thread instead of getting a new one.

When a blocker comes back after a fix was claimed for it (its thread was resolved, someone replied in it, or Manki confirmed the fix), the review keeps requesting changes, lists the blocker under "Needs a human", and pauses automatic review. A blocker named again after a rebase, with its thread still open and unanswered, just stays open. The last automatic round, round `convergence.max_auto_rounds` (default 3) counted from Manki's last approval, approves when nothing blocks, or stops the same way when a blocker is still open. Rounds after an approval, such as on rebases, start the count again. An approval held because the PR conflicts with its base counts as an approval here, and so does auto-approve after the last blocking thread is resolved. That approval also ends a pause from a blocker that came back. Only rounds that reviewed a new change count, so another round on a change Manki already reviewed, such as a Force review of the same commit, does not. While automatic review is paused, its notice lists the blocking threads still open, with links. A pause by the round cap also asks the author to step back and reconsider the approach, since rounds that keep finding problems usually mean the design needs another look. A push starts no review, but replies in threads, auto-approve after the last blocking thread is resolved, the Force review box in the settings block and `@manki review` still work.

Use the `models` config section to choose different models for the finders and the judge (e.g., a faster model for the finders and a more precise model for the judge).

The judge treats two finders reporting the same defect as strong evidence that it is real, and one finder's silence as no evidence against the other's finding. Agreement never raises a finding's severity.

`review_level` and `review_thresholds` from earlier releases still load, with a warning, and are ignored. To give the second finder its own model, set `models.reviewer_pair`, or name models in a review group.

## Skipping PRs

`skip_labels`, `skip_authors` and `skip_branches` name PRs that get no automatic review, such as dependency bumps from a bot. Manki reads them from `.manki.yml` on the base branch only, so a PR that edits them cannot skip itself. A PR that matches any rule gets no review, no comment and no approval. Its `Manki` check completes as skipped. A `@manki review` comment still reviews it.

A skipped check passes a required status check, so a branch protection rule that requires `Manki` lets a skipped PR merge without a review. Use rules that only trusted actors can meet. GitHub sets the author, so `skip_authors` for bot accounts is the safest. It skips an event only when its sender is a listed author too, so a person who pushes to a bot's PR still gets a review. A label or branch rule matches only PRs whose head branch is in the repo itself, never a fork's. A fork's author can name a branch freely and keep pushing after a label is added, for example by a path-based labeler. Anyone with write access can still pick a matching branch name or add a skip label.

## Reading CI results

Manki reads what your CI already reported on the PR head commit and gives the reviewers the results that sit on lines of the diff: check-run annotations (linters, type checkers, test reporters), open code scanning alerts, and vulnerable packages from the dependency review. The tool text reaches the reviewers fenced and marked as untrusted, and only for the lines they review. When a Manki suggestion or nitpick sits on the same file and line as a tool result, Manki drops it because the author already sees the tool's result. Warnings, blockers and security findings are always kept, because they can be a different problem on the same line. The drops are listed in the `Manki context` block.

Some tool results also go to the judge as candidate findings, next to the reviewers' findings:

- A vulnerable package, or a result whose tool or rule id names a security class (such as `security`, `injection`, `xss`, `format-string` or `secret`), always does.
- A style or formatting result never does, because the linter already shows it. Manki recognises these by rule id, such as `prettier/prettier`, `@stylistic/*`, `indent` or `max-len`. A result without a rule id is judged by its tool name, such as `rustfmt`.
- Any other code scanning alert does, and a check annotation only at the `failure` level.

The judge keeps a real defect at the grade it earns and refutes a false positive with a reason. A refuted result is never posted. A kept one is posted with the tool in its label, such as `⚠️ **Warning** (CodeQL):`.

Before the judge runs, Manki also checks each reviewer finding against the code, without running it: the file is in the diff, the line is in the file, and whether each symbol the finding names in backticks occurs in the file or the diff. Only a file outside the diff or a line past the end of the file contradicts a finding. A missing symbol is only noted, since it can live elsewhere. A claimed type or compile error is confirmed by a failing annotation near the line from a type checker or compiler, such as `tsc`, `mypy` or `rustc`. A lint error there does not confirm it. The judge sees the result as confirmed, contradicted or unchecked. Only the judge can drop a contradicted finding, and a tool that says nothing never lowers or drops a finding. Each finding in the `Manki context` block records `toolEvidence` as `confirmed`, `contradicted` or `none`.

Manki reads these results with the workflow token (`github_token`), so grant the permissions in the workflow, even when the Manki app posts the review:

| Permission | Source |
|------------|--------|
| `checks: read` | Check-run annotations |
| `security-events: read` | Code scanning alerts (needs code scanning, and GitHub Advanced Security on private repositories) |
| `contents: read` | Dependency review (needs the dependency graph, and GitHub Advanced Security on private repositories) |

A source Manki cannot read is skipped with one info line in the log. Turn a source off with `static_analysis` in `.manki.yml` (see [Configuration](configuration.md)). Manki reads that block from the base branch, so a PR cannot turn off the tool that would flag it.

Manki only sees checks that finished before it runs. Manki runs in its own workflow, so `needs:` cannot order it after your CI. List the check runs to wait for in `static_analysis.wait_for_checks` instead. Manki polls them on the PR head every 15 seconds and reads the results once each has finished. After `wait_timeout_seconds` (default 300) it stops waiting, reads what is there, and records the checks still running in the `Manki context` block. A name is the check run's name as the PR's checks list shows it, usually the job name.

```yaml
static_analysis:
  wait_for_checks: [lint, CodeQL]
  wait_timeout_seconds: 300
```

## Running Manki's analyzers

Manki can run analyzers itself. `actionlint`, `zizmor` and `shellcheck` are on by default, but each runs only when a file it checks changes, and only when CI does not run the same tool already. Manki's Rust rules for `ast_grep` are on by default in a Cargo repository (see below). The others are off by default, for a repository without CI checks. Turn them on or off in `.manki.yml` on the base branch:

```yaml
static_analysis:
  analyzers:
    ast_grep: true
    secrets: true
    dependencies: true
    semgrep:
      rules: [.semgrep/manki.yml]
    shellcheck: false
```

`analyzers: all` turns on every analyzer that needs no rules from you, including ones later releases add. Semgrep only runs when you list rule files.

| Analyzer | Tool | What it checks |
|----------|------|----------------|
| `ast_grep` | [ast-grep](https://ast-grep.github.io) 0.51.1 | Manki's own rules in [`rules/ast-grep`](../rules/ast-grep) (MIT licensed): code and shell injection, HTML sinks, disabled TLS checks and unsafe deserialization, plus error-prone patterns such as an async `forEach` callback, a comparison with `NaN` or a mutable default argument. Runs on the changed JavaScript, TypeScript and Python files. The Rust rules also run on a changed Rust file that has a `Cargo.toml` in its directory or one above it on the base branch, even without `ast_grep: true`: a narrowing `as` cast of a length, count or index, `unwrap` or `expect` on decoded input, `with_capacity` sized by a decoded length, a new `unsafe` block, and `==` on secret bytes. They report hints on added lines only, skip tests, benchmarks, examples and build scripts, and stop with `ast_grep: false`. |
| `secrets` | [gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 | Secrets on the lines the PR adds in any changed file, with gitleaks' default rules through Manki's [`rules/gitleaks.toml`](../rules/gitleaks.toml). `gitleaks:allow` comments are ignored. |
| `dependencies` | [OSV-Scanner](https://github.com/google/osv-scanner) 2.7.0 | Known vulnerabilities in the packages of the changed lockfiles, such as `package-lock.json`, `pnpm-lock.yaml`, `go.mod` or `requirements.txt`, with Manki's [`rules/osv-scanner.toml`](../rules/osv-scanner.toml). A result sits on the line that adds the package. |
| `semgrep` | [Opengrep](https://github.com/opengrep/opengrep) 1.33.1 | Your Semgrep rules on the changed files. List rule files in the repository, read from the base branch. Manki ships no Semgrep rules and never fetches registry rules such as `p/default`. `nosemgrep` comments are ignored. |
| `actionlint` | [actionlint](https://github.com/rhysd/actionlint) 1.7.12 | Mistakes in the changed workflow files under `.github/workflows`, such as invalid syntax, expression type errors or untrusted input in a `run` script. Uses `.github/actionlint.yaml` from the base branch when there is one, so self-hosted runner labels are known. Its shellcheck and pyflakes checks stay off. |
| `zizmor` | [zizmor](https://github.com/zizmorcore/zizmor) 1.32.0 | Security problems in the changed workflow files, such as template injection, dangerous triggers or excessive permissions. Runs offline, without the repository's zizmor config, and ignores `zizmor: ignore` comments. |
| `shellcheck` | [ShellCheck](https://github.com/koalaman/shellcheck) 0.11.0 | Bugs in the changed shell scripts: `.sh` and `.bash` files, and files without an extension, that start with a `sh`, `bash`, `dash` or `ksh` shebang. A `.sh` or `.bash` file without a shebang counts too. Reports down to `info`, without the repository's `.shellcheckrc`. |

The analyzers never run code from the PR. Manki reads the changed files through the API at the head commit and gives the tools the files, never a checkout. It never uses rules or config from the PR: each tool gets Manki's config or the rule files from the base branch, and the files a tool would read as its own config or ignore list, such as `.gitleaksignore` or `.semgrepignore`, are left out of what it scans. The tools run without the action's environment, so they never see a token.

Manki downloads each tool at the pinned version, checks it against its pinned digest (SHA-512 for the ast-grep packages from npm, SHA-256 for the release binaries), and caches it for the run. The ast-grep native module and its Python grammar load in process. ncc can only bundle the native module for the platform that builds `dist/`, so they load at run time. Builds are pinned for Linux and macOS (x64 and arm64) and Windows (x64). If a download fails, the platform has no pinned build or a tool fails, that analyzer is skipped with a warning and the review goes on.

`exclude_paths` keeps files away from the reviewers, and `ast_grep` and `semgrep` follow it. `dependencies` checks every lockfile the PR changes, including the ones the default `*.lock` pattern excludes, such as `yarn.lock` or `Cargo.lock`, within 10 MB per lockfile and 40 MB in all. `secrets` checks every changed file, since a PR can add its own `exclude_paths`, and for the same reason `actionlint`, `zizmor` and `shellcheck` check every changed workflow or shell script. A result on an excluded file has no inline thread, so it is listed in the review body. A PR whose every changed file is excluded or has no code to read is never approved. No code to read means a binary, a rename, a mode change, an empty file, a Git LFS pointer, whose lines only name the content by hash, or a submodule bump, whose line only names a commit. Manki posts a comment that lists each skipped file and why, with what the analyzers found on them, and the `Manki` check waits for a person. When the PR also changes files the models read, a clean round still holds its approval: Manki posts its review as a comment that lists the skipped files, the `Manki` check reports the approval held, and a person approves. Auto-approve after the last blocking thread is resolved never gives that approval either. A deleted binary, LFS file or submodule leaves nothing unread, so it holds no approval. Since `*.lock` is excluded by default, lockfile changes need a person's approval for now.

Analyzer results follow the path of the CI results above, limited to lines of the diff. `actionlint`, `zizmor` and `shellcheck` keep only results on the lines the PR adds or changes, so a problem the PR did not touch is never raised.

Manki also looks for hidden characters on the lines the PR adds in any changed file, whatever `static_analysis` or `exclude_paths` says: control characters other than tab and newline, format characters such as zero-width spaces and bidi controls, the line and paragraph separators U+2028 and U+2029, the invisible Hangul filler letters, and variation selectors other than U+FE0F, the one that follows most emoji. A file that adds any gets one `hidden-characters` alert from Manki at the first such line. A bidi embedding, override or isolate, which can make code display differently than it runs, makes the alert an error. Any other hidden character makes it a warning. A suggested fix that holds a hidden character is never offered as a `suggestion` block, and no text a model wrote can open a `suggestion` block. Manki rebuilds every code block in that text with its own fence, which nothing inside can close, keeps a plain language name at most, and escapes any other run of three backticks or tildes.

Manki skips `actionlint`, `zizmor` or `shellcheck` when CI already runs it: when a workflow on the base branch names the tool outside a comment, or a check run on the base branch's head commit has the tool's name in its name. The PR can change neither, so a job it adds cannot turn a tool off. The `Manki context` block records the skip. Since no CI shows them to the author, every result goes to the judge as a candidate finding, and a reviewer finding on the same line is never dropped for it. A result the judge keeps is posted with the tool in its label, such as `⚠️ **Warning** (gitleaks):`. A clean run posts nothing. The `Manki context` block records each enabled analyzer under `staticAnalysis.analyzers`, with how many results it found or why it was skipped.

## Related repositories

`related_repos` lists public repositories on github.com that the review may read as context. Each entry has:

- **`repo`**: the repository as `owner/name`.
- **`kind`**: `reference` for a repository this one implements or ports, such as a protocol's reference implementation or its specifications. `consumer` for a repository that depends on this one, where a change to a public API or a wire or data format can break it.
- **`ref`** (optional): the branch, tag or full commit hash to read. The default is the repository's default branch. Write a branch or tag whose name looks like a short commit hash, such as `20240115`, as `refs/heads/20240115` or `refs/tags/20240115`.
- **`paths`** (optional): up to 20 paths or globs inside the repository, such as `src/` or `packages/rs-*`. Only these are fetched. The default is the whole repository.

```yaml
related_repos:
  - { repo: dashpay/dash, kind: reference, paths: [src/] }
  - { repo: dashpay/dips, kind: reference }
  - { repo: dashpay/platform, kind: consumer, paths: ["packages/rs-*"] }
```

Reviewers with [repository tools](security.md) read these repositories through the same tools, by naming one in a `repo` argument. They read a reference to check protocol behaviour, and a consumer only when the PR changes a public API or a wire or data format, to find the consumer's code that uses it. A divergence from a reference is graded like any other finding. A change that breaks a consumer is a warning that lists the consumer's call sites, and a blocker only when the PR says it does not break anything. Reviewers without tools never read them.

Manki reads `related_repos` from the PR's base branch only, so a PR cannot make Manki fetch another repository. A PR that changes it is reviewed with the base branch's list. Nothing is fetched up front: a repository is fetched the first time a reviewer names it, once per round however many reviewers read it. The fetch is a shallow, path-limited clone of one commit (`git` with `--depth 1`, `--filter=blob:none` and a sparse checkout of `paths`), run without any credentials, so a private repository cannot be read. A repository that is private, missing, or not fetched within a minute gives a warning, and the review goes on without it.

The clones go to `manki-related-repos` in the runner's temp directory. To reuse them across runs, restore and save that directory with `actions/cache` before the Manki step. Each run saves a new entry and restores the latest one:

```yaml
      - uses: actions/cache@v4
        with:
          path: ${{ runner.temp }}/manki-related-repos
          key: manki-related-repos-${{ github.run_id }}
          restore-keys: manki-related-repos-
```

Of a restored clone Manki keeps only the object store, and only once `git fsck` finds it intact, so a tampered cache entry cannot change how git runs. The fetch then downloads nothing when the cache already holds the commit. For a new commit it downloads the commit's trees and only the files the cache does not hold yet, and Manki repacks the store so it keeps one copy of each object. A run without write access to the cache, such as one started by a comment, still restores it (see [Cache access](getting-started.md#cache-access)).

## Round records

Each review summary on the PR embeds a `Manki context` block. The block is a hidden HTML comment holding the round's diagnostics as JSON: models and effort, timings, token use, the planner's choices, every finding the finders reported (`reviewers.rawFindings`), dedup drops, and the judge's decisions with its reasoning, including the findings it dropped (`judge.dropped`). When it would not fit in the review body, Manki stores it gzip compressed and base64 encoded in the same comment instead of cutting it. `usage.llmCalls` lists every LLM call of the round: the stage and finder, model and effort, input, output, cache read, cache write and reasoning tokens, duration, attempt, whether a fallback model answered, and an estimated cost in USD at public API prices. A call whose model has no known price, or whose provider reports no token counts (the Codex and Gemini CLI paths), counts as unpriced, and subscription use is not billed per token, so the cost is an estimate of the same calls on the API. `usage` also holds the totals for the round, per stage (`perStage`) and per model (`perModel`). Each reply Manki posts in a thread or to a command carries the same usage in a hidden `<!-- manki-reply-record: ... -->` comment. To pull every record of a PR or a whole repo into one JSON Lines file, run `npm run review-history -- <owner/repo> [<pr number>] > history.jsonl` in a manki checkout. Add `--calls` to get one line per LLM call instead, ready to sum per agent, stage, model, PR or repo. The script decodes compressed records and reads the token from `GITHUB_TOKEN` or `gh auth token`.
