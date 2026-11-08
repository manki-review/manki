import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const DOWNLOAD_TIMEOUT_MS = 120_000;
// Written last, so a directory with it holds a whole install.
const INSTALLED_MARKER = '.manki-installed';

/** A release file pinned to one version by its digest in Subresource Integrity form, such as `sha512-<base64>`. */
export interface PinnedDownload {
  url: string;
  integrity: string;
}

const installs = new Map<string, Promise<string>>();

/**
 * Returns the directory a pinned download was installed into. A `.tgz`, `.tar.gz` or `.zip` is unpacked there, and
 * any other file is saved there as an executable under its own name. Each download is installed at most once per run.
 * In the runner's temp folder, other processes such as Manki's tool server reuse it too. Throws when the download
 * fails or its digest differs from `integrity`, and the next call then tries again.
 */
export function installPinned(download: PinnedDownload): Promise<string> {
  let install = installs.get(download.url);
  if (!install) {
    install = downloadAndInstall(download);
    installs.set(download.url, install);
    install.catch(() => installs.delete(download.url));
  }
  return install;
}

/** Returns a new empty directory in the runner's temp directory, as a real path so tools report paths under it. */
export function makeScratchDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), `manki-${prefix}-`)));
}

/** Whether this user owns `path` and no one else can write it, so another user of a shared folder cannot have planted it. */
export function writableOnlyByUs(path: string): boolean {
  const { uid, mode } = statSync(path);
  return process.getuid === undefined || (uid === process.getuid() && (mode & 0o022) === 0);
}

/** Whether `data` has the digest `integrity`, which is in Subresource Integrity form. */
function matchesIntegrity(data: Buffer, integrity: string): boolean {
  const separator = integrity.indexOf('-');
  return createHash(integrity.slice(0, separator)).update(data).digest('base64') === integrity.slice(separator + 1);
}

/**
 * Returns the folder another process of this run installed `download` into, or `undefined` when there is none.
 * Only the runner's own temp folder holds one, and only a folder this user owns and no one else can write is reused,
 * since the shared temp folder would let another user plant a binary there. The download kept in it must still
 * match its digest.
 */
function sharedInstall({ url, integrity }: PinnedDownload): { path: string; ready: boolean } | undefined {
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) return undefined;
  const path = join(realpathSync(runnerTemp), `manki-pinned-${createHash('sha256').update(integrity).digest('hex').slice(0, 16)}`);
  if (!existsSync(join(path, INSTALLED_MARKER))) return { path, ready: false };
  const download = join(path, basename(new URL(url).pathname));
  return writableOnlyByUs(path) && existsSync(download) && matchesIntegrity(readFileSync(download), integrity) ? { path, ready: true } : undefined;
}

async function downloadAndInstall(download: PinnedDownload): Promise<string> {
  const { url, integrity } = download;
  const shared = sharedInstall(download);
  if (shared?.ready) return shared.path;
  const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`download of ${url} failed with HTTP ${response.status}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!matchesIntegrity(data, integrity)) {
    throw new Error(`download of ${url} does not match its pinned ${integrity.slice(0, integrity.indexOf('-'))} digest`);
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
  if (!shared) return dir;
  writeFileSync(join(dir, INSTALLED_MARKER), '');
  try {
    renameSync(dir, shared.path);
  } catch {
    // Another process installed the same download first. Its folder is reused only if it passes the same checks.
    if (!sharedInstall(download)?.ready) return dir;
    rmSync(dir, { recursive: true, force: true });
  }
  return shared.path;
}
