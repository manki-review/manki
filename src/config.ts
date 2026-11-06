import * as core from '@actions/core';
import * as fs from 'fs';
import { minimatch } from 'minimatch';
import { parse as parseYaml } from 'yaml';

import { BUILT_IN_CLASSES, BUILT_IN_GROUPS, PATH_ALIASES, floorShortfall, modelIdentity, resolveRouting, routeClass } from './routing';
import { ANALYZERS, PairedPin, ReviewConfig, ReviewRoutingConfig, SkipFacts, StaticAnalysisConfig } from './types';

export const MAX_LOCK_TTL_SECONDS = 3600;
const MAX_WAIT_TIMEOUT_SECONDS = 3600;

const HAIKU_MODEL = 'claude-haiku-5-5';
const SONNET_MODEL = 'claude-sonnet-5-5';
const OPUS_MODEL = 'claude-opus-5-5';

export const DEFAULT_CONFIG: ReviewConfig = {
  auto_review: true,
  auto_approve: true,
  exclude_paths: ['*.lock', 'dist/**', '*.generated.*'],
  skip_labels: [],
  skip_authors: [],
  skip_branches: [],
  max_diff_lines: 50000,
  reviewers: [],
  instructions: '',
  models: {
    planner: HAIKU_MODEL,
    reviewer: SONNET_MODEL,
    judge: OPUS_MODEL,
    dedup: HAIKU_MODEL,
  },
  planner: {
    enabled: true,
    paired: 'auto',
  },
  static_analysis: {
    checks: true,
    code_scanning: true,
    dependency_review: true,
    wait_for_checks: [],
    wait_timeout_seconds: 300,
    analyzers: {},
  },
  memory: {
    enabled: false,
    repo: '',
  },
  noise_level: 'low',
  review_passes: 1,
  convergence: {
    max_auto_rounds: 5,
    test_path_patterns: ['**/*.test.*', '**/*.spec.*', '**/tests/**', '**/__tests__/**'],
    suppress_resolved_threads: true,
  },
  concurrency_lock_ttl_seconds: 600,
};

const SKIP_KEYS = ['skip_labels', 'skip_authors', 'skip_branches'] as const;

const KNOWN_KEYS = new Set([
  'auto_review',
  'auto_approve',
  'exclude_paths',
  'skip_labels',
  'skip_authors',
  'skip_branches',
  'max_diff_lines',
  'reviewers',
  'instructions',
  'review_level',
  'review_thresholds',
  'memory',
  'models',
  'planner',
  'review',
  'static_analysis',
  'nit_handling',
  'noise_level',
  'review_passes',
  'convergence',
  'stats',
  'metrics',
  'concurrency_lock_ttl_seconds',
]);

// Accepted so older configs keep loading, then dropped.
const IGNORED_KEYS = new Set(['review_level', 'review_thresholds', 'stats']);

const PAIRED_PINS: readonly PairedPin[] = ['auto', 'always', 'never'];

const REVIEW_KEYS = new Set(['default_group', 'groups', 'classes', 'routing', 'allow_weaker', 'outside_input', 'examples']);
const GROUP_REVIEWER_KEYS = new Set(['model', 'effort', 'focus', 'role']);
const REVIEWER_EFFORTS = new Set(['low', 'medium', 'high', 'max', 'auto']);
const TRIAGE_KEYS = new Set(['trivial', 'subtle', 'paired']);

const REPO_FORMAT = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function validateConfig(config: Record<string, unknown>): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`Unknown config key: "${key}"`);
    }
  }

  if ('max_diff_lines' in config) {
    if (typeof config.max_diff_lines !== 'number' || config.max_diff_lines <= 0) {
      errors.push('`max_diff_lines` must be a positive number');
    }
  }

  if ('auto_review' in config && typeof config.auto_review !== 'boolean') {
    errors.push('`auto_review` must be a boolean');
  }

  if ('auto_approve' in config && typeof config.auto_approve !== 'boolean') {
    errors.push('`auto_approve` must be a boolean');
  }

  if ('instructions' in config && typeof config.instructions !== 'string') {
    errors.push('`instructions` must be a string');
  }

  for (const key of SKIP_KEYS) {
    if (key in config && (!Array.isArray(config[key]) || !(config[key] as unknown[]).every(v => typeof v === 'string' && v.trim() !== ''))) {
      errors.push(`\`${key}\` must be an array of non-empty strings`);
    }
  }

  if ('exclude_paths' in config) {
    if (!Array.isArray(config.exclude_paths)) {
      errors.push('`exclude_paths` must be an array of strings');
    } else {
      for (let i = 0; i < config.exclude_paths.length; i++) {
        if (typeof config.exclude_paths[i] !== 'string') {
          errors.push(`\`exclude_paths[${i}]\` must be a string, got ${typeof config.exclude_paths[i]}`);
        }
      }
    }
  }

  if ('review_level' in config) {
    warnings.push('`review_level` is deprecated and ignored. The planner triage now sets how many finders read each PR, from the nature of the change. To pin whether a second finder runs, use `planner.paired`.');
  }
  if ('review_thresholds' in config) {
    warnings.push('`review_thresholds` is deprecated and ignored. Line counts no longer size the review: the planner triage sets how many finders read each PR, from the nature of the change.');
  }

  if ('reviewers' in config) {
    if (!Array.isArray(config.reviewers)) {
      errors.push('`reviewers` must be an array');
    } else {
      for (let i = 0; i < config.reviewers.length; i++) {
        const reviewer = config.reviewers[i] as Record<string, unknown>;
        if (!reviewer || typeof reviewer !== 'object') {
          errors.push(`\`reviewers[${i}]\` must be an object`);
        } else {
          if (typeof reviewer.name !== 'string' || !reviewer.name) {
            errors.push(`\`reviewers[${i}].name\` must be a non-empty string`);
          }
          if (typeof reviewer.focus !== 'string' || !reviewer.focus) {
            errors.push(`\`reviewers[${i}].focus\` must be a non-empty string`);
          }
        }
      }
    }
  }

  if ('models' in config) {
    const models = config.models as Record<string, unknown>;
    if (!models || typeof models !== 'object' || Array.isArray(models)) {
      errors.push('`models` must be an object');
    } else {
      if ('planner' in models && typeof models.planner !== 'string') {
        errors.push('`models.planner` must be a string');
      }
      if ('reviewer' in models && typeof models.reviewer !== 'string') {
        errors.push('`models.reviewer` must be a string');
      }
      if ('reviewer_pair' in models && (typeof models.reviewer_pair !== 'string' || models.reviewer_pair === '')) {
        errors.push('`models.reviewer_pair` must be a non-empty string');
      }
      if ('judge' in models && typeof models.judge !== 'string') {
        errors.push('`models.judge` must be a string');
      }
      if ('dedup' in models && typeof models.dedup !== 'string') {
        errors.push('`models.dedup` must be a string');
      }
      if ('fallback' in models && (typeof models.fallback !== 'string' || models.fallback === '')) {
        errors.push('`models.fallback` must be a non-empty string');
      }
      if ('agents' in models) {
        const agents = models.agents as Record<string, unknown>;
        if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
          errors.push('`models.agents` must be an object mapping agent names to model strings');
        } else {
          for (const [agentName, modelValue] of Object.entries(agents)) {
            if (typeof modelValue !== 'string' || modelValue === '') {
              errors.push(`\`models.agents.${agentName}\` must be a non-empty string`);
            }
          }
          warnings.push('`models.agents` is deprecated and will be removed in the next major release. Manki no longer runs specialist agents. Unless `models.reviewer_pair` is set, its first model that differs from `models.reviewer` becomes the second finder\'s model, which `@reviewer_pair` in a review group names.');
        }
      }
    }
  }

  if ('planner' in config) {
    const planner = config.planner as Record<string, unknown>;
    if (!planner || typeof planner !== 'object' || Array.isArray(planner)) {
      errors.push('`planner` must be an object');
    } else {
      if ('enabled' in planner && typeof planner.enabled !== 'boolean') {
        errors.push('`planner.enabled` must be a boolean');
      }
      if ('paired' in planner) {
        if (!PAIRED_PINS.includes(planner.paired as PairedPin)) {
          errors.push('`planner.paired` must be one of: auto, always, never');
        }
        warnings.push('`planner.paired` is deprecated. Route classes to review groups with `review.routing` instead: `always` is `behavior` and `internal` on a two-finder group, `never` is `behavior` on a one-finder group.');
      }
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
      for (const key of ['checks', 'code_scanning', 'dependency_review']) {
        if (key in staticAnalysis && typeof staticAnalysis[key] !== 'boolean') {
          errors.push(`\`static_analysis.${key}\` must be a boolean`);
        }
      }
      const waitFor = staticAnalysis.wait_for_checks;
      if (waitFor !== undefined && (!Array.isArray(waitFor) || !waitFor.every(name => typeof name === 'string' && name.trim() !== ''))) {
        errors.push('`static_analysis.wait_for_checks` must be a list of check run names');
      }
      const timeout = staticAnalysis.wait_timeout_seconds;
      if (timeout !== undefined && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_WAIT_TIMEOUT_SECONDS)) {
        errors.push(`\`static_analysis.wait_timeout_seconds\` must be an integer from 1 to ${MAX_WAIT_TIMEOUT_SECONDS}`);
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

  if ('nit_handling' in config) {
    if (config.nit_handling === 'issues' || config.nit_handling === 'comments') {
      warnings.push("`nit_handling: '" + config.nit_handling + "'` is deprecated and ignored, surviving nit findings now post inline. See https://github.com/manki-review/manki/issues/738 for context.");
    } else {
      warnings.push(`\`nit_handling: '${String(config.nit_handling)}'\` is not a recognized value. Remove it from your config.`);
    }
  }

  if ('noise_level' in config) {
    const valid = new Set(['low', 'medium', 'high']);
    if (typeof config.noise_level !== 'string' || !valid.has(config.noise_level)) {
      errors.push('`noise_level` must be one of: low, medium, high');
    }
  }

  if ('review_passes' in config) {
    if (typeof config.review_passes !== 'number' ||
        !Number.isInteger(config.review_passes) ||
        config.review_passes < 1 ||
        config.review_passes > 5) {
      errors.push('`review_passes` must be an integer between 1 and 5');
    }
  }

  if ('convergence' in config) {
    const convergence = config.convergence as Record<string, unknown>;
    if (!convergence || typeof convergence !== 'object' || Array.isArray(convergence)) {
      errors.push('`convergence` must be an object');
    } else {
      if ('max_auto_rounds' in convergence) {
        if (
          typeof convergence.max_auto_rounds !== 'number' ||
          !Number.isInteger(convergence.max_auto_rounds) ||
          convergence.max_auto_rounds < 0
        ) {
          errors.push('`convergence.max_auto_rounds` must be a non-negative integer');
        }
      }
      if ('test_path_patterns' in convergence) {
        if (
          !Array.isArray(convergence.test_path_patterns) ||
          !convergence.test_path_patterns.every(p => typeof p === 'string')
        ) {
          errors.push('`convergence.test_path_patterns` must be an array of strings');
        }
      }
      if ('suppress_resolved_threads' in convergence && typeof convergence.suppress_resolved_threads !== 'boolean') {
        errors.push('`convergence.suppress_resolved_threads` must be a boolean');
      }
    }
  }

  if ('stats' in config) {
    warnings.push('`stats` is deprecated and ignored. The round record is always a hidden comment in the review.');
  }

  if ('metrics' in config) {
    const metrics = config.metrics as Record<string, unknown>;
    if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) {
      errors.push('`metrics` must be an object');
    } else if ('fix_rate' in metrics && typeof metrics.fix_rate !== 'boolean') {
      errors.push('`metrics.fix_rate` must be a boolean');
    }
  }

  if ('concurrency_lock_ttl_seconds' in config) {
    if (
      typeof config.concurrency_lock_ttl_seconds !== 'number' ||
      !Number.isFinite(config.concurrency_lock_ttl_seconds) ||
      config.concurrency_lock_ttl_seconds < 0 ||
      config.concurrency_lock_ttl_seconds > MAX_LOCK_TTL_SECONDS
    ) {
      errors.push(`\`concurrency_lock_ttl_seconds\` must be a non-negative number ≤ ${MAX_LOCK_TTL_SECONDS}`);
    }
  }

  if ('memory' in config) {
    const memory = config.memory as Record<string, unknown>;
    if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
      errors.push('`memory` must be an object');
    } else {
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

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === 'string' && v !== '');

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
      errors.push('`review.groups` must be an object mapping group names to groups');
    } else {
      for (const [name, group] of Object.entries(review.groups)) {
        groups.add(name);
        const reviewers = isObject(group) ? group.reviewers : undefined;
        if (!Array.isArray(reviewers) || reviewers.length === 0) {
          errors.push(`\`review.groups.${name}.reviewers\` must be a non-empty array`);
          continue;
        }
        reviewers.forEach((reviewer: unknown, i) => {
          const at = `\`review.groups.${name}.reviewers[${i}]`;
          if (!isObject(reviewer)) {
            errors.push(`${at}\` must be an object`);
            return;
          }
          for (const key of Object.keys(reviewer)) {
            if (!GROUP_REVIEWER_KEYS.has(key)) warnings.push(`Unknown config key: "review.groups.${name}.reviewers[${i}].${key}"`);
          }
          if ('model' in reviewer && (typeof reviewer.model !== 'string' || reviewer.model === '')) errors.push(`${at}.model\` must be a non-empty string`);
          if ('effort' in reviewer && !REVIEWER_EFFORTS.has(reviewer.effort as string)) errors.push(`${at}.effort\` must be one of: low, medium, high, max, auto`);
          if ('focus' in reviewer && (typeof reviewer.focus !== 'string' || reviewer.focus === '')) errors.push(`${at}.focus\` must be a non-empty string`);
          if ('role' in reviewer && reviewer.role !== 'finder' && reviewer.role !== 'verifier') errors.push(`${at}.role\` must be one of: finder, verifier`);
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
        if (builtIn) {
          if (!builtIn.match.paths_any || 'rank' in def || 'floor' in def || 'critical' in def || !isObject(match) || Object.keys(match).some(k => k !== 'paths_any')) {
            errors.push(builtIn.match.paths_any
              ? `${at}\` is built in: it takes only \`match.paths_any\`, which adds paths to its built-in rule`
              : `${at}\` is built in and cannot be changed. Route it with \`review.routing\` instead`);
            continue;
          }
        } else {
          if ('floor' in def) errors.push(`${at}.floor\` is not allowed: only the built-in security, supply_chain and data_contract classes are floors`);
          if ('critical' in def && typeof def.critical !== 'boolean') errors.push(`${at}.critical\` must be a boolean`);
          if (def.critical === true && (!isObject(match) || !('paths_any' in match) || 'triage' in match)) {
            errors.push(`${at}.critical\` needs \`match.paths_any\` and no \`triage\`: a critical area is a set of paths`);
          }
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
        if ('paths_any' in match) {
          if (!isStringArray(match.paths_any) || match.paths_any.length === 0) {
            errors.push(`${at}.match.paths_any\` must be a non-empty array of strings`);
          } else {
            for (const p of match.paths_any.filter(p => p.startsWith('@') && !(p in PATH_ALIASES))) {
              errors.push(`${at}.match.paths_any\` names unknown path alias \`${p}\`. Known aliases: ${Object.keys(PATH_ALIASES).join(', ')}`);
            }
          }
        }
      }
    }
  }

  if ('outside_input' in review && (typeof review.outside_input !== 'string' || !review.outside_input.trim())) {
    errors.push('`review.outside_input` must be a non-empty string');
  }
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

  if ('default_group' in review && (typeof review.default_group !== 'string' || !groups.has(review.default_group))) {
    errors.push(`\`review.default_group\` names unknown group \`${String(review.default_group)}\``);
  }

  if ('allow_weaker' in review) {
    const floors = Object.keys(BUILT_IN_CLASSES).filter(name => BUILT_IN_CLASSES[name].floor);
    if (!isStringArray(review.allow_weaker) || review.allow_weaker.some(name => !floors.includes(name))) {
      errors.push(`\`review.allow_weaker\` must be an array of floor classes: ${floors.join(', ')}`);
    }
  }
}

/**
 * Returns an error for each floor class the `review` block routes to a group below the floor,
 * unless `allow_weaker` names the class. The built-in `pair` group is accepted even when both
 * of its finders resolve to one model, as they do on a non-Claude reviewer with no pair model.
 */
export function reviewFloorErrors(config: ReviewConfig): string[] {
  if (!config.review) return [];
  const routing = resolveRouting(config.review);
  const errors: string[] = [];
  for (const [name, c] of Object.entries(routing.classes)) {
    if (!c.floor || routing.allowWeaker.includes(name)) continue;
    const groupName = routeClass(routing, name);
    const group = routing.groups[groupName];
    if (group === BUILT_IN_GROUPS.pair) continue;
    const shortfall = floorShortfall(group, ref => resolveReviewerModel(config, ref));
    if (shortfall) {
      errors.push(`\`review\` routes the \`${name}\` floor class to the \`${groupName}\` group, but ${shortfall}. A floor class needs two finders on two distinct models, none at \`low\` effort. Route it to a stronger group, or list it in \`review.allow_weaker\` to accept the weaker review`);
    }
  }
  return errors;
}

function deepMerge(defaults: ReviewConfig, overrides: Record<string, unknown>): ReviewConfig {
  const result = { ...defaults };

  for (const key of Object.keys(overrides)) {
    if (!KNOWN_KEYS.has(key) || IGNORED_KEYS.has(key)) continue;

    const value = overrides[key];

    if (key === 'memory' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.memory = { ...defaults.memory, ...(value as Record<string, unknown>) } as ReviewConfig['memory'];
    } else if (key === 'models' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const { agents, ...incoming } = value as Record<string, unknown>;
      const models = { ...defaults.models, ...incoming } as NonNullable<ReviewConfig['models']>;
      if (!models.reviewer_pair && agents && typeof agents === 'object') {
        const reviewer = models.reviewer || defaults.models?.reviewer;
        const pair = Object.values(agents).find(m => typeof m === 'string' && m !== '' && m !== reviewer);
        if (pair) models.reviewer_pair = pair;
      }
      result.models = models;
    } else if (key === 'planner' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.planner = { ...defaults.planner, ...(value as Record<string, unknown>) } as ReviewConfig['planner'];
    } else if (key === 'static_analysis' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.static_analysis = { ...defaults.static_analysis, ...(value as Record<string, unknown>) } as ReviewConfig['static_analysis'];
    } else if (key === 'convergence' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.convergence = { ...defaults.convergence, ...(value as Record<string, unknown>) } as ReviewConfig['convergence'];
    } else if (key === 'exclude_paths' && Array.isArray(value)) {
      // Union with defaults so users adding a single pattern don't lose
      // built-in skips (`*.lock`, `dist/**`, `*.generated.*`).
      const userPatterns = value.filter((p): p is string => typeof p === 'string');
      result.exclude_paths = Array.from(new Set([...defaults.exclude_paths, ...userPatterns]));
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
export function loadConfigFromContent(content: string, source = '.manki.yml'): ReviewConfig {
  if (!content.trim()) {
    core.info('Empty config, using defaults');
    return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], memory: { ...DEFAULT_CONFIG.memory } };
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
    return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], memory: { ...DEFAULT_CONFIG.memory } };
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
export function loadStaticAnalysisConfig(content: string | null, source = '.manki.yml'): StaticAnalysisConfig {
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

export interface BaseReviewConfig {
  review?: ReviewRoutingConfig;
  /** The base branch's skip rules, when they validate. */
  skip?: Pick<ReviewConfig, (typeof SKIP_KEYS)[number]>;
  /** The base branch's `models`, with defaults, when its config file parses. */
  models?: ReviewConfig['models'];
  /**
   * `builtin` when the base branch has no `review` block, `base_unreadable` when its config could
   * not be read, and `base_invalid` when its `review` block fails validation or misses a floor.
   */
  source: 'base' | 'builtin' | 'base_unreadable' | 'base_invalid';
}

/**
 * Returns the `review` block and `models` of the base branch's config file. A file that cannot be
 * parsed, or a `review` block that fails validation, gives the built-in review groups, never the
 * PR's copy, so a broken base never blocks the PR that fixes it.
 */
export function loadReviewConfig(content: string | null, source = '.manki.yml'): BaseReviewConfig {
  // A base branch without a config file runs on the default models, so a PR cannot collapse those either.
  if (!content) return { models: DEFAULT_CONFIG.models, source: 'builtin' };
  let parsed: unknown;
  try {
    parsed = parseYaml(content);
  } catch (e) {
    core.warning(`Could not parse ${source} on the base branch, using the built-in review groups: ${e instanceof Error ? e.message : String(e)}`);
    return { source: 'base_unreadable' };
  }
  const root = isObject(parsed) ? parsed : {};
  const models = root.models !== undefined && validateConfig({ models: root.models }).valid
    ? deepMerge(DEFAULT_CONFIG, { models: root.models }).models
    : DEFAULT_CONFIG.models;
  const skip = loadSkipRules(root, source);
  if (root.review === undefined) return { models, ...(skip && { skip }), source: 'builtin' };
  const validation = validateConfig({ review: root.review });
  for (const warning of validation.warnings) core.warning(warning);
  if (!validation.valid) {
    core.warning(`Invalid \`review\` in ${source} on the base branch, using the built-in review groups: ${validation.errors.join('; ')}`);
    return { models, ...(skip && { skip }), source: 'base_invalid' };
  }
  return { review: root.review as ReviewRoutingConfig, models, ...(skip && { skip }), source: 'base' };
}

/** Returns the skip rules of a base config, or `undefined` when it sets none or they fail validation. */
function loadSkipRules(root: Record<string, unknown>, source: string): BaseReviewConfig['skip'] {
  const given = Object.fromEntries(SKIP_KEYS.filter(k => k in root).map(k => [k, root[k]]));
  if (Object.keys(given).length === 0) return undefined;
  const validation = validateConfig(given);
  if (!validation.valid) {
    core.warning(`Invalid skip rules in ${source} on the base branch, skipping no PR: ${validation.errors.join('; ')}`);
    return undefined;
  }
  return { skip_labels: [], skip_authors: [], skip_branches: [], ...given } as BaseReviewConfig['skip'];
}

/**
 * Returns the PR's config with the base branch's `review` block. When the PR's models would run both
 * finders of a pair on one model and the base branch's give two, the reviewer models come from the
 * base, so a PR cannot drop the second model. A base block that misses a floor gives the built-ins.
 */
export function applyBaseReviewConfig(head: ReviewConfig, base: BaseReviewConfig): { config: ReviewConfig; source: BaseReviewConfig['source'] } {
  if (JSON.stringify(head.review) !== JSON.stringify(base.review)) {
    core.info('This PR changes the `review` block. The change applies after merge: this round uses the base branch\'s review groups.');
  }
  let config: ReviewConfig = { ...head, review: base.review, skip_labels: [], skip_authors: [], skip_branches: [], ...base.skip };
  if (base.models) {
    const baseConfig: ReviewConfig = { ...DEFAULT_CONFIG, models: base.models };
    const onOneModel = (c: ReviewConfig) => modelIdentity(resolvePairModel(c)) === modelIdentity(resolveModel(c, 'reviewer'));
    if (onOneModel(config) && !onOneModel(baseConfig)) {
      const reviewer = resolveModel(baseConfig, 'reviewer');
      const reviewerPair = resolvePairModel(baseConfig);
      core.warning(`This PR's \`models\` run both finders on ${resolveModel(config, 'reviewer')}. This round keeps the base branch's ${reviewer} and ${reviewerPair}, so a PR cannot drop the second model.`);
      config = { ...config, models: { ...config.models, reviewer, reviewer_pair: reviewerPair } };
    }
  }
  const floorErrors = reviewFloorErrors(config);
  if (floorErrors.length > 0) {
    core.warning(`The base branch's \`review\` block misses a floor, using the built-in review groups: ${floorErrors.join('; ')}`);
    return { config: { ...config, review: undefined }, source: 'base_invalid' };
  }
  return { config, source: base.source };
}

export function loadConfigFromFile(filePath: string): ReviewConfig {
  if (!fs.existsSync(filePath)) {
    core.info(`Config file not found at ${filePath}, using defaults`);
    return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], memory: { ...DEFAULT_CONFIG.memory } };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    core.warning(`Failed to read config file at ${filePath}: ${msg}. Using defaults.`);
    return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], memory: { ...DEFAULT_CONFIG.memory } };
  }

  return loadConfigFromContent(content, filePath);
}

export function resolveModel(config: ReviewConfig, stage: 'planner' | 'reviewer' | 'judge' | 'dedup'): string {
  return config.models?.[stage] || DEFAULT_CONFIG.models![stage]!;
}

/**
 * Returns the model for the second finder: `models.reviewer_pair`, else the other Claude tier of the
 * reviewer model, else the reviewer model itself. The tier swap needs no credential beyond the reviewer's.
 */
export function resolvePairModel(config: ReviewConfig): string {
  return config.models?.reviewer_pair || otherClaudeTier(resolveModel(config, 'reviewer'));
}

/**
 * Returns the model a stage on `stageModel` moves to when a safety filter refuses it: `models.fallback`,
 * else `models.reviewer`. A stage already on that model moves to its other Claude tier instead.
 * Returns undefined when no other model is left.
 */
export function resolveFallbackModel(config: ReviewConfig, stageModel: string): string | undefined {
  const fallback = config.models?.fallback || resolveModel(config, 'reviewer');
  const model = sameModel(fallback, stageModel) ? otherClaudeTier(stageModel) : fallback;
  return sameModel(model, stageModel) ? undefined : model;
}

function sameModel(a: string, b: string): boolean {
  return a.replace(/^anthropic\//, '') === b.replace(/^anthropic\//, '');
}

/** Returns the other Claude tier of `model` (Sonnet for Opus and Haiku, Opus for Sonnet), or `model` itself for other providers. */
function otherClaudeTier(model: string): string {
  const id = model.replace(/^anthropic\//, '');
  if (id.startsWith('claude-opus-')) return SONNET_MODEL;
  if (id.startsWith('claude-sonnet-')) return OPUS_MODEL;
  if (id.startsWith('claude-haiku-')) return SONNET_MODEL;
  return model;
}

/** Returns the model a group reviewer runs on. `@reviewer` and `@reviewer_pair` resolve through `models`, and unset means `@reviewer`. */
export function resolveReviewerModel(config: ReviewConfig, ref: string | undefined): string {
  if (ref === undefined || ref === '@reviewer') return resolveModel(config, 'reviewer');
  if (ref === '@reviewer_pair') return resolvePairModel(config);
  return ref;
}

export function loadConfig(yamlContent: string | undefined, source?: string): ReviewConfig {
  if (!yamlContent) {
    core.info('No config content provided, using defaults');
    return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], memory: { ...DEFAULT_CONFIG.memory } };
  }

  return loadConfigFromContent(yamlContent, source);
}

/** Returns the memory repo as `owner/name`: `memory.repo`, or `<owner>/review-memory` when that is empty. */
export function resolveMemoryRepo(memory: { repo: string }, owner: string): string {
  return memory.repo || `${owner}/review-memory`;
}

export function sanitizeForkConfig(config: ReviewConfig): ReviewConfig {
  return {
    ...config,
    instructions: DEFAULT_CONFIG.instructions,
    reviewers: [...DEFAULT_CONFIG.reviewers],
    memory: { ...config.memory, repo: DEFAULT_CONFIG.memory.repo },
  };
}

/** Returns which of `config`'s skip rules the PR matches, such as `label "dependencies"`, or `undefined` when none does. */
export function matchSkipRule(config: ReviewConfig, facts: SkipFacts): string | undefined {
  const lower = (values: string[]) => values.map(v => v.toLowerCase());
  const label = facts.labels.find(l => lower(config.skip_labels ?? []).includes(l.toLowerCase()));
  if (label) return `label "${label}"`;
  if (facts.author && lower(config.skip_authors ?? []).includes(facts.author.toLowerCase())) return `author ${facts.author}`;
  const branch = (config.skip_branches ?? []).find(pattern => minimatch(facts.branch, pattern));
  if (branch) return `branch ${facts.branch}`;
  return undefined;
}
