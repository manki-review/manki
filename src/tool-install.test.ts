import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { installTarball } from './tool-install';

function tarball(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'manki-tool-test-'));
  mkdirSync(join(dir, 'package'));
  writeFileSync(join(dir, 'package', 'tool.txt'), 'pinned tool');
  execFileSync('tar', ['-czf', join(dir, 'tool.tgz'), '-C', dir, 'package']);
  return readFileSync(join(dir, 'tool.tgz'));
}

describe('installTarball', () => {
  const data = tarball();
  const integrity = `sha512-${createHash('sha512').update(data).digest('base64')}`;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(data));
  });

  afterEach(() => {
    fetchMock.mockRestore();
  });

  it('unpacks a download that matches its digest, and downloads each URL once per run', async () => {
    const download = { url: 'https://example.test/tool-1.tgz', integrity };

    const [first, second] = await Promise.all([installTarball(download), installTarball(download)]);

    expect(readFileSync(join(first, 'package', 'tool.txt'), 'utf-8')).toBe('pinned tool');
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a download whose digest differs, and a failed download', async () => {
    const tampered = `sha512-${createHash('sha512').update('other').digest('base64')}`;
    await expect(installTarball({ url: 'https://example.test/tool-2.tgz', integrity: tampered })).rejects.toThrow(/does not match its pinned sha512 digest/);

    fetchMock.mockImplementation(async () => new Response('gone', { status: 404 }));
    await expect(installTarball({ url: 'https://example.test/tool-3.tgz', integrity })).rejects.toThrow(/HTTP 404/);
  });
});
