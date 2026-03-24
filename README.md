# Manki

**Your tokens, your rules.** Self-hosted AI code review that runs on your own GitHub runners and learns from your team.

Manki runs three specialist reviewers in parallel, then consolidates their findings into one clean review. She's curious, thorough, and remembers what you teach her.

## What Manki does

- **Multi-agent review** -- Security, Architecture, and Testing specialists review every PR independently, then a consolidation agent merges and validates findings
- **Smart verdicts** -- Blocking issues get `REQUEST_CHANGES`. Nits get `APPROVE` with suggestions. She won't hold up your PRs over style nitpicks
- **Self-learning memory** -- Teach her with `@manki remember`. She stores learnings, tracks patterns, and gets smarter over time
- **No external dependencies** -- Runs on GitHub Actions with your Claude Max subscription. No third-party services, no external rate limits, no waiting in queue
- **Review lifecycle** -- Tracks conversations, auto-resolves addressed findings, creates issues from nits for later triage

## Quick start

```yaml
# .github/workflows/manki.yml
name: Manki

on:
  pull_request:
    types: [opened, synchronize]
  issue_comment:
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
      - name: Manki
        uses: xdustinface/manki@v2
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

For the full setup guide (permissions, memory system, GitHub App identity, troubleshooting), see **[SETUP.md](SETUP.md)**.

## Talk to Manki

| Command | What it does |
|---------|-------------|
| `@manki review` | Trigger a review on any PR |
| `@manki explain [topic]` | Ask about the PR changes |
| `@manki remember [instruction]` | Teach her something for future reviews |
| `@manki dismiss [finding]` | Dismiss a finding (stored as suppression) |
| `@manki help` | Show all commands |

## Configure

Create `.manki.yml` in your repo root:

```yaml
model: claude-opus-4-6
auto_review: true
auto_approve: true
exclude_paths: ["*.lock"]

# Teach Manki about your project
instructions: |
  This is a Rust project. Focus on ownership and error handling.

# Enable memory for self-learning
memory:
  enabled: true
  repo: "your-org/review-memory"
```

## How it works

1. PR opened -- Manki wakes up
2. Three specialist agents review the diff in parallel
3. A consolidation agent merges findings, removes duplicates, validates line numbers
4. Clean review posted -- blocking issues block, nits don't
5. On new pushes, Manki checks if her previous findings were addressed
6. When everything's resolved, she approves

> Manki has a healthy appetite for tokens and a nose for bugs. She doesn't chase rate limits -- she chases rabbits.

## License

MIT
