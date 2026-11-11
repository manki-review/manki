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
  --checkout Kotlin/kotlinx.coroutines=$HOME/GIT/bench-repos/kotlinx.coroutines \
  --checkout python-attrs/attrs=$HOME/GIT/bench-repos/attrs \
  --checkout rack/rack=$HOME/GIT/bench-repos/rack \
  --checkout google/gson=$HOME/GIT/bench-repos/gson \
  --checkout valkey-io/valkey=$HOME/GIT/bench-repos/valkey \
  --checkout tokio-rs/tokio=$HOME/GIT/bench-repos/tokio \
  --checkout denoland/std=$HOME/GIT/bench-repos/deno-std \
  --checkout App-vNext/Polly=$HOME/GIT/bench-repos/polly \
  --checkout go-chi/chi=$HOME/GIT/bench-repos/chi \
  --checkout seredis/StackExchange.Redis=$HOME/GIT/bench-repos/StackExchange.Redis \
  --checkout vapor/vapor=$HOME/GIT/bench-repos/vapor"
```

Clone each in full with `git clone https://github.com/<owner/name>.git`. A blobless or shallow clone does not work, because the review fetches its workspace from this clone. A case's head is often a commit of a pull request that no branch holds any more. The bench names each commit it cannot find, and `git fetch origin <sha>` fetches it. For the rust-dashcore cases, fetch the fork's `test-base/<n>` and `test/<n>` branches. The Dash Core cases name the owner's fork `xdustinface/dash`, which shares its objects with the upstream repository, so a clone of the fork can fetch every upstream commit by SHA. The review reads `.manki.yml` from `base`, or the defaults when there is none, and the tools read a fresh copy holding only `head`, so no later fix commit is visible to them.

## Tuning and hold-out cases

The cases are split in two sets. `cases/` is the tuning set: develop and debug a change against it only. `holdout/` is the hold-out set: it is run before a release, and its score decides whether the release goes out (see `RELEASE.md`). Never read the hold-out cases while working on Manki, since a change tuned to them no longer shows how Manki does on code it has not seen.

`--holdout` runs both sets and scores them apart. The summary and the comparison table give one column per variant and set, so tuning that does not carry over shows as a gap between the two.

```sh
npm run bench -- $CHECKOUTS --holdout
```

Both sets mix repositories, languages and sizes: rust-dashcore (Rust), manki and token-service (TypeScript), the GitHub CLI (Go), Dash Core (C++), SwiftNIO and Vapor (Swift), Apache Commons Lang and Gson (Java), kotlinx.coroutines (Kotlin), attrs (Python), Rack (Ruby), Valkey (C), Polly and StackExchange.Redis (C#), Tokio (Rust), Deno std (TypeScript), chi (Go), and CI workflow changes. Each set holds clean cases. The five rust-dashcore replays are tuning cases, each as a first round and as a follow-up round (`rdc-<n>-r2`).

`npm run missed-blockers -- --repo <owner/name> [--last <n>]` drafts more cases from Manki's own misses. It reads the round records of the last merged pull requests and finds each round whose blockers sit on code the round before it had already reviewed (`origin: reviewed`), which no earlier round raised as a blocker. Each such earlier round becomes a draft in `bench/drafts/`: its commit is the head, its merge base with the base commit the pull request recorded is the base, and each missed blocker is a `must_catch` item. Each follow-up round also becomes a follow-up draft: its `prior_round` holds the latest of each finding the rounds before it posted, with each thread's state before the round and the grade the records last gave it. A thread an earlier round resolved is `fixed`. The round's own thread evaluations sort the earlier open threads: `must_resolve` lists those it resolved, `must_keep_open` those it found partly fixed, with what it said is left and the grade it kept, and `must_not_repeat` those it left open. A thread it resolved that a later round found again is also in `must_keep_open`. A record without thread evaluations falls back to Manki's replies, and a thread resolved at a time neither shows is left out. Body findings the round posted again are in `must_not_repeat`. A follow-up round with missed blockers gets one draft holding both. Run it on a repository Manki reviews, such as manki-review/manki or the owner's forks, since a case names its repository. A draft has `key_version: 0`. Check its items, severities and locations, then set `key_version` to 1 and move it to `bench/cases` or `bench/holdout`. The body is the pull request body as it was when the drafted round's review started, from its edit history. A body never edited is the same at any time, so it needs no date. For an edited body, when its version cannot be recovered or the round record holds no usable time or wall-clock time to date the review, the draft uses the body as it is now and says so in its header. References to repositories outside manki-review and the forks are written as plain text.

## On GitHub

The **Benchmark** workflow (`.github/workflows/bench.yml`) runs the bench without local clones. Start it from the Actions tab with **Run workflow**. Each case runs in its own job, four at a time. A job builds Manki at `ref`, fetches the case's commits in full (base, head and a follow-up case's earlier head), and runs that ref's `manki bench` on the case file of the workflow's own commit. The `report` job merges the case reports with `npm run bench-report -- merge`, writes the comparison table to its summary and uploads `report.json` as the `bench-report` artifact. Given the run ids of earlier runs in `baseline`, it also applies the release gate in `RELEASE.md`.

Each ref scores with its own bench code. After a change to the matcher, run the baseline's ref again rather than compare with an older report. To compare downloaded reports locally, run `npm run bench-report -- gate --baseline old.json --candidate new.json`.

### Unmatched blockers on tuning cases

A false blocker is either a wrong blocker or a real defect the key does not list. So the summary of a run with tuning cases, local or on GitHub, lists every blocker that matched no key item, by case and run. Check each against the code at the case's head. Add each real defect to the case's `must_catch` and bump its `key_version`, so the next run counts it as a find. Never grow a hold-out key this way: its cases are not read while working on Manki.

## Comparing setups

`--variant <name>=<file>` scores one setup: the YAML file holds config set on top of each case's config, where mappings merge key by key and any other value replaces. A case's config is its own `config:` block, or else its base `.manki.yml`. `--variant <name>` without a file runs that config as it is. Repeat it to score several setups on the same cases in one run. `--set <key.path>=<value>` sets one value, read as YAML, on top of every variant. Paths are relative to this checkout, since `npm run` starts there.

```sh
npm run bench -- $CHECKOUTS --variant base --variant opus-pair=bench/variants/opus-pair.yml
npm run bench -- $CHECKOUTS --set models.judge=claude-sonnet-5-5
```

Before the first review, every variant's config is loaded on every case. A variant whose overrides make a config invalid, or name a key the config does not know, stops the bench there, so no variant runs on the defaults or on the base setup by mistake. The bench exits 2 when a variant completes no review of one of the sets. The report holds one entry per variant, and the printed summary ends with a Markdown table that sets the variants side by side: recall, verdict accuracy, false blockers, unexpected warnings, extra findings, duplicates, incomplete runs, cost and wall time per run, and each key item's catch rate. After it come the unmatched blockers on tuning cases (see below). The matcher cache is shared, so the same findings are matched once.

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

### Follow-up cases

A follow-up case reviews a push that follows an earlier review. `prior_round` holds what that review posted, and `head` is the commit after the push. The bench hands the earlier round to the review in place of what a pull request round reads from GitHub: the earlier threads, with the code now at each open one, the earlier round record and the diff since that round. So a follow-up case runs offline like a first round. It tests the round given this earlier review, not two rounds in a row.

```yaml
prior_round:
  head: <full SHA>                       # the commit the earlier round reviewed
  findings:                              # each finding the earlier round posted
    - id: P1
      severity: blocker
      title: "The finding's title"
      file: path/to/file.rs
      line: 42
      grade_if_confirmed: blocker        # optional, the judge's grade if its doubt holds
      posted: thread                     # thread or body
      state: open                        # a thread's state before the push: open, resolved by a person, or fixed (resolved by a round)
      description: What goes wrong.      # optional, as the thread shows it
      how_to_fix: The fix in words.      # optional
      suggested_fix: replacement code    # optional
      security: true                     # optional, a security thread
must_resolve: [P1]                       # open threads the push fixes, which the round should resolve
must_keep_open:                          # open threads the push fixes only in part
  - id: P2
    severity: warning                    # the grade the leftover keeps
    mechanism: What is left of it.
    locations: [path/to/file.rs]         # optional, defaults to the thread's file
must_not_repeat: [P3]                    # earlier findings still in the code, which the round must not post again
must_catch: []                           # problems still in the code or brought in by the push, with their grades
```

An earlier open thread the key does not list should stay open. List an earlier finding the push leaves in place under `must_not_repeat`, unless the round should regrade it: then it is a `must_catch` item at the grade it earns. A ref older than follow-up support reviews such a case as a first round, so the release gate leaves out a case one side scored as a follow-up round and the other as a first round, and lists it.

### A case's own config

A case is reviewed with the `.manki.yml` its repository holds at the base. When a Manki release changes the config format, that file may no longer load. Such a case gets a `config:` block that holds the same settings in the current format:

```yaml
# Overrides the repository's `.manki.yml` at the base, which no longer loads. Same settings in the current format.
config:
  instructions: Pay attention to the wallet code.
  review:
    critical_paths: ["wallet/**"]
```

The bench reviews the case with this block in place of the repository's file, and a variant's overrides are set on top of it. The block can drift from what the repository uses, so keep it to a translation and say in a comment above it that it overrides the repository's config. A ref that does not know `config:` ignores it and reads the repository's file. The block is the one place in a case file that may name a repository of the upstream organisation, since `related_repos` lists them. A linked `owner/repo#N` reference to another repository stays out of it too.

A case whose config does not load, its own or the repository's, gets no review. Each of its runs is recorded as `CONFIG_INVALID` with the reason and counts as incomplete, and the `Config invalid` row of the summary table names the case. So a config format change never drops a case without a trace, and the release gate decides nothing while a hold-out case is in that state, naming the case.

A new case comes from a merged pull request in a public repository. Its head is the commit a review saw before a later commit fixed the defect, and each `must_catch` item is checked against the code at that head, with the fixing commit in `fix`. A clean case is a pull request merged as first pushed, with no later fix to its code. Put a new case in the set that needs it more, and never move a hold-out case into tuning to debug it.

## Scoring

The matcher only sees findings in a file the item lists or naming one of its symbols. It grades the closest one MATCH (same root cause in the same code), PARTIAL (right code, vaguer or different mechanism) or NONE, and lists every finding that names the same defect. Recall counts MATCH only. Weighted recall gives blockers 3, warnings 2 and the rest 1, with half credit when the highest severity among the matching findings is one tier low and none below that. A run's verdict is correct when it blocks a case with a must-catch blocker or approves a clean case. On a follow-up case, an earlier blocker still in the code also asks for a block: a `must_keep_open` item graded blocker, a `must_not_repeat` item graded blocker whose thread is not resolved, or an open blocker thread the key does not resolve, since a pull request round blocks on it. A follow-up case with none of those and no `must_catch` or `must_keep_open` item should approve. A follow-up run also counts the earlier open threads it resolved, right when the key lists them in `must_resolve` and wrong otherwise, and its repeats: findings the matcher grades MATCH against a `must_keep_open` or `must_not_repeat` item. A repeat counts in none of the extra findings, the false blockers and the unexpected warnings. A finding graded PARTIAL there names another mechanism, so it counts as a new finding. Must-catch at grade counts a MATCH graded at the key's severity or above. Findings that match no item, neither a `must_catch` nor a `nice_to_have` one, count as extra, blocker findings among them as false blockers and warning findings as unexpected warnings, and further findings on an item already matched as duplicates. A run that fails or does not complete is listed with its reason and counts in no recall, verdict or catch rate. The matcher is tried twice before a finished review is given up, and such a run keeps its findings and cost. The command exits 2 when any variant completes no review of one of the sets. The report is saved after each case. Matcher decisions are cached in `bench/.matcher-cache.json` by the matcher prompt, the item and the findings it saw. A cache file that does not parse stops the bench with its path. Delete it to start a fresh one.
