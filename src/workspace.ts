import { execFile } from 'child_process';
import { rmSync } from 'fs';
import { devNull } from 'os';
import { promisify } from 'util';

import { makeScratchDir } from './tool-install';
import { SYSTEM_ENV } from './utils';

const execFileAsync = promisify(execFile);

/** How many commits of history a workspace holds. */
export const WORKSPACE_DEPTH = 500;

const GIT_TIMEOUT_MS = 300_000;
// A local review reads a whole `git diff` before `exclude_paths` drops lockfiles and generated files.
const GIT_MAX_BUFFER = 512 * 1024 * 1024;

/**
 * Returns the environment for git: no global or system config, so no credential helper, hook path or LFS filter of
 * the runner applies, no prompt, and the `config` entries passed through `GIT_CONFIG_*`.
 */
export function gitEnv(config: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' };
  for (const key of [...SYSTEM_ENV, 'HOME']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const entries = Object.entries(config);
  env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([key, value], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = key;
    env[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  return env;
}

/** Runs git in `dir` with `gitEnv` and returns what it printed. */
export async function runGit(dir: string, args: string[], env = gitEnv()): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
  return stdout;
}

/**
 * Fetches commit `sha` of the repo at `url`, with `WORKSPACE_DEPTH` commits of history, into a new directory, checks
 * it out and returns the directory. `token` authenticates the fetch only: it reaches git through the environment, so
 * it is never written to the repo's config or shown on a command line.
 */
export async function fetchWorkspace(url: string, sha: string, token?: string): Promise<string> {
  const dir = makeScratchDir('repo');
  const git = (args: string[], env = gitEnv()) => runGit(dir, args, env);
  const auth: Record<string, string> = token ? { 'http.extraHeader': `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {};
  try {
    await git(['init', '-q']);
    await git(['fetch', '-q', '--no-tags', `--depth=${WORKSPACE_DEPTH}`, url, sha], gitEnv(auth));
    // Symlinks are checked out as plain files holding their target, so none of them points out of the workspace.
    await git(['-c', 'core.symlinks=false', 'checkout', '-q', '--detach', sha]);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dir;
}
