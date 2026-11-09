# Configuration

Create `.manki.yml` in your repository root. If the file is not valid YAML or has an invalid setting, the run fails, and a review run posts the error on the PR instead of reviewing with the defaults.

A review uses `.manki.yml` from the PR's base branch, so a PR cannot change its own review, such as by hiding files, picking weaker models or turning approval on. A PR that changes the file is reviewed with the base branch's settings, and the change applies after merge. The PR's own file must still load, so a broken file never lands. When the base branch's file cannot be read or does not load, Manki reviews with the defaults and never approves, so the PR that fixes it still gets a review.

Every setting is in the [reference](#reference) below the example.

## Example

```yaml
# Auto-review on PR open/update (default: true)
auto_review: true

# Auto-approve when all blocking issues are resolved (default: true)
auto_approve: true

# File filtering (defaults: ["*.lock", "dist/**", "*.generated.*"])
exclude_paths:
  - "*.lock"
  - "dist/**"
  - "*.generated.*"

# PRs that get no automatic review (default: none). Read from the base branch
# only, so a PR cannot skip itself. Labels and authors compare case-insensitively,
# branches are glob patterns on the head branch. Label and branch rules skip only
# branches in the repo itself, never a fork's.
# A skipped check passes a required status check. See "Skipping PRs" in docs/how-reviews-work.md.
# skip_labels: ["dependencies"]
# skip_authors: ["dependabot[bot]", "renovate[bot]"]
# skip_branches: ["dependabot/**"]

# Draft PRs (default: skip). `skip` reviews a draft only on request, such as
# `@manki review`. `review` reviews drafts automatically. Either way a draft
# review never approves and does not count toward `convergence.max_auto_rounds`.
# drafts: skip

# Review size limits, in reviewable lines after `exclude_paths`, read from the
# base branch only. A PR up to `auto_review_max_lines` (default: 8000) is
# reviewed automatically. A larger one gets a comment asking to split it, with
# Review again in its settings block, and no review: a request for changes stays, and Manki's
# earlier approvals are dismissed. A forced review covers
# the whole PR up to `max_diff_lines` (default: 15000). Above that Manki never
# reviews, even when forced. Each finder reads a diff over `slice_lines`
# (default: 1500, at least 200) in slices of that size, four at a time. A file
# and its test, and the files of one folder, stay in one slice where they fit.
auto_review_max_lines: 8000
max_diff_lines: 15000
slice_lines: 1500

# Per-stage model selection
models:
  planner: claude-haiku-5-5      # fast pre-review planning pass
  reviewer: claude-sonnet-5-5    # the finder on every round
  reviewer_pair: claude-opus-5-5 # the second finder on paired rounds (default: the other Claude tier)
  judge: claude-opus-5-5         # precise, single judge
  refuter_pair: gpt-6.1-sol      # a second refuter beside the judge's (default: off)
  dedup: claude-haiku-5-5        # fast LLM dedup against prior findings
  fallback: claude-sonnet-5-5    # reruns a stage a safety filter refused (default: reviewer)

# Planner stage (default: enabled). A fast pre-review pass triages the
# change (trivial, subtle, paired) and picks the judge effort and PR type.
planner:
  enabled: true

# Review groups per class of PR (default: the built-ins). Read from the base
# branch, never from the PR. See "Review groups" in docs/how-reviews-work.md.
# review:
#   groups:
#     deep:
#       reviewers:
#         - { model: claude-opus-5-5, effort: high }
#         - { model: gpt-5.5, effort: high }
#   routing:
#     security: deep

# CI results the reviewers read as evidence (default: all on), and Manki's
# own analyzers. Read from the base branch, never from the PR.
# See "Reading CI results" and "Running Manki's analyzers" in docs/how-reviews-work.md.
static_analysis:
  checks: true             # check-run annotations, needs `checks: read`
  code_scanning: true      # code scanning alerts, needs `security-events: read`
  dependency_review: true  # vulnerable packages the PR adds
  wait_for_checks: []      # check runs to wait for, such as [lint, CodeQL]
  wait_timeout_seconds: 300
  analyzers:               # analyzers Manki runs itself, or `all`
    ast_grep: false        # Manki's ast-grep rules
    secrets: false         # gitleaks on the added lines
    dependencies: false    # OSV-Scanner on the changed lockfiles
    semgrep: false         # or `rules: [...]`, your Semgrep rule files
    actionlint: true       # on changed workflows, unless CI runs it
    zizmor: true           # on changed workflows, unless CI runs it
    shellcheck: true       # on changed shell scripts, unless CI runs it

# Public repos the review may read as context (default: none). Read from the
# base branch, never from the PR. See "Related repositories" in docs/how-reviews-work.md.
# related_repos:
#   - { repo: dashpay/dash, kind: reference, paths: [src/] }
#   - { repo: dashpay/platform, kind: consumer, paths: ["packages/rs-*"] }

# Multi-pass verification (integer 1-5, default: 1). Runs each reviewer N
# times with shuffled file ordering; only consistent findings are kept.
# review_passes: 1

# On merge, count per severity and reviewer how many posted findings were
# fixed, dismissed or left untouched. Written to the job summary, and appended
# to `metrics/fix-rate.jsonl` in the repo's memory when memory is enabled.
# Default: on when `memory.enabled` is true, off otherwise.
# metrics:
#   fix_rate: true

# Additional context for reviewers. Reviewers also read the root `AGENTS.md`,
# `CLAUDE.md` and `CONTRIBUTING.md` files, the nearest `AGENTS.md` and `CLAUDE.md`
# above each changed file, and the `.md` files these link to.
instructions: |
  This is a Rust project. Focus on ownership and error handling.

# Extra checks, added as focus lines to the finder prompt
reviewers:
  - name: "Protocol Compliance"
    focus: "DIP compliance, consensus rules"

# Review memory, kept in the central memory repository for a public repo. Set
# `repo` and the `memory_repo_token` input to use a memory repository of your
# own instead. A private repo needs one, private and of the same owner.
memory:
  enabled: true
```

[`.manki.yml.example`](../.manki.yml.example) has the same example with every default.

## Reference

<!-- config-reference:start -->
<!-- Generated by `npm run config-reference` from `scripts/config-reference.ts`. Do not edit by hand. -->

| Setting | Type | Default | What it does |
|---------|------|---------|--------------|
| `auto_review` | boolean | `true` | Review a PR automatically when it opens and on every push. With `false`, Manki reviews only on request, such as `@manki review`. |
| `auto_approve` | boolean | `true` | Approve the PR once every blocking thread is resolved, without a new review. |
| `exclude_paths` | list of globs | `["*.lock", "dist/**", "*.generated.*"]` | Files the reviewers never read. Manki never approves a PR that changes such a file: a person must approve it. A `Cargo.lock`, `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` is the exception: the reviewers read it as a package list. Some analyzers still check them, see [Running Manki's analyzers](how-reviews-work.md#running-mankis-analyzers). |
| `skip_labels` | list of strings | none | PRs with any of these labels get no automatic review. Compared case-insensitively, and read from the base branch. See [Skipping PRs](how-reviews-work.md#skipping-prs). |
| `skip_authors` | list of strings | none | PRs by any of these authors, such as `dependabot[bot]`, get no automatic review. Compared case-insensitively, and read from the base branch. |
| `skip_branches` | list of globs | none | PRs whose head branch in the repo itself matches, such as `dependabot/**`, get no automatic review. Never matches a fork's branch. Read from the base branch. |
| `drafts` | `skip` or `review` | `skip` | `skip` reviews a draft only on request, `review` reviews it automatically. A draft review never approves and does not count toward `convergence.max_auto_rounds`. |
| `auto_review_max_lines` | positive integer | `8000` | Reviewable lines, after `exclude_paths`, above which a PR gets no automatic review, only a request to split it, with Review again in its settings block. Read from the base branch. |
| `max_diff_lines` | positive integer | `15000` | Reviewable lines above which Manki never reviews a PR, even when forced. Read from the base branch. |
| `slice_lines` | integer, at least 200 | `1500` | Changed lines a finder or the verdict reader reads in one call. A larger diff is read in slices of this size, and of at most 200,000 characters, four at a time. Read from the base branch. |
| `models` | map | see below | The model of each stage. A model id picks its provider: `claude-*` is Anthropic, `gpt-*` and the o-series are OpenAI, `gemini-*` is Gemini. `provider/model` names one explicitly. |
| `models.planner` | model id | `claude-haiku-5-5` | The planner, a fast pass that triages the change before the review. |
| `models.reviewer` | model id | `claude-sonnet-5-5` | The finder on every round, and `@reviewer` in a review group. |
| `models.reviewer_pair` | model id | the other Claude tier of `models.reviewer` | The second finder on paired rounds, and `@reviewer_pair` in a review group. |
| `models.judge` | model id | `claude-opus-5-5` | The judge, which filters the findings and sets their severity, the verdict reader and the refuter. |
| `models.refuter_pair` | model id | off | A second refuter on another model that checks every finding the first refuter checks, at the same time. The first runs on `models.judge`. A split keeps the judge's grade and shows both reasons, and no disproof lowers a blocker. It needs repository tools, so the Claude or Codex CLI. See [Severity tiers](how-reviews-work.md#severity-tiers). |
| `models.dedup` | model id | `claude-haiku-5-5` | The dedup pass against findings already posted on the PR. |
| `models.fallback` | model id | `models.reviewer` | Reruns a stage once when a provider's safety filter refuses it. A stage already on this model moves to its other Claude tier. |
| `planner` | map | see below | The planner stage. |
| `planner.enabled` | boolean | `true` | Run the planner. Without it, every round takes the side that adds review: two finders at high effort. |
| `judge` | map | see below | The judge stage. |
| `judge.tool_steps` | integer from 0 to 100 | `0` | Read-only repository tool calls the judge may make while it grades, on a judge that runs on the Claude or Codex CLI. With them the judge reads the code a finding rests on itself, at the cost of a longer judge call. A round whose judge fallback model has no tools runs the judge without them. `0` gives it none. |
| `review` | map | the built-in groups | Review groups and how PR classes route to them. Read from the base branch, so a PR cannot weaken its own review. See [Review groups](how-reviews-work.md#review-groups). |
| `review.groups` | map of groups | `trivial`, `solo` and `pair` | Each group lists its `reviewers`. A group with a built-in name replaces it. |
| `review.groups.<name>.reviewers[].model` | model id | `@reviewer` | A model id, `provider/model`, or `@reviewer` or `@reviewer_pair`, which resolve through `models`. |
| `review.groups.<name>.reviewers[].effort` | `low`, `medium`, `high`, `max` or `auto` | `auto` | `auto` is high when the planner answers `subtle: true`, otherwise medium. |
| `review.groups.<name>.reviewers[].focus` | string | none | A line added to this finder's prompt. |
| `review.groups.<name>.reviewers[].role` | `finder` or `verifier` | `finder` | `verifier` is the quick check of a trivial change. |
| `review.classes` | map of classes | the built-in classes | Classes of your own, each with a unique `rank` and a `match` on `paths_any`, `triage` or both. On `security`, `supply_chain` and `data_contract`, `match.paths_any` adds paths to the built-in rule. |
| `review.routing` | map of class to group | the built-in routes | The group per class. A class left out keeps its built-in group. |
| `review.default_group` | group name | `pair` | The group for a class with no route. |
| `review.allow_weaker` | list of class names | none | Floor classes allowed to route to a group below the floor. Without it, such a route fails the run. |
| `review.outside_input` | string | none | What counts as outside input in your repository. The judge treats a failure this input can trigger as reachable. |
| `review.examples` | map with `blocker` and `not_blocker` lists | none | Worked examples from your repository, which the judge reads next to its built-in examples. |
| `static_analysis` | map | see below | Which CI results the reviewers read as evidence, and Manki's own analyzers. Read from the base branch. See [Reading CI results](how-reviews-work.md#reading-ci-results). |
| `static_analysis.checks` | boolean | `true` | Read check-run annotations. Needs `checks: read` in the workflow. |
| `static_analysis.code_scanning` | boolean | `true` | Read open code scanning alerts. Needs `security-events: read` in the workflow. |
| `static_analysis.dependency_review` | boolean | `true` | Read the vulnerable packages the PR adds, from the dependency review. |
| `static_analysis.wait_for_checks` | list of check run names | none | Check runs to wait for before reading the results, when CI runs in a separate workflow. |
| `static_analysis.wait_timeout_seconds` | integer from 1 to 3600 | `300` | How long to wait for `wait_for_checks` before reading what is there. |
| `static_analysis.analyzers` | `all` or a map | per analyzer, below | Analyzers Manki runs itself. `all` turns on every one that needs no rules from you. See [Running Manki's analyzers](how-reviews-work.md#running-mankis-analyzers). |
| `static_analysis.analyzers.ast_grep` | boolean | `false`, but the Rust rules run in a Cargo repository | Manki's ast-grep rules on the changed JavaScript, TypeScript and Python files. `false` also stops the Rust rules. |
| `static_analysis.analyzers.secrets` | boolean | `false` | gitleaks on the lines the PR adds. |
| `static_analysis.analyzers.dependencies` | boolean | `false` | OSV-Scanner on the changed lockfiles. |
| `static_analysis.analyzers.semgrep` | `false` or `{ rules: [...] }` | `false` | Your Semgrep rule files from the repository, run with Opengrep. |
| `static_analysis.analyzers.actionlint` | boolean | `true` | actionlint on the changed workflows, unless CI runs it already. |
| `static_analysis.analyzers.zizmor` | boolean | `true` | zizmor on the changed workflows, unless CI runs it already. |
| `static_analysis.analyzers.shellcheck` | boolean | `true` | ShellCheck on the changed shell scripts, unless CI runs it already. |
| `related_repos` | list of up to 10 repos | none | Public repositories the review may read as context. Read from the base branch. See [Related repositories](how-reviews-work.md#related-repositories). |
| `related_repos[].repo` | `owner/name` | required | A public repository on github.com. |
| `related_repos[].kind` | `reference` or `consumer` | required | `reference` for a repository this one implements, `consumer` for one that depends on it. |
| `related_repos[].ref` | branch, tag or full commit hash | the default branch | What to read. Write a name that looks like a short commit hash as `refs/heads/<name>` or `refs/tags/<name>`. |
| `related_repos[].paths` | list of up to 20 paths or globs | the whole repository | The only paths fetched. |
| `review_passes` | integer from 1 to 5 | `1` | Runs each finder this many times with the files in shuffled order, and keeps only the findings the passes agree on. |
| `noise_level` | `low`, `medium` or `high` | `low` | `low` tells the finders to leave out style, formatting and anything a formatter or linter catches, except a break of a rule in the repository's own `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`, which is reported with the rule quoted. `high` asks for borderline suggestions too. |
| `instructions` | string | none | Extra context for the finders. They also read the root `AGENTS.md`, `CLAUDE.md` and `CONTRIBUTING.md`, the nearest `AGENTS.md` and `CLAUDE.md` above each changed file, and the `.md` files these link to. |
| `project` | string | none | A short phrase naming what the project is, such as `blockchain consensus library`. The finders read it as "This PR is in a blockchain consensus library project". Without it they go by the repository description and the `AGENTS.md` and `CLAUDE.md` files. |
| `reviewers` | list | none | Extra checks, each added as a focus line to the finder prompt. |
| `reviewers[].name` | string | required | The check's name. |
| `reviewers[].focus` | string | required | What the finders check for. |
| `convergence` | map | see below | How rounds end. See [Severity tiers](how-reviews-work.md#severity-tiers). |
| `convergence.max_auto_rounds` | non-negative integer | `10` | Automatic rounds since Manki last approved. After the last one, automatic review pauses until a review is started by hand, and the notice asks the author to reconsider the approach. `0` turns the cap off. |
| `convergence.rounds_after_restart` | non-negative integer | `3` | Automatic rounds that a review started by hand, with `@manki review` or a settings box, turns back on while automatic review is paused. When they pass without an approval, automatic review pauses again until the next one. `0` reviews only the round asked for. |
| `convergence.test_path_patterns` | list of globs | `["**/*.test.*", "**/*.spec.*", "**/tests/**", "**/__tests__/**"]` | Test files. From the second round, suggestions and nitpicks on them are dropped. |
| `convergence.suppress_resolved_threads` | boolean | `true` | A finding whose thread a person resolved, or Manki resolved as addressed, suppresses matching findings in later rounds. |
| `memory` | map | see below | Review memory. See [Review memory](memory.md). |
| `memory.enabled` | boolean | `false` | Read learnings and suppressions, and write new ones. Without `memory.repo`, a public repo's memory lives in the central memory repository, which holds only public repos' memory and which the token service reads and writes for the run. A private repo needs `memory.repo`. |
| `memory.repo` | `owner/name` | none | Your own memory repository instead of the central one, such as `<owner>/review-memory`. Needs the `memory_repo_token` input, or memory is skipped with a warning. For a private repo, it must be private and have the same owner. |
| `metrics` | map | none | Metrics Manki records. |
| `metrics.fix_rate` | boolean | the value of `memory.enabled` | On merge, count per severity and finder how many posted findings were fixed, dismissed or left untouched. Written to the job summary, and to the repo's memory when memory is on. |

### Deprecated settings

These still load, with a warning.

| Setting | Type | Default | What it does |
|---------|------|---------|--------------|
| `planner.paired` | `auto`, `always` or `never` | `auto` | Pins the planner's `paired` answer. Route classes with `review.routing` instead. |
| `nit_handling` | `issues` or `comments` | none | Ignored. Nitpicks are listed in the review body. |
| `review_level` | any | none | Ignored. The planner sets how many finders read each PR. |
| `review_thresholds` | any | none | Ignored. Line counts no longer size the review. |
| `stats` | any | none | Ignored. The round record is always a hidden comment in the review. |
<!-- config-reference:end -->
