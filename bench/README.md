# Recall benchmark

`npm run bench` reviews each case in `cases/` with the local review pipeline (`manki review`), matches the findings to the case's answer key with an LLM, prints recall per key item and severity, and writes a JSON report to `bench/results/`.

```sh
claude setup-token                      # prints a long-lived token for your Claude subscription
export CLAUDE_CODE_OAUTH_TOKEN=<that token>
npm ci
npm run bench -- --checkout xdustinface/rust-dashcore=/path/to/rust-dashcore            # every case, 3 runs each
npm run bench -- --checkout xdustinface/rust-dashcore=/path/to/rust-dashcore --case rdc-1295 --runs 1
```

The bench reads credentials only from environment variables, the same names the Action's secrets have. A `claude` login on its own is not enough. With `CLAUDE_CODE_OAUTH_TOKEN`, every Claude stage and the matcher run through the `claude` CLI on `PATH` (the pinned version is installed when none is found), and the finders get the read-only repository tools as in a pull request round. `ANTHROPIC_API_KEY` also works, but the API path has no repository tools, so its scores do not match production.

The seed set holds the five rust-dashcore replays. The misses #1163 is to collect are not cases yet, since that issue lists none so far.

Each case repo needs a local clone holding the case's `base` and `head` commits. For the rust-dashcore cases, fetch the fork's `test-base/<n>` and `test/<n>` branches. The review reads `.manki.yml` from `base`, and the tools read a fresh copy holding only `head`, so no later fix commit is visible to them.

## Comparing setups

`--variant <name>=<file>` scores one setup: the YAML file holds config set on top of each case's base `.manki.yml`, where mappings merge key by key and any other value replaces. `--variant <name>` without a file runs the base config as it is. Repeat it to score several setups on the same cases in one run. `--set <key.path>=<value>` sets one value, read as YAML, on top of every variant. Paths are relative to this checkout, since `npm run` starts there.

```sh
npm run bench -- --checkout xdustinface/rust-dashcore=/path/to/rust-dashcore \
  --variant base --variant opus-pair=bench/variants/opus-pair.yml
npm run bench -- --checkout xdustinface/rust-dashcore=/path/to/rust-dashcore --set models.judge=claude-sonnet-5-5
```

A config that the overrides make invalid fails the run before any model call, and it never falls back to the defaults. The report holds one entry per variant, and the printed summary ends with a Markdown table that sets the variants side by side: recall, verdict accuracy, false blockers, extra findings, duplicates, incomplete runs, cost and wall time per run, and each key item's catch rate. The matcher cache is shared, so the same findings are matched once.

## Case files

One YAML file per case:

```yaml
id: rdc-1295
repo: xdustinface/rust-dashcore          # owner/name of the clone holding base and head
source: rust-dashcore upstream PR 1295   # plain text, never a link or owner/repo#N to another repo
base: <full SHA>
head: <full SHA>                         # the PR's initial head, before any review
title: "PR title"
body: |
  PR description at the initial head.
key_version: 1                           # bump when the key changes
must_catch:                              # defects a review must report
  - id: K1
    severity: blocker                    # blocker, warning, suggestion or nitpick
    mechanism: What goes wrong and why.
    locations: [path/to/file.rs, symbol_name]
    fix: 095f7f208                       # optional: the commit that fixed it
nice_to_have: []                         # design, test, reuse and convention points
```

A case with no `must_catch` items is clean: a review of it should approve, and every finding counts as noise.

## Scoring

The matcher only sees findings in a file the item lists or naming one of its symbols. It grades the closest one MATCH (same root cause in the same code), PARTIAL (right code, vaguer or different mechanism) or NONE, and lists every finding that names the same defect. Recall counts MATCH only. Weighted recall gives blockers 3, warnings 2 and the rest 1, with half credit when the highest severity among the matching findings is one tier low and none below that. A run's verdict is correct when it blocks a case with a must-catch blocker or approves a clean case. Findings that match no item count as extra, blocker findings among them as false blockers, and further findings on an item already matched as duplicates. A run that fails or does not complete is listed with its reason and counts in no recall, verdict or catch rate. The matcher is tried twice before a finished review is given up, and such a run keeps its findings and cost. The command exits 2 when no run completed. The report is saved after each case. Matcher decisions are cached in `bench/.matcher-cache.json` by the matcher prompt, the item and the findings it saw. A cache file that does not parse stops the bench with its path. Delete it to start a fresh one.
