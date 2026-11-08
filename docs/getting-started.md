# Getting started

Install Manki on a GitHub repository: the App, a provider credential and the workflow. Then [configure reviews](configuration.md) and, optionally, [review memory](memory.md).

## Prerequisites

- A GitHub repository
- Credentials for at least one provider (Anthropic, OpenAI, or Gemini)
- Repository admin access (for settings changes)

## Required Repository Settings

### Branch protection

**Required.** Without both settings below, an approval Manki gave on one commit still counts after the author pushes another, so the PR can merge before Manki reviews the new code.

1. Go to **Settings > Branches > Branch protection rules**, or a ruleset under **Settings > Rules**
2. Edit the rule for `main` (or your default branch)
3. Under "Require status checks to pass", add `Manki` (the check Manki creates on the PR), and your CI checks such as `build`
4. Under "Require pull request reviews before merging":
   - Set to 1 required review. Manki's APPROVE counts as a review
   - Check **"Dismiss stale pull request approvals when new commits are pushed"**

> **Note**: If the action finds blocking issues, it posts REQUEST_CHANGES which blocks the merge. Non-blocking suggestions still result in APPROVE.

When Manki posts a new review, it dismisses its own earlier REQUEST_CHANGES review. If a ruleset turns on **Restrict who can dismiss reviews** (in its **Require a pull request before merging** rule), add the App Manki posts as to the allowed actors: the Manki app, or your own App. Otherwise GitHub refuses the dismissal, and the old REQUEST_CHANGES keeps blocking the merge after Manki approves.

## Step 1: Install the GitHub App

Install the [Manki GitHub App](https://github.com/apps/manki-review) on the repositories you want reviewed. Manki reviews and posts with the App's token, as `manki-review[bot]`.

1. Go to [github.com/apps/manki-review](https://github.com/apps/manki-review)
2. Click **Install**
3. Select your account and choose which repositories to install on

The app requires these permissions:

| Permission | Access | Purpose |
|------------|--------|---------|
| Contents | Read and write | Read repository files and diffs. GitHub needs write to resolve a review thread, and the token Manki gets covers only the reviewed repo |
| Pull requests | Read and write | Post review comments and approvals |
| Issues | Read and write | Post progress comments; read linked issues for review context; file a finding as an issue when someone ticks its box |
| Actions | Read and write | Start the Manki workflow and follow its runs (see [What the Manki App needs](#what-the-manki-app-needs)). Set on the App by its maintainers, so you only approve it |
| Checks | Read and write | Show a `Manki` check on the PR. Set on the App by its maintainers, so you only approve it |

### Your own GitHub App

Instead of the manki-review App, Manki can post as an App you create, with the `github_app_id` and `github_app_private_key` inputs. Manki limits the token it mints to the reviewed repo. The App's private key is a secret of the workflow, though. Any code that runs in that job can read the key and mint tokens for every repository the App is installed on. Keep that job to the steps Manki needs, or prefer the manki-review App, whose key stays in the token service.

## Step 2: Authentication Secrets

> **Do you need a GitHub token?** No. `github_token` defaults to the workflow's own token. Manki reviews and posts with the GitHub App's token (Step 1) as `manki-review[bot]`, and uses the workflow token only to read the dispatched event and CI results. When the token service gives no App token, Manki tries once more, then fails the run and says so on the PR with the workflow token. Review memory needs no token either: the token service keeps it in the central memory repository for you. Only a memory repo of your own needs the `memory_repo_token` input, see [Review memory](memory.md).

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

> **Status: experimental for CI.** The Codex CLI keeps subscription auth in `~/.codex/auth.json` and refreshes it during a run once the tokens are about 8 days old. A refresh rotates the tokens and writes them back to `auth.json` on the runner. Manki deletes the `auth.json` it wrote when the run ends, also on a persistent self-hosted runner, and leaves alone one that was there before the run. The secret still holds the old tokens, so later runs fail to authenticate until you bootstrap again and re-upload the secret. Concurrent jobs, or a local Codex that refreshes the same login, invalidate it the same way. An API key has none of these problems, and [OpenAI's CI/CD auth guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth) recommends it for most CI jobs.

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

## Step 3: Add the Workflow

GitHub sends your repository's events to the Manki GitHub App. The Manki service drops the ones Manki ignores, puts the rest in order for each PR, and starts a run of your Manki workflow for each event Manki acts on. The run uses your runner and your secrets. The service only orders and starts runs: every decision about a review, a reply or an approval stays in the action.

The service only handles the repositories of the accounts its operator lists (`WEBHOOK_ACCOUNTS` in the token service), a user or an organization the App is installed on. It ignores the events of every other account, so ask the Manki maintainers to add yours. Manki runs through the manki-review service, and running your own copy of it is not supported yet ([#1091](https://github.com/manki-review/manki/issues/1091)).

Create `.github/workflows/manki.yml` on the default branch:

```yaml
name: Manki
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
  contents: read          # read repo files and diffs
  pull-requests: write    # post review comments and approvals
  issues: write           # post a note on the PR when the token service gives no token
  id-token: write         # OIDC token for GitHub App identity
  actions: read           # verify workflow run is legitimate
  # checks: read          # optional: read CI annotations, see "Reading CI results"
  # security-events: read # optional: read code scanning alerts

jobs:
  review:
    timeout-minutes: 30
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v7
        with:
          node-version: '24'
      - name: Manki Review
        uses: manki-review/manki@v7
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          # memory_repo_token: ${{ secrets.REVIEW_MEMORY_TOKEN }}  # Only with your own memory repo in `memory.repo`
```

The job has no `if` and no `concurrency` block, since the service filters and orders the events. It needs no checkout: Manki reads `.manki.yml` on the base branch, and the PR's copy at its head commit to check that it loads, through the API. The service finds the workflow by its `workflow_dispatch` inputs, so the file name is free. No other workflow may run Manki on events such as `pull_request`: while one is on the default branch, the service starts nothing for the repository and logs why, since each event would otherwise run twice. Manki fails a run that the service did not start.

#### Workflow examples per provider

Claude Code OAuth:

```yaml
      - name: Manki Review
        uses: manki-review/manki@v7
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
```

OpenAI API key:

```yaml
      - name: Manki Review
        uses: manki-review/manki@v7
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
```

OpenAI Codex CLI OAuth (requires the CLI on the runner):

```yaml
      - name: Install Codex CLI
        # --ignore-scripts is safe: @openai/codex@0.166.0 ships a plain JS bin with no postinstall steps. Re-verify if you bump the version pin.
        run: npm install -g --ignore-scripts '@openai/codex@0.166.0'
      - name: Manki Review
        uses: manki-review/manki@v7
        with:
          openai_oauth_token: ${{ secrets.OPENAI_OAUTH_TOKEN }}
```

Gemini API key:

```yaml
      - name: Manki Review
        uses: manki-review/manki@v7
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

Gemini CLI OAuth (requires the CLI on the runner and a Gemini Code Assist Standard or Enterprise license):

```yaml
      - name: Install Gemini CLI
        # --ignore-scripts is safe: @google/gemini-cli@0.66.0 has no install script of its own. Re-verify if you bump the version pin.
        run: npm install -g --ignore-scripts '@google/gemini-cli@0.66.0'
      - name: Manki Review
        uses: manki-review/manki@v7
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

The workflow above uses the only inputs most setups need: a provider credential (e.g. `anthropic_api_key`, `openai_api_key`, `gemini_api_key`, or one of the OAuth equivalents) and optionally `memory_repo_token`. `github_token` defaults to the workflow token, so set it only to read with a different token. To point at a config file outside the repo root, set `config_path` (default: `.manki.yml`). To post as [your own GitHub App](#your-own-github-app), set `github_app_id` and `github_app_private_key`. `manki_token_url` points at a different token service. See [`action.yml`](../action.yml) for the full input reference.

### Action outputs

The action exposes outputs you can chain into later workflow steps: `review_id`, `verdict`, `findings_count`, `findings_json`, `severity_counts`, and `judge_model`. See [`action.yml`](../action.yml) for the source of truth on each output's shape and semantics.

### Pinning the action version

Pin to a release tag or to the commit a release tag points to:

- `manki-review/manki@v7` is the floating major tag. It picks up minor and patch releases automatically. Recommended for most setups.
- `manki-review/manki@v7.0.0` is an exact release. It stays on that release until you bump it. Recommended when you want lockstep upgrades.
- `manki-review/manki@<sha>` is a full commit SHA, for organizations that require actions pinned to one.

`main` holds source only and has no built `dist/`, so `@main` or a commit SHA from `main` will not run. Each release tag points at a commit that contains the built `dist/`. For a SHA pin, take the commit of the release tag:

```sh
git ls-remote https://github.com/manki-review/manki 'refs/tags/v7.0.0^{}'
```

Then pin it with the version as a comment, so tools that update pins can read it:

```yaml
      - name: Manki Review
        uses: manki-review/manki@<sha>  # v7.0.0
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Manki publishes immutable releases: once a release is out, its tag can never move, so the SHA behind `v7.x.y` never changes. The floating `v7` tag keeps moving to each new release.

[Workflow lockfiles](https://docs.github.com/actions/concepts/security/workflow-dependency-lockfiles) are the alternative to SHA pins. Keep `@v7` in the workflow, and run the [`gh actions-lock`](https://github.com/github/gh-actions-lock) extension to record the commit it resolves to in `.github/workflows/actions.lock`. Commit that file. Actions then runs the recorded commit, even after the tag moves, until you regenerate the lockfile. A lockfile satisfies the policy that requires actions pinned to a full commit SHA for the workflows it covers, and Dependabot regenerates the entry when it bumps the version.

### Using outputs in downstream workflow steps

```yaml
# Fail CI when the judge requests changes
- uses: manki-review/manki@v7
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
  run: gh pr edit "$PR" --add-label blocking-findings
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PR: ${{ inputs.pr }}
```

You can also forward `severity_counts` or `findings_json` to a metrics sink (Slack, Datadog, a dashboard) in a follow-up step.

### Events Manki handles

| Event | Purpose |
|-------|---------|
| `pull_request: [opened, synchronize]` | Auto-review on PR open and new pushes |
| `pull_request: [ready_for_review]` | Auto-review when a draft PR is marked ready (head SHA unchanged, so the planner sees the same diff a `synchronize` would have produced). Drafts get no automatic review unless `drafts: review` is set. A draft review never approves: a clean round is posted as a comment saying the approval is held until the PR is ready, and it does not count toward the round cap |
| `pull_request: [closed]` | On merge, records how many posted findings were fixed, dismissed or left untouched (see `metrics.fix_rate` in [Configuration](configuration.md)). Closing without merging does nothing |
| `issue_comment: [created, edited]` | `/manki` commands on PRs and issues, and ticks in the settings block. PR-only commands: `review`, `check`, `explain`. Available on both: `help`, `dismiss`, `remember`, `forget`, and free-form questions. |
| `pull_request_review_comment: [created, edited]` | Replies to review comment threads, and ticks of a finding's "Create an issue for this" box |
| `pull_request_review: [submitted, dismissed]` | Auto-approve check when reviews change state |
| `pull_request_review_thread: [resolved, unresolved]` | Auto-approve check when someone resolves the last open thread by hand |

The service starts no run for anything Manki or another bot did, a PR closed without merging, or a comment that doesn't mention `@manki` or `/manki`.

Manki itself decides who can start it from a comment, on a PR, an issue or a review thread. A comment counts when its author has write access to the repository. Manki asks the GitHub API about every commenter, with the workflow's own `GITHUB_TOKEN`, since the role an event reports does not show write access: an org member with read access shows as `MEMBER`, and a private member with write access as `CONTRIBUTOR` or `NONE`. Anyone can comment on a public repository, so Manki checks the commenter before it fetches the App token, uses a provider credential or calls a model. It refuses without posting anything, and the run ends at once. A tick in the settings block, or in a finding's issue box, edits Manki's own comment, so Manki checks the person who ticked, who needs write access.

### What the service does

- **Events run in order.** Each PR has two queues. Reviews, thread replies, `check` and `dismiss` run one at a time in the order they arrived, and several pushes during a review become one review of the newest head. `explain`, `help`, `remember`, `forget` and free questions run one at a time in a second queue beside it, so a question never waits behind a review.
- **A running review stops by itself on a new push.** It checks the PR head while it works, and when a new commit lands it stops within about 30 seconds, posts no verdict, and marks its progress comment superseded. The next run in the queue then reviews the new head. A run that receives SIGTERM, for example when the job is cancelled, stops writing to the PR.
- **A paused PR starts no push review.** After each review Manki tells the service the reviewed commit, the approval and whether automatic review is paused, by the round cap or by a blocker that came back. While it is paused, or the Pause box in the settings block is ticked, a push starts no run. Replies, thread resolutions and the boxes still do.
- **Every run uses the current version.** The service always starts the workflow on the default branch, so reviews, comment commands and thread replies all run the Manki version pinned there.
- **A `Manki` check on the PR.** Every run belongs to the default branch, so its job shows on no PR. Manki creates a check named `Manki` on the PR head instead. It shows in progress during a review, links to the run, and ends with the result: success when Manki approves, failure when it requests changes or needs a human, or when the review is incomplete or the run fails, neutral when it holds its approval because the PR conflicts, cancelled when a newer push replaces the review, and action required when the PR is too big for an automatic review or for any review, or automatic review is paused. This needs the App's **Checks: read and write** permission. Until your installation approves it, the PR shows no Manki check and each review logs a warning, so don't require one before then. Once it shows, you can require the `Manki` check in branch protection.
- **Resolving a thread can approve the PR.** Resolving the last open thread by hand runs the auto-approve check at once.
- **Missed events come back.** Every 5 minutes the service retries the deliveries GitHub failed to hand over and queues a review for any open, non-draft PR from your repository whose head has no Manki review yet.

`timeout-minutes: 30` ends a run that hangs, for example on a model call that never returns. GitHub's default is 6 hours, and the PR's queue would wait behind it for that long. A full review usually takes a few minutes.

### Pull requests from forks

A push to a PR from a fork starts no review. Someone with write access can still ask for a review of a fork PR with a review command in a PR comment, and Manki reviews it like any other PR. Manki ignores a comment from anyone else, including the fork PR's author (see [Events Manki handles](#events-manki-handles)).

### Cache access

Every run the service starts belongs to the default branch, so a cache it saved would reach every branch. The workflow above uses no cache, so this changes nothing for it. If you add one, for example `cache: 'npm'` on `actions/setup-node` to speed up CLI installs, set `cache-mode: read` on the `review` job:

```yaml
jobs:
  review:
    cache-mode: read
```

Your CI on the default branch still writes the caches that Manki restores. Note that `cache: 'npm'` needs a lockfile (`package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`) in your repository.

### What the Manki App needs

The Manki maintainers set up the App's webhook, the **Actions: read and write** and **Checks: read and write** permissions and the **Workflow run** event once for every installation. The webhook receives the events of every installation, with their payloads such as PR titles, PR bodies and comment text, and the service drops the events of accounts it does not serve. Actions write lets the App start, cancel and rerun workflow runs in the repositories it is installed on. The service uses it to start your Manki workflow, and the Workflow run event tells it within seconds that a run ended, so it can start the next one in that PR's queue. Checks write lets Manki create and update its `Manki` check on your PRs.

A new App permission only takes effect once each installation approves it. GitHub emails the owner of every installation and shows the request on the App's installation settings, where the owner accepts it. Until then the service cannot start runs in your repositories. Without the Checks permission, reviews run as usual and only the `Manki` check is missing.

### Starting a run by hand

The inputs carry only the event kind and its ids. Manki reads the PR, comment or review itself and checks that it belongs to the PR, so a dispatch cannot hand it anything else. Anyone with write access can also start the workflow by hand:

```bash
gh workflow run manki.yml -f event=pull_request -f action=synchronize -f pr=<number> -f head_sha=<full head SHA>
```

The service does not queue a run started by hand, so it can overlap a run the service started and review the same commit twice. To review again, prefer a review command or Full review in the settings block.

## Verification

After setup, create a test PR to verify everything works:

1. Create a branch with a small change
2. Open a PR
3. The service should start the Manki workflow
4. Check the Actions tab for the review run
5. The PR should receive inline review comments and an APPROVE/REQUEST_CHANGES review

You can also trigger a review manually by commenting `/manki review` on any PR. Manki reviews each commit once. The command reviews the PR's current head when Manki has no complete review of it yet, and an incomplete or failed review does not count. On a head Manki already reviewed, it posts no review, and the settings block shows the head as up to date. Ticking Full review there reviews the same commit again.

Manki's newest progress comment ends with a settings block. It holds a status line, such as "Last reviewed `abc1234` · head `def5678` · review running" or "up to date", and the boxes that apply to the PR: Pause automatic reviews, Full review, Deeper review, Cancel this review while a review runs, Review this draft on a draft, and Force review while automatic review is paused or the PR is too big for automatic review. Pause stays ticked until someone unticks it. The other boxes start one run each. Full review counts every finding as new code. Deeper review runs two finders on every group, moving a group with one finder up to the built-in `pair` group, and runs each finder one effort level higher. The block moves to the newest progress comment, and older comments lose it. A PR paused by the round cap or too big for automatic review gets no separate notice: the status line says so, and the block offers the box that reviews it. A push to a draft, unless the base branch sets `drafts: review`, or to a PR with Pause ticked starts no run at all. Review this draft or Full review reviews it on request. A PR above the hard size limit gets only the Pause box, since no box can review it.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "spawn claude ENOENT" | Add the "Install Claude Code CLI" step before the action |
| "Claude subscription limit reached" or another quota message | The provider's limit is used up. Wait for the reset time the review names, or switch to another token or key |
| "Failed to post APPROVE review" | Check that the [GitHub App](#step-1-install-the-github-app) is installed on the repo with **Pull requests** read and write |
| Review says "Not reviewed" and lists skipped files | Every changed file matches `exclude_paths` or has no code to read, such as a binary, a Git LFS pointer or a submodule bump, so a person must review the PR. Check `exclude_paths` in config if a file should be read |
| Memory not loading | The run log names the cause. With `memory.repo` set, pass `memory_repo_token` with Contents read/write on that repo. Without it, the token service must have started the run |
| No run starts | The Manki workflow must be on the default branch and declare the dispatch inputs, no other workflow may run Manki on events, and the repository's account must be one the service serves (see [Step 3](#step-3-add-the-workflow)) |
| "above the limit ... for automatic review" | Split the PR, tick Force review to review it in full, or raise `auto_review_max_lines` |
| "above the limit ... that Manki reviews" | Split the PR, or raise `max_diff_lines` |
| Auto-approve not working | Check that `auto_approve: true` is set in `.manki.yml` |
| Inline comments land on wrong lines | The judge agent validated line numbers but the diff may have shifted. A blocking finding that is not on a changed line is posted as a comment on its file instead |

## Known Limitations

### Runs use the workflow on the default branch

The service starts every run on the default branch. A PR that changes the Manki workflow or the pinned Manki version only takes effect for its own reviews once it is merged. The review content is still correct: the PR diff is fetched through the API. A change to `.manki.yml` also takes effect after merge, since every review reads it from the base branch.

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
| `REVIEW_MEMORY_TOKEN` | Fine-grained PAT for your own memory repo in `memory.repo` (see [Review memory token](memory.md#review-memory-token)) |
