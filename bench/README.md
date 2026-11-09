# Recall benchmark

`npm run bench` reviews each case in `cases/` with the local review pipeline (`manki review`), matches the findings to the case's answer key with an LLM, prints recall per key item and severity, and writes a JSON report to `bench/results/`.

```sh
claude setup-token                      # prints a long-lived token for your Claude subscription
export CLAUDE_CODE_OAUTH_TOKEN=<that token>
npm ci
npm run bench -- $CHECKOUTS                                  # every tuning case, 3 runs each
npm run bench -- $CHECKOUTS --case rdc-1295 --runs 1
```

The bench reads credentials only from environment variables, the same names the Action's secrets have. A `claude` login on its own is not enough. With `CLAUDE_CODE_OAUTH_TOKEN`, every Claude stage and the matcher run through the `claude` CLI on `PATH` (the pinned version is installed when none is found), and the finders get the read-only repository tools as in a pull request round. `ANTHROPIC_API_KEY` also works, but the API path has no repository tools, so its scores do not match production.

## Local checkouts

Each case repo needs a local clone holding the case's `base` and `head` commits. `--checkout <owner/name>=<dir>` names each one:

```sh
CHECKOUTS="--checkout xdustinface/rust-dashcore=$HOME/GIT/rust-dashcore \
  --checkout manki-review/manki=$HOME/GIT/bench-repos/manki \
  --checkout manki-review/token-service=$HOME/GIT/bench-repos/token-service \
  --checkout cli/cli=$HOME/GIT/bench-repos/cli \
  --checkout xdustinface/dash=$HOME/GIT/bench-repos/dash \
  --checkout apple/swift-nio=$HOME/GIT/bench-repos/swift-nio \
  --checkout apache/commons-lang=$HOME/GIT/bench-repos/commons-lang \
  --checkout Kotlin/kotlinx.coroutines=$HOME/GIT/bench-repos/kotlinx.coroutines"
```

Clone each in full with `git clone https://github.com/<owner/name>.git`. A blobless or shallow clone does not work, because the review fetches its workspace from this clone. A case's head is often a commit of a pull request that no branch holds any more. The bench names each commit it cannot find, and `git fetch origin <sha>` fetches it. For the rust-dashcore cases, fetch the fork's `test-base/<n>` and `test/<n>` branches. The Dash Core cases name the owner's fork `xdustinface/dash`, which shares its objects with the upstream repository, so a clone of the fork can fetch every upstream commit by SHA. The review reads `.manki.yml` from `base`, or the defaults when there is none, and the tools read a fresh copy holding only `head`, so no later fix commit is visible to them.

## Tuning and hold-out cases

The cases are split in two sets. `cases/` is the tuning set: develop and debug a change against it only. `holdout/` is the hold-out set: it is run before a release, and its score decides whether the release goes out (see `RELEASE.md`). Never read the hold-out cases while working on Manki, since a change tuned to them no longer shows how Manki does on code it has not seen.

`--holdout` runs both sets and scores them apart. The summary and the comparison table give one column per variant and set, so tuning that does not carry over shows as a gap between the two.

```sh
npm run bench -- $CHECKOUTS --holdout
```

Both sets mix repositories, languages and sizes: rust-dashcore (Rust), manki and token-service (TypeScript), the GitHub CLI (Go), Dash Core (C++), SwiftNIO (Swift), Apache Commons Lang (Java), kotlinx.coroutines (Kotlin), and CI workflow changes. Each set holds clean cases. The five rust-dashcore replays are tuning cases.

`npm run missed-blockers -- --repo <owner/name> [--last <n>]` drafts more cases from Manki's own misses. It reads the round records of the last merged pull requests and finds each round whose blockers sit on code the round before it had already reviewed (`origin: reviewed`), which no earlier round raised as a blocker. Each such earlier round becomes a draft in `bench/drafts/`: its commit is the head, its merge base with the base commit the pull request recorded is the base, and each missed blocker is a `must_catch` item. Run it on a repository Manki reviews, such as manki-review/manki or the owner's forks, since a case names its repository. A draft has `key_version: 0`. Check its items, severities and locations, then set `key_version` to 1 and move it to `bench/cases` or `bench/holdout`. The body is the pull request body as it is now, and references to repositories outside manki-review and the forks are written as plain text.

## Comparing setups

`--variant <name>=<file>` scores one setup: the YAML file holds config set on top of each case's base `.manki.yml`, where mappings merge key by key and any other value replaces. `--variant <name>` without a file runs the base config as it is. Repeat it to score several setups on the same cases in one run. `--set <key.path>=<value>` sets one value, read as YAML, on top of every variant. Paths are relative to this checkout, since `npm run` starts there.

```sh
npm run bench -- $CHECKOUTS --variant base --variant opus-pair=bench/variants/opus-pair.yml
npm run bench -- $CHECKOUTS --set models.judge=claude-sonnet-5-5
```

Before the first review, every variant's config is loaded on every case. A variant whose overrides make a config invalid, or name a key the config does not know, stops the bench there, so no variant runs on the defaults or on the base setup by mistake. The bench exits 2 when a variant completes no review of one of the sets. The report holds one entry per variant, and the printed summary ends with a Markdown table that sets the variants side by side: recall, verdict accuracy, false blockers, extra findings, duplicates, incomplete runs, cost and wall time per run, and each key item's catch rate. The matcher cache is shared, so the same findings are matched once.

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
    source: owner /check review          # optional: who found it, when not the upstream review
nice_to_have: []                         # design, test, reuse and convention points
```

A case with no `must_catch` items is clean: a review of it should approve, and every finding counts as noise.

A new case comes from a merged pull request in a public repository. Its head is the commit a review saw before a later commit fixed the defect, and each `must_catch` item is checked against the code at that head, with the fixing commit in `fix`. A clean case is a pull request merged as first pushed, with no later fix to its code. Put a new case in the set that needs it more, and never move a hold-out case into tuning to debug it.

## Scoring

The matcher only sees findings in a file the item lists or naming one of its symbols. It grades the closest one MATCH (same root cause in the same code), PARTIAL (right code, vaguer or different mechanism) or NONE, and lists every finding that names the same defect. Recall counts MATCH only. Weighted recall gives blockers 3, warnings 2 and the rest 1, with half credit when the highest severity among the matching findings is one tier low and none below that. A run's verdict is correct when it blocks a case with a must-catch blocker or approves a clean case. Findings that match no item count as extra, blocker findings among them as false blockers, and further findings on an item already matched as duplicates. A run that fails or does not complete is listed with its reason and counts in no recall, verdict or catch rate. The matcher is tried twice before a finished review is given up, and such a run keeps its findings and cost. The command exits 2 when any variant completes no review of one of the sets. The report is saved after each case. Matcher decisions are cached in `bench/.matcher-cache.json` by the matcher prompt, the item and the findings it saw. A cache file that does not parse stops the bench with its path. Delete it to start a fresh one.
