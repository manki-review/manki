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
import type { RoundRawFinding, StoredGrade } from './types';

jest.mock('@actions/core');
jest.mock('./providers', () => ({ ...jest.requireActual('./providers'), createLLMClient: jest.fn() }));
jest.mock('./ast-grep', () => ({ ...jest.requireActual('./ast-grep'), loadAstGrep: async () => jest.requireActual('@ast-grep/napi') }));

const STAGES: Array<[string, string]> = [
  ['You test a claim', 'vote'], ['You rate findings', 'rating'], ['You check one finding', 'refuter'], ['You decide whether a defect', 'origin check'], ['A code review reported the finding', 'sweep'],
  ['You are deduplicating', 'dedup'], ['You check whether a code review reported', 'matcher'], ['You give the final merge-readiness', 'verdict reader'], ['You judge a pull request as a whole', 'scope reader'],
];
const inputs = { anthropicOauthToken: 'token', anthropicApiKey: '', openaiOauthToken: 'token', openaiOauthFile: '', openaiApiKey: '', openaiBaseUrl: '', geminiOauthToken: '', geminiApiKey: '' };
const CONFIG = loadConfig(`models:\n  second_refuter: gpt-6.2-sol\nreview:\n  scope_blocks: true\n  sweep: blockers\n  groups:\n    trivial: [claude-sonnet-5-5]\n    solo: [claude-opus-5-5]\n    full: [claude-opus-5-5, gpt-6.2-sol]\n`);
const FINDERS = ['Claude Opus 5.5 · high', 'GPT 6.2 Sol · high'];

describe('a replay that scores the posted warnings', () => {
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

  interface Round { earlier?: EarlierRound; rows?: Record<string, string>; threads?: unknown[]; blocks?: boolean; declines?: string }

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
        if (stage === 'rating') {
          expect(options?.repoTools).toBeUndefined();
          asked.push(`${system}\n${message}`);
          const ids = [...message.matchAll(/^## Finding (\d+): /gm)].map(([, id]) => Number(id));
          return reply({ ratings: ids.map(id => ({ id, ...scored(3) })) });
        }
        if (stage === 'vote') return reply(more.declines && message.includes(`Claim: ${more.declines}`) ? { harm: '', situation: '', line: 'none', quote: '' } : { harm: 'h', situation: 's', line: 'src/a.ts:5', quote: 'const v5 = 0;' });
        if (stage === 'refuter') return reply({ outcome: 'confirmed', reason: 'Real.', proof: ['src/a.ts:5'], trigger: cite, result: cite, premises: [1, 2, 3].map(id => ({ id, outcome: 'confirmed', ...cite })) });
        if (stage === 'origin check') return reply({ origin: 'introduced', reason: 'New.', head: ['src/a.ts:5'] });
        if (stage === 'sweep') return reply({ class: 'c', general: true, findings: [{ ...finding('Swept elsewhere', 'blocker', 30), evidence: ['src/a.ts:30 is wrong'], proof: ['src/a.ts:30'] }] });
        if (stage === 'dedup') return reply([...message.matchAll(/A: "/g)].map((_, i) => ({ pair: i + 1, sameDefect: false })));
        if (stage === 'scope reader') return { content: JSON.stringify({ useful: false, topics: [] }) };
        if (stage === 'verdict reader') return reply({ verdict: 'READY', blockers: [], summary: 's', whatThisDoes: 'w', whatToTest: { steps: ['Do it.'] } });
        if (stage === 'matcher') return reply({ verdict: 'NONE', findings: [], reason: 'n' });
        if (stage === 'judge') return reply({ summary: 'Judged.', threadEvaluations: more.threads ?? [], findings: [...message.matchAll(/### Finding (\d+): ([^\n]*)/g)].map(([, id, title]) => ({ id: Number(id), title, row: Object.entries(more.rows ?? {}).find(([name]) => title.includes(name))?.[1] ?? 'degraded', column: 'normal', reasoning: 'SECRET_GRADE_REASON', trigger: 'when run' })) });
        throw new Error('unexpected call');
      }),
    }) as never);
  };

  const run = async (findings: RoundRawFinding[], more: Round, answers: AnswerStore, grades?: StoredGrade[]) => {
    const calls: string[] = [];
    const asked: string[] = [];
    fakeClients(calls, asked, more);
    const review = await reviewLocal({
      repoRoot: repo, base: 'main', head: 'feature', title: 'T', body: 'B', providerInputs: inputs, config: CONFIG, answers, ...(more.earlier && { earlier: more.earlier }),
      replay: { planner: null, finders: FINDERS, findings, ...(grades && { grades }) },
    });
    return { review, calls, asked };
  };

  it('asks nothing but one rating call, takes the stored grades and votes, and refuses another posted list', async () => {
    commit('change', { 'src/a.ts': lines({ 5: 'const v5 = 0;', 12: 'const v12 = 0;', 30: 'const v30 = 0;' }), 'src/b.ts': lines({ 7: 'const v7 = 0;' }) });
    const raw = [finding('First problem', 'blocker', 5), finding('Second problem', 'warning', 12, 1), finding('Third problem', 'warning', 7, 1, 'src/b.ts')];
    const more: Round = { rows: { 'First problem': 'wrong', 'Swept': 'wrong' }, declines: 'Second problem' };
    const live = new AnswerStore();
    const first = await run(raw, more, live);
    expect(first.calls).toContain('vote');
    const of = (round: typeof first, title: string) => round.review.result.findings.find(f => f.title === title)!;
    expect(of(first, 'Second problem').severity).toBe('note');
    const grades = [
      ...first.review.result.findings.filter(f => f.severity === 'blocker' || f.severity === 'warning').map(({ file, line, title, severity }): StoredGrade => ({ file, line, title, severity })),
      { file: 'src/a.ts', line: 12, title: 'Second problem', severity: 'warning', declined: true } satisfies StoredGrade,
    ];
    // The stored round is replayed as it was before the product scored it.
    if (!grades.some(g => g.title === 'Third problem')) grades.push({ file: 'src/b.ts', line: 7, title: 'Third problem', severity: 'warning' });
    const kept = JSON.stringify(live.answers);
    const again = (some: StoredGrade[]) => run(raw, more, new AnswerStore(JSON.parse(kept) as StoredAnswers, 'refuter'), some);

    const second = await again(grades);
    expect(second.review.result.reviewComplete).toBe(true);
    expect(second.calls).toEqual(['rating']);
    expect(second.asked[0]).toContain('## Finding 1: Third problem');
    expect(second.asked[0]).not.toContain('Second problem');
    expect(of(second, 'Third problem')).toMatchObject({ severity: 'note', importance: { overall: 3 } });
    expect(of(second, 'Second problem').importance).toBeUndefined();
    expect(of(second, 'First problem').importance).toBeUndefined();

    for (const [wrong, said] of [
      [[...grades, { file: 'src/a.ts', line: 5, title: 'Not there', severity: 'blocker' }], 'Not posted exactly once: blocker "Not there"'],
      [grades.filter(g => g.title !== 'Third problem'), 'Extra: warning "Third problem"'],
    ] as Array<[StoredGrade[], string]>) {
      await expect(again(wrong)).rejects.toThrow(said);
    }
  }, GIT_TEST_TIMEOUT_MS * 3);

  it('runs a replay of `manki bench` with no call but the rating, also none to the matcher', async () => {
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
      expect([...new Set(calls)].sort()).toEqual(['judge', 'matcher', 'origin check', 'rating', 'refuter', 'scope reader', 'sweep', 'vote']);
      // A live round posts the warning it lowered, so the recording holds its grade from before the score.
      const report = JSON.parse(readFileSync(join(dir, 'recorded.json'), 'utf-8')) as BenchReport;
      for (const f of report.variants[0].cases[0].runs[0].findings) if (f.title === 'Second problem') f.severity = 'warning';
      writeFileSync(join(dir, 'recorded.json'), JSON.stringify(report));
      const scoredRun = await bench('recorded.json', 'scored.json', '--replay-refuter');
      expect(scoredRun.complete).toBe(true);
      expect(calls).toEqual(['rating']);
      expect(scoredRun.findings.find(f => f.title === 'Second problem')!.route!.importance).toMatchObject({ overall: 3, lowered: true, scores: { trigger: 3 } });
      expect(scoredRun.calls!.map(c => c.stage)).toEqual(['rating']);
    } finally {
      process.env = env;
      rmSync(dir, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS * 3);
});
