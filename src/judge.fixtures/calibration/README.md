# Labelled findings for blocker calibration

Each `*.jsonl` file holds findings Manki posted on one repository, one JSON object per line, each labelled `real` or `false` from what happened to it. `npm run calibration -- <history.jsonl> --export <file>` writes this format, see "Changing the blocker rubric" in [`CONTRIBUTING.md`](../../../CONTRIBUTING.md).

| Field | Meaning |
|-------|---------|
| `id` | `<owner/repo>#<pr>:<file>:<slug>`, unique in the set |
| `repo`, `pr`, `commitSha` | The pull request and the commit of the round that raised the finding |
| `file`, `lineStart`, `lineEnd` | Where the finding points, at `commitSha` |
| `severity` | The grade the judge gave |
| `title`, `comment` | The finding as posted, without hidden markers |
| `judgeNotes`, `judgeConfidence` | The judge's reasoning and confidence, when the round recorded them |
| `label` | `real` or `false` |
| `labelSource` | Why: `reply-fixed` or `reply-withdrawn` (Manki's reply), `author-fixed` or `author-declined` (a person's reply), `judge-addressed` (a later judge marked the thread addressed), or `line-changed` (the flagged lines changed before merge) |
| `threadUrl` | The review thread |

A finding a person turned down counts as `false`, since it did not hold the PR up. GitHub does not say why a person resolved a thread without a reply, so such findings are left out as unclear.

## Sets

| File | Repository | Findings | Taken |
|------|------------|---------:|-------|
| `rust-dashcore.jsonl` | `xdustinface/rust-dashcore`, the fork that ran Manki before the pilot | 60: 22 false, 9 real blockers, 29 other real | 2026-11-07 |
