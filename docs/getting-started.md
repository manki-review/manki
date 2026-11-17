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
3. Under "Require status checks to pass", add `Manki` (the check Manki creates on the PR), and your CI checks such as `build`. With the Manki App, pick it (`manki-review`) as the source of `Manki`, so a check of that name from anything else does not count. With [your own App](#your-own-github-app), do not tie `Manki` to one App: the review's check comes from your App, and the service's checks for a skipped, paused or conflicting PR come from the Manki App
4. Under "Require pull request reviews before merging":
   - Set to 1 required review. Manki's APPROVE counts as a review
   - Check **"Dismiss stale pull request approvals when new commits are pushed"**

Require the review as well as the check when you rely on Manki to gate merges. The `Manki` check alone does not hold every PR, for two reasons. GitHub counts a skipped or neutral check as passed, and the check is neutral when Manki holds its approval: the PR conflicts, is a draft, has files no model read, a config file did not load, a warning waits for a fix or an accepted answer, or GitHub refused the approval. The check also sits on the head commit, so of two PRs with the same head commit, the one Manki does not review shows the check of the other, and its diff differs when the two have different base branches. The required review covers both cases, since Manki approves only a PR it reviewed.

> **Note**: If the action finds blocking issues, it posts REQUEST_CHANGES which blocks the merge. A warning thread holds the approval with a COMMENT review until the warning is fixed, tracked with its `Create an issue for this` box, resolved by someone with the role `author_clear_role` names, or answered in its thread with a reply Manki accepts. A reply Manki keeps the warning against lifts nothing. A security warning needs a fix or a maintainer's resolve. Suggestions alone still result in APPROVE.

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
| Issues | Read and write | Post progress comments; read linked issues for review context and search open ones for related work; file a finding as an issue when someone ticks its box |
| Actions | Read and write | Start the Manki workflow and follow its runs (see [What the Manki App needs](#what-the-manki-app-needs)). Set on the App by its maintainers, so you only approve it |
| Checks | Read and write | Show a `Manki` check on the PR. Set on the App by its maintainers, so you only approve it |

### Your own GitHub App

Manki can post as an App you create, with the `github_app_id` and `github_app_private_key` inputs. The manki-review App stays installed, since the service starts the runs through it. Manki limits the token it mints to the reviewed repo. The App's private key is a secret of the workflow, though. Any code that runs in that job can read the key and mint tokens for every repository the App is installed on. Keep that job to the steps Manki needs, or prefer the manki-review App, whose key stays in the token service.

## Step 2: Authentication Secrets

> **Do you need a GitHub token?** No. `github_token` defaults to the workflow's own token. Manki reviews and posts with the GitHub App's token (Step 1) as `manki-review[bot]`, and uses the workflow token only to read the dispatched event and CI results. When the token service times out, cannot be reached or answers with a server error, Manki tries once more. It does the same for an answer that does not come from the service itself, such as an error page of the network in front of it. The service's own answer that it has nothing for the run (HTTP 403 or 404) is not tried again. Neither is a call the service throttles (HTTP 429), since its limit counts per minute and the second try would come two seconds later. Without an App token, or when the service cannot tell it the PR's pause setting and ticked boxes, it fails the run and says so on the PR with the workflow token. Review memory of a public repo needs no token either: the token service keeps it in the central memory repository for you. Only a memory repo of your own, which a private repo needs, takes the `memory_repo_token` input, see [Review memory](memory.md).

### Choosing a provider

Manki supports Anthropic, OpenAI, and Gemini. You only need credentials for the provider(s) you actually use. The model ID in `.manki.yml` selects the provider automatically (`claude-*` routes to Anthropic, `gpt-*` and `o1`/`o3`/`o4`/... to OpenAI, `gemini-*` to Gemini), or use `provider/model` syntax to be explicit.

| Provider | API key input | OAuth input |
|----------|--------------|-------------|
| Anthropic | `anthropic_api_key` | `claude_code_oauth_token` (Claude Code CLI) |
| OpenAI | `openai_api_key` | `openai_oauth_token` (Codex CLI) |
| Gemini | `gemini_api_key` | `gemini_oauth_token` (Gemini CLI) |

The table lists action input names (lowercase, passed in `with:`). The corresponding GitHub secret is the uppercase version: `anthropic_api_key` reads from `secrets.ANTHROPIC_API_KEY`, and so on, as shown in the workflow examples below.

OpenAI models can also run on an endpoint of your own instead of OpenAI's servers. Set `openai_base_url` next to `openai_api_key` for that, see [OpenAI-compatible endpoint](#openai-compatible-endpoint).

#### Effort mapping

The `low | medium | high | xhigh | max` knobs map per provider as follows. Manki passes effort tiers per stage based on planner decisions and config.

| Effort | Anthropic | OpenAI reasoning models | Other OpenAI models | Gemini |
|--------|-----------|-------------------------|---------------------|--------|
| low    | adaptive, `effort: low` (4.5 models: no thinking) | `reasoning_effort: low` | (ignored, warning) | `thinkingLevel: LOW` (Gemini 3+), the model's default (2.5) |
| medium | adaptive, `effort: medium` (4.5 models: `budget_tokens: 5000`) | `reasoning_effort: medium` | (ignored, warning) | `thinkingLevel: MEDIUM` (Gemini 3+), `thinkingBudget: 5000` (2.5) |
| high   | adaptive, `effort: high` (4.5 models: `budget_tokens: 10000`) | `reasoning_effort: high` | (ignored, warning) | `thinkingLevel: HIGH` (Gemini 3+), `thinkingBudget: 10000` (2.5) |
| xhigh  | adaptive, `effort: xhigh` (4.6 models: `effort: high`, 4.5 models: `budget_tokens: 13000`) | `reasoning_effort: xhigh`, capped at the model's highest value | (ignored, warning) | same as `high` (collapsed) |
| max    | adaptive, `effort: max` (4.5 models: `budget_tokens: 16000`) | the model's highest value (see below) | (ignored, warning) | same as `high` (collapsed) |

OpenAI reasoning models are the o-series and GPT-5 onwards. For `max`, Manki sends the highest `reasoning_effort` the model accepts: `high` for o-series, `gpt-5` and `gpt-5.1`, `xhigh` for `gpt-5.2` to `gpt-5.5`, and `max` for `gpt-5.6` onwards. GPT-4 models (`gpt-4o`, `gpt-4.1`), `-chat` snapshots and `-pro` models do not accept effort, so Manki logs a warning and sends none. Via the Codex CLI (the OAuth path and an [endpoint of your own](#openai-compatible-endpoint)), the CLI then applies its own default effort. Via the API, effort has no effect. A tier above the model's highest value, such as `xhigh` on `gpt-5.1`, gets that value. Claude models before Opus 4.7 have no `xhigh`, so Manki sends `high` there, also through the Claude Code CLI. The `xhigh` and `max` tiers collapse silently to `high` for Gemini. Finder names, progress comments and round records show the tier the provider receives, so a finder on Claude Sonnet 4.6 asked for `xhigh` is listed as `high`. A model that takes no effort keeps the tier it was asked for. A deeper review steps the tier up, which adds no effort when the model receives the same value as before, such as `xhigh` on `gpt-5.5` or `high` on `gpt-5.1`. The run log and the progress comment then name the finders it added no effort for. Gemini 3 onwards takes `thinkingLevel` and rejects `thinkingBudget`, while Gemini 2.5 takes only `thinkingBudget`. The Gemini OAuth (CLI) path passes prompts through the Gemini CLI binary and does not support effort tiers. Use API key auth if you need thinking control on Gemini.

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

> **Where this login may be used:** this path signs the Codex CLI in with your ChatGPT account instead of an API key. [OpenAI's guide for this login in CI/CD](https://learn.chatgpt.com/docs/auth/ci-cd-auth) sets limits on it. Use it only on a private runner that you trust. Do not use it for a public or open-source repository. Prefer an API key: the guide recommends one for most CI/CD jobs, and describes this login as an advanced setup for work that has to run as your own Codex account. For a public repository, set `openai_api_key` instead.

> **Status: experimental for CI.** The Codex CLI keeps subscription auth in `auth.json` in its home folder and refreshes it during a run once the tokens are about 8 days old. A refresh rotates the tokens and writes them back to `auth.json`. Manki gives Codex a home folder of its own for each run, writes `auth.json` there from the secret, and deletes the folder when the run ends, also on a persistent self-hosted runner. A login the runner's own user keeps in `~/.codex` is never used or changed. The secret still holds the old tokens, so later runs fail to authenticate until you bootstrap again and re-upload the secret. Concurrent jobs, or a local Codex that refreshes the same login, invalidate it the same way. An API key has none of these problems.

If you have a ChatGPT Plus or Pro subscription and the Codex CLI installed:

1. Run `codex login` and complete the browser flow. This populates `~/.codex/auth.json`.
2. Bootstrap the secret from that file:
   ```bash
   cat ~/.codex/auth.json | base64 | gh secret set OPENAI_OAUTH_TOKEN --repo <owner>/<repo>
   ```
   The secret must be the base64-encoded contents of `~/.codex/auth.json`, which contains `tokens.access_token` and `tokens.refresh_token`. Re-run this step and re-upload the secret whenever Codex fails to authenticate in CI.
3. Manki installs the pinned Codex CLI when the runner has none. An install step in the workflow keeps that out of the review's time (see [Step 3](#step-3-add-the-workflow))

> **Security note:** The base64 encoding is for transport format only — it is not encrypted. Anyone with access to repository secrets can decode the full credential, including the refresh token, which grants ongoing access to your ChatGPT Plus/Pro subscription. If this secret is ever compromised, revoke the OAuth session immediately at [platform.openai.com/account/sessions](https://platform.openai.com/account/sessions). For production use, prefer the API key path (`OPENAI_API_KEY`), which can be rotated without affecting your account session.

#### OpenAI-compatible endpoint

Use this when your model access runs through an endpoint of your own: a company gateway, Azure OpenAI or a self-hosted OpenAI-compatible endpoint. With `openai_base_url` set, every OpenAI model call runs through the Codex CLI against that endpoint, authenticated with `openai_api_key`. The reviewers get the same repository tools as on the Codex subscription path.

The endpoint has to speak the OpenAI Responses API (`POST <base URL>/responses`), because that is what the Codex CLI sends. An endpoint that only offers Chat Completions does not work.

1. Add the endpoint's key as a repository secret:
   ```bash
   gh secret set OPENAI_API_KEY --repo <owner>/<repo>
   ```
2. Pass the key and the base URL to the action, as in the workflow example in [Step 3](#step-3-add-the-workflow). The base URL is the part before `/responses`, which usually ends in `/v1`. It must start with `http://` or `https://`, and it is no secret, so put no credential in it.
3. Name models the endpoint serves in `.manki.yml`. `gpt-*` and o-series IDs go to OpenAI by their name. Any other name needs the `openai/` prefix, such as `openai/my-deployment`.
4. Manki installs the pinned Codex CLI when the runner has none. An install step in the workflow keeps that out of the review's time.

`openai_base_url` needs `openai_api_key` and cannot be combined with `openai_oauth_token`, since a ChatGPT login works only on OpenAI's own servers. A run that uses an OpenAI model then fails with a message that names the problem. Manki writes no Codex config file and no login file for the endpoint. The key reaches the Codex CLI only (see [Security](security.md)).

The effort tiers follow the model's name as described above, so a model that is not named like an OpenAI reasoning model gets no effort tier, and the Codex CLI applies its own default. When the endpoint answers with a rate limit or a used-up quota, the stage fails with "OpenAI endpoint limit reached" and moves to its [fallback model](how-reviews-work.md#review-pipeline). The review ends incomplete with that message only when the stage cannot move: it has no fallback model, that model fails too, or the call uses repository tools and the fallback model has none.

When an answer from the endpoint fails part way, Manki continues the same Codex session, so nothing the reviewer already read is lost. The Codex CLI retries no failed answer itself on this path, because it would sit out any wait the endpoint names, however long. Manki pauses and resumes the session instead:

| What the Codex CLI reports | Pause before the resume |
|---|---|
| The connection closed, broke or went silent before the answer ended | None |
| The model is at capacity | 5 seconds before the call's first resume, 15 before its second, 30 before its third, 60 before each later one |
| A rate limit that names a wait, such as "try again in 3s" | The wait it names |
| The endpoint answered every try of a request with 429 and named no wait ("exceeded retry limit, last status: 429") | The same pauses as for a model at capacity |

A call resumes its session at most 8 times, and all of its runs and pauses stay inside the call's time limit. A resume is started only when the pause before it leaves the resumed run at least 30 seconds of that limit. Otherwise the call fails with the last error, as it does when the eighth resume fails. A resumed run that uses up the call's time after a model at capacity or a rate limit fails with that limit, not with a timeout. For a model at capacity the stage fails with "OpenAI model at capacity". A stage that fails this way moves to its [fallback model](how-reviews-work.md#review-pipeline). When it cannot move, a finder, the judge or the verdict reader ends the review incomplete, and `/manki review` starts it again later. Every other failure ends the call at once: a wrong key, an unknown model, a refusal, a used-up quota, a rate limit the provider words itself without naming a wait, and any other error the endpoint words itself. An HTTP 503 before the answer starts is still retried by the Codex CLI.

A resumed run has the same sandbox, model, effort and tools as the first one, and the reviewer's budget of tool calls counts across the runs. Each resume is one line in the log, such as `Codex stream failed (model at capacity). Resuming the session in 5s, resume 1 of 8.`

With a ChatGPT login the Codex CLI keeps its own retries, and Manki resumes nothing. While the provider asks the CLI to wait, the CLI waits, which can run a call into its time limit. The timeout message then says that the CLI was waiting on the provider. When the CLI gives up on a model at capacity, the stage fails with "OpenAI model at capacity" there too.

When the Codex CLI cannot reach the endpoint or OpenAI at all, for example because the connection is refused or the host name does not resolve, it prints `ERROR: Reconnecting... waiting for network` and tries again after a wait that grows to about a minute, without ever giving up. A run that prints nothing but that line for 2 minutes is ended, and the call fails as a failed connection without a resume, since the resumed run would wait for the same network. A finder that fails this way is retried once when [the round has the time](how-reviews-work.md#review-pipeline), and a call that ran out of its own time is not retried.

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
4. Manki installs the pinned Gemini CLI when the runner has none. An install step in the workflow keeps that out of the review's time (see [Step 3](#step-3-add-the-workflow))

> **Security note:** The base64 encoding is for transport format only — it is not encrypted. Anyone with access to repository secrets can decode the full credential, including the refresh token, which grants ongoing access to your Gemini Code Assist license. If this secret is ever compromised, revoke the OAuth session immediately at [myaccount.google.com/permissions](https://myaccount.google.com/permissions). For production use, prefer the API key path (`GEMINI_API_KEY`), which can be rotated without affecting your account session.

## Step 3: Add the Workflow

GitHub sends your repository's events to the Manki GitHub App. The Manki service drops the ones Manki ignores, puts the rest in order for each PR, and starts a run of your Manki workflow for each event Manki acts on. The run uses your runner and your secrets. The service orders and starts the runs. It starts no review that a skip rule, a draft, a pause or a conflict with the base branch rules out, and it answers `help` and applies the Pause and Cancel boxes itself. Every review, reply and approval is made in the action.

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
  issues: write           # post a note on the PR when the token service fails
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

The job has no `if` and no `concurrency` block, since the service filters and orders the events. It needs no checkout: Manki reads `.manki.yml` on the base branch, and the PR's copy at its head commit to check that it loads, through the API. The service finds the workflow by its `workflow_dispatch` inputs, so the file name is free. Keep the `run-name` line and the inputs as they are, and add no other trigger to the file: the service reads the PR from the run name, and skips a file with more triggers. No other workflow may run Manki on events such as `pull_request`: while one is on the default branch, the service starts nothing for the repository and logs why, since each event would otherwise run twice. A run that the service did not start gets no token from it and fails, unless it posts as [your own GitHub App](#your-own-github-app).

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

OpenAI Codex CLI OAuth (the install step is optional):

```yaml
      - name: Install Codex CLI
        # --ignore-scripts is safe: @openai/codex@0.166.0 ships a plain JS bin with no postinstall steps. Re-verify if you bump the version pin.
        run: npm install -g --ignore-scripts '@openai/codex@0.166.0'
      - name: Manki Review
        uses: manki-review/manki@v7
        with:
          openai_oauth_token: ${{ secrets.OPENAI_OAUTH_TOKEN }}
```

OpenAI-compatible endpoint (the install step is optional):

```yaml
      - name: Install Codex CLI
        # --ignore-scripts is safe: @openai/codex@0.166.0 ships a plain JS bin with no postinstall steps. Re-verify if you bump the version pin.
        run: npm install -g --ignore-scripts '@openai/codex@0.166.0'
      - name: Manki Review
        uses: manki-review/manki@v7
        with:
          openai_api_key: ${{ secrets.OPENAI_API_KEY }}
          openai_base_url: https://llm.example.com/v1
```

Gemini API key:

```yaml
      - name: Manki Review
        uses: manki-review/manki@v7
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
```

Gemini CLI OAuth (needs a Gemini Code Assist Standard or Enterprise license, the install step is optional):

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

Pair each workflow with matching `models:` and `review.groups` blocks in `.manki.yml`. The groups name the finders, and the built-in ones run on Claude models. For example:

```yaml
# OpenAI
models:
  planner: gpt-6-luna
  judge: gpt-6.1-sol
  dedup: gpt-6-luna
review:
  groups:
    trivial: [gpt-6.1-terra]
    solo: [gpt-6.1-terra]
    full: [gpt-6.1-terra, gpt-6.1-sol]
```

```yaml
# Gemini
models:
  planner: gemini-3.5-flash-lite
  judge: gemini-3.8-flash
  dedup: gemini-3.5-flash-lite
review:
  groups:
    trivial: [gemini-3.8-flash]
    solo: [gemini-3.8-flash]
    full: [gemini-3.8-flash, gemini-3-pro]
```

### Action inputs

The workflow above uses the only inputs most setups need: a provider credential (e.g. `anthropic_api_key`, `openai_api_key`, `gemini_api_key`, or one of the OAuth equivalents) and optionally `memory_repo_token`. `github_token` defaults to the workflow token, so set it only to read with a different token. Manki has one config file, `.manki.yml` at the root of the base branch, and reads no other path. The Manki service reads the skip rules and `drafts` from the same file to decide whether a run starts, and `auto_review` to decide whether a push gets a waiting check. To post as [your own GitHub App](#your-own-github-app), set `github_app_id` and `github_app_private_key`. `manki_token_url` points at a different token service. Such a service must send its own 403 and 404 answers with a JSON body that has an `error` string. Manki takes any other 403 or 404, such as one from a proxy in front of the service, for an unknown failure: it tries the call once more, and a read of the PR's state that fails again fails the run. See [`action.yml`](../action.yml) for the full input reference.

### Action outputs

The action exposes outputs you can chain into later workflow steps: `review_id`, `verdict`, `approval_held`, `findings_count`, `findings_json`, `severity_counts`, and `judge_model`. See [`action.yml`](../action.yml) for the source of truth on each output's shape and semantics.

`verdict` is `APPROVE` only when Manki approved the PR, `REQUEST_CHANGES` when the round found a blocker, and `COMMENT` otherwise. A round that would approve but has its approval held posts a `COMMENT` review, so `verdict` is `COMMENT` too. `approval_held` then names the first reason: `conflict` (the PR conflicts with its base), `draft`, `config` (a config file did not load), `unread` (no model read some changed files), `warnings` (a warning waits for a fix or an accepted answer) or `refused` (GitHub refused the approval, as when the repository does not allow GitHub Actions to approve pull requests). It is empty when the approval is not held, so a step that gates on `verdict == 'APPROVE'` never passes a PR whose approval is held. When GitHub refuses a request for changes, Manki posts a comment review, and `verdict` stays `REQUEST_CHANGES`, so a step that gates on it still fails.

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
# Fail the run when the judge requests changes. The `Manki` check already fails on the PR
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
  if: steps.manki.outputs.severity_counts != '' && fromJSON(steps.manki.outputs.severity_counts).blocker > 0
  run: gh pr edit "$PR" --add-label blocking-findings
  env:
    GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    GH_REPO: ${{ github.repository }}
    PR: ${{ inputs.pr }}
```

Only a run that posts a review sets the outputs. They are empty on a reply, a command or a review state check.

You can also forward `severity_counts` or `findings_json` to a metrics sink (Slack, Datadog, a dashboard) in a follow-up step.

### Events Manki handles

| Event | Purpose |
|-------|---------|
| `pull_request: [opened, synchronize]` | Auto-review on PR open and new pushes |
| `pull_request: [ready_for_review]` | A draft PR is marked ready. A head commit without a complete Manki review is reviewed (head SHA unchanged, so the planner sees the same diff a `synchronize` would have produced). On a head commit a draft review already covers, no round runs: Manki runs the approval check on that review and approves if nothing else holds the approval. Drafts get no automatic review unless `drafts: review` is set. A draft review never approves: a clean round is posted as a comment saying the approval is held until the PR is ready, and it does not count toward the round cap. The service starts that check as a run of its own (`pull_request` with the action `approval_check`), also while automatic review is paused or a skip rule matches, as for a resolved thread. For a PR from a fork, and for a head commit without a review while automatic review is off or paused, marking the PR ready starts nothing. Comment `/manki check` there, and Manki approves or says what holds the approval. With `auto_approve: false` the check approves nothing and the command says so: tick Review again in the settings block, and that round approves the PR if nothing holds the approval. The line a draft review posts names the step that applies |
| `pull_request: [closed]` | On merge, records how many posted findings were fixed, dismissed or left untouched when `memory.enabled` is true (see [Review memory](memory.md)). Closing without merging does nothing |
| `issue_comment: [created, edited]` | `/manki` commands on PRs and issues, and ticks in the settings block. PR-only: `review`, `check`, `explain`, `dismiss` and free-form questions. Available on both: `help`, `remember`, `forget`. |
| `pull_request_review_comment: [created, edited]` | Replies to review comment threads, and ticks of a finding's `Create an issue for this` box. A tick that resolves a thread runs the auto-approve check |
| `pull_request_review: [submitted, dismissed, edited]` | Auto-approve check when reviews change state, and ticks of a finding's issue box in Manki's review |
| `pull_request_review_thread: [resolved, unresolved]` | Auto-approve check when someone resolves the last open thread by hand. When the PR author resolves a blocker or security thread, Manki reopens it |

On a merged or closed PR the approval check does nothing, and a reply or a command is answered without resolving or reopening a thread, approving, or storing a dismissal or a learning from the thread. The fix rate of a merge is still recorded.

The service starts no run for anything Manki or another bot did, a PR closed without merging, or a comment that neither mentions Manki nor replies in a review thread. A comment mentions Manki with `/manki`, or with the older `@manki-review` or `@manki`. `/manki` is the form to write.

So a PR that a bot opens or pushes to, such as a Dependabot update, gets no automatic review and no `Manki` check. A person with write access can still ask for a review with `/manki review` in a PR comment. Where `Manki` is a required check, name the bot in `skip_authors`: its PRs then get a `Manki` check that completes as skipped, which passes (see [Skipping PRs](how-reviews-work.md#skipping-prs)).

Manki itself decides who can start it from a comment, on a PR, an issue or a review thread. A comment counts when its author has write access to the repository. Manki asks the GitHub API about every commenter, with the workflow's own `GITHUB_TOKEN`, since the role an event reports does not show write access: an org member with read access shows as `MEMBER`, and a private member with write access as `CONTRIBUTOR` or `NONE`. Anyone can comment on a public repository, so Manki checks the commenter before it fetches the App token, uses a provider credential or calls a model. It refuses without posting anything, and the run ends at once. A tick in the settings block, or in a finding's issue box, edits Manki's own comment, so Manki checks the person who ticked, who needs write access.

### What the service does

- **Events run in order.** Each PR has two queues. Reviews, thread replies, `check` and `dismiss` run one at a time in the order they arrived, except that a waiting thread reply runs before a waiting review or auto-approve check, for at most 5 minutes. A review that already shows its waiting `Manki` check, because its start is tried again, lets no reply go first. A command, or a reply in one of Manki's own threads, gets an eyes reaction as soon as it is queued, when GitHub shows its writer as the owner, a member or a collaborator of the repository. Anyone else Manki answers gets the reaction when the run starts. Several pushes during a review become one review of the newest head. `explain`, `remember`, `forget` and free questions run one at a time in a second queue beside it, so a question never waits behind a review. The service answers `help` on a PR itself, without a run.
- **A running review stops by itself on a new push.** It checks the PR head while it works, and when a new commit lands it stops within about 30 seconds, posts no verdict, and marks its progress comment superseded. The next run in the queue then reviews the new head. A run that receives SIGTERM, for example when the job is cancelled, stops writing to the PR.
- **A paused PR starts no push review.** After each review Manki tells the service the reviewed commit, the approval and whether automatic review is paused, by the round cap or by a blocker that came back. While it is paused, or the Pause box in the settings block is ticked, a push starts no run. Replies, thread resolutions and the boxes still do.
- **Every run uses the current version.** The service always starts the workflow on the default branch, so reviews, comment commands and thread replies all run the Manki version pinned there.
- **A `Manki` check on the PR.** Every run belongs to the default branch, so its job shows on no PR. A check named `Manki` on the PR head shows the review instead. The Manki service creates it right before it starts the review run, so it shows queued with the title "Waiting for a runner" until GitHub Actions gives the run a runner. It does so only when the head commit has no `Manki` check yet and an earlier run has told it that your Manki version takes the check over, so the first review after an upgrade to 7.5 gets no waiting check. A push with `auto_review` off gets none either. Manki then takes it over: it shows in progress during the review, links to the run, and ends with the result: success when Manki approves, failure when it requests changes or needs a human, or when the review is incomplete or the run fails, neutral when it holds its approval (the PR conflicts, is a draft, has files no model read, a config file did not load, a warning thread waits for a fix or an accepted answer, or GitHub refused the approval), cancelled when a newer push replaces the review or the run is cancelled, skipped when a skip rule matches, and action required when the PR must be rebased before a review, no model could read any changed file, the PR is too big for an automatic review or for any review, or automatic review is paused. A review that never starts ends the check as well: cancelled when a newer commit replaced its head or the PR was closed, failure when GitHub refused to start the run, and timed out when no runner picked the run up. A run that approves after a thread change, or finds nothing changed since the reviewed commit, shows the check already completed. A run that finds Manki's approval of the head standing reports it again as success, unless the newest `Manki` check on the head already passed. A run that ends because its head commit already has a review completes a waiting check with that review's verdict, under the summary "This commit already has a review.": success for an approval, failure for a request for changes, and neutral for an approval that a draft, a conflict or a warning thread holds now. It reports only what the review says and never a better result. When that review held its approval, the [approval check](how-reviews-work.md#severity-tiers) decides instead, as it does after a thread is resolved. A comment review counts as a held approval only when its own round record says so, since a request for changes that GitHub refused is posted as a comment too. While the check names a hold, which is a draft, a warning with or without a thread, files no model read, a config file that did not load, a conflict or a refusal by GitHub, the run reports neutral with that hold. Once nothing holds the approval, the check approves the PR and reports success. The run leaves the waiting check as it is when the record of a comment review cannot be read or names no held approval, when the approval check names no such hold, as for an open blocking thread, when the PR's head is no longer that commit, when `auto_approve` is off, when a newer review of another commit overrides an approval, or when it cannot read the PR, the config or the threads. The service then ends the waiting check as cancelled. Completing the check posts no comment on the PR. Only the approval check can, with its approval or the notice of a hold. This needs the App's **Checks: read and write** permission. Until your installation approves it, the PR shows no Manki check and each review logs a warning, so don't require one before then. Once it shows, you can require the `Manki` check in branch protection. The check sits on the head commit, so two PRs with the same head commit show the same `Manki` check.
- **One review per head commit.** Of a repository's open PRs with the same head commit on a branch of the repository itself, Manki reviews only the lowest numbered one. The other PR is told so, in the status line of its settings block or in a note, and shows the `Manki` check of the reviewed one. Nothing starts the held review on its own, also when the other PR closes or moves to another commit. A review command, a review box or a push to the held PR asks again, and the review then runs as on any other PR when the other PR no longer shares the head. Thread replies, other commands and auto-approve checks are not held, and a PR from a fork is neither held nor counted.
- **Resolving a thread can approve the PR.** Resolving the last open thread by hand runs the auto-approve check at once.
- **Missed events come back.** Every 5 minutes the service retries the deliveries GitHub failed to hand over and queues a review for any open, non-draft PR from your repository, updated in the last day and not opened by a bot, whose head has no Manki review yet.

`timeout-minutes: 30` ends a run that hangs, for example on a model call that never returns. A higher value gains nothing: the service cancels a run after 40 minutes, so the PR's queue moves on. A full review usually takes a few minutes. Manki cannot read the job's `timeout-minutes`, so it ends the model calls of a review 25 minutes after the action started and posts the round, incomplete when a stage did not fit (see [the round's time](how-reviews-work.md#review-pipeline)). With a lower `timeout-minutes`, GitHub can stop a slow review before it posts anything.

### Pull requests from forks

A push to a PR from a fork starts no review. Someone with write access can still ask for a review of a fork PR with a review command in a PR comment, and Manki reviews it like any other PR. Replies in its review threads, resolved threads, submitted or dismissed reviews and ticks of a finding's issue box start no run. So after a push, ask for the next review with a review command, which reviews the head commit unless Manki's newest review of it is complete. After resolving its threads, comment `/manki check`, and Manki approves or replies with what holds the approval. Manki ignores a comment from anyone else, including the fork PR's author (see [Events Manki handles](#events-manki-handles)).

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

The inputs carry only the event kind and its ids. Manki reads the PR, comment or review itself and checks that it belongs to the PR, so a dispatch cannot hand it anything else. The token service gives a token only to a run it started, so a run started by hand fails and says so on the PR. To start a review yourself, comment a review command, which reviews the head commit unless Manki's newest review of it is complete, or tick Review again in the settings block, which reviews the commit again.

Only with [your own GitHub App](#your-own-github-app), which needs no token from the service, can someone with write access start a run by hand:

```bash
gh workflow run manki.yml -f event=pull_request -f action=synchronize -f pr=<number> -f head_sha=<full head SHA>
```

The service does not queue such a run, so it can overlap a run the service started and review the same commit twice.

## Verification

After setup, create a test PR to verify everything works:

1. Create a branch with a small change
2. Open a PR
3. The service should start the Manki workflow
4. Check the Actions tab for the review run
5. The PR should receive inline review comments and an APPROVE/REQUEST_CHANGES review

You can also trigger a review manually by commenting `/manki review` on a PR. Write `/manki` and never `@manki`, which still works but notifies an unrelated GitHub user each time. Manki reviews each commit once. The command reviews the PR's current head unless Manki's newest review of it is complete. An incomplete or failed review does not count, also when it follows a complete review of the same commit, and neither does a round in which no model could read a file. On a head whose newest review is complete, it posts no review. Manki replies that the command started no round, and the settings block shows the head as up to date. Ticking Review again there reviews the same commit again. Both also work while automatic review is off or paused, when a push starts no review.

Manki's newest progress comment ends with a settings block. It holds a status line, such as "Last reviewed `abc1234` · head `def5678` · review running" or "up to date", and the boxes that apply to the PR: Pause automatic reviews, Review again, Deeper review, Cancel this review while a review runs, and Review this draft on a draft. Pause stays ticked until someone unticks it. Review again, Deeper review and Review this draft start one review each, and Cancel this review stops the running one. Review again reviews the current commit now, also while automatic review is paused or the PR is too big for automatic review, and counts every finding as new code, so it also posts the suggestions a later round otherwise leaves out. Deeper review runs two finders on every group, moving a group with fewer than two finders up to the `full` group, and runs each finder at xhigh effort, or one level above its configured effort when that is set. It never lowers a finder's effort: a finder the earlier group already had keeps that group's effort when it is higher, such as `max`. While a review runs, Deeper review cancels it and starts the deeper review on the current commit right away. Review again does nothing while the running review is on the current commit, and the status line says it is already reviewing that commit. When commits came in since that review started, Review again cancels it and starts again. A cancelled review shows in its progress comment as replaced. The block moves to the newest progress comment, and older comments lose it. A run on a head whose last run failed deletes that failed comment once it has posted its own, so a head shows at most one failure. A PR paused by the round cap or too big for automatic review gets no separate notice: the status line says so, and the block offers the box that reviews it. A push to a draft, unless the base branch sets `drafts: review`, or to a PR with Pause ticked starts no run at all. Review this draft or Review again reviews it on request. A PR above the hard size limit gets only the Pause box, since no box can review it.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Failed to install Claude CLI" | Manki downloads the pinned Claude Code CLI from the npm registry when the runner has none, about 160 MB. A download that fails or delivers no data for 20 seconds is tried again, three times at most, and all tries together have 4 minutes. A self-hosted runner keeps the checked download in its tool cache, so later runs on it need none. Allow that download, or install the `claude` CLI on the runner before the action, which also saves the download where none is kept |
| "Claude subscription limit reached" or another quota message | The provider's limit is used up, and the stage's fallback model could not take over. Wait for the reset time the review names, switch to another token or key, or set `models.fallback` to a model of another provider or account. A stage that uses repository tools moves only to a model on the Claude or Codex CLI |
| "GitHub refused the APPROVE review" | GitHub did not let the App approve, so Manki posted the review as a comment that says so, and the `Manki` check is neutral with the title "Approval held: GitHub refused the approval". Check that the [GitHub App](#step-1-install-the-github-app) is installed on the repo with **Pull requests** read and write |
| Review says "Not reviewed" and lists skipped files | Every changed file matches `exclude_paths` or has no code to read, such as a binary, a Git LFS pointer or a submodule bump, so a person must review the PR. A `Cargo.lock`, `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` is read as a package list instead, unless Manki cannot parse it. Check `exclude_paths` in config if a file should be read |
| Memory not loading | The run log names the cause. With `memory.repo` set, pass `memory_repo_token` with Contents read/write on that repo. Without it, the token service must have started the run |
| No run starts | The Manki workflow must be on the default branch and declare the dispatch inputs, no other workflow may run Manki on events, and the repository's account must be one the service serves (see [Step 3](#step-3-add-the-workflow)) |
| "above the limit ... for automatic review" | Split the PR, tick Review again to review it in full, or raise `auto_review_max_lines` |
| "above the limit ... that Manki reviews" | Split the PR, or raise `max_diff_lines` |
| Auto-approve not working | `auto_approve` is on by default. Check that `.manki.yml` on the base branch does not set it to `false`. Comment `/manki check` on the PR, and Manki replies with what holds the approval |
| A finding has no line comment | Only a changed line can take one. A blocker or a warning on any other line, except a pre-existing warning, is posted as a comment on its file that links the line, or on the first changed file when its own file is not part of the PR. The others are listed in the review body |

## Known Limitations

### Runs use the workflow on the default branch

The service starts every run on the default branch. A PR that changes the Manki workflow or the pinned Manki version only takes effect for its own reviews once it is merged. The review content is still correct: the PR diff is fetched through the API. A change to `.manki.yml` also takes effect after merge, since every review reads it from the base branch.

## Quick Reference: All Secrets

Provide credentials for the providers you actually use. The model ID in `.manki.yml` picks the provider per stage (`claude-*` → Anthropic, `gpt-*` and `o1`/`o3`/`o4`/... → OpenAI, `gemini-*` → Gemini), or use `provider/model` syntax to be explicit. The action fails fast with a clear error if a configured provider's credentials are missing.

### Provider credentials

| Provider | API key | OAuth alternative |
|----------|---------|-------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) |
| OpenAI | `OPENAI_API_KEY` | `OPENAI_OAUTH_TOKEN` (base64 of `~/.codex/auth.json`). Experimental, and only for a trusted private runner, not for a public or open-source repository, see [where this login may be used](#codex-cli-oauth-token-subscription-experimental). |
| Gemini | `GEMINI_API_KEY` | `GEMINI_OAUTH_TOKEN` (base64 of `~/.gemini/oauth_creds.json`) |

When both are set for a provider, OAuth takes precedence (the action checks the OAuth input before the API key for each provider).

`openai_base_url` is no secret. It sends the OpenAI models to an [endpoint of your own](#openai-compatible-endpoint), with `OPENAI_API_KEY` as that endpoint's key, and it cannot be combined with `OPENAI_OAUTH_TOKEN`.

### Other

| Secret | Purpose |
|--------|---------|
| `REVIEW_MEMORY_TOKEN` | Fine-grained PAT for your own memory repo in `memory.repo` (see [Review memory token](memory.md#review-memory-token)) |
