# Judge note order fixture corpus

Each `*.json` file holds the findings of one round and the PR diff they sit in. At least three of the findings end as notes of clearly different worth, and one is a warning. `formatting` names the pure formatting point, which the judge should rank last. The code is made up for the fixture.

The judge is shown the diff of a file only when a finding sits on it or cites it in a proving line (`evidence.proof`) or at the start of an evidence line (`evidence.checks`). A finding whose claim rests on another file of the diff, such as a missing test, cites that file in one of the two, as a finder would. Without it the judge cannot check the claim, and it sometimes drops the note.

`judge.test.ts` checks that each finding points at a line of its diff, and that every file of the diff is one the judge is shown. A live replay, gated on `RUN_JUDGE_LIVE_FIXTURES=1`, sends each fixture through `runJudgeAgent` against a real model. It passes when `noteOrder` names every note exactly once, names nothing else, and puts the formatting point last. CI does not run it. Run it after changing the judge prompt or model.

## Coverage

| File | Findings |
|------|----------|
| `01_mixed_worth.json` | A new Python retry helper: a sleep after the last failed attempt (warning), a docstring that misstates the result, an error branch without a test, and a missing space after a comma. |
