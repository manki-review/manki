/**
 * Writes the `.manki.yml` reference into `docs/configuration.md`, between the `config-reference` markers. Defaults come
 * from `DEFAULT_CONFIG`, and the descriptions from `SETTINGS` below.
 *
 * Usage:
 *   npm run config-reference
 */

import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';

import { DEFAULT_CONFIG } from '../src/config';

export interface Setting {
  /** The setting's path, such as `models.judge`. `[]` stands for any list item and `<name>` for any map key. */
  key: string;
  type: string;
  description: string;
  /** Overrides the default read from `DEFAULT_CONFIG`, for one that depends on other settings. */
  default?: string;
}

export const REFERENCE_PATH = path.join(__dirname, '..', 'docs', 'configuration.md');
const START = '<!-- config-reference:start -->';
const END = '<!-- config-reference:end -->';

const REVIEWS = 'how-reviews-work.md';

export const SETTINGS: Setting[] = [
  { key: 'auto_review', type: 'boolean', description: 'Review a PR automatically when it opens and on every push. With `false`, Manki reviews only on request, such as `/manki review`.' },
  { key: 'auto_approve', type: 'boolean', description: 'Approve the PR without a new review once every blocking thread is resolved by someone allowed to clear it and no warning thread holds the approval, or once a draft with a clean review is marked ready. When off, only a review round approves.' },
  { key: 'author_clear_role', type: '`admin`, `maintain` or `write`', description: 'The lowest repository role with which a PR author may clear a blocker, a security finding or a warning a check lowered from a blocker on their own PR, by resolving the thread or with `/manki dismiss`. An author below it clears nothing, and someone else with write access can always clear. With `write`, everyone who can push may clear the blockers on their own PRs, so a blocker no longer holds their PR. A role outside the three, a custom role and a role GitHub does not confirm never count. It is also the lowest role with which anyone, the PR author included, lifts the hold of a warning by resolving its thread. Read from the base branch, so a PR cannot lower it for itself. See [Severity tiers](' + REVIEWS + '#severity-tiers).' },
  { key: 'exclude_paths', type: 'list of globs', description: 'Files the reviewers never read. Your list replaces the defaults, so repeat a default you want to keep, and `[]` excludes nothing. Manki never approves a PR that changes such a file: a person must approve it. A `Cargo.lock`, `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` is the exception: the reviewers read it as a package list. The defaults name the known package lockfiles that end in `.lock`, so any other `.lock` file, such as `.github/workflows/actions.lock` or `flake.lock`, is read as text. Some analyzers still check them, see [Running Manki\'s analyzers](' + REVIEWS + '#running-mankis-analyzers).' },
  { key: 'closed_paths', type: 'list of globs', description: 'Paths no review stage reads, such as a hidden test set. A closed file is left out of the diff, for the analyzers too, and deleted from the checkout the reviewer tools read before any stage runs, so no tool finds it. A pattern that names a folder closes every file in it, and a file renamed from a closed path counts as closed, at its new path too. A path is matched however it is written, such as `./a` or `a//b`, and one that leaves the repository, such as `../a`, counts as closed. A pattern with no slash, such as `secret.txt`, closes that name at any depth. A pattern with a slash anywhere, such as `/README.md`, `./README.md` or `bench/holdout/**`, matches from the repository root only. A leading `./` or `/` and doubled slashes change nothing else, and `dir/` closes the folder `dir` at the root. A pattern that names no path, such as an empty one, one with `..` or one with a backslash (write `/`), makes the config invalid, and on the base branch ends a review before any code is read, since Manki cannot tell what it closes. A call of Manki\'s own tools on a closed path is answered that the repository\'s config closes it, and the round record counts those calls as `usage.closedCalls`. Unlike `exclude_paths`, which only keeps a file out of the diff, a closed file cannot be read with the tools either. Manki never approves a PR that changes a closed file: a person must approve it. Read from the base branch. A base config that does not load still closes these paths. One that cannot be read on a second try, or does not parse while it names `closed_paths`, ends a review before any code is read, and a reply or a question gets the reason instead of an answer. See [Security model](security.md).' },
  { key: 'skip_labels', type: 'list of strings', description: 'PRs with any of these labels get no automatic review. Compared case-insensitively, and read from the base branch. See [Skipping PRs](' + REVIEWS + '#skipping-prs).' },
  { key: 'skip_authors', type: 'list of strings', description: 'PRs by any of these authors, such as `dependabot[bot]`, get no automatic review. Compared case-insensitively, and read from the base branch.' },
  { key: 'skip_branches', type: 'list of globs', description: 'PRs whose head branch in the repo itself matches, such as `dependabot/**`, get no automatic review. Never matches a fork\'s branch. Read from the base branch.' },
  { key: 'drafts', type: '`skip` or `review`', description: '`skip` reviews a draft only on request, or after each push once Review every push is ticked on it. `review` reviews it automatically. A draft review never approves and does not count toward `max_auto_rounds`.' },
  { key: 'auto_review_max_lines', type: 'positive integer', description: 'Reviewable lines, after `exclude_paths`, above which a PR gets no automatic review, only a request to split it, with the review box in its settings block. Read from the base branch.' },
  { key: 'max_diff_lines', type: 'positive integer', description: 'Reviewable lines above which Manki never reviews a PR, even when forced. Read from the base branch.' },
  { key: 'models', type: 'map', description: 'The model of each stage. The finders are not here: `review.groups` says who reviews. A model id picks its provider: `claude-*` is Anthropic, `gpt-*` and the o-series are OpenAI, `gemini-*` is Gemini. `provider/model` names one explicitly.' },
  { key: 'models.planner', type: 'model id', description: 'The planner, a fast pass that triages the change before the review.' },
  { key: 'models.judge', type: 'model id', description: 'The judge, which filters the findings and sets their severity, the verdict reader and the refuter.' },
  { key: 'models.second_refuter', type: 'model id', default: 'off', description: 'A second refuter on another model that checks every finding the first refuter checks, at the same time. The first runs on `models.judge`. A split keeps the judge\'s grade and shows both reasons. Its model also gives the second answer of the origin check, which asks whether the PR caused a blocker or warning. A blocker, a security finding, a finding that would block and any finding on a line the PR added or changed becomes pre-existing only when both models find the same failure at the base. Without it, or with both on one model, such an answer leaves the finding as it is, and a blocker only notes that it may be older than the PR. It needs repository tools, so the Claude or Codex CLI. See [Severity tiers](' + REVIEWS + '#severity-tiers).' },
  { key: 'models.dedup', type: 'model id', description: 'The dedup pass against resolved findings from earlier rounds, and the small side calls: same-defect checks, related work, the match of findings to the open issues that track them, and name translation.' },
  { key: 'models.fallback', type: 'model id', default: 'the first model of the `full` group other than the stage\'s own', description: 'Reruns a stage once when a provider\'s safety filter refuses it, or when the stage\'s own model reaches a limit: a rate limit, a used-up quota or subscription limit, or a model at capacity. Without it, or for a stage already on this model, the stage moves to the first model of the `full` group that is another model than its own. When `full` has no other model, the stage is not rerun. After a limit, a finder never moves to a model that already reads for the round. A call made with repository tools never moves to a model without them.' },
  { key: 'judge', type: 'map', description: 'The judge stage.' },
  { key: 'judge.effort', type: '`low`, `medium`, `high`, `xhigh`, `max` or `auto`', default: '`auto`', description: 'The judge\'s effort, which the refuter follows. `auto` takes the level the planner picks for the change, low, medium or high, and high when the planner gives no answer. A fixed level replaces that pick on every round. Read from the base branch.' },
  { key: 'judge.tool_steps', type: 'integer from 0 to 100', description: 'Read-only repository tool calls the judge may make while it grades, on a judge that runs on the Claude or Codex CLI. With them the judge reads the code a finding rests on itself, at the cost of a longer judge call. A round whose judge fallback model has no tools runs the judge without them. `0` gives it none.' },
  { key: 'review', type: 'map', default: 'the built-in groups', description: 'Review groups and how PR classes route to them. Read from the base branch, so a PR cannot weaken its own review. See [Review groups](' + REVIEWS + '#review-groups).' },
  { key: 'review.groups', type: 'map of groups', default: '`trivial`, `solo` and `full`', description: 'Each group is a list of one or more reviewers. An entry is a model id, or a map with `model`, `effort` and `focus`. A config that sets `groups` defines all three of `trivial`, `solo` and `full`, and may add groups under other names. `full` must hold at least two finders on two distinct models, whatever routes to it, or the config does not load. The readers of `trivial` run the quick check of a trivial change. The sibling comparisons, related repo checks, claim checks, pattern checks, fix checks and sweeps run on the first reviewer of the group that reads the PR.' },
  { key: 'review.groups.<name>[].model', type: 'model id', default: 'required', description: 'A model id or `provider/model`.' },
  { key: 'review.groups.<name>[].effort', type: '`low`, `medium`, `high`, `xhigh`, `max` or `auto`', default: '`auto`, and `medium` in `trivial`', description: '`auto` is high when the planner answers `subtle: true`, otherwise medium. A Deeper review runs an `auto` finder at xhigh, and never below the effort the finder has without it. An entry of `trivial` without an effort runs the quick check at medium.' },
  { key: 'review.groups.<name>[].focus', type: 'string', default: 'none', description: 'A line added to this finder\'s prompt. The quick check takes none, so `focus` in an entry of `trivial` gets the unknown key warning.' },
  { key: 'review.classes', type: 'map of classes', default: 'the built-in classes', description: 'Classes of your own, each with a unique `rank` and a `match` on `paths_any`, `triage` or both. On `security`, `supply_chain` and `data_contract`, `match.paths_any` adds paths to the built-in rule.' },
  { key: 'review.routing', type: 'map of class to group', default: 'the built-in routes', description: 'The group per class. A built-in class left out keeps its built-in group, and a class of your own with no route goes to `full`. A config that routes a floor class to a group below the floor does not load: Manki reviews with the defaults and holds the approval.' },
  { key: 'review.critical_paths', type: 'list of globs', default: 'none', description: 'Critical areas, where any wrong result is severe even in a rare internal edge case. Globs or the path aliases. The judge grades a wrong result there as severe damage. See [Review groups](' + REVIEWS + '#review-groups).' },
  { key: 'review.outside_input', type: 'string', default: 'none', description: 'What counts as outside input in your repository. The judge treats a failure this input can trigger as reachable.' },
  { key: 'review.examples', type: 'map with `blocker` and `not_blocker` lists', default: 'none', description: 'Worked examples from your repository, which the judge reads next to its built-in examples.' },
  { key: 'review.sweep', type: '`off`, `blockers`, `warnings` or `notes`', default: '`off`', description: 'After the judge keeps a finding, search the whole diff for other instances of its defect class, at most three findings a round. The value names the lowest grade that starts a search: `blockers`, `warnings` for blockers and proven warnings, or `notes` for those and every note that is not about style. Each place found is graded on its own, through dedup and the judge like any finding. See [Sweeping for a defect class](' + REVIEWS + '#sweeping-for-a-defect-class).' },
  { key: 'review.notes', type: 'non-negative integer', default: '`3`', description: 'How many notes a review posts at most. A note is a finding below a warning: an optional improvement, never a defect, which the review posts as a suggestion. A suggestion whose line is in the PR\'s diff gets an inline thread that never blocks, unless an earlier round reviewed that code. The review body lists the others in one collapsed section, and the round record keeps the ones left out. `0` posts none. A security finding is never a note. See [Severity tiers](' + REVIEWS + '#severity-tiers).' },
  { key: 'review.rules', type: '`auto`, `warn` or `block`', default: '`auto`', description: 'How a broken required rule of your instruction files is graded, such as "every migration needs a rollback" in `CONTRIBUTING.md`. It counts when the rule is quoted from an instruction file of the base branch and the judge confirms that it states a requirement and that the PR breaks it. `auto` grades it by the damage it can do, like any other finding: a broken style rule is a note, and one that can crash or corrupt data is still a warning or a blocker. `warn` makes it at least a warning. `block` makes it a blocker, so the PR is not approved until the rule is followed. In doubt it is a warning. See [Rules from instruction files](' + REVIEWS + '#rules-from-instruction-files).' },
  { key: 'review.scope_blocks', type: 'boolean', default: '`false`', description: 'Whether the scope reader\'s answer holds the approval. Every round that reads more than a trivial change asks whether the PR is useful and whether it mixes topics that belong in separate PRs. With `false` a doubt or a proposed split is only listed in the review body, under Scope. With `true` each is posted as a warning, which holds the approval until its thread is resolved like any warning. A doubt is posted only once the refuter confirms it from the code, which needs repository tools. It is never a blocker. See [The scope of a PR](' + REVIEWS + '#the-scope-of-a-pr).' },
  { key: 'static_analysis', type: 'map', description: 'Which CI results the reviewers read as evidence, and Manki\'s own analyzers. Read from the base branch. See [Reading CI results](' + REVIEWS + '#reading-ci-results).' },
  { key: 'static_analysis.checks', type: 'boolean', description: 'Read check-run annotations. Needs `checks: read` in the workflow.' },
  { key: 'static_analysis.code_scanning', type: 'boolean', description: 'Read open code scanning alerts. Needs `security-events: read` in the workflow.' },
  { key: 'static_analysis.dependency_review', type: 'boolean', description: 'Read the vulnerable packages the PR adds, from the dependency review.' },
  { key: 'static_analysis.wait_for_checks', type: 'list of check run names', description: 'Check runs to wait for before reading the results, when CI runs in a separate workflow. Manki waits up to 300 seconds, then reads what is there.' },
  { key: 'static_analysis.analyzers', type: '`all` or a map', default: 'per analyzer, below', description: 'Analyzers Manki runs itself. `all` turns on every one that needs no rules from you. See [Running Manki\'s analyzers](' + REVIEWS + '#running-mankis-analyzers).' },
  { key: 'static_analysis.analyzers.ast_grep', type: 'boolean', default: '`false`, but the Rust rules run in a Cargo repository', description: 'Manki\'s ast-grep rules on the changed JavaScript, TypeScript and Python files. `false` also stops the Rust rules.' },
  { key: 'static_analysis.analyzers.secrets', type: 'boolean', default: '`false`', description: 'gitleaks on the lines the PR adds.' },
  { key: 'static_analysis.analyzers.dependencies', type: 'boolean', default: '`false`', description: 'OSV-Scanner on the changed lockfiles.' },
  { key: 'static_analysis.analyzers.semgrep', type: '`false` or `{ rules: [...] }`', default: '`false`', description: 'Your Semgrep rule files from the repository, run with Opengrep.' },
  { key: 'static_analysis.analyzers.actionlint', type: 'boolean', default: '`true`', description: 'actionlint on the changed workflows, unless CI runs it already.' },
  { key: 'static_analysis.analyzers.zizmor', type: 'boolean', default: '`true`', description: 'zizmor on the changed workflows, unless CI runs it already.' },
  { key: 'static_analysis.analyzers.shellcheck', type: 'boolean', default: '`true`', description: 'ShellCheck on the changed shell scripts, unless CI runs it already.' },
  { key: 'related_repos', type: 'list of up to 10 repos', description: 'Public repositories the review may read as context. Read from the base branch. See [Related repositories](' + REVIEWS + '#related-repositories).' },
  { key: 'related_repos[].repo', type: '`owner/name`', default: 'required', description: 'A public repository on github.com.' },
  { key: 'related_repos[].kind', type: '`reference`, `consumer` or `dependency`', default: 'required', description: '`reference` for a repository this one implements, `consumer` for one that depends on it, `dependency` for one it depends on.' },
  { key: 'related_repos[].ref', type: 'branch, tag or full commit hash', default: 'the default branch', description: 'What to read. A `dependency` without one is read at the commit the lockfiles of the PR lock for it, when they lock exactly one. Write a name that looks like a short commit hash as `refs/heads/<name>` or `refs/tags/<name>`.' },
  { key: 'related_repos[].paths', type: 'list of up to 20 paths or globs', default: 'the whole repository', description: 'The only paths fetched, along with a root `AGENTS.md` and `CLAUDE.md`.' },
  { key: 'instructions', type: 'string', default: 'none', description: 'Extra context for the finders. They also read the root `AGENTS.md`, `CLAUDE.md` and `.claude/CLAUDE.md`, the first `CONTRIBUTING.md` found in `.github/`, the root or `docs/`, the nearest `AGENTS.md` and `CLAUDE.md` above each changed file, and the `.md` files these link to.' },
  { key: 'project', type: 'string', default: 'none', description: 'A short phrase naming what the project is, such as `blockchain consensus library`. The finders read it as "This PR is in a blockchain consensus library project". Without it they go by the repository description and the `AGENTS.md` and `CLAUDE.md` files.' },
  { key: 'max_auto_rounds', type: 'non-negative integer', description: 'Automatic rounds since Manki last approved. After the last one, automatic review pauses until a review is started by hand, with `/manki review` or a settings box, and the notice asks the author to reconsider the approach. Such a review also turns automatic review back on for 3 rounds, or for the rounds the cap still allows if that is more. `0` turns the cap off. See [Severity tiers](' + REVIEWS + '#severity-tiers).' },
  { key: 'memory', type: 'map', description: 'Review memory. See [Review memory](memory.md).' },
  { key: 'memory.enabled', type: 'boolean', description: 'Read learnings and suppressions, and write new ones. Without `memory.repo`, a public repo\'s memory lives in the central memory repository, which holds only public repos\' memory and which the token service reads and writes for the run. A private repo needs `memory.repo`. With memory on, a merge also counts per severity and finder how many posted findings were fixed, dismissed or left untouched, in the job summary and in the memory.' },
  { key: 'memory.repo', type: '`owner/name`', default: 'none', description: 'Your own memory repository instead of the central one, such as `<owner>/review-memory`. Needs the `memory_repo_token` input, or memory is skipped with a warning. For a private repo, it must be private and have the same owner.' },
];

/** Returns the value at `key` in `DEFAULT_CONFIG`, or `undefined` when it has none there. */
function defaultValue(key: string): unknown {
  let value: unknown = DEFAULT_CONFIG;
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !(part in value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function formatDefault(setting: Setting): string {
  if (setting.default !== undefined) return setting.default;
  const value = defaultValue(setting.key);
  if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) return 'none';
  if (typeof value === 'object' && !Array.isArray(value)) return 'see below';
  if (typeof value === 'string') return `\`${value}\``;
  return `\`${JSON.stringify(value).replace(/,/g, ', ')}\``;
}

function row(setting: Setting): string {
  const cells = [`\`${setting.key}\``, setting.type, formatDefault(setting), setting.description];
  return `| ${cells.map(c => c.replace(/\|/g, '\\|')).join(' | ')} |`;
}

/** Returns the generated reference, with its markers. */
export function renderReference(): string {
  return [
    START,
    '<!-- Generated by `npm run config-reference` from `scripts/config-reference.ts`. Do not edit by hand. -->',
    '',
    '| Setting | Type | Default | What it does |',
    '|---------|------|---------|--------------|',
    ...SETTINGS.map(row),
    END,
  ].join('\n');
}

/** Returns `page` with the text between the markers replaced by `renderReference()`. */
export function withReference(page: string): string {
  const start = page.indexOf(START);
  const end = page.indexOf(END);
  if (start === -1 || end < start) throw new Error(`${REFERENCE_PATH} has no ${START} ... ${END} block`);
  return page.slice(0, start) + renderReference() + page.slice(end + END.length);
}

if (require.main === module) {
  writeFileSync(REFERENCE_PATH, withReference(readFileSync(REFERENCE_PATH, 'utf-8')));
}
