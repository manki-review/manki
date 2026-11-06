import * as core from '@actions/core';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';

import { runTool } from './binary-analyzers';
import { RelatedRepo, RelatedRepoKind } from './types';

const FETCH_TIMEOUT_MS = 120_000;
// Git reads no global or system config and asks for no password, so it never sends a credential and a private repo fails.
const GIT_ENV = { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const GIT_SAFETY = ['-c', 'credential.helper=', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

export interface RelatedRepoCheckout extends RelatedRepo {
  /** Directory holding the fetched files. */
  dir: string;
}

export interface RelatedRepoLoaderOptions {
  /** Directory the repos are cloned into, one `owner/name` directory each. A workflow can keep it between runs with `actions/cache`. */
  cacheDir?: string;
  /** Time limit for fetching one repo. */
  timeoutMs?: number;
  run?: typeof runTool;
}

/** Returns the directory related repos are cloned into: `manki-related-repos` in the runner's temp directory. */
export function relatedReposCacheDir(): string {
  return join(process.env.RUNNER_TEMP || tmpdir(), 'manki-related-repos');
}

/**
 * Returns a function that fetches the related repos of one kind and resolves with those it could read.
 * Nothing is fetched until it is called, and each repo is fetched at most once per loader.
 */
export function relatedRepoLoader(
  repos: RelatedRepo[],
  { cacheDir = relatedReposCacheDir(), timeoutMs = FETCH_TIMEOUT_MS, run = runTool }: RelatedRepoLoaderOptions = {},
): (kind: RelatedRepoKind) => Promise<RelatedRepoCheckout[]> {
  const checkouts = new Map<RelatedRepo, Promise<RelatedRepoCheckout | undefined>>();
  return async kind => {
    const fetched = await Promise.all(repos.filter(r => r.kind === kind).map(repo => {
      let checkout = checkouts.get(repo);
      if (!checkout) {
        checkout = checkoutRelatedRepo(repo, cacheDir, timeoutMs, run);
        checkouts.set(repo, checkout);
      }
      return checkout;
    }));
    return fetched.filter((c): c is RelatedRepoCheckout => c !== undefined);
  };
}

/**
 * Fetches one commit of `repo`, with only its `paths`, into its directory under `cacheDir`, reusing a clone already there.
 * A repo that cannot be fetched in time, such as a private or missing one, is skipped with a warning.
 */
async function checkoutRelatedRepo(repo: RelatedRepo, cacheDir: string, timeoutMs: number, run: typeof runTool): Promise<RelatedRepoCheckout | undefined> {
  const dir = resolve(cacheDir, ...repo.repo.split('/'));
  if (!dir.startsWith(resolve(cacheDir) + sep)) {
    core.warning(`Skipping related repo ${repo.repo}: not an "owner/name" repo`);
    return undefined;
  }
  const deadline = Date.now() + timeoutMs;
  const git = async (...args: string[]): Promise<void> => {
    const remaining = deadline - Date.now();
    const { code, stderr } = remaining > 0
      ? await run('git', [...GIT_SAFETY, ...args], dir, { env: GIT_ENV, timeoutMs: remaining })
      : { code: -1, stderr: '' };
    if (code === 0) return;
    if (Date.now() >= deadline) throw new Error(`git did not finish within ${timeoutMs / 1000}s`);
    throw new Error(stderr.trim().split('\n').at(-1) || `\`git ${args[0]}\` exited with ${code}`);
  };
  try {
    const url = `https://github.com/${repo.repo}.git`;
    if (existsSync(join(dir, '.git'))) {
      await git('remote', 'set-url', 'origin', url);
    } else {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      await git('init', '-q');
      await git('remote', 'add', 'origin', url);
    }
    await git(...(repo.paths ? ['sparse-checkout', 'set', '--no-cone', ...repo.paths.map(sparsePattern)] : ['sparse-checkout', 'disable']));
    await git('fetch', '-q', '--depth', '1', '--filter=blob:none', '--no-tags', 'origin', repo.ref ?? 'HEAD');
    await git('checkout', '-q', '--force', '--detach', 'FETCH_HEAD');
    core.info(`Fetched related repo ${repo.repo}${repo.ref ? ` at ${repo.ref}` : ''}`);
    return { ...repo, dir };
  } catch (error) {
    core.warning(`Skipping related repo ${repo.repo}, which must be public on github.com: ${error instanceof Error ? error.message : String(error)}`);
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
}

/** Anchors a configured path at the repo root, since a sparse checkout pattern without a leading `/` matches at any depth. */
function sparsePattern(path: string): string {
  return `/${path.replace(/^(\.\/)+/, '')}`;
}
