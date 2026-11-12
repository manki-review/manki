import { execFile } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, futimesSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'fs';
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
/** The folder in the runner's tool cache that keeps downloads for later runs. */
const KEPT_FOLDER = 'manki-pinned';
/** A kept download no run used for this long is removed, so the folder does not grow with every version bump. */
const KEPT_UNUSED_MS = 14 * 24 * 60 * 60 * 1000;

/** A release file pinned to one version by its digest in Subresource Integrity form, such as `sha512-<base64>`. */
export interface PinnedDownload {
  url: string;
  integrity: string;
}

/** A download failure another try may not hit: no connection, a stalled transfer, or a 408, 429 or 5xx answer. */
class TransientDownloadError extends Error {}

/**
 * A download failure every try of this run would hit again: a digest that differs from the pinned one, a status such
 * as 404, or the time for all tries used up. Only such a failure is kept for the run.
 */
class LastingDownloadError extends Error {}

const installs = new Map<string, Promise<string>>();

/**
 * Returns the directory a pinned download was installed into. A `.tgz`, `.tar.gz` or `.zip` is unpacked there, and
 * any other file is saved there as an executable under its own name. Each download is installed at most once per run.
 * In the runner's temp folder, other processes such as Manki's tool server reuse it too. A download that fails in
 * passing is tried up to `DOWNLOAD_TRIES` times. Throws when it still fails, and the next call then tries again.
 * Throws at once for a `LastingDownloadError`, such as a digest that differs from `integrity` or a download too slow
 * for `DOWNLOAD_DEADLINE_MS`. Every later call of the run gets that failure without a download. Any other failure,
 * such as a full disk or an archive that does not unpack, throws at once too, and the next call tries again.
 */
export function installPinned(download: PinnedDownload): Promise<string> {
  let install = installs.get(download.url);
  if (!install) {
    install = installWithRetries(download);
    installs.set(download.url, install);
    install.catch((error: unknown) => {
      if (!(error instanceof LastingDownloadError)) installs.delete(download.url);
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
 * `TransientDownloadError` for a failure another try may not hit, and `LastingDownloadError` for one it would hit again.
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
    if (deadline.aborted) throw new LastingDownloadError(`download of ${url} did not finish within ${DOWNLOAD_DEADLINE_MS / 1000} seconds`);
    if (stall.signal.aborted) throw new TransientDownloadError(`download of ${url} stalled, no data for ${STALL_TIMEOUT_MS / 1000} seconds`);
    // `fetch` reports a network failure as "fetch failed" and keeps the reason, such as a refused connection, in `cause`.
    const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : '';
    throw new TransientDownloadError(`download of ${url} failed: ${error instanceof Error ? error.message : String(error)}${cause}`);
  } finally {
    clearTimeout(timer);
  }
  const failed = `download of ${url} failed with HTTP ${status}`;
  throw status >= 500 || status === 408 || status === 429 ? new TransientDownloadError(failed) : new LastingDownloadError(failed);
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

/** A short name for the digest `integrity`, so each pinned version gets a folder or file of its own. */
function integrityKey(integrity: string): string {
  return createHash('sha256').update(integrity).digest('hex').slice(0, 16);
}

// Written to stderr, since stdout carries the protocol of Manki's tool server, which installs through here too.
function note(text: string): void {
  process.stderr.write(`${text}\n`);
}

/** Whether this process already said that the tool cache is not trusted, so the log says it once. */
let distrustNoted = false;

/** Whether `path` is a folder itself, not a link to one, that this user owns and no one else can write. */
function ownFolder(path: string): boolean {
  return lstatSync(path).isDirectory() && writableOnlyByUs(path);
}

/**
 * Returns the folder that keeps pinned downloads for later runs on this runner, or `undefined` when there is none to
 * trust. Only a self-hosted runner keeps its tool cache between jobs. The folder and the tool cache around it must
 * each be this user's own and writable by no one else, so no other user can plant a file or a link there. With
 * `create` a missing folder is made, and only in a tool cache that passed that check.
 */
function keptFolder(create: boolean): string | undefined {
  const toolCache = process.env.RUNNER_TOOL_CACHE;
  // Without a user id the owner of a folder cannot be checked, as on Windows.
  if (!toolCache || process.env.RUNNER_ENVIRONMENT !== 'self-hosted' || process.getuid === undefined) return undefined;
  try {
    // With a mode of its own: under a umask that leaves the group's write bit, a new folder would fail `ownFolder`.
    if (create) mkdirSync(toolCache, { recursive: true, mode: 0o755 });
    const root = realpathSync(toolCache);
    const folder = join(root, KEPT_FOLDER);
    if (ownFolder(root)) {
      // Not an error when the folder exists, as when another run made it at the same moment.
      if (create) mkdirSync(folder, { recursive: true, mode: 0o700 });
      if (ownFolder(folder)) return folder;
    }
    if (!distrustNoted) note(`Not keeping downloads in ${folder}: it and ${root} must be folders that only this user can write`);
    distrustNoted = true;
    return undefined;
  } catch {
    return undefined;
  }
}

function keptName({ url, integrity }: PinnedDownload): string {
  return `${integrityKey(integrity)}-${basename(new URL(url).pathname)}`;
}

/**
 * Returns the download an earlier run on this runner kept, or `undefined` when there is none or it no longer matches
 * its digest. The bytes returned are the bytes that were checked, so a file replaced after the check is never used.
 */
function keptDownload(download: PinnedDownload): Buffer | undefined {
  const folder = keptFolder(false);
  if (!folder) return undefined;
  const file = join(folder, keptName(download));
  let fd: number;
  try {
    // Never through a link, and never waiting on a pipe someone put there.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const data = readFileSync(fd);
    if (!matchesIntegrity(data, download.integrity)) {
      note(`The kept download ${file} does not match its pinned digest, downloading it again`);
      return undefined;
    }
    // The time of the last use decides when `removeUnusedKept` removes the file.
    const now = new Date();
    futimesSync(fd, now, now);
    note(`Using the kept download ${file} instead of downloading it`);
    return data;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Removes the kept downloads no run used for `KEPT_UNUSED_MS`, and what a run that died while writing left behind. */
function removeUnusedKept(folder: string): void {
  const cutoff = Date.now() - KEPT_UNUSED_MS;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    try {
      if (entry.isFile() && lstatSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
      // Another run on this runner may have removed the file meanwhile. A file that stays is tried again by a later run.
    }
  }
}

/** Keeps the checked `data` of `download` for later runs on this runner. A failure to keep it never fails the install. */
function keepDownload(download: PinnedDownload, data: Buffer): void {
  let folder: string | undefined;
  try {
    folder = keptFolder(true);
    if (!folder) return;
    // Written under another name first, so a run that reads meanwhile finds the whole file or none.
    const writing = join(folder, `.writing-${randomBytes(8).toString('hex')}`);
    try {
      writeFileSync(writing, data, { flag: 'wx', mode: 0o600 });
      renameSync(writing, join(folder, keptName(download)));
    } catch (error) {
      rmSync(writing, { force: true });
      throw error;
    }
  } catch (error) {
    note(`Could not keep the download of ${download.url} for later runs: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    removeUnusedKept(folder);
  } catch (error) {
    note(`Could not remove the unused downloads in ${folder}: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  const path = join(realpathSync(runnerTemp), `manki-pinned-${integrityKey(integrity)}`);
  if (!existsSync(join(path, INSTALLED_MARKER))) return { path, ready: false };
  const download = join(path, basename(new URL(url).pathname));
  return writableOnlyByUs(path) && existsSync(download) && matchesIntegrity(readFileSync(download), integrity) ? { path, ready: true } : undefined;
}

async function downloadAndInstall(download: PinnedDownload, deadline: AbortSignal): Promise<string> {
  const { url, integrity } = download;
  const shared = sharedInstall(download);
  // A folder of this run is used as it is. A download an earlier run kept is unpacked again for this run.
  const kept = shared?.ready ? undefined : keptDownload(download);
  if (kept) return unpack(download, kept, shared);
  if (shared?.ready) return shared.path;
  const data = await fetchWhole(url, deadline);
  if (!matchesIntegrity(data, integrity)) {
    throw new LastingDownloadError(`download of ${url} does not match its pinned ${integrity.slice(0, integrity.indexOf('-'))} digest`);
  }
  keepDownload(download, data);
  return unpack(download, data, shared);
}

/**
 * Installs the checked `data` of `download` into a folder of this run and returns it: `shared.path` when the run has
 * a temp folder its other processes can find, else a new folder.
 */
async function unpack(download: PinnedDownload, data: Buffer, shared: { path: string } | undefined): Promise<string> {
  const { url } = download;
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
