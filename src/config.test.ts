import { changedKeys, DEFAULT_CONFIG, fallbackConfig, loadConfig, loadConfigFromContent, loadStaticAnalysisConfig, resolveFallbackModel, resolveModel, resolvePairModel, reviewFloorErrors } from './config';
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
      expect(DEFAULT_CONFIG.convergence?.max_auto_rounds).toBe(10);
      expect(DEFAULT_CONFIG.convergence?.rounds_after_restart).toBe(3);
      expect(DEFAULT_CONFIG.convergence?.suppress_resolved_threads).toBe(true);
      expect(DEFAULT_CONFIG.convergence?.test_path_patterns).toContain('**/*.test.*');
      expect(DEFAULT_CONFIG.convergence?.test_path_patterns).toContain('**/__tests__/**');
    });
  });

  describe('convergence config', () => {
    it('merges user-provided convergence overrides with defaults', () => {
      const config = loadConfigFromContent('convergence:\n  max_auto_rounds: 3\n');
      expect(config.convergence?.max_auto_rounds).toBe(3);
      expect(config.convergence?.rounds_after_restart).toBe(3);
      expect(config.convergence?.suppress_resolved_threads).toBe(true);
      expect(loadConfigFromContent('convergence:\n  rounds_after_restart: 0\n').convergence?.rounds_after_restart).toBe(0);
    });

    it.each(['max_auto_rounds', 'rounds_after_restart'])('rejects a negative, fractional or non-numeric %s', key => {
      for (const value of ['-1', '1.5', 'three']) {
        expect(() => loadConfigFromContent(`convergence:\n  ${key}: ${value}\n`)).toThrow(`\`convergence.${key}\` must be a non-negative integer`);
      }
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
    const defaults = { checks: true, code_scanning: true, dependency_review: true, wait_for_checks: [], wait_timeout_seconds: 300, analyzers: {} };

    it('turns every CI source on and every analyzer off by default, and merges a partial block', () => {
      expect(loadConfigFromContent('').static_analysis).toEqual(defaults);
      expect(loadConfigFromContent('static_analysis:\n  code_scanning: false\n').static_analysis)
        .toEqual({ ...defaults, code_scanning: false });
      expect(loadConfigFromContent('static_analysis:\n  wait_for_checks: [lint]\n  wait_timeout_seconds: 60\n  analyzers: all\n').static_analysis)
        .toEqual({ ...defaults, wait_for_checks: ['lint'], wait_timeout_seconds: 60, analyzers: 'all' });
      expect(loadConfigFromContent('static_analysis:\n  analyzers:\n    ast_grep: true\n    secrets: true\n    dependencies: false\n    semgrep:\n      rules: [.semgrep/manki.yml, rules/extra.yaml]\n    actionlint: false\n    zizmor: true\n    shellcheck: false\n').static_analysis?.analyzers)
        .toEqual({ ast_grep: true, secrets: true, dependencies: false, semgrep: { rules: ['.semgrep/manki.yml', 'rules/extra.yaml'] }, actionlint: false, zizmor: true, shellcheck: false });
      expect(loadConfigFromContent('static_analysis:\n  analyzers:\n    semgrep: false\n').static_analysis?.analyzers).toEqual({ semgrep: false });
    });

    it('rejects a non-boolean source, a bad wait, an unknown analyzer and a non-object block', () => {
      expect(() => loadConfigFromContent('static_analysis:\n  checks: "yes"\n')).toThrow(/static_analysis\.checks/);
      expect(() => loadConfigFromContent('static_analysis: true\n')).toThrow(/`static_analysis` must be an object/);
      expect(() => loadConfigFromContent('static_analysis:\n  wait_for_checks: lint\n')).toThrow(/wait_for_checks/);
      expect(() => loadConfigFromContent('static_analysis:\n  wait_for_checks: [""]\n')).toThrow(/wait_for_checks/);
      for (const timeout of ['0', '1.5', '3601', '"300"']) {
        expect(() => loadConfigFromContent(`static_analysis:\n  wait_timeout_seconds: ${timeout}\n`)).toThrow(/wait_timeout_seconds/);
      }
      expect(() => loadConfigFromContent('static_analysis:\n  analyzers: some\n')).toThrow(/`static_analysis.analyzers` must be `all` or an object/);
      expect(() => loadConfigFromContent('static_analysis:\n  analyzers:\n    astgrep: true\n')).toThrow(/`static_analysis.analyzers.astgrep` is not a known analyzer/);
      expect(() => loadConfigFromContent('static_analysis:\n  analyzers:\n    ast_grep: "on"\n')).toThrow(/`static_analysis.analyzers.ast_grep` must be a boolean/);
      for (const semgrep of ['true', '{ rules: [] }', '{ rules: [p/default] }', '{ rules: [/etc/rules.yml] }', '{ rules: [../rules.yml] }', '{ rules: ["https://example.com/r.yml"] }', '{ rules: [rules.json] }']) {
        expect(() => loadConfigFromContent(`static_analysis:\n  analyzers:\n    semgrep: ${semgrep}\n`)).toThrow(/`static_analysis.analyzers.semgrep` must be `false` or `\{ rules: \[...\] \}`/);
      }
    });

    it('reads the block alone and falls back to the defaults when it is missing or invalid', () => {
      expect(loadStaticAnalysisConfig('static_analysis:\n  checks: false\n')).toEqual({ ...defaults, checks: false });
      expect(loadStaticAnalysisConfig('unknown_key: 1\nstatic_analysis:\n  dependency_review: false\n'))
        .toEqual({ ...defaults, dependency_review: false });
      expect(loadStaticAnalysisConfig(null)).toEqual(defaults);
      expect(loadStaticAnalysisConfig('static_analysis:\n  checks: "no"\n')).toEqual(defaults);
      expect(loadStaticAnalysisConfig('static_analysis: [\n')).toEqual(defaults);
      expect(core.warning).not.toHaveBeenCalled();
    });
  });

  describe('related_repos config', () => {
    const repos = [
      { repo: 'dashpay/dash', kind: 'reference', ref: 'v23.0.0', paths: ['src/', './doc/*.md'] },
      { repo: 'dashpay/dips', kind: 'reference' },
      { repo: 'dashpay/platform', kind: 'consumer', paths: ['packages/rs-*'] },
    ];
    const yaml = 'related_repos:\n  - { repo: dashpay/dash, kind: reference, ref: v23.0.0, paths: [src/, ./doc/*.md] }\n  - { repo: dashpay/dips, kind: reference }\n  - { repo: dashpay/platform, kind: consumer, paths: ["packages/rs-*"] }\n';

    it('loads the entries as written, and none by default', () => {
      expect(loadConfigFromContent('').related_repos).toEqual([]);
      expect(loadConfigFromContent(yaml).related_repos).toEqual(repos);
      const commit = '0123456789abcdef0123456789abcdef01234567';
      expect(loadConfigFromContent(`related_repos:\n  - { repo: dashpay/dash, kind: reference, ref: ${commit} }\n`).related_repos?.[0].ref).toBe(commit);
      expect(loadConfigFromContent('related_repos:\n  - { repo: dashpay/dash, kind: reference, ref: refs/tags/20240115 }\n').related_repos?.[0].ref).toBe('refs/tags/20240115');
      expect(core.warning).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-list block', 'related_repos: dashpay/dash\n', '`related_repos` must be a list of repos'],
      ['a non-object entry', 'related_repos: [dashpay/dash]\n', '`related_repos[0]` must be an object'],
      ['a repo without an owner', 'related_repos: [{ repo: dash, kind: reference }]\n', '`related_repos[0].repo` must be in "owner/name" format'],
      ['a repo outside the cache directory', 'related_repos: [{ repo: ../.., kind: reference }]\n', '`related_repos[0].repo` must be in "owner/name" format'],
      ['a repo listed twice', 'related_repos: [{ repo: dashpay/dash, kind: reference }, { repo: DashPay/Dash, kind: consumer }]\n', '`related_repos[1].repo` lists DashPay/Dash a second time'],
      ['a missing kind', 'related_repos: [{ repo: dashpay/dash }]\n', '`related_repos[0].kind` must be one of: reference, consumer'],
      ['an unknown kind', 'related_repos: [{ repo: dashpay/dash, kind: upstream }]\n', '`related_repos[0].kind` must be one of: reference, consumer'],
      ['a ref that reads as an option', 'related_repos: [{ repo: dashpay/dash, kind: reference, ref: --upload-pack=x }]\n', '`related_repos[0].ref` must be a branch, tag or commit name'],
      ['an abbreviated commit', 'related_repos: [{ repo: dashpay/dash, kind: reference, ref: 0123abcd }]\n', '`related_repos[0].ref` looks like an abbreviated commit. Use the full hash, or `refs/tags/0123abcd` or `refs/heads/0123abcd`'],
      ['a ref with `..`', 'related_repos: [{ repo: dashpay/dash, kind: reference, ref: a..b }]\n', '`related_repos[0].ref` must be a branch, tag or commit name'],
      ['empty paths', 'related_repos: [{ repo: dashpay/dash, kind: reference, paths: [] }]\n', '`related_repos[0].paths` must be a list of 1 to 20 paths'],
      ['an absolute path', 'related_repos: [{ repo: dashpay/dash, kind: reference, paths: [/etc] }]\n', '`related_repos[0].paths` has `/etc`'],
      ['a path out of the repo', 'related_repos: [{ repo: dashpay/dash, kind: reference, paths: [src/../..] }]\n', '`related_repos[0].paths` has `src/../..`'],
      ['a negated path', 'related_repos: [{ repo: dashpay/dash, kind: reference, paths: ["!src"] }]\n', '`related_repos[0].paths` has `!src`'],
      ['a path with a line break', 'related_repos: [{ repo: dashpay/dash, kind: reference, paths: ["src\\n/etc"] }]\n', '`related_repos[0].paths` has `src\n/etc`'],
    ])('rejects %s', (_label, content, message) => {
      expect(() => loadConfigFromContent(content)).toThrow(message);
    });

    it('rejects more than ten repos, and warns about an unknown key', () => {
      const many = Array.from({ length: 11 }, (_, i) => `  - { repo: o/r${i}, kind: consumer }`).join('\n');
      expect(() => loadConfigFromContent(`related_repos:\n${many}\n`)).toThrow('`related_repos` lists 11 repos, at most 10 are allowed');
      loadConfigFromContent('related_repos: [{ repo: dashpay/dash, kind: reference, token: x }]\n');
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "related_repos[0].token"');
    });
  });

  describe('review config', () => {
    const deep = 'review:\n  groups:\n    deep:\n      reviewers:\n        - { model: claude-opus-5-5, effort: high }\n        - { model: gpt-5.5, effort: xhigh }\n';

    it('loads groups, classes and routing as written and leaves the built-ins when unset', () => {
      expect(loadConfigFromContent('').review).toBeUndefined();
      const config = loadConfigFromContent(`${deep}  classes:\n    security:\n      match: { paths_any: ["src/billing/**"] }\n    hot_path:\n      rank: 85\n      match: { paths_any: ["src/net/**"], triage: { subtle: true } }\n  routing:\n    security: deep\n    hot_path: deep\n    internal: solo\n  default_group: pair\n  critical_paths: ["src/consensus/**", "@security_paths"]\n  outside_input: Messages from network peers.\n  examples:\n    blocker:\n      - A panic on a peer message.\n    not_blocker:\n      - A slow RPC call.\n  sweep: true\n  notes: 0\n  rules: block\n`);
      expect(config.review).toEqual({
        groups: { deep: { reviewers: [{ model: 'claude-opus-5-5', effort: 'high' }, { model: 'gpt-5.5', effort: 'xhigh' }] } },
        classes: {
          security: { match: { paths_any: ['src/billing/**'] } },
          hot_path: { rank: 85, match: { paths_any: ['src/net/**'], triage: { subtle: true } } },
        },
        routing: { security: 'deep', hot_path: 'deep', internal: 'solo' },
        default_group: 'pair',
        critical_paths: ['src/consensus/**', '@security_paths'],
        outside_input: 'Messages from network peers.',
        examples: { blocker: ['A panic on a peer message.'], not_blocker: ['A slow RPC call.'] },
        sweep: true,
        notes: 0,
        rules: 'block',
      });
      expect(core.warning).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-object block', 'review: true\n', '`review` must be an object'],
      ['an empty group', 'review:\n  groups:\n    empty: { reviewers: [] }\n', '`review.groups.empty.reviewers` must be a non-empty array'],
      ['an unknown effort', 'review:\n  groups:\n    g: { reviewers: [{ effort: extreme }] }\n', '`review.groups.g.reviewers[0].effort` must be one of: low, medium, high, xhigh, max, auto'],
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
      ['a critical class', 'review:\n  classes:\n    hot: { rank: 60, critical: true, match: { paths_any: ["src/**"] } }\n', '`review.classes.hot.critical` is not a class setting. List the critical paths in `review.critical_paths`'],
      ['a critical built-in class', 'review:\n  classes:\n    security: { critical: true, match: { paths_any: ["src/**"] } }\n', '`review.classes.security.critical` is not a class setting. List the critical paths in `review.critical_paths`'],
      ['empty critical paths', 'review:\n  critical_paths: []\n', '`review.critical_paths` must be a non-empty array of strings'],
      ['critical paths with an unknown alias', 'review:\n  critical_paths: ["src/**", "@hot_paths"]\n', '`review.critical_paths` names unknown path alias `@hot_paths`'],
      ['an empty outside_input', 'review:\n  outside_input: "  "\n', '`review.outside_input` must be a non-empty string'],
      ['outside_input that is no string', 'review:\n  outside_input: [peers]\n', '`review.outside_input` must be a non-empty string'],
      ['a sweep that is no boolean', 'review:\n  sweep: "yes"\n', '`review.sweep` must be true or false'],
      ['a negative number of notes', 'review:\n  notes: -1\n', '`review.notes` must be a non-negative integer'],
      ['a fractional number of notes', 'review:\n  notes: 2.5\n', '`review.notes` must be a non-negative integer'],
      ['notes that are no number', 'review:\n  notes: "3"\n', '`review.notes` must be a non-negative integer'],
      ['an unknown rules mode', 'review:\n  rules: error\n', '`review.rules` must be `warn` or `block`'],
      ['a rules mode that is no string', 'review:\n  rules: true\n', '`review.rules` must be `warn` or `block`'],
      ['examples as a plain list', 'review:\n  examples: [A panic.]\n', '`review.examples` must set `blocker`, `not_blocker` or both'],
      ['empty examples', 'review:\n  examples: {}\n', '`review.examples` must set `blocker`, `not_blocker` or both'],
      ['an unknown example side', 'review:\n  examples:\n    warning: [A slow call.]\n', '`review.examples.warning` is not a known side'],
      ['an empty example side', 'review:\n  examples:\n    blocker: []\n', '`review.examples.blocker` must be a non-empty array of strings'],
      ['examples that are no strings', 'review:\n  examples:\n    not_blocker: [{ text: x }]\n', '`review.examples.not_blocker` must be a non-empty array of strings'],
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
      for (const twin of ['[{ model: gpt-5.5 }, { model: gpt-5.5 }]', '[{ model: claude-sonnet-5-5 }, { model: anthropic/claude-sonnet-5-5 }]']) {
        const sameModel = `review:\n  groups:\n    twin:\n      reviewers: ${twin}\n  routing:\n    security: twin\n`;
        expect(() => loadConfigFromContent(sameModel)).toThrow('its finders run on fewer than two distinct models');
      }
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

    it('fails the PR that adds a floor class routed below the floor in its own config file', () => {
      expect(() => loadConfigFromContent('review:\n  routing:\n    security: solo\n', '.manki.yml')).toThrow('routes the `security` floor class to the `solo` group');
    });

    it('loads and validates the skip rules', () => {
      expect(DEFAULT_CONFIG).toEqual(expect.objectContaining({ skip_labels: [], skip_authors: [], skip_branches: [] }));
      expect(loadConfigFromContent('skip_labels: ["wip"]\nskip_authors: ["me"]\n')).toEqual(expect.objectContaining({ skip_labels: ['wip'], skip_authors: ['me'] }));
      expect(() => loadConfigFromContent('skip_branches: ["", "main"]\n')).toThrow('`skip_branches` must be an array of non-empty strings');
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

    it('reads `project` and `instructions` as strings, empty by default', () => {
      expect(loadConfigFromContent('').project).toBe('');
      expect(loadConfigFromContent('project: blockchain consensus library\n').project).toBe('blockchain consensus library');
      expect(() => loadConfigFromContent('project: [a, b]\n')).toThrow(/`project` must be a string/);
      expect(() => loadConfigFromContent('instructions: 5\n')).toThrow(/`instructions` must be a string/);
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

    it('replaces the default exclude_paths with the repository\'s list, so an empty list excludes nothing', () => {
      expect(loadConfigFromContent('exclude_paths:\n  - "vendor/**"\n  - "dist/**"\n').exclude_paths).toEqual(['vendor/**', 'dist/**']);
      expect(loadConfigFromContent('exclude_paths: []').exclude_paths).toEqual([]);
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
nit_handling: comments
`;
      const config = loadConfigFromContent(yaml);
      expect(config.auto_review).toBe(true);
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "unknown_key"');
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "another_unknown"');
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "nit_handling"');
    });

    it('warns on unknown keys inside each block that takes an object, and not on the keys it knows', () => {
      loadConfigFromContent(`
reviewers: [{ name: a, focus: b, fokus: c }]
planner: { enabled: true, enabeld: false }
static_analysis: { checks: true, code_scanning: true, dependency_review: true, wait_for_checks: [ci], wait_timeout_seconds: 60, analyzers: all, check: false }
convergence: { max_auto_rounds: 3, test_path_patterns: ['**/*.test.ts'], suppress_resolved_threads: true, max_rounds: 2 }
metrics: { fix_rate: true, fixrate: false }
memory: { enabled: false, repo: '', repository: x/y }
`);
      const unknown = jest.mocked(core.warning).mock.calls.map(c => String(c[0])).filter(m => m.startsWith('Unknown config key'));
      expect(unknown).toEqual([
        'Unknown config key: "reviewers[0].fokus"',
        'Unknown config key: "planner.enabeld"',
        'Unknown config key: "static_analysis.check"',
        'Unknown config key: "convergence.max_rounds"',
        'Unknown config key: "metrics.fixrate"',
        'Unknown config key: "memory.repository"',
      ]);
    });

    it('throws on invalid max_diff_lines', () => {
      const yaml = 'max_diff_lines: -5';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('throws on non-number max_diff_lines', () => {
      const yaml = 'max_diff_lines: "big"';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it('defaults the review size limits to 15,000, 8,000 and 1,500 lines, and accepts only positive whole numbers', () => {
      expect([DEFAULT_CONFIG.max_diff_lines, DEFAULT_CONFIG.auto_review_max_lines, DEFAULT_CONFIG.slice_lines]).toEqual([15_000, 8_000, 1_500]);
      expect(loadConfigFromContent('auto_review_max_lines: 4000\nslice_lines: 900\n')).toEqual(expect.objectContaining({ auto_review_max_lines: 4000, slice_lines: 900 }));
      for (const yaml of ['auto_review_max_lines: 0', 'slice_lines: 1.5', 'slice_lines: "big"']) {
        expect(() => loadConfigFromContent(yaml)).toThrow('must be a positive whole number');
      }
      expect(() => loadConfigFromContent('slice_lines: 199')).toThrow('`slice_lines` must be at least 200');
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

    it('accepts `review_level`, `review_thresholds` and `stats` with a deprecation warning and drops them', () => {
      const config = loadConfigFromContent('review_level: large\nreview_thresholds:\n  small: 500\n  medium: 100\nstats:\n  hidden: false\n');
      expect(config).toEqual(DEFAULT_CONFIG);
      for (const key of ['review_level', 'review_thresholds', 'stats']) {
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

    it.each(['reviewer_pair', 'refuter_pair', 'fallback'])('accepts `models.%s` and rejects a non-string or empty one', (key) => {
      expect(loadConfigFromContent(`models:\n  ${key}: gpt-5.5\n`).models?.[key as 'reviewer_pair' | 'refuter_pair' | 'fallback']).toBe('gpt-5.5');
      for (const value of ['123', '""']) {
        expect(() => loadConfigFromContent(`models:\n  ${key}: ${value}\n`)).toThrow('Invalid config');
        expect(core.error).toHaveBeenCalledWith(`\`models.${key}\` must be a non-empty string`);
      }
      expect(core.warning).not.toHaveBeenCalled();
    });

    it.each([
      ['models:\n  reviewer: gemini/--yolo\n', '`models.reviewer`: Invalid model id "--yolo" in "gemini/--yolo"'],
      ['models:\n  judge: claude/-x\n', '`models.judge`: Invalid model id "-x" in "claude/-x"'],
      ['models:\n  planner: claude-haiku 5\n', '`models.planner`: Invalid model id "claude-haiku 5"'],
      ['models:\n  fallback: -x\n', '`models.fallback`: Invalid model id "-x"'],
      ['models:\n  dedup: mistral-large\n', '`models.dedup`: Unknown model "mistral-large"'],
      ['review:\n  groups:\n    g: { reviewers: [{ model: "openai/--sandbox" }, { model: "@reviewer_pair" }] }\n', '`review.groups.g.reviewers[0].model`: Invalid model id "--sandbox"'],
    ])('rejects a model id a CLI could read as an option: %s', (yaml, message) => {
      expect(() => loadConfigFromContent(yaml)).toThrow(message);
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

    it('defaults `author_clear_role` to maintain, accepts the three roles, and rejects anything else', () => {
      expect(loadConfigFromContent('').author_clear_role).toBe('maintain');
      expect(loadConfig(undefined).author_clear_role).toBe('maintain');
      for (const role of ['admin', 'maintain', 'write'] as const) expect(loadConfigFromContent(`author_clear_role: ${role}`).author_clear_role).toBe(role);
      // A role that cannot push, a custom role, another case and an empty value are errors, never a lower role or the default.
      for (const value of ['triage', 'read', 'none', 'release-manager', 'Admin', 'true', '[admin]', '', '~']) {
        expect(() => loadConfigFromContent(`author_clear_role: ${value}`)).toThrow('`author_clear_role` must be one of: admin, maintain, write');
      }
      // While the base branch config cannot be read or loaded, only the role that every value of the setting allows may clear.
      expect(fallbackConfig()).toEqual({ ...loadConfig(undefined), author_clear_role: 'admin' });
    });

    it('defaults `drafts` to skip, accepts skip and review, and rejects anything else', () => {
      expect(loadConfigFromContent('').drafts).toBe('skip');
      expect(loadConfigFromContent('drafts: review').drafts).toBe('review');
      expect(() => loadConfigFromContent('drafts: always')).toThrow('`drafts` must be one of: skip, review');
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
      expect(resolvePairModel(withModels({ reviewer: 'claude-fable-5-1' }))).toBe('claude-opus-5-5');
      expect(resolvePairModel(withModels({ reviewer: 'anthropic/claude-fable-5' }))).toBe('claude-opus-5-5');
    });

    it('keeps the reviewer model for other providers and honours `reviewer_pair`', () => {
      expect(resolvePairModel(withModels({ reviewer: 'gpt-5.5' }))).toBe('gpt-5.5');
      expect(resolvePairModel(withModels({ reviewer: 'claude-sonnet-4-6', reviewer_pair: 'gemini-3-pro' }))).toBe('gemini-3-pro');
    });
  });

  describe('resolveFallbackModel', () => {
    const withModels = (models: ReviewConfig['models']): ReviewConfig => ({ ...DEFAULT_CONFIG, models });

    it('falls back to the reviewer model, or the other Claude tier for a stage already on it', () => {
      expect(resolveFallbackModel(DEFAULT_CONFIG, 'claude-opus-5-5')).toBe('claude-sonnet-5-5');
      expect(resolveFallbackModel(DEFAULT_CONFIG, 'claude-haiku-5-5')).toBe('claude-sonnet-5-5');
      expect(resolveFallbackModel(DEFAULT_CONFIG, 'claude-sonnet-5-5')).toBe('claude-opus-5-5');
      expect(resolveFallbackModel(DEFAULT_CONFIG, 'anthropic/claude-sonnet-5-5')).toBe('claude-opus-5-5');
      expect(resolveFallbackModel(withModels({ reviewer: 'claude-fable-5-1' }), 'claude-fable-5-1')).toBe('claude-opus-5-5');
    });

    it('honours `models.fallback` and returns undefined when no other model is left', () => {
      expect(resolveFallbackModel(withModels({ fallback: 'gpt-5.5' }), 'claude-opus-5-5')).toBe('gpt-5.5');
      expect(resolveFallbackModel(withModels({ fallback: 'claude-opus-5-5' }), 'claude-opus-5-5')).toBe('claude-sonnet-5-5');
      expect(resolveFallbackModel(withModels({ reviewer: 'gpt-5.5' }), 'gpt-5.5')).toBeUndefined();
    });
  });

  describe('unknown `models` keys', () => {
    it('warns about a key such as the removed `models.agents` and ignores it', () => {
      const config = loadConfigFromContent('models:\n  reviewer: gpt-5.5\n  agents:\n    "Security & Safety": claude-opus-5-5\n');
      expect(config.models).toEqual({ ...DEFAULT_CONFIG.models, reviewer: 'gpt-5.5' });
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "models.agents"');
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

  describe('judge config', () => {
    it('gives the judge no tool steps and auto effort by default, and takes tool steps from 0 to 100 and an effort level', () => {
      expect(loadConfig(undefined).judge).toEqual({ tool_steps: 0, effort: 'auto' });
      expect(loadConfig('judge:\n  tool_steps: 30\n').judge).toEqual({ tool_steps: 30, effort: 'auto' });
      expect(loadConfig('judge:\n  effort: xhigh\n').judge).toEqual({ tool_steps: 0, effort: 'xhigh' });
      expect(() => loadConfig('judge:\n  effort: extreme\n')).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`judge.effort` must be one of: low, medium, high, xhigh, max, auto');
      for (const bad of ['-1', '1.5', '101', '"30"']) {
        expect(() => loadConfig(`judge:\n  tool_steps: ${bad}\n`)).toThrow('Invalid config');
      }
      expect(core.error).toHaveBeenCalledWith('`judge.tool_steps` must be an integer from 0 to 100');
      expect(() => loadConfig('judge: 30\n')).toThrow('Invalid config');
      expect(core.error).toHaveBeenCalledWith('`judge` must be an object');
      // A misspelled key would leave the tools off without a word.
      loadConfig('judge:\n  toolsteps: 30\n');
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "judge.toolsteps"');
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
  });

  describe('changedKeys', () => {
    it('names the keys whose values differ, whatever their order in the file', () => {
      const base = loadConfigFromContent('models:\n  judge: claude-opus-5-5\n  reviewer_pair: gpt-5.5\nreview_passes: 2\n');
      expect(changedKeys(loadConfigFromContent('models:\n  reviewer_pair: gpt-5.5\n  judge: claude-opus-5-5\nreview_passes: 2\n'), base)).toEqual([]);
      const head = loadConfigFromContent('exclude_paths: ["*"]\nmodels:\n  judge: claude-haiku-5-5\nreview_passes: 2\nplanner:\n  paired: never\nstats: {}\n');
      expect(changedKeys(head, base)).toEqual(['exclude_paths', 'models', 'planner']);
    });
  });

});
