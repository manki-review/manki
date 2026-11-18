import { spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { hostname, tmpdir } from 'os';
import { join, resolve } from 'path';

import * as core from '@actions/core';

import { buildOpenAIAuth, OpenAIClient } from './openai';

// Jest gives a test its own `process.env`, which `execFile` does not read, so `which codex` would find the Codex CLI
// installed on the machine. Every `codex` of these tests is the stand-in below.
const fakeCodex = { path: '' };
jest.mock('util', () => {
  const util = jest.requireActual('util');
  const { execFile } = jest.requireActual('child_process');
  return { ...util, promisify: (fn: unknown) => (fn === execFile ? async () => ({ stdout: fakeCodex.path }) : util.promisify(fn)) };
});

/**
 * A stand-in for the ChatGPT login server: it issues fake tokens, renews them once per refresh token and refuses a
 * refresh token used before, and answers a model request only with the access token it issued last. It records what
 * happened in order in `events`, and names each Codex run by the message it was sent.
 */
/**
 * Lets requests through once `count` of them arrived. A gate that is never filled opens after 15 seconds, so a test
 * whose code took turns fails on what happened in what order rather than on a timeout.
 */
class Gate {
  private arrived = 0;
  private open!: () => void;
  private readonly opened = new Promise<void>(done => { this.open = done; });

  constructor(private readonly count: number) {
    setTimeout(() => this.open(), 15_000).unref();
  }

  arrive(): Promise<void> {
    if (++this.arrived >= this.count) this.open();
    return this.opened;
  }

  passed(): Promise<void> {
    return this.opened;
  }
}

class StandIn {
  gen = 0;
  access = '';
  refresh = '';
  renewals: { given: string; reason: string }[] = [];
  refused: string[] = [];
  answered: string[] = [];
  homes = new Set<string>();
  started: Record<string, number> = {};
  events: string[] = [];
  /** Runs when the stand-in renews, before Codex gets the new tokens. */
  onRenew?: () => void;
  /** Runs when a Codex run starts, before it reads the login. */
  onStart?: () => void;
  /** Holds back the start of each Codex run until this many runs started. */
  startsTogether?: Gate;
  /** Holds back each refused model request until this many were refused. */
  refusalsTogether?: Gate;
  /** Holds back the answer to a renewal until another renewal was refused. */
  renewalAfterRefusal?: Gate;
  private server?: Server;
  url = '';

  /** Starts with tokens that expire in `ttlSec`. A renewal issues tokens for a day. */
  constructor(ttlSec: number) {
    this.issue(ttlSec);
  }

  issue(ttlSec = 24 * 60 * 60): void {
    this.gen++;
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    this.access = `${part({ alg: 'none' })}.${part({ exp, gen: this.gen })}.stand-in`;
    this.refresh = `refresh-${this.gen}`;
  }

  /** Refuses the current access token from now on, as a server does that revoked it, and keeps the refresh token. */
  revoke(): void {
    this.access = `${this.access}.revoked`;
  }

  login(): string {
    return JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: this.access, access_token: this.access, refresh_token: this.refresh, account_id: 'stand-in' }, last_refresh: new Date().toISOString() });
  }

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      req.on('end', () => {
        this.homes.add(String(req.headers['x-codex-home']));
        if (req.url === '/answered') {
          res.writeHead(200).end(String(this.answered.length));
          return;
        }
        if (req.url === '/start') {
          this.onStart?.();
          this.started[raw] = Date.now();
          this.events.push(`start ${raw}`);
          void (this.startsTogether?.arrive() ?? Promise.resolve()).then(() => res.writeHead(200).end());
          return;
        }
        if (req.url === '/token') {
          const { refresh_token: given, refresh_reason: reason } = JSON.parse(raw) as { refresh_token: string; refresh_reason: string };
          if (given !== this.refresh) {
            this.refused.push(given);
            this.events.push('refuse');
            void this.renewalAfterRefusal?.arrive();
            res.writeHead(401).end();
            return;
          }
          this.renewals.push({ given, reason });
          this.events.push('renew');
          this.onRenew?.();
          this.issue();
          const body = JSON.stringify({ access_token: this.access, id_token: this.access, refresh_token: this.refresh });
          void (this.renewalAfterRefusal?.passed() ?? Promise.resolve()).then(() => res.writeHead(200, { 'content-type': 'application/json' }).end(body));
          return;
        }
        const token = String(req.headers.authorization).replace('Bearer ', '');
        if (token !== this.access) {
          void (this.refusalsTogether?.arrive() ?? Promise.resolve()).then(() => res.writeHead(401).end());
          return;
        }
        this.answered.push(token);
        this.events.push('answer');
        res.writeHead(200).end('OK');
      });
    });
    await new Promise<void>(done => this.server!.listen(0, '127.0.0.1', done));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  close(): void {
    this.server?.close();
  }
}

/**
 * A stand-in for the Codex CLI 0.166.0 on the ChatGPT login, as measured. `codex exec` reads the login when it starts,
 * and renews it before its request when the access token expires within 5 minutes, or after a refused request, unless
 * the login file changed meanwhile. `codex app-server` renews it when `account/read` asks to refresh the token. A
 * renewal is written into `auth.json` in place, and a refused one leaves it. `codex exec` prints its answer as `--json`
 * events, and a refused renewal ends it with Codex's error. `CODEX_STANDIN_DELAY_MS` is the time `exec` works before its request, `CODEX_STANDIN_LINGER_MS` the
 * time it works after the answer, `CODEX_STANDIN_RENEW_MS` the
 * time the app server takes to renew, and `CODEX_STANDIN_NO_APP_RENEWAL` makes it renew nothing.
 */
const FAKE_CODEX = `
const fs = require('fs');
const path = require('path');
const file = path.join(process.env.CODEX_HOME, 'auth.json');
const url = process.env.CODEX_STANDIN_URL;
const headers = { 'x-codex-home': process.env.CODEX_HOME };
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const expiry = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000;
const sleep = ms => new Promise(done => setTimeout(done, ms));
const SESSION = '01a1e7b6-908c-7750-8dcd-e6fdb23319de';
const print = (...events) => process.stdout.write(events.map(event => JSON.stringify(event) + '\\n').join(''));
const begin = () => print({ type: 'thread.started', thread_id: SESSION }, { type: 'turn.started' });
const fail = text => { print({ type: 'error', message: text }, { type: 'turn.failed', error: { message: text } }); process.exit(1); };
async function renew(login, reason) {
  const res = await fetch(url + '/token', { method: 'POST', headers, body: JSON.stringify({ refresh_token: login.tokens.refresh_token, refresh_reason: reason }) });
  if (!res.ok) return undefined;
  const tokens = await res.json();
  login.tokens = { ...login.tokens, ...tokens };
  login.last_refresh = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(login));
  return login;
}
const used = 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.';
const ask = login => fetch(url + '/responses', { method: 'POST', headers: { ...headers, authorization: 'Bearer ' + login.tokens.access_token } });
const current = login => {
  const disk = read();
  return disk.tokens.access_token !== login.tokens.access_token ? disk : undefined;
};
async function exec(prompt) {
  await fetch(url + '/start', { method: 'POST', headers, body: prompt });
  begin();
  let login = read();
  await sleep(Number(process.env.CODEX_STANDIN_DELAY_MS || 0));
  if (expiry(login.tokens.access_token) - Date.now() < 300000) login = current(login) ?? await renew(login, 'proactive_expiry') ?? fail(used);
  let res = await ask(login);
  if (res.status === 401) {
    login = current(login) ?? await renew(login, 'unauthorized_recovery') ?? fail(used);
    res = await ask(login);
  }
  if (!res.ok) fail('unauthorized');
  await sleep(Number(process.env.CODEX_STANDIN_LINGER_MS || 0));
  print({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'OK' } }, { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
}
let input = '';
process.stdin.on('data', data => {
  input += data;
  if (process.argv[2] !== 'app-server') return;
  for (const line of input.split('\\n').slice(0, -1)) {
    const message = JSON.parse(line);
    if (message.method !== 'account/read') continue;
    input = '';
    (async () => {
      await sleep(Number(process.env.CODEX_STANDIN_RENEW_MS || 0));
      if (message.params.refreshToken && !process.env.CODEX_STANDIN_NO_APP_RENEWAL) await renew(read(), 'forced');
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');
    })();
  }
});
process.stdin.on('end', () => { if (process.argv[2] !== 'app-server') exec(input); });
`;

const MINUTE = 60;
const DAY = 24 * 60 * MINUTE;

describe('openai_oauth_file', () => {
  const savedEnv = process.env;
  let scratch: string;
  let folder: string;
  let file: string;
  let standIn: StandIn;

  const client = () => new OpenAIClient({ auth: buildOpenAIAuth('', '', '', file), model: 'gpt-5.5' });
  const fileLogin = () => JSON.parse(readFileSync(file, 'utf8')) as { tokens: { access_token: string; refresh_token: string } };
  const start = async (ttlSec: number) => {
    standIn = new StandIn(ttlSec);
    await standIn.start();
    process.env.CODEX_STANDIN_URL = standIn.url;
    writeFileSync(file, standIn.login(), { mode: 0o600 });
  };
  /** Sends `label` as the message, and returns when the call started and how it ended. */
  const timedCall = async (label: string) => {
    const at = Date.now();
    const result = await client().sendMessage('sys', label).then(r => r.content, (e: Error) => e);
    return { label, at, result };
  };
  /**
   * Starts a second run in a process of its own, with its own Codex home, as a second review on the runner is. Returns
   * when its call started and how it ended.
   */
  const ns = existsSync('/proc/self/ns/pid') ? readlinkSync('/proc/self/ns/pid') : '';
  /** Writes `lock` as held by the process `pid` on this host. */
  const holdLock = (lock: string, pid: number | undefined) => writeFileSync(lock, JSON.stringify({ host: hostname(), ns, pid, id: 'other' }));
  const otherRun = (exitOnRenewal = false) => {
    const script = join(scratch, 'other-run.ts');
    writeFileSync(script, [
      `import { buildOpenAIAuth, OpenAIClient } from ${JSON.stringify(resolve(__dirname, 'openai'))};`,
      'const at = Date.now();',
      // As a second Ctrl-C ends `manki review`, once Codex renewed and sent its request with the renewed token.
      ...(exitOnRenewal ? [`setInterval(() => fetch('${standIn.url}/answered').then(r => r.text()).then(n => { if (n !== '0') process.exit(130); }), 100);`] : []),
      `new OpenAIClient({ auth: buildOpenAIAuth('', '', '', ${JSON.stringify(file)}), model: 'gpt-5.5' }).sendMessage('sys', 'other')`,
      '  .then(r => r.content, (e: Error) => e.message)',
      '  .then(result => process.stdout.write(`\\nresult: ${JSON.stringify({ at, result })}\\n`));',
    ].join('\n'));
    const repo = resolve(__dirname, '..', '..');
    return new Promise<{ at: number; result: string }>(done => {
      const child = spawn(process.execPath, [join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), script], { cwd: repo, env: process.env });
      let stdout = '';
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.on('close', () => done(JSON.parse(/\nresult: (.*)\n/.exec(stdout)?.[1] ?? `{"at":0,"result":${JSON.stringify(stdout)}}`)));
    });
  };

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'manki-login-file-')));
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    fakeCodex.path = join(bin, 'codex');
    writeFileSync(fakeCodex.path, `#!${process.execPath}\n${FAKE_CODEX}`, { mode: 0o755 });
    folder = join(scratch, 'runner-login');
    mkdirSync(folder, { mode: 0o700 });
    file = join(folder, 'auth.json');
    // Only the stand-in is on the path, so no `codex` installed on the machine can run.
    process.env = { ...savedEnv, PATH: `${bin}:/usr/bin:/bin` };
    delete process.env.GITHUB_WORKSPACE;
  });

  afterEach(() => {
    process.env = savedEnv;
    // The Codex home lives as long as the process, so each test starts without a login in it.
    for (const home of standIn?.homes ?? []) rmSync(join(home, 'auth.json'), { force: true });
    standIn?.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it('renews a login due within the call once before it, writes it back, and the next run starts from it', async () => {
    await start(2 * MINUTE);
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });

    expect(standIn.renewals).toEqual([{ given: 'refresh-1', reason: 'forced' }]);
    expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // No lock and no temporary file stays behind.
    expect(readdirSync(folder)).toEqual(['auth.json']);

    // A new run has a new Codex home, so only the runner's file can carry the renewed login to it.
    for (const home of standIn.homes) rmSync(join(home, 'auth.json'));
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(standIn.renewals).toHaveLength(1);
    expect(standIn.refused).toEqual([]);
  });

  it('renews a login due within the call once for all calls of a run that start together', async () => {
    await start(2 * MINUTE);
    const calls = await Promise.all([client().sendMessage('sys', 'a'), client().sendMessage('sys', 'b')]);
    expect(calls.map(c => c.content)).toEqual(['OK', 'OK']);
    expect(standIn.renewals).toEqual([{ given: 'refresh-1', reason: 'forced' }]);
    expect(standIn.refused).toEqual([]);
    expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
  });

  it('runs the calls of a run one at a time with the lock held when Codex does not renew the login before them', async () => {
    await start(2 * MINUTE);
    process.env.CODEX_STANDIN_NO_APP_RENEWAL = '1';
    const calls = await Promise.all([timedCall('a'), timedCall('b')]);

    expect(calls.map(c => c.result)).toEqual(['OK', 'OK']);
    // The first call renews during its run, and the second one starts from the renewed login once the first ended.
    expect(standIn.events.map(e => e.replace(/ [ab]$/, ''))).toEqual(['start', 'renew', 'answer', 'start', 'answer']);
    expect(standIn.renewals).toEqual([{ given: 'refresh-1', reason: 'proactive_expiry' }]);
    expect(standIn.refused).toEqual([]);
    expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
    expect(readdirSync(folder)).toEqual(['auth.json']);
  });

  it('runs two runs side by side without any wait while no renewal is due', async () => {
    await start(DAY);
    // Each Codex run starts its request only once both runs started, so two runs that took turns would start apart.
    standIn.startsTogether = new Gate(2);
    const [own, theirs] = await Promise.all([timedCall('own'), otherRun()]);

    expect([own.result, theirs.result]).toEqual(['OK', 'OK']);
    expect(standIn.events.slice(0, 2).sort()).toEqual(['start other', 'start own']);
    expect(standIn.renewals).toEqual([]);
    expect(readdirSync(folder)).toEqual(['auth.json']);
  }, 60_000);

  it('lets one run renew a login due within the call, and the other wait for that renewal only and read the file again', async () => {
    await start(2 * MINUTE);
    process.env.CODEX_STANDIN_RENEW_MS = '3000';
    const [own, theirs] = await Promise.all([timedCall('own'), otherRun()]);

    expect([own.result, theirs.result]).toEqual(['OK', 'OK']);
    expect(standIn.renewals).toEqual([{ given: 'refresh-1', reason: 'forced' }]);
    expect(standIn.refused).toEqual([]);
    expect(standIn.events[0]).toBe('renew');
    expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
    expect(readdirSync(folder)).toEqual(['auth.json']);
  }, 60_000);

  it.each([
    ['two calls of one run', false],
    ['two runs', true],
  ])('lets one of %s win when both renew after a refused request, and never leaves a used refresh token in the file', async (_case, twoRuns) => {
    await start(DAY);
    standIn.revoke();
    // Both requests are refused at once, and the renewal that wins is answered once the other one was refused.
    standIn.refusalsTogether = new Gate(2);
    standIn.renewalAfterRefusal = new Gate(1);
    const results = await Promise.all(twoRuns ? [timedCall('own').then(r => r.result), otherRun().then(r => r.result)] : [timedCall('a').then(r => r.result), timedCall('b').then(r => r.result)]);

    expect(standIn.renewals).toEqual([{ given: 'refresh-1', reason: 'unauthorized_recovery' }]);
    expect(standIn.refused).toEqual(['refresh-1']);
    expect(results.filter(r => r === 'OK')).toHaveLength(1);
    expect(String(results.find(r => r !== 'OK'))).toContain('refresh token was already used');
    expect(fileLogin().tokens.refresh_token).toBe(standIn.refresh);
    expect(readdirSync(folder)).toEqual(['auth.json']);

    expect(await client().sendMessage('sys', 'after')).toMatchObject({ content: 'OK' });
    expect(standIn.renewals).toHaveLength(1);
  }, 60_000);

  it('waits for a run that renews, takes over a lock whose process stopped, and gives up after its time limit', async () => {
    await start(2 * MINUTE);
    const lock = `${file}.lock`;
    holdLock(lock, spawnSync('true').pid);
    // A process that stopped while it removed a lock left its marker too.
    writeFileSync(`${lock}.removing`, '');
    utimesSync(`${lock}.removing`, new Date(Date.now() - 2 * 60_000), new Date(Date.now() - 2 * 60_000));
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.removing`)).toBe(false);
    expect(standIn.renewals).toHaveLength(1);

    // A login far from its expiry needs no lock, so a call runs although another process holds it.
    const running = spawn('sleep', ['30']);
    try {
      holdLock(lock, running.pid);
      expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });

      writeFileSync(file, (() => { standIn.issue(2 * MINUTE); return standIn.login(); })());
      const lockError = new RegExp(`waited \\d+s for the lock ${lock} of openai_oauth_file, held by process ${running.pid}`);
      // A call that stops waiting stops the renewal no other call waits for, and the next call starts a new one.
      await expect(client().sendMessage('sys', 'user', { timeoutMs: 1200 })).rejects.toThrow(lockError);

      // A call that runs out of time or is cancelled stops waiting, and the renewal goes on for the call still waiting.
      const waiting = client().sendMessage('sys', 'user');
      const cancel = new AbortController();
      const cancelled = client().sendMessage('sys', 'user', { signal: cancel.signal });
      cancel.abort(new Error('cancelled'));
      await expect(cancelled).rejects.toThrow('cancelled');
      await expect(client().sendMessage('sys', 'user', { timeoutMs: 1200 })).rejects.toThrow(lockError);
      running.kill();
      expect(await waiting).toMatchObject({ content: 'OK' });
    } finally {
      running.kill();
    }
    expect(standIn.renewals).toHaveLength(2);
  }, 20_000);

  it('counts the wait for the lock against the time limit of the call', async () => {
    await start(2 * MINUTE);
    const lock = `${file}.lock`;
    const running = spawn('sleep', ['30']);
    try {
      holdLock(lock, running.pid);
      process.env.CODEX_STANDIN_DELAY_MS = '2000';
      const call = client().sendMessage('sys', 'user', { timeoutMs: 3000 });
      setTimeout(() => running.kill(), 1500);
      // The renewal ends about 1.5 seconds into the call, which leaves its Codex run too little time for 2 seconds of work.
      await expect(call).rejects.toMatchObject({ name: 'TimeoutError' });
    } finally {
      running.kill();
    }
    expect(standIn.renewals).toHaveLength(1);
  });

  it('does not write a renewal over a file that changed outside Manki during the call', async () => {
    await start(DAY);
    standIn.revoke();
    const relogin = { ...JSON.parse(standIn.login()) as Record<string, unknown>, account: 'logged in again' };
    standIn.onRenew = () => writeFileSync(file, JSON.stringify(relogin));
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(standIn.renewals).toHaveLength(1);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(relogin);
  });

  it('keeps a renewal in the home while writing it back fails, writes it once the file can be written again, and warns once per cause', async () => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => undefined);
    const warnings = (text: string) => warning.mock.calls.filter(([w]) => String(w).includes(text));
    await start(DAY);
    standIn.revoke();
    // Codex works on for a few looks at the home after it renewed.
    process.env.CODEX_STANDIN_LINGER_MS = '3500';
    // The folder takes no new file, so the write through a new file and a rename fails.
    standIn.onRenew = () => chmodSync(folder, 0o500);
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(fileLogin().tokens.refresh_token).toBe('refresh-1');
    expect(warnings('could not write it back')).toHaveLength(1);

    chmodSync(folder, 0o700);
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
    expect(standIn.renewals).toHaveLength(1);
    expect(standIn.refused).toEqual([]);

    // A file that others can read from now on fails every look during the call, and warns once.
    standIn.onRenew = undefined;
    process.env.CODEX_STANDIN_DELAY_MS = '500';
    const call = client().sendMessage('sys', 'user');
    setTimeout(() => chmodSync(file, 0o644), 300);
    expect(await call).toMatchObject({ content: 'OK' });
    expect(warnings('Could not compare')).toHaveLength(1);
    warning.mockRestore();
  }, 40_000);

  it('waits for another process that writes the file, and keeps the renewal and warns once when it waits too long', async () => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => undefined);
    await start(DAY);
    standIn.revoke();
    const writing = `${file}.writing`;
    // A process that writes the file for 2 seconds, so each look during the call finds it busy.
    const brief = spawn('sleep', ['2']);
    holdLock(writing, brief.pid);
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
    expect(warning).not.toHaveBeenCalled();

    standIn.revoke();
    const stuck = spawn('sleep', ['30']);
    try {
      holdLock(writing, stuck.pid);
      expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
      expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
      expect(warning).toHaveBeenCalledTimes(1);
      expect(String(warning.mock.calls[0][0])).toContain(`could not write it back to ${file}: ${writing} is held by process ${stuck.pid}`);
    } finally {
      stuck.kill();
    }
    // The renewal stayed in Codex's home, so the next call writes it instead of starting from the used refresh token.
    await new Promise(done => setTimeout(done, 100));
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(fileLogin().tokens.refresh_token).toBe('refresh-3');
    expect(standIn.refused).toEqual([]);
    expect(readdirSync(folder)).toEqual(['auth.json']);
    warning.mockRestore();
  }, 30_000);

  it('writes back at exit a renewal made while the run holds the lock', async () => {
    await start(2 * MINUTE);
    process.env.CODEX_STANDIN_NO_APP_RENEWAL = '1';
    process.env.CODEX_STANDIN_LINGER_MS = '6000';
    // Another process writes the file until shortly after the renewal, so only the write-back at exit can write it.
    standIn.onStart = () => holdLock(`${file}.writing`, spawn('sleep', ['3']).pid);
    await otherRun(true);

    expect(standIn.renewals).toEqual([{ given: 'refresh-1', reason: 'proactive_expiry' }]);
    expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
    expect(readdirSync(folder)).toEqual(['auth.json']);
  }, 60_000);

  it('finishes and writes back a renewal before the call that the calls stopped waiting for', async () => {
    await start(2 * MINUTE);
    process.env.CODEX_STANDIN_RENEW_MS = '1500';
    const cancel = new AbortController();
    const call = client().sendMessage('sys', 'user', { signal: cancel.signal });
    const late = client().sendMessage('sys', 'user', { timeoutMs: 800 });
    setTimeout(() => cancel.abort(new Error('cancelled')), 300);
    await expect(call).rejects.toThrow('cancelled');
    // The lock is this run's own, so the message names no other review.
    await expect(late).rejects.toThrow(`for the lock ${file}.lock of openai_oauth_file and ran out of its time limit, while this review itself renewed the login`);
    while (standIn.renewals.length === 0 || fileLogin().tokens.refresh_token !== 'refresh-2') await new Promise(done => setTimeout(done, 100));
    expect(standIn.renewals).toEqual([{ given: 'refresh-1', reason: 'forced' }]);
    while (existsSync(`${file}.lock`)) await new Promise(done => setTimeout(done, 100));
    expect(readdirSync(folder)).toEqual(['auth.json']);
  });

  it('checks the file again before each call, and refuses one that is no Codex login', async () => {
    await start(DAY);
    const auth = buildOpenAIAuth('', '', '', file);
    const call = () => new OpenAIClient({ auth, model: 'gpt-5.5' }).sendMessage('sys', 'user');
    chmodSync(file, 0o644);
    await expect(call()).rejects.toThrow(`other users can read or write ${file} (mode 644). Run \`chmod 600 ${file}\``);
    chmodSync(file, 0o600);
    writeFileSync(file, JSON.stringify({ tokens: { access_token: 'a' } }));
    await expect(call()).rejects.toThrow('openai_oauth_file is missing required field `tokens.refresh_token`');
    writeFileSync(file, JSON.stringify({ tokens: { access_token: 'no-jwt', refresh_token: 'r' } }));
    await expect(call()).rejects.toThrow('openai_oauth_file: the access token has no expiry Manki can read');
    writeFileSync(file, 'not json');
    await expect(call()).rejects.toThrow('openai_oauth_file is not JSON');
    expect(standIn.answered).toEqual([]);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
  it('refuses a file or folder others can use, a link, and a path in the workspace, the temp folder, the working folder or a Codex home', () => {
    writeFileSync(file, '{}', { mode: 0o600 });
    const refused = (path: string, env: NodeJS.ProcessEnv = {}) => {
      process.env = { ...process.env, ...env };
      return () => buildOpenAIAuth('', '', '', path);
    };
    expect(buildOpenAIAuth('', '', '', file)).toEqual({ kind: 'oauthFile', path: file });

    expect(refused('runner-login/auth.json')).toThrow('openai_oauth_file must be an absolute path');
    expect(refused(join(folder, 'missing.json'))).toThrow(`openai_oauth_file: ${join(folder, 'missing.json')} does not exist`);
    expect(refused(folder)).toThrow(`openai_oauth_file: ${folder} is not a regular file`);
    symlinkSync(file, join(folder, 'link.json'));
    expect(refused(join(folder, 'link.json'))).toThrow('is a symbolic link');
    symlinkSync(folder, join(scratch, 'linked-folder'));
    expect(refused(join(scratch, 'linked-folder', 'auth.json'))).toThrow(`the folder ${join(scratch, 'linked-folder')} is a symbolic link`);
    chmodSync(file, 0o640);
    expect(refused(file)).toThrow(`other users can read or write ${file} (mode 640)`);
    chmodSync(file, 0o600);
    chmodSync(folder, 0o755);
    expect(refused(file)).toThrow(`other users can read or write the folder ${folder} (mode 755). Run \`chmod 700 ${folder}\``);
    chmodSync(folder, 0o700);

    for (const [name, root] of [['GITHUB_WORKSPACE', scratch], ['RUNNER_TEMP', folder], ['CODEX_HOME', folder]]) {
      expect(refused(file, { [name]: root })).toThrow(`openai_oauth_file: ${file} is inside`);
      process.env = { ...process.env, [name]: join(scratch, 'elsewhere') };
    }
    const cwd = process.cwd();
    process.chdir(folder);
    try {
      expect(refused(file)).toThrow('is inside the working folder');
    } finally {
      process.chdir(cwd);
    }
  });

  it('keeps the secret path as it was: the login lives in the Codex home of the run, and no file is read or written', async () => {
    await start(2 * MINUTE);
    const secret = Buffer.from(standIn.login()).toString('base64');
    rmSync(file);
    const secretClient = new OpenAIClient({ auth: buildOpenAIAuth(secret, '', ''), model: 'gpt-5.5' });

    expect(await secretClient.sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(await secretClient.sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(standIn.renewals).toHaveLength(1);
    expect(standIn.refused).toEqual([]);
    expect(readdirSync(folder)).toEqual([]);
  });
});
