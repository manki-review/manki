# Setup Guide

Complete step-by-step guide to install Manki on a GitHub repository.

## Quick Start

### 1. Install the GitHub App

Install [Manki](https://github.com/apps/manki-review) on the repositories you want reviewed.

### 2. Add Secrets

Add your Claude authentication to the repository:

```bash
# Option A: Claude Max subscription (no extra API costs)
claude setup-token
gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>

# Option B: Anthropic API key (pay-per-use)
gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>
```

### 3. Add the Workflow

Create `.github/workflows/manki.yml` -- see [full workflow below](#step-3-add-the-workflow).

---

## Prerequisites

- A GitHub repository
- A Claude Max subscription (or Anthropic API key)
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

### Claude Code OAuth Token (Max Subscription)

This allows the action to use your Claude Max subscription -- no extra API costs.

1. Run locally:
   ```bash
   claude setup-token
   ```
2. Copy the generated token
3. Add as a repository secret:
   ```bash
   gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo <owner>/<repo>
   ```

**OR**

### Anthropic API Key (Pay-per-use)

1. Get your API key from [console.anthropic.com](https://console.anthropic.com)
2. Add as a repository secret:
   ```bash
   gh secret set ANTHROPIC_API_KEY --repo <owner>/<repo>
   ```

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
          node-version: '20'
          cache: 'npm'
      - name: Install Claude Code CLI
        run: npm install -g @anthropic-ai/claude-code
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      - name: Manki Review
        uses: manki-review/manki@v4
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}  # Alternative to OAuth
          # github_token: ${{ secrets.GITHUB_TOKEN }}  # Only if not using the GitHub App
          # memory_repo_token: ${{ secrets.REVIEW_MEMORY_TOKEN }}  # Only if memory repo is separate
```

### Action inputs

The workflow above uses the only inputs most setups need: `claude_code_oauth_token` (or `anthropic_api_key`), `github_token`, and optionally `memory_repo_token`. To point at a config file outside the repo root, set `config_path` (default: `.manki.yml`). For GitHub App identity, set `github_app_id`, `github_app_private_key`, and `manki_token_url`. See [`action.yml`](action.yml) for the full input reference.

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
# Label PRs that have any required-severity findings
- name: Label blocking PRs
  if: fromJSON(steps.manki.outputs.severity_counts).required > 0
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
3. **Dedup** -- A two-tier dedup pass filters findings already posted on the PR before judge evaluation. A static matcher handles exact/near-exact matches, then an LLM dedup pass (Haiku) catches semantic duplicates.
4. **Judge agent** -- A single agent evaluates the deduplicated reviewer findings for accuracy, actionability, and severity. It filters out noise, merges any remaining overlap, and assigns a 4-tier severity to each surviving finding.
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
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes* | Claude Max subscription auth |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API auth (alternative) |
| `REVIEW_MEMORY_TOKEN` | No | Fine-grained PAT for memory repo writes |

\* One of `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is required.
