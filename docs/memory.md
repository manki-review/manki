# Review memory

The memory system makes reviews smarter over time by tracking learnings and suppressions.

## Turn it on

Add to your `.manki.yml`:

```yaml
memory:
  enabled: true
```

For a public repo, Manki then keeps the memory in the central memory repository, `manki-review/review-memory`, in the folder `<owner>/<repo>/`. No secret is needed, and Manki never holds a token for that repository. The token service reads and writes it for the run it started, through its `/memory/read`, `/memory/write` and `/memory/append` endpoints. Each request carries the run's OIDC token, which is GitHub's signed proof of which workflow run is asking, and the token service also checks that it started that run for the PR. It takes the folder from that proof and never from the request, so a run can write only its own repo's folder. The central repository holds only public repos' memory, and only the token service writes it. A private repo needs a memory repo of its own, see [Private repos](#private-repos). Manki never writes its own secrets there: it redacts their values from every file it writes and every commit message, as it does for any memory repo.

When two runs change the same file at once, the later write is refused. Manki then reads the file again and applies its change to the new version. After three refused attempts it gives up with a warning, and the review goes on.

## Private repos

A private repo never uses the central memory repository. It keeps its memory only in a memory repo of its own, set with `memory.repo` and the `memory_repo_token` input (see [Use your own memory repository](#use-your-own-memory-repository)). On every run, Manki asks the API, with that token, whether the memory repo is private and has the same owner as the reviewed repo. If either check fails, memory is skipped. Manki takes the reviewed repo's visibility from the event, and asks the API when the event does not say. A failed lookup counts as private.

## When memory is skipped

Memory is skipped for a run, and the review goes on without it, when:

- a private repo has no `memory.repo`;
- `memory.repo` is set but `memory_repo_token` is not;
- for a private repo, the memory repo is not private, has another owner, or the token cannot read it;
- the token service refuses the run's memory requests.

The review body then says **Memory skipped:** with the reason and the fix, the round record keeps the reason in `memory.skipReason`, and the run log has a warning.

## Use your own memory repository

To keep memory in a repository of your own, set `memory.repo` and pass a token that writes it in the `memory_repo_token` input (see [Review memory token](#review-memory-token)). Manki then reads and writes that repository directly, with the repo's files in a folder named after the repo. For a private repo, the memory repo must be private and have the same owner. Without the token, Manki skips memory for the run and says so in the review. It does not fall back to the central repository. With [your own GitHub App](getting-started.md#your-own-github-app), Manki mints no memory token from it either: pass `memory_repo_token` the same way.

Create the memory repo and seed its folders:

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

Then point `.manki.yml` at it:

```yaml
memory:
  enabled: true
  repo: "<owner>/review-memory"
```

## How memory works

- **Learnings**: Stored when you use `/manki remember`, or when a reply from someone with write access gets Manki to withdraw a finding. That learning holds for the finding's file, and a security finding never leaves one. Injected as context into future reviewer prompts. With the `global:` prefix, `/manki remember` stores nothing. Global learnings apply to every repo, so the owner of the memory repository edits `_global/` by hand.
- **Suppressions**: Created by `/manki dismiss <finding title>`, only when the text matches the title of a finding Manki posted on that PR. After the judge grades the findings, a finding whose title contains a suppression pattern is filtered out. A blocker, a security finding at any severity, a tool alert and a blocker the judge posts as a warning for lack of proof are never suppressed, so a short pattern cannot hide an injection warning. Neither is a finding a tool check graded anew, or one a tool check ran on that was or could be a blocker. A tool check that leaves a warning at its grade does not undo a suppression. The judge's grade decides, not the reviewer's, so a reviewer cannot get a blocker suppressed by grading it a warning.
- **Global conventions**: `_global/conventions.md` and `_global/learnings.yml` apply to every repo of the memory repository. Runs only read them.
- **Fix rate**: On each merge, one JSON line per PR is appended to `metrics/fix-rate.jsonl` in the repo's folder with the posted, fixed, dismissed and untouched findings per severity and first reviewer (the `counts` field), and per severity, check status, tool evidence, category, effort, evidence and judge check (the `calibration` field, where `hadEvidence` says whether the finding cited evidence and `judgeChecked` whether the judge tried to refute it), plus the `class`, `group` and `configDigest` of the PR's last review round, so fix rates compare per class and group. A finding counts as fixed when the judge marked its thread addressed or the code at its lines changed before the merge. Whether the PR author's own resolve of a blocker counted is decided with `author_clear_role` at the base branch commit GitHub recorded for the PR, which is from before the merge. A PR that changes the setting is therefore counted under the old value. Turn it off with `metrics.fix_rate: false`. To read the totals, run `npm run fix-rate-report -- <path to fix-rate.jsonl> [more paths]` in a manki checkout, which prints one markdown table per dimension.

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

A GitHub token cannot be limited to one folder, so this token writes every repo's folder in the memory repo. Any workflow that holds it can change the memory of every repo there, for example add a suppression that hides findings in another repo. Share one memory repo only between repos you trust alike. Per-round state lives on the PR, in each review's [round record](how-reviews-work.md#round-records), not in the memory repo.
