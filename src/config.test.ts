import { changedKeys, DEFAULT_CONFIG, fallbackConfig, loadConfig, loadConfigFromContent, loadStaticAnalysisConfig, readClosedPaths, resolveFallbackModel, resolveModel } from './config';
import { findClosedPattern } from './diff';
import { GroupReviewer, ReviewConfig } from './types';

// Suppress @actions/core output during tests
jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  error: jest.fn(),
}));

import * as core from '@actions/core';

/** A `review` block that sets the three groups every `review.groups` must define, to the built-in models. */
const GROUPS = 'review:\n  groups:\n    trivial: [claude-sonnet-5-5]\n    solo: [claude-sonnet-5-5]\n    full: [claude-sonnet-5-5, claude-opus-5-5]\n';

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
      expect(typeof DEFAULT_CONFIG.instructions).toBe('string');
      expect(typeof DEFAULT_CONFIG.memory).toBe('object');
      expect(typeof DEFAULT_CONFIG.memory.enabled).toBe('boolean');
      expect(typeof DEFAULT_CONFIG.memory.repo).toBe('string');
    });

    it('defaults models.judge to Opus and the planner and dedup to Haiku, and names no finder', () => {
      expect(DEFAULT_CONFIG.models).toEqual({ planner: 'claude-haiku-5-5', judge: 'claude-opus-5-5', dedup: 'claude-haiku-5-5' });
    });

    it('caps automatic rounds at 10 by default', () => {
      expect(DEFAULT_CONFIG.max_auto_rounds).toBe(10);
    });
  });

  describe('max_auto_rounds', () => {
    it('takes the cap the config sets, 0 included', () => {
      expect(loadConfigFromContent('max_auto_rounds: 3\n').max_auto_rounds).toBe(3);
      expect(loadConfigFromContent('max_auto_rounds: 0\n').max_auto_rounds).toBe(0);
    });

    it('rejects a negative, fractional or non-numeric max_auto_rounds', () => {
      for (const value of ['-1', '1.5', 'three']) {
        expect(() => loadConfigFromContent(`max_auto_rounds: ${value}\n`)).toThrow('`max_auto_rounds` must be a non-negative integer');
      }
    });
  });

  describe('static_analysis config', () => {
    const defaults = { checks: true, code_scanning: true, dependency_review: true, wait_for_checks: [], analyzers: {} };

    it('turns every CI source on and every analyzer off by default, and merges a partial block', () => {
      expect(loadConfigFromContent('').static_analysis).toEqual(defaults);
      expect(loadConfigFromContent('static_analysis:\n  code_scanning: false\n').static_analysis)
        .toEqual({ ...defaults, code_scanning: false });
      expect(loadConfigFromContent('static_analysis:\n  wait_for_checks: [lint]\n  analyzers: all\n').static_analysis)
        .toEqual({ ...defaults, wait_for_checks: ['lint'], analyzers: 'all' });
      expect(loadConfigFromContent('static_analysis:\n  analyzers:\n    ast_grep: true\n    secrets: true\n    dependencies: false\n    semgrep:\n      rules: [.semgrep/manki.yml, rules/extra.yaml]\n    actionlint: false\n    zizmor: true\n    shellcheck: false\n').static_analysis?.analyzers)
        .toEqual({ ast_grep: true, secrets: true, dependencies: false, semgrep: { rules: ['.semgrep/manki.yml', 'rules/extra.yaml'] }, actionlint: false, zizmor: true, shellcheck: false });
      expect(loadConfigFromContent('static_analysis:\n  analyzers:\n    semgrep: false\n').static_analysis?.analyzers).toEqual({ semgrep: false });
    });

    it('rejects a non-boolean source, a bad wait, an unknown analyzer and a non-object block', () => {
      expect(() => loadConfigFromContent('static_analysis:\n  checks: "yes"\n')).toThrow(/static_analysis\.checks/);
      expect(() => loadConfigFromContent('static_analysis: true\n')).toThrow(/`static_analysis` must be an object/);
      expect(() => loadConfigFromContent('static_analysis:\n  wait_for_checks: lint\n')).toThrow(/wait_for_checks/);
      expect(() => loadConfigFromContent('static_analysis:\n  wait_for_checks: [""]\n')).toThrow(/wait_for_checks/);
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
      expect(loadConfigFromContent('related_repos:\n  - { repo: acme/lib, kind: dependency, ref: v1.4.2 }\n').related_repos).toEqual([{ repo: 'acme/lib', kind: 'dependency', ref: 'v1.4.2' }]);
      expect(core.warning).not.toHaveBeenCalled();
    });

    it.each([
      ['a non-list block', 'related_repos: dashpay/dash\n', '`related_repos` must be a list of repos'],
      ['a non-object entry', 'related_repos: [dashpay/dash]\n', '`related_repos[0]` must be an object'],
      ['a repo without an owner', 'related_repos: [{ repo: dash, kind: reference }]\n', '`related_repos[0].repo` must be in "owner/name" format'],
      ['a repo outside the cache directory', 'related_repos: [{ repo: ../.., kind: reference }]\n', '`related_repos[0].repo` must be in "owner/name" format'],
      ['a repo listed twice', 'related_repos: [{ repo: dashpay/dash, kind: reference }, { repo: DashPay/Dash, kind: consumer }]\n', '`related_repos[1].repo` lists DashPay/Dash a second time'],
      ['a missing kind', 'related_repos: [{ repo: dashpay/dash }]\n', '`related_repos[0].kind` must be one of: reference, consumer, dependency'],
      ['an unknown kind', 'related_repos: [{ repo: dashpay/dash, kind: upstream }]\n', '`related_repos[0].kind` must be one of: reference, consumer, dependency'],
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
    const deep = `${GROUPS}    deep:\n      - { model: claude-opus-5-5, effort: high }\n      - gpt-5.5\n`;

    it('loads groups, classes and routing as written and leaves the built-ins when unset', () => {
      expect(loadConfigFromContent('').review).toBeUndefined();
      const config = loadConfigFromContent(`${deep}  classes:\n    security:\n      match: { paths_any: ["src/billing/**"] }\n    hot_path:\n      rank: 85\n      match: { paths_any: ["src/net/**"], triage: { subtle: true } }\n  routing:\n    security: deep\n    hot_path: deep\n    internal: solo\n  critical_paths: ["src/consensus/**", "@security_paths"]\n  outside_input: Messages from network peers.\n  examples:\n    blocker:\n      - A panic on a peer message.\n    not_blocker:\n      - A slow RPC call.\n  sweep: notes\n  notes: 0\n  rules: block\n  min_warning_trigger: 6\n  scope_blocks: true\n`);
      expect(config.review).toEqual({
        groups: { trivial: ['claude-sonnet-5-5'], solo: ['claude-sonnet-5-5'], full: ['claude-sonnet-5-5', 'claude-opus-5-5'], deep: [{ model: 'claude-opus-5-5', effort: 'high' }, 'gpt-5.5'] },
        classes: {
          security: { match: { paths_any: ['src/billing/**'] } },
          hot_path: { rank: 85, match: { paths_any: ['src/net/**'], triage: { subtle: true } } },
        },
        routing: { security: 'deep', hot_path: 'deep', internal: 'solo' },
        critical_paths: ['src/consensus/**', '@security_paths'],
        outside_input: 'Messages from network peers.',
        examples: { blocker: ['A panic on a peer message.'], not_blocker: ['A slow RPC call.'] },
        sweep: 'notes',
        notes: 0,
        rules: 'block',
        min_warning_trigger: 6,
        scope_blocks: true,
      });
      expect(core.warning).not.toHaveBeenCalled();
      // `auto`, the default, grades a broken rule by its damage alone, and stays unset in the config when left out.
      expect(['auto', 'warn'].map(mode => loadConfigFromContent(`review:\n  rules: ${mode}\n`).review?.rules)).toEqual(['auto', 'warn']);
    });

    it.each([
      ['a non-object block', 'review: true\n', '`review` must be an object'],
      ['groups that are a list', 'review:\n  groups: [claude-sonnet-5-5]\n', '`review.groups` must be an object mapping group names to lists of reviewers'],
      ['groups that leave out a built-in name', 'review:\n  groups:\n    trivial: [claude-sonnet-5-5]\n    full: [claude-sonnet-5-5, claude-opus-5-5]\n', '`review.groups` must define the `trivial`, `solo` and `full` groups, and has no `solo`'],
      ['groups that only add one', 'review:\n  groups:\n    deep: [claude-opus-5-5, gpt-5.5]\n', '`review.groups` must define the `trivial`, `solo` and `full` groups, and has no `trivial`'],
      ['an empty group', `${GROUPS}    empty: []\n`, '`review.groups.empty` must be a non-empty array of reviewers'],
      ['a group with the removed `reviewers` level', `${GROUPS}    g: { reviewers: [{ model: gpt-5.5 }] }\n`, '`review.groups.g` must be a non-empty array of reviewers'],
      ['a reviewer that is no model id or object', `${GROUPS}    g: [5]\n`, '`review.groups.g[0]` must be a model id or an object with a `model`'],
      ['a reviewer without a model', `${GROUPS}    g: [{ effort: high }]\n`, '`review.groups.g[0].model` must be a non-empty string'],
      ['an unknown effort', `${GROUPS}    g: [{ model: gpt-5.5, effort: extreme }]\n`, '`review.groups.g[0].effort` must be one of: low, medium, high, xhigh, max, auto'],
      ['an empty focus', `${GROUPS}    g: [{ model: gpt-5.5, focus: "" }]\n`, '`review.groups.g[0].focus` must be a non-empty string'],
      ['a route to an unknown group', 'review:\n  routing:\n    security: deep\n', '`review.routing.security` names unknown group `deep`'],
      ['a route for an unknown class', 'review:\n  routing:\n    hot_path: full\n', '`review.routing.hot_path` routes an unknown class'],
      ['a rank another class has', 'review:\n  classes:\n    hot: { rank: 50, match: { paths_any: ["src/**"] } }\n', '`review.classes.hot.rank` 50 is already the rank of `behavior`'],
      ['a class without a rank', 'review:\n  classes:\n    hot: { match: { paths_any: ["src/**"] } }\n', '`review.classes.hot.rank` must be an integer'],
      ['a class without conditions', 'review:\n  classes:\n    hot: { rank: 60 }\n', '`review.classes.hot.match` must set'],
      ['an unknown condition', 'review:\n  classes:\n    hot: { rank: 60, match: { min_files: 3 } }\n', '`review.classes.hot.match.min_files` is not a known condition'],
      ['a user floor class', 'review:\n  classes:\n    hot: { rank: 60, floor: true, match: { paths_any: ["src/**"] } }\n', '`review.classes.hot.floor` is not allowed'],
      ['an unknown path alias', 'review:\n  classes:\n    hot: { rank: 60, match: { paths_any: ["@hot_paths"] } }\n', 'unknown path alias `@hot_paths`'],
      ['a new rank on a built-in class', 'review:\n  classes:\n    security: { rank: 10, match: { paths_any: ["src/**"] } }\n', '`review.classes.security` is built in: it takes only `match.paths_any`'],
      ['a change to a triage class', 'review:\n  classes:\n    docs: { match: { paths_any: ["docs/**"] } }\n', '`review.classes.docs` is built in and cannot be changed'],
      ['a critical class', 'review:\n  classes:\n    hot: { rank: 60, critical: true, match: { paths_any: ["src/**"] } }\n', '`review.classes.hot.critical` is not a class setting. List the critical paths in `review.critical_paths`'],
      ['a critical built-in class', 'review:\n  classes:\n    security: { critical: true, match: { paths_any: ["src/**"] } }\n', '`review.classes.security.critical` is not a class setting. List the critical paths in `review.critical_paths`'],
      ['empty critical paths', 'review:\n  critical_paths: []\n', '`review.critical_paths` must be a non-empty array of strings'],
      ['critical paths with an unknown alias', 'review:\n  critical_paths: ["src/**", "@hot_paths"]\n', '`review.critical_paths` names unknown path alias `@hot_paths`'],
      ['an empty outside_input', 'review:\n  outside_input: "  "\n', '`review.outside_input` must be a non-empty string'],
      ['outside_input that is no string', 'review:\n  outside_input: [peers]\n', '`review.outside_input` must be a non-empty string'],
      ['a sweep that names no grade', 'review:\n  sweep: true\n', '`review.sweep` must be `off`, `blockers`, `warnings` or `notes`'],
      ['a negative number of notes', 'review:\n  notes: -1\n', '`review.notes` must be a non-negative integer'],
      ['a fractional number of notes', 'review:\n  notes: 2.5\n', '`review.notes` must be a non-negative integer'],
      ['notes that are no number', 'review:\n  notes: "3"\n', '`review.notes` must be a non-negative integer'],
      ['an unknown rules mode', 'review:\n  rules: error\n', '`review.rules` must be `auto`, `warn` or `block`'],
      ['a rules mode that is no string', 'review:\n  rules: true\n', '`review.rules` must be `auto`, `warn` or `block`'],
      ...['0', '11', '4.5', '"4"', 'true'].map(value => [`a min_warning_trigger of ${value}`, `review:\n  min_warning_trigger: ${value}\n`, '`review.min_warning_trigger` must be a whole number from 1 to 10']),
      ['a scope_blocks that is no boolean', 'review:\n  scope_blocks: "yes"\n', '`review.scope_blocks` must be `true` or `false`'],
      ['examples as a plain list', 'review:\n  examples: [A panic.]\n', '`review.examples` must set `blocker`, `not_blocker` or both'],
      ['empty examples', 'review:\n  examples: {}\n', '`review.examples` must set `blocker`, `not_blocker` or both'],
      ['an unknown example side', 'review:\n  examples:\n    warning: [A slow call.]\n', '`review.examples.warning` is not a known side'],
      ['an empty example side', 'review:\n  examples:\n    blocker: []\n', '`review.examples.blocker` must be a non-empty array of strings'],
      ['examples that are no strings', 'review:\n  examples:\n    not_blocker: [{ text: x }]\n', '`review.examples.not_blocker` must be a non-empty array of strings'],
    ])('rejects %s', (_label, yaml, message) => {
      expect(() => loadConfigFromContent(yaml)).toThrow(message);
    });

    it('fails a floor class routed to a group below the floor', () => {
      const solo = 'review:\n  routing:\n    security: solo\n';
      expect(() => loadConfigFromContent(solo)).toThrow('routes the `security` floor class to the `solo` group, but it has fewer than two finders. A floor class needs two finders on two distinct models, none at `low` effort. Route it to a stronger group');

      for (const floor of ['supply_chain', 'data_contract']) {
        expect(() => loadConfigFromContent(`review:\n  routing:\n    ${floor}: trivial\n`)).toThrow(`the \`${floor}\` floor class`);
      }
      for (const twin of ['[gpt-5.5, { model: gpt-5.5 }]', '[claude-sonnet-5-5, anthropic/claude-sonnet-5-5]']) {
        const sameModel = `${GROUPS}    twin: ${twin}\n  routing:\n    security: twin\n`;
        expect(() => loadConfigFromContent(sameModel)).toThrow('its finders run on fewer than two distinct models');
      }
      const low = `${GROUPS}    cheap: [{ model: gpt-5.5, effort: low }, claude-opus-5-5]\n  routing:\n    data_contract: cheap\n`;
      expect(() => loadConfigFromContent(low)).toThrow('a reader runs at `low` effort');
    });

    it('needs two finders on two distinct models in the `full` group, whatever routes to it', () => {
      const own = (full: string) => `review:\n  groups:\n    trivial: [gpt-5.5]\n    solo: [gpt-5.5]\n    full: ${full}\n`;
      expect(loadConfigFromContent(own('[gpt-5.5, gemini-3-pro]')).review?.groups?.full).toEqual(['gpt-5.5', 'gemini-3-pro']);
      const elsewhere = '    deep: [gpt-5.5, gemini-3-pro]\n  routing: { security: deep, supply_chain: deep, data_contract: deep }\n';
      const shortfalls = [
        ['[gpt-5.5]', 'it has fewer than two finders'],
        ['[gpt-5.5, gpt-5.5]', 'its finders run on fewer than two distinct models'],
        ['[openai/gpt-5.5, gpt-5.5]', 'its finders run on fewer than two distinct models'],
      ];
      for (const [full, shortfall] of shortfalls) {
        // The error is given once, with or without a floor class routed to `full`.
        for (const rest of ['', elsewhere]) {
          expect(() => loadConfigFromContent(own(full) + rest)).toThrow(new Error(`Invalid config in .manki.yml: \`review.groups.full\` must hold at least two finders on two distinct models, but ${shortfall}`));
        }
      }
      // A `low` reader in `full` counts only for a floor class routed to it.
      const low = own('[{ model: gpt-5.5, effort: low }, gemini-3-pro]');
      expect(() => loadConfigFromContent(low)).toThrow('routes the `security` floor class to the `full` group, but a reader runs at `low` effort');
      expect(loadConfigFromContent(low + elsewhere).review?.routing).toEqual({ security: 'deep', supply_chain: 'deep', data_contract: 'deep' });
      // The quick check is no finder, however many readers the `trivial` group lists.
      expect(() => loadConfigFromContent('review:\n  groups:\n    trivial: [gpt-5.5, gemini-3-pro]\n    solo: [gpt-5.5]\n    full: [gpt-5.5, gemini-3-pro]\n  routing:\n    security: trivial\n'))
        .toThrow('routes the `security` floor class to the `trivial` group, but it has fewer than two finders');
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
      expect(config.exclude_paths).toEqual(DEFAULT_CONFIG.exclude_paths);
    });

    it('reads `project` and `instructions` as strings, empty by default', () => {
      expect(loadConfigFromContent('').project).toBe('');
      expect(loadConfigFromContent('project: blockchain consensus library\n').project).toBe('blockchain consensus library');
      expect(() => loadConfigFromContent('project: [a, b]\n')).toThrow(/`project` must be a string/);
      expect(() => loadConfigFromContent('instructions: 5\n')).toThrow(/`instructions` must be a string/);
    });

    it('replaces the default exclude_paths with the repository\'s list, so an empty list excludes nothing', () => {
      expect(loadConfigFromContent('exclude_paths:\n  - "vendor/**"\n  - "dist/**"\n').exclude_paths).toEqual(['vendor/**', 'dist/**']);
      expect(loadConfigFromContent('exclude_paths: []').exclude_paths).toEqual([]);
    });

    it('closes no path by default, and keeps exclude_paths when closed_paths is set', () => {
      expect(loadConfigFromContent('').closed_paths).toEqual([]);
      const config = loadConfigFromContent('closed_paths: ["bench/holdout/**"]\n');
      expect([config.closed_paths, config.exclude_paths]).toEqual([['bench/holdout/**'], DEFAULT_CONFIG.exclude_paths]);
    });

    it('reads a closed path however it is written, closing the folder and its files, and refuses one that names no path', () => {
      const spellings = ['bench/holdout/**', 'bench/holdout/', '/bench/holdout/**', './bench/holdout/**', 'bench//holdout/**', './/bench/./holdout//', 'bench/holdout'];
      for (const pattern of spellings) {
        const [closed] = loadConfigFromContent(`closed_paths: [${JSON.stringify(pattern)}]\n`).closed_paths!;
        expect([pattern, readClosedPaths(`closed_paths: [${JSON.stringify(pattern)}]\n`)]).toEqual([pattern, [closed]]);
        expect([pattern, findClosedPattern('bench/holdout/case.yml', [closed]), findClosedPattern('bench/holdout', [closed])]).toEqual([pattern, closed, closed]);
        expect([pattern, findClosedPattern('bench/cases/case.yml', [closed]), findClosedPattern('bench', [closed])]).toEqual([pattern, undefined, undefined]);
      }
      // A pattern written with a slash matches from the root, and one with no slash matches a name at any depth.
      const closed = loadConfigFromContent('closed_paths: ["/README.md", "./NOTES.md", "docs/", "secret.txt", "#hidden", "!keep"]\n').closed_paths!;
      expect(closed).toEqual(['/README.md', '/NOTES.md', 'docs/**', 'secret.txt', '#hidden', '!keep']);
      const closedBy = (path: string) => findClosedPattern(path, closed);
      expect(['README.md', 'src/README.md', 'NOTES.md', 'src/NOTES.md', 'docs/a.md', 'src/docs/a.md'].map(closedBy))
        .toEqual(['/README.md', undefined, '/NOTES.md', undefined, 'docs/**', undefined]);
      expect(['secret.txt', 'src/deep/secret.txt', '#hidden', 'src/#hidden/a.ts', 'src/a.ts', 'keep'].map(closedBy))
        .toEqual(['secret.txt', 'secret.txt', '#hidden', '#hidden', undefined, undefined]);
      for (const pattern of ['', '/', './', '.', ' ', '../x/**', 'bench/../holdout', 'a/ /b']) {
        const content = `closed_paths: [${JSON.stringify(pattern)}]\n`;
        expect(() => loadConfigFromContent(content)).toThrow('`closed_paths[0]` names no path in the repository');
        expect([pattern, readClosedPaths(content)]).toEqual([pattern, undefined]);
      }
      for (const pattern of ['bench\\holdout\\**', 'bench/holdout/\\*']) {
        const content = `closed_paths: [${JSON.stringify(pattern)}]\n`;
        expect(() => loadConfigFromContent(content)).toThrow('`closed_paths[0]` holds a backslash: write the path with `/`');
        expect([pattern, readClosedPaths(content)]).toEqual([pattern, undefined]);
      }
    });

    it('reads closed_paths from a file that does not load, and none when the file cannot say which paths it closes', () => {
      expect(readClosedPaths('closed_paths: ["bench/**"]\nmax_diff_lines: 0\n')).toEqual(['bench/**']);
      // YAML that does not parse to a mapping closes nothing while its text never names the key.
      for (const content of [null, '', '# nothing\n', 'max_diff_lines: 0\n', 'exclude_paths: [\n', '- bench\n', 'plain']) expect(readClosedPaths(content)).toEqual([]);
      const unknown = ['closed_paths: [\n', '# closed_paths\nexclude_paths: [\n', '- closed_paths: [bench]\n', 'closed_paths: bench/**\n', 'closed_paths: [1]\n', 'closed_paths:\n'];
      for (const content of unknown) expect(readClosedPaths(content)).toBeUndefined();
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

    it('warns on unknown keys, removed ones included, but does not fail', () => {
      const yaml = `
auto_review: true
unknown_key: some_value
another_unknown: 123
nit_handling: comments
review_level: large
review_passes: 3
planner: { enabled: false }
slice_lines: 200
reviewers: [{ name: Protocol, focus: consensus rules }]
convergence: { max_auto_rounds: 2, rounds_after_restart: 1, suppress_resolved_threads: false, test_path_patterns: [] }
metrics: { fix_rate: true }
static_analysis: { wait_timeout_seconds: 5 }
`;
      const config = loadConfigFromContent(yaml);
      expect(config).toEqual({ ...DEFAULT_CONFIG, static_analysis: { ...DEFAULT_CONFIG.static_analysis, wait_timeout_seconds: 5 } });
      expect(jest.mocked(core.warning).mock.calls.map(c => c[0])).toEqual([
        'Unknown config key: "unknown_key"',
        'Unknown config key: "another_unknown"',
        'Unknown config key: "nit_handling"',
        'Unknown config key: "review_level"',
        'Unknown config key: "review_passes"',
        'Unknown config key: "planner"',
        'Unknown config key: "slice_lines"',
        'Unknown config key: "reviewers"',
        'Unknown config key: "convergence"',
        'Unknown config key: "metrics"',
        'Unknown config key: "static_analysis.wait_timeout_seconds"',
      ]);
    });

    it('warns on unknown keys inside each block that takes an object, and not on the keys it knows', () => {
      loadConfigFromContent(`
static_analysis: { checks: true, code_scanning: true, dependency_review: true, wait_for_checks: [ci], analyzers: all, check: false }
memory: { enabled: false, repo: '', repository: x/y }
`);
      const unknown = jest.mocked(core.warning).mock.calls.map(c => String(c[0])).filter(m => m.startsWith('Unknown config key'));
      expect(unknown).toEqual([
        'Unknown config key: "static_analysis.check"',
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

    it('defaults the review size limits to 15,000 and 8,000 lines, and accepts only positive whole numbers', () => {
      expect([DEFAULT_CONFIG.max_diff_lines, DEFAULT_CONFIG.auto_review_max_lines]).toEqual([15_000, 8_000]);
      expect(loadConfigFromContent('auto_review_max_lines: 4000\n')).toEqual(expect.objectContaining({ auto_review_max_lines: 4000 }));
      for (const yaml of ['auto_review_max_lines: 0', 'auto_review_max_lines: 1.5', 'auto_review_max_lines: "big"']) {
        expect(() => loadConfigFromContent(yaml)).toThrow('must be a positive whole number');
      }
    });

    it('throws on invalid auto_review type', () => {
      const yaml = 'auto_review: "yes"';
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
  planner: claude-sonnet-4-6
  judge: claude-opus-4-6
`;
      const config = loadConfigFromContent(yaml);
      expect(config.models?.planner).toBe('claude-sonnet-4-6');
      expect(config.models?.judge).toBe('claude-opus-4-6');
    });

    it('accepts partial models object and merges with defaults', () => {
      const yaml = `
models:
  planner: claude-sonnet-4-6
`;
      const config = loadConfigFromContent(yaml);
      expect(config.models?.planner).toBe('claude-sonnet-4-6');
      expect(config.models?.judge).toBe('claude-opus-5-5');
    });

    it('throws on invalid models type', () => {
      const yaml = 'models: "not an object"';
      expect(() => loadConfigFromContent(yaml)).toThrow('Invalid config');
    });

    it.each(['second_refuter', 'fallback'])('accepts `models.%s` and rejects a non-string or empty one', (key) => {
      expect(loadConfigFromContent(`models:\n  ${key}: gpt-5.5\n`).models?.[key as 'second_refuter' | 'fallback']).toBe('gpt-5.5');
      for (const value of ['123', '""']) {
        expect(() => loadConfigFromContent(`models:\n  ${key}: ${value}\n`)).toThrow('Invalid config');
        expect(core.error).toHaveBeenCalledWith(`\`models.${key}\` must be a non-empty string`);
      }
      expect(core.warning).not.toHaveBeenCalled();
    });

    it.each([
      ['models:\n  judge: claude/-x\n', '`models.judge`: Invalid model id "-x" in "claude/-x"'],
      ['models:\n  planner: claude-haiku 5\n', '`models.planner`: Invalid model id "claude-haiku 5"'],
      ['models:\n  fallback: -x\n', '`models.fallback`: Invalid model id "-x"'],
      ['models:\n  dedup: mistral-large\n', '`models.dedup`: Unknown model "mistral-large"'],
      [`${GROUPS}    g: [claude-opus-5-5, gemini/--yolo]\n`, '`review.groups.g[1]`: Invalid model id "--yolo" in "gemini/--yolo"'],
      [`${GROUPS}    g: [{ model: "openai/--sandbox" }]\n`, '`review.groups.g[0].model`: Invalid model id "--sandbox"'],
      [`${GROUPS}    g: ["@reviewer"]\n`, '`review.groups.g[0]`: Invalid model id "@reviewer"'],
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
  dedup: claude-haiku-4-5
`;
      const config = loadConfigFromContent(yaml);
      expect(config.models?.dedup).toBe('claude-haiku-4-5');
      expect(config.models?.judge).toBe('claude-opus-5-5');
    });
  });

  describe('resolveModel', () => {
    const baseConfig: ReviewConfig = {
      ...DEFAULT_CONFIG,
    };

    it('returns default stage-specific models from defaults', () => {
      expect(resolveModel(baseConfig, 'judge')).toBe('claude-opus-5-5');
      expect(resolveModel(baseConfig, 'dedup')).toBe('claude-haiku-5-5');
      expect(resolveModel(baseConfig, 'planner')).toBe('claude-haiku-5-5');
    });

    it('returns overridden stage-specific model', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: { judge: 'claude-sonnet-4-6', dedup: 'claude-sonnet-4-6' },
      };
      expect(resolveModel(config, 'judge')).toBe('claude-sonnet-4-6');
      expect(resolveModel(config, 'dedup')).toBe('claude-sonnet-4-6');
    });

    it('falls back to default models when models is undefined', () => {
      const config: ReviewConfig = { ...baseConfig, models: undefined };
      expect(resolveModel(config, 'judge')).toBe('claude-opus-5-5');
      expect(resolveModel(config, 'dedup')).toBe('claude-haiku-5-5');
    });

    it('falls back to default model when stage key is missing', () => {
      const config: ReviewConfig = {
        ...baseConfig,
        models: { dedup: 'claude-sonnet-4-6' },
      };
      expect(resolveModel(config, 'dedup')).toBe('claude-sonnet-4-6');
      expect(resolveModel(config, 'judge')).toBe('claude-opus-5-5');
    });

    it('falls back to default models when models is empty object', () => {
      const config: ReviewConfig = { ...baseConfig, models: {} };
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

  describe('resolveFallbackModel', () => {
    const withModels = (models: ReviewConfig['models']): ReviewConfig => ({ ...DEFAULT_CONFIG, models });
    const withFull = (full: Array<string | GroupReviewer>, models?: ReviewConfig['models']): ReviewConfig => ({ ...withModels(models), review: { groups: { trivial: [full[0]], solo: [full[0]], full } } });

    it('falls back to the first model of the `full` group other than the stage\'s own', () => {
      // Without a config: every stage but Sonnet's moves to Sonnet, and a finder on Sonnet to Opus.
      expect(resolveFallbackModel(DEFAULT_CONFIG, 'claude-opus-5-5')).toBe('claude-sonnet-5-5');
      expect(resolveFallbackModel(DEFAULT_CONFIG, 'claude-haiku-5-5')).toBe('claude-sonnet-5-5');
      expect(resolveFallbackModel(DEFAULT_CONFIG, 'claude-sonnet-5-5')).toBe('claude-opus-5-5');
      expect(resolveFallbackModel(DEFAULT_CONFIG, 'anthropic/claude-sonnet-5-5')).toBe('claude-opus-5-5');
      expect(resolveFallbackModel(DEFAULT_CONFIG, 'gpt-5.5')).toBe('claude-sonnet-5-5');
      const mixed = withFull(['gpt-5.5', { model: 'claude-opus-5-5', effort: 'high' }, 'gemini-3-pro']);
      expect(['gpt-5.5', 'claude-opus-5-5', 'gemini-3-pro', 'claude-haiku-5-5'].map(stage => resolveFallbackModel(mixed, stage))).toEqual(['claude-opus-5-5', 'gpt-5.5', 'gpt-5.5', 'gpt-5.5']);
    });

    it('honours `models.fallback` and returns undefined when no other model is left', () => {
      expect(resolveFallbackModel(withModels({ fallback: 'gpt-5.5' }), 'claude-opus-5-5')).toBe('gpt-5.5');
      expect(resolveFallbackModel(withModels({ fallback: 'claude-opus-5-5' }), 'claude-opus-5-5')).toBe('claude-sonnet-5-5');
      expect(resolveFallbackModel(withFull(['gpt-5.5', 'gemini-3-pro'], { fallback: 'gpt-5.5' }), 'gpt-5.5')).toBe('gemini-3-pro');
      expect(resolveFallbackModel(withFull(['gpt-5.5', 'gpt-5.5']), 'gpt-5.5')).toBeUndefined();
      expect(resolveFallbackModel(withFull(['gpt-5.5'], { fallback: 'gpt-5.5' }), 'gpt-5.5')).toBeUndefined();
      // One model written with and without its provider is the stage's own model.
      expect(resolveFallbackModel(withFull(['openai/gpt-5.5', 'gpt-5.5']), 'gpt-5.5')).toBeUndefined();
      expect(resolveFallbackModel(withFull(['openai/gpt-5.5', 'gemini-3-pro'], { fallback: 'gpt-5.5' }), 'openai/gpt-5.5')).toBe('gemini-3-pro');
      expect(resolveFallbackModel(withModels({ fallback: 'openai/gpt-5.5' }), 'gpt-5.5')).toBe('claude-sonnet-5-5');
    });
  });

  describe('unknown `models` keys', () => {
    it('warns about a key such as the removed `models.agents` and ignores it', () => {
      const config = loadConfigFromContent('models:\n  judge: gpt-5.5\n  agents:\n    "Security & Safety": claude-opus-5-5\n');
      expect(config.models).toEqual({ ...DEFAULT_CONFIG.models, judge: 'gpt-5.5' });
      expect(core.warning).toHaveBeenCalledWith('Unknown config key: "models.agents"');
    });

    it('warns about the removed finder, refuter and group keys and reviews with the defaults', () => {
      const removed = 'models:\n  reviewer: gpt-5.5\n  reviewer_pair: gpt-5.5\n  refuter_pair: gpt-5.5\nreview:\n  default_group: solo\n  allow_weaker: [security]\n'
        + '  groups:\n    trivial: [{ model: gpt-5.5, role: verifier, focus: "" }]\n    solo: [gpt-5.5]\n    full: [gpt-5.5, claude-opus-5-5]\n';
      const config = loadConfigFromContent(removed);
      expect(config.models).toEqual(DEFAULT_CONFIG.models);
      expect(jest.mocked(core.warning).mock.calls.map(call => call[0])).toEqual(
        // The quick check takes `model` and `effort` only, so `focus` is unknown in `trivial`.
        ['models.reviewer', 'models.reviewer_pair', 'models.refuter_pair', 'review.default_group', 'review.allow_weaker', 'review.groups.trivial[0].role', 'review.groups.trivial[0].focus']
          .map(key => `Unknown config key: "${key}"`),
      );
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

  describe.each(['exclude_paths', 'closed_paths'])('%s element type validation', (key) => {
    it(`throws when ${key} contains a non-string element`, () => {
      expect(() => loadConfigFromContent(`${key}:\n  - "*.lock"\n  - 42\n`))
        .toThrow(`\`${key}[1]\` must be a string, got number`);
    });

    it(`throws when ${key} contains a boolean element`, () => {
      expect(() => loadConfigFromContent(`${key}:\n  - true\n`))
        .toThrow(`\`${key}[0]\` must be a string, got boolean`);
    });

    it(`throws when ${key} is not a list`, () => {
      expect(() => loadConfigFromContent(`${key}: "dist/**"\n`)).toThrow(`\`${key}\` must be an array of strings`);
    });
  });

  describe('changedKeys', () => {
    it('names the keys whose values differ, whatever their order in the file', () => {
      const base = loadConfigFromContent('models:\n  judge: claude-opus-5-5\n  second_refuter: gpt-5.5\nmax_diff_lines: 2000\n');
      expect(changedKeys(loadConfigFromContent('models:\n  second_refuter: gpt-5.5\n  judge: claude-opus-5-5\nmax_diff_lines: 2000\n'), base)).toEqual([]);
      const head = loadConfigFromContent('exclude_paths: ["*"]\nmodels:\n  judge: claude-haiku-5-5\nmax_diff_lines: 2000\ndrafts: review\n');
      expect(changedKeys(head, base)).toEqual(['exclude_paths', 'models', 'drafts']);
    });
  });

});
