# Judge grading fixture corpus

Each `*.json` file holds one reviewer finding, which claims a `blocker` in all but `own-proposal-objection` and `refuted-by-shown-guard`, the PR diff it sits in, and the grades the judge may return (`allowed`). Every fixture without `blocker` in `allowed` breaks exactly one rule of the blocker definition. The others cover cases a rule could wrongly clear.

`judge.test.ts` checks that the corpus covers every case once and that each finding points at a line of its diff. A live replay, gated on `RUN_JUDGE_LIVE_FIXTURES=1`, sends each fixture through `runJudgeAgent` against a real model and checks the grade is allowed. CI does not run it. Run it after changing the judge prompt or model.

## Coverage

| File | Allowed | Case |
|------|---------|------|
| `01_passes_all_tests.json` | `blocker` | An off-by-one in new pagination code drops the last page of every listing. |
| `02_fails_pr_causes_it.json` | not `blocker` | The flagged division by zero sits in a context line the PR neither changed nor affects. |
| `03_fails_failure_named.json` | not `blocker` | A vague race condition claim on a pure function, with no path to a failure. |
| `04_fails_damage_serious.json` | not `blocker` | A retry log drops the error cause. The result is still correct. |
| `05_fails_code_proves_it.json` | not `blocker` | The crash depends on how `load_config` behaves, which the diff does not show. |
| `06_fails_author_would_fix.json` | not `blocker` | The missing retry is covered by a TODO with a tracking issue. |
| `07_never_tests.json` | not `blocker` | A new error branch has no test. |
| `08_never_style.json` | not `blocker` | A variable name could be clearer. |
| `09_never_could_not_verify.json` | not `blocker` | The reviewer could not confirm that CI runs the migration. |
| `10_grade_stable.json` | `warning` | A prior round graded the finding `warning`, and the code has not changed since. |
| `11_severe_on_internal_value.json` | `blocker` | An internally computed index writes past a buffer in `unsafe` code. A missing guard on an internal value is not the finding. The write past the buffer is. |
| `12_removed_guard.json` | `blocker` | The PR deletes an ownership check. The defect sits in removed lines. |
| `13_security_with_todo.json` | `blocker` | A shell injection from a branch name, covered by a TODO with a tracking issue. A TODO never clears a security defect. |
| `14_own_proposal_objection.json` | `ignore` | The finding objects to a timeout floor that an earlier round asked for. Manki does not object to a change it asked for. |
| `15_own_proposal_worse.json` | `warning` or `blocker` | Applying an earlier round's fix dropped a default, so a request without `limit` returns nothing. The new code is worse, so the finding stays. |
| `16_library_resource_exhaustion.json` | `blocker` | A library's `Vec` decode drops the cap on the bytes read, so a length prefix sizes the allocation. Any caller of the public API can pass the stream, so no caller in the repository is needed, and a doc comment calling it intended does not lower a removed guard. |
| `17_unconfirmed_build_claim.json` | not `blocker` | The finding claims a missing trait import fails to compile, and no CI result reports it. Reading code is not compiling it, so it is posted as a warning at most. |
| `18_public_api_reachable.json` | `blocker` | A TypeScript library's `parseDuration`, which its entry point exports, gains a `d` unit that returns seconds instead of milliseconds. The package's own callers never pass days, but any caller of the exported function can, and a path through a public API counts as reached. |
| `19_declared_gap.json` | `blocker` | A new Python `transfer` commits the debit before a credit that raises for a frozen account, so the money is lost. The PR description lists it as a known limitation, which keeps the grade the lost funds earn. |
| `20_added_code_not_pre_existing.json` | `blocker` | A new Go `Invalidate` clears one of two price maps, so category listings keep the old price. The reviewer calls it pre-existing because the second map was never pruned, but the gap is in lines the PR adds. |
| `21_rare_claim_reachable.json` | `blocker` | A new Python `Session.refresh()` races `close()` and leaks a socket. The window looks like a rare timing case, but the docstring tells users to call `refresh()` from a background thread, so normal use produces it. |
| `22_sibling_path_incomplete_fix.json` | `blocker` | The PR adds a write check to `POST /items` and leaves `PUT /items/:id` open. The reviewer calls the open route pre-existing because its lines are unchanged, but it is the defect the PR fixes, left in a sibling path. |
| `23_refuted_by_shown_guard.json` | not `blocker` | A reviewer files as a `warning` that a Go stream's `Shutdown` and `run` can both close one channel, which would panic. Both go through a `sync.Once` the diff shows, so the judge has no ground to raise the finding to a blocker. |
