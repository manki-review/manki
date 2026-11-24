import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { BenchReport, buildReport, parseCase, runBenchCommand, scoreRun } from './bench';
import { loadConfig } from './config';
import { EarlierRound, LocalReview, reviewLocal } from './local-review';
import { createLLMClient, TimeoutError } from './providers';
import { AnswerStore, StoredAnswers } from './stored-answers';
import { GIT_TEST_TIMEOUT_MS } from './test-utils';
import type { RoundRawFinding } from './types';

jest.mock('@actions/core');
jest.mock('./providers', () => ({ ...jest.requireActual('./providers'), createLLMClient: jest.fn() }));
jest.mock('./ast-grep', () => ({ ...jest.requireActual('./ast-grep'), loadAstGrep: async () => jest.requireActual('@ast-grep/napi') }));

const STAGES: Array<[string, string]> = [
  ['You test a claim', 'vote'], ['You check one finding', 'refuter'], ['You decide whether a defect', 'origin check'], ['A code review reported the finding', 'sweep'],
  ['You are deduplicating', 'dedup'], ['You check whether a code review reported', 'matcher'], ['You give the final merge-readiness', 'verdict reader'], ['You judge a pull request as a whole', 'scope reader'],
];
const inputs = { anthropicOauthToken: 'token', anthropicApiKey: '', openaiOauthToken: 'token', openaiOauthFile: '', openaiApiKey: '', openaiBaseUrl: '', geminiOauthToken: '', geminiApiKey: '' };
const CONFIG = loadConfig(`models:\n  second_refuter: gpt-6.2-sol\nreview:\n  scope_blocks: true\n  sweep: blockers\n  groups:\n    trivial: [claude-sonnet-5-5]\n    solo: [claude-opus-5-5]\n    full: [claude-opus-5-5, gpt-6.2-sol]\n`);
const FINDERS = ['Claude Opus 5.5 · high', 'GPT 6.2 Sol · high'];

describe('a replay of the vote', () => {
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
    repo = mkdtempSync(join(tmpdir(), 'manki-vote-replay-'));
    git('init', '-q', '-b', 'main');
    commit('base', { 'src/a.ts': lines(), 'src/b.ts': lines(), 'src/c.ts': lines() });
    git('checkout', '-q', '-b', 'feature');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  const finding = (title: string, severity: 'blocker' | 'warning', line: number, finder = 0, file = 'src/a.ts'): RoundRawFinding =>
    ({ title, file, line, severity, description: `${title} is wrong.`, reviewers: [FINDERS[finder]], evidence: { proof: [`${file}:${line}`], checks: [] } });

  interface Round { earlier?: EarlierRound; rows?: Record<string, string>; threads?: unknown[]; blocks?: boolean; failVote?: string; reads?: Array<{ reviewer: string; model: string }> }

  /** Answers every client's calls, and adds the stage of each call to `calls`. */
  const fakeClients = (calls: string[], more: Round): void => {
    const cite = { reason: 'Any call.', proof: ['src/a.ts:5'] };
    jest.mocked(createLLMClient).mockImplementation((_provider, model) => ({
      repoTools: true,
      sendMessage: jest.fn(async (system: string, message: string) => {
        const stage = STAGES.find(([head]) => system.startsWith(head))?.[1] ?? (message.includes('## Findings to Evaluate') ? 'judge' : `other: ${system.slice(0, 60)}`);
        calls.push(stage);
        const reply = (value: unknown) => ({ content: JSON.stringify(value), model, latencyMs: 10 });
        if (stage === 'vote') {
          if (more.failVote && message.includes(`Claim: ${more.failVote}`)) throw new TimeoutError('Claude CLI timed out after 120s');
          return reply({ harm: 'h', situation: 's', line: 'none', quote: '', trigger: { reason: 'r', line: 'none', quote: '' }, result: { reason: 'r', line: 'none', quote: '' } });
        }
        if (stage === 'refuter') return reply({ outcome: 'confirmed', reason: 'Real.', proof: ['src/a.ts:5'], trigger: cite, result: cite, premises: [1, 2, 3].map(id => ({ id, outcome: 'confirmed', ...cite })) });
        if (stage === 'origin check') return reply({ origin: 'introduced', reason: 'New.', head: ['src/a.ts:5'] });
        if (stage === 'sweep') return reply({ class: 'c', general: true, findings: [{ ...finding('Swept elsewhere', 'blocker', 30), evidence: ['src/a.ts:30 is wrong'], proof: ['src/a.ts:30'] }] });
        if (stage === 'dedup') return reply([...message.matchAll(/A: "/g)].map((_, i) => ({ pair: i + 1, sameDefect: false })));
        if (stage === 'scope reader') return { content: JSON.stringify({ useful: false, topics: [] }) };
        if (stage === 'verdict reader') return reply({ verdict: more.blocks ? 'ADDRESS_FIRST' : 'READY', blockers: more.blocks ? [{ file: 'src/b.ts', line: 7, title: 'Reader blocker', description: 'd', howToFix: 'f', evidence: ['src/b.ts:7'], proof: ['src/b.ts:7'], buildClaim: false }] : [], summary: 's', whatThisDoes: 'w', whatToTest: { steps: ['Do it.'] } });
        if (stage === 'judge') return reply({ summary: 'Judged.', threadEvaluations: more.threads ?? [], findings: [...message.matchAll(/### Finding (\d+): ([^\n]*)/g)].map(([, id, title]) => ({ id: Number(id), title, row: Object.entries(more.rows ?? {}).find(([name]) => title.includes(name))?.[1] ?? 'degraded', column: 'normal', reasoning: 'r' })) });
        throw new Error('unexpected call');
      }),
    }) as never);
  };

  const run = async (findings: RoundRawFinding[], more: Round, answers: AnswerStore) => {
    const calls: string[] = [];
    fakeClients(calls, more);
    const review = await reviewLocal({
      repoRoot: repo, base: 'main', head: 'feature', title: 'T', body: 'B', providerInputs: inputs, config: CONFIG, answers, ...(more.earlier && { earlier: more.earlier }),
      replay: { planner: null, finders: FINDERS, findings, ...(more.reads && { reads: more.reads }) },
    });
    return { review, calls };
  };

  it('asks nothing but the votes, and keeps every other answer of the stored round', async () => {
    const reviewed = commit('change', { 'src/a.ts': lines({ 5: 'const v5 = 0;', 12: 'const v12 = 0;', 30: 'const v30 = 0;' }), 'src/b.ts': lines({ 7: 'const v7 = 0;' }), 'src/c.ts': lines({ 20: 'const v20 = 0;' }) });
    const replayed = async (findings: RoundRawFinding[], more: Parameters<typeof run>[1]) => {
      const live = new AnswerStore();
      const first = await run(findings, more, live);
      const kept = JSON.parse(JSON.stringify(live.answers)) as StoredAnswers;
      const store = new AnswerStore(kept, 'refuter');
      const second = await run(findings, more, store);
      const { result } = second.review;
      expect(result.reviewComplete).toBe(true);
      expect(result.findings).toEqual(first.review.result.findings);
      // Nothing replaced a stored answer, and each stored check was used.
      const order = (answers: StoredAnswers) => ({ ...answers, checks: answers.checks!.map(c => JSON.stringify(c)).sort() });
      expect(order(JSON.parse(JSON.stringify(store.answers)) as StoredAnswers)).toEqual(order(kept));
      return { live: new Set(first.calls), calls: second.calls, stored: new Set(kept.checks!.map(c => c.call)), votes: new Map(result.votes!.map(v => [v.title, [v.grade, v.after, v.answer, v.calls.map(c => c.outcome).join()]])) };
    };

    // Its stored round asked the judge, the refuters, the origin checks and a sweep with a judge call of its own. A vote that times out is asked once more.
    const blocker = await replayed([finding('First blocker', 'blocker', 5), finding('Second warning', 'warning', 12, 1)], { rows: { 'First blocker': 'wrong', 'Swept': 'wrong' }, failVote: 'Second warning' });
    expect([...blocker.live].sort()).toEqual(['judge', 'origin check', 'refuter', 'sweep', 'vote']);
    expect([...blocker.stored].sort()).toEqual(['origin check', 'refutation', 'second origin check', 'second refutation', 'sweep', 'sweep judge']);
    expect(blocker.calls).toEqual(['vote', 'vote', 'vote']);
    expect(Object.fromEntries(blocker.votes)).toEqual({ 'First blocker': ['blocker', 'warning', 'declines', 'answered'], 'Second warning': ['warning', 'warning', 'no_answer', 'timed_out,timed_out'] });

    // Nothing blocks, so without the skip a verdict reader runs, and its blocker is checked and matched to the findings.
    const read = { ...finding('Read warning', 'warning', 30), reviewers: ['Second read 1'] };
    const warnings = await replayed([finding('A warning', 'warning', 5), finding('Other warning', 'warning', 12, 1), read], { blocks: true, reads: [{ reviewer: 'Second read 1', model: 'claude-opus-5-5' }] });
    expect(warnings.calls).toEqual(['vote', 'vote', 'vote']);
    expect(Object.fromEntries(warnings.votes)).toEqual(Object.fromEntries(['A warning', 'Other warning', 'Read warning'].map(title => [title, ['warning', 'note', 'declines', 'answered']])));

    // A follow-up whose push fixes one thread in another file, follows the fix suggested in another and reworded a third, which without the skip asks the refuters and the dedup model.
    commit('push', { 'src/a.ts': lines({ 5: 'const v5 = 0;', 12: 'const v12 = 1;', 30: 'const v30 = 0;' }), 'src/b.ts': lines({ 7: 'const v7 = 2;' }) });
    const followUp = await replayed([finding('Total is stale after a retry', 'warning', 12), finding('Third value is wrong', 'blocker', 7, 1, 'src/b.ts')], {
      earlier: { head: reviewed, findings: [
        { id: 'T1', severity: 'warning', title: 'A retry leaves the total stale', file: 'src/a.ts', line: 12, description: 'd', thread: 'open' },
        { id: 'T2', severity: 'warning', title: 'Old two', file: 'src/c.ts', line: 20, description: 'd', disproved: true, thread: 'open' },
        { id: 'T3', severity: 'blocker', title: 'Third value is wrong', file: 'src/b.ts', line: 7, description: 'd', howToFix: 'Set it to 2.', thread: 'open' },
      ] },
      rows: { 'Third value': 'wrong' },
      threads: [{ threadId: 'T1', status: 'not_addressed', reason: 'r' }, { threadId: 'T2', status: 'addressed', reason: 'fixed', fixedIn: 'src/a.ts' }, { threadId: 'T3', status: 'not_addressed', reason: 'r' }],
    });
    expect(followUp.calls).toEqual(['vote']);
  }, GIT_TEST_TIMEOUT_MS * 3);

  it('runs a replay of `manki bench` with no call but the votes, also none to the matcher', async () => {
    const base = git('rev-parse', 'main');
    const head = commit('change', { 'src/a.ts': lines({ 5: 'const v5 = 0;', 12: 'const v12 = 0;', 30: 'const v30 = 0;' }) });
    git('checkout', '-q', 'main');
    const dir = mkdtempSync(join(tmpdir(), 'manki-vote-bench-'));
    const env = process.env;
    const calls: string[] = [];
    try {
      const cases = join(dir, 'bench', 'cases');
      mkdirSync(cases, { recursive: true });
      mkdirSync(join(dir, 'bench', 'holdout'));
      const yaml = `id: demo-1\nrepo: owner/demo\nsource: demo\nbase: ${base}\nhead: ${head}\ntitle: T\nbody: B\nkey_version: 1\nconfig:\n  models: { second_refuter: gpt-6.2-sol }\n  review:\n    sweep: blockers\n    groups: { trivial: [claude-sonnet-5-5], solo: [claude-opus-5-5], full: [claude-opus-5-5, gpt-6.2-sol] }\nmust_catch:\n  - id: K1\n    severity: warning\n    mechanism: The value is wrong.\n    locations: [src/a.ts]\n`;
      writeFileSync(join(cases, 'demo-1.yml'), yaml);
      const benchCase = parseCase(yaml, 'demo-1.yml');
      const raw = [finding('First blocker', 'blocker', 5), finding('Second warning', 'warning', 12, 1)];
      const review = { result: { verdict: 'APPROVE', outcome: 'READY', summary: '', findings: [], highlights: [], reviewComplete: true, agentNames: FINDERS }, base, head, approvalHeld: false, context: { usage: {}, findings: { entries: [] }, judge: {}, memory: {}, dedup: {}, reviewers: { rawFindings: raw, agentMetrics: [] } } } as unknown as LocalReview;
      const source = buildReport({ startedAt: '2026-11-24T00:00:00.000Z', runsPerCase: 1, matcherModel: 'claude-sonnet-5-5' }, [{ variant: { name: 'base', overrides: {} }, results: [{ benchCase, runs: [await scoreRun(benchCase, review, async () => ({ verdict: 'NONE', findings: [], reason: '' }))] }] }]);
      writeFileSync(join(dir, 'source.json'), JSON.stringify(source));
      process.env = { PATH: env.PATH, TMPDIR: env.TMPDIR, HOME: dir, CLAUDE_CODE_OAUTH_TOKEN: 'token', OPENAI_OAUTH_TOKEN: 'token' };
      const bench = async (from: string, out: string, ...flags: string[]) => {
        calls.length = 0;
        fakeClients(calls, { rows: { 'First blocker': 'wrong', 'Swept': 'wrong' } });
        expect(await runBenchCommand(['--cases', cases, '--checkout', `owner/demo=${repo}`, '--findings-from', join(dir, from), '--out', join(dir, out), '--cache', join(dir, 'cache.json'), '--runs', '1', ...flags], dir)).toBe(0);
        return (JSON.parse(readFileSync(join(dir, out), 'utf-8')) as BenchReport).variants[0].cases[0].runs[0];
      };
      const recorded = await bench('source.json', 'recorded.json');
      expect(recorded.complete).toBe(true);
      expect([...new Set(calls)].sort()).toEqual(['judge', 'origin check', 'refuter', 'sweep', 'vote']);
      const arm = await bench('recorded.json', 'arm.json', '--replay-refuter');
      expect(arm.complete).toBe(true);
      expect(calls).toEqual(['vote', 'vote']);
      expect(arm.votes!.map(v => [v.title, v.grade, v.after])).toEqual([['First blocker', 'blocker', 'warning'], ['Second warning', 'warning', 'note']]);
    } finally {
      process.env = env;
      rmSync(dir, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS * 3);
});
