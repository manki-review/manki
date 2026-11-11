import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isMap, isScalar, parseDocument } from 'yaml';

import { BenchCase, BenchReport, buildReport, candidateFindings, formatBenchSummary, formatGate, formatUnmatched, gateReports, KeyItem, llmMatcher, loadCases, loadMatcherCache, MatchDecision, Matcher, mergeReports, parseBenchArgs, parseCase, rescoreReport, resolveVariants, runBench, runBenchCommand, scoreRun } from './bench';
import { loadConfigWithOverrides } from './local-review';
import type { LocalReview, LocalReviewInput } from './local-review';
import type { LLMClient } from './providers';
import type { Finding, FindingSeverity, RoundContext, RoundOutcome } from './types';

jest.mock('@actions/core');

const CASES_DIR = join(__dirname, '..', 'bench', 'cases');
const HOLDOUT_DIR = join(__dirname, '..', 'bench', 'holdout');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const CASE_YAML = `id: demo-1
repo: owner/demo
source: demo upstream PR 7
base: ${SHA_A}
head: ${SHA_B}
title: "fix: bound the reader"
body: |
  Reads lengths with a bound.
key_version: 2
must_catch:
  - id: K1
    severity: blocker
    mechanism: The reader allocates from a peer length.
    locations: [src/read.rs, read_len]
    fix: abc1234
    source: owner review
  - id: K2
    severity: warning
    mechanism: The error path drops the lock.
    locations: [unlock]
nice_to_have:
  - id: N1
    severity: suggestion
    mechanism: The test duplicates a helper.
`;

const FOLLOW_UP_YAML = `${CASE_YAML}prior_round:
  head: ${SHA_C}
  findings:
    - id: P1
      severity: blocker
      title: Reader allocates from a peer length
      file: src/read.rs
      line: 12
      grade_if_confirmed: blocker
      cell: { row: severe, column: normal }
      doubts:
        - premise: A peer can send the length.
          decides: defect
      posted: thread
      state: open
      description: A peer picks the size.
      how_to_fix: Cap the length.
      suggested_fix: let len = len.min(MAX);
      security: true
    - id: P2
      severity: warning
      title: No timeout on the connection
      file: src/conn.rs
      line: 40
      posted: thread
      state: open
    - id: P3
      severity: suggestion
      title: The retry loop has no test
      file: src/conn.rs
      line: 70
      posted: body
    - id: P4
      severity: warning
      title: Stale comment
      file: src/conn.rs
      line: 90
      posted: thread
      state: resolved
must_resolve: [P1]
must_keep_open:
  - id: P2
    severity: warning
    mechanism: The read timeout is set, the write timeout is not.
must_not_repeat: [P3]
`;

/**
 * Returns what a case file may not hold: the upstream organisation's name outside the `config:` block, whose
 * `related_repos` may name its repositories, and anywhere a linked reference to a repository outside the forks.
 */
function foreignReferences(text: string): string[] {
  const { contents } = parseDocument(text);
  const config = isMap(contents) ? contents.items.find(pair => isScalar(pair.key) && pair.key.value === 'config')?.value : undefined;
  const [from, to] = (isMap(config) && config.range) || [0, 0];
  const named = `${text.slice(0, from)}${text.slice(to)}`.match(/dashpay\//gi) ?? [];
  const linked = [...text.matchAll(/([\w.-]+)\/[\w.-]+#\d+/g)].filter(m => m[1] !== 'xdustinface' && m[1] !== 'manki-review').map(m => m[0]);
  return [...named, ...linked];
}

function makeFinding(overrides: Partial<Finding>): Finding {
  return { severity: 'warning', title: 'A finding', file: 'src/other.rs', line: 1, description: 'Something.', reviewers: ['reviewer'], ...overrides };
}

function makeReview(outcome: RoundOutcome, findings: Finding[], complete = true): LocalReview {
  return {
    result: { verdict: outcome === 'READY' ? 'APPROVE' : 'REQUEST_CHANGES', outcome, summary: '', findings, highlights: [], reviewComplete: complete, agentNames: ['reviewer'] },
    context: {
      usage: {
        estimatedCostUsd: 1.25, inputTokens: 1000, outputTokens: 100, durationMs: 50, wallClockMs: 90,
        llmCalls: [
          { stage: 'reviewer', agent: 'finder-a', model: 'claude-sonnet-5-5', attempt: 1, durationMs: 1, costUsd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, toolSteps: [{ tool: 'Read' }, { tool: 'Grep' }, { tool: 'mcp__manki__read_file' }], filesRead: ['src/a.rs', 'src/b.rs'] },
          { stage: 'reviewer', agent: 'finder-a', model: 'claude-sonnet-5-5', attempt: 2, durationMs: 1, costUsd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, toolSteps: [{ tool: 'Read' }], filesRead: ['src/b.rs', 'src/c.rs'] },
          { stage: 'judge', model: 'claude-opus-5-5', attempt: 1, durationMs: 1, costUsd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, toolSteps: [{ tool: 'Read' }] },
        ],
      },
    } as unknown as RoundContext,
    base: SHA_A,
    head: SHA_B,
    approvalHeld: false,
  };
}

describe('parseCase', () => {
  it('reads a case with its answer key', () => {
    expect(parseCase(CASE_YAML, 'demo.yml')).toEqual({
      id: 'demo-1', set: 'tuning', repo: 'owner/demo', source: 'demo upstream PR 7', base: SHA_A, head: SHA_B, title: 'fix: bound the reader', body: 'Reads lengths with a bound.\n', keyVersion: 2,
      mustCatch: [
        { id: 'K1', severity: 'blocker', mechanism: 'The reader allocates from a peer length.', locations: ['src/read.rs', 'read_len'], fix: 'abc1234', source: 'owner review' },
        { id: 'K2', severity: 'warning', mechanism: 'The error path drops the lock.', locations: ['unlock'] },
      ],
      niceToHave: [{ id: 'N1', severity: 'suggestion', mechanism: 'The test duplicates a helper.', locations: [] }],
      mustResolve: [], mustKeepOpen: [], mustNotRepeat: [],
    });
  });

  it('reads a follow-up case with the earlier round and the items that name its findings', () => {
    const followUp = parseCase(FOLLOW_UP_YAML, 'follow.yml');
    expect(followUp.priorRound).toEqual({
      head: SHA_C,
      findings: [
        {
          id: 'P1', severity: 'blocker', title: 'Reader allocates from a peer length', file: 'src/read.rs', line: 12, gradeIfConfirmed: 'blocker', thread: 'open',
          cell: { row: 'severe', column: 'normal' }, doubts: [{ premise: 'A peer can send the length.', decides: 'defect' }],
          description: 'A peer picks the size.', howToFix: 'Cap the length.', suggestedFix: 'let len = len.min(MAX);', security: true,
        },
        { id: 'P2', severity: 'warning', title: 'No timeout on the connection', file: 'src/conn.rs', line: 40, thread: 'open' },
        { id: 'P3', severity: 'suggestion', title: 'The retry loop has no test', file: 'src/conn.rs', line: 70 },
        { id: 'P4', severity: 'warning', title: 'Stale comment', file: 'src/conn.rs', line: 90, thread: 'resolved' },
      ],
    });
    expect(followUp).toMatchObject({
      mustResolve: ['P1'], mustNotRepeat: ['P3'],
      mustKeepOpen: [{ id: 'P2', severity: 'warning', mechanism: 'The read timeout is set, the write timeout is not.', locations: ['src/conn.rs'] }],
    });
  });

  it.each([
    ['must_resolve: [P1]', 'must_resolve: [P4]', '`must_resolve` names P4, which is no open earlier thread'],
    ['must_resolve: [P1]', 'must_resolve: [P9]', '`must_resolve` names P9, which is no earlier finding'],
    ['must_not_repeat: [P3]', 'must_not_repeat: [P1]', 'earlier finding P1 is in more than one follow-up list'],
    ['    - id: P3', '    - id: K1', 'item id K1 is used twice'],
    ['      posted: body', '      posted: body\n      state: open', '`state` must be open, resolved or fixed for a thread, and unset for a body finding'],
    ['      posted: body', '      posted: review', '`posted` must be thread or body'],
    ['      line: 70', '      line: 0', 'prior_round.findings[2]: `line` must be a positive integer'],
    ['row: severe', 'row: serious', '`cell` must have a `row` of severe, wrong, degraded, improvement, style and a `column` of normal or rare'],
    ['decides: defect', 'decides: maybe', '`doubts` must be a list of mappings with a `premise` and a `decides` of defect or grade'],
    [`  head: ${SHA_C}`, '  head: abc', '`prior_round.head` must be a full commit SHA'],
    ['  - id: P2\n    severity: warning\n    mechanism: The read', '  - id: K1\n    severity: warning\n    locations: [src/conn.rs]\n    mechanism: The read', '`must_keep_open` names K1, which is no earlier finding'],
    ['  - id: P2\n    severity: warning\n    mechanism: The read', '  - id: P4\n    severity: warning\n    locations: [src/conn.rs]\n    mechanism: The read', '`must_keep_open` names P4, which is no open earlier thread'],
  ])('refuses a follow-up case where %s is %s', (from, to, message) => {
    expect(() => parseCase(FOLLOW_UP_YAML.replace(from, to), 'bad.yml')).toThrow(message);
  });

  it('refuses follow-up items without an earlier round', () => {
    expect(() => parseCase(`${CASE_YAML}must_not_repeat: [P1]\n`, 'bad.yml')).toThrow('`must_resolve`, `must_keep_open` and `must_not_repeat` need a `prior_round`');
  });

  it('reads a clean case without key items, and a case with its own config', () => {
    const clean = parseCase(CASE_YAML.slice(0, CASE_YAML.indexOf('must_catch:')), 'clean.yml');
    expect([clean.mustCatch, clean.niceToHave]).toEqual([[], []]);
    expect(parseCase(`${CASE_YAML}config:\n  review_passes: 2\n  models: { reviewer: claude-opus-5-5 }\n`, 'own.yml').config).toEqual({ review_passes: 2, models: { reviewer: 'claude-opus-5-5' } });
    expect(parseCase(`${CASE_YAML}config: {}\n`, 'own.yml').config).toEqual({});
  });

  it.each([
    ['repo: owner/demo', 'repo: demo', '`repo` must be `owner/name`'],
    [`base: ${SHA_A}`, 'base: abc', '`base` must be a full commit SHA'],
    ['key_version: 2', 'key_version: two', '`key_version` must be a number'],
    ['key_version: 2', 'key_version: 2\nconfig: [review_passes]', '`config` must be a mapping of config keys'],
    ['key_version: 2', 'key_version: 2\nconfig:', '`config` must be a mapping of config keys'],
    ['title: "fix: bound the reader"', 'title: ""', '`title` must be a non-empty string'],
    ['severity: warning', 'severity: major', 'must_catch[1].severity must be one of blocker, warning, suggestion, nitpick'],
    ['locations: [unlock]', 'locations: unlock', 'must_catch[1].locations must be a list of strings'],
    ['source: owner review', 'source: [owner]', 'must_catch[0].source must be a string'],
    ['  - id: N1', '  - id: K1', 'item id K1 is used twice'],
  ])('refuses a case where %s is %s', (from, to, message) => {
    expect(() => parseCase(CASE_YAML.replace(from, to), 'bad.yml')).toThrow(`bad.yml`);
    expect(() => parseCase(CASE_YAML.replace(from, to), 'bad.yml')).toThrow(message);
  });

  it('parses every tuning and hold-out case, with unique ids, a config of its own that loads and no linked reference to a repository outside the forks', async () => {
    const files = [CASES_DIR, HOLDOUT_DIR].flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.yml')).map(f => join(dir, f)));
    const cases = loadCases({ tuning: CASES_DIR, holdout: HOLDOUT_DIR });
    expect(cases).toHaveLength(files.length);
    expect(cases.filter(c => c.set === 'holdout' && c.repo !== 'xdustinface/rust-dashcore').length).toBeGreaterThanOrEqual(8);
    const unloadable: string[] = [];
    for (const c of cases.filter(own => own.config)) await loadConfigWithOverrides('', '', {}, c.config).catch(() => unloadable.push(c.id));
    expect(unloadable).toEqual([]);
    expect(files.flatMap(file => foreignReferences(readFileSync(file, 'utf-8')).map(found => `${file}: ${found}`))).toEqual([]);
  });

  it('lets only the config of a case name an upstream repository, and no part of it link to one', () => {
    const related = (repo: string) => `${CASE_YAML}# The reference repositories.\nconfig:\n  related_repos:\n    - { repo: ${repo}, kind: reference }\n  instructions: Follow the reference.\n# After the config.\nkey_note: last\n`;
    expect(foreignReferences(related('dashpay/dash'))).toEqual([]);
    expect(foreignReferences(related('dashpay/dash').replace('source: demo upstream PR 7', 'source: dashpay/dash PR 7'))).toEqual(['dashpay/']);
    expect(foreignReferences(related('dashpay/dash').replace('# The reference repositories.', '# From dashpay/dash.'))).toEqual(['dashpay/']);
    expect(foreignReferences(related('dashpay/dash').replace('# After the config.', '# After dashpay/dash.'))).toEqual(['dashpay/']);
    expect(foreignReferences(related('dashpay/dash').replace('key_note: last', 'key_note: DashPay/dips'))).toEqual(['DashPay/']);
    expect(foreignReferences(related('owner/demo').replace('Follow the reference.', 'See other/repo#12.'))).toEqual(['other/repo#12']);
    expect(foreignReferences(`${CASE_YAML}config: dashpay/dash\n`)).toEqual(['dashpay/']);
    expect(foreignReferences(CASE_YAML.replace('demo upstream PR 7', 'xdustinface/demo#7 and manki-review/manki#8'))).toEqual([]);
  });
});

describe('loadCases', () => {
  it('keeps only the asked cases of the sets given, and refuses an unknown id, an id used in two sets or a set without cases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manki-cases-'));
    const holdout = mkdtempSync(join(tmpdir(), 'manki-holdout-'));
    try {
      writeFileSync(join(dir, 'a.yml'), CASE_YAML);
      writeFileSync(join(dir, 'b.yml'), CASE_YAML.replace('id: demo-1', 'id: demo-2'));
      writeFileSync(join(dir, 'notes.md'), 'not a case');
      writeFileSync(join(holdout, 'c.yml'), CASE_YAML.replace('id: demo-1', 'id: demo-3'));
      expect(loadCases({ tuning: dir }).map(c => c.id)).toEqual(['demo-1', 'demo-2']);
      expect(loadCases({ tuning: dir }, ['demo-2']).map(c => c.id)).toEqual(['demo-2']);
      expect(() => loadCases({ tuning: dir }, ['demo-3'])).toThrow('No case with id demo-3');
      expect(loadCases({ tuning: dir, holdout }, ['demo-1', 'demo-3']).map(c => [c.id, c.set])).toEqual([['demo-1', 'tuning'], ['demo-3', 'holdout']]);
      writeFileSync(join(holdout, 'd.yml'), CASE_YAML);
      expect(() => loadCases({ tuning: dir, holdout })).toThrow('Case id demo-1 is used twice');
      rmSync(join(holdout, 'c.yml'));
      rmSync(join(holdout, 'd.yml'));
      expect(() => loadCases({ tuning: dir, holdout })).toThrow(`No case files in ${holdout}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(holdout, { recursive: true, force: true });
    }
  });
});

describe('candidateFindings', () => {
  const item: KeyItem = { id: 'K1', severity: 'blocker', mechanism: 'x', locations: ['src/read.rs', 'read_len'] };
  const findings = [
    makeFinding({ file: 'crate/src/read.rs' }),
    makeFinding({ file: 'src/lib.rs', description: 'Calls `read_len` with a peer value.' }),
    makeFinding({ file: 'src/lib.rs', title: 'Unrelated' }),
  ];

  it('keeps findings in a named file or naming a symbol', () => {
    expect(candidateFindings(item, findings)).toEqual([0, 1]);
  });

  it('keeps every finding for an item without locations', () => {
    expect(candidateFindings({ ...item, locations: [] }, findings)).toEqual([0, 1, 2]);
  });
});

describe('llmMatcher', () => {
  const item: KeyItem = { id: 'K1', severity: 'blocker', mechanism: 'The reader allocates from a peer length.', locations: ['src/read.rs'] };
  const findings = [makeFinding({ title: 'First' }), makeFinding({ title: 'Second', suggestedFix: 'Bound it.' })];
  const clientAnswering = (content: string) => ({ sendMessage: jest.fn().mockResolvedValue({ content }) }) as unknown as LLMClient & { sendMessage: jest.Mock };

  it('maps the numbered findings to their indexes, shows the key item and findings, and answers a repeat from the cache', async () => {
    const client = clientAnswering('```json\n{"verdict": "MATCH", "findings": [2, 1, 2], "reason": "Same allocation."}\n```');
    const cache = new Map<string, MatchDecision>();
    const matcher = llmMatcher(client, 'model-a', cache);

    expect(await matcher(item, findings)).toEqual({ verdict: 'MATCH', findings: [1, 0], reason: 'Same allocation.' });
    expect(await matcher(item, findings)).toEqual({ verdict: 'MATCH', findings: [1, 0], reason: 'Same allocation.' });
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const [, message, options] = client.sendMessage.mock.calls[0];
    expect(message).toContain('Key item (blocker): The reader allocates from a peer length.');
    expect(message).toContain('2. [warning] src/other.rs:1: Second');
    expect(message).toContain('Fix: Bound it.');
    expect(options).toEqual({ effort: 'high' });
    expect(cache.size).toBe(1);
  });

  it.each([
    ['{"verdict": "NONE", "findings": [], "reason": "Not there."}', { verdict: 'NONE', findings: [], reason: 'Not there.' }],
    ['{"verdict": "PARTIAL", "findings": [9, 0], "reason": "Close."}', { verdict: 'NONE', findings: [], reason: 'Named no listed finding: Close.' }],
  ])('reads %s as no match', async (content, expected) => {
    expect(await llmMatcher(clientAnswering(content), 'model-a', new Map())(item, findings)).toEqual(expected);
  });

  it('loads a kept cache without the entries that are not decisions, and names a cache file that does not load', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manki-cache-'));
    try {
      const path = join(dir, 'cache.json');
      expect(loadMatcherCache(path).size).toBe(0);
      const kept: MatchDecision = { verdict: 'MATCH', findings: [0], reason: 'same' };
      writeFileSync(path, JSON.stringify({ a: kept, b: { verdict: 'MATCH', finding: 0, reason: 'old shape' }, c: { verdict: 'MAYBE', findings: [], reason: '' }, d: null }));
      expect([...loadMatcherCache(path)]).toEqual([['a', kept]]);
      writeFileSync(path, '{"a": {"verdict"');
      expect(() => loadMatcherCache(path)).toThrow(`The matcher cache ${path} is not valid JSON. Delete it to start a fresh one:`);
      writeFileSync(path, '[]');
      expect(() => loadMatcherCache(path)).toThrow(`The matcher cache ${path} is not a JSON object.`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a reply without a verdict', async () => {
    await expect(llmMatcher(clientAnswering('{"answer": "yes"}'), 'model-a', new Map())(item, findings)).rejects.toThrow('no verdict for K1');
  });
});

describe('scoreRun', () => {
  const benchCase = parseCase(CASE_YAML, 'demo.yml');
  const stub = (decisions: Record<string, MatchDecision>): Matcher & jest.Mock => jest.fn(async (item: KeyItem) => decisions[item.id] ?? { verdict: 'NONE', findings: [], reason: 'none' });

  it('scores recall, severity credit, extra findings, false blockers, unexpected warnings and duplicates, and counts finder reads and cost', async () => {
    const findings = [
      makeFinding({ severity: 'warning', file: 'src/read.rs', title: 'Peer length allocation' }),
      makeFinding({ severity: 'blocker', file: 'src/lock.rs', title: 'Lock dropped', description: 'Calls `unlock` early.' }),
      makeFinding({ severity: 'blocker', file: 'src/other.rs', title: 'Invented' }),
      makeFinding({ severity: 'blocker', file: 'src/read.rs', title: 'Same allocation, second place' }),
    ];
    const matcher = stub({ K1: { verdict: 'MATCH', findings: [1, 0], reason: 'same' }, K2: { verdict: 'PARTIAL', findings: [0], reason: 'vague' } });

    const score = await scoreRun(benchCase, makeReview('ADDRESS_FIRST', findings), matcher);

    expect(matcher).toHaveBeenCalledTimes(3);
    expect(matcher.mock.calls[0][1]).toEqual([findings[0], findings[3]]);
    expect(matcher.mock.calls[1][1]).toEqual([findings[1]]);
    expect(matcher.mock.calls[2][1]).toEqual(findings);
    expect(score.matches).toEqual([
      { item: 'K1', verdict: 'MATCH', findings: [3, 0], severity: 'blocker', reason: 'same' },
      { item: 'K2', verdict: 'PARTIAL', findings: [1], severity: 'blocker', reason: 'vague' },
      { item: 'N1', verdict: 'NONE', findings: [], reason: 'none' },
    ]);
    expect(score).toMatchObject({
      outcome: 'ADDRESS_FIRST', complete: true, mustCatchRecall: 0.5, weightedRecall: 3 / 5, verdictCorrect: true, falseBlockers: 1, unexpectedWarnings: 0, extraFindings: 1, duplicates: 1,
      finders: [{ name: 'finder-a', model: 'claude-sonnet-5-5', toolSteps: 4, filesRead: 3 }],
      costUsd: 1.25, inputTokens: 1000, outputTokens: 100, durationMs: 90,
    });
    expect(score.findings.slice(1, 3)).toEqual([
      { severity: 'blocker', title: 'Lock dropped', file: 'src/lock.rs', line: 1, description: 'Calls `unlock` early.' },
      { severity: 'blocker', title: 'Invented', file: 'src/other.rs', line: 1, description: 'Something.' },
    ]);

    const warnings = [makeFinding({ title: 'Helper copied' }), makeFinding({ title: 'Unlisted\n```', description: 'Drops the lock.\r```rust\r\nunlock();\n```\n', howToFix: 'Hold it.', suggestedFix: 'lock();' }), makeFinding({ severity: 'suggestion', title: 'A note' })];
    const warned = await scoreRun(benchCase, makeReview('READY', warnings), stub({ N1: { verdict: 'MATCH', findings: [0], reason: 'same' } }));
    expect(warned).toMatchObject({ falseBlockers: 0, unexpectedWarnings: 1, extraFindings: 2 });
    const unscored = buildReport(
      { startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' },
      [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [{ ...warned, unexpectedWarnings: undefined }] }] }],
    );
    expect(unscored.variants[0].summary.unexpectedWarnings).toBe(1);
    expect(formatBenchSummary(unscored)).toContain('0 false blockers, 1 unexpected warnings, 2 extra');
    expect(warned.findings[1]).toEqual({ severity: 'warning', title: 'Unlisted\n```', file: 'src/other.rs', line: 1, description: 'Drops the lock.\r```rust\r\nunlock();\n```\n', howToFix: 'Hold it.', suggestedFix: 'lock();' });
    expect(formatUnmatched(unscored.variants)).toBe([
      '### Unexpected warnings on tuning cases', '',
      "Warnings that match no key item. Add each real defect to its case's `must_catch`, or to `nice_to_have` when a good review may leave it out, and bump the case's `key_version`.", '',
      // A line break in the title, or a bare carriage return in the description, starts no line of its own that could close the block.
      '```text', 'base demo-1 key v2 run 1: src/other.rs:1: Unlisted ```', '    Drops the lock.', '    ```rust', '    unlock();', '    ```', '```', '',
    ].join('\n'));
  });

  it('gives half credit one tier low and none two tiers low, skips the matcher without candidates, and calls an approval of a blocker case wrong', async () => {
    const run = (severity: Finding['severity']) => scoreRun(benchCase, makeReview('READY', [makeFinding({ severity, file: 'src/read.rs' })]), stub({ K1: { verdict: 'MATCH', findings: [0], reason: 'same' } }));

    expect(await run('warning')).toMatchObject({ mustCatchRecall: 0.5, weightedRecall: 1.5 / 5 });
    const score = await run('nitpick');
    expect(score.matches[1]).toEqual({ item: 'K2', verdict: 'NONE', findings: [], reason: 'No finding names its files or symbols.' });
    expect(score).toMatchObject({ mustCatchRecall: 0.5, weightedRecall: 0, verdictCorrect: false, extraFindings: 0, duplicates: 0 });
  });

  it('expects a clean case to approve, and leaves the recall and verdict of an incomplete run unscored', async () => {
    const clean: BenchCase = { ...benchCase, mustCatch: [], niceToHave: [] };
    expect(await scoreRun(clean, makeReview('READY', []), stub({}))).toMatchObject({ mustCatchRecall: null, weightedRecall: null, verdictCorrect: true });
    expect(await scoreRun(clean, makeReview('ADDRESS_FIRST', [makeFinding({ severity: 'blocker' })]), stub({}))).toMatchObject({ verdictCorrect: false, falseBlockers: 1 });
    expect(await scoreRun(benchCase, makeReview('INCOMPLETE', [], false), stub({}))).toMatchObject({ complete: false, error: 'The review did not complete.', mustCatchRecall: null, weightedRecall: null, verdictCorrect: null });
  });
});

describe('scoreRun on a follow-up case', () => {
  const followUp = parseCase(FOLLOW_UP_YAML, 'follow.yml');
  const findings = [
    makeFinding({ severity: 'blocker', file: 'src/conn.rs', title: 'Write has no timeout' }),
    makeFinding({ severity: 'suggestion', file: 'src/conn.rs', title: 'Retry loop untested' }),
    makeFinding({ severity: 'blocker', file: 'src/read.rs', title: 'Peer length allocation' }),
  ];
  const decisions: Record<string, MatchDecision> = {
    K1: { verdict: 'MATCH', findings: [0], reason: 'same' }, P2: { verdict: 'MATCH', findings: [0], reason: 'restates' }, P3: { verdict: 'MATCH', findings: [1], reason: 'restates' },
  };
  const matcher: Matcher = async item => decisions[item.id] ?? { verdict: 'NONE', findings: [], reason: 'none' };
  const review = (complete = true): LocalReview => {
    const local = makeReview('ADDRESS_FIRST', findings, complete);
    local.result.threadEvaluations = [
      { threadId: 'P1', status: 'addressed', reason: 'capped' }, { threadId: 'P2', status: 'addressed', reason: 'read timeout set' },
      { threadId: 'P4', status: 'addressed', reason: 'not open' }, { threadId: 'P3', status: 'not_addressed', reason: 'body' },
    ];
    return local;
  };

  it('scores resolutions against the key and repeats of earlier findings apart from extra findings, and reports each follow-up item', async () => {
    const score = await scoreRun(followUp, review(), matcher);

    expect(score.matches.map(m => [m.item, m.verdict, m.findings])).toEqual([['K1', 'MATCH', [2]], ['K2', 'NONE', []], ['N1', 'NONE', []], ['P2', 'MATCH', [0]], ['P3', 'MATCH', [1]]]);
    expect(score).toMatchObject({
      verdictCorrect: true, falseBlockers: 0, unexpectedWarnings: 0, extraFindings: 0, duplicates: 0, followUp: { resolved: ['P1', 'P2'], resolvedRight: 1, resolvedWrong: 1, repeats: 2 },
    });
    expect(await scoreRun(followUp, review(false), matcher)).not.toHaveProperty('followUp');
    const reworded = await scoreRun(followUp, review(), async item => (item.id === 'P2' ? { verdict: 'PARTIAL', findings: [0], reason: 'other mechanism' } : decisions[item.id] ?? { verdict: 'NONE', findings: [], reason: 'none' }));
    expect(reworded).toMatchObject({ falseBlockers: 1, extraFindings: 1, followUp: { repeats: 1 } });
    const incomplete = await scoreRun(followUp, review(false), matcher);
    const listed = (benchCase: BenchCase, sets?: Array<BenchCase['set']>) => formatUnmatched(buildReport(
      { startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 3, matcherModel: 'model-a' },
      [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [score, reworded, incomplete] }] }],
    ).variants, sets);
    const blockers = (on: string) => [
      `### Unmatched blockers on ${on} cases`, '',
      "Blockers that match no key item. Add each real defect to its case's `must_catch` and bump the case's `key_version`.", '',
      '```text', 'base demo-1 key v2 run 2: src/conn.rs:1: Write has no timeout', '    Something.', '```', '',
    ].join('\n');
    expect(listed(followUp)).toBe(blockers('tuning'));
    expect(listed({ ...followUp, set: 'holdout' })).toBe('');
    expect(listed({ ...followUp, set: 'holdout' }, ['holdout'])).toBe(blockers('hold-out'));
    expect(listed(followUp, ['tuning', 'holdout'])).toBe(blockers('tuning and hold-out'));

    const report = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase: followUp, runs: [score] }] }]);
    expect(report.variants[0].cases[0].items.slice(3)).toEqual([
      { id: 'P1', tier: 'must_resolve', severity: 'blocker', caught: 1, partial: 0, runs: 1 },
      { id: 'P2', tier: 'must_keep_open', severity: 'warning', caught: 0, partial: 0, runs: 1 },
      { id: 'P3', tier: 'must_not_repeat', severity: 'suggestion', caught: 0, partial: 0, runs: 1 },
    ]);
    expect(report.variants[0].summary).toMatchObject({ atGradeRecall: 0.5, resolvedRight: 1, resolvedWrong: 1, repeats: 2 });
    const summary = formatBenchSummary(report);
    expect(summary).toContain('  P2 keep open warning: 0/1\n');
    expect(summary).toContain(', 0 duplicates, resolved 1 right and 1 wrong, 2 repeats, files read');
    expect(summary).toContain('\nFollow-up rounds: resolved 1 right and 1 wrong, 2 repeats.\n');
    expect(summary).toContain('| Resolved right | 1 |\n| Resolved wrong | 1 |\n| Repeats | 2 |\n');
    expect(summary).toContain('| demo-1 P3 (no repeat suggestion) | 0/1 |');
  });

  it('expects a block while an earlier blocker or a kept-open blocker is still in the code, and an approval once nothing is left', async () => {
    const approve = makeReview('READY', []);
    const verdict = (changes: Partial<BenchCase>) => scoreRun({ ...followUp, mustCatch: [], ...changes }, approve, matcher).then(s => s.verdictCorrect);
    expect(await verdict({})).toBeNull();
    expect(await verdict({ mustKeepOpen: [] })).toBe(true);
    expect(await verdict({ mustKeepOpen: [{ ...followUp.mustKeepOpen[0], severity: 'blocker' }] })).toBe(false);
    expect(await verdict({ mustKeepOpen: [], mustResolve: [], mustNotRepeat: ['P1'] })).toBe(false);
    expect(await verdict({ mustKeepOpen: [], mustResolve: [] })).toBe(false);
    const resolvedBlocker = { ...followUp.priorRound!.findings[3], severity: 'blocker' as const };
    const priorRound = { ...followUp.priorRound!, findings: [...followUp.priorRound!.findings.slice(0, 3), resolvedBlocker] };
    expect(await verdict({ mustKeepOpen: [], priorRound, mustNotRepeat: ['P3', 'P4'] })).toBe(true);
  });
});

describe('runBench and buildReport', () => {
  let checkout: string;
  let benchCase: BenchCase;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

  beforeAll(() => {
    checkout = mkdtempSync(join(tmpdir(), 'manki-bench-'));
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    git('commit', '-q', '--allow-empty', '-m', 'head');
    benchCase = { ...parseCase(CASE_YAML, 'demo.yml'), base, head: git('rev-parse', 'HEAD') };
  });

  afterAll(() => {
    rmSync(checkout, { recursive: true, force: true });
  });

  const inputs = { anthropicOauthToken: 'token', anthropicApiKey: '', openaiOauthToken: '', openaiApiKey: '', geminiOauthToken: '', geminiApiKey: '' };
  const blocker = makeFinding({ severity: 'blocker', file: 'src/read.rs' });

  it('reviews each case the asked number of times with the overrides, records a failed or incomplete run apart, and reports catch rates side by side', async () => {
    const runs: Array<RoundOutcome | Error> = ['ADDRESS_FIRST', new Error('provider down'), 'READY', 'INCOMPLETE', 'ADDRESS_FIRST'];
    let call = 0;
    const review = jest.fn(async (_input: LocalReviewInput) => {
      const next = runs[call++];
      if (next instanceof Error) throw next;
      return makeReview(next, next === 'INCOMPLETE' ? [] : [blocker], next !== 'INCOMPLETE');
    });
    const verdicts: MatchDecision[] = [
      { verdict: 'MATCH', findings: [0], reason: 'same' }, { verdict: 'PARTIAL', findings: [0], reason: 'close' }, { verdict: 'MATCH', findings: [0], reason: 'same' },
    ];
    let k1 = 0;
    const matcher: Matcher = async item => (item.id === 'K1' ? verdicts[k1++] : { verdict: 'NONE', findings: [], reason: 'none' });
    const onCase = jest.fn();

    const overrides = { models: { reviewer: 'claude-opus-5-5' } };
    const baseReview = jest.fn(async (_input: LocalReviewInput) => makeReview('READY', []));
    await runBench([benchCase], { runs: 1, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, matcher, review: baseReview });
    expect(baseReview.mock.calls[0][0]).not.toHaveProperty('configOverrides');
    expect(baseReview.mock.calls[0][0]).not.toHaveProperty('earlier');
    const followUp = { ...benchCase, priorRound: { head: benchCase.base, findings: [] } };
    await runBench([followUp], { runs: 1, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, matcher, review: baseReview });
    expect(baseReview.mock.calls[1][0].earlier).toBe(followUp.priorRound);
    // A case with related repos reads them as of the oldest author date of its own commits, which a replayed commit keeps.
    expect(baseReview.mock.calls[1][0]).not.toHaveProperty('relatedReposAsOf');
    git('commit', '-q', '--allow-empty', '--date=2026-01-05T10:00:00Z', '-m', 'replayed change');
    git('commit', '-q', '--allow-empty', '--date=2026-03-01T10:00:00Z', '-m', 'fix after the review');
    const replayed = { ...benchCase, base: benchCase.head, head: git('rev-parse', 'HEAD'), config: { related_repos: [{ repo: 'o/ref', kind: 'reference' as const }] } };
    const asOf = '2026-01-05T10:00:00Z';
    baseReview.mockImplementationOnce(async () => {
      const local = makeReview('READY', []);
      local.context.relatedRepos = [{ repo: 'o/ref', ref: 'v1', status: 'fetched', commit: SHA_C, asOf, durationMs: 5, reads: 2 }, { repo: 'o/other', status: 'unused', asOf }];
      return local;
    });
    const bench = (cases: BenchCase[]) => runBench(cases, { runs: 1, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, matcher, review: baseReview });
    const datedAt = () => Date.parse(baseReview.mock.calls.at(-1)![0].relatedReposAsOf!);
    const [{ results: [{ runs: [dated] }] }] = await bench([replayed]);
    expect(datedAt()).toBe(Date.parse(asOf));
    expect(dated.relatedRepos).toEqual([{ repo: 'o/ref', ref: 'v1', status: 'fetched', commit: SHA_C, asOf }, { repo: 'o/other', status: 'unused', asOf }]);
    // The base branch merged into the change adds none of its older commits to the change's own.
    git('checkout', '-q', '-b', 'trunk', replayed.base);
    git('commit', '-q', '--allow-empty', '--date=2025-06-01T10:00:00Z', '-m', 'older work on the base branch');
    git('checkout', '-q', '-');
    git('merge', '-q', '--no-ff', '-m', 'merge the base branch', 'trunk');
    const merged = { ...replayed, head: git('rev-parse', 'HEAD') };
    await bench([merged]);
    expect(datedAt()).toBe(Date.parse(asOf));
    // A head that merges the change in has no commit of its own, so every commit it merged counts.
    git('checkout', '-q', '--detach', replayed.base);
    git('merge', '-q', '--no-ff', '-m', 'merge the change', merged.head);
    const mergeOfChange = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-');
    await bench([{ ...replayed, head: mergeOfChange }]);
    expect(datedAt()).toBe(Date.parse('2025-06-01T10:00:00Z'));
    // A case whose change cannot be dated fails without a review, so it never reads the newest related code. Without related repos it needs no date.
    const orphan = git('commit-tree', git('rev-parse', 'HEAD^{tree}'), '-m', 'unrelated history');
    const reviewed = baseReview.mock.calls.length;
    const undated = await bench([{ ...replayed, base: replayed.head }, { ...replayed, id: 'demo-2', base: orphan }]);
    expect(baseReview).toHaveBeenCalledTimes(reviewed);
    expect(undated[0].results.map(r => [r.runs[0].outcome, r.runs[0].complete])).toEqual([['FAILED', false], ['FAILED', false]]);
    expect(undated[0].results[0].runs[0].error).toBe('Case demo-1 has no date to read its related repos at: its head holds no commit past the merge base.');
    expect(undated[0].results[1].runs[0].error).toContain('Case demo-2 has no date to read its related repos at: the merge base of its base and head cannot be read. Git said: ');
    await bench([{ ...benchCase, base: benchCase.head, head: benchCase.head }]);
    expect(baseReview).toHaveBeenCalledTimes(reviewed + 1);
    expect(baseReview.mock.calls.at(-1)![0]).not.toHaveProperty('relatedReposAsOf');
    const [{ variant, results }] = await runBench([benchCase], { runs: 5, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, matcher, review, onCase, variants: [{ name: 'opus', overrides }] });

    expect(review).toHaveBeenCalledTimes(5);
    expect(review.mock.calls[0]).toEqual([expect.objectContaining({
      repoRoot: checkout, base: benchCase.base, head: benchCase.head, title: 'fix: bound the reader', body: 'Reads lengths with a bound.\n', configOverrides: overrides,
    })]);
    expect(variant).toEqual({ name: 'opus', overrides });
    const ownReview = jest.fn(async (_input: LocalReviewInput) => makeReview('READY', []));
    await runBench([{ ...benchCase, config: { review_passes: 2 } }], { runs: 1, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, matcher, review: ownReview, variants: [{ name: 'opus', overrides }] });
    expect(ownReview.mock.calls[0][0].config).toMatchObject({ review_passes: 2, models: { reviewer: 'claude-opus-5-5' } });
    expect(ownReview.mock.calls[0][0]).not.toHaveProperty('configOverrides');
    expect(onCase).toHaveBeenCalledWith([{ variant, results }]);
    expect(results[0].runs[1]).toMatchObject({ outcome: 'FAILED', complete: false, error: 'provider down', mustCatchRecall: null, verdictCorrect: null });

    const report = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 5, matcherModel: 'model-a' }, [
      { variant: { name: 'base', overrides: {} }, results },
      { variant: { name: 'opus', overrides }, results },
    ]);
    expect(report.variants.map(v => [v.name, v.overrides])).toEqual([['base', {}], ['opus', overrides]]);
    expect(report.variants[0].cases[0].items).toEqual([
      { id: 'K1', tier: 'must_catch', severity: 'blocker', caught: 2, partial: 1, runs: 3 },
      { id: 'K2', tier: 'must_catch', severity: 'warning', caught: 0, partial: 0, runs: 3 },
      { id: 'N1', tier: 'nice_to_have', severity: 'suggestion', caught: 0, partial: 0, runs: 3 },
    ]);
    expect(report.variants[0].summary).toEqual({
      runs: 5, incompleteRuns: 2, mustCatchRecall: 1 / 3, weightedRecall: expect.closeTo(0.4), atGradeRecall: 1 / 3, verdictAccuracy: 2 / 3,
      bySeverity: { blocker: { caught: 2, partial: 1, total: 3 }, warning: { caught: 0, partial: 0, total: 3 } },
      falseBlockers: 0, unexpectedWarnings: 0, extraFindings: 0, duplicates: 0, resolvedRight: null, resolvedWrong: null, repeats: null, costUsd: 5, costPerRunUsd: 1.25, wallTimePerRunMs: 90,
    });
    expect(JSON.parse(JSON.stringify(report))).toStrictEqual(report);
    const summary = formatBenchSummary(report);
    expect(summary).toMatch(/^== base\ndemo-1 \(demo upstream PR 7\)\n/);
    expect(summary).toContain('\n== opus\n');
    expect(summary).toContain('  K1 must blocker: 2/3, 1 partial\n');
    expect(summary).toContain('  run 2: FAILED: provider down\n');
    expect(summary).toContain('  run 4: INCOMPLETE: The review did not complete.\n');
    expect(summary).toContain('  run 3: READY, recall 0%, 0 false blockers, 0 unexpected warnings, 0 extra, 0 duplicates, files read finder-a 3, $1.25\n');
    expect(summary).toContain('5 runs (2 incomplete). Must-catch recall 33%, weighted 40%, at grade 33%, verdicts 67%.');
    expect(summary).not.toContain('Follow-up rounds');
    expect(summary).toContain('By severity: blocker 2/3, warning 0/3. False blockers 0, unexpected warnings 0, extra findings 0, duplicates 0, cost $5.00.');
    expect(summary.slice(summary.indexOf('| Metric'))).toBe([
      '| Metric | base | opus |',
      '| --- | --- | --- |',
      '| Must-catch recall | 33% | 33% |',
      '| Weighted recall | 40% | 40% |',
      '| Must-catch at grade | 33% | 33% |',
      '| Verdict accuracy | 67% | 67% |',
      '| False blockers | 0 | 0 |',
      '| Unexpected warnings | 0 | 0 |',
      '| Extra findings | 0 | 0 |',
      '| Duplicates | 0 | 0 |',
      '| Resolved right | n/a | n/a |',
      '| Resolved wrong | n/a | n/a |',
      '| Repeats | n/a | n/a |',
      '| Incomplete runs | 2 of 5 | 2 of 5 |',
      '| Config invalid | none | none |',
      '| Cost per run | $1.25 | $1.25 |',
      '| Wall time per run | 0m 00s | 0m 00s |',
      '| demo-1 K1 (must blocker) | 2/3, 1 partial | 2/3, 1 partial |',
      '| demo-1 K2 (must warning) | 0/3 | 0/3 |',
      '| demo-1 N1 (nice suggestion) | 0/3 | 0/3 |',
      '',
    ].join('\n'));
    expect(report.variants[0].sets).toEqual({ tuning: report.variants[0].summary });

    const held = { benchCase: { ...benchCase, id: 'demo-2', set: 'holdout' as const }, runs: results[0].runs.slice(0, 1) };
    const split = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 5, matcherModel: 'model-a' }, [{ variant, results: [...results, held] }]);
    expect(split.variants[0].summary.runs).toBe(6);
    expect(split.variants[0].sets).toEqual({ tuning: report.variants[0].summary, holdout: expect.objectContaining({ runs: 1, mustCatchRecall: 0.5, verdictAccuracy: 1 }) });
    const splitSummary = formatBenchSummary(split);
    expect(splitSummary).toContain('\ntuning: 5 runs (2 incomplete). Must-catch recall 33%');
    expect(splitSummary).toContain('\nholdout: 1 runs (0 incomplete). Must-catch recall 50%');
    expect(splitSummary).toContain('| Metric | opus tuning | opus holdout |\n| --- | --- | --- |\n| Must-catch recall | 33% | 50% |\n');
    expect(splitSummary).toContain('| demo-1 K1 (must blocker) | 2/3, 1 partial |  |\n');
    expect(splitSummary).toContain('| demo-2 K1 (must blocker) |  | 1/1 |\n');
  });

  it('tries the matcher again before giving up a finished review, and keeps its findings and cost when it gives up', async () => {
    const review = jest.fn(async () => makeReview('ADDRESS_FIRST', [blocker]));
    let calls = 0;
    const flaky: Matcher = async () => {
      if (calls++ === 0) throw new Error('bad reply');
      return { verdict: 'NONE', findings: [], reason: 'none' };
    };
    const broken: Matcher = async () => {
      throw new Error('no such model');
    };
    const options = { runs: 1, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, review };

    const [{ results: [retried] }] = await runBench([benchCase], { ...options, matcher: flaky });
    expect(retried.runs[0]).toMatchObject({ outcome: 'ADDRESS_FIRST', complete: true });
    expect(retried.runs[0].error).toBeUndefined();

    const [{ results: [failed] }] = await runBench([benchCase], { ...options, matcher: broken });
    expect(failed.runs[0]).toMatchObject({ outcome: 'ADDRESS_FIRST', complete: false, error: 'no such model', costUsd: 1.25, mustCatchRecall: null });
    expect(failed.runs[0].findings).toEqual([{ severity: 'blocker', title: 'A finding', file: 'src/read.rs', line: 1, description: 'Something.' }]);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it('stops on an abort instead of recording the run as failed', async () => {
    const cancel = new AbortController();
    const review = jest.fn(async () => {
      cancel.abort(new Error('Interrupted'));
      throw new Error('aborted call');
    });
    await expect(runBench([benchCase], { runs: 2, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, matcher: jest.fn(), review, signal: cancel.signal })).rejects.toThrow('Interrupted');
    expect(review).toHaveBeenCalledTimes(1);
  });

  it('checks every checkout and every variant before the first review', async () => {
    const review = jest.fn();
    const options = { runs: 1, providerInputs: inputs, matcher: jest.fn(), review };
    const checkouts = new Map([['owner/demo', checkout]]);
    const good = { name: 'good', overrides: { review_passes: 2 } };
    await expect(runBench([benchCase], { ...options, checkouts, variants: [good, { name: 'bad', overrides: { review_passes: 9 } }] }))
      .rejects.toThrow('Variant bad does not load on case demo-1: Invalid config in .manki.yml with the overrides');
    await expect(runBench([benchCase], { ...options, checkouts, variants: [good, { name: 'typo', overrides: { models: { reviwer: 'claude-opus-5-5' } } }] }))
      .rejects.toThrow('Variant typo does not load on case demo-1: The config overrides name keys the config does not know: Unknown config key: "models.reviwer"');
    await expect(runBench([benchCase], { ...options, checkouts: new Map() })).rejects.toThrow('No checkout for owner/demo');
    await expect(runBench([{ ...benchCase, head: 'c'.repeat(40) }], { ...options, checkouts: new Map([['owner/demo', checkout]]) })).rejects.toThrow(new RegExp(`Commit ${'c'.repeat(40)} of case demo-1 is not in .*Git said: `));
    await expect(runBench([{ ...benchCase, priorRound: { head: 'd'.repeat(40), findings: [] } }], { ...options, checkouts: new Map([['owner/demo', checkout]]) }))
      .rejects.toThrow(`Commit ${'d'.repeat(40)} of case demo-1 is not in`);
    expect(review).not.toHaveBeenCalled();
  });

  it('reviews no case whose config does not load, records each of its runs as config invalid, and still reviews the other cases', async () => {
    writeFileSync(join(checkout, '.manki.yml'), 'review:\n  classes:\n    wallet: { rank: 86, critical: true, match: { paths_any: ["wallet/**"] } }\n');
    git('add', '.manki.yml');
    git('commit', '-q', '-m', 'old config format');
    const held = { ...benchCase, id: 'held', base: git('rev-parse', 'HEAD') };
    git('commit', '-q', '--allow-empty', '-m', 'head on the old config');
    held.head = git('rev-parse', 'HEAD');
    const own = { ...benchCase, id: 'own', config: { review_passes: 9 } };
    const typo = { ...benchCase, id: 'typo', config: { review: { critcal_paths: ['wallet/**'] } } };
    const translated = { ...held, id: 'translated', config: { review: { critical_paths: ['wallet/**'] } } };
    const review = jest.fn(async (_input: LocalReviewInput) => makeReview('READY', []));
    const variants = [{ name: 'base', overrides: {} }, { name: 'passes', overrides: { review_passes: 2 } }];

    const results = await runBench([held, own, translated, benchCase, typo], { runs: 2, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, matcher: async () => ({ verdict: 'NONE', findings: [], reason: 'none' }), review, variants });

    for (const { results: [heldRuns, ownRuns, translatedRuns, plainRuns, typoRuns] } of results) {
      expect(heldRuns.runs).toEqual([1, 2].map(() => expect.objectContaining({
        outcome: 'CONFIG_INVALID', complete: false, costUsd: 0,
        error: 'The config at the base does not load: Invalid config in .manki.yml: `review.classes.wallet.critical` is not a class setting. List the critical paths in `review.critical_paths`',
      })));
      expect(ownRuns.runs.map(run => [run.outcome, run.error])).toEqual([1, 2].map(() => ['CONFIG_INVALID', expect.stringContaining('The config of the case does not load: Invalid config in the config given:')]));
      expect(typoRuns.runs.map(run => [run.outcome, run.error])).toEqual([1, 2].map(() => [
        'CONFIG_INVALID', 'The config of the case does not load: The config given names keys the config does not know: Unknown config key: "review.critcal_paths"',
      ]));
      expect([...translatedRuns.runs, ...plainRuns.runs].map(run => run.outcome)).toEqual(['READY', 'READY', 'READY', 'READY']);
    }
    expect(review).toHaveBeenCalledTimes(8);
    expect(review.mock.calls.map(([input]) => input.config?.review?.critical_paths)).toEqual([['wallet/**'], ['wallet/**'], undefined, undefined, ['wallet/**'], ['wallet/**'], undefined, undefined]);
    const summary = formatBenchSummary(buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 2, matcherModel: 'model-a' }, results));
    expect(summary).toContain('  run 1: CONFIG_INVALID: The config at the base does not load: Invalid config in .manki.yml:');
    expect(summary).toContain('| Config invalid | held, own, typo | held, own, typo |\n');
    expect(summary).toContain('| Cost per run | $1.25 | $1.25 |\n');
  });
});

describe('mergeReports and gateReports', () => {
  type Run = Awaited<ReturnType<typeof scoreRun>>;
  const meta = { startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' };
  const [first, second] = ['demo-1', 'demo-2'].map(id => parseCase(CASE_YAML.replace('id: demo-1', `id: ${id}`), `${id}.yml`, 'holdout'));
  const tuning = parseCase(CASE_YAML.replace('id: demo-1', 'id: demo-3'), 'demo-3.yml');

  /** A run that reports K1 at `k1`, if given, and `falseBlockers` blockers and `warnings` warnings that match no item. */
  async function run(benchCase: BenchCase, k1?: FindingSeverity, falseBlockers = 0, complete = true, warnings = 0): Promise<Run> {
    const findings = [
      ...(k1 ? [makeFinding({ severity: k1, file: 'src/read.rs' })] : []),
      ...Array.from({ length: falseBlockers }, () => makeFinding({ severity: 'blocker', file: 'src/other.rs' })),
      ...Array.from({ length: warnings }, () => makeFinding({ severity: 'warning', file: 'src/other.rs' })),
    ];
    const matcher: Matcher = async item => (item.id === 'K1' && k1 ? { verdict: 'MATCH', findings: [0], reason: 'same' } : { verdict: 'NONE', findings: [], reason: 'none' });
    return scoreRun(benchCase, makeReview(k1 === 'blocker' ? 'ADDRESS_FIRST' : 'READY', findings, complete), matcher);
  }

  /** The same report as a second run of its ref, started later. */
  const again = (r: BenchReport): BenchReport => ({ ...r, startedAt: '2026-11-09T01:00:00.000Z' });

  function report(runs: Array<[BenchCase, Run[]]>) {
    return buildReport(meta, [{ variant: { name: 'base', overrides: {} }, results: runs.map(([benchCase, caseRuns]) => ({ benchCase, runs: caseRuns })) }]);
  }

  it('joins one report per case, takes each set from the cases, and fails a case no report holds', async () => {
    const parts = [
      { ...report([[{ ...first, set: 'tuning' }, [await run(first, 'blocker')]]]), startedAt: '2026-11-09T02:00:00.000Z' },
      report([[tuning, [await run(tuning)]]]),
    ];
    const merged = mergeReports(parts, [first, second, tuning], { ref: 'v7.3.0', commit: 'c'.repeat(40) });
    expect(merged).toMatchObject({ ref: 'v7.3.0', commit: 'c'.repeat(40), startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' });
    const [variant] = merged.variants;
    expect(variant.cases.map(c => [c.id, c.set, c.runs.map(r => r.complete)])).toEqual([['demo-1', 'holdout', [true]], ['demo-2', 'holdout', [false]], ['demo-3', 'tuning', [true]]]);
    expect(variant.cases[1].runs[0].error).toBe('No report: the job for this case failed or was cancelled.');
    expect(variant.sets.holdout).toMatchObject({ runs: 2, incompleteRuns: 1, mustCatchRecall: 0.5 });
    expect(() => mergeReports(parts, [first], {})).toThrow('The reports hold case demo-3, which is not one of the cases to merge');
    expect(() => mergeReports([], [first], {})).toThrow('No report to merge');
  });

  it('passes, fails or asks for a rerun on the shared hold-out cases, counting only matches at the key grade, and counts the warnings of a report that does not score them', async () => {
    const baseline = report([[first, [await run(first, 'blocker')]], [second, [await run(second, 'blocker')]], [tuning, [await run(tuning, 'blocker')]]]);
    const gate = async (firstK1?: FindingSeverity, secondK1?: FindingSeverity, falseBlockers = 0, warnings = 0) => gateReports([baseline, again(baseline)], [
      report([[first, [await run(first, firstK1, falseBlockers, true, warnings)]], [second, [await run(second, secondK1)]], [tuning, [await run(tuning)]]]),
    ])[0];

    expect(await gate('blocker', 'blocker')).toMatchObject({
      variant: 'base', verdict: 'PASS', shared: ['demo-1', 'demo-2'],
      baseline: { runs: 2, found: 2, falseBlockers: 0, unexpectedWarnings: 0 }, candidate: { runs: 1, found: 2, falseBlockers: 0, unexpectedWarnings: 0 },
    });
    expect(gateReports([baseline], [baseline])[0]).toMatchObject({
      verdict: 'NO DECISION', baseline: { runs: 1 },
      reason: "The baseline has 1 run per case, and the gate decides on 2. Run the baseline's ref again and give both runs as the baseline.",
    });
    expect(await gate('blocker', 'blocker', 1)).toMatchObject({
      verdict: 'RERUN', reason: 'False blockers rose from 0 to 1 per run, within the margin of 1. Run the candidate once more and decide on the mean of both runs.',
    });
    expect(await gate('blocker', 'blocker', 2)).toMatchObject({ verdict: 'FAIL', reason: 'False blockers rose from 0 to 2 per run, by more than 1.' });
    expect(await gate('blocker', 'blocker', 0, 1)).toMatchObject({
      verdict: 'RERUN', reason: 'Unexpected warnings rose from 0 to 1 per run, within the margin of 1. Run the candidate once more and decide on the mean of both runs.',
    });
    expect(await gate('blocker', 'blocker', 0, 2)).toMatchObject({ verdict: 'FAIL', reason: 'Unexpected warnings rose from 0 to 2 per run, by more than 1.' });
    const warned = report([[first, [await run(first, 'warning', 0, true, 2)]], [second, [await run(second, 'blocker')]]]);
    const unscored: BenchReport = JSON.parse(JSON.stringify(warned, (key, value: unknown) => (key === 'unexpectedWarnings' ? undefined : value)));
    expect(unscored.variants[0].cases[0].runs[0]).not.toHaveProperty('unexpectedWarnings');
    expect(gateReports([unscored, again(unscored)], [report([[first, [await run(first, 'warning', 0, true, 4)]], [second, [await run(second, 'blocker')]]])])[0]).toMatchObject({
      verdict: 'FAIL', baseline: { unexpectedWarnings: 2 }, candidate: { unexpectedWarnings: 4 }, reason: 'Unexpected warnings rose from 2 to 4 per run, by more than 1.',
    });
    const followUps = async (scores: Partial<NonNullable<Run['followUp']>>) => report([
      [first, [{ ...await run(first, 'blocker'), followUp: { resolved: [], resolvedRight: 0, resolvedWrong: 0, repeats: 0, ...scores } }]], [second, [await run(second, 'blocker')]],
    ]);
    expect(gateReports([await followUps({}), again(await followUps({}))], [await followUps({ resolvedWrong: 2, repeats: 2 })])[0]).toMatchObject({
      verdict: 'FAIL', reason: 'Earlier threads resolved that the key keeps open rose from 0 to 2, and earlier findings posted again rose from 0 to 2 per run, by more than 1.',
    });
    const firstRoundOnOneSide = gateReports([baseline, again(baseline)], [await followUps({ resolvedWrong: 1 })])[0];
    expect(firstRoundOnOneSide).toMatchObject({ verdict: 'PASS', shared: ['demo-2'], unlike: ['demo-1'] });
    expect(formatGate([firstRoundOnOneSide])).toContain('Left out, scored as a follow-up round on one side and as a first round on the other: demo-1\n');
    const onlyUnlike = report([[first, [{ ...await run(first, 'blocker'), followUp: { resolved: [], resolvedRight: 0, resolvedWrong: 0, repeats: 0 } }]]]);
    expect(gateReports([report([[first, [await run(first, 'blocker')]]])], [onlyUnlike])[0]).toMatchObject({ verdict: 'NO DECISION', shared: [], unlike: ['demo-1'] });
    expect(gateReports([await followUps({ resolvedRight: 1 }), again(await followUps({ resolvedRight: 1 }))], [await followUps({ resolvedRight: 0 })])[0]).toMatchObject({
      verdict: 'RERUN', reason: 'Earlier threads resolved as the key says fell from 1 to 0 per run, within the margin of 1. Run the candidate once more and decide on the mean of both runs.',
    });
    expect(await gate('blocker', 'warning')).toMatchObject({ verdict: 'RERUN', candidate: { found: 1 } });
    expect(await gate(undefined, undefined, 1)).toMatchObject({ verdict: 'FAIL', reason: "Must-catch items found at the key's grade fell from 2 to 0 per run, by more than 1." });

    const rerun = report([[first, [await run(first, 'blocker')]], [second, [await run(second)]]]);
    const atMargin = report([[first, [await run(first, 'blocker')]], [second, [await run(second, 'blocker')]]]);
    expect(gateReports([baseline, again(baseline)], [rerun, again(atMargin)])[0]).toMatchObject({
      verdict: 'PASS', candidate: { runs: 2, found: 1.5 },
      reason: "Must-catch items found at the key's grade fell from 2 to 1.5 on the mean of 2 runs, within the margin of 1. No other figure got worse.",
    });
    const noisy = report([[first, [await run(first, 'blocker', 2)]], [second, [await run(second, 'blocker')]]]);
    expect(gateReports([baseline, again(baseline)], [noisy, again(atMargin)])[0]).toMatchObject({ verdict: 'PASS', candidate: { runs: 2, falseBlockers: 1 } });
    expect(gateReports([baseline, again(baseline)], [rerun, again(rerun)])[0]).toMatchObject({ verdict: 'PASS', candidate: { runs: 2, found: 1 } });
  });

  it('decides nothing on an incomplete run, a config that does not load or without a shared hold-out case, and leaves a case with another key version out', async () => {
    const baseline = report([[first, [await run(first, 'blocker')]], [second, [await run(second, 'blocker')]]]);
    expect(gateReports([baseline, again(baseline)], [report([[first, [await run(first, 'blocker', 0, false)]], [second, [await run(second, 'blocker')]]])])[0]).toMatchObject({
      verdict: 'NO DECISION', reason: 'The candidate has incomplete reviews on demo-1. A run with incomplete reviews does not count, so run that side again.',
    });
    const unloadable = report([[first, [{ ...await run(first, 'blocker', 0, false), outcome: 'CONFIG_INVALID' }]], [second, [await run(second, 'blocker', 0, false)]]]);
    expect(gateReports([baseline, again(baseline)], [unloadable])[0]).toMatchObject({
      verdict: 'NO DECISION',
      reason: "The candidate has no review of demo-1, because the case's config does not load. Another run changes nothing until each such case holds a `config:` that loads. "
        + 'The candidate has incomplete reviews on demo-2. A run with incomplete reviews does not count, so run that side again.',
    });
    const rekeyed = report([[first, [await run(first, 'blocker')]], [{ ...second, keyVersion: 3 }, [await run(second)]]]);
    const otherKey = gateReports([baseline, again(baseline)], [rekeyed])[0];
    expect(otherKey).toMatchObject({ verdict: 'PASS', shared: ['demo-1'], rekeyed: ['demo-2'] });
    expect(formatGate([otherKey])).toContain('Left out, scored with different key versions: demo-2. Score the reports with the older key again with `manki bench --rescore` to compare them.\n');
    expect(gateReports([baseline, again(baseline)], [report([[tuning, [await run(tuning)]]])])[0]).toMatchObject({ verdict: 'NO DECISION', shared: [] });
    expect(() => gateReports([], [baseline])).toThrow('The gate needs a baseline and a candidate report');
    const at = (commit: string) => ({ ...baseline, commit });
    expect(gateReports([at('a'), again(at('a'))], [at('b'), again(at('b'))])[0].verdict).toBe('PASS');
    expect(() => gateReports([at('a')], [at('b'), at('c')])).toThrow('The candidate reports reviewed different commits: b, c');
    expect(() => gateReports([at('a'), at('d')], [at('b')])).toThrow('The baseline reports reviewed different commits: a, d');
    expect(() => gateReports([at('a'), at('a')], [at('b')])).toThrow('The baseline holds the run started at 2026-11-09T00:00:00.000Z twice');
    expect(() => gateReports([at('a'), again(at('a'))], [at('b'), at('b')])).toThrow('The candidate holds the run started at 2026-11-09T00:00:00.000Z twice');
    expect(() => gateReports([at('a')], [at('a')])).toThrow("The baseline reviewed the candidate's own commit a");
    expect(() => gateReports([baseline, again(baseline)], [{ ...baseline, matcherModel: 'model-b' }])).toThrow('The reports were matched by different models: model-a, model-b');

    const text = formatGate(gateReports([baseline, again(baseline)], [baseline]));
    expect(text).toContain([
      '### Release gate, base: PASS', '',
      'No figure got worse.',
      '', '| Figure | Baseline | Candidate |', '| --- | --- | --- |', '| Runs per case | 2 | 1 |', '| Must-catch found at grade | 2 | 2 |', '| Resolved right | 0 | 0 |',
      '| False blockers | 0 | 0 |', '| Unexpected warnings | 0 | 0 |', '| Resolved wrong | 0 | 0 |', '| Repeats | 0 | 0 |', '',
    ].join('\n'));
    expect(text).toContain('Shared hold-out cases (2): demo-1, demo-2');
    expect(text).not.toContain('Left out');
  });

  it('scores a stored report again against a changed key, so the gate compares it, and leaves a case it cannot score with certainty', async () => {
    const confirmed: KeyItem = { id: 'K3', severity: 'warning', mechanism: 'The retry never backs off.', locations: ['src/other.rs'] };
    const rekeyed: BenchCase = { ...second, keyVersion: 3, mustCatch: [...second.mustCatch, confirmed] };
    const stored = report([[first, [await run(first, 'blocker')]], [second, [await run(second, 'blocker', 0, true, 1), await run(second, 'blocker', 0, false, 1)]]]);
    const decisions: Record<string, MatchDecision> = { K1: { verdict: 'MATCH', findings: [0], reason: 'same' }, K3: { verdict: 'MATCH', findings: [0], reason: 'confirmed' } };
    const matcher: Matcher & jest.Mock = jest.fn(async (item: KeyItem) => decisions[item.id] ?? { verdict: 'NONE', findings: [], reason: 'none' });

    const { report: scored, rescored, left } = await rescoreReport(stored, [first, rekeyed], matcher);

    expect({ rescored, left }).toEqual({ rescored: ['demo-2'], left: [] });
    const [kept, changed] = scored.variants[0].cases;
    expect(kept).toBe(stored.variants[0].cases[0]);
    expect(matcher.mock.calls.find(([item]) => item.id === 'K3')![1]).toEqual([{ severity: 'warning', title: 'A finding', file: 'src/other.rs', line: 1, description: 'Something.' }]);
    expect(stored.variants[0].cases[1].runs[0]).toMatchObject({ mustCatchRecall: 0.5, unexpectedWarnings: 1, extraFindings: 1 });
    expect(changed).toMatchObject({ id: 'demo-2', set: 'holdout', keyVersion: 3 });
    expect(changed.items.map(item => [item.id, item.caught, item.runs])).toEqual([['K1', 1, 1], ['K2', 0, 1], ['K3', 1, 1], ['N1', 0, 1]]);
    expect(changed.runs[0]).toMatchObject({ complete: true, outcome: 'ADDRESS_FIRST', mustCatchRecall: 2 / 3, unexpectedWarnings: 0, extraFindings: 0, verdictCorrect: true, costUsd: 1.25 });
    expect(changed.runs[0].matches.find(m => m.item === 'K3')).toEqual({ item: 'K3', verdict: 'MATCH', findings: [1], severity: 'warning', reason: 'confirmed' });
    expect(changed.runs[1]).toBe(stored.variants[0].cases[1].runs[1]);
    expect(scored).toMatchObject({ startedAt: stored.startedAt, matcherModel: 'model-a', variants: [{ name: 'base', summary: { unexpectedWarnings: 1 }, sets: { holdout: { runs: 3 } } }] });
    expect(await rescoreReport(scored, [first, rekeyed], matcher)).toMatchObject({ rescored: [], left: [] });

    const complete = (r: BenchReport): BenchReport => ({ ...r, variants: r.variants.map(v => ({ ...v, cases: v.cases.map(c => ({ ...c, runs: c.runs.filter(one => one.complete) })) })) });
    const candidate = report([[first, [await run(first, 'blocker')]], [rekeyed, [await run(rekeyed, 'blocker')]]]);
    expect(gateReports([complete(stored), again(complete(stored))], [candidate])[0]).toMatchObject({ shared: ['demo-1'], rekeyed: ['demo-2'] });
    expect(gateReports([complete(scored), again(complete(scored))], [candidate])[0]).toMatchObject({ verdict: 'RERUN', shared: ['demo-1', 'demo-2'], baseline: { found: 3 }, candidate: { found: 2 } });

    const bare: BenchReport = JSON.parse(JSON.stringify(stored, (key, value: unknown) => (key === 'description' ? undefined : value)));
    const unread = await rescoreReport(bare, [first, rekeyed], matcher);
    expect(unread).toMatchObject({ rescored: [], left: [{ id: 'demo-2', reason: 'its report holds no text of the findings' }] });
    expect(unread.report.variants[0].cases[1]).toBe(bare.variants[0].cases[1]);
    const followUp = parseCase(FOLLOW_UP_YAML.replace('id: demo-1', 'id: demo-2').replace('key_version: 2', 'key_version: 3'), 'demo-2.yml', 'holdout');
    expect(await rescoreReport(stored, [followUp], matcher)).toMatchObject({ rescored: [], left: [{ id: 'demo-2', reason: 'its runs reviewed a first round' }] });
  });
});

describe('parseBenchArgs', () => {
  it('reads the options and defaults', () => {
    expect(parseBenchArgs([])).toMatchObject({ cases: 'bench/cases', holdout: false, only: [], runs: 3, matcherModel: 'claude-sonnet-5-5', cache: 'bench/.matcher-cache.json', help: false });
    const args = parseBenchArgs([
      '--checkout', 'owner/demo=/src/a=b', '--case', 'x', '--case', 'y', '--runs', '1', '--out', 'r.json', '--matcher-model', 'm', '--cache', 'c.json',
      '--holdout', '--variant', 'base', '--variant', 'opus=bench/opus.yml', '--set', 'models.reviewer=claude-opus-5-5', '--set', 'review_passes=2', '--set', 'exclude_paths=[a, b]',
    ]);
    expect(args).toMatchObject({
      holdout: true, only: ['x', 'y'], runs: 1, out: 'r.json', matcherModel: 'm', cache: 'c.json',
      variants: [{ name: 'base' }, { name: 'opus', file: 'bench/opus.yml' }],
      sets: [{ models: { reviewer: 'claude-opus-5-5' } }, { review_passes: 2 }, { exclude_paths: ['a', 'b'] }],
    });
    expect([...args.checkouts]).toEqual([['owner/demo', '/src/a=b']]);
  });

  it.each([
    [['--runs', '0'], '--runs must be a positive integer'],
    [['--checkout', 'owner/demo'], '--checkout takes <owner/name>=<dir>'],
    [['--out'], '--out requires a value'],
    [['--bogus'], 'Unknown argument --bogus'],
    [['--config', 'c.yml'], 'Unknown argument --config'],
    [['--variant', 'two words=x.yml'], '--variant takes <name>[=<file>]'],
    [['--variant', 'a', '--variant', 'a=x.yml'], '--variant a is given twice'],
    [['--set', 'models.reviewer'], '--set takes <key.path>=<value>'],
    [['--set', 'models..reviewer=x'], '--set takes <key.path>=<value>'],
  ])('refuses %j', (argv, message) => {
    expect(() => parseBenchArgs(argv)).toThrow(message);
  });
});

describe('resolveVariants', () => {
  it('runs the base config without a variant, reads each variant file, and sets every --set on top', () => {
    const dir = mkdtempSync(join(tmpdir(), 'manki-variants-'));
    try {
      const opus = join(dir, 'opus.yml');
      writeFileSync(opus, 'models:\n  reviewer: claude-opus-5-5\n  reviewer_pair: claude-opus-5-5\n');
      writeFileSync(join(dir, 'empty.yml'), '');
      writeFileSync(join(dir, 'list.yml'), '- a\n');
      const sets = [{ models: { judge: 'claude-sonnet-5-5' } }];

      expect(resolveVariants({ variants: [], sets: [] })).toEqual([{ name: 'base', overrides: {} }]);
      expect(resolveVariants({ variants: [{ name: 'base' }, { name: 'opus', file: opus }, { name: 'empty', file: join(dir, 'empty.yml') }], sets })).toEqual([
        { name: 'base', overrides: { models: { judge: 'claude-sonnet-5-5' } } },
        { name: 'opus', overrides: { models: { reviewer: 'claude-opus-5-5', reviewer_pair: 'claude-opus-5-5', judge: 'claude-sonnet-5-5' } } },
        { name: 'empty', overrides: { models: { judge: 'claude-sonnet-5-5' } } },
      ]);
      expect(() => resolveVariants({ variants: [{ name: 'list', file: join(dir, 'list.yml') }], sets: [] })).toThrow('The overrides of variant list');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runBenchCommand', () => {
  const savedEnv = process.env;
  let stdout: jest.SpyInstance;
  let stderr: jest.SpyInstance;

  beforeEach(() => {
    stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdout.mockRestore();
    stderr.mockRestore();
    process.env = savedEnv;
  });

  it('prints the usage for --help', async () => {
    expect(await runBenchCommand(['--help'])).toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('Usage: manki bench'));
  });

  it('exits 2 before any model call without credentials, or without a checkout for a case', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manki-bench-cmd-'));
    try {
      writeFileSync(join(dir, 'demo.yml'), CASE_YAML);
      process.env = {};
      expect(await runBenchCommand(['--cases', dir])).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('manki bench: No credentials set.'));
      process.env = { PATH: savedEnv.PATH, ANTHROPIC_API_KEY: 'sk-test' };
      expect(await runBenchCommand(['--cases', dir, '--cache', join(dir, 'cache.json')])).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('manki bench: No checkout for owner/demo'));
      expect(stdout).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('scores a stored report again with --rescore, without a checkout, and refuses another matcher model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'manki-bench-cmd-'));
    try {
      const benchCase = parseCase(CASE_YAML, 'demo.yml');
      const clean = await scoreRun(benchCase, makeReview('READY', []), async () => ({ verdict: 'NONE', findings: [], reason: 'none' }));
      const stored = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'claude-sonnet-5-5' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [clean] }] }]);
      const [report, cache] = [join(dir, 'report.json'), join(dir, 'cache.json')];
      writeFileSync(report, JSON.stringify(stored));
      writeFileSync(join(dir, 'demo.yml'), `${CASE_YAML.replace('key_version: 2', 'key_version: 3')}  - id: N2\n    severity: warning\n    mechanism: The retry never backs off.\n    locations: [src/retry.rs]\n`);
      process.env = { PATH: savedEnv.PATH, ANTHROPIC_API_KEY: 'sk-test' };

      expect(await runBenchCommand(['--rescore', report, '--cases', dir, '--cache', cache])).toBe(0);
      expect(stdout.mock.calls.map(call => call[0]).join('')).toBe(`Scored again with the changed key: demo-1\nReport: ${join(dir, 'report.rescored.json')}\n`);
      const scored = JSON.parse(readFileSync(join(dir, 'report.rescored.json'), 'utf-8')) as BenchReport;
      expect(scored.variants[0].cases[0]).toMatchObject({ keyVersion: 3, items: [{ id: 'K1' }, { id: 'K2' }, { id: 'N1' }, { id: 'N2', tier: 'nice_to_have', caught: 0, runs: 1 }] });

      expect(await runBenchCommand(['--rescore', report, '--cases', dir, '--cache', cache, '--matcher-model', 'claude-opus-5-5'])).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('The report was matched by claude-sonnet-5-5. Pass --matcher-model claude-sonnet-5-5 to score it again.'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
