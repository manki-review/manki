# Review memory

The memory system makes reviews smarter over time by tracking learnings and suppressions.

## Turn it on

Add to your `.manki.yml`:

```yaml
memory:
  enabled: true
```

Manki then keeps the repo's memory in the central memory repository, `manki-review/review-memory`, in the folder `<owner>/<repo>/`. No secret is needed, and Manki never holds a token for that repository. The token service reads and writes it for the run it started, through its `/memory/read`, `/memory/write` and `/memory/append` endpoints. Each request carries the run's OIDC token, which is GitHub's signed proof of which workflow run is asking, and the token service also checks that it started that run for the PR. It takes the folder from that proof and never from the request, so a run can write only its own repo's folder. The central repository is private: only its owner and the token service can read the learnings and suppressions in it. Manki still redacts its own secret values before it writes, as it does for any memory repo.

When two runs change the same file at once, the later write is refused. Manki then reads the file again and applies its change to the new version. After three refused attempts it gives up with a warning, and the review goes on.

## Use your own memory repository

To keep memory in a repository of your own, set `memory.repo` and pass a token that writes it in the `memory_repo_token` input (see [Review memory token](#review-memory-token)). Manki then reads and writes that repository directly, with the repo's files in a folder named after the repo. Without the token, Manki skips memory for the run and logs a warning. It does not fall back to the central repository. With [your own GitHub App](getting-started.md#your-own-github-app), Manki mints no memory token from it either: pass `memory_repo_token` the same way.

```bash
gh repo create <owner>/review-memory --private --description "Review memory for Manki"
git clone https://github.com/<owner>/review-memory
cd review-memory

mkdir -p _global
mkdir -p <repo-name>

# Global conventions (applied to all repos)
cat > _global/conventions.md << 'EOF'
# Global Review Conventions

- Prefer explicit error handling over silent failures
- Flag any hardcoded credentials or API keys
- Security findings should always be blocking
EOF

# Empty files for repo-specific memory
echo "[]" > <repo-name>/suppressions.yml
echo "[]" > <repo-name>/learnings.yml

git add -A
git commit -m "chore: seed review memory"
git push
```

```yaml
memory:
  enabled: true
  repo: "<owner>/review-memory"
```

## How memory works

- **Learnings** -- Stored when you use `/manki remember` or when substantive review comment discussions are detected. Injected as context into future reviewer prompts. With the `global:` prefix, `/manki remember` stores nothing. Global learnings apply to every repo, so the owner of the memory repository edits `_global/` by hand.
- **Suppressions** -- Created by `/manki dismiss`. Non-blocking findings matching a suppression pattern are filtered out (blocking findings are never suppressed).
- **Global conventions** -- `_global/conventions.md` and `_global/learnings.yml` apply to every repo of the memory repository. Runs only read them.
- **Fix rate** -- On each merge, one JSON line per PR is appended to `metrics/fix-rate.jsonl` in the repo's folder with the posted, fixed, dismissed and untouched findings per severity and first reviewer (the `counts` field), and per severity, judge confidence, tool evidence, category, effort, evidence and judge check (the `calibration` field, where `hadEvidence` says whether the finding cited evidence and `judgeChecked` whether the judge tried to refute it), plus the `class`, `group` and `configDigest` of the PR's last review round, so fix rates compare per class and group. A finding counts as fixed when the judge marked its thread addressed or the code at its lines changed before the merge. Turn it off with `metrics.fix_rate: false`. To read the totals, run `npm run fix-rate-report -- <path to fix-rate.jsonl> [more paths]` in a manki checkout, which prints one markdown table per dimension.

## Review memory token

Needed only for your own memory repository in `memory.repo`. The central memory needs no token, and a `memory_repo_token` without `memory.repo` is unused. This is a fine-grained PAT scoped to the memory repo only.

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
2. Configure:
   - **Token name**: `manki-memory`
   - **Expiration**: 1 year (or your preference)
   - **Repository access**: "Only select repositories" > select your memory repo (e.g., `<owner>/review-memory`)
   - **Permissions**: Repository permissions > **Contents** > Read and write
3. Generate and copy the token
4. Add as a repository secret, and pass it to the action as `memory_repo_token: ${{ secrets.REVIEW_MEMORY_TOKEN }}`:
   ```bash
   gh secret set REVIEW_MEMORY_TOKEN --repo <owner>/<repo>
   ```

A GitHub token cannot be limited to one folder, so this token writes every repo's folder in the memory repo. Any workflow that holds it can change the memory of every repo there, for example add a suppression that hides findings in another repo. Share one memory repo only between repos you trust alike. Per-round state lives on the PR, in each review's [round record](how-reviews-work.md#round-records), not in the memory repo. Existing `handover.json` files in older memory repos are orphaned but harmless and require no migration.
