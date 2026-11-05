import { minimatch } from 'minimatch';

import { countChangedLines } from './diff';
import { DiffFile, ParsedDiff, ReviewClass, ReviewClassMatch, ReviewGroup, Triage } from './types';

// Path segment prefixes that indicate security-sensitive files. The rule is path-based, not
// prompt-based, so prompt injection in the PR content cannot switch it off.
const SECURITY_SENSITIVE_PREFIXES: readonly string[] = Object.freeze([
  'auth', 'oauth', 'token', 'secret', 'credential', 'password', 'passwd',
  'crypto', 'cipher', 'encrypt', 'decrypt', 'hmac', 'sign',
  'jwt', 'session', 'cookie', 'permission', 'acl', 'rbac', 'privilege',
  'key', 'cert', 'tls', 'ssl', 'https',
]);

// CI and automation, which runs with the repository's secrets, and dependency or toolchain pins.
const CI_OR_DEPENDENCY_PATTERNS: readonly string[] = Object.freeze([
  '.github/workflows/**', '.github/actions/**', '**/action.yml', '**/action.yaml',
  '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/pnpm-lock.yaml', '**/*.lock', '**/go.sum',
  '**/Cargo.toml', '**/go.mod', '**/pyproject.toml', '**/requirements*.txt', '**/Gemfile', '**/*.gemspec',
  '**/rust-toolchain*', '**/.nvmrc', '**/Dockerfile*',
]);

// Stored data and wire formats that other code or services rely on.
const DATA_CONTRACT_PATTERNS: readonly string[] = Object.freeze([
  '**/migrations/**', '**/*.sql', '**/*.proto', '**/schema.*', '**/openapi*.{yml,yaml,json}',
]);

// Kinds of file where the planner's `trivial: true` is believed: docs, snapshots and generated files.
const DOCS_FILE_PATTERNS: readonly string[] = Object.freeze([
  '**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc', '**/*.txt', 'docs/**', '**/LICENSE*',
  '**/*.snap', '**/__snapshots__/**', '**/*.generated.*', 'dist/**',
]);

const globAlias = (patterns: readonly string[]) => (path: string) => patterns.some(p => minimatch(path, p, { dot: true }));

/** Path aliases a class's `paths_any` can name next to plain globs. */
const PATH_ALIASES: Readonly<Record<string, (path: string) => boolean>> = Object.freeze({
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

export const BUILT_IN_GROUPS: Readonly<Record<string, ReviewGroup>> = Object.freeze({
  trivial: { reviewers: [{ model: '@reviewer', effort: 'medium', role: 'verifier' }] },
  solo: { reviewers: [{ model: '@reviewer', effort: 'auto' }] },
  pair: { reviewers: [{ model: '@reviewer', effort: 'auto' }, { model: '@reviewer_pair', effort: 'auto' }] },
});

export const BUILT_IN_ROUTING: Readonly<Record<string, string>> = Object.freeze({
  security: 'pair',
  supply_chain: 'pair',
  data_contract: 'pair',
  behavior: 'pair',
  internal: 'solo',
  docs: 'trivial',
});

export const BUILT_IN_DEFAULT_GROUP = 'pair';

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
 * Whether every changed file could be trivial: docs, snapshots or generated, deleted, or renamed without edits.
 * The planner only sees PR-derived text, so its `trivial` answer needs this floor in code.
 */
function couldBeTrivial(diff: ParsedDiff): boolean {
  return diff.files.every(f => f.changeType === 'deleted' || isUnchangedRename(f) || DOCS_FILE_PATTERNS.some(p => minimatch(f.path, p, { dot: true })));
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
