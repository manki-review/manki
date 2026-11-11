# Judge rule finding fixture corpus

Each `*.json` file holds one round: the instruction files as the judge gets them (`repoContext`), the PR diff, and findings that each quote a rule of those files. `rules` is the `review.rules` setting of the round, `warn` when left out. `excludedPaths` names the changed files `exclude_paths` leaves out of the diff. `expected` names, per finding title, the rule verdicts and grades a correct judge may end with. The repositories and code are made up for the fixtures.

`judge.test.ts` checks that each finding points at a line of its diff, that its named instruction file holds its quote, and that every finding has an expectation. A live replay, gated on `RUN_JUDGE_LIVE_FIXTURES=1`, sends each fixture through `runJudgeAgent` against a real model and compares each finding's `rule.verdict` and grade with `expected`. A finding the judge drops counts as `ignore`. CI does not run it. Run it after changing the judge prompt or model.

## Coverage

| File | `review.rules` | Findings |
|------|----------------|----------|
| `01_migration_without_rollback.json` | `block` | A Go service adds a migration without the down file its `CONTRIBUTING.md` requires (confirmed, a blocker). A second finding quotes a "Prefer" sentence (no requirement). |
| `02_flag_docs_and_unseen_file.json` | `warn` | A Rust command-line tool adds a flag without the entry in `docs/cli.md` its `AGENTS.md` requires (confirmed, a warning). A second finding says a file outside the diff lacks an entry, with no search (not shown). A third quotes a sentence that describes the tests (no requirement). |
| `03_companion_in_a_file_not_shown.json` | `block` | A Java service adds an endpoint. Its `CONTRIBUTING.md` requires an entry in an OpenAPI file that the PR changes, but that `exclude_paths` keeps from the judge (not confirmed, so no blocker). A second finding says the endpoint has no test, and no changed file can hold one (confirmed, a blocker). |
