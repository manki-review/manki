import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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

  it('saves a download that is not an archive as an executable under its own name', async () => {
    const binary = Buffer.from('#!/bin/sh\n');
    fetchMock.mockImplementation(async () => new Response(binary));

    const dir = await installPinned({ url: 'https://example.test/v1/tool_linux_amd64', integrity: `sha256-${createHash('sha256').update(binary).digest('base64')}` });

    expect(readFileSync(join(dir, 'tool_linux_amd64'))).toEqual(binary);
    expect(() => accessSync(join(dir, 'tool_linux_amd64'), constants.X_OK)).not.toThrow();
  });

  it('rejects a download whose digest differs, and a failed download', async () => {
    const tampered = `sha512-${createHash('sha512').update('other').digest('base64')}`;
    await expect(installPinned({ url: 'https://example.test/tool-2.tgz', integrity: tampered })).rejects.toThrow(/does not match its pinned sha512 digest/);

    fetchMock.mockImplementation(async () => new Response('gone', { status: 404 }));
    await expect(installPinned({ url: 'https://example.test/tool-3.tgz', integrity })).rejects.toThrow(/HTTP 404/);
  });
});
