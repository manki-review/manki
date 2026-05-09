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

Create `.github/workflows/manki.yml` -- see [full workflow below](#step-3-add-the-workflow).

---

## Prerequisites

- A GitHub repository
- Credentials for at least one provider (Anthropic, OpenAI, or Gemini)
- Repository admin access (for settings changes)

### Enable GitHub Actions PR Approval

**Required** -- without this, the action cannot approve PRs.

1. Go to **Settings > Actions > General**
2. Scroll to **Workflow permissions**
3. Check **"Allow GitHub Actions to create and approve pull requests"**
4. Click Save

### Branch Protection (Optional)

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

Install the [Manki GitHub App](https://github.com/apps/manki-review) on the repositories you want reviewed. This gives Manki its own identity -- reviews appear as `manki-review[bot]` with a distinct avatar instead of the generic `github-actions[bot]`.

1. Go to [github.com/apps/manki-review](https://github.com/apps/manki-review)
2. Click **Install**
3. Select your account and choose which repositories to install on

The app requires these permissions:

| Permission | Access | Purpose |
|------------|--------|---------|
| Contents | Read | Read repository files and diffs |
| Pull requests | Read and write | Post review comments and approvals |
| Issues | Read and write | Create nit issues and triage |

## Step 2: Authentication Secrets

> **When do you need a GitHub token?** If you installed the GitHub App (Step 1), you do **not** need to pass `github_token` -- the App handles PR access. The `memory_repo_token` input is only required when your memory repo is a **separate** repository (the App can't reach it). Users who skip the GitHub App can fall back to `github_token: ${{ secrets.GITHUB_TOKEN }}`.

### Choosing a provider

Manki supports Anthropic, OpenAI, and Gemini. You only need credentials for the provider(s) you actually use. The model ID in `.manki.yml` selects the provider automatically (`claude-*` routes to Anthropic, `gpt-*` and `o*` to OpenAI, `gemini-*` to Gemini), or use `provider/model` syntax to be explicit.

| Provider | API key input | OAuth input |
|----------|--------------|-------------|
| Anthropic | `anthropic_api_key` | `claude_code_oauth_token` (deprecated, see note) |
| OpenAI | `openai_api_key` | `openai_oauth_token` (Codex CLI) |
| Gemini | `gemini_api_key` | `gemini_oauth_token` (Gemini CLI) |

> **`claude_code_oauth_token` is deprecated.** Anthropic restricted Claude Code OAuth tokens for third-party tools on April 4, 2026. The input still works and the action emits a one-line `core.warning` per run. New setups should use `anthropic_api_key`. If you want a subscription-based path with no extra API charges, switch to `openai_oauth_token` (Codex CLI) or `gemini_oauth_token` (Gemini CLI).

#### Effort mapping

The `low | medium | high | max` knobs map per provider as follows. Manki passes effort tiers per stage and per agent based on planner decisions and config.

| Effort | Anthropic | OpenAI o-series | OpenAI GPT | Gemini |
|--------|-----------|-----------------|------------|--------|
| low    | no thinking | `reasoning_effort: low` | (ignored, warning) | no thinking |
| medium | `budget_tokens: 5000` | `reasoning_effort: medium` | (ignored, warning) | `thinkingBudget: 5000` |
| high   | `budget_tokens: 10000` | `reasoning_effort: high` | (ignored, warning) | `thinkingBudget: 10000` |
| max    | `budget_tokens: 16000` | `reasoning_effort: high` (collapsed) | (ignored, warning) | `thinkingBudget: 10000` (collapsed) |

The Gemini OAuth (CLI) path passes prompts through the Gemini CLI binary and does not support effort tiers. Use API key auth if you need thinking budgets on Gemini.

### Anthropic

#### Anthropic API Key (recommended)

1. Get your API key from [console.anthropic.com](https://console.anthropic.com)
2. Add as a repository secret:
   ```bash
   gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>
   ```

#### Claude Code OAuth Token (deprecated)

Older setups used `claude_code_oauth_token` to ride a Claude Max subscription. Anthropic restricted this token type for third-party tools on April 4, 2026. Existing tokens still work, the action prints a deprecation warning. New installations should use `ANTHROPIC_API_KEY` or one of the other providers below.

For reference, the original setup was:

```bash
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>
```

### OpenAI

#### OpenAI API Key

1. Get your API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Add as a repository secret:
   ```bash
   gh secret set OPENAI_API_KEY --repo <owner>/<repo>
   ```

Reasoning models (`o1`, `o3`, `o4`, ...) accept the effort tiers above. Non-reasoning chat models (`gpt-4o`, `gpt-4.1`, ...) ignore effort and log a warning.

#### Codex CLI OAuth Token (subscription, experimental)

> **Status: experimental for CI.** The Codex CLI stores subscription auth in `~/.codex/auth.json` as short-lived tokens (`access_token` ~1h) refreshed automatically when the CLI runs. For CI workflows, use the API-key path above unless you can keep the secret refreshed externally.

If you have a ChatGPT Plus or Pro subscription and the Codex CLI installed:

1. Run `codex login` and complete the browser flow. This populates `~/.codex/auth.json`.
2. Bootstrap the secret from that file:
   ```bash
   cat ~/.codex/auth.json | base64 | gh secret set OPENAI_OAUTH_TOKEN --repo <owner>/<repo>
   ```
   The secret must be the base64-encoded contents of `~/.codex/auth.json`, which contains `tokens.access_token` and `tokens.refresh_token`. Re-run when the refresh token expires.
3. The workflow needs to install the Codex CLI on the runner (see [Step 3](#step-3-add-the-workflow))

### Gemini

#### Gemini API Key

1. Get your API key from [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
2. Add as a repository secret:
   ```bash
   gh secret set GEMINI_API_KEY --repo <owner>/<repo>
   ```

#### Gemini CLI OAuth Token (subscription)

Rides a Google AI subscription via the Gemini CLI binary. Effort tiers are not honored on this path.

1. Install the Gemini CLI: see [github.com/google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
2. Sign in with Google when prompted (`gemini` opens a browser flow)
3. Bootstrap the secret from `~/.gemini/oauth_creds.json`:
   ```bash
   cat ~/.gemini/oauth_creds.json | base64 | gh secret set GEMINI_OAUTH_TOKEN --repo <owner>/<repo>
   ```
   The secret must be the base64-encoded contents of `~/.gemini/oauth_creds.json`, which contains `access_token` and `refresh_token`. Re-run when the refresh token expires.
4. The workflow needs to install the Gemini CLI on the runner (see [Step 3](#step-3-add-the-workflow))

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

## Step 3: Add the Workflow

Create `.github/workflows/manki.yml`:

```yaml
name: Manki

on:
  pull_request:
    types: [opened, synchronize]
  pull_request_review:
    types: [submitted, dismissed]
  issue_comment:
    types: [created, edited]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read          # read repo files and diffs
  pull-requests: write    # post review comments and approvals
  issues: write           # create nit issues when configured
  id-token: write         # OIDC token for GitHub App identity
  actions: read           # verify workflow run is legitimate

jobs:
  review:
    if: github.actor != 'manki-review[bot]'
    concurrency:
      group: manki-${{ github.event_name }}-${{ github.event.comment.id || github.event.pull_request.number || github.event.issue.number || github.run_id }}
      cancel-in-progress: true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: 'npm'
      - name: Manki Review
        uses: manki-review/manki@v5
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          # github_token: ${{ secrets.GITHUB_TOKEN }}  # Only if not using the GitHub App
          # memory_repo_token: ${{ secrets.REVIEW_MEMORY_TOKEN }}  # Only if memory repo is separate
```

#### Workflow examples per provider

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
        run: npm install -g @openai/codex
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

Gemini CLI OAuth (requires the CLI on the runner):

```yaml
      - name: Install Gemini CLI
        run: npm install -g @google/gemini-cli
      - name: Manki Review
        uses: manki-review/manki@v5
        with:
          gemini_oauth_token: ${{ secrets.GEMINI_OAUTH_TOKEN }}
```

You can pass multiple credentials at once. The active provider for each agent is chosen by the model ID in `.manki.yml`.

Pair each workflow with a matching `models:` block in `.manki.yml`, for example:

```yaml
# OpenAI
models:
  planner: gpt-4o-mini
  reviewer: gpt-4o-mini
  judge: o4-mini
  dedup: gpt-4o-mini

# Gemini
models:
  planner: gemini-2.5-flash
  reviewer: gemini-2.5-flash
  judge: gemini-2.5-pro
  dedup: gemini-2.5-flash
```

### Action inputs

The workflow above uses the only inputs most setups need: a provider credential (e.g. `anthropic_api_key`, `openai_api_key`, `gemini_api_key`, or one of the OAuth equivalents), `github_token` (only if you skipped the GitHub App), and optionally `memory_repo_token`. To point at a config file outside the repo root, set `config_path` (default: `.manki.yml`). For GitHub App identity, set `github_app_id`, `github_app_private_key`, and `manki_token_url`. See [`action.yml`](action.yml) for the full input reference.

### Action outputs

The action exposes outputs you can chain into later workflow steps: `review_id`, `verdict`, `findings_count`, `findings_json`, `severity_counts`, and `judge_model`. See [`action.yml`](action.yml) for the source of truth on each output's shape and semantics.

### Using outputs in downstream workflow steps

```yaml
# Fail CI when the judge requests changes
- uses: manki-review/manki@v4
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
| `issue_comment: [created, edited]` | `/manki` commands on PRs and issues (review, explain, triage, etc.) |
| `pull_request_review_comment: [created]` | Replies to review comment threads |
| `pull_request_review: [submitted, dismissed]` | Auto-approve check when reviews change state |

The `if` condition allows `issue_comment` events without the `pull_request` filter so that `/manki triage` works on nit issues (which are regular issues, not PRs). The self-trigger guard (`github.actor != 'manki-review[bot]'`) prevents the bot from reviewing its own comments.

### Concurrency

The `concurrency` block ensures only one Manki run is active per PR at a time. If a new push arrives while a review is running, the in-progress run is cancelled. The `comment.id` in the concurrency group allows parallel runs for different comment-triggered commands on the same PR.

## Step 4: Configure Reviews (Optional)

Create `.manki.yml` in your repository root:

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

# Team sizing: auto (default), small (3 agents), medium (5), large (7)
review_level: auto
review_thresholds:
  small: 200   # diffs under this many lines get a small team
  medium: 1000  # diffs under this many lines get a medium team

# Per-stage model selection
models:
  planner: claude-haiku-4-5      # fast pre-review planning pass
  reviewer: claude-sonnet-4-6    # fast, parallel reviewers
  judge: claude-opus-4-6         # precise, single judge
  dedup: claude-haiku-4-5        # fast LLM dedup against prior findings

# Planner stage (default: enabled). When review_level is "auto", a fast
# pre-review pass chooses team size (1/3/5/7), reviewer/judge effort, and
# PR type. teamSize=1 routes trivial changes to a Trivial Change Verifier.
planner:
  enabled: true

# Where to post nit findings: 'issues' (separate GitHub issue) or 'comments' (inline PR comments)
nit_handling: issues

# Multi-pass verification (integer 1-5, default: 1). Runs each reviewer N
# times with shuffled file ordering; only consistent findings are kept.
# review_passes: 1

# Additional context for reviewers
instructions: |
  This is a Rust project. Focus on ownership and error handling.

# Custom reviewer agents (added to the built-in pool)
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

1. **Planner** (pre-review, `review_level: auto` only) -- A fast Haiku pass analyzes the diff and picks team size (1/3/5/7), reviewer/judge effort, and PR type. teamSize=1 routes trivial changes (docs, renames, comment-only edits) to a single **Trivial Change Verifier** agent. Falls back to the heuristic team selector if the planner fails or is disabled.
2. **Reviewer agents** -- The chosen team of specialist agents (security, architecture, correctness, etc.) review the diff in parallel. Each produces raw findings.
3. **Dedup**: A two-tier dedup pass filters findings already posted on the PR before judge evaluation. A static matcher handles exact/near-exact matches, then an LLM dedup pass (Haiku) catches semantic duplicates.
4. **Judge agent**: A single agent evaluates the deduplicated reviewer findings for accuracy, actionability, and severity. It filters out noise, merges any remaining overlap, and assigns a 4-tier severity to each surviving finding.
5. **Recap** -- Surviving findings are posted as inline PR comments with a summary review.

### Severity tiers

The judge assigns one of four severity levels to each finding:

| Severity | Meaning | Effect |
|----------|---------|--------|
| `required` | Must fix before merge | Blocks approval (REQUEST_CHANGES) |
| `suggestion` | Should fix, but not blocking | Posted as inline comment, PR can still be approved |
| `nit` | Minor style or preference issue | Collected into a nit issue (or inline comments, depending on `nit_handling`) |
| `ignore` | False positive or irrelevant | Dropped silently |

Use the `models` config section to choose different Claude models for the reviewer and judge stages (e.g., a faster model for reviewers and a more precise model for the judge).

## Step 5: Set Up Review Memory (Optional)

The memory system makes reviews smarter over time by tracking learnings, suppressions, and recurring patterns.

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
echo "[]" > <repo-name>/patterns.yml
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
- **Suppressions** -- Created by `/manki dismiss` or by leaving nit issue checkboxes unchecked during triage. Non-blocking findings matching a suppression pattern are filtered out (blocking findings are never suppressed).
- **Patterns** -- Automatically tracked from recurring findings. After 5 occurrences a pattern is escalated for visibility.
- **Global conventions** -- A `_global/conventions.md` file applied to all repos using the memory system.

## Step 6: Nit Issue Triage Workflow

When Manki approves a PR with non-blocking suggestions, she creates a GitHub issue with:

- A checkbox per finding (with code snippets and AI fix prompts)
- The `needs-human` label

To triage:

1. Open the nit issue
2. Check the boxes for findings worth fixing, leave the rest unchecked
3. Comment `/manki triage`

Manki will:

- Create a new GitHub issue for each checked finding
- Store unchecked findings as suppressions in memory
- Remove the `needs-human` label and close the nit issue

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
| `/manki triage` does nothing | Make sure the `if` condition allows plain `issue_comment` events (not just PR comments) |
| Auto-approve not working | Check that `auto_approve: true` is set in `.manki.yml` and the `pull_request_review` event trigger is in the workflow |
| Inline comments land on wrong lines | The judge agent validated line numbers but the diff may have shifted. Findings that can't be placed inline are moved to the review body |

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

| Secret | Required | Purpose |
|--------|----------|---------|
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API auth |
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes* | Claude Max subscription auth (deprecated) |
| `OPENAI_OAUTH_TOKEN` | No | Base64-encoded `~/.codex/auth.json` for Codex CLI OAuth |
| `OPENAI_API_KEY` | No | OpenAI API key (alternative to Codex OAuth) |
| `GEMINI_OAUTH_TOKEN` | No | Base64-encoded `~/.gemini/oauth_creds.json` for Gemini CLI OAuth |
| `GEMINI_API_KEY` | No | Google Generative AI API key (alternative to Gemini OAuth) |
| `REVIEW_MEMORY_TOKEN` | No | Fine-grained PAT for memory repo writes |

\* At least one provider credential is required. The active provider for each agent is selected by the model ID in `.manki.yml`.
