# Review memory

The memory system makes reviews smarter over time by tracking learnings and suppressions.

## Create the Memory Repository

```bash
gh repo create <owner>/review-memory --public --description "Review memory for Manki"
```

## Seed Initial Structure

```bash
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

## Enable in Config

Add to your `.manki.yml`:

```yaml
memory:
  enabled: true
  repo: "<owner>/review-memory"
```

With the manki-review App, Manki writes memory with the App's memory token, so no secret is needed. Without the App, set the `REVIEW_MEMORY_TOKEN` secret (see [Review memory token](#review-memory-token)). A `memory_repo_token` that is set always wins over the App's token, so leave it unset when you use the App.

## How memory works

- **Learnings** -- Stored when you use `/manki remember` or when substantive review comment discussions are detected. Injected as context into future reviewer prompts.
- **Suppressions** -- Created by `/manki dismiss`. After the judge grades the findings, a finding whose title contains a suppression pattern is filtered out. A blocker, a security finding at any severity and a tool alert are never suppressed, so a short pattern cannot hide an injection warning. The judge's grade decides, not the reviewer's, so a reviewer cannot get a blocker suppressed by grading it a warning.
- **Patterns** -- Automatically tracked from recurring findings. After 5 occurrences a pattern is escalated for visibility.
- **Global conventions** -- A `_global/conventions.md` file applied to all repos using the memory system.
- **Fix rate** -- On each merge, one JSON line per PR is appended to `<repo-name>/metrics/fix-rate.jsonl` with the posted, fixed, dismissed and untouched findings per severity and first reviewer (the `counts` field), and per severity, judge confidence, tool evidence, category, effort, evidence and judge check (the `calibration` field, where `hadEvidence` says whether the finding cited evidence and `judgeChecked` whether the judge tried to refute it), plus the `class`, `group` and `configDigest` of the PR's last review round, so fix rates compare per class and group. A finding counts as fixed when the judge marked its thread addressed or the code at its lines changed before the merge. Turn it off with `metrics.fix_rate: false`. To read the totals, run `npm run fix-rate-report -- <path to fix-rate.jsonl> [more paths]` in a manki checkout, which prints one markdown table per dimension.


## Review memory token

Required only if you enable the review memory system and the manki-review App can't write the memory repo. The App writes only a repo named `review-memory` in the same account as the reviewed repo, and only when it is installed there. Any other memory repo, a custom name or another account, needs this token, unless [your own GitHub App](getting-started.md#your-own-github-app) is installed on it. Without either, Manki skips memory and logs a warning. This is a fine-grained PAT scoped to the memory repo only.

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
2. Configure:
   - **Token name**: `manki-memory`
   - **Expiration**: 1 year (or your preference)
   - **Repository access**: "Only select repositories" > select your memory repo (e.g., `<owner>/review-memory`)
   - **Permissions**: Repository permissions > **Contents** > Read and write
3. Generate and copy the token
4. Add as a repository secret:
   ```bash
   gh secret set REVIEW_MEMORY_TOKEN --repo <owner>/<repo>
   ```

The token's write surface is limited to cross-PR memory files (`learnings.yml`, `suppressions.yml`, `metrics/fix-rate.jsonl`). Per-round state lives on the PR, in each review's [round record](how-reviews-work.md#round-records), not in the memory repo. Existing `handover.json` files in older memory repos are orphaned but harmless and require no migration.
