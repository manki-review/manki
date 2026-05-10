import { DEFAULT_CONFIG, loadConfig, loadConfigFromContent, resolveAgentModel, resolveModel } from './config';
import { ReviewConfig } from './types';

// Suppress @actions/core output during tests
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as core from '@actions/core';

describe('config', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('DEFAULT_CONFIG', () => {
    it('has all required fields with valid types', () => {
      expect(typeof DEFAULT_CONFIG.auto_review).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.auto_approve).toBe('boolean');
      expect(Array.isArray(DEFAULT_CONFIG.exclude_paths)).toBe(true);
      expect(typeof DEFAULT_CONFIG.max_diff_lines).toBe('number');
      expect(DEFAULT_CONFIG.max_diff_lines).toBeGreaterThan(0);
      expect(Array.isArray(DEFAULT_CONFIG.reviewers)).toBe(true);
      expect(DEFAULT_CONFIG.reviewers.length).toBe(0);
      expect(typeof DEFAULT_CONFIG.instructions).toBe('string');
      expect(typeof DEFAULT_CONFIG.memory).toBe('object');
      expect(typeof DEFAULT_CONFIG.memory.enabled).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.memory.repo).toBe('string');
      expect(DEFAULT_CONFIG.nit_handling).toBe('issues');
      expect(DEFAULT_CONFIG.review_level).toBe('auto');
      expect(DEFAULT_CONFIG.review_thresholds).toEqual({ small: 200, medium: 1000 });
      expect(DEFAULT_CONFIG.review_passes).toBe(1);
    });

    it('defaults models.reviewer to Sonnet and models.judge to Opus', () => {
      expect(DEFAULT_CONFIG.models?.reviewer).toBe('claude-sonnet-4-6');
      expect(DEFAULT_CONFIG.models?.judge).toBe('claude-opus-4-7');
      expect(DEFAULT_CONFIG.models?.planner).toBe('claude-haiku-4-5');
      expect(DEFAULT_CONFIG.models?.dedup).toBe('claude-haiku-4-5');
    });

    it('has no default custom reviewers', () => {
      expect(DEFAULT_CONFIG.reviewers).toEqual([]);
    });

    it('exposes default convergence settings', () => {
      expect(DEFAULT_CONFIG.convergence?.max_auto_rounds).toBe(5);
      expect(DEFAULT_CONFIG.convergence?.suppress_resolved_threads).toBe(true);
      expect(DEFAULT_CONFIG.convergence?.test_path_patterns).toContain('**/*.test.*');
      expect(DEFAULT_CONFIG.convergence?.test_path_patterns).toContain('**/__tests__/**');
    });
  });

  describe('convergence config', () => {
    it('merges user-provided convergence overrides with defaults', () => {
      const config = loadConfigFromContent('convergence:\n  max_auto_rounds: 3\n');
      expect(config.convergence?.max_auto_rounds).toBe(3);
      expect(config.convergence?.suppress_resolved_threads).toBe(true);
    });

    it('rejects negative max_auto_rounds', () => {
      expect(() => loadConfigFromContent('convergence:\n  max_auto_rounds: -1\n'))
        .toThrow(/max_auto_rounds/);
    });

    it('rejects non-integer max_auto_rounds', () => {
      expect(() => loadConfigFromContent('convergence:\n  max_auto_rounds: 1.5\n'))
        .toThrow(/max_auto_rounds/);
    });

    it('rejects non-array test_path_patterns', () => {
      expect(() => loadConfigFromContent('convergence:\n  test_path_patterns: "not-an-array"\n'))
        .toThrow(/test_path_patterns/);
    });

    it('rejects non-boolean suppress_resolved_threads', () => {
      expect(() => loadConfigFromContent('convergence:\n  suppress_resolved_threads: "yes"\n'))
        .toThrow(/suppress_resolved_threads/);
    });
  });

  describe('stats config', () => {
    it('defaults stats.hidden to false', () => {
      expect(DEFAULT_CONFIG.stats?.hidden).toBe(false);
      const config = loadConfigFromContent('');
      expect(config.stats?.hidden).toBe(false);
    });

    it('merges user-provided stats.hidden over defaults', () => {
      const config = loadConfigFromContent('stats:\n  hidden: true\n');
      expect(config.stats?.hidden).toBe(true);
    });

    it('rejects non-boolean stats.hidden', () => {
      expect(() => loadConfigFromContent('stats:\n  hidden: "yes"\n'))
        .toThrow(/stats\.hidden/);
    });

    it('rejects non-object stats', () => {
      expect(() => loadConfigFromContent('stats: "nope"\n'))
        .toThrow(/`stats` must be an object/);
    });
  });

  describe('loadConfig', () => {
    it('returns defaults when no content provided', () => {
      const config = loadConfig(undefined);
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('returns defaults for empty string', () => {
      const config = loadConfig('');
      expect(config).toEqual(DEFAULT_CONFIG);
    });
  });

  describe('loadConfigFromContent', () => {
    it('returns defaults for empty YAML', () => {
      const config = loadConfigFromContent('');
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('returns defaults for whitespace-only YAML', () => {
      const config = loadConfigFromContent('   \n  \n  ');
      expect(config).toEqual(DEFAULT_CONFIG);
    });

    it('merges partial config over defaults', () => {
      const yaml = `
max_diff_lines: 5000
`;
      const config = loadConfigFromContent(yaml);
      expect(config.max_diff_lines).toBe(5000);
      // Other fields remain default
      expect(config.auto_review).toBe(DEFAULT_CONFIG.auto_review);
      expect(config.reviewers).toEqual(DEFAULT_CONFIG.reviewers);
      expect(config.exclude_paths).toEqual(DEFAULT_CONFIG.exclude_paths);
    });

    it('replaces reviewers array entirely', () => {
      const yaml = `
reviewers:
  - name: "Custom Reviewer"
    focus: "custom focus area"
`;
      const config = loadConfigFromContent(yaml);
      expect(config.reviewers).toHaveLength(1);
      expect(config.reviewers[0].name).toBe('Custom Reviewer');
      expect(config.reviewers[0].focus).toBe('custom focus area');
    });

    it('replaces exclude_paths array entirely', () => {
      const yaml = `
exclude_paths:
  - "vendor/**"
`;
      const config = loadConfigFromContent(yaml);
      expect(config.exclude_paths).toEqual(['vendor/**']);
    });

    it('deep-merges memory object', () => {
      const yaml = `
memory:
  enabled: true
`;
      const config = loadConfigFromContent(yaml);
      expect(config.memory.enabled).toBe(true);
      expect(config.memory.repo).toBe('');
    });

    it('warns on unknown keys but does not fail', () => {
      const yaml = `
auto_review: true
unknown_key: some_value
another_unknown: 123
`;
      const config = loadConfigFromContent(yaml);
      expect(config.auto_review).toBe(true);
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "unknown_key"');
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "another_unknown"');
    });

    it('throws on invalid max_diff_lines', () => {
      const yaml = 'max_diff_lines: -5';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('throws on non-number max_diff_lines', () => {
      const yaml = 'max_diff_lines: "big"';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('throws on invalid auto_review type', () => {
      const yaml = 'auto_review: "yes"';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('throws on invalid reviewers structure', () => {
      const yaml = 'reviewers: "not an array"';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('throws on reviewer missing name', () => {
      const yaml = `
reviewers:
  - focus: "some focus"
`;
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('throws on reviewer missing focus', () => {
      const yaml = `
reviewers:
  - name: "Some Name"
`;
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('validates memory.repo format - valid', () => {
      const yaml = `
memory:
  enabled: true
  repo: "owner/repo-name"
`;
      const config = loadConfigFromContent(yaml);
      expect(config.memory.repo).toBe('owner/repo-name');
    });

    it('validates memory.repo format - invalid', () => {
      const yaml = `
memory:
  repo: "not-a-valid-repo-format/with/extra"
`;
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('allows empty memory.repo', () => {
      const yaml = `
memory:
  enabled: true
  repo: ""
`;
      const config = loadConfigFromContent(yaml);
      expect(config.memory.repo).toBe('');
    });

    it('handles invalid YAML gracefully', () => {
      const yaml = '{{{{not valid yaml';
      const config = loadConfigFromContent(yaml);
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to parse config YAML')
      );
    });

    it('handles YAML that parses to non-object', () => {
      const yaml = '- just\n- a\n- list';
      const config = loadConfigFromContent(yaml);
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(core.warning).toHaveBeenCalledWith('Config YAML root must be an object. Using defaults.');
    });

    it('throws when review_thresholds.small >= review_thresholds.medium', () => {
      const yaml = `
review_thresholds:
  small: 500
  medium: 100
`;
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('throws when review_thresholds.small equals review_thresholds.medium', () => {
      const yaml = `
review_thresholds:
  small: 200
  medium: 200
`;
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('throws when partial threshold override causes small >= medium after merge', () => {
      const yaml = `
review_thresholds:
  small: 1500
`;
      // After merge: small=1500, medium=1000 (default) => small >= medium
      expect(() => loadConfigFromContent(yaml)).toThrow('review_thresholds.small');
    });

    it('ignores unknown keys during merge', () => {
      const yaml = `
auto_review: false
unknown_thing: true
`;
      const config = loadConfigFromContent(yaml);
      expect(config.auto_review).toBe(false);
      expect((config as unknown as Record<string, unknown>)['unknown_thing']).toBeUndefined();
    });

    it('accepts valid models object', () => {
      const yaml = `
models:
  reviewer: claude-sonnet-4-6
  judge: claude-opus-4-6
`;
      const config = loadConfigFromContent(yaml);
      expect(config.models?.reviewer).toBe('claude-sonnet-4-6');
      expect(config.models?.judge).toBe('claude-opus-4-6');
    });

    it('accepts partial models object and merges with defaults', () => {
      const yaml = `
models:
  reviewer: claude-sonnet-4-6
`;
      const config = loadConfigFromContent(yaml);
      expect(config.models?.reviewer).toBe('claude-sonnet-4-6');
      expect(config.models?.judge).toBe('claude-opus-4-7');
    });

    it('throws on invalid models type', () => {
      const yaml = 'models: "not an object"';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('throws on invalid models.reviewer type', () => {
      const yaml = `
models:
  reviewer: 123
`;
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`models.reviewer` must be a string');
    });

    it('throws on invalid models.judge type', () => {
      const yaml = `
models:
  judge: true
`;
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`models.judge` must be a string');
    });

    it('throws on invalid models.planner type', () => {
      const yaml = `
models:
  planner: 99
`;
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`models.planner` must be a string');
    });

    it('throws on invalid models.dedup type', () => {
      const yaml = `
models:
  dedup: 42
`;
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`models.dedup` must be a string');
    });

    it('accepts valid nit_handling values', () => {
      const yamlIssues = 'nit_handling: issues';
      expect(loadConfigFromContent(yamlIssues).nit_handling).toBe('issues');

      const yamlComments = 'nit_handling: comments';
      expect(loadConfigFromContent(yamlComments).nit_handling).toBe('comments');
    });

    it('throws on invalid nit_handling value', () => {
      const yaml = 'nit_handling: email';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`nit_handling` must be "issues" or "comments"');
    });

    it('deep-merges models object with defaults', () => {
      const yaml = `
models:
  reviewer: claude-haiku-4-5
`;
      const config = loadConfigFromContent(yaml);
      expect(config.models?.reviewer).toBe('claude-haiku-4-5');
      expect(config.models?.judge).toBe('claude-opus-4-7');
    });

    it('accepts valid review_passes values', () => {
      expect(loadConfigFromContent('review_passes: 1').review_passes).toBe(1);
      expect(loadConfigFromContent('review_passes: 3').review_passes).toBe(3);
      expect(loadConfigFromContent('review_passes: 5').review_passes).toBe(5);
    });

    it('defaults review_passes to 1', () => {
      const config = loadConfigFromContent('auto_review: true');
      expect(config.review_passes).toBe(1);
    });

    it('throws on review_passes less than 1', () => {
      expect(() => loadConfigFromContent('review_passes: 0')).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`review_passes` must be an integer between 1 and 5');
    });

    it('throws on review_passes greater than 5', () => {
      expect(() => loadConfigFromContent('review_passes: 6')).toThrow('Invalid config');
    });

    it('throws on non-integer review_passes', () => {
      expect(() => loadConfigFromContent('review_passes: 2.5')).toThrow('Invalid config');
    });

    it('throws on non-number review_passes', () => {
      expect(() => loadConfigFromContent('review_passes: "three"')).toThrow('Invalid config');
    });
  });

  describe('resolveModel', () => {
    const baseConfig: ReviewConfig = {
      ...DEFAULT_CONFIG,
    };

    it('returns default stage-specific models from defaults', () => {
      expect(resolveModel(baseConfig, 'reviewer')).toBe('claude-sonnet-4-6');
      expect(resolveModel(baseConfig, 'judge')).toBe('claude-opus-4-7');
      expect(resolveModel(baseConfig, 'dedup')).toBe('claude-haiku-4-5');
      expect(resolveModel(baseConfig, 'planner')).toBe('claude-haiku-4-5');
    });

    it('returns overridden stage-specific model', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: { reviewer: 'claude-haiku-4-5', judge: 'claude-sonnet-4-6', dedup: 'claude-sonnet-4-6' },
      };
      expect(resolveModel(config, 'reviewer')).toBe('claude-haiku-4-5');
      expect(resolveModel(config, 'judge')).toBe('claude-sonnet-4-6');
      expect(resolveModel(config, 'dedup')).toBe('claude-sonnet-4-6');
    });

    it('falls back to default models when models is undefined', () => {
      const config: ReviewConfig = { ...baseConfig, models: undefined };
      expect(resolveModel(config, 'reviewer')).toBe('claude-sonnet-4-6');
      expect(resolveModel(config, 'judge')).toBe('claude-opus-4-7');
      expect(resolveModel(config, 'dedup')).toBe('claude-haiku-4-5');
    });

    it('falls back to default model when stage key is missing', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: { reviewer: 'claude-sonnet-4-6' },
      };
      expect(resolveModel(config, 'reviewer')).toBe('claude-sonnet-4-6');
      expect(resolveModel(config, 'judge')).toBe('claude-opus-4-7');
    });

    it('falls back to default models when models is empty object', () => {
      const config: ReviewConfig = { ...baseConfig, models: {} };
      expect(resolveModel(config, 'reviewer')).toBe('claude-sonnet-4-6');
      expect(resolveModel(config, 'judge')).toBe('claude-opus-4-7');
      expect(resolveModel(config, 'dedup')).toBe('claude-haiku-4-5');
      expect(resolveModel(config, 'planner')).toBe('claude-haiku-4-5');
    });

    it('returns overridden planner model', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: { planner: 'claude-sonnet-4-6' },
      };
      expect(resolveModel(config, 'planner')).toBe('claude-sonnet-4-6');
    });
  });

  describe('resolveAgentModel', () => {
    const baseConfig: ReviewConfig = { ...DEFAULT_CONFIG };

    it('returns per-agent override when present', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: {
          reviewer: 'claude-sonnet-4-6',
          agents: { 'Security & Safety': 'claude-opus-4-7' },
        },
      };
      expect(resolveAgentModel(config, 'Security & Safety', 'reviewer')).toBe('claude-opus-4-7');
    });

    it('falls back to stage default when no per-agent override', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: {
          reviewer: 'claude-haiku-4-5',
          agents: { 'Security & Safety': 'claude-opus-4-7' },
        },
      };
      expect(resolveAgentModel(config, 'Architecture & Design', 'reviewer')).toBe('claude-haiku-4-5');
    });

    it('falls back to built-in default when no stage override and no agent override', () => {
      const config: ReviewConfig = { ...baseConfig, models: undefined };
      expect(resolveAgentModel(config, 'Security & Safety', 'reviewer')).toBe('claude-sonnet-4-6');
    });

    it('falls back to built-in default when models.agents is undefined', () => {
      const config: ReviewConfig = { ...baseConfig, models: { reviewer: 'claude-haiku-4-5' } };
      expect(resolveAgentModel(config, 'Security & Safety', 'reviewer')).toBe('claude-haiku-4-5');
    });

    it('resolves the per-agent override regardless of stage', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: {
          planner: 'claude-haiku-4-5',
          judge: 'claude-opus-4-7',
          dedup: 'claude-haiku-4-5',
          agents: { 'Security & Safety': 'claude-opus-4-7' },
        },
      };
      expect(resolveAgentModel(config, 'Security & Safety', 'planner')).toBe('claude-opus-4-7');
      expect(resolveAgentModel(config, 'Security & Safety', 'judge')).toBe('claude-opus-4-7');
      expect(resolveAgentModel(config, 'Security & Safety', 'dedup')).toBe('claude-opus-4-7');
    });

    it('falls back to the requested stage default for non-overridden agents', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: {
          planner: 'planner-model',
          judge: 'judge-model',
          dedup: 'dedup-model',
          reviewer: 'reviewer-model',
        },
      };
      expect(resolveAgentModel(config, 'Architecture & Design', 'planner')).toBe('planner-model');
      expect(resolveAgentModel(config, 'Architecture & Design', 'judge')).toBe('judge-model');
      expect(resolveAgentModel(config, 'Architecture & Design', 'dedup')).toBe('dedup-model');
    });
  });

  describe('models.agents config', () => {
    it('accepts per-agent overrides for built-in agents', () => {
      const yaml = `
models:
  reviewer: claude-sonnet-4-6
  agents:
    "Security & Safety": claude-opus-4-7
`;
      const config = loadConfig(yaml);
      expect(config.models?.agents?.['Security & Safety']).toBe('claude-opus-4-7');
    });

    it('accepts per-agent overrides for custom reviewers declared in config', () => {
      const yaml = `
reviewers:
  - name: "Protocol Compliance"
    focus: "DIP compliance"
models:
  agents:
    "Protocol Compliance": claude-opus-4-7
`;
      const config = loadConfig(yaml);
      expect(config.models?.agents?.['Protocol Compliance']).toBe('claude-opus-4-7');
    });

    it('rejects unknown agent names with a list of known agents', () => {
      const yaml = `
models:
  agents:
    "Foo": claude-opus-4-7
`;
      expect(() => loadConfig(yaml)).toThrow(/Unknown agent name "Foo" in `models.agents`. Known agents: /);
    });

    it('rejects empty model string for an agent', () => {
      const yaml = `
models:
  agents:
    "Security & Safety": ""
`;
      expect(() => loadConfig(yaml)).toThrow(/`models.agents.Security & Safety` must be a non-empty string/);
    });

    it('rejects non-object models.agents', () => {
      const yaml = `
models:
  agents: "not a map"
`;
      expect(() => loadConfig(yaml)).toThrow(/`models.agents` must be an object/);
    });

    it('omits agents key when not provided', () => {
      const config = loadConfig('models:\n  reviewer: claude-sonnet-4-6\n');
      expect(config.models?.agents).toBeUndefined();
    });

    it('rejects non-string (number) value for an agent override', () => {
      const yaml = `
models:
  agents:
    "Security & Safety": 42
`;
      expect(() => loadConfig(yaml)).toThrow(/`models.agents.Security & Safety` must be a non-empty string/);
    });

    it('rejects array value for models.agents', () => {
      const yaml = `
models:
  agents:
    - "Security & Safety"
`;
      expect(() => loadConfig(yaml)).toThrow(/`models.agents` must be an object/);
    });

    it('points malformed reviewer entries at the right error when an override targets them', () => {
      const yaml = `
reviewers:
  - name: "Protocol Compliance"
models:
  agents:
    "Protocol Compliance": claude-opus-4-7
`;
      expect(() => loadConfig(yaml)).toThrow(/Agent "Protocol Compliance" in `models.agents` matches a reviewer declared under `reviewers:` but that entry is invalid/);
    });

    it('merges per-agent overrides through deepMerge without dropping prior entries', () => {
      const config = loadConfigFromContent(`
reviewers:
  - name: "Protocol Compliance"
    focus: "DIP compliance"
models:
  agents:
    "Security & Safety": claude-opus-4-7
    "Protocol Compliance": claude-haiku-4-5
`);
      expect(config.models?.agents).toEqual({
        'Security & Safety': 'claude-opus-4-7',
        'Protocol Compliance': 'claude-haiku-4-5',
      });
    });
  });

  describe('planner config', () => {
    it('accepts planner key in config validation', () => {
      const config = loadConfig('planner:\n  enabled: false\n');
      expect(config.planner?.enabled).toBe(false);
    });

    it('defaults planner to enabled', () => {
      const config = loadConfig(undefined);
      expect(config.planner?.enabled).toBe(true);
    });

    it('rejects invalid planner.enabled type', () => {
      expect(() => loadConfig('planner:\n  enabled: "yes"\n')).toThrow();
    });
  });
});
