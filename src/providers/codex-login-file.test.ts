import { spawn, spawnSync } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { hostname, tmpdir } from 'os';
import { join, resolve } from 'path';

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
 * refresh token used before, and answers a model request only with the access token it issued last.
 */
class StandIn {
  gen = 0;
  access = '';
  refresh = '';
  renewals: string[] = [];
  refused: string[] = [];
  answered: string[] = [];
  homes = new Set<string>();
  open = 0;
  maxOpen = 0;
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

  login(): string {
    return JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: this.access, access_token: this.access, refresh_token: this.refresh, account_id: 'stand-in' }, last_refresh: new Date().toISOString() });
  }

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
      req.on('end', () => {
        this.homes.add(String(req.headers['x-codex-home']));
        if (req.url === '/token') {
          const { refresh_token: given } = JSON.parse(raw) as { refresh_token: string };
          if (given !== this.refresh) {
            this.refused.push(given);
            res.writeHead(401).end();
            return;
          }
          this.renewals.push(given);
          this.issue();
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: this.access, id_token: this.access, refresh_token: this.refresh }));
          return;
        }
        const token = String(req.headers.authorization).replace('Bearer ', '');
        if (token !== this.access) {
          res.writeHead(401).end();
          return;
        }
        this.answered.push(token);
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
 * A stand-in for the Codex CLI 0.166.0 on the ChatGPT login, as measured: it reads the login when it starts, and renews
 * it before its request when the access token expires within 5 minutes, or after a refused request, unless the login
 * file changed meanwhile. A renewal is written into `auth.json` in place. A refused renewal ends the run with Codex's
 * error. `CODEX_STANDIN_DELAY_MS` is the time the run works before its request.
 */
const FAKE_CODEX = `
const fs = require('fs');
const path = require('path');
const file = path.join(process.env.CODEX_HOME, 'auth.json');
const url = process.env.CODEX_STANDIN_URL;
const headers = { 'x-codex-home': process.env.CODEX_HOME };
const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
const expiry = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp * 1000;
const fail = text => { process.stderr.write('ERROR: ' + text + '\\n'); process.exit(1); };
async function renew(login) {
  const res = await fetch(url + '/token', { method: 'POST', headers, body: JSON.stringify({ refresh_token: login.tokens.refresh_token }) });
  if (!res.ok) fail('Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.');
  const tokens = await res.json();
  login.tokens = { ...login.tokens, ...tokens };
  login.last_refresh = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(login));
  return login;
}
const ask = login => fetch(url + '/responses', { method: 'POST', headers: { ...headers, authorization: 'Bearer ' + login.tokens.access_token } });
const current = login => {
  const disk = read();
  return disk.tokens.access_token !== login.tokens.access_token ? disk : undefined;
};
(async () => {
  let login = read();
  await new Promise(done => setTimeout(done, Number(process.env.CODEX_STANDIN_DELAY_MS || 0)));
  if (expiry(login.tokens.access_token) - Date.now() < 300000) login = current(login) ?? await renew(login);
  let res = await ask(login);
  if (res.status === 401) {
    login = current(login) ?? await renew(login);
    res = await ask(login);
  }
  if (!res.ok) fail('unauthorized');
  process.stdout.write('OK\\n');
})();
`;

const MINUTE = 60;

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
  /** The login file in the Codex home of this process, which the next call overwrites from the runner's file. */
  const homeFile = () => join([...standIn.homes][0], 'auth.json');

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'manki-login-file-')));
    const bin = join(scratch, 'bin');
    mkdirSync(bin);
    fakeCodex.path = join(bin, 'codex');
    writeFileSync(fakeCodex.path, `#!${process.execPath}\n${FAKE_CODEX}`, { mode: 0o755 });
    folder = join(scratch, 'runner-login');
    mkdirSync(folder, { mode: 0o700 });
    file = join(folder, 'auth.json');
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

  it('writes a renewal back to the file, and the next run starts from the renewed tokens', async () => {
    await start(2 * MINUTE);
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });

    expect(standIn.renewals).toEqual(['refresh-1']);
    expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // No lock and no temporary file stays behind.
    expect(readdirSync(folder)).toEqual(['auth.json']);

    // A new run has a new Codex home, so only the runner's file can carry the renewed login to it.
    rmSync(homeFile());
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(standIn.renewals).toEqual(['refresh-1']);
    expect(standIn.refused).toEqual([]);
  });

  it('runs the calls of one run at once while no renewal is due', async () => {
    await start(24 * 60 * MINUTE);
    process.env.CODEX_STANDIN_DELAY_MS = '1500';
    const started = Date.now();
    await Promise.all([client().sendMessage('sys', 'a'), client().sendMessage('sys', 'b')]);
    expect(Date.now() - started).toBeLessThan(2900);
    expect(standIn.renewals).toEqual([]);
  });

  it('runs the calls of one run one at a time once a renewal is due, so no refresh token is sent twice', async () => {
    await start(2 * MINUTE);
    await Promise.all([client().sendMessage('sys', 'a'), client().sendMessage('sys', 'b')]);
    expect(standIn.renewals).toEqual(['refresh-1']);
    expect(standIn.refused).toEqual([]);
    expect(standIn.answered).toHaveLength(2);
    expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
  });

  it('lets two runs on one runner take turns, so neither renews tokens the other already renewed', async () => {
    await start(2 * MINUTE);
    // Long enough that the other run starts before this one renews.
    process.env.CODEX_STANDIN_DELAY_MS = '8000';
    // The other run is a second process with its own Codex home, as a second review on the runner is.
    const other = join(scratch, 'other-run.ts');
    writeFileSync(other, [
      `import { buildOpenAIAuth, OpenAIClient } from ${JSON.stringify(resolve(__dirname, 'openai'))};`,
      `new OpenAIClient({ auth: buildOpenAIAuth('', '', '', ${JSON.stringify(file)}), model: 'gpt-5.5' }).sendMessage('sys', 'user')`,
      "  .then(r => process.stdout.write(`\\nanswer: ${r.content}\\n`), (e: Error) => { process.stdout.write(e.message); process.exitCode = 1; });",
    ].join('\n'));
    const repo = resolve(__dirname, '..', '..');
    const otherRun = new Promise<{ code: number | null; stdout: string }>(done => {
      const child = spawn(process.execPath, [join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'), other], { cwd: repo, env: process.env });
      let stdout = '';
      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.on('close', code => done({ code, stdout }));
    });
    const [own, theirs] = await Promise.all([client().sendMessage('sys', 'user'), otherRun]);

    expect(own.content).toBe('OK');
    expect(theirs).toEqual({ code: 0, stdout: expect.stringContaining('\nanswer: OK\n') });
    expect(standIn.homes.size).toBe(2);
    expect(standIn.renewals).toEqual(['refresh-1']);
    expect(standIn.refused).toEqual([]);
    expect(fileLogin().tokens.refresh_token).toBe('refresh-2');
    expect(readdirSync(folder)).toEqual(['auth.json']);
  }, 60_000);

  it('waits for a run that holds the lock, takes over a lock whose process stopped, and gives up after its time limit', async () => {
    await start(24 * 60 * MINUTE);
    const lock = `${file}.lock`;
    const ns = existsSync('/proc/self/ns/pid') ? readlinkSync('/proc/self/ns/pid') : '';
    const holder = (pid: number | undefined) => JSON.stringify({ host: hostname(), ns, pid, id: 'other' });

    writeFileSync(lock, holder(spawnSync('true').pid));
    expect(await client().sendMessage('sys', 'user')).toMatchObject({ content: 'OK' });
    expect(existsSync(lock)).toBe(false);

    const running = spawn('sleep', ['30']);
    try {
      writeFileSync(lock, holder(running.pid));
      await expect(client().sendMessage('sys', 'user', { timeoutMs: 1200 })).rejects.toThrow(`waited 1.2s for the lock ${lock} of openai_oauth_file, held by process ${running.pid}`);
      const waiting = client().sendMessage('sys', 'user');
      await new Promise(done => setTimeout(done, 700));
      running.kill();
      expect(await waiting).toMatchObject({ content: 'OK' });
    } finally {
      running.kill();
    }
    expect(standIn.answered).toHaveLength(2);
  }, 20_000);

  it('does not write a renewal over a file that changed outside Manki during the call', async () => {
    await start(2 * MINUTE);
    process.env.CODEX_STANDIN_DELAY_MS = '1500';
    const call = client().sendMessage('sys', 'user');
    await new Promise(done => setTimeout(done, 700));
    const relogin = JSON.stringify({ tokens: { access_token: 'new-login', refresh_token: 'new-login' } });
    writeFileSync(file, relogin);
    await call;
    expect(readFileSync(file, 'utf8')).toBe(relogin);
  });

  it('checks the file again before each run, and refuses one that is no Codex login', async () => {
    await start(24 * 60 * MINUTE);
    const auth = buildOpenAIAuth('', '', '', file);
    chmodSync(file, 0o644);
    await expect(new OpenAIClient({ auth, model: 'gpt-5.5' }).sendMessage('sys', 'user')).rejects.toThrow(`other users can read or write ${file} (mode 644). Run \`chmod 600 ${file}\``);
    chmodSync(file, 0o600);
    writeFileSync(file, JSON.stringify({ tokens: { access_token: 'a' } }));
    await expect(new OpenAIClient({ auth, model: 'gpt-5.5' }).sendMessage('sys', 'user')).rejects.toThrow('openai_oauth_file is missing required field `tokens.refresh_token`');
    writeFileSync(file, 'not json');
    await expect(new OpenAIClient({ auth, model: 'gpt-5.5' }).sendMessage('sys', 'user')).rejects.toThrow('openai_oauth_file is not JSON');
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
