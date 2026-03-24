import { DEFAULT_CONFIG, loadConfig, loadConfigFromContent } from './config';

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
      expect(typeof DEFAULT_CONFIG.model).toBe('string');
      expect(typeof DEFAULT_CONFIG.auto_review).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.auto_approve).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.review_language).toBe('string');
      expect(Array.isArray(DEFAULT_CONFIG.include_paths)).toBe(true);
      expect(Array.isArray(DEFAULT_CONFIG.exclude_paths)).toBe(true);
      expect(typeof DEFAULT_CONFIG.max_diff_lines).toBe('number');
      expect(DEFAULT_CONFIG.max_diff_lines).toBeGreaterThan(0);
      expect(Array.isArray(DEFAULT_CONFIG.reviewers)).toBe(true);
      expect(DEFAULT_CONFIG.reviewers.length).toBe(3);
      expect(typeof DEFAULT_CONFIG.instructions).toBe('string');
      expect(typeof DEFAULT_CONFIG.memory).toBe('object');
      expect(typeof DEFAULT_CONFIG.memory.enabled).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.memory.repo).toBe('string');
      expect(DEFAULT_CONFIG.review_level).toBe('auto');
      expect(DEFAULT_CONFIG.review_thresholds).toEqual({ small: 200, medium: 1000 });
    });

    it('has three default reviewers with name and focus', () => {
      for (const reviewer of DEFAULT_CONFIG.reviewers) {
        expect(typeof reviewer.name).toBe('string');
        expect(reviewer.name.length).toBeGreaterThan(0);
        expect(typeof reviewer.focus).toBe('string');
        expect(reviewer.focus.length).toBeGreaterThan(0);
      }
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
model: claude-sonnet-4-20250514
max_diff_lines: 5000
`;
      const config = loadConfigFromContent(yaml);
      expect(config.model).toBe('claude-sonnet-4-20250514');
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

    it('replaces include_paths array entirely', () => {
      const yaml = `
include_paths:
  - "src/**"
  - "lib/**"
`;
      const config = loadConfigFromContent(yaml);
      expect(config.include_paths).toEqual(['src/**', 'lib/**']);
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
model: claude-opus-4-6
unknown_key: some_value
another_unknown: 123
`;
      const config = loadConfigFromContent(yaml);
      expect(config.model).toBe('claude-opus-4-6');
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "unknown_key"');
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "another_unknown"');
    });

    it('throws on invalid model type', () => {
      const yaml = 'model: 123';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`model` must be a string');
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
model: claude-sonnet-4-20250514
unknown_thing: true
`;
      const config = loadConfigFromContent(yaml);
      expect(config.model).toBe('claude-sonnet-4-20250514');
      expect((config as unknown as Record<string, unknown>)['unknown_thing']).toBeUndefined();
    });
  });
});
