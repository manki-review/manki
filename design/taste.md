# Design taste

What the owner picks in design rounds, and why the rest lose. Read it before every round of variations. Rejections are constraints. Patterns under "Needs a reason" stay off unless the problem calls for them and the rationale says why.

Manki's surface is GitHub itself: review bodies, inline comments and the progress comment. Every design must render in GitHub-flavored Markdown, in light and dark.

## What wins

- Clear separation per finding. Each finding is its own unit, never a paragraph that runs into the next.
- Scannable by default: a list of titles, with the detail one click away in a fold.
- Real code next to the finding, through a GitHub permalink, so the body stays short and the code has line numbers.

- On the homepage: real Manki comments as GitHub renders them, never review cards drawn in a style of our own. A full page with bold colour fields, not a bare one. Green as the main colour.

## What loses

- One emoji with two meanings. ⚠️ is the Warning severity, so no section may reuse it.

- On the homepage: art concepts (oversized mascot parts, magazine layouts, flying letters, 3D glass), and generic dark product templates with flat cards.
- On the homepage: a page stripped down to one idea. The owner called it "a bit too minimalistic".

## Needs a reason

Shown and not picked. Use only when the problem calls for it.

- An index table of findings.
- Every finding always open, under its own heading and rule.
- Findings grouped by file under one shared snippet.
- Task-list checkboxes in Manki's own review body. A tick edits the body and is lost when Manki rewrites it. A box is fine where Manki never rewrites the text after posting it, such as a finding's own "Create an issue for this" box.

## Round log

- 2026-11-07, `design-variations/review-findings`: picked variation 1 (one fold per finding, "What this does" under the verdict, a rule before the lists) with variation 5's permalink as the code preview inside each fold. Section symbols: 🔧 in this PR, 🔶 previously missed, 📝 nitpicks. Why: the owner wanted per-finding separation and code previews, folds keep the body scannable, and permalinks show real code without bloat. ⚠️ for previously missed lost because it clashes with the Warning severity. No reason was given for the other variations.
- 2026-11-08, `design-variations/finding-checks`: picked 1b (variation 1's checks fold with a GitHub code preview per check), changed so that checks close together in one file share one preview of up to 8 lines under a short list of their sentences, the finding's own line comes first as "On the commented line: ..." with no preview, each preview starts one line above the cited line, and the sentence above it quotes the key part of a long line. Its labels were adapted per severity: "What goes wrong:" for blockers and warnings, "Why:" for suggestions and nitpicks, and "Fix:" only before a prose fix. Why: the owner wanted each check readable right on GitHub, with code previews in the fold. No reason was given for the other variations.
- 2026-11-09, `design-variations/review-body`: picked v3 with v1's named thread list; owner first said v1 ("v1 is perfect"). The body groups findings by origin with exact counts ("Found this round", "Findings" on a first round, "Missed by an earlier review", "Pre-existing", "Not read by any model"), labels the summary "What blocks:" or "Summary:", ends in an "About this review" fold, and names and links every thread under the verdict. Why: the owner first took v1, then chose the recommended mix of v3's grouping by origin with v1's named thread list. No reason was given for the other variations.
- 2026-11-09, `design-variations/combined-fold`: picked variation 2, "Fix first". The open comment says only what goes wrong. One fold, summarised as "How to fix it, why, and 8 places read · double-checked", holds the fix, then why it matters, then the checks with their previews, and the refuter's outcome closes it. Each part has a bold label on its own line. The fold replaces the separate "Details", "Suggested fix" and "How this was checked" folds, inline and in the review body. A short code fix GitHub can commit stays open as a suggestion. Why: the owner asked to combine the details and the checks into one fold with clearly separated parts. No reason was given for the other variations.
- 2026-11-12, `design-variations/homepage-5` and `homepage-6`: for the homepage, picked round 5's variation 5 ("Calico": bold colour fields, the mascot at full size, real review comments set on the fields) in round 6's "Forest" colouring, deep green fields with white type, with the headline "Curious, thorough, always learning." Asked for with the pick: the finders stop says the readers are yours to choose, no "What sets it apart" section, the config example matches `.manki.yml.example`, and the install example uses the Claude subscription token. Why: "lets work with 5", then "the green i like". Four earlier rounds lost. Round 1, generic dark pages: "i dont like the variations". Round 2, art concepts: "i actually hate every single one of them". Round 3 got no verdict. Round 4, minimal pages with review cards drawn by hand: "please use realistic looking review example comments so people see on the website how manki review actually looks in practice" and "a bit too minimalistic".
