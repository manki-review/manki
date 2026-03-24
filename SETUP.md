# Setup Guide

Complete step-by-step guide to install Manki on a GitHub repository.

## Prerequisites

- A GitHub repository
- A Claude Max subscription (or Anthropic API key)
- Repository admin access (for settings changes)

## Step 1: Repository Settings

### Enable GitHub Actions PR Approval

**Required** — without this, the action cannot approve PRs.

1. Go to **Settings → Actions → General**
2. Scroll to **Workflow permissions**
3. Check **"Allow GitHub Actions to create and approve pull requests"**
4. Click Save

### Branch Protection (Optional)

If you use branch protection rules and want Manki to be a required check:

1. Go to **Settings → Branches → Branch protection rules**
2. Edit the rule for `main` (or your default branch)
3. Under "Require status checks to pass":
   - Add `build` (CI check)
   - Add `review` (Manki check)
4. Under "Require pull request reviews before merging":
   - Set to 1 required review
   - The action's APPROVE counts as a review

> **Note**: If the action finds blocking issues, it posts REQUEST_CHANGES which blocks the merge. Non-blocking suggestions still result in APPROVE.

## Step 2: Authentication Secrets

### Claude Code OAuth Token (Max Subscription)

This allows the action to use your Claude Max subscription — no extra API costs.

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
   - **Repository access**: "Only select repositories" → select your memory repo (e.g., `<owner>/review-memory`)
   - **Permissions**: Repository permissions → **Contents** → Read and write
3. Generate and copy the token
4. Add as a repository secret:
   ```bash
   gh secret set REVIEW_MEMORY_TOKEN --repo <owner>/<repo>
   ```

## Custom Bot Identity (Optional)

By default, reviews appear as "github-actions[bot]". To give the review bot its own name and avatar, create a GitHub App.

### Create the GitHub App

1. Go to **Settings > Developer settings > GitHub Apps > New GitHub App**
2. Configure:
   - **App name**: `Manki` (or your preferred name)
   - **Homepage URL**: `https://github.com/xdustinface/manki`
   - **Webhook**: Uncheck "Active" (not needed)
   - **Permissions**:
     - Repository: **Contents** > Read
     - Repository: **Pull requests** > Read and write
     - Repository: **Issues** > Read and write
   - **Where can this GitHub App be installed?**: "Only on this account"
3. Click "Create GitHub App"
4. Note the **App ID** displayed on the app page
5. Generate a **private key** (scroll down > "Generate a private key")
6. Download the `.pem` file

### Install the App

1. Go to the app's settings page
2. Click "Install App" in the sidebar
3. Select your account and choose which repos to install on

### Add Secrets

```bash
gh secret set MANKI_APP_ID --repo <owner>/<repo>
# Paste the App ID number

gh secret set MANKI_PRIVATE_KEY --repo <owner>/<repo>
# Paste the contents of the .pem file
```

### Update Workflow

```yaml
      - name: Manki Review
        uses: xdustinface/manki@v2
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          github_app_id: ${{ secrets.MANKI_APP_ID }}
          github_app_private_key: ${{ secrets.MANKI_PRIVATE_KEY }}
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

## Step 3: Add the Workflow

Create `.github/workflows/manki.yml`:

```yaml
name: Manki

on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    if: |
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' &&
       contains(github.event.comment.body, '@manki') &&
       github.event.issue.pull_request)
    runs-on: ubuntu-latest
    concurrency:
      group: manki-${{ github.event.pull_request.number || github.event.issue.number || github.run_id }}
      cancel-in-progress: true
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
        uses: xdustinface/manki@v2
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}  # Alternative to OAuth
          # memory_repo_token: ${{ secrets.REVIEW_MEMORY_TOKEN }}  # Optional: for review memory
```

## Step 4: Configure Reviews (Optional)

Create `.manki.yml` in your repository root:

```yaml
# Claude model (default: claude-opus-4-6)
model: claude-opus-4-6

# Auto-review on PR open/update (default: true)
auto_review: true

# Auto-approve when all blocking issues are resolved (default: true)
auto_approve: true

# File filtering
exclude_paths:
  - "*.lock"

# Maximum diff size before skipping (default: 10000 lines)
max_diff_lines: 10000

# Additional context for reviewers
# instructions: |
#   This is a Rust project. Focus on ownership and error handling.

# Custom reviewer agents (replaces defaults)
# reviewers:
#   - name: "Security & Correctness"
#     focus: "bugs, vulnerabilities, memory safety"
#   - name: "Architecture & Quality"
#     focus: "design, simplicity, maintainability"
#   - name: "Protocol Compliance"
#     focus: "DIP compliance, consensus rules"

# Review memory (requires REVIEW_MEMORY_TOKEN secret)
# memory:
#   enabled: true
#   repo: "<owner>/review-memory"
```

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

## Verification

After setup, create a test PR to verify everything works:

1. Create a branch with a small change
2. Open a PR
3. The Manki workflow should trigger automatically
4. Check the Actions tab for the review run
5. The PR should receive inline review comments and an APPROVE/REQUEST_CHANGES review

You can also trigger a review manually by commenting `@manki review` on any PR.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "spawn claude ENOENT" | Add the "Install Claude Code CLI" step before the action |
| "Failed to post APPROVE review" | Enable "Allow GitHub Actions to create and approve pull requests" in repo settings |
| Review says "No reviewable files" | Check `include_paths`/`exclude_paths` in config — dotfiles are included by default |
| Memory not loading | Verify `REVIEW_MEMORY_TOKEN` secret is set and the PAT has Contents read/write on the memory repo |
| Review doesn't trigger on `@manki review` | The workflow file must exist on the default branch (main) |
| "Diff too large" | Increase `max_diff_lines` in config or split the PR |

## Known Limitations

### `@manki review` runs action code from main branch

GitHub Actions runs `issue_comment` triggered workflows from the **default branch** (main), not the PR branch. This means:

- `@manki review` always uses the action code from main — not from the PR branch
- If you're developing the action itself and want to test changes, use a direct push to trigger the `pull_request` event instead
- **The review content is still correct** — the PR diff is fetched via API regardless of which branch the workflow runs on

This is a GitHub platform limitation that affects all Actions-based bots. Tools like CodeRabbit avoid this by using a webhook server instead of GitHub Actions.

### Reviews may post duplicate comments across runs

Each review run posts fresh inline comments. The recap phase deduplicates against previous findings, but if the consolidation agent fails or produces different titles, duplicates can occur. This is tracked in issue backlog.

## Quick Reference: All Secrets

| Secret | Required | Purpose |
|--------|----------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes* | Claude Max subscription auth |
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API auth (alternative) |
| `REVIEW_MEMORY_TOKEN` | No | Fine-grained PAT for memory repo writes |
| `MANKI_APP_ID` | No | GitHub App ID for custom bot identity |
| `MANKI_PRIVATE_KEY` | No | GitHub App private key (PEM format) |

\* One of `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is required.
