import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { BenchCase, buildReport, candidateFindings, formatBenchSummary, formatGate, gateReports, KeyItem, llmMatcher, loadCases, loadMatcherCache, MatchDecision, Matcher, mergeReports, parseBenchArgs, parseCase, resolveVariants, runBench, runBenchCommand, scoreRun } from './bench';
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
    [`  head: ${SHA_C}`, '  head: abc', '`prior_round.head` must be a full commit SHA'],
    ['  - id: P2\n    severity: warning\n    mechanism: The read', '  - id: K1\n    severity: warning\n    locations: [src/conn.rs]\n    mechanism: The read', '`must_keep_open` names K1, which is no earlier finding'],
    ['  - id: P2\n    severity: warning\n    mechanism: The read', '  - id: P4\n    severity: warning\n    locations: [src/conn.rs]\n    mechanism: The read', '`must_keep_open` names P4, which is no open earlier thread'],
  ])('refuses a follow-up case where %s is %s', (from, to, message) => {
    expect(() => parseCase(FOLLOW_UP_YAML.replace(from, to), 'bad.yml')).toThrow(message);
  });

  it('refuses follow-up items without an earlier round', () => {
    expect(() => parseCase(`${CASE_YAML}must_not_repeat: [P1]\n`, 'bad.yml')).toThrow('`must_resolve`, `must_keep_open` and `must_not_repeat` need a `prior_round`');
  });

  it('reads a clean case without key items', () => {
    const clean = parseCase(CASE_YAML.slice(0, CASE_YAML.indexOf('must_catch:')), 'clean.yml');
    expect([clean.mustCatch, clean.niceToHave]).toEqual([[], []]);
  });

  it.each([
    ['repo: owner/demo', 'repo: demo', '`repo` must be `owner/name`'],
    [`base: ${SHA_A}`, 'base: abc', '`base` must be a full commit SHA'],
    ['key_version: 2', 'key_version: two', '`key_version` must be a number'],
    ['title: "fix: bound the reader"', 'title: ""', '`title` must be a non-empty string'],
    ['severity: warning', 'severity: major', 'must_catch[1].severity must be one of blocker, warning, suggestion, nitpick'],
    ['locations: [unlock]', 'locations: unlock', 'must_catch[1].locations must be a list of strings'],
    ['source: owner review', 'source: [owner]', 'must_catch[0].source must be a string'],
    ['  - id: N1', '  - id: K1', 'item id K1 is used twice'],
  ])('refuses a case where %s is %s', (from, to, message) => {
    expect(() => parseCase(CASE_YAML.replace(from, to), 'bad.yml')).toThrow(`bad.yml`);
    expect(() => parseCase(CASE_YAML.replace(from, to), 'bad.yml')).toThrow(message);
  });

  it('parses every tuning and hold-out case, with unique ids and no linked reference to a repository outside the forks', () => {
    const files = [CASES_DIR, HOLDOUT_DIR].flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.yml')).map(f => join(dir, f)));
    const cases = loadCases({ tuning: CASES_DIR, holdout: HOLDOUT_DIR });
    expect(cases).toHaveLength(files.length);
    expect(cases.filter(c => c.set === 'holdout' && c.repo !== 'xdustinface/rust-dashcore').length).toBeGreaterThanOrEqual(8);
    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      expect(text).not.toMatch(/dashpay\//i);
      const references = [...text.matchAll(/([\w.-]+)\/[\w.-]+#\d+/g)].map(m => m[1]);
      expect(references.filter(owner => owner !== 'xdustinface' && owner !== 'manki-review')).toEqual([]);
    }
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

  it('scores recall, severity credit, extra findings, false blockers and duplicates, and counts finder reads and cost', async () => {
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
      outcome: 'ADDRESS_FIRST', complete: true, mustCatchRecall: 0.5, weightedRecall: 3 / 5, verdictCorrect: true, falseBlockers: 1, extraFindings: 1, duplicates: 1,
      finders: [{ name: 'finder-a', model: 'claude-sonnet-5-5', toolSteps: 4, filesRead: 3 }],
      costUsd: 1.25, inputTokens: 1000, outputTokens: 100, durationMs: 90,
    });
    expect(score.findings[2]).toEqual({ severity: 'blocker', title: 'Invented', file: 'src/other.rs', line: 1 });
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
      verdictCorrect: true, falseBlockers: 0, extraFindings: 0, duplicates: 0, followUp: { resolved: ['P1', 'P2'], resolvedRight: 1, resolvedWrong: 1, repeats: 2 },
    });
    expect(await scoreRun(followUp, review(false), matcher)).not.toHaveProperty('followUp');
    const reworded = await scoreRun(followUp, review(), async item => (item.id === 'P2' ? { verdict: 'PARTIAL', findings: [0], reason: 'other mechanism' } : decisions[item.id] ?? { verdict: 'NONE', findings: [], reason: 'none' }));
    expect(reworded).toMatchObject({ falseBlockers: 1, extraFindings: 1, followUp: { repeats: 1 } });

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

  beforeAll(() => {
    checkout = mkdtempSync(join(tmpdir(), 'manki-bench-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: checkout, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
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
    const [{ variant, results }] = await runBench([benchCase], { runs: 5, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, matcher, review, onCase, variants: [{ name: 'opus', overrides }] });

    expect(review).toHaveBeenCalledTimes(5);
    expect(review.mock.calls[0]).toEqual([expect.objectContaining({
      repoRoot: checkout, base: benchCase.base, head: benchCase.head, title: 'fix: bound the reader', body: 'Reads lengths with a bound.\n', configOverrides: overrides,
    })]);
    expect(variant).toEqual({ name: 'opus', overrides });
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
      falseBlockers: 0, extraFindings: 0, duplicates: 0, resolvedRight: null, resolvedWrong: null, repeats: null, costUsd: 5, costPerRunUsd: 1.25, wallTimePerRunMs: 90,
    });
    expect(JSON.parse(JSON.stringify(report))).toStrictEqual(report);
    const summary = formatBenchSummary(report);
    expect(summary).toMatch(/^== base\ndemo-1 \(demo upstream PR 7\)\n/);
    expect(summary).toContain('\n== opus\n');
    expect(summary).toContain('  K1 must blocker: 2/3, 1 partial\n');
    expect(summary).toContain('  run 2: FAILED: provider down\n');
    expect(summary).toContain('  run 4: INCOMPLETE: The review did not complete.\n');
    expect(summary).toContain('  run 3: READY, recall 0%, 0 false blockers, 0 extra, 0 duplicates, files read finder-a 3, $1.25\n');
    expect(summary).toContain('5 runs (2 incomplete). Must-catch recall 33%, weighted 40%, at grade 33%, verdicts 67%.');
    expect(summary).not.toContain('Follow-up rounds');
    expect(summary).toContain('By severity: blocker 2/3, warning 0/3. False blockers 0, extra findings 0, duplicates 0, cost $5.00.');
    expect(summary.slice(summary.indexOf('| Metric'))).toBe([
      '| Metric | base | opus |',
      '| --- | --- | --- |',
      '| Must-catch recall | 33% | 33% |',
      '| Weighted recall | 40% | 40% |',
      '| Must-catch at grade | 33% | 33% |',
      '| Verdict accuracy | 67% | 67% |',
      '| False blockers | 0 | 0 |',
      '| Extra findings | 0 | 0 |',
      '| Duplicates | 0 | 0 |',
      '| Resolved right | n/a | n/a |',
      '| Resolved wrong | n/a | n/a |',
      '| Repeats | n/a | n/a |',
      '| Incomplete runs | 2 of 5 | 2 of 5 |',
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
    expect(failed.runs[0].findings).toEqual([{ severity: 'blocker', title: 'A finding', file: 'src/read.rs', line: 1 }]);
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
});

describe('mergeReports and gateReports', () => {
  type Run = Awaited<ReturnType<typeof scoreRun>>;
  const meta = { startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' };
  const [first, second] = ['demo-1', 'demo-2'].map(id => parseCase(CASE_YAML.replace('id: demo-1', `id: ${id}`), `${id}.yml`, 'holdout'));
  const tuning = parseCase(CASE_YAML.replace('id: demo-1', 'id: demo-3'), 'demo-3.yml');

  /** A run that reports K1 at `k1`, if given, and `falseBlockers` blockers that match no item. */
  async function run(benchCase: BenchCase, k1?: FindingSeverity, falseBlockers = 0, complete = true): Promise<Run> {
    const findings = [
      ...(k1 ? [makeFinding({ severity: k1, file: 'src/read.rs' })] : []),
      ...Array.from({ length: falseBlockers }, () => makeFinding({ severity: 'blocker', file: 'src/other.rs' })),
    ];
    const matcher: Matcher = async item => (item.id === 'K1' && k1 ? { verdict: 'MATCH', findings: [0], reason: 'same' } : { verdict: 'NONE', findings: [], reason: 'none' });
    return scoreRun(benchCase, makeReview(k1 === 'blocker' ? 'ADDRESS_FIRST' : 'READY', findings, complete), matcher);
  }

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

  it('passes, fails or asks for a rerun on the shared hold-out cases, counting only matches at the key grade', async () => {
    const baseline = report([[first, [await run(first, 'blocker')]], [second, [await run(second, 'blocker')]], [tuning, [await run(tuning, 'blocker')]]]);
    const gate = async (firstK1?: FindingSeverity, secondK1?: FindingSeverity, falseBlockers = 0) => gateReports([baseline], [
      report([[first, [await run(first, firstK1, falseBlockers)]], [second, [await run(second, secondK1)]], [tuning, [await run(tuning)]]]),
    ])[0];

    expect(await gate('blocker', 'blocker')).toMatchObject({
      variant: 'base', verdict: 'PASS', shared: ['demo-1', 'demo-2'],
      baseline: { runs: 1, found: 2, falseBlockers: 0 }, candidate: { runs: 1, found: 2, falseBlockers: 0 },
    });
    expect(await gate('blocker', 'blocker', 1)).toMatchObject({ verdict: 'FAIL', reason: 'False blockers rose from 0 to 1 per run.' });
    const followUps = async (scores: Partial<NonNullable<Run['followUp']>>) => report([
      [first, [{ ...await run(first, 'blocker'), followUp: { resolved: [], resolvedRight: 0, resolvedWrong: 0, repeats: 0, ...scores } }]], [second, [await run(second, 'blocker')]],
    ]);
    expect(gateReports([await followUps({})], [await followUps({ resolvedWrong: 1, repeats: 2 })])[0]).toMatchObject({
      verdict: 'FAIL', reason: 'Earlier threads resolved that the key keeps open rose from 0 to 1 per run. Earlier findings posted again rose from 0 to 2 per run.',
    });
    const firstRoundOnOneSide = gateReports([baseline], [await followUps({ resolvedWrong: 1 })])[0];
    expect(firstRoundOnOneSide).toMatchObject({ verdict: 'PASS', shared: ['demo-2'], unlike: ['demo-1'] });
    expect(formatGate([firstRoundOnOneSide])).toContain('Left out, scored as a follow-up round on one side and as a first round on the other: demo-1\n');
    const onlyUnlike = report([[first, [{ ...await run(first, 'blocker'), followUp: { resolved: [], resolvedRight: 0, resolvedWrong: 0, repeats: 0 } }]]]);
    expect(gateReports([report([[first, [await run(first, 'blocker')]]])], [onlyUnlike])[0]).toMatchObject({ verdict: 'NO DECISION', shared: [], unlike: ['demo-1'] });
    expect(gateReports([await followUps({ resolvedRight: 1 })], [await followUps({ resolvedRight: 0 })])[0]).toMatchObject({
      verdict: 'RERUN', reason: 'Earlier threads resolved as the key says fell by 1, within the margin of 1. Run the candidate once more and decide on the mean of both runs.',
    });
    expect(await gate('blocker', 'warning')).toMatchObject({ verdict: 'RERUN', candidate: { found: 1 } });
    expect(await gate()).toMatchObject({ verdict: 'FAIL', reason: "Must-catch items found at the key's grade fell by 2, more than 1." });

    const rerun = report([[first, [await run(first, 'blocker')]], [second, [await run(second)]]]);
    const atMargin = report([[first, [await run(first, 'blocker')]], [second, [await run(second, 'blocker')]]]);
    expect(gateReports([baseline], [rerun, atMargin])[0]).toMatchObject({
      verdict: 'PASS', candidate: { runs: 2, found: 1.5 },
      reason: "False blockers, earlier threads resolved that the key keeps open and earlier findings posted again did not rise. Must-catch items found at the key's grade fell by 0.5 on the mean of 2 runs, within the margin of 1.",
    });
    expect(gateReports([baseline], [rerun, rerun])[0]).toMatchObject({ verdict: 'PASS', candidate: { runs: 2, found: 1 } });
  });

  it('decides nothing on an incomplete run or without a shared hold-out case, and leaves a case with another key version out', async () => {
    const baseline = report([[first, [await run(first, 'blocker')]], [second, [await run(second, 'blocker')]]]);
    expect(gateReports([baseline], [report([[first, [await run(first, 'blocker', 0, false)]], [second, [await run(second, 'blocker')]]])])[0]).toMatchObject({
      verdict: 'NO DECISION', reason: 'The candidate has incomplete reviews on demo-1. A run with incomplete reviews does not count, so run that side again.',
    });
    const rekeyed = report([[first, [await run(first, 'blocker')]], [{ ...second, keyVersion: 3 }, [await run(second)]]]);
    expect(gateReports([baseline], [rekeyed])[0]).toMatchObject({ verdict: 'PASS', shared: ['demo-1'] });
    expect(gateReports([baseline], [report([[tuning, [await run(tuning)]]])])[0]).toMatchObject({ verdict: 'NO DECISION', shared: [] });
    expect(() => gateReports([], [baseline])).toThrow('The gate needs a baseline and a candidate report');
    const at = (commit: string) => ({ ...baseline, commit });
    expect(gateReports([at('a')], [at('b'), at('b')])[0].verdict).toBe('PASS');
    expect(() => gateReports([at('a')], [at('b'), at('c')])).toThrow('The candidate reports reviewed different commits: b, c');
    expect(() => gateReports([at('a')], [at('a')])).toThrow("The baseline reviewed the candidate's own commit a");
    expect(() => gateReports([baseline], [{ ...baseline, matcherModel: 'model-b' }])).toThrow('The reports were matched by different models: model-a, model-b');

    const text = formatGate(gateReports([baseline], [baseline]));
    expect(text).toContain([
      '### Release gate, base: PASS', '',
      "False blockers, earlier threads resolved that the key keeps open and earlier findings posted again did not rise. Must-catch items found at the key's grade and earlier threads resolved as the key says did not fall.",
      '', '| Figure | Baseline | Candidate |', '| --- | --- | --- |', '| Runs per case | 1 | 1 |', '| Must-catch found at grade | 2 | 2 |', '| Resolved right | 0 | 0 |',
      '| False blockers | 0 | 0 |', '| Resolved wrong | 0 | 0 |', '| Repeats | 0 | 0 |', '',
    ].join('\n'));
    expect(text).toContain('Shared hold-out cases (2): demo-1, demo-2');
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
});
