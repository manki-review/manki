# Release process

This document captures the mechanics of cutting a Manki release. Keep it short, keep it accurate.

## Joint version bump (enforced by CI)

When you add a new `## [X.Y.Z]` heading to `CHANGELOG.md`, you MUST bump `package.json` and `package-lock.json` to the same `X.Y.Z` in the same commit.

CI enforces this: `scripts/check-changelog-version.js` runs on every PR and on `main`, and fails if `package.json` `version` does not match the most recent non-`Unreleased` `## [X.Y.Z]` heading in `CHANGELOG.md`. The check was added after `v5.0.0` and `v5.0.1` shipped with `package.json` still pinned at `4.7.0` (see [#783](https://github.com/manki-review/manki/issues/783)).

To run the check locally:

```sh
npm run check-changelog-version
```

## Release PR checklist

1. Run the hold-out benchmark on GitHub, and let its gate decide whether the release goes out. In the repository's **Actions** tab, open **Benchmark**, click **Run workflow**, keep `ref: main`, `set: holdout`, `variants: base` and `runs: 2`, and set `baseline` to the run ids of the last release's own benchmark, from its release PR body. A run id is the number at the end of the run's URL. The gate decides on two runs per side, so the last release's two candidate runs are this release's baseline, and a release pays only for its own two runs. Two runs can also be one run with `runs: 1` and a second with `rerun_of`, as below. The gate result is in the summary of the run's `report` job, and the job fails unless the gate passes, so a `RERUN` or `NO DECISION` shows as a failed job too. The gate rule:
   - It compares the hold-out cases that both sides scored with the same key version, as the same kind of round. A follow-up case that the baseline's ref reviewed as a first round is left out and listed, and so is a case the two sides scored with different key versions.
   - A run with an incomplete review does not count, so run that side again.
   - A run whose review completed but whose matcher failed is unscored. The gate decides nothing while a side has one, and names its cases. It needs no new run: score the report again and apply the gate to the rescored reports, as described below for changed keys.
   - A case whose config does not load gets no review, and the gate decides nothing while one side has such a case. Another run changes nothing. The case needs a `config:` block that loads first (see [`bench/README.md`](bench/README.md)).
   - A baseline with fewer than two runs per case decides nothing. Run the baseline's ref again with `ref` set to the commit in the first run's summary, and give both run ids in `baseline`. The runs of one side must review the same commit, and the gate refuses them otherwise.
   - The must-catch items found at the key's grade or above, and on follow-up cases the earlier threads the key says the push fixes, are judged one key item at a time over all runs of each side. An item that some runs of a side get right and others do not counts as noise. An item that every baseline run gets right and no candidate run does looks lost. The summary lists each item that changed by case id and item id, with how many runs of each side got it right, and marks the items that look lost and the items that differ between the runs of one side.
   - An item that looks lost reads `RERUN` and names its cases. Run those cases on both commits. First start the workflow with `ref` set to the baseline's commit, `cases` set to the named case ids, `runs: 3` and no `baseline`. Then start it with `ref` set to the candidate's commit, the same `cases`, `runs: 3`, `baseline` set to the baseline's run ids plus the id of that first run, and `rerun_of` set to the candidate's earlier run ids. Each case pools all runs of one commit from every report that holds it, so a report of a few cases counts beside a full one. An item still right in every baseline run and in no candidate run then fails the release. A `RERUN` never passes, so a release whose gate has no rerun yet waits.
   - The false blockers, the unexpected warnings (warning findings that match no key item), and on follow-up cases the earlier threads resolved wrong and the earlier findings posted again may each get worse by at most one per run on average, summed over those cases. For a baseline whose ref did not score the unexpected warnings, the gate counts them from the findings and matches in its report, so it needs no new run. The gate table also shows the blockers above key grade and the key blockers posted lower (see `bench/README.md`), which decide nothing.
   - Any change on a single candidate run reads `RERUN`: start the workflow once more with `ref` set to the commit in the first run's summary, the same `baseline`, and the first run's id in `rerun_of`, and the gate decides on both runs.

   What the gate can and cannot show: two runs of one commit differ on about one must-catch item in four, so with two runs per side an item that looks lost can be noise. The measured noise makes about one such item per gate, and a rerun of three more runs per side makes a noise loss rare. The rule passes a drop in how often an item is caught, such as from 9 runs in 10 to 3 in 10, as long as some candidate run catches it. A baseline and a candidate run days apart can also differ for reasons outside the repository, such as a change to the model behind the same name or to a related repository the review reads. Rerunning the baseline's commit beside the candidate's is what tells such a change from a loss in Manki.

   Put the links of the run, or both runs, any rerun of named cases, and the gate result in the release PR body, where the next release finds its baseline. The `bench-report` artifact is kept for 90 days. When the baseline's has expired, run the last release's tag with `runs: 2` and use that run as the baseline.

   The first baseline with two runs is v7.3.2's, runs 42729695122 and 42733124985. Both reviewed commit 178ae7729f61adcbec86311c310e53945adea75c.

   The hold-out pass: a false blocker or an unexpected warning of a hold-out run can be a real defect the key does not list, and nobody who works on Manki may read the hold-out cases to tell. The isolated agent that maintains the hold-out cases does it, in a session that does no other work on Manki:
   - It downloads the run's `bench-report` artifact and lists the findings that match no key item, each with its case, location and description: `npm run bench-report -- unmatched --report report.json --set holdout`. The command refuses to list hold-out findings in a workflow job, whose log is public.
   - It checks each unmatched blocker and each unexpected warning against the code at the case's head. It adds each real blocker to the case's `must_catch`, each real warning to `must_catch` or `nice_to_have`, and bumps the case's `key_version`.
   - It reports only how many items it added per case id. No title, text or location of a case or a finding leaves that session.

   After the changed keys are merged, score the stored reports of both sides again, once per report: `npm run bench -- --rescore report.json --holdout`. That costs matcher calls only and no review, and it prints case ids only. Run it again when it exits 2, which means the matcher failed on a case and left it as scored. Then apply the gate to the rescored reports: `npm run bench-report -- gate --baseline <report> --baseline <report> --candidate <report>`. The workflow's own gate reads the baseline reports as they were stored, so it leaves each re-keyed case out and lists it. A report of a ref before v7.5 holds no text of its findings and cannot be scored again, so its re-keyed cases stay out of the gate until both sides are reports that hold the text.
2. Write a new `## [X.Y.Z] - YYYY-MM-DD` section in `CHANGELOG.md` from the PRs merged since the last tag (`git log --oneline vPREV..main`, then each PR's title and body), grouped by what a Manki user notices, not by PR. Use these sections in this order and leave out any that are empty: Breaking changes and migration, Review loop and verdicts, Review format, Security, Static analysis, Reviewer groups and models, Reliability, Docs, Internal. A new feature area, such as Webhook mode, gets its own section after the first one. Each entry is one or two plain sentences on what changed for the user, ending with the PR links. Fold anything still under `## [Unreleased]` into it. Feature and fix PRs never edit `CHANGELOG.md`, and CI rejects one that does, so entries are written only here and in a PR that rewrites the notes of a release that is not published (see [Changing a release that is not published](#changing-a-release-that-is-not-published)).
3. Bump `version` in `package.json` to `X.Y.Z`.
4. Refresh `package-lock.json` (`npm install` will do it).
5. Open the release PR. CI runs `check-changelog-version` automatically.
6. Once merged, push the merged release commit on `main` to a release branch: `git push origin <sha>:refs/heads/release/vX.Y.Z`. The `Release` workflow (`.github/workflows/release.yml`) checks that the commit is on `main`, that it bumps the version or changes `CHANGELOG.md` alone (see [Changing a release that is not published](#changing-a-release-that-is-not-published)), that no later commit on `main` edits `CHANGELOG.md` at the same version, and that `package.json` and `CHANGELOG.md` say `X.Y.Z`. It then builds `dist/`, commits it on top of the release commit and pushes that build commit to `release/vX.Y.Z`. It never writes tags. `main` never carries `dist/`.
7. Once the `Release` workflow finishes, the `Publish release` workflow (`.github/workflows/publish-release.yml`) starts on its own. To start it by hand, run it from `main` with the tag `vX.Y.Z`. Its `verify` job runs `scripts/publish-release.sh --dry-run vX.Y.Z` without any secret and prints what it will write: the tag, the release notes and the major tag move. Read that log, then approve the `release` deployment on the run. The `publish` job then mints a token from the release App and runs the script again on the build commit the dry run verified, skipping the rebuild. If the App isn't set up, the job fails without writing anything.

   As a fallback, a repository admin of `manki` runs `scripts/publish-release.sh vX.Y.Z` from a clone of the repo, with Node 24 and `gh` signed in. Run it with `--dry-run` first to print the commands that write tags or the release without running them.

   Either way, the script waits for the build commit and repeats the workflow's checks on the release commit. It then rebuilds `dist/` from the release commit and refuses unless the build commit is exactly the release commit plus that fresh `dist/`. It creates the annotated tag `vX.Y.Z` on the build commit, pushes it, publishes the GitHub Release with the `CHANGELOG.md` section as its notes, and moves the major tag (`vX`) to the same commit. It leaves `vX` alone when a newer `vX` release exists. Keep the release branch, because the script reads the build commit from it.

## Changing a release that is not published

A release whose PR is merged can still take more changes as long as its tag `vX.Y.Z` does not exist. Merge the changes, then open one more PR that rewrites the `## [X.Y.Z]` section of `CHANGELOG.md` and changes nothing else. CI lets a PR edit `CHANGELOG.md` when it changes the version. It also lets one through when the version it is on has no tag yet, `CHANGELOG.md` is the only file it changes, and every line outside the `## [X.Y.Z]` section stays as it is. A feature or fix PR still fails, and so does an edit to the notes of another release.

That PR's commit is the new release commit. If `release/vX.Y.Z` already exists, delete it first (`git push origin --delete release/vX.Y.Z`), then push the new commit as in step 6. From then on the `Release` workflow and `scripts/publish-release.sh` refuse the earlier release commit, because `main` has a later commit that edits `CHANGELOG.md` at the same version. The next release's PR is at another version, so it never gets in the way of an older release. The version never goes back, and there is no new version number for a release nobody could install.

A tag `vX.Y.Z` ends this. CI rejects a notes PR for that version, and the script no longer looks at later commits, so a rerun finishes the release whatever `main` holds. Close a notes PR that is still open at that point: its CI result is from before the tag, so it would still merge. A tag is not yet a published release. If publishing failed after the tag was pushed, rerun the script. If the script reports that the tag points at another commit than the build commit, an admin deletes the tag as the message says, and with the tag gone the notes can change again as above. Once the release is published it is final, and a change needs a new version.

## Tag ruleset

The `release tags` ruleset of the `manki` repository covers `refs/tags/v*` and restricts creating, updating and deleting release tags. It is a repository ruleset, not an org one. Only repository admins and the `manki-release` App can bypass it. GitHub can't exempt GitHub Actions from a ruleset, which is why the `Release` workflow builds on a branch and the tags are written with the App's token or by a repository admin.

## Release App setup

The `Publish release` workflow needs this one-time setup by an org owner:

1. Create a GitHub App owned by the `manki-review` org, for example `manki-release`. Turn its webhook off. Give it the repository permissions Contents: read and write, and Workflows: read and write. Moving `vX` across commits that change `.github/workflows/` is refused without the Workflows permission.
2. Note the App's Client ID and generate a private key.
3. Install the App on the `manki-review` org for the `manki` repository only.
4. Add the App as a bypass actor, always allowed, on the `release tags` ruleset in the `manki` repository's settings, under Rules and Rulesets.
5. In the `manki` repository, create the `release` environment. Add yourself as a required reviewer and leave "Prevent self-review" off, because you both start and approve a run. Limit its deployment branches to `main`, so a run from any other branch can't reach the App's key. GitHub may already have created the environment on its own, with no protection, the first time a workflow run used it. So check its required reviewer, its branch rule and its secrets even when it exists.
6. Add the environment secrets `RELEASE_APP_CLIENT_ID` (the Client ID) and `RELEASE_APP_PRIVATE_KEY` (the whole `.pem` file).

## Immutable releases

Immutable releases are enabled in the repository settings. Once a release is published, its tag can't be moved or deleted and its assets can't change. Deleting the release doesn't free the tag name either. This is why the script only publishes after `vX.Y.Z` points at the build commit. A release asset, if one is ever added, has to be attached in the script's `gh release create` call, because the release is published as it is created. If a published release turns out broken, cut a new patch version. Never re-push `vX.Y.Z`. The major tag `vX` has no release of its own, so the script can keep moving it.

If the `Release` workflow fails, rerun it. A rerun sees `dist/` on the release branch and skips the rebuild. `Publish release` and the script are safe to rerun too: the script skips every step that is already done, publishes an existing draft, and refuses to move a `vX.Y.Z` tag that points anywhere but the build commit.

## Why all three files in one commit

The published action consumers reference the major tag (`vX`), but anyone inspecting the repo via `npm`, `package.json`, or the GitHub UI expects `package.json` and `CHANGELOG.md` to agree. Splitting the bump across PRs is what allowed the `v5.0.0` / `v5.0.1` drift in the first place. The CI check makes the joint bump non-optional.
