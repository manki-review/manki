import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import * as core from '@actions/core';

import { formatLockfileChanges } from './lockfile';
import { EarlierFinding, overlayConfig, reviewLocal } from './local-review';
import { runReview } from './review';
import { REACH_DOUBT } from './types';
import type { Finding, ReviewResult, RoundOutcome, ThreadEvaluation } from './types';

jest.mock('@actions/core');
jest.mock('./providers', () => ({
  ...jest.requireActual('./providers'),
  // As with the real clients, only an OAuth token gives repository tools.
  createLLMClient: jest.fn((_provider: string, _model: string, auth: { kind: string }) => ({ repoTools: auth.kind === 'oauth', sendMessage: jest.fn() })),
}));
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
  const inputs = { anthropicOauthToken: 'token', anthropicApiKey: '', openaiOauthToken: '', openaiApiKey: '', geminiOauthToken: '', geminiApiKey: '' };

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
    let workspaceSeen: { content: string; log: string } | undefined;
    jest.mocked(runReview).mockImplementation(async (_clients, options) => {
      workspaceSeen = {
        content: readFileSync(join(options.workspace!, 'src/a.ts'), 'utf-8'),
        log: git(options.workspace!, 'log', '--format=%H'),
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
    expect(options).not.toHaveProperty('relatedReposAsOf');
    expect(workspaceSeen?.content).toBe('const a = 1;\nconst b = 3;\n');
    expect(workspaceSeen?.log).not.toContain(later);
    expect(existsSync(options.workspace!)).toBe(false);
    expect(review.base).toBe(base);
    expect(review.head).toBe(head);
    expect(review.approvalHeld).toBe(false);
    expect(review.result.findings[0].codeContext).toContain('const b = 3;');
    // The result holds the notes a review would list, and the record keeps the one past `review.notes`.
    expect(review.result.findings.map(f => f.title)).toEqual([finding.title, 'Note one', 'Note two', 'Note three']);
    expect(review.context.findings.unposted).toMatchObject([{ title: 'Note four', unpostedReason: 'note_cap', posted: 'record' }]);
    expect(review.context.meta).toMatchObject({ prNumber: 0, commitSha: head, trigger: { event: 'local', sender: 'local' }, outcome: 'ADDRESS_FIRST' });

    // A round that would approve holds the approval for the excluded file no model read, as a pull request round does.
    jest.mocked(runReview).mockResolvedValueOnce({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    expect((await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', providerInputs: inputs })).approvalHeld).toBe('unread');
    // So does a binary file, which no model reads either.
    git(repo, 'checkout', '-q', '-b', 'binary', later);
    commit(repo, 'Add a logo', { 'src/a.ts': 'const a = 1;\nconst b = 5;\n', 'logo.bin': 'logo\u0000' });
    git(repo, 'checkout', '-q', 'main');
    jest.mocked(runReview).mockResolvedValueOnce({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    expect((await reviewLocal({ repoRoot: repo, base: later, head: 'binary', providerInputs: inputs })).approvalHeld).toBe('unread');
    expect(jest.mocked(runReview).mock.calls.at(-1)![1].excludedPaths).toEqual([]);
  });

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
      { ...finding }, { ...finding, file: 'src/b.ts', line: 2 }, { ...finding, file: 'src/b.ts', line: 20 },
      { ...note, title: 'Rename', line: 3 }, { ...note, title: 'Name the constant', file: 'src/a.ts', line: 1, raisedIn: 1 }, { ...note, title: 'New name', line: 19 },
      { ...note, title: 'Second name', line: 20 }, { ...note, title: 'Third name', line: 20 }, { ...note, title: 'Fifth again', line: 20, sameAs: 'src/b.ts:5:5:Fifth-value-is-wrong' },
    ];
    jest.mocked(runReview).mockResolvedValue({ verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: 'Still wrong', findings, highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    const earlier = {
      head: reviewed,
      findings: [
        { id: 'P1', severity: 'blocker' as const, title: 'Wrong value', file: 'src/b.ts', line: 20, description: 'Should be 0.', suggestedFix: 'const v20 = 0;', security: true, thread: 'open' as const },
        { id: 'P2', severity: 'warning' as const, title: 'Unused constant', file: 'src/a.ts', line: 1, thread: 'resolved' as const },
        { id: 'P4', severity: 'blocker' as const, title: 'Missing check', file: 'src/a.ts', line: 2, thread: 'fixed' as const },
        { id: 'P3', severity: 'note' as const, title: 'Name the constant', file: 'src/a.ts', line: 1, gradeIfConfirmed: 'warning' as const },
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
    expect(options.previousFindings?.map(f => [f.threadId, f.status, f.fixed, f.isSecurity])).toEqual([['P1', 'open', undefined, true], ['P2', 'resolved', undefined, undefined], ['P4', 'resolved', true, undefined]]);
    expect(options.openThreads).toEqual([expect.objectContaining({ threadId: 'P1', severity: 'blocker', description: 'Should be 0.', currentCode: expect.stringContaining('>>> 20: const v20 = 0;') })]);
    const [record] = options.priorRounds!;
    expect(record.meta).toMatchObject({ round: 1, commitSha: reviewed });
    expect(record.judge.threadEvaluations).toEqual([{ threadId: 'P4', status: 'addressed', reason: 'Fixed by an earlier push.' }]);
    expect(record.findings.entries.map(e => [e.title, e.threadId, e.severity, e.tags, e.gradeIfConfirmed])).toEqual([
      ['Wrong value', 'P1', 'blocker', ['security'], undefined], ['Unused constant', 'P2', 'warning', undefined, undefined], ['Missing check', 'P4', 'blocker', undefined, undefined],
      ['Name the constant', undefined, 'note', undefined, 'warning'], ['Stale read', undefined, 'warning', undefined, 'blocker'],
      ['Tenth value is wrong', undefined, 'warning', undefined, undefined], ['Guide is vague', undefined, 'warning', undefined, undefined],
      ['Null is returned', undefined, 'warning', undefined, undefined], ['End runs late', undefined, 'warning', undefined, undefined],
      ['Fifth value is wrong', undefined, 'warning', undefined, undefined], ['No file', undefined, 'warning', undefined, undefined],
      ['Outside the repo', undefined, 'warning', undefined, undefined],
    ]);
    // A warning without a thread was listed in the review body, so its entry holds the place it points at. `src/a.ts` has
    // no line 3. A warning without a file has no place, and neither has one in a file that cannot be read.
    expect(record.findings.entries.map(e => [e.posted, e.citedLine?.count]).slice(3)).toEqual([
      [undefined, undefined], ['body', undefined], ['body', 1], ['body', 1], ['body', 1], ['body', 1], ['body', 1], ['body', undefined], ['body', undefined],
    ]);
    expect(jest.mocked(core.warning).mock.calls.filter(([message]) => `${message}`.startsWith('Failed to read'))).toEqual([[expect.stringMatching(/^Failed to read \.\.\/outside\.ts, so its earlier warnings are not carried: /)]]);
    // The earlier round's cell and doubts come back with its conditional grade, and an earlier finding without them has none.
    expect(record.findings.entries.map(e => [e.cell, e.doubts]).slice(3, 5)).toEqual([[undefined, undefined], [{ row: 'wrong', column: 'rare' }, [REACH_DOUBT]]]);
    // A note on code the earlier round reviewed, or one it listed, is left out as in a pull request round.
    expect(review.result.findings.map(f => [f.file, f.line, f.origin])).toEqual([
      ['src/a.ts', 2, 'reviewed'], ['src/b.ts', 2, 'reviewed'], ['src/b.ts', 20, 'new'], ['src/b.ts', 19, 'new'], ['src/b.ts', 20, 'new'], ['src/b.ts', 20, 'new'],
    ]);
    expect(review.context.findings.unposted?.map(e => [e.title, e.unpostedReason])).toEqual([['Rename', 'reviewed_code'], ['Name the constant', 'listed_earlier'], ['Fifth again', 'note_cap']]);
    expect(review.context.findings.count).toBe(6);
    // A warning the earlier round listed in its body is carried while the place it points at reads the same, with the
    // line that place is on now, whatever else the push changed in its file. One on a line the file does not have is not carried.
    expect(review.result.carried?.map(e => [e.title, e.raisedIn, e.currentLine])).toEqual([['Tenth value is wrong', 1, 10], ['End runs late', 1, 6]]);
    expect(review.context.findings.carried).toEqual(review.result.carried);
    // An edited line ends its warning, in a file outside the diff too. So does a note that names it, which `review.notes` left out.
    expect(review.context.findings.carriedEnded).toEqual([
      { key: 'guides/conventions.md:1:1:Guide-is-vague', reason: 'line_changed' }, { key: 'src/c.ts:2:2:Null-is-returned', reason: 'line_changed' },
      { key: 'src/b.ts:5:5:Fifth-value-is-wrong', reason: 'hidden_note' },
    ]);
    expect(review.context.meta).toMatchObject({ round: 2, commitSha: fixed });
  });

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
      return (await reviewLocal({ repoRoot: repo, base: later, head: fixed, earlier: { head: reviewed, findings }, providerInputs: inputs })).approvalHeld;
    };
    expect(await heldBy([thread({})])).toBe('warnings');
    expect(await heldBy([thread({})], [{ threadId: 'W1', status: 'addressed', reason: 'Bounded now.' }])).toBe(false);
    expect(await heldBy([thread({})], [{ threadId: 'W1', status: 'partly_addressed', reason: 'Smaller.', grade: 'note' }])).toBe(false);
    expect(await heldBy([thread({ thread: 'resolved' })])).toBe(false);
    expect(await heldBy([thread({ thread: 'resolved', security: true })])).toBe('warnings');
    expect(await heldBy([thread({ thread: 'fixed', security: true })])).toBe(false);
    // Grades are read as a pull request round reads them: a security warning is never graded below its thread, and a blocker grade blocks instead.
    expect(await heldBy([thread({ security: true })], [{ threadId: 'W1', status: 'partly_addressed', reason: 'Smaller.', grade: 'note' }])).toBe('warnings');
    expect(await heldBy([thread({})], [{ threadId: 'W1', status: 'partly_addressed', reason: 'Worse.', grade: 'blocker' }])).toBe(false);
    // A warning the earlier round listed only in its review body has no thread, so it holds only if this round finds it again.
    expect(await heldBy([thread({ thread: undefined })])).toBe(false);
    // A pre-existing defect never holds, as its thread does not in a pull request round.
    expect(await heldBy([thread({ preExisting: true })])).toBe(false);
  }, 30_000);

  it('reviews a patch on a workspace holding the tracked files of the head with the patch applied, with the given config, title and body', async () => {
    let workspaceSeen: { content: string; env: boolean; linkIsFile: boolean } | undefined;
    jest.mocked(runReview).mockImplementation(async (_clients, options) => {
      const workspace = options.workspace!;
      workspaceSeen = { content: readFileSync(join(workspace, 'src/a.ts'), 'utf-8'), env: existsSync(join(workspace, '.env')), linkIsFile: lstatSync(join(workspace, 'link')).isFile() };
      return { verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] };
    });
    git(repo, 'checkout', '-q', '-b', 'with-link', 'feature');
    symlinkSync('/etc/hosts', join(repo, 'link'));
    commit(repo, 'Add a link', {});
    git(repo, 'checkout', '-q', 'main');
    const patch = git(repo, 'diff', 'main', 'with-link');
    writeFileSync(join(repo, '.env'), 'SECRET=1\n');

    const review = await reviewLocal({
      repoRoot: repo, base: 'main', head: 'HEAD', patch, config: { ...jest.requireActual('./config').DEFAULT_CONFIG, exclude_paths: [] },
      title: 'My change', body: 'Why it changes', providerInputs: inputs,
    });

    const options = jest.mocked(runReview).mock.calls[0][1];
    expect(workspaceSeen).toEqual({ content: 'const a = 1;\nconst b = 4;\n', env: false, linkIsFile: true });
    expect(options.workspace).not.toBe(repo);
    expect(existsSync(options.workspace!)).toBe(false);
    expect(options.rawDiff).toContain('docs/x.md');
    expect(options.prContext).toEqual({ title: 'My change', body: 'Why it changes', baseBranch: 'main' });
    expect(review.base).toBe(review.head);
  });

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
  });

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
  });

  it('refuses a patch that does not apply to the head', async () => {
    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'HEAD', patch: git(repo, 'diff', 'feature~1', 'feature'), providerInputs: inputs }))
      .rejects.toThrow('The patch does not apply to');
    expect(runReview).not.toHaveBeenCalled();
  });

  it('reviews with the defaults when the base config does not load, and with the base config and no approval when the change breaks it, as a pull request round does', async () => {
    jest.mocked(runReview).mockResolvedValue({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    git(repo, 'checkout', '-q', '-b', 'broken', base);
    commit(repo, 'Break config', { '.manki.yml': 'exclude_paths: [\n' });
    git(repo, 'checkout', '-q', '-b', 'fix');
    commit(repo, 'Fix config', { '.manki.yml': 'exclude_paths: []\n', 'src/a.ts': 'const a = 2;\n' });

    const review = await reviewLocal({ repoRoot: repo, base: 'broken', head: 'fix', providerInputs: inputs });

    expect(review.approvalHeld).toBe('config');
    // A round that requests changes has no approval to hold, as in a pull request round.
    jest.mocked(runReview).mockResolvedValueOnce({ verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: 'One blocker', findings: [{ ...finding }], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    expect((await reviewLocal({ repoRoot: repo, base: 'broken', head: 'fix', providerInputs: inputs })).approvalHeld).toBe(false);

    expect(jest.mocked(runReview).mock.calls[0][1].config.exclude_paths).toEqual(jest.requireActual('./config').DEFAULT_CONFIG.exclude_paths);
    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(expect.stringContaining('Could not load .manki.yml on the base branch, using the defaults'));
    // The defaults that stand in for the broken base config are not what the change edits.
    expect(jest.mocked(core.info)).not.toHaveBeenCalledWith(expect.stringContaining('This change edits'));
    await expect(reviewLocal({ repoRoot: repo, base: 'broken', head: 'fix', configOverrides: { review_passes: 2 }, providerInputs: inputs }))
      .rejects.toThrow('Invalid YAML in .manki.yml');

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

  });

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
  });

  it('sets config overrides on top of the base config, and refuses overrides that make it invalid or name an unknown key before any model call', async () => {
    jest.mocked(runReview).mockResolvedValue({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });

    await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { models: { reviewer: 'claude-opus-5-5' } }, providerInputs: inputs });
    await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { exclude_paths: ['vendor/**'] }, providerInputs: inputs });

    const [kept, replaced] = jest.mocked(runReview).mock.calls.map(call => call[1]);
    expect(kept.config.models?.reviewer).toBe('claude-opus-5-5');
    expect(kept.config.exclude_paths).toContain('docs/**');
    expect(replaced.config.exclude_paths).toContain('vendor/**');
    expect(replaced.config.exclude_paths).not.toContain('docs/**');
    expect(replaced.rawDiff).toContain('docs/x.md');
    expect(jest.mocked(core.info)).not.toHaveBeenCalledWith(expect.stringContaining('This change edits'));
    jest.mocked(runReview).mockClear();
    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { review_passes: 9 }, providerInputs: inputs }))
      .rejects.toThrow('Invalid config in .manki.yml with the overrides');
    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { model: { reviewer: 'claude-opus-5-5' } }, providerInputs: inputs }))
      .rejects.toThrow('The config overrides name keys the config does not know: Unknown config key: "model"');
    expect(runReview).not.toHaveBeenCalled();
  });

  it('refuses a change with no reviewable files before any model call', async () => {
    git(repo, 'checkout', '-q', '-b', 'docs-only', base);
    commit(repo, 'Docs', { 'docs/y.md': 'more\n' });

    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'docs-only', providerInputs: inputs })).rejects.toThrow('no reviewable files');
    expect(runReview).not.toHaveBeenCalled();
  });
});

describe('overlayConfig', () => {
  it('merges mappings key by key and replaces every other value', () => {
    expect(overlayConfig(
      { models: { reviewer: 'a', judge: 'b' }, exclude_paths: ['x'], review: { routing: { wallet: 'pair' } } },
      { models: { reviewer: 'c' }, exclude_paths: ['y'], review: { routing: { consensus: 'pair' } }, auto_review: false },
    )).toEqual({ models: { reviewer: 'c', judge: 'b' }, exclude_paths: ['y'], review: { routing: { wallet: 'pair', consensus: 'pair' } }, auto_review: false });
  });
});
