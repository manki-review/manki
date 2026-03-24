# Claude Review

Multi-agent AI code review for GitHub pull requests, powered by Claude.

Claude Review runs three specialized reviewer agents in parallel — **Security & Correctness**, **Architecture & Quality**, and **Testing & Edge Cases** — then consolidates their findings into a single, actionable review.

## Features

- **Multi-agent review**: 3 specialist agents provide diverse perspectives, then a consolidation agent de-duplicates and validates findings
- **Smart severity**: Blocking issues trigger `REQUEST_CHANGES`, suggestions are posted as `COMMENT`, clean PRs get `APPROVE`
- **Auto-approve**: When all blocking issues are resolved, the PR is automatically approved
- **Customizable**: Configure reviewer agents, file filters, and custom instructions via `.claude-review.yml`
- **Dual auth**: Works with Claude Max subscription (OAuth) or Anthropic API key
- **Mention trigger**: Comment `@claude review` on any PR to trigger a review on demand

## Quick Start

### 1. Set up authentication

Choose one:

**Option A: Claude Max subscription (recommended — no extra cost)**
```bash
claude setup-token
```
Copy the token and add it as a repository secret named `CLAUDE_CODE_OAUTH_TOKEN`.

**Option B: Anthropic API key**
Add your API key as a repository secret named `ANTHROPIC_API_KEY`.

### 2. Add the workflow

Create `.github/workflows/claude-review.yml` in your repository:

```yaml
name: Claude Review

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
    # Skip if not a PR event or not a @claude review request
    if: |
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' &&
       contains(github.event.comment.body, '@claude') &&
       contains(github.event.comment.body, 'review') &&
       github.event.issue.pull_request)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install Claude Code CLI
        if: env.CLAUDE_CODE_OAUTH_TOKEN != ''
        run: npm install -g @anthropic-ai/claude-code
        env:
          CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
      - name: Claude Review
        uses: xdustinface/claude-review@v1
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          # Use ONE of the following:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          # anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

> **Note:** `@v1` points to the latest release with pre-built `dist/`. If you use `@main`, you must build from source by adding `setup-node`, `npm ci`, and `npm run build` steps before the action.

### 3. (Optional) Customize

Create `.claude-review.yml` in your repository root:

```yaml
# Claude model (default: claude-opus-4-6)
model: claude-opus-4-6

# Auto-review on PR open/update
auto_review: true

# Auto-approve when all blocking issues are resolved
auto_approve: true

# File filtering
exclude_paths:
  - "*.lock"
  - "dist/**"
  - "*.generated.*"

# Maximum diff size (lines) before skipping
max_diff_lines: 10000

# Custom reviewer agents (replaces defaults)
# reviewers:
#   - name: "Security & Correctness"
#     focus: "bugs, vulnerabilities, memory safety"
#   - name: "Architecture & Quality"
#     focus: "design, simplicity, maintainability"
#   - name: "Protocol Compliance"
#     focus: "DIP compliance, consensus rules"

# Additional context for all reviewers
# instructions: |
#   This is a Rust project. Focus on ownership and error handling.
#   The FFI layer uses raw pointers intentionally.
```

## Configuration Reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `model` | string | `claude-opus-4-6` | Claude model for reviews |
| `auto_review` | bool | `true` | Auto-review on PR open/update |
| `auto_approve` | bool | `true` | Auto-approve when blocking issues resolved |
| `review_language` | string | `en` | Review comment language |
| `include_paths` | string[] | `["**/*"]` | Glob patterns for files to review |
| `exclude_paths` | string[] | `["*.lock", "dist/**", "*.generated.*"]` | Glob patterns for files to skip |
| `max_diff_lines` | number | `10000` | Skip review if diff exceeds this |
| `reviewers` | object[] | *(3 default agents)* | Custom reviewer agents |
| `instructions` | string | `""` | Additional context for reviewers |
| `memory.enabled` | bool | `false` | Enable review memory |
| `memory.repo` | string | `""` | Memory repo (`owner/name` format) |

## Action Inputs

| Input | Required | Description |
|-------|----------|-------------|
| `github_token` | Yes | GitHub token for posting reviews |
| `claude_code_oauth_token` | No* | OAuth token for Max subscription |
| `anthropic_api_key` | No* | Anthropic API key |
| `config_path` | No | Path to config file (default: `.claude-review.yml`) |
| `model` | No | Override model from config |
| `memory_repo_token` | No | Token for memory repo access |

\* One of `claude_code_oauth_token` or `anthropic_api_key` is required.

## Action Outputs

| Output | Description |
|--------|-------------|
| `review_id` | GitHub review ID |
| `verdict` | `APPROVE`, `COMMENT`, or `REQUEST_CHANGES` |
| `findings_count` | Total findings count |

## How It Works

1. **Trigger**: PR opened/updated, or `@claude review` comment
2. **Gather context**: Fetches diff, config, and repo context (CLAUDE.md)
3. **Parallel review**: 3 specialist agents analyze the diff independently
4. **Consolidation**: A consolidation agent merges, de-duplicates, and validates findings
5. **Post review**: Findings posted as inline comments with appropriate severity
6. **Auto-approve**: When all blocking issues are resolved, the PR is approved

## License

MIT
