import * as core from '@actions/core';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { devNull, tmpdir } from 'os';
import { join } from 'path';

import { fetchedRelatedRepos, fetchRelatedRepos, relatedRepoGuides, relatedRepoLoader, RelatedRepoLoaderOptions, relatedRepoOutcomes, relatedReposCacheDir, relatedRepoTools, repoTools, requireRelatedRepos } from './related-repos';
import { RelatedRepo } from './types';
import { gitEnv } from './workspace';

jest.mock('@actions/core', () => ({
  warning: jest.fn(),
}));

const ENV = gitEnv({ 'credential.helper': '', 'core.hooksPath': devNull, 'core.fsmonitor': 'false' });

const DASH: RelatedRepo = { repo: 'dashpay/dash', kind: 'reference', ref: 'v23.0.0', paths: ['src/consensus', './doc/*.md'] };
const DIPS: RelatedRepo = { repo: 'dashpay/dips', kind: 'reference' };
const PLATFORM: RelatedRepo = { repo: 'dashpay/platform', kind: 'consumer', paths: ['packages/rs-*'] };

type Run = NonNullable<RelatedRepoLoaderOptions['run']>;

describe('relatedRepoLoader', () => {
  let tempDir: string;
  let cacheDir: string;
  let stateDir: string;
  let calls: Array<{ cwd: string; args: string[] }>;
  let log: jest.Mock<void, [string]>;

  /**
   * A git that succeeds, except that `failing[repo][command]` fails that command with its stderr. `init` makes
   * `.git/objects`, as git does, and `output` gives what a command prints.
   */
  function fakeGit(failing: Record<string, Record<string, string>> = {}, output: (args: string[]) => string = () => ''): jest.MockedFunction<Run> {
    return jest.fn(async (binary, args, cwd, options) => {
      expect(binary).toBe('git');
      expect(options?.env).toEqual(ENV);
      calls.push({ cwd, args });
      const command = args.find(arg => /^[a-z][a-z-]*$/.test(arg))!;
      const stderr = Object.entries(failing).find(([repo]) => cwd.endsWith(join(...repo.split('/'))))?.[1][command];
      if (stderr) return { code: 128, stdout: '', stderr: `${stderr}\nnotice: No default references\n` };
      if (command === 'init') mkdirSync(join(cwd, '.git', 'objects'), { recursive: true });
      return { code: 0, stdout: output(args), stderr: '' };
    });
  }

  const loader = (repos: RelatedRepo[], options: RelatedRepoLoaderOptions = {}) =>
    relatedRepoLoader({ repos, cacheDir, stateDir }, { run: fakeGit(), log, ...options });

  beforeEach(() => {
    jest.clearAllMocks();
    tempDir = mkdtempSync(join(tmpdir(), 'manki-related-repos-test-'));
    cacheDir = join(tempDir, 'cache');
    stateDir = join(tempDir, 'state');
    mkdirSync(cacheDir);
    mkdirSync(stateDir);
    calls = [];
    log = jest.fn();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('fetches a repo only when asked for it, shallow and path-limited, once per round', async () => {
    const run = fakeGit();
    const load = loader([DASH, DIPS, PLATFORM], { run });
    expect(run).not.toHaveBeenCalled();

    const dashDir = join(cacheDir, 'dashpay', 'dash');
    const dipsDir = join(cacheDir, 'dashpay', 'dips');
    expect(await Promise.all([load('dashpay/dash'), load('dashpay/dips'), load('dashpay/dash')])).toEqual([dashDir, dipsDir, dashDir]);
    expect(calls.filter(c => c.cwd === dashDir).map(c => c.args)).toEqual([
      ['init', '-q'],
      ['remote', 'add', 'origin', 'https://github.com/dashpay/dash.git'],
      ['sparse-checkout', 'set', '--no-cone', '/AGENTS.md', '/CLAUDE.md', '/src/consensus', '/doc/*.md'],
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', 'v23.0.0'],
      ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD'],
      ['rev-parse', 'HEAD'],
      ['repack', '-a', '-d', '-q'],
    ]);
    expect(calls.filter(c => c.cwd === dipsDir).map(c => c.args)).toEqual([
      ['init', '-q'],
      ['remote', 'add', 'origin', 'https://github.com/dashpay/dips.git'],
      ['sparse-checkout', 'disable'],
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', 'HEAD'],
      ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD'],
      ['rev-parse', 'HEAD'],
      ['repack', '-a', '-d', '-q'],
    ]);
    expect(run).toHaveBeenCalledTimes(14);
    expect(existsSync(join(cacheDir, 'dashpay', 'platform'))).toBe(false);
    expect(log).toHaveBeenCalledWith('Fetched related repo dashpay/dash at v23.0.0');

    // A second tool server of the round finds the repo fetched and runs no git.
    const otherRun = fakeGit();
    expect(await loader([DASH], { run: otherRun })('dashpay/dash')).toBe(dashDir);
    expect(otherRun).not.toHaveBeenCalled();

    await expect(load('dashpay/other')).rejects.toThrow('dashpay/other is not a related repo');
  });

  it('checks out the newest first-parent commit made by the as-of time, fetching older history in growing chunks', async () => {
    const [tip, cut, older, oldest, found, root] = ['a', 'b', 'c', 'd', 'e', 'f'].map(c => c.repeat(40));
    const asOf = '2026-10-03T11:20:50+10:00';
    const before = `--before=${Date.parse(asOf) / 1000}`;
    // Each fetched history, by the commit it is walked from, and the parents each commit object names.
    const fetched: Record<string, string[]> = { FETCH_HEAD: [tip], [cut]: [cut, older], [oldest]: [oldest, root] };
    const parents: Record<string, string[]> = { [tip]: [cut, oldest], [older]: [oldest], [root]: [] };
    const history = (oldEnough: string) => (args: string[]): string => {
      const from = args.at(-1)!;
      if (args[0] === 'rev-list') return args[1] === '-1' ? (from === oldEnough ? `${found}\n` : '') : `${fetched[from].join('\n')}\n`;
      if (args[0] === 'rev-parse') return `${found}\n`;
      if (args[0] === 'cat-file') return `tree ${'0'.repeat(40)}\n${parents[from].map(p => `parent ${p}\n`).join('')}author A <a@b> 1 +0000\n\nMessage\nparent ${'9'.repeat(40)}\n`;
      return '';
    };
    const dipsDir = join(cacheDir, 'dashpay', 'dips');
    const load = (output: (args: string[]) => string, at = asOf) => {
      rmSync(stateDir, { recursive: true });
      mkdirSync(stateDir);
      calls = [];
      return relatedRepoLoader({ repos: [DIPS], cacheDir, stateDir, asOf: at }, { run: fakeGit({}, output), log })('dashpay/dips');
    };
    const fetch = (depth: string, commit: string) => ['fetch', '-q', '--depth', depth, '--filter=blob:none', '--no-tags', 'origin', commit];
    const fromFetch = () => calls.map(c => c.args).slice(calls.findIndex(c => c.args[0] === 'fetch'));
    const walk = (from: string) => [['rev-list', '-1', '--first-parent', before, from], ['rev-list', '--first-parent', from]];

    expect(await load(history(oldest))).toBe(dipsDir);
    expect(fromFetch()).toEqual([
      fetch('1', 'HEAD'), ...walk('FETCH_HEAD'), ['cat-file', 'commit', tip],
      fetch('64', cut), ...walk(cut), ['cat-file', 'commit', older],
      fetch('128', oldest), walk(oldest)[0],
      ['checkout', '-q', '--force', '--detach', found],
      ['rev-parse', 'HEAD'],
      ['repack', '-a', '-d', '-q'],
    ]);
    expect(log).toHaveBeenCalledWith(`Fetched related repo dashpay/dips as of ${asOf}, commit ${found}`);
    expect(relatedRepoOutcomes([DIPS], stateDir, {}, asOf)).toEqual([{ repo: DIPS.repo, asOf, status: 'fetched', commit: found, durationMs: expect.any(Number) }]);

    // A newest commit that is old enough is checked out without another fetch.
    expect(await load(history('FETCH_HEAD'))).toBe(dipsDir);
    expect(fromFetch()).toEqual([fetch('1', 'HEAD'), walk('FETCH_HEAD')[0], ['checkout', '-q', '--force', '--detach', found], ['rev-parse', 'HEAD'], ['repack', '-a', '-d', '-q']]);

    // A history without a commit that old fails the repo, and so does a time that is no date.
    await expect(load(history('none'))).rejects.toThrow(`it has no commit as old as ${asOf}`);
    expect(calls.map(c => c.args).slice(-2)).toEqual([walk(oldest)[1], ['cat-file', 'commit', root]]);
    await expect(load(history('none'), 'last week')).rejects.toThrow('`last week` is not a date');
    expect(existsSync(dipsDir)).toBe(false);
    expect(relatedRepoOutcomes([DIPS], stateDir, {}, 'last week')).toEqual([expect.objectContaining({ asOf: 'last week', status: 'failed', reason: '`last week` is not a date' })]);
  });

  it('waits for another tool server that is fetching the repo, takes its outcome, fetches in its place when it stopped, and records a failure when it hangs', async () => {
    const lock = (name: string, pid = process.pid) => writeFileSync(join(stateDir, `${name}.lock`), String(pid));
    const gone = spawnSync('true').pid;
    lock('dashpay%2Fdips');
    lock('dashpay%2Fdash');
    const run = fakeGit();
    const load = loader([DASH, DIPS], { run, timeoutMs: 5000 });

    const dips = load('dashpay/dips');
    const dash = load('dashpay/dash');
    writeFileSync(join(stateDir, 'dashpay%2Fdips.done'), '/fetched/dips');
    writeFileSync(join(stateDir, 'dashpay%2Fdash.failed'), 'fatal: repository not found');

    await expect(dips).resolves.toBe('/fetched/dips');
    await expect(dash).rejects.toThrow('fatal: repository not found');
    expect(run).not.toHaveBeenCalled();

    const hung: RelatedRepo = { repo: 'dashpay/hung', kind: 'reference' };
    lock('dashpay%2Fhung');
    await expect(loader([hung], { run, timeoutMs: 100 })('dashpay/hung')).rejects.toThrow("another reviewer's fetch of dashpay/hung did not finish in time");
    expect(run).not.toHaveBeenCalled();

    // A holder that stopped mid-fetch left a lock and no outcome. Of the two tool servers that ask next, one fetches and the other waits for it.
    lock('dashpay%2Fplatform', gone);
    const platformDir = join(cacheDir, 'dashpay', 'platform');
    const [first, second] = [fakeGit(), fakeGit()];
    expect(await Promise.all([loader([PLATFORM], { run: first })('dashpay/platform'), loader([PLATFORM], { run: second })('dashpay/platform')])).toEqual([platformDir, platformDir]);
    expect([first.mock.calls.length, second.mock.calls.length].sort()).toEqual([0, 7]);
    expect(readdirSync(stateDir).filter(f => f.startsWith('dashpay%2Fplatform')).sort()).toEqual(['dashpay%2Fplatform.commit', 'dashpay%2Fplatform.done', 'dashpay%2Fplatform.lock', 'dashpay%2Fplatform.lock.1']);
    expect(readFileSync(join(stateDir, 'dashpay%2Fplatform.lock'), 'utf-8')).toBe(String(gone));
    // A reader after that takes the outcome and fetches nothing.
    expect(await loader([PLATFORM], { run })('dashpay/platform')).toBe(platformDir);
    expect(run).not.toHaveBeenCalled();

    // The one that fetches in its place can stop too, and the next asker fetches. A fetch that really fails still ends as failed.
    const twice: RelatedRepo = { repo: 'dashpay/twice', kind: 'reference' };
    lock('dashpay%2Ftwice', gone);
    writeFileSync(join(stateDir, 'dashpay%2Ftwice.lock.1'), String(gone));
    expect(await loader([twice])('dashpay/twice')).toBe(join(cacheDir, 'dashpay', 'twice'));
    expect(existsSync(join(stateDir, 'dashpay%2Ftwice.lock.2'))).toBe(true);
    const broken: RelatedRepo = { repo: 'dashpay/broken', kind: 'reference' };
    lock('dashpay%2Fbroken', gone);
    await expect(loader([broken], { run: fakeGit({ 'dashpay/broken': { fetch: 'fatal: repository not found' } }) })('dashpay/broken')).rejects.toThrow('fatal: repository not found');
    await expect(loader([broken], { run })('dashpay/broken')).rejects.toThrow('fatal: repository not found');
    expect(run).not.toHaveBeenCalled();

    // A lock with no outcome and no later asker says the stage did not finish, never that the repo cannot be fetched. A repo no call named is unused.
    lock('dashpay%2Fsilent');
    lock('dashpay%2Fcut', gone);
    const silent: RelatedRepo = { repo: 'dashpay/silent', kind: 'reference' };
    const cut: RelatedRepo = { repo: 'dashpay/cut', kind: 'reference' };
    const unused: RelatedRepo = { repo: 'dashpay/unused', kind: 'consumer', ref: 'main' };
    const outcomes = relatedRepoOutcomes([DIPS, DASH, hung, PLATFORM, broken, silent, cut, unused], stateDir);
    expect(outcomes).toEqual([
      { repo: 'dashpay/dips', status: 'fetched', durationMs: expect.any(Number) },
      { repo: 'dashpay/dash', ref: 'v23.0.0', status: 'failed', reason: 'fatal: repository not found', durationMs: expect.any(Number) },
      { repo: 'dashpay/hung', status: 'failed', reason: "another reviewer's fetch of dashpay/hung did not finish in time", durationMs: expect.any(Number) },
      { repo: 'dashpay/platform', status: 'fetched', durationMs: expect.any(Number) },
      { repo: 'dashpay/broken', status: 'failed', reason: 'fatal: repository not found', durationMs: expect.any(Number) },
      { repo: 'dashpay/silent', status: 'failed', reason: 'the fetch was still running when the round ended' },
      { repo: 'dashpay/cut', status: 'failed', reason: 'the stage fetching it was stopped before the fetch finished, and no later stage asked for it' },
      { repo: 'dashpay/unused', ref: 'main', status: 'unused' },
    ]);
    expect(outcomes.every(o => o.durationMs === undefined || o.durationMs >= 0)).toBe(true);
    expect(jest.mocked(core.warning).mock.calls.map(([message]) => message)).toEqual([
      'Could not fetch related repo dashpay/dash, which must be public on github.com: fatal: repository not found',
      "Could not fetch related repo dashpay/hung, which must be public on github.com: another reviewer's fetch of dashpay/hung did not finish in time",
      'Could not fetch related repo dashpay/broken, which must be public on github.com: fatal: repository not found',
      'Related repo dashpay/silent was not fetched: the fetch was still running when the round ended',
      'Related repo dashpay/cut was not fetched: the stage fetching it was stopped before the fetch finished, and no later stage asked for it',
    ]);
  });

  /** Writes a clone as `actions/cache` restores it, with objects and a `.git/config` and `objects/info` that point elsewhere. */
  function restoreClone(dir: string): void {
    mkdirSync(join(dir, '.git', 'objects', 'pack'), { recursive: true });
    mkdirSync(join(dir, '.git', 'objects', 'info'));
    writeFileSync(join(dir, '.git', 'objects', 'pack', 'pack-1.pack'), 'objects');
    writeFileSync(join(dir, '.git', 'objects', 'info', 'alternates'), '/elsewhere/objects');
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\tworktree = /elsewhere\n');
    writeFileSync(join(dir, 'stale.txt'), 'x');
  }
  const FSCK = ['-c', 'remote.origin.promisor=true', '-c', 'remote.origin.partialclonefilter=blob:none', 'fsck', '--no-dangling', '--no-progress'];

  it('keeps only the checked objects of a clone restored from the cache, in a new repository', async () => {
    const dashDir = join(cacheDir, 'dashpay', 'dash');
    restoreClone(dashDir);

    await loader([DASH])('dashpay/dash');

    expect(calls.map(c => c.args)).toEqual([
      ['init', '-q'],
      ['remote', 'add', 'origin', 'https://github.com/dashpay/dash.git'],
      FSCK,
      ['sparse-checkout', 'set', '--no-cone', '/AGENTS.md', '/CLAUDE.md', '/src/consensus', '/doc/*.md'],
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', 'v23.0.0'],
      ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD'],
      ['rev-parse', 'HEAD'],
      ['repack', '-a', '-d', '-q'],
    ]);
    expect(readFileSync(join(dashDir, '.git', 'objects', 'pack', 'pack-1.pack'), 'utf-8')).toBe('objects');
    expect(existsSync(join(dashDir, '.git', 'objects', 'info'))).toBe(false);
    expect(existsSync(join(dashDir, '.git', 'config'))).toBe(false);
    expect(existsSync(join(dashDir, 'stale.txt'))).toBe(false);
  });

  it('starts from an empty repository when the restored objects fail the check', async () => {
    const dashDir = join(cacheDir, 'dashpay', 'dash');
    restoreClone(dashDir);

    expect(await loader([DASH], { run: fakeGit({ 'dashpay/dash': { fsck: 'error: index CRC mismatch for object 0931' } }) })('dashpay/dash')).toBe(dashDir);

    expect(calls.map(c => c.args[0] === '-c' ? 'fsck' : c.args[0])).toEqual(['init', 'remote', 'fsck', 'init', 'remote', 'sparse-checkout', 'fetch', 'checkout', 'rev-parse', 'repack']);
    expect(existsSync(join(dashDir, '.git', 'objects', 'pack'))).toBe(false);
    expect(log).toHaveBeenCalledWith(`Discarding the cached objects of ${dashDir}: error: index CRC mismatch for object 0931`);
  });

  it('reuses nothing through a symlink that the cache restored, in the path or in the object store', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'manki-related-repos-outside-'));
    try {
      restoreClone(join(outside, 'dash'));
      symlinkSync(outside, join(cacheDir, 'dashpay'));

      await loader([DASH])('dashpay/dash');

      expect(calls.map(c => c.args[0])).toEqual(['init', 'remote', 'sparse-checkout', 'fetch', 'checkout', 'rev-parse', 'repack']);
      expect(lstatSync(join(cacheDir, 'dashpay')).isSymbolicLink()).toBe(false);
      expect(existsSync(join(outside, 'dash', 'stale.txt'))).toBe(true);

      const dipsDir = join(cacheDir, 'dashpay', 'dips');
      restoreClone(dipsDir);
      rmSync(join(dipsDir, '.git', 'objects', 'pack'), { recursive: true });
      symlinkSync(join(outside, 'dash', '.git', 'objects', 'pack'), join(dipsDir, '.git', 'objects', 'pack'));
      calls = [];

      await loader([DIPS])('dashpay/dips');

      expect(calls.map(c => c.args[0])).toEqual(['init', 'remote', 'sparse-checkout', 'fetch', 'checkout', 'rev-parse', 'repack']);
      expect(existsSync(join(dipsDir, '.git', 'objects', 'pack'))).toBe(false);
      expect(readFileSync(join(outside, 'dash', '.git', 'objects', 'pack', 'pack-1.pack'), 'utf-8')).toBe('objects');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a repo whose restored directory or symlink it cannot remove, without running git there', async () => {
    const dashDir = join(cacheDir, 'dashpay', 'dash');
    mkdirSync(join(dashDir, '.git'), { recursive: true });
    writeFileSync(join(dashDir, '.git', 'config'), '[core]\n\tworktree = /elsewhere\n');
    chmodSync(join(dashDir, '.git'), 0o555);
    const outside = mkdtempSync(join(tmpdir(), 'manki-related-repos-outside-'));
    try {
      const run = fakeGit();
      await expect(loader([DASH], { run })('dashpay/dash')).rejects.toThrow(`could not remove ${dashDir}`);

      symlinkSync(outside, join(cacheDir, 'linked'));
      chmodSync(cacheDir, 0o555);
      await expect(loader([{ repo: 'linked/dips', kind: 'reference' }], { run })('linked/dips')).rejects.toThrow(`could not remove ${join(cacheDir, 'linked')}`);

      expect(run).not.toHaveBeenCalled();
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      chmodSync(cacheDir, 0o755);
      chmodSync(join(dashDir, '.git'), 0o755);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('records a repo it cannot fetch and removes its directory, and keeps one whose repack fails', async () => {
    const run = fakeGit({
      'dashpay/dips': { fetch: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" },
      'dashpay/dash': { repack: 'fatal: out of memory' },
    });
    const load = loader([DASH, DIPS], { run });

    await expect(load('dashpay/dips')).rejects.toThrow("fatal: could not read Username for 'https://github.com': terminal prompts disabled");
    await expect(load('dashpay/dips')).rejects.toThrow('terminal prompts disabled');
    expect(await load('dashpay/dash')).toBe(join(cacheDir, 'dashpay', 'dash'));

    expect(existsSync(join(cacheDir, 'dashpay', 'dips'))).toBe(false);
    expect(calls.filter(c => c.cwd.endsWith('dips')).map(c => c.args[0])).toEqual(['init', 'remote', 'sparse-checkout', 'fetch']);
    expect(log).toHaveBeenCalledWith(`Could not repack ${join(cacheDir, 'dashpay', 'dash')}: fatal: out of memory`);
    expect(readdirSync(stateDir).sort()).toEqual(['dashpay%2Fdash.commit', 'dashpay%2Fdash.done', 'dashpay%2Fdash.lock', 'dashpay%2Fdips.failed', 'dashpay%2Fdips.lock']);
    expect(fetchedRelatedRepos(stateDir)).toEqual(new Map([['dashpay/dash', join(cacheDir, 'dashpay', 'dash')]]));

    expect(relatedRepoOutcomes([DASH, DIPS], stateDir).map(o => o.status)).toEqual(['fetched', 'failed']);
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      "Could not fetch related repo dashpay/dips, which must be public on github.com: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );

    // Fetching the related repos up front takes each outcome of the round, fetches the consumer no call named yet and leaves out the failed one.
    const before = calls.length;
    const dirOf = ({ repo }: RelatedRepo) => join(cacheDir, ...repo.split('/'));
    expect(await fetchRelatedRepos({ repos: [DASH, DIPS, PLATFORM], cacheDir, stateDir }, { run, log })).toEqual([DASH, PLATFORM].map(r => ({ repo: r.repo, kind: r.kind, dir: dirOf(r) })));
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.slice(before).every(c => c.cwd === dirOf(PLATFORM))).toBe(true);

    // Requiring every repo takes the same outcomes, and names each repo that could not be fetched with its reason.
    const fetched = calls.length;
    await expect(requireRelatedRepos({ repos: [DASH, PLATFORM], cacheDir, stateDir }, { run, log })).resolves.toBeUndefined();
    await expect(requireRelatedRepos({ repos: [DASH, DIPS], cacheDir, stateDir, asOf: '2026-10-03T00:00:00Z' }, { run, log })).rejects.toThrow(
      "Could not read every related repo as of 2026-10-03T00:00:00Z. dashpay/dips: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
    expect(calls).toHaveLength(fetched);

    // A repo's guide is its root `AGENTS.md`, else its root `CLAUDE.md`, and only a regular file. The round record names it.
    const [both, linked, none] = [DASH, DIPS, PLATFORM].map(({ repo, kind }) => ({ repo, kind, dir: mkdtempSync(join(tempDir, 'checkout-')) }));
    for (const name of ['AGENTS.md', 'CLAUDE.md']) writeFileSync(join(both.dir, name), '');
    symlinkSync(join(tempDir, 'outside.md'), join(linked.dir, 'AGENTS.md'));
    writeFileSync(join(linked.dir, 'CLAUDE.md'), '');
    mkdirSync(join(none.dir, 'AGENTS.md'));
    const guides = relatedRepoGuides([both, linked, none]);
    expect(guides).toEqual({ [DASH.repo]: 'AGENTS.md', [DIPS.repo]: 'CLAUDE.md' });
    expect(relatedRepoGuides([none])).toBeUndefined();
    expect(relatedRepoOutcomes([DASH], stateDir, guides)).toEqual([{ repo: DASH.repo, ref: DASH.ref, guide: 'AGENTS.md', status: 'fetched', durationMs: expect.any(Number) }]);
  });

  it('gives each repo one time limit across its git commands', async () => {
    const run = jest.fn<ReturnType<Run>, Parameters<Run>>(async (_binary, _args, _cwd, options) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(options?.timeoutMs).toBeLessThanOrEqual(10);
      return { code: -1, stdout: '', stderr: '' };
    });

    await expect(loader([DIPS], { run, timeoutMs: 10 })('dashpay/dips')).rejects.toThrow('git did not finish within 0.01s');

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses a repo name that leaves the cache directory, and fetches nothing for it', async () => {
    const run = fakeGit();

    await expect(loader([{ repo: '../..', kind: 'reference' }], { run })('../..')).rejects.toThrow('not an "owner/name" repo');

    expect(run).not.toHaveBeenCalled();
  });

  it('clones into the runner temp directory by default', () => {
    const runnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = '/runner/temp';
    try {
      expect(relatedReposCacheDir()).toBe(join('/runner/temp', 'manki-related-repos'));
    } finally {
      if (runnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = runnerTemp;
    }
  });

  it('gives each round a state directory of its own, and states the related repos on the tools of every call', () => {
    const first = relatedRepoTools([DASH, PLATFORM], '2026-01-05T00:00:00Z')!;
    const second = relatedRepoTools([DASH])!;
    try {
      expect(first).toEqual({ repos: [DASH, PLATFORM], cacheDir: relatedReposCacheDir(), stateDir: expect.any(String), asOf: '2026-01-05T00:00:00Z' });
      expect(lstatSync(first.stateDir).isDirectory()).toBe(true);
      expect(second.stateDir).not.toBe(first.stateDir);
      expect(second).not.toHaveProperty('asOf');
      expect(relatedRepoTools([])).toBeUndefined();
      expect(relatedRepoTools(undefined)).toBeUndefined();
      expect(repoTools('/work/head', 15, first)).toStrictEqual({ root: '/work/head', steps: 15, related: first });
      expect(repoTools('/work/head', 15, undefined)).toStrictEqual({ root: '/work/head', steps: 15, related: undefined });
      // A call that checks one finding or statement is marked, so its prompt gives it no rules for grading.
      expect(repoTools('/work/head', 15, first, 'check')).toStrictEqual({ root: '/work/head', steps: 15, related: first, checking: true });
      expect(repoTools('/work/head', 15, first, 'find')).toStrictEqual(repoTools('/work/head', 15, first));
    } finally {
      for (const { stateDir } of [first, second]) rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
