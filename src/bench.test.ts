import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isMap, isScalar, parseDocument } from 'yaml';

import { BenchCase, BenchReport, buildReport, candidateFindings, caseSet, formatBenchSummary, formatBlockerRoutes, formatGate, formatUnmatched, formatVotes, formatWarningSources, gateReports, KeyItem, llmMatcher, loadCases, loadMatcherCache, MatchDecision, Matcher, MatcherSpend, mergeReports, parseBenchArgs, parseCase, readReport, rescoreReport, resolveVariants, runBench, runBenchCommand, scoreRun } from './bench';
import { loadConfigWithOverrides } from './local-review';
import type { LocalReview, LocalReviewInput } from './local-review';
import { printableError } from './cli';
import { cutLegacyCommands, sanitizeLogOutput } from './providers';
import type { LLMClient } from './providers';
import { NAMED_AGAIN_REASON, UNCONFIRMED_FIX_ENDING, WORKAROUND_REASON } from './review';
import { buildLLMClient } from './review-clients';
import { expectLinearTime, GIT_TEST_TIMEOUT_MS } from './test-utils';
import { PRE_EXISTING_TAG, SCOPE_READER_NAME, VERDICT_READER_NAME, VoteLog } from './types';
import type { Doubt, Finding, FindingFingerprintEntry, FindingSeverity, GradeChange, Refutation, RoundContext, RoundDedup, RoundFix, RoundJudge, RoundLead, RoundMemory, RoundOutcome, RoundRawFinding, VoteCitation } from './types';

jest.mock('@actions/core');
jest.mock('./review-clients', () => {
  const actual = jest.requireActual<typeof import('./review-clients')>('./review-clients');
  return { ...actual, buildLLMClient: jest.fn(actual.buildLLMClient) };
});

const IN_ACTIONS = process.env.GITHUB_ACTIONS;
// CI sets `GITHUB_ACTIONS`, which stops any listing of hold-out findings, so each test sets it itself.
beforeAll(() => {
  delete process.env.GITHUB_ACTIONS;
});
afterAll(() => {
  if (IN_ACTIONS !== undefined) process.env.GITHUB_ACTIONS = IN_ACTIONS;
});

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
        - premise: The reader aborts the process.
          decides: grade
          consequence: true
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
      disproved: true
      evidence_files: [src/timeout.rs]
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

/**
 * Returns a round record of `raw`, the findings the finders reported, and of what became of them: the `posted` findings,
 * the `unposted` ones and the record's other lists in `parts`.
 */
function rawRecord(raw: Array<Partial<RoundRawFinding>>, posted: Finding[], parts: { unposted?: Finding[]; judge?: Partial<RoundJudge>; memory?: RoundMemory; dedup?: RoundDedup; leads?: RoundLead[] } = {}): Partial<RoundContext> {
  const entry = (f: Finding): FindingFingerprintEntry => ({
    fingerprint: { file: f.file, lineStart: f.line, lineEnd: f.line, slug: '' }, title: f.title, severity: f.severity, reviewers: f.reviewers,
    ...(f.tags && { tags: f.tags }), ...(f.unpostedReason && { unpostedReason: f.unpostedReason }),
  });
  return {
    reviewers: { agents: ['finder-a', 'finder-b'], rawFindings: raw.map(f => ({ severity: 'warning', title: 'A finding', file: 'src/other.rs', line: 1, description: 'Something.', reviewers: ['finder-a'], ...f })) },
    findings: { count: posted.length, severityCounts: {}, entries: posted.map(entry), ...(parts.unposted && { unposted: parts.unposted.map(entry) }) },
    judge: { summary: '', mergedDuplicates: 0, ...parts.judge },
    memory: parts.memory ?? {},
    dedup: parts.dedup ?? {},
    ...(parts.leads && { leads: parts.leads }),
  };
}

function makeReview(outcome: RoundOutcome, findings: Finding[], complete = true, record: Partial<RoundContext> = {}): LocalReview {
  return {
    result: { verdict: outcome === 'READY' ? 'APPROVE' : 'REQUEST_CHANGES', outcome, summary: '', findings, highlights: [], reviewComplete: complete, agentNames: ['reviewer'] },
    context: {
      ...record,
      usage: {
        estimatedCostUsd: 1.25, inputTokens: 1000, outputTokens: 100, durationMs: 50, wallClockMs: 90,
        llmCalls: [
          { stage: 'reviewer', agent: 'finder-a', model: 'claude-sonnet-5-5', attempt: 1, durationMs: 1, costUsd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, toolSteps: [{ tool: 'Read' }, { tool: 'Grep' }, { tool: 'mcp__manki__read_file' }], filesRead: ['src/a.rs', 'src/b.rs'] },
          { stage: 'reviewer', agent: 'finder-a', model: 'claude-sonnet-5-5', attempt: 2, durationMs: 1, costUsd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, toolSteps: [{ tool: 'Read' }], filesRead: ['src/b.rs', 'src/c.rs'] },
          { stage: 'reviewer', agent: 'Second read 1', model: 'claude-sonnet-5-5', attempt: 1, durationMs: 1, costUsd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, toolSteps: [{ tool: 'Read' }, { tool: 'Grep' }], filesRead: ['src/d.rs'] },
          { stage: 'judge', model: 'claude-opus-5-5', attempt: 1, durationMs: 1, costUsd: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, toolSteps: [{ tool: 'Read' }] },
        ],
      },
      reviewers: { ...record.reviewers, agentMetrics: [{ name: 'finder-a', askedAgain: true, units: [{ unit: 'U1', checked: 'Both paths.' }, { unit: 'U2' }, { unit: 'U3' }] }, { name: 'finder-b' }] },
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
      // The key says `suggestion`. A level an older key names reads as the level it became.
      niceToHave: [{ id: 'N1', severity: 'note', mechanism: 'The test duplicates a helper.', locations: [] }],
      mustResolve: [], mustKeepOpen: [], mustNotRepeat: [],
    });
    for (const old of ['suggestion', 'nitpick', 'nit']) {
      expect(parseCase(CASE_YAML.replace('severity: suggestion', `severity: ${old}`), 'demo.yml').niceToHave[0].severity).toBe('note');
    }
  });

  it('reads a follow-up case with the earlier round and the items that name its findings', () => {
    const followUp = parseCase(FOLLOW_UP_YAML, 'follow.yml');
    expect(followUp.priorRound).toEqual({
      head: SHA_C,
      findings: [
        {
          id: 'P1', severity: 'blocker', title: 'Reader allocates from a peer length', file: 'src/read.rs', line: 12, gradeIfConfirmed: 'blocker', thread: 'open',
          cell: { row: 'severe', column: 'normal' }, doubts: [{ premise: 'A peer can send the length.', decides: 'defect' }, { premise: 'The reader aborts the process.', decides: 'grade', consequence: true }],
          description: 'A peer picks the size.', howToFix: 'Cap the length.', suggestedFix: 'let len = len.min(MAX);', security: true,
        },
        { id: 'P2', severity: 'warning', title: 'No timeout on the connection', file: 'src/conn.rs', line: 40, disproved: true, thread: 'open', evidenceFiles: ['src/timeout.rs'] },
        { id: 'P3', severity: 'note', title: 'The retry loop has no test', file: 'src/conn.rs', line: 70 },
        { id: 'P4', severity: 'warning', title: 'Stale comment', file: 'src/conn.rs', line: 90, thread: 'resolved' },
      ],
    });
    expect(followUp).toMatchObject({
      mustResolve: ['P1'], mustNotRepeat: ['P3'],
      mustKeepOpen: [{ id: 'P2', severity: 'warning', mechanism: 'The read timeout is set, the write timeout is not.', locations: ['src/conn.rs'] }],
    });
    expect(parseCase(FOLLOW_UP_YAML.replace('grade_if_confirmed: blocker', 'grade_if_confirmed: nitpick'), 'follow.yml').priorRound!.findings[0].gradeIfConfirmed).toBe('note');
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
    ['decides: defect', 'decides: maybe', '`doubts` must be a list of mappings with a `premise`, a `decides` of defect or grade, and `consequence: true` only beside `decides: grade`'],
    ['decides: defect', 'decides: defect\n          consequence: true', '`doubts` must be a list of mappings with a `premise`, a `decides` of defect or grade, and `consequence: true` only beside `decides: grade`'],
    ['evidence_files: [src/timeout.rs]', 'evidence_files: src/timeout.rs', '`evidence_files` must be a list of file paths'],
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
    expect(parseCase(`${CASE_YAML}config:\n  max_diff_lines: 2000\n  models: { judge: claude-sonnet-5-5 }\n`, 'own.yml').config).toEqual({ max_diff_lines: 2000, models: { judge: 'claude-sonnet-5-5' } });
    expect(parseCase(`${CASE_YAML}config: {}\n`, 'own.yml').config).toEqual({});
  });

  it.each([
    ['repo: owner/demo', 'repo: demo', '`repo` must be `owner/name`'],
    [`base: ${SHA_A}`, 'base: abc', '`base` must be a full commit SHA'],
    ['key_version: 2', 'key_version: two', '`key_version` must be a number'],
    ['key_version: 2', 'key_version: 2\nconfig: [max_diff_lines]', '`config` must be a mapping of config keys'],
    ['key_version: 2', 'key_version: 2\nconfig:', '`config` must be a mapping of config keys'],
    ['title: "fix: bound the reader"', 'title: ""', '`title` must be a non-empty string'],
    ['severity: warning', 'severity: major', 'must_catch[1].severity must be one of blocker, warning, note'],
    ['locations: [unlock]', 'locations: unlock', 'must_catch[1].locations must be a list of strings'],
    ['source: owner review', 'source: [owner]', 'must_catch[0].source must be a string'],
    ['  - id: N1', '  - id: K1', 'item id K1 is used twice'],
  ])('refuses a case where %s is %s', (from, to, message) => {
    expect(() => parseCase(CASE_YAML.replace(from, to), 'bad.yml')).toThrow(`bad.yml`);
    expect(() => parseCase(CASE_YAML.replace(from, to), 'bad.yml')).toThrow(message);
  });

  it('parses every tuning and hold-out case, with unique ids, a config of its own that loads and no linked reference to a repository outside the forks', async () => {
    const files = [CASES_DIR, HOLDOUT_DIR].flatMap(dir => readdirSync(dir).filter(f => f.endsWith('.yml')).map(f => join(dir, f)));
    const cases = loadCases([CASES_DIR, HOLDOUT_DIR], [], join(__dirname, '..'));
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
  it('keeps only the asked cases of the directories given, and refuses an unknown id, an id used twice, a file not named after its id or a directory without cases', () => {
    const root = mkdtempSync(join(tmpdir(), 'manki-cases-'));
    const [dir, holdout, copies] = [join(root, 'bench', 'cases'), join(root, 'bench', 'holdout'), join(root, 'case-dir')];
    const demo = (id: string) => CASE_YAML.replace('id: demo-1', `id: ${id}`);
    try {
      for (const made of [dir, holdout, copies]) mkdirSync(made, { recursive: true });
      writeFileSync(join(dir, 'demo-1.yml'), CASE_YAML);
      writeFileSync(join(dir, 'demo-2.yml'), demo('demo-2'));
      writeFileSync(join(dir, 'notes.md'), 'not a case');
      writeFileSync(join(holdout, 'demo-3.yml'), demo('demo-3'));
      expect(loadCases([dir], [], root).map(c => c.id)).toEqual(['demo-1', 'demo-2']);
      expect(loadCases([dir], ['demo-2'], root).map(c => c.id)).toEqual(['demo-2']);
      expect(() => loadCases([dir], ['demo-3'], root)).toThrow('No case with id demo-3');
      expect(loadCases([dir, holdout], ['demo-1', 'demo-3'], root).map(c => [c.id, c.set])).toEqual([['demo-1', 'tuning'], ['demo-3', 'holdout']]);

      // The id alone gives a case its set, wherever its file was copied to. A case that neither directory holds is a hold-out case.
      for (const id of ['demo-1', 'demo-3', 'demo-9']) writeFileSync(join(copies, `${id}.yml`), demo(id));
      expect(loadCases([copies], [], root).map(c => [c.id, c.set])).toEqual([['demo-1', 'tuning'], ['demo-3', 'holdout'], ['demo-9', 'holdout']]);
      expect(['demo-1', 'demo-3', 'demo-9', '../cases/demo-1'].map(id => caseSet(id, root))).toEqual(['tuning', 'holdout', 'holdout', 'holdout']);
      expect(loadCases([dir]).every(c => c.set === 'holdout')).toBe(true);
      writeFileSync(join(copies, 'renamed.yml'), demo('demo-3'));
      expect(() => loadCases([copies], [], root)).toThrow(`${join(copies, 'renamed.yml')}: \`id\` must be the name of the file`);

      // An id in both directories is a hold-out case.
      writeFileSync(join(holdout, 'demo-1.yml'), CASE_YAML);
      expect(loadCases([dir], ['demo-1'], root)[0].set).toBe('holdout');
      expect(() => loadCases([dir, holdout], [], root)).toThrow('Case id demo-1 is used twice');
      rmSync(join(holdout, 'demo-1.yml'));
      rmSync(join(holdout, 'demo-3.yml'));
      expect(() => loadCases([dir, holdout], [], root)).toThrow(`No case files in ${holdout}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
    expect(options).toEqual({ effort: 'high', timeoutMs: 300_000 });
    expect(cache.size).toBe(1);

    // Each model call adds its cost, one whose reply cannot be used too, and a cached answer adds nothing.
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    const priced = { sendMessage: jest.fn().mockResolvedValueOnce({ content: 'not json', usage }).mockResolvedValue({ content: '{"verdict": "NONE", "findings": [], "reason": "Not there."}', usage }) } as unknown as LLMClient;
    const costed = llmMatcher(priced, 'anthropic/claude-sonnet-5-5', new Map());
    const spend = { costUsd: 0, unpriced: 0 };
    await expect(costed(item, findings, spend)).rejects.toThrow('is not a JSON object');
    expect(await costed(item, findings, spend)).toEqual({ verdict: 'NONE', findings: [], reason: 'Not there.' });
    expect(await costed(item, findings, spend)).toEqual({ verdict: 'NONE', findings: [], reason: 'Not there.' });
    expect(spend).toEqual({ costUsd: 4, unpriced: 0 });
    // A model without a price, a reply without token counts and a call that failed have no known cost.
    const unknownCost = { costUsd: 0, unpriced: 0 };
    await llmMatcher(clientAnswering('{"verdict": "NONE", "findings": [], "reason": "x"}'), 'model-a', new Map())(item, findings, unknownCost);
    await llmMatcher({ sendMessage: jest.fn().mockResolvedValue({ content: '{"verdict": "NONE", "findings": [], "reason": "x"}', usage, model: 'model-without-price' }) } as unknown as LLMClient, 'model-a', new Map())(item, findings, unknownCost);
    await expect(llmMatcher({ sendMessage: jest.fn().mockRejectedValue(new Error('timed out')) } as unknown as LLMClient, 'model-a', new Map())(item, findings, unknownCost)).rejects.toThrow('timed out');
    expect(unknownCost).toEqual({ costUsd: 0, unpriced: 3 });
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
      expect(() => loadMatcherCache(path)).toThrow(new Error(`The matcher cache ${path} is not valid JSON. Delete it to start a fresh one.`));
      writeFileSync(path, '[]');
      expect(() => loadMatcherCache(path)).toThrow(`The matcher cache ${path} is not a JSON object.`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on a reply without a verdict or that is no JSON, without quoting the reply', async () => {
    await expect(llmMatcher(clientAnswering('{"answer": "yes"}'), 'model-a', new Map())(item, findings)).rejects.toThrow(/^The matcher answered no verdict for K1$/);
    await expect(llmMatcher(clientAnswering('The finding says the lock is dropped'), 'model-a', new Map())(item, findings)).rejects.toThrow(/^The matcher's answer for K1 is not a JSON object$/);
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

    const review = makeReview('ADDRESS_FIRST', findings);
    const votes: VoteLog[] = [{ title: 'Voted', file: 'src/read.rs', line: 1, grade: 'warning', after: 'warning', finder: 'finder-b', model: 'claude-opus-5-5', answer: 'no_answer', calls: [{ outcome: 'timed_out', durationMs: 120_000, error: 'timed out' }] }];
    Object.assign(review.result, { votes });
    const score = await scoreRun(benchCase, review, matcher);
    expect(score.votes).toEqual(votes);

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
      finders: [{ name: 'finder-a', model: 'claude-sonnet-5-5', toolSteps: 4, filesRead: 3, askedAgain: true, unitsNotCovered: 2 }],
      secondReads: [{ name: 'Second read 1', model: 'claude-sonnet-5-5', toolSteps: 2, filesRead: 1 }],
      costUsd: 1.25, inputTokens: 1000, outputTokens: 100, durationMs: 90,
    });
    expect(score.findings.slice(1, 3)).toEqual([
      { severity: 'blocker', title: 'Lock dropped', file: 'src/lock.rs', line: 1, description: 'Calls `unlock` early.', route: { finderGrade: 'blocker', raisedBy: ['finder'] } },
      { severity: 'blocker', title: 'Invented', file: 'src/other.rs', line: 1, description: 'Something.', route: { finderGrade: 'blocker', raisedBy: ['finder'] } },
    ]);

    const warnings = [makeFinding({ title: 'Helper copied' }), makeFinding({ title: 'Unlisted\n```', description: 'Drops the lock.\r```rust\r\nunlock();\n```\n', howToFix: 'Hold it.', suggestedFix: 'lock();' }), makeFinding({ severity: 'note', title: 'A note' })];
    const warned = await scoreRun(benchCase, makeReview('READY', warnings), stub({ N1: { verdict: 'MATCH', findings: [0], reason: 'same' } }));
    expect(warned).toMatchObject({ falseBlockers: 0, unexpectedWarnings: 1, extraFindings: 2 });
    const unscored = buildReport(
      { startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' },
      [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [{ ...warned, unexpectedWarnings: undefined }] }] }],
    );
    expect(unscored.variants[0].summary.unexpectedWarnings).toBe(1);
    expect(formatBenchSummary(unscored)).toContain('0 false blockers, 1 unexpected warnings, 2 extra');
    expect(warned.findings[1]).toEqual({ severity: 'warning', title: 'Unlisted\n```', file: 'src/other.rs', line: 1, description: 'Drops the lock.\r```rust\r\nunlock();\n```\n', howToFix: 'Hold it.', suggestedFix: 'lock();', route: { finderGrade: 'warning', raisedBy: ['finder'] } });
    expect(formatUnmatched(unscored.variants)).toBe([
      '### Unexpected warnings on tuning cases', '',
      "Warnings that match no key item. Add each real defect to its case's `must_catch`, or to `nice_to_have` when a good review may leave it out, and bump the case's `key_version`.", '',
      // A line break in the title, or a bare carriage return in the description, starts no line of its own that could close the block.
      '```text', 'base demo-1 key v2 run 1: src/other.rs:1: Unlisted ```', '    | Drops the lock.', '    | ```rust', '    | unlock();', '    | ```', '```', '',
    ].join('\n'));
  });

  it('stores how each finding got its grade without any of its text, and counts the posted blockers by route against the key', async () => {
    const step = (from: FindingSeverity, to: FindingSeverity, by: GradeChange) => ({ from, to, by, reason: 'REASON-TEXT' });
    const doubt = (decides: Doubt['decides']): Doubt => ({ premise: 'PREMISE-TEXT', decides });
    const refutation: Refutation = {
      outcome: 'confirmed', defect: 'confirmed', reason: 'REASON-TEXT', rule: 'RULE-TEXT', proof: ['src/read.rs:3'], files: ['src/read.rs'], codeDigest: 'digest', model: 'model-a',
      premises: [{ premise: 'PREMISE-TEXT', outcome: 'confirmed', reason: 'REASON-TEXT' }],
    };
    const blocker = (title: string, overrides: Partial<Finding>) => makeFinding({ severity: 'blocker', title, ...overrides });
    const cite = (held?: boolean) => ({ reason: 'REASON-TEXT', ...(held !== undefined && { line: 'src/read.rs:3', quote: 'QUOTE-TEXT', held }) });
    const notShown = { reason: 'REASON-TEXT', notShown: true as const };
    const vote = (answer: 'backs' | 'declines' | 'not_shown', trigger: VoteCitation, result: VoteCitation) => ({ finder: 'Other', trigger, result, answer });
    const findings = [
      // A finder filed it as a blocker. A doubt held it down, and a check gave the blocker back. The judge's own answer for that case is stored too.
      blocker('Kept', {
        file: 'src/read.rs', gradePath: [step('blocker', 'warning', 'judge'), step('warning', 'blocker', 'refutation')], cell: { row: 'wrong', column: 'normal' }, gradeIfConfirmed: 'blocker', judgeIfConfirmed: 'blocker',
        doubts: [doubt('defect'), doubt('grade'), doubt('defect')], refutation, checkStatus: 'confirmed', otherFinderVote: vote('backs', cite(true), cite(true)),
      }),
      // The judge's cell raised it. A check gave back what the cap for want of proof took, which is no raise of its own.
      blocker('Raised', {
        description: 'Calls `unlock` early.', reviewerSeverity: 'warning', cell: { row: 'severe', column: 'normal', judgeColumn: 'rare' },
        gradePath: [step('warning', 'blocker', 'judge'), step('blocker', 'warning', 'unproven'), step('warning', 'blocker', 'refutation')], refutation: { ...refutation, defect: undefined },
      }),
      // The check that confirmed the doubt cited lines of a related repo alone.
      blocker('Doubted', {
        gradePath: [step('note', 'warning', 'judge'), step('warning', 'blocker', 'refutation')], gradeIfConfirmed: 'blocker', doubts: [doubt('grade')],
        refutation: { ...refutation, proof: undefined, relatedProof: ['o/r:src/read.rs:3', 'o/r:src/read.rs:9'] },
      }),
      blocker('Read', { reviewers: [VERDICT_READER_NAME] }),
      blocker('Ruled', { gradePath: [step('warning', 'blocker', 'rule')], tags: ['security'] }),
      // A finder that reports it too makes it a finder's blocker.
      blocker('Claimed', { reviewers: ['Claim check 2', 'Claim check 4'] }),
      blocker('Claimed and found', { reviewers: ['Claim check 1', 'Reviewer'] }),
      // A check that ended unsettled keeps whether its call used all its steps, and how many of its confirmations rest on
      // outside behavior a line states. Each kind of step that reported it is named once, in pipeline order.
      makeFinding({
        title: 'Lowered', toolSource: 'clippy',
        reviewers: [SCOPE_READER_NAME, 'clippy', 'Sweep 2', 'Consumer check: Api', 'Reference check: read', 'Pattern check: helper', 'Sibling code: Codec::decode', 'Sibling field: len vs cap', 'Second read 1', 'Reviewer', 'reviewer'],
        // The vote backed it as a blocker, before the check of the base lowered it.
        gradePath: [step('blocker', 'warning', 'pre_existing')], checkStatus: 'unconfirmed', otherFinderVote: vote('backs', cite(true), cite(true)), refutation: {
          ...refutation, outcome: 'unsettled', defect: 'unsettled', stepsUsedUp: 'yes', outside: { behavior: 'b', stated: false },
          premises: [{ premise: 'p', outcome: 'confirmed', outside: { behavior: 'b', stated: true }, reason: 'r' }, { premise: 'q', outcome: 'unsettled', reason: 'r' }],
        },
      }),
      // No finder filed it as a blocker, and the check confirmed the defect and the consequence the judge named.
      blocker('Consequence', {
        gradePath: [step('warning', 'blocker', 'refutation')], gradeIfConfirmed: 'blocker', doubts: [doubt('defect'), { ...doubt('grade'), consequence: true }], refutation,
      }),
      // The finders split on it, so the check that confirmed the consequence made it a blocker, not the finder that filed one.
      blocker('Split', {
        reviewerSeverity: 'blocker', lowestReviewerSeverity: 'warning', gradePath: [step('blocker', 'warning', 'judge'), step('warning', 'blocker', 'refutation')], gradeIfConfirmed: 'blocker',
        doubts: [doubt('defect'), { ...doubt('grade'), consequence: true }], refutation,
      }),
      makeFinding({ title: 'Worked around', severity: 'blocker', reviewers: ['Fix check 1'] }),
      // A vote that named no trigger line declined a warning, and one whose result line did not hold its quote declined a blocker.
      makeFinding({ title: 'Voted down', severity: 'note', gradePath: [step('warning', 'note', 'other_finder')], otherFinderVote: vote('declines', cite(), cite(true)) }),
      makeFinding({ title: 'Misquoted', severity: 'warning', gradePath: [step('blocker', 'warning', 'other_finder')], otherFinderVote: vote('declines', cite(true), cite(false)) }),
      // The code for its trigger was not shown to the voter, so it kept its grade.
      blocker('Out of view', { otherFinderVote: vote('not_shown', notShown, cite(true)) }),
    ];
    const review = makeReview('ADDRESS_FIRST', findings);
    review.result.verdictReason = 'required_present';
    const matcher = stub({ K1: { verdict: 'MATCH', findings: [0], reason: 'same' }, K2: { verdict: 'MATCH', findings: [0], reason: 'same' }, N1: { verdict: 'PARTIAL', findings: [2, 12], reason: 'vague' } });

    const score = await scoreRun(benchCase, review, matcher);

    expect(score).toMatchObject({ verdictReason: 'required_present', falseBlockers: 8 });
    expect(score.findings.map(f => f.route)).toEqual([
      {
        finderGrade: 'blocker', cell: { row: 'wrong', column: 'normal' }, gradeIfConfirmed: 'blocker', judgeIfConfirmed: 'blocker', gradePath: [{ from: 'blocker', to: 'warning', by: 'judge' }, { from: 'warning', to: 'blocker', by: 'refutation' }],
        doubts: { defect: 2, grade: 1 }, refutation: { outcome: 'confirmed', defect: 'confirmed' }, checkStatus: 'confirmed', raisedBy: ['finder'], vote: { grade: 'blocker', answer: 'backs', trigger: 'held', result: 'held' },
      },
      {
        finderGrade: 'warning', cell: { row: 'severe', column: 'normal', judgeColumn: 'rare' }, refutation: { outcome: 'confirmed' },
        gradePath: [{ from: 'warning', to: 'blocker', by: 'judge' }, { from: 'blocker', to: 'warning', by: 'unproven' }, { from: 'warning', to: 'blocker', by: 'refutation' }], raisedBy: ['finder'],
      },
      {
        finderGrade: 'note', gradeIfConfirmed: 'blocker', gradePath: [{ from: 'note', to: 'warning', by: 'judge' }, { from: 'warning', to: 'blocker', by: 'refutation' }], doubts: { defect: 0, grade: 1 },
        refutation: { outcome: 'confirmed', defect: 'confirmed', relatedLines: 2, prLines: 0 }, raisedBy: ['finder'],
      },
      { finderGrade: 'blocker', byReader: true, raisedBy: ['reader'] },
      { finderGrade: 'warning', gradePath: [{ from: 'warning', to: 'blocker', by: 'rule' }], security: true, raisedBy: ['finder'] },
      { finderGrade: 'blocker', byClaimCheck: true, raisedBy: ['claim'] },
      { finderGrade: 'blocker', raisedBy: ['finder', 'claim'] },
      {
        finderGrade: 'blocker', gradePath: [{ from: 'blocker', to: 'warning', by: 'pre_existing' }], refutation: { outcome: 'unsettled', defect: 'unsettled', stepsUsedUp: 'yes', outside: { stated: 1, unstated: 1 } }, checkStatus: 'unconfirmed',
        raisedBy: ['finder', 'second_read', 'comparison', 'pattern', 'related', 'sweep', 'tool', 'scope'], vote: { grade: 'blocker', answer: 'backs', trigger: 'held', result: 'held' },
      },
      {
        finderGrade: 'warning', gradeIfConfirmed: 'blocker', gradePath: [{ from: 'warning', to: 'blocker', by: 'refutation' }],
        doubts: { defect: 1, grade: 1, consequence: 1 }, refutation: { outcome: 'confirmed', defect: 'confirmed' }, raisedBy: ['finder'],
      },
      {
        finderGrade: 'blocker', lowestFinderGrade: 'warning', gradeIfConfirmed: 'blocker', gradePath: [{ from: 'blocker', to: 'warning', by: 'judge' }, { from: 'warning', to: 'blocker', by: 'refutation' }],
        doubts: { defect: 1, grade: 1, consequence: 1 }, refutation: { outcome: 'confirmed', defect: 'confirmed' }, raisedBy: ['finder'],
      },
      { finderGrade: 'blocker', byFixCheck: true, raisedBy: ['fix'] },
      { finderGrade: 'warning', gradePath: [{ from: 'warning', to: 'note', by: 'other_finder' }], raisedBy: ['finder'], vote: { grade: 'warning', answer: 'declines', trigger: 'none', result: 'held' } },
      { finderGrade: 'blocker', gradePath: [{ from: 'blocker', to: 'warning', by: 'other_finder' }], raisedBy: ['finder'], vote: { grade: 'blocker', answer: 'declines', trigger: 'held', result: 'missed' } },
      { finderGrade: 'blocker', raisedBy: ['finder'], vote: { grade: 'blocker', answer: 'not_shown', trigger: 'not_shown', result: 'held' } },
    ]);
    expect(await scoreRun(benchCase, makeReview('READY', []), stub({}))).not.toHaveProperty('verdictReason');

    // An incomplete run counts in no row. Neither does the warning. The last run is one the matcher failed on, which keeps its findings.
    const report = (runs: Array<typeof score>) => buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs }] }]);
    const table = (rows: string[]) => ['| Route of a posted blocker | Key blocker | Key warning | Key note | No key item | Total |', '| --- | --- | --- | --- | --- | --- |', ...rows].join('\n');
    const routed = report([score, { ...score, complete: false }, { ...score, complete: false, matches: [], unexpectedWarnings: 0 }]);
    expect(formatBlockerRoutes(routed.variants)).toBe(table([
      '| base: filed by a finder and kept | 1 | 0 | 0 | 2 | 3 |',
      '| base: raised by the judge | 0 | 1 | 0 | 0 | 1 |',
      '| base: raised by a confirmed doubt | 0 | 0 | 1 | 0 | 1 |',
      '| base: raised by a confirmed doubt and consequence | 0 | 0 | 0 | 2 | 2 |',
      '| base: claim check | 0 | 0 | 0 | 1 | 1 |',
      '| base: fix check | 0 | 0 | 0 | 1 | 1 |',
      '| base: verdict reader | 0 | 0 | 0 | 1 | 1 |',
      '| base: other | 0 | 0 | 0 | 1 | 1 |',
    ]));
    expect(formatBenchSummary(routed)).toContain(`\n\n${formatBlockerRoutes(routed.variants)}\n`);
    // The unexpected warning counts in every run the variant's figure of unexpected warnings counts it in, and not in the run the matcher failed on.
    const sources = (row: string) => ['| Raised an unexpected warning | Warnings |', '| --- | --- |', row].join('\n');
    expect(routed.variants[0].summary.unexpectedWarnings).toBe(2);
    expect(formatWarningSources(routed.variants)).toBe(sources('| base: finder, second read, sibling comparison, pattern check, related repo check, sweep, tool result, scope reader | 2 |'));
    expect(formatBenchSummary(routed)).toContain(`\n\n${formatWarningSources(routed.variants)}\n`);
    // The votes count in the complete run alone, by the grade each vote saw and whether the finding matches a key item.
    expect(formatVotes(routed.variants)).toBe("Other finder's votes, base: on a blocker 2 backed (1 matched), 1 declined (1 matched, 1 with a line that did not hold its quote) and 1 not shown the code (0 matched), on a warning 0 backed (0 matched), 1 declined (0 matched, 0 with a line that did not hold its quote) and 0 not shown the code (0 matched).");
    expect(formatBenchSummary(routed)).toContain(`\n\n${formatVotes(routed.variants)}\n`);
    expect(formatVotes(report([{ ...score, findings: score.findings.slice(1, 7) }]).variants)).toBe('');
    expect(formatWarningSources(report([{ ...score, findings: score.findings.slice(0, 7) }]).variants)).toBe('');
    expect(formatBlockerRoutes(report([{ ...score, findings: score.findings.slice(7, 8) }]).variants)).toBe('');

    // A report of a ref that stored no route scores the same, and the route of its blockers is not known.
    const older: BenchReport = JSON.parse(JSON.stringify(routed, (key, value: unknown) => (key === 'route' || key === 'verdictReason' ? undefined : value)));
    expect(older.variants[0].summary).toEqual(routed.variants[0].summary);
    expect(formatBlockerRoutes(older.variants)).toBe(table(['| base: unknown | 1 | 1 | 1 | 8 | 11 |']));
    expect(formatWarningSources(older.variants)).toBe(sources('| base: unknown | 2 |'));
  });

  it('gives half credit one tier low and none two tiers low, skips the matcher without candidates, and calls an approval of a blocker case wrong', async () => {
    const run = (severity: Finding['severity']) => scoreRun(benchCase, makeReview('READY', [makeFinding({ severity, file: 'src/read.rs' })]), stub({ K1: { verdict: 'MATCH', findings: [0], reason: 'same' } }));

    expect(await run('warning')).toMatchObject({ mustCatchRecall: 0.5, weightedRecall: 1.5 / 5 });
    const score = await run('note');
    expect(score.matches[1]).toEqual({ item: 'K2', verdict: 'NONE', findings: [], reason: 'No finding names its files or symbols.' });
    expect(score).toMatchObject({ mustCatchRecall: 0.5, weightedRecall: 0, verdictCorrect: false, extraFindings: 0, duplicates: 0 });
  });

  it('expects a clean case to approve, and leaves the recall and verdict of an incomplete run unscored', async () => {
    const clean: BenchCase = { ...benchCase, mustCatch: [], niceToHave: [] };
    expect(await scoreRun(clean, makeReview('READY', []), stub({}))).toMatchObject({ mustCatchRecall: null, weightedRecall: null, verdictCorrect: true });
    expect(await scoreRun(clean, makeReview('ADDRESS_FIRST', [makeFinding({ severity: 'blocker' })]), stub({}))).toMatchObject({ verdictCorrect: false, falseBlockers: 1 });
    expect(await scoreRun(benchCase, makeReview('INCOMPLETE', [], false), stub({}))).toMatchObject({ complete: false, error: 'The review did not complete.', mustCatchRecall: null, weightedRecall: null, verdictCorrect: null });
  });

  it('scores the findings the finders reported against the must-catch items, and names from the round record where each one the review did not post left it', async () => {
    const posted = [makeFinding({ title: 'Posted', file: 'src/read.rs' })];
    const step = (by: GradeChange) => [{ from: 'warning' as const, to: 'ignore' as const, by }];
    // What the stages after the finders read of a finding is kept, so a replay of the run gives them the same finding.
    const later: Partial<RoundRawFinding> = {
      evidence: { checks: ['Read `read_len`.'], proof: ['src/read.rs:1'] }, notChecked: true, lead: { checked: 'The caller.', left: 'The peer.' }, preExisting: 'The base had it.',
      rule: { file: 'AGENTS.md', quote: 'Bound every length.' },
    };
    const raw: Array<Partial<RoundRawFinding>> = [
      { title: 'Posted', file: 'src/read.rs', ...later },
      { title: 'Unproven' }, { title: 'Old code' }, { title: 'Over the cap' },
      { title: 'Judged', description: 'Calls `unlock` early.', reviewers: ['finder-b'] }, { title: 'Disproved' }, { title: 'Resolved before' }, { title: 'No step' },
      { title: 'Hidden' }, { title: 'Lead' }, { title: 'Seen before' },
      { title: 'Merged', description: 'Drops the lock in `unlock`.' },
      // Two findings at one place with one title are one finding to the record, so it cannot tell which became of which.
      { title: 'Twin', description: 'One text.' }, { title: 'Twin', description: 'Another text.' },
    ];
    const place = (title: string) => ({ title, file: 'src/other.rs', line: 1 });
    const parts: Parameters<typeof rawRecord>[2] = {
      unposted: [makeFinding({ ...place('Unproven'), unpostedReason: 'no_proof' }), makeFinding({ ...place('Old code'), tags: [PRE_EXISTING_TAG] }), makeFinding({ ...place('Over the cap'), unpostedReason: 'note_cap' })],
      judge: {
        dropped: [{ ...place('Judged'), reviewers: [], gradePath: step('judge') }, { ...place('Disproved'), reviewers: [], gradePath: step('refutation') }, { ...place('Resolved before'), reviewers: [], gradePath: step('ratchet') }, { ...place('No step'), reviewers: [] }],
        // One of the twins went into the other, and 'Merged' into another finding.
        mergedDuplicates: 2,
      },
      memory: { suppressed: [{ ...place('Hidden'), severity: 'warning', suppressionId: 'S1' }] },
      dedup: { duplicateMatches: [{ droppedTitle: 'Seen before', matchedTitle: 'Seen in round 1', matchType: 'exact' }] },
      leads: [{ ...place('Lead'), severity: 'warning', reviewers: [], description: '', lead: { checked: '', left: '' }, outcome: 'not_checked', since: 1 }],
    };
    const record = (changes: typeof parts = {}) => rawRecord(raw, [...posted, makeFinding(place('Twin'))], { ...parts, ...changes });
    // The matcher names every finding it is shown for K1 and K2, closest first as given, and each of its calls costs a quarter.
    const matcher = jest.fn(async (item: KeyItem, findings: unknown[], spend?: MatcherSpend): Promise<MatchDecision> => {
      if (spend) spend.costUsd += 0.25;
      return item.id === 'N1' ? { verdict: 'NONE', findings: [], reason: 'none' } : { verdict: 'MATCH', findings: findings.map((_, i) => i), reason: 'same' };
    });
    const exits = async (changes: typeof parts = {}) => (await scoreRun(benchCase, makeReview('ADDRESS_FIRST', posted, true, record(changes)), matcher)).raw!.findings.map(f => f.exit);

    const score = await scoreRun(benchCase, makeReview('ADDRESS_FIRST', posted, true, record()), matcher);

    expect(score.raw!.findings.map(f => [f.title, f.exit])).toEqual([
      ['Posted', 'posted'], ['Unproven', 'unproven'], ['Old code', 'pre_existing'], ['Over the cap', 'note_cap'],
      ['Judged', 'judge'], ['Disproved', 'refuter'], ['Resolved before', 'earlier_round'], ['No step', 'unknown'],
      ['Hidden', 'memory_suppression'], ['Lead', 'open_lead'], ['Seen before', 'dedup'], ['Merged', 'merged'], ['Twin', 'unknown'], ['Twin', 'unknown'],
    ]);
    expect(score.raw!.findings[4]).toEqual({ severity: 'warning', title: 'Judged', file: 'src/other.rs', line: 1, description: 'Calls `unlock` early.', reviewers: ['finder-b'], exit: 'judge' });
    expect(score.raw!.findings[0]).toEqual({ severity: 'warning', title: 'Posted', file: 'src/read.rs', line: 1, description: 'Something.', ...later, reviewers: ['finder-a'], exit: 'posted' });
    expect(score.replay).toEqual({ planner: null, finders: ['reviewer'] });
    expect(score.raw!.matches).toEqual([
      { item: 'K1', verdict: 'MATCH', findings: [0], severity: 'warning', reason: 'same' },
      { item: 'K2', verdict: 'MATCH', findings: [4, 11], severity: 'warning', reason: 'same' },
    ]);
    // The raw scoring asks about the must-catch items only, and its cost is counted apart from the posted findings' scoring.
    expect(score.raw!.caught).toEqual([
      { item: 'K1', finders: ['finder-a'], posted: true },
      { item: 'K2', finders: ['finder-b', 'finder-a'], posted: false, exits: ['judge', 'merged'] },
    ]);
    expect(score.raw!.matcherCostUsd).toBe(0.5);
    expect(score.matches.map(m => [m.item, m.verdict])).toEqual([['K1', 'MATCH'], ['K2', 'NONE'], ['N1', 'NONE']]);

    // A finding no stage names is merged only when no step that drops findings without naming them ran, and the judge merged
    // every finding no stage names, the twin the record holds once among them.
    expect((await exits({ dedup: { ...parts.dedup, testNitSuppressedCount: 1 } }))[11]).toBe('unknown');
    expect((await exits({ judge: { ...parts.judge, mergedDuplicates: 1 } }))[11]).toBe('unknown');
    // A lead no stage names may be one the sweep's judge left unsettled, which the record keeps nowhere.
    const unnamedLead = rawRecord([{ title: 'Sweep lead', lead: { checked: '', left: '' } }], [], { judge: { mergedDuplicates: 1 } });
    expect((await scoreRun(benchCase, makeReview('READY', [], true, unnamedLead), matcher)).raw!.findings.map(f => f.exit)).toEqual(['unknown']);
    const readerFold = rawRecord(raw.slice(11, 12), [...posted, makeFinding({ title: 'Reader blocker', reviewers: [VERDICT_READER_NAME, 'finder-a'] })], { judge: { mergedDuplicates: 1 } });
    expect((await scoreRun(benchCase, makeReview('ADDRESS_FIRST', posted, true, readerFold), matcher)).raw!.findings.map(f => f.exit)).toEqual(['unknown']);
    // The dedup names only the title it dropped, so it counts only while it dropped as many findings with that title as no later stage names.
    // The finding of the two the dedup did not drop left unnamed too, so a merge the judge made counts for it and not for another finding.
    const twoSeen = rawRecord([{ title: 'Seen before' }, { title: 'Seen before', file: 'src/b.rs' }, { title: 'Unseen' }], [], { dedup: parts.dedup, judge: { mergedDuplicates: 1 } });
    expect((await scoreRun(benchCase, makeReview('READY', [], true, twoSeen), matcher)).raw!.findings.map(f => f.exit)).toEqual(['unknown', 'unknown', 'unknown']);

    // The report sums the runs: the items a finder found, the ones posted, the lost ones by the exit of the closest finding naming each, and the matcher's cost.
    const report = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 2, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [score, { ...score, complete: false }] }] }]);
    expect(report.variants[0].summary.raw).toEqual({ items: 2, found: 2, posted: 1, lost: { judge: 1 }, unscored: 0, matcherCostUsd: 0.5 });
    const summary = formatBenchSummary(report);
    expect(summary).toContain('\n    found by a finder and missed by the review: K2 (dropped by the judge, merged by the judge into another finding)\n');
    expect(summary).toContain("\nFinders' findings: 2 of 2 must-catch items found by a finder, 1 found by the review. Missed by the review after a finder found it: dropped by the judge 1. Matcher cost of this scoring $0.50.\n");
    // A merged report keeps them, and one from a ref that scored no raw findings has none.
    expect(mergeReports([report], [benchCase], {}).variants[0].cases[0].runs[0].raw).toEqual(score.raw);
    const older: BenchReport = JSON.parse(JSON.stringify(report, (key, value: unknown) => (key === 'raw' ? undefined : value)));
    expect(buildReport(report, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: older.variants[0].cases[0].runs }] }]).variants[0].summary.raw).toBeNull();
    expect(formatBenchSummary(older)).not.toContain("Finders' findings");
    // A report scored again against a changed key scores the raw findings again too, and keeps where each one left the review.
    const rekeyed = { ...benchCase, keyVersion: benchCase.keyVersion + 1, mustCatch: benchCase.mustCatch.slice(1) };
    const again = (await rescoreReport(report, [rekeyed], matcher)).report.variants[0];
    expect(again.cases[0].runs[0].raw).toEqual({ ...score.raw, matches: score.raw!.matches.slice(1), caught: score.raw!.caught.slice(1), matcherCostUsd: 0.25 });
    expect(again.summary.raw).toEqual({ items: 1, found: 1, posted: 0, lost: { judge: 1 }, unscored: 0, matcherCostUsd: 0.25 });
    expect(await rescoreReport(older, [rekeyed], matcher).then(r => r.report.variants[0].cases[0].runs[0])).not.toHaveProperty('raw');
  });

  it("keeps the posted score when the matcher fails on the finders' findings, and counts every matcher call of them", async () => {
    const posted = [makeFinding({ title: 'Posted', file: 'src/read.rs' })];
    const record = rawRecord([{ title: 'Posted', file: 'src/read.rs', description: 'Raw text.' }, { title: 'Judged', description: 'Calls `unlock` early.' }], posted, { judge: { dropped: [{ title: 'Judged', file: 'src/other.rs', line: 1, reviewers: [], gradePath: [{ from: 'warning', to: 'ignore', by: 'judge' }] }] } });
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    // Only the finders' findings name `unlock`, so only their K2 call gets `unusable` replies. Each priced call costs $2.
    const scored = async (unusable: number, priced = true) => {
      let left = unusable;
      const client = {
        sendMessage: async (_system: string, message: string) => {
          const content = message.includes('unlock') && left-- > 0 ? 'not json' : '{"verdict": "MATCH", "findings": [1], "reason": "same"}';
          return { content, ...(priced && { usage }) };
        },
      } as unknown as LLMClient;
      return scoreRun(benchCase, makeReview('ADDRESS_FIRST', posted, true, record), llmMatcher(client, 'claude-sonnet-5-5', new Map()));
    };

    // The retry reads K1 from the cache, so the first attempt's calls and its failed K2 call count once each: K1, the failed K2 and the K2 that worked.
    const retried = await scored(1);
    expect(retried.raw).toMatchObject({ caught: [{ item: 'K1', posted: true }, { item: 'K2', posted: false, exits: ['judge'] }], matcherCostUsd: 6 });
    expect(retried.raw).not.toHaveProperty('unscored');
    // A matcher that fails twice on them leaves the run complete with its posted score, and the raw part unscored.
    const failed = await scored(2);
    expect(failed).toMatchObject({ complete: true, mustCatchRecall: 0.5, matches: [{ item: 'K1', verdict: 'MATCH' }, { item: 'K2', verdict: 'NONE' }, { item: 'N1', verdict: 'MATCH' }] });
    expect(failed.raw).toEqual({ findings: retried.raw!.findings, matches: [], caught: [], unscored: true, error: expect.any(String), matcherCostUsd: 6 });
    const unpriced = await scored(0, false);
    expect(unpriced.raw!.matcherCostUsd).toBeNull();

    const report = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 3, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [retried, failed] }] }]);
    expect(report.variants[0].summary.raw).toEqual({ items: 2, found: 2, posted: 1, lost: { judge: 1 }, unscored: 1, matcherCostUsd: 12 });
    expect(formatBenchSummary(report)).toContain(" The matcher failed on the finders' findings of 1 run, which count in none of these. Matcher cost of this scoring $12.00.\n");
    expect(formatBenchSummary(report)).toContain(`    the matcher failed on the finders' findings: ${failed.raw!.error}\n`);
    const withUnpriced = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 2, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [retried, unpriced] }] }]);
    expect(withUnpriced.variants[0].summary.raw!.matcherCostUsd).toBeNull();
    expect(formatBenchSummary(withUnpriced)).toContain('Matcher cost of this scoring unknown, since a call has no known price.\n');
  });
});

describe('scoreRun on a follow-up case', () => {
  const followUp = parseCase(FOLLOW_UP_YAML, 'follow.yml');
  const findings = [
    makeFinding({ severity: 'blocker', file: 'src/conn.rs', title: 'Write has no timeout' }),
    makeFinding({ severity: 'note', file: 'src/conn.rs', title: 'Retry loop untested' }),
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
    // P3 and P4 are no open threads, so the report leaves them out. It holds no reason of any thread.
    expect(score.followUp?.threads).toEqual([{ id: 'P1', status: 'addressed' }, { id: 'P2', status: 'addressed' }]);
    const kept = review();
    kept.result.findings = [{ ...findings[0], threadId: 'P1' }, findings[1], { ...findings[2], threadId: 'P1' }, makeFinding({ severity: 'blocker', file: 'src/old.rs', title: 'Earlier blocker', relisted: true, threadId: 'P1' })];
    kept.result.threadEvaluations = [
      { threadId: 'P1', status: 'not_addressed', reason: NAMED_AGAIN_REASON },
      { threadId: 'P2', status: 'uncertain', reason: `The push did not change \`src/conn.rs\`${UNCONFIRMED_FIX_ENDING}`, grade: 'warning' },
    ];
    expect((await scoreRun(followUp, kept, matcher)).followUp).toMatchObject({
      resolved: [], threads: [{ id: 'P1', status: 'not_addressed', keptOpenBy: 'named', findings: ['blocker', 'blocker'] }, { id: 'P2', status: 'uncertain', keptOpenBy: 'unconfirmed', grade: 'warning' }],
    });
    kept.result.threadEvaluations = [{ threadId: 'P2', status: 'partly_addressed', reason: `Part remains${UNCONFIRMED_FIX_ENDING}`, grade: 'note' }];
    expect((await scoreRun(followUp, kept, matcher)).followUp?.threads).toEqual([{ id: 'P1', status: 'none', findings: ['blocker', 'blocker'] }, { id: 'P2', status: 'partly_addressed', grade: 'note' }]);
    kept.result.threadEvaluations = [{ threadId: 'P2', status: 'partly_addressed', reason: WORKAROUND_REASON, remaining: 'r', grade: 'warning' }];
    expect((await scoreRun(followUp, kept, matcher)).followUp?.threads?.[1]).toEqual({ id: 'P2', status: 'partly_addressed', keptOpenBy: 'workaround', grade: 'warning' });
    expect(await scoreRun(followUp, review(false), matcher)).not.toHaveProperty('followUp');
    // No model raised a blocker the review lists again from an earlier round, so it is neither a finding nor a repeat.
    const relisting = review();
    relisting.result.findings = [makeFinding({ severity: 'blocker', file: 'src/old.rs', title: 'Earlier blocker', relisted: true }), ...findings];
    expect(await scoreRun(followUp, relisting, matcher)).toEqual(score);
    const reworded = await scoreRun(followUp, review(), async item => (item.id === 'P2' ? { verdict: 'PARTIAL', findings: [0], reason: 'other mechanism' } : decisions[item.id] ?? { verdict: 'NONE', findings: [], reason: 'none' }));
    expect(reworded).toMatchObject({ falseBlockers: 1, extraFindings: 1, followUp: { repeats: 1 } });
    // A finding folded into the open thread of the item it restates is not posted again: it is no repeat, and the thread counts as kept open.
    const scored = (runs: Array<Awaited<ReturnType<typeof scoreRun>>>) => buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase: followUp, runs }] }]);
    const restating = async (first: Partial<Finding>) => {
      const local = review();
      local.result.findings = [{ ...findings[0], ...first }, ...findings.slice(1)];
      local.result.threadEvaluations = [];
      const run = await scoreRun(followUp, local, matcher);
      const keptOpen = scored([run]).variants[0].cases[0].items.find(item => item.id === 'P2')!.caught;
      return { run, seen: { repeats: run.followUp?.repeats, foldedInto: run.findings[0].foldedInto, keptOpen } };
    };
    const folded = await restating({ severity: 'warning', threadId: 'P2' });
    expect(folded.seen).toEqual({ repeats: 1, foldedInto: 'P2', keptOpen: 1 });
    expect(folded.run.followUp?.foldsStored).toBe(true);
    // A finding posted on its own, graded above its thread, posted as a variant in the thread's replies, or folded into another thread still counts.
    expect((await restating({ severity: 'warning' })).seen).toEqual({ repeats: 2, foldedInto: undefined, keptOpen: 0 });
    expect((await restating({ threadId: 'P2' })).seen).toEqual({ repeats: 2, foldedInto: undefined, keptOpen: 0 });
    expect((await restating({ severity: 'warning', threadId: 'P2', variantOf: 'src/conn.rs:40:40:no-timeout' })).seen).toEqual({ repeats: 2, foldedInto: undefined, keptOpen: 0 });
    expect((await restating({ severity: 'warning', threadId: 'P1' })).seen).toEqual({ repeats: 2, foldedInto: 'P1', keptOpen: 0 });
    // A thread that is not open carries nothing.
    expect((await restating({ severity: 'warning', threadId: 'P4' })).seen).toEqual({ repeats: 2, foldedInto: undefined, keptOpen: 0 });
    // A report scored again keeps the folds it stored, and a report from a ref that stored none is scored as before.
    const rescoredRun = async (r: BenchReport) => (await rescoreReport(r, [{ ...followUp, keyVersion: followUp.keyVersion + 1 }], matcher)).report.variants[0].cases[0];
    const again = await rescoredRun(scored([folded.run]));
    expect(again.runs[0].followUp).toEqual(folded.run.followUp);
    expect(again.items.find(item => item.id === 'P2')!.caught).toBe(1);
    const unfolded: BenchReport = JSON.parse(JSON.stringify(scored([folded.run]), (key, value: unknown) => (key === 'foldedInto' || key === 'foldsStored' ? undefined : value)));
    const before = await rescoredRun(unfolded);
    expect(before.runs[0].followUp).toMatchObject({ repeats: 2 });
    expect(before.runs[0].followUp).not.toHaveProperty('foldsStored');
    expect(before.items.find(item => item.id === 'P2')!.caught).toBe(0);
    const incomplete = await scoreRun(followUp, review(false), matcher);
    const listed = (benchCase: BenchCase, sets?: Array<BenchCase['set']>) => formatUnmatched(buildReport(
      { startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 3, matcherModel: 'model-a' },
      [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [score, reworded, incomplete] }] }],
    ).variants, sets);
    const blockers = (on: string) => [
      `### Unmatched blockers on ${on} cases`, '',
      "Blockers that match no key item. Add each real defect to its case's `must_catch` and bump the case's `key_version`.", '',
      '```text', 'base demo-1 key v2 run 2: src/conn.rs:1: Write has no timeout', '    | Something.', '```', '',
    ].join('\n');
    expect(listed(followUp)).toBe(blockers('tuning'));
    expect(listed({ ...followUp, set: 'holdout' })).toBe('');
    expect(listed({ ...followUp, set: 'holdout' }, ['holdout'])).toBe(blockers('hold-out'));
    expect(listed(followUp, ['tuning', 'holdout'])).toBe(blockers('tuning and hold-out'));

    const report = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase: followUp, runs: [score] }] }]);
    expect(report.variants[0].cases[0].items.slice(3)).toEqual([
      { id: 'P1', tier: 'must_resolve', severity: 'blocker', caught: 1, partial: 0, runs: 1 },
      { id: 'P2', tier: 'must_keep_open', severity: 'warning', caught: 0, partial: 0, runs: 1 },
      { id: 'P3', tier: 'must_not_repeat', severity: 'note', caught: 0, partial: 0, runs: 1 },
    ]);
    expect(report.variants[0].summary).toMatchObject({ atGradeRecall: 0.5, resolvedRight: 1, resolvedWrong: 1, repeats: 2 });
    // A report scored again against a changed key keeps the threads its review left, and one stored without them gets none.
    const rekeyed = { ...followUp, keyVersion: followUp.keyVersion + 1 };
    expect((await rescoreReport(report, [rekeyed], matcher)).report.variants[0].cases[0].runs[0].followUp).toEqual(score.followUp);
    const { threads: _threads, ...older } = score.followUp!;
    const stored = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase: followUp, runs: [{ ...score, followUp: older }] }] }]);
    expect((await rescoreReport(stored, [rekeyed], matcher)).report.variants[0].cases[0].runs[0].followUp).toEqual(older);
    const summary = formatBenchSummary(report);
    expect(summary).toContain('  P2 keep open warning: 0/1\n');
    expect(summary).toContain(', 0 duplicates, resolved 1 right and 1 wrong, 2 repeats, files read');
    expect(summary).toContain('\nFollow-up rounds: resolved 1 right and 1 wrong, 2 repeats.\n');
    expect(summary).toContain('| Resolved right | 1 |\n| Resolved wrong | 1 |\n| Repeats | 2 |\n');
    expect(summary).toContain('| demo-1 P3 (no repeat note) | 0/1 |');
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

  const inputs = { anthropicOauthToken: 'token', anthropicApiKey: '', openaiOauthToken: '', openaiOauthFile: '', openaiApiKey: '', openaiBaseUrl: '', geminiOauthToken: '', geminiApiKey: '' };
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

    const overrides = { models: { judge: 'claude-sonnet-5-5' } };
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
    await runBench([{ ...benchCase, config: { max_diff_lines: 2000 } }], { runs: 1, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, matcher, review: ownReview, variants: [{ name: 'opus', overrides }] });
    expect(ownReview.mock.calls[0][0].config).toMatchObject({ max_diff_lines: 2000, models: { judge: 'claude-sonnet-5-5' } });
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
      { id: 'N1', tier: 'nice_to_have', severity: 'note', caught: 0, partial: 0, runs: 3 },
    ]);
    expect(report.variants[0].summary).toEqual({
      runs: 5, incompleteRuns: 2, mustCatchRecall: 1 / 3, weightedRecall: expect.closeTo(0.4), atGradeRecall: 1 / 3, verdictAccuracy: 2 / 3,
      bySeverity: { blocker: { caught: 2, partial: 1, total: 3 }, warning: { caught: 0, partial: 0, total: 3 } },
      falseBlockers: 0, unexpectedWarnings: 0, extraFindings: 0, duplicates: 0, resolvedRight: null, resolvedWrong: null, repeats: null,
      raw: { items: 6, found: 0, posted: 2, lost: {}, unscored: 0, matcherCostUsd: 0 }, costUsd: 5, costPerRunUsd: 1.25, wallTimePerRunMs: 90,
    });
    expect(JSON.parse(JSON.stringify(report))).toStrictEqual(report);
    const summary = formatBenchSummary(report);
    expect(summary).toMatch(/^== base\ndemo-1 \(demo upstream PR 7\)\n/);
    expect(summary).toContain('\n== opus\n');
    expect(summary).toContain('  K1 must blocker: 2/3, 1 partial\n');
    expect(summary).toContain('  run 2: FAILED: provider down\n');
    expect(summary).toContain('  run 4: INCOMPLETE: The review did not complete.\n');
    expect(summary).toContain('  run 3: READY, recall 0%, 0 false blockers, 0 unexpected warnings, 0 extra, 0 duplicates, files read finder-a 3 (asked again) (2 units not covered), by second reads Second read 1 1, $1.25\n');
    expect(summary).toContain('5 runs (2 incomplete). Must-catch recall 33%, weighted 40%, at grade 33%, verdicts 67%.');
    expect(summary).not.toContain('Follow-up rounds');
    expect(summary).toContain('By severity: blocker 2/3, warning 0/3. False blockers 0, unexpected warnings 0, extra findings 0, duplicates 0, cost $5.00.');
    expect(summary).toContain("\nFinders' findings: 0 of 6 must-catch items found by a finder, 2 found by the review. Missed by the review after a finder found it: none. Matcher cost of this scoring $0.00.\n");
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
      '| demo-1 N1 (nice note) | 0/3 | 0/3 |',
      '',
      '| Route of a posted blocker | Key blocker | Key warning | Key note | No key item | Total |',
      '| --- | --- | --- | --- | --- | --- |',
      '| base: filed by a finder and kept | 3 | 0 | 0 | 0 | 3 |',
      '| opus: filed by a finder and kept | 3 | 0 | 0 | 0 | 3 |',
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
  }, GIT_TEST_TIMEOUT_MS);

  it('tries the matcher again before giving up a finished review, and keeps the review unscored for a later scoring when it gives up', async () => {
    const review = jest.fn(async (input: LocalReviewInput) => {
      await input.answers!.askCheck('refutation', 'A finding', { message: 'm' }, async () => ({ status: 'confirmed' }));
      return makeReview('ADDRESS_FIRST', [blocker], true, rawRecord([{ title: 'Raw' }], [blocker]));
    });
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
    expect(failed.runs[0].findings).toEqual([{ severity: 'blocker', title: 'A finding', file: 'src/read.rs', line: 1, description: 'Something.', route: { finderGrade: 'blocker', raisedBy: ['finder'] } }]);
    expect(review).toHaveBeenCalledTimes(2);
    // The run keeps what a replay and a later scoring read, and the summary says that it is unscored.
    expect(failed.runs[0]).toMatchObject({ unscored: {}, replay: { planner: null, finders: ['reviewer'], answers: { translate: null, dedup: null, judge: null, checks: [{ call: 'refutation', answer: { status: 'confirmed' } }] } } });
    expect(failed.runs[0].raw).toMatchObject({ findings: [expect.objectContaining({ title: 'Raw' })], matches: [], unscored: true, error: 'no such model' });
    const report = buildReport({ startedAt: '2026-11-24T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [failed] }]);
    expect(formatBenchSummary(report)).toContain('  run 1: ADDRESS_FIRST: no such model (unscored: the review completed, and `--rescore` scores it without a new review)\n');
    expect(report.variants[0].summary.incompleteRuns).toBe(1);
    // A later scoring needs no changed key and no review, and the run then counts as complete.
    const { report: rescored, rescored: ids } = await rescoreReport(report, [benchCase], flaky);
    expect(ids).toEqual(['demo-1']);
    expect(rescored.variants[0].cases[0].runs[0]).toMatchObject({ complete: true, outcome: 'ADDRESS_FIRST', costUsd: 1.25, raw: { findings: [expect.objectContaining({ title: 'Raw' })], matches: [expect.anything(), expect.anything()] } });
    expect(rescored.variants[0].cases[0].runs[0]).not.toHaveProperty('unscored');
    expect(rescored.variants[0].cases[0].runs[0]).not.toHaveProperty('error');
    expect(rescored.variants[0].summary.incompleteRuns).toBe(0);
    expect((await rescoreReport(rescored, [benchCase], broken)).rescored).toEqual([]);
    // A complete run of the case keeps its score while the key is unchanged.
    const both = buildReport({ startedAt: '2026-11-24T00:00:00.000Z', runsPerCase: 2, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [{ ...failed, runs: [retried.runs[0], failed.runs[0]] }] }]);
    const rescoredBoth = (await rescoreReport(both, [benchCase], flaky)).report.variants[0].cases[0].runs;
    expect(rescoredBoth[0]).toBe(retried.runs[0]);
    expect(rescoredBoth[1].complete).toBe(true);
    // A run the report holds no text of cannot be scored, unscored or not.
    const textless = { ...report, variants: [{ ...report.variants[0], cases: [{ ...report.variants[0].cases[0], runs: [{ ...failed.runs[0], findings: failed.runs[0].findings.map(({ description: _d, ...f }) => f) }] }] }] };
    expect((await rescoreReport(textless, [benchCase], flaky)).left).toEqual([{ id: 'demo-1', reason: 'its report holds no text of the findings' }]);
    // The round of a follow-up case keeps what it left of the earlier threads for the later scoring.
    const followUp = parseCase(FOLLOW_UP_YAML, 'demo.yml');
    const followed = { ...followUp, base: benchCase.base, head: benchCase.head, priorRound: { ...followUp.priorRound!, head: benchCase.base } };
    review.mockImplementation(async () => {
      const local = makeReview('ADDRESS_FIRST', [blocker]);
      Object.assign(local.result, { threadEvaluations: [{ threadId: 'P1', status: 'addressed', reason: 'fixed' }] });
      return local;
    });
    const [{ results: [unscoredFollowUp] }] = await runBench([followed], { ...options, matcher: broken });
    expect(unscoredFollowUp.runs[0]).not.toHaveProperty('followUp');
    expect(unscoredFollowUp.runs[0].unscored).toMatchObject({ followUp: { resolved: ['P1'], threads: expect.arrayContaining([expect.objectContaining({ id: 'P1', status: 'addressed' })]) } });
    const followReport = buildReport({ startedAt: '2026-11-24T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [unscoredFollowUp] }]);
    const scoredFollowUp = await rescoreReport(followReport, [followed], flaky);
    expect(scoredFollowUp.left).toEqual([]);
    expect(scoredFollowUp.report.variants[0].cases[0].runs[0]).toMatchObject({ complete: true, followUp: { resolved: ['P1'], foldsStored: true } });
    // A replay reuses the finder output of the unscored run.
    review.mockClear();
    review.mockImplementation(async () => makeReview('ADDRESS_FIRST', [blocker]));
    await runBench([benchCase], { ...options, matcher: flaky, findingsFrom: { ...report, commit: SHA_C } });
    expect(review.mock.calls[0][0].replay).toMatchObject({ finders: ['reviewer'], findings: [expect.objectContaining({ title: 'Raw' })] });
    // A replay that stays unscored passes the models of the reads on like a scored one.
    const reads = [{ reviewer: 'Second read 1', model: 'claude-sonnet-5-5' }];
    const withReads = { ...report, commit: SHA_C, variants: [{ ...report.variants[0], cases: [{ ...report.variants[0].cases[0], runs: [{ ...failed.runs[0], replay: { ...failed.runs[0].replay!, reads } }] }] }] };
    const [{ results: [unscoredReplay] }] = await runBench([benchCase], { ...options, matcher: broken, findingsFrom: withReads });
    expect(unscoredReplay.runs[0]).toMatchObject({ unscored: {}, replay: { reads } });
    // With the refuter's answers kept, the replay gets the stored one and makes no such call.
    const live = jest.fn();
    review.mockImplementationOnce(async (input: LocalReviewInput) => {
      expect(await input.answers!.askCheck('refutation', 'A finding', { message: 'm' }, live)).toEqual({ status: 'confirmed' });
      return makeReview('ADDRESS_FIRST', [blocker]);
    });
    const [{ results: [replayed] }] = await runBench([benchCase], { ...options, matcher: flaky, findingsFrom: { ...report, commit: SHA_C }, replayLevel: 'refuter' });
    expect(replayed.runs[0]).toMatchObject({ complete: true });
    expect(live).not.toHaveBeenCalled();
    // A review that did not complete keeps no such data.
    review.mockResolvedValueOnce(makeReview('INCOMPLETE', [blocker], false, rawRecord([{ title: 'Raw' }], [blocker])));
    const [{ results: [incomplete] }] = await runBench([benchCase], { ...options, matcher: broken });
    expect(incomplete.runs[0]).toMatchObject({ complete: false, error: 'no such model' });
    expect(incomplete.runs[0]).not.toHaveProperty('unscored');
    expect(incomplete.runs[0]).not.toHaveProperty('raw');
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

  // About 15 bench runs on a real git checkout take over the default 5 seconds when other test files run beside it.
  it('replays the finder output a stored report holds, run n from its complete run n modulo their count, and decides no release with it', async () => {
    const matcher: Matcher = async () => ({ verdict: 'NONE', findings: [], reason: 'none' });
    const planner = { trivial: false, subtle: true, paired: true, judgeEffort: 'low' as const, prType: 'fix' as const };
    const fixes: RoundFix[] = [{ at: ['src/read.rs:1'], problem: 'p', reviewer: 'Fix check 1', status: 'workaround', cause: 'c', stillFails: 's', proof: ['src/read.rs:1'], findings: 0 }];
    const storedRun = (title: string) => {
      const local = makeReview('ADDRESS_FIRST', [blocker], true, rawRecord([{ title }], [blocker]));
      // The stored round set its judge effort, so the replay keeps the planner's own answer and applies its own config.
      Object.assign(local.result, { plannerResult: { ...planner, judgeEffort: 'max' }, plannerAnswer: planner, fixes: { fixes } });
      return scoreRun(benchCase, local, matcher);
    };
    const [first, second] = [await storedRun('First'), await storedRun('Second')];
    const stored = { ...buildReport({ startedAt: '2026-11-20T00:00:00.000Z', runsPerCase: 3, matcherModel: 'model-a' }, [
      { variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [first, { ...first, complete: false }, second] }] },
    ]), commit: SHA_C };
    const review = jest.fn(async (_input: LocalReviewInput) => makeReview('READY', []));
    const options = { runs: 3, checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs, matcher, review, findingsFrom: stored, variants: [{ name: 'tuned', overrides: {} }] };

    // A variant the report does not hold replays its only variant.
    const [{ variant, results: [replayed] }] = await runBench([benchCase], options);
    const reads = [{ reviewer: 'Second read 1', model: 'claude-sonnet-5-5' }];
    const replayOf = (title: string) => ({ planner, finders: ['reviewer'], fixes, reads, findings: [{ severity: 'warning', title, file: 'src/other.rs', line: 1, description: 'Something.', reviewers: ['finder-a'] }] });
    // This report has the model of the reads in their tool use only. The replay passes it on, so its own report can be replayed too.
    expect(review.mock.calls.map(([input]) => input.replay)).toEqual([replayOf('First'), replayOf('Second'), replayOf('First')]);
    expect(replayed.runs.map(run => run.replay?.reads)).toEqual([reads, reads, reads]);
    // A case the report holds no complete run of gets no review.
    review.mockClear();
    const [{ results: [, missing] }] = await runBench([benchCase, { ...benchCase, id: 'demo-2' }], { ...options, runs: 1 });
    expect(review).toHaveBeenCalledTimes(1);
    expect(missing.runs).toEqual([expect.objectContaining({ outcome: 'FAILED', complete: false, error: 'The report to replay holds no complete run of this case with its finder output.' })]);
    // A case whose file changed what the review reads since the stored run, or a report that does not record it, gets no review either.
    // A key change alone leaves the stored runs replayable, and scoring the report again keeps what its runs reviewed.
    const changed = 'The case\'s commits, title, body, config or earlier round changed since the report to replay, or it does not record them.';
    const unrecorded = { ...stored, variants: [{ ...stored.variants[0], cases: [{ ...stored.variants[0].cases[0], reviewedDigest: undefined }] }] };
    for (const [benched, findingsFrom] of [[{ ...benchCase, head: benchCase.base }, stored], [{ ...benchCase, body: 'Another body.' }, stored], [benchCase, unrecorded]] as const) {
      const [{ results: [refused] }] = await runBench([benched], { ...options, runs: 1, findingsFrom });
      expect(refused.runs).toEqual([expect.objectContaining({ outcome: 'FAILED', error: changed })]);
    }
    expect(review).toHaveBeenCalledTimes(1);
    const rekeyed = { ...benchCase, keyVersion: benchCase.keyVersion + 1 };
    const rescored = (await rescoreReport(stored, [{ ...rekeyed, head: benchCase.base }], matcher)).report;
    expect(rescored.variants[0].cases[0].reviewedDigest).toBe(stored.variants[0].cases[0].reviewedDigest);
    await runBench([rekeyed], { ...options, runs: 1, findingsFrom: rescored });
    expect(review).toHaveBeenCalledTimes(2);
    review.mockClear();
    // With more than one variant, a variant replays the one of its name, and the bench stops before any review on a name the report does not hold.
    const two = { ...stored, variants: [stored.variants[0], { ...stored.variants[0], name: 'tuned', cases: [] }] };
    await runBench([benchCase], { ...options, runs: 1, findingsFrom: two });
    await expect(runBench([benchCase], { ...options, findingsFrom: two, variants: [{ name: 'other', overrides: {} }] })).rejects.toThrow('The report to replay holds no variant other and more than one other');
    expect(review).not.toHaveBeenCalled();

    // With `replayLevel`, a case whose stored runs lack an answer gets no review, and one whose runs hold them all gives them to the review.
    const answers = { translate: null, dedup: { input: {} }, judge: { input: { message: 'm' }, answer: { summary: 's', findings: [] } } };
    const withAnswers = (list: Array<unknown>) => ({ ...stored, variants: [{ ...stored.variants[0], cases: [{ ...stored.variants[0].cases[0], runs: list.map(a => ({ ...first, replay: { ...first.replay!, ...(a ? { answers: a } : {}) } as typeof first.replay })) }] }] });
    const { dedup: _, ...undecided } = answers;
    for (const list of [[undefined], [answers, undefined], [undecided], [{ ...answers, judge: { input: {} } }]]) {
      const [{ results: [refused] }] = await runBench([benchCase], { ...options, runs: 1, findingsFrom: withAnswers(list), replayLevel: 'judge' });
      expect(refused.runs).toEqual([expect.objectContaining({ outcome: 'FAILED', error: 'The report to replay holds a complete run of this case without its judge, dedup and name translation answers.' })]);
    }
    expect(review).not.toHaveBeenCalled();
    const [{ results: [judged] }] = await runBench([benchCase], { ...options, runs: 1, findingsFrom: withAnswers([answers]), replayLevel: 'judge' });
    expect(review.mock.calls[0][0].replay).toEqual(replayOf('First'));
    const ask = () => Promise.reject(new Error('asked live'));
    await expect(review.mock.calls[0][0].answers!.ask('translate', {}, ask)).rejects.toThrow('The stored round made no translate call');
    expect(judged.runs[0].replay?.answers).toBeDefined();
    // With `refuter` the runs must also hold the checks after the judge, and give them to the review.
    const checks = [{ call: 'refutation' as const, target: 't', input: { message: 'm' }, answer: {} }];
    for (const list of [[answers], [{ ...answers, checks: [{ call: 'refutation' }] }]]) {
      const [{ results: [refused] }] = await runBench([benchCase], { ...options, runs: 1, findingsFrom: withAnswers(list), replayLevel: 'refuter' });
      expect(refused.runs).toEqual([expect.objectContaining({ outcome: 'FAILED', error: 'The report to replay holds a complete run of this case without its refuter, sweep, judge, dedup and name translation answers.' })]);
    }
    review.mockClear();
    await runBench([benchCase], { ...options, runs: 1, findingsFrom: withAnswers([{ ...answers, checks }]), replayLevel: 'refuter' });
    await expect(review.mock.calls[0][0].answers!.askCheck('refutation', 'other', {}, ask)).rejects.toThrow('The stored round made no such refutation call');
    // At `judge` the checks are asked live, whatever the report holds.
    review.mockClear();
    await runBench([benchCase], { ...options, runs: 1, findingsFrom: withAnswers([{ ...answers, checks }]), replayLevel: 'judge' });
    await expect(review.mock.calls[0][0].answers!.askCheck('refutation', 'other', {}, ask)).rejects.toThrow('asked live');
    review.mockClear();
    // Without it the review asks live, even when the report holds the answers.
    await runBench([benchCase], { ...options, runs: 1, findingsFrom: withAnswers([answers]) });
    await expect(review.mock.calls[0][0].answers!.ask('judge', { message: 'm' }, ask)).rejects.toThrow('asked live');
    review.mockClear();

    // The report of a replay says what it kept, keeps it when merged, and decides no release.
    const findingsFrom = { commit: SHA_C, startedAt: stored.startedAt };
    const report = buildReport({ startedAt: '2026-11-21T00:00:00.000Z', runsPerCase: 3, matcherModel: 'model-a', findingsFrom }, [{ variant, results: [replayed] }]);
    expect(formatBenchSummary(report)).toMatch(new RegExp(`^Finder output kept from the run started at 2026-11-20T00:00:00.000Z on ${SHA_C}. The planner, finders and checks beside them did not run.\n\n== tuned\n`));
    expect(mergeReports([report], [benchCase], {}).findingsFrom).toEqual(findingsFrom);
    expect(formatBenchSummary({ ...report, findingsFrom: { ...findingsFrom, live: ['refuter', 'scope reader'] } })).toContain('did not run. Stored answers stood in for the calls after the finders, except these live ones: refuter, scope reader.\n');
    expect(() => gateReports([stored], [report])).toThrow('The report started at 2026-11-21T00:00:00.000Z kept the finder output of an earlier run, so it decides no release');
  }, 30_000);

  it('prints nothing of a hold-out case but its id and counts: no finding text, review log, matcher reply, source or failure reason', async () => {
    const SECRET = 'HOLDOUT-TEXT';
    const cases: BenchCase[] = [{ ...benchCase, id: 'shown-1', title: 'SHOWN-TEXT', source: 'source SHOWN-TEXT' }, { ...benchCase, id: 'held-1', set: 'holdout', title: SECRET, source: `source ${SECRET}` }];
    // A review logs, and fails on its second run of a case when `failSecond` is set. Its blocker and warning are not in the key. A finder's finding the judge dropped matches K1.
    const reviewing = (failSecond: boolean) => {
      const seen = new Map<string, number>();
      return jest.fn(async ({ title: text }: LocalReviewInput) => {
        process.stdout.write(`info: finding ${text}\n`);
        process.stderr.write(`warning: finding ${text}\n`);
        seen.set(text!, (seen.get(text!) ?? 0) + 1);
        if (failSecond && seen.get(text!) === 2) throw new Error(`failed on ${text}`);
        const finding = (severity: FindingSeverity) => makeFinding({ severity, title: `title ${text}`, description: `description ${text}`, howToFix: `fix ${text}`, suggestedFix: `code ${text}`, file: `src/${text}.rs` });
        const posted = [finding('blocker'), finding('warning')];
        const raw = { title: `raw title ${text}`, file: 'src/read.rs', description: `raw description ${text}`, howToFix: `raw fix ${text}`, reviewers: [`finder ${text}`] };
        const dropped = { ...raw, line: 1, gradePath: [{ from: 'warning' as const, to: 'ignore' as const, by: 'judge' as const }] };
        const review = makeReview('ADDRESS_FIRST', posted, true, rawRecord([raw], posted, { judge: { dropped: [dropped] } }));
        // A first attempt of the finder failed, and its retry answered.
        return { ...review, result: { ...review.result, agentErrors: new Map([['finder-a', [{ kind: 'Error', message: `CLI failed on ${text}`, exitCode: 1 }]]]) } };
      });
    };
    // The matcher's client logs each reply through `@actions/core`, as the provider clients do, and the reply quotes the finding.
    const core = jest.requireActual<typeof import('@actions/core')>('@actions/core');
    const matching = (usable: boolean): Matcher => llmMatcher({
      sendMessage: async (_system: string, message: string) => {
        const text = message.includes(SECRET) ? SECRET : 'SHOWN-TEXT';
        const decision = message.includes('raw title') ? { verdict: 'MATCH', findings: [1], reason: `reason ${text}` } : { verdict: 'NONE', findings: [], reason: `reason ${text}` };
        const content = usable ? JSON.stringify(decision) : `The finding ${text} is`;
        core.debug(content);
        if (!usable) core.warning(`reply ended with: ${content}`);
        return { content };
      },
    } as unknown as LLMClient, 'model-a', new Map());
    const options = { checkouts: new Map([['owner/demo', checkout]]), providerInputs: inputs };
    const [out, err] = [jest.spyOn(process.stdout, 'write').mockImplementation(() => true), jest.spyOn(process.stderr, 'write').mockImplementation(() => true)];
    const logged = () => [...out.mock.calls, ...err.mock.calls].map(call => String(call[0])).join('');
    try {
      const review = reviewing(true);
      const results = await runBench(cases, { ...options, runs: 2, review, matcher: matching(true) });
      expect(review).toHaveBeenCalledTimes(4);
      for (const text of ['info: finding SHOWN-TEXT\nwarning: finding SHOWN-TEXT\n', '::debug::{"verdict":"NONE","findings":[],"reason":"reason SHOWN-TEXT"}']) expect(logged()).toContain(text);

      const report = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 2, matcherModel: 'model-a' }, results);
      // The report itself keeps the text, which the hold-out pass reads.
      for (const text of [`description ${SECRET}`, `reason ${SECRET}`, `raw description ${SECRET}`, `finder ${SECRET}`]) expect(JSON.stringify(report.variants[0].cases[1])).toContain(text);
      expect(report.variants[0].cases[1].runs[0].finderErrors).toEqual([{ finder: 'finder-a', kind: 'Error', message: `CLI failed on ${SECRET}`, exitCode: 1 }]);
      const printed = () => [
        formatBenchSummary(report), formatUnmatched(report.variants), formatGate(gateReports([report, { ...report, startedAt: '2026-11-09T01:00:00.000Z' }], [report])),
      ].join('\n');
      for (const text of ['shown-1 (source SHOWN-TEXT)', 'run 2: FAILED: failed on SHOWN-TEXT', '\n    finder-a failed: Error (exit 1): CLI failed on SHOWN-TEXT\n', 'src/SHOWN-TEXT.rs:1: title SHOWN-TEXT', '    | description SHOWN-TEXT']) expect(printed()).toContain(text);
      expect(printed()).toContain('\nheld-1\n');
      expect(printed()).toContain('  run 1: ADDRESS_FIRST, recall 0%, 1 false blockers, 1 unexpected warnings, 2 extra, 0 duplicates');
      expect(printed()).toContain('  run 2: FAILED: the reason is in the report\n');
      // What became of the finders' findings shows as the item's id and fixed words, with the finders' names left out.
      expect(printed().split('\nheld-1\n')[1]).toContain('  run 1: ADDRESS_FIRST, recall 0%, 1 false blockers, 1 unexpected warnings, 2 extra, 0 duplicates, files read finder-a 3 (asked again) (2 units not covered), by second reads Second read 1 1, $1.25\n    finder-a failed: Error (exit 1)\n    found by a finder and missed by the review: K1 (dropped by the judge)\n');
      expect(printed().split("\nFinders' findings: 1 of 2 must-catch items found by a finder, 0 found by the review. Missed by the review after a finder found it: dropped by the judge 1. Matcher cost of this scoring unknown, since a call has no known price.\n")).toHaveLength(3);
      expect(printed()).not.toContain(SECRET);

      // Only an explicit request lists hold-out findings, and never in a workflow job, whose log and summary are public.
      expect(formatUnmatched(report.variants, ['holdout'])).toContain(`src/${SECRET}.rs:1: title ${SECRET}`);
      process.env.GITHUB_ACTIONS = 'true';
      try {
        expect(() => formatUnmatched(report.variants, ['holdout'])).toThrow('The findings of hold-out cases are not listed in a workflow job');
        expect(() => formatUnmatched(report.variants, ['tuning', 'holdout'])).toThrow('The findings of hold-out cases are not listed in a workflow job');
        expect(printed()).not.toContain(SECRET);
      } finally {
        delete process.env.GITHUB_ACTIONS;
      }

      // A matcher reply that cannot be used fails the run with an error that quotes nothing, and the client's warning about it is not shown.
      const unusable = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, await runBench(cases, { ...options, runs: 1, review: reviewing(false), matcher: matching(false) }));
      expect(unusable.variants[0].cases.map(c => c.runs[0].error)).toEqual(["The matcher's answer for N1 is not a JSON object", "The matcher's answer for N1 is not a JSON object"]);
      expect(logged()).toContain('::warning::reply ended with: The finding SHOWN-TEXT is');
      expect(formatBenchSummary(unusable)).not.toContain(SECRET);

      // Scoring a stored report again asks the matcher too. An error about a hold-out case names the case and nothing the case, its config or a model's reply holds.
      const rekeyed = cases.map(c => ({ ...c, keyVersion: 3 }));
      expect((await rescoreReport(report, rekeyed, matching(true))).rescored).toEqual(['shown-1', 'held-1']);
      const leftBy = async (matcher: Matcher) => (await rescoreReport(report, rekeyed, matcher)).left;
      expect(await leftBy(matching(false))).toEqual([{ id: 'shown-1', reason: "the matcher failed: The matcher's answer for N1 is not a JSON object" }, { id: 'held-1', reason: 'the matcher failed' }]);
      const quoting: Matcher = async (_item, findings) => {
        throw new Error(`reply about ${findings[0].title}`);
      };
      expect(await leftBy(quoting)).toEqual([{ id: 'shown-1', reason: 'the matcher failed: reply about title SHOWN-TEXT' }, { id: 'held-1', reason: 'the matcher failed' }]);
      // A case the report calls a hold-out case stays one when its file is loaded as a tuning case.
      const moved = rekeyed.map(c => ({ ...c, set: 'tuning' as const }));
      expect((await rescoreReport(report, moved, quoting)).left).toEqual(await leftBy(quoting));
      expect((await rescoreReport(report, moved, matching(true))).report.variants[0].cases.map(c => c.set)).toEqual(['tuning', 'holdout']);
      await expect(runBench([cases[1]], { ...options, runs: 1, review: reviewing(false), matcher: matching(true), variants: [{ name: 'bad', overrides: { [SECRET]: true } }] })).rejects.toThrow(/^Variant bad does not load on case held-1$/);
      expect(() => parseCase(`id: [${SECRET}`, 'held.yml', 'holdout')).toThrow(/^held\.yml: is not valid YAML$/);
      expect(() => parseCase('id: [SHOWN-TEXT', 'shown.yml')).toThrow(/^shown\.yml: .*SHOWN-TEXT/s);
      // The YAML parser warns with the line it warns about.
      const warned = jest.spyOn(process, 'emitWarning').mockImplementation(() => undefined);
      try {
        parseCase(`${CASE_YAML}note: !custom ${SECRET}\n`, 'held.yml', 'holdout');
        expect(warned).not.toHaveBeenCalled();
        parseCase(`${CASE_YAML}note: !custom SHOWN-TEXT\n`, 'shown.yml');
        expect(String(warned.mock.calls[0][0])).toContain('SHOWN-TEXT');
      } finally {
        warned.mockRestore();
      }

      // Text of a tuning case is printed, and it comes from a model reading outside code. No line of it may run as a workflow command
      // in a job log or leave its block in the step summary.
      const hostile = 'It calls `Peer::connect` twice.\n::error::RUN\n   ::warning file=a::RUN\nok\r::stop-commands::RUN\nmid ##[add-mask]RUN\n```\n</details>';
      const injected: BenchReport = {
        ...report,
        variants: report.variants.map(v => ({
          ...v,
          cases: v.cases.map(c => ({ ...c, source: `source\r::notice::RUN ${c.source}`, runs: c.runs.map(run => ({ ...run, ...(run.error && { error: `${run.error}\n::error::RUN\n##[error]RUN` }), findings: run.findings.map(f => ({ ...f, title: `${f.title}\n::error::RUN`, file: `${f.file}\r::error::RUN`, description: hostile })) })) })),
        })),
      };
      for (const output of [formatUnmatched(injected.variants), formatBenchSummary(injected)]) {
        const lines = output.split(/\r\n|\r|\n/);
        expect(lines.filter(line => /^\s*::|##\[/.test(line))).toEqual([]);
        expect(lines.filter(line => /^ {0,3}(```|<)/.test(line)).every(line => line === '```text' || line === '```')).toBe(true);
      }
      expect(formatUnmatched(injected.variants)).toContain('run 1: src/SHOWN-TEXT.rs ::error::RUN:1: title SHOWN-TEXT ::error::RUN\n    | It calls `Peer::connect` twice.\n    | ::error::RUN\n    |    ::warning file=a::RUN\n    | ok\n    | ::stop-commands::RUN\n    | mid [redacted-workflow-cmd]\n    | ```\n    | </details>\n');
      expect(formatBenchSummary(injected)).toContain('shown-1 (source ::notice::RUN source SHOWN-TEXT)\n');
      expect(formatBenchSummary(injected)).toContain('  run 2: FAILED: failed on SHOWN-TEXT ::error::RUN [redacted-workflow-cmd]\n');
      expect(formatBenchSummary(injected)).not.toContain(SECRET);

      // A stored report that calls the hold-out case a tuning case is refused by the case's id, before anything of it is printed.
      const root = mkdtempSync(join(tmpdir(), 'manki-bench-sets-'));
      try {
        for (const [set, id] of [['cases', 'shown-1'], ['holdout', 'held-1']]) {
          mkdirSync(join(root, 'bench', set), { recursive: true });
          writeFileSync(join(root, 'bench', set, `${id}.yml`), '');
        }
        const stored = (held: BenchCase['set'], shown: BenchCase['set'] = 'tuning') => {
          writeFileSync(join(root, 'report.json'), JSON.stringify({ ...report, variants: report.variants.map(v => ({ ...v, cases: v.cases.map(c => ({ ...c, set: c.id === 'held-1' ? held : shown })) })) }));
          return join(root, 'report.json');
        };
        const sets = (path: string, from = root) => {
          const { report: read, removed } = readReport(path, from);
          return { sets: read.variants[0].cases.map(c => [c.id, c.set]), removed };
        };
        expect(sets(stored('holdout'))).toEqual({ sets: [['shown-1', 'tuning'], ['held-1', 'holdout']], removed: [] });
        expect(() => readReport(stored('tuning'), root)).toThrow(new Error(`The report ${join(root, 'report.json')} calls held-1 a tuning case, and bench/holdout holds a case file for it.`));
        // A case the report calls a hold-out case stays one, although only `bench/cases` holds its file.
        expect(sets(stored('holdout', 'holdout'))).toEqual({ sets: [['shown-1', 'holdout'], ['held-1', 'holdout']], removed: [] });
        // A report an older version stored names that version's levels, and they are read as the levels they became. The config it stored is a user's own and stays as written.
        const overrides = { review: { from: 'suggestion', severity: 'nitpick' } };
        const older = { ...report, variants: report.variants.map(v => ({ ...v, overrides, cases: v.cases.map(c => ({ ...c, items: c.items.map(item => ({ ...item, severity: 'nitpick' })) })) })) };
        writeFileSync(join(root, 'report.json'), JSON.stringify(older));
        const { report: read } = readReport(join(root, 'report.json'), root);
        const levels = read.variants.flatMap(v => v.cases.flatMap(c => c.items.map(item => item.severity)));
        expect(levels.length).toBeGreaterThan(0);
        expect(new Set(levels)).toEqual(new Set(['note']));
        expect(read.variants.map(v => v.overrides)).toEqual(read.variants.map(() => overrides));
        // A case no case file holds is no contradiction. It is left out and named, and nothing of it is read as a tuning case.
        rmSync(join(root, 'bench', 'holdout', 'held-1.yml'));
        expect(sets(stored('tuning'))).toEqual({ sets: [['shown-1', 'tuning']], removed: ['held-1'] });
        expect(sets(stored('holdout'), join(root, 'bench'))).toEqual({ sets: [], removed: ['shown-1', 'held-1'] });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }

      expect(logged()).not.toContain(SECRET);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it('prints long runs of blank lines, spaces, tabs, carriage returns and Unicode line breaks in outside text without slowing down', async () => {
    for (const unit of ['\n', ' ', '\t', '\r', ' \t\r\n\n \r', '\u2028', '\u2029', ' \u2028\u0085\u2029']) {
      const inputs = new Map<number, { long: string; report: BenchReport }>();
      const inputOf = async (size: number) => {
        if (!inputs.has(size)) {
          const long = `x${unit.repeat(Math.ceil(size / unit.length))}y`;
          const run = await scoreRun(benchCase, makeReview('ADDRESS_FIRST', [makeFinding({ severity: 'blocker', title: long, file: long, description: long })]), async () => ({ verdict: 'NONE', findings: [], reason: 'none' }));
          const report = buildReport({ startedAt: '2026-11-09T00:00:00.000Z', runsPerCase: 1, matcherModel: 'model-a' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase: { ...benchCase, source: long }, runs: [{ ...run, error: long }] }] }]);
          inputs.set(size, { long, report });
        }
        return inputs.get(size)!;
      };
      const prints: Array<(input: { long: string; report: BenchReport }) => unknown> = [
        ({ long }) => sanitizeLogOutput(long), ({ long }) => cutLegacyCommands(long), ({ long }) => printableError(new Error(long)),
        ({ report }) => formatUnmatched(report.variants), ({ report }) => formatBenchSummary(report),
      ];
      // A pattern whose whitespace class crosses line breaks takes time quadratic in a run of them.
      for (const print of prints) {
        await expectLinearTime(async (size) => {
          const input = await inputOf(size);
          const start = performance.now();
          print(input);
          return performance.now() - start;
        }, 200_000);
      }
      expect(formatUnmatched((await inputOf(200_000)).report.variants)).toContain('Unmatched blockers on tuning cases');
    }
  }, 120_000);

  it('checks every checkout and every variant before the first review', async () => {
    const review = jest.fn();
    const options = { runs: 1, providerInputs: inputs, matcher: jest.fn(), review };
    const checkouts = new Map([['owner/demo', checkout]]);
    const good = { name: 'good', overrides: { max_diff_lines: 2000 } };
    await expect(runBench([benchCase], { ...options, checkouts, variants: [good, { name: 'bad', overrides: { max_diff_lines: 0 } }] }))
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
    const own = { ...benchCase, id: 'own', config: { max_diff_lines: 0 } };
    const typo = { ...benchCase, id: 'typo', config: { review: { critcal_paths: ['wallet/**'] } } };
    const translated = { ...held, id: 'translated', config: { review: { critical_paths: ['wallet/**'] } } };
    const review = jest.fn(async (_input: LocalReviewInput) => makeReview('READY', []));
    const variants = [{ name: 'base', overrides: {} }, { name: 'lines', overrides: { max_diff_lines: 2000 } }];

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
      verdict: 'RERUN', reason: 'False blockers rose from 0 to 1 per run, within the margin of 1. Run the candidate once more and decide on both runs.',
    });
    expect(await gate('blocker', 'blocker', 2)).toMatchObject({ verdict: 'FAIL', reason: 'False blockers rose from 0 to 2 per run, by more than 1.' });
    expect(await gate('blocker', 'blocker', 0, 1)).toMatchObject({
      verdict: 'RERUN', reason: 'Unexpected warnings rose from 0 to 1 per run, within the margin of 1. Run the candidate once more and decide on both runs.',
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
    // A run that stores no folds counts a restatement folded into its own thread as posted, so on such a case the gate counts it on both sides.
    const followUpCase = parseCase(FOLLOW_UP_YAML, 'demo-1.yml', 'holdout');
    const restating = async (folded: number, posted: number) => {
      const restatements = [
        ...Array.from({ length: folded }, () => makeFinding({ file: 'src/conn.rs', threadId: 'P2' })),
        ...Array.from({ length: posted }, () => makeFinding({ file: 'src/conn.rs' })),
      ];
      const matcher: Matcher = async item => (item.id === 'P2' ? { verdict: 'MATCH', findings: restatements.map((_, i) => i), reason: 'restates' } : { verdict: 'NONE', findings: [], reason: 'none' });
      return report([[followUpCase, [await scoreRun(followUpCase, makeReview('ADDRESS_FIRST', restatements), matcher)]]]);
    };
    const withoutFolds = (r: BenchReport): BenchReport => JSON.parse(JSON.stringify(r, (key, value: unknown) => (key === 'foldedInto' || key === 'foldsStored' ? undefined : value)));
    const candidateFolds = await restating(2, 2);
    expect(candidateFolds.variants[0].cases[0].runs[0].followUp?.repeats).toBe(2);
    const olderBaseline = withoutFolds(await restating(0, 2));
    expect(gateReports([olderBaseline, again(olderBaseline)], [candidateFolds])[0]).toMatchObject({
      verdict: 'FAIL', shared: ['demo-1'], baseline: { repeats: 2 }, candidate: { repeats: 4 }, reason: 'Earlier findings posted again rose from 2 to 4 per run, by more than 1.',
    });
    const baselineFolds = await restating(0, 2);
    expect(gateReports([baselineFolds, again(baselineFolds)], [candidateFolds])[0]).toMatchObject({ verdict: 'PASS', baseline: { repeats: 2 }, candidate: { repeats: 2 } });
    expect(gateReports([baselineFolds, again(baselineFolds)], [withoutFolds(await restating(0, 3))])[0]).toMatchObject({ verdict: 'RERUN', baseline: { repeats: 2 }, candidate: { repeats: 3 } });
    expect(gateReports([await followUps({ resolvedRight: 1 }), again(await followUps({ resolvedRight: 1 }))], [await followUps({ resolvedRight: 0 })])[0]).toMatchObject({
      verdict: 'RERUN', reason: 'Earlier threads resolved as the key says fell from 1 to 0 per run. Run the candidate once more and decide on both runs.',
    });
    expect(await gate('blocker', 'warning')).toMatchObject({ verdict: 'RERUN', candidate: { found: 1 } });
    expect(await gate(undefined, undefined, 1)).toMatchObject({
      verdict: 'RERUN',
      reason: "False blockers rose from 0 to 1 per run, within the margin of 1. Must-catch items found at the key's grade fell from 2 to 0 per run. "
        + '2 items are right in every baseline run and in no candidate run: demo-1 K1, demo-2 K1. Run the candidate once more and decide on both runs.',
    });

    const rerun = report([[first, [await run(first, 'blocker')]], [second, [await run(second)]]]);
    const atMargin = report([[first, [await run(first, 'blocker')]], [second, [await run(second, 'blocker')]]]);
    expect(gateReports([baseline, again(baseline)], [rerun, again(atMargin)])[0]).toMatchObject({
      verdict: 'PASS', candidate: { runs: 2, found: 1.5 },
      reason: "Must-catch items found at the key's grade fell from 2 to 1.5 on the mean of 2 runs, and no item is right in every baseline run and in no candidate run. No other figure got worse.",
      items: [{ case: 'demo-2', item: 'K1', baseline: { right: 2, runs: 2 }, candidate: { right: 1, runs: 2 } }],
    });
    const noisy = report([[first, [await run(first, 'blocker', 2)]], [second, [await run(second, 'blocker')]]]);
    expect(gateReports([baseline, again(baseline)], [noisy, again(atMargin)])[0]).toMatchObject({ verdict: 'PASS', candidate: { runs: 2, falseBlockers: 1 } });
    expect(gateReports([baseline, again(baseline)], [rerun, again(rerun)])[0]).toMatchObject({
      verdict: 'RERUN', candidate: { runs: 2, found: 1 },
      reason: "1 item is right in every baseline run and in no candidate run: demo-2 K1. Run demo-2 again on the baseline's commit and on the candidate's, and decide on all runs of each side. "
        + 'An item that some runs of a side get right and others do not is noise.',
    });
  });

  it('asks for a rerun of each case with an item that looks lost, pools the runs of partial reports, and fails only an item still lost after them', async () => {
    const [flips, lost, gained] = ['demo-1', 'demo-2', 'demo-3'].map(id => parseCase(CASE_YAML.replace('id: demo-1', `id: ${id}`), `${id}.yml`, 'holdout'));
    const thread = parseCase(FOLLOW_UP_YAML.replace('id: demo-1', 'id: demo-4'), 'demo-4.yml', 'holdout');
    // One run per entry: whether it finds K1 and, on the follow-up case, whether it resolves P1.
    const runs = (benchCase: BenchCase, hits: number[], falseBlockers = 0) => Promise.all(hits.map(async (hit) => {
      if (benchCase !== thread) return run(benchCase, hit ? 'blocker' : undefined, falseBlockers);
      return { ...await run(thread, 'blocker'), followUp: { resolved: hit ? ['P1'] : [], resolvedRight: hit, resolvedWrong: 0, repeats: 0 } };
    }));
    const side = async (hits: Array<[BenchCase, number[]]>, startedAt: string, falseBlockers = 0) =>
      ({ ...report(await Promise.all(hits.map(async ([c, h]): Promise<[BenchCase, Run[]]> => [c, await runs(c, h, c === flips ? falseBlockers : 0)]))), startedAt });
    const [first, rerun] = ['2026-11-09T00:00:00.000Z', '2026-11-11T00:00:00.000Z'];
    const baseline = await side([[flips, [1, 0]], [lost, [1, 1]], [gained, [0, 0]], [thread, [1, 1]]], first);
    const candidate = await side([[flips, [0, 1]], [lost, [0, 0]], [gained, [1, 1]], [thread, [0, 0]]], first);

    const looksLost = gateReports([baseline], [candidate])[0];
    expect(looksLost).toMatchObject({
      verdict: 'RERUN', shared: ['demo-1', 'demo-2', 'demo-3', 'demo-4'], baseline: { runs: 2, found: 2.5, resolvedRight: 1 }, candidate: { runs: 2, found: 2.5, resolvedRight: 0 },
      reason: "2 items are right in every baseline run and in no candidate run: demo-2 K1, demo-4 P1. Run demo-2, demo-4 again on the baseline's commit and on the candidate's, "
        + 'and decide on all runs of each side. An item that some runs of a side get right and others do not is noise.',
    });
    expect(formatGate([looksLost])).toContain([
      'Key items that changed, with the runs that got each right on each side:', '',
      '- demo-1 K1: baseline 1 of 2, candidate 1 of 2, differs between the runs of both sides',
      '- demo-2 K1: baseline 2 of 2, candidate 0 of 2, looks lost',
      '- demo-3 K1: baseline 0 of 2, candidate 2 of 2',
      '- demo-4 P1: baseline 2 of 2, candidate 0 of 2, looks lost', '',
    ].join('\n'));

    // The reruns hold only the named cases, three runs each, and every run of a commit counts for its case.
    const baselineRerun = await side([[lost, [1, 0, 1]], [thread, [0, 1, 1]]], rerun);
    const candidateRerun = await side([[lost, [0, 0, 0]], [thread, [1, 0, 0]]], rerun);
    const noise = gateReports([baseline, baselineRerun], [candidate, candidateRerun])[0];
    expect(noise).toMatchObject({ verdict: 'PASS', shared: ['demo-1', 'demo-2', 'demo-3', 'demo-4'], baseline: { runs: 2, resolvedRight: 0.8 }, candidate: { runs: 2, resolvedRight: 0.2 } });
    expect(noise.items).toContainEqual({ case: 'demo-2', item: 'K1', baseline: { right: 4, runs: 5 }, candidate: { right: 0, runs: 5 } });
    expect(formatGate([noise])).toContain('- demo-4 P1: baseline 4 of 5, candidate 1 of 5, differs between the runs of both sides\n');

    const stillLost = await side([[lost, [1, 1, 1]], [thread, [0, 1, 1]]], rerun);
    expect(gateReports([baseline, stillLost], [candidate, candidateRerun])[0]).toMatchObject({
      verdict: 'FAIL', reason: '1 item is right in every baseline run and in no candidate run, over more than 2 runs per side: demo-2 K1.',
    });
    // A rerun of one side only decides nothing yet.
    expect(gateReports([baseline], [candidate, candidateRerun])[0]).toMatchObject({ verdict: 'RERUN', reason: expect.stringContaining('demo-2 K1.') });

    // A figure without item ids keeps the margin on the pooled runs.
    const blocking = await side([[flips, [0, 1]], [lost, [0, 0]], [gained, [1, 1]], [thread, [0, 0]]], first, 2);
    expect(gateReports([baseline, baselineRerun], [blocking, candidateRerun])[0]).toMatchObject({ verdict: 'FAIL', reason: 'False blockers rose from 0 to 2 per run, by more than 1.' });
    const warned = await side([[flips, [0, 1]], [lost, [0, 0]], [gained, [1, 1]], [thread, [0, 0]]], first, 1);
    expect(gateReports([baseline, baselineRerun], [warned, candidateRerun])[0]).toMatchObject({
      verdict: 'PASS', reason: expect.stringMatching(/^False blockers rose from 0 to 1 on the mean of 2 runs, within the margin of 1\. /),
    });
  });

  it('decides nothing on an incomplete run, a config that does not load or without a shared hold-out case, and leaves a case with another key version out', async () => {
    const baseline = report([[first, [await run(first, 'blocker')]], [second, [await run(second, 'blocker')]]]);
    expect(gateReports([baseline, again(baseline)], [report([[first, [await run(first, 'blocker', 0, false)]], [second, [await run(second, 'blocker')]]])])[0]).toMatchObject({
      verdict: 'NO DECISION', reason: 'The candidate has incomplete reviews on demo-1. A run with incomplete reviews does not count, so run that side again.',
    });
    // An unscored run needs a later scoring and no new review, unless its case also holds a run that does.
    const unscored = async () => ({ ...await run(first, 'blocker', 0, false), unscored: {} });
    const rescore = 'The review of an unscored run completed, so it needs no new run. Score the reports of that side again with `manki bench --rescore <report.json> --holdout`.';
    const side = async (firstRuns: Run[], complete = true) => report([[first, firstRuns], [second, [await run(second, 'blocker', 0, complete)]]]);
    const reasonOf = (base: BenchReport, candidate: BenchReport) => gateReports([base, again(base)], [candidate])[0];
    expect(reasonOf(baseline, await side([await run(first, 'blocker'), await unscored()]))).toMatchObject({ verdict: 'NO DECISION', reason: `The candidate has unscored runs on demo-1. ${rescore}` });
    expect(reasonOf(await side([await unscored()]), baseline)).toMatchObject({ verdict: 'NO DECISION', reason: `The baseline has unscored runs on demo-1. ${rescore}` });
    expect(reasonOf(baseline, await side([await unscored(), await run(first, 'blocker', 0, false)])).reason).toBe('The candidate has incomplete reviews on demo-1. A run with incomplete reviews does not count, so run that side again.');
    expect(reasonOf(baseline, await side([await unscored()], false)).reason).toBe(`The candidate has incomplete reviews on demo-2. A run with incomplete reviews does not count, so run that side again. The candidate has unscored runs on demo-1. ${rescore}`);
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

  it('gives a stored report with the older levels the same gate figures as a report of the same reviews with notes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'manki-bench-gate-'));
    try {
      mkdirSync(join(root, 'bench', 'holdout'), { recursive: true });
      writeFileSync(join(root, 'bench', 'holdout', 'demo-1.yml'), '');
      const stored = (name: string, r: unknown) => {
        writeFileSync(join(root, name), JSON.stringify(r));
        return readReport(join(root, name), root).report;
      };
      // The level of K1 in an older case file, the level the review gave its match, that level as the older version stored it, and the items found at grade.
      for (const [keyed, given, olderGiven, found] of [['suggestion', 'warning', 'warning', 1], ['warning', 'note', 'suggestion', 0], ['nitpick', 'note', 'nitpick', 1]] as const) {
        const benchCase = parseCase(CASE_YAML.replace('severity: blocker', `severity: ${keyed}`), 'demo-1.yml', 'holdout');
        const current = report([[benchCase, [await run(benchCase, given)]]]);
        // An older version stored no route with a finding.
        const older: BenchReport = JSON.parse(JSON.stringify(current, function (this: object, key, value: unknown) {
          if (key === 'route') return undefined;
          return key === 'severity' && value === 'note' ? ('tier' in this ? 'suggestion' : olderGiven) : value;
        }).replaceAll('"note":', '"suggestion":'));
        expect(JSON.stringify(older)).not.toContain('"note"');
        const [result] = gateReports([stored('older.json', older), stored('older-again.json', again(older))], [stored('current.json', current)]);
        expect(result).toMatchObject({ verdict: 'PASS', shared: ['demo-1'], baseline: { found }, candidate: { found } });
        expect(result.baseline).toEqual({ ...result.candidate, runs: 2 });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    expect(matcher.mock.calls.find(([item]) => item.id === 'K3')![1]).toEqual([{ severity: 'warning', title: 'A finding', file: 'src/other.rs', line: 1, description: 'Something.', route: { finderGrade: 'warning', raisedBy: ['finder'] } }]);
    expect(stored.variants[0].cases[1].runs[0]).toMatchObject({ mustCatchRecall: 0.5, unexpectedWarnings: 1, extraFindings: 1 });
    expect(changed).toMatchObject({ id: 'demo-2', set: 'holdout', keyVersion: 3 });
    expect(changed.items.map(item => [item.id, item.caught, item.runs])).toEqual([['K1', 1, 1], ['K2', 0, 1], ['K3', 1, 1], ['N1', 0, 1]]);
    expect(changed.runs[0]).toMatchObject({ complete: true, outcome: 'ADDRESS_FIRST', mustCatchRecall: 2 / 3, unexpectedWarnings: 0, extraFindings: 0, verdictCorrect: true, costUsd: 1.25 });
    expect(changed.runs[0].matches.find(m => m.item === 'K3')).toEqual({ item: 'K3', verdict: 'MATCH', findings: [1], severity: 'warning', reason: 'confirmed' });
    expect(changed.runs[1]).toBe(stored.variants[0].cases[1].runs[1]);
    expect(scored).toMatchObject({ startedAt: stored.startedAt, matcherModel: 'model-a', variants: [{ name: 'base', summary: { unexpectedWarnings: 1 }, sets: { holdout: { runs: 3 } } }] });
    expect(await rescoreReport(scored, [first, rekeyed], matcher)).toMatchObject({ rescored: [], left: [] });
    // One unusable matcher reply does not end the scoring: each run is tried twice.
    let failures = 1;
    const flaky: Matcher = async (...args) => {
      if (failures-- > 0) throw new Error('unusable reply');
      return matcher(...args);
    };
    expect((await rescoreReport(stored, [first, rekeyed], flaky)).report).toEqual(scored);
    // A case whose matcher fails both times stays as scored and is named. The other cases are still scored again.
    const failing: Matcher = async (item, ...rest) => {
      if (item.id === 'K3') throw new Error('unusable reply');
      return matcher(item, ...rest);
    };
    const rekeyedFirst: BenchCase = { ...first, keyVersion: 3 };
    const partly = await rescoreReport(stored, [rekeyedFirst, rekeyed], failing);
    expect(partly).toMatchObject({ rescored: ['demo-1'], left: [{ id: 'demo-2', reason: 'the matcher failed' }], failed: ['demo-2'] });
    expect(partly.report.variants[0].cases[1]).toBe(stored.variants[0].cases[1]);

    const complete = (r: BenchReport): BenchReport => ({ ...r, variants: r.variants.map(v => ({ ...v, cases: v.cases.map(c => ({ ...c, runs: c.runs.filter(one => one.complete) })) })) });
    const candidate = report([[first, [await run(first, 'blocker')]], [rekeyed, [await run(rekeyed, 'blocker')]]]);
    expect(gateReports([complete(stored), again(complete(stored))], [candidate])[0]).toMatchObject({ shared: ['demo-1'], rekeyed: ['demo-2'] });
    expect(gateReports([complete(scored), again(complete(scored))], [candidate])[0]).toMatchObject({ verdict: 'RERUN', shared: ['demo-1', 'demo-2'], baseline: { found: 3 }, candidate: { found: 2 } });

    const bare: BenchReport = JSON.parse(JSON.stringify(stored, (key, value: unknown) => (key === 'description' ? undefined : value)));
    const unread = await rescoreReport(bare, [first, rekeyed], matcher);
    expect(unread).toMatchObject({ rescored: [], left: [{ id: 'demo-2', reason: 'its report holds no text of the findings' }] });
    expect(unread.report.variants[0].cases[1]).toBe(bare.variants[0].cases[1]);
    const followUp = parseCase(FOLLOW_UP_YAML.replace('id: demo-1', 'id: demo-2').replace('key_version: 2', 'key_version: 3'), 'demo-2.yml', 'holdout');
    expect(await rescoreReport(stored, [followUp], matcher)).toMatchObject({
      rescored: [], left: [{ id: 'demo-1', reason: 'no case file was loaded for it, which for a hold-out case takes --holdout' }, { id: 'demo-2', reason: 'its runs reviewed a first round' }],
    });
    // A case no case file was loaded for is never counted as scored again, with or without a changed key.
    const mixed = report([[first, [await run(first, 'blocker')]], [tuning, [await run(tuning, 'blocker')]]]);
    expect(await rescoreReport(mixed, [], matcher)).toMatchObject({
      rescored: [], left: [{ id: 'demo-1', reason: 'no case file was loaded for it, which for a hold-out case takes --holdout' }, { id: 'demo-3', reason: 'no case file was loaded for it, which for a hold-out case takes --holdout' }],
    });
  });
});

describe('parseBenchArgs', () => {
  it('reads the options and defaults', () => {
    expect(parseBenchArgs([])).toMatchObject({ cases: 'bench/cases', holdout: false, only: [], runs: 3, matcherModel: 'claude-sonnet-5-5', cache: 'bench/.matcher-cache.json', help: false });
    const args = parseBenchArgs([
      '--checkout', 'owner/demo=/src/a=b', '--case', 'x', '--case', 'y', '--runs', '1', '--out', 'r.json', '--matcher-model', 'm', '--cache', 'c.json',
      '--holdout', '--variant', 'base', '--variant', 'opus=bench/opus.yml', '--set', 'models.judge=claude-sonnet-5-5', '--set', 'max_diff_lines=2000', '--set', 'exclude_paths=[a, b]',
      '--findings-from', 'earlier.json', '--replay-refuter', '--replay-judge',
    ]);
    expect(args).toMatchObject({
      holdout: true, only: ['x', 'y'], runs: 1, out: 'r.json', matcherModel: 'm', cache: 'c.json', findingsFrom: 'earlier.json', replayLevel: 'refuter',
      variants: [{ name: 'base' }, { name: 'opus', file: 'bench/opus.yml' }],
      sets: [{ models: { judge: 'claude-sonnet-5-5' } }, { max_diff_lines: 2000 }, { exclude_paths: ['a', 'b'] }],
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
      writeFileSync(opus, 'models:\n  planner: claude-opus-5-5\n  dedup: claude-opus-5-5\n');
      writeFileSync(join(dir, 'empty.yml'), '');
      writeFileSync(join(dir, 'list.yml'), '- a\n');
      const sets = [{ models: { judge: 'claude-sonnet-5-5' } }];

      expect(resolveVariants({ variants: [], sets: [] })).toEqual([{ name: 'base', overrides: {} }]);
      expect(resolveVariants({ variants: [{ name: 'base' }, { name: 'opus', file: opus }, { name: 'empty', file: join(dir, 'empty.yml') }], sets })).toEqual([
        { name: 'base', overrides: { models: { judge: 'claude-sonnet-5-5' } } },
        { name: 'opus', overrides: { models: { planner: 'claude-opus-5-5', dedup: 'claude-opus-5-5', judge: 'claude-sonnet-5-5' } } },
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
      writeFileSync(join(dir, 'demo-1.yml'), CASE_YAML);
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
      const [report, cache, cases, holdout] = [join(dir, 'report.json'), join(dir, 'cache.json'), join(dir, 'bench', 'cases'), join(dir, 'bench', 'holdout')];
      for (const made of [cases, holdout]) mkdirSync(made, { recursive: true });
      writeFileSync(report, JSON.stringify(stored));
      writeFileSync(join(cases, 'demo-1.yml'), `${CASE_YAML.replace('key_version: 2', 'key_version: 3')}  - id: N2\n    severity: warning\n    mechanism: The retry never backs off.\n    locations: [src/retry.rs]\n`);
      process.env = { PATH: savedEnv.PATH, ANTHROPIC_API_KEY: 'sk-test' };

      expect(await runBenchCommand(['--rescore', report, '--cases', cases, '--cache', cache], dir)).toBe(0);
      expect(stdout.mock.calls.map(call => call[0]).join('')).toBe(`Scored again with the changed key or for an unscored run: demo-1\nReport: ${join(dir, 'report.rescored.json')}\n`);
      const scored = JSON.parse(readFileSync(join(dir, 'report.rescored.json'), 'utf-8')) as BenchReport;
      expect(scored.variants[0].cases[0]).toMatchObject({ keyVersion: 3, items: [{ id: 'K1' }, { id: 'K2' }, { id: 'N1' }, { id: 'N2', tier: 'nice_to_have', caught: 0, runs: 1 }] });

      expect(await runBenchCommand(['--rescore', report, '--cases', cases, '--cache', cache, '--matcher-model', 'claude-opus-5-5'], dir)).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('The report was matched by claude-sonnet-5-5. Pass --matcher-model claude-sonnet-5-5 to score it again.'));
      // An error message can quote a file. No line of it runs as a workflow command in a job log.
      writeFileSync(join(dir, 'hostile.json'), JSON.stringify({ ...stored, matcherModel: 'model\r::error::RUN\n  ::add-mask::RUN ##[error]RUN' }));
      expect(await runBenchCommand(['--rescore', join(dir, 'hostile.json'), '--cases', cases, '--cache', cache], dir)).toBe(2);
      const quoted = '\n| ::error::RUN\n|   ::add-mask::RUN [redacted-workflow-cmd]';
      expect(stderr).toHaveBeenLastCalledWith(`manki bench: The report was matched by model${quoted}${quoted}\n`);
      expect(await runBenchCommand(['--rescore', report, '--cases', cases, '--case', 'demo-1'], dir)).toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('--case does not apply to --rescore'));
      expect(await runBenchCommand(['--rescore', report, '--cases', cases, '--findings-from', report], dir)).toBe(2);
      expect(stderr).toHaveBeenLastCalledWith('manki bench: --findings-from does not apply to --rescore, which reviews nothing\n');
      expect(await runBenchCommand(['--cases', cases, '--replay-judge'], dir)).toBe(2);
      expect(stderr).toHaveBeenLastCalledWith('manki bench: --replay-judge needs --findings-from, whose runs hold the answers to keep\n');
      writeFileSync(join(dir, 'cut.json'), '{"variants": [{"title": "HOLDOUT-TEXT');
      expect(await runBenchCommand(['--rescore', join(dir, 'cut.json'), '--cases', cases], dir)).toBe(2);
      expect(stderr).toHaveBeenLastCalledWith(`manki bench: The report ${join(dir, 'cut.json')} is not valid JSON\n`);

      // A stored case that no case file holds was removed since: it is left out and named. A report that calls a hold-out case a tuning case,
      // as the report of a single case job of an older ref does, is refused by the id alone.
      const [scoredCase] = stored.variants[0].cases;
      const finding = { severity: 'blocker' as const, title: 'title HOLDOUT-TEXT', file: 'src/HOLDOUT-TEXT.rs', line: 1, description: 'description HOLDOUT-TEXT' };
      const held = { ...scoredCase, id: 'held-1', source: 'source HOLDOUT-TEXT', runs: [{ ...scoredCase.runs[0], findings: [finding], error: 'failed on HOLDOUT-TEXT' }] };
      const mislabelled = join(dir, 'mislabelled.json');
      writeFileSync(mislabelled, JSON.stringify({ ...stored, variants: [{ ...stored.variants[0], cases: [scoredCase, held] }] }));
      stdout.mockClear();
      expect(await runBenchCommand(['--rescore', mislabelled, '--cases', cases, '--cache', cache], dir)).toBe(0);
      expect(stdout.mock.calls.map(call => call[0]).join('')).toBe(`Scored again with the changed key or for an unscored run: demo-1\nLeft out, no case file holds it: held-1\nReport: ${join(dir, 'mislabelled.rescored.json')}\n`);
      expect((JSON.parse(readFileSync(join(dir, 'mislabelled.rescored.json'), 'utf-8')) as BenchReport).variants[0].cases.map(c => c.id)).toEqual(['demo-1']);
      const refused = `manki bench: The report ${mislabelled} calls held-1 a tuning case, and bench/holdout holds a case file for it.\n`;
      writeFileSync(join(holdout, 'held-1.yml'), CASE_YAML.replace('id: demo-1', 'id: held-1').replace('key_version: 2', 'key_version: 3'));
      for (const flags of [[], ['--holdout']]) {
        expect(await runBenchCommand(['--rescore', mislabelled, '--cases', cases, ...flags, '--cache', cache], dir)).toBe(2);
        expect(stderr).toHaveBeenLastCalledWith(refused);
      }
      expect([...stdout.mock.calls, ...stderr.mock.calls].join('')).not.toContain('HOLDOUT-TEXT');

      // A stored case with no case file loaded is named, and is not counted as scored again.
      stdout.mockClear();
      const other = join(dir, 'other');
      mkdirSync(other);
      writeFileSync(join(other, 'demo-9.yml'), CASE_YAML.replace('id: demo-1', 'id: demo-9'));
      expect(await runBenchCommand(['--rescore', report, '--cases', other, '--cache', cache], dir)).toBe(0);
      expect(stdout.mock.calls.map(call => call[0]).join('')).toBe(`No case was scored again.\nLeft as scored, demo-1: no case file was loaded for it, which for a hold-out case takes --holdout.\nReport: ${join(dir, 'report.rescored.json')}\n`);

      // A case the matcher fails on stays as scored in the report written, and the exit code says that not every case was scored again.
      const found = await scoreRun(benchCase, makeReview('ADDRESS_FIRST', [makeFinding({ file: 'src/read.rs' })]), async () => ({ verdict: 'NONE', findings: [], reason: 'none' }));
      const matched = join(dir, 'matched.json');
      writeFileSync(matched, JSON.stringify({ ...stored, variants: [{ ...stored.variants[0], cases: [{ ...scoredCase, runs: [found] }] }] }));
      const replying = (content: string) => jest.mocked(buildLLMClient).mockReturnValueOnce({ sendMessage: async () => ({ content }) } as unknown as LLMClient);
      stdout.mockClear();
      replying('no JSON');
      expect(await runBenchCommand(['--rescore', matched, '--cases', cases, '--cache', cache], dir)).toBe(2);
      expect(stdout.mock.calls.map(call => call[0]).join('')).toBe(`No case was scored again.\nLeft as scored, demo-1: the matcher failed: The matcher's answer for K1 is not a JSON object.\nReport: ${join(dir, 'matched.rescored.json')}\n`);
      expect((JSON.parse(readFileSync(join(dir, 'matched.rescored.json'), 'utf-8')) as BenchReport).variants[0].cases[0].keyVersion).toBe(2);
      replying('{"verdict": "MATCH", "findings": [1], "reason": "same"}');
      expect(await runBenchCommand(['--rescore', matched, '--cases', cases, '--cache', cache], dir)).toBe(0);
      expect((JSON.parse(readFileSync(join(dir, 'matched.rescored.json'), 'utf-8')) as BenchReport).variants[0].cases[0]).toMatchObject({ keyVersion: 3, items: [{ id: 'K1', caught: 1 }, { id: 'K2' }, { id: 'N1' }, { id: 'N2' }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
