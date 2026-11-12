import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  accessSync, chmodSync, constants, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  truncateSync, utimesSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join } from 'path';

import { pastRetryWait } from './test-utils';
import { installPinned } from './tool-install';

function tarball(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'manki-tool-test-'));
  mkdirSync(join(dir, 'package'));
  writeFileSync(join(dir, 'package', 'tool.txt'), 'pinned tool');
  execFileSync('tar', ['-czf', join(dir, 'tool.tgz'), '-C', dir, 'package']);
  return readFileSync(join(dir, 'tool.tgz'));
}

describe('installPinned', () => {
  const data = tarball();
  const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`;
  let fetchMock: jest.SpyInstance;
  const RUNNER_VARIABLES = ['RUNNER_TEMP', 'RUNNER_TOOL_CACHE', 'RUNNER_ENVIRONMENT'] as const;
  const saved = RUNNER_VARIABLES.map(name => process.env[name]);

  beforeEach(() => {
    process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), 'manki-runner-temp-'));
    // No test reads or writes the tool cache of the machine it runs on.
    delete process.env.RUNNER_TOOL_CACHE;
    delete process.env.RUNNER_ENVIRONMENT;
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(data));
  });

  afterEach(() => {
    fetchMock.mockRestore();
    RUNNER_VARIABLES.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
  });

  it('unpacks a download that matches its digest, and downloads it once per run, across processes too', async () => {
    const download = { url: 'https://example.test/tool-1.tgz', integrity };

    const [first, second] = await Promise.all([installPinned(download), installPinned(download)]);

    expect(readFileSync(join(first, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Another process, such as Manki's tool server, finds the install without downloading it again.
    let fromOtherProcess: string | undefined;
    await jest.isolateModulesAsync(async () => {
      fromOtherProcess = await (await import('./tool-install')).installPinned(download);
    });
    expect(fromOtherProcess).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never reuses an install that others can write, one whose download changed, or one outside the runner temp folder', async () => {
    const download = { url: 'https://example.test/tool-4.tgz', integrity };
    const first = await installPinned(download);
    chmodSync(first, 0o777);
    let planted: string | undefined;
    await jest.isolateModulesAsync(async () => {
      planted = await (await import('./tool-install')).installPinned(download);
    });
    expect(planted).not.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const changed = { url: 'https://example.test/tool-5.tgz', integrity: `sha256-${createHash('sha256').update(data).digest('base64')}` };
    const shared = await installPinned(changed);
    expect(basename(shared)).toMatch(/^manki-pinned-/);
    writeFileSync(join(shared, 'tool-5.tgz'), 'tampered');
    let reused: string | undefined;
    await jest.isolateModulesAsync(async () => {
      reused = await (await import('./tool-install')).installPinned(changed);
    });
    expect(reused).not.toBe(shared);
    expect(fetchMock).toHaveBeenCalledTimes(4);

    delete process.env.RUNNER_TEMP;
    let unshared: string | undefined;
    await jest.isolateModulesAsync(async () => {
      unshared = await (await import('./tool-install')).installPinned(download);
    });
    expect(basename(unshared!)).toMatch(/^manki-tool-/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('saves a download that is not an archive as an executable under its own name', async () => {
    const binary = Buffer.from('#!/bin/sh\n');
    fetchMock.mockImplementation(async () => new Response(binary));

    const dir = await installPinned({ url: 'https://example.test/v1/tool_linux_amd64', integrity: `sha256-${createHash('sha256').update(binary).digest('base64')}` });

    expect(readFileSync(join(dir, 'tool_linux_amd64'))).toEqual(binary);
    expect(() => accessSync(join(dir, 'tool_linux_amd64'), constants.X_OK)).not.toThrow();
  });

  it('rejects a download whose digest differs or that the server refuses after one try, and keeps that failure for the run', async () => {
    const tampered = `sha512-${createHash('sha512').update('other').digest('base64')}`;
    await expect(installPinned({ url: 'https://example.test/tool-2.tgz', integrity: tampered })).rejects.toThrow(/does not match its pinned sha512 digest/);

    fetchMock.mockImplementation(async () => new Response('gone', { status: 404 }));
    await expect(installPinned({ url: 'https://example.test/tool-3.tgz', integrity })).rejects.toThrow(/HTTP 404/);
    // Neither would end differently on another try, so each was downloaded once.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A later call of the run gets the same failure without another download.
    fetchMock.mockImplementation(async () => new Response(data));
    await expect(installPinned({ url: 'https://example.test/tool-2.tgz', integrity: tampered })).rejects.toThrow(/does not match its pinned sha512 digest/);
    await expect(installPinned({ url: 'https://example.test/tool-3.tgz', integrity })).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('forgets a failure of unpacking or of the disk, so the next call downloads again', async () => {
    // Only a failure every try of the run would hit again is kept. An archive `tar` cannot read is not one of them.
    const unreadable = Buffer.from('not an archive');
    fetchMock.mockImplementation(async () => new Response(unreadable));
    const download = { url: 'https://example.test/unreadable.tgz', integrity: `sha512-${createHash('sha512').update(unreadable).digest('base64')}` };
    for (const downloads of [1, 2]) {
      await expect(installPinned(download)).rejects.toThrow(/tar/);
      expect(fetchMock).toHaveBeenCalledTimes(downloads);
    }

    // A temp folder that cannot be written fails after the download too, and the call after the repair installs.
    fetchMock.mockClear().mockImplementation(async () => new Response(data));
    const temp = process.env.RUNNER_TEMP!;
    chmodSync(temp, 0o500);
    try {
      await expect(installPinned({ url: 'https://example.test/read-only-temp.tgz', integrity })).rejects.toThrow(/EACCES/);
    } finally {
      chmodSync(temp, 0o700);
    }
    const dir = await installPinned({ url: 'https://example.test/read-only-temp.tgz', integrity });
    expect(readFileSync(join(dir, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /** A response whose body delivers one of `chunks` every `gapMs` and then ends, or goes on with single bytes when `endless`. */
  function slowResponse(chunks: Uint8Array[], gapMs: number, signal: AbortSignal, endless = false): Response {
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(signal.reason));
        const next = (index: number): void => {
          setTimeout(() => {
            if (signal.aborted) return;
            if (index < chunks.length) controller.enqueue(chunks[index]);
            else if (endless) controller.enqueue(new Uint8Array(1));
            else return controller.close();
            next(index + 1);
          }, gapMs);
        };
        next(0);
      },
    }));
  }
  const signalOf = (init?: RequestInit): AbortSignal => init!.signal!;
  /** A body that never delivers a byte. */
  const stalled = async (_url: unknown, init?: RequestInit): Promise<Response> => slowResponse([], 3_600_000, signalOf(init));

  it.each([
    ['a network error', async () => { throw new TypeError('fetch failed'); }, /failed: fetch failed/],
    ['a server error', async () => new Response('down', { status: 503 }), /HTTP 503/],
    ['a throttled download', async () => new Response('slow down', { status: 429 }), /HTTP 429/],
    ['a download that stalls', stalled, /stalled, no data for 20 seconds/],
  ])('tries %s three times at most, and installs from the first try that works', async (name, failing, reason) => {
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const url = `https://example.test/${name.replace(/ /g, '-')}.tgz`;
    try {
      fetchMock.mockImplementation(failing);
      await expect(pastRetryWait(() => installPinned({ url, integrity }), 70_000)).rejects.toThrow(reason);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(stderr.mock.calls.map(([line]) => String(line))).toEqual([2, 3].map(attempt => expect.stringMatching(new RegExp(`${reason.source}, trying again \\(try ${attempt} of 3\\)\n$`))));

      fetchMock.mockClear().mockImplementationOnce(failing).mockImplementationOnce(failing).mockImplementation(async () => new Response(data));
      const dir = await pastRetryWait(() => installPinned({ url, integrity }), 50_000);
      expect(readFileSync(join(dir, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      stderr.mockRestore();
    }
  });

  it('lets a slow download finish while data keeps arriving, and stops one that takes over four minutes for the whole run', async () => {
    const third = Math.ceil(data.length / 3);
    const chunks = [data.subarray(0, third), data.subarray(third, 2 * third), data.subarray(2 * third)];
    // A minute in all, three times what a stalled download gets, with 15 seconds between two chunks.
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => slowResponse(chunks, 15_000, signalOf(init)));
    const dir = await pastRetryWait(() => installPinned({ url: 'https://example.test/slow.tgz', integrity }), 60_000);
    expect(readFileSync(join(dir, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear().mockImplementation(async (_url: unknown, init?: RequestInit) => slowResponse([], 15_000, signalOf(init), true));
    await expect(pastRetryWait(() => installPinned({ url: 'https://example.test/endless.tgz', integrity }), 240_000))
      .rejects.toThrow('download of https://example.test/endless.tgz did not finish within 240 seconds');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The link would be as slow for the next call, which fails at once instead of waiting four minutes again.
    await expect(installPinned({ url: 'https://example.test/endless.tgz', integrity })).rejects.toThrow('did not finish within 240 seconds');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  describe('a download kept for later runs', () => {
    const download = { url: 'https://example.test/kept/tool.tgz', integrity };
    const keptName = `${createHash('sha256').update(integrity).digest('hex').slice(0, 16)}-tool.tgz`;
    let toolCache: string;
    let stderr: jest.SpyInstance;
    const folder = () => join(toolCache, 'manki-pinned');
    const kept = () => join(folder(), keptName);
    const notes = () => stderr.mock.calls.map(([line]) => String(line));
    /** The real `fs`, for a test that gives the next run one call that answers differently. */
    const fs = jest.requireActual<typeof import('fs')>('fs');

    beforeEach(() => {
      toolCache = mkdtempSync(join(tmpdir(), 'manki-tool-cache-'));
      process.env.RUNNER_TOOL_CACHE = toolCache;
      process.env.RUNNER_ENVIRONMENT = 'self-hosted';
      stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
      stderr.mockRestore();
      jest.restoreAllMocks();
    });

    /** Returns `installPinned` as a process of its own has it, with nothing installed yet. */
    async function newProcess(): Promise<typeof installPinned> {
      let install: typeof installPinned | undefined;
      await jest.isolateModulesAsync(async () => {
        install = (await import('./tool-install')).installPinned;
      });
      return install!;
    }

    /** Installs `pinned` as another run on the same runner does: in a process of its own with a temp folder of its own. */
    async function nextRun(pinned = download): Promise<string> {
      process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), 'manki-runner-temp-'));
      return (await newProcess())(pinned);
    }

    it('keeps a download in the tool cache, and a later run unpacks it again without downloading it, and says so', async () => {
      // The tool cache can be a link to a folder of this user's own, as a runner's `_work/_tool` often is.
      const link = join(mkdtempSync(join(tmpdir(), 'manki-tool-cache-link-')), 'tools');
      symlinkSync(toolCache, link);
      process.env.RUNNER_TOOL_CACHE = link;

      const first = await nextRun();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(readFileSync(kept())).toEqual(data);
      expect(statSync(folder()).mode & 0o777).toBe(0o700);
      expect(statSync(kept()).mode & 0o777).toBe(0o600);
      expect(readdirSync(folder())).toEqual([keptName]);

      const second = await nextRun();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // What runs is unpacked from the checked bytes into this run's own temp folder, never taken from the tool cache.
      expect(second).not.toBe(first);
      expect(second.startsWith(realpathSync(process.env.RUNNER_TEMP!))).toBe(true);
      expect(readFileSync(join(second, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
      expect(notes()).toEqual([expect.stringMatching(/^Using the kept download .*tool\.tgz instead of downloading it\n$/)]);

      // Where the time of last use cannot be set, as in a tool cache mounted read-only, the checked download is still used.
      jest.doMock('fs', () => ({ ...fs, futimesSync: () => { throw new Error('EROFS: read-only file system, futime'); } }));
      try {
        await nextRun();
      } finally {
        jest.dontMock('fs');
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(notes().slice(1)).toEqual([
        expect.stringMatching(/^Could not set the time of last use in .*manki-pinned, so its downloads count as unused: EROFS: read-only file system, futime\n$/),
        expect.stringMatching(/^Using the kept download /),
      ]);
    });

    // A file that was read and failed its digest is named in the log. A link and a pipe are never read, so nothing is compared.
    const MISMATCH = [expect.stringMatching(/^The kept download .*tool\.tgz does not match its pinned digest, downloading it again\n$/)];
    it.each([
      ['its content was replaced', () => writeFileSync(kept(), 'planted'), MISMATCH],
      ['it was cut short', () => truncateSync(kept(), 10), MISMATCH],
      ['it is a link to a file with the right content', () => {
        renameSync(kept(), join(toolCache, 'elsewhere.tgz'));
        symlinkSync(join(toolCache, 'elsewhere.tgz'), kept());
      }, []],
      ['it is a named pipe', () => {
        renameSync(kept(), join(toolCache, 'elsewhere.tgz'));
        // Without its own stderr, which `execFileSync` would pass on to the log this test reads.
        execFileSync('mkfifo', [kept()], { stdio: 'ignore' });
      }, []],
    ])('downloads again instead of using a kept file when %s, and keeps the checked download in its place', async (_case, tamper, said) => {
      await nextRun();
      tamper();

      const dir = await nextRun();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(readFileSync(join(dir, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
      expect(notes()).toEqual(said);

      // The checked download replaces the bad entry, and a file a link pointed to is left as it was.
      expect(lstatSync(kept()).isFile()).toBe(true);
      expect(readFileSync(kept())).toEqual(data);
      if (existsSync(join(toolCache, 'elsewhere.tgz'))) expect(readFileSync(join(toolCache, 'elsewhere.tgz'))).toEqual(data);
      await nextRun();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // The log says once per process why a tool cache that exists is not used, and nothing for a runner that keeps none.
    const DISTRUST = [expect.stringMatching(/^Not keeping downloads in .*manki-pinned: it and .* must be folders that only this user can write\n$/)];
    it.each([
      ['another user can write the folder', () => chmodSync(folder(), 0o777), DISTRUST],
      ['the group can write the folder', () => chmodSync(folder(), 0o770), DISTRUST],
      ['another user can write the tool cache', () => chmodSync(toolCache, 0o777), DISTRUST],
      // Only `manki-pinned` gets another owner. The tool cache stays this user's own and passes its check.
      ['another user owns the folder', () => jest.doMock('fs', () => ({
        ...fs,
        statSync: (path: string) => {
          const stats = fs.statSync(path);
          if (basename(path) === 'manki-pinned') stats.uid += 1;
          return stats;
        },
      })), DISTRUST],
      ['the folder is a link', () => {
        renameSync(folder(), join(toolCache, 'real'));
        symlinkSync(join(toolCache, 'real'), folder());
      }, DISTRUST],
      ['the runner is GitHub-hosted', () => { process.env.RUNNER_ENVIRONMENT = 'github-hosted'; }, []],
      ['the runner does not say where it runs', () => { delete process.env.RUNNER_ENVIRONMENT; }, []],
      ['the platform has no user ids', () => { Object.defineProperty(process, 'getuid', { value: undefined, configurable: true }); }, []],
    ])('neither uses nor writes the kept download when %s', async (_case, arrange, said) => {
      const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
      await nextRun();
      const before = statSync(kept());
      arrange();
      try {
        const dir = await nextRun();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(readFileSync(join(dir, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
        expect(notes()).toEqual(said);
      } finally {
        if (getuid) Object.defineProperty(process, 'getuid', getuid);
        else delete (process as { getuid?: unknown }).getuid;
        jest.restoreAllMocks();
        jest.dontMock('fs');
      }
      // The same file is still there, and nothing was written next to it.
      const after = statSync(kept());
      expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
      expect(readdirSync(realFolder())).toEqual([keptName]);
    });
    const realFolder = () => (existsSync(join(toolCache, 'real')) ? join(toolCache, 'real') : folder());

    it('keeps nothing and installs as before on a runner without a tool cache, or whose tool cache is no folder, which the log says', async () => {
      delete process.env.RUNNER_TOOL_CACHE;
      await nextRun();
      await nextRun();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      process.env.RUNNER_TOOL_CACHE = join(toolCache, 'a-file');
      writeFileSync(join(toolCache, 'a-file'), '');
      await nextRun();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(readdirSync(toolCache)).toEqual(['a-file']);
      expect(notes()).toEqual(DISTRUST);
    });

    it.each([
      ['others can write', () => chmodSync(toolCache, 0o777)],
      ['the group can write', () => chmodSync(toolCache, 0o770)],
      // As for a job in a container, which runs as root on the tool cache of the runner's user.
      ['another user owns', () => jest.spyOn(process, 'getuid').mockReturnValue(statSync(toolCache).uid + 1)],
    ])('makes no folder in a tool cache that %s', async (_case, arrange) => {
      arrange();

      const dir = await nextRun();

      expect(readFileSync(join(dir, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
      expect(readdirSync(toolCache)).toEqual([]);
      expect(notes()).toEqual(DISTRUST);
    });

    it('makes a tool cache folder that does not exist yet, and one it trusts whatever the umask', async () => {
      process.env.RUNNER_TOOL_CACHE = join(toolCache, '_work', '_tool');
      // Under this umask a folder made without a mode is one the group can write.
      const umask = process.umask(0o002);
      try {
        await nextRun();
        await nextRun();
      } finally {
        process.umask(umask);
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(statSync(join(toolCache, '_work', '_tool')).mode & 0o777).toBe(0o755);
      expect(readdirSync(join(toolCache, '_work', '_tool', 'manki-pinned'))).toEqual([keptName]);
      expect(notes().filter(line => line.startsWith('Not keeping'))).toEqual([]);
    });

    it('lets two runs that start together each install, and never has half a file under the kept name', async () => {
      // Neither run finds a kept file, so both download. The second answer comes only once both have asked.
      let asked = 0;
      let bothAsked: () => void = () => {};
      const gate = new Promise<void>(resolve => { bothAsked = resolve; });
      fetchMock.mockImplementation(async () => {
        if (++asked === 2) bothAsked();
        await gate;
        return new Response(data);
      });
      // What another run finds under the kept name while a run has written half of its file.
      const foundMeanwhile: string[] = [];
      const writtenUnder: string[] = [];
      jest.doMock('fs', () => ({
        ...fs,
        writeFileSync: (path: string, content: Buffer | string, options?: import('fs').WriteFileOptions) => {
          if (basename(dirname(path)) !== 'manki-pinned' || typeof content === 'string') return fs.writeFileSync(path, content, options);
          writtenUnder.push(basename(path));
          fs.writeFileSync(path, content.subarray(0, content.length / 2), options);
          foundMeanwhile.push(!fs.existsSync(kept()) ? 'none' : fs.readFileSync(kept()).equals(data) ? 'whole' : 'half');
          fs.appendFileSync(path, content.subarray(content.length / 2));
        },
      }));
      // Without a shared temp folder each install is a run of its own.
      delete process.env.RUNNER_TEMP;
      let installs: Array<typeof installPinned>;
      try {
        installs = [await newProcess(), await newProcess()];
      } finally {
        jest.dontMock('fs');
      }

      const [first, second] = await Promise.all(installs.map(install => install(download)));

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(first).not.toBe(second);
      for (const dir of [first, second]) expect(readFileSync(join(dir, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
      // The first run writes beside no kept file, the second beside the whole file of the first.
      expect(foundMeanwhile).toEqual(['none', 'whole']);
      // Each run writes under a name of its own, so two that write at the same moment do not write one file.
      expect(writtenUnder).toEqual([expect.stringMatching(/^\.writing-[0-9a-f]{16}$/), expect.stringMatching(/^\.writing-[0-9a-f]{16}$/)]);
      expect(new Set(writtenUnder).size).toBe(2);
      expect(readdirSync(folder())).toEqual([keptName]);
      expect(readFileSync(kept())).toEqual(data);
      expect(notes()).toEqual([]);
    });

    it('removes a kept download no run used for 14 days when it keeps a new one, and nothing else', async () => {
      await nextRun();
      const days = (count: number) => new Date(Date.now() - count * 24 * 60 * 60 * 1000);
      const age = (name: string, count: number) => utimesSync(join(folder(), name), days(count), days(count));
      for (const [name, count] of [['old-version.tgz', 15], ['other-version.tgz', 13], ['.writing-0123456789abcdef', 15]] as const) {
        writeFileSync(join(folder(), name), 'x');
        age(name, count);
      }
      // Only files go. A folder and a link stay, and so does what the link points to.
      mkdirSync(join(folder(), 'a-folder'));
      age('a-folder', 15);
      writeFileSync(join(toolCache, 'outside'), 'x');
      utimesSync(join(toolCache, 'outside'), days(15), days(15));
      symlinkSync(join(toolCache, 'outside'), join(folder(), 'a-link'));
      lutimesSync(join(folder(), 'a-link'), days(15), days(15));
      // A run that uses a kept download marks it as used, however old the file is.
      age(keptName, 15);
      await nextRun();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const other = Buffer.from('#!/bin/sh\n');
      fetchMock.mockImplementation(async () => new Response(other));
      const otherIntegrity = `sha256-${createHash('sha256').update(other).digest('base64')}`;
      // Another run on the runner removes the first old file this run looks at, between the listing and the look.
      const vanished: string[] = [];
      jest.doMock('fs', () => ({
        ...fs,
        lstatSync: (path: string) => {
          if (vanished.length === 0 && ['old-version.tgz', '.writing-0123456789abcdef'].includes(basename(path))) {
            vanished.push(basename(path));
            fs.rmSync(path);
          }
          return fs.lstatSync(path);
        },
      }));
      try {
        await nextRun({ url: 'https://example.test/kept/other-tool', integrity: otherIntegrity });
      } finally {
        jest.dontMock('fs');
      }

      const otherName = `${createHash('sha256').update(otherIntegrity).digest('hex').slice(0, 16)}-other-tool`;
      expect(vanished).toHaveLength(1);
      expect(readdirSync(folder()).sort()).toEqual(['a-folder', 'a-link', keptName, 'other-version.tgz', otherName].sort());
      expect(existsSync(join(toolCache, 'outside'))).toBe(true);
      // The new download was kept, and the log does not say otherwise.
      expect(notes().filter(line => line.startsWith('Could not'))).toEqual([]);

      // A cleanup that cannot list the folder says so, and does not say that the download was not kept.
      rmSync(join(folder(), otherName));
      jest.doMock('fs', () => ({ ...fs, readdirSync: () => { throw new Error('EIO: i/o error, scandir'); } }));
      try {
        await nextRun({ url: 'https://example.test/kept/other-tool', integrity: otherIntegrity });
      } finally {
        jest.dontMock('fs');
      }
      expect(readFileSync(join(folder(), otherName))).toEqual(other);
      expect(notes().filter(line => line.startsWith('Could not'))).toEqual([expect.stringMatching(/^Could not remove the unused downloads in .*manki-pinned: EIO: i\/o error, scandir\n$/)]);
    });

    it('installs all the same when a folder sits where the kept file goes, and says why nothing is kept', async () => {
      mkdirSync(join(kept(), 'in-the-way'), { recursive: true });
      chmodSync(folder(), 0o700);

      for (const downloads of [1, 2]) {
        const dir = await nextRun();
        expect(readFileSync(join(dir, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
        expect(fetchMock).toHaveBeenCalledTimes(downloads);
      }

      expect(notes()).toEqual([1, 2].map(() => expect.stringMatching(/^Could not keep the download of https:\/\/example\.test\/kept\/tool\.tgz for later runs: /)));
      // The folder is left as it was, and no half-written file stays behind.
      expect(readdirSync(folder())).toEqual([keptName]);
      expect(readdirSync(kept())).toEqual(['in-the-way']);
    });
  });
});
