import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DOWNLOAD_TIMEOUT_MS = 120_000;

/** A release archive pinned to one version by its digest in Subresource Integrity form, such as `sha512-<base64>`. */
export interface PinnedDownload {
  url: string;
  integrity: string;
}

const installs = new Map<string, Promise<string>>();

/**
 * Returns the directory a pinned `.tgz` was unpacked into. Each URL is downloaded at most once per run.
 * Throws when the download fails or its digest differs from `integrity`.
 */
export function installTarball(download: PinnedDownload): Promise<string> {
  let install = installs.get(download.url);
  if (!install) {
    install = downloadAndExtract(download);
    installs.set(download.url, install);
  }
  return install;
}

async function downloadAndExtract({ url, integrity }: PinnedDownload): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`download of ${url} failed with HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const separator = integrity.indexOf('-');
  const algorithm = integrity.slice(0, separator);
  if (createHash(algorithm).update(data).digest('base64') !== integrity.slice(separator + 1)) {
    throw new Error(`download of ${url} does not match its pinned ${algorithm} digest`);
  }
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'manki-tool-'));
  const archive = join(dir, 'download.tgz');
  writeFileSync(archive, data);
  await execFileAsync('tar', ['-xzf', archive, '-C', dir]);
  return dir;
}
