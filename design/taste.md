# Design taste

What the owner picks in design rounds, and why the rest lose. Read it before every round of variations. Rejections are constraints. Patterns under "Needs a reason" stay off unless the problem calls for them and the rationale says why.

Manki's surface is GitHub itself: review bodies, inline comments and the progress comment. Every design must render in GitHub-flavored Markdown, in light and dark.

## What wins

- Clear separation per finding. Each finding is its own unit, never a paragraph that runs into the next.
- Scannable by default: a list of titles, with the detail one click away in a fold.
- Real code next to the finding, through a GitHub permalink, so the body stays short and the code has line numbers.

## What loses

- One emoji with two meanings. ⚠️ is the Warning severity, so no section may reuse it.

## Needs a reason

Shown and not picked. Use only when the problem calls for it.

- An index table of findings.
- Every finding always open, under its own heading and rule.
- Findings grouped by file under one shared snippet.
- Task-list checkboxes in Manki's own review body. A tick edits the body and is lost when Manki rewrites it.

## Round log

- 2026-11-07, `design-variations/review-findings`: picked variation 1 (one fold per finding, "What this does" under the verdict, a rule before the lists) with variation 5's permalink as the code preview inside each fold. Section symbols: 🔧 in this PR, 🔶 previously missed, 📝 nitpicks. Why: the owner wanted per-finding separation and code previews, folds keep the body scannable, and permalinks show real code without bloat. ⚠️ for previously missed lost because it clashes with the Warning severity. No reason was given for the other variations.
- 2026-11-08, `design-variations/finding-checks`: picked 1b (variation 1's checks fold with a GitHub code preview per check), changed so that checks close together in one file share one preview of up to 8 lines under a short list of their sentences, the finding's own line comes first as "On the commented line: ..." with no preview, each preview starts one line above the cited line, and the sentence above it quotes the key part of a long line. Its labels were adapted per severity: "What goes wrong:" for blockers and warnings, "Why:" for suggestions and nitpicks, and "Fix:" only before a prose fix. Why: the owner wanted each check readable right on GitHub, with code previews in the fold. No reason was given for the other variations.
