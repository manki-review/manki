import * as core from '@actions/core';
import { spawnSync } from 'child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { devNull, tmpdir } from 'os';
import { join } from 'path';

import { fetchedRelatedRepos, fetchReferenceRepos, relatedRepoLoader, RelatedRepoLoaderOptions, relatedRepoOutcomes, relatedReposCacheDir } from './related-repos';
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

  /** A git that succeeds, except that `failing[repo][command]` fails that command with its stderr. `init` makes `.git/objects`, as git does. */
  function fakeGit(failing: Record<string, Record<string, string>> = {}): jest.MockedFunction<Run> {
    return jest.fn(async (binary, args, cwd, options) => {
      expect(binary).toBe('git');
      expect(options?.env).toEqual(ENV);
      calls.push({ cwd, args });
      const command = args.find(arg => /^[a-z][a-z-]*$/.test(arg))!;
      const stderr = Object.entries(failing).find(([repo]) => cwd.endsWith(join(...repo.split('/'))))?.[1][command];
      if (stderr) return { code: 128, stdout: '', stderr: `${stderr}\nnotice: No default references\n` };
      if (command === 'init') mkdirSync(join(cwd, '.git', 'objects'), { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
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
      ['sparse-checkout', 'set', '--no-cone', '/src/consensus', '/doc/*.md'],
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', 'v23.0.0'],
      ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD'],
      ['repack', '-a', '-d', '-q'],
    ]);
    expect(calls.filter(c => c.cwd === dipsDir).map(c => c.args)).toEqual([
      ['init', '-q'],
      ['remote', 'add', 'origin', 'https://github.com/dashpay/dips.git'],
      ['sparse-checkout', 'disable'],
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', 'HEAD'],
      ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD'],
      ['repack', '-a', '-d', '-q'],
    ]);
    expect(run).toHaveBeenCalledTimes(12);
    expect(existsSync(join(cacheDir, 'dashpay', 'platform'))).toBe(false);
    expect(log).toHaveBeenCalledWith('Fetched related repo dashpay/dash at v23.0.0');

    // A second tool server of the round finds the repo fetched and runs no git.
    const otherRun = fakeGit();
    expect(await loader([DASH], { run: otherRun })('dashpay/dash')).toBe(dashDir);
    expect(otherRun).not.toHaveBeenCalled();

    await expect(load('dashpay/other')).rejects.toThrow('dashpay/other is not a related repo');
  });

  it('waits for another tool server that is fetching the repo, takes its outcome, and records a failure when it stops or hangs', async () => {
    const lock = (name: string, pid = process.pid) => writeFileSync(join(stateDir, `${name}.lock`), String(pid));
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

    lock('dashpay%2Fplatform', spawnSync('true').pid);
    await expect(loader([PLATFORM], { run })('dashpay/platform')).rejects.toThrow('the reviewer fetching dashpay/platform stopped before it finished');
    const hung: RelatedRepo = { repo: 'dashpay/hung', kind: 'reference' };
    lock('dashpay%2Fhung');
    await expect(loader([hung], { run, timeoutMs: 100 })('dashpay/hung')).rejects.toThrow("another reviewer's fetch of dashpay/hung did not finish in time");
    expect(run).not.toHaveBeenCalled();

    // A lock that never got an outcome warns too, and a repo no call named is unused.
    lock('dashpay%2Fsilent');
    const silent: RelatedRepo = { repo: 'dashpay/silent', kind: 'reference' };
    const unused: RelatedRepo = { repo: 'dashpay/unused', kind: 'consumer', ref: 'main' };
    const outcomes = relatedRepoOutcomes([DIPS, DASH, hung, PLATFORM, silent, unused], stateDir);
    expect(outcomes).toEqual([
      { repo: 'dashpay/dips', status: 'fetched', durationMs: expect.any(Number) },
      { repo: 'dashpay/dash', ref: 'v23.0.0', status: 'failed', reason: 'fatal: repository not found', durationMs: expect.any(Number) },
      { repo: 'dashpay/hung', status: 'failed', reason: "another reviewer's fetch of dashpay/hung did not finish in time", durationMs: expect.any(Number) },
      { repo: 'dashpay/platform', status: 'failed', reason: 'the reviewer fetching dashpay/platform stopped before it finished', durationMs: expect.any(Number) },
      { repo: 'dashpay/silent', status: 'failed', reason: 'the fetch never finished' },
      { repo: 'dashpay/unused', ref: 'main', status: 'unused' },
    ]);
    expect(outcomes.every(o => o.durationMs === undefined || o.durationMs >= 0)).toBe(true);
    expect(jest.mocked(core.warning).mock.calls.map(([message]) => message)).toEqual([
      'Could not fetch related repo dashpay/dash, which must be public on github.com: fatal: repository not found',
      "Could not fetch related repo dashpay/hung, which must be public on github.com: another reviewer's fetch of dashpay/hung did not finish in time",
      'Could not fetch related repo dashpay/platform, which must be public on github.com: the reviewer fetching dashpay/platform stopped before it finished',
      'Could not fetch related repo dashpay/silent, which must be public on github.com: the fetch never finished',
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
      ['sparse-checkout', 'set', '--no-cone', '/src/consensus', '/doc/*.md'],
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', 'v23.0.0'],
      ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD'],
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

    expect(calls.map(c => c.args[0] === '-c' ? 'fsck' : c.args[0])).toEqual(['init', 'remote', 'fsck', 'init', 'remote', 'sparse-checkout', 'fetch', 'checkout', 'repack']);
    expect(existsSync(join(dashDir, '.git', 'objects', 'pack'))).toBe(false);
    expect(log).toHaveBeenCalledWith(`Discarding the cached objects of ${dashDir}: error: index CRC mismatch for object 0931`);
  });

  it('reuses nothing through a symlink that the cache restored, in the path or in the object store', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'manki-related-repos-outside-'));
    try {
      restoreClone(join(outside, 'dash'));
      symlinkSync(outside, join(cacheDir, 'dashpay'));

      await loader([DASH])('dashpay/dash');

      expect(calls.map(c => c.args[0])).toEqual(['init', 'remote', 'sparse-checkout', 'fetch', 'checkout', 'repack']);
      expect(lstatSync(join(cacheDir, 'dashpay')).isSymbolicLink()).toBe(false);
      expect(existsSync(join(outside, 'dash', 'stale.txt'))).toBe(true);

      const dipsDir = join(cacheDir, 'dashpay', 'dips');
      restoreClone(dipsDir);
      rmSync(join(dipsDir, '.git', 'objects', 'pack'), { recursive: true });
      symlinkSync(join(outside, 'dash', '.git', 'objects', 'pack'), join(dipsDir, '.git', 'objects', 'pack'));
      calls = [];

      await loader([DIPS])('dashpay/dips');

      expect(calls.map(c => c.args[0])).toEqual(['init', 'remote', 'sparse-checkout', 'fetch', 'checkout', 'repack']);
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
    expect(readdirSync(stateDir).sort()).toEqual(['dashpay%2Fdash.done', 'dashpay%2Fdash.lock', 'dashpay%2Fdips.failed', 'dashpay%2Fdips.lock']);
    expect(fetchedRelatedRepos(stateDir)).toEqual(new Map([['dashpay/dash', join(cacheDir, 'dashpay', 'dash')]]));

    expect(relatedRepoOutcomes([DASH, DIPS], stateDir).map(o => o.status)).toEqual(['fetched', 'failed']);
    expect(core.warning).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith(
      "Could not fetch related repo dashpay/dips, which must be public on github.com: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );

    // Fetching the references up front takes each outcome of the round, leaves out the failed one and never fetches a consumer.
    const before = calls.length;
    expect(await fetchReferenceRepos({ repos: [DASH, DIPS, PLATFORM], cacheDir, stateDir }, { run, log })).toEqual([{ repo: 'dashpay/dash', dir: join(cacheDir, 'dashpay', 'dash') }]);
    expect(calls).toHaveLength(before);
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
});
