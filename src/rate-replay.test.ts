import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { BenchReport, buildReport, parseCase, runBenchCommand, scoreRun } from './bench';
import { loadConfig } from './config';
import { EarlierRound, LocalReview, reviewLocal } from './local-review';
import { createLLMClient } from './providers';
import { AnswerStore, StoredAnswers } from './stored-answers';
import { GIT_TEST_TIMEOUT_MS } from './test-utils';
import type { FinderReplay, RoundRawFinding } from './types';

jest.mock('@actions/core');
jest.mock('./providers', () => ({ ...jest.requireActual('./providers'), createLLMClient: jest.fn() }));
jest.mock('./ast-grep', () => ({ ...jest.requireActual('./ast-grep'), loadAstGrep: async () => jest.requireActual('@ast-grep/napi') }));

const STAGES: Array<[string, string]> = [
  ['You test a claim', 'vote'], ['You rate findings', 'batch rating'], ['You rate a finding', 'rating'], ['You check one finding', 'refuter'], ['You decide whether a defect', 'origin check'], ['A code review reported the finding', 'sweep'],
  ['You are deduplicating', 'dedup'], ['You check whether a code review reported', 'matcher'], ['You give the final merge-readiness', 'verdict reader'], ['You judge a pull request as a whole', 'scope reader'],
];
const inputs = { anthropicOauthToken: 'token', anthropicApiKey: '', openaiOauthToken: 'token', openaiOauthFile: '', openaiApiKey: '', openaiBaseUrl: '', geminiOauthToken: '', geminiApiKey: '' };
const CONFIG = loadConfig(`models:\n  second_refuter: gpt-6.2-sol\nreview:\n  scope_blocks: true\n  sweep: blockers\n  groups:\n    trivial: [claude-sonnet-5-5]\n    solo: [claude-opus-5-5]\n    full: [claude-opus-5-5, gpt-6.2-sol]\n`);
const FINDERS = ['Claude Opus 5.5 · high', 'GPT 6.2 Sol · high'];

describe('a replay that rates the posted findings', () => {
  let repo: string;
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }, encoding: 'utf-8' }).trim();
  const commit = (message: string, files: Record<string, string>): string => {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const lines = (edit: Record<number, string> = {}) => `${Array.from({ length: 40 }, (_, i) => edit[i + 1] ?? `const v${i + 1} = ${i + 1};`).join('\n')}\n`;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'manki-rate-replay-'));
    git('init', '-q', '-b', 'main');
    commit('base', { 'src/a.ts': lines(), 'src/b.ts': lines(), 'src/c.ts': lines() });
    git('checkout', '-q', '-b', 'feature');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const finding = (title: string, severity: 'blocker' | 'warning', line: number, finder = 0, file = 'src/a.ts'): RoundRawFinding =>
    ({ title, file, line, severity, description: `${title} is wrong.`, reviewers: [FINDERS[finder]], evidence: { proof: [`${file}:${line}`], checks: [] } });

  interface Round { earlier?: EarlierRound; rows?: Record<string, string>; threads?: unknown[]; blocks?: boolean; declines?: string; reads?: Array<{ reviewer: string; model: string }> }

  const scored = (score: number) => Object.fromEntries(['trigger', 'introduced', 'matters', 'overall'].map(name => [name, { reason: `Why ${name}.`, score }]));

  /** Answers every client's calls, and adds the stage of each call to `calls` and the messages of the ratings to `asked`. */
  const fakeClients = (calls: string[], asked: string[], more: Round): void => {
    const cite = { reason: 'Any call.', proof: ['src/a.ts:5'] };
    jest.mocked(createLLMClient).mockImplementation((_provider, model) => ({
      repoTools: true,
      sendMessage: jest.fn(async (system: string, message: string, options?: { repoTools?: unknown }) => {
        const stage = STAGES.find(([head]) => system.startsWith(head))?.[1] ?? (message.includes('## Findings to Evaluate') ? 'judge' : `other: ${system.slice(0, 60)}`);
        calls.push(stage);
        const reply = (value: unknown) => ({ content: JSON.stringify(value), model, latencyMs: 10 });
        if (stage === 'rating' || stage === 'batch rating') {
          expect(options?.repoTools).toBeUndefined();
          asked.push(`${system}\n${message}`);
          const ids = [...message.matchAll(/^## Finding (\d+): /gm)].map(([, id]) => Number(id));
          return reply(stage === 'rating' ? scored(model.startsWith('claude') ? 3 : 8) : { ratings: ids.map(id => ({ id, ...scored(id) })) });
        }
        if (stage === 'vote') return reply(more.declines && message.includes(`Claim: ${more.declines}`) ? { harm: '', situation: '', line: 'none', quote: '' } : { harm: 'h', situation: 's', line: 'src/a.ts:5', quote: 'const v5 = 0;' });
        if (stage === 'refuter') return reply({ outcome: 'confirmed', reason: 'Real.', proof: ['src/a.ts:5'], trigger: cite, result: cite, premises: [1, 2, 3].map(id => ({ id, outcome: 'confirmed', ...cite })) });
        if (stage === 'origin check') return reply({ origin: 'introduced', reason: 'New.', head: ['src/a.ts:5'] });
        if (stage === 'sweep') return reply({ class: 'c', general: true, findings: [{ ...finding('Swept elsewhere', 'blocker', 30), evidence: ['src/a.ts:30 is wrong'], proof: ['src/a.ts:30'] }] });
        if (stage === 'dedup') return reply([...message.matchAll(/A: "/g)].map((_, i) => ({ pair: i + 1, sameDefect: false })));
        if (stage === 'scope reader') return { content: JSON.stringify({ useful: false, topics: [] }) };
        if (stage === 'verdict reader') return reply({ verdict: 'READY', blockers: [], summary: 's', whatThisDoes: 'w', whatToTest: { steps: ['Do it.'] } });
        if (stage === 'judge') return reply({ summary: 'Judged.', threadEvaluations: more.threads ?? [], findings: [...message.matchAll(/### Finding (\d+): ([^\n]*)/g)].map(([, id, title]) => ({ id: Number(id), title, row: Object.entries(more.rows ?? {}).find(([name]) => title.includes(name))?.[1] ?? 'degraded', column: 'normal', reasoning: 'SECRET_GRADE_REASON', trigger: 'when run' })) });
        throw new Error('unexpected call');
      }),
    }) as never);
  };

  const run = async (findings: RoundRawFinding[], more: Round, answers: AnswerStore, rating?: FinderReplay['rating']) => {
    const calls: string[] = [];
    const asked: string[] = [];
    fakeClients(calls, asked, more);
    const review = await reviewLocal({
      repoRoot: repo, base: 'main', head: 'feature', title: 'T', body: 'B', providerInputs: inputs, config: CONFIG, answers, ...(more.earlier && { earlier: more.earlier }),
      replay: { planner: null, finders: FINDERS, findings, ...(more.reads && { reads: more.reads }), ...(rating && { rating }) },
    });
    return { review, calls, asked };
  };

  it('asks nothing but the ratings of the findings the stored round posted, and shows no grade, reporter or check', async () => {
    const reviewed = commit('change', { 'src/a.ts': lines({ 5: 'const v5 = 0;', 12: 'const v12 = 0;', 30: 'const v30 = 0;' }), 'src/b.ts': lines({ 7: 'const v7 = 0;' }), 'src/c.ts': lines({ 20: 'const v20 = 0;' }) });
    const rate = async (findings: RoundRawFinding[], more: Round, form: 'single' | 'batch') => {
      const live = new AnswerStore();
      const first = await run(findings, more, live);
      const posted = first.review.result.findings.filter(f => f.severity === 'blocker' || f.severity === 'warning').map(({ file, line, title, severity }) => ({ file, line, title, severity }));
      const kept = JSON.parse(JSON.stringify(live.answers)) as StoredAnswers;
      const store = new AnswerStore(kept, 'refuter');
      const second = await run(findings, more, store, { form, candidates: posted });
      expect(second.review.result.reviewComplete).toBe(true);
      expect(second.review.result.votes).toBeUndefined();
      const order = (answers: StoredAnswers) => ({ ...answers, checks: answers.checks!.map(c => JSON.stringify(c)).sort() });
      expect(order(JSON.parse(JSON.stringify(store.answers)) as StoredAnswers)).toEqual(order(kept));
      for (const text of second.asked) expect(text).not.toMatch(/SECRET_GRADE_REASON|Severity|blocker|warning\b(?! of)|Claude Opus|GPT 6\.2|Second read|Confirmed|Any call\./);
      return { posted, kinds: new Set(first.calls), calls: second.calls, asked: second.asked, logs: second.review.result.ratings! };
    };

    // A vote declines one warning, so the round posts it as a note and it is no candidate. The other one only a second read reported.
    const read = { ...finding('Read problem', 'warning', 30), reviewers: ['Second read 1'] };
    const single = await rate([finding('First problem', 'blocker', 5), finding('Second problem', 'warning', 12, 1), read], { rows: { 'First problem': 'wrong', 'Swept': 'wrong' }, declines: 'Second problem', reads: [{ reviewer: 'Second read 1', model: 'claude-opus-5-5' }] }, 'single');
    expect([...single.kinds].sort()).toEqual(['judge', 'origin check', 'refuter', 'sweep', 'vote']);
    expect(single.posted.map(f => f.title).sort()).toEqual(['First problem', 'Read problem']);
    expect(single.calls).toEqual(['rating', 'rating', 'rating', 'rating']);
    expect(single.logs.map(l => [l.form, l.model, l.findings[0].title, l.findings[0].own, l.findings[0].rating!.overall.score, l.calls.length]).sort()).toEqual([
      ['single', 'claude-opus-5-5', 'First problem', true, 3, 1], ['single', 'claude-opus-5-5', 'Read problem', true, 3, 1],
      ['single', 'gpt-6.2-sol', 'First problem', false, 8, 1], ['single', 'gpt-6.2-sol', 'Read problem', false, 8, 1],
    ]);

    // Nothing blocks, so without the skip a verdict reader runs.
    expect((await rate([finding('A problem', 'warning', 5), finding('Other problem', 'warning', 12, 1)], {}, 'single')).calls).toEqual(Array(4).fill('rating'));

    // A batch shows the findings in an order of its own, the same for both models, and each entry keeps its finding.
    commit('more', { 'src/a.ts': lines({ 5: 'const v5 = 0;', 12: 'const v12 = 0;', 30: 'const v30 = 0;' }) + '\n' });
    const batch = await rate([finding('First problem', 'blocker', 5), finding('Second problem', 'warning', 12, 1), finding('Third problem', 'warning', 7, 1, 'src/b.ts')], { rows: { 'First problem': 'wrong', 'Swept': 'wrong' } }, 'batch');
    expect(batch.calls).toEqual(['batch rating', 'batch rating']);
    expect(new Set(batch.asked).size).toBe(1);
    for (const log of batch.logs) {
      expect(log.findings.map(f => f.title).sort()).toEqual(batch.posted.map(f => f.title).sort());
      log.findings.forEach((f, i) => {
        expect(f.rating!.overall.score).toBe(i + 1);
        expect(batch.asked[0]).toContain(`## Finding ${i + 1}: ${f.title}`);
      });
    }

    // A follow-up round, whose fold, fix checks and verdict reader stay out as well.
    commit('push', { 'src/a.ts': lines({ 5: 'const v5 = 0;', 12: 'const v12 = 1;', 30: 'const v30 = 0;' }), 'src/b.ts': lines({ 7: 'const v7 = 2;' }) });
    const followUp = await rate([finding('Total is stale after a retry', 'warning', 12), finding('Third value is wrong', 'blocker', 7, 1, 'src/b.ts')], {
      earlier: { head: reviewed, findings: [
        { id: 'T1', severity: 'warning', title: 'A retry leaves the total stale', file: 'src/a.ts', line: 12, description: 'd', thread: 'open' },
        { id: 'T2', severity: 'warning', title: 'Old two', file: 'src/c.ts', line: 20, description: 'd', disproved: true, thread: 'open' },
        { id: 'T3', severity: 'blocker', title: 'Third value is wrong', file: 'src/b.ts', line: 7, description: 'd', howToFix: 'Set it to 2.', thread: 'open' },
      ] },
      rows: { 'Third value': 'wrong' },
      threads: [{ threadId: 'T1', status: 'not_addressed', reason: 'r' }, { threadId: 'T2', status: 'addressed', reason: 'fixed', fixedIn: 'src/a.ts' }, { threadId: 'T3', status: 'not_addressed', reason: 'r' }],
    }, 'single');
    expect(followUp.posted.length).toBeGreaterThan(0);
    expect(new Set(followUp.calls)).toEqual(new Set(['rating']));

    // A candidate the replay does not rebuild stops the round before any rating call.
    const stored = new AnswerStore();
    const raw = [finding('First problem', 'blocker', 5)];
    await run(raw, { rows: { 'First problem': 'wrong' } }, stored);
    const gone = await run(raw, { rows: { 'First problem': 'wrong' } }, new AnswerStore(JSON.parse(JSON.stringify(stored.answers)) as StoredAnswers, 'refuter'), { form: 'single', candidates: [{ file: 'src/a.ts', line: 5, title: 'Not there', severity: 'blocker' }] }).catch((error: Error) => error);
    expect(String(gone)).toContain('posts the blocker "Not there" 0 times');
  }, GIT_TEST_TIMEOUT_MS * 3);

  it('runs a replay of `manki bench` with no call but the ratings, also none to the matcher, in the form the variant names', async () => {
    const base = git('rev-parse', 'main');
    const head = commit('change', { 'src/a.ts': lines({ 5: 'const v5 = 0;', 12: 'const v12 = 0;', 30: 'const v30 = 0;' }) });
    git('checkout', '-q', 'main');
    const dir = mkdtempSync(join(tmpdir(), 'manki-rate-bench-'));
    const env = process.env;
    const calls: string[] = [];
    const asked: string[] = [];
    try {
      const cases = join(dir, 'bench', 'cases');
      mkdirSync(cases, { recursive: true });
      mkdirSync(join(dir, 'bench', 'holdout'));
      const yaml = `id: demo-1\nrepo: owner/demo\nsource: demo\nbase: ${base}\nhead: ${head}\ntitle: T\nbody: B\nkey_version: 1\nconfig:\n  models: { second_refuter: gpt-6.2-sol }\n  review:\n    sweep: blockers\n    groups: { trivial: [claude-sonnet-5-5], solo: [claude-opus-5-5], full: [claude-opus-5-5, gpt-6.2-sol] }\nmust_catch:\n  - id: K1\n    severity: warning\n    mechanism: The value is wrong.\n    locations: [src/a.ts]\n`;
      writeFileSync(join(cases, 'demo-1.yml'), yaml);
      const benchCase = parseCase(yaml, 'demo-1.yml');
      const raw = [finding('First problem', 'blocker', 5), finding('Second problem', 'warning', 12, 1)];
      const review = { result: { verdict: 'APPROVE', outcome: 'READY', summary: '', findings: [], highlights: [], reviewComplete: true, agentNames: FINDERS }, base, head, approvalHeld: false, context: { usage: {}, findings: { entries: [] }, judge: {}, memory: {}, dedup: {}, reviewers: { rawFindings: raw, agentMetrics: [] } } } as unknown as LocalReview;
      const source = buildReport({ startedAt: '2026-11-24T00:00:00.000Z', runsPerCase: 1, matcherModel: 'claude-sonnet-5-5' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [await scoreRun(benchCase, review, async () => ({ verdict: 'NONE', findings: [], reason: '' }))] }] }]);
      writeFileSync(join(dir, 'source.json'), JSON.stringify(source));
      process.env = { PATH: env.PATH, TMPDIR: env.TMPDIR, HOME: dir, CLAUDE_CODE_OAUTH_TOKEN: 'token', OPENAI_OAUTH_TOKEN: 'token' };
      const bench = async (from: string, out: string, ...flags: string[]) => {
        calls.length = 0;
        fakeClients(calls, asked, { rows: { 'First problem': 'wrong', 'Swept': 'wrong' } });
        expect(await runBenchCommand(['--cases', cases, '--checkout', `owner/demo=${repo}`, '--findings-from', join(dir, from), '--out', join(dir, out), '--cache', join(dir, 'cache.json'), '--runs', '1', ...flags], dir)).toBe(0);
        return (JSON.parse(readFileSync(join(dir, out), 'utf-8')) as BenchReport).variants[0].cases[0].runs[0];
      };
      const recorded = await bench('source.json', 'recorded.json');
      expect(recorded.complete).toBe(true);
      expect([...new Set(calls)].sort()).toEqual(['judge', 'origin check', 'refuter', 'sweep', 'vote']);
      writeFileSync(join(dir, 'empty.yml'), '{}\n');
      const arm = (form: string, ...flags: string[]) => bench('recorded.json', `${form}.json`, '--replay-refuter', '--variant', `base-rate${form}=${join(dir, 'empty.yml')}`, ...flags);
      const single = await arm('');
      expect(single.complete).toBe(true);
      expect(calls).toEqual(Array(6).fill('rating'));
      expect(single.ratings!.map(l => [l.model, l.findings[0].title, l.findings[0].severity]).sort()).toEqual(['claude-opus-5-5', 'gpt-6.2-sol'].flatMap(model => [[model, 'First problem', 'blocker'], [model, 'Second problem', 'warning'], [model, 'Swept elsewhere', 'blocker']]));
      const batch = await arm('-batch');
      expect(calls).toEqual(['batch rating', 'batch rating']);
      expect(batch.ratings!.map(l => [l.form, l.findings.length])).toEqual([['batch', 3], ['batch', 3]]);
    } finally {
      process.env = env;
      rmSync(dir, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS * 3);
});
