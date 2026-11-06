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

## Upgrading to 6.1

- **Review memory.** With the manki-review App, 6.1 writes memory with a separate memory token from the token service, which can write only `<owner>/review-memory`. Releases before 6.1 use the App's review token for memory. That token now covers only the reviewed repo, so their memory reads and writes fail. Upgrade to 6.1, or set `memory_repo_token`. A memory repo with any other name needs `memory_repo_token`, or [your own GitHub App](#your-own-github-app).
- **Comment access.** Copy the job `if` from [Step 3](#step-3-add-the-workflow) into your workflow. The old `if` let only owners, members and collaborators start Manki from a comment, and GitHub reports an organization member with a private membership as neither, so those members were refused. Manki checks the commenter's write access itself in any case, see [Event triggers explained](#event-triggers-explained).
- **Webhook mode** is a preview in 6.1, open only to some repositories. See [Webhook mode](#webhook-mode-opt-in-new-in-61).

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

When Manki posts a new review, it dismisses its own earlier REQUEST_CHANGES review. If a ruleset turns on **Restrict who can dismiss reviews** (in its **Require a pull request before merging** rule), add the identity Manki posts as to the allowed actors: the Manki app, or GitHub Actions when Manki runs without the app. Otherwise GitHub refuses the dismissal, and the old REQUEST_CHANGES keeps blocking the merge after Manki approves.

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
| Actions | Read and write | [Webhook mode](#webhook-mode-opt-in-new-in-61): start the dispatch workflow and follow its runs. Set on the App by its maintainers, so you only approve it |
| Checks | Read and write | [Webhook mode](#webhook-mode-opt-in-new-in-61): show a `Manki` check on the PR. Set on the App by its maintainers, so you only approve it |

### Your own GitHub App

Instead of the manki-review App, Manki can post as an App you create, with the `github_app_id` and `github_app_private_key` inputs. Manki limits the tokens it mints to the reviewed repo and the memory repo. The App's private key is a secret of the workflow, though. Any code that runs in that job can read the key and mint tokens for every repository the App is installed on. Keep that job to the steps Manki needs, or prefer the manki-review App, whose key stays in the token service.

## Step 2: Authentication Secrets

> **Do you need a GitHub token?** No. `github_token` defaults to the workflow's own token. With the GitHub App installed (Step 1), Manki uses the App's token instead and posts as `manki-review[bot]`. Without the App, it posts with the workflow token as `github-actions[bot]`. For review memory, Manki gets a second App token that can write only the `review-memory` repo of the same account, when the App is installed on it. A memory repo with any other name needs the `memory_repo_token` input.

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

Required only if you enable the review memory system and the manki-review App can't write the memory repo. The App writes only a repo named `review-memory` in the same account as the reviewed repo, and only when it is installed there. Any other memory repo, a custom name or another account, needs this token, unless [your own GitHub App](#your-own-github-app) is installed on it. Without either, Manki skips memory and logs a warning. This is a fine-grained PAT scoped to the memory repo only.

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

The token's write surface is limited to cross-PR memory files (`learnings.yml`, `suppressions.yml`, `metrics/fix-rate.jsonl`). As of v5.0.0, per-round state lives in a `Manki context` block embedded in each review summary on the PR, so the memory repo no longer receives `prs/{n}/handover.json` writes. The block is a hidden HTML comment holding the round's diagnostics as JSON: models and effort, timings, token use, the planner's choices, every finding the finders reported (`reviewers.rawFindings`), dedup drops, and the judge's decisions with its reasoning, including the findings it dropped (`judge.dropped`). When it would not fit in the review body, Manki stores it gzip compressed and base64 encoded in the same comment instead of cutting it. `usage.llmCalls` lists every LLM call of the round: the stage and finder, model and effort, input, output, cache read, cache write and reasoning tokens, duration, attempt, whether a fallback model answered, and an estimated cost in USD at public API prices. A call whose model has no known price, or whose provider reports no token counts (the Codex and Gemini CLI paths), counts as unpriced, and subscription use is not billed per token, so the cost is an estimate of the same calls on the API. `usage` also holds the totals for the round, per stage (`perStage`) and per model (`perModel`). Each reply Manki posts in a thread or to a command carries the same usage in a hidden `<!-- manki-reply-record: ... -->` comment. To pull every record of a PR or a whole repo into one JSON Lines file, run `npm run review-history -- <owner/repo> [<pr number>] > history.jsonl` in a manki checkout. Add `--calls` to get one line per LLM call instead, ready to sum per agent, stage, model, PR or repo. The script decodes compressed records and reads the token from `GITHUB_TOKEN` or `gh auth token`. Existing `handover.json` files in older memory repos are orphaned but harmless and require no migration.

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
    if: >-
      github.actor != 'manki-review[bot]'
      && github.event.sender.type != 'Bot'
      && github.event.review.user.type != 'Bot'
      && (github.event.action != 'closed' || github.event.pull_request.merged)
      && (github.event_name != 'issue_comment' || contains(github.event.comment.body, '@manki') || contains(github.event.comment.body, '/manki') || contains(github.event.comment.body, '- [x] Force review'))
      && (github.event_name != 'issue_comment' || !contains(fromJSON('["FIRST_TIMER","FIRST_TIME_CONTRIBUTOR"]'), github.event.comment.author_association))
      && (!github.event.pull_request || github.event.pull_request.head.repo.full_name == github.repository)
    concurrency:
      group: manki-${{ (github.event_name == 'pull_request' || (github.event_name == 'issue_comment' && (contains(github.event.comment.body, 'manki review') || contains(github.event.comment.body, '- [x] Force review')))) && 'review' || 'reply' }}-${{ github.event.pull_request.number || github.event.issue.number }}
      queue: max
    timeout-minutes: 30
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '24'
      - name: Manki Review
        uses: manki-review/manki@v6
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          # memory_repo_token: ${{ secrets.REVIEW_MEMORY_TOKEN }}  # Only if the App can't reach the memory repo
```

#### Workflow examples per provider

Claude Code OAuth:

```yaml
      - name: Manki Review
        uses: manki-review/manki@v6
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

OpenAI API key:

```yaml
      - name: Manki Review
        uses: manki-review/manki@v6
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

OpenAI Codex CLI OAuth (requires the CLI on the runner):

```yaml
      - name: Install Codex CLI
        # --ignore-scripts is safe: @openai/codex@0.166.0 ships a plain JS bin with no postinstall steps. Re-verify if you bump the version pin.
        run: npm install -g --ignore-scripts '@openai/codex@0.166.0'
      - name: Manki Review
        uses: manki-review/manki@v6
        with:
          openai_oauth_token: ${{ secrets.OPENAI_OAUTH_TOKEN }}
```

Gemini API key:

```yaml
      - name: Manki Review
        uses: manki-review/manki@v6
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

Gemini CLI OAuth (requires the CLI on the runner and a Gemini Code Assist Standard or Enterprise license):

```yaml
      - name: Install Gemini CLI
        # --ignore-scripts is safe: @google/gemini-cli@0.66.0 has no install script of its own. Re-verify if you bump the version pin.
        run: npm install -g --ignore-scripts '@google/gemini-cli@0.66.0'
      - name: Manki Review
        uses: manki-review/manki@v6
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

The workflow above uses the only inputs most setups need: a provider credential (e.g. `anthropic_api_key`, `openai_api_key`, `gemini_api_key`, or one of the OAuth equivalents) and optionally `memory_repo_token`. `github_token` defaults to the workflow token, so set it only to post with a different token. To point at a config file outside the repo root, set `config_path` (default: `.manki.yml`). To post as [your own GitHub App](#your-own-github-app), set `github_app_id` and `github_app_private_key`. `manki_token_url` points at a different token service. To tune the in-app concurrent-submission lock TTL (defense in depth against simultaneous-start races on top of the workflow `concurrency` group), set `concurrency_lock_ttl_seconds` (default: 600). See [`action.yml`](action.yml) for the full input reference.

### Action outputs

The action exposes outputs you can chain into later workflow steps: `review_id`, `verdict`, `findings_count`, `findings_json`, `severity_counts`, and `judge_model`. See [`action.yml`](action.yml) for the source of truth on each output's shape and semantics.

### Pinning the action version

Pin to a release tag or to the commit a release tag points to:

- `manki-review/manki@v6` is the floating major tag. It picks up minor and patch releases automatically. Recommended for most setups.
- `manki-review/manki@v6.0.0` is an exact release. It stays on that release until you bump it. Recommended when you want lockstep upgrades.
- `manki-review/manki@<sha>` is a full commit SHA, for organizations that require actions pinned to one.

`main` holds source only and has no built `dist/`, so `@main` or a commit SHA from `main` will not run. Each release tag points at a commit that contains the built `dist/`. For a SHA pin, take the commit of the release tag:

```sh
git ls-remote https://github.com/manki-review/manki 'refs/tags/v6.0.0^{}'
```

Then pin it with the version as a comment, so tools that update pins can read it:

```yaml
      - name: Manki Review
        uses: manki-review/manki@<sha>  # v6.0.0
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

From v6.0.0, Manki publishes immutable releases: once a release is out, its tag can never move, so the SHA behind `v6.x.y` never changes. The floating `v6` tag keeps moving to each new release.

[Workflow lockfiles](https://docs.github.com/actions/concepts/security/workflow-dependency-lockfiles) are the alternative to SHA pins. Keep `@v6` in the workflow, and run the [`gh actions-lock`](https://github.com/github/gh-actions-lock) extension to record the commit it resolves to in `.github/workflows/actions.lock`. Commit that file. Actions then runs the recorded commit, even after the tag moves, until you regenerate the lockfile. A lockfile satisfies the policy that requires actions pinned to a full commit SHA for the workflows it covers, and Dependabot regenerates the entry when it bumps the version.

Releases before the committed `dist/` fix (`v5.0.0`, `v5.0.1`) only work through the floating `@v5` tag.

### Using outputs in downstream workflow steps

```yaml
# Fail CI when the judge requests changes
- uses: manki-review/manki@v6
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

The job `if` repeats the checks Manki makes when it starts, so GitHub skips the job without starting a runner for an event Manki would ignore anyway:

- anything Manki or another bot did, such as a coverage bot's PR comment,
- a review event on a bot's review, such as a push dismissing Manki's stale review,
- a PR closed without merging,
- a comment that doesn't mention `@manki` or `/manki` and doesn't tick a Force review box,
- any event of a PR from a fork (see [Pull requests from forks](#pull-requests-from-forks)).

Manki keeps the checks above in its code, so a workflow with a shorter `if` still works. It just starts a runner that exits at once. A skipped job shows as a skipped `review` check, which GitHub counts as passing for a required check.

Manki itself decides who can start it from a comment, on a PR, an issue or a review thread. A comment counts when its author has write access to the repository. Manki trusts an owner, member or collaborator as the event reports them, and asks the GitHub API about anyone else, with the workflow's own `GITHUB_TOKEN`. That API call is why the check lives in Manki and not in the `if`, which cannot make one: GitHub reports an organization member who keeps the membership private as `CONTRIBUTOR` or `NONE`, and the API still shows their access. Anyone can comment on a public repository, so Manki checks the commenter before it fetches the App token, uses a provider credential or calls a model. It refuses without posting anything, and the run ends at once. The `if` only skips comments from first-time contributors, who are never members. A tick of a Force review box edits Manki's own comment, so Manki checks the person who ticked, who needs write access. If you run Manki under your own GitHub App, replace `manki-review[bot]` with your app's bot login in the `github.actor` check.

### Concurrency

The `concurrency` block gives each PR two queues. Runs in the same queue never overlap, and nothing cancels them from outside:

- The review queue, `manki-review-<pr>`, takes pushes and the other `pull_request` events, review commands, and ticks of the Force review box.
- The reply queue, `manki-reply-<pr>`, takes thread replies, review state changes, and every other command.

Both use `queue: max`, so GitHub holds up to 100 waiting runs per queue and starts them in order. Without it, a group holds a single waiting run, and GitHub cancels it when a newer run queues: a thread reply would silently drop a push review that was waiting to start. `cancel-in-progress` stays off, and GitHub rejects it next to `queue: max` anyway. Earlier setups cancelled a review when a new push arrived, and that kept causing trouble: every cancel left a red check on the PR, and a cancel could land while Manki was posting. A running review now stops by itself instead. It checks the PR head while it works, and when a new commit lands it stops within about 30 seconds, posts no verdict, and marks its progress comment superseded. The next run in the queue then reviews the new head. A run that receives SIGTERM, for example when the job is cancelled, stops writing to the PR.

Replies have their own queue so an answer in a thread never waits behind a full review. The queue is picked from the comment text: a comment containing `manki review` goes to the review queue. A review request phrased another way runs in the reply queue, and the in-app lock described below still stops two reviews of the same commit.

`timeout-minutes: 30` ends a run that hangs, for example on a model call that never returns. GitHub's default is 6 hours, and the PR's queue would wait behind it for that long. A full review usually takes a few minutes.

GitHub Actions concurrency is best-effort, not atomic. Two events dispatched within the same scheduling window can transition to in-progress before either reaches the queue check, in which case both runs proceed concurrently. As defense in depth, the action runs an in-app lock at the review pipeline entry point: it scans its own existing comments for an "in progress" marker carrying a different `manki-run-id`, and bails (with a `core.warning`) before any LLM call when one is found within the configurable TTL. Tune the TTL with the `concurrency_lock_ttl_seconds` action input (default 600 seconds). Lowering it makes the lock recover faster from crashed runs that left a stale marker behind. Raising it tolerates longer-running reviews.

### Pull requests from forks

GitHub gives a workflow run for a PR from a fork no secrets and no OIDC token, and only a read-only `GITHUB_TOKEN`. This holds for the `pull_request`, `pull_request_review` and `pull_request_review_comment` events. Manki would have no model credentials and no permission to post, so the run would fail. The last line of the job `if` skips these events instead. The PR shows a skipped `review` check, and Manki posts nothing.

Comment events are different: GitHub runs `issue_comment` in the base repository, with its secrets. Someone with write access can still ask for a review of a fork PR with a review command in a PR comment, and Manki reviews it like any other PR. Manki ignores a comment from anyone else, including the fork PR's author (see [Event triggers explained](#event-triggers-explained)).

### Cache access

GitHub gives `issue_comment` runs read-only access to the Actions cache. They can restore the default branch's caches but can't save new ones. The workflow above uses no cache, so this changes nothing for it. If you add one, for example `cache: 'npm'` on `actions/setup-node` to speed up CLI installs, set `cache-mode: read` on the `review` job:

```yaml
jobs:
  review:
    cache-mode: read
```

Every Manki run is then read-only on the cache, not only the comment runs. Your CI on the default branch still writes the caches that Manki restores. Note that `cache: 'npm'` needs a lockfile (`package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`) in your repository.

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
    # `!cancelled()` runs the review even when lint fails or is skipped, such as on comment events.
    if: >-
      !cancelled()
      && github.actor != 'manki-review[bot]'
      && github.event.sender.type != 'Bot'
      && github.event.review.user.type != 'Bot'
      && (github.event.action != 'closed' || github.event.pull_request.merged)
      && (github.event_name != 'issue_comment' || contains(github.event.comment.body, '@manki') || contains(github.event.comment.body, '/manki') || contains(github.event.comment.body, '- [x] Force review'))
      && (github.event_name != 'issue_comment' || !contains(fromJSON('["FIRST_TIMER","FIRST_TIME_CONTRIBUTOR"]'), github.event.comment.author_association))
      && (!github.event.pull_request || github.event.pull_request.head.repo.full_name == github.repository)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - name: Manki Review
        uses: manki-review/manki@v6
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Keep the `on:`, `permissions:`, `concurrency:` and `timeout-minutes:` settings from the workflow above.

When CI runs in a separate workflow, `needs:` cannot order the jobs. List the check runs to wait for in `static_analysis.wait_for_checks` instead. Manki polls them on the PR head every 15 seconds and reads the results once each has finished. After `wait_timeout_seconds` (default 300) it stops waiting, reads what is there, and records the checks still running in the `Manki context` block. A name is the check run's name as the PR's checks list shows it, usually the job name.

```yaml
static_analysis:
  wait_for_checks: [lint, CodeQL]
  wait_timeout_seconds: 300
```

### Running Manki's analyzers

Manki can run analyzers itself. `actionlint`, `zizmor` and `shellcheck` are on by default, but each runs only when a file it checks changes, and only when CI does not run the same tool already. Manki's Rust rules for `ast_grep` are on by default in a Cargo repository (see below). The others are off by default, for a repository without CI checks. Turn them on or off in `.manki.yml` on the base branch:

```yaml
static_analysis:
  analyzers:
    ast_grep: true
    secrets: true
    dependencies: true
    semgrep:
      rules: [.semgrep/manki.yml]
    shellcheck: false
```

`analyzers: all` turns on every analyzer that needs no rules from you, including ones later releases add. Semgrep only runs when you list rule files.

| Analyzer | Tool | What it checks |
|----------|------|----------------|
| `ast_grep` | [ast-grep](https://ast-grep.github.io) 0.51.1 | Manki's own rules in [`rules/ast-grep`](rules/ast-grep) (MIT licensed): code and shell injection, HTML sinks, disabled TLS checks and unsafe deserialization, plus error-prone patterns such as an async `forEach` callback, a comparison with `NaN` or a mutable default argument. Runs on the changed JavaScript, TypeScript and Python files. The Rust rules also run on a changed Rust file that has a `Cargo.toml` in its directory or one above it on the base branch, even without `ast_grep: true`: a narrowing `as` cast of a length, count or index, `unwrap` or `expect` on decoded input, `with_capacity` sized by a decoded length, a new `unsafe` block, and `==` on secret bytes. They report hints on added lines only, skip tests, benchmarks, examples and build scripts, and stop with `ast_grep: false`. |
| `secrets` | [gitleaks](https://github.com/gitleaks/gitleaks) 8.30.1 | Secrets on the lines the PR adds in any changed file, with gitleaks' default rules through Manki's [`rules/gitleaks.toml`](rules/gitleaks.toml). `gitleaks:allow` comments are ignored. |
| `dependencies` | [OSV-Scanner](https://github.com/google/osv-scanner) 2.7.0 | Known vulnerabilities in the packages of the changed lockfiles, such as `package-lock.json`, `pnpm-lock.yaml`, `go.mod` or `requirements.txt`, with Manki's [`rules/osv-scanner.toml`](rules/osv-scanner.toml). A result sits on the line that adds the package. |
| `semgrep` | [Opengrep](https://github.com/opengrep/opengrep) 1.33.1 | Your Semgrep rules on the changed files. List rule files in the repository, read from the base branch. Manki ships no Semgrep rules and never fetches registry rules such as `p/default`. `nosemgrep` comments are ignored. |
| `actionlint` | [actionlint](https://github.com/rhysd/actionlint) 1.7.12 | Mistakes in the changed workflow files under `.github/workflows`, such as invalid syntax, expression type errors or untrusted input in a `run` script. Uses `.github/actionlint.yaml` from the base branch when there is one, so self-hosted runner labels are known. Its shellcheck and pyflakes checks stay off. |
| `zizmor` | [zizmor](https://github.com/zizmorcore/zizmor) 1.32.0 | Security problems in the changed workflow files, such as template injection, dangerous triggers or excessive permissions. Runs offline, without the repository's zizmor config, and ignores `zizmor: ignore` comments. |
| `shellcheck` | [ShellCheck](https://github.com/koalaman/shellcheck) 0.11.0 | Bugs in the changed shell scripts: `.sh` and `.bash` files, and files without an extension, that start with a `sh`, `bash`, `dash` or `ksh` shebang. A `.sh` or `.bash` file without a shebang counts too. Reports down to `info`, without the repository's `.shellcheckrc`. |

The analyzers never run code from the PR. Manki reads the changed files through the API at the head commit and gives the tools the files, never a checkout. It never uses rules or config from the PR: each tool gets Manki's config or the rule files from the base branch, and the files a tool would read as its own config or ignore list, such as `.gitleaksignore` or `.semgrepignore`, are left out of what it scans. The tools run without the action's environment, so they never see a token.

Manki downloads each tool at the pinned version, checks it against its pinned digest (SHA-512 for the ast-grep packages from npm, SHA-256 for the release binaries), and caches it for the run. The ast-grep native module and its Python grammar load in process. ncc can only bundle the native module for the platform that builds `dist/`, so they load at run time. Builds are pinned for Linux and macOS (x64 and arm64) and Windows (x64). If a download fails, the platform has no pinned build or a tool fails, that analyzer is skipped with a warning and the review goes on.

`exclude_paths` keeps files away from the reviewers, and `ast_grep` and `semgrep` follow it. `dependencies` checks every lockfile the PR changes, including the ones the default `*.lock` pattern excludes, such as `yarn.lock` or `Cargo.lock`, within 10 MB per lockfile and 40 MB in all. `secrets` checks every changed file, since a PR can add its own `exclude_paths`, and for the same reason `actionlint`, `zizmor` and `shellcheck` check every changed workflow or shell script. A result on an excluded file has no inline thread, so it is listed in the review body.

Analyzer results follow the path of the CI results above, limited to lines of the diff. `actionlint`, `zizmor` and `shellcheck` keep only results on the lines the PR adds or changes, so a problem the PR did not touch is never raised.

Manki skips `actionlint`, `zizmor` or `shellcheck` when CI already runs it: when a workflow on the base branch names the tool outside a comment, or a check run on the base branch's head commit has the tool's name in its name. The PR can change neither, so a job it adds cannot turn a tool off. The `Manki context` block records the skip. Since no CI shows them to the author, every result goes to the judge as a candidate finding, and a reviewer finding on the same line is never dropped for it. A result the judge keeps is posted with the tool in its label, such as `⚠️ **Warning** (gitleaks):`. A clean run posts nothing. The `Manki context` block records each enabled analyzer under `staticAnalysis.analyzers`, with how many results it found or why it was skipped.

## Webhook mode (opt-in, new in 6.1)

Webhook mode is a preview in 6.1 and off unless you opt in. The event-driven workflow from Step 3 keeps working unchanged.

The service only handles repositories that its operator has added to an allowlist (`WEBHOOK_REPOS` in the token service). It ignores the events of every other repository, so those keep the event-driven workflow. Webhook mode opens to more repositories once the service has protections against floods of requests.

In the default setup, GitHub starts a workflow run in your repository for every push, comment and review, and the job `if` skips the ones Manki ignores. In webhook mode the Manki GitHub App receives those events instead. The Manki service filters them, puts them in order for each PR, and starts a run of a dispatch-only workflow in your repository for each event Manki acts on. The run uses your runner and your secrets, as before. The service only orders and starts runs: every decision about a review, a reply or an approval stays in the action.

### What changes for you

- **No run for an event Manki ignores.** A comment without a mention, a bot's push or a PR closed without merging never starts a workflow run, so the Actions tab and the PR checks show no skipped runs for them.
- **Events run in order.** Each PR has two queues. Reviews, thread replies, `check` and `dismiss` run one at a time in the order they arrived, and several pushes during a review become one review of the newest head. `explain`, `help`, `remember`, `forget` and free questions run one at a time in a second queue beside it, so a question never waits behind a review. The service replaces the `concurrency` block.
- **Every run uses the current version.** The service always starts the workflow on the default branch, so reviews, comment commands and thread replies all run the Manki version pinned there. In the event-driven setup, pushes, reviews and thread replies run the workflow from the PR's merge commit, so a PR that changes the workflow runs its own version for them. PR comments already run the workflow on the default branch.
- **A `Manki` check on the PR.** In webhook mode every run belongs to the default branch, so its job shows on no PR. Manki creates a check named `Manki` on the PR head instead. It shows in progress during a review, links to the run, and ends with the result: success when Manki approves, failure when it requests changes or needs a human, or when the review is incomplete or the run fails, neutral when it holds its approval because the PR conflicts, cancelled when a newer push replaces the review, and action required when the diff is too large to review or automatic review is paused. This needs the App's **Checks: read and write** permission. Until your installation approves it, the PR shows no Manki check and each review logs a warning, so don't require one before then. Once it shows, you can require the `Manki` check in branch protection.
- **Resolving a thread can approve the PR.** GitHub Actions cannot start a run when someone resolves a review thread, so in the event-driven setup Manki only approves after a later event. In webhook mode, resolving the last open thread by hand runs the auto-approve check at once.
- **Missed events come back.** Every 5 minutes the service retries the deliveries GitHub failed to hand over and queues a review for any open, non-draft PR from your repository whose head has no Manki review yet.

Fork PRs work as before: a push to a PR from a fork starts no review, and a review command in a PR comment still reviews it.

### What the Manki App needs

The Manki maintainers set up the App's webhook, the **Actions: read and write** and **Checks: read and write** permissions and the **Workflow run** event once for every installation. The webhook receives the events of every installation, with their payloads such as PR titles, PR bodies and comment text, and the service drops the events of repositories that have not opted in. Actions write lets the App start, cancel and rerun workflow runs in the repositories it is installed on. The service uses it to start `manki-dispatch.yml`, and the Workflow run event tells it within seconds that a run ended, so it can start the next one in that PR's queue. Checks write lets Manki create and update its `Manki` check on your PRs.

A new App permission only takes effect once each installation approves it. GitHub emails the owner of every installation and shows the request on the App's installation settings, where the owner accepts it. Until then the service cannot start runs in your repositories, so keep the event-driven workflow until you have approved the Actions permission. Without the Checks permission, reviews run as usual and only the `Manki` check is missing.

### Opting in

Only opt in once your repository is in the preview. Outside it, removing the event-driven workflow stops all reviews, since the service starts no runs.

Once the installation owner has approved the Actions permission, add `.github/workflows/manki-dispatch.yml` to the default branch:

```yaml
name: Manki dispatch
run-name: 'Manki ${{ inputs.event }}.${{ inputs.action }} on #${{ inputs.pr }} (${{ inputs.delivery_id }})'

on:
  workflow_dispatch:
    inputs:
      event: { type: string, required: true }
      action: { type: string, required: true }
      pr: { type: string, required: true }
      head_sha: { type: string, required: false }
      comment_id: { type: string, required: false }
      review_id: { type: string, required: false }
      delivery_id: { type: string, required: false }

permissions:
  contents: read
  pull-requests: write
  issues: write
  id-token: write
  actions: read

jobs:
  review:
    timeout-minutes: 30
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: '24'
      - name: Manki Review
        uses: manki-review/manki@v6
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

The job has no `if` and no `concurrency` block, since the service filters and orders the events. It needs no checkout: Manki reads the PR's `.manki.yml` at the head commit through the API. The example uses `anthropic_api_key`. Pass the same inputs to the Manki step as in your Step 3 workflow, such as another provider's credential from the [workflow examples per provider](#workflow-examples-per-provider) or `memory_repo_token`, and keep any CLI install steps it has. Otherwise reviews stop once `manki.yml` is gone.

Keep the file name `manki-dispatch.yml`, since the service starts the workflow by that name.

Then delete the event-driven workflow, `.github/workflows/manki.yml`, from the default branch. Webhook mode starts once it is gone. The service only dispatches when the default branch has the dispatch workflow and no event-driven Manki workflow. With both present, it starts nothing for the repository and logs why, while the event-driven workflow keeps handling every event. Otherwise each event would run twice. Doing both in one change works as well.

The inputs carry only the event kind and its ids. Manki reads the PR, comment or review itself and checks that it belongs to the PR, so a dispatch cannot hand it anything else. Anyone with write access can also start the workflow by hand, for example to run a review again:

```bash
gh workflow run manki-dispatch.yml -f event=pull_request -f action=synchronize -f pr=<number> -f head_sha=<full head SHA>
```

A run started by hand is not queued by the service, so it can overlap a dispatched run. The in-app lock described under [Concurrency](#concurrency) still stops two reviews of the same commit.

### Switching back

Put the event-driven workflow from [Step 3](#step-3-add-the-workflow) back on the default branch. From then on the service sees both workflows and starts nothing, and the event-driven workflow takes over at once. Delete `manki-dispatch.yml` afterwards, or keep it to switch again later.

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

# PRs that get no automatic review (default: none). Read from the base branch
# only, so a PR cannot skip itself. Labels and authors compare case-insensitively,
# branches are glob patterns on the head branch. Label and branch rules skip only
# branches in the repo itself, never a fork's.
# A skipped check passes a required status check. See "Skipping PRs" below.
# skip_labels: ["dependencies"]
# skip_authors: ["dependabot[bot]", "renovate[bot]"]
# skip_branches: ["dependabot/**"]

# Maximum diff size before skipping (default: 50000 lines)
max_diff_lines: 50000

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
# branch, never from the PR. See "Review groups" below.
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
# See "Reading CI results" and "Running Manki's analyzers" above.
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

See [`.manki.yml.example`](.manki.yml.example) for the full reference with defaults.

### Skipping PRs

`skip_labels`, `skip_authors` and `skip_branches` name PRs that get no automatic review, such as dependency bumps from a bot. Manki reads them from `.manki.yml` on the base branch only, so a PR that edits them cannot skip itself. A PR that matches any rule gets no review, no comment and no approval. In webhook mode its `Manki` check completes as skipped. A `@manki review` comment still reviews it.

A skipped check passes a required status check, so a branch protection rule that requires `Manki` lets a skipped PR merge without a review. Use rules that only trusted actors can meet. GitHub sets the author, so `skip_authors` for bot accounts is the safest. It skips an event only when its sender is a listed author too, so a person who pushes to a bot's PR still gets a review. A label or branch rule matches only PRs whose head branch is in the repo itself, never a fork's. A fork's author can name a branch freely and keep pushing after a label is added, for example by a path-based labeler. Anyone with write access can still pick a matching branch name or add a skip label.

### Review pipeline

Manki reviews run in these stages:

1. **Planner** (pre-review) -- A fast Haiku pass answers three questions about the nature of the change, never its line count, plus the judge effort and PR type. `trivial`: could a defect hide here at all? A trivial change (docs, a rename or move, a repeated mechanical edit, dead code, fixtures) is read by a single **quick check**. The planner sees only the list of changed files, never the PR title, description or diff text, and Manki believes a `trivial` answer only when every changed file is docs, snapshots or generated, deleted, or renamed without edits. A change to tests alone is not trivial: one finder reads it. `subtle`: does judging it need reasoning about behavior? That sets the finders' effort to high, otherwise medium. `paired`: could a defect reach a user if every reader missed it? That adds a second finder. A missing or unclear answer, a timeout or a disabled planner takes the side that adds review: two finders at high effort. A diff that touches a security-sensitive path (auth, tokens, secrets, crypto, sessions, permissions and similar), CI or automation (`.github/workflows/**`, `.github/actions/**`, `action.yml`), a dependency or toolchain manifest (`package.json`, lockfiles, `Cargo.toml`, `go.mod`, `pyproject.toml`, `requirements*.txt`, `Gemfile`, `*.gemspec`, `rust-toolchain*`, `.nvmrc`, `Dockerfile*`), or a data contract (`migrations/**`, `*.sql`, `*.proto`, `schema.*`, `openapi*.yml`, `openapi*.yaml`, `openapi*.json`) is never trivial and always paired, whatever the planner or `planner.paired` say. Each round is triaged fresh. See [Review groups](#review-groups) for how the answers and paths pick the readers.
2. **Finders** -- One finder on `models.reviewer`, plus on paired rounds a second on `models.reviewer_pair`, read the diff in parallel with the same prompt: correctness first, then security, error paths, tests that cannot fail and contract breaks, plus any `reviewers:` entries. Without `models.reviewer_pair` the second finder runs on the other Claude tier (Sonnet with Opus), which needs no extra credential. Another provider is used only when you set it. If either finder fails after its retry, the round ends incomplete and never approves.
3. **Dedup**: A two-tier dedup pass filters findings already posted on the PR before judge evaluation. A static matcher handles exact/near-exact matches, then an LLM dedup pass (Haiku) catches semantic duplicates.
4. **Judge agent**: A single agent evaluates the deduplicated reviewer findings for accuracy, actionability, and severity. It filters out noise, merges any remaining overlap, and assigns a 4-tier severity to each surviving finding.
5. **Verdict reader**: Runs only when no finding blocks. One call on the judge's model reads the whole diff cold, without the PR description or earlier rounds, and looks for a reason not to merge. `READY` approves with "What this does" and "What to test" sections. `ADDRESS_FIRST` requests changes and posts its blockers as inline comments. Output that cannot be parsed ends the round as incomplete, never as an approval.
6. **Recap** -- Surviving findings are posted as inline PR comments with a summary review.

When a provider's safety filter refuses a stage, Manki sends that stage once more on `models.fallback`, which defaults to `models.reviewer`. A stage already on that model goes to its other Claude tier instead. The round context records the stage, the fallback model and the refusal reason under `models.fallbacks`. A second refusal ends the round incomplete, and other errors are never retried on the fallback model. A used-up subscription limit, quota or rate limit, or an overloaded provider, is neither retried nor sent to the fallback model. The round ends incomplete and names the limit, with its reset time when the provider gives one.

### Review groups

Each round sorts the PR into a **review class**, and the class picks a **review group**: the readers that run as finders. The class with the highest rank among those that match wins.

| Class | Rank | Matches | Built-in group |
|-------|------|---------|----------------|
| `security` | 100 | a security-sensitive path (`@security_paths`) | `pair` |
| `supply_chain` | 90 | CI, automation or a dependency or toolchain manifest (`@ci_dependency_paths`) | `pair` |
| `data_contract` | 80 | migrations, `*.sql`, `*.proto`, `schema.*`, OpenAPI files (`@data_contract_paths`) | `pair` |
| `behavior` | 50 | the planner answered `paired: true` | `pair` |
| `internal` | 30 | the planner answered `paired: false` | `solo` |
| `docs` | 20 | the planner answered `trivial: true` and every file is docs, snapshots or generated, deleted, or renamed without edits | `trivial` |

The built-in groups are `trivial` (the quick check on `models.reviewer` at medium effort), `solo` (one finder on `models.reviewer`) and `pair` (a finder on `models.reviewer` and one on `models.reviewer_pair`). Their effort is `auto`: high when the planner answers `subtle: true`, otherwise medium.

The progress comment names the class and group in its review header, such as `Review (security · pair)`. It names each reader by its model, the effort it ran at and the group's `focus` when one is set, such as `Claude Sonnet 5.5 · high` or `Claude Opus 5.5 · high · consensus rules`. The quick check shows as `Quick check · Claude Haiku 5.5`. A second reader with the same name gets ` #2`. The same names appear in failure lines, logs and the `Manki context` block.

`security`, `supply_chain` and `data_contract` are **floor classes**. Path rules decide them, so nothing in the PR's text can change them. A PR in a floor class always gets at least two finders on two distinct models, none at `low` effort. The floor is checked after routing: if the routed group misses it, the PR moves up to the floor class's own group, then to the built-in `pair` group. So a class of your own that outranks `security` cannot pull a PR that also touches auth into a weaker group.

The `review` block changes the groups and the routing:

```yaml
review:
  groups:
    deep:
      reviewers:
        - { model: claude-opus-5-5, effort: high }
        - { model: gpt-5.5, effort: high }
  routing:
    security: deep
    data_contract: deep
```

That minimal example sends security and data contract PRs to two strong readers on two providers and keeps the built-ins for the rest. A fuller one:

```yaml
review:
  default_group: pair
  groups:
    solo:
      reviewers: [{ model: "@reviewer", effort: auto }]
    pair:
      reviewers:
        - { model: "@reviewer", effort: auto }
        - { model: "@reviewer_pair", effort: auto }
    deep:
      reviewers:
        - { model: claude-opus-5-5, effort: high, focus: "authz, injection, secret handling" }
        - { model: gemini-3-pro, effort: high }
        - { model: claude-sonnet-5-5, effort: medium, focus: "error paths and rollback" }
  classes:
    security:                      # adds paths to the built-in rule, never narrows it
      match: { paths_any: ["src/billing/**"] }
    hot_path:
      rank: 85
      match: { paths_any: ["src/consensus/**", "src/net/**"] }
  routing:
    security: deep
    hot_path: deep
    internal: solo
```

- **`groups`**: each group lists its `reviewers`. A reviewer takes `model` (a model id, `provider/model`, or `@reviewer` and `@reviewer_pair`, which resolve through `models`; unset means `@reviewer`), `effort` (`low`, `medium`, `high`, `max` or `auto`, the default), an optional `focus` line added to that finder's prompt, and `role` (`finder`, the default, or `verifier` for the quick check). A group with the name of a built-in replaces it.
- **`classes`**: a new class needs a `rank` no other class has, and a `match` with `paths_any` (globs, or the `@security_paths`, `@ci_dependency_paths` and `@data_contract_paths` aliases), `triage` (`trivial`, `subtle` or `paired` set to true or false), or both. Every condition must hold. On `security`, `supply_chain` and `data_contract`, `match.paths_any` adds paths to the built-in rule. The other built-in classes cannot be changed.
- **`routing`**: the group per class. Classes you leave out keep their built-in group. When you set `groups` but no `routing`, every class goes to `default_group`, and the floors still apply.
- **`default_group`**: the group for a class with no route (default `pair`).
- **`allow_weaker`**: floor classes allowed to route to a group below the floor, such as `allow_weaker: [security]`. Without it, routing a floor class to a weaker group fails the run with the reason. Every round that runs below the floor logs a warning.
- **`critical`**: on a class of your own, marks its `match.paths_any` as a critical area, where any wrong result is severe even in a rare internal edge case. The judge sees which findings sit in a critical area and grades a wrong result there as severe damage, which blocks when the other blocker tests hold. A critical class takes paths only, no `triage`.
- **`outside_input`**: what counts as outside input in your repository, in a sentence or two. The judge treats a failure that this input can trigger as reachable, never as a rare internal case.
- **`examples`**: worked examples from your repository, one string each, under `blocker` for findings that block and `not_blocker` for findings that do not. Set either side or both. The judge reads them next to its built-in examples on the same two sides.

The last three only change how the judge grades findings. A repository with consensus code might set them like this:

```yaml
review:
  classes:
    consensus:
      rank: 70
      critical: true
      match: { paths_any: ["dash/src/consensus/**", "dash/src/blockdata/**"] }
  outside_input: >-
    Anything a network peer sends: P2P messages, blocks, transactions, headers
    and the length prefixes inside them.
  examples:
    blocker:
      - "Indexing `buf[len]` with a length read from a peer message panics on a short message."
      - "Changing the field order in a `consensus_encode` implementation changes the bytes on the wire, even when every test passes."
      - "An inverted weight comparison picks the wrong quorum member on every block."
    not_blocker:
      - "A debug log of a decoded message that leaves out the peer address: `suggestion`."
```

Each review's `Manki context` block records a `routing` object: the class, its rank and source, every matched class, the group and why it was picked, any floor and escalation, where the `review` block came from, a `configDigest` of the classes, groups and routes, and each reader's model, provider and effort. `reviewers.keptOnlyBy` counts the kept findings only one finder raised, per finder, and `keptByMany` those two or more raised.

Manki reads the `review` block from the PR's base branch only, like `static_analysis`, so a PR cannot weaken its own review. A PR that changes the block is reviewed with the base branch's, and the change applies after merge. A PR whose own block misses a floor fails, so a broken block never lands. When the base branch's config cannot be read, or its block is invalid or misses a floor, Manki uses the built-ins with a warning, never the PR's copy, so the PR that fixes it still gets reviewed. The models behind `@reviewer` and `@reviewer_pair` come from the PR's `models` block, except that a PR cannot put both finders of a pair on one model when the base branch's models give two: that round keeps the base branch's reviewer models.

`planner.paired` still works and is deprecated in favour of `routing`: `always` turns `paired` on before the PR is classified, and `never` turns it off, which routes `behavior` changes to the `internal` class and its group.

### Severity tiers

The judge assigns one of five severity levels to each finding:

| Severity | Meaning | Effect |
|----------|---------|--------|
| `required` | Must fix before merge | Blocks approval (REQUEST_CHANGES), posted as a review thread |
| `warning` | Should fix, but not blocking | Listed under "smaller fixes in this PR" in the review body, PR can still be approved |
| `suggestion` | Should fix, but not blocking | Listed in a collapsed section of the review body, PR can still be approved |
| `nit` | Minor style or preference issue | Listed in a collapsed "nitpicks" list in the review body, never as a thread, PR can still be approved |
| `ignore` | False positive or irrelevant | Dropped silently |

A finding is a blocker only when it passes five tests: the PR causes it (lines it adds, changes or removes), the failure can be named ("when X happens, Y goes wrong"), the damage is serious, the code proves it with cited lines, and the author would fix it (it is not a declared placeholder or a tracked TODO). Serious damage is wrong behaviour in normal use or from outside input, lost or corrupted data, a crash, hang or resource exhaustion from outside input, a security defect, memory unsafety or undefined behaviour, or a broken public contract with no migration. Wrong behaviour in a rare internal edge case is a warning. Degraded but correct behaviour is a warning, or a suggestion when rare. Missing tests, style, naming, docs, commit messages, performance without a crash, checks on trusted internal values and claims nobody could verify never block. Behaviour that is intended but surprising becomes a suggestion that asks about it. A later round keeps a finding's grade unless the code or the evidence changed.

Only `required` findings block, in every round. A `warning` is listed under "smaller fixes in this PR" in the review body instead of becoming a thread, so the round can approve. A blocker from the verdict reader blocks too. A security finding blocks only as a blocker: the judge grades a security defect that outside input can trigger as a blocker, and one it cannot settle stays a `warning`, which does not block.

From the second round, each finding is tagged as new or previously missed: new when it sits within a few lines of code the PR added since the last reviewed round, previously missed when an earlier round already reviewed that code. Manki compares the PR's own change at both rounds by line text, so a rebase or moved lines do not make reviewed code new. A blocker blocks wherever it sits. A smaller finding on reviewed code gets no thread and is listed under "Previously missed" in the review body. Each finding's `origin` in the round record says which it is. Manki also does not object to a change it asked for: a smaller finding on code that applies a fix an earlier round suggested is dropped, unless the judge finds the new code worse.

The review body leads with the verdict, then the findings. On an approval, "What this does" follows in at most two sentences, and "What to test" is collapsed. An inline finding shows its title, up to three sentences of what goes wrong and the fix, about 700 characters at most, and collapses the rest under "Details". Up to five warnings and suggestions on changed lines get inline threads, and the rest are listed in the body. Nitpicks never get a thread. Each review's round record stores `output.bodyLength` and `output.commentLengths`, the length of the body and of each comment it posted.

The PR author cannot dismiss a security blocker. Their own "agree" reply or resolving the thread leaves it blocking, and auto-approve waits for it. When the author resolves the thread, the next round reopens it once and replies to say why. It is cleared when someone else with write access resolves the thread or replies in agreement, or when the judge marks the thread addressed.

A PR author who is a repo admin may clear a security finding on their own PR, so a repo with a single maintainer is not stuck. They resolve the thread in the GitHub UI, or comment `@manki dismiss` in the thread. Manki checks admin and write permission through the GitHub API, because comments show an org owner, and an org member with read access, as a plain member. Every such override is recorded: Manki replies once in the thread with "Security finding dismissed by @<login> (repo admin).", the round context lists it under `recap.securityOverrides`, and an approval that relies on it names it in the review body. A reply of "Agreed." on a security thread that the replier may not clear says that the thread stays open.

Each round checks the open Manki threads against the push. When it confirms a fix in a file the push changed, it resolves the thread with a short "Fixed in" reply and the thread stops blocking. A blocker that a round names again while its thread is still open stays in that thread instead of getting a new one.

When a blocker comes back after a fix was claimed for it (its thread was resolved, someone replied in it, or Manki confirmed the fix), the review keeps requesting changes, lists the blocker under "Needs a human", and pauses automatic review. A blocker named again after a rebase, with its thread still open and unanswered, just stays open. The last automatic round, round `convergence.max_auto_rounds` (default 5) counted from Manki's last approval, approves when nothing blocks, or stops the same way when a blocker is still open. Rounds after an approval, such as on rebases, start the count again. An approval held because the PR conflicts with its base counts as an approval here, and so does auto-approve after the last blocking thread is resolved. That approval also ends a pause from a blocker that came back. Only rounds that reviewed a new change count, so another round on a change Manki already reviewed, such as a Force review of the same commit, does not. While automatic review is paused, its notice lists the blocking threads still open, with links. A push starts no review, but replies in threads, auto-approve after the last blocking thread is resolved, the Force review box and `@manki review` still work.

Use the `models` config section to choose different models for the finders and the judge (e.g., a faster model for the finders and a more precise model for the judge).

The judge treats two finders reporting the same defect as strong evidence that it is real, and one finder's silence as no evidence against the other's finding. Agreement never raises a finding's severity.

`review_level`, `review_thresholds` and `models.agents` from earlier releases still load, with a warning. The first two are ignored. The first model in `models.agents` that differs from `models.reviewer` becomes `models.reviewer_pair` when that is not set. `models.agents` will be removed in the next major release: set `models.reviewer_pair`, or name models in a review group.

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

With the manki-review App, Manki writes memory with the App's memory token, so no secret is needed. Without the App, set the `REVIEW_MEMORY_TOKEN` secret (see Step 2). A `memory_repo_token` that is set always wins over the App's token, so leave it unset when you use the App.

### How memory works

- **Learnings** -- Stored when you use `/manki remember` or when substantive review comment discussions are detected. Injected as context into future reviewer prompts.
- **Suppressions** -- Created by `/manki dismiss`. Non-blocking findings matching a suppression pattern are filtered out (blocking findings are never suppressed).
- **Patterns** -- Automatically tracked from recurring findings. After 5 occurrences a pattern is escalated for visibility.
- **Global conventions** -- A `_global/conventions.md` file applied to all repos using the memory system.
- **Fix rate** -- On each merge, one JSON line per PR is appended to `<repo-name>/metrics/fix-rate.jsonl` with the posted, fixed, dismissed and untouched findings per severity and first reviewer (the `counts` field), and per severity, judge confidence and tool evidence (the `calibration` field), plus the `class`, `group` and `configDigest` of the PR's last review round, so fix rates compare per class and group. A finding counts as fixed when the judge marked its thread addressed or the code at its lines changed before the merge. Turn it off with `metrics.fix_rate: false`. To read the totals, run `npm run fix-rate-report -- <path to fix-rate.jsonl> [more paths]` in a manki checkout, which prints one markdown table per dimension.

## Verification

After setup, create a test PR to verify everything works:

1. Create a branch with a small change
2. Open a PR
3. The Manki workflow should trigger automatically
4. Check the Actions tab for the review run
5. The PR should receive inline review comments and an APPROVE/REQUEST_CHANGES review

You can also trigger a review manually by commenting `/manki review` on any PR. Manki reviews each commit once. The command reviews the PR's current head when Manki has no complete review of it yet, and an incomplete or failed review does not count. On a head Manki already reviewed, it posts no review and replies with one notice that carries a Force review box. Only ticking that box reviews the same commit again.

## Security

Manki handles untrusted PR content and cross-repo tokens. The security model rests on these guarantees:

- **Prompt injection** — PR diffs are untrusted content passed into LLM prompts. All findings are sanitized before posting to GitHub so that embedded HTML, scripts, and `@mention` strings cannot be used to inject content or trigger notifications.
- **Token handling** — All secrets are masked in workflow logs via `core.setSecret()`. The App's review token covers only the reviewed repo and only reads its code. Memory writes use a separate token: `memory_repo_token`, or an App token that can write only the memory repo (`<owner>/review-memory` with the manki-review App). Your own App's private key needs more care, see [Your own GitHub App](#your-own-github-app). The provider CLIs get only the variables they need to run (`PATH`, `HOME`, temp folders, locale, `XDG_*`, the proxy settings including `ALL_PROXY` and `NODE_USE_ENV_PROXY`, and the CA settings), their own configuration and their own credential. The Claude CLI gets `ANTHROPIC_*`, `CLAUDE_CODE_*`, `DISABLE_*`, `VERTEX_REGION_*`, `CLAUDE_CONFIG_DIR`, `API_TIMEOUT_MS`, `MAX_THINKING_TOKENS`, `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`, `CLOUD_ML_REGION`, and the AWS region, profile, config file, role and web identity variables. The Codex CLI gets `OPENAI_*` and `CODEX_*`. The Gemini CLI gets `GEMINI_*`, `GOOGLE_*` and `VERTEX_*`. A variable named like a secret (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`, `*_CREDENTIALS` and similar) never reaches a CLI, so no other variable of the Manki step does either, whatever its name, and neither do the action inputs and the OIDC endpoint. The one exception is the credentials of a Claude setup that is on: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_BEARER_TOKEN_BEDROCK` with `CLAUDE_CODE_USE_BEDROCK`, `GOOGLE_APPLICATION_CREDENTIALS` with `CLAUDE_CODE_USE_VERTEX`, and `ANTHROPIC_AUTH_TOKEN` with `ANTHROPIC_BASE_URL`. They go to the Claude CLI only, and Manki redacts their values from everything it posts.
- **Memory access control** — Only people with write access to the repository can use `/manki remember`, `/manki forget`, and `/manki dismiss`. Commands from anyone else are ignored so memory cannot be poisoned by drive-by PRs.
- **Judge trust model** — The judge agent has final say on severity and can downgrade `required` to `ignore`. This is intentional: a single precise judge produces fewer false positives than trusting individual reviewers.
- **OIDC authentication** — When using the GitHub App identity, token service requests are authenticated via GitHub Actions OIDC tokens. The request is cryptographically proven to come from a legitimate workflow run, so no shared secret is exchanged between your workflow and the token service.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "spawn claude ENOENT" | Add the "Install Claude Code CLI" step before the action |
| "Claude subscription limit reached" or another quota message | The provider's limit is used up. Wait for the reset time the review names, or switch to another token or key |
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
| `REVIEW_MEMORY_TOKEN` | Fine-grained PAT for memory repo writes (only when the App can't write the memory repo, see [Review Memory Token](#review-memory-token-optional)) |
