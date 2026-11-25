import * as core from '@actions/core';
import { parse as parseYaml } from 'yaml';

import { LOCKFILES } from './binary-analyzers';
import { parseModelSpec } from './providers';
import { BUILT_IN_CLASSES, BUILT_IN_GROUPS, FULL_GROUP, OPUS_MODEL, PATH_ALIASES, TRIVIAL_GROUP, canonicalJson, finderShortfall, floorShortfall, modelIdentity, resolveRouting, routeClass } from './routing';
import { ANALYZERS, AUTHOR_CLEAR_ROLES, RELATED_REPO_KINDS, ReviewConfig, StaticAnalysisConfig, RULES_MODES, SWEEP_MODES } from './types';

const HAIKU_MODEL = 'claude-haiku-5-5';

/** The config file Manki reads, at the root of the base branch. */
export const CONFIG_PATH = '.manki.yml';

/**
 * The known package lockfiles that end in `.lock`: those osv-scanner reads, and others it does not. They are excluded by
 * name, so any other `.lock` file, such as `.github/workflows/actions.lock`, is read as text.
 */
const PACKAGE_LOCKFILES = [...new Set([
  ...[...LOCKFILES].filter(name => name.endsWith('.lock')),
  'Podfile.lock', 'deno.lock', 'pixi.lock', 'paket.lock', 'shard.lock', 'rebar.lock', 'Berksfile.lock', 'Puppetfile.lock', 'MODULE.bazel.lock',
  'Gopkg.lock', 'glide.lock', 'Chart.lock', 'stack.yaml.lock', 'requirements.lock', 'requirements-dev.lock', 'nimble.lock', 'spago.lock',
])];

export const DEFAULT_CONFIG: ReviewConfig = {
  auto_review: true,
  auto_approve: true,
  author_clear_role: 'maintain',
  exclude_paths: [...PACKAGE_LOCKFILES, 'dist/**', '*.generated.*'],
  closed_paths: [],
  skip_labels: [],
  skip_authors: [],
  skip_branches: [],
  max_diff_lines: 15000,
  auto_review_max_lines: 8000,
  instructions: '',
  project: '',
  models: {
    planner: HAIKU_MODEL,
    judge: OPUS_MODEL,
    dedup: HAIKU_MODEL,
  },
  judge: {
    tool_steps: 0,
    effort: 'auto',
  },
  static_analysis: {
    checks: true,
    code_scanning: true,
    dependency_review: true,
    wait_for_checks: [],
    analyzers: {},
  },
  memory: {
    enabled: false,
    repo: '',
  },
  drafts: 'skip',
  max_auto_rounds: 10,
  related_repos: [],
};

const SKIP_KEYS = ['skip_labels', 'skip_authors', 'skip_branches'] as const;

const LIMIT_KEYS = ['max_diff_lines', 'auto_review_max_lines'] as const;

export const KNOWN_KEYS: ReadonlySet<string> = new Set([
  'auto_review',
  'auto_approve',
  'author_clear_role',
  'exclude_paths',
  'closed_paths',
  'skip_labels',
  'skip_authors',
  'skip_branches',
  'max_diff_lines',
  'auto_review_max_lines',
  'instructions',
  'project',
  'memory',
  'models',
  'judge',
  'review',
  'static_analysis',
  'related_repos',
  'drafts',
  'max_auto_rounds',
]);

const MAX_JUDGE_TOOL_STEPS = 100;

export const MODEL_KEYS: ReadonlySet<string> = new Set(['planner', 'judge', 'second_refuter', 'dedup', 'fallback']);
/** How many notes a review lists when `review.notes` is not set. */
export const DEFAULT_NOTES = 3;
export const DEFAULT_MIN_WARNING_TRIGGER = 5;

export const REVIEW_KEYS: ReadonlySet<string> = new Set(['groups', 'classes', 'routing', 'critical_paths', 'outside_input', 'examples', 'sweep', 'notes', 'rules', 'min_warning_trigger', 'scope_blocks']);
export const GROUP_REVIEWER_KEYS: ReadonlySet<string> = new Set(['model', 'effort', 'focus']);
/** The keys of a reader of the `trivial` group. The quick check has one fixed prompt, so it takes no `focus`. */
const QUICK_CHECK_KEYS: ReadonlySet<string> = new Set(['model', 'effort']);
const EFFORT_CHOICES = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);
const TRIAGE_KEYS = new Set(['trivial', 'subtle', 'paired']);
const JUDGE_KEYS: ReadonlySet<string> = new Set(['tool_steps', 'effort']);
const STATIC_ANALYSIS_KEYS: ReadonlySet<string> = new Set(['checks', 'code_scanning', 'dependency_review', 'wait_for_checks', 'analyzers']);
const MEMORY_KEYS: ReadonlySet<string> = new Set(['enabled', 'repo']);

const REPO_FORMAT = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

export const RELATED_REPO_KEYS: ReadonlySet<string> = new Set(['repo', 'kind', 'ref', 'paths']);
const MAX_RELATED_REPOS = 10;
const MAX_RELATED_REPO_PATHS = 20;
// A ref is passed to `git fetch`, so it may not start with `-` or hold `..`.
const RELATED_REPO_REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,255}$/;
// `git fetch` reads an abbreviated commit hash as a ref name, which the server cannot resolve.
const ABBREVIATED_COMMIT = /^[0-9a-f]{7,39}$/i;

interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export function validateConfig(config: Record<string, unknown>): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`Unknown config key: "${key}"`);
    }
  }

  for (const key of LIMIT_KEYS) {
    if (key in config && (typeof config[key] !== 'number' || !Number.isInteger(config[key]) || (config[key] as number) <= 0)) {
      errors.push(`\`${key}\` must be a positive whole number`);
    }
  }

  if ('auto_review' in config && typeof config.auto_review !== 'boolean') {
    errors.push('`auto_review` must be a boolean');
  }

  if ('auto_approve' in config && typeof config.auto_approve !== 'boolean') {
    errors.push('`auto_approve` must be a boolean');
  }

  for (const key of ['instructions', 'project']) {
    if (key in config && typeof config[key] !== 'string') {
      errors.push(`\`${key}\` must be a string`);
    }
  }

  for (const key of SKIP_KEYS) {
    if (key in config && (!Array.isArray(config[key]) || !(config[key] as unknown[]).every(v => typeof v === 'string' && v.trim() !== ''))) {
      errors.push(`\`${key}\` must be an array of non-empty strings`);
    }
  }

  for (const key of ['exclude_paths', 'closed_paths']) {
    if (!(key in config)) continue;
    const patterns = config[key];
    if (!Array.isArray(patterns)) {
      errors.push(`\`${key}\` must be an array of strings`);
      continue;
    }
    patterns.forEach((pattern: unknown, i) => {
      if (typeof pattern !== 'string') errors.push(`\`${key}[${i}]\` must be a string, got ${typeof pattern}`);
      else if (key === 'closed_paths' && pattern.includes('\\')) errors.push(`\`closed_paths[${i}]\` holds a backslash: write the path with \`/\``);
      else if (key === 'closed_paths' && closedPattern(pattern) === undefined) {
        errors.push(`\`closed_paths[${i}]\` names no path in the repository: give a path or glob from the repository root, without \`..\``);
      }
    });
  }

  if ('models' in config) {
    const models = config.models as Record<string, unknown>;
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
      errors.push('`models` must be an object');
    } else {
      if ('planner' in models && typeof models.planner !== 'string') {
        errors.push('`models.planner` must be a string');
      }
      if ('judge' in models && typeof models.judge !== 'string') {
        errors.push('`models.judge` must be a string');
      }
      if ('second_refuter' in models && (typeof models.second_refuter !== 'string' || models.second_refuter === '')) {
        errors.push('`models.second_refuter` must be a non-empty string');
      }
      if ('dedup' in models && typeof models.dedup !== 'string') {
        errors.push('`models.dedup` must be a string');
      }
      if ('fallback' in models && (typeof models.fallback !== 'string' || models.fallback === '')) {
        errors.push('`models.fallback` must be a non-empty string');
      }
      for (const [key, model] of Object.entries(models)) {
        if (!MODEL_KEYS.has(key)) warnings.push(`Unknown config key: "models.${key}"`);
        else if (typeof model === 'string' && model !== '') pushModelError(errors, `models.${key}`, model);
      }
    }
  }

  if ('judge' in config) {
    const judge = config.judge as Record<string, unknown>;
    if (!judge || typeof judge !== 'object' || Array.isArray(judge)) {
      errors.push('`judge` must be an object');
    } else {
      warnUnknownKeys(judge, JUDGE_KEYS, 'judge', warnings);
      if ('tool_steps' in judge && (!Number.isInteger(judge.tool_steps) || (judge.tool_steps as number) < 0 || (judge.tool_steps as number) > MAX_JUDGE_TOOL_STEPS)) {
        errors.push(`\`judge.tool_steps\` must be an integer from 0 to ${MAX_JUDGE_TOOL_STEPS}`);
      }
      if ('effort' in judge && !EFFORT_CHOICES.has(judge.effort as string)) errors.push('`judge.effort` must be one of: low, medium, high, xhigh, max, auto');
    }
  }

  if ('review' in config) {
    validateReviewBlock(config.review, errors, warnings);
  }

  if ('static_analysis' in config) {
    const staticAnalysis = config.static_analysis as Record<string, unknown>;
    if (!staticAnalysis || typeof staticAnalysis !== 'object' || Array.isArray(staticAnalysis)) {
      errors.push('`static_analysis` must be an object');
    } else {
      warnUnknownKeys(staticAnalysis, STATIC_ANALYSIS_KEYS, 'static_analysis', warnings);
      for (const key of ['checks', 'code_scanning', 'dependency_review']) {
        if (key in staticAnalysis && typeof staticAnalysis[key] !== 'boolean') {
          errors.push(`\`static_analysis.${key}\` must be a boolean`);
        }
      }
      const waitFor = staticAnalysis.wait_for_checks;
      if (waitFor !== undefined && (!Array.isArray(waitFor) || !waitFor.every(name => typeof name === 'string' && name.trim() !== ''))) {
        errors.push('`static_analysis.wait_for_checks` must be a list of check run names');
      }
      const analyzers = staticAnalysis.analyzers;
      if (analyzers !== undefined && analyzers !== 'all') {
        if (!analyzers || typeof analyzers !== 'object' || Array.isArray(analyzers)) {
          errors.push('`static_analysis.analyzers` must be `all` or an object');
        } else {
          for (const [key, value] of Object.entries(analyzers)) {
            if (!(ANALYZERS as readonly string[]).includes(key)) {
              errors.push(`\`static_analysis.analyzers.${key}\` is not a known analyzer. Known analyzers: ${ANALYZERS.join(', ')}`);
            } else if (key === 'semgrep') {
              if (value !== false && !isSemgrepSettings(value)) {
                errors.push('`static_analysis.analyzers.semgrep` must be `false` or `{ rules: [...] }` listing `.yml` or `.yaml` rule files in the repository');
              }
            } else if (typeof value !== 'boolean') {
              errors.push(`\`static_analysis.analyzers.${key}\` must be a boolean`);
            }
          }
        }
      }
    }
  }

  if ('related_repos' in config) {
    validateRelatedRepos(config.related_repos, errors, warnings);
  }

  if ('author_clear_role' in config && !AUTHOR_CLEAR_ROLES.some(role => role === config.author_clear_role)) {
    errors.push(`\`author_clear_role\` must be one of: ${[...AUTHOR_CLEAR_ROLES].reverse().join(', ')}`);
  }

  if ('drafts' in config && config.drafts !== 'skip' && config.drafts !== 'review') {
    errors.push('`drafts` must be one of: skip, review');
  }

  const maxAutoRounds = config.max_auto_rounds;
  if ('max_auto_rounds' in config && (typeof maxAutoRounds !== 'number' || !Number.isInteger(maxAutoRounds) || maxAutoRounds < 0)) {
    errors.push('`max_auto_rounds` must be a non-negative integer');
  }

  if ('memory' in config) {
    const memory = config.memory as Record<string, unknown>;
    if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
      errors.push('`memory` must be an object');
    } else {
      warnUnknownKeys(memory, MEMORY_KEYS, 'memory', warnings);
      if ('enabled' in memory && typeof memory.enabled !== 'boolean') {
        errors.push('`memory.enabled` must be a boolean');
      }
      if ('repo' in memory && typeof memory.repo === 'string' && memory.repo !== '') {
        if (!REPO_FORMAT.test(memory.repo)) {
          errors.push('`memory.repo` must be in "owner/name" format');
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Warns about each key of `block` that is not in `known`, named by its path under `prefix`. */
function warnUnknownKeys(block: Record<string, unknown>, known: ReadonlySet<string>, prefix: string, warnings: string[]): void {
  for (const key of Object.keys(block)) {
    if (!known.has(key)) warnings.push(`Unknown config key: "${prefix}.${key}"`);
  }
}

/** Adds an error when `model` is no model spec Manki can run, so a bad id never reaches a CLI. */
function pushModelError(errors: string[], key: string, model: string): void {
  try {
    parseModelSpec(model);
  } catch (error) {
    errors.push(`\`${key}\`: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string' && v !== '');

function validateRelatedRepos(value: unknown, errors: string[], warnings: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('`related_repos` must be a list of repos');
    return;
  }
  if (value.length > MAX_RELATED_REPOS) errors.push(`\`related_repos\` lists ${value.length} repos, at most ${MAX_RELATED_REPOS} are allowed`);
  const seen = new Set<string>();
  value.forEach((entry: unknown, i) => {
    const at = `\`related_repos[${i}]`;
    if (!isObject(entry)) {
      errors.push(`${at}\` must be an object`);
      return;
    }
    for (const key of Object.keys(entry)) {
      if (!RELATED_REPO_KEYS.has(key)) warnings.push(`Unknown config key: "related_repos[${i}].${key}"`);
    }
    const { repo, kind, ref, paths } = entry;
    if (typeof repo !== 'string' || !REPO_FORMAT.test(repo) || repo.split('/').some(part => part === '.' || part === '..')) {
      errors.push(`${at}.repo\` must be in "owner/name" format`);
    } else if (seen.has(repo.toLowerCase())) {
      errors.push(`${at}.repo\` lists ${repo} a second time`);
    } else {
      seen.add(repo.toLowerCase());
    }
    if (!RELATED_REPO_KINDS.some(known => known === kind)) errors.push(`${at}.kind\` must be one of: ${RELATED_REPO_KINDS.join(', ')}`);
    if (ref !== undefined && (typeof ref !== 'string' || !RELATED_REPO_REF.test(ref))) {
      errors.push(`${at}.ref\` must be a branch, tag or commit name`);
    } else if (typeof ref === 'string' && ABBREVIATED_COMMIT.test(ref)) {
      errors.push(`${at}.ref\` looks like an abbreviated commit. Use the full hash, or \`refs/tags/${ref}\` or \`refs/heads/${ref}\` for a tag or branch of that name`);
    }
    if (paths !== undefined) {
      if (!isStringArray(paths) || paths.length === 0 || paths.length > MAX_RELATED_REPO_PATHS) {
        errors.push(`${at}.paths\` must be a list of 1 to ${MAX_RELATED_REPO_PATHS} paths`);
      } else {
        for (const p of paths) {
          if (!isRepoRelativePattern(p)) errors.push(`${at}.paths\` has \`${p}\`, which must be a path or glob inside the repo`);
        }
      }
    }
  });
}

/** Whether `pattern` names files inside a repo: relative, without `..`, and without the characters a sparse checkout reads specially. */
function isRepoRelativePattern(pattern: string): boolean {
  return !/^[/!#-]/.test(pattern) && !pattern.includes('\\') && ![...pattern].some(c => c.charCodeAt(0) < 0x20)
    && !pattern.split('/').includes('..');
}

/** Checks that `paths` is a non-empty list of globs and known path aliases. `at` names the setting in an error. */
function checkPathList(paths: unknown, at: string, errors: string[]): void {
  if (!isStringArray(paths) || paths.length === 0) {
    errors.push(`${at} must be a non-empty array of strings`);
    return;
  }
  for (const p of paths.filter(p => p.startsWith('@') && !(p in PATH_ALIASES))) {
    errors.push(`${at} names unknown path alias \`${p}\`. Known aliases: ${Object.keys(PATH_ALIASES).join(', ')}`);
  }
}

function validateReviewBlock(review: unknown, errors: string[], warnings: string[]): void {
  if (!isObject(review)) {
    errors.push('`review` must be an object');
    return;
  }
  for (const key of Object.keys(review)) {
    if (!REVIEW_KEYS.has(key)) warnings.push(`Unknown config key: "review.${key}"`);
  }

  const groups = new Set(Object.keys(BUILT_IN_GROUPS));
  if ('groups' in review) {
    if (!isObject(review.groups)) {
      errors.push('`review.groups` must be an object mapping group names to lists of reviewers');
    } else {
      for (const name of Object.keys(BUILT_IN_GROUPS).filter(builtIn => !Object.hasOwn(review.groups as object, builtIn))) {
        errors.push(`\`review.groups\` must define the \`trivial\`, \`solo\` and \`full\` groups, and has no \`${name}\``);
      }
      for (const [name, reviewers] of Object.entries(review.groups)) {
        groups.add(name);
        if (!Array.isArray(reviewers) || reviewers.length === 0) {
          errors.push(`\`review.groups.${name}\` must be a non-empty array of reviewers`);
          continue;
        }
        const known = name === TRIVIAL_GROUP ? QUICK_CHECK_KEYS : GROUP_REVIEWER_KEYS;
        reviewers.forEach((reviewer: unknown, i) => {
          const at = `\`review.groups.${name}[${i}]`;
          if (typeof reviewer === 'string' && reviewer !== '') {
            pushModelError(errors, `review.groups.${name}[${i}]`, reviewer);
            return;
          }
          if (!isObject(reviewer)) {
            errors.push(`${at}\` must be a model id or an object with a \`model\``);
            return;
          }
          warnUnknownKeys(reviewer, known, `review.groups.${name}[${i}]`, warnings);
          if (typeof reviewer.model !== 'string' || reviewer.model === '') errors.push(`${at}.model\` must be a non-empty string`);
          else pushModelError(errors, `review.groups.${name}[${i}].model`, reviewer.model);
          if ('effort' in reviewer && !EFFORT_CHOICES.has(reviewer.effort as string)) errors.push(`${at}.effort\` must be one of: low, medium, high, xhigh, max, auto`);
          if (known.has('focus') && 'focus' in reviewer && (typeof reviewer.focus !== 'string' || reviewer.focus === '')) errors.push(`${at}.focus\` must be a non-empty string`);
        });
      }
    }
  }

  const classes = new Set(Object.keys(BUILT_IN_CLASSES));
  if ('classes' in review) {
    if (!isObject(review.classes)) {
      errors.push('`review.classes` must be an object mapping class names to classes');
    } else {
      const ranks = new Map(Object.entries(BUILT_IN_CLASSES).map(([name, c]) => [c.rank, name]));
      for (const [name, def] of Object.entries(review.classes)) {
        const at = `\`review.classes.${name}`;
        classes.add(name);
        if (!isObject(def)) {
          errors.push(`${at}\` must be an object`);
          continue;
        }
        const builtIn = BUILT_IN_CLASSES[name];
        const match = def.match;
        if ('critical' in def) errors.push(`${at}.critical\` is not a class setting. List the critical paths in \`review.critical_paths\``);
        if (builtIn) {
          if (!builtIn.match.paths_any || 'rank' in def || 'floor' in def || !isObject(match) || Object.keys(match).some(k => k !== 'paths_any')) {
            errors.push(builtIn.match.paths_any
              ? `${at}\` is built in: it takes only \`match.paths_any\`, which adds paths to its built-in rule`
              : `${at}\` is built in and cannot be changed. Route it with \`review.routing\` instead`);
            continue;
          }
        } else {
          if ('floor' in def) errors.push(`${at}.floor\` is not allowed: only the built-in security, supply_chain and data_contract classes are floors`);
          if (typeof def.rank !== 'number' || !Number.isInteger(def.rank)) {
            errors.push(`${at}.rank\` must be an integer`);
          } else if (ranks.has(def.rank)) {
            errors.push(`${at}.rank\` ${def.rank} is already the rank of \`${ranks.get(def.rank)}\`. Each class needs its own rank`);
          } else {
            ranks.set(def.rank, name);
          }
          if (!isObject(match) || Object.keys(match).length === 0) {
            errors.push(`${at}.match\` must set \`paths_any\`, \`triage\` or both`);
            continue;
          }
          for (const key of Object.keys(match)) {
            if (key !== 'paths_any' && key !== 'triage') errors.push(`${at}.match.${key}\` is not a known condition. Use \`paths_any\` or \`triage\``);
          }
          if ('triage' in match) {
            if (!isObject(match.triage) || Object.entries(match.triage).some(([k, v]) => !TRIAGE_KEYS.has(k) || typeof v !== 'boolean')) {
              errors.push(`${at}.match.triage\` must map trivial, subtle or paired to true or false`);
            }
          }
        }
        if ('paths_any' in match) checkPathList(match.paths_any, `${at}.match.paths_any\``, errors);
      }
    }
  }

  if ('critical_paths' in review) checkPathList(review.critical_paths, '`review.critical_paths`', errors);
  if ('outside_input' in review && (typeof review.outside_input !== 'string' || !review.outside_input.trim())) {
    errors.push('`review.outside_input` must be a non-empty string');
  }
  if ('sweep' in review && !SWEEP_MODES.some(mode => mode === review.sweep)) errors.push('`review.sweep` must be `off`, `blockers`, `warnings` or `notes`');
  if ('notes' in review && !(Number.isInteger(review.notes) && (review.notes as number) >= 0)) errors.push('`review.notes` must be a non-negative integer');
  if ('rules' in review && !RULES_MODES.some(mode => mode === review.rules)) errors.push('`review.rules` must be `auto`, `warn` or `block`');
  if ('min_warning_trigger' in review && !(Number.isInteger(review.min_warning_trigger) && (review.min_warning_trigger as number) >= 1 && (review.min_warning_trigger as number) <= 10)) {
    errors.push(`\`review.min_warning_trigger\` must be a whole number from 1 to 10. The default is ${DEFAULT_MIN_WARNING_TRIGGER}, 1 turns the filter off, and a higher number filters more`);
  }
  if ('scope_blocks' in review && typeof review.scope_blocks !== 'boolean') errors.push('`review.scope_blocks` must be `true` or `false`');
  if ('examples' in review) {
    const examples = review.examples;
    if (!isObject(examples) || Object.keys(examples).length === 0) {
      errors.push('`review.examples` must set `blocker`, `not_blocker` or both');
    } else {
      for (const [side, list] of Object.entries(examples)) {
        if (side !== 'blocker' && side !== 'not_blocker') errors.push(`\`review.examples.${side}\` is not a known side. Use \`blocker\` or \`not_blocker\``);
        else if (!isStringArray(list) || list.length === 0) errors.push(`\`review.examples.${side}\` must be a non-empty array of strings`);
      }
    }
  }

  if ('routing' in review) {
    if (!isObject(review.routing)) {
      errors.push('`review.routing` must be an object mapping class names to group names');
    } else {
      for (const [name, group] of Object.entries(review.routing)) {
        if (!classes.has(name)) errors.push(`\`review.routing.${name}\` routes an unknown class. Define it under \`review.classes\``);
        if (typeof group !== 'string' || !groups.has(group)) errors.push(`\`review.routing.${name}\` names unknown group \`${String(group)}\``);
      }
    }
  }
}

/**
 * Returns an error when the `full` group has no two finders on two distinct models, and one for each floor class
 * the `review` block routes to another group below the floor.
 */
export function reviewFloorErrors(config: ReviewConfig): string[] {
  if (!config.review) return [];
  const routing = resolveRouting(config.review);
  const full = finderShortfall(routing.groups[FULL_GROUP]);
  const errors = full ? [`\`review.groups.${FULL_GROUP}\` must hold at least two finders on two distinct models, but ${full}`] : [];
  for (const [name, c] of Object.entries(routing.classes)) {
    if (!c.floor) continue;
    const groupName = routeClass(routing, name);
    if (full && groupName === FULL_GROUP) continue;
    const shortfall = floorShortfall(routing.groups[groupName]);
    if (shortfall) {
      errors.push(`\`review\` routes the \`${name}\` floor class to the \`${groupName}\` group, but ${shortfall}. A floor class needs two finders on two distinct models, none at \`low\` effort. Route it to a stronger group`);
    }
  }
  return errors;
}

function deepMerge(defaults: ReviewConfig, overrides: Record<string, unknown>): ReviewConfig {
  const result = { ...defaults };

  for (const key of Object.keys(overrides)) {
    if (!KNOWN_KEYS.has(key)) continue;

    const value = overrides[key];

    if (key === 'memory' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.memory = { ...defaults.memory, ...(value as Record<string, unknown>) } as ReviewConfig['memory'];
    } else if (key === 'models' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const known = Object.entries(value as Record<string, unknown>).filter(([name]) => MODEL_KEYS.has(name));
      result.models = { ...defaults.models, ...Object.fromEntries(known) } as ReviewConfig['models'];
    } else if (key === 'judge' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.judge = { ...defaults.judge, ...(value as Record<string, unknown>) } as ReviewConfig['judge'];
    } else if (key === 'static_analysis' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.static_analysis = { ...defaults.static_analysis, ...(value as Record<string, unknown>) } as ReviewConfig['static_analysis'];
    } else {
      (result as Record<string, unknown>)[key] = value;
    }
  }

  return result;
}

/**
 * Parses and validates a config file's content. Throws on invalid YAML or an invalid schema
 * rather than falling back to defaults, because the defaults include `auto_approve: true`.
 */
export function loadConfigFromContent(content: string, source = CONFIG_PATH): ReviewConfig {
  if (!content.trim()) {
    core.info('Empty config, using defaults');
    return { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory } };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid YAML in ${source}: ${msg}`);
  }

  if (parsed === null || parsed === undefined) {
    core.info('Config has no settings, using defaults');
    return { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory } };
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config in ${source}: the top level must be a mapping of keys to values`);
  }

  const validation = validateConfig(parsed as Record<string, unknown>);

  for (const warning of validation.warnings) {
    core.warning(warning);
  }

  if (!validation.valid) {
    for (const error of validation.errors) {
      core.error(error);
    }
    throw new Error(`Invalid config in ${source}: ${validation.errors.join('; ')}`);
  }

  const config = deepMerge(DEFAULT_CONFIG, parsed as Record<string, unknown>);
  config.closed_paths = config.closed_paths?.map(pattern => closedPattern(pattern)!);
  const floorErrors = reviewFloorErrors(config);
  if (floorErrors.length > 0) {
    for (const error of floorErrors) core.error(error);
    throw new Error(`Invalid config in ${source}: ${floorErrors.join('; ')}`);
  }
  return config;
}

function isSemgrepSettings(value: unknown): boolean {
  const rules = (value as { rules?: unknown } | null)?.rules;
  // Registry names such as `p/default` and URLs are refused: Manki only runs rule files it reads from the base branch.
  return Array.isArray(rules) && rules.length > 0 && rules.every(rule => typeof rule === 'string'
    && /\.ya?ml$/.test(rule) && !rule.startsWith('/') && !rule.includes('://') && !rule.split('/').includes('..'));
}

/**
 * Returns the `static_analysis` block of a config file's content, with defaults for missing keys.
 * Falls back to the defaults when the content is missing or invalid, so a broken file never turns sources off.
 */
export function loadStaticAnalysisConfig(content: string | null, source = CONFIG_PATH): StaticAnalysisConfig {
  const defaults = DEFAULT_CONFIG.static_analysis!;
  if (!content) return { ...defaults };
  try {
    const parsed: unknown = parseYaml(content);
    const block = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).static_analysis
      : undefined;
    if (block === undefined) return { ...defaults };
    const validation = validateConfig({ static_analysis: block });
    if (!validation.valid) {
      core.info(`Ignoring invalid \`static_analysis\` in ${source} on the base branch: ${validation.errors.join('; ')}`);
      return { ...defaults };
    }
    return { ...defaults, ...(block as Partial<StaticAnalysisConfig>) };
  } catch (e) {
    core.info(`Could not parse ${source} on the base branch, using the default \`static_analysis\`: ${e instanceof Error ? e.message : String(e)}`);
    return { ...defaults };
  }
}

/** Returns the top-level keys whose values differ between the PR's config and the base branch's. */
export function changedKeys(head: ReviewConfig, base: ReviewConfig): string[] {
  const values = (config: ReviewConfig) => config as unknown as Record<string, unknown>;
  return [...KNOWN_KEYS].filter(key => canonicalJson(values(head)[key]) !== canonicalJson(values(base)[key]));
}

export function resolveModel(config: ReviewConfig, stage: 'planner' | 'judge' | 'dedup'): string {
  return config.models?.[stage] || DEFAULT_CONFIG.models![stage]!;
}

/**
 * Returns the model a stage on `stageModel` moves to when a safety filter refuses it or its model reaches a limit: `models.fallback`. Without it,
 * or for a stage already on it, the first model of the `full` group other than the stage's own.
 * Returns undefined when no other model is left.
 */
export function resolveFallbackModel(config: ReviewConfig, stageModel: string): string | undefined {
  const other = (model: string): boolean => modelIdentity(model) !== modelIdentity(stageModel);
  const fallback = config.models?.fallback;
  if (fallback && other(fallback)) return fallback;
  return resolveRouting(config.review).groups[FULL_GROUP].reviewers.map(r => r.model).find(other);
}

/**
 * Returns the defaults for a base branch config that could not be read or loaded. `author_clear_role` is `admin` in
 * them, the one role that may clear under every value the repository can have set. `closedPaths` is what the file
 * closes, as `readClosedPaths` reads it.
 */
export function fallbackConfig(closedPaths: string[] = []): ReviewConfig {
  return { ...loadConfig(undefined), author_clear_role: 'admin', closed_paths: closedPaths };
}

/**
 * Returns the `closed_paths` of a config file from its YAML alone, so a file that does not load still closes its paths.
 * YAML that does not parse to a mapping closes nothing when its text never names `closed_paths`. Returns undefined when
 * it does, and when `closed_paths` is set but is not a list of strings.
 */
export function readClosedPaths(content: string | null): string[] | undefined {
  if (!content?.trim()) return [];
  const unreadable = content.includes('closed_paths') ? undefined : [];
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch {
    return unreadable;
  }
  if (parsed === null || parsed === undefined) return [];
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return unreadable;
  const closed = (parsed as Record<string, unknown>).closed_paths;
  if (closed === undefined) return [];
  if (!Array.isArray(closed) || !closed.every(p => typeof p === 'string')) return undefined;
  const patterns = closed.map(closedPattern);
  return patterns.every(p => p !== undefined) ? patterns : undefined;
}

/**
 * Returns a `closed_paths` pattern in the spelling of the paths it is matched against: without doubled slashes or `.`
 * segments, and with a trailing `/` read as every file in the folder. A pattern written with a slash matches from the
 * repository root, so one left with a single segment keeps a leading `/`, which `findClosedPattern` reads as the root.
 * Returns undefined for a pattern that names no path in the repository, such as an empty one, one with a `..` segment
 * or one with a backslash.
 */
function closedPattern(pattern: string): string | undefined {
  const parts = pattern.split('/').filter(part => part !== '' && part !== '.');
  if (pattern.includes('\\') || parts.length === 0 || parts.some(part => part.trim() === '' || part === '..')) return undefined;
  const path = parts.join('/') + (pattern.endsWith('/') ? '/**' : '');
  return pattern.includes('/') && !path.includes('/') ? `/${path}` : path;
}

export function loadConfig(yamlContent: string | undefined, source?: string): ReviewConfig {
  if (!yamlContent) {
    core.info('No config content provided, using defaults');
    return { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory } };
  }

  return loadConfigFromContent(yamlContent, source);
}
