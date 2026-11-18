import { randomBytes } from 'crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, unwatchFile, watchFile, writeFileSync, writeSync } from 'fs';
import { homedir, hostname } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';

import * as core from '@actions/core';

import { checkAuthFields, pause, registerAuthFileSecrets } from './cli-utils';

const INPUT = 'openai_oauth_file';
const LOGIN_FIELDS = {
  inputName: INPUT,
  requiredFields: ['tokens.access_token', 'tokens.refresh_token'],
  bootstrapHint: 'Create it with `codex login` under a Codex home of its own, as docs/getting-started.md describes.',
};

// Codex 0.166.0 renews the login before a request once its access token expires within 5 minutes, so a call that
// starts with more than its time limit and this margin left never renews unless a request is refused.
const RENEWAL_MARGIN_MS = 10 * 60_000;
const POLL_MS = 500;
// How often the home's login file is checked for tokens Codex renewed during a call.
const WATCH_MS = 1000;

/** Who holds the lock of a login file: a process, named so that another process can tell whether it still runs. */
interface Holder {
  host: string;
  /** The PID namespace on Linux, since a PID means nothing in another container. Empty elsewhere. */
  ns: string;
  pid: number;
  id: string;
}

function pidNamespace(): string {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return '';
  }
}

const me: Holder = { host: hostname(), ns: pidNamespace(), pid: process.pid, id: randomBytes(8).toString('hex') };

/** How this process uses one login file. */
interface LoginFileState {
  path: string;
  lock: string;
  /** The login file inside Codex's home, which the calls of this process share. */
  homeFile?: string;
  /** Whether this process holds the lock, and so has copied the file into the home. */
  held: boolean;
  /** The content of the file as this process last read or wrote it. */
  synced?: string;
  /** Set once the file changed outside Manki, so nothing is written back over it. */
  keepFile?: boolean;
  running: number;
  waiting: number;
  aloneRunning: boolean;
  aloneWaiting: number;
  watcher?: () => void;
}

const states = new Map<string, LoginFileState>();

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether `path` is `root` or inside it, comparing real paths. A root that does not exist holds nothing. */
function isInside(path: string, root: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return false;
  }
  const rel = relative(realRoot, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Throws unless this user owns the entry `stats` describes and no other user can read or write it. */
function checkOwnEntry(stats: { uid: number; mode: number }, what: string, fix: string): void {
  if (stats.uid !== process.getuid!()) throw new Error(`${INPUT}: ${what} belongs to another user. ${fix}`);
  if ((stats.mode & 0o077) !== 0) {
    throw new Error(`${INPUT}: other users can read or write ${what} (mode ${(stats.mode & 0o777).toString(8)}). ${fix}`);
  }
}

/**
 * Throws unless the login file at `path` is one Manki may use: an absolute path to a regular file, not a link, in a
 * folder that is not a link either, both owned by this user and closed to every other user, and outside the workspace,
 * the runner's temp folder, the working folder and the runner user's own Codex home.
 */
export function checkLoginFilePath(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform === 'win32' || process.getuid === undefined) {
    throw new Error(`${INPUT} is not supported on Windows, since Manki cannot check there who can read the file. Use openai_oauth_token instead.`);
  }
  if (!isAbsolute(path)) throw new Error(`${INPUT} must be an absolute path, such as /home/runner/.manki-codex/auth.json.`);
  const folder = dirname(path);
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) throw new Error(`${INPUT}: ${path} does not exist. ${LOGIN_FIELDS.bootstrapHint}`);
  if (file.isSymbolicLink()) throw new Error(`${INPUT}: ${path} is a symbolic link. Name the file itself.`);
  if (!file.isFile()) throw new Error(`${INPUT}: ${path} is not a regular file.`);
  const dir = lstatSync(folder);
  if (dir.isSymbolicLink()) throw new Error(`${INPUT}: the folder ${folder} is a symbolic link. Name the file by its real folder.`);
  checkOwnEntry(file, path, `Run \`chmod 600 ${path}\` as the runner's user.`);
  checkOwnEntry(dir, `the folder ${folder}`, `Run \`chmod 700 ${folder}\` as the runner's user.`);
  const realFolder = realpathSync(folder);
  const forbidden: [string | undefined, string][] = [
    [env.GITHUB_WORKSPACE, 'the workspace (GITHUB_WORKSPACE), where the checked-out code and every step of the job can read it'],
    [env.RUNNER_TEMP, "the runner's temp folder (RUNNER_TEMP), which holds Manki's checkout of the pull request and is emptied after each job"],
    [process.cwd(), 'the working folder, which holds the checked-out code'],
    [env.CODEX_HOME || join(homedir(), '.codex'), "the runner user's own Codex home, where a Codex the user runs would renew the login while Manki uses it"],
  ];
  for (const [root, what] of forbidden) {
    if (root && isInside(realFolder, resolve(root))) throw new Error(`${INPUT}: ${path} is inside ${what}. Keep the login file in a folder of its own outside it.`);
  }
}

/** Reads the login file at `path` through no link, and checks again that only this user can read or write it. */
function readLoginFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`${INPUT}: ${path} is not a regular file.`);
    checkOwnEntry(stats, path, `Run \`chmod 600 ${path}\` as the runner's user.`);
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** Parses `text` as a Codex login and throws unless it holds both tokens. */
function parseLogin(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${INPUT} is not JSON. ${LOGIN_FIELDS.bootstrapHint}`);
  }
  checkAuthFields(parsed, LOGIN_FIELDS);
  return parsed as Record<string, unknown>;
}

/** Returns the expiry of the access token in the Codex login `text`, in milliseconds, or `undefined` when it has none. */
function accessExpiry(text: string): number | undefined {
  try {
    const token = (JSON.parse(text) as { tokens?: { access_token?: unknown } }).tokens?.access_token;
    if (typeof token !== 'string') return undefined;
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** Whether Codex may renew the login in `homeFile` during a call of up to `limitMs`. Without a readable expiry it may. */
function mayRenew(homeFile: string, limitMs: number): boolean {
  let text: string;
  try {
    text = readFileSync(homeFile, 'utf8');
  } catch {
    return true;
  }
  const expiry = accessExpiry(text);
  return expiry === undefined || expiry - Date.now() <= limitMs + RENEWAL_MARGIN_MS;
}

function readHolder(lock: string): Holder | undefined {
  try {
    const fd = openSync(lock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const holder = JSON.parse(readFileSync(fd, 'utf8')) as Holder;
      return typeof holder.pid === 'number' && typeof holder.id === 'string' ? holder : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** Whether the process `holder` names has stopped. Only a holder on this host in this PID namespace can be told. */
function holderStopped(holder: Holder): boolean {
  if (holder.host !== me.host || holder.ns !== me.ns) return false;
  // An earlier process with this PID left the lock, since this process never writes another id.
  if (holder.pid === me.pid) return holder.id !== me.id;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Removes the lock a stopped process left. A second file serializes the removal, so a process that judged the same
 * holder stopped cannot remove a lock another process took meanwhile.
 */
function removeStoppedLock(lock: string, stopped: Holder): void {
  const removal = `${lock}.removing`;
  try {
    closeSync(openSync(removal, 'wx', 0o600));
  } catch {
    return;
  }
  try {
    if (readHolder(lock)?.id === stopped.id) rmSync(lock);
  } finally {
    rmSync(removal, { force: true });
  }
}

/** Takes the lock of `state` when it is free or its holder stopped. Returns whether this process holds it now. */
function tryLock(state: LoginFileState): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(state.lock, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify(me));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const holder = readHolder(state.lock);
    if (!holder || !holderStopped(holder)) return false;
    removeStoppedLock(state.lock, holder);
  }
  return false;
}

function unlock(state: LoginFileState): void {
  if (readHolder(state.lock)?.id === me.id) rmSync(state.lock, { force: true });
}

/**
 * Writes the login Codex renewed in the home back to the file, through a new file in the same folder and a rename, so
 * a crash never leaves half a login. A home file Codex is still writing does not parse and waits for the next look.
 * A file changed outside Manki is never written over.
 */
function writeBack(state: LoginFileState): void {
  if (!state.held || !state.homeFile || state.keepFile) return;
  let text: string;
  try {
    text = readFileSync(state.homeFile, 'utf8');
    if (text === state.synced) return;
    parseLogin(text);
  } catch {
    return;
  }
  let temp: string | undefined;
  try {
    if (readLoginFile(state.path) !== state.synced) {
      state.keepFile = true;
      core.warning(`${state.path} changed while this run used it, so Manki does not write the login Codex renewed over it. If Codex fails to sign in next time, run codex login again.`);
      return;
    }
    temp = join(dirname(state.path), `.${basename(state.path)}.${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, state.path);
    temp = undefined;
    state.synced = text;
    core.info(`Wrote the Codex login that Codex renewed back to ${state.path}`);
  } catch (error) {
    core.warning(`Codex renewed the login, but Manki could not write it back to ${state.path}: ${message(error)}. The file now holds tokens that no longer work. Run codex login again.`);
  } finally {
    if (temp) rmSync(temp, { force: true });
  }
}

/** Copies the login file into the home once this process holds the lock, and watches the home for a renewal. */
function copyIn(state: LoginFileState, homeFile: string): void {
  checkLoginFilePath(state.path);
  const text = readLoginFile(state.path);
  parseLogin(text);
  writeFileSync(homeFile, text, { mode: 0o600 });
  registerAuthFileSecrets(homeFile);
  state.homeFile = homeFile;
  state.synced = text;
  state.keepFile = false;
  const listener = (): void => writeBack(state);
  watchFile(homeFile, { interval: WATCH_MS, persistent: false }, listener);
  state.watcher = () => unwatchFile(homeFile, listener);
}

/** Writes back what is left and gives the lock up once no call of this process runs or waits. */
function releaseIfIdle(state: LoginFileState): void {
  if (!state.held || state.running > 0 || state.waiting > 0) return;
  state.watcher?.();
  state.watcher = undefined;
  writeBack(state);
  state.held = false;
  unlock(state);
}

function stateOf(path: string): LoginFileState {
  let state = states.get(path);
  if (!state) {
    // Runs before the home is removed on exit, so a renewal in a call that a cancelled run cut short is not lost.
    if (states.size === 0) process.prependOnceListener('exit', () => states.forEach(exiting => {
      exiting.waiting = 0;
      exiting.running = 0;
      releaseIfIdle(exiting);
    }));
    state = { path, lock: `${path}.lock`, held: false, running: 0, waiting: 0, aloneRunning: false, aloneWaiting: 0 };
    states.set(path, state);
  }
  return state;
}

/**
 * Runs `run`, a Codex call that reads the login from `homeFile`, with the login file at `path`, and waits at most
 * `limitMs` for its turn. The process holds the file's lock while any of its calls runs, since Codex renews whenever a
 * request is refused, and a renewal makes every other copy of the login fail. A call that may renew runs alone.
 */
export async function withLoginFile<T>(path: string, homeFile: string, { limitMs, signal }: { limitMs: number; signal?: AbortSignal }, run: () => Promise<T>): Promise<T> {
  const state = stateOf(path);
  const deadline = Date.now() + limitMs;
  let alone: boolean | undefined;
  let queuedAlone = false;
  state.waiting++;
  try {
    for (;;) {
      if (!state.held && tryLock(state)) {
        try {
          copyIn(state, homeFile);
        } catch (error) {
          unlock(state);
          throw error;
        }
        state.held = true;
      }
      if (state.held) {
        alone ??= mayRenew(homeFile, limitMs);
        if (alone ? state.running === 0 : !state.aloneRunning && state.aloneWaiting === 0) break;
        if (alone && !queuedAlone) {
          queuedAlone = true;
          state.aloneWaiting++;
        }
      }
      if (Date.now() >= deadline) {
        const holder = state.held ? undefined : readHolder(state.lock);
        throw new Error(state.held
          ? `A Codex call waited ${limitMs / 1000}s for other calls of this run to end, since a call that may renew the login of ${INPUT} runs alone.`
          : `A Codex call waited ${limitMs / 1000}s for the lock ${state.lock} of ${INPUT}${holder ? `, held by process ${holder.pid} on ${holder.host}` : ''}. Another review on this runner uses the login. If none runs, delete the lock.`);
      }
      await pause(POLL_MS, signal);
    }
  } catch (error) {
    state.waiting--;
    if (queuedAlone) state.aloneWaiting--;
    try {
      releaseIfIdle(state);
    } catch (releaseError) {
      core.warning(`Could not give up the lock ${state.lock}: ${message(releaseError)}`);
    }
    throw error;
  }
  state.waiting--;
  if (queuedAlone) state.aloneWaiting--;
  state.running++;
  if (alone) state.aloneRunning = true;
  try {
    return await run();
  } finally {
    state.running--;
    if (alone) state.aloneRunning = false;
    writeBack(state);
    releaseIfIdle(state);
  }
}
