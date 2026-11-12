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
  /** Still loads, with a warning, but has no effect or is replaced by another setting. */
  deprecated?: true;
}

export const REFERENCE_PATH = path.join(__dirname, '..', 'docs', 'configuration.md');
const START = '<!-- config-reference:start -->';
const END = '<!-- config-reference:end -->';

const REVIEWS = 'how-reviews-work.md';

export const SETTINGS: Setting[] = [
  { key: 'auto_review', type: 'boolean', description: 'Review a PR automatically when it opens and on every push. With `false`, Manki reviews only on request, such as `@manki review`.' },
  { key: 'auto_approve', type: 'boolean', description: 'Approve the PR without a new review once every blocking thread is resolved by someone allowed to clear it.' },
  { key: 'author_clear_role', type: '`admin`, `maintain` or `write`', description: 'The lowest repository role with which a PR author may clear a blocker or a security finding on their own PR, by resolving the thread or with `@manki dismiss`. An author below it clears nothing, and someone else with write access can always clear. With `write`, everyone who can push may clear the blockers on their own PRs, so a blocker no longer holds their PR. A role outside the three, a custom role and a role GitHub does not confirm never count. Read from the base branch, so a PR cannot lower it for itself. See [Severity tiers](' + REVIEWS + '#severity-tiers).' },
  { key: 'exclude_paths', type: 'list of globs', description: 'Files the reviewers never read. Your list replaces the defaults, so repeat a default you want to keep, and `[]` excludes nothing. Manki never approves a PR that changes such a file: a person must approve it. A `Cargo.lock`, `package-lock.json`, `yarn.lock` or `pnpm-lock.yaml` is the exception: the reviewers read it as a package list. The defaults name the known package lockfiles that end in `.lock`, so any other `.lock` file, such as `.github/workflows/actions.lock` or `flake.lock`, is read as text. Some analyzers still check them, see [Running Manki\'s analyzers](' + REVIEWS + '#running-mankis-analyzers).' },
  { key: 'skip_labels', type: 'list of strings', description: 'PRs with any of these labels get no automatic review. Compared case-insensitively, and read from the base branch. See [Skipping PRs](' + REVIEWS + '#skipping-prs).' },
  { key: 'skip_authors', type: 'list of strings', description: 'PRs by any of these authors, such as `dependabot[bot]`, get no automatic review. Compared case-insensitively, and read from the base branch.' },
  { key: 'skip_branches', type: 'list of globs', description: 'PRs whose head branch in the repo itself matches, such as `dependabot/**`, get no automatic review. Never matches a fork\'s branch. Read from the base branch.' },
  { key: 'drafts', type: '`skip` or `review`', description: '`skip` reviews a draft only on request, `review` reviews it automatically. A draft review never approves and does not count toward `convergence.max_auto_rounds`.' },
  { key: 'auto_review_max_lines', type: 'positive integer', description: 'Reviewable lines, after `exclude_paths`, above which a PR gets no automatic review, only a request to split it, with Review again in its settings block. Read from the base branch.' },
  { key: 'max_diff_lines', type: 'positive integer', description: 'Reviewable lines above which Manki never reviews a PR, even when forced. Read from the base branch.' },
  { key: 'slice_lines', type: 'integer, at least 200', description: 'Changed lines a finder or the verdict reader reads in one call. A larger diff is read in slices of about this size, and of at most 200,000 characters, four at a time. Read from the base branch.' },
  { key: 'models', type: 'map', description: 'The model of each stage. A model id picks its provider: `claude-*` is Anthropic, `gpt-*` and the o-series are OpenAI, `gemini-*` is Gemini. `provider/model` names one explicitly.' },
  { key: 'models.planner', type: 'model id', description: 'The planner, a fast pass that triages the change before the review.' },
  { key: 'models.reviewer', type: 'model id', description: 'The finder of the built-in review groups, and `@reviewer` in a group of your own.' },
  { key: 'models.reviewer_pair', type: 'model id', default: 'the other Claude tier of `models.reviewer`', description: 'The second finder of the built-in `pair` group, and `@reviewer_pair` in a group of your own.' },
  { key: 'models.judge', type: 'model id', description: 'The judge, which filters the findings and sets their severity, the verdict reader and the refuter.' },
  { key: 'models.refuter_pair', type: 'model id', default: 'off', description: 'A second refuter on another model that checks every finding the first refuter checks, at the same time. The first runs on `models.judge`. A split keeps the judge\'s grade and shows both reasons. Two disproofs lower a blocker only when the judge alone raised it above every finder\'s grade. It needs repository tools, so the Claude or Codex CLI. See [Severity tiers](' + REVIEWS + '#severity-tiers).' },
  { key: 'models.dedup', type: 'model id', description: 'The dedup pass against resolved findings from earlier rounds, and the small side calls: same-defect checks, related work and name translation.' },
  { key: 'models.fallback', type: 'model id', default: '`models.reviewer`', description: 'Reruns a stage once when a provider\'s safety filter refuses it. A stage already on this model moves to its other Claude tier.' },
  { key: 'planner', type: 'map', description: 'The planner stage.' },
  { key: 'planner.enabled', type: 'boolean', description: 'Run the planner. Without it, every round takes the side that adds review: two finders at high effort.' },
  { key: 'planner.paired', type: '`auto`, `always` or `never`', deprecated: true, description: 'Pins the planner\'s `paired` answer. Route classes with `review.routing` instead.' },
  { key: 'judge', type: 'map', description: 'The judge stage.' },
  { key: 'judge.effort', type: '`low`, `medium`, `high`, `xhigh`, `max` or `auto`', default: '`auto`', description: 'The judge\'s effort, which the refuter follows. `auto` takes the level the planner picks for the change, low, medium or high, and high without a planner. A fixed level replaces that pick on every round. Read from the base branch.' },
  { key: 'judge.tool_steps', type: 'integer from 0 to 100', description: 'Read-only repository tool calls the judge may make while it grades, on a judge that runs on the Claude or Codex CLI. With them the judge reads the code a finding rests on itself, at the cost of a longer judge call. A round whose judge fallback model has no tools runs the judge without them. `0` gives it none.' },
  { key: 'review', type: 'map', default: 'the built-in groups', description: 'Review groups and how PR classes route to them. Read from the base branch, so a PR cannot weaken its own review. See [Review groups](' + REVIEWS + '#review-groups).' },
  { key: 'review.groups', type: 'map of groups', default: '`trivial`, `solo` and `pair`', description: 'Each group lists its `reviewers`, one or more. A group with a built-in name replaces it.' },
  { key: 'review.groups.<name>.reviewers[].model', type: 'model id', default: '`@reviewer`', description: 'A model id, `provider/model`, or `@reviewer` or `@reviewer_pair`, which resolve through `models`.' },
  { key: 'review.groups.<name>.reviewers[].effort', type: '`low`, `medium`, `high`, `xhigh`, `max` or `auto`', default: '`auto`', description: '`auto` is high when the planner answers `subtle: true`, otherwise medium. A Deeper review runs an `auto` finder at xhigh, and never below the effort the finder has without it.' },
  { key: 'review.groups.<name>.reviewers[].focus', type: 'string', default: 'none', description: 'A line added to this finder\'s prompt.' },
  { key: 'review.groups.<name>.reviewers[].role', type: '`finder` or `verifier`', default: '`finder`', description: '`verifier` is the quick check of a trivial change.' },
  { key: 'review.classes', type: 'map of classes', default: 'the built-in classes', description: 'Classes of your own, each with a unique `rank` and a `match` on `paths_any`, `triage` or both. On `security`, `supply_chain` and `data_contract`, `match.paths_any` adds paths to the built-in rule.' },
  { key: 'review.routing', type: 'map of class to group', default: 'the built-in routes', description: 'The group per class. A class left out keeps its built-in group.' },
  { key: 'review.default_group', type: 'group name', default: '`pair`', description: 'The group for a class with no route.' },
  { key: 'review.allow_weaker', type: 'list of class names', default: 'none', description: 'Floor classes allowed to route to a group below the floor. Without it, a config with such a route does not load: Manki reviews with the defaults and holds the approval.' },
  { key: 'review.critical_paths', type: 'list of globs', default: 'none', description: 'Critical areas, where any wrong result is severe even in a rare internal edge case. Globs or the path aliases. The judge grades a wrong result there as severe damage. See [Review groups](' + REVIEWS + '#review-groups).' },
  { key: 'review.outside_input', type: 'string', default: 'none', description: 'What counts as outside input in your repository. The judge treats a failure this input can trigger as reachable.' },
  { key: 'review.examples', type: 'map with `blocker` and `not_blocker` lists', default: 'none', description: 'Worked examples from your repository, which the judge reads next to its built-in examples.' },
  { key: 'review.sweep', type: 'boolean', default: '`false`', description: 'After the judge keeps a blocker, search the whole diff for other instances of its defect class, at most three blockers a round. Their findings go through dedup and the judge like any finding. See [Sweeping for a defect class](' + REVIEWS + '#sweeping-for-a-defect-class).' },
  { key: 'review.notes', type: 'non-negative integer', default: '`3`', description: 'How many notes a review lists at most. A note is a finding below a warning: an optional improvement, never a defect. A note gets no thread. The review body lists the notes in one collapsed section, and the round record keeps the ones left out. `0` lists none. A security finding is never a note. See [Severity tiers](' + REVIEWS + '#severity-tiers).' },
  { key: 'review.rules', type: '`warn` or `block`', default: '`warn`', description: 'How a broken required rule of your instruction files is graded, such as "every migration needs a rollback" in `CONTRIBUTING.md`. It counts when the rule is quoted from an instruction file of the base branch and the judge confirms that it states a requirement and that the PR breaks it. `warn` makes it at least a warning. `block` makes it a blocker, so the PR is not approved until the rule is followed. In doubt it is a warning. See [Rules from instruction files](' + REVIEWS + '#rules-from-instruction-files).' },
  { key: 'static_analysis', type: 'map', description: 'Which CI results the reviewers read as evidence, and Manki\'s own analyzers. Read from the base branch. See [Reading CI results](' + REVIEWS + '#reading-ci-results).' },
  { key: 'static_analysis.checks', type: 'boolean', description: 'Read check-run annotations. Needs `checks: read` in the workflow.' },
  { key: 'static_analysis.code_scanning', type: 'boolean', description: 'Read open code scanning alerts. Needs `security-events: read` in the workflow.' },
  { key: 'static_analysis.dependency_review', type: 'boolean', description: 'Read the vulnerable packages the PR adds, from the dependency review.' },
  { key: 'static_analysis.wait_for_checks', type: 'list of check run names', description: 'Check runs to wait for before reading the results, when CI runs in a separate workflow.' },
  { key: 'static_analysis.wait_timeout_seconds', type: 'integer from 1 to 3600', description: 'How long to wait for `wait_for_checks` before reading what is there.' },
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
  { key: 'related_repos[].ref', type: 'branch, tag or full commit hash', default: 'the default branch', description: 'What to read. For a `dependency`, the version this repository pins. Write a name that looks like a short commit hash as `refs/heads/<name>` or `refs/tags/<name>`.' },
  { key: 'related_repos[].paths', type: 'list of up to 20 paths or globs', default: 'the whole repository', description: 'The only paths fetched, along with a root `AGENTS.md` and `CLAUDE.md`.' },
  { key: 'review_passes', type: 'integer from 1 to 5', description: 'Runs each finder this many times with the files in shuffled order, and keeps only the findings the passes agree on.' },
  { key: 'instructions', type: 'string', default: 'none', description: 'Extra context for the finders. They also read the root `AGENTS.md`, `CLAUDE.md`, `.claude/CLAUDE.md` and `CONTRIBUTING.md`, the nearest `AGENTS.md` and `CLAUDE.md` above each changed file, and the `.md` files these link to.' },
  { key: 'project', type: 'string', default: 'none', description: 'A short phrase naming what the project is, such as `blockchain consensus library`. The finders read it as "This PR is in a blockchain consensus library project". Without it they go by the repository description and the `AGENTS.md` and `CLAUDE.md` files.' },
  { key: 'reviewers', type: 'list', default: 'none', description: 'Extra checks, each added as a focus line to the finder prompt.' },
  { key: 'reviewers[].name', type: 'string', default: 'required', description: 'The check\'s name.' },
  { key: 'reviewers[].focus', type: 'string', default: 'required', description: 'What the finders check for.' },
  { key: 'convergence', type: 'map', description: 'How rounds end. See [Severity tiers](' + REVIEWS + '#severity-tiers).' },
  { key: 'convergence.max_auto_rounds', type: 'non-negative integer', description: 'Automatic rounds since Manki last approved. After the last one, automatic review pauses until a review is started by hand, and the notice asks the author to reconsider the approach. `0` turns the cap off.' },
  { key: 'convergence.rounds_after_restart', type: 'non-negative integer', description: 'Automatic rounds that a review started by hand, with `@manki review` or a settings box, turns back on while automatic review is paused. A restart never leaves fewer rounds than the cap still allows. When they pass without an approval, automatic review pauses again until the next one. `0` grants none, so after a round-cap pause a restart reviews only the round asked for.' },
  { key: 'convergence.test_path_patterns', type: 'list of globs', description: 'Test files. From the second round, notes on them are dropped, except security findings and tool alerts.' },
  { key: 'convergence.suppress_resolved_threads', type: 'boolean', description: 'A finding whose thread a person resolved, or Manki resolved as addressed, suppresses matching findings in later rounds.' },
  { key: 'memory', type: 'map', description: 'Review memory. See [Review memory](memory.md).' },
  { key: 'memory.enabled', type: 'boolean', description: 'Read learnings and suppressions, and write new ones. Without `memory.repo`, a public repo\'s memory lives in the central memory repository, which holds only public repos\' memory and which the token service reads and writes for the run. A private repo needs `memory.repo`.' },
  { key: 'memory.repo', type: '`owner/name`', default: 'none', description: 'Your own memory repository instead of the central one, such as `<owner>/review-memory`. Needs the `memory_repo_token` input, or memory is skipped with a warning. For a private repo, it must be private and have the same owner.' },
  { key: 'metrics', type: 'map', default: 'none', description: 'Metrics Manki records.' },
  { key: 'metrics.fix_rate', type: 'boolean', default: 'the value of `memory.enabled`', description: 'On merge, count per severity and finder how many posted findings were fixed, dismissed or left untouched. Written to the job summary, and to the repo\'s memory when memory is on.' },
  { key: 'review_level', type: 'any', default: 'none', deprecated: true, description: 'Ignored. The planner sets how many finders read each PR.' },
  { key: 'review_thresholds', type: 'any', default: 'none', deprecated: true, description: 'Ignored. Line counts no longer size the review.' },
  { key: 'stats', type: 'any', default: 'none', deprecated: true, description: 'Ignored. The round record is always a hidden comment in the review.' },
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
  const header = ['| Setting | Type | Default | What it does |', '|---------|------|---------|--------------|'];
  return [
    START,
    '<!-- Generated by `npm run config-reference` from `scripts/config-reference.ts`. Do not edit by hand. -->',
    '',
    ...header,
    ...SETTINGS.filter(s => !s.deprecated).map(row),
    '',
    '### Deprecated settings',
    '',
    'These still load, with a warning.',
    '',
    ...header,
    ...SETTINGS.filter(s => s.deprecated).map(row),
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
