import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** A download that delivers no byte for this long has stalled and is aborted. */
const STALL_TIMEOUT_MS = 20_000;
/** How long all tries of one download may take together. A link too slow for it would be as slow on another try. */
const DOWNLOAD_DEADLINE_MS = 240_000;
const DOWNLOAD_TRIES = 3;
const RETRY_WAIT_MS = 2_000;
// Written last, so a directory with it holds a whole install.
const INSTALLED_MARKER = '.manki-installed';

/** A release file pinned to one version by its digest in Subresource Integrity form, such as `sha512-<base64>`. */
export interface PinnedDownload {
  url: string;
  integrity: string;
}

/** A download failure another try may not hit: no connection, a stalled transfer, or a 408, 429 or 5xx answer. */
class TransientDownloadError extends Error {}

const installs = new Map<string, Promise<string>>();

/**
 * Returns the directory a pinned download was installed into. A `.tgz`, `.tar.gz` or `.zip` is unpacked there, and
 * any other file is saved there as an executable under its own name. Each download is installed at most once per run.
 * In the runner's temp folder, other processes such as Manki's tool server reuse it too. A download that fails in
 * passing is tried up to `DOWNLOAD_TRIES` times. Throws when it still fails, and the next call then tries again.
 * Throws at once for a failure another try would hit again, such as a digest that differs from `integrity` or a
 * download too slow for `DOWNLOAD_DEADLINE_MS`. Every later call of the run gets that failure without a download.
 */
export function installPinned(download: PinnedDownload): Promise<string> {
  let install = installs.get(download.url);
  if (!install) {
    install = installWithRetries(download);
    installs.set(download.url, install);
    install.catch((error: unknown) => {
      if (error instanceof TransientDownloadError) installs.delete(download.url);
    });
  }
  return install;
}

async function installWithRetries(download: PinnedDownload): Promise<string> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), DOWNLOAD_DEADLINE_MS);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return await downloadAndInstall(download, deadline.signal);
      } catch (error) {
        if (!(error instanceof TransientDownloadError) || attempt === DOWNLOAD_TRIES || deadline.signal.aborted) throw error;
        // Written to stderr, since stdout carries the protocol of Manki's tool server, which installs through here too.
        process.stderr.write(`${error.message}, trying again (try ${attempt + 1} of ${DOWNLOAD_TRIES})\n`);
        await new Promise(resolve => setTimeout(resolve, RETRY_WAIT_MS));
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads `url` whole. A download that keeps delivering data may take until `deadline` aborts. Throws
 * `TransientDownloadError` for a failure another try may not hit, and a plain error for one it would hit again.
 */
async function fetchWhole(url: string, deadline: AbortSignal): Promise<Buffer> {
  const stall = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const moved = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => stall.abort(), STALL_TIMEOUT_MS);
  };
  let status: number;
  moved();
  try {
    const response = await fetch(url, { signal: AbortSignal.any([stall.signal, deadline]) });
    if (response.ok) {
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body ?? []) {
        moved();
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    }
    status = response.status;
    await response.body?.cancel();
  } catch (error) {
    if (deadline.aborted) throw new Error(`download of ${url} did not finish within ${DOWNLOAD_DEADLINE_MS / 1000} seconds`);
    if (stall.signal.aborted) throw new TransientDownloadError(`download of ${url} stalled, no data for ${STALL_TIMEOUT_MS / 1000} seconds`);
    // `fetch` reports a network failure as "fetch failed" and keeps the reason, such as a refused connection, in `cause`.
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
    throw new TransientDownloadError(`download of ${url} failed: ${error instanceof Error ? error.message : String(error)}${cause}`);
  } finally {
    clearTimeout(timer);
  }
  const failed = `download of ${url} failed with HTTP ${status}`;
  throw status >= 500 || status === 408 || status === 429 ? new TransientDownloadError(failed) : new Error(failed);
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

async function downloadAndInstall(download: PinnedDownload, deadline: AbortSignal): Promise<string> {
  const { url, integrity } = download;
  const shared = sharedInstall(download);
  if (shared?.ready) return shared.path;
  const data = await fetchWhole(url, deadline);
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
