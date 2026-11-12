import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';

import { installPinned } from './tool-install';

/** Starts `call` and lets `ms` of fake time pass, so its waits and timeouts run without real time. */
async function afterTime<T>(call: () => Promise<T>, ms: number): Promise<T> {
  jest.useFakeTimers();
  try {
    const result = call();
    result.catch(() => {});
    await jest.advanceTimersByTimeAsync(ms);
    return await result;
  } finally {
    jest.useRealTimers();
  }
}

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
  const savedRunnerTemp = process.env.RUNNER_TEMP;

  beforeEach(() => {
    process.env.RUNNER_TEMP = mkdtempSync(join(tmpdir(), 'manki-runner-temp-'));
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(data));
  });

  afterEach(() => {
    fetchMock.mockRestore();
    if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedRunnerTemp;
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
      await expect(afterTime(() => installPinned({ url, integrity }), 70_000)).rejects.toThrow(reason);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(stderr.mock.calls.map(([line]) => String(line))).toEqual([2, 3].map(attempt => expect.stringMatching(new RegExp(`${reason.source}, trying again \\(try ${attempt} of 3\\)\n$`))));

      fetchMock.mockClear().mockImplementationOnce(failing).mockImplementationOnce(failing).mockImplementation(async () => new Response(data));
      const dir = await afterTime(() => installPinned({ url, integrity }), 50_000);
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
    const dir = await afterTime(() => installPinned({ url: 'https://example.test/slow.tgz', integrity }), 60_000);
    expect(readFileSync(join(dir, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear().mockImplementation(async (_url: unknown, init?: RequestInit) => slowResponse([], 15_000, signalOf(init), true));
    await expect(afterTime(() => installPinned({ url: 'https://example.test/endless.tgz', integrity }), 240_000))
      .rejects.toThrow('download of https://example.test/endless.tgz did not finish within 240 seconds');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The link would be as slow for the next call, which fails at once instead of waiting four minutes again.
    await expect(installPinned({ url: 'https://example.test/endless.tgz', integrity })).rejects.toThrow('did not finish within 240 seconds');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
