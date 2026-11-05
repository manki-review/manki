# Setup Guide

Complete step-by-step guide to install Manki on a GitHub repository.

## Quick Start

### 1. Install the GitHub App

Install [Manki](https://github.com/apps/manki-review) on the repositories you want reviewed.

### 2. Add Secrets

Manki supports three providers. Add credentials for the one you want to use:

```bash
# Anthropic (default)
gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>

# OpenAI
gh secret set OPENAI_API_KEY --repo <owner>/<repo>

# Gemini
gh secret set GEMINI_API_KEY --repo <owner>/<repo>
```

OAuth alternatives that ride your existing CLI subscription are also supported. See [Step 2](#step-2-authentication-secrets) for the full matrix.

### 3. Add the Workflow

Create `.github/workflows/manki.yml`. See [full workflow below](#step-3-add-the-workflow).

---

## Prerequisites

- A GitHub repository
- Credentials for at least one provider (Anthropic, OpenAI, or Gemini)
- Repository admin access (for settings changes)

## Required Repository Settings

### Enable PR Approvals and Change Requests

**Required.** Without this setting, the action cannot post APPROVE or REQUEST_CHANGES reviews. The "Failed to post APPROVE review" error in CI means this is not enabled.

1. Go to **Settings > Actions > General**
2. Scroll to **Workflow permissions**
3. Check **"Allow GitHub Actions to create and approve pull requests"**
4. Click Save

## Branch Protection (Optional)

If you use branch protection rules and want Manki to be a required check:

1. Go to **Settings > Branches > Branch protection rules**
2. Edit the rule for `main` (or your default branch)
3. Under "Require status checks to pass":
   - Add `build` (CI check)
   - Add `review` (Manki check)
4. Under "Require pull request reviews before merging":
   - Set to 1 required review
   - The action's APPROVE counts as a review

> **Note**: If the action finds blocking issues, it posts REQUEST_CHANGES which blocks the merge. Non-blocking suggestions still result in APPROVE.

## Step 1: Install the GitHub App

Install the [Manki GitHub App](https://github.com/apps/manki-review) on the repositories you want reviewed. This gives Manki its own identity: reviews appear as `manki-review[bot]` with a distinct avatar instead of the generic `github-actions[bot]`.

1. Go to [github.com/apps/manki-review](https://github.com/apps/manki-review)
2. Click **Install**
3. Select your account and choose which repositories to install on

The app requires these permissions:

| Permission | Access | Purpose |
|------------|--------|---------|
| Contents | Read | Read repository files and diffs |
| Pull requests | Read and write | Post review comments and approvals |
| Issues | Read and write | Post progress comments and app warnings; read linked issues for review context |

## Step 2: Authentication Secrets

> **Do you need a GitHub token?** No. `github_token` defaults to the workflow's own token. With the GitHub App installed (Step 1), Manki uses the App's token instead and posts as `manki-review[bot]`. Without the App, it posts with the workflow token as `github-actions[bot]`. The `memory_repo_token` input is only required when your memory repo is a **separate** repository (the App can't reach it).

### Choosing a provider

Manki supports Anthropic, OpenAI, and Gemini. You only need credentials for the provider(s) you actually use. The model ID in `.manki.yml` selects the provider automatically (`claude-*` routes to Anthropic, `gpt-*` and `o1`/`o3`/`o4`/... to OpenAI, `gemini-*` to Gemini), or use `provider/model` syntax to be explicit.

| Provider | API key input | OAuth input |
|----------|--------------|-------------|
| Anthropic | `anthropic_api_key` | `claude_code_oauth_token` (Claude Code CLI) |
| OpenAI | `openai_api_key` | `openai_oauth_token` (Codex CLI) |
| Gemini | `gemini_api_key` | `gemini_oauth_token` (Gemini CLI) |

The table lists action input names (lowercase, passed in `with:`). The corresponding GitHub secret is the uppercase version: `anthropic_api_key` reads from `secrets.ANTHROPIC_API_KEY`, and so on, as shown in the workflow examples below.

#### Effort mapping

The `low | medium | high | max` knobs map per provider as follows. Manki passes effort tiers per stage based on planner decisions and config.

| Effort | Anthropic | OpenAI reasoning models | Other OpenAI models | Gemini |
|--------|-----------|-------------------------|---------------------|--------|
| low    | adaptive, `effort: low` (4.5 models: no thinking) | `reasoning_effort: low` | (ignored, warning) | `thinkingLevel: LOW` (Gemini 3+), no thinking (2.5) |
| medium | adaptive, `effort: medium` (4.5 models: `budget_tokens: 5000`) | `reasoning_effort: medium` | (ignored, warning) | `thinkingLevel: MEDIUM` (Gemini 3+), `thinkingBudget: 5000` (2.5) |
| high   | adaptive, `effort: high` (4.5 models: `budget_tokens: 10000`) | `reasoning_effort: high` | (ignored, warning) | `thinkingLevel: HIGH` (Gemini 3+), `thinkingBudget: 10000` (2.5) |
| max    | adaptive, `effort: max` (4.5 models: `budget_tokens: 16000`) | the model's highest value (see below) | (ignored, warning) | same as `high` (collapsed) |

OpenAI reasoning models are the o-series and GPT-5 onwards. For `max`, Manki sends the highest `reasoning_effort` the model accepts: `high` for o-series, `gpt-5` and `gpt-5.1`, `xhigh` for `gpt-5.2` to `gpt-5.5`, and `max` for `gpt-5.6` onwards. GPT-4 models (`gpt-4o`, `gpt-4.1`), `-chat` snapshots and `-pro` models do not accept effort, so Manki logs a warning and sends none. Via the Codex CLI (OAuth path), the CLI then applies its own default effort. Via the API, effort has no effect. The `max` tier collapses silently to `high` for Gemini. Gemini 3 onwards takes `thinkingLevel` and rejects `thinkingBudget`, while Gemini 2.5 takes only `thinkingBudget`. The Gemini OAuth (CLI) path passes prompts through the Gemini CLI binary and does not support effort tiers. Use API key auth if you need thinking control on Gemini.

### Anthropic

#### Anthropic API Key (recommended)

1. Get your API key from [console.anthropic.com](https://console.anthropic.com)
2. Add as a repository secret:
   ```bash
   gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>
   ```

#### Claude Code OAuth Token (subscription)

Reviews run through the Claude Code CLI on your own Claude subscription instead of API billing. The action installs the CLI on the runner when it is missing.

1. Generate a long-lived token locally:
   ```bash
   claude setup-token
   ```
2. Add it as a repository secret:
   ```bash
   gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>
   ```

> **Shared secrets:** the token is tied to the subscription of the person who ran `claude setup-token`. For a secret shared across many repositories or set at the organization level, use `ANTHROPIC_API_KEY` instead, as [Anthropic's GitHub Actions docs](https://code.claude.com/docs/en/github-actions) advise.

### OpenAI

#### OpenAI API Key

1. Get your API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Add as a repository secret:
   ```bash
   gh secret set OPENAI_API_KEY --repo <owner>/<repo>
   ```

Reasoning models (o-series and GPT-5 onwards, such as `gpt-5.6-terra` or `gpt-6.1-sol`) accept the effort tiers above. GPT-4 models (`gpt-4o`, `gpt-4.1`), `-chat` snapshots and `-pro` models ignore effort and log a warning.

#### Codex CLI OAuth Token (subscription, experimental)

> **Status: experimental for CI.** The Codex CLI keeps subscription auth in `~/.codex/auth.json` and refreshes it during a run once the tokens are about 8 days old. A refresh rotates the tokens and writes them back to `auth.json` on the runner, which is discarded when the job ends. The secret still holds the old tokens, so later runs fail to authenticate until you bootstrap again and re-upload the secret. Concurrent jobs, or a local Codex that refreshes the same login, invalidate it the same way. An API key has none of these problems, and [OpenAI's CI/CD auth guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth) recommends it for most CI jobs.

If you have a ChatGPT Plus or Pro subscription and the Codex CLI installed:

1. Run `codex login` and complete the browser flow. This populates `~/.codex/auth.json`.
2. Bootstrap the secret from that file:
   ```bash
   cat ~/.codex/auth.json | base64 | gh secret set OPENAI_OAUTH_TOKEN --repo <owner>/<repo>
   ```
   The secret must be the base64-encoded contents of `~/.codex/auth.json`, which contains `tokens.access_token` and `tokens.refresh_token`. Re-run this step and re-upload the secret whenever Codex fails to authenticate in CI.
3. The workflow needs to install the Codex CLI on the runner (see [Step 3](#step-3-add-the-workflow))

> **Security note:** The base64 encoding is for transport format only — it is not encrypted. Anyone with access to repository secrets can decode the full credential, including the refresh token, which grants ongoing access to your ChatGPT Plus/Pro subscription. If this secret is ever compromised, revoke the OAuth session immediately at [platform.openai.com/account/sessions](https://platform.openai.com/account/sessions). For production use, prefer the API key path (`OPENAI_API_KEY`), which can be rotated without affecting your account session.

### Gemini

#### Gemini API Key

1. Get your API key from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Add as a repository secret:
   ```bash
   gh secret set GEMINI_API_KEY --repo <owner>/<repo>
   ```

#### Gemini CLI OAuth Token (Gemini Code Assist Standard or Enterprise only)

Runs reviews through the Gemini CLI binary, signed in with Google. Effort tiers are not honored on this path.

> **Who can still use this:** Google [ended "Login with Google" for the Gemini CLI](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals) on 2026-06-18 for Gemini Code Assist for individuals, Google AI Pro and Google AI Ultra. Personal Google accounts on those tiers can no longer sign in, so use `GEMINI_API_KEY` instead. Only organization accounts with a Gemini Code Assist Standard or Enterprise license can still sign in, and those editions are [being retired](https://docs.cloud.google.com/gemini/docs/codeassist/sunset): no new subscriptions since 2026-10-09, and renewals end on 2027-01-31 for annual and 2027-12-31 for monthly subscriptions.

1. Install the Gemini CLI: see [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
2. Sign in with Google when prompted (`gemini` opens a browser flow) using the organization account that holds the license. These accounts need a Google Cloud project, so also set `GOOGLE_CLOUD_PROJECT` in the `env:` of the Manki step.
3. Bootstrap the secret from `~/.gemini/oauth_creds.json`:
   ```bash
   cat ~/.gemini/oauth_creds.json | base64 | gh secret set GEMINI_OAUTH_TOKEN --repo <owner>/<repo>
   ```
   The secret must be the base64-encoded contents of `~/.gemini/oauth_creds.json`, which contains `access_token` and `refresh_token`. Re-run when the refresh token expires.
4. The workflow needs to install the Gemini CLI on the runner (see [Step 3](#step-3-add-the-workflow))

> **Security note:** The base64 encoding is for transport format only — it is not encrypted. Anyone with access to repository secrets can decode the full credential, including the refresh token, which grants ongoing access to your Gemini Code Assist license. If this secret is ever compromised, revoke the OAuth session immediately at [myaccount.google.com/permissions](https://myaccount.google.com/permissions). For production use, prefer the API key path (`GEMINI_API_KEY`), which can be rotated without affecting your account session.

### Review Memory Token (Optional)

Required only if you enable the review memory system. This is a fine-grained PAT scoped to the memory repo only.

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
2. Configure:
   - **Token name**: `manki-memory`
   - **Expiration**: 1 year (or your preference)
   - **Repository access**: "Only select repositories" > select your memory repo (e.g., `<owner>/review-memory`)
   - **Permissions**: Repository permissions > **Contents** > Read and write
3. Generate and copy the token
4. Add as a repository secret:
   ```bash
   gh secret set REVIEW_MEMORY_TOKEN --repo <owner>/<repo>
   ```

The token's write surface is limited to cross-PR memory files (`learnings.yml`, `suppressions.yml`, `metrics/fix-rate.jsonl`). As of v5.0.0, per-round state lives in a `Manki context` block embedded in each review summary on the PR, so the memory repo no longer receives `prs/{n}/handover.json` writes. Existing `handover.json` files in older memory repos are orphaned but harmless and require no migration.

## Step 3: Add the Workflow

Create `.github/workflows/manki.yml`:

```yaml
name: Manki

on:
  pull_request:
    types: [opened, synchronize, ready_for_review, closed]
  pull_request_review:
    types: [submitted, dismissed]
  issue_comment:
    types: [created, edited]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read          # read repo files and diffs
  pull-requests: write    # post review comments and approvals
  issues: write           # post progress comments and app warnings on PRs
  id-token: write         # OIDC token for GitHub App identity
  actions: read           # verify workflow run is legitimate
  # checks: read          # optional: read CI annotations, see "Reading CI results"
  # security-events: read # optional: read code scanning alerts

jobs:
  review:
    if: github.actor != 'manki-review[bot]'
    concurrency:
      group: manki-${{ (github.event_name == 'issue_comment' && github.event.comment.id) || format('pr-{0}', github.event.pull_request.number || github.event.issue.number) }}
      cancel-in-progress: false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '24'
          cache: 'npm'
      - name: Manki Review
        uses: manki-review/manki@v5
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          # memory_repo_token: ${{ secrets.REVIEW_MEMORY_TOKEN }}  # Only if memory repo is separate
```

#### Workflow examples per provider

Claude Code OAuth:

```yaml
      - name: Manki Review
        uses: manki-review/manki@v5
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

OpenAI API key:

```yaml
      - name: Manki Review
        uses: manki-review/manki@v5
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

OpenAI Codex CLI OAuth (requires the CLI on the runner):

```yaml
      - name: Install Codex CLI
        # --ignore-scripts is safe: @openai/codex@0.166.0 ships a plain JS bin with no postinstall steps. Re-verify if you bump the version pin.
        run: npm install -g --ignore-scripts '@openai/codex@0.166.0'
      - name: Manki Review
        uses: manki-review/manki@v5
        with:
          openai_oauth_token: ${{ secrets.OPENAI_OAUTH_TOKEN }}
```

Gemini API key:

```yaml
      - name: Manki Review
        uses: manki-review/manki@v5
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

Gemini CLI OAuth (requires the CLI on the runner and a Gemini Code Assist Standard or Enterprise license):

```yaml
      - name: Install Gemini CLI
        # --ignore-scripts is safe: @google/gemini-cli@0.66.0 has no install script of its own. Re-verify if you bump the version pin.
        run: npm install -g --ignore-scripts '@google/gemini-cli@0.66.0'
      - name: Manki Review
        uses: manki-review/manki@v5
        env:
          GOOGLE_CLOUD_PROJECT: <your-project-id>
        with:
          gemini_oauth_token: ${{ secrets.GEMINI_OAUTH_TOKEN }}
```

You can pass multiple credentials at once. The active provider for each agent is chosen by the model ID in `.manki.yml`.

Pair each workflow with a matching `models:` block in `.manki.yml`, for example:

```yaml
# OpenAI
models:
  planner: gpt-6-luna
  reviewer: gpt-6.1-terra
  judge: gpt-6.1-sol
  dedup: gpt-6-luna

# Gemini
models:
  planner: gemini-3.5-flash-lite
  reviewer: gemini-3.8-flash
  judge: gemini-3.8-flash
  dedup: gemini-3.5-flash-lite
```

### Action inputs

The workflow above uses the only inputs most setups need: a provider credential (e.g. `anthropic_api_key`, `openai_api_key`, `gemini_api_key`, or one of the OAuth equivalents) and optionally `memory_repo_token`. `github_token` defaults to the workflow token, so set it only to post with a different token. To point at a config file outside the repo root, set `config_path` (default: `.manki.yml`). For GitHub App identity, set `github_app_id`, `github_app_private_key`, and `manki_token_url`. To tune the in-app concurrent-submission lock TTL (defense in depth against simultaneous-start races on top of the workflow `concurrency` group), set `concurrency_lock_ttl_seconds` (default: 600). See [`action.yml`](action.yml) for the full input reference.

### Action outputs

The action exposes outputs you can chain into later workflow steps: `review_id`, `verdict`, `findings_count`, `findings_json`, `severity_counts`, and `judge_model`. See [`action.yml`](action.yml) for the source of truth on each output's shape and semantics.

### Pinning the action version

Both the floating major tag and the immutable exact-version tag are supported:

- `manki-review/manki@v5` — floating major. Picks up minor and patch releases automatically. Recommended for most setups.
- `manki-review/manki@v5.1.0` — immutable exact-version. Stays on the published release until you bump it. Recommended when you want lockstep upgrades.

Pin to a release tag. `main` holds source only and has no built `dist/`, so `@main` or a commit SHA from `main` will not run.

Both forms point at a tree that already contains the built `dist/`, so the runner can execute the action without any extra setup on the consumer side.

Releases prior to this fix (`v5.0.0`, `v5.0.1`) only work via the floating `@v5` tag. From the release that introduced committed `dist/` onwards, exact-version pins work as well.

### Using outputs in downstream workflow steps

```yaml
# Fail CI when the judge requests changes
- uses: manki-review/manki@v5
  id: manki
  with:
    anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
- name: Fail on blocking findings
  if: steps.manki.outputs.verdict == 'REQUEST_CHANGES'
  run: exit 1
```

```yaml
# Label PRs that have any blocker-severity findings
- name: Label blocking PRs
  if: fromJSON(steps.manki.outputs.severity_counts).blocker > 0
  run: gh pr edit ${{ github.event.number }} --add-label blocking-findings
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

You can also forward `severity_counts` or `findings_json` to a metrics sink (Slack, Datadog, a dashboard) in a follow-up step.

### Event triggers explained

| Event | Purpose |
|-------|---------|
| `pull_request: [opened, synchronize]` | Auto-review on PR open and new pushes |
| `pull_request: [ready_for_review]` | Auto-review when a draft PR is marked ready (head SHA unchanged, so the planner sees the same diff a `synchronize` would have produced) |
| `pull_request: [closed]` | On merge, records how many posted findings were fixed, dismissed or left untouched (see `metrics.fix_rate` below). Closing without merging does nothing |
| `issue_comment: [created, edited]` | `/manki` commands on PRs and issues. PR-only commands: `review`, `check`, `explain`. Available on both: `help`, `dismiss`, `remember`, `forget`, and free-form questions. |
| `pull_request_review_comment: [created]` | Replies to review comment threads |
| `pull_request_review: [submitted, dismissed]` | Auto-approve check when reviews change state |

The self-trigger guard (`github.actor != 'manki-review[bot]'`) prevents the bot from reviewing its own comments.

### Concurrency

The `concurrency` block keeps at most one Manki run active per PR across every PR-scoped event (`pull_request`, `pull_request_review`, `pull_request_review_comment`), serializing the vast majority of concurrent triggers so they do not race and submit conflicting reviews on the same commit. When a new PR-scoped event arrives while a run is in flight, GitHub queues it (at most one queued event per group, newer queued events replace older ones), the in-flight run completes, then the most recent queued event runs. `cancel-in-progress` is `false`, so no run is cancelled and the PR check list does not collect red crosses from superseded runs. The `issue_comment`-gated `comment.id` branch keeps distinct `/manki` invocations in separate groups so they do not serialize against each other, while `pull_request_review_comment` events fall through to the shared `pr-{N}` group alongside the other PR-scoped events.

GitHub Actions concurrency is best-effort, not atomic. Two events dispatched within the same scheduling window can transition to in-progress before either reaches the queue check, in which case both runs proceed concurrently. As defense in depth, the action runs an in-app lock at the review pipeline entry point: it scans its own existing comments for an "in progress" marker carrying a different `manki-run-id`, and bails (with a `core.warning`) before any LLM call when one is found within the configurable TTL. Tune the TTL with the `concurrency_lock_ttl_seconds` action input (default 600 seconds). Lowering it makes the lock recover faster from crashed runs that left a stale marker behind. Raising it tolerates longer-running reviews.

### Reading CI results

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

A source Manki cannot read is skipped with one info line in the log. Turn a source off with `static_analysis` in `.manki.yml` (see Step 4). Manki reads that block from the base branch, so a PR cannot turn off the tool that would flag it.

Manki only sees checks that finished before it runs. To make it run after your CI, put the review job in the same workflow as the CI job and make it wait with `needs:`:

```yaml
jobs:
  lint:
    if: github.event_name == 'pull_request' && github.event.action != 'closed'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: npm ci && npm run lint

  review:
    needs: lint
    # Run even when lint fails or is skipped, such as on comment events.
    if: ${{ !cancelled() && github.actor != 'manki-review[bot]' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Manki Review
        uses: manki-review/manki@v5
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Keep the `on:`, `permissions:` and `concurrency:` settings from the workflow above.

## Step 4: Configure Reviews (Optional)

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

# Maximum diff size before skipping (default: 50000 lines)
max_diff_lines: 50000

# Per-stage model selection
models:
  planner: claude-haiku-5-5      # fast pre-review planning pass
  reviewer: claude-sonnet-5-5    # the finder on every round
  reviewer_pair: claude-opus-5-5 # the second finder on paired rounds (default: the other Claude tier)
  judge: claude-opus-5-5         # precise, single judge
  dedup: claude-haiku-5-5        # fast LLM dedup against prior findings

# Planner stage (default: enabled). A fast pre-review pass triages the
# change (trivial, subtle, paired) and picks the judge effort and PR type.
# `paired` pins whether a second finder runs: auto (default), always or never.
planner:
  enabled: true
  paired: auto

# CI results the reviewers read as evidence (default: all on). Read from the
# base branch, never from the PR. See "Reading CI results" above.
static_analysis:
  checks: true             # check-run annotations, needs `checks: read`
  code_scanning: true      # code scanning alerts, needs `security-events: read`
  dependency_review: true  # vulnerable packages the PR adds

# Multi-pass verification (integer 1-5, default: 1). Runs each reviewer N
# times with shuffled file ordering; only consistent findings are kept.
# review_passes: 1

# Keep the structured `Manki context` block in an HTML comment
# (`<!-- manki-context: ... -->`). Set to false to show it as a `<details>` block (default: true).
# stats:
#   hidden: true

# On merge, count per severity and reviewer how many posted findings were
# fixed, dismissed or left untouched. Written to the job summary, and appended
# to `<repo>/metrics/fix-rate.jsonl` in the memory repo when memory is enabled.
# Default: on when `memory.enabled` is true, off otherwise.
# metrics:
#   fix_rate: true

# Additional context for reviewers
instructions: |
  This is a Rust project. Focus on ownership and error handling.

# Extra checks, added as focus lines to the finder prompt
reviewers:
  - name: "Protocol Compliance"
    focus: "DIP compliance, consensus rules"

# Review memory (requires REVIEW_MEMORY_TOKEN secret)
memory:
  enabled: true
  repo: "<owner>/review-memory"
```

See [`.manki.yml.example`](.manki.yml.example) for the full reference with defaults.

### Review pipeline

Manki reviews run in these stages:

1. **Planner** (pre-review) -- A fast Haiku pass answers three questions about the nature of the change, never its line count, plus the judge effort and PR type. `trivial`: could a defect hide here at all? A trivial change (docs, a rename or move, a repeated mechanical edit, dead code, fixtures) is read by a single **Trivial Change Verifier**. The planner sees only the list of changed files, never the PR title, description or diff text, and Manki believes a `trivial` answer only when every changed file is docs, snapshots or generated, deleted, or renamed without edits. A change to tests alone is not trivial: one finder reads it. `subtle`: does judging it need reasoning about behavior? That sets the finders' effort to high, otherwise medium. `paired`: could a defect reach a user if every reader missed it? That adds a second finder. A missing or unclear answer, a timeout or a disabled planner takes the side that adds review: two finders at high effort. A diff that touches a security-sensitive path (auth, tokens, secrets, crypto, sessions, permissions and similar), CI or automation (`.github/workflows/**`, `.github/actions/**`, `action.yml`), a dependency or toolchain manifest (`package.json`, lockfiles, `Cargo.toml`, `go.mod`, `pyproject.toml`, `requirements*.txt`, `Gemfile`, `*.gemspec`, `rust-toolchain*`, `.nvmrc`, `Dockerfile*`), or a data contract (`migrations/**`, `*.sql`, `*.proto`, `schema.*`, `openapi*.yml`, `openapi*.yaml`, `openapi*.json`) is never trivial and always paired, whatever the planner or `planner.paired` say. Each round is triaged fresh.
2. **Finders** -- One finder on `models.reviewer`, plus on paired rounds a second on `models.reviewer_pair`, read the diff in parallel with the same prompt: correctness first, then security, error paths, tests that cannot fail and contract breaks, plus any `reviewers:` entries. Without `models.reviewer_pair` the second finder runs on the other Claude tier (Sonnet with Opus), which needs no extra credential. Another provider is used only when you set it. If either finder fails after its retry, the round ends incomplete and never approves.
3. **Dedup**: A two-tier dedup pass filters findings already posted on the PR before judge evaluation. A static matcher handles exact/near-exact matches, then an LLM dedup pass (Haiku) catches semantic duplicates.
4. **Judge agent**: A single agent evaluates the deduplicated reviewer findings for accuracy, actionability, and severity. It filters out noise, merges any remaining overlap, and assigns a 4-tier severity to each surviving finding.
5. **Verdict reader**: Runs only when no finding blocks. One call on the judge's model reads the whole diff cold, without the PR description or earlier rounds, and looks for a reason not to merge. `READY` approves with "What this does" and "What to test" sections. `ADDRESS_FIRST` requests changes and posts its blockers as inline comments. Output that cannot be parsed ends the round as incomplete, never as an approval.
6. **Recap** -- Surviving findings are posted as inline PR comments with a summary review.

### Severity tiers

The judge assigns one of five severity levels to each finding:

| Severity | Meaning | Effect |
|----------|---------|--------|
| `required` | Must fix before merge | Blocks approval (REQUEST_CHANGES), posted as a review thread |
| `warning` | Should fix before merge | Blocks approval (REQUEST_CHANGES), posted as a review thread |
| `suggestion` | Should fix, but not blocking | Listed in a collapsed section of the review body, PR can still be approved |
| `nit` | Minor style or preference issue | Listed in a collapsed section of the review body, PR can still be approved |
| `ignore` | False positive or irrelevant | Dropped silently |

Rounds 1 and 2 block on `required` and `warning` findings. From round 3 only `required` findings block. A `warning` raised then is listed under "smaller fixes in this PR" in the review body instead of becoming a thread, so the round can approve. A blocker from the verdict reader blocks at every round, and so does a security finding: one the judge tags `security` and keeps at `warning` or above, whichever finder raised it.

The PR author cannot dismiss a security finding. Their own "agree" reply or resolving the thread leaves it blocking, and auto-approve waits for it. When the author resolves the thread, the next round reopens it once and replies to say why. It is cleared when someone else with write access resolves the thread or replies in agreement, or when the judge marks the thread addressed.

When a blocker comes back after the author pushed a fix for it, the review keeps requesting changes, lists the blocker under "Needs a human", and pauses automatic review. The last automatic round, round `convergence.max_auto_rounds` (default 5), blocks on blockers only: it approves with the remaining warnings as smaller fixes, or stops the same way when a blocker is still open. After a pause, commenting `@manki review` runs one more round that blocks on blockers only.

Use the `models` config section to choose different models for the finders and the judge (e.g., a faster model for the finders and a more precise model for the judge).

The judge treats two finders reporting the same defect as strong evidence that it is real, and one finder's silence as no evidence against the other's finding. Agreement never raises a finding's severity.

`review_level`, `review_thresholds` and `models.agents` from earlier releases still load, with a warning. The first two are ignored. The first model in `models.agents` that differs from `models.reviewer` becomes `models.reviewer_pair` when that is not set.

## Step 5: Set Up Review Memory (Optional)

The memory system makes reviews smarter over time by tracking learnings and suppressions.

### Create the Memory Repository

```bash
gh repo create <owner>/review-memory --public --description "Review memory for Manki"
```

### Seed Initial Structure

```bash
git clone https://github.com/<owner>/review-memory
cd review-memory

mkdir -p _global
mkdir -p <repo-name>

# Global conventions (applied to all repos)
cat > _global/conventions.md << 'EOF'
# Global Review Conventions

- Prefer explicit error handling over silent failures
- Flag any hardcoded credentials or API keys
- Security findings should always be blocking
EOF

# Empty files for repo-specific memory
echo "[]" > <repo-name>/suppressions.yml
echo "[]" > <repo-name>/learnings.yml

git add -A
git commit -m "chore: seed review memory"
git push
```

### Enable in Config

Add to your `.manki.yml`:

```yaml
memory:
  enabled: true
  repo: "<owner>/review-memory"
```

Make sure the `REVIEW_MEMORY_TOKEN` secret is set (see Step 2).

### How memory works

- **Learnings** -- Stored when you use `/manki remember` or when substantive review comment discussions are detected. Injected as context into future reviewer prompts.
- **Suppressions** -- Created by `/manki dismiss`. Non-blocking findings matching a suppression pattern are filtered out (blocking findings are never suppressed).
- **Patterns** -- Automatically tracked from recurring findings. After 5 occurrences a pattern is escalated for visibility.
- **Global conventions** -- A `_global/conventions.md` file applied to all repos using the memory system.
- **Fix rate** -- On each merge, one JSON line per PR is appended to `<repo-name>/metrics/fix-rate.jsonl` with the posted, fixed, dismissed and untouched findings per severity and first reviewer (the `specialist` field). A finding counts as fixed when the judge marked its thread addressed or the code at its lines changed before the merge. Turn it off with `metrics.fix_rate: false`.

## Verification

After setup, create a test PR to verify everything works:

1. Create a branch with a small change
2. Open a PR
3. The Manki workflow should trigger automatically
4. Check the Actions tab for the review run
5. The PR should receive inline review comments and an APPROVE/REQUEST_CHANGES review

You can also trigger a review manually by commenting `/manki review` on any PR.

## Security

Manki handles untrusted PR content and cross-repo tokens. The security model rests on these guarantees:

- **Prompt injection** — PR diffs are untrusted content passed into LLM prompts. All findings are sanitized before posting to GitHub so that embedded HTML, scripts, and `@mention` strings cannot be used to inject content or trigger notifications.
- **Token handling** — All secrets are masked in workflow logs via `core.setSecret()`. The memory repo uses a separate `memory_repo_token` so that the review token never has write access to code repositories.
- **Memory access control** — Only repository owners, members, and collaborators can use `/manki remember`, `/manki forget`, and `/manki dismiss`. Commands from outside contributors are ignored so memory cannot be poisoned by drive-by PRs.
- **Judge trust model** — The judge agent has final say on severity and can downgrade `required` to `ignore`. This is intentional: a single precise judge produces fewer false positives than trusting individual reviewers.
- **OIDC authentication** — When using the GitHub App identity, token service requests are authenticated via GitHub Actions OIDC tokens. The request is cryptographically proven to come from a legitimate workflow run, so no shared secret is exchanged between your workflow and the token service.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "spawn claude ENOENT" | Add the "Install Claude Code CLI" step before the action |
| "Failed to post APPROVE review" | Enable "Allow GitHub Actions to create and approve pull requests" in repo settings |
| Review says "No reviewable files" | Check `exclude_paths` in config -- dotfiles are included by default |
| Memory not loading | Verify `REVIEW_MEMORY_TOKEN` secret is set and the PAT has Contents read/write on the memory repo |
| Review doesn't trigger on `/manki review` | The workflow file must exist on the default branch (main) |
| "Diff too large" | Increase `max_diff_lines` in config or split the PR |
| Auto-approve not working | Check that `auto_approve: true` is set in `.manki.yml` and the `pull_request_review` event trigger is in the workflow |
| Inline comments land on wrong lines | The judge agent validated line numbers but the diff may have shifted. A blocking finding that is not on a changed line is posted as a comment on its file instead |

## Known Limitations

### `/manki review` runs action code from main branch

GitHub Actions runs `issue_comment` triggered workflows from the **default branch** (main), not the PR branch. This means:

- `/manki review` always uses the action code from main -- not from the PR branch
- If you're developing the action itself and want to test changes, use a direct push to trigger the `pull_request` event instead
- **The review content is still correct** -- the PR diff is fetched via API regardless of which branch the workflow runs on

This is a GitHub platform limitation that affects all Actions-based bots. Tools like CodeRabbit avoid this by using a webhook server instead of GitHub Actions.

### Reviews may post duplicate comments across runs

Each review run posts fresh inline comments. The recap phase deduplicates against previous findings, but if the judge agent fails or produces different titles, duplicates can occur. This is tracked in issue backlog.

## Quick Reference: All Secrets

Provide credentials for the providers you actually use. The model ID in `.manki.yml` picks the provider per stage (`claude-*` → Anthropic, `gpt-*` and `o1`/`o3`/`o4`/... → OpenAI, `gemini-*` → Gemini), or use `provider/model` syntax to be explicit. The action fails fast with a clear error if a configured provider's credentials are missing.

### Provider credentials

| Provider | API key | OAuth alternative |
|----------|---------|-------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_OAUTH_TOKEN` (base64 of `~/.codex/auth.json`) |
| Gemini | `GEMINI_API_KEY` | `GEMINI_OAUTH_TOKEN` (base64 of `~/.gemini/oauth_creds.json`) |

When both are set for a provider, OAuth takes precedence (the action checks the OAuth input before the API key for each provider).

### Other

| Secret | Purpose |
|--------|---------|
| `REVIEW_MEMORY_TOKEN` | Fine-grained PAT for memory repo writes (only when the memory repo is a separate repository — see [Review memory](#review-memory)) |
