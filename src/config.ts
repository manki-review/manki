import * as core from '@actions/core';
import * as fs from 'fs';
import { parse as parseYaml } from 'yaml';

import { ReviewConfig, ReviewerAgent } from './types';

const DEFAULT_REVIEWERS: ReviewerAgent[] = [
  {
    name: 'Security & Correctness',
    focus: 'bugs, vulnerabilities, memory safety, data integrity, input validation, crypto correctness, no key exposure, integer overflow, no panics in library code',
  },
  {
    name: 'Architecture & Quality',
    focus: 'design patterns, simplicity, maintainability, code reuse, naming conventions, idiomatic usage, dead code, over-engineering, appropriate visibility modifiers',
  },
  {
    name: 'Testing & Edge Cases',
    focus: 'test coverage, error paths, boundary conditions, race conditions, missing assertions, test quality, edge cases in error handling',
  },
];

export const DEFAULT_CONFIG: ReviewConfig = {
  model: 'claude-opus-4-6',
  auto_review: true,
  auto_approve: true,
  review_language: 'en',
  include_paths: ['**/*'],
  exclude_paths: ['*.lock', 'dist/**', '*.generated.*'],
  max_diff_lines: 10000,
  reviewers: DEFAULT_REVIEWERS,
  instructions: '',
  review_level: 'auto',
  review_thresholds: { small: 200, medium: 1000 },
  memory: {
    enabled: false,
    repo: '',
  },
  nit_handling: 'issues',
};

const KNOWN_KEYS = new Set([
  'model',
  'auto_review',
  'auto_approve',
  'review_language',
  'include_paths',
  'exclude_paths',
  'max_diff_lines',
  'reviewers',
  'instructions',
  'review_level',
  'review_thresholds',
  'memory',
  'models',
  'nit_handling',
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

  for (const key of Object.keys(config)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`Unknown config key: "${key}"`);
    }
  }

  if ('model' in config && typeof config.model !== 'string') {
    errors.push('`model` must be a string');
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

  if ('review_language' in config && typeof config.review_language !== 'string') {
    errors.push('`review_language` must be a string');
  }

  if ('instructions' in config && typeof config.instructions !== 'string') {
    errors.push('`instructions` must be a string');
  }

  if ('include_paths' in config) {
    if (!Array.isArray(config.include_paths)) {
      errors.push('`include_paths` must be an array of strings');
    }
  }

  if ('exclude_paths' in config) {
    if (!Array.isArray(config.exclude_paths)) {
      errors.push('`exclude_paths` must be an array of strings');
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
      if ('reviewer' in models && typeof models.reviewer !== 'string') {
        errors.push('`models.reviewer` must be a string');
      }
      if ('judge' in models && typeof models.judge !== 'string') {
        errors.push('`models.judge` must be a string');
      }
    }
  }

  if ('nit_handling' in config) {
    if (config.nit_handling !== 'issues' && config.nit_handling !== 'comments') {
      errors.push('`nit_handling` must be "issues" or "comments"');
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
      result.models = { ...defaults.models, ...(value as Record<string, unknown>) } as ReviewConfig['models'];
    } else if (key === 'review_thresholds' && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result.review_thresholds = { ...defaults.review_thresholds, ...(value as Record<string, unknown>) } as ReviewConfig['review_thresholds'];
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

  const content = fs.readFileSync(filePath, 'utf-8');
  return loadConfigFromContent(content);
}

export function loadConfig(yamlContent: string | undefined): ReviewConfig {
  if (!yamlContent) {
    core.info('No config content provided, using defaults');
    return { ...DEFAULT_CONFIG, reviewers: [...DEFAULT_CONFIG.reviewers], memory: { ...DEFAULT_CONFIG.memory } };
  }

  return loadConfigFromContent(yamlContent);
}
