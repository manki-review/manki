import * as core from '@actions/core';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { relatedRepoLoader, relatedReposCacheDir } from './related-repos';
import { RelatedRepo } from './types';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
}));

const SAFETY = ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
const ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

const DASH: RelatedRepo = { repo: 'dashpay/dash', kind: 'reference', ref: 'v23.0.0', paths: ['src/consensus', './doc/*.md'] };
const DIPS: RelatedRepo = { repo: 'dashpay/dips', kind: 'reference' };
const PLATFORM: RelatedRepo = { repo: 'dashpay/platform', kind: 'consumer', paths: ['packages/rs-*'] };

type Run = NonNullable<Parameters<typeof relatedRepoLoader>[1]>['run'];

describe('relatedRepoLoader', () => {
  let cacheDir: string;
  let calls: Array<{ cwd: string; args: string[] }>;

  /** A git that succeeds, except that `failing[repo][command]` fails that command with its stderr. `init` makes `.git/objects`, as git does. */
  function fakeGit(failing: Record<string, Record<string, string>> = {}): jest.MockedFunction<NonNullable<Run>> {
    return jest.fn(async (binary, args, cwd, options) => {
      expect(binary).toBe('git');
      expect(options?.env).toEqual(ENV);
      expect(args.slice(0, SAFETY.length)).toEqual(SAFETY);
      const gitArgs = args.slice(SAFETY.length);
      calls.push({ cwd, args: gitArgs });
      const command = gitArgs.find(arg => /^[a-z][a-z-]*$/.test(arg))!;
      const stderr = Object.entries(failing).find(([repo]) => cwd.endsWith(join(...repo.split('/'))))?.[1][command];
      if (stderr) return { code: 128, stdout: '', stderr: `${stderr}\nnotice: No default references\n` };
      if (command === 'init') mkdirSync(join(cwd, '.git', 'objects'), { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    cacheDir = mkdtempSync(join(tmpdir(), 'manki-related-repos-test-'));
    calls = [];
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('fetches only the repos of the kind asked for, shallow and path-limited, once per loader', async () => {
    const run = fakeGit();
    const load = relatedRepoLoader([DASH, DIPS, PLATFORM], { cacheDir, run });
    expect(run).not.toHaveBeenCalled();

    const references = await load('reference');

    const dashDir = join(cacheDir, 'dashpay', 'dash');
    const dipsDir = join(cacheDir, 'dashpay', 'dips');
    expect(references).toEqual([{ ...DASH, dir: dashDir }, { ...DIPS, dir: dipsDir }]);
    expect(calls.filter(c => c.cwd === dashDir).map(c => c.args)).toEqual([
      ['init', '-q'],
      ['remote', 'add', 'origin', 'https://github.com/dashpay/dash.git'],
      ['sparse-checkout', 'set', '--no-cone', '/src/consensus', '/doc/*.md'],
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', 'v23.0.0'],
      ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD'],
    ]);
    expect(calls.filter(c => c.cwd === dipsDir).map(c => c.args)).toEqual([
      ['init', '-q'],
      ['remote', 'add', 'origin', 'https://github.com/dashpay/dips.git'],
      ['sparse-checkout', 'disable'],
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', 'HEAD'],
      ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD'],
    ]);
    expect(existsSync(dashDir)).toBe(true);

    expect(await load('reference')).toEqual(references);
    expect(run).toHaveBeenCalledTimes(10);

    expect(await load('consumer')).toEqual([{ ...PLATFORM, dir: join(cacheDir, 'dashpay', 'platform') }]);
    expect(run).toHaveBeenCalledTimes(15);
    expect(core.warning).not.toHaveBeenCalled();
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

    await relatedRepoLoader([DASH], { cacheDir, run: fakeGit() })('reference');

    expect(calls.map(c => c.args)).toEqual([
      ['init', '-q'],
      ['remote', 'add', 'origin', 'https://github.com/dashpay/dash.git'],
      FSCK,
      ['sparse-checkout', 'set', '--no-cone', '/src/consensus', '/doc/*.md'],
      ['fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', 'v23.0.0'],
      ['checkout', '-q', '--force', '--detach', 'FETCH_HEAD'],
    ]);
    expect(readFileSync(join(dashDir, '.git', 'objects', 'pack', 'pack-1.pack'), 'utf-8')).toBe('objects');
    expect(existsSync(join(dashDir, '.git', 'objects', 'info'))).toBe(false);
    expect(existsSync(join(dashDir, '.git', 'config'))).toBe(false);
    expect(existsSync(join(dashDir, 'stale.txt'))).toBe(false);
  });

  it('starts from an empty repository when the restored objects fail the check', async () => {
    const dashDir = join(cacheDir, 'dashpay', 'dash');
    restoreClone(dashDir);

    const fetched = await relatedRepoLoader([DASH], { cacheDir, run: fakeGit({ 'dashpay/dash': { fsck: 'error: index CRC mismatch for object 0931' } }) })('reference');

    expect(fetched).toHaveLength(1);
    expect(calls.map(c => c.args[0] === '-c' ? 'fsck' : c.args[0])).toEqual(['init', 'remote', 'fsck', 'init', 'remote', 'sparse-checkout', 'fetch', 'checkout']);
    expect(existsSync(join(dashDir, '.git', 'objects', 'pack'))).toBe(false);
    expect(core.info).toHaveBeenCalledWith(`Discarding the cached objects of ${dashDir}: error: index CRC mismatch for object 0931`);
  });

  it('reuses nothing through a symlink that the cache restored', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'manki-related-repos-outside-'));
    try {
      restoreClone(join(outside, 'dash'));
      symlinkSync(outside, join(cacheDir, 'dashpay'));

      await relatedRepoLoader([DASH], { cacheDir, run: fakeGit() })('reference');

      expect(calls.map(c => c.args[0])).toEqual(['init', 'remote', 'sparse-checkout', 'fetch', 'checkout']);
      expect(lstatSync(join(cacheDir, 'dashpay')).isSymbolicLink()).toBe(false);
      expect(existsSync(join(outside, 'dash', 'stale.txt'))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('skips a repo it cannot fetch with a warning, removes its directory, and returns the others', async () => {
    const run = fakeGit({ 'dashpay/dips': { fetch: "fatal: could not read Username for 'https://github.com': terminal prompts disabled" } });

    const references = await relatedRepoLoader([DASH, DIPS], { cacheDir, run })('reference');

    expect(references.map(r => r.repo)).toEqual(['dashpay/dash']);
    expect(core.warning).toHaveBeenCalledWith(
      "Skipping related repo dashpay/dips, which must be public on github.com: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
    expect(existsSync(join(cacheDir, 'dashpay', 'dips'))).toBe(false);
    expect(calls.filter(c => c.cwd.endsWith('dips')).map(c => c.args[0])).not.toContain('checkout');
  });

  it('gives each repo one time limit across its git commands, and skips it once that runs out', async () => {
    const run = jest.fn<ReturnType<NonNullable<Run>>, Parameters<NonNullable<Run>>>(async (_binary, _args, _cwd, options) => {
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(options?.timeoutMs).toBeLessThanOrEqual(10);
      return { code: -1, stdout: '', stderr: '' };
    });

    expect(await relatedRepoLoader([DIPS], { cacheDir, run, timeoutMs: 10 })('reference')).toEqual([]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(core.warning).toHaveBeenCalledWith('Skipping related repo dashpay/dips, which must be public on github.com: git did not finish within 0.01s');
  });

  it('refuses a repo name that leaves the cache directory, and fetches nothing for it', async () => {
    const run = fakeGit();

    expect(await relatedRepoLoader([{ repo: '../..', kind: 'reference' }], { cacheDir, run })('reference')).toEqual([]);

    expect(run).not.toHaveBeenCalled();
    expect(core.warning).toHaveBeenCalledWith('Skipping related repo ../..: not an "owner/name" repo');
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
