# Judge note order fixture corpus

Each `*.json` file holds the findings of one round and the PR diff they sit in. At least three of the findings are filed as notes of clearly different worth, and one is a warning. `formatting` names the pure formatting point, which the judge should rank last. `noteOrWarning` names a note whose description argues a consequence for callers, such as a docstring that promises a result the code never returns. The judge may grade such a note a warning, and every other note must end as a note. `revertGap` names a note on a changed line whose removal no test would catch, which the review must post. `testMethod` names a note that only says how a test is built, which the review must leave out: the judge may drop it or keep it as a note without a revert gap. The code is made up for the fixture.

The judge is shown the diff of a file only when a finding sits on it or cites it in a proving line (`evidence.proof`) or at the start of an evidence line (`evidence.checks`). A finding whose claim rests on another file of the diff, such as a missing test, cites that file in one of the two, as a finder would. Without it the judge cannot check the claim, and it sometimes drops the note.

`judge.test.ts` checks that each finding points at a line of its diff, and that every file of the diff is one the judge is shown. A live replay, gated on `RUN_JUDGE_LIVE_FIXTURES=1` and signed in with `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, sends each fixture through `runJudgeAgent` against a real model. It passes when every note outside `noteOrWarning` ends as a note, each one in `noteOrWarning` ends as a note or a warning, `noteOrder` names every note exactly once and nothing else, the formatting point comes last, and `capNotes` posts the `revertGap` note and leaves out the `testMethod` note. CI does not run it. Run it after changing the judge prompt or model.

## Coverage

| File | Findings |
|------|----------|
| `01_mixed_worth.json` | A new Python retry helper: a sleep after the last failed attempt (warning), a docstring that misstates the result, an error branch without a test, and a missing space after a comma. |
| `02_test_method.json` | A new Go rate limiter: a map that never forgets a key (warning), a test that sets private state but fails when the change it covers is reverted, a clamp that no test covers, and a missing space before a brace. |
