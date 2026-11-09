import { execFileSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import * as core from '@actions/core';

import { overlayConfig, reviewLocal } from './local-review';
import { runReview } from './review';
import type { Finding, ReviewResult, RoundOutcome } from './types';

jest.mock('@actions/core');
jest.mock('./providers', () => ({
  ...jest.requireActual('./providers'),
  createLLMClient: jest.fn(() => ({ repoTools: true, sendMessage: jest.fn() })),
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
      'src/a.ts': 'const a = 1;\nconst b = 2;\n',
    });
    git(repo, 'checkout', '-q', '-b', 'feature');
    head = commit(repo, 'Change a', { 'src/a.ts': 'const a = 1;\nconst b = 3;\n', 'docs/x.md': 'notes\n' });
    later = commit(repo, 'Fix a later', { 'src/a.ts': 'const a = 1;\nconst b = 4;\n' });
    git(repo, 'checkout', '-q', 'main');
    commit(repo, 'Base moves on', { 'README.md': 'readme\n' });
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
      return { verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST' as RoundOutcome, summary: 'One blocker', findings: [{ ...finding }], highlights: [], reviewComplete: true, agentNames: ['reviewer'] } as ReviewResult & { outcome: RoundOutcome };
    });

    const review = await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', providerInputs: inputs });

    const options = jest.mocked(runReview).mock.calls[0][1];
    expect(options.rawDiff).toContain('+const b = 3;');
    expect(options.rawDiff).not.toContain('docs/x.md');
    expect(options.excludedPaths).toEqual(['docs/x.md']);
    expect(options.config.exclude_paths).toContain('docs/**');
    expect(options.repoContext).toContain('Use tabs.');
    expect(options.prContext).toEqual({ title: 'Change a', body: '', baseBranch: 'main' });
    expect(options.headSha).toBe(head);
    expect(workspaceSeen?.content).toBe('const a = 1;\nconst b = 3;\n');
    expect(workspaceSeen?.log).not.toContain(later);
    expect(existsSync(options.workspace!)).toBe(false);
    expect(review.base).toBe(base);
    expect(review.head).toBe(head);
    expect(review.approvalHeld).toBe(false);
    expect(review.result.findings[0].codeContext).toContain('const b = 3;');
    expect(review.context.meta).toMatchObject({ prNumber: 0, commitSha: head, trigger: { event: 'local', sender: 'local' }, outcome: 'ADDRESS_FIRST' });
  });

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

  it('refuses a patch that does not apply to the head', async () => {
    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'HEAD', patch: git(repo, 'diff', 'feature~1', 'feature'), providerInputs: inputs }))
      .rejects.toThrow('The patch does not apply to');
    expect(runReview).not.toHaveBeenCalled();
  });

  it('reviews with the defaults when the base config does not load, as a pull request round does', async () => {
    jest.mocked(runReview).mockResolvedValue({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });
    git(repo, 'checkout', '-q', '-b', 'broken', base);
    commit(repo, 'Break config', { '.manki.yml': 'exclude_paths: [\n' });
    git(repo, 'checkout', '-q', '-b', 'fix');
    commit(repo, 'Fix config', { '.manki.yml': 'exclude_paths: []\n', 'src/a.ts': 'const a = 2;\n' });

    const review = await reviewLocal({ repoRoot: repo, base: 'broken', head: 'fix', providerInputs: inputs });

    expect(review.approvalHeld).toBe('config');

    expect(jest.mocked(runReview).mock.calls[0][1].config.exclude_paths).toEqual(jest.requireActual('./config').DEFAULT_CONFIG.exclude_paths);
    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(expect.stringContaining('Could not load .manki.yml on the base branch, reviewing with the defaults'));
    await expect(reviewLocal({ repoRoot: repo, base: 'broken', head: 'fix', configOverrides: { review_passes: 2 }, providerInputs: inputs }))
      .rejects.toThrow('Invalid YAML in .manki.yml');
  });

  it('sets config overrides on top of the base config, and refuses overrides that make it invalid before any model call', async () => {
    jest.mocked(runReview).mockResolvedValue({ verdict: 'APPROVE', outcome: 'READY', summary: 'Fine', findings: [], highlights: [], reviewComplete: true, agentNames: ['reviewer'] });

    await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { models: { reviewer: 'claude-opus-5-5' } }, providerInputs: inputs });
    await reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { exclude_paths: ['vendor/**'] }, providerInputs: inputs });

    const [kept, replaced] = jest.mocked(runReview).mock.calls.map(call => call[1]);
    expect(kept.config.models?.reviewer).toBe('claude-opus-5-5');
    expect(kept.config.exclude_paths).toContain('docs/**');
    expect(replaced.config.exclude_paths).toContain('vendor/**');
    expect(replaced.config.exclude_paths).not.toContain('docs/**');
    expect(replaced.rawDiff).toContain('docs/x.md');
    jest.mocked(runReview).mockClear();
    await expect(reviewLocal({ repoRoot: repo, base: 'main', head: 'feature~1', configOverrides: { review_passes: 9 }, providerInputs: inputs }))
      .rejects.toThrow('Invalid config in .manki.yml with the overrides');
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
