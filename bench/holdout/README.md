# Hold-out cases

Never read these files while tuning Manki. This applies to people and to agents alike: do not open, search, quote or summarize them while developing, debugging or reviewing a change to prompts, routing, models, tools or the judge. Develop against `bench/cases` only.

These cases are run once before a release, with `npm run bench -- $CHECKOUTS --holdout` (see `bench/README.md`), and their score decides whether the release goes out (see `RELEASE.md`). A case that someone tuned against no longer measures how Manki does on code it has not seen. If that happens, move the case to `bench/cases` and add a fresh one here.
