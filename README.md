<p align="center">
  <img src="assets/manki.png" alt="Manki" width="200" />
</p>

<h1 align="center">Manki — curious, thorough, and always learning</h1>

<p align="center">
  <a href="https://github.com/xdustinface/manki/actions/workflows/ci.yml"><img src="https://github.com/xdustinface/manki/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://codecov.io/gh/xdustinface/manki"><img src="https://codecov.io/gh/xdustinface/manki/graph/badge.svg" alt="codecov" /></a>
</p>

<p align="center"><strong>Your tokens, your rules.</strong> Self-hosted AI code review that runs on your own GitHub runners and learns from your team.</p>

Manki assembles a dynamic review team from a pool of seven specialist agents, sized to your diff, then passes all findings through a judge agent that deduplicates, re-severities, and tallies the final verdict. She's curious, thorough, and remembers what you teach her.

## What Manki does

- **Dynamic review teams** -- A pool of seven specialist agents (Security, Architecture, Correctness, Testing, Performance, Maintainability, Dependencies) with automatic team sizing: 3 agents for small diffs, 5 for medium, 7 for large. Core agents (Security, Architecture, Correctness) always participate; additional agents are selected by content relevance. Trivial PRs (docs, renames, comment-only edits) are routed to a single Trivial Change Verifier (`teamSize=1`)
- **Judge agent** -- After the review round, a judge agent deduplicates overlapping findings, assigns a final 4-tier severity (required/suggestion/nit/ignore), and tallies the verdict
- **Smart verdicts** -- Blocking issues get `REQUEST_CHANGES`. Nits get `APPROVE` with suggestions. Failures fall back to `COMMENT`. She won't hold up your PRs over style nitpicks
- **Two-tier dedup** -- On subsequent pushes, Manki runs static matching plus an LLM dedup pass (Haiku) against previously posted findings, and tracks which ones were resolved
- **Auto-resolve with validation** -- When a new push touches code near an open finding, Claude validates whether the fix actually addresses it and auto-resolves the thread
- **Auto-approve** -- When all blocking threads are resolved, Manki approves the PR. Trigger manually with `/manki check`
- **Nit issues for triage** -- Non-blocking findings become a GitHub issue with checkboxes, a `needs-human` label, and collapsible details with GitHub permalink embeds. Triage with `/manki triage`
- **Live dashboard** -- Progress comment updates in real-time showing each review phase (parse, review, judge) with status
- **AI-generated summaries** -- The judge writes a concise review summary instead of a hardcoded template. Collapsed review stats (JSON) are included for future performance analysis
- **Structured AI context** -- Inline comments include a collapsed JSON block with machine-readable metadata for AI agents to consume
- **Self-learning memory** -- Teach her with `/manki remember`. She stores learnings, tracks patterns, applies suppressions, and auto-escalates findings that are consistently accepted during triage
- **Conversational** -- Reply to any review comment to start a discussion. She reacts with emoji to acknowledge commands
- **Self-hosted** -- Runs on GitHub Actions with your own Claude credentials. Optional GitHub App identity via OIDC token service; also enables cross-repo memory access without a separate token. Falls back gracefully to github-actions[bot] if unavailable

## Quick start

1. **Install the app** -- [github.com/apps/manki-review](https://github.com/apps/manki-review)
2. **Add a Claude secret** -- `gh secret set CLAUDE_CODE_OAUTH_TOKEN`
3. **Add the workflow** -- copy the YAML from the [Setup Guide](SETUP.md#step-3-add-the-workflow)

Full setup guide with memory, triage, and troubleshooting: **[SETUP.md](SETUP.md)**

## Talk to Manki

| Command | What it does |
|---------|-------------|
| `/manki review` | Trigger a full multi-agent review |
| `/manki explain [topic]` | Ask about the PR changes |
| `/manki dismiss [finding]` | Dismiss a finding (stored as suppression in memory) |
| `/manki remember <instruction>` | Teach her something for future reviews |
| `/manki remember global: <instruction>` | Teach globally (applies to all repos) |
| `/manki check` | Check thread resolution and auto-approve if clear |
| `/manki triage` | Process nit issue checkboxes into work issues + suppressions |
| `/manki forget <text>` | Remove a learning matching the text |
| `/manki forget suppression <pattern>` | Remove a suppression matching the pattern |
| `/manki help` | Show all commands |

You can also use `@manki` as the command prefix, or reply to any of her review comments to start a conversation. Tip: You can edit a comment to add `/manki` if you forgot to include it.

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

# Per-stage model selection
models:
  planner: claude-haiku-4-5     # fast pre-review planning pass
  reviewer: claude-sonnet-4-6   # fast, parallel reviewers
  judge: claude-opus-4-6        # precise, single judge
  dedup: claude-haiku-4-5       # fast LLM dedup against prior findings

# Multi-pass verification (default: 1, increase for higher confidence)
# review_passes: 2

# Max diff size for automated review (default: 50000)
# max_diff_lines: 50000

# What to do with non-blocking findings: "issues" (default) or "comments"
nit_handling: issues

# Enable memory for self-learning
memory:
  enabled: true
  repo: "your-org/review-memory"
# memory_repo_token is optional if the manki-review GitHub App
# is installed on your memory repo. Otherwise, add it as a
# workflow secret: memory_repo_token: ${{ secrets.REVIEW_MEMORY_TOKEN }}
```

See [`.manki.yml.example`](.manki.yml.example) for all options.

## Security

- **Prompt injection** -- PR diffs are untrusted content passed to LLM prompts. All findings are sanitized before posting to GitHub (HTML stripping, `@mention` escaping via `sanitizeMarkdown`)
- **Token handling** -- All secrets are masked via `core.setSecret()`. The memory repo uses a separate `memory_repo_token`
- **Memory access control** -- Only repo owners, members, and collaborators can use `/manki remember`. Commands from outside collaborators are ignored
- **Judge trust model** -- The judge has final say on severity and can downgrade `required` to `ignore`. This is by design to reduce false positives from individual reviewers
- **OIDC authentication** -- Token service requests are authenticated via GitHub Actions OIDC tokens, cryptographically proving the request comes from a legitimate workflow. No shared secrets needed

## How it works

1. PR opened -- Manki wakes up
2. A fast planner pass (Haiku) sizes the team adaptively for `review_level: auto` (1/3/5/7 agents) and picks reviewer/judge effort. Trivial PRs go to a single Trivial Change Verifier
3. The chosen team of reviewers analyzes the diff in parallel
4. A judge agent evaluates each finding for accuracy, actionability, and severity using per-finding curated code context and memory
5. Clean review posted -- blocking issues get `REQUEST_CHANGES`, nits get `APPROVE`
6. Non-blocking findings become a GitHub issue with checkboxes and a `needs-human` label
7. On new pushes, Manki checks which findings were addressed, auto-resolves validated threads, and runs two-tier dedup (static + LLM) against prior findings before reviewing again
8. When all blocking threads are resolved, she approves
9. Comment `/manki triage` on a nit issue to convert checked items into work issues and dismiss the rest as suppressions

> Manki has a healthy appetite for tokens and a nose for bugs. She doesn't chase rate limits -- she chases rabbits.

## License

AGPL-3.0
