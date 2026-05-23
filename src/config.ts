import * as core from '@actions/core';
import * as fs from 'fs';
import { parse as parseYaml } from 'yaml';

import { buildAgentPool } from './agents';
import { ReviewerAgent, ReviewConfig } from './types';

export const MAX_LOCK_TTL_SECONDS = 3600;

export const DEFAULT_CONFIG: ReviewConfig = {
  auto_review: true,
  auto_approve: true,
  exclude_paths: ['*.lock', 'dist/**', '*.generated.*'],
  max_diff_lines: 50000,
  reviewers: [],
  instructions: '',
  review_level: 'auto',
  review_thresholds: { small: 200, medium: 1000 },
  models: {
    planner: 'claude-haiku-4-5',
    reviewer: 'claude-sonnet-4-6',
    judge: 'claude-opus-4-7',
    dedup: 'claude-haiku-4-5',
  },
  planner: {
    enabled: true,
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
  stats: {
    hidden: false,
  },
  concurrency_lock_ttl_seconds: 600,
};

const KNOWN_KEYS = new Set([
  'auto_review',
  'auto_approve',
  'exclude_paths',
  'max_diff_lines',
  'reviewers',
  'instructions',
  'review_level',
  'review_thresholds',
  'memory',
  'models',
  'planner',
  'nit_handling',
  'noise_level',
  'review_passes',
  'convergence',
  'stats',
  'concurrency_lock_ttl_seconds',
]);

const REPO_FORMAT = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

interface ConfigValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

function validateConfig(config: Record<string, unknown>): ConfigValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const customReviewers = Array.isArray(config.reviewers)
    ? (config.reviewers as Array<Record<string, unknown>>)
        .filter(r => r && typeof r === 'object' && typeof r.name === 'string' && typeof r.focus === 'string')
        .map(r => ({ name: r.name as string, focus: r.focus as string }))
    : [];
  const knownAgentNames = new Set(buildAgentPool(customReviewers as ReviewerAgent[]).map(a => a.name));
  const declaredReviewerNames = new Set(
    Array.isArray(config.reviewers)
      ? (config.reviewers as Array<Record<string, unknown>>)
          .filter(r => r && typeof r === 'object' && typeof r.name === 'string' && (r.name as string).length > 0)
          .map(r => r.name as string)
      : [],
  );

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
    const valid = ['auto', 'small', 'medium', 'large'];
    if (typeof config.review_level !== 'string' || !valid.includes(config.review_level)) {
      errors.push('`review_level` must be one of: auto, small, medium, large');
    }
  }

  if ('review_thresholds' in config) {
    const thresholds = config.review_thresholds as Record<string, unknown>;
    if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
      errors.push('`review_thresholds` must be an object');
    } else {
      if ('small' in thresholds && (typeof thresholds.small !== 'number' || thresholds.small <= 0)) {
        errors.push('`review_thresholds.small` must be a positive number');
      }
      if ('medium' in thresholds && (typeof thresholds.medium !== 'number' || thresholds.medium <= 0)) {
        errors.push('`review_thresholds.medium` must be a positive number');
      }
      if (
        typeof thresholds.small === 'number' && typeof thresholds.medium === 'number' &&
        thresholds.small >= thresholds.medium
      ) {
        errors.push('`review_thresholds.small` must be less than `review_thresholds.medium`');
      }
    }
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
      if ('judge' in models && typeof models.judge !== 'string') {
        errors.push('`models.judge` must be a string');
      }
      if ('dedup' in models && typeof models.dedup !== 'string') {
        errors.push('`models.dedup` must be a string');
      }
      if ('agents' in models) {
        const agents = models.agents as Record<string, unknown>;
        if (!agents || typeof agents !== 'object' || Array.isArray(agents)) {
          errors.push('`models.agents` must be an object mapping agent names to model strings');
        } else {
          for (const [agentName, modelValue] of Object.entries(agents)) {
            if (typeof modelValue !== 'string' || modelValue === '') {
              errors.push(`\`models.agents.${agentName}\` must be a non-empty string`);
              continue;
            }
            if (!knownAgentNames.has(agentName)) {
              if (declaredReviewerNames.has(agentName)) {
                errors.push(`Agent "${agentName}" in \`models.agents\` matches a reviewer declared under \`reviewers:\` but that entry is invalid. Check its \`name\` and \`focus\` fields.`);
              } else {
                const known = Array.from(knownAgentNames).map(n => `"${n}"`).join(', ');
                errors.push(`Unknown agent name "${agentName}" in \`models.agents\`. Known agents: ${known}`);
              }
            }
          }
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
    const stats = config.stats as Record<string, unknown>;
    if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
      errors.push('`stats` must be an object');
    } else {
      if ('hidden' in stats && typeof stats.hidden !== 'boolean') {
        errors.push('`stats.hidden` must be a boolean');
      }
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

function deepMerge(defaults: ReviewConfig, overrides: Record<string, unknown>): ReviewConfig {
  const result = { ...defaults };

  for (const key of Object.keys(overrides)) {
    if (!KNOWN_KEYS.has(key)) continue;

    const value = overrides[key];

    if (key === 'memory' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.memory = { ...defaults.memory, ...(value as Record<string, unknown>) } as ReviewConfig['memory'];
    } else if (key === 'models' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const incoming = value as Record<string, unknown>;
      const incomingAgents = incoming.agents as Record<string, string> | undefined;
      const existingAgents = defaults.models?.agents;
      const merged = { ...defaults.models, ...incoming } as ReviewConfig['models'];
      if (merged) {
        merged.agents = (existingAgents || incomingAgents)
          ? { ...(existingAgents ?? {}), ...(incomingAgents ?? {}) }
          : undefined;
      }
      result.models = merged;
    } else if (key === 'planner' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.planner = { ...defaults.planner, ...(value as Record<string, unknown>) } as ReviewConfig['planner'];
    } else if (key === 'review_thresholds' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.review_thresholds = { ...defaults.review_thresholds, ...(value as Record<string, unknown>) } as ReviewConfig['review_thresholds'];
    } else if (key === 'convergence' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.convergence = { ...defaults.convergence, ...(value as Record<string, unknown>) } as ReviewConfig['convergence'];
    } else if (key === 'stats' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.stats = { ...defaults.stats, ...(value as Record<string, unknown>) } as ReviewConfig['stats'];
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

export function loadConfigFromContent(content: string): ReviewConfig {
  if (!content.trim()) {
    core.info('Empty config, using defaults');
    return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], memory: { ...DEFAULT_CONFIG.memory } };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(content) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    core.warning(`Failed to parse config YAML: ${msg}. Using defaults.`);
    return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], memory: { ...DEFAULT_CONFIG.memory } };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    core.warning('Config YAML root must be an object. Using defaults.');
    return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], memory: { ...DEFAULT_CONFIG.memory } };
  }

  const validation = validateConfig(parsed);

  for (const warning of validation.warnings) {
    core.warning(warning);
  }

  if (!validation.valid) {
    for (const error of validation.errors) {
      core.error(error);
    }
    throw new Error(`Invalid config: ${validation.errors.join('; ')}`);
  }

  const merged = deepMerge(DEFAULT_CONFIG, parsed);

  if (merged.review_thresholds.small >= merged.review_thresholds.medium) {
    throw new Error('Invalid config: `review_thresholds.small` must be less than `review_thresholds.medium`');
  }

  return merged;
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

  return loadConfigFromContent(content);
}

export function resolveModel(config: ReviewConfig, stage: 'planner' | 'reviewer' | 'judge' | 'dedup'): string {
  return config.models?.[stage] || DEFAULT_CONFIG.models![stage]!;
}

/**
 * Resolves the model for a specific reviewer agent. Resolution order:
 * `models.agents[agentName]` → `models[stage]` → built-in default for `stage`.
 */
export function resolveAgentModel(
  config: ReviewConfig,
  agentName: string,
  stage: 'planner' | 'reviewer' | 'judge' | 'dedup',
): string {
  const override = config.models?.agents?.[agentName];
  if (override) return override;
  return resolveModel(config, stage);
}

export function loadConfig(yamlContent: string | undefined): ReviewConfig {
  if (!yamlContent) {
    core.info('No config content provided, using defaults');
    return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], memory: { ...DEFAULT_CONFIG.memory } };
  }

  return loadConfigFromContent(yamlContent);
}

export function sanitizeForkConfig(config: ReviewConfig): ReviewConfig {
  return {
    ...config,
    instructions: DEFAULT_CONFIG.instructions,
    reviewers: [...DEFAULT_CONFIG.reviewers],
    memory: { ...config.memory, repo: DEFAULT_CONFIG.memory.repo },
  };
}
