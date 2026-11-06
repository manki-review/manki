# Configuration

Create `.manki.yml` in your repository root. If the file is not valid YAML or has an invalid setting, the run fails, and a review run posts the error on the PR instead of reviewing with the defaults.

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
# reviewed automatically. A larger one gets a comment asking to split it with a
# Force review box, and no review: a request for changes stays, and Manki's
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
# to `<repo>/metrics/fix-rate.jsonl` in the memory repo when memory is enabled.
# Default: on when `memory.enabled` is true, off otherwise.
# metrics:
#   fix_rate: true

# Additional context for reviewers. Reviewers also read the root `AGENTS.md` and
# `CLAUDE.md` files, and the nearest ones above each changed file.
instructions: |
  This is a Rust project. Focus on ownership and error handling.

# Extra checks, added as focus lines to the finder prompt
reviewers:
  - name: "Protocol Compliance"
    focus: "DIP compliance, consensus rules"

# Review memory (uses the App's memory token, or a REVIEW_MEMORY_TOKEN secret without the App)
memory:
  enabled: true
  repo: "<owner>/review-memory"
```

See [`.manki.yml.example`](../.manki.yml.example) for the full reference with defaults.
