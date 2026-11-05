import { applyBaseReviewConfig, DEFAULT_CONFIG, loadConfig, loadConfigFromContent, loadConfigFromFile, loadReviewConfig, loadStaticAnalysisConfig, resolveModel, resolvePairModel, reviewFloorErrors, sanitizeForkConfig } from './config';
import { ReviewConfig } from './types';

// Suppress @actions/core output during tests
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

jest.mock('fs');

import * as core from '@actions/core';
import * as fs from 'fs';

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
      expect(DEFAULT_CONFIG.noise_level).toBe('low');
      expect(DEFAULT_CONFIG.planner).toEqual({ enabled: true, paired: 'auto' });
      expect(DEFAULT_CONFIG.review_passes).toBe(1);
    });

    it('defaults models.reviewer to Sonnet and models.judge to Opus', () => {
      expect(DEFAULT_CONFIG.models?.reviewer).toBe('claude-sonnet-5-5');
      expect(DEFAULT_CONFIG.models?.judge).toBe('claude-opus-5-5');
      expect(DEFAULT_CONFIG.models?.planner).toBe('claude-haiku-5-5');
      expect(DEFAULT_CONFIG.models?.dedup).toBe('claude-haiku-5-5');
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
    it('defaults stats.hidden to true', () => {
      expect(DEFAULT_CONFIG.stats?.hidden).toBe(true);
      const config = loadConfigFromContent('');
      expect(config.stats?.hidden).toBe(true);
    });

    it('merges user-provided stats.hidden over defaults', () => {
      const config = loadConfigFromContent('stats:\n  hidden: false\n');
      expect(config.stats?.hidden).toBe(false);
    });

    it('keeps stats.hidden true when stats key is present but hidden is omitted', () => {
      const config = loadConfigFromContent('stats: {}');
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

  describe('metrics config', () => {
    it('leaves metrics.fix_rate unset by default and accepts a boolean', () => {
      expect(loadConfigFromContent('').metrics?.fix_rate).toBeUndefined();
      expect(loadConfigFromContent('metrics:\n  fix_rate: false\n').metrics?.fix_rate).toBe(false);
    });

    it('rejects non-boolean metrics.fix_rate and non-object metrics', () => {
      expect(() => loadConfigFromContent('metrics:\n  fix_rate: "no"\n')).toThrow(/metrics\.fix_rate/);
      expect(() => loadConfigFromContent('metrics: "nope"\n')).toThrow(/`metrics` must be an object/);
    });
  });

  describe('static_analysis config', () => {
    it('turns every source on by default and merges a partial block', () => {
      expect(loadConfigFromContent('').static_analysis).toEqual({ checks: true, code_scanning: true, dependency_review: true });
      expect(loadConfigFromContent('static_analysis:\n  code_scanning: false\n').static_analysis)
        .toEqual({ checks: true, code_scanning: false, dependency_review: true });
    });

    it('rejects a non-boolean source and a non-object block', () => {
      expect(() => loadConfigFromContent('static_analysis:\n  checks: "yes"\n')).toThrow(/static_analysis\.checks/);
      expect(() => loadConfigFromContent('static_analysis: true\n')).toThrow(/`static_analysis` must be an object/);
    });

    it('reads the block alone and falls back to the defaults when it is missing or invalid', () => {
      const defaults = { checks: true, code_scanning: true, dependency_review: true };
      expect(loadStaticAnalysisConfig('static_analysis:\n  checks: false\n')).toEqual({ ...defaults, checks: false });
      expect(loadStaticAnalysisConfig('unknown_key: 1\nstatic_analysis:\n  dependency_review: false\n'))
        .toEqual({ ...defaults, dependency_review: false });
      expect(loadStaticAnalysisConfig(null)).toEqual(defaults);
      expect(loadStaticAnalysisConfig('static_analysis:\n  checks: "no"\n')).toEqual(defaults);
      expect(loadStaticAnalysisConfig('static_analysis: [\n')).toEqual(defaults);
      expect(core.warning).not.toHaveBeenCalled();
    });
  });

  describe('review config', () => {
    const deep = 'review:\n  groups:\n    deep:\n      reviewers:\n        - { model: claude-opus-5-5, effort: high }\n        - { model: gpt-5.5, effort: high }\n';

    it('loads groups, classes and routing as written and leaves the built-ins when unset', () => {
      expect(loadConfigFromContent('').review).toBeUndefined();
      const config = loadConfigFromContent(`${deep}  classes:\n    security:\n      match: { paths_any: ["src/billing/**"] }\n    hot_path:\n      rank: 85\n      match: { paths_any: ["src/net/**"], triage: { subtle: true } }\n  routing:\n    security: deep\n    hot_path: deep\n    internal: solo\n  default_group: pair\n`);
      expect(config.review).toEqual({
        groups: { deep: { reviewers: [{ model: 'claude-opus-5-5', effort: 'high' }, { model: 'gpt-5.5', effort: 'high' }] } },
        classes: { security: { match: { paths_any: ['src/billing/**'] } }, hot_path: { rank: 85, match: { paths_any: ['src/net/**'], triage: { subtle: true } } } },
        routing: { security: 'deep', hot_path: 'deep', internal: 'solo' },
        default_group: 'pair',
      });
      expect(core.warning).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-object block', 'review: true\n', '`review` must be an object'],
      ['an empty group', 'review:\n  groups:\n    empty: { reviewers: [] }\n', '`review.groups.empty.reviewers` must be a non-empty array'],
      ['an unknown effort', 'review:\n  groups:\n    g: { reviewers: [{ effort: extreme }] }\n', '`review.groups.g.reviewers[0].effort` must be one of'],
      ['an unknown role', 'review:\n  groups:\n    g: { reviewers: [{ role: judge }] }\n', '`review.groups.g.reviewers[0].role` must be one of'],
      ['a route to an unknown group', 'review:\n  routing:\n    security: deep\n', '`review.routing.security` names unknown group `deep`'],
      ['a route for an unknown class', 'review:\n  routing:\n    hot_path: pair\n', '`review.routing.hot_path` routes an unknown class'],
      ['an unknown default group', 'review:\n  default_group: deep\n', '`review.default_group` names unknown group `deep`'],
      ['a rank another class has', 'review:\n  classes:\n    hot: { rank: 50, match: { paths_any: ["src/**"] } }\n', '`review.classes.hot.rank` 50 is already the rank of `behavior`'],
      ['a class without a rank', 'review:\n  classes:\n    hot: { match: { paths_any: ["src/**"] } }\n', '`review.classes.hot.rank` must be an integer'],
      ['a class without conditions', 'review:\n  classes:\n    hot: { rank: 60 }\n', '`review.classes.hot.match` must set'],
      ['an unknown condition', 'review:\n  classes:\n    hot: { rank: 60, match: { min_files: 3 } }\n', '`review.classes.hot.match.min_files` is not a known condition'],
      ['a user floor class', 'review:\n  classes:\n    hot: { rank: 60, floor: true, match: { paths_any: ["src/**"] } }\n', '`review.classes.hot.floor` is not allowed'],
      ['an unknown path alias', 'review:\n  classes:\n    hot: { rank: 60, match: { paths_any: ["@hot_paths"] } }\n', 'unknown path alias `@hot_paths`'],
      ['a new rank on a built-in class', 'review:\n  classes:\n    security: { rank: 10, match: { paths_any: ["src/**"] } }\n', '`review.classes.security` is built in: it takes only `match.paths_any`'],
      ['a change to a triage class', 'review:\n  classes:\n    docs: { match: { paths_any: ["docs/**"] } }\n', '`review.classes.docs` is built in and cannot be changed'],
      ['allow_weaker on a class that is no floor', 'review:\n  allow_weaker: [behavior]\n', '`review.allow_weaker` must be an array of floor classes'],
    ])('rejects %s', (_label, yaml, message) => {
      expect(() => loadConfigFromContent(yaml)).toThrow(message);
    });

    it('fails a floor class routed to a group below the floor unless `allow_weaker` names it', () => {
      const solo = 'review:\n  routing:\n    security: solo\n';
      expect(() => loadConfigFromContent(solo)).toThrow('routes the `security` floor class to the `solo` group, but it has fewer than two finders');
      expect(loadConfigFromContent(`${solo}  allow_weaker: [security]\n`).review?.allow_weaker).toEqual(['security']);

      for (const floor of ['supply_chain', 'data_contract']) {
        expect(() => loadConfigFromContent(`review:\n  routing:\n    ${floor}: trivial\n`)).toThrow(`the \`${floor}\` floor class`);
      }
      const sameModel = 'review:\n  groups:\n    twin:\n      reviewers: [{ model: gpt-5.5 }, { model: gpt-5.5 }]\n  routing:\n    security: twin\n';
      expect(() => loadConfigFromContent(sameModel)).toThrow('its finders run on fewer than two distinct models');
      const low = 'review:\n  groups:\n    cheap:\n      reviewers: [{ model: gpt-5.5, effort: low }, { model: claude-opus-5-5 }]\n  routing:\n    data_contract: cheap\n';
      expect(() => loadConfigFromContent(low)).toThrow('a reader runs at `low` effort');
      // Groups without routing send every class, floors included, to the default group.
      expect(() => loadConfigFromContent(`${deep}  default_group: solo\n`)).toThrow('the `security` floor class to the `solo` group');
      expect(loadConfigFromContent(`${deep}  default_group: deep\n`).review?.default_group).toBe('deep');
    });

    it('accepts the built-in `pair` group for a floor even when both finders resolve to one model', () => {
      const config = loadConfigFromContent('models:\n  reviewer: gpt-5.5\nreview:\n  routing:\n    internal: pair\n');
      expect(resolvePairModel(config)).toBe('gpt-5.5');
      expect(reviewFloorErrors(config)).toEqual([]);
      expect(reviewFloorErrors({ ...config, review: { groups: { pair: { reviewers: [{ model: 'gpt-5.5' }, { model: '@reviewer_pair' }] } } } })).toHaveLength(3);
    });

    it('reads the block and models from the base branch, with the built-ins when it is missing, unreadable or invalid', () => {
      const models = DEFAULT_CONFIG.models;
      expect(loadReviewConfig(null)).toEqual({ source: 'builtin' });
      expect(loadReviewConfig('auto_review: true\n')).toEqual({ models, source: 'builtin' });
      expect(loadReviewConfig('review: [\n')).toEqual({ source: 'base_unreadable' });
      expect(loadReviewConfig('models:\n  reviewer: gpt-5.5\nreview:\n  routing:\n    internal: pair\n'))
        .toEqual({ review: { routing: { internal: 'pair' } }, models: { ...models, reviewer: 'gpt-5.5' }, source: 'base' });
      expect(loadReviewConfig('review:\n  routing:\n    security: deep\n')).toEqual({ models, source: 'base_invalid' });
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Invalid `review` in .manki.yml on the base branch, using the built-in review groups'));
    });

    it('fails the PR that adds a floor class routed below the floor in its own config file', () => {
      jest.mocked(fs.existsSync).mockReturnValue(true);
      jest.mocked(fs.readFileSync).mockReturnValue('review:\n  routing:\n    security: solo\n');
      expect(() => loadConfigFromFile('/repo/.manki.yml')).toThrow('routes the `security` floor class to the `solo` group');
    });

    it('applies the base block, keeps two reviewer models, and falls back to the built-ins on a base floor miss', () => {
      const head = loadConfigFromContent('models:\n  reviewer: gpt-5.5\n  reviewer_pair: gpt-5.5\nreview:\n  routing:\n    internal: pair\n');
      const kept = applyBaseReviewConfig(head, { review: { routing: { internal: 'solo' } }, models: DEFAULT_CONFIG.models, source: 'base' });
      expect(kept.source).toBe('base');
      expect(kept.config.review).toEqual({ routing: { internal: 'solo' } });
      expect(kept.config.models).toEqual(expect.objectContaining({ reviewer: 'claude-sonnet-5-5', reviewer_pair: 'claude-opus-5-5' }));

      const baseOnOneModel = { ...DEFAULT_CONFIG.models, reviewer: 'gpt-5.5' };
      expect(applyBaseReviewConfig(head, { models: baseOnOneModel, source: 'builtin' }).config.models).toEqual(head.models);
      expect(applyBaseReviewConfig(head, { source: 'base_unreadable' }).config.models).toEqual(head.models);

      const missed = applyBaseReviewConfig(loadConfigFromContent(''), { review: { routing: { security: 'solo' } }, source: 'base' });
      expect([missed.source, missed.config.review]).toEqual(['base_invalid', undefined]);
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

    it('merges user exclude_paths with defaults and dedupes', () => {
      const yaml = `
exclude_paths:
  - "vendor/**"
  - "dist/**"
`;
      const config = loadConfigFromContent(yaml);
      for (const pattern of DEFAULT_CONFIG.exclude_paths) {
        expect(config.exclude_paths).toContain(pattern);
      }
      expect(config.exclude_paths).toContain('vendor/**');
      const distOccurrences = config.exclude_paths.filter(p => p === 'dist/**').length;
      expect(distOccurrences).toBe(1);
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

    it('throws on invalid YAML, naming the file and the parse error', () => {
      expect(() => loadConfigFromContent('auto_approve: [false\n', 'cfg/manki.yml'))
        .toThrow(/^Invalid YAML in cfg\/manki\.yml: .*Flow sequence/s);
      expect(() => loadConfigFromContent('{{{{not valid yaml')).toThrow(/^Invalid YAML in \.manki\.yml: /);
    });

    it('throws when the YAML root is not a mapping', () => {
      expect(() => loadConfigFromContent('- just\n- a\n- list')).toThrow('Invalid config in .manki.yml: the top level must be a mapping');
      expect(() => loadConfigFromContent('just a string')).toThrow('Invalid config in .manki.yml: the top level must be a mapping');
    });

    it('returns defaults for a comment-only file', () => {
      expect(loadConfigFromContent('# everything commented out\n# auto_approve: false\n')).toEqual(DEFAULT_CONFIG);
    });

    it('names the file in schema errors', () => {
      expect(() => loadConfigFromContent('auto_approve: "no"\n', 'cfg/manki.yml'))
        .toThrow(/^Invalid config in cfg\/manki\.yml: /);
    });

    it('accepts `review_level` and `review_thresholds` with a deprecation warning and drops them', () => {
      const config = loadConfigFromContent('review_level: large\nreview_thresholds:\n  small: 500\n  medium: 100\n');
      expect(config).toEqual(DEFAULT_CONFIG);
      for (const key of ['review_level', 'review_thresholds']) {
        expect(core.warning).toHaveBeenCalledWith(expect.stringContaining(`\`${key}\` is deprecated and ignored`));
      }
      expect(core.warning).not.toHaveBeenCalledWith(expect.stringContaining('Unknown config key'));
      const thresholds = jest.mocked(core.warning).mock.calls.map(c => String(c[0])).find(m => m.startsWith('`review_thresholds`'));
      expect(thresholds).toContain('the planner triage sets how many finders read each PR');
      expect(thresholds).not.toContain('planner.paired');
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
      expect(config.models?.judge).toBe('claude-opus-5-5');
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

    it('accepts `models.reviewer_pair` and rejects a non-string or empty one', () => {
      expect(loadConfigFromContent('models:\n  reviewer_pair: gpt-5.5\n').models?.reviewer_pair).toBe('gpt-5.5');
      for (const value of ['123', '""']) {
        expect(() => loadConfigFromContent(`models:\n  reviewer_pair: ${value}\n`)).toThrow('Invalid config');
        expect(core.error).toHaveBeenCalledWith('`models.reviewer_pair` must be a non-empty string');
      }
      expect(core.warning).not.toHaveBeenCalled();
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

    it('warns and ignores deprecated nit_handling values', () => {
      expect(() => loadConfigFromContent('nit_handling: issues')).not.toThrow();
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("`nit_handling: 'issues'` is deprecated"));

      jest.mocked(core.warning).mockClear();
      expect(() => loadConfigFromContent('nit_handling: comments')).not.toThrow();
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("`nit_handling: 'comments'` is deprecated"));

      jest.mocked(core.warning).mockClear();
      expect(() => loadConfigFromContent('nit_handling: email')).not.toThrow();
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining("`nit_handling: 'email'` is not a recognized value"));
    });

    it('accepts valid noise_level values', () => {
      expect(loadConfigFromContent('noise_level: low').noise_level).toBe('low');
      expect(loadConfigFromContent('noise_level: medium').noise_level).toBe('medium');
      expect(loadConfigFromContent('noise_level: high').noise_level).toBe('high');
    });

    it('throws on invalid noise_level value', () => {
      const yaml = 'noise_level: extreme';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`noise_level` must be one of: low, medium, high');
    });

    it('defaults noise_level to "low" when absent', () => {
      expect(loadConfigFromContent('').noise_level).toBe('low');
      expect(loadConfigFromContent('nit_handling: issues').noise_level).toBe('low');
    });

    it('deep-merges models object with defaults', () => {
      const yaml = `
models:
  reviewer: claude-haiku-4-5
`;
      const config = loadConfigFromContent(yaml);
      expect(config.models?.reviewer).toBe('claude-haiku-4-5');
      expect(config.models?.judge).toBe('claude-opus-5-5');
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

    it('throws on non-number concurrency_lock_ttl_seconds', () => {
      expect(() => loadConfigFromContent('concurrency_lock_ttl_seconds: "fast"'))
        .toThrow(/concurrency_lock_ttl_seconds/);
      expect(() => loadConfigFromContent('concurrency_lock_ttl_seconds: "fast"'))
        .toThrow(/3600/);
    });

    it('throws on non-finite concurrency_lock_ttl_seconds (Infinity)', () => {
      expect(() => loadConfigFromContent('concurrency_lock_ttl_seconds: .inf'))
        .toThrow(/concurrency_lock_ttl_seconds/);
    });

    it('throws on non-finite concurrency_lock_ttl_seconds (NaN)', () => {
      expect(() => loadConfigFromContent('concurrency_lock_ttl_seconds: .nan'))
        .toThrow(/concurrency_lock_ttl_seconds/);
    });

    it('throws on negative concurrency_lock_ttl_seconds', () => {
      expect(() => loadConfigFromContent('concurrency_lock_ttl_seconds: -1'))
        .toThrow(/concurrency_lock_ttl_seconds/);
    });

    it('throws on concurrency_lock_ttl_seconds exceeding 3600', () => {
      expect(() => loadConfigFromContent('concurrency_lock_ttl_seconds: 3601'))
        .toThrow(/concurrency_lock_ttl_seconds/);
    });

    it('accepts valid concurrency_lock_ttl_seconds', () => {
      const config = loadConfigFromContent('concurrency_lock_ttl_seconds: 300');
      expect(config.concurrency_lock_ttl_seconds).toBe(300);
    });
  });

  describe('resolveModel', () => {
    const baseConfig: ReviewConfig = {
      ...DEFAULT_CONFIG,
    };

    it('returns default stage-specific models from defaults', () => {
      expect(resolveModel(baseConfig, 'reviewer')).toBe('claude-sonnet-5-5');
      expect(resolveModel(baseConfig, 'judge')).toBe('claude-opus-5-5');
      expect(resolveModel(baseConfig, 'dedup')).toBe('claude-haiku-5-5');
      expect(resolveModel(baseConfig, 'planner')).toBe('claude-haiku-5-5');
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
      expect(resolveModel(config, 'reviewer')).toBe('claude-sonnet-5-5');
      expect(resolveModel(config, 'judge')).toBe('claude-opus-5-5');
      expect(resolveModel(config, 'dedup')).toBe('claude-haiku-5-5');
    });

    it('falls back to default model when stage key is missing', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: { reviewer: 'claude-sonnet-4-6' },
      };
      expect(resolveModel(config, 'reviewer')).toBe('claude-sonnet-4-6');
      expect(resolveModel(config, 'judge')).toBe('claude-opus-5-5');
    });

    it('falls back to default models when models is empty object', () => {
      const config: ReviewConfig = { ...baseConfig, models: {} };
      expect(resolveModel(config, 'reviewer')).toBe('claude-sonnet-5-5');
      expect(resolveModel(config, 'judge')).toBe('claude-opus-5-5');
      expect(resolveModel(config, 'dedup')).toBe('claude-haiku-5-5');
      expect(resolveModel(config, 'planner')).toBe('claude-haiku-5-5');
    });

    it('returns overridden planner model', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: { planner: 'claude-sonnet-4-6' },
      };
      expect(resolveModel(config, 'planner')).toBe('claude-sonnet-4-6');
    });
  });

  describe('resolvePairModel', () => {
    const withModels = (models: ReviewConfig['models']): ReviewConfig => ({ ...DEFAULT_CONFIG, models });

    it('pairs the reviewer with the other Claude tier when `reviewer_pair` is unset', () => {
      expect(resolvePairModel(DEFAULT_CONFIG)).toBe('claude-opus-5-5');
      expect(resolvePairModel(withModels({ reviewer: 'claude-sonnet-5-5' }))).toBe('claude-opus-5-5');
      expect(resolvePairModel(withModels({ reviewer: 'claude-opus-5-5' }))).toBe('claude-sonnet-5-5');
      expect(resolvePairModel(withModels({ reviewer: 'claude-haiku-5-5' }))).toBe('claude-sonnet-5-5');
      expect(resolvePairModel(withModels({ reviewer: 'claude-sonnet-4-6' }))).toBe('claude-opus-5-5');
      expect(resolvePairModel(withModels({ reviewer: 'claude-opus-4-7' }))).toBe('claude-sonnet-5-5');
      expect(resolvePairModel(withModels({ reviewer: 'anthropic/claude-opus-4-6' }))).toBe('claude-sonnet-5-5');
      expect(resolvePairModel(withModels({ reviewer: 'claude-haiku-4-5-20251001' }))).toBe('claude-sonnet-5-5');
    });

    it('keeps the reviewer model for other providers and honours `reviewer_pair`', () => {
      expect(resolvePairModel(withModels({ reviewer: 'gpt-5.5' }))).toBe('gpt-5.5');
      expect(resolvePairModel(withModels({ reviewer: 'claude-sonnet-4-6', reviewer_pair: 'gemini-3-pro' }))).toBe('gemini-3-pro');
    });
  });

  describe('models.agents config', () => {
    it('accepts `models.agents` with a deprecation warning and seeds `reviewer_pair` from its first other model', () => {
      const config = loadConfigFromContent(`
reviewers:
  - name: "Protocol Compliance"
    focus: "DIP compliance"
models:
  reviewer: claude-sonnet-5-5
  agents:
    "Correctness & Logic": claude-sonnet-5-5
    "Protocol Compliance": gpt-5.5
    "Security & Safety": claude-opus-5-5
`);
      expect(config.models).toEqual({ ...DEFAULT_CONFIG.models, reviewer_pair: 'gpt-5.5' });
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('`models.agents` is deprecated'));
    });

    it('keeps an explicit `reviewer_pair` and seeds nothing when every override names the reviewer model', () => {
      const pinned = loadConfigFromContent('models:\n  reviewer_pair: gemini-3-pro\n  agents:\n    "Security & Safety": claude-opus-4-7\n');
      expect(pinned.models?.reviewer_pair).toBe('gemini-3-pro');
      const same = loadConfigFromContent('models:\n  agents:\n    "Security & Safety": claude-sonnet-5-5\n');
      expect(same.models).toEqual(DEFAULT_CONFIG.models);
    });

    it.each([
      ['an empty model', '"Security & Safety": ""', /`models.agents.Security & Safety` must be a non-empty string/],
      ['a number', '"Security & Safety": 42', /`models.agents.Security & Safety` must be a non-empty string/],
      ['a list', '- "Security & Safety"', /`models.agents` must be an object/],
    ])('rejects %s', (_label, entry, expected) => {
      expect(() => loadConfig(`models:\n  agents:\n    ${entry}\n`)).toThrow(expected);
    });

    it('rejects a non-object `models.agents`', () => {
      expect(() => loadConfig('models:\n  agents: "not a map"\n')).toThrow(/`models.agents` must be an object/);
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

    it('accepts each `planner.paired` pin and rejects any other value', () => {
      for (const pin of ['auto', 'always', 'never']) {
        expect(loadConfig(`planner:\n  paired: ${pin}\n`).planner).toEqual({ enabled: true, paired: pin });
      }
      expect(() => loadConfig('planner:\n  paired: sometimes\n')).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`planner.paired` must be one of: auto, always, never');
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('`planner.paired` is deprecated. Route classes to review groups with `review.routing` instead'));
    });
  });

  describe('exclude_paths element type validation', () => {
    it('throws when exclude_paths contains a non-string element', () => {
      expect(() => loadConfigFromContent('exclude_paths:\n  - "*.lock"\n  - 42\n'))
        .toThrow(/exclude_paths\[1\]/);
    });

    it('throws when exclude_paths contains a boolean element', () => {
      expect(() => loadConfigFromContent('exclude_paths:\n  - true\n'))
        .toThrow(/exclude_paths\[0\]/);
    });

    it('keeps default exclude_paths when user supplies an empty array', () => {
      const config = loadConfigFromContent('exclude_paths: []');
      expect(config.exclude_paths).toEqual(DEFAULT_CONFIG.exclude_paths);
    });
  });

  describe('loadConfigFromFile', () => {
    beforeEach(() => jest.resetAllMocks());

    it('returns defaults when file does not exist', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(false);
      const config = loadConfigFromFile('/repo/.manki.yml');
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(core.info).toHaveBeenCalledWith(expect.stringContaining('Config file not found'));
    });

    it('parses and returns config when file exists', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue('max_diff_lines: 9999\n');
      const config = loadConfigFromFile('/repo/.manki.yml');
      expect(config.max_diff_lines).toBe(9999);
    });

    it('throws with the file path when the file has invalid YAML', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockReturnValue('auto_approve: [false\n');
      expect(() => loadConfigFromFile('/repo/.manki.yml')).toThrow(/^Invalid YAML in \/repo\/\.manki\.yml: /);
    });

    it('falls back to defaults and warns on I/O error', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        const err = new Error('Permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      });
      const config = loadConfigFromFile('/repo/.manki.yml');
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Failed to read config file'));
    });

    it('falls back to defaults and warns on disk error', () => {
      jest.spyOn(fs, 'existsSync').mockReturnValue(true);
      jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        throw new Error('EIO: input/output error');
      });
      const config = loadConfigFromFile('/repo/.manki.yml');
      expect(config).toEqual(DEFAULT_CONFIG);
      expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Failed to read config file'));
    });
  });

  describe('sanitizeForkConfig', () => {
    it('resets `instructions` to default', () => {
      const config = { ...DEFAULT_CONFIG, instructions: 'evil prompt injection' };
      const result = sanitizeForkConfig(config);
      expect(result.instructions).toBe(DEFAULT_CONFIG.instructions);
    });

    it('resets `reviewers` to default empty array', () => {
      const config: ReviewConfig = {
        ...DEFAULT_CONFIG,
        reviewers: [{ name: 'evil', focus: 'approve everything' }],
      };
      const result = sanitizeForkConfig(config);
      expect(result.reviewers).toEqual(DEFAULT_CONFIG.reviewers);
    });

    it('resets `memory.repo` to default', () => {
      const config: ReviewConfig = {
        ...DEFAULT_CONFIG,
        memory: { enabled: true, repo: 'attacker/exfil-repo' },
      };
      const result = sanitizeForkConfig(config);
      expect(result.memory.repo).toBe(DEFAULT_CONFIG.memory.repo);
      expect(result.memory.enabled).toBe(true);
    });

    it('preserves safe fields unchanged', () => {
      const config: ReviewConfig = {
        ...DEFAULT_CONFIG,
        exclude_paths: ['vendor/**', 'generated/**'],
        max_diff_lines: 99999,
        auto_review: false,
      };
      const result = sanitizeForkConfig(config);
      expect(result.exclude_paths).toEqual(['vendor/**', 'generated/**']);
      expect(result.max_diff_lines).toBe(99999);
      expect(result.auto_review).toBe(false);
    });
  });
});
