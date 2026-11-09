# Judge grading fixture corpus

Each `*.json` file holds one reviewer finding, which claims a `blocker` in all but `own-proposal-objection`, the PR diff it sits in, and the grades the judge may return (`allowed`). Every fixture without `blocker` in `allowed` breaks exactly one rule of the blocker definition. The others cover cases a rule could wrongly clear.

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
| `18_public_api_reachable.json` | `blocker` | A library's fee estimate leaves a v3 payload's payouts out, so the fee is too low and relays reject the transaction. The builder only creates v2 payloads itself, but its public `set_payload` accepts any version, and a path through a public API counts as reached. |
