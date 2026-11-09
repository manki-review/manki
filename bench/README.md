# Recall benchmark

`npm run bench` reviews each case in `cases/` with the local review pipeline (`manki review`), matches the findings to the case's answer key with an LLM, prints recall per key item and severity, and writes a JSON report to `bench/results/`.

```sh
export CLAUDE_CODE_OAUTH_TOKEN=...
npm ci
npm run bench -- --checkout xdustinface/rust-dashcore=/path/to/rust-dashcore            # every case, 3 runs each
npm run bench -- --checkout xdustinface/rust-dashcore=/path/to/rust-dashcore --case rdc-1295 --runs 1
```

Each case repo needs a local clone holding the case's `base` and `head` commits. For the rust-dashcore cases, fetch the fork's `test-base/<n>` and `test/<n>` branches. The review reads `.manki.yml` from `base`, unless `--config` names another file, and the tools read a fresh copy holding only `head`, so no later fix commit is visible to them.

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

The matcher only sees findings in a file the item lists or naming one of its symbols. It grades the closest one MATCH (same root cause in the same code), PARTIAL (right code, vaguer or different mechanism) or NONE, and lists every finding that names the same defect. Recall counts MATCH only. Weighted recall gives blockers 3, warnings 2 and the rest 1, with half credit when the highest severity among the matching findings is one tier low and none below that. A run's verdict is correct when it blocks a case with a must-catch blocker or approves a clean case. Findings that match no item count as extra, blocker findings among them as false blockers, and further findings on an item already matched as duplicates. A run that fails or does not complete is listed with its reason and counts in no recall, verdict or catch rate. The matcher is tried twice before a finished review is given up, and such a run keeps its findings and cost. The command exits 2 when no run completed. The report is saved after each case. Matcher decisions are cached in `bench/.matcher-cache.json` by the matcher prompt, the item and the findings it saw.
