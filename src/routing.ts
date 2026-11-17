import { createHash } from 'crypto';
import { minimatch } from 'minimatch';

import { countChangedLines } from './diff';
import { parseModelSpec } from './providers';
import { DiffFile, GroupReviewer, ParsedDiff, ReviewClass, ReviewClassMatch, ReviewGroup, ReviewRoutingConfig, TeamRouting, Triage } from './types';

// Path segment prefixes that indicate security-sensitive files. The rule is path-based, not
// prompt-based, so prompt injection in the PR content cannot switch it off.
const SECURITY_SENSITIVE_PREFIXES: readonly string[] = Object.freeze([
  'auth', 'oauth', 'token', 'secret', 'credential', 'password', 'passwd',
  'crypto', 'cipher', 'encrypt', 'decrypt', 'hmac', 'sign',
  'jwt', 'session', 'cookie', 'permission', 'acl', 'rbac', 'privilege',
  'key', 'cert', 'tls', 'ssl', 'https',
]);

// CI and automation, which runs with the repository's secrets, dependency or toolchain pins, what fetches or builds
// code, and the review's own config.
const CI_OR_DEPENDENCY_PATTERNS: readonly string[] = Object.freeze([
  '.github/workflows/**', '.github/actions/**', '**/action.yml', '**/action.yaml',
  '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml', '**/*.lock', '**/go.sum',
  '**/Cargo.toml', '**/go.mod', '**/pyproject.toml', '**/requirements*.txt', '**/Gemfile', '**/*.gemspec',
  '**/rust-toolchain*', '**/.nvmrc', '**/Dockerfile*',
  '**/.gitmodules', '**/.gitattributes', '**/.npmrc', '**/.yarnrc*', '**/build.rs', '**/setup.py', '**/Makefile',
  '.husky/**', '**/.manki.{yml,yaml}', '**/manki.{yml,yaml}',
]);

// Stored data and wire formats that other code or services rely on.
const DATA_CONTRACT_PATTERNS: readonly string[] = Object.freeze([
  '**/migrations/**', '**/*.sql', '**/*.proto', '**/schema.*', '**/openapi*.{yml,yaml,json}',
]);

// Kinds of file where the planner's `trivial: true` is believed: prose, snapshots and generated files.
const DOCS_FILE_PATTERNS: readonly string[] = Object.freeze([
  '**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc', '**/LICENSE*',
  '**/*.snap', '**/__snapshots__/**', '**/*.generated.*', 'dist/**',
]);

// Prose that steers coding agents, so a change to it is never trivial. Matched in any case.
const AGENT_INSTRUCTION_PATTERNS: readonly string[] = Object.freeze([
  '**/AGENTS.md', '**/CLAUDE.md', '**/GEMINI.md', '.github/copilot-instructions.md', '.github/instructions/**',
  '**/.claude/**', '**/.cursor/**',
]);

const globAlias = (patterns: readonly string[]) => (path: string) => patterns.some(p => minimatch(path, p, { dot: true }));
const isDocsFile = globAlias(DOCS_FILE_PATTERNS);
const isAgentInstructions = (path: string) => AGENT_INSTRUCTION_PATTERNS.some(p => minimatch(path, p, { dot: true, nocase: true }));

/** Path aliases a class's `paths_any` and `critical_paths` can name next to plain globs. */
export const PATH_ALIASES: Readonly<Record<string, (path: string) => boolean>> = Object.freeze({
  '@security_paths': (path: string) => path.toLowerCase().split('/').some(segment => {
    const base = segment.replace(/\.[^.]+$/, '');
    return SECURITY_SENSITIVE_PREFIXES.some(prefix => base.startsWith(prefix));
  }),
  '@ci_dependency_paths': globAlias(CI_OR_DEPENDENCY_PATTERNS),
  '@data_contract_paths': globAlias(DATA_CONTRACT_PATTERNS),
});

export const BUILT_IN_CLASSES: Readonly<Record<string, ReviewClass>> = Object.freeze({
  security: { rank: 100, floor: true, match: { paths_any: ['@security_paths'] } },
  supply_chain: { rank: 90, floor: true, match: { paths_any: ['@ci_dependency_paths'] } },
  data_contract: { rank: 80, floor: true, match: { paths_any: ['@data_contract_paths'] } },
  behavior: { rank: 50, match: { triage: { trivial: false, paired: true } } },
  internal: { rank: 30, match: { triage: { trivial: false, paired: false } } },
  docs: { rank: 20, match: { triage: { trivial: true } } },
});

const SONNET_MODEL = 'claude-sonnet-5-5';
export const OPUS_MODEL = 'claude-opus-5-5';

/** The group whose readers run the quick check. */
const TRIVIAL_GROUP = 'trivial';
/** The group of a class with no route, and the one a floor or a deeper review moves a PR up to. */
export const FULL_GROUP = 'full';

/** The groups of a config without `review.groups`. */
export const BUILT_IN_GROUPS: Readonly<Record<string, ReadonlyArray<string | GroupReviewer>>> = Object.freeze({
  [TRIVIAL_GROUP]: [{ model: SONNET_MODEL, effort: 'medium' }],
  solo: [SONNET_MODEL],
  [FULL_GROUP]: [SONNET_MODEL, OPUS_MODEL],
});

export const BUILT_IN_ROUTING: Readonly<Record<string, string>> = Object.freeze({
  security: FULL_GROUP,
  supply_chain: FULL_GROUP,
  data_contract: FULL_GROUP,
  behavior: FULL_GROUP,
  internal: 'solo',
  docs: 'trivial',
});

export interface PrClassification {
  /** Highest ranked matching class, unset when none matched. */
  name?: string;
  /** Every matching class, highest rank first. */
  matched: string[];
  /** Highest ranked matching floor class. */
  floor?: string;
  /** The triage the classes were matched on. */
  triage: Triage;
  /** The planner answered `trivial: true`, but a changed file could not be trivial or a floor class matched. */
  trivialOverridden: boolean;
}

function matchesPath(path: string, pattern: string): boolean {
  const alias = PATH_ALIASES[pattern];
  return alias ? alias(path) : minimatch(path, pattern, { dot: true });
}

function isUnchangedRename(file: DiffFile): boolean {
  if (file.changeType !== 'renamed') return false;
  const { additions, deletions } = countChangedLines(file);
  return additions === 0 && deletions === 0;
}

/**
 * Whether every changed file could be trivial: prose other than agent instructions, snapshots or generated, deleted,
 * or renamed without edits.
 * The planner only sees PR-derived text, so its `trivial` answer needs this floor in code.
 */
function couldBeTrivial(diff: ParsedDiff): boolean {
  return diff.files.every(f => f.changeType === 'deleted' || isUnchangedRename(f) || (isDocsFile(f.path) && !isAgentInstructions(f.path)));
}

function matchesClass(diff: ParsedDiff, match: ReviewClassMatch, triage: Triage): boolean {
  if (match.paths_any && !diff.files.some(f => match.paths_any!.some(p => matchesPath(f.path, p)))) return false;
  if (match.triage && !(Object.keys(match.triage) as (keyof Triage)[]).every(k => match.triage![k] === triage[k])) return false;
  return true;
}

/**
 * Sorts a PR into review classes. A floor class forces `trivial: false` and `paired: true`, and
 * `trivial` is believed only when every changed file could be trivial. Path rules come from the
 * diff alone, so the PR's text can move only the triage-gated classes.
 */
export function classifyPr(diff: ParsedDiff, triage: Triage, classes: Readonly<Record<string, ReviewClass>>): PrClassification {
  const entries = Object.entries(classes).sort(([, a], [, b]) => b.rank - a.rank);
  const floor = entries.find(([, c]) => c.floor && matchesClass(diff, c.match, triage))?.[0];
  const effective: Triage = {
    trivial: triage.trivial && !floor && couldBeTrivial(diff),
    subtle: triage.subtle,
    paired: triage.paired || floor !== undefined,
  };
  const matched = entries.filter(([, c]) => matchesClass(diff, c.match, effective)).map(([name]) => name);
  return {
    ...(matched.length > 0 && { name: matched[0] }),
    matched,
    ...(floor && { floor }),
    triage: effective,
    trivialOverridden: triage.trivial && !effective.trivial,
  };
}

/** The classes, groups and routes a round chooses from: the built-ins with the `review` block over them. */
export interface ResolvedRouting {
  classes: Record<string, ReviewClass>;
  groups: Record<string, ReviewGroup>;
  routing: Record<string, string>;
}

export function resolveRouting(review: ReviewRoutingConfig | undefined): ResolvedRouting {
  const classes: Record<string, ReviewClass> = { ...BUILT_IN_CLASSES };
  for (const [name, def] of Object.entries(review?.classes ?? {})) {
    const builtIn = BUILT_IN_CLASSES[name];
    classes[name] = builtIn
      ? { ...builtIn, match: { ...builtIn.match, paths_any: [...(builtIn.match.paths_any ?? []), ...(def.match?.paths_any ?? [])] } }
      : { rank: def.rank ?? 0, match: def.match ?? {} };
  }
  const groups = Object.entries({ ...BUILT_IN_GROUPS, ...review?.groups }).map(([name, entries]): [string, ReviewGroup] => [name, {
    reviewers: entries.map(entry => (typeof entry === 'string' ? { model: entry } : entry)),
    ...(name === TRIVIAL_GROUP && { quickCheck: true as const }),
  }]);
  return { classes, groups: Object.fromEntries(groups), routing: { ...BUILT_IN_ROUTING, ...review?.routing } };
}

/** Returns the first of `criticalPaths` that matches `path`, or undefined when none does. */
export function criticalAreaOf(criticalPaths: readonly string[], path: string): string | undefined {
  return criticalPaths.find(pattern => matchesPath(path, pattern));
}

/** Returns the group a class routes to. */
export function routeClass(routing: ResolvedRouting, reviewClass: string | undefined): string {
  return (reviewClass && routing.routing[reviewClass]) || FULL_GROUP;
}

/** Returns one identity per model however it is written, so `claude-x` and `anthropic/claude-x` match. An unknown spec stays as written. */
export function modelIdentity(model: string): string {
  try {
    const spec = parseModelSpec(model);
    return `${spec.provider}/${spec.model}`;
  } catch {
    return model.trim();
  }
}

/** Returns the finders of a group. The readers of the quick check group are none. */
export function findersOf(group: ReviewGroup): GroupReviewer[] {
  return group.quickCheck ? [] : group.reviewers;
}

/**
 * Returns why a group misses the floor a floor class needs, or undefined when it meets it.
 * The floor is two finders on two distinct models, and no reader at `low` effort.
 */
export function floorShortfall(group: ReviewGroup): string | undefined {
  const finders = findersOf(group);
  if (finders.length < 2) return 'it has fewer than two finders';
  if (new Set(finders.map(r => modelIdentity(r.model))).size < 2) return 'its finders run on fewer than two distinct models';
  if (group.reviewers.some(r => r.effort === 'low')) return 'a reader runs at `low` effort';
  return undefined;
}

export interface GroupChoice {
  name: string;
  group: ReviewGroup;
  source: TeamRouting['groupSource'];
  /** The routed group the floor, or a deeper review, moved the PR up from. */
  escalatedFrom?: string;
}

/**
 * Picks the group for a classified PR, then checks the floor of every floor class it matched.
 * A group below a floor moves up to that floor class's group, then to the `full` group.
 */
export function chooseGroup(routing: ResolvedRouting, classification: PrClassification): GroupChoice {
  const routed = classification.name ? routing.routing[classification.name] : undefined;
  const name = routed ?? FULL_GROUP;
  const source = routed ? 'routing' : 'default_group';
  const floors = classification.matched.filter(c => routing.classes[c].floor);
  const accepted = (groupName: string) => floors.length === 0 || !floorShortfall(routing.groups[groupName]);
  if (accepted(name)) return { name, group: routing.groups[name], source };
  const target = floors.map(f => routeClass(routing, f)).find(accepted) ?? FULL_GROUP;
  return { name: target, group: routing.groups[target], source: 'floor_escalation', escalatedFrom: name };
}

/** Returns the SHA-256 of the classes, groups and routes a round chooses from. Key order in the config does not change it. */
export function routingDigest(review: ReviewRoutingConfig | undefined): string {
  return createHash('sha256').update(canonicalJson(resolveRouting(review))).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
