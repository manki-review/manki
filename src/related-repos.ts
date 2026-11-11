import * as core from '@actions/core';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { devNull, tmpdir } from 'os';
import { dirname, join, resolve, sep } from 'path';

import { runTool } from './binary-analyzers';
import { ReferenceCheckout, RelatedRepo, RelatedRepoTools, RoundRelatedRepo } from './types';
import { gitEnv } from './workspace';

// A tool call that runs for the fetch and the wait after it must end before the CLI's 90 second stale limit.
const FETCH_TIMEOUT_MS = 60_000;
const WAIT_SLACK_MS = 2_000;
const WAIT_POLL_MS = 250;
// Git sends no credential, so a private repo fails, and runs no hook or fsmonitor of a clone.
const GIT_CONFIG = { 'credential.helper': '', 'core.hooksPath': devNull, 'core.fsmonitor': 'false' };
/** The files that can be a repo's guide, at its root. The first one found is the guide. */
export const GUIDE_FILES = ['AGENTS.md', 'CLAUDE.md'];

export interface RelatedRepoLoaderOptions {
  /** Time limit for fetching one repo. */
  timeoutMs?: number;
  run?: typeof runTool;
  /** Where progress goes. Defaults to stderr, since a tool server's stdout carries its protocol. */
  log?: (message: string) => void;
}

/** Returns the directory related repos are cloned into: `manki-related-repos` in the runner's temp directory. */
export function relatedReposCacheDir(): string {
  return join(process.env.RUNNER_TEMP || tmpdir(), 'manki-related-repos');
}

/**
 * Returns a function that fetches the related repo `name` and resolves with the directory holding it, or rejects with
 * the reason it could not. Each repo is fetched at most once per round: the first tool server to ask fetches it and
 * the others of the round wait for it.
 */
export function relatedRepoLoader(
  { repos, cacheDir, stateDir }: RelatedRepoTools,
  { timeoutMs = FETCH_TIMEOUT_MS, run = runTool, log = message => process.stderr.write(`${message}\n`) }: RelatedRepoLoaderOptions = {},
): (name: string) => Promise<string> {
  const checkouts = new Map<string, Promise<string>>();
  return name => {
    const repo = repos.find(r => r.repo === name);
    if (!repo) return Promise.reject(new Error(`${name} is not a related repo`));
    let checkout = checkouts.get(name);
    if (!checkout) {
      checkout = sharedCheckout(repo, join(stateDir, encodeURIComponent(name)), timeoutMs, () => checkoutRelatedRepo(repo, cacheDir, timeoutMs, run, log));
      checkouts.set(name, checkout);
    }
    return checkout;
  };
}

/**
 * Runs `checkout` in the one process that creates the lock `<marker>.lock`, holding its PID, which records the outcome
 * in `<marker>.done` or `<marker>.failed`. Any other process waits for that outcome.
 */
async function sharedCheckout(repo: RelatedRepo, marker: string, timeoutMs: number, checkout: () => Promise<string>): Promise<string> {
  try {
    writeFileSync(`${marker}.lock`, String(process.pid), { flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return waitForCheckout(repo, marker, timeoutMs);
  }
  try {
    const dir = await checkout();
    writeMarker(`${marker}.done`, dir);
    return dir;
  } catch (error) {
    writeMarker(`${marker}.failed`, messageOf(error));
    throw error;
  }
}

/** Writes `text` to `path` through a rename, so a waiting process never reads it half written. */
function writeMarker(path: string, text: string): void {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

/** Waits for the outcome the lock holder records, and records a failure when the holder stops or runs out of time. */
async function waitForCheckout(repo: RelatedRepo, marker: string, timeoutMs: number): Promise<string> {
  // The lock holder gives up on its fetch after `timeoutMs`, so a lock held longer belongs to a holder that hangs.
  const deadline = Date.now() + timeoutMs + WAIT_SLACK_MS;
  let reason = `another reviewer's fetch of ${repo.repo} did not finish in time`;
  while (Date.now() < deadline) {
    if (existsSync(`${marker}.done`)) return readFileSync(`${marker}.done`, 'utf-8');
    if (existsSync(`${marker}.failed`)) throw new Error(readFileSync(`${marker}.failed`, 'utf-8'));
    if (!isHolderAlive(`${marker}.lock`)) {
      reason = `the reviewer fetching ${repo.repo} stopped before it finished`;
      break;
    }
    await new Promise(done => setTimeout(done, WAIT_POLL_MS));
  }
  writeMarker(`${marker}.failed`, reason);
  throw new Error(reason);
}

/** Whether the process whose PID the lock holds still runs. A lock whose PID is not written yet counts as held. */
function isHolderAlive(lock: string): boolean {
  const pid = Number(readFileSync(lock, 'utf-8'));
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Fetches each `reference` repo of `related` the way a tool call does, so the round's tool servers reuse the checkout,
 * and returns those fetched. One that fails is left out, and the round record says why.
 */
export async function fetchReferenceRepos(related: RelatedRepoTools, options: RelatedRepoLoaderOptions = {}): Promise<ReferenceCheckout[]> {
  const load = relatedRepoLoader(related, { log: message => core.info(message), ...options });
  const fetched = await Promise.allSettled(related.repos.filter(r => r.kind === 'reference').map(async ({ repo }) => ({ repo, dir: await load(repo) })));
  return fetched.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
}

/**
 * Returns the guide file at the root of each of `checkouts` that has one, by `owner/name`, or `undefined` when none
 * has. Only a regular file counts, so a guide is never a link that leaves the checkout.
 */
export function relatedRepoGuides(checkouts: ReferenceCheckout[]): Record<string, string> | undefined {
  const guides = checkouts.flatMap(({ repo, dir }) => {
    const guide = GUIDE_FILES.find(name => lstatSync(join(dir, name), { throwIfNoEntry: false })?.isFile());
    return guide ? [[repo, guide]] : [];
  });
  return guides.length > 0 ? Object.fromEntries(guides) : undefined;
}

/** Returns the checkout directory of each related repo a tool server of the round in `stateDir` fetched, by `owner/name`. */
export function fetchedRelatedRepos(stateDir: string): Map<string, string> {
  const done = readdirSync(stateDir).filter(f => f.endsWith('.done'));
  return new Map(done.map(f => [decodeURIComponent(f.slice(0, -'.done'.length)), readFileSync(join(stateDir, f), 'utf-8')]));
}

const MAX_REASON_CHARS = 300;

/**
 * Returns how each of `repos` fared in the round in `stateDir`: fetched, failed with the reason, or unused when no tool
 * call named it, with how long a fetch took from its lock to its outcome, and the guide of `guides` the finders were
 * pointed to. Warns about each repo it could not fetch.
 */
export function relatedRepoOutcomes(repos: RelatedRepo[], stateDir: string, guides: Record<string, string> = {}): RoundRelatedRepo[] {
  const files = new Set(readdirSync(stateDir));
  return repos.map(({ repo, ref }) => {
    const marker = encodeURIComponent(repo);
    const base = { repo, ...(ref && { ref }), ...(guides[repo] && { guide: guides[repo] }) };
    if (!files.has(`${marker}.lock`)) return { ...base, status: 'unused' as const };
    const took = (outcome: string) => ({ durationMs: Math.max(0, Math.round(statSync(join(stateDir, outcome)).mtimeMs - statSync(join(stateDir, `${marker}.lock`)).mtimeMs)) });
    if (files.has(`${marker}.done`)) return { ...base, status: 'fetched' as const, ...took(`${marker}.done`) };
    const failed = files.has(`${marker}.failed`);
    const reason = failed ? readFileSync(join(stateDir, `${marker}.failed`), 'utf-8') : 'the fetch never finished';
    core.warning(`Could not fetch related repo ${repo}, which must be public on github.com: ${reason}`);
    return { ...base, status: 'failed' as const, reason: reason.slice(0, MAX_REASON_CHARS), ...(failed && took(`${marker}.failed`)) };
  });
}

/**
 * Fetches one commit of `repo`, with only its `paths` and `GUIDE_FILES`, into its directory under `cacheDir`, reusing the objects of a
 * clone already there, and returns that directory. Throws when it cannot be fetched in time, as a private or missing
 * repo cannot.
 */
async function checkoutRelatedRepo(repo: RelatedRepo, cacheDir: string, timeoutMs: number, run: typeof runTool, log: (message: string) => void): Promise<string> {
  const dir = resolve(cacheDir, ...repo.repo.split('/'));
  if (!dir.startsWith(resolve(cacheDir) + sep)) throw new Error('not an "owner/name" repo');
  const deadline = Date.now() + timeoutMs;
  const git = async (...args: string[]): Promise<void> => {
    const remaining = deadline - Date.now();
    const { code, stderr } = remaining > 0
      ? await run('git', args, dir, { env: gitEnv(GIT_CONFIG), timeoutMs: remaining })
      : { code: -1, stderr: '' };
    if (code === 0) return;
    if (Date.now() >= deadline) throw new Error(`git did not finish within ${timeoutMs / 1000}s`);
    throw new Error(stderr.trim().split('\n').filter(line => !line.startsWith('notice:')).at(-1) || `\`git ${args.find(arg => /^[a-z][a-z-]*$/.test(arg))}\` exited with ${code}`);
  };
  const init = async (): Promise<void> => {
    removeQuietly(dir, log);
    // A restored `.git` left in place would bring its own config into `git init`.
    if (lstatSync(dir, { throwIfNoEntry: false })) throw new Error(`could not remove ${dir}`);
    mkdirSync(dir, { recursive: true });
    await git('init', '-q');
    await git('remote', 'add', 'origin', `https://github.com/${repo.repo}.git`);
  };
  try {
    // A symlink restored from the cache could point the clone outside it.
    removeUnlessRealDirectory(cacheDir, log);
    removeUnlessRealDirectory(dirname(dir), log);
    await initReusingObjects(dir, init, git, log);
    await git(...(repo.paths ? ['sparse-checkout', 'set', '--no-cone', ...[...GUIDE_FILES, ...repo.paths].map(sparsePattern)] : ['sparse-checkout', 'disable']));
    await git('fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', repo.ref ?? 'HEAD');
    await git('checkout', '-q', '--force', '--detach', 'FETCH_HEAD');
    // With no refs to negotiate from, the fetch sends every tree of a new commit again. Repacking keeps one copy in the cache.
    await git('repack', '-a', '-d', '-q').catch(error => log(`Could not repack ${dir}: ${messageOf(error)}`));
    log(`Fetched related repo ${repo.repo}${repo.ref ? ` at ${repo.ref}` : ''}`);
    return dir;
  } catch (error) {
    if ([cacheDir, dirname(dir)].every(isRealDirectory)) removeQuietly(dir, log);
    throw error;
  }
}

/**
 * Makes `dir` a new repository with `init`. Of a clone restored from the cache it keeps only the object store, and only
 * once `git fsck` finds every object intact. Whoever can write the cache can write the rest of `.git`, such as its config.
 */
async function initReusingObjects(
  dir: string, init: () => Promise<void>, git: (...args: string[]) => Promise<void>, log: (message: string) => void,
): Promise<void> {
  const objects = join(dir, '.git', 'objects');
  // `@` cannot occur in a repo name, so the stash never collides with another repo's directory.
  const stash = `${dir}@objects`;
  removeQuietly(stash, log);
  // A symlink in the store could make git read or write outside the cache directory.
  const restored = [dir, join(dir, '.git')].every(isRealDirectory) && isPlainTree(objects);
  if (restored) renameSync(objects, stash);
  await init();
  if (!restored) return;
  rmSync(objects, { recursive: true, force: true });
  renameSync(stash, objects);
  rmSync(join(objects, 'info'), { recursive: true, force: true });
  try {
    // The store comes from a blobless clone, so fsck must not report its missing blobs as damage.
    await git('-c', 'remote.origin.promisor=true', '-c', 'remote.origin.partialclonefilter=blob:none', 'fsck', '--no-dangling', '--no-progress');
  } catch (error) {
    log(`Discarding the cached objects of ${dir}: ${messageOf(error)}`);
    await init();
  }
}

/** Removes `path` when it exists and is not a real directory, and throws when that fails. */
function removeUnlessRealDirectory(path: string, log: (message: string) => void): void {
  if (!lstatSync(path, { throwIfNoEntry: false }) || isRealDirectory(path)) return;
  removeQuietly(path, log);
  if (lstatSync(path, { throwIfNoEntry: false })) throw new Error(`could not remove ${path}`);
}

function isRealDirectory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/** Whether `path` is a real directory that holds only regular files and real directories, at any depth. */
function isPlainTree(path: string): boolean {
  return isRealDirectory(path) && readdirSync(path, { withFileTypes: true, recursive: true }).every(entry => entry.isFile() || entry.isDirectory());
}

/** Removes `path`, logging instead of throwing, since a git process killed on timeout can still hold files in it. */
function removeQuietly(path: string, log: (message: string) => void): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  } catch (error) {
    log(`Could not remove ${path}: ${messageOf(error)}`);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Anchors a configured path at the repo root, since a sparse checkout pattern without a leading `/` matches at any depth. */
function sparsePattern(path: string): string {
  return `/${path.replace(/^(\.\/)+/, '')}`;
}
