import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import * as core from '@actions/core';

import { formatLockfileChanges } from './lockfile';
import { EarlierFinding, overlayConfig, reviewLocal } from './local-review';
import { createLLMClient } from './providers';
import { pushTouchesThread } from './recap';
import { filesChangedByPush, runReview } from './review';
import { AnswerStore, holdsEveryCall, StoredAnswers } from './stored-answers';
import { GIT_TEST_TIMEOUT_MS } from './test-utils';
import { REACH_DOUBT } from './types';
import type { Finding, ReviewResult, RoundOutcome, ThreadEvaluation } from './types';
import { BASE_READS_FILE, BASE_REF, closedPathsOf } from './workspace';

jest.mock('@actions/core');
jest.mock('./providers', () => ({
  ...jest.requireActual('./providers'),
  // As with the real clients, only an OAuth token gives repository tools.
  createLLMClient: jest.fn((_provider: string, _model: string, auth: { kind: string }) => ({ repoTools: auth.kind === 'oauth', sendMessage: jest.fn() })),
}));
jest.mock('./ast-grep', () => ({ ...jest.requireActual('./ast-grep'), loadAstGrep: async () => jest.requireActual('@ast-grep/napi') }));
jest.mock('./review', () => ({
  ...jest.requireActual('./review'),
  runReview: jest.fn(),
}));

const finding: Finding = {
  severity: 'blocker', title: 'Off by one', file: 'src/a.ts', line: 2, description: 'Reads past the end.', reviewers: ['reviewer'],
};

function git(dir: string, ...args: string[]): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  return execFileSync('git', args, { cwd: dir, env, encoding: 'utf-8' }).trim();
}

function commit(dir: string, message: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

describe('reviewLocal', () => {
  let repo: string;
  let base: string;
  let head: string;
  let later: string;
  const inputs = { anthropicOauthToken: 'token', anthropicApiKey: '', openaiOauthToken: '', openaiOauthFile: '', openaiApiKey: '', openaiBaseUrl: '', geminiOauthToken: '', geminiApiKey: '' };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'manki-local-'));
    git(repo, 'init', '-q', '-b', 'main');
    base = commit(repo, 'base', {
      '.manki.yml': 'exclude_paths:\n  - "docs/**"\n',
      'AGENTS.md': 'Use tabs.\n',
      'CONTRIBUTING.md': 'See [conventions](guides/conventions.md).\n',
      'guides/conventions.md': 'Name things plainly.\n',
      'src/a.ts': 'const a = 1;\nconst b = 2;\n',
    });
    git(repo, 'checkout', '-q', '-b', 'feature');
    head = commit(repo, 'Change a', { 'src/a.ts': 'const a = 1;\nconst b = 3;\n', 'docs/x.md': 'notes\n' });
    later = commit(repo, 'Fix a later', { 'src/a.ts': 'const a = 1;\nconst b = 4;\n' });
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'Base moves on', { 'README.md': 'readme\n' });
    jest.clearAllMocks();
    jest.mocked(runReview).mockReset();
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reviews the change from the merge base on a workspace holding only the head, and records the round', async () => {
    let workspaceSeen: { content: string; log: string; base: string; excluded: unknown } | undefined;
    jest.mocked(runReview).mockImplementation(async (_clients, options) => {
      workspaceSeen = {
        content: readFileSync(join(options.workspace!, 'src/a.ts'), 'utf-8'),
        log: git(options.workspace!, 'log', '--format=%H'),
        base: git(options.workspace!, 'rev-parse', BASE_REF),
        excluded: JSON.parse(readFileSync(join(options.workspace!, '.git', BASE_READS_FILE), 'utf8')),
      };
      const notes = ['Note one', 'Note two', 'Note three', 'Note four'].map(title => ({ ...finding, severity: 'note' as const, title }));
      return { verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST' as RoundOutcome, summary: 'One blocker', findings: [{ ...finding }, ...notes], highlights: [], reviewComplete: true, agentNames: ['reviewer'] } as ReviewResult & { outcome: RoundOutcome };
    });

    const review = await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', providerInputs: inputs });

    const options = jest.mocked(runReview).mock.calls[0][1];
    expect(options.rawDiff).toContain('+const b = 3;');
    expect(options.rawDiff).not.toContain('docs/x.md');
    expect(options.excludedPaths).toEqual(['docs/x.md']);
    expect(options.config.exclude_paths).toContain('docs/**');
    expect(options.repoContext).toContain('Use tabs.');
    expect(options.repoContext).toContain('Name things plainly.');
    expect(options.instructionFiles?.map(f => f.path)).toEqual(['AGENTS.md', 'CONTRIBUTING.md', 'guides/conventions.md']);
    expect(review.context.instructions).toEqual({ files: ['AGENTS.md', 'CONTRIBUTING.md', 'guides/conventions.md'] });
    expect(options.prContext).toEqual({ title: 'Change a', body: '', baseBranch: 'main' });
    expect(options.headSha).toBe(head);
    // Without an earlier round there is no thread, which lets a round with nothing to judge skip the judge.
    expect(options.openThreads).toEqual([]);
    expect(options).not.toHaveProperty('relatedReposAsOf');
    expect(workspaceSeen?.content).toBe('const a = 1;\nconst b = 3;\n');
    expect(workspaceSeen?.log).not.toContain(later);
    // The tools read the merge base the change is reviewed from, never excluded paths there.
    expect(workspaceSeen?.base).toBe(base);
    expect(workspaceSeen?.excluded).toEqual({ excludePaths: options.config.exclude_paths });
    expect(existsSync(options.workspace!)).toBe(false);
    expect(review.base).toBe(base);
    expect(review.head).toBe(head);
    expect(review.approvalHeld).toBe(false);
    expect(review.result.findings[0].codeContext).toContain('const b = 3;');
    // The result holds the notes a review would list, and the record keeps the one past `review.notes`.
    expect(review.result.findings.map(f => f.title)).toEqual([finding.title, 'Note one', 'Note two', 'Note three']);
    expect(review.context.findings.unposted).toMatchObject([{ title: 'Note four', unpostedReason: 'note_cap', posted: 'record' }]);
    expect(review.context.meta).toMatchObject({ prNumber: 0, commitSha: head, trigger: { event: 'local', sender: 'local' }, outcome: 'ADDRESS_FIRST' });
    // A round that does not approve records no approval, as a pull request round does.
    expect(review.context).not.toHaveProperty('approval');

    // A round that would approve holds the approval for the excluded file no model read, as a pull request round does.
    jest.mocked(runReview).mockResolvedValueOnce({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    const unread = await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', providerInputs: inputs });
    expect([unread.approvalHeld, unread.context.approval]).toEqual(['unread', { held: 'unread' }]);
    // A warning holds it too, and the record says so behind the first reason, as a pull request round's does.
    const warning = { ...finding, severity: 'warning' as const };
    jest.mocked(runReview).mockResolvedValueOnce({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [warning], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    expect((await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', providerInputs: inputs })).context.approval).toEqual({ held: 'unread', warningsHeld: true });
    // So does a binary file, which no model reads either.
    git(repo, 'checkout', '-q', '-b', 'binary', later);
    commit(repo, 'Add a logo', { 'src/a.ts': 'const a = 1;\nconst b = 5;\n', 'logo.bin': 'logo\u0000' });
    git(repo, 'checkout', '-q', 'main');
    jest.mocked(runReview).mockResolvedValueOnce({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    expect((await reviewLocal({ repoRoot: repo, base: later, head: 'binary', providerInputs: inputs })).approvalHeld).toBe('unread');
    expect(jest.mocked(runReview).mock.calls.at(-1)![1].excludedPaths).toEqual([]);
  }, GIT_TEST_TIMEOUT_MS);

  it('gives the dedup and the judge the same input in two reviews, so their stored answers stand for both calls, and refuses any other', async () => {
    const judgeCalls: string[] = [];
    let dedupCalls = 0;
    const checkCalls: string[] = [];
    const shown = { reason: 'Any call.', proof: ['src/a.ts:2'] };
    jest.mocked(createLLMClient).mockImplementation(() => ({
      repoTools: true,
      sendMessage: jest.fn(async (system: string, message: string) => {
        if (system.startsWith('You are deduplicating')) {
          dedupCalls++;
          return { content: '[{"index": 2, "matchedResolved": 1}]' };
        }
        const refuting = system.startsWith('You check one finding');
        if (refuting || system.startsWith('You decide whether a defect')) {
          checkCalls.push(refuting ? 'refutation' : 'origin check');
          return { content: JSON.stringify(refuting ? { outcome: 'confirmed', reason: 'Past the end.', proof: ['src/a.ts:2'], trigger: shown, result: shown, premises: [1, 2, 3].map(id => ({ id, outcome: 'confirmed', ...shown })) } : { origin: 'introduced', reason: 'New.', head: ['src/a.ts:2'] }) };
        }
        if (!message.includes('## Findings to Evaluate')) throw new Error('no answer');
        judgeCalls.push(message);
        return { content: JSON.stringify({ summary: 'Judged.', findings: [{ id: 1, title: 'Off by one', row: 'wrong', column: 'normal', reasoning: 'r' }] }) };
      }),
    }));
    jest.mocked(runReview).mockImplementation(jest.requireActual<typeof import('./review')>('./review').runReview);
    const raised = { title: 'Off by one', file: 'src/a.ts', line: 2, severity: 'warning' as const, description: 'Reads `b` past the end.', reviewers: ['Claude Opus 5.5 · high'], evidence: { proof: ['AGENTS.md:1'], checks: [] } };
    const findings = [raised, { ...raised, title: 'Repeat', line: 1 }];
    const earlier = { head: 'feature~1', findings: [{ id: 'T1', severity: 'warning' as const, title: 'Settled before', file: 'src/a.ts', line: 1, description: 'd', thread: 'resolved' as const }] };
    const run = async (answers: AnswerStore, body = 'Body.') => reviewLocal({
      repoRoot: repo, base: 'main', head: 'feature', title: 'T', body, providerInputs: inputs, earlier, answers,
      replay: { planner: null, finders: ['Claude Sonnet 5.5 · high', 'Claude Opus 5.5 · high'], findings },
    });

    const live = new AnswerStore();
    const first = await run(live);
    expect([judgeCalls.length, dedupCalls]).toEqual([1, 1]);
    expect(checkCalls).toEqual(['refutation', 'origin check']);
    expect(judgeCalls[0]).toContain('Off by one');
    expect(holdsEveryCall(live.answers)).toBe(true);
    const kept = JSON.parse(JSON.stringify(live.answers)) as StoredAnswers;

    const stored = new AnswerStore(kept);
    const second = await run(stored);
    expect([judgeCalls.length, dedupCalls]).toEqual([1, 1]);
    expect(second.result.allJudgedFindings).toEqual(first.result.allJudgedFindings);
    expect([first, second].map(r => r.result.llmDedupCount)).toEqual([1, 1]);
    expect(stored.answers).toEqual(kept);

    // Without the stored checks the refuter and the origin check run live. With them neither is asked, and the findings come out the same.
    expect(checkCalls).toEqual(['refutation', 'origin check', 'refutation', 'origin check']);
    checkCalls.length = 0;
    const checked = new AnswerStore(kept, 'refuter');
    const third = await run(checked);
    expect(checkCalls).toEqual([]);
    expect(third.result.allJudgedFindings).toEqual(first.result.allJudgedFindings);
    expect(checked.answers).toEqual(kept);
    // Another input to a check is refused, as is a check the stored round did not make. One that failed there fails again, so the later check gets another input.
    const withCheck = (call: string, changed: object) => new AnswerStore({ ...kept, checks: kept.checks!.map(c => (c.call === call ? { ...c, ...changed } : c)) }, 'refuter');
    await expect(run(withCheck('refutation', { input: { ...kept.checks![0].input, message: 'x', effort: 'x' } }))).rejects.toThrow('The stored refutation answer does not fit, since its input differs in: message, effort.');
    await expect(run(withCheck('origin check', { target: 'x' }))).rejects.toThrow('The stored round made no such origin check call, and this one needs its answer.');
    await expect(run(withCheck('refutation', { answer: undefined }))).rejects.toThrow('The stored origin check answer does not fit, since its input differs in: message.');
    expect(checkCalls).toEqual([]);

    // Another input, or a call the stored round did not make, is refused before the call, naming parts and no content.
    await expect(run(new AnswerStore(kept), 'Another body.')).rejects.toThrow(/^The stored judge answer does not fit, since its input differs in: message\.$/);
    findings[1].title = 'Reworded';
    await expect(run(new AnswerStore(kept))).rejects.toThrow('The stored dedup answer does not fit, since its input differs in: message.');
    findings[1].title = 'Repeat';
    await expect(run(new AnswerStore({ ...kept, dedup: null }))).rejects.toThrow('The stored round made no dedup call, and this one needs its answer.');
    await expect(run(new AnswerStore({ ...kept, judge: { ...kept.judge!, input: { ...kept.judge!.input, effort: 'x', model: 'x' } } }))).rejects.toThrow('input differs in: effort, model.');
    expect([judgeCalls.length, dedupCalls]).toEqual([1, 1]);
    // A dedup call that failed in the stored round fails again, so both findings reach the judge, whose stored answer then does not fit.
    await expect(run(new AnswerStore({ ...kept, dedup: { input: kept.dedup!.input } }))).rejects.toThrow('The stored judge answer does not fit, since its input differs in: ');
    expect([judgeCalls.length, dedupCalls]).toEqual([1, 1]);
  }, GIT_TEST_TIMEOUT_MS);

  it('reviews a follow-up round from an earlier round: its threads with the code now, its record, and the diff since', async () => {
    git(repo, 'checkout', '-q', 'feature');
    const lines = Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`);
    const reviewed = commit(repo, 'Add b', { 'src/b.ts': `${lines.join('\n')}\n`, 'src/c.ts': 'start();\nreturn null;\nmiddle();\ncheck();\nend();\nlast();\n' });
    lines[19] = 'const v20 = 0;';
    // The push also edits a file outside the diff, and in `src/c.ts` moves every line down and edits one line.
    const fixed = commit(repo, 'Fix b', { 'src/b.ts': `${lines.join('\n')}\n`, 'src/c.ts': '// Checked.\nstart();\nreturn [];\nmiddle();\ncheck();\nend();\nlast();\n', 'guides/conventions.md': 'Name things clearly.\n' });
    git(repo, 'checkout', '-q', 'main');
    const note = { ...finding, severity: 'note' as const, file: 'src/b.ts' };
    const findings = [
      { ...finding }, { ...finding, file: 'src/b.ts', line: 2 }, { ...finding, title: 'Reads the changed value', file: 'src/b.ts', line: 2, evidence: { checks: [], proof: ['src/b.ts:20'] } },
      { ...finding, file: 'src/b.ts', line: 20 },
      { ...note, title: 'Rename', line: 3 }, { ...note, title: 'Name the constant', file: 'src/a.ts', line: 1, raisedIn: 1 }, { ...note, title: 'New name', line: 19 },
      { ...note, title: 'Second name', line: 20 }, { ...note, title: 'Third name', line: 20 }, { ...note, title: 'Fifth again', line: 20, sameAs: 'src/b.ts:5:5:Fifth-value-is-wrong' },
    ];
    jest.mocked(runReview).mockResolvedValue({ verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: 'Still wrong', findings, highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    const earlier = {
      head: reviewed,
      findings: [
        { id: 'P1', severity: 'blocker' as const, title: 'Wrong value', file: 'src/b.ts', line: 20, description: 'Should be 0.', suggestedFix: 'const v20 = 0;', security: true, thread: 'open' as const },
        { id: 'P2', severity: 'warning' as const, title: 'Unused constant', file: 'src/a.ts', line: 1, disproved: true, thread: 'resolved' as const },
        { id: 'P4', severity: 'blocker' as const, title: 'Missing check', file: 'src/a.ts', line: 2, thread: 'fixed' as const },
        { id: 'P3', severity: 'note' as const, title: 'Name the constant', file: 'src/a.ts', line: 1, gradeIfConfirmed: 'warning' as const, importance: { overall: 3, trigger: 2, introduced: 9, matters: 4 } },
        { id: 'P5', severity: 'warning' as const, title: 'Stale read', file: 'src/a.ts', line: 3, gradeIfConfirmed: 'blocker' as const, cell: { row: 'wrong' as const, column: 'rare' as const }, doubts: [REACH_DOUBT] },
        { id: 'P6', severity: 'warning' as const, title: 'Tenth value is wrong', file: 'src/b.ts', line: 10 },
        { id: 'P7', severity: 'warning' as const, title: 'Guide is vague', file: 'guides/conventions.md', line: 1 },
        { id: 'P8', severity: 'warning' as const, title: 'Null is returned', file: 'src/c.ts', line: 2 },
        { id: 'P9', severity: 'warning' as const, title: 'End runs late', file: 'src/c.ts', line: 5 },
        { id: 'P10', severity: 'warning' as const, title: 'Fifth value is wrong', file: 'src/b.ts', line: 5 },
        { id: 'P11', severity: 'warning' as const, title: 'No file', file: '', line: 1 },
        { id: 'P12', severity: 'warning' as const, title: 'Outside the repo', file: '../outside.ts', line: 1 },
      ],
    };

    const review = await reviewLocal({ repoRoot: repo, base: 'main', head: fixed, earlier, relatedReposAsOf: '2026-10-03T11:20:50Z', providerInputs: inputs });

    const options = jest.mocked(runReview).mock.calls[0][1];
    expect(options.isFollowUp).toBe(true);
    expect(options.relatedReposAsOf).toBe('2026-10-03T11:20:50Z');
    expect(options.interRoundDiff).toContain('-const v20 = 20;\n+const v20 = 0;');
    expect(options.interRoundDiff).not.toContain('src/a.ts');
    expect(options.previousFindings?.map(f => [f.threadId, f.status, f.fixed, f.isSecurity, f.disprovedBlocker])).toEqual([['P1', 'open', undefined, true, undefined], ['P2', 'resolved', undefined, undefined, true], ['P4', 'resolved', true, undefined, undefined]]);
    expect(options.openThreads).toEqual([expect.objectContaining({ threadId: 'P1', severity: 'blocker', description: 'Should be 0.', isSecurity: true, currentCode: expect.stringContaining('>>> 20: const v20 = 0;') })]);
    const [record] = options.priorRounds!;
    expect(record.meta).toMatchObject({ round: 1, commitSha: reviewed });
    expect(record.judge.threadEvaluations).toEqual([{ threadId: 'P4', status: 'addressed', reason: 'Fixed by an earlier push.' }]);
    expect(record.findings.entries.map(e => [e.title, e.threadId, e.severity, e.tags, e.gradeIfConfirmed, ...(e.importance ? [e.importance.overall] : [])])).toEqual([
      ['Wrong value', 'P1', 'blocker', ['security'], undefined], ['Unused constant', 'P2', 'warning', ['disproved-blocker'], undefined], ['Missing check', 'P4', 'blocker', undefined, undefined],
      ['Name the constant', undefined, 'note', undefined, 'warning', 3], ['Stale read', undefined, 'warning', undefined, 'blocker'],
      ['Tenth value is wrong', undefined, 'warning', undefined, undefined], ['Guide is vague', undefined, 'warning', undefined, undefined],
      ['Null is returned', undefined, 'warning', undefined, undefined], ['End runs late', undefined, 'warning', undefined, undefined],
      ['Fifth value is wrong', undefined, 'warning', undefined, undefined], ['No file', undefined, 'warning', undefined, undefined],
      ['Outside the repo', undefined, 'warning', undefined, undefined],
    ]);
    // A warning without a thread was listed in the review body, so its entry holds the place it points at. `src/a.ts` has
    // no line 3. A warning without a file has no place. One in a file that cannot be read is marked unread, so it stays carried.
    expect(record.findings.entries.map(e => [e.posted, e.citedLine?.count, e.unread]).slice(3)).toEqual([
      [undefined, undefined, undefined], ['body', undefined, undefined], ['body', 1, undefined], ['body', 1, undefined], ['body', 1, undefined], ['body', 1, undefined], ['body', 1, undefined], ['body', undefined, undefined], ['body', undefined, true],
    ]);
    expect(jest.mocked(core.warning).mock.calls.filter(([message]) => `${message}`.startsWith('Failed to read'))).toEqual([
      [expect.stringMatching(/^Failed to read \.\.\/outside\.ts, so its earlier warnings are carried without their line: /)],
      [expect.stringMatching(/^Failed to read \.\.\/outside\.ts, so the warnings carried on it stay listed: /)],
    ]);
    // The earlier round's cell and doubts come back with its conditional grade, and an earlier finding without them has none.
    expect(record.findings.entries.map(e => [e.cell, e.doubts]).slice(3, 5)).toEqual([[undefined, undefined], [{ row: 'wrong', column: 'rare' }, [REACH_DOUBT]]]);
    // A note on code the earlier round reviewed, or one it listed, is left out as in a pull request round. A finding that
    // cites a line the push changed is new on an untouched line too.
    expect(review.result.findings.map(f => [f.file, f.line, f.origin])).toEqual([
      ['src/a.ts', 2, 'reviewed'], ['src/b.ts', 2, 'reviewed'], ['src/b.ts', 2, 'new'], ['src/b.ts', 20, 'new'], ['src/b.ts', 19, 'new'], ['src/b.ts', 20, 'new'], ['src/b.ts', 20, 'new'],
    ]);
    expect(review.context.findings.unposted?.map(e => [e.title, e.unpostedReason])).toEqual([['Rename', 'reviewed_code'], ['Name the constant', 'listed_earlier'], ['Fifth again', 'note_cap']]);
    expect(review.context.findings.count).toBe(7);
    // A warning the earlier round listed in its body is carried with the line the place it points at is on now, whatever
    // else the push changed in its file. One on a line the file does not have is not carried. An edited line ends no
    // warning without the judge, in a file outside the diff too, so its warning stays carried without a line, as one in a
    // file that cannot be read does.
    expect(review.result.carried?.map(e => [e.title, e.raisedIn, e.currentLine])).toEqual([
      ['Tenth value is wrong', 1, 10], ['Guide is vague', 1, undefined], ['Null is returned', 1, undefined], ['End runs late', 1, 6], ['Outside the repo', 1, undefined],
    ]);
    expect(review.context.findings.carried).toEqual(review.result.carried);
    // A note that names a carried warning ends it, also when `review.notes` left the note out.
    expect(review.context.findings.carriedEnded).toEqual([{ key: 'src/b.ts:5:5:Fifth-value-is-wrong', reason: 'hidden_note' }]);
    expect(review.context.meta).toMatchObject({ round: 2, commitSha: fixed });
  }, GIT_TEST_TIMEOUT_MS);

  // Each case runs a whole local review over git, which together can pass the default timeout on a CI runner.
  it('holds a local follow-up round for an earlier warning thread as a pull request round does', async () => {
    git(repo, 'checkout', '-q', 'feature');
    const reviewed = commit(repo, 'Add b', { 'src/b.ts': 'retry();\n' });
    const fixed = commit(repo, 'Bound b', { 'src/b.ts': 'retry(3);\n' });
    git(repo, 'checkout', '-q', 'main');

    // An earlier warning thread holds an approving round as in a pull request round, until it is found fixed, graded lower
    // or resolved. A resolved security warning holds until a round finds it fixed.
    const thread = (overrides: Partial<EarlierFinding>): EarlierFinding => ({ id: 'W1', severity: 'warning', title: 'Retry never stops', file: 'src/b.ts', line: 1, thread: 'open', ...overrides });
    const heldBy = async (findings: EarlierFinding[], threadEvaluations?: ThreadEvaluation[]) => {
      jest.mocked(runReview).mockResolvedValueOnce({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'], ...(threadEvaluations && { threadEvaluations }) });
      // From `later`, so the excluded `docs/x.md` does not hold the approval as unread.
      const review = await reviewLocal({ repoRoot: repo, base: later, head: fixed, earlier: { head: reviewed, findings }, providerInputs: inputs });
      // The `--record` file keeps the same approval a pull request round's record does.
      expect(review.context.approval).toEqual({ held: review.approvalHeld, ...(review.approvalHeld === 'warnings' && { warningsHeld: true }) });
      return review.approvalHeld;
    };
    expect(await heldBy([thread({})])).toBe('warnings');
    expect(await heldBy([thread({})], [{ threadId: 'W1', status: 'addressed', reason: 'Bounded now.' }])).toBe(false);
    expect(await heldBy([thread({})], [{ threadId: 'W1', status: 'partly_addressed', reason: 'Smaller.', grade: 'note' }])).toBe(false);
    expect(await heldBy([thread({ thread: 'resolved' })])).toBe(false);
    expect(await heldBy([thread({ thread: 'resolved', security: true })])).toBe('warnings');
    expect(await heldBy([thread({ thread: 'fixed', security: true })])).toBe(false);
    // The thread of a disproved blocker holds as a security thread does.
    expect(await heldBy([thread({ thread: 'resolved', disproved: true })])).toBe('warnings');
    expect(await heldBy([thread({ disproved: true })], [{ threadId: 'W1', status: 'partly_addressed', reason: 'Smaller.', grade: 'note' }])).toBe('warnings');
    // Grades are read as a pull request round reads them: a security warning is never graded below its thread, and a blocker grade blocks instead.
    expect(await heldBy([thread({ security: true })], [{ threadId: 'W1', status: 'partly_addressed', reason: 'Smaller.', grade: 'note' }])).toBe('warnings');
    expect(await heldBy([thread({})], [{ threadId: 'W1', status: 'partly_addressed', reason: 'Worse.', grade: 'blocker' }])).toBe(false);
    // A warning the earlier round listed only in its review body has no thread, so it holds only if this round finds it again.
    expect(await heldBy([thread({ thread: undefined })])).toBe(false);
    // A pre-existing defect never holds, as its thread does not in a pull request round.
    expect(await heldBy([thread({ preExisting: true })])).toBe(false);
  }, 2 * GIT_TEST_TIMEOUT_MS);

  it('counts a push to a file an earlier finding cited as a push to its thread, as a pull request round does', async () => {
    git(repo, 'checkout', '-q', 'feature');
    const reviewed = commit(repo, 'Add b', { 'src/b.ts': 'retry(MAX);\n', 'src/limits.ts': 'export const MAX = Infinity;\n' });
    const fixed = commit(repo, 'Bound the retries', { 'src/limits.ts': 'export const MAX = 3;\n' });
    git(repo, 'checkout', '-q', 'main');
    jest.mocked(runReview).mockResolvedValue({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    const thread: EarlierFinding = { id: 'B1', severity: 'blocker', title: 'Retry never stops', file: 'src/b.ts', line: 1, thread: 'open' };
    const read = async (evidenceFiles?: string[]) => {
      await reviewLocal({ repoRoot: repo, base: later, head: fixed, earlier: { head: reviewed, findings: [{ ...thread, ...(evidenceFiles && { evidenceFiles }) }] }, providerInputs: inputs });
      const { openThreads, previousFindings, interRoundDiff } = jest.mocked(runReview).mock.calls.at(-1)![1];
      return [previousFindings![0].evidenceFiles, openThreads![0].evidenceFiles, pushTouchesThread(openThreads![0], filesChangedByPush(interRoundDiff))];
    };

    // The cited files are cleaned as a pull request round reads them back: the thread's own file and a path outside the repository are left out.
    expect(await read(['src/limits.ts', 'src/b.ts', '../outside.ts'])).toEqual([['src/limits.ts'], ['src/limits.ts'], true]);
    // Without cited files, as in a case written before they were recorded, only the thread's own file counts.
    expect(await read()).toEqual([undefined, undefined, false]);
    expect(jest.mocked(runReview).mock.calls.at(-1)![1].openThreads![0].currentCode).toContain('retry(MAX);');
    expect(jest.mocked(runReview).mock.calls.at(-1)![1].openThreads![0].codeUnread).toBeUndefined();

    // The code of a thread on a file `closed_paths` closes is not read, so the judge is told it cannot see it.
    const config = { ...jest.requireActual('./config').DEFAULT_CONFIG, closed_paths: ['src/b.ts'] };
    await reviewLocal({ repoRoot: repo, base: later, head: fixed, earlier: { head: reviewed, findings: [thread] }, config, providerInputs: inputs });
    expect(jest.mocked(runReview).mock.calls.at(-1)![1].openThreads![0].currentCode).not.toContain('retry(MAX);');
    expect(jest.mocked(runReview).mock.calls.at(-1)![1].openThreads![0].codeUnread).toBe(true);
  }, GIT_TEST_TIMEOUT_MS);

  it('reviews a patch on a workspace holding the tracked files of the head with the patch applied, with the given config, title and body', async () => {
    let workspaceSeen: { content: string; env: boolean; linkIsFile: boolean; indexed: string; closed: boolean; patch: boolean; base: string } | undefined;
    jest.mocked(runReview).mockImplementation(async (_clients, options) => {
      const workspace = options.workspace!;
      workspaceSeen = {
        content: readFileSync(join(workspace, 'src/a.ts'), 'utf-8'), env: existsSync(join(workspace, '.env')), linkIsFile: lstatSync(join(workspace, 'link')).isFile(),
        // Tools that list tracked files read the index, so it holds the symlink the patch adds and no closed file.
        indexed: git(workspace, 'ls-files', '-s', '--', 'docs/x.md', 'link').replace(/ [0-9a-f]+ /g, ' '),
        closed: existsSync(join(workspace, 'docs')), patch: readdirSync(join(workspace, '.git')).some(name => name.endsWith('.patch')),
        base: git(workspace, 'rev-parse', BASE_REF),
      };
      return { verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] };
    });
    git(repo, 'checkout', '-q', '-b', 'with-link', 'feature');
    symlinkSync('/etc/hosts', join(repo, 'link'));
    commit(repo, 'Add a link', {});
    git(repo, 'checkout', '-q', 'main');
    const patch = git(repo, 'diff', 'main', 'with-link');
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');

    const review = await reviewLocal({
      repoRoot: repo, base: 'main', head: 'HEAD', patch, config: { ...jest.requireActual('./config').DEFAULT_CONFIG, exclude_paths: [], closed_paths: ['docs/**'] },
      title: 'My change', body: 'Why it changes', providerInputs: inputs,
    });

    const options = jest.mocked(runReview).mock.calls[0][1];
    // The closed files the patch changes are deleted after it applies, and the patch file, which holds their lines, with them.
    // The base of a patch is the commit it applies to.
    expect(workspaceSeen).toEqual({ content: 'const a = 1;\nconst b = 4;\n', env: false, linkIsFile: true, indexed: '120000 0\tlink', closed: false, patch: false, base: review.head });
    expect(options.workspace).not.toBe(repo);
    expect(existsSync(options.workspace!)).toBe(false);
    expect(options.rawDiff).not.toContain('docs/x.md');
    expect(options.excludedPaths).toEqual(['docs/x.md']);
    expect(options.prContext).toEqual({ title: 'My change', body: 'Why it changes', baseBranch: 'main' });
    expect(review.base).toBe(review.head);

    // A file moved out of a closed path holds the closed file's text, so it is closed in the checkout and for every later read too.
    // A file moved into one held that text at the base, so its old path is closed too.
    git(repo, 'checkout', '-q', '-b', 'moved', 'feature');
    git(repo, 'mv', 'docs/x.md', 'src/x.md');
    git(repo, 'mv', 'guides/conventions.md', 'docs/conventions.md');
    commit(repo, 'Move the notes', { 'src/a.ts': 'const a = 1;\nconst b = 9;\n' });
    git(repo, 'checkout', '-q', 'main');
    let movedSeen: { headCopy: boolean; toolsClose: string[] } | undefined;
    jest.mocked(runReview).mockImplementation(async (_clients, options) => {
      movedSeen = { headCopy: existsSync(join(options.workspace!, 'src/x.md')), toolsClose: closedPathsOf(options.workspace!) };
      return { verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] };
    });
    await reviewLocal({ repoRoot: repo, base: 'feature', head: 'moved', config: { ...jest.requireActual('./config').DEFAULT_CONFIG, closed_paths: ['docs/**'] }, providerInputs: inputs });
    // The tool server refuses a read at the base by the list the checkout keeps, so it holds the old path too.
    expect(movedSeen).toEqual({ headCopy: false, toolsClose: ['docs/**', '/guides/conventions.md', '/src/x.md'] });
    expect(jest.mocked(runReview).mock.calls.at(-1)![1].config.closed_paths).toEqual(['docs/**', '/guides/conventions.md', '/src/x.md']);
  }, GIT_TEST_TIMEOUT_MS);

  it('reads a symlinked config and instruction file at their targets, and no target outside the tree', async () => {
    jest.mocked(runReview).mockResolvedValue({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    git(repo, 'checkout', '-q', '-b', 'linked', base);
    rmSync(join(repo, '.manki.yml'));
    rmSync(join(repo, 'AGENTS.md'));
    symlinkSync('config/manki.yml', join(repo, '.manki.yml'));
    symlinkSync('docs/rules.md', join(repo, 'AGENTS.md'));
    symlinkSync('../../etc/hosts', join(repo, 'CLAUDE.md'));
    commit(repo, 'Link the config', { 'config/manki.yml': 'exclude_paths:\n  - "vendor/**"\n', 'docs/rules.md': 'Linked rules.\n' });
    git(repo, 'checkout', '-q', '-b', 'linked-change');
    commit(repo, 'Change a', { 'src/a.ts': 'const a = 5;\n' });

    await reviewLocal({ repoRoot: repo, base: 'linked', head: 'linked-change', providerInputs: inputs });

    const options = jest.mocked(runReview).mock.calls[0][1];
    expect(options.config.exclude_paths).toContain('vendor/**');
    expect(options.repoContext).toContain('Linked rules.');
    expect(options.repoContext).not.toContain('CLAUDE.md');

    // While the config closes paths, a symlink reads as no file, since its target could be closed.
    jest.mocked(runReview).mockClear();
    const config = { ...jest.requireActual('./config').DEFAULT_CONFIG, closed_paths: ['bench/**'] };
    await reviewLocal({ repoRoot: repo, base: 'linked', head: 'linked-change', config, providerInputs: inputs });
    expect(jest.mocked(runReview).mock.calls[0][1].repoContext ?? '').not.toContain('Linked rules.');
  }, GIT_TEST_TIMEOUT_MS);

  it('reviews a change that only bumps an excluded lockfile through its package list, from a commit range and from a patch', async () => {
    jest.mocked(runReview).mockResolvedValue({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    const lock = (version: string) => `version = 4\n\n[[package]]\nname = "hex"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`;
    git(repo, 'checkout', '-q', '-b', 'locked', base);
    commit(repo, 'Add the lockfile', { '.manki.yml': 'exclude_paths:\n  - "*.lock"\n', 'Cargo.lock': lock('0.4.2') });
    git(repo, 'checkout', '-q', '-b', 'bumped');
    commit(repo, 'Bump hex', { 'Cargo.lock': lock('0.4.3') });
    git(repo, 'checkout', '-q', 'locked');

    const reviews = [
      await reviewLocal({ repoRoot: repo, base: 'locked', head: 'bumped', providerInputs: inputs }),
      await reviewLocal({ repoRoot: repo, base: 'main', head: 'locked', patch: git(repo, 'diff', 'locked', 'bumped'), providerInputs: inputs }),
    ];
    // The excluded lockfile is read through its package list, so it holds no approval.
    expect(reviews.map(r => r.approvalHeld)).toEqual([false, false]);

    for (const [, options] of jest.mocked(runReview).mock.calls) {
      expect([options.diff.files, options.excludedPaths, formatLockfileChanges(options.lockfiles ?? [])]).toEqual([[], ['Cargo.lock'], 'Cargo.lock\n  updated hex 0.4.2 -> 0.4.3 (line 5)']);
    }
    expect(runReview).toHaveBeenCalledTimes(2);

    // A lockfile past the 10 MB a pull request round reads stays unread here too, so nothing is left to review.
    git(repo, 'checkout', '-q', '-b', 'huge', 'locked');
    commit(repo, 'Bump hex in a huge lockfile', { 'Cargo.lock': `# ${'x'.repeat(10 * 1024 * 1024)}\n${lock('0.4.3')}` });
    await expect(reviewLocal({ repoRoot: repo, base: 'locked', head: 'huge', providerInputs: inputs })).rejects.toThrow('Nothing to review');
  }, GIT_TEST_TIMEOUT_MS);

  it('refuses a patch that does not apply to the head', async () => {
    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'HEAD', patch: git(repo, 'diff', 'feature~1', 'feature'), providerInputs: inputs }))
      .rejects.toThrow('The patch does not apply to');
    expect(runReview).not.toHaveBeenCalled();
  }, GIT_TEST_TIMEOUT_MS);

  it('reviews with the defaults when the base config does not load, and with the base config and no approval when the change breaks it, as a pull request round does', async () => {
    jest.mocked(runReview).mockResolvedValue({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    // A base config whose YAML does not parse but names `closed_paths` cannot say which paths it closes, so the review stops before it reads any code.
    git(repo, 'checkout', '-q', '-b', 'unparsable', base);
    commit(repo, 'Break YAML', { '.manki.yml': 'closed_paths: [\n' });
    git(repo, 'checkout', '-q', '-b', 'unparsable-fix');
    commit(repo, 'Fix YAML', { '.manki.yml': 'exclude_paths: []\n', 'src/a.ts': 'const a = 2;\n' });
    await expect(reviewLocal({ repoRoot: repo, base: 'unparsable', head: 'unparsable-fix', providerInputs: inputs }))
      .rejects.toThrow("The base branch's `.manki.yml` names `closed_paths` but does not parse, or its `closed_paths` is not a list of paths");
    expect(runReview).not.toHaveBeenCalled();

    git(repo, 'checkout', '-q', '-b', 'broken', base);
    commit(repo, 'Break config', { '.manki.yml': 'closed_paths:\n  - "docs/**"\nmax_diff_lines: 0\n' });
    git(repo, 'checkout', '-q', '-b', 'fix');
    commit(repo, 'Fix config', { '.manki.yml': 'exclude_paths: []\n', 'src/a.ts': 'const a = 2;\n' });

    const review = await reviewLocal({ repoRoot: repo, base: 'broken', head: 'fix', providerInputs: inputs });

    expect(review.approvalHeld).toBe('config');
    // A round that requests changes has no approval to hold, as in a pull request round.
    jest.mocked(runReview).mockResolvedValueOnce({ verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: 'One blocker', findings: [{ ...finding }], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    expect((await reviewLocal({ repoRoot: repo, base: 'broken', head: 'fix', providerInputs: inputs })).approvalHeld).toBe(false);

    // The defaults keep the paths the file closes.
    expect(jest.mocked(runReview).mock.calls[0][1].config).toMatchObject({ exclude_paths: jest.requireActual('./config').DEFAULT_CONFIG.exclude_paths, closed_paths: ['docs/**'] });
    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(expect.stringContaining('Could not load .manki.yml on the base branch, using the defaults'));
    // The defaults that stand in for the broken base config are not what the change edits.
    expect(jest.mocked(core.info)).not.toHaveBeenCalledWith(expect.stringContaining('This change edits'));
    await expect(reviewLocal({ repoRoot: repo, base: 'broken', head: 'fix', configOverrides: { exclude_paths: [] }, providerInputs: inputs }))
      .rejects.toThrow('`max_diff_lines` must be');

    jest.mocked(runReview).mockClear();
    jest.mocked(core.warning).mockClear();
    jest.mocked(core.info).mockClear();
    git(repo, 'checkout', '-q', '-b', 'rebreak', 'fix');
    commit(repo, 'Break config again', { '.manki.yml': 'exclude_paths: [\n', 'src/a.ts': 'const a = 3;\n' });

    const fromHead = await reviewLocal({ repoRoot: repo, base: 'fix', head: 'rebreak', providerInputs: inputs });

    // The change breaks the file itself, so its approval is held.
    expect(fromHead.approvalHeld).toBe('config');
    expect(jest.mocked(runReview).mock.calls[0][1].config.exclude_paths).toEqual([]);
    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(expect.stringMatching(/^Could not load \.manki\.yml at the head, this review uses the base's settings: Invalid YAML/));
    expect(jest.mocked(core.info)).not.toHaveBeenCalledWith(expect.stringContaining('This change edits'));

  }, GIT_TEST_TIMEOUT_MS);

  it('holds a patch review whose patch leaves a config that does not load, read with the patch applied', async () => {
    jest.mocked(runReview).mockResolvedValue({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    // An API key gives no repository tools, so no workspace applies the patch and only the config read can refuse it.
    const noTools = { ...inputs, anthropicOauthToken: '', anthropicApiKey: 'key' };
    const patched = (config: string) => reviewLocal({
      repoRoot: repo, base: 'main', head: 'main', providerInputs: noTools,
      patch: `diff --git a/.manki.yml b/.manki.yml\n--- a/.manki.yml\n+++ b/.manki.yml\n@@ -1,2 +1,${config.split('\n').length - 1} @@\n-exclude_paths:\n-  - "docs/**"\n${config.replace(/^(?=.)/gm, '+')}`,
    });

    expect((await patched('exclude_paths: [\n')).approvalHeld).toBe('config');
    expect(jest.mocked(runReview).mock.calls[0][1].config.exclude_paths).toEqual(['docs/**']);
    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(expect.stringMatching(/^Could not load \.manki\.yml at the head, this review uses the base's settings: Invalid YAML/));

    // A patch that leaves the config loading holds nothing.
    jest.mocked(core.warning).mockClear();
    expect((await patched('exclude_paths: ["vendor/**"]\n')).approvalHeld).toBe(false);
    expect(jest.mocked(core.warning)).not.toHaveBeenCalled();
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(expect.stringContaining('This change edits `exclude_paths` in .manki.yml'));
    // The patch is applied in a scratch index, so the checkout and its index stay as they were.
    expect(git(repo, 'status', '--porcelain')).toBe('');

    // A warning holds the approval as its thread would in a pull request round, unless it is a pre-existing defect.
    const approving = (findings: Finding[]): ReviewResult & { outcome: RoundOutcome } => ({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings, highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    const warning: Finding = { ...finding, severity: 'warning', tags: ['follow-up'] };
    jest.mocked(runReview).mockResolvedValueOnce(approving([warning]));
    expect((await patched('exclude_paths: ["vendor/**"]\n')).approvalHeld).toBe('warnings');
    jest.mocked(runReview).mockResolvedValueOnce(approving([{ ...warning, tags: ['follow-up', 'pre-existing'] }]));
    expect((await patched('exclude_paths: ["vendor/**"]\n')).approvalHeld).toBe(false);

    // A patch that does not apply cannot show what config it leaves, so it is refused without tools too.
    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'main', patch: git(repo, 'diff', 'feature~1', 'feature'), providerInputs: noTools }))
      .rejects.toThrow('The patch does not apply to');
  }, GIT_TEST_TIMEOUT_MS);

  it('sets config overrides on top of the base config, and refuses overrides that make it invalid or name an unknown key before any model call', async () => {
    jest.mocked(runReview).mockResolvedValue({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });

    await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { models: { judge: 'claude-sonnet-5-5' } }, providerInputs: inputs });
    await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { exclude_paths: ['vendor/**'] }, providerInputs: inputs });

    const [kept, replaced] = jest.mocked(runReview).mock.calls.map(call => call[1]);
    expect(kept.config.models?.judge).toBe('claude-sonnet-5-5');
    expect(kept.config.exclude_paths).toContain('docs/**');
    expect(replaced.config.exclude_paths).toContain('vendor/**');
    expect(replaced.config.exclude_paths).not.toContain('docs/**');
    expect(replaced.rawDiff).toContain('docs/x.md');
    expect(jest.mocked(core.info)).not.toHaveBeenCalledWith(expect.stringContaining('This change edits'));
    jest.mocked(runReview).mockClear();
    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { max_diff_lines: 0 }, providerInputs: inputs }))
      .rejects.toThrow('Invalid config in .manki.yml with the overrides');
    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { model: { reviewer: 'claude-opus-5-5' } }, providerInputs: inputs }))
      .rejects.toThrow('The config overrides name keys the config does not know: Unknown config key: "model"');
    expect(runReview).not.toHaveBeenCalled();
  }, GIT_TEST_TIMEOUT_MS);

  it('refuses a change with no reviewable files before any model call', async () => {
    git(repo, 'checkout', '-q', '-b', 'docs-only', base);
    commit(repo, 'Docs', { 'docs/y.md': 'more\n' });

    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'docs-only', providerInputs: inputs })).rejects.toThrow('no reviewable files');
    expect(runReview).not.toHaveBeenCalled();
  }, GIT_TEST_TIMEOUT_MS);
});

describe('overlayConfig', () => {
  it('merges mappings key by key and replaces every other value', () => {
    expect(overlayConfig(
      { models: { planner: 'a', judge: 'b' }, exclude_paths: ['x'], review: { routing: { wallet: 'full' } } },
      { models: { planner: 'c' }, exclude_paths: ['y'], review: { routing: { consensus: 'full' } }, auto_review: false },
    )).toEqual({ models: { planner: 'c', judge: 'b' }, exclude_paths: ['y'], review: { routing: { wallet: 'full', consensus: 'full' } }, auto_review: false });
  });
});
