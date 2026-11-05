import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DOWNLOAD_TIMEOUT_MS = 120_000;

/** A release file pinned to one version by its digest in Subresource Integrity form, such as `sha512-<base64>`. */
export interface PinnedDownload {
  url: string;
  integrity: string;
}

const installs = new Map<string, Promise<string>>();

/**
 * Returns the directory a pinned download was installed into. A `.tgz`, `.tar.gz` or `.zip` is unpacked there, and
 * any other file is saved there as an executable under its own name. Each URL is downloaded at most once per run.
 * Throws when the download fails or its digest differs from `integrity`.
 */
export function installPinned(download: PinnedDownload): Promise<string> {
  let install = installs.get(download.url);
  if (!install) {
    install = downloadAndInstall(download);
    installs.set(download.url, install);
  }
  return install;
}

/** Returns a new empty directory in the runner's temp directory. */
export function makeScratchDir(prefix: string): string {
  return mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), `manki-${prefix}-`));
}

async function downloadAndInstall({ url, integrity }: PinnedDownload): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`download of ${url} failed with HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  const separator = integrity.indexOf('-');
  const algorithm = integrity.slice(0, separator);
  if (createHash(algorithm).update(data).digest('base64') !== integrity.slice(separator + 1)) {
    throw new Error(`download of ${url} does not match its pinned ${algorithm} digest`);
  }
  const dir = makeScratchDir('tool');
  const name = basename(new URL(url).pathname);
  const file = join(dir, name);
  writeFileSync(file, data);
  // A relative name keeps a Windows drive letter away from GNU tar, which reads `C:` as a remote host.
  if (/\.(tgz|tar\.gz)$/.test(name)) {
    await execFileAsync('tar', ['-xzf', name], { cwd: dir });
  } else if (name.endsWith('.zip')) {
    // Only Windows builds come as zips, and the Windows `tar` is bsdtar, which reads them.
    await execFileAsync('tar', ['-xf', name], { cwd: dir });
  } else {
    chmodSync(file, 0o755);
  }
  return dir;
}
