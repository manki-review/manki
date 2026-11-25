# Changelog

All notable changes to Manki will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [7.8.0] - 2026-11-25

Manki 7.8 is about fewer warnings and blockers that do not matter. Warnings with a rare trigger are left out of the review, a finding only one of two finders reported needs the other finder's backing, and a refuter confirms a finding only when normal use reaches it and someone can see the result. Pre-existing findings are posted only when they are security findings or the PR fixes the same failure elsewhere. Thread replies are read on the newest pushed commit and answered once. The new filter is on by default and one setting changes it. Nothing breaks on the upgrade.

### Upgrading

- `review.min_warning_trigger` is new, a whole number from 1 to 10, with the default 4. A higher number leaves out more warnings and `1` turns the filter off. It is read from the PR's base branch, so a PR cannot set its own ([#2066](https://github.com/manki-review/manki/pull/2066), [#2072](https://github.com/manki-review/manki/pull/2072)).
- A round can now make one call to rate its warnings, and one small call for each blocker or warning only one of two finders reported ([#2066](https://github.com/manki-review/manki/pull/2066), [#2012](https://github.com/manki-review/manki/pull/2012)).

### Grading

- A warning whose trigger is rated below 4 of 10 and whose harm is rated below 7 is not posted and does not hold the approval. The collapsed "Checked and left out" section names it with its score, and the round record keeps it. Blockers, security findings, tool alerts, findings the judge graded a blocker, pre-existing findings and earlier threads are never left out this way. A failed rating posts the warning ([#2066](https://github.com/manki-review/manki/pull/2066), [#2072](https://github.com/manki-review/manki/pull/2072), [#2071](https://github.com/manki-review/manki/pull/2071)).
- On a round with two finders, the other finder votes on each blocker and warning that only one of them reported, without seeing its grade. A finding the vote declines goes one grade down: a blocker becomes a warning that only a fix or a maintainer clears, and a warning becomes a note. When a refuter runs, a blocker one finder reported also needs a check that confirms its consequence. Security findings and rounds with one finder are exempt ([#2012](https://github.com/manki-review/manki/pull/2012), [#2023](https://github.com/manki-review/manki/pull/2023)).
- A blocker the judge raised above every finder's grade stays a blocker only when a check confirms the defect. Otherwise it goes back to the highest finder grade ([#2023](https://github.com/manki-review/manki/pull/2023)).
- A refuter confirms a finding only when it can cite lines for how normal use reaches the state and what goes wrong where someone can see it. Before, it confirmed that the code path exists ([#2027](https://github.com/manki-review/manki/pull/2027)).
- A refuter confirms how an external tool, package manager, runtime or remote service behaves only from a line that states it, not from what it knows ([#2006](https://github.com/manki-review/manki/pull/2006)).
- When the judge's own reasoning argues for a lower grade than the table cell it picked, the finding is held at a warning and a check has to confirm the damage before it blocks ([#2002](https://github.com/manki-review/manki/pull/2002)).
- A warning without a realistic trigger is kept in the round record on every row of the severity table, not only on the `degraded` row. One that is serious if true stays posted until a check disproves its trigger ([#2001](https://github.com/manki-review/manki/pull/2001)).
- A finding the PR did not cause is posted only when it is a security finding. Every other one is in the round record only, unless the PR fixes the same failure elsewhere. Then it is posted as a note ([#2025](https://github.com/manki-review/manki/pull/2025)).
- A note about a test is ranked by the gap it names, and one that claims a gap an existing test already covers is kept in the round record ([#2003](https://github.com/manki-review/manki/pull/2003)).

### Review loop and verdicts

- A thread reply is read only after GitHub has moved the PR to the newest push, up to 3 minutes later, so "Fixed in abc1234" written right after a push is read on that commit. A reply whose head moves while it is read is read once more, and the answer says when it could not be checked ([#2064](https://github.com/manki-review/manki/pull/2064), [#2068](https://github.com/manki-review/manki/pull/2068)).
- A review no longer answers a partly fixed thread in which a reply waits for its own answer, so the reply is not answered twice ([#2070](https://github.com/manki-review/manki/pull/2070)). A reply whose fix a later review already confirmed points at that review instead of answering "Unverified", and needs no answer when the question is settled ([#2038](https://github.com/manki-review/manki/pull/2038), [#2070](https://github.com/manki-review/manki/pull/2070)).
- A reply about a fix on a branch that was rebased since the finding was posted says so and leaves the thread to the next review, instead of answering "Unverified." ([#2056](https://github.com/manki-review/manki/pull/2056)).
- When a person dismisses Manki's request for changes on the head and the threads are resolved, Manki can approve again ([#2000](https://github.com/manki-review/manki/pull/2000)).
- A warning thread that a later round raises to a blocker is closed with a link to the blocker's thread, so the same defect no longer shows twice ([#1995](https://github.com/manki-review/manki/pull/1995)).
- A finding that repeats a thread deferred to an open tracking issue stays quiet while the issue still names its code ([#1999](https://github.com/manki-review/manki/pull/1999)).
- A finding is tagged new when a line it cites changed since the last reviewed round, and a record entry is attached to its own thread when several fit ([#2005](https://github.com/manki-review/manki/pull/2005), [#2013](https://github.com/manki-review/manki/pull/2013)).
- A push run that starts late reviews the head it finds, instead of stopping as superseded ([#1998](https://github.com/manki-review/manki/pull/1998)).
- A PR into a branch without its own `.manki.yml` is reviewed with the default branch's settings instead of the built-in defaults ([#2009](https://github.com/manki-review/manki/pull/2009)).
- A draft shows the Review every push box in its settings, as the token service offers it ([#2065](https://github.com/manki-review/manki/pull/2065)).

### Review format

- The lines a check or note cites name each file once ([#1990](https://github.com/manki-review/manki/pull/1990)).

### Security

- Claude's own Read, Grep and Glob no longer read the `.git` of the checkout, and CI checks this with the pinned CLI ([#2060](https://github.com/manki-review/manki/pull/2060)).
- The check whether another pull request fixes a finding is off in a repository that sets `closed_paths` ([#2047](https://github.com/manki-review/manki/pull/2047)).

### Reliability

- A reply of the Claude CLI that is cut at the output limit is joined with its last message when the two hold one whole answer. Before, the judge could read only the end of it ([#2055](https://github.com/manki-review/manki/pull/2055)).
- Two parts of a large file's syntax tree that share an internal id are told apart, so a changed method is no longer listed as removed or added ([#2058](https://github.com/manki-review/manki/pull/2058)).

### Review records and statistics

- A round with memory records how often findings of the same kind were fixed, and the fix-rate line of a merged PR names the Manki version. Neither changes a grade yet ([#2014](https://github.com/manki-review/manki/pull/2014), [#2034](https://github.com/manki-review/manki/pull/2034)).

### Docs

- The docs describe that the proof rule counts only the judge's blocker ([#2028](https://github.com/manki-review/manki/pull/2028)).

### Internal

- A benchmark run can replay stored finder output, the judge's answer and the refuter's answers, scores an Opus and Sol setup, and keeps a run whose matcher failed twice ([#2022](https://github.com/manki-review/manki/pull/2022), [#2036](https://github.com/manki-review/manki/pull/2036), [#2052](https://github.com/manki-review/manki/pull/2052), [#2050](https://github.com/manki-review/manki/pull/2050), [#1989](https://github.com/manki-review/manki/pull/1989)).

## [7.7.5] - 2026-11-23

Manki 7.7.5 cuts review loops and false blockers. A blocker restated after Manki's own suggested fix, a blocker that needs an unrealistic trigger and a tool alert two models disprove no longer block, and a finding settled by agreement is not posted again. Taking an approval back now also works when a dismissal fails or a round is incomplete, and the review texts are plainer. On the tuning benchmark against 7.7.4, false blockers fell from 47 to 32 and verdict accuracy rose from 75% to 87.5%, with the same real blockers caught. Nothing breaks on the upgrade and no setting changes.

### Grading

- A blocker whose trigger needs an event that real use does not meet is posted as a warning at most: odds no real use meets, two failures in a row that only keep a hold in place longer, or a call no caller in the repository makes and no outside input reaches. A refuter checks the judge's claim, and a realistic trigger it confirms with cited lines gives the blocker back. Security findings are exempt ([#1983](https://github.com/manki-review/manki/pull/1983)).
- A security finding about a cost or a missed input form, such as a quadratic loop or a parser gap, stays a warning while the doubt that it is actually reached stays open. An injection, an auth bypass or a leaked secret still blocks ([#1982](https://github.com/manki-review/manki/pull/1982)).
- The judge puts a finding on the top rows of the severity table only when the code itself causes the damage those rows name. A doc that promises behaviour the code lacks, or a wrong figure in a heading, label or log line, is a warning ([#1981](https://github.com/manki-review/manki/pull/1981)).
- A static tool alert, such as from actionlint, zizmor or shellcheck, that both refuters on two different models disprove with cited lines is posted as a warning that holds the approval until it is fixed or cleared, instead of blocking every round. Alerts from security scanners and rules with a security name always keep blocking ([#1984](https://github.com/manki-review/manki/pull/1984)).

### Review loop and verdicts

- A blocker that restates an earlier finding on code that carries Manki's own suggested fix is capped, so applying Manki's fix no longer starts a new blocker loop on the same defect ([#1978](https://github.com/manki-review/manki/pull/1978)).
- A finding that restates a thread Manki settled by agreeing with the author is dropped while the push left the cited lines alone, and is no longer tagged as missed by an earlier review. When Manki cannot read what changed, it sends the finding to the judge instead ([#1986](https://github.com/manki-review/manki/pull/1986)).
- A reply held behind a running review is answered as before, and when that answer clears the thread it says it replaces the verdict the review just posted, instead of contradicting it silently ([#1979](https://github.com/manki-review/manki/pull/1979)).
- Manki resolves or reopens a thread before it posts its answer, so the hidden reply record names the state the thread is really in, including a failed resolve ([#1970](https://github.com/manki-review/manki/pull/1970)).
- An open blocker fails the `Manki` check on the head even when no approval was left to dismiss, and the token service is told no approval stands only when every dismissal worked ([#1969](https://github.com/manki-review/manki/pull/1969)). After an incomplete round, the approval record is cleared only when no approval of the head is left ([#1985](https://github.com/manki-review/manki/pull/1985)).

### Review format

- The Pre-existing section says in one line why its findings do not block ([#1967](https://github.com/manki-review/manki/pull/1967)), and review texts use plain words, such as "Manki's record of this review" for the round record ([#1976](https://github.com/manki-review/manki/pull/1976)).
- Follow-ups agreed for later are listed as one line each instead of in full ([#1980](https://github.com/manki-review/manki/pull/1980)).

### Related repositories

- A `Cargo.lock` in a workspace member's folder, which Cargo ignores, no longer decides a dependency's version ([#1971](https://github.com/manki-review/manki/pull/1971)).

### Docs

- The workflow examples grant `pull-requests: read`, since Manki posts with the App token. A workflow that grants `write` keeps working ([#1968](https://github.com/manki-review/manki/pull/1968)).

## [7.7.4] - 2026-11-23

Manki 7.7.4 takes an approval back when a blocking thread opens again, and keeps the required check and the token service in step with it. A "Tracked in #N" link now needs an issue that names the flagged code, and the round record says which findings the review body left out. Nothing breaks on the upgrade and no setting changes.

### Review loop and verdicts

- When a blocking thread is reopened after Manki approved, by a person or by Manki, Manki dismisses its round approval or auto-approval right away instead of keeping it until the next round. This also works with `auto_approve` off, after a thread event or a reply in a thread ([#1956](https://github.com/manki-review/manki/pull/1956)).
- Once that dismissal went through, the `Manki` check on the head fails as "Changes requested" and says the next review round decides, so a required check no longer lets the PR merge beside the reopened blocker ([#1960](https://github.com/manki-review/manki/pull/1960)).
- Each dismissal that removes every approval, after a reopened blocker, a too-big notice or a round where no model read any file, also tells the token service that no approval stands. This needs the token service from [token-service#139](https://github.com/manki-review/token-service/pull/139). An older token service refuses the report and Manki only logs it ([#1960](https://github.com/manki-review/manki/pull/1960), [#1963](https://github.com/manki-review/manki/pull/1963)).

### Review format

- A finding is linked to a tracking issue only when the issue's title or the start of its description names the code the finding cites: its file or a name the finding puts in a code span. A link that only shares a topic, such as review commands, is no longer made ([#1955](https://github.com/manki-review/manki/pull/1955)).
- When the review body has no room for every finding, the round record lists the findings the body left out as kept in the round record only, instead of as posted in the body ([#1957](https://github.com/manki-review/manki/pull/1957)).

## [7.7.3] - 2026-11-23

Manki 7.7.3 cuts review loops and unrelated findings. A maintainer's clear stays cleared, one blocker keeps one thread, a clean rebase keeps an auto-approval, and a fix in a renamed file is seen. A cost the PR only shares with existing code is no longer posted as its own, and the progress comment's counts add up. Split proposals now name side changes by purpose and by hunk. Nothing breaks on the upgrade and no setting changes.

### Review loop and verdicts

- A push that leaves the PR's change unchanged, such as a clean rebase, keeps an auto-approval without a full review, under the same holds as a round approval. A later round dismisses an auto-approval like a round approval, and an unchanged push gets a full review when a blocking thread was reopened after the approval ([#1941](https://github.com/manki-review/manki/pull/1941)).
- When Manki resolves a blocker or security thread for a maintainer, its own reply records who cleared it. A later reply, such as the PR author's "thanks", no longer makes the thread block again. Only Manki's own record counts, and the maintainer's write access is checked again each time it is read ([#1942](https://github.com/manki-review/manki/pull/1942)).
- A blocker an earlier round could only list in its review body takes the thread of a later blocker that restates it, instead of getting a second thread for the same defect ([#1943](https://github.com/manki-review/manki/pull/1943)).
- A push that renames and edits the file of an open thread puts that file first in the diff the judge reads, matched by its old or its new path, and no longer tells a blocker thread there that the push did not change its file ([#1936](https://github.com/manki-review/manki/pull/1936)).
- A cost finding is no longer posted as the PR's own when the PR's new path runs existing work no more often and on no larger input than existing code already does, such as a second delivery of the same data. The origin check answers pre-existing and cites the existing path, so the warning stays in the round record. A cost the PR makes grow faster, makes more expensive per run, or lets outside input newly trigger stays the PR's own, and so does a failure a new caller reaches ([#1948](https://github.com/manki-review/manki/pull/1948)).
- A warning a finder filed as a blocker, but whose trigger the judge doubts, gets its trigger checked by a refuter. When the check disproves the trigger, the warning stays in the round record. When the check stays open or does not run, it is posted as before. Security findings and wrong results are never lowered this way ([#1952](https://github.com/manki-review/manki/pull/1952)).
- A draft with an open blocking thread keeps its waiting check instead of a neutral one, which a required check counts as passing ([#1938](https://github.com/manki-review/manki/pull/1938)).

### Scope reader

- A split proposal also flags a side change by purpose: a fix mixed into a feature or refactoring PR, or a refactoring mixed into a fix or feature PR, when it would be easier to review on its own. A small fix that belongs with the change is not flagged. Each part names its hunks as `path:start-end`, and a ranged split is asked again after a rebase ([#1934](https://github.com/manki-review/manki/pull/1934)).

### Review format

- The judge part of the progress comment lists its steps in the order they ran: grading, the refuter, the origin checks, then sweeps and the verdict reader, and keeps each step's result in the finished comment. Kept and dropped count only the judge's own decisions, the dropped line says the grades are the finders', and a new Posted part gives what was posted and, per reason, what stayed in the round record only ([#1953](https://github.com/manki-review/manki/pull/1953)).
- A finding a refuter checked but could not confirm says "Manki could not confirm this", instead of saying no line in the code was cited for it ([#1939](https://github.com/manki-review/manki/pull/1939)).

### Commands

- A review command on a merged or closed PR runs no review. Manki answers once that nothing was reviewed, with a "Review anyway" box that runs the review once when someone allowed to request reviews ticks it. This needs the token service from [token-service#137](https://github.com/manki-review/token-service/pull/137) ([#1940](https://github.com/manki-review/manki/pull/1940)).

### Reliability

- A refusal for a named version of a dependency is recorded under that version, so it no longer hides behind an earlier refusal of the whole package ([#1937](https://github.com/manki-review/manki/pull/1937)).

## [7.7.2] - 2026-11-22

Manki 7.7.2 fixes how reviews read. A finding whose defect Manki confirmed no longer says it could not confirm it, the review body is never cut inside a finding, split proposals show whole and come less often, and actionlint follows the repository's path rules. Nothing breaks on the upgrade and no setting changes.

### Review loop and verdicts

- A finding whose defect a check confirmed in the code no longer says "Manki could not confirm this" because an open question depends on something no code can show, such as how a model, a person or another project behaves. The refuter answers such a question as outside the code, and the finding reads as confirmed. For grading it still counts as unsettled, so no grade, hold or sweep changes. A finding that is still unconfirmed names what stayed open: "Manki confirmed the code path but could not check: ...", or that no line in the code was cited for it ([#1928](https://github.com/manki-review/manki/pull/1928)).
- The scope reader counts the same kind of change made in several places for one purpose as one topic, such as removing unused code, one rename or one mechanical migration. A cleanup like that no longer gets a proposal to split it ([#1920](https://github.com/manki-review/manki/pull/1920)).

### Review format

- The visible review gets the room of the review body first, and the hidden round record shrinks to fit. When the review still does not fit, whole findings are left out, pre-existing ones first, then notes, with a line saying how many. Before, the body was cut at a word, in the middle of a finding, which lost its fold and its "Create an issue for this" box ([#1930](https://github.com/manki-review/manki/pull/1930)).
- A pre-existing finding in the review body is short: its title, location, "Already broken before this PR" with one link, what goes wrong and how to fix it. Its thread keeps the full evidence ([#1930](https://github.com/manki-review/manki/pull/1930)).
- A proposed split shows its whole numbered list, and split and usefulness warnings no longer say they could not be confirmed. Before, the list could break after "1." with the rest in the fold ([#1920](https://github.com/manki-review/manki/pull/1920)).

### Earlier threads

- When an author says another pull request fixes a finding and that PR changes the file, Manki says it is not certain the PR replaces the line, instead of saying it does not, since that PR's diff counts lines from its own base ([#1924](https://github.com/manki-review/manki/pull/1924)).
- On a thread with 100 or more comments, an old dismissal no longer counts, since Manki may not see its own later reopen there ([#1922](https://github.com/manki-review/manki/pull/1922)).

### Static analysis

- actionlint gets the workflow paths without a leading `./`, so the `paths:` rules of the repository's actionlint config apply. An error the config ignores for a path is no longer raised as a blocker ([#1921](https://github.com/manki-review/manki/pull/1921)).

### Reliability

- A request for a version of a dependency the PR does not use no longer takes the package's record, so a later refusal of the same package is recorded ([#1925](https://github.com/manki-review/manki/pull/1925)).

## [7.7.1] - 2026-11-22

Manki 7.7.1 is about noise. Each blocker and warning is checked for whether the PR caused it, so a problem the code already had stays out of the review, and a warning needs a trigger that happens in realistic use. Findings are matched by meaning instead of titles and lines, replies are decided by Manki's own checked answer, and a blocker every refuter disproved no longer blocks. Nothing breaks on the upgrade and no setting changes.

### Review loop and verdicts

- Every blocker and warning Manki keeps gets a check with repository tools that reads the PR's base and answers whether this PR caused the problem. A warning or note about a problem the code already had goes to the round record only. A blocker the code already had is posted as a pre-existing warning once two models agree. A finding on a line the PR added or changed needs two answers on different models, and an unsure or failed check leaves the finding the PR's own. A round checks at most 8 findings, blockers first. This replaces the refuter's base question ([#1896](https://github.com/manki-review/manki/pull/1896), [#1911](https://github.com/manki-review/manki/pull/1911)).
- When the PR fixes a problem in one place of its own diff and leaves the same problem on another path, Manki posts a note: "The same problem remains here. This PR fixes it at <link> but not on this path." The note never blocks and comes first among the notes ([#1916](https://github.com/manki-review/manki/pull/1916)).
- A warning whose consequence is a cost, not a wrong result, is posted only when the judge names a realistic trigger, a sequence of events normal use produces. Without one it stays in the round record. When only one finder reported such a warning, the refuter checks the trigger too. Lost data, security holes, crashes and wrong results keep their grade however rare the trigger ([#1897](https://github.com/manki-review/manki/pull/1897)).
- A blocker every refuter disproved is posted as a warning with the refuter's reason, from the judge and from the verdict reader alike. It still holds the approval, and its thread clears only through a fix a review confirms or a person allowed to clear it ([#1907](https://github.com/manki-review/manki/pull/1907)).
- The judge doubts only facts that reading code can settle. A real defect is no longer posted as "Manki could not confirm this" because the judge doubted how a model or a person behaves at run time ([#1909](https://github.com/manki-review/manki/pull/1909)).
- Findings are matched by meaning. Code merges only copies with the same title on nearby lines, and every other pair goes to the dedup model, where an unsure answer keeps them apart. A merge keeps the highest grade, so a blocker no longer comes out as another line's warning, and a new defect next to an open thread is posted unless the model calls it the same ([#1902](https://github.com/manki-review/manki/pull/1902)).

### Earlier threads

- A reply counts as agreement only when Manki answered the latest reply with a settling Fixed, Withdrawn or Agreed, never because of words such as "done" or "fixed" in the reply. A "Fixed" needs a proof that cites a line the PR changed since the thread was posted, or it is answered Unverified. A warning is no longer lowered to a note because its text says "remove" or "instead" ([#1903](https://github.com/manki-review/manki/pull/1903)).
- A warning carried from an earlier review body no longer ends because a neighbouring line changed. Only the judge ending it, a fix, or its file being gone ends it. A blocker fixed in a file the thread does not cite stays open, and gets a "Fix seen in" note when two refuters on different models find the failure gone ([#1905](https://github.com/manki-review/manki/pull/1905)).

### Reliability

- A review whose round record is too big for the review body is posted with a smaller record instead of failing. Manki cuts the parts no later round reads first, names what it left out, and writes the full record to the log ([#1906](https://github.com/manki-review/manki/pull/1906)).

### Internal

- New and corrected tuning keys: real blockers in existing cases and two cases from 7.7.0 review noise ([#1888](https://github.com/manki-review/manki/pull/1888), [#1895](https://github.com/manki-review/manki/pull/1895), [#1912](https://github.com/manki-review/manki/pull/1912)).
- Two slow or timing-sensitive tests are steadier ([#1912](https://github.com/manki-review/manki/pull/1912), [#1913](https://github.com/manki-review/manki/pull/1913), [#1914](https://github.com/manki-review/manki/pull/1914)).

## [7.7.0] - 2026-11-21

Manki 7.7 is about the first round finding what later rounds used to find. Each finder answers for every unit of the change, a second read looks for what the first one missed, and new checks beside the finders ask whether each fix reaches its root cause and whether new code fits how the repository already does the same thing. Each slice of a large PR gets a map of the whole change, and a check can read a dependency's source at the version the PR builds against, or any file as it was before the PR. A blocker the base branch already had stops blocking once two checks prove it, and a failed review retries only the part that failed. Read Breaking changes and migration before upgrading: a Gemini login kept on a self-hosted runner is no longer used, and pre-existing blockers need a second refuter on another model.

### Breaking changes and migration

1. New top-level setting `closed_paths`, a list of globs that closes nothing by default. No review stage may read a closed path: it is left out of every diff, deleted from the checkout the reviewer tools read, and refused by Manki's tool server with a message that names the pattern. A PR that changes a closed file lists it as unread, so Manki never approves it and a person has to look. `exclude_paths` keeps its meaning ("not in the diff") ([#1785](https://github.com/manki-review/manki/pull/1785)).
2. New setting `review.scope_blocks`, off by default. Every round that reads more than a trivial change now asks whether the PR is useful and whether it mixes topics that belong in separate PRs, and shows a doubt or the proposed PRs in a **Scope** section of the review body that never holds the approval. With the setting on, a doubt the refuter confirms from the code, or a proposed split, becomes a warning that holds the approval until its thread is resolved. A PR has at most one such thread of each kind, and a settled one opens again only when the PR title or description changes ([#1798](https://github.com/manki-review/manki/pull/1798)).
3. New action input `openai_oauth_file` names a Codex login file (`auth.json`) on a self-hosted runner, in place of the `openai_oauth_token` secret. Manki writes the tokens Codex renews back to the file, so the login no longer goes stale and nobody has to upload the secret again. The run stops with a message when another user can read the file, when it is a symbolic link or sits in the workspace, or when `openai_oauth_token` or `openai_base_url` is set too. `docs/getting-started.md` has the steps ([#1813](https://github.com/manki-review/manki/pull/1813)).
4. A blocker is posted as pre-existing only when two refuters on different models prove the base branch fails the same way, so set `models.second_refuter` to a model other than the judge's to use it. With one refuter the blocker keeps blocking and only gets a "Possibly older than this PR" note ([#1841](https://github.com/manki-review/manki/pull/1841), [#1868](https://github.com/manki-review/manki/pull/1868)).
5. A `dependency` related repo without a `ref` is now read at the commit the PR's own lockfiles lock for it, instead of its default branch. A configured `ref` still wins, and a repo no lockfile locks at one commit is read at its default branch as before ([#1858](https://github.com/manki-review/manki/pull/1858)).
6. A Gemini reviewer on a self-hosted runner no longer uses a login kept in `~/.gemini/oauth_creds.json`. Set `gemini_oauth_token` instead ([#1805](https://github.com/manki-review/manki/pull/1805)).

### How finders search

- Each finder answers for every unit of the change: every function the change touches and every run of lines that adds, changes or removes a condition. It gives one line per unit with what it checked and the defect it found or none. A unit without a line is asked about once more, and one still without a line shows in the round record as not covered. Unit lines are never posted ([#1853](https://github.com/manki-review/manki/pull/1853)).
- A first review reads the change a second time inside the same round, and so does a later round after a push that changes more than half of the diff. A PR read in slices gets no second read. One finder's model reads its message again with the location and title of each finding so far, and is asked only for defects the list does not cover. This costs one or two more finder calls, and the progress comment counts them on a line of their own ([#1854](https://github.com/manki-review/manki/pull/1854)).
- A call beside the finders finds the fixes in a change, also in a feature or refactor PR, and checks each one for its root cause. A fix that only hides the symptom gets a finding that names the cause and the change there that would replace the PR's fix. The sibling comparisons, related repository checks, claim checks, sweeps and the verdict reader also propose the fix at the root cause ([#1851](https://github.com/manki-review/manki/pull/1851), [#1869](https://github.com/manki-review/manki/pull/1869)).
- Each new file, type, function, error kind or config key gets one small call that finds at least two places in the repository doing the same kind of thing and compares the new code with them. A finding is posted only for a difference the code shows, with its practical cost, such as a new handler that skips the session check every other handler makes ([#1848](https://github.com/manki-review/manki/pull/1848)).
- On a PR over 1,500 changed lines, each slice now gets a short map of the other slices: how each file changed and up to 6 declarations the change removes, changes or adds there. A defect split across two slices, such as a signature changed in one and called the old way in another, no longer depends on a finder opening the other file. A finder that read in slices and opened none of the listed files outside the diff is asked again, as a finder of one call already was ([#1855](https://github.com/manki-review/manki/pull/1855), [#1803](https://github.com/manki-review/manki/pull/1803)).
- The finders, claim checks and refuters can read a dependency's published source at the version the PR builds against, named as `crates.io/<name>` or `npm/<name>`. A claim about the library's behaviour can then be confirmed or disproved from its own lines, cited as `crates.io/time@0.3.47:src/date.rs:120`. Manki reads only crates.io and npm over HTTPS, checks the archive against the lockfile's checksum, and refuses a package whenever the installed code could differ from the registry's, such as with an override, a patch or another registry ([#1793](https://github.com/manki-review/manki/pull/1793)).
- Every stage with repository tools can read a file as it was before the PR with `read_file` and `ref: base`. A refuter can see whether the code already failed the same way, and a finder or a reply can read a file the PR deletes ([#1846](https://github.com/manki-review/manki/pull/1846)).

### Earlier threads

- A push that claims to fix a thread but only works around the reported case leaves the thread open as partly fixed, with the cause or the input that still fails. This holds whatever the judge found when a standing fix check calls the push a workaround within 5 lines of the thread ([#1869](https://github.com/manki-review/manki/pull/1869)).
- A review pauses with "a blocker came back after a fix" only after a real fix was tried. A blocker the author dismissed, or said another PR fixes, while leaving the code alone is posted again as a normal blocker and automatic review goes on. A blocker settled without a fix never counts as a failed fix, and a finding that restates such a waived thread under a new title in the same file is dropped ([#1843](https://github.com/manki-review/manki/pull/1843), [#1871](https://github.com/manki-review/manki/pull/1871)).
- A reply that says another pull request fixes a finding is checked. When that PR is merged into the default branch and replaced the finding's line, Manki confirms it and asks to update the branch, otherwise it answers Unverified with the reason. The check never resolves a thread or lifts a hold. A dismissal note and the approval name the claimed PR and whether Manki confirmed it ([#1847](https://github.com/manki-review/manki/pull/1847)).
- Dedup against resolved and dismissed threads also catches a repeat a finder cites from another file, when it shares a cited line with the earlier finding ([#1843](https://github.com/manki-review/manki/pull/1843)).

### Review loop and verdicts

- A blocker whose failure the base branch already had no longer blocks the PR. A check reads the base with repository tools, and Manki accepts its answer only when the cited lines are there at the base and the flagged line is one the PR left unchanged. When two refuters on different models both pass, the finding is posted as pre-existing with "Already broken before this PR" and does not hold the approval. The judge's own call that a finding is pre-existing never lowers a grade ([#1841](https://github.com/manki-review/manki/pull/1841), [#1868](https://github.com/manki-review/manki/pull/1868)).
- A pre-existing finding is posted only when it would block had the PR caused it, or when it is a security finding. Every other pre-existing finding goes to the round record only ([#1841](https://github.com/manki-review/manki/pull/1841)).
- A warning needs a consequence someone would notice in realistic use. A real cost nobody would notice is a note, and a finding about a cost states the scale the code shows. When the code does not show the scale, the warning stays ([#1884](https://github.com/manki-review/manki/pull/1884)).
- A blocker a finder filed is no longer lost when the judge drops it on an unchecked claim about code outside the diff. The refuter checks that claim, and the finding is posted only when the check disproves it ([#1839](https://github.com/manki-review/manki/pull/1839)).
- When two finders report the same defect and only one files it as a blocker, a doubt the judge names needs every check to confirm the consequence too. Without that the finding is posted as a warning ([#1835](https://github.com/manki-review/manki/pull/1835)).
- A warning is no longer posted as confirmed when its check left open the premise the judge said decides whether the defect exists. It stays in the round record as unsettled. A blocker keeps its grade, and only its status label can change ([#1831](https://github.com/manki-review/manki/pull/1831)).
- A finding that repeats another one from a different file goes to the dedup model, so it is no longer posted twice. This covers sweep findings, verdict reader blockers and earlier open findings ([#1830](https://github.com/manki-review/manki/pull/1830)).

### Review format

- While a review runs, the progress comment shows what each stage is doing: each finder's tool steps and time so far, one line for the comparisons and claim checks, and the judge's grading, refuter checks and verdict reader. The finished comment adds up: the side checks, second reads and sweeps keep their lines, the sweeps sit under the judge, and the judge's line names merged findings and what was added before and after it ([#1825](https://github.com/manki-review/manki/pull/1825), [#1863](https://github.com/manki-review/manki/pull/1863), [#1865](https://github.com/manki-review/manki/pull/1865)).
- A message that names a next step carries a box for it, so the step is one tick: **Review again**, **Check approval**, **Forget this learning** and **Dismiss this finding**. The text still names the command as a second way ([#1856](https://github.com/manki-review/manki/pull/1856)).
- A "Needs a human" headline says how much the round found, such as "1 blocker came back after a fix, plus 3 blockers and 1 warning in threads." A "Changes requested" line no longer counts a warning thread as a blocker ([#1836](https://github.com/manki-review/manki/pull/1836)).
- A finding with an open issue that tracks it shows "Tracked in #N". The link never changes a grade or a hold ([#1868](https://github.com/manki-review/manki/pull/1868)).
- A review with a finding off the changed lines shows as one review. File-level threads no longer appear as a second, empty review ([#1840](https://github.com/manki-review/manki/pull/1840)).
- The review box reads "Review now" until the PR's first review, and "Review again" after it ([#1819](https://github.com/manki-review/manki/pull/1819)).
- Test files are told apart by one rule that follows each language's test tools, so Swift, Java, Kotlin, C#, Go, Python, Ruby and Rust test layouts count when notes on test files are dropped from the second round on. A data or document file counts only under a test folder ([#1803](https://github.com/manki-review/manki/pull/1803)).

### Security

- On a self-hosted runner, a Claude or Gemini reviewer no longer sees what the runner's user keeps in `~/.claude`, `~/.claude.json`, `~/.gemini` or `~/.agents`. Before, the Gemini CLI read the runner's instructions, extensions, MCP servers and `.env`, and the Claude CLI wrote each call's transcript into the runner's home ([#1805](https://github.com/manki-review/manki/pull/1805)).
- Manki reads a Codex call's answer, limits and errors from the JSON events of `codex exec --json` instead of plain text. A pull request that steers the model into writing `ERROR:` lines can no longer make a failed call pass for a limit or a retry ([#1812](https://github.com/manki-review/manki/pull/1812)).
- A maintainer can let an account without write access use Manki in one repository with `/manki allow`, `/manki disallow` and `/manki allowed`. An allowed account's commands, replies and box ticks work like a collaborator's, but it never holds a role such as `author_clear_role`. `docs/security.md` has "Who can command Manki" ([#1867](https://github.com/manki-review/manki/pull/1867)).

### Reviewer groups and models

- `gpt-6.2-sol` has a price, the same as GPT 6.1 Sol, so its cost is no longer unknown ([#1817](https://github.com/manki-review/manki/pull/1817)).
- A Codex reviewer records its token counts, so the round's cost and token totals include it ([#1822](https://github.com/manki-review/manki/pull/1822)).
- A long-prompt price applies only when one request of a call passes the limit, not when the call's requests add up past it. A CLI call with tools was estimated at about twice its cost ([#1824](https://github.com/manki-review/manki/pull/1824)).

### Reliability

- The next review of a commit whose round ended incomplete keeps the results of the finders and checks that finished and runs only what failed. The review says what it kept. Review again and Deeper review keep nothing ([#1849](https://github.com/manki-review/manki/pull/1849)).
- The token service's automatic retry of an incomplete review says so in its progress comment and review. The incomplete message says when that retry comes, and the failed run's progress comment is kept and marked superseded ([#1821](https://github.com/manki-review/manki/pull/1821)).
- A failed OIDC token request is retried and its cause is logged. Before, a runner that lost its connection to GitHub ended with "the workflow needs `id-token: write`" although the workflow granted it ([#1882](https://github.com/manki-review/manki/pull/1882)).
- A finder that fails now logs why each attempt failed: the error type, the HTTP status or CLI exit code, and whether its answer could not be read. Before, the log said only that it failed after retries ([#1887](https://github.com/manki-review/manki/pull/1887)).

### Docs

- `docs/how-reviews-work.md` says a Codex call records `wrapUpNoted` too ([#1845](https://github.com/manki-review/manki/pull/1845)).

### Internal

- The round record keeps the tool steps and files read of a Codex finder too, with the file and result size of each step, and `review-stats` shows the characters per read step ([#1844](https://github.com/manki-review/manki/pull/1844)).
- The benchmark scores what each finder reported, so a missed item shows as never reported or as dropped at a named stage, and records which step raised each finding ([#1814](https://github.com/manki-review/manki/pull/1814), [#1881](https://github.com/manki-review/manki/pull/1881)).
- `bench-report gate` exits non-zero unless the gate passes, so the benchmark's `report` job fails on a failed gate ([#1880](https://github.com/manki-review/manki/pull/1880)).
- `review-history` writes a line for each round record it could not decode, and `calibration` skips that PR ([#1816](https://github.com/manki-review/manki/pull/1816)).
- New tuning cases for the pattern checks, for fixes that hide the symptom and for large PRs with defects across slices ([#1850](https://github.com/manki-review/manki/pull/1850), [#1852](https://github.com/manki-review/manki/pull/1852), [#1862](https://github.com/manki-review/manki/pull/1862)).
- Add real findings to hold-out keys ([#1883](https://github.com/manki-review/manki/pull/1883)).

## [7.6.3] - 2026-11-18

Manki 7.6.3 makes a review finish when a model is limited or its endpoint cannot be reached. A limited or unreachable reviewer moves to its fallback model, a reviewer that ran out of time is not started over, and a round keeps inside the job's time so it always posts. Codex reviewers run in a home folder of their own, with only Manki's tools, and wait until those tools are ready. A review that is held by earlier warnings now names them. No setting changes.

### Review loop and verdicts

- On a repository with `related_repos`, each counterpart the related repository search lists for the finders now also gets a small call of its own beside the finders. A reference counterpart is compared with the change, a consumer is checked for uses the change breaks, and a dependency for assumptions the change makes about it. Finders had opened few of the listed files ([#1796](https://github.com/manki-review/manki/pull/1796)).

### Review format

- A review held only by warning threads of earlier rounds said how many warnings were left to address but named none of them. It now lists each one under its first line, with its file, the line its finding names and a link to its thread. When the approval check holds the approval for a new reason, such as a conflict with the base branch, its notice first says which earlier holds have cleared, for example that every warning is handled ([#1809](https://github.com/manki-review/manki/pull/1809)).

### Security

- A Codex reviewer was offered tools of Codex's own, such as subagents, goal tools and a request for user input, although `docs/security.md` said it had only Manki's read-only tools. Four more Codex switches now remove them. What Codex 0.166.0 still offers and cannot switch off is listed in `docs/security.md`: a script host without file, network or shell access, empty resource tools, and a patch tool whose writes the sandbox refuses but which can confirm a guessed line of a file the runner user can read. A new CI check fails when a Codex version offers a tool that is not on the recorded list ([#1786](https://github.com/manki-review/manki/pull/1786)).
- Codex no longer sends usage events to OpenAI's analytics during a review, and no longer adds the text of its built-in skills to the prompt ([#1795](https://github.com/manki-review/manki/pull/1795)).
- Codex read the runner user's own `~/.codex` and `~/.agents`, so skills, instructions, MCP servers, hooks, a key in `.env` or a changed endpoint there could reach a review on a self-hosted runner. Each run now gets a private Codex home that holds only what Manki writes, deleted when the run ends ([#1799](https://github.com/manki-review/manki/pull/1799)).

### Reliability

- A model that hit a rate limit, a used-up quota or a "model at capacity" error ended the review incomplete. That stage now moves to its fallback model with the time its call has left, the same model a safety refusal moves to (`models.fallback`, or else the first other model of the `full` group). A finder that reads the repository with tools moves only to a fallback that has them too, and two finders never move onto one model ([#1777](https://github.com/manki-review/manki/pull/1777)).
- A reviewer that used up its time was started again from scratch with the same time, which could run past the job's limit, and a job that is stopped posts nothing. A reviewer that timed out is now not retried. A round in the action keeps its model calls inside 25 minutes and stops the finders 8 minutes before that, so the judge and the posting always fit within the template's 30-minute job. A stage that no longer fits ends the round incomplete, with the findings of the finders that finished, and the review says why a retry or fallback did not start. A workflow with a longer `timeout-minutes` still stops at 25 minutes, and one with a shorter limit is not covered ([#1789](https://github.com/manki-review/manki/pull/1789)).
- Every model call after the finders, such as the judge, a refuter check, a sweep, a dedup call or the verdict reader, now checks the time left before it starts. A call that no longer fits is not started, the calls running beside it are stopped, and the round ends incomplete right there, keeping everything it produced so far ([#1794](https://github.com/manki-review/manki/pull/1794)).
- A Codex call whose endpoint could not be reached printed only "Reconnecting... waiting for network" and waited out its whole time limit. It now ends after 2 minutes of only that line ([#1789](https://github.com/manki-review/manki/pull/1789)). When Codex shows that no request reached the model, the reviewer moves to its fallback model under the same rules as a limit, instead of a retry on the same network ([#1807](https://github.com/manki-review/manki/pull/1807)).
- Codex sent its first request before Manki's tool server had started, so a slow start left the model without Manki's read tools for the whole call. Codex now waits for the tool server, and a call fails when the server does not start ([#1799](https://github.com/manki-review/manki/pull/1799)).

### Internal

- `review-stats` reports the share of blockers and warnings found in round 1, and how often finders open files with their tools ([#1780](https://github.com/manki-review/manki/pull/1780), [#1788](https://github.com/manki-review/manki/pull/1788)).
- The benchmark gate reruns the cases of an item that looks lost before it fails, and scores a finding folded into an earlier thread as not posted again ([#1782](https://github.com/manki-review/manki/pull/1782), [#1783](https://github.com/manki-review/manki/pull/1783)).

## [7.6.2] - 2026-11-18

Manki 7.6.2 keeps a review with a GPT model going when an OpenAI-compatible endpoint throttles it. Nothing else changes, and nothing breaks on the upgrade.

### Reliability

- An endpoint that throttles answers 429 without naming a wait. A reviewer on a GPT model then failed at once with "OpenAI endpoint limit reached", and the review ended incomplete after minutes of work. Manki now pauses and resumes the same Codex session, so nothing the reviewer already read is lost. If the endpoint still answers 429 after the last resume, the call fails as before ([#1771](https://github.com/manki-review/manki/pull/1771)).
- The pauses before a resume are 5, 15, 30 and then 60 seconds, also for a model at capacity. They were 15, 30 and 60, so a short throttle now costs seconds ([#1771](https://github.com/manki-review/manki/pull/1771), [#1773](https://github.com/manki-review/manki/pull/1773)).

## [7.6.1] - 2026-11-18

Manki 7.6.1 fixes reviews with a GPT model through an OpenAI-compatible endpoint on a fresh runner. Nothing else changes, and nothing breaks on the upgrade.

### Reliability

- With `openai_base_url` and `openai_api_key`, every Codex call failed at once on a runner whose home has no `.codex` folder, and the round ended as "Review incomplete" with the GPT finder failed after its retry. Codex exits when that folder does not exist, and only the ChatGPT login path created it. Manki now creates it before an endpoint call. A workflow that pins `@v7.6.0` and sets `openai_base_url` should move to `@v7.6.1` ([#1762](https://github.com/manki-review/manki/pull/1762)).

## [7.6.0] - 2026-11-17

Manki 7.6 runs GPT models through any OpenAI-compatible endpoint and makes long Codex calls hold up: a silent call is no longer ended after 90 seconds, a model at capacity is named and its session resumed, and the judge gets 15 minutes. It also tidies `.manki.yml`: review groups are the only place that names the finders, and nine rarely used settings are gone. Manki writes its commands as `/manki`. Some settings change with no transition, so read Breaking changes and migration first.

### Breaking changes and migration

A removed or moved key gets the usual unknown key warning and is otherwise ignored, so the review runs with the default. Two old forms do not load at all, and Manki then reviews with the defaults and holds its approval: `@reviewer` or `@reviewer_pair` as a model, and a group written as `{ reviewers: [...] }`.

1. Review groups are the only place that names the finders. `models.reviewer` and `models.reviewer_pair` are gone, and so are `@reviewer` and `@reviewer_pair`. A group is a plain list, and an entry is a model id or a map with `model`, `effort` and `focus`. The `reviewers:` level and the `role` key are gone. The built-in groups are `trivial` (the quick check) and `solo` on Sonnet, and `full` on Sonnet and Opus. `full` is the new name of `pair`. A repository that set `models.reviewer: gpt-6.1-terra` now writes all three groups, for example `trivial: [gpt-6.1-terra]`, `solo: [gpt-6.1-terra]` and `full: [gpt-6.1-terra, claude-opus-5-5]` under `review.groups`. Without a `review.groups` block a review is what it was ([#1754](https://github.com/manki-review/manki/pull/1754)).
2. A config that sets `review.groups` must define all three of `trivial`, `solo` and `full`, and may add groups of its own. `full` must hold at least two finders on two distinct models, where `openai/gpt-5.5` and `gpt-5.5` count as one. A config that breaks either rule does not load. An entry of `trivial` without `effort` runs at medium, and a `focus` there gets the unknown key warning, since the quick check takes none ([#1754](https://github.com/manki-review/manki/pull/1754)).
3. `review.default_group` and `review.allow_weaker` are gone. A class with no route goes to `full`, and a route that puts a security, CI or data contract class below its floor never loads. `review.routing` is always the built-in routes with the config's on top ([#1754](https://github.com/manki-review/manki/pull/1754)).
4. `models.refuter_pair` is now `models.second_refuter`, with the same behaviour ([#1754](https://github.com/manki-review/manki/pull/1754)).
5. Without `models.fallback`, a stage that a safety filter refused moves to the first model of the `full` group that is another model than its own. Before, it moved to `models.reviewer`. The sibling comparisons, claim checks and sweeps run on the first reader of the group that reads the PR, where they ran on `models.reviewer` ([#1754](https://github.com/manki-review/manki/pull/1754)).
6. Nine settings are removed, and each keeps its default as fixed behaviour: `review_passes` (every finder runs once), `planner.enabled` (the planner always runs), `slice_lines` (1500), `static_analysis.wait_timeout_seconds` (300), `convergence.rounds_after_restart` (3), `convergence.suppress_resolved_threads` (on), `convergence.test_path_patterns` (the default list), `metrics.fix_rate` (recorded when `memory.enabled` is true) and the top-level `reviewers` list, whose checks belong in `instructions`. The `focus` of an entry in a review group stays. A repository that turned the planner off to run without Anthropic credentials has to set `models.planner` to a model it has credentials for, or every round fails with `Invalid model config` ([#1755](https://github.com/manki-review/manki/pull/1755)).
7. `convergence.max_auto_rounds` is now the top-level `max_auto_rounds`, and the `convergence` block is gone. A repository that set the old key gets the default cap of 10 until it moves the setting ([#1755](https://github.com/manki-review/manki/pull/1755)).

### OpenAI-compatible endpoints

- New action input `openai_base_url`. With it and `openai_api_key`, every OpenAI model call runs through the Codex CLI against that OpenAI-compatible endpoint, with the same repository tools, step budget and related repositories as on the Codex subscription path. `openai_base_url` without `openai_api_key`, together with `openai_oauth_token`, or with a value that is no `http` or `https` URL stops the run with a message that names the problem. The local `manki review` command and `npm run smoke` read the endpoint from `OPENAI_BASE_URL` ([#1727](https://github.com/manki-review/manki/pull/1727)).
- A Codex call on an endpoint whose stream fails is resumed in the same session, so the call keeps everything it already read. Before, Codex sat out any wait the endpoint named in silence, which could be more than five minutes at a time and ended a finder in a timeout. Manki now resumes at once after a dropped connection, after 15, 30 and then 60 seconds when the model is at capacity, and after the wait a rate limit names, up to 8 times and always inside the call's time limit. A used-up quota, a rate limit that names no wait and any other error are not resumed. The tool step limit holds across the resumed runs, and each resume logs one line. The ChatGPT login path is unchanged ([#1741](https://github.com/manki-review/manki/pull/1741)).
- A rate limit or used-up quota on an endpoint reads "OpenAI endpoint limit reached" and suggests another key, instead of "ChatGPT subscription limit reached" ([#1727](https://github.com/manki-review/manki/pull/1727)).

### Review loop and verdicts

- A `/manki review` comment on a commit that already has a complete review gets a reply that says so. Before, it started no round and got no answer. While automatic review is paused, the reply adds the pause notice with the open blockers and who may clear them ([#1728](https://github.com/manki-review/manki/pull/1728)).
- A run that ends because its commit already has a review now also completes the waiting `Manki` check when that review held its approval. The check is neutral with the hold as its title while something still holds the approval, and Manki approves once nothing does. Before, the check ended as "Review did not run", which a required status check then read ([#1732](https://github.com/manki-review/manki/pull/1732)).

### Review format

- A finding on a line that takes no comment gets a thread on its file, and that thread now opens with a link to the finding's line at the reviewed commit ([#1736](https://github.com/manki-review/manki/pull/1736)).
- An approval that relies on findings the PR author dismissed lists them, with the author and the role named once in the heading. Before, it was one long sentence that repeated both for each finding ([#1716](https://github.com/manki-review/manki/pull/1716)).
- An issue filed from a `Create an issue for this` box names the person who ticked it, as a mention, so GitHub notifies them. A tick that finds an open issue for the same finding still only links it ([#1730](https://github.com/manki-review/manki/pull/1730)).
- Manki names every command as `/manki <command>` in its reviews, notices, answers and docs. `manki` is the login of an unrelated GitHub user, who was notified by every comment that wrote the name with an at sign. A command written that way still works, and Manki's answer to it ends with a line that asks for `/manki` next time. A review command that starts a round gets no such line, because its only comment is the progress comment ([#1756](https://github.com/manki-review/manki/pull/1756)).

### Reliability

- The judge has 15 minutes per attempt, with or without tools. A judge without tools had 5 minutes per call, which a slow model, such as a GPT model through the Codex CLI at high effort, ran past, and the round ended incomplete. The calls of one attempt share the 15 minutes. A judge with tools that fails grades once more without them in the time that is left, and never in less than 5 minutes, so the judge takes at most 15 minutes without tools and 20 with them. A judge that runs out of time ends the round with "The judge ran out of time" in place of "The judge failed". On every stage, a call that moves to the fallback model after a refusal gets only the time the refused call left, and a request on an OpenAI API key gets the call's limit, where it had a fixed 5 minutes ([#1745](https://github.com/manki-review/manki/pull/1745)).
- A Codex or Gemini CLI call is no longer ended as stale after 90 seconds without output. Those CLIs print the answer at the end, so a healthy call that thought for longer failed with "CLI stale". Such a call now ends only by the time limit of its stage, and the calls that had none get the limit their stage already uses with tools ([#1725](https://github.com/manki-review/manki/pull/1725)).
- A Codex call that ends because the provider reports the model at capacity now fails as "OpenAI model at capacity" instead of a generic CLI failure, and a call that ran out of time while Codex waited on the provider says so, with the retry it was on. Manki reads Codex's own final error line only, also when Codex prints its token count below it, so text from a pull request is never taken for a Codex error ([#1738](https://github.com/manki-review/manki/pull/1738), [#1740](https://github.com/manki-review/manki/pull/1740)).

### Docs

- `docs/getting-started.md` says where the ChatGPT login (`openai_oauth_token`) may be used: only on a private runner that you trust, and not for a public or open-source repository, where `openai_api_key` is the right choice. `docs/security.md` and `action.yml` point to that section ([#1733](https://github.com/manki-review/manki/pull/1733)).

### Internal

- `review-stats` gets a "Sweeps" section: how the sweeps of the merged PRs ended, what they reported, what was posted and what they cost. The dedup and refuter calls that run only for a sweep's findings are marked in the round record, so the cost is complete ([#1719](https://github.com/manki-review/manki/pull/1719)).
- Manki's own reviews run with `review.sweep: warnings` as a trial. The default stays `off` ([#1720](https://github.com/manki-review/manki/pull/1720)).
- A release that is merged but not published can take more changes under the same version: a PR that changes `CHANGELOG.md` alone becomes the new release commit, and the `Release` workflow and the publish script refuse the commit it replaces. `RELEASE.md` has the steps ([#1757](https://github.com/manki-review/manki/pull/1757)).

## [7.5.2] - 2026-11-16

Manki 7.5.2 makes approvals, checks and threads do what they say. A warning holds the approval until Manki accepts an answer to it, a run that finds its commit already reviewed reports the `Manki` check, a merged PR is left as it is, and a withdrawn finding leaves a learning only once its thread is cleared.

### Review loop and verdicts

- A warning thread holds the approval until its warning is settled. In 7.5.0 and 7.5.1 any reply from the PR author lifted the hold, also one that Manki answered with Kept or Unverified. The hold now lifts only when Manki answers a reply with Fixed, Withdrawn or Agreed, when a round finds the warning fixed, when the `Create an issue for this` box files it, or when a person with the `author_clear_role` role resolves the thread. A Kept or Unverified answer, a reply without an answer, `/manki dismiss` and a resolve by anyone below that role leave it. A round that names the warning again makes the thread hold again. The held review, the `Manki` check and Manki's answers say what lifts the hold. On a PR that is open at the upgrade, a warning thread holds again when it was only replied to, resolved by someone below that role, or tracked with the issue box before the upgrade, until one of the four happens ([#1713](https://github.com/manki-review/manki/pull/1713)).
- A run that ends because its commit already has an approval or a change request now completes the waiting `Manki` check with that review's result: success for an approval, failure for requested changes, and neutral when a draft, a conflict or an open warning now holds that approval. Before, the check ended as "Review did not run" on a commit with a valid review. The check is left as it is when the commit's own review is a comment, such as an approval that was held when it was posted, and when the review or the hold cannot be read ([#1709](https://github.com/manki-review/manki/pull/1709)).
- On a merged or closed PR Manki still answers a thread reply, `dismiss` and `check`, and they change nothing about the review: no thread is resolved or reopened, nothing is approved, no review is dismissed and no suppression is stored. Neither does a thread someone resolves or reopens there. Before, a thread resolved after the merge could still bring an approval or a reopened thread. A tick of the `Create an issue for this` box still files the issue and resolves its thread ([#1708](https://github.com/manki-review/manki/pull/1708)).

### Review memory

- A reply that gets a finding withdrawn saves its learning only once the thread is cleared. A blocker thread that stays open on a reply from the PR author leaves none, and neither does a thread Manki cannot find, read or resolve. Manki adds the "Saved a learning" line to its answer after the thread is resolved ([#1712](https://github.com/manki-review/manki/pull/1712)).

### Docs

- `docs/getting-started.md` says that a PR a bot opens or pushes to gets no automatic review and no `Manki` check, and that `@manki review` still starts one ([#1707](https://github.com/manki-review/manki/pull/1707)).

### Internal

- `bench/README.md` describes `followUp.threads` of the benchmark report ([#1702](https://github.com/manki-review/manki/pull/1702)).
- A hold-out follow-up case keys an earlier thread that the push fixed only in part as kept open ([#1704](https://github.com/manki-review/manki/pull/1704)).

## [7.5.1] - 2026-11-16

Manki 7.5.1 makes finders read more of the code around a change, asks whether a fix reaches the root cause of its problem, and lets the judge see a blocker's fix on a large PR. It also reviews a rebased PR that an earlier version skipped, removes settings that did nothing and fixes a set of small problems.

### Breaking changes and migration

- The `config_path` action input is gone. Manki reads `.manki.yml` at the root of the base branch only, as the token service always did, and GitHub warns in the run log when a workflow still passes the input ([#1665](https://github.com/manki-review/manki/pull/1665)).
- The deprecated settings `nit_handling`, `review_level`, `review_thresholds`, `stats` and `planner.paired` are gone. A config that still sets one gets the usual unknown key warning ([#1662](https://github.com/manki-review/manki/pull/1662)).
- A Manki review counts for a commit only when its own text names that commit in full. A PR whose newest Manki review names none gets one more review on its next push. That is a review from before 7.1.0, or an approval that 7.5.0 or earlier posted again after a rebase ([#1694](https://github.com/manki-review/manki/pull/1694)).
- `manki review` without a base now stops when `origin/HEAD` is not set, instead of guessing `main`. Name the base, as in `manki review main`, or run `git remote set-head origin --auto` ([#1659](https://github.com/manki-review/manki/pull/1659)).

### Review loop and verdicts

- A round with no finding, no open thread and no carried warning skips the judge call. The verdict reader still reads the whole diff and can still request changes, and the round record says the judge was skipped ([#1661](https://github.com/manki-review/manki/pull/1661)).
- The judge also sees the code a finding cites outside the diff in its evidence lines, not only in its proof lines, so such a finding is no longer left out as unproven every round ([#1658](https://github.com/manki-review/manki/pull/1658)).
- The next round's judge sees a premise a check confirmed as confirmed, also when the check left open or disproved the finding's consequence ([#1660](https://github.com/manki-review/manki/pull/1660)).
- An approval held for a config that does not load or for unread files now also says when the PR is a draft or conflicts with its base ([#1664](https://github.com/manki-review/manki/pull/1664)).

### How finders search

- On a follow-up round, finders get the diff since the last reviewed head, with the files of open threads first, and are asked what the fix commits themselves break. They still review the whole PR as a first round would ([#1677](https://github.com/manki-review/manki/pull/1677)).
- Once a finder finds a defect, it checks which other inputs reach the same lines and which other places in the change make the same mistake, and lists every case in that one finding, with a fix that covers each ([#1669](https://github.com/manki-review/manki/pull/1669)).
- Manki also reads the contributing guide from `.github/CONTRIBUTING.md` and `docs/CONTRIBUTING.md`, taking the first one it finds in GitHub's order, so its rules are checked in repositories that keep it there ([#1657](https://github.com/manki-review/manki/pull/1657)).
- Finders ask of every fix whether it reaches the root cause of the problem or only works around its symptom. A finding about a workaround cites the code that causes the problem and says what change there would replace the PR's fix, or names the input or path that still fails ([#1691](https://github.com/manki-review/manki/pull/1691)).
- A finding's fix advice goes to the root cause of the problem. It no longer advises repeating the PR's own handling on another path when one change at the root cause covers every path ([#1687](https://github.com/manki-review/manki/pull/1687), [#1690](https://github.com/manki-review/manki/pull/1690)).
- The lists of uses outside the diff and of lines in related repositories point finders at more files: the best line of each file comes before a second line of any file, and generated code, mocks and vendored code come last. A finder that can open files is told to open the listed files before it answers. The judge and the refuter get the lists as before ([#1683](https://github.com/manki-review/manki/pull/1683)).
- A finder that opened none of the listed files outside the changed files is asked once more, and its second answer replaces the first. The round record marks it with `askedAgain` ([#1682](https://github.com/manki-review/manki/pull/1682)).

### Earlier threads

- On a large PR, the judge reads the files of open threads before other changed files and gets the diff since the last round with those files first, so a correct blocker fix is no longer left open because the judge never saw it. When a fix may still fall past the cut, the judge is told so and does not call the thread fixed ([#1655](https://github.com/manki-review/manki/pull/1655)).
- A warning listed only in an earlier review body leaves "Earlier warnings, code unchanged" once the judge, which now gets it with the diff since the last round, finds it fixed. Before, a fix a few lines away kept it listed every round ([#1658](https://github.com/manki-review/manki/pull/1658)).
- A reply in a thread about the PR description is checked against the PR's current title and description. Before, it got "Unverified", because the description is not part of the checked-out code ([#1681](https://github.com/manki-review/manki/pull/1681)).

### Review format

- Style suggestions come after every other suggestion, so a style point is posted only when fewer other suggestions than `review.notes` exist ([#1663](https://github.com/manki-review/manki/pull/1663)).

### Reliability

- After a force push that only rebases a PR, GitHub can list an earlier Manki approval under the new head. Manki took the new head for approved, started nothing, and its check ended as "Review did not run". Manki now reads the reviewed commit from the review's own text, so such a push keeps the earlier verdict with a passing check, and a rebase that changes the PR gets a review ([#1694](https://github.com/manki-review/manki/pull/1694)).
- Logged model output keeps text like `std::fmt::Display`. Only a workflow command where it starts a line is neutralized, which the OpenAI client now does the same way as the others ([#1654](https://github.com/manki-review/manki/pull/1654)).
- Issue commands such as `remember` read `.manki.yml` from the repository's default branch, not from a branch named `main` ([#1659](https://github.com/manki-review/manki/pull/1659)).
- A stored refuter check is no longer reused when text moves between two cited files. Every stored fingerprint changes, so the first round after the upgrade checks each earlier finding once more ([#1671](https://github.com/manki-review/manki/pull/1671)).
- When the claim lines are skipped, the round record names the step that was still running and the limit that ended the wait ([#1666](https://github.com/manki-review/manki/pull/1666)).
- `manki review --record` writes `approval` like a pull request round ([#1673](https://github.com/manki-review/manki/pull/1673)). Local and benchmark follow-up rounds count a push to a file a finding cited, as a pull request round does, with the new `evidence_files` field of a follow-up case ([#1670](https://github.com/manki-review/manki/pull/1670)).

### Docs

- `docs/how-reviews-work.md` says that a PR which only deletes binaries is "Not reviewed" and waits for a person, and that a deleted LFS pointer or submodule is read like a deleted text file ([#1674](https://github.com/manki-review/manki/pull/1674)).
- `CONTRIBUTING.md` says which grading changes need which replay ([#1667](https://github.com/manki-review/manki/pull/1667)).

### Internal

- Tests that start real `git` processes get a 30 s limit, and the live `mixed-worth` fixture accepts a note or a warning for its docstring finding ([#1672](https://github.com/manki-review/manki/pull/1672)).
- The title parser no longer reads the `: fix, explain or track` label, which no released version posted ([#1656](https://github.com/manki-review/manki/pull/1656)).
- A benchmark follow-up run stores how each earlier open thread ended in `followUp.threads` of its report: the final status, whether `confirmFixes` kept it open, and the grades of the findings posted under it ([#1700](https://github.com/manki-review/manki/pull/1700)).

## [7.5.0] - 2026-11-14

Manki 7.5 makes reviews quieter. A finding is now a blocker, a warning or a suggestion, a warning that nothing proves is held back, apart from a few kinds such as security warnings, and a review posts at most three of the model's suggestions by default. In return, an open warning holds the approval until it is fixed, explained, resolved or tracked. Manki also checks what the PR text and a thread reply claim against the code instead of taking it on trust, and every stage with repository tools can read the related repositories.

### Review loop and verdicts

- An open warning now holds Manki's approval: the round posts a `COMMENT` review with a neutral `Manki` check, and each warning on the PR's own code is posted as a thread wherever GitHub accepts one, which stops holding once a later round finds it fixed, someone allowed to resolves the thread, its `Create an issue for this` box is ticked, or, for a warning that is not a security warning, the PR author explains in it why it needs no fix ([#1621](https://github.com/manki-review/manki/pull/1621), [#1646](https://github.com/manki-review/manki/pull/1646)).
- The action's `verdict` output is `COMMENT` for every held approval, and the new `approval_held` output names the reason (`conflict`, `draft`, `config`, `unread`, `warnings`, or `refused` when GitHub refuses the approval), which `manki review --json` prints as `approvalHeld` ([#1640](https://github.com/manki-review/manki/pull/1640)).
- New setting `review.rules` grades a broken required rule of your instruction files, such as "every migration needs a rollback", once the judge confirms it: `auto` (default) by the damage it can do like any other finding, `warn` as at least a warning, and `block` as a blocker, and finders also check rules about the change as a whole, such as "one concern per PR" ([#1457](https://github.com/manki-review/manki/pull/1457), [#1485](https://github.com/manki-review/manki/pull/1485), [#1526](https://github.com/manki-review/manki/pull/1526), [#1650](https://github.com/manki-review/manki/pull/1650)).
- A warning that nothing proves is no longer posted. With repository tools, a warning the judge doubts, or one that cites no proving lines, gets a tool check, up to eight a round. One the check leaves unsettled, or that the eight checks did not reach, stays in the round record and is listed under "Checked and left out". Where no check could run, the cited lines decide. A security warning, a tool alert, a warning a confirmed rule grades under `review.rules: warn` or `block`, one that would be a blocker if true, wrong behaviour the judge calls rare, and a finding an earlier thread still carries are posted either way ([#1473](https://github.com/manki-review/manki/pull/1473)).
- The judge no longer states a grade. It states the cell of its severity table for each finding, and Manki works out the grade from the cell. A tool check that confirms normal use reaches wrong behaviour the judge calls rare no longer raises it to a blocker ([#1412](https://github.com/manki-review/manki/pull/1412), [#1567](https://github.com/manki-review/manki/pull/1567)).
- A finding the judge put in a blocker cell with doubts no longer becomes a blocker just because a check confirms every doubt. The judge states the grade it earns once confirmed. Unless a finder filed it as a blocker, it is a security finding or it restates an earlier blocker, the check must also confirm the consequence the judge names, and otherwise it is posted as a warning marked "confirmed with tools" ([#1579](https://github.com/manki-review/manki/pull/1579), [#1593](https://github.com/manki-review/manki/pull/1593), [#1616](https://github.com/manki-review/manki/pull/1616)).
- A blocker that only the judge raised goes back to its finders' grade when two checks on different models both disprove it, unless `review.rules: warn` or `block` holds a confirmed rule finding at the grade the rule gives. A check that confirms the defect while it disproves one of the judge's counter-arguments no longer drops the finding ([#1455](https://github.com/manki-review/manki/pull/1455), [#1614](https://github.com/manki-review/manki/pull/1614)).
- A finding the judge's reply leaves out is asked about once more. When the judge still skips it, the round ends incomplete instead of posting the finder's grade unchecked ([#1460](https://github.com/manki-review/manki/pull/1460)).
- The judge prompt no longer holds two rules that disagree on a suggestion resting on code the judge cannot see. It now says to drop such a suggestion, where before the same suggestion was kept in one run and dropped in the next. The judge also sees the changed files that a finding's evidence lines cite, up to ten lines a finding ([#1496](https://github.com/manki-review/manki/pull/1496)).
- Auto-approve reads the record of the review that covers the head and approves only when a thread on the PR carries every blocker the record names. A blocker listed only in the review body is no longer approved away by the check its own review started ([#1490](https://github.com/manki-review/manki/pull/1490)).
- A review command now starts a round when the newest review of the head gave no usable verdict, such as an incomplete round or one in which no model could read a file. With `auto_approve` on, marking a reviewed draft ready runs the approval check, so a clean draft is approved without another round ([#1572](https://github.com/manki-review/manki/pull/1572)).

### Earlier threads

- A blocker or security thread can now be cleared by a push to a file its finding cited in its "Checked in the code" evidence, once the judge finds the thread fixed, for findings posted by 7.5 or later ([#1651](https://github.com/manki-review/manki/pull/1651)).
- New setting `author_clear_role` sets the lowest repository role, `admin`, `maintain` (default, where 7.4 always required `admin`) or `write`, with which a PR author may clear a blocker or a security finding on their own PR, and it is read from the base branch only ([#1515](https://github.com/manki-review/manki/pull/1515)).
- A blocker in a file outside the diff, or tied to no file, now gets a file-level thread on the first changed file that says where the blocker is, so a later round can check it and a person can resolve it. When GitHub refuses the thread, the blocker is listed in the review body and the next round posts the thread again ([#1501](https://github.com/manki-review/manki/pull/1501)).
- The first time the PR author resolves a blocker or security thread, Manki reopens it as soon as it sees the resolve, not at the next round, with one note that says why. When Manki answers "Fixed." in such a thread, the same comment no longer asks for a fix ([#1505](https://github.com/manki-review/manki/pull/1505), [#1583](https://github.com/manki-review/manki/pull/1583)).
- An author's reply or resolve no longer counts as a claim of a fix. A blocker found again after the author answered "this is intended" keeps requesting changes and no longer pauses automatic review as "came back after a fix" ([#1503](https://github.com/manki-review/manki/pull/1503)).
- A review round and the approval check decide by the same rule whether a resolved blocker or security thread is cleared. Manki's own resolve counts only when a round found the thread fixed or a maintainer's reply backs it ([#1516](https://github.com/manki-review/manki/pull/1516)).
- A warning an earlier round listed only in the review body is listed again under "Earlier warnings, code unchanged" while the lines it points at read the same, unless a new finding takes its place ([#1464](https://github.com/manki-review/manki/pull/1464)).
- What remains of a partly fixed thread is graded from a severity table cell too, and a claim that the rest is rare lifts no block. An outdated thread counts as changed only by the PR's own change since the last reviewed round ([#1422](https://github.com/manki-review/manki/pull/1422), [#1436](https://github.com/manki-review/manki/pull/1436)).
- Before Manki answers a reply in a thread, it checks what the reply says about code, in the PR and in the related repositories, and lists up to five statements under its answer with what it checked. A "Kept." answer that cites a line of the thread's file without backticks counts as new proof ([#1507](https://github.com/manki-review/manki/pull/1507), [#1606](https://github.com/manki-review/manki/pull/1606)).

### How finders search

- `review.sweep` now names the lowest grade of a kept finding that starts a sweep: `off` (default), `blockers`, `warnings` or `notes` ([#1570](https://github.com/manki-review/manki/pull/1570)).
- Manki checks the PR's claims instead of trusting them. Up to five statements of the PR title, description or added comments that ask reviewers to take something on trust are each checked by one call with repository tools, which never sees the description. A round whose reviewer has no repository tools checks none. With related repositories configured, each check starts from the lines a search found there for its claim. A claim disproved with a cited line that exists becomes a finding like any finder's ([#1573](https://github.com/manki-review/manki/pull/1573), [#1608](https://github.com/manki-review/manki/pull/1608)).
- `related_repos` has a third kind, `dependency`: a repository this one depends on, read at the version it pins with `ref`. Finders with repository tools get a checklist step that checks what the change assumes about the dependency's code ([#1552](https://github.com/manki-review/manki/pull/1552), [#1557](https://github.com/manki-review/manki/pull/1557)).
- Every stage with repository tools can read the related repositories: the finders, the quick check of a trivial PR, the sibling comparisons, the sweep, the refuter, the judge with `judge.tool_steps` and the reply in a thread ([#1587](https://github.com/manki-review/manki/pull/1587)).
- Consumer repositories get the same pre-search as references, with the diff's names translated into the other codebase's terms, and finders have checklist steps for consumers and specifications. A related repository's `AGENTS.md` or `CLAUDE.md` is named to the finders as a map, and the pre-search no longer quotes it into the prompts ([#1424](https://github.com/manki-review/manki/pull/1424), [#1432](https://github.com/manki-review/manki/pull/1432), [#1433](https://github.com/manki-review/manki/pull/1433)).
- The check of an open lead starts with what is left to check. A check that ran out of tool steps is recorded as such, and a later round checks it again instead of reusing that answer ([#1586](https://github.com/manki-review/manki/pull/1586), [#1592](https://github.com/manki-review/manki/pull/1592)).
- A finder reply whose elements have no title or description is retried once with a note on what was wrong, instead of being read as empty findings ([#1569](https://github.com/manki-review/manki/pull/1569)).

### Review format

- Findings have three grades, `blocker`, `warning` and `note`: `note` replaces `suggestion` and `nitpick`, also in the `severity_counts` and `findings_json` outputs, the review shows it as a suggestion, and the `nit_handling` and `noise_level` settings are gone ([#1437](https://github.com/manki-review/manki/pull/1437), [#1463](https://github.com/manki-review/manki/pull/1463)).
- New setting `review.notes`, default 3, caps the model's suggestions a review posts in the order the judge ranks them, with tool alerts and security findings below a warning listed on top of the cap, and a suggestion on a changed line gets an inline thread labelled "Suggestion, not blocking" ([#1437](https://github.com/manki-review/manki/pull/1437), [#1612](https://github.com/manki-review/manki/pull/1612)).
- A posted blocker or warning says how it was checked: proven from the cited lines, confirmed with tools, or not confirmed. The judge's confidence is gone ([#1481](https://github.com/manki-review/manki/pull/1481)).
- The review ends with one fold, "Checked and left out", which lists the findings a tool check disproved, the warnings nothing proves and the leads not finished checking. The progress comment loses those lists ([#1492](https://github.com/manki-review/manki/pull/1492)).
- A proven warning on code an earlier round reviewed gets an inline thread that says an earlier round missed it. From the second round, a suggestion on reviewed code, or one an earlier review listed, stays in the round record wherever Manki could compare the lines with the earlier round ([#1434](https://github.com/manki-review/manki/pull/1434), [#1511](https://github.com/manki-review/manki/pull/1511)).
- A review held for warnings shows the findings and Related work, as a change request does, and the approval Manki posts once the warnings clear shows "What this does" and "What to test". The judge's summary is left out when it describes a finding the round no longer lists, or misses a blocker a later step made or lowered ([#1474](https://github.com/manki-review/manki/pull/1474), [#1482](https://github.com/manki-review/manki/pull/1482), [#1491](https://github.com/manki-review/manki/pull/1491), [#1646](https://github.com/manki-review/manki/pull/1646)).
- Related work lists only what the author can act on: an open PR that seems to make the same change, and an issue the PR may fix without linking it ([#1636](https://github.com/manki-review/manki/pull/1636)).
- "About this review" shows the runner, how long after the workflow run started Manki began, and the peak memory on Linux and macOS, such as `Runner: self-hosted · started after 11m 3s · peak memory 1.5 GiB of 2.0 GiB`. The start time needs `actions: read` on the workflow token and is left out without it ([#1479](https://github.com/manki-review/manki/pull/1479), [#1542](https://github.com/manki-review/manki/pull/1542)).
- The review body line on findings the PR author dismissed and the issue box replies write the login of the person who acted in backticks, so GitHub no longer notifies them about their own click ([#1649](https://github.com/manki-review/manki/pull/1649)).
- A code fix shows as a suggestion block only on the finding's own line. Texts that promised a review after a push now say what to do when the push starts none, and Manki's notes in italics are posted as written ([#1521](https://github.com/manki-review/manki/pull/1521), [#1543](https://github.com/manki-review/manki/pull/1543), [#1561](https://github.com/manki-review/manki/pull/1561), [#1571](https://github.com/manki-review/manki/pull/1571)).

### Security

- A login clears a blocker or security thread only when GitHub confirms a person with write access. A workflow that resolves Manki's threads with its token clears nothing, and a bot's comment is no reply ([#1531](https://github.com/manki-review/manki/pull/1531)).
- A review that quotes Manki's marker is dismissed only when Manki wrote it. A security finding is hidden as already settled only when its earlier thread was a blocker or security thread that someone allowed cleared ([#1543](https://github.com/manki-review/manki/pull/1543)).
- Names a PR author controls have a length cap, and the search pattern a size cap, so long or many names can no longer switch the uses search off, and two steps of the search that grew quadratically now run in linear time. The uses list says which symbols and types it left out ([#1582](https://github.com/manki-review/manki/pull/1582), [#1597](https://github.com/manki-review/manki/pull/1597)).

### Reviewer groups and models

- The round record and the progress comment show the effort each provider actually receives, and name a finder that a deeper review gives no more effort. A deeper review never lowers a finder's effort ([#1414](https://github.com/manki-review/manki/pull/1414), [#1429](https://github.com/manki-review/manki/pull/1429)).
- Claude CLI calls cache prompts for 5 minutes instead of the hour a subscription got, and calls without repository tools write no cache, which cuts the cost of cache writes ([#1635](https://github.com/manki-review/manki/pull/1635)).
- A spawned provider CLI gets `USER`, which the Claude CLI on macOS needs to find its login ([#1428](https://github.com/manki-review/manki/pull/1428)).

### Reliability

- A PR whose diff GitHub refuses, such as one with more than 300 changed files, is read from its file list, up to the 3,000 files GitHub lists, and reviewed when it is under the size limits. A file without a patch counts as not read ([#1639](https://github.com/manki-review/manki/pull/1639)).
- A thread reply Manki fails to answer gets a note that says so, and the run fails instead of ending green. A pinned download is tried three times, and a self-hosted runner with a tool cache, outside Windows, keeps a checked download there for later runs ([#1580](https://github.com/manki-review/manki/pull/1580), [#1589](https://github.com/manki-review/manki/pull/1589), [#1599](https://github.com/manki-review/manki/pull/1599)).
- A failed read of the PR state is tried once more, and so is a GitHub 5xx on the first read of a dispatched run ([#1568](https://github.com/manki-review/manki/pull/1568), [#1588](https://github.com/manki-review/manki/pull/1588)).
- When the Manki service has created a queued `Manki` check for the head, the run takes it over instead of creating a second one. On the paths that know the result at once, the check is reported in one call, so it no longer stays in progress ([#1459](https://github.com/manki-review/manki/pull/1459), [#1641](https://github.com/manki-review/manki/pull/1641)).
- An incomplete round posts its round record, marked incomplete, so a failed round can be diagnosed. Later rounds skip it ([#1417](https://github.com/manki-review/manki/pull/1417)).
- `manki review --patch` holds the approval when the patch breaks `.manki.yml`, as a PR round does ([#1418](https://github.com/manki-review/manki/pull/1418)).

### Docs

- The README, the docs and the homepage were checked against the code and corrected. They present review groups as configurable, the homepage shows a real review, and the docs describe the upgrade effects on open PRs ([#1447](https://github.com/manki-review/manki/pull/1447), [#1468](https://github.com/manki-review/manki/pull/1468), [#1510](https://github.com/manki-review/manki/pull/1510), [#1559](https://github.com/manki-review/manki/pull/1559)).

### Internal

- The release gate counts unexpected warnings. A stored benchmark report keeps the text and grade route of its findings, so from this release on a changed key costs only matcher calls to score again with `--rescore` ([#1413](https://github.com/manki-review/manki/pull/1413), [#1430](https://github.com/manki-review/manki/pull/1430), [#1461](https://github.com/manki-review/manki/pull/1461), [#1574](https://github.com/manki-review/manki/pull/1574)).
- A benchmark case can carry its own config and reads its related repositories as of the case date. The hold-out keys gained the real finds of earlier runs ([#1416](https://github.com/manki-review/manki/pull/1416), [#1427](https://github.com/manki-review/manki/pull/1427), [#1563](https://github.com/manki-review/manki/pull/1563)).
- `review-stats` reports findings per approved round, the rounds after a first approval and the fix rate per grade, and `calibration` skips incomplete rounds ([#1415](https://github.com/manki-review/manki/pull/1415), [#1425](https://github.com/manki-review/manki/pull/1425)).
- Linear-time tests measure growth instead of a fixed time, the dependency name search and the queued check are covered, two live fixtures are fixed, and the notes left open by the 7.5 reviews are cleaned up ([#1462](https://github.com/manki-review/manki/pull/1462), [#1476](https://github.com/manki-review/manki/pull/1476), [#1484](https://github.com/manki-review/manki/pull/1484), [#1494](https://github.com/manki-review/manki/pull/1494), [#1537](https://github.com/manki-review/manki/pull/1537), [#1557](https://github.com/manki-review/manki/pull/1557)).

## [7.4.0] - 2026-11-11

Manki 7.4 makes follow-up rounds work with the threads earlier rounds opened. A finding that restates an open thread joins it, a partly fixed thread stays open at the grade of what remains, and an outdated thread is judged on the code it moved to. A deeper review runs at the new `xhigh` effort, a repository can set the judge's effort, and an opt-in sweep looks for more places with a blocker's mistake. Some settings change with no transition, so read Upgrading first.

### Upgrading

1. `exclude_paths` now replaces the default list instead of adding to it, like any other setting, and `exclude_paths: []` excludes nothing. A repository with its own list loses every default pattern it does not repeat, so add `dist/**`, `*.generated.*` or the lockfile names back if you relied on them. The default list no longer hides every `.lock` file. It names the package lockfiles, such as `Cargo.lock`, `poetry.lock`, `Gemfile.lock` and `composer.lock`, so another `.lock` file, such as `.github/workflows/actions.lock` or `flake.lock`, is now reviewed as text ([#1347](https://github.com/manki-review/manki/pull/1347)).
2. `critical` on a review class is gone. List critical paths in the new `review.critical_paths` instead, as globs or path aliases such as `@security_paths`. A `.manki.yml` that sets `critical` on any class, built-in or not, no longer loads. Move that class's `paths_any` to `review.critical_paths`, and drop the class if it only marked critical paths. The judge's "Critical area" note names the first glob that matches the file ([#1349](https://github.com/manki-review/manki/pull/1349)).
3. New setting `judge.effort`. The default `auto` keeps the planner's pick, and `low`, `medium`, `high`, `xhigh` or `max` fixes the level for the judge and the refuter on every round. The round record and the progress comment show the judge's effort, also when no planner ran ([#1377](https://github.com/manki-review/manki/pull/1377), [#1380](https://github.com/manki-review/manki/pull/1380)).
4. New setting `review.sweep`, off by default. When it is on, each blocker the judge keeps starts one call that states the defect class in general terms and lists every other place in the diff with the same mistake. A round runs at most three sweeps, security blockers first, and their findings get one more judge call. A place that a judged finding already cites is dropped. The round record lists each sweep under `sweeps`, and its findings name `Sweep 1`, `Sweep 2` and so on as their reviewer ([#1374](https://github.com/manki-review/manki/pull/1374), [#1390](https://github.com/manki-review/manki/pull/1390)).

### Earlier threads

- A finding that restates a thread an earlier round left open is no longer posted again. Another instance of the same mistake goes to that thread as a reply. A restatement of a finding only an earlier review body listed appears under "Still open from round N" ([#1351](https://github.com/manki-review/manki/pull/1351)).
- A restatement graded above its thread gets a reply that names the new grade, and a blocker makes the thread block. A reply lists every finding that joined the thread, not only the first ([#1365](https://github.com/manki-review/manki/pull/1365)).
- A thread is resolved only when every failure it names is gone. A partly fixed thread stays open with a "Partly fixed" reply that says what remains, at the grade the rest earns. That grade drops below the thread's own only after a push to the thread's file, and never on a security thread. The judge also checks that each finding's fix removes everything the finding names, and a fix that leaves part says so ([#1355](https://github.com/manki-review/manki/pull/1355)).
- Whether a thread blocks now comes only from the round records posted with each review, never from a reply in the thread. A failed reply can no longer leave a raised thread below blocker, and a thread raised to blocker keeps that grade in later rounds. The verdict line counts a thread newly raised to blocker as a new blocker ([#1361](https://github.com/manki-review/manki/pull/1361), [#1388](https://github.com/manki-review/manki/pull/1388)).
- A security finding never joins a thread that is not a security thread. It gets a thread of its own, and a plain open thread it names still counts as open in the verdict ([#1365](https://github.com/manki-review/manki/pull/1365), [#1382](https://github.com/manki-review/manki/pull/1382), [#1388](https://github.com/manki-review/manki/pull/1388)).
- The judge sees the code an outdated thread named when it was posted, and where that code sits now or that it is gone. An unchanged file is no longer read as proof the problem remains. Before it keeps such a thread open, the judge answers Manki's own reply in the thread ([#1391](https://github.com/manki-review/manki/pull/1391)).
- The "Fixed in" reply names a commit only when it is the one commit since the last reviewed head that changed the thread's file. Otherwise it says "Fixed by the commits up to" the head, which is always true ([#1354](https://github.com/manki-review/manki/pull/1354), [#1379](https://github.com/manki-review/manki/pull/1379)).
- Replies in threads stay when the review posted and the head moved right after ([#1357](https://github.com/manki-review/manki/pull/1357)). A round that could not read the review threads matches no finding to an earlier one ([#1388](https://github.com/manki-review/manki/pull/1388)).

### Review loop and verdicts

- The judge names each premise it doubts, and the refuter answers each one. A grade rises only when every premise is confirmed. A doubt whether the defect exists at all, or a premise that lowers the grade, such as "callers probably validate", is now checked with tools too, up to four such checks a round. A grade that only a doubt held down no longer fixes the grade in the next round ([#1350](https://github.com/manki-review/manki/pull/1350), [#1359](https://github.com/manki-review/manki/pull/1359)).
- When an earlier review record cannot be read, Manki still does not approve while a thread stays open, and it now says why. The review and the check lead with an "Approval withheld" line that links the unread reviews, and they call nothing a blocker. Only threads still open after the round's resolves hold the PR, and the PR author cannot clear a thread whose grade is unknown by resolving it ([#1367](https://github.com/manki-review/manki/pull/1367), [#1371](https://github.com/manki-review/manki/pull/1371), [#1381](https://github.com/manki-review/manki/pull/1381)).

### How finders search

- In the uses list, a use the parser places on a same-named field of another type ranks after every other use of the symbol instead of being dropped. Production code ranks before lines that only call `.name()`, and those before test files. A redefined field's production readers keep their place, up to 30 of the 60 lines ([#1352](https://github.com/manki-review/manki/pull/1352), [#1362](https://github.com/manki-review/manki/pull/1362)).

### Review format

- The progress comment no longer counts kept findings as dropped, and the dropped total cannot go below zero. A refutation reason, a rule or a failure reason that is cut short ends in `...` ([#1346](https://github.com/manki-review/manki/pull/1346)).

### Reviewer groups and models

- `xhigh` is a new effort level between `high` and `max`. Claude Opus 4.7 and later receive it, and earlier Claude models get `high`. OpenAI models get their highest level up to `xhigh`, and Gemini maps it like `high` ([#1364](https://github.com/manki-review/manki/pull/1364)).
- A deeper review runs a finder on effort `auto` at `xhigh`. A finder with a set effort runs one level higher, so `high` steps to `xhigh` and `xhigh` to `max`. Reviewer effort `auto` itself is unchanged: `high` on a change the planner marks subtle, and `medium` otherwise ([#1370](https://github.com/manki-review/manki/pull/1370), [#1400](https://github.com/manki-review/manki/pull/1400)).
- With `models.reviewer` on a Fable model and no `models.reviewer_pair`, a paired round now runs Fable and Opus instead of two Fable finders. A Fable stage also falls back to Opus ([#1348](https://github.com/manki-review/manki/pull/1348)).

### Reliability

- A PR whose own `.manki.yml` does not load no longer fails the round. The round runs on the base branch's settings and warns with the reason. When the PR changed its copy and the copy does not load, Manki holds its approval and says so. A copy that cannot be read or compared counts as changed. A PR that only predates the base branch's copy can still be approved ([#1395](https://github.com/manki-review/manki/pull/1395)).
- An incomplete round keeps in its record everything its stages produced before the failure, such as the planner result, retries, dedup counts, the judge's findings and `judge.effort` ([#1385](https://github.com/manki-review/manki/pull/1385), [#1386](https://github.com/manki-review/manki/pull/1386)).

### Internal

- The benchmark scores follow-up rounds. A case can hold the earlier round's findings and list which threads the push fixes, which it fixes only in part, and which findings must not be posted again ([#1353](https://github.com/manki-review/manki/pull/1353)).
- The release gate gives every figure a margin of one item per run, decides on two runs per side, and decides nothing on a baseline with one run. A tuning run lists its blockers that match no key item ([#1356](https://github.com/manki-review/manki/pull/1356), [#1358](https://github.com/manki-review/manki/pull/1358), [#1360](https://github.com/manki-review/manki/pull/1360)).
- The hold-out set grows from 12 to 26 cases, in more languages and with follow-up rounds ([#1366](https://github.com/manki-review/manki/pull/1366)).
- `missed-blockers` drafts follow-up keys from the round's own thread verdicts, takes the PR description as it read when the round's review started, and never stops on a malformed record ([#1368](https://github.com/manki-review/manki/pull/1368), [#1375](https://github.com/manki-review/manki/pull/1375), [#1376](https://github.com/manki-review/manki/pull/1376), [#1378](https://github.com/manki-review/manki/pull/1378), [#1385](https://github.com/manki-review/manki/pull/1385)).
- A slow test checks that the sibling step's time grows linearly instead of against a fixed bound ([#1369](https://github.com/manki-review/manki/pull/1369)).

## [7.3.2] - 2026-11-10

Manki 7.3.2 fixes a judge regression from 7.3.1 and tightens how findings are merged and what the finders see. The judge now reads the repository's instruction files, so findings that cite a repository rule are graded again instead of dropped.

### Review loop and verdicts

- The judge sees the repository's instruction files, such as `AGENTS.md` and `CLAUDE.md`, as the finders do. A finding that says the change breaks one of their rules is checked against the rule's text. A convention such as naming or import placement is graded a nitpick or a suggestion. The judge grades a finding on its main claim and corrects a wrong side detail, such as an off line number, in its reasoning instead of dropping the finding ([#1330](https://github.com/manki-review/manki/pull/1330)).
- A kept finding that sits within a few lines of a verdict reader blocker in the same file, and does not already match it, goes to the dedup model with the blocker. All such pairs of a round go in one call, and a pair folds into one thread only when the model answers that both describe the same defect. A failed or unclear answer keeps both threads ([#1332](https://github.com/manki-review/manki/pull/1332)).
- The judge treats a lockfile alert as a repeat of a resolved one only when the title matches exactly, as dedup does ([#1331](https://github.com/manki-review/manki/pull/1331)).

### How finders search

- The uses list shows at most 3 uses of a symbol from one file while another file still has a code use to show, so one file can no longer fill the list ([#1334](https://github.com/manki-review/manki/pull/1334)).
- A sibling implementation group is dropped only when one earlier group already compared all its members. Groups without a sibling are dropped before ranking, and the per-file cap of 50 groups is gone. At most 2 MB of function body text is read per round to spot identical bodies ([#1335](https://github.com/manki-review/manki/pull/1335)).
- Parsed lockfiles no longer count against the file contents budget, so a code file keeps its place. A thread on a lockfile reads its code window from a separate fetch of up to 1 MB ([#1331](https://github.com/manki-review/manki/pull/1331)).

### Review format

- A saved fix in words or code that is cut short ends in `...`. Proof entries without a `file:line` are dropped before the list is cut to ten, so a real location is not pushed out. A bare file name links only when a file is actually there, and otherwise stays plain text ([#1333](https://github.com/manki-review/manki/pull/1333)).

## [7.3.1] - 2026-11-10

Manki 7.3.1 grades findings more honestly. Every stage checks what it is told against the code before that changes a grade, a gap the PR admits keeps the grade its damage earns, and every doubt the judge cannot settle goes to the refuter. A finding comment opens with what goes wrong and keeps the rest in one fold that leads with the fix. Automatic review pauses later and resumes after a review started by hand.

### Upgrading

1. The judge now checks claims instead of trusting them. The PR description, code comments, linked issues, author replies, another model's finding and an earlier round's verdict move a grade only when the code confirms them. A gap the PR description, a comment or a TODO calls deferred, out of scope or not handled yet keeps the grade its damage earns, so expect more warnings and blockers on PRs that list known limitations. A declared placeholder or a TODO with a tracking issue still counts as before ([#1288](https://github.com/manki-review/manki/pull/1288), [#1295](https://github.com/manki-review/manki/pull/1295)).
2. The judge states, for every finding, the grade it earns if the premise the judge doubts holds. Any doubt that leaves a finding below that grade goes to the refuter, not only doubts about unseen code or whether a path is reached, so a round can make a few more refuter calls. A defect in lines the PR adds is never treated as pre-existing ([#1288](https://github.com/manki-review/manki/pull/1288), [#1295](https://github.com/manki-review/manki/pull/1295)).
3. A finding comment shows "What goes wrong" open, with a committable suggestion still open under it. One fold holds the rest and leads with the fix: "How to fix it", "Why it matters", "Checked in the code" and the refuter's outcome. A finding in the review body uses the same fold ([#1306](https://github.com/manki-review/manki/pull/1306)).
4. `convergence.max_auto_rounds` defaults to 10 instead of 5. When automatic review is paused, a review started by hand turns it back on for the next `convergence.rounds_after_restart` automatic rounds, 3 by default. Set it to 0 for the old behaviour, where a restart reviews only the round asked for. An open PR that is paused now and already had a review started by hand gets up to 3 automatic rounds back once after the upgrade ([#1313](https://github.com/manki-review/manki/pull/1313), [#1317](https://github.com/manki-review/manki/pull/1317)).
5. The subscription limit box under the verdict shows only just after a usage window passes 70% or 80%, up to 2 points past the mark, and on every review from 90%. The progress comment still shows every reading on every review ([#1316](https://github.com/manki-review/manki/pull/1316)).
6. Python and Go get sibling field and sibling implementation questions, as Rust, TypeScript and JavaScript do. Other languages get the uses list only. Methods every type has, such as Python `__init__` and other dunder methods, TypeScript `constructor` and `toString`, Go `String` and `Error` or a Rust `new`, are compared only between classes that share a base class or interface, and standard Rust trait methods such as `Display` or `Clone` not at all ([#1289](https://github.com/manki-review/manki/pull/1289), [#1321](https://github.com/manki-review/manki/pull/1321)).
7. Releases are published from GitHub with an approval, now that the release App is set up. `RELEASE.md` names the tag rule as a ruleset of the `manki` repository and says to check the `release` environment's protection ([#1319](https://github.com/manki-review/manki/pull/1319)).

### How finders search

- A new "Narrowed input" check: when a change narrows what it accepts, with a lower or new limit, stricter validation, a narrower type, a new required field or a stricter format, the finder finds every producer of that input, in this repository or in a reference it mirrors, and checks that each still fits ([#1301](https://github.com/manki-review/manki/pull/1301)).
- The finder checklist and its example finding are language-neutral, with examples in Rust, TypeScript, Python and Go. The reference behaviour check applies whenever the changed code implements or mirrors a spec, another implementation or an API it talks to ([#1286](https://github.com/manki-review/manki/pull/1286), [#1295](https://github.com/manki-review/manki/pull/1295)).
- For a field or variant whose meaning the diff changes, the uses list ranks first the uses in files that name its type, shows up to 12 of them instead of 4, and says how many it cut. The `ast_grep` repository tool also searches Go ([#1289](https://github.com/manki-review/manki/pull/1289)).
- A sibling implementation question about a method every type has compares the classes that share a base, together with the base's own method, so two subclasses of `Account` compare their `__eq__` with each other and with `Account.__eq__`. Each class's first 8 bases count, standard bases such as `object`, `ABC`, `Enum` or `Error` are left out, and each changed file asks about at most 50 groups ([#1321](https://github.com/manki-review/manki/pull/1321)).

### Review loop and verdicts

- A kept finding folds into a verdict reader blocker when both sit within a few lines in one file and cite a common proof line near both, whatever their titles say. The blocker's description keeps the other title ([#1287](https://github.com/manki-review/manki/pull/1287), [#1294](https://github.com/manki-review/manki/pull/1294)).
- The verdict reader's message ends with its reply format, so fewer rounds pay for a second reader call after a Markdown answer ([#1293](https://github.com/manki-review/manki/pull/1293)).
- A proof entry that lists several lines, such as `app/views.py:12,40-42`, keeps every line instead of the first, and one long entry no longer crowds the others out ([#1309](https://github.com/manki-review/manki/pull/1309), [#1311](https://github.com/manki-review/manki/pull/1311)).
- The judge sees a finding below a removed line at its correct line number ([#1295](https://github.com/manki-review/manki/pull/1295)).
- The refuter's examples of language rules cover Python, TypeScript, Go and Rust instead of one Rust rule ([#1288](https://github.com/manki-review/manki/pull/1288)).

### Review format

- "Checked in the code" shows one check per place when reviewers quote the same code, links a bare file name to the changed or read file it names, keeps a path's lower case, no longer marks code inside a number such as `0x7fff_ffff`, and links every line of a location that lists several ([#1304](https://github.com/manki-review/manki/pull/1304)).
- After a restart, the round cap notice counts the rounds since the last approval and those since the last review started by hand, instead of a fraction past the cap ([#1317](https://github.com/manki-review/manki/pull/1317)).

### Commands and settings boxes

- A `dismiss` that dismisses nothing says so and shows the command's usage. In a review thread it answers in that thread, and says why when it leaves the thread open. A named `dismiss` stores a suppression only when its text matches a finding Manki posted on the PR, and says why when nothing was stored ([#1302](https://github.com/manki-review/manki/pull/1302), [#1307](https://github.com/manki-review/manki/pull/1307)).
- In webhook mode, ticking "Review again" or another settings box always starts a run. The run takes the sender from the newest edit by a person, not from Manki's own status edit that lands right after ([#1300](https://github.com/manki-review/manki/pull/1300)).

### Review records and statistics

- A round record over the size budget keeps the finders' raw findings and the uses list in short form, named in `meta.compacted`, before it drops them. A round with warnings and no blocker records the reason `warnings_present` instead of `only_nit_or_suggestion` ([#1287](https://github.com/manki-review/manki/pull/1287)).

### Internal

- The benchmark grows from the five replay cases to cases from more repositories and languages, split into a tuning set and a hold-out set that `--holdout` reports side by side. A Benchmark workflow runs it on GitHub, and `RELEASE.md` makes the hold-out score the release gate A tuning case checks that one round finds every instance of one defect class ([#1291](https://github.com/manki-review/manki/pull/1291), [#1296](https://github.com/manki-review/manki/pull/1296), [#1298](https://github.com/manki-review/manki/pull/1298), [#1322](https://github.com/manki-review/manki/pull/1322)).

## [7.3.0] - 2026-11-09

Manki 7.3 gives the finders more to compare against. Every finder runs the same checklist, the reference repos are searched before the finders start, and small targeted calls compare sibling fields and implementations while the finders run. The judge reads the PR description and can send a doubt about whether a path is reached to the refuter. A second refuter on another model and a judge with repository tools are new opt-in settings. A PR that only bumps dependencies in a supported lockfile can be approved again.

### Upgrading

1. Every finder runs one checklist of 13 checks, which now includes reuse of existing code, the repository's own rules and claims that the change matches a reference. Finders in a group differ only by their model. The pair lens from 7.2 is gone, and there is no setting for it. Round records drop the primary and pair counts (`keptPrimaryOnly`, `keptPairOnly`, `keptBoth`, `keptOnlyBy`, `keptByMany` and `models.reviewerPair`) and keep `keptOnly` and `keptShared` on each finder's entry instead ([#1250](https://github.com/manki-review/manki/pull/1250)).
2. A round does more, so it costs somewhat more. Up to 12 small calls on `models.reviewer` compare sibling fields and implementations alongside the finders. The `reference` related repos are fetched and searched before the finders start, which adds up to a minute, or seconds with the cache, and gives the finders an "In the Reference Repos" list. A note on related open PRs and issues costs one GraphQL query, one issue search and one cheap call on the dedup model ([#1254](https://github.com/manki-review/manki/pull/1254), [#1257](https://github.com/manki-review/manki/pull/1257), [#1268](https://github.com/manki-review/manki/pull/1268)).
3. Two new optional settings. `models.refuter_pair` adds a second refuter on another model, which never lowers a blocker. `judge.tool_steps` gives the judge read-only repository tools with that many steps, and is 0, off, by default. Both need the Claude or Codex CLI ([#1255](https://github.com/manki-review/manki/pull/1255), [#1259](https://github.com/manki-review/manki/pull/1259)).
4. A PR that only changes dependencies in a `Cargo.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock` or `pnpm-lock.yaml` that Manki can parse can be approved again. Other lockfile formats, such as `poetry.lock` or `go.sum`, still hold the approval for a person. `manki review` and the benchmark read changed lockfiles the same way, so a local change that only bumps a lockfile is reviewed instead of stopping with "Nothing to review" ([#1258](https://github.com/manki-review/manki/pull/1258), [#1277](https://github.com/manki-review/manki/pull/1277)).
5. A mistyped key inside `planner`, `static_analysis`, `convergence`, `metrics`, `memory` or a `reviewers` entry now shows a warning with its full path, such as `Unknown config key: "planner.enabeld"`. Nothing that loaded before fails now ([#1269](https://github.com/manki-review/manki/pull/1269)).
6. The review body no longer lists the findings that have their own thread. The verdict line still counts them, and every finding without a thread is still listed ([#1266](https://github.com/manki-review/manki/pull/1266)).
7. Releases can be published from GitHub: the `Publish release` workflow shows what it will write and waits for an approval. It needs a one-time release App setup, described in `RELEASE.md`, and `scripts/publish-release.sh` stays the fallback ([#1252](https://github.com/manki-review/manki/pull/1252)).

### How finders search

- When the PR title, description or changed code says the change matches another implementation, a spec or a standard, finders open what it names, in a `reference` related repo when one is listed, and report each difference the PR does not call out, citing both sides. For protocol, consensus, network or serialization code that a reference implements, they compare both directions: what this code sends against what the reference accepts, and the reverse ([#1253](https://github.com/manki-review/manki/pull/1253), [#1268](https://github.com/manki-review/manki/pull/1268)).
- Before the finders run, Manki searches each `reference` related repo for the names the diff changes or reads and the names its added comments mention, ignoring case and underscores, so `script_payout` also finds `scriptPayout`. The matches go to the finders, the judge and the refuter as "In the Reference Repos", up to 4 lines per name and 40 in all ([#1268](https://github.com/manki-review/manki/pull/1268), [#1274](https://github.com/manki-review/manki/pull/1274)).
- Sibling comparisons ask targeted questions while the finders run. When a changed line looks an item up in one collection field, a call asks whether the item can sit in another field of the same type and whether the change handles it. When the change touches a function that sibling types also implement, a call puts them side by side and lists each check one has and another lacks. Their findings are named `Sibling field: ...` or `Sibling code: ...` and go through dedup and the judge like any other. The round waits at most one minute for them after the finders finish ([#1257](https://github.com/manki-review/manki/pull/1257), [#1276](https://github.com/manki-review/manki/pull/1276)).
- After a blocker is fixed, or while its file changes, the next round's finders get a "Fixed Blockers" section that asks them to check other callers, inputs, variants and sibling code for the same outcome ([#1256](https://github.com/manki-review/manki/pull/1256)).
- Finders read the root `CONTRIBUTING.md` and the Markdown files the instruction files link to, and see up to 20,000 characters of the PR description instead of 2,000 ([#1253](https://github.com/manki-review/manki/pull/1253)).
- The uses list never cuts a field or variant whose own declaration changes as too common, since its readers are what the change can break, and it shows up to 60 lines instead of 40 ([#1268](https://github.com/manki-review/manki/pull/1268), [#1274](https://github.com/manki-review/manki/pull/1274)).

### Review loop and verdicts

- The judge reads the PR title and description, fenced and labelled as untrusted author text, and checks what the author claims against the code ([#1273](https://github.com/manki-review/manki/pull/1273)).
- A doubt that a failure is ever reached no longer holds a finding down unchecked. The judge states the grade the finding earns if the path exists, and the refuter searches for that path with tools. In a library, a path through the public API counts as reached without a caller in the repository ([#1249](https://github.com/manki-review/manki/pull/1249)).
- With `models.refuter_pair`, a second refuter on that model checks every finding the first refuter checks, at the same time and with the same prompt. A confirmation against a disproof keeps the judge's grade and shows both reasons. A blocker both refuters disprove still blocks, posted with both reasons ([#1255](https://github.com/manki-review/manki/pull/1255)).
- With `judge.tool_steps` above 0, the judge reads the code a finding rests on before grading, and gets the finders' 15-minute timeout. A tool call that fails grades once more without tools instead of failing the round ([#1259](https://github.com/manki-review/manki/pull/1259)).
- The judge reads each parsed lockfile's package list instead of its raw hunks, which keeps its prompt small on a large dependency update ([#1277](https://github.com/manki-review/manki/pull/1277)).
- Dedup catches a reworded repeat of an earlier finding more often. The dedup model reads each finding's description and the line it names, and matches only within the same file. A resolved thread whose code moved is matched on the line it was posted on ([#1256](https://github.com/manki-review/manki/pull/1256), [#1265](https://github.com/manki-review/manki/pull/1265)).

### Review format

- A review body can end with a "Related work" note listing open PRs that change the same files and open issues the PR may fix without linking them, as a duplicate, an overlap or a fix. The note never blocks, never opens a thread and never changes the verdict. The review waits at most 15 seconds for the lookup, and a rate-limited search is skipped ([#1254](https://github.com/manki-review/manki/pull/1254), [#1275](https://github.com/manki-review/manki/pull/1275)).
- Check lines in "How this was checked" keep their code spans whole when shortened, a cited location without an explanation shows its link and code line instead of "Shows the failure.", and units such as `MiB` are no longer shown as code ([#1241](https://github.com/manki-review/manki/pull/1241), [#1261](https://github.com/manki-review/manki/pull/1261)).
- The progress comment's planner line shows only the judge effort, since each finder's line shows its own ([#1263](https://github.com/manki-review/manki/pull/1263)).

### Static analysis

- A changed `Cargo.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock` or `pnpm-lock.yaml` is parsed into a list of added, removed and updated packages that the finders and the verdict reader read. A source moved to another registry or repository, an added package from a registry no other package uses, a git or path source, a checksum change without a version change, a downgrade and a tarball URL that names another package each raise a `lockfile-change` alert, and so does a package in a new lockfile from another registry than most of its packages (`unfamiliar registry`). Past the alert cap, the most telling flags come first and one summary alert names the rest. A lockfile alert counts as a repeat of an earlier one only when its title matches exactly, so a waived alert on a nearby package no longer hides it. A lockfile-only PR gets two finders ([#1258](https://github.com/manki-review/manki/pull/1258), [#1277](https://github.com/manki-review/manki/pull/1277)).

### Review records and statistics

- The round record keeps the uses list and the reference matches (`usesOutsideDiff`), each sibling comparison (`comparisons`, under the new `compare` stage), the related work candidates (`relatedWork`) and the second refuter's answers (`pairRefutation`, `models.refuterPair`). It no longer keeps `planner.reviewerEffort` ([#1253](https://github.com/manki-review/manki/pull/1253), [#1254](https://github.com/manki-review/manki/pull/1254), [#1255](https://github.com/manki-review/manki/pull/1255), [#1257](https://github.com/manki-review/manki/pull/1257), [#1263](https://github.com/manki-review/manki/pull/1263), [#1268](https://github.com/manki-review/manki/pull/1268), [#1274](https://github.com/manki-review/manki/pull/1274)).
- `review-stats` reports the second refuter's cost and how often it agreed with the first, split from it or changed the outcome, and the refutation table also counts the findings a disproof dropped ([#1262](https://github.com/manki-review/manki/pull/1262)).

### Docs

- `docs/security.md` gives the current finder budgets and time limit, and says which content each stage gets ([#1263](https://github.com/manki-review/manki/pull/1263), [#1273](https://github.com/manki-review/manki/pull/1273)).

### Internal

- The recall benchmark compares config variants side by side with `--variant` and `--set`, and `npm run missed-blockers` drafts benchmark cases from blockers an earlier round missed. Two seed cases gain must-catch blockers ([#1251](https://github.com/manki-review/manki/pull/1251), [#1260](https://github.com/manki-review/manki/pull/1260), [#1270](https://github.com/manki-review/manki/pull/1270)).

## [7.2.0] - 2026-11-09

Manki 7.2 makes each round find more. Finders work through a wider list of checks with more steps and more of the changed code in front of them, the second finder of a pair looks from its own angle, and every finder, the judge and the refuter get a list of where the changed symbols are used outside the diff. The judge no longer lowers a finding because it rests on code it cannot see, and sends it to the refuter instead. `manki review` runs the same review on a local branch.

### Upgrading

1. Reviews read more, so a round costs more. A single finder gets 30 tool steps instead of 15, and a finder of a pair or a floor class 40 instead of 30. A finder call may run 15 minutes instead of 10, so keep the job's `timeout-minutes` at 30 or more. Changed files are inlined in the prompt up to 200 KB each and 400 KB in all, instead of 50 KB and 100 KB. The judge sees up to 40 windows of the code findings cite outside the diff. The estimate for a paired round is about $0.6 to $1.0 more at API prices, and the review footer now shows each round's tokens and cost ([#1229](https://github.com/manki-review/manki/pull/1229), [#1231](https://github.com/manki-review/manki/pull/1231), [#1234](https://github.com/manki-review/manki/pull/1234)).
2. The planner no longer guesses the project label the finders read, which differed from round to round. Set it with the new optional `project` key in `.manki.yml`, such as `project: blockchain consensus library`. Without the key the label is left out, and the finders go by the repository description and the `AGENTS.md` and `CLAUDE.md` files. The round record no longer holds `planner.context` ([#1235](https://github.com/manki-review/manki/pull/1235)).
3. `manki review` runs a review on your own machine before you push, with the credentials the Action takes as environment variables. See "Local review" below ([#1230](https://github.com/manki-review/manki/pull/1230)).

### Local review

- `npx github:manki-review/manki#v7 review [<base>[..<head>]]` runs the planner, the finders, dedup, the judge and the verdict reader on the change from the merge base to `HEAD`, reads `.manki.yml` and the instruction files from the base, and writes nothing to GitHub. Findings print as Markdown in the review body's layout, or as JSON with `--json`, and `--record` writes the round record. `--patch` reviews a patch on a scratch copy of the tracked files, so untracked files such as `.env` stay out. The exit code is 0 when a pull request round would approve, 1 when something blocks or the base config did not load, and 2 when the review is incomplete or failed. Memory, earlier rounds, linked issues and CI results stay out, since they live on GitHub ([#1230](https://github.com/manki-review/manki/pull/1230)).

### How finders search

- The finder focus is a list of concrete checks: every reader of a changed type, field, variant or function anywhere in the repository, sibling state such as other collections, caches, size estimates and serializers, sibling symmetry such as encode and decode, dropped cases in matches, `catch` blocks and ignored results, and tests that pass whether or not the code they name works ([#1229](https://github.com/manki-review/manki/pull/1229)).
- The second finder of a pair gets its own lens. It runs the same checks led by readers, sibling state, symmetry and tests, and adds reuse of existing code and the repository's own rules, each reported only with the existing code's `file:line` or the rule quoted. It still reports every blocker and security issue ([#1229](https://github.com/manki-review/manki/pull/1229)).
- Finders leave out only a warning, suggestion or nitpick that matches a memory suppression, never a blocker or a security issue. A break of a rule in the repository's `AGENTS.md` or `CLAUDE.md` is reported with the rule quoted at any `noise_level` ([#1229](https://github.com/manki-review/manki/pull/1229)).
- Before the finders run, Manki lists where the symbols the PR changes are used outside the diff, and the fields of each type the changed lines read or change. The finders, the judge and the refuter get the same "Uses Outside the Diff" section. The list comes from the PR head checkout with no model call, so it appears when a client has repository tools, and needs no setting ([#1232](https://github.com/manki-review/manki/pull/1232)).

### Review loop and verdicts

- The judge no longer caps a finding at suggestion because it rests on code outside the diff. With a workspace it sees the cited code under each finding, up to 5 windows per finding and 40 per round. When the grade it would give if that code is as the finding says is higher than its own, the refuter checks the finding with tools: a confirmation gives the finding that grade and a disproof drops it ([#1231](https://github.com/manki-review/manki/pull/1231)).
- A finding that claims a compile, type or test failure is posted as a warning, "Check that this builds", unless a compiler or type checker annotation on the commit confirms it or it is a security finding. This applies to the verdict reader's blockers too, and when all of them are such claims the change stays ready ([#1231](https://github.com/manki-review/manki/pull/1231)).
- The refuter names the general rule a finding relies on and searches unchanged code that already relies on the same rule. One such counterexample disproves the finding ([#1231](https://github.com/manki-review/manki/pull/1231)).
- The judge grades a few cases higher. A defect behind a declared placeholder or tracked TODO is a suggestion instead of ignored, a test that cannot fail when the code it names breaks is a warning, and a doc or comment that states behaviour the code does not have is a suggestion. "Intended but surprising" never lowers a security defect, resource exhaustion or a removed guard, check or limit ([#1231](https://github.com/manki-review/manki/pull/1231)).
- A kept finding that names the same problem as a verdict reader blocker is folded into that blocker, so one bug gets one thread. The blocker keeps its grade and line and takes the finding's reviewers and evidence ([#1223](https://github.com/manki-review/manki/pull/1223)).

### Review format

- The folded "About this review" footer shows the round's token usage and estimated cost, such as "Tokens: 1.2M in (980k from cache) · 23k out · about $1.58 at API prices". On a subscription account the figure still shows how heavy the round was ([#1234](https://github.com/manki-review/manki/pull/1234)).
- Each "Create an issue for this" box has its own id. Before, two findings on one line whose titles differed only in punctuation shared a box id, so one tick filed one issue for both. Boxes posted earlier keep working ([#1236](https://github.com/manki-review/manki/pull/1236)).

### Security

- Resource exhaustion or denial of service from outside input (CWE-400, CWE-770) is a security defect: an allocation, loop or recursion sized by the input, or a size limit removed or raised. For a library, outside input is anything a caller of its public API can pass, readers and byte streams included ([#1229](https://github.com/manki-review/manki/pull/1229), [#1231](https://github.com/manki-review/manki/pull/1231)).

### Review records and statistics

- The round record keeps the files each Claude finder call read, as `filesRead` next to its tool steps ([#1229](https://github.com/manki-review/manki/pull/1229)).

### Reliability

- After a Codex call, Manki reads usage limits only from the session folders of the dates the call can have written to, not from every session on the runner. On a self-hosted runner that keeps `~/.codex`, this scan no longer slows down with every run ([#1222](https://github.com/manki-review/manki/pull/1222)).

### Internal

- `npm run bench` scores reviews against a recall benchmark: it reviews each case several times with the local review core, matches the findings to the case's answer key and reports recall per item and severity, verdict accuracy, false blockers and cost. It counts the distinct files each finder read and gives the reason for an incomplete run. It is seeded with five cases ([#1233](https://github.com/manki-review/manki/pull/1233), [#1238](https://github.com/manki-review/manki/pull/1238)).

## [7.1.1] - 2026-11-09

Manki 7.1.1 warns before a Claude or Codex subscription usage limit runs out, so a used-up limit no longer ends a round as a surprise.

### Review format

- When a Claude or Codex subscription usage window reaches 70%, the review body shows a caution box under the verdict that names the window and the 70, 80 or 90% mark it passed. The Review metadata in the progress comment lists every window with its used share and reset time ([#1216](https://github.com/manki-review/manki/pull/1216)).
- The verdict line and the section intros read in the singular for one finding, such as "1 warning, which doesn't block" ([#1217](https://github.com/manki-review/manki/pull/1217)).

### Review records and statistics

- The round record keeps each configured related repository's fetch outcome and how often each finder read it, and the newest reading of each subscription usage window. `review-stats` reports both ([#1215](https://github.com/manki-review/manki/pull/1215), [#1216](https://github.com/manki-review/manki/pull/1216)).

### Internal

- Manki's own reviews read `manki-review/token-service` as a related repository ([#1214](https://github.com/manki-review/manki/pull/1214)).

## [7.1.0] - 2026-11-09

Manki 7.1 makes Manki safe to run for people who only want a review, and makes each round find more. The security work from the v7.0.0 audit ([#1116](https://github.com/manki-review/manki/issues/1116)) means nobody gains write access they should not have, Manki never approves code no model read, and no answer from a single model can unblock a change. Review memory moves to a central repository the Manki service writes. The review body is grouped by where findings sit, and any finding can be filed as an issue with a tick. Finders search the whole PR in every round, and the round records keep enough diagnostics for a weekly statistics report.

### Upgrading

1. Every setting comes from the base branch's `.manki.yml`. A PR that edits it is reviewed with the base branch's settings, and its change applies after merge. When the base branch's config does not load, Manki reviews with the defaults and does not approve ([#1119](https://github.com/manki-review/manki/pull/1119)).
2. Only someone other than the PR author can clear a blocker, by resolving its thread or by a reply Manki answers Fixed or Agreed. An admin author's own clearing is recorded as an override ([#1125](https://github.com/manki-review/manki/pull/1125)).
3. Comment commands, thread resolution and learning from replies need real write access, which Manki looks up through the API. Org members and outside collaborators with only read or triage access are refused ([#1117](https://github.com/manki-review/manki/pull/1117)).
4. A PR that changes only excluded files, binaries, Git LFS pointers or submodules is never approved, and a mixed PR's approval is held for a person. Since `*.lock` is excluded by default, a lockfile-only PR needs a person's approval ([#1126](https://github.com/manki-review/manki/pull/1126), [#1157](https://github.com/manki-review/manki/pull/1157)).
5. With `memory.enabled: true` and no `memory.repo`, a public repository's memory now lives in `manki-review/review-memory`, written only by the Manki service. A private repository keeps memory only in a private memory repository of the same owner, set with `memory.repo` and `memory_repo_token`, and `memory.repo` without the token skips memory with a warning ([#1130](https://github.com/manki-review/manki/pull/1130)).
6. The settings block's "Full review" and "Force review" boxes are replaced by "Review again", which reviews the current commit with every finding counted as new, also while the PR is paused or too big for automatic review. "Deeper review" stays ([#1208](https://github.com/manki-review/manki/pull/1208)).
7. A variable of the Manki step whose name holds a secret word anywhere, such as `OPENAI_API_KEY_PROD`, no longer reaches a provider CLI. `ANTHROPIC_CUSTOM_HEADERS` reaches the Claude CLI only with `ANTHROPIC_BASE_URL` ([#1128](https://github.com/manki-review/manki/pull/1128)).
8. On a runner without `claude` on the path, Manki downloads the pinned native Claude CLI (about 157 MB) into the runner's temp folder and checks its digest, instead of a global npm install ([#1124](https://github.com/manki-review/manki/pull/1124)).
9. A persistent self-hosted runner no longer keeps the Codex or Gemini OAuth file after a run. When Codex rotates its token, refresh the secret, as on a hosted runner ([#1140](https://github.com/manki-review/manki/pull/1140)).
10. Pin this release before the Manki service drops the review token to read-only access: Manki now resolves and reopens its threads through the service ([#1134](https://github.com/manki-review/manki/pull/1134)).

### Review memory

- Manki reads and writes review memory only through the Manki service and holds no token for the central repository. Each run may write only its own repository's folder, `<owner>/<repo>/`, and a write that raced another is read again and retried ([#1130](https://github.com/manki-review/manki/pull/1130)).
- A memory suppression never hides a blocker, a security finding or a tool alert. Suppressions apply once, after the judge, and the progress comment shows "suppressed by memory" with the judge's results ([#1136](https://github.com/manki-review/manki/pull/1136)).
- `/manki remember global:` needs write access to the memory repository ([#1140](https://github.com/manki-review/manki/pull/1140)).

### How finders search

- Finders search the whole PR in every round. They report every blocker, warning and security issue they find, follow the callers of changed code and other routes to the same outcome, and report one finding per kind of defect that lists every place it occurs ([#1167](https://github.com/manki-review/manki/pull/1167), [#1204](https://github.com/manki-review/manki/pull/1204)).
- A later round lists the files changed since the last review first, and still reads the whole PR ([#1168](https://github.com/manki-review/manki/pull/1168)).
- Each evidence line starts with its `file:line` and quotes the code it refers to ([#1170](https://github.com/manki-review/manki/pull/1170)).
- A normal PR is read whole in one call per finder. Only a PR over 200,000 characters is read in slices, and no prompt ever cuts the diff: a changed line too long to show ends the round incomplete and is named ([#1137](https://github.com/manki-review/manki/pull/1137), [#1202](https://github.com/manki-review/manki/pull/1202)).
- Finders get a `repo_info` tool that says whether a repository is public, with its default branch ([#1195](https://github.com/manki-review/manki/pull/1195)).

### Review loop and verdicts

- A disproof from the judge's refuter never clears a blocker, security or not. The blocker stays, posted with the refuter's reason, and a disproof drops only a lead or a finding below blocker that cites the finding's own file or the diff ([#1118](https://github.com/manki-review/manki/pull/1118), [#1143](https://github.com/manki-review/manki/pull/1143)).
- The verdict reader's blockers carry evidence and proving lines, and go through the refuter like the judge's ([#1151](https://github.com/manki-review/manki/pull/1151), [#1155](https://github.com/manki-review/manki/pull/1155)).
- A finding on code the PR did not change, which the reviewer, the judge and the diff all agree existed before, no longer blocks unless it is a security finding. It is listed under "Pre-existing" ([#1171](https://github.com/manki-review/manki/pull/1171), [#1185](https://github.com/manki-review/manki/pull/1185), [#1188](https://github.com/manki-review/manki/pull/1188), [#1191](https://github.com/manki-review/manki/pull/1191)).
- With repository tools, the judge settles open leads graded warning as it does blocker leads. A lead it cannot settle carries over to the next round instead of coming back as new ([#1193](https://github.com/manki-review/manki/pull/1193)).
- Each thread gets one Manki "Fixed" reply per commit, and a reply written while a round ran waits for that round's judgment ([#1154](https://github.com/manki-review/manki/pull/1154), [#1139](https://github.com/manki-review/manki/pull/1139)).
- After a rebase, the judge checks earlier threads against the PR's own change only, not the base branch's ([#1153](https://github.com/manki-review/manki/pull/1153)).
- An earlier blocker is matched to its thread by the line its finding names, so a resolved thread always backs it ([#1152](https://github.com/manki-review/manki/pull/1152)).
- When the round cap pauses automatic review, the notice asks the author to step back and reconsider the approach. The cap stays at 5 ([#1166](https://github.com/manki-review/manki/pull/1166), [#1180](https://github.com/manki-review/manki/pull/1180)).

### Review format

- The review body is grouped by where findings sit: found this round, missed by an earlier review, pre-existing, and files no model read. The verdict line counts what was posted, the threads are listed by name under it, and a collapsed "About this review" closes the body ([#1205](https://github.com/manki-review/manki/pull/1205), [#1210](https://github.com/manki-review/manki/pull/1210)).
- Every finding, in a thread or in the review body, has a `Create an issue for this` box. A tick by someone with write access files the finding as an issue and links it. A non-blocking thread is then resolved ([#1196](https://github.com/manki-review/manki/pull/1196), [#1200](https://github.com/manki-review/manki/pull/1200)).
- "How this was checked" shows a code preview under each check, with the refuter's outcome first ([#1172](https://github.com/manki-review/manki/pull/1172), [#1179](https://github.com/manki-review/manki/pull/1179)).
- A finding labels "What goes wrong" (or "Why" for a suggestion or nitpick) and "Fix" ([#1177](https://github.com/manki-review/manki/pull/1177)).
- A small code fix in the review body shows as a diff against the flagged line ([#1183](https://github.com/manki-review/manki/pull/1183)).
- The progress comment's headline shows how long the review took, such as "Review complete in 4m 12s" ([#1176](https://github.com/manki-review/manki/pull/1176)).
- A successful auto-approve leaves only the approval, and the Manki service's rebase note is removed once a review posts ([#1156](https://github.com/manki-review/manki/pull/1156), [#1199](https://github.com/manki-review/manki/pull/1199)).

### Security

- Model ids are validated when the config loads, and every CLI gets the id as `--model=<id>`, so no value can pass as a flag ([#1127](https://github.com/manki-review/manki/pull/1127)).
- Gemini and Codex CLIs run with no built-in tools: no web search, web fetch, connectors, plugins or sub-agents ([#1122](https://github.com/manki-review/manki/pull/1122)).
- The PR's title, description, linked issues, files and diff reach the finders and the verdict reader in fences nothing inside can close, labelled as untrusted ([#1123](https://github.com/manki-review/manki/pull/1123)).
- No text a model writes can open a `suggestion` block, and a fix holding hidden characters never gets a commit button. Thread replies and answers are sanitized like findings, so they cannot ping people, carry links or forge Manki's markers ([#1121](https://github.com/manki-review/manki/pull/1121), [#1142](https://github.com/manki-review/manki/pull/1142), [#1140](https://github.com/manki-review/manki/pull/1140)).
- An incomplete round dismisses Manki's approvals of older commits ([#1135](https://github.com/manki-review/manki/pull/1135)).
- A run that cannot get the App token retries once, then fails with a note, and never posts as `github-actions[bot]`. Comments by `github-actions[bot]` are never read as Manki's ([#1133](https://github.com/manki-review/manki/pull/1133)).
- Every action output is redacted ([#1128](https://github.com/manki-review/manki/pull/1128)).
- Release and CI workflows are pinned, and a shared tool install is checked against its digest again on reuse ([#1140](https://github.com/manki-review/manki/pull/1140)).

### Static analysis

- Every review raises a `hidden-characters` alert for each changed file whose added lines hold control or format characters, bidi controls, line separators, Hangul fillers or variation selectors, whatever the config says. A bidi control makes it an error ([#1121](https://github.com/manki-review/manki/pull/1121)).

### Reviewer groups and models

- `.gitmodules`, `.gitattributes`, `.npmrc`, `.yarnrc*`, `build.rs`, `setup.py`, `Makefile`, `.husky` hooks and `manki.yml` force two finders. Only prose files can be trivial, and agent instructions such as `AGENTS.md` never are ([#1132](https://github.com/manki-review/manki/pull/1132)).

### Review records and statistics

- The hidden round and reply records keep each call's prompt digest and tool budget, the pause, memory, token service calls, how each finding's grade changed and why, how a sliced diff was read, and each approval decision ([#1178](https://github.com/manki-review/manki/pull/1178), [#1184](https://github.com/manki-review/manki/pull/1184), [#1192](https://github.com/manki-review/manki/pull/1192), [#1189](https://github.com/manki-review/manki/pull/1189)).
- `npm run review-stats -- --repo <owner/repo>` reports the recorded decisions of recent merged PRs, and a weekly workflow posts the report on a tracking issue ([#1169](https://github.com/manki-review/manki/pull/1169), [#1186](https://github.com/manki-review/manki/pull/1186)).

### Reliability

- A retry of a finder, the judge, the verdict reader or the refuter names what was wrong with the first reply, so fewer rounds end incomplete ([#1131](https://github.com/manki-review/manki/pull/1131), [#1198](https://github.com/manki-review/manki/pull/1198)).

### Internal

- Test and doc follow-ups ([#1144](https://github.com/manki-review/manki/pull/1144), [#1182](https://github.com/manki-review/manki/pull/1182), [#1211](https://github.com/manki-review/manki/pull/1211)).

## [7.0.1] - 2026-11-07

### Review loop and verdicts

- The verdict line on a follow-up round says how many blockers are new and how many are still open from earlier reviews, such as "1 new blocker and 2 still open". The summary under it no longer says nothing blocks while an earlier blocker is open, and a round with a new blocker also lists the earlier blockers still open ([#1095](https://github.com/manki-review/manki/pull/1095)).

Also: the Manki service now runs a thread reply before a review that arrives at the same time, so a push and a reply on a Manki thread no longer get a request for changes that the reply withdraws a minute later. The service is updated live, with no Manki release needed ([manki-review/token-service#48](https://github.com/manki-review/token-service/pull/48)).

## [7.0.0] - 2026-11-07

Manki 7 checks its findings against the code before it posts them. Reviewers on a Claude or Codex subscription read the PR beyond the diff with read-only tools, every blocker must cite the lines that prove it, and the judge tries to refute each blocker before it blocks. Only blockers block. Drafts, very large PRs and PRs you name in `.manki.yml` get no automatic review. This release is tracked in [#1036](https://github.com/manki-review/manki/issues/1036).

### Breaking changes and migration

1. Pin the action to `manki-review/manki@v7`.
2. Manki runs only as the `workflow_dispatch` run the Manki service starts. Make `.github/workflows/manki.yml` the dispatched workflow from Step 3 of `docs/getting-started.md`, and delete the event-driven workflow and any `manki-dispatch.yml`. The service serves only the accounts it lists, so the repository's account must be one of them ([#1084](https://github.com/manki-review/manki/pull/1084)).
3. Remove `concurrency_lock_ttl_seconds` from the workflow and from `.manki.yml`. The service orders each PR's runs, so the in-app lock is gone ([#1084](https://github.com/manki-review/manki/pull/1084)).
4. Drafts get no automatic review. Set `drafts: review` to review them automatically. A draft review never approves ([#1061](https://github.com/manki-review/manki/pull/1061)).
5. Only blockers block, in every round. Warnings, security warnings included, are listed as smaller fixes, so a round with only warnings left approves ([#1047](https://github.com/manki-review/manki/pull/1047)).
6. A PR over 8,000 reviewable lines gets no automatic review, only a request to split it with a Force review box, and Manki never reviews one over 15,000 lines. The old limit was 50,000. Raise `auto_review_max_lines` and `max_diff_lines` on the base branch to review larger PRs ([#1062](https://github.com/manki-review/manki/pull/1062)).
7. Provider CLIs get only the environment variables they need, their own documented settings and their own credential. Any other variable in the Manki step's `env:` no longer reaches them ([#1051](https://github.com/manki-review/manki/pull/1051), [#1064](https://github.com/manki-review/manki/pull/1064)).
8. Codex reviewers run without a shell, the image reader or web search ([#1048](https://github.com/manki-review/manki/pull/1048)).
9. `stats` is ignored. The round record is always a hidden comment in the review ([#1049](https://github.com/manki-review/manki/pull/1049)).
10. The `BUDGET` outcome is gone. A clean last round is `READY` with a successful `Manki` check ([#1050](https://github.com/manki-review/manki/pull/1050)).
11. `models.agents` is removed. A config that sets it gets an unknown-key warning, and the key no longer sets the second finder's model. Set `models.reviewer_pair`, or name models in a review group ([#1093](https://github.com/manki-review/manki/pull/1093)).

### Dispatched runs

- The Manki service orders every run of a PR, applies the skip rules, and drops pushes to drafts and to PRs with Pause ticked before it dispatches. The Action's in-app locks and its own skip checks are gone, and the PR's `.manki.yml` always comes from the head commit through the API ([#1084](https://github.com/manki-review/manki/pull/1084), [#1090](https://github.com/manki-review/manki/pull/1090)).
- A dispatched review shows a `Manki` check on the PR head with the round's result ([#1009](https://github.com/manki-review/manki/pull/1009)).
- After each review, Manki tells the service the reviewed commit, the approval and whether automatic review is paused. A push to a paused PR starts no run ([#1088](https://github.com/manki-review/manki/pull/1088)).
- Once a review posts its verdict, a failed progress comment from any earlier commit reads as superseded. A run that stops early marks its own progress comment "Review cancelled: the run stopped before the review finished" ([#1089](https://github.com/manki-review/manki/pull/1089), [#1090](https://github.com/manki-review/manki/pull/1090)).

### Reviewer tools

- Finders on the Claude CLI (`claude_code_oauth_token`) and the Codex CLI (`openai_oauth_token`) read the PR beyond the diff. Manki fetches the PR head with 500 commits of history into a folder that holds no credential, and gives each finder read, grep and glob confined to it, plus Manki's own `git_history` and `ast_grep` tools. A finder has no shell, no web access and no other tool. Finders on an API key or on Gemini still review the diff only ([#1054](https://github.com/manki-review/manki/pull/1054), [#1055](https://github.com/manki-review/manki/pull/1055), [#1059](https://github.com/manki-review/manki/pull/1059), [#1066](https://github.com/manki-review/manki/pull/1066)).
- Each finder gets a budget of tool calls by risk: 8 for the quick check of a trivial PR, 15 for a single finder, and 30 for a paired PR or one in a floor class such as `security`. It is told to wrap up three calls before the end, so its findings always arrive ([#1069](https://github.com/manki-review/manki/pull/1069)).
- Every finding carries the evidence behind it, and a blocker must cite the lines that prove it. A finding a finder ran out of steps on is marked "not checked yet", and what it was still checking comes back as an open lead. The judge settles a lead that could block, and the progress comment lists the others ([#1070](https://github.com/manki-review/manki/pull/1070)).
- The judge tries to refute every blocker and open lead with the same tools, and drops one the code rules out, with the reason in the progress comment. A blocker the judge cannot settle no longer blocks ([#1076](https://github.com/manki-review/manki/pull/1076)).
- A reply to a Manki thread is checked against the PR head with the same tools. The answer starts with Fixed, Withdrawn, Agreed, Kept or Unverified. A withdrawn finding saves a learning for its file only, and a security finding never saves one ([#1079](https://github.com/manki-review/manki/pull/1079)).
- Once Manki has answered a thread, a later round that finds the same problem never opens a new thread. It replies in that thread only when the code there got worse, and the review body lists the findings Manki agreed to leave for later as follow-ups ([#1082](https://github.com/manki-review/manki/pull/1082), [#1085](https://github.com/manki-review/manki/pull/1085)).
- These tools make a review on a subscription take longer and use more of it.

### Related repositories

- New `related_repos` setting: public repositories the review may read as context, as a `reference` this repository implements or a `consumer` that depends on it. Manki reads it from the base branch only ([#1052](https://github.com/manki-review/manki/pull/1052)).
- Finders with tools read these repositories through the same confined tools. A repository is fetched shallow, path-limited and without credentials the first time a finder names it. A change that breaks a consumer is a warning that lists its call sites ([#1068](https://github.com/manki-review/manki/pull/1068)).
- A finding that cites a related repository line that does not exist is graded like any claim the judge cannot check ([#1074](https://github.com/manki-review/manki/pull/1074)).

### Which PRs get reviewed

- New `skip_labels`, `skip_authors` and `skip_branches` settings name PRs that get no automatic review, such as bot dependency bumps. Manki reads them from the base branch only, so a PR cannot skip itself ([#1060](https://github.com/manki-review/manki/pull/1060)).
- Drafts are skipped by default, see the migration list above ([#1061](https://github.com/manki-review/manki/pull/1061)).
- A forced review of a large PR reads the diff in slices of `slice_lines` (default 1,500), four at a time, so it covers every line ([#1062](https://github.com/manki-review/manki/pull/1062)).

### Settings block

- Once the token service sends a PR's settings, Manki's newest progress comment ends with a settings block. It holds a status line and the boxes that apply: Pause automatic reviews, Full review, Deeper review, Cancel this review, Review this draft and Force review. The skipped, paused, draft and too-big notices move into it ([#1067](https://github.com/manki-review/manki/pull/1067), [#1077](https://github.com/manki-review/manki/pull/1077)).
- Every Force review box lives in the settings block. A head Manki already reviewed shows as up to date instead of getting a "Review skipped" comment, and the pause and too-big notices take over the progress comment ([#1080](https://github.com/manki-review/manki/pull/1080)).

### Review loop and verdicts

- The judge grades every finding against one blocker definition with five tests: the PR causes it, the failure can be named, the damage is serious, the code proves it with cited lines, and the author would fix it. Missing tests, style, performance without a crash, checks on trusted internal values and claims nobody can verify never block ([#1040](https://github.com/manki-review/manki/pull/1040)).
- The `review` block can name critical areas, say what counts as outside input, and give worked examples of how findings are graded ([#1044](https://github.com/manki-review/manki/pull/1044)).
- From the second round, each finding is new or previously missed. A smaller finding on code already reviewed gets no thread and is listed under "Previously missed", and Manki no longer objects to a fix it asked for ([#1057](https://github.com/manki-review/manki/pull/1057)).
- Only rounds that reviewed a new change count toward the automatic review pause, and the pause notice lists the blocking threads still open. An auto-approval resets the count like any approval ([#1041](https://github.com/manki-review/manki/pull/1041), [#1045](https://github.com/manki-review/manki/pull/1045)).
- A reply that Manki cannot check against the code gets "Unverified", and its thread stays open for a maintainer ([#1006](https://github.com/manki-review/manki/pull/1006)).
- Threads Manki resolves carry a resolution reason on GitHub: fixed, withdrawn or accepted ([#1037](https://github.com/manki-review/manki/pull/1037)).
- A finding that resembles an earlier fixed one goes to the judge with a note instead of being dropped, and the progress comment says how many findings were dropped before the judge and why ([#1011](https://github.com/manki-review/manki/pull/1011), [#1012](https://github.com/manki-review/manki/pull/1012)).
- Manki reads only the hidden round record. A round that only has the visible `Manki context` block of older releases no longer counts toward the round history or the round cap ([#1086](https://github.com/manki-review/manki/pull/1086)).
- Reviewers read the root `AGENTS.md` and the nearest one above each changed file, like `CLAUDE.md` ([#1039](https://github.com/manki-review/manki/pull/1039)).

### Review format

- The review body leads with the verdict and the findings. An approval's "What this does" follows in at most two sentences, and "What to test" is collapsed. Inline findings stay under about 700 visible characters with the rest collapsed, and nitpicks no longer get threads ([#1063](https://github.com/manki-review/manki/pull/1063)).
- A finding backed by evidence, inline or in the review body, has a collapsed "How this was checked" with up to five one-line entries. The fix-rate record notes whether a finding had evidence and whether the judge checked it ([#1081](https://github.com/manki-review/manki/pull/1081), [#1083](https://github.com/manki-review/manki/pull/1083)).
- Every finding opens with its severity, category and the effort of the fix, such as **Warning** · Concurrency · Moderate ([#1065](https://github.com/manki-review/manki/pull/1065)).
- Each finding in the review body lists is its own collapsed fold with a code preview, under a heading per list ([#1073](https://github.com/manki-review/manki/pull/1073)).
- A suggested fix in the review body shows its code as a fenced block under a **Suggested fix** label, and a block that names no language is highlighted by the file's extension, in the body and in inline comments ([#1087](https://github.com/manki-review/manki/pull/1087)).
- A PR whose files are all filtered out, or whose diff is too large, no longer shows "Review failed" on its progress comment ([#1007](https://github.com/manki-review/manki/pull/1007)).

### Security

- Manki redacts its own secret values from everything it posts to GitHub and writes to the memory repo ([#1042](https://github.com/manki-review/manki/pull/1042), [#1053](https://github.com/manki-review/manki/pull/1053)).
- Provider CLIs run with an allow list of environment variables. Claude on Bedrock, on Vertex or behind a gateway gets its credentials only while that setup is on ([#1051](https://github.com/manki-review/manki/pull/1051), [#1064](https://github.com/manki-review/manki/pull/1064)).
- `minimatch` is updated to 11 for advisory GHSA-g3hv-75wg-m249, a denial of service through glob patterns ([#1072](https://github.com/manki-review/manki/pull/1072)).

### Static analysis

- Manki runs actionlint and zizmor on changed workflows and ShellCheck on changed shell scripts, unless CI already runs the same tool. Turn one off with `static_analysis.analyzers.<name>: false` ([#1043](https://github.com/manki-review/manki/pull/1043)).
- Manki ships ast-grep rules for Rust that run in a Cargo repository and post hints the judge keeps as suggestions. Turn them off with `static_analysis.analyzers.ast_grep: false` ([#1046](https://github.com/manki-review/manki/pull/1046)).

### Reliability

- Saving a learning or suppression at the same time as another memory write no longer loses either change ([#1038](https://github.com/manki-review/manki/pull/1038)).
- A round record that does not fit the review is compressed instead of cut, and it keeps the raw finder findings and the findings the judge dropped ([#1049](https://github.com/manki-review/manki/pull/1049)).

### Docs

- The setup guide is split into pages under `docs/`: getting started, how reviews work, configuration, memory and the security model. `docs/configuration.md` has a reference of every setting, generated from the defaults ([#1075](https://github.com/manki-review/manki/pull/1075), [#1078](https://github.com/manki-review/manki/pull/1078)).
- `docs/migrating-to-v7.md` is a short checklist for moving from v6, with the setting that brings back each changed default. Getting started covers only the dispatched setup ([#1092](https://github.com/manki-review/manki/pull/1092)).

### Internal

- Each review and reply records every LLM call with its tokens, duration and an estimated cost. `npm run review-history` exports the records of a PR or repository, and `npm run calibration` measures blocker precision from them ([#1056](https://github.com/manki-review/manki/pull/1056), [#1058](https://github.com/manki-review/manki/pull/1058)).
- The `Release` workflow builds `dist/` on a release branch and writes no tags. An org admin tags and publishes the build ([#1008](https://github.com/manki-review/manki/pull/1008)).
- Manki's own workflow writes review memory with the App's memory token ([#1014](https://github.com/manki-review/manki/pull/1014)), and three comment trigger tests set their own API key input ([#1010](https://github.com/manki-review/manki/pull/1010)).

## [6.1.0] - 2026-11-06

### Upgrading

1. Pin the action to `manki-review/manki@v6`.
2. Copy the new job `if` from Step 3 of `SETUP.md`. The comment rules changed: the workflow no longer filters on `author_association`, and the action checks write access itself before it reads any secret ([#991](https://github.com/manki-review/manki/pull/991), [#995](https://github.com/manki-review/manki/pull/995)).
3. Review memory with the shared Manki App needs 6.1, because 6.0.x can no longer write memory through the App token. Otherwise set `memory_repo_token`. A memory repo with a name other than `<owner>/review-memory` needs `memory_repo_token` or your own App ([#994](https://github.com/manki-review/manki/pull/994), [#999](https://github.com/manki-review/manki/pull/999), [#1000](https://github.com/manki-review/manki/pull/1000)).
4. A review command no longer reviews a commit again when it already has a complete review. Manki replies with a Force review box instead, and only ticking it reviews the same commit again ([#1002](https://github.com/manki-review/manki/pull/1002)).

### Webhook mode (preview)

- New opt-in webhook mode. The Manki App receives the events and starts a dispatch-only workflow, `manki-dispatch.yml`, on your default branch, while every decision stays in the action. It is a preview for repositories on the service's allowlist, and every other repository keeps the event-driven workflow ([#987](https://github.com/manki-review/manki/pull/987), [#988](https://github.com/manki-review/manki/pull/988), [#1000](https://github.com/manki-review/manki/pull/1000)).
- Events run in order in two queues per PR, and several pushes during a review become one review of the newest head. Events Manki ignores start no run, and missed deliveries are picked up again every 5 minutes ([#988](https://github.com/manki-review/manki/pull/988)).
- Resolving the last open thread by hand runs the auto-approve check at once, which GitHub Actions cannot trigger on its own ([#987](https://github.com/manki-review/manki/pull/987)).
- The service adds the eyes reaction as soon as it queues a command. Manki now tracks the comments it answered with a hidden marker, so editing a comment to add a command still runs it ([#1003](https://github.com/manki-review/manki/pull/1003)).
- In webhook mode every run belongs to the default branch, so the PR shows no Manki check yet ([#1004](https://github.com/manki-review/manki/issues/1004)). Do not require a Manki status check while you use this mode.

### Review loop and verdicts

- Manki never approves a PR that conflicts with its base. A ready round posts its full verdict as a COMMENT with an "Approval held" line on top, and auto-approve posts one held notice per head instead of approving ([#998](https://github.com/manki-review/manki/pull/998)).
- Each run posts exactly one verdict review. Manki resolves the threads it counts as fixed before it posts, so a thread that cannot be resolved no longer leads to an approval followed by a request for changes on the same commit ([#998](https://github.com/manki-review/manki/pull/998)).
- An incomplete or failed review no longer counts as a review of its commit, so the next run reviews that commit normally. Its progress comment is marked superseded once a later verdict on the same head is posted ([#1002](https://github.com/manki-review/manki/pull/1002)).
- The review command reviews the current head when it has no complete review, and still bypasses the round cap and a pause ([#1002](https://github.com/manki-review/manki/pull/1002)).

### Security

- Starting Manki from a comment needs write access, and the action checks it before it requests a token or reads a provider credential. Organization members with a private membership work again. A contributor without write access and the author of a fork PR are refused without a reply ([#991](https://github.com/manki-review/manki/pull/991), [#995](https://github.com/manki-review/manki/pull/995)).
- A collaborator who is not the PR author can now tick Force review. The tick is checked against the editor, not the author of Manki's comment ([#991](https://github.com/manki-review/manki/pull/991)).
- With your own GitHub App, the review token is limited to the reviewed repo, and memory gets a second token limited to the memory repo with only `contents: write` ([#999](https://github.com/manki-review/manki/pull/999)).
- Memory writes use their own token: `memory_repo_token` first, then the App's memory token. They never fall back to the review token or `github_token`, and Manki logs one warning when no memory token is available ([#994](https://github.com/manki-review/manki/pull/994)).
- Provider CLIs start with a filtered environment. They get no `INPUT_*` variables, no OIDC request URL and no `*_TOKEN`, `*_KEY` or `*_SECRET` variables other than their own credential ([#994](https://github.com/manki-review/manki/pull/994)).

### Reliability

- A failed review always names its cause. A 5xx from GitHub reads as a transient failure with the status, the failing call, the request id and a retry hint, and an empty error names its status or type ([#992](https://github.com/manki-review/manki/pull/992)).

### Docs

- `SETUP.md` documents webhook mode, adds "Upgrading to 6.1", and explains the trade-off of running Manki under your own GitHub App, whose private key can mint tokens for the whole installation. The security notes say memory commands need write access ([#988](https://github.com/manki-review/manki/pull/988), [#1000](https://github.com/manki-review/manki/pull/1000)).

### Internal

- Manki reviews its own PRs in webhook mode. The event-driven workflow moves to `docs/examples/manki.yml`, which the snippet test keeps in step with `SETUP.md` ([#989](https://github.com/manki-review/manki/pull/989), [#997](https://github.com/manki-review/manki/pull/997)).

## [6.0.1] - 2026-11-06

### Review format

- Reviewers are named by the model they run on and the effort they ran at, plus the group's `focus` when one is set, such as "Claude Sonnet 5.5 · high". The "Finder" and "Pair finder" labels are gone, and the Trivial Change Verifier shows as "Quick check" ([#983](https://github.com/manki-review/manki/pull/983)).
- The progress comment's review header names the class and group the PR was routed to, such as "Review (security · pair)" ([#983](https://github.com/manki-review/manki/pull/983)).
- The fix-rate `specialist` field records the new reviewer names. Per-reviewer rows from before and after this release land in separate rows of `metrics/fix-rate.jsonl` and the report ([#983](https://github.com/manki-review/manki/pull/983)).

### Reliability

- A used-up provider quota, subscription limit or rate limit is no longer retried or sent to the fallback model. The round ends `INCOMPLETE` at once with a plain message that names the provider limit, the reviewers it stopped and the reset time when the provider gives one ([#984](https://github.com/manki-review/manki/pull/984)).

### Internal

- The workflow examples in `SETUP.md`, `docs/index.html` and `CONTRIBUTING.md` pin `@v6`, and `.manki.yml.example` matches the v6 defaults: `stats.hidden` is `true`, the memory repo no longer mentions patterns, and `static_analysis.analyzers` is listed ([#980](https://github.com/manki-review/manki/pull/980)).

## [6.0.0] - 2026-11-05

Manki 6 gives one clear verdict per round and stops a review loop that is not converging. Every round ends in a named outcome, a failed or partial run never approves, and the bar for blocking lives in code. One or two generalist finders replace the specialist team, and a final verdict reader checks the whole change before Manki approves. This release is tracked in [#859](https://github.com/manki-review/manki/issues/859).

### Breaking changes and migration

To upgrade from v5:

1. Pin the action to `manki-review/manki@v6`, or to the commit SHA of a `v6.x.y` release tag.
2. Replace `.github/workflows/manki.yml` with the snippet in `SETUP.md`. It carries the new `permissions`, the per-PR `concurrency` queues, the job-level `if` and `timeout-minutes: 30`.
3. Review the optional settings below: `models`, the `review` block, `static_analysis`, `metrics.fix_rate` and `stats.hidden`.

- Pin Manki to a release tag such as `manki-review/manki@v6`. `dist/` is no longer committed to `main`. The `Release` workflow builds it when a `vX.Y.Z` tag is pushed and moves the tag to the build commit, so `@main` and commit SHAs from `main` no longer run ([#842](https://github.com/manki-review/manki/pull/842)).
- The default Claude models are now `claude-haiku-5-5` for the planner and dedup, `claude-sonnet-5-5` for the reviewer, and `claude-opus-5-5` for the judge and the verdict reader. A repo that does not set `models` moves to these models and their cost. A repo that pins 4.x models keeps them ([#945](https://github.com/manki-review/manki/pull/945)).
- The specialist team is gone. Each round runs one generalist finder, or two finders on different models when the planner marks the change as paired, or the Trivial Change Verifier alone for a trivial change. Each `reviewers:` entry is now one extra focus line in the finder prompt instead of its own agent ([#934](https://github.com/manki-review/manki/pull/934)).
- `review_level` and `review_thresholds` are deprecated and ignored, with a warning. The planner now sizes the review from the nature of the change, not its line count ([#934](https://github.com/manki-review/manki/pull/934)).
- `models.agents` is deprecated and will be removed in the next major release. It still loads with a warning, and unless `models.reviewer_pair` is set, its first model that differs from `models.reviewer` becomes the second finder's model ([#934](https://github.com/manki-review/manki/pull/934), [#960](https://github.com/manki-review/manki/pull/960)).
- A failed or partial run never approves. A provider failure, an unparseable or truncated reply, a failed judge or a failed GitHub call ends the round `INCOMPLETE`. Manki posts a COMMENT with the reason, leaves the previous review standing and fails the job ([#893](https://github.com/manki-review/manki/pull/893), [#890](https://github.com/manki-review/manki/pull/890), [#897](https://github.com/manki-review/manki/pull/897), [#898](https://github.com/manki-review/manki/pull/898), [#915](https://github.com/manki-review/manki/pull/915)).
- A finder that still fails after its retry makes the round `INCOMPLETE`. The quorum path that let a round continue with the remaining agents is removed ([#934](https://github.com/manki-review/manki/pull/934)).
- Before Manki approves, a final verdict reader reads the whole diff once and can request changes on its own. A PR with no blocking findings therefore costs one more model call ([#915](https://github.com/manki-review/manki/pull/915)).
- From round 3 only blockers block. Warnings still standing become follow-ups listed in the review body, so a round with only warnings left can approve. Security findings are the exception and block at every round ([#922](https://github.com/manki-review/manki/pull/922), [#931](https://github.com/manki-review/manki/pull/931)).
- A blocker that comes back after a real fix claim ends the round `NOT_CONVERGING`. A fix claim is a resolved thread, a reply in the thread, or a fix Manki confirmed. A rebase with the thread still open and unanswered is not one, and the round stays `ADDRESS_FIRST`. On `NOT_CONVERGING` Manki keeps REQUEST_CHANGES, lists the blocker under "Needs a human" and pauses automatic review until someone comments `@manki review` ([#924](https://github.com/manki-review/manki/pull/924), [#965](https://github.com/manki-review/manki/pull/965)).
- Only blockers and warnings become review threads that hold up approval. Suggestions and nitpicks are posted inline as "not blocking" (at most five per review) or listed in a collapsed body section, and auto-approve ignores them, including old open suggestion and nitpick threads ([#917](https://github.com/manki-review/manki/pull/917), [#925](https://github.com/manki-review/manki/pull/925)).
- The PR author can no longer clear a security finding alone, unless the author is a repo admin. Agreeing with it or resolving its thread does not retire it. A maintainer other than the author has to resolve it or agree, or the judge has to find it addressed. If the author resolves the thread anyway, Manki reopens it once and explains why ([#942](https://github.com/manki-review/manki/pull/942), [#968](https://github.com/manki-review/manki/pull/968)).
- A `.manki.yml` with a YAML or schema error now fails the run and posts the error on the PR. Before, Manki reviewed with the defaults, which include `auto_approve: true` ([#909](https://github.com/manki-review/manki/pull/909)).
- The `review` and `static_analysis` blocks are read from the base branch only. A PR that changes them is reviewed with the base branch's copy, and the change applies after merge ([#938](https://github.com/manki-review/manki/pull/938), [#954](https://github.com/manki-review/manki/pull/954)).
- `stats.hidden` now defaults to `true`. The `Manki context` block sits in an HTML comment, and the visible stats line becomes a hidden `manki-stats` comment. Set `stats.hidden: false` to keep the visible block ([#925](https://github.com/manki-review/manki/pull/925)).
- Repeated findings are no longer escalated to blockers. Manki stops reading and writing `patterns.yml` in the memory repo, and existing files can be deleted ([#914](https://github.com/manki-review/manki/pull/914)).
- `noise_level` no longer changes the judge prompt. It still shapes the reviewer prompts, so existing configs keep working ([#907](https://github.com/manki-review/manki/pull/907)).
- The Claude CLI ignores user, project and local settings files and loads no MCP servers. Configure it only through its environment, such as `CLAUDE_CODE_OAUTH_TOKEN` ([#911](https://github.com/manki-review/manki/pull/911)).
- Personal Google accounts can no longer use `gemini_oauth_token`, because Google ended Login with Google for the Gemini CLI on consumer tiers. Switch to `gemini_api_key` ([#919](https://github.com/manki-review/manki/pull/919)).
- API-key users of Anthropic now run on API version `2026-10-21`, and the key is sent as `Authorization: Bearer`. This only matters if you put a proxy in front of the API through `ANTHROPIC_BASE_URL` ([#916](https://github.com/manki-review/manki/pull/916)).
- Recommended workflow changes, all in the `SETUP.md` snippet:
  - Action required: use the new `concurrency` block. Each PR gets two queues with `queue: max` and no `cancel-in-progress`: `manki-review-<pr>` for pushes and review commands, and `manki-reply-<pr>` for thread replies and other commands. Runs in a queue start in order and are never cancelled from outside. A running review stops on its own when a new commit lands ([#977](https://github.com/manki-review/manki/pull/977), [#978](https://github.com/manki-review/manki/pull/978)).
  - Add the job-level `if`, so GitHub skips events Manki ignores, such as bot comments, dismissals of Manki's own reviews and every fork PR event, before a runner starts. Add `timeout-minutes: 30` in place of the 6 hour default ([#977](https://github.com/manki-review/manki/pull/977)).
  - Drop `cache: 'npm'` from `actions/setup-node`. It fails the job in a repository without a lockfile, and the snippet runs no npm install that would use it ([#977](https://github.com/manki-review/manki/pull/977)).
  - The workflow needs only `actions: read` instead of `actions: write` ([#967](https://github.com/manki-review/manki/pull/967)). Add `checks: read` and `security-events: read` so Manki can read CI and code scanning results ([#938](https://github.com/manki-review/manki/pull/938)).
  - Add `closed` to the `pull_request` types to get the merge-time fix rate ([#932](https://github.com/manki-review/manki/pull/932)).
  - Pin the Claude, Codex and Gemini CLI installs to the versions in `SETUP.md`, and install Gemini with `--ignore-scripts` ([#894](https://github.com/manki-review/manki/pull/894), [#911](https://github.com/manki-review/manki/pull/911), [#918](https://github.com/manki-review/manki/pull/918)).
  - `github_token` no longer needs to be passed, since it defaults to the workflow token ([#909](https://github.com/manki-review/manki/pull/909)).
  - To pin by commit SHA, take the commit a release tag points to, or keep `@v6` and record it in a workflow lockfile. From v6.0.0 releases are immutable, so the SHA behind `v6.x.y` never changes ([#976](https://github.com/manki-review/manki/pull/976), [#977](https://github.com/manki-review/manki/pull/977)).
  - If a ruleset restricts who may dismiss reviews, allow the Manki app, or GitHub Actions when Manki runs without the app. Otherwise the old REQUEST_CHANGES keeps blocking the merge after Manki approves ([#977](https://github.com/manki-review/manki/pull/977), [#978](https://github.com/manki-review/manki/pull/978)).

### Review loop and verdicts

- Each round ends in one outcome: `READY` posts APPROVE, `ADDRESS_FIRST` and `NOT_CONVERGING` post REQUEST_CHANGES, `INCOMPLETE` posts COMMENT, and `BUDGET` posts APPROVE on the last automatic round when nothing blocks. The outcome is stored in the round context ([#915](https://github.com/manki-review/manki/pull/915), [#924](https://github.com/manki-review/manki/pull/924)).
- The last round `max_auto_rounds` allows blocks on blockers only. It ends `BUDGET` with an approval and the remaining warnings listed, or `NOT_CONVERGING` with a "Needs a human" list. A PR no longer sits at a stale REQUEST_CHANGES after the round cap ([#924](https://github.com/manki-review/manki/pull/924)).
- A push that leaves the PR's own change as it was, such as a clean rebase or an empty commit, keeps the previous verdict and runs no model. A previous approval is posted again on the new head, so a ruleset that dismisses approvals on push gets it back ([#921](https://github.com/manki-review/manki/pull/921)).
- Reviewers see the same filtered full PR diff every round, with no round number or earlier findings. Only the judge sees the history. This replaces the inter-round delta and follow-up planner context from 5.3.0 ([#908](https://github.com/manki-review/manki/pull/908), [#913](https://github.com/manki-review/manki/pull/913)).
- The judge re-grades every finding against a fixed rubric and no longer sees the reviewer's severity. Missing test coverage, unverifiable claims, untouched code and commit messages no longer block ([#907](https://github.com/manki-review/manki/pull/907), [#957](https://github.com/manki-review/manki/pull/957)).
- The judge now gets the full PR diff, so it can check a finding against the actual change ([#901](https://github.com/manki-review/manki/pull/901)).
- A judged severity can no longer land on the wrong finding when the model reorders its output, and a finding the judge leaves out stays visible ([#906](https://github.com/manki-review/manki/pull/906)).
- A blocker the judge marks `hypothetical` keeps its blocker severity. Only warnings and suggestions are still capped at nitpick ([#891](https://github.com/manki-review/manki/pull/891)).
- Resolving a Manki thread, or replying that you agree, now clears the matching earlier finding from the verdict. A finding reported only in the review body stops blocking once the PR no longer touches its file ([#912](https://github.com/manki-review/manki/pull/912)).
- When the judge finds that a fix addressed an open thread, the review no longer requests changes for it ([#910](https://github.com/manki-review/manki/pull/910)).
- Manki no longer closes its own threads just because the code moved. Threads the judge did not confirm fixed stay open, and findings that match them are no longer suppressed ([#920](https://github.com/manki-review/manki/pull/920)).
- A paused PR gets its pause notice once, and later pushes update it instead of posting another. The reply on a reopened security thread of a paused PR says to comment `@manki review` after pushing the fix ([#966](https://github.com/manki-review/manki/pull/966)).
- A blocker that matches an earlier blocker with an open thread gets no duplicate thread. The review links it under "Still open from earlier reviews" instead ([#965](https://github.com/manki-review/manki/pull/965)).
- A round that confirms a blocker fixed resolves Manki's thread with a `Fixed in <sha>.` reply and no longer blocks on it. A fix counts as confirmed only when the push changed the thread's file and the round does not name the blocker again ([#965](https://github.com/manki-review/manki/pull/965)).
- The round cap counts only the rounds since Manki last approved the PR, so rebases after an approval no longer use it up and pause an approved PR ([#965](https://github.com/manki-review/manki/pull/965)).
- The "Auto-approve withheld" notice appears only when no automatic review will run on the head, because review is paused or `auto_review` is off, and it says which. Withheld and pause notices are cleaned up once a round posts its verdict ([#969](https://github.com/manki-review/manki/pull/969)).
- A rebase-only push can auto-approve once its threads are resolved, and the `check` command explains why a commit is not approved yet ([#969](https://github.com/manki-review/manki/pull/969)).
- Manki never posts a verdict on a superseded commit. It checks the PR head between stages and before posting, and when the head moved it posts no review, resolves no threads and marks the progress comment as superseded by the new commit ([#967](https://github.com/manki-review/manki/pull/967)).
- A review in progress only holds back runs for the same commit, so a push during a `@manki review` run of the older commit gets its own review instead of "Review skipped" ([#967](https://github.com/manki-review/manki/pull/967)).

### Review format

- A review opens with a short verdict line: Approved, Changes requested, Review incomplete or Needs a human. A request for changes says what goes wrong in practice, and an approval says what the change does and what to test as numbered steps ([#925](https://github.com/manki-review/manki/pull/925), [#915](https://github.com/manki-review/manki/pull/915)).
- Finding comments open with the severity label, and a low-confidence finding says Manki is not sure it applies. Identifiers and paths from the diff are always shown as code, and a `suggestion` block only ever holds code that applies as is ([#925](https://github.com/manki-review/manki/pull/925)).
- Thread replies start with Fixed, Agreed, Withdrawn or Still open and stay within three sentences. On Fixed, Agreed or Withdrawn from the PR author or a collaborator, Manki resolves the thread ([#929](https://github.com/manki-review/manki/pull/929)).
- Review text from the judge, verdict reader and reviewers follows shared writing rules: plain words, the practical consequence first, no praise or filler ([#929](https://github.com/manki-review/manki/pull/929)).
- Hidden markers sit at the end of every comment, so notifications and previews start with the actual message ([#961](https://github.com/manki-review/manki/pull/961)).
- The progress comment drops its dash separators and decorative emoji and shows one status symbol per agent ([#925](https://github.com/manki-review/manki/pull/925)).
- File-level threads in the "Still open from earlier reviews" list show the path without `:0` ([#963](https://github.com/manki-review/manki/pull/963)).

### Security

- Security findings block at every round. The judge treats a reachable defect on attacker-controlled input, such as prompt injection, auth bypass or token exposure, as a blocker, or refutes it when the attacker gains nothing new ([#931](https://github.com/manki-review/manki/pull/931)).
- Provider CLIs run in an empty temp directory instead of the PR checkout. A PR can no longer add hooks, MCP servers, settings or context files that run during the review ([#911](https://github.com/manki-review/manki/pull/911)).
- A security-sensitive path always gets two finders, whatever the planner or the config say ([#934](https://github.com/manki-review/manki/pull/934)).
- A repo admin who authored the PR can clear a security finding on it, by resolving the thread or commenting `@manki dismiss` in it. Manki replies once in the thread, and every override is recorded in the round context and in the approval that relies on it ([#968](https://github.com/manki-review/manki/pull/968)).
- `@manki dismiss` in a Manki thread resolves it. Clearing a security finding this way needs write access, checked through the API ([#968](https://github.com/manki-review/manki/pull/968)).
- A Manki command quoted in inline code or a code block is treated as text and no longer runs ([#968](https://github.com/manki-review/manki/pull/968)).
- Stateless GitHub App tokens are now redacted in full from error text Manki posts, along with `ghu_` and `ghr_` tokens ([#905](https://github.com/manki-review/manki/pull/905)).

### Static analysis

- Manki reads check-run annotations, open code scanning alerts and vulnerable packages from the dependency review on the PR head, and gives reviewers the results on changed lines. A suggestion or nitpick that repeats a tool result on the same line is dropped. Configure the sources with `static_analysis` ([#938](https://github.com/manki-review/manki/pull/938)).
- Tool results on changed lines also reach the judge as candidate findings, and a kept one is posted with the tool in its label. Each reviewer finding is checked against the code first, and the judge sees whether a tool confirmed or contradicted it ([#943](https://github.com/manki-review/manki/pull/943), [#946](https://github.com/manki-review/manki/pull/946)).
- New opt-in `static_analysis.analyzers` runs `ast-grep` with Manki's own rules on changed JavaScript, TypeScript and Python files, for repos without CI checks. Turn it on with `ast_grep: true` or `analyzers: all`. No PR code runs ([#959](https://github.com/manki-review/manki/pull/959)).
- New `static_analysis.wait_for_checks` and `wait_timeout_seconds` let Manki wait for named CI checks in another workflow before it reads their results ([#959](https://github.com/manki-review/manki/pull/959)).
- Three more opt-in analyzers: `secrets` runs gitleaks on the added lines, `dependencies` runs OSV-Scanner on every changed lockfile, and `semgrep: { rules: [...] }` runs your own Semgrep-compatible rule files from the base branch with Opengrep. The binaries are pinned and checksum-verified, they use Manki's own config, and they never run PR code or see a token. All are off by default, and `analyzers: all` turns on `secrets` and `dependencies` but not `semgrep` ([#962](https://github.com/manki-review/manki/pull/962)).
- A changed lockfile is scanned even when `exclude_paths` hides it from the reviewers, such as `yarn.lock` under the default `*.lock`. Its results are listed in the review body ([#962](https://github.com/manki-review/manki/pull/962)).

### Reviewer groups and models

- New `review` block in `.manki.yml` with `groups`, `classes`, `routing`, `default_group` and `allow_weaker`. Each PR is sorted into a review class from its paths and the planner triage, and the class picks the group of finders that reads it. Without the block the built-in groups apply ([#952](https://github.com/manki-review/manki/pull/952), [#954](https://github.com/manki-review/manki/pull/954)).
- Security, supply chain and data contract changes are floor classes. They always get two finders on two models, and a group that would read them weaker fails the run unless `allow_weaker` names the class ([#952](https://github.com/manki-review/manki/pull/952), [#954](https://github.com/manki-review/manki/pull/954)).
- A tests-only change is no longer trivial and gets a full finder instead of the Trivial Change Verifier ([#952](https://github.com/manki-review/manki/pull/952)).
- New `models.reviewer_pair` sets the second finder's model. Without it, the second finder runs on the other Claude tier, so Sonnet pairs with Opus ([#933](https://github.com/manki-review/manki/pull/933), [#934](https://github.com/manki-review/manki/pull/934)).
- New `planner.paired` (`auto`, `always` or `never`) pins whether a second finder runs. It is already deprecated in favour of `review.routing` and logs a warning, but it still works ([#934](https://github.com/manki-review/manki/pull/934), [#954](https://github.com/manki-review/manki/pull/954)).
- Reviewer `effort` accepts `max` ([#954](https://github.com/manki-review/manki/pull/954)).
- GPT-5 and later models now honour the effort tiers, and `max` reaches `xhigh` or `max` where the model allows it. The Codex CLI is pinned to 0.166.0 ([#918](https://github.com/manki-review/manki/pull/918)).
- Gemini runs on `@google/genai`, and Gemini 3 models get the effort tier as `thinkingLevel` ([#919](https://github.com/manki-review/manki/pull/919)).
- The Anthropic API path sends adaptive thinking to Opus 4.6 and later, which reject the budget form. Before, every API-key run with the default judge failed ([#892](https://github.com/manki-review/manki/pull/892)).
- `claude_code_oauth_token` is no longer deprecated and no longer logs a warning on every run. The Claude Code CLI is pinned, so a future default of `--bare` cannot break it ([#888](https://github.com/manki-review/manki/pull/888), [#894](https://github.com/manki-review/manki/pull/894)).
- On merge, Manki records how many of its posted findings were fixed, dismissed or left untouched, in the job summary and in `metrics/fix-rate.jsonl` when memory is on. Turn it off with `metrics.fix_rate: false`. A new `npm run fix-rate-report` script turns these files into tables ([#932](https://github.com/manki-review/manki/pull/932), [#957](https://github.com/manki-review/manki/pull/957), [#960](https://github.com/manki-review/manki/pull/960), [#964](https://github.com/manki-review/manki/pull/964)).
- The `Manki context` block records the finder models, which finders raised each kept finding, and a `routing` object with the class, group and a digest of the review config ([#933](https://github.com/manki-review/manki/pull/933), [#960](https://github.com/manki-review/manki/pull/960)).

### Reliability

- Claude CLI output is capped at 32768 tokens, so a runaway reply ends as a truncated reply that the stage retries once. Each stage has its own time budget: the judge stops after 300 s and the verdict reader after 900 s, instead of 1,200 s ([#958](https://github.com/manki-review/manki/pull/958)).
- The judge and the verdict reader are asked once more when a reply does not parse, so one malformed reply no longer costs the round ([#928](https://github.com/manki-review/manki/pull/928)).
- JSON is read from the shape each stage expects, so a bracket in prose before the JSON no longer breaks parsing ([#927](https://github.com/manki-review/manki/pull/927)).
- Transient GitHub errors and rate limits are retried. A persistent error fails the run instead of turning REQUEST_CHANGES into a COMMENT ([#898](https://github.com/manki-review/manki/pull/898)).
- Long PRs with more than 100 comments or threads, or more than 30 reviews, keep their round state, lock and auto-approve behaviour ([#926](https://github.com/manki-review/manki/pull/926)).
- Runs on the workflow token, a custom GitHub App or a personal access token now recognise their own comments and reviews, so round state, the concurrency lock and the round cap work across rounds. With a personal access token, use a dedicated account ([#923](https://github.com/manki-review/manki/pull/923), [#941](https://github.com/manki-review/manki/pull/941)).
- Excluded and generated files no longer reach any prompt, and an oversized diff gives every file a fair share of the budget instead of cutting from the top ([#904](https://github.com/manki-review/manki/pull/904)).
- A draft marked ready for review is now reviewed ([#909](https://github.com/manki-review/manki/pull/909)).
- Replies and `@manki` commands on a Manki thread are no longer dropped with a "Review skipped" comment ([#889](https://github.com/manki-review/manki/pull/889)).
- A stage the provider refuses is retried once on a fallback model: `models.fallback` if set, else the reviewer model, or the other Claude tier when the stage already runs on it. A second refusal ends the round `INCOMPLETE`, and each fallback is recorded in the round context ([#955](https://github.com/manki-review/manki/pull/955)).
- A running review checks the PR head every 30 seconds and stops within about 30 s when a new commit lands, aborting the model call in flight. After a cancel signal it makes no GitHub writes, so a cancelled run never posts or dismisses a review ([#978](https://github.com/manki-review/manki/pull/978)).
- A progress comment from an old run that GitHub deleted under its retention rules counts as finished and no longer blocks reviews. A failed dismissal of an earlier review is logged as a warning ([#978](https://github.com/manki-review/manki/pull/978)).
- When GitHub refuses an approval, Manki logs GitHub's real error and names the repo setting only when the error does. Before, it always blamed the "Allow GitHub Actions to create and approve pull requests" setting ([#967](https://github.com/manki-review/manki/pull/967)).

### Internal

- `runFullReview` is split into named stages, `runReview` takes one options object, and a new end-to-end test runs a round against a fake GitHub ([#947](https://github.com/manki-review/manki/pull/947), [#948](https://github.com/manki-review/manki/pull/948), [#949](https://github.com/manki-review/manki/pull/949)).
- The release workflow runs on current actions and publishes with immutable releases in mind. It builds `dist/`, publishes the release, and only then moves the floating `vX` tag ([#976](https://github.com/manki-review/manki/pull/976)).
- Feature and fix PRs no longer edit `CHANGELOG.md`, and CI enforces it. The release PR writes the entries ([#900](https://github.com/manki-review/manki/pull/900)).
- `@anthropic-ai/sdk` moves to 1.4, `npm audit` findings are fixed and the workflows use the Node 24 actions ([#916](https://github.com/manki-review/manki/pull/916), [#896](https://github.com/manki-review/manki/pull/896)).
- `AGENTS.md` has a current architecture map, and a test fix restored `main` CI ([#895](https://github.com/manki-review/manki/pull/895), [#902](https://github.com/manki-review/manki/pull/902)).

## [5.3.0] - 2026-05-25

### Added

- `RunReviewerAgentOptions` now accepts an optional `interRoundDiff` field, threaded through all four call sites in the review pipeline. On follow-up rounds with a non-empty `interRoundDiff`, the `## Pull Request Diff` block in the reviewer prompt becomes `## Pull Request Diff (delta since prior review round)` populated with the delta instead of the full PR diff, so reviewers focus exclusively on what changed since they last looked. The `## Changed Files` block continues to carry full-PR file contents for reference. Closes [#820](https://github.com/manki-review/manki/issues/820), [#821](https://github.com/manki-review/manki/issues/821) ([PR #853](https://github.com/manki-review/manki/pull/853), [PR #854](https://github.com/manki-review/manki/pull/854)).
- On follow-up rounds (round > 1), the planner system prompt now includes a `## Follow-Up Round Context` block with the current round number, the inter-round delta line count (counting only `+`/`-` lines, not headers or context lines, via a new `countChangedLines` helper), and the pinned team that will be unioned with the planner's picks, along with guidance to default to the prior team when the delta is small. Closes [#822](https://github.com/manki-review/manki/issues/822) ([PR #855](https://github.com/manki-review/manki/pull/855)).

### Fixed

- `isPriorLikelyUnresolved` now retires threadless priors (handover entries without a `threadId`, produced before the `threadId` field was introduced) when no review threads are currently open on the PR. Previously, these legacy priors triggered a false `Blocking unresolved review threads:` header on long-running PRs whose round 1 ran on a pre-`threadId` handover format, even though all threads had since been resolved. Closes [#847](https://github.com/manki-review/manki/issues/847) ([PR #851](https://github.com/manki-review/manki/pull/851)).

## [5.2.0] - 2026-05-24

### Added

- `RoundPlanner` now carries full team-selection provenance: `source` (`planner` / `heuristic` / `heuristic_fallback` / `disabled`, replacing the ambiguous `used: boolean` which is preserved as a derived alias), `fallbackReason` (short tag when the planner failed: `timeout`, `invalid_teamSize`, `invalid_judgeEffort`, `agents_teamSize_mismatch`, `exception`), `language` and `context` (the sanitized hints the planner emitted), `agents` (the picks with per-agent effort), `coreAgentInjections` (names the team-builder reinjected after the planner omitted them, e.g., Security & Safety on sensitive paths), and `priorRoundEffortDowngrades` (effort steps applied by the safety net when the previous round dismissed all of a specialist's findings). `RoundAgentMetric` gains `model` (the resolved per-agent model, from `config.models.agents` or `models.reviewer`), `effort` (the run-time effort after planner pick plus downgrade), and `multiPassConsistency` (`{ consistent, totalRaw }` from `intersectFindings` on `review_passes > 1` rounds). Replay tooling can now answer "why did this round pick these agents at this effort?" from the persisted context alone ([#793](https://github.com/manki-review/manki/issues/793)).
- Every Manki review body now ends with a `Reviewed commit [`<short-sha>`](…)` footer linking to the exact commit reviewed, removing ambiguity about which SHA a verdict applies to and giving a stable human-visible anchor for every review across `APPROVED` / `COMMENTED` / `CHANGES_REQUESTED` ([#807](https://github.com/manki-review/manki/issues/807)).
- `RoundMeta` now carries `cap` (`priorRoundCount`, `maxAutoRounds`, `skipCap`, `forceReview`, `bypassReason`) and `trigger` (`event`, `sender`) provenance, so a round-cap progression like `5/5 -> 6/5` is attributable to the exact tickbox or comment that admitted each round ([#791](https://github.com/manki-review/manki/issues/791), [PR #815](https://github.com/manki-review/manki/pull/815)).
- `RoundContext.usage` now ships per-stage token counts (`planner`, `reviewer`, `judge`, `dedup`) and round-level rollups (`inputTokens`, `outputTokens`, `totalTokens`) sourced directly from each provider's SDK/CLI usage block. `LLMResponse` carries `usage` (`inputTokens`, `outputTokens`, `cachedTokens`, `reasoningTokens`) and `latencyMs` on every call. `RoundAgentMetric` is populated with `durationMs`, `inputTokens`, `outputTokens`, `retryCount`, `status`, and `failureReason` (threaded from `ReviewResult.agentFailureReasons`). `RoundJudge.retryCount` is wired through. Replay tooling can now reconstruct token cost and per-stage latency from metadata alone ([#792](https://github.com/manki-review/manki/issues/792)).
- `runFullReview` now refetches the PR's current `head.sha` via `octokit.rest.pulls.get` after config load and bails with a `core.info` line (`Event SHA <a> != head SHA <b> — bailing out`) when the head has advanced past the event SHA the run was triggered with. The check sits before `postProgressComment` so a stale-SHA bail leaves no progress marker behind to block a sibling run, complements the existing `pull_request_review` stale-SHA guard in `handleReviewStateCheck`, and is fail-open: a transient `pulls.get` error logs `Head SHA lookup failed, proceeding: <error>` and the review continues so an API hiccup never disables reviews ([#826](https://github.com/manki-review/manki/issues/826), [PR #831](https://github.com/manki-review/manki/pull/831)).
- `RoundContext` now carries dedup, recap, and diff-prep attribution that was previously lost between pipeline stages. `RoundDedup` gains `sameRoundLlmDropped` (the judge's same-round merge count, previously rolled into `mergedDuplicates` via subtraction), `duplicateMatches[]` (per-drop `{ droppedTitle, matchedTitle, matchType }` for both `deduplicateFindings` and `llmDeduplicateFindings`, with `matchType` ∈ `'exact' | 'substring' | 'word_overlap' | 'llm'`), and `testNitSuppressedCount` (returned from `runReview` but previously never written into the context). `RoundDiff` gains `excludedFiles` (path + matched glob), `binarySkipped` (paths dropped by `isBinaryFile` during `parsePRDiff`), `oversizedHandled` (always `false` on the success path, recorded explicitly so replay tooling can tell oversize-bail rounds apart from regular ones), and `perFile` (lossless `{ path, additions, deletions, changeType }` rollup that replaces the lossy `fileTypes` aggregate). `RoundMemory` gains `loadStatus` (`'loaded' | 'disabled' | 'no_token' | 'failed'`) and `loadError` (truncated message on failure), so a silently-collapsed memory load is no longer indistinguishable from "memory disabled". `RoundContext` gains a `recap` sub-section recording `priorRoundCount` (priors actually loaded), `reclassifiedPriorCount` (fingerprints whose `authorReplyClass` flipped during `refreshAuthorReplyClass`), and `reclassifiedPriors[]` (capped attribution by `threadId`). All new fields are optional so older context blocks parse cleanly ([#794](https://github.com/manki-review/manki/issues/794)).

### Fixed

- `checkAndAutoApprove` no longer posts an empty placeholder review when the `APPROVE` event fails. The previous fallback emitted a `COMMENT` review whose body was a bare `<!-- manki -->` HTML comment (rendered by the API as `body_length: 0`), which then tripped the head-SHA dedupe gate (`hasBotReviewOnCommit`) and broke the round-cap force-review tickbox loop — every subsequent tick bailed with "Review skipped — a review has already been posted for this commit". The `APPROVE` body now carries visible content (`**Manki** — Auto-approved (all findings resolved).`) so it does not register as an empty review, and the no-permission fallback path posts a plain issue comment instructing the user to enable "Allow GitHub Actions to create and approve pull requests" instead of creating a placeholder review on the head SHA ([#840](https://github.com/manki-review/manki/issues/840)).
- `checkAndAutoApprove` now bails when the latest non-`DISMISSED` `manki-review[bot]` review's `commit_id` does not match the current `pr.head.sha`, so a thread-reply `pull_request_review` event from a third party (which fires with `commit_id = head.sha` and slips past the event-level stale guard in `handleReviewStateCheck`) can no longer trigger an undeserved `APPROVED` review on a HEAD manki has never actually reviewed. The bail emits a structured `core.warning` carrying both SHAs and posts a single explanatory PR comment (idempotent per HEAD via a `manki-stale-approve:<sha>` marker) instructing the user to re-trigger with `@manki review` ([#838](https://github.com/manki-review/manki/issues/838)).
- `fetchBotReviews` now filters out empty-body `pull_request_review` wrapper objects that GitHub's REST API auto-creates when `createReplyForReviewComment` is called. These wrappers (body: `""`) are not real reviews but were indistinguishable from bot reviews to `hasBotReviewOnCommit` and `isApprovedOnCommit`, causing the dedupe gate to fire incorrectly on commits that had only received reply comments, not a full manki review ([#843](https://github.com/manki-review/manki/issues/843), [PR #844](https://github.com/manki-review/manki/pull/844)).
- The heuristic-fallback and planner-enabled `planning` progress events no longer carry an explicit `rawFindingCount: 0`. The field is optional on `ReviewProgress`, so omitting it is semantically equivalent for all consumers (which already default via `?? 0`), but emitting an explicit zero was misleading: it implied zero findings had been collected when in fact the review has not started yet ([#765](https://github.com/manki-review/manki/issues/765)).

- Removed tautological `perTeamSum` assertion in `github.test.ts` that summed a hardcoded literal array and compared it to the equally hardcoded `rawFindingCount` fixture value, testing the test author's arithmetic rather than `buildDashboard`. The individual `toContain` assertions for each per-team count and the `'**Review** — 18 findings'` header already cover the meaningful behavior ([#764](https://github.com/manki-review/manki/issues/764), [PR #835](https://github.com/manki-review/manki/pull/835)).
- `baseOpenThreads` in `src/index.ts` now uses a type-predicate filter `(f): f is PreviousFinding & { threadId: string }` instead of a truthy guard followed by a `!` non-null assertion, making the narrowing explicit and compiler-verified ([#769](https://github.com/manki-review/manki/issues/769), [PR #836](https://github.com/manki-review/manki/pull/836)).
- `checkAndAutoApprove` now posts its own in-progress marker comment before calling `pulls.createReview`, transitions it to a "Review complete" terminal body on success, and to a labeled failure body if both the `APPROVE` and `COMMENT` fallback calls throw. The marker reuses the same `BOT_MARKERS` + `manki-run-id` envelope as the full-review path so `findInProgressLock` and `checkConcurrentSubmissionLock` treat it as a live lock, closing the defense-in-depth gap where two concurrent auto-approve runs could both pass the existing `listReviews` precondition (which only sees finalized reviews, not in-flight ones) and race into a duplicate approval. The bail paths (sibling marker detected, `isReviewInProgress`, prior `APPROVED` on this SHA) all exit before the marker is posted, so an aborted invocation never leaves a stale lock behind ([#827](https://github.com/manki-review/manki/issues/827), [PR #830](https://github.com/manki-review/manki/pull/830)).
- `.manki.yml` is now sourced from the PR head's local checkout (`process.cwd()`) instead of the base ref, so a PR that adds or modifies its own config (e.g., extending `exclude_paths`) takes effect on the same PR rather than only after merge. User-supplied `exclude_paths` are also unioned with `DEFAULT_CONFIG.exclude_paths` (deduped) instead of replacing them, so adding a single pattern no longer silently drops the built-in `*.lock`, `dist/**`, `*.generated.*` skips. Closes the chicken-and-egg observed on [PR #810](https://github.com/manki-review/manki/pull/810) where the dist/-on-main migration tripped the PR-size gate because main's `.manki.yml` lacked `dist/**` and the PR's local override was never consulted ([#813](https://github.com/manki-review/manki/issues/813)).
- State-based head-SHA dedupe gate: `manki-review[bot]` now bails before any LLM call when a non-`DISMISSED` bot review already exists on the current head SHA. Closes the serialized-sibling race observed on [PR #805](https://github.com/manki-review/manki/pull/805) where one human review fanned out into a `pull_request_review` and `pull_request_review_comment` event pair, the workflow `concurrency` group serialized them, and the in-progress marker from #796 had already been cleared by the time run #2 scanned. The new `hasBotReviewOnCommit` helper in `src/github.ts` is consulted by `handlePullRequest`, `handleCommentTrigger`, `handleReviewCommentInteraction`, and `runFullReview` (defense in depth, right after `checkConcurrentSubmissionLock`). When the gate fires the run posts a `**Review skipped** for `<short-sha>` — a review has already been posted for this commit` comment so the user sees nothing was silently dropped. `@manki review` (force-review) still bypasses the gate so explicit re-review on the same SHA proceeds. `postReviewSkippedComment` takes a `SkipReason` (`'in_progress'` | `'already_reviewed'`) and always includes the short head SHA on both paths ([#806](https://github.com/manki-review/manki/issues/806)).
- The PR-size gate (`max_diff_lines`) now applies `exclude_paths` before counting, so generated artifacts the user has opted out of (`dist/**`, `*.lock`, `*.generated.*` by default) no longer trip the "PR too large for automated review" abort. Previously the raw diff was counted, which caused PRs that commit a build bundle (e.g., `dist/index.js` on `main`) to short-circuit review even when the reviewable source delta was small.
- The judge now enforces one `threadEvaluations` entry per open review thread. Missing entries trigger a single retry with a stricter reminder, any still-missing entries after retry are synthesized as `uncertain` with a `core.warning`, and the system prompt pins an explicit `You MUST return exactly N entries` constraint. When the verdict gate fires on `prior_unaddressed`, the PR comment body now lists each blocking thread inline with file, line, original severity, and a direct GitHub link instead of silently blocking. Closes [#808](https://github.com/manki-review/manki/issues/808).

### Changed

- `openai.ts` no longer defines its own `buildTimeoutDiagnostics`; it now imports the function directly from `cli-utils`, matching how `anthropic.ts` and `gemini.ts` already consume it. The local copy was structurally identical to the exported one, so this is a pure deduplication with no behaviour change ([#722](https://github.com/manki-review/manki/issues/722)).
- Extracted `AGENT_POOL`, `TRIVIAL_VERIFIER_AGENT`, and `buildAgentPool` from `src/review.ts` into a new low-level `src/agents.ts` module, breaking the layering inversion where `src/config.ts` (low layer) imported from `src/review.ts` (orchestration layer) just to validate `reviewers` names against the agent pool. `src/config.ts`, `src/index.ts`, and the test files now import these primitives directly from `./agents`, and `src/review.ts` consumes them from the same module so the agent-pool primitives have a single canonical home decoupled from review orchestration ([#676](https://github.com/manki-review/manki/issues/676), [PR #833](https://github.com/manki-review/manki/pull/833)).
- Switched to the canonical TypeScript-Action release model: the compiled `dist/` is committed to `main` so both floating (`manki-review/manki@v5`) and immutable exact-version (`manki-review/manki@v5.x.y`) pins resolve to a runnable action. Previously, `release.yml` committed `dist/` onto a one-off SHA and force-updated only the major tag, leaving exact-version tags pointing at source-only commits that failed with `File not found: dist/index.js` on the runner. A new [`check-dist.yml`](.github/workflows/check-dist.yml) workflow runs on every PR and `push` to `main`, rebuilds `dist/`, and fails if the committed copy drifts from a fresh build. `release.yml` is simplified to just force-update the floating major tag and publish the GitHub Release. `dist/**` is added to `.gitattributes` (`linguist-generated=true`, plus `-diff` on the minified entry) so the GitHub PR Files view collapses the bundle diff, and to `.manki.yml` / `codecov.yml` so manki self-reviews and coverage reports skip it. [`CONTRIBUTING.md`](CONTRIBUTING.md) documents the local `npm run build` step contributors must run before opening a PR. Historical `v5.0.0` and `v5.0.1` tags remain source-only and continue to require pinning to `@v5` ([#800](https://github.com/manki-review/manki/issues/800)).

## [5.1.1] - 2026-05-22

### Fixed

- `checkAndAutoApprove` now consults the same TTL-based in-progress-marker scan as the full-review path, so it cannot auto-approve while a parallel `runFullReview` is still mid-flight. Closes the silent verdict-flip seen on [patchly-gold/patchly#69](https://github.com/patchly-gold/patchly/pull/69) where an APPROVED landed during an in-flight review that later posted CHANGES_REQUESTED. `checkConcurrentSubmissionLock`, `readConcurrencyLockTtlSeconds`, and `DEFAULT_CONCURRENCY_LOCK_TTL_SECONDS` moved from `index.ts` to `github.ts` so both entry points share the scan. `config` threaded through the three `checkAndAutoApprove` call sites so the guard honors `concurrency_lock_ttl_seconds` from `.manki.yml` (#801, [PR #802](https://github.com/manki-review/manki/pull/802)).
- CLI exit-non-zero diagnostics now capture the last 500 chars of stdout, elapsed runtime, model, effort, prompt size, stderr length, and signal across all three providers (`anthropic.ts`, `openai.ts`, `gemini.ts`) via a new `buildExitDiagnostics` helper in `cli-utils.ts`. For the Claude path, the terminal stream-json `result` event (`is_error`, `subtype`, message text) is parsed and rendered as comma-joined `result.*` ctx entries, so failures like `Claude CLI failed (exit 1: )` with empty stderr now surface the actual reason (e.g., `error_during_execution`, `error_max_turns`) instead of an opaque blank (#803, [PR #805](https://github.com/manki-review/manki/pull/805)).

## [5.1.0] - 2026-05-22

### Added

- In-app concurrent-submission lock: `manki-review[bot]` bails out at the review pipeline entry point when another run already holds a fresh in-progress marker with a different `manki-run-id` within the configurable TTL. New action input `concurrency_lock_ttl_seconds` (default 600, max 3600) (#779, [PR #796](https://github.com/manki-review/manki/pull/796)).
- `noise_level` config knob (`low` / `medium` / `high`, default `medium`) suppresses nit-volume noise at the source. At `low`, reviewer agents are instructed to surface only blockers and warnings; at `high`, all findings including nitpicks are encouraged. Replaces the deprecated `nit_handling: 'issues'` routing (#739, #740, #741).
- Judge calibration honors `noise_level` — the judge's acceptance threshold for nitpick findings scales with the configured level so the gate stays consistent with the reviewer signal (#761).
- Reviewer-agent prompts honor `noise_level` — the effort-level and finding-count guidance in each reviewer's system prompt adapts to the configured level (#760).

### Changed

- New CI check fails when `package.json` version does not match the most recent non-Unreleased CHANGELOG heading, preventing version drift. Adds top-level `RELEASE.md` (#783, [PR #795](https://github.com/manki-review/manki/pull/795)).
- `nit_handling: 'issues'` is deprecated and has no effect. The `nit_handling` config key is now ignored. Migrate to `noise_level` instead (#742, #771).
- `/manki triage` command removed. The triage flow relied on `nit_handling: 'issues'` routing, which is gone. No replacement command is needed: `noise_level` controls nit volume at the source (#771).

### Fixed

- Judge `threadEvaluations.status === 'addressed'` is now wired through `determineVerdict` and `applyCrossRoundSuppression`, so a thread the judge knows the author silently fixed no longer blocks APPROVE (#787, [PR #797](https://github.com/manki-review/manki/pull/797)).
- `PLANNER_TIMEOUT_MS` bumped from 30s to 60s to absorb normal API tail latency without masking genuine hangs ([PR #786](https://github.com/manki-review/manki/pull/786)).
- `ready_for_review` webhook event now correctly triggers a review when a draft PR is converted to ready (#717, #744).
- Planner timeout race eliminated by eagerly warming up the Claude CLI during action startup, before the planner call (#735, #749).
- Review-summary timings on planner fallback now sourced from agent completion timestamps rather than a missing planner field (#736, #748).
- Planner PR-type vocabulary aligned to Conventional Commits (`feat`, `fix`, `refactor`, etc.) so planner decisions are consistent with the project's commit taxonomy (#737, #750).
- Skip-ack comment now posts a fresh comment instead of editing the prior one, preventing stale edit-based ack from showing for the wrong commit (#664, #759).
- `determineVerdict` now grounds its addressed/not-addressed decision in the GitHub `isResolved` state, preventing zero-diff force-pushes from auto-resolving open warnings incorrectly (#758).
- `Judge` kept counts and test-nit suppression surface accurately in the stats block (#773).
- CI test flake in `plannerDurationMs` assertion resolved by relaxing the assertion to `>= 0` (#781).
- The planner's team selection is now trusted. `selectTeam` no longer post-injects `{Security, Architecture, Correctness}` on top of the planner's picks, so a 3-agent plan stays a 3-agent review. The dashboard `Planner` line reports the actual resolved roster size instead of the planner-requested `teamSize`, matching the per-category breakdown. When the planner is unavailable, manki falls back to a conservative fixed `{Security, Architecture, Correctness}` roster. Closes [#784](https://github.com/manki-review/manki/issues/784).

### Action required for downstream installs

- Update the `concurrency:` block in your `.github/workflows/manki.yml` to drop `github.event_name` from the `group` key and set `cancel-in-progress: false`. See [SETUP.md](SETUP.md#step-3-add-the-workflow) for the new snippet. Without this change, concurrent runs triggered by different event types (e.g. `pull_request` + `pull_request_review`) can race and submit conflicting reviews on the same commit. Closes [#776](https://github.com/manki-review/manki/issues/776).

## [5.0.1] - 2026-05-20

### Fixed

- `action.yml` description shortened to fit GitHub Marketplace's 125-character limit so the action can be published / re-published to the Marketplace. No runtime behavior change.

### Docs

- CHANGELOG entry for `v5.0.0` stamped with its actual release date (was `unreleased`).

## [5.0.0] - 2026-05-20

### Added

- `stats.hidden` config (default `false`). When `true`, the per-round `Manki context` payload renders as an HTML comment (`<!-- manki-context: ... -->`) instead of a `<details>` block, keeping the payload machine-readable while hiding it from the rendered review (#711).

### Changed (BREAKING)

- `openai_oauth_token` and `gemini_oauth_token` inputs now expect the **base64-encoded contents of the CLI's auth JSON file**, not a single-string token. Both CLIs read OAuth credentials from disk (`$CODEX_HOME/auth.json` for Codex, `~/.gemini/oauth_creds.json` for Gemini) and there is no portable single-string equivalent that the spawned subprocesses honor with refresh-token semantics. On invocation the action seeds the file with mode `0600` only when absent, so refreshed tokens written by the CLI on persistent runners are preserved across runs. Re-bootstrap when the `refresh_token` expires (#695).
  - Bootstrap (Codex): ``codex login`` then ``cat ~/.codex/auth.json | base64 | gh secret set OPENAI_OAUTH_TOKEN``
  - Bootstrap (Gemini): sign in with ``gemini`` then ``cat ~/.gemini/oauth_creds.json | base64 | gh secret set GEMINI_OAUTH_TOKEN``
  - The legacy single-token shape is rejected fast with an error pointing to the bootstrap command. No fallback or compat shim.
- Per-round state moved from the memory repo (`prs/{n}/handover.json`) to a `Manki context` block embedded in each review summary on the PR itself. The memory repo now retains only cross-PR data (`learnings.yml`, `patterns.yml`, `suppressions.yml`), so `memory_repo_token` no longer needs write access to `prs/{n}/handover.json`. Existing `handover.json` files in memory repos are orphaned but harmless and require no migration. In-flight PRs upgrading mid-review see one round of regressed prior-round context (round cap, cross-round suppression, planner team carry-over, etc.) until the next manki comment lands the embedded block. Parent: #684. Implementation: #706 (emit), #712 (aggregate), #723 (consumers), #728 (drop write path).
- `Force review` tickbox on the round-cap notice now only bypasses the round cap, not other gating. `forceReview` and `skipCap` are now distinct flags on `ReviewConfig`, so ticking the box re-enables a single follow-up review without disabling other safeguards (#727).

## [4.7.0] - 2026-04-28

### Added

- Review convergence mechanisms gated by a new `convergence` block in `ReviewConfig`. Round-count hard cap (`max_auto_rounds`, default 5) skips automatic re-reviews after the cap with a posted notice, while `@manki review` bypasses it. Test-file nit suppression (`test_path_patterns`) drops `suggestion` and `nitpick` findings on test files from round 2 onward, keeping `blocker` and `warning` findings. Resolved-thread cross-round suppression (`suppress_resolved_threads`) ratchets prior-round findings whose GitHub threads are now resolved to `ignore`, with `blocker` findings still protected (#646)
- Review team is pinned across rounds with monotonic growth. Round 1's resolved agents persist on `HandoverRound.agents`, and from round 2 onward `selectTeam` unions prior-round agents with the planner's picks (or the heuristic team) before injecting core agents. The planner may add agents but never remove them, and the audit log distinguishes inherited from newly added agents (#643)

### Fixed

- `selectTeam` planner path now prepends any missing `CORE_AGENTS` (Security, Architecture, Correctness) to the resolved team in `CORE_AGENTS` order, fixing silent core-agent drops when the planner omitted them (#641)

## [4.6.1] - 2026-04-27

### Fixed

- Judge thread auto-resolution now grounds its addressed/not-addressed decision in the inter-round diff plus the current code at each thread region, preventing zero-diff force-pushes (rebases with identical trees) from auto-resolving open warnings (#624)
- Verdict layer now blocks `APPROVE` when a prior-round `warning` or `blocker` is still unresolved (no `agree` reply, thread not resolved on GitHub), surfacing the new `prior_unaddressed` reason. Multi-round priors are deduped by fingerprint with the latest round winning (#625)

## [4.6.0] - 2026-04-27

### Added

- Judge multi-round cross-round suppression: ratchet detector (won't re-raise findings the author has already addressed) and contradiction detector (demotes findings that contradict previously accepted guidance) (#561)
- Judge cross-round state infrastructure: fingerprints and author-reply parsing for round-to-round comparison (#555)
- Judge practical-reachability check: caps hypothetical findings at `nitpick` severity (#553)
- Judge verdict approval ceiling: when all remaining findings are dismissed suggestions, returns `APPROVE` (#562)
- Judge own-proposal caveat rule: demotes findings where the reviewer is flagging code it suggested itself (#566)
- Planner per-round summary for agent budget allocation (#565)
- Reviewer factual provenance note for prior-suggestion diff regions (#594)
- Open-thread references rendered as clickable GitHub links in judge prompt (#610)
- In-PR finding suppression: skips re-raising findings that match an already-resolved review thread or an author agree-reply (#584)
- Warning banner on PR when the GitHub App is not installed (#541)

### Changed (BREAKING)

- Renamed severity tiers from `required`/`suggestion`/`nit` to `blocker`/`warning`/`suggestion`/`nitpick` (#598). The `severity` field of every entry in the `findings_json` action output now uses the new values, and the `severity_counts` action output is now `{blocker, warning, suggestion, nitpick}`. Downstream workflow steps that switch on these values must be updated. Persisted handover and review markers from older versions are migrated automatically on read (`required` → `blocker`, `nit` → `nitpick`).
- Replaced `<sub>[high confidence]</sub>` text with a traffic-light dot prefix in review comment headers: 🔴 (high), 🟠 (medium), 🟡 (low) (#598).
- `determineVerdict` now only requests changes for `blocker` and `warning` findings; `suggestion` and `nitpick` findings produce `APPROVE` (#604, #612).

### Changed

- Default judge model updated to `claude-opus-4-7` (#606)

### Fixed

- Cancel in-progress review run when `@manki review` is re-requested (#542)
- Guard all-ignore prior rounds in judge prompt (#591)
- Restore review-in-progress tickbox for `@manki review` requests (#601)
- `contradictionMatch` now cites the most-recent agreeing round rather than the earliest (#618)

## [4.5.3] - 2026-04-10

### Fixed

- LLM-triggering commands (`review`, `explain`, generic questions, inline reply handling) now require `OWNER`, `MEMBER`, `COLLABORATOR`, or `CONTRIBUTOR` association — or be the PR author — preventing arbitrary users from consuming API quota on public repos (#530)
- PR-author bypass correctly guarded against absent payload fields with diagnostic logging (#530)

## [4.5.2] - 2026-04-07

### Changed

- Default judge model changed from Opus to Sonnet (~5x cost reduction per review)
- Team sizes 2, 4, and 6 now available — planner can pick more granular team sizes
- Planner prompt updated with guidance for 2-agent and 4-agent teams

## [4.5.1] - 2026-04-07

### Changed

- Renamed action from "Manki" to "Manki Review" for GitHub Marketplace uniqueness
- Updated action description to highlight the planner/agent/judge pipeline
- Changed marketplace branding color from orange to green

## [4.5.0] - 2026-04-07

### Added

- Smarter planner: picks specific agents from the pool with per-agent effort levels (#498)
- Language/framework auto-detection injected into reviewer prompts (#498)
- Planner prompt includes agent focus descriptions for better selection (#498)
- Retry failed reviewer agents with majority quorum — 1 retry, proceeds if `ceil(teamSize/2)` agents succeed (#499)
- Progress dashboard shows planner and judge runtime duration (#501)
- Telemetry: distinguish empty vs malformed reviewer responses, suspicious-fast warning (#502)
- Per-agent `failureReason` in Review Stats JSON (#509)
- Stale CLI process detection (90s no stdout) with streaming JSON mode (#512)
- CLI output sanitization against workflow-command injection (#512)

### Changed

- Planner effort bumped from `low` to `high` for more consistent decisions (#498)
- Planner defaults to 3 agents; scales to 5 for multi-subsystem or security-critical PRs (#498)
- CLI timeout increased from 300s to 20 minutes (#509, #518)
- CLI switched from `--output-format text` to `stream-json` with `--include-partial-messages` for progress monitoring (#512)
- Judge summary prompt includes anti-pattern guidance to avoid generic openers (#519)
- `MAX_AGENT_RETRIES` set to 1 (2 total attempts per agent) (#499)
- `SUSPICIOUS_FAST_THRESHOLD_MS` extracted as named constant (#513)

### Fixed

- Dashboard done count no longer decreases when failed agent transitions to retrying (#499)
- `partialNote` surfaced in review summary when agents fail after retries (#499)
- `typeof null` no longer produces misleading "got object" warning in `parseFindings` (#513)
- Docs footer attribution updated from `xdustinface` to `manki-review` (#503)
- `dist/` removed from git tracking — only committed by release workflow (#508)

### Chores

- Planner output sanitization: `language` and `context` fields stripped of injection patterns (#498)
- `buildAgentPool` helper extracted to deduplicate pool-building logic (#498)

## [4.4.0] - 2026-04-06

### Added

- Embed manki version in `manki-bot` comment marker for debugging (#468)
- `trivial` review level variant for `teamSize=1` reviews (#465)
- Landing page for GitHub Pages docs site (#478)

### Changed

- Redesign progress dashboard with stage grouping and unified icons (#476)
- Run dedup before judge to fix stale summary on follow-up reviews (#472)
- Migrate token service URL from `manki.dustinface.me` to `manki-api.dustinface.me` (#481)
- Move repo to `manki-review` GitHub organization, update all references (#484)

### Fixed

- Progress dashboard stage grouping, icon consistency, and flicker on updates (#469)
- Stale `review-in-progress` comments via Actions API verification (#466)

### Docs

- Add permission comments to workflow examples in SETUP.md (#480)
- Restructure README for scannability (#456)

## [4.3.0] - 2026-04-05

> **Rename note**: references to `@manki-labs` and `manki-labs[bot]` in the 4.0.0–4.2.0 entries below refer to the old command prefix and bot login, which were removed/renamed in 4.3.0. The current prefix is `@manki` and the bot login is `manki-review[bot]`.

### Added

- Pre-review planner stage with content-aware team and effort selection (#412)
- `teamSize=1` with `Trivial Change Verifier` agent for trivial PRs (#438)
- New config keys `planner.enabled` (default `true`) and `models.planner` (default `claude-haiku-4-5`) (#412)

### Changed

- **Breaking (soft)**: `@manki-labs` command prefix removed — use `@manki` (#403)
- **Breaking (soft)**: bot login renamed `manki-labs[bot]` → `manki-review[bot]` and centralized as `BOT_LOGIN` (#394)
- Planner output simplified to team-size + effort-level only (#418)
- Auto-approve now requires all findings resolved before approving (#406)
- Judge always runs; review fails on agent or judge errors (#430)
- Judge summaries more opinionated with examples and anti-patterns (#428)
- Skip redundant review after recent approval (#421, #425)
- Follow-up review recap uses delta since last review (#410, #382)
- Static dedup only matches resolved findings, not open or replied (#379)
- Recap simplified to judge-only natural summary, finding-counting machinery removed (#415)
- Reorder `models` config keys by pipeline order — planner, reviewer, judge, dedup (#450)

### Fixed

- Prevent premature auto-approve and stale progress comment blocking (#390)
- Fail fast when no API key is configured (#429)
- Show full description in collapsed duplicate findings (#397)
- Handle confidence tag in finding title regex and improve dedup details (#376)

### Docs

- Overhaul SETUP.md with quick start and GitHub App installation (#400)
- Replace README quick start with link to SETUP.md (#404)
- Align README, SETUP, and example config with v4.3.0 state (#446)
- Introduce `AGENTS.md` with repo conventions (#452)

### Chores

- Raise patch coverage target from 80% to 90% (#387)
- Ignore `.claude/` and `coverage/` directories (#435)

## [4.2.0] - 2026-03-31

### Added

- Live per-agent progress updates in review comment — shows real-time agent completion with timing and finding counts (#357)
- LLM-based deduplication for dismissed findings using Haiku — catches semantically similar findings that static matching misses (#364)
- Collapsed `<details>` section in review report showing deduplicated findings with matched titles (#372)
- Configurable `dedup` model in `.manki.yml` via `models.dedup` (defaults to `claude-haiku-4-5`) (#364)

### Fixed

- Fuzzy word-overlap matching in recap dedup to catch rephrased findings (#361)
- Prevent parallel review runs by checking for in-progress reviews before starting new ones (#371)
- Skip self-triggered workflow events from `manki-labs[bot]` to reduce runner waste (#371)

### Changed

- Consolidate `titlesRelated` in judge.ts with shared `titlesOverlap` from recap.ts (#364)
- Refactor `buildDashboard` to single linear rendering path — 52 → 36 lines (#369)
- Simplify `completeDashboard` construction using spread from accumulated dashboard object (#369)

### Chores

- Guard `majorityThreshold` for `agentCount < 2`, harden bot review filter, add language annotation to suggested fix code blocks, narrow `recapSummary` scope, conditional `confidenceDistribution`, encapsulate `octokitCache`, export and test `scopeDiffToFile`, realistic test data in `determineVerdict` tests (#366)

## [4.1.0] - 2026-03-31

### Added

- Per-agent, judge, and file metrics in `ReviewStats` JSON (`agentMetrics`, `judgeMetrics`, `fileMetrics`, split `reviewerModel`/`judgeModel`) (#348)
- PR diff context included in conversational replies to review comments (#346)
- Confidence-weighted verdict threshold and anti-leniency calibration in judge prompt (#343)

### Fixed

- Remove top-level `model` action input that silently overrode `.manki.yml` config (#354)
- Lower `HIGH_CONF_SUGGESTION_THRESHOLD` to 1 — single high-confidence suggestion triggers REQUEST_CHANGES (#351)
- Use `comment.id` in concurrency group to prevent review comment cancellation (#345)
- Skip duplicate approval in `checkAndAutoApprove` (#340)
- Route `/manki` commands from review comment replies (#337)

### Docs

- Update SETUP.md action references from v3 to v4 (#336)

## [4.0.0] - 2026-03-30

### Added

- Live-updating dashboard progress comment with text status lines
- AI-generated review summaries from judge agent
- Review event body with collapsed stats JSON for future analysis
- Progress comment as frozen audit log with review metadata (config, judge decisions, timing)
- Auto-detect GitHub App installation and use app token (`manki-labs[bot]` identity)
- `/manki` and `@manki-labs` command prefixes alongside `@manki`
- Token service authentication with GitHub Actions OIDC (no secrets needed)
- Judge validates PR scope — flags unrelated file changes
- Judge consensus weighting — multi-reviewer findings get more weight
- Judge acceptance criteria enforcement — unmet criteria flagged as required
- Judge impact x likelihood severity matrix (inspired by SonarQube)
- Dynamic consensus thresholds relative to team size
- Support for edited comments (`/manki` added via edit)
- Triage-created issues with proper prefixes and structured format
- Post-judge dedup pass for duplicate findings
- Logo added to repo and README

### Changed

- `resolvedToken` made explicit — `createAuthenticatedOctokit` returns token alongside Octokit, `getMemoryToken` is now a pure function
- Action always exits 0 — event filtering moved inside, SIGTERM handled gracefully
- Concurrency group includes event name to prevent cross-event cancellation
- Nit issues redesigned with collapsible `<details>` and GitHub permalink embeds
- Inline comments use structured AI context JSON instead of duplicated "Fix prompt"
- All command responses restyled with `**Manki** —` branding
- Silent auto-approve (no visible message body)
- Default `models.reviewer` to Sonnet, `models.judge` to Opus
- `max_diff_lines` bumped from 10k to 50k
- Universal bot filter using `sender.type === 'Bot'`
- Removed `DEFAULT_REVIEWERS` — `AGENT_POOL` is single source of truth
- Team size label shows actual agent count
- README overhauled with logo, updated features, simplified config

### Fixed

- Code fences in nit issues render at column 0 for GitHub compat
- Triage parser matches new `<details>` nit issue format
- Serialize concurrent `ensureCLI` calls with shared install promise
- Remove blockquote from review summary, separate recap text
- `isReviewRequest` and `hasBotMention` support all command prefixes
- Bot self-triggering prevention for `pull_request_review` events
- Stale commit SHA guard for auto-approve
- Judge `required` severity bar loosened and calibrated with project memory
- Codecov checks made informational, then enforced at 95%
- Bot skip log message now shows review author login when `reviewAuthorType` triggers the skip

### Tests

- Test coverage for missing `sender.type` field on webhook payloads
- Test coverage for POST method assertion on OIDC token exchange

## [3.1.0] - 2026-03-25

### Added

- Extended thinking for judge agent
- Full file content as reviewer context
- PR context (title, description, base branch) in prompts
- Memory context (learnings, suppressions) for reviewers
- Resolve `@rules/` references in `CLAUDE.md`
- Pre-filter suppressions before judge
- Code coverage with Codecov
- Severity examples in prompts
- Auto-resolve stale threads after force-push
- Check suppressions in recap dedup
- Linked issue context in prompts
- `@manki forget` command
- Subdirectory `CLAUDE.md` files
- Multi-pass review verification

### Changed

- Default reviewer to Sonnet, judge to Opus
- Renamed nit issues to "triage: findings from PR #N"

### Fixed

- Judge merges duplicate findings
- Prevent duplicate findings via resolved thread dedup

## [3.0.0] - 2026-03-25

### Added

- Dynamic review teams (3/5/7 agents scaled by diff size)
- Judge agent with prompt, parser, and context curation
- 4-tier severity system (required/suggestion/nit/ignore)
- Per-stage model selection (`models.reviewer` / `models.judge`)
- `nit_handling` config (issues vs comments)
- Triage acceptance pattern tracking and auto-escalation
- AGPL-3.0 license

### Changed

- README rewrite and SETUP.md update

### Fixed

- `COMMENT` fallback drops inline comments
- Graceful fallback without `github_token`

## [2.4.0] - 2026-03-24

### Added

- `@manki triage` command for nit issue processing
- Richer nit issues with code snippets and fix prompts

### Fixed

- Renamed `need-human` to `needs-human` label

## [2.3.0] - 2026-03-24

### Added

- `@manki check` command and auto-approve on thread resolution

## [2.2.0] - 2026-03-24

### Added

- Collapsible suggested fixes and AI agent prompts in comments

## [2.1.0] - 2026-03-24

### Changed

- Stripped backwards compatibility, rewrote README with Manki personality

### Fixed

- Consolidation fallback, JSON extraction, and warning annotations

## [2.0.0] - 2026-03-24

### Added

- Rebranded from claude-review to Manki
- `@manki remember` command to teach the reviewer

## [1.2.0] - 2026-03-24

### Added

- Emoji reactions to acknowledge triggers

### Fixed

- Cancel in-progress review runs on PR update

## [1.1.0] - 2026-03-24

### Added

- Memory write path (patterns, suppressions, learnings)
- GitHub App identity support
- Review recap phase (dedup, track resolved)
- Conversation lifecycle (auto-approve, reply handling)
- Nit issues with `needs-human` label
- SETUP.md installation guide

### Fixed

- Auto-resolve addressed findings with validation
- Consolidation failure returns `COMMENT` not `APPROVE`

## [1.0.0] - 2026-03-24

### Added

- Initial release: multi-agent Claude Code PR review
- Specialist reviewer agents
- Basic review posting with inline comments
- Configuration via `.manki.yml`

[Unreleased]: https://github.com/manki-review/manki/compare/v5.3.0...HEAD
[5.3.0]: https://github.com/manki-review/manki/compare/v5.2.0...v5.3.0
[5.2.0]: https://github.com/manki-review/manki/compare/v5.1.1...v5.2.0
[5.1.1]: https://github.com/manki-review/manki/compare/v5.1.0...v5.1.1
[5.1.0]: https://github.com/manki-review/manki/compare/v5.0.1...v5.1.0
[5.0.1]: https://github.com/manki-review/manki/compare/v5.0.0...v5.0.1
[5.0.0]: https://github.com/manki-review/manki/compare/v4.7.0...v5.0.0
[4.7.0]: https://github.com/manki-review/manki/compare/v4.6.1...v4.7.0
[4.6.1]: https://github.com/manki-review/manki/compare/v4.6.0...v4.6.1
[4.6.0]: https://github.com/manki-review/manki/compare/v4.5.3...v4.6.0
[4.5.3]: https://github.com/manki-review/manki/compare/v4.5.2...v4.5.3
[4.5.2]: https://github.com/manki-review/manki/compare/v4.5.1...v4.5.2
[4.5.1]: https://github.com/manki-review/manki/compare/v4.5.0...v4.5.1
[4.5.0]: https://github.com/manki-review/manki/compare/v4.4.0...v4.5.0
[4.4.0]: https://github.com/manki-review/manki/compare/v4.3.0...v4.4.0
[4.3.0]: https://github.com/manki-review/manki/compare/v4.2.0...v4.3.0
[4.2.0]: https://github.com/manki-review/manki/compare/v4.1.0...v4.2.0
[4.1.0]: https://github.com/manki-review/manki/compare/v4.0.0...v4.1.0
[4.0.0]: https://github.com/manki-review/manki/compare/v3.1.0...v4.0.0
[3.1.0]: https://github.com/manki-review/manki/compare/v3.0.0...v3.1.0
[3.0.0]: https://github.com/manki-review/manki/compare/v2.4.0...v3.0.0
[2.4.0]: https://github.com/manki-review/manki/compare/v2.3.0...v2.4.0
[2.3.0]: https://github.com/manki-review/manki/compare/v2.2.0...v2.3.0
[2.2.0]: https://github.com/manki-review/manki/compare/v2.1.0...v2.2.0
[2.1.0]: https://github.com/manki-review/manki/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/manki-review/manki/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/manki-review/manki/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/manki-review/manki/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/manki-review/manki/releases/tag/v1.0.0
