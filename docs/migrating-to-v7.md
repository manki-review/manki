# Migrating from v6 to v7

1. Pin the action to `manki-review/manki@v7`.
2. Make `.github/workflows/manki.yml` the dispatched workflow from [Step 3](getting-started.md#step-3-add-the-workflow). It runs only on `workflow_dispatch`, with no job `if` and no `concurrency` block. Delete every other workflow that runs Manki, such as an event-driven one or a `manki-dispatch.yml`. Manki fails a run that the Manki service did not start.
3. Install the [Manki App](https://github.com/apps/manki-review) and approve its Actions and Checks permissions. The service only serves the accounts it lists, so ask the Manki maintainers to add yours.
4. Remove `concurrency_lock_ttl_seconds` from the workflow and from `.manki.yml`. The service orders the runs of each PR, so the lock is gone.
5. Check the changed defaults:

| What changed | To get the v6 behaviour |
|--------------|-------------------------|
| Drafts get no automatic review | Set `drafts: review` on the base branch |
| A PR over 8,000 reviewable lines gets no automatic review, and one over 15,000 is never reviewed | Raise `auto_review_max_lines` and `max_diff_lines` on the base branch. v6 reviewed up to 50,000 lines |
| Only blockers block. Warnings, security warnings included, are listed under the warnings in the review body | No setting |
| Provider CLIs get only the environment variables they need | No setting. Pass a provider's settings through its documented variables |
| Codex reviewers have no shell, image reader or web search | No setting |
| `stats` is ignored, and the round record is always hidden | No setting |

See [Configuration](configuration.md) for every setting, and the [CHANGELOG](../CHANGELOG.md) for everything else that changed.
