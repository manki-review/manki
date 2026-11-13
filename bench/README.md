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
  --checkout vapor/vapor=$HOME/GIT/bench-repos/vapor \
  --checkout jestjs/jest=$HOME/GIT/bench-repos/jest \
  --checkout open-telemetry/opentelemetry-go=$HOME/GIT/bench-repos/opentelemetry-go \
  --checkout prometheus/prometheus=$HOME/GIT/bench-repos/prometheus"
```

Clone each in full with `git clone https://github.com/<owner/name>.git`. A blobless or shallow clone does not work, because the review fetches its workspace from this clone. A case's head is often a commit of a pull request that no branch holds any more. The bench names each commit it cannot find, and `git fetch origin <sha>` fetches it. For the rust-dashcore cases, fetch the fork's `test-base/<n>` and `test/<n>` branches. The Dash Core cases name the owner's fork `xdustinface/dash`, which shares its objects with the upstream repository, so a clone of the fork can fetch every upstream commit by SHA. The review reads `.manki.yml` from `base`, or the defaults when there is none, and the tools read a fresh copy holding only `head`, so no later fix commit is visible to them.

## Tuning and hold-out cases

The cases are split in two sets. `cases/` is the tuning set: develop and debug a change against it only. `holdout/` is the hold-out set: it is run before a release, and its score decides whether the release goes out (see `RELEASE.md`). Never read the hold-out cases while working on Manki, since a change tuned to them no longer shows how Manki does on code it has not seen.

A case file is named after its id, and the id alone says which set a case is in. A tuning case has a file in `cases/` and none in `holdout/`. Any other case counts as a hold-out case, also one that neither directory holds, and also when its file is read from another directory with `--cases`.

`--holdout` runs both sets and scores them apart. The summary and the comparison table give one column per variant and set, so tuning that does not carry over shows as a gap between the two.

```sh
npm run bench -- $CHECKOUTS --holdout
```

Both sets mix repositories, languages and sizes: rust-dashcore (Rust), manki and token-service (TypeScript), the GitHub CLI (Go), Dash Core (C++), SwiftNIO and Vapor (Swift), Apache Commons Lang and Gson (Java), kotlinx.coroutines (Kotlin), attrs (Python), Rack (Ruby), Valkey (C), Polly and StackExchange.Redis (C#), Tokio (Rust), Deno std and Jest (TypeScript), chi, opentelemetry-go and Prometheus (Go), and CI workflow changes. Each set holds clean cases. The five rust-dashcore replays are tuning cases, each as a first round and as a follow-up round (`rdc-<n>-r2`). Three tuning cases hold no code defect but a broken rule of the repository's instruction files: `jest-16342` and `otel-go-8805` lack a required changelog entry, and `prometheus-19043` carries two unrelated commits against a rule that asks for a separate PR. `bench/variants/rules-block.yml` sets `review.rules: block`, to count the rule blockers a run raises on the cases that follow their rules.

`npm run missed-blockers -- --repo <owner/name> [--last <n>]` drafts more cases from Manki's own misses. It reads the round records of the last merged pull requests and finds each round whose blockers sit on code the round before it had already reviewed (`origin: reviewed`), which no earlier round raised as a blocker. Each such earlier round becomes a draft in `bench/drafts/`: its commit is the head, its merge base with the base commit the pull request recorded is the base, and each missed blocker is a `must_catch` item. Each follow-up round also becomes a follow-up draft: its `prior_round` holds the latest of each finding the rounds before it posted, with each thread's state before the round and the grade the records last gave it. A thread an earlier round resolved is `fixed`. The round's own thread evaluations sort the earlier open threads: `must_resolve` lists those it resolved, `must_keep_open` those it found partly fixed, with what it said is left and the grade it kept, and `must_not_repeat` those it left open. A thread it resolved that a later round found again is also in `must_keep_open`. A record without thread evaluations falls back to Manki's replies, and a thread resolved at a time neither shows is left out. Body findings the round posted again are in `must_not_repeat`. A follow-up round with missed blockers gets one draft holding both. Run it on a repository Manki reviews, such as manki-review/manki or the owner's forks, since a case names its repository. A draft has `key_version: 0`. Check its items, severities and locations, then set `key_version` to 1 and move it to `bench/cases` or `bench/holdout`. The body is the pull request body as it was when the drafted round's review started, from its edit history. A body never edited is the same at any time, so it needs no date. For an edited body, when its version cannot be recovered or the round record holds no usable time or wall-clock time to date the review, the draft uses the body as it is now and says so in its header. References to repositories outside manki-review and the forks are written as plain text.

## On GitHub

The **Benchmark** workflow (`.github/workflows/bench.yml`) runs the bench without local clones. Start it from the Actions tab with **Run workflow**. Each case runs in its own job, four at a time. A job builds Manki at `ref`, fetches the case's commits in full (base, head and a follow-up case's earlier head), and runs that ref's `manki bench` on the case file of the workflow's own commit. The `report` job merges the case reports with `npm run bench-report -- merge`, writes the comparison table to its summary and uploads `report.json` as the `bench-report` artifact. Given the run ids of earlier runs in `baseline`, it also applies the release gate in `RELEASE.md`.

Each ref scores with its own bench code. After a change to the matcher, run the baseline's ref again rather than compare with an older report. To compare downloaded reports locally, run `npm run bench-report -- gate --baseline old.json --candidate new.json`.

### The route of each blocker

The report stores with each finding how it got its grade: the grade its finder gave it, the severity table cell the judge stated, the grade a confirmed doubt would give, the grade the judge itself stated for that case, whether it is a security finding, each step of its grade path with what made the step, the number of doubts of each kind and how many of them state the consequence, the outcome of the refuter's check, whether an unsettled check ended on its step budget, how many lines of related repos and of the PR's repository that check cited when it cited a related line, and the check status. With each run it stores why the review reached its outcome. These are grades, kinds and counts. No text of a finding is among them.

The summary counts the blockers of the complete runs by the route each took, against the grade of the key item it matches. A blocker that matches a key item only partly counts in that item's column. The table holds counts only, so it also covers hold-out cases. The routes are:

- **filed by a finder and kept**: a finder graded it a blocker, whatever lowered and restored it between.
- **raised by the judge**: its finders graded it lower, and the cell the judge stated made it a blocker.
- **raised by a confirmed doubt**: its finders graded it lower, a doubt of the judge held it below blocker, and the refuter's check confirmed the doubt. Only a security finding or one that restates an earlier blocker takes this route.
- **raised by a confirmed doubt and consequence**: its finders graded it lower, a doubt of the judge held it below blocker, and every check confirmed the defect and every premise, among them the consequence the judge named. A security finding with such a premise counts as raised by a confirmed doubt.
- **claim check**: only the checks of the PR text's claims reported it, whatever happened to its grade afterwards.
- **verdict reader**: the verdict reader named it.
- **other**: another step made it a blocker, such as a broken rule under `review.rules: block`.
- **unknown**: the report holds no route. Each ref writes its own case reports, so every blocker of a ref from before the route was stored is unknown.

### Unmatched blockers and unexpected warnings on tuning cases

A false blocker is either a wrong blocker or a real defect the key does not list, and the same holds for an unexpected warning. So the summary of a run with tuning cases, local or on GitHub, lists every blocker and every warning that matched no key item, by case and run, each with its location and description. Check each against the code at the case's head. Add each real blocker to the case's `must_catch`. Add each real warning to `must_catch`, or to `nice_to_have` when a good review may leave it out. Then bump the case's `key_version`, so the next run counts it as a find. `npm run bench-report -- unmatched --report <report.json>` prints the same list from a stored report, and names the cases of the other set, which it does not list. Never grow a hold-out key this way while working on Manki: its cases are not read. The hold-out pass in `RELEASE.md` does it instead.

Of a hold-out case the bench prints the id and counts only. Its review, its matcher calls and the load of its config log nothing, and the summary leaves out its source and the reason of a failed run, which stay in the report file. Its findings are listed only on request, with `--set holdout`, and never in a workflow job, since the logs and summaries of this repository are public. On GitHub a hold-out case job shows no output of the bench at all, whatever its ref prints.

The text of a tuning case is printed, and it comes from a model that read outside code. So no line of it may start a line of the output, where a job log would run a workflow command: each source, title, location and failure reason is printed on one line behind the case, and each line of a description behind a bar.

A stored report is not trusted on the set of a case. `--rescore`, `bench-report unmatched` and `bench-report gate` take each case's set from its id. A case the report calls a hold-out case stays one for them, also when only `cases/` holds its file now. They refuse a report only when it contradicts the case files, which is when it calls a case a tuning case while `holdout/` holds the case's file. The report of a single case job of a ref before v7.5 is such a report. `bench-report merge` reads those reports and writes the set each id gives into the merged report. A case that was removed or renamed after a report was written has no case file any more, so it is left out of the list, the gate and the rescored report, and named in one line.

### Scoring a report again after a key change

A report scored with an older key does not compare with one scored with the new key, so the gate leaves such a case out and lists it. `npm run bench -- --rescore <report.json>` scores the stored runs again without reviewing anything. It matches the findings each run stored to the key of each case whose `key_version` is not the report's, and writes `<report>.rescored.json`. It needs the matcher's credentials and no checkout, so a key change costs matcher calls only. Add `--holdout` for a report with hold-out cases, and `--matcher-model` when the report was not matched by the default model. It prints the ids of the cases it scored again and nothing of their findings. It exits 2 when the matcher failed on a case. That case stays as scored in the report it writes, so run the command again, and the matcher cache keeps what was already matched.

Only complete runs are scored again. A case stays as scored, and is listed with the reason, when no case file was loaded for it, such as a hold-out case without `--holdout`, when its report holds no text of the findings, which is every report of a ref before v7.5, when its runs reviewed another kind of round than the case describes, or when the matcher fails on it twice. The other cases are still scored again. Scoring again is for a changed key only: a case whose commits, title, body, config or earlier round changed needs a new review.

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
    severity: blocker                    # blocker, warning or note
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
      cell: { row: wrong, column: rare } # optional, the severity table cell the earlier round recorded
      doubts:                            # optional, the premises the earlier round left open
        - premise: A caller passes it.
          decides: grade                 # defect or grade
          consequence: true              # optional, only beside grade: the premise states the consequence that makes the cell a blocker
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

An earlier open thread the key does not list should stay open. List an earlier finding the push leaves in place under `must_not_repeat`, unless the round should regrade it: then it is a `must_catch` item at the grade it earns. An earlier warning posted in the body is carried into the result's `carried` list while its line and the two lines around it read the same at `head` as at the earlier round's `head` and no finding names it again. It is not a finding of the round, so the scoring does not read it, and it does not count as posted again for `must_not_repeat`. A follow-up key does not expect a note on code the earlier round reviewed, since the round posts none there. A `nice_to_have` item for such a note still belongs in the key when it also absorbs a finding on the same point at a higher grade. A ref older than follow-up support reviews such a case as a first round, so the release gate leaves out a case one side scored as a follow-up round and the other as a first round, and lists it.

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

A case whose config does not load, its own or the repository's, gets no review. A case's own config with a key Manki does not know, such as a misspelled one, counts as not loading, while the same key in the repository's file only gives a warning. Each of its runs is recorded as `CONFIG_INVALID` with the reason and counts as incomplete, and the `Config invalid` row of the summary table names the case. So a config format change never drops a case without a trace, and the release gate decides nothing while a hold-out case is in that state, naming the case.

### Related repos

A config's `related_repos` are read as they were when the case's change was made, not at today's head. Otherwise a review could rest on code written after the change, such as a consumer that already adopted the merged API, which no reviewer at the time could have read. The time is the oldest author date among the case's own commits, from the merge base of `base` and `head` to `head`. Its own commits are those on the first-parent line of `head`, so the base branch merged into the change adds none of its older commits. When `head` is itself the merge of the change, every commit it merged counts. A commit replayed into a fork keeps its author date, while its commit date is the day of the replay, and the head of a follow-up case can be newer than the merge of the change it follows up. Each related repo is checked out at the newest commit made by that time on the first-parent history of its `ref`, or of its default branch. A case without related repos needs no date. A run fails without a review when the change of a case with related repos cannot be dated. Every related repo is fetched before a finder runs, and a run ends incomplete there, with what it spent so far in the report, when one cannot be read as of that time, such as a repo with no commit that old. It never reads newer related code instead. Each run in the report lists its related repos with that time and the commit checked out (`relatedRepos`), so a reader sees what the review could read. A pull request round always reads the newest commit, and its round record names that commit.

A new case comes from a merged pull request in a public repository. Its head is the commit a review saw before a later commit fixed the defect, and each `must_catch` item is checked against the code at that head, with the fixing commit in `fix`. A clean case is a pull request merged as first pushed, with no later fix to its code. Put a new case in the set that needs it more, and never move a hold-out case into tuning to debug it.

## Scoring

The matcher only sees findings in a file the item lists or naming one of its symbols. It grades the closest one MATCH (same root cause in the same code), PARTIAL (right code, vaguer or different mechanism) or NONE, and lists every finding that names the same defect. Recall counts MATCH only. Weighted recall gives blockers 3, warnings 2 and the rest 1, with half credit when the highest severity among the matching findings is one tier low and none below that. A run's verdict is correct when it blocks a case with a must-catch blocker or approves a clean case. On a follow-up case, an earlier blocker still in the code also asks for a block: a `must_keep_open` item graded blocker, a `must_not_repeat` item graded blocker whose thread is not resolved, or an open blocker thread the key does not resolve, since a pull request round blocks on it. A follow-up case with none of those and no `must_catch` or `must_keep_open` item should approve. A follow-up run also counts the earlier open threads it resolved, right when the key lists them in `must_resolve` and wrong otherwise, and its repeats: findings the matcher grades MATCH against a `must_keep_open` or `must_not_repeat` item. A repeat counts in none of the extra findings, the false blockers and the unexpected warnings. A finding graded PARTIAL there names another mechanism, so it counts as a new finding. A follow-up run is scored on the findings a pull request round would show. A note the round leaves out, because it sits on code the earlier round reviewed or restates a finding the earlier round listed without a thread, counts nowhere: not as a match, a repeat or an extra finding. The run report does not list it. Must-catch at grade counts a MATCH graded at the key's severity or above. Findings that match no item, neither a `must_catch` nor a `nice_to_have` one, count as extra, blocker findings among them as false blockers and warning findings as unexpected warnings, and further findings on an item already matched as duplicates. A run that fails or does not complete is listed with its reason and counts in no recall, verdict or catch rate. The matcher is tried twice before a finished review is given up, and such a run keeps its findings and cost. The command exits 2 when any variant completes no review of one of the sets. The report is saved after each case. Matcher decisions are cached in `bench/.matcher-cache.json` by the matcher prompt, the item and the findings it saw. A cache file that does not parse stops the bench with its path. Delete it to start a fresh one.
