# Configuration

Create `.manki.yml` in your repository root. A file that is not valid YAML or has an invalid setting holds Manki's approval, as described below.

A review uses `.manki.yml` from the PR's base branch, so a PR cannot change its own review, such as by hiding files, picking weaker models or turning approval on. A PR that changes the file is reviewed with the base branch's settings, and the change applies after merge. When the PR's own file does not load, Manki logs a warning and still reviews with the base branch's settings. If the PR itself changes the file, Manki also holds its approval until the file loads, so Manki never approves a broken file. When the base branch's file cannot be read or does not load, Manki reviews with the defaults and never approves, so the PR that fixes it still gets a review.

A base branch without a `.manki.yml`, such as a release branch, uses the file on the repository's default branch instead, which a PR cannot change either. The round record then gives `default_branch` as its config source. Only a missing file falls back: a base branch file that cannot be read or does not load is never swapped for the default branch's. When the default branch's file cannot be read or does not load, Manki reviews with the defaults and never approves, as for a broken file on the base branch. With no file on either branch, the defaults apply.

Every setting is in the [reference](#reference) below the example.

## Example

```yaml
# Auto-review on PR open/update (default: true)
auto_review: true

# Auto-approve when all blocking issues are resolved (default: true)
auto_approve: true

# The lowest repository role with which a PR author may clear a blocker or a
# security finding on their own PR: admin, maintain or write (default: maintain).
# Read from the base branch only. With `write`, everyone who can push may clear
# the blockers on their own PRs.
# author_clear_role: maintain

# File filtering (defaults: the known package lockfiles that end in ".lock", such as
# "Cargo.lock" and "poetry.lock", then "dist/**" and "*.generated.*"). The list
# replaces the defaults, so repeat the ones you keep. [] excludes nothing.
exclude_paths:
  - "Cargo.lock"
  - "dist/**"
  - "vendor/**"

# Paths no review stage reads (default: none), such as a hidden test set. They
# are left out of the diff and deleted from the checkout the reviewer tools
# read, so not even a tool call finds them. A PR that changes one is never
# approved: a person must approve it.
# closed_paths:
#   - "tests/holdout/**"

# PRs that get no automatic review (default: none). Read from the base branch
# only, so a PR cannot skip itself. Labels and authors compare case-insensitively,
# branches are glob patterns on the head branch. Label and branch rules skip only
# branches in the repo itself, never a fork's.
# A skipped check passes a required status check. See "Skipping PRs" in docs/how-reviews-work.md.
# skip_labels: ["dependencies"]
# skip_authors: ["dependabot[bot]", "renovate[bot]"]
# skip_branches: ["dependabot/**"]

# Draft PRs (default: skip). `skip` reviews a draft only on request, such as
# `/manki review`, or after each push once Review every push is ticked on it.
# `review` reviews drafts automatically. Either way a draft review never
# approves and does not count toward `max_auto_rounds`.
# drafts: skip

# Review size limits, in reviewable lines after `exclude_paths`, read from the
# base branch only. A PR up to `auto_review_max_lines` (default: 8000) is
# reviewed automatically. A larger one gets a comment asking to split it, with
# the review box in its settings block, and no review: a request for changes stays, and Manki's
# earlier approvals are dismissed. A forced review covers
# the whole PR up to `max_diff_lines` (default: 15000). Above that Manki never
# reviews, even when forced. Each finder reads a diff over 1500 changed lines
# in slices of about that size, four at a time. A file and its test, and the
# files of one folder, stay in one slice where they fit.
auto_review_max_lines: 8000
max_diff_lines: 15000

# Per-stage model selection. The finders are in `review.groups`.
models:
  planner: claude-haiku-5-5      # fast pre-review planning pass
  judge: claude-opus-5-5         # precise, single judge
  second_refuter: gpt-6.1-sol    # a second refuter beside the judge's (default: off)
  dedup: claude-haiku-5-5        # fast LLM dedup against prior findings
  fallback: claude-sonnet-5-5    # reruns a stage a safety filter refused or whose model reached a limit (default: the first model of `full` other than the stage's own)

# Who reviews each class of PR (default: the built-ins). A config that sets
# `groups` defines `trivial`, `solo` and `full`. Read from the base branch,
# never from the PR. See "Review groups" in docs/how-reviews-work.md.
# review:
#   groups:
#     trivial: [claude-sonnet-5-5]                  # the quick check of a trivial change
#     solo: [claude-sonnet-5-5]                     # a low-risk change, one finder
#     full: [claude-sonnet-5-5, claude-opus-5-5]    # everything else
#     deep:                                         # a group of your own
#       - { model: claude-opus-5-5, effort: high }
#       - { model: gpt-5.5, effort: high }
#   routing:
#     security: deep
#   rules: warn    # a broken required rule of the instruction files is at least a warning. `block` makes it a blocker. `auto`, the default, grades it by its damage

# CI results the reviewers read as evidence (default: all on), and Manki's
# own analyzers. Read from the base branch, never from the PR.
# See "Reading CI results" and "Running Manki's analyzers" in docs/how-reviews-work.md.
static_analysis:
  checks: true             # check-run annotations, needs `checks: read`
  code_scanning: true      # code scanning alerts, needs `security-events: read`
  dependency_review: true  # vulnerable packages the PR adds
  wait_for_checks: []      # check runs to wait for up to 300 seconds, such as [lint, CodeQL]
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
#   - { repo: tokio-rs/tokio, kind: dependency, ref: tokio-1.38.0, paths: [tokio/src/] }

# Additional context for reviewers. Reviewers also read the root `AGENTS.md`,
# `CLAUDE.md` and `.claude/CLAUDE.md` files, the first `CONTRIBUTING.md` found in
# `.github/`, the root or `docs/`, the nearest `AGENTS.md` and `CLAUDE.md` above
# each changed file, and the `.md` files these link to. Name here what the
# finders should also check for.
instructions: |
  This is a Rust project. Focus on ownership and error handling.
  Check DIP compliance and consensus rules.

# Review memory, kept in the central memory repository for a public repo. Set
# `repo` and the `memory_repo_token` input to use a memory repository of your
# own instead. A private repo needs one, private and of the same owner.
# With memory on, a merge also records how many posted findings were fixed,
# dismissed or left untouched, in `metrics/fix-rate.jsonl` in the memory.
memory:
  enabled: true
```

[`.manki.yml.example`](../.manki.yml.example) has the same example with every default.

## Reference

<!-- config-reference:start -->
<!-- Generated by `npm run config-reference` from `scripts/config-reference.ts`. Do not edit by hand. -->

| Setting | Type | Default | What it does |
|---------|------|---------|--------------|
| `auto_review` | boolean | `true` | Review a PR automatically when it opens and on every push. With `false`, Manki reviews only on request, such as `/manki review`. |
| `auto_approve` | boolean | `true` | Approve the PR without a new review once every blocking thread is resolved by someone allowed to clear it and no warning thread holds the approval, or once a draft with a clean review is marked ready. When off, only a review round approves. |
| `author_clear_role` | `admin`, `maintain` or `write` | `maintain` | The lowest repository role with which a PR author may clear a blocker, a security finding or a warning a check lowered from a blocker on their own PR, by resolving the thread or with `/manki dismiss`. An author below it clears nothing, and someone else with write access can always clear. With `write`, everyone who can push may clear the blockers on their own PRs, so a blocker no longer holds their PR. A role outside the three, a custom role and a role GitHub does not confirm never count. It is also the lowest role with which anyone, the PR author included, lifts the hold of a warning by resolving its thread. Read from the base branch, so a PR cannot lower it for itself. See [Severity tiers](how-reviews-work.md#severity-tiers). |
| `exclude_paths` | list of globs | `["yarn.lock", "bun.lock", "Cargo.lock", "poetry.lock", "Pipfile.lock", "pdm.lock", "uv.lock", "Gemfile.lock", "composer.lock", "pubspec.lock", "mix.lock", "renv.lock", "conan.lock", "Podfile.lock", "deno.lock", "pixi.lock", "paket.lock", "shard.lock", "rebar.lock", "Berksfile.lock", "Puppetfile.lock", "MODULE.bazel.lock", "Gopkg.lock", "glide.lock", "Chart.lock", "stack.yaml.lock", "requirements.lock", "requirements-dev.lock", "nimble.lock", "spago.lock", "dist/**", "*.generated.*"]` | Files the reviewers never read. Your list replaces the defaults, so repeat a default you want to keep, and `[]` excludes nothing. Manki never approves a PR that changes such a file: a person must approve it. A `Cargo.lock`, `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` is the exception: the reviewers read it as a package list. The defaults name the known package lockfiles that end in `.lock`, so any other `.lock` file, such as `.github/workflows/actions.lock` or `flake.lock`, is read as text. Some analyzers still check them, see [Running Manki's analyzers](how-reviews-work.md#running-mankis-analyzers). |
| `closed_paths` | list of globs | none | Paths no review stage reads, such as a hidden test set. A closed file is left out of the diff, for the analyzers too, and deleted from the checkout the reviewer tools read before any stage runs, so no tool finds it. A pattern that names a folder closes every file in it, and a file renamed from a closed path counts as closed, at its new path too. A path is matched however it is written, such as `./a` or `a//b`, and one that leaves the repository, such as `../a`, counts as closed. A pattern with no slash, such as `secret.txt`, closes that name at any depth. A pattern with a slash anywhere, such as `/README.md`, `./README.md` or `bench/holdout/**`, matches from the repository root only. A leading `./` or `/` and doubled slashes change nothing else, and `dir/` closes the folder `dir` at the root. A pattern that names no path, such as an empty one, one with `..` or one with a backslash (write `/`), makes the config invalid, and on the base branch ends a review before any code is read, since Manki cannot tell what it closes. A call of Manki's own tools on a closed path is answered that the repository's config closes it, and the round record counts those calls as `usage.closedCalls`. Unlike `exclude_paths`, which only keeps a file out of the diff, a closed file cannot be read with the tools either. Manki never approves a PR that changes a closed file: a person must approve it. Read from the base branch. A base config that does not load still closes these paths. One that cannot be read on a second try, or does not parse while it names `closed_paths`, ends a review before any code is read, and a reply or a question gets the reason instead of an answer. See [Security model](security.md). |
| `skip_labels` | list of strings | none | PRs with any of these labels get no automatic review. Compared case-insensitively, and read from the base branch. See [Skipping PRs](how-reviews-work.md#skipping-prs). |
| `skip_authors` | list of strings | none | PRs by any of these authors, such as `dependabot[bot]`, get no automatic review. Compared case-insensitively, and read from the base branch. |
| `skip_branches` | list of globs | none | PRs whose head branch in the repo itself matches, such as `dependabot/**`, get no automatic review. Never matches a fork's branch. Read from the base branch. |
| `drafts` | `skip` or `review` | `skip` | `skip` reviews a draft only on request, or after each push once Review every push is ticked on it. `review` reviews it automatically. A draft review never approves and does not count toward `max_auto_rounds`. |
| `auto_review_max_lines` | positive integer | `8000` | Reviewable lines, after `exclude_paths`, above which a PR gets no automatic review, only a request to split it, with the review box in its settings block. Read from the base branch. |
| `max_diff_lines` | positive integer | `15000` | Reviewable lines above which Manki never reviews a PR, even when forced. Read from the base branch. |
| `models` | map | see below | The model of each stage. The finders are not here: `review.groups` says who reviews. A model id picks its provider: `claude-*` is Anthropic, `gpt-*` and the o-series are OpenAI, `gemini-*` is Gemini. `provider/model` names one explicitly. |
| `models.planner` | model id | `claude-haiku-5-5` | The planner, a fast pass that triages the change before the review. |
| `models.judge` | model id | `claude-opus-5-5` | The judge, which filters the findings and sets their severity, the verdict reader and the refuter. |
| `models.second_refuter` | model id | off | A second refuter on another model that checks every finding the first refuter checks, at the same time. The first runs on `models.judge`. A split keeps the judge's grade and shows both reasons. Its model also gives the second answer of the origin check, which asks whether the PR caused a blocker or warning. A blocker, a security finding, a finding that would block and any finding on a line the PR added or changed becomes pre-existing only when both models find the same failure at the base. Without it, or with both on one model, such an answer leaves the finding as it is, and a blocker only notes that it may be older than the PR. It needs repository tools, so the Claude or Codex CLI. See [Severity tiers](how-reviews-work.md#severity-tiers). |
| `models.dedup` | model id | `claude-haiku-5-5` | The dedup pass against resolved findings from earlier rounds, and the small side calls: same-defect checks, related work, the match of findings to the open issues that track them, and name translation. |
| `models.fallback` | model id | the first model of the `full` group other than the stage's own | Reruns a stage once when a provider's safety filter refuses it, or when the stage's own model reaches a limit: a rate limit, a used-up quota or subscription limit, or a model at capacity. Without it, or for a stage already on this model, the stage moves to the first model of the `full` group that is another model than its own. When `full` has no other model, the stage is not rerun. After a limit, a finder never moves to a model that already reads for the round. A call made with repository tools never moves to a model without them. |
| `judge` | map | see below | The judge stage. |
| `judge.effort` | `low`, `medium`, `high`, `xhigh`, `max` or `auto` | `auto` | The judge's effort, which the refuter follows. `auto` takes the level the planner picks for the change, low, medium or high, and high when the planner gives no answer. A fixed level replaces that pick on every round. Read from the base branch. |
| `judge.tool_steps` | integer from 0 to 100 | `0` | Read-only repository tool calls the judge may make while it grades, on a judge that runs on the Claude or Codex CLI. With them the judge reads the code a finding rests on itself, at the cost of a longer judge call. A round whose judge fallback model has no tools runs the judge without them. `0` gives it none. |
| `review` | map | the built-in groups | Review groups and how PR classes route to them. Read from the base branch, so a PR cannot weaken its own review. See [Review groups](how-reviews-work.md#review-groups). |
| `review.groups` | map of groups | `trivial`, `solo` and `full` | Each group is a list of one or more reviewers. An entry is a model id, or a map with `model`, `effort` and `focus`. A config that sets `groups` defines all three of `trivial`, `solo` and `full`, and may add groups under other names. `full` must hold at least two finders on two distinct models, whatever routes to it, or the config does not load. The readers of `trivial` run the quick check of a trivial change. The sibling comparisons, related repo checks, claim checks, pattern checks, fix checks and sweeps run on the first reviewer of the group that reads the PR. |
| `review.groups.<name>[].model` | model id | required | A model id or `provider/model`. |
| `review.groups.<name>[].effort` | `low`, `medium`, `high`, `xhigh`, `max` or `auto` | `auto`, and `medium` in `trivial` | `auto` is high when the planner answers `subtle: true`, otherwise medium. A Deeper review runs an `auto` finder at xhigh, and never below the effort the finder has without it. An entry of `trivial` without an effort runs the quick check at medium. |
| `review.groups.<name>[].focus` | string | none | A line added to this finder's prompt. The quick check takes none, so `focus` in an entry of `trivial` gets the unknown key warning. |
| `review.classes` | map of classes | the built-in classes | Classes of your own, each with a unique `rank` and a `match` on `paths_any`, `triage` or both. On `security`, `supply_chain` and `data_contract`, `match.paths_any` adds paths to the built-in rule. |
| `review.routing` | map of class to group | the built-in routes | The group per class. A built-in class left out keeps its built-in group, and a class of your own with no route goes to `full`. A config that routes a floor class to a group below the floor does not load: Manki reviews with the defaults and holds the approval. |
| `review.critical_paths` | list of globs | none | Critical areas, where any wrong result is severe even in a rare internal edge case. Globs or the path aliases. The judge grades a wrong result there as severe damage. See [Review groups](how-reviews-work.md#review-groups). |
| `review.outside_input` | string | none | What counts as outside input in your repository. The judge treats a failure this input can trigger as reachable. |
| `review.examples` | map with `blocker` and `not_blocker` lists | none | Worked examples from your repository, which the judge reads next to its built-in examples. |
| `review.sweep` | `off`, `blockers`, `warnings` or `notes` | `off` | After the judge keeps a finding, search the whole diff for other instances of its defect class, at most three findings a round. The value names the lowest grade that starts a search: `blockers`, `warnings` for blockers and proven warnings, or `notes` for those and every note that is not about style. Each place found is graded on its own, through dedup and the judge like any finding. See [Sweeping for a defect class](how-reviews-work.md#sweeping-for-a-defect-class). |
| `review.notes` | non-negative integer | `3` | How many notes a review posts at most. A note is a finding below a warning: an optional improvement, never a defect, which the review posts as a suggestion. A suggestion whose line is in the PR's diff gets an inline thread that never blocks, unless an earlier round reviewed that code. The review body lists the others in one collapsed section, and the round record keeps the ones left out. `0` posts none. A security finding is never a note. See [Severity tiers](how-reviews-work.md#severity-tiers). |
| `review.rules` | `auto`, `warn` or `block` | `auto` | How a broken required rule of your instruction files is graded, such as "every migration needs a rollback" in `CONTRIBUTING.md`. It counts when the rule is quoted from an instruction file of the base branch and the judge confirms that it states a requirement and that the PR breaks it. `auto` grades it by the damage it can do, like any other finding: a broken style rule is a note, and one that can crash or corrupt data is still a warning or a blocker. `warn` makes it at least a warning. `block` makes it a blocker, so the PR is not approved until the rule is followed. In doubt it is a warning. See [Rules from instruction files](how-reviews-work.md#rules-from-instruction-files). |
| `review.min_warning_score` | integer, 1 to 10 | `4` | The lowest importance a warning keeps its grade with. One call on the judge's model rates each warning a round posts from 1 to 10, and a warning below this cut-off is posted as a suggestion, which does not hold the approval. Blockers, security findings, tool alerts and findings a rule grades are never lowered. See [the importance of a warning](how-reviews-work.md#the-importance-of-a-warning). `1` lowers none and skips the call. |
| `review.scope_blocks` | boolean | `false` | Whether the scope reader's answer holds the approval. Every round that reads more than a trivial change asks whether the PR is useful and whether it mixes topics that belong in separate PRs. With `false` a doubt or a proposed split is only listed in the review body, under Scope. With `true` each is posted as a warning, which holds the approval until its thread is resolved like any warning. A doubt is posted only once the refuter confirms it from the code, which needs repository tools. It is never a blocker. See [The scope of a PR](how-reviews-work.md#the-scope-of-a-pr). |
| `static_analysis` | map | see below | Which CI results the reviewers read as evidence, and Manki's own analyzers. Read from the base branch. See [Reading CI results](how-reviews-work.md#reading-ci-results). |
| `static_analysis.checks` | boolean | `true` | Read check-run annotations. Needs `checks: read` in the workflow. |
| `static_analysis.code_scanning` | boolean | `true` | Read open code scanning alerts. Needs `security-events: read` in the workflow. |
| `static_analysis.dependency_review` | boolean | `true` | Read the vulnerable packages the PR adds, from the dependency review. |
| `static_analysis.wait_for_checks` | list of check run names | none | Check runs to wait for before reading the results, when CI runs in a separate workflow. Manki waits up to 300 seconds, then reads what is there. |
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
| `related_repos[].kind` | `reference`, `consumer` or `dependency` | required | `reference` for a repository this one implements, `consumer` for one that depends on it, `dependency` for one it depends on. |
| `related_repos[].ref` | branch, tag or full commit hash | the default branch | What to read. A `dependency` without one is read at the commit the lockfiles of the PR lock for it, when they lock exactly one. Write a name that looks like a short commit hash as `refs/heads/<name>` or `refs/tags/<name>`. |
| `related_repos[].paths` | list of up to 20 paths or globs | the whole repository | The only paths fetched, along with a root `AGENTS.md` and `CLAUDE.md`. |
| `instructions` | string | none | Extra context for the finders. They also read the root `AGENTS.md`, `CLAUDE.md` and `.claude/CLAUDE.md`, the first `CONTRIBUTING.md` found in `.github/`, the root or `docs/`, the nearest `AGENTS.md` and `CLAUDE.md` above each changed file, and the `.md` files these link to. |
| `project` | string | none | A short phrase naming what the project is, such as `blockchain consensus library`. The finders read it as "This PR is in a blockchain consensus library project". Without it they go by the repository description and the `AGENTS.md` and `CLAUDE.md` files. |
| `max_auto_rounds` | non-negative integer | `10` | Automatic rounds since Manki last approved. After the last one, automatic review pauses until a review is started by hand, with `/manki review` or a settings box, and the notice asks the author to reconsider the approach. Such a review also turns automatic review back on for 3 rounds, or for the rounds the cap still allows if that is more. `0` turns the cap off. See [Severity tiers](how-reviews-work.md#severity-tiers). |
| `memory` | map | see below | Review memory. See [Review memory](memory.md). |
| `memory.enabled` | boolean | `false` | Read learnings and suppressions, and write new ones. Without `memory.repo`, a public repo's memory lives in the central memory repository, which holds only public repos' memory and which the token service reads and writes for the run. A private repo needs `memory.repo`. With memory on, a merge also counts per severity and finder how many posted findings were fixed, dismissed or left untouched, in the job summary and in the memory. |
| `memory.repo` | `owner/name` | none | Your own memory repository instead of the central one, such as `<owner>/review-memory`. Needs the `memory_repo_token` input, or memory is skipped with a warning. For a private repo, it must be private and have the same owner. |
<!-- config-reference:end -->
