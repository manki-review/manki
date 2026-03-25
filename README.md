# Manki

**Your tokens, your rules.** Self-hosted AI code review that runs on your own GitHub runners and learns from your team.

Manki assembles a dynamic review team from a pool of seven specialist agents, sized to your diff, then passes all findings through a judge agent that deduplicates, re-severities, and tallies the final verdict. She's curious, thorough, and remembers what you teach her.

## What Manki does

- **Dynamic review teams** -- A pool of seven specialist agents (Security, Architecture, Correctness, Testing, Performance, Maintainability, Dependencies) with automatic team sizing: 3 agents for small diffs, 5 for medium, 7 for large. Core agents (Security, Architecture, Correctness) always participate; additional agents are selected by content relevance
- **Judge agent** -- After the review round, a judge agent deduplicates overlapping findings, assigns a final 4-tier severity (required/suggestion/nit/ignore), and tallies the verdict
- **Smart verdicts** -- Blocking issues get `REQUEST_CHANGES`. Nits get `APPROVE` with suggestions. Failures fall back to `COMMENT`. She won't hold up your PRs over style nitpicks
- **Review recap** -- On subsequent pushes, Manki deduplicates against previous findings and tracks which ones were resolved
- **Auto-resolve with validation** -- When a new push touches code near an open finding, Claude validates whether the fix actually addresses it and auto-resolves the thread
- **Auto-approve** -- When all blocking threads are resolved, Manki approves the PR. Trigger manually with `@manki check`
- **Nit issues for triage** -- Non-blocking findings become a GitHub issue with checkboxes, a `needs-human` label, code snippets, and AI agent fix prompts. Triage with `@manki triage`
- **Self-learning memory** -- Teach her with `@manki remember`. She stores learnings, tracks patterns, applies suppressions, and auto-escalates findings that are consistently accepted during triage
- **Conversational** -- Reply to any review comment to start a discussion. She reacts with emoji to acknowledge commands
- **No external dependencies** -- Runs on GitHub Actions with your Claude Max subscription. No third-party services, no external rate limits, no waiting in queue

## Quick start

```yaml
# .github/workflows/manki.yml
name: Manki

on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]
  pull_request_review:
    types: [submitted, dismissed]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  review:
    if: |
      github.event_name == 'pull_request' ||
      (github.event_name == 'issue_comment' &&
       contains(github.event.comment.body, '@manki')) ||
      (github.event_name == 'pull_request_review_comment' &&
       github.event.action == 'created') ||
      (github.event_name == 'pull_request_review' &&
       (github.event.action == 'submitted' || github.event.action == 'dismissed'))
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
      - name: Manki
        uses: xdustinface/manki@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

For the full setup guide (permissions, memory system, GitHub App identity, troubleshooting), see **[SETUP.md](SETUP.md)**.

## Talk to Manki

| Command | What it does |
|---------|-------------|
| `@manki review` | Trigger a full multi-agent review |
| `@manki explain [topic]` | Ask about the PR changes |
| `@manki dismiss [finding]` | Dismiss a finding (stored as suppression in memory) |
| `@manki remember <instruction>` | Teach her something for future reviews |
| `@manki remember global: <instruction>` | Teach globally (applies to all repos) |
| `@manki check` | Check thread resolution and auto-approve if clear |
| `@manki triage` | Process nit issue checkboxes into work issues + suppressions |
| `@manki forget` | Not yet implemented -- remove learnings manually for now |
| `@manki help` | Show all commands |

You can also reply to any of her review comments to start a conversation.

## Configure

Create `.manki.yml` in your repo root:

```yaml
auto_review: true
auto_approve: true
exclude_paths: ["*.lock"]

# Team sizing: auto (default), small (3), medium (5), large (7)
review_level: auto
review_thresholds:
  small: 200
  medium: 1000

# Teach Manki about your project
instructions: |
  This is a Rust project. Focus on ownership and error handling.

# Default model (used as fallback when per-stage model is not set)
model: claude-opus-4-6

# Per-stage model selection (falls back to `model` if not set)
models:
  reviewer: claude-sonnet-4-6   # fast, parallel reviewers
  judge: claude-opus-4-6        # precise, single judge

# What to do with non-blocking findings: "issues" (default) or "comments"
nit_handling: issues

# Enable memory for self-learning
memory:
  enabled: true
  repo: "your-org/review-memory"
```

See [`.manki.yml.example`](.manki.yml.example) for all options.

## Security

- **Prompt injection** -- PR diffs are untrusted content passed to LLM prompts. All findings are sanitized before posting to GitHub (HTML stripping, `@mention` escaping via `sanitizeMarkdown`)
- **Token handling** -- All secrets are masked via `core.setSecret()`. The memory repo uses a separate `memory_repo_token`
- **Memory access control** -- Only repo owners, members, and collaborators can use `@manki remember`. Commands from outside collaborators are ignored
- **Judge trust model** -- The judge has final say on severity and can downgrade `required` to `ignore`. This is by design to reduce false positives from individual reviewers

## How it works

1. PR opened -- Manki wakes up
2. A dynamic team is assembled from the agent pool (3/5/7 agents depending on diff size)
3. All reviewers analyze the diff in parallel
4. A judge agent evaluates each finding for accuracy, actionability, and severity using per-finding curated code context and memory
5. Clean review posted -- blocking issues get `REQUEST_CHANGES`, nits get `APPROVE`
6. Non-blocking findings become a GitHub issue with checkboxes and a `needs-human` label
7. On new pushes, Manki checks which findings were addressed, auto-resolves validated threads, and deduplicates before reviewing again
8. When all blocking threads are resolved, she approves
9. Comment `@manki triage` on a nit issue to convert checked items into work issues and dismiss the rest as suppressions

> Manki has a healthy appetite for tokens and a nose for bugs. She doesn't chase rate limits -- she chases rabbits.

## License

AGPL-3.0
