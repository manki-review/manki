import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeSync } from 'fs';
import { homedir, hostname } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';

import * as core from '@actions/core';

import { checkAuthFields, HARD_TIMEOUT_MS, pause, registerAuthFileSecrets } from './cli-utils';

const INPUT = 'openai_oauth_file';
const LOGIN_FIELDS = {
  inputName: INPUT,
  requiredFields: ['tokens.access_token', 'tokens.refresh_token'],
  bootstrapHint: 'Create it with `codex login` under a Codex home of its own, as docs/getting-started.md describes.',
};

// Codex 0.166.0 renews the login before a request once its access token expires within 5 minutes. A call that starts
// with more than its time limit and this margin left never renews unless a request is refused.
const RENEWAL_MARGIN_MS = 10 * 60_000;
const POLL_MS = 250;
// How often a running call looks for a renewal in Codex's home or in the file.
const SYNC_MS = 1000;
const RENEWAL_TIMEOUT_MS = 60_000;
// Removing a stopped holder's lock takes a moment, so a removal marker this old was left by a process that stopped.
const STALE_REMOVAL_MS = 60_000;

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
  /** The login as this process last copied it into the home or wrote it to the file. */
  synced?: string;
  running: number;
  /** The cause of the last warning, so a failure that repeats on every look warns once. */
  warned?: string;
  renewal?: Renewal;
  timer?: NodeJS.Timeout;
}

/** A renewal before a call, which the calls of this process that need one share. */
interface Renewal {
  done: Promise<void>;
  /** The longest time limit of the calls that wait, which decides whether a renewal is still due. */
  limitMs: number;
  waiters: number;
  /** Ends the wait for the lock once no call waits any more. A renewal that holds the lock always finishes. */
  stop: AbortController;
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
  if (accessExpiry(text) === undefined) throw new Error(`${INPUT}: the access token has no expiry Manki can read, so Manki cannot tell when Codex renews it. ${LOGIN_FIELDS.bootstrapHint}`);
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

/** Whether Codex may renew the login `text` during a call of up to `limitMs`. */
function isDue(text: string, limitMs: number): boolean {
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
  if (Date.now() - (statSync(removal, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > STALE_REMOVAL_MS) rmSync(removal, { force: true });
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

/**
 * Takes the lock of `state` when it is free or its holder stopped. Returns whether this process holds it now. The lock
 * is linked into place complete, so a process that stops while it takes the lock never leaves an empty one.
 */
function tryLock(state: LoginFileState): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    const temp = writeTemp(state.lock, JSON.stringify(me));
    try {
      linkSync(temp, state.lock);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    } finally {
      rmSync(temp, { force: true });
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

function readQuietly(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function isLogin(text: string | undefined): text is string {
  try {
    return text !== undefined && !!parseLogin(text);
  } catch {
    return false;
  }
}

/** Writes `text` to a new file beside `path`, readable only by this user, and returns its name. */
function writeTemp(path: string, text: string): string {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return temp;
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Writes `text` to `path` through a new file in the same folder and a rename, so no reader ever sees half a login. */
function writeWhole(path: string, text: string): void {
  const temp = writeTemp(path, text);
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Brings Codex's home and the file together without waiting. A login Codex renewed in the home is written to the file,
 * under the lock, and only while the file still holds the login it was renewed from, so the file never goes back to a
 * used refresh token. Until that write succeeds, the home keeps the renewal and nothing is copied over it. A login
 * another run wrote to the file is copied into the home while the home holds no renewal of its own, so a running Codex
 * reads it when a request is refused instead of renewing a used refresh token. A home file Codex is still writing does
 * not parse and waits for the next look. `locked` says this process holds the lock already.
 */
function sync(state: LoginFileState, locked = false): void {
  const { homeFile } = state;
  if (!homeFile) return;
  const home = readQuietly(homeFile);
  if (home !== undefined && state.synced !== undefined && home !== state.synced && isLogin(home)) {
    let took = false;
    try {
      if (!locked && !(took = tryLock(state))) return;
      if (readLoginFile(state.path) === state.synced) {
        writeWhole(state.path, home);
        core.info(`Wrote the Codex login that Codex renewed back to ${state.path}`);
      } else {
        core.info(`${state.path} changed since this run read it, so Manki keeps it and does not write the login Codex renewed over it.`);
      }
      state.synced = home;
      state.warned = undefined;
    } catch (error) {
      warnOnce(state, 'write', error, `Codex renewed the login, but Manki could not write it back to ${state.path}: ${message(error)}. Manki tries again while this run lasts. If Codex fails to sign in next time, run codex login again.`);
    } finally {
      if (took) unlock(state);
    }
    return;
  }
  const file = readLoginFile(state.path);
  if (home === undefined || (file !== state.synced && (home === state.synced || state.synced === undefined))) {
    parseLogin(file);
    writeWhole(homeFile, file);
    registerAuthFileSecrets(homeFile);
    state.synced = file;
  }
}

/** Warns about `error` unless the last warning had the same cause, since a look that fails fails again a second later. */
function warnOnce(state: LoginFileState, what: string, error: unknown, text: string): void {
  const cause = `${what}:${(error as NodeJS.ErrnoException).code ?? message(error)}`;
  if (state.warned === cause) return;
  state.warned = cause;
  core.warning(text);
}

/** How Manki starts the Codex CLI: its path and environment, whose `CODEX_HOME` is the home that `homeFile` is in. */
export interface CodexRunner {
  cliPath: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Has Codex renew the login in its home now, with the app server's `account/read` and `refreshToken`, which renews
 * whatever the token's expiry. Codex writes the renewed login to the home only once the server took the refresh token.
 */
async function renewInHome({ cliPath, env }: CodexRunner, home: string): Promise<void> {
  const child = spawn(cliPath, ['app-server', '-c', 'analytics.enabled=false', '-c', 'features.plugins=false', '-c', 'features.apps=false'], { cwd: home, env, stdio: ['pipe', 'pipe', 'ignore'] });
  await new Promise<void>(done => {
    let stdout = '';
    const timer = setTimeout(() => child.kill(), RENEWAL_TIMEOUT_MS);
    child.on('error', () => done());
    child.on('close', () => {
      clearTimeout(timer);
      done();
    });
    // The app server works on its requests until stdin ends, so stdin stays open until the answer to `account/read`.
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      if (/"id":2[,}]/.test(stdout)) child.stdin.end();
    });
    child.stdin.on('error', () => undefined);
    child.stdin.write([
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'manki', version: '1' } } },
      { method: 'initialized' },
      { id: 2, method: 'account/read', params: { refreshToken: true } },
    ].map(message => `${JSON.stringify(message)}\n`).join(''));
  });
}

function lockTimeout(state: LoginFileState, waitedMs: number): Error {
  const holder = readHolder(state.lock);
  const by = holder ? `, held by process ${holder.pid} on ${holder.host}` : ', which names no process Manki can read';
  return new Error(`A Codex call waited ${Math.round(waitedMs / 1000)}s for the lock ${state.lock} of ${INPUT}${by}. Another review on this runner is renewing the login. If none runs, delete the lock.`);
}

/** Waits until this process holds the lock of `state`, and at most until `deadline`. */
async function lock(state: LoginFileState, deadline: number, signal?: AbortSignal): Promise<void> {
  const start = Date.now();
  while (!tryLock(state)) {
    if (Date.now() >= deadline) throw lockTimeout(state, Date.now() - start);
    await pause(Math.min(POLL_MS, Math.max(deadline - Date.now(), 0)), signal);
  }
}

/** Waits for `done`, but at most until `deadline` and until `signal` aborts, without stopping what `done` waits for. */
function waitFor<T>(done: Promise<T>, deadline: number, signal: AbortSignal | undefined, late: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const end = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      end();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      end();
      reject(late());
    }, Math.max(deadline - Date.now(), 0));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    done.then(value => {
      end();
      resolve(value);
    }, (error: unknown) => {
      end();
      reject(error);
    });
  });
}

/**
 * Has Codex renew the login in the file once, with the lock held, so one run renews and the others wait for that
 * renewal only and read the file again. A renewal Codex refuses leaves the file. Waiting for the lock ends after
 * `HARD_TIMEOUT_MS` or once no call waits. Once the lock is held, the renewal is never stopped part way, since Codex
 * killed after the server took the refresh token would lose the only login that still works.
 */
async function renew(state: LoginFileState, renewal: Renewal, runner: CodexRunner): Promise<void> {
  await lock(state, Date.now() + HARD_TIMEOUT_MS, renewal.stop.signal);
  try {
    sync(state, true);
    // Checked once the lock is held, since another run may have renewed meanwhile.
    if (!isDue(readLoginFile(state.path), renewal.limitMs)) return;
    await renewInHome(runner, dirname(state.homeFile!));
    sync(state, true);
  } finally {
    unlock(state);
  }
}

/** Waits for the renewal the calls of this process share, starting it when none runs, at most until `deadline`. */
async function renewBefore(state: LoginFileState, runner: CodexRunner, limitMs: number, deadline: number, signal?: AbortSignal): Promise<void> {
  let renewal = state.renewal;
  if (!renewal) {
    const started: Renewal = { done: Promise.resolve(), limitMs, waiters: 0, stop: new AbortController() };
    started.done = renew(state, started, runner).finally(() => {
      if (state.renewal === started) state.renewal = undefined;
    });
    // A renewal that every call stopped waiting for still settles, with no call left to see how.
    started.done.catch(() => undefined);
    state.renewal = renewal = started;
  }
  renewal.limitMs = Math.max(renewal.limitMs, limitMs);
  renewal.waiters++;
  const start = Date.now();
  try {
    await waitFor(renewal.done, deadline, signal, () => lockTimeout(state, Date.now() - start));
  } finally {
    if (--renewal.waiters === 0) renewal.stop.abort();
  }
}

async function track<T>(state: LoginFileState, run: () => Promise<T>): Promise<T> {
  state.running++;
  state.timer ??= setInterval(() => syncQuietly(state), SYNC_MS).unref();
  try {
    return await run();
  } finally {
    state.running--;
    if (state.running === 0) {
      clearInterval(state.timer);
      state.timer = undefined;
    }
  }
}

/**
 * Runs `run` with the lock held, since Codex may renew during it. The lock also keeps the other such calls of this
 * process out, since a call that holds it is not taken for a stopped one.
 */
async function runLocked<T>(state: LoginFileState, deadline: number, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  await lock(state, deadline, signal);
  try {
    sync(state, true);
    return await track(state, run);
  } finally {
    try {
      syncQuietly(state, true);
    } finally {
      unlock(state);
    }
  }
}

/** Runs `sync` where a failure must not end the run, as on a timer or at exit. */
function syncQuietly(state: LoginFileState, locked = false): void {
  try {
    sync(state, locked);
  } catch (error) {
    warnOnce(state, 'read', error, `Could not compare ${state.path} with the login in Codex's home: ${message(error)}`);
  }
}

function stateOf(path: string): LoginFileState {
  let state = states.get(path);
  if (!state) {
    // Runs before the home is removed on exit, so a renewal in a call that a cancelled run cut short is not lost.
    if (states.size === 0) process.prependOnceListener('exit', () => states.forEach(exiting => syncQuietly(exiting)));
    state = { path, lock: `${path}.lock`, running: 0 };
    states.set(path, state);
  }
  return state;
}

/**
 * Runs `run`, a Codex call that reads the login from `homeFile`, with the login file at `path`. Calls of every run use
 * the login side by side without a lock. Only when Codex could renew during the call does the call first have Codex
 * renew it once under the lock. If that renewal fails, the call runs with the lock held. Waiting for either counts
 * against `limitMs`, which the call's own run then gets the rest of. A renewal after a refused request is written back
 * as it happens.
 */
export async function withLoginFile<T>(
  path: string, homeFile: string, { limitMs, signal, runner }: { limitMs: number; signal?: AbortSignal; runner: CodexRunner }, run: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + limitMs;
  const state = stateOf(path);
  checkLoginFilePath(path);
  if (state.homeFile !== homeFile) state.synced = undefined;
  state.homeFile = homeFile;
  sync(state);
  if (isDue(readLoginFile(path), limitMs)) {
    await renewBefore(state, runner, limitMs, deadline, signal);
    if (isDue(readLoginFile(path), limitMs)) {
      core.warning(`Codex could not renew the login of ${INPUT} before the call, so this call holds the lock of the file while it runs.`);
      return runLocked(state, deadline, signal, run);
    }
  }
  try {
    return await track(state, run);
  } finally {
    syncQuietly(state);
  }
}
