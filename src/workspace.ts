import { execFile } from 'child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { devNull } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import * as core from '@actions/core';

import { findClosedPattern } from './diff';
import { makeScratchDir } from './tool-install';
import { safeJsonParse, SYSTEM_ENV } from './utils';

const execFileAsync = promisify(execFile);

/** How many commits of history a workspace holds. */
export const WORKSPACE_DEPTH = 500;

/** The ref of a workspace that points at the PR's base commit, which `read_file` reads with `ref` set to `base`. */
export const BASE_REF = 'refs/manki/base';

/** The file in a workspace's `.git` that holds the `exclude_paths` a read at the base refuses. Without it nothing is read there. */
export const BASE_READS_FILE = 'manki-base-reads.json';

/** The commit a PR's diff starts from, and the `exclude_paths` the tools may not read there. */
export interface WorkspaceBase {
  sha: string;
  excludePaths: readonly string[];
}

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
 * it out without the paths `closedPaths` closes and returns the directory. `token` authenticates the fetch only: it
 * reaches git through the environment, so it is never written to the repo's config or shown on a command line. With
 * `base`, the workspace also holds that commit for reads at the base, by `addBase`.
 */
export async function fetchWorkspace(
  url: string, sha: string, token?: string, closedPaths: readonly string[] = [], base?: WorkspaceBase,
): Promise<string> {
  const dir = makeScratchDir('repo');
  const git = (args: string[], env = gitEnv()) => runGit(dir, args, env);
  const auth: Record<string, string> = token ? { 'http.extraHeader': `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : {};
  try {
    await git(['init', '-q']);
    await git(['fetch', '-q', '--no-tags', `--depth=${WORKSPACE_DEPTH}`, url, sha], gitEnv(auth));
    // Symlinks are checked out as plain files holding their target, so none of them points out of the workspace.
    await git(['-c', 'core.symlinks=false', 'checkout', '-q', '--detach', sha]);
    await closePaths(dir, closedPaths);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  if (base) await addBase(dir, url, base, gitEnv(auth));
  return dir;
}

/**
 * Returns the `exclude_paths` a read at the base of the workspace `dir` refuses, or `undefined` when it holds no base.
 * One whose list cannot be read holds none, so no read at the base runs without that list.
 */
export function baseReadsOf(dir: string): string[] | undefined {
  try {
    const { excludePaths } = (safeJsonParse(readFileSync(join(dir, '.git', BASE_READS_FILE), 'utf8')) ?? {}) as Record<string, unknown>;
    return Array.isArray(excludePaths) && excludePaths.every(p => typeof p === 'string') ? excludePaths : undefined;
  } catch {
    return undefined;
  }
}

/** The file in a checkout's `.git` that keeps the patterns `closePaths` closed and the paths it removed, for the tool server. */
const CLOSED_PATHS_FILE = 'manki-closed-paths.json';

/** What `closePaths` keeps in `CLOSED_PATHS_FILE`. */
interface ClosedRecord {
  patterns: string[];
  /** Each path it deleted from the checkout or dropped from the index, relative to the checkout. */
  removed: string[];
  /** The removed paths that git held as submodules, whose files no listing of the checkout shows. */
  submodules: string[];
}

/**
 * Deletes every file and folder of the checkout at `dir` that `closedPaths` closes, every symlink, whose target could be
 * closed, and the folders that leaves empty, so no tool that reads the checkout finds them. Drops the closed files from
 * the index too, so no tool that lists tracked files names them. Keeps the patterns and the removed paths in `.git`
 * for `closedPathsOf` and `removedPathsOf`.
 */
export async function closePaths(dir: string, closedPaths: readonly string[]): Promise<void> {
  if (closedPaths.length === 0) return;
  const removed = new Set<string>();
  // Returns whether deleting closed paths left the folder `rel` empty.
  const close = (rel: string): boolean => {
    let emptied = false;
    let left = 0;
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (path === '.git') {
        left++;
      } else if (entry.isSymbolicLink() || findClosedPattern(path, closedPaths) || (entry.isDirectory() && close(path))) {
        if (entry.isDirectory()) for (const below of readdirSync(join(dir, path), { recursive: true, encoding: 'utf8' })) removed.add(`${path}/${below}`);
        rmSync(join(dir, path), { recursive: true, force: true });
        removed.add(path);
        emptied = true;
      } else {
        left++;
      }
    }
    return emptied && left === 0;
  };
  close('');
  // The git directory is named, so a checkout without one fails instead of changing a repository above it.
  const git = (args: string[]) => runGit(dir, ['--git-dir', join(dir, '.git'), '--work-tree', dir, '--literal-pathspecs', ...args]);
  // Each entry is `<mode> <object> <stage>\t<path>`, and mode `160000` is a submodule.
  const gitlinks = (await git(['ls-files', '-s', '-z'])).split('\0').filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1));
  const indexed = (await git(['ls-files', '-z'])).split('\0').filter(path => path && findClosedPattern(path, closedPaths));
  for (const path of indexed) removed.add(path);
  if (indexed.length > 0) {
    const list = join(dir, '.git', 'manki-closed-index');
    writeFileSync(list, `${indexed.join('\0')}\0`);
    try {
      await git(['rm', '--cached', '-f', '-q', '--pathspec-from-file', list, '--pathspec-file-nul']);
    } finally {
      rmSync(list, { force: true });
    }
  }
  const record: ClosedRecord = { patterns: [...closedPaths], removed: [...removed].sort(), submodules: gitlinks.filter(path => removed.has(path)).sort() };
  writeFileSync(join(dir, '.git', CLOSED_PATHS_FILE), JSON.stringify(record));
}

/** Returns what `closePaths` kept for the checkout at `dir`, or nothing removed for a checkout it never closed. */
function closedRecordOf(dir: string): ClosedRecord {
  const file = join(dir, '.git', CLOSED_PATHS_FILE);
  if (!existsSync(file)) return { patterns: [], removed: [], submodules: [] };
  const record: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(p => typeof p === 'string');
  if (typeof record !== 'object' || record === null || !strings((record as ClosedRecord).patterns) || !strings((record as ClosedRecord).removed) || !strings((record as ClosedRecord).submodules)) {
    throw new Error(`${file} does not list the closed paths`);
  }
  return record as ClosedRecord;
}

/** Returns the patterns `closePaths` removed from the checkout at `dir`, or none for a checkout it never closed. */
export function closedPathsOf(dir: string): string[] {
  return closedRecordOf(dir).patterns;
}

/**
 * Returns each path `closePaths` deleted from the checkout at `dir` or dropped from its index, or none for a checkout
 * it never closed. Throws when the record cannot be read.
 */
export function removedPathsOf(dir: string): string[] {
  return closedRecordOf(dir).removed;
}

/** Returns each path `closePaths` removed from the checkout at `dir` that git held as a submodule. Throws when the record cannot be read. */
export function removedSubmodulesOf(dir: string): string[] {
  return closedRecordOf(dir).submodules;
}

/**
 * Points `BASE_REF` of the workspace `dir` at the base commit, then writes the `exclude_paths` a read there refuses.
 * The base is usually in the history the workspace already holds, so it is fetched from `url` only when it is not, as
 * that one commit. A base that cannot be had leaves the workspace without one, so the tools read only the head.
 */
async function addBase(dir: string, url: string, { sha, excludePaths }: WorkspaceBase, fetchEnv: NodeJS.ProcessEnv): Promise<void> {
  try {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) throw new Error('it is no full commit id');
    const held = await runGit(dir, ['cat-file', '-e', `${sha}^{commit}`]).then(() => true, () => false);
    if (!held) await runGit(dir, ['fetch', '-q', '--no-tags', '--depth=1', url, sha], fetchEnv);
    await runGit(dir, ['update-ref', BASE_REF, sha]);
    // Written last, since `baseReadsOf` takes the file as the sign that the ref is set.
    writeFileSync(join(dir, '.git', BASE_READS_FILE), JSON.stringify({ excludePaths }));
  } catch (error) {
    core.warning(`Could not fetch the PR's base commit ${sha.slice(0, 7)}, so the tools read only the head: ${error instanceof Error ? error.message : String(error)}`);
  }
}
