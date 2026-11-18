/**
 * Checks which tools the Codex CLI offers a model when Manki runs it. Runs the installed CLI with the arguments Manki
 * gives a reviewer on an OpenAI-compatible endpoint, against a stand-in endpoint on localhost that records each
 * request. The first answer asks Codex's script host for every tool it holds, or `tool_search` for the tools it
 * holds back. The check fails when a model is offered a tool that `scripts/fixtures/codex-tools.json` does not list, or
 * no longer offered one it lists. It also fails when a request carries Codex's skill text, or Codex tries to reach any
 * host but the stand-in. Every other address goes to a proxy that records and refuses it, so no request leaves the
 * machine. A connection that ignores the proxy settings is not seen. Each run starts from a runner home that holds its
 * own Codex setup (`plantRunnerSetup`), and the check fails when any part of it reaches Codex, also on the ChatGPT
 * login. Runs on the runner's own home show that each part still would.
 *
 * On the `tool_search` path the list is not complete. No request names the held-back tools, and `tool_search` returns
 * only tools whose description shares a word with `SEARCH_QUERY`. An empty, `*` or stop-word query returns none. So a
 * new held-back tool with none of those words is not seen. The check also compares the sources the `tool_search`
 * description names, so a held-back tool from a new source, such as a new MCP server or Codex's subagent tools, is seen.
 *
 * Usage (needs `npm run build` and the Codex CLI version in `CODEX_CLI_VERSION` on the PATH):
 *   npx tsx scripts/codex-tools-check.ts [--write]
 *
 * `--write` records the tools each model is offered into the fixture instead of comparing them.
 * Exit codes: 0 every model is offered the listed tools and nothing else was sent, 1 a list differs, a run sent skill
 * text, the runner's setup reached Codex or no longer would from the runner's own home, a run tried another host, or
 * the run failed.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { FILE_TOOLS_FLAG, MCP_SERVER_COMMAND, STEPS_FLAG } from '../src/mcp-server';
import { cliEnv } from '../src/providers/cli-utils';
import { CODEX_CLI_VERSION, codexExecArgs, codexToolServerArgs } from '../src/providers/openai';

/** What Codex offers one model. */
export interface OfferedTools {
  /** The tools named in its request. */
  offered: string[];
  /** The tools its script host holds, or those `tool_search` returns for `SEARCH_QUERY`. */
  held: string[];
  /** The sources of held-back tools that the `tool_search` description names. */
  sources: string[];
}

type Json = Record<string, unknown>;

// `tool_search` returns only the tools whose description shares a word with the query.
const SEARCH_QUERY = 'agent spawn send wait close resume input goal file read write edit grep glob history repo search web image shell command exec patch resource mcp time clock sleep plugin app install user message list task skill memory';
const ALL_TOOLS_SCRIPT = 'text(JSON.stringify(ALL_TOOLS.map(t => t.name)));';

function names(tools: unknown, namespace?: string): string[] {
  if (!Array.isArray(tools)) return [];
  return (tools as Json[]).flatMap(tool => {
    const name = typeof tool.name === 'string' ? tool.name : String(tool.type);
    const full = namespace ? `${namespace}.${name}` : name;
    return tool.type === 'namespace' ? names(tool.tools, full) : [full];
  });
}

/** Returns the tools a Responses API request offers the model, a namespace's tools as `namespace.name`. */
export function offeredTools(body: Json): string[] {
  const input = Array.isArray(body.input) ? body.input as Json[] : [];
  const added = input.filter(item => item.type === 'additional_tools').flatMap(item => names(item.tools));
  return [...names(body.tools), ...added].sort();
}

const SOURCES_HEADING = 'You have access to tools from the following sources:\n';

/** Returns the sources of held-back tools that the description of the `tool_search` tool in a request names. */
export function searchSources(body: Json): string[] {
  const tool = (Array.isArray(body.tools) ? body.tools as Json[] : []).find(t => t.type === 'tool_search');
  const description = typeof tool?.description === 'string' ? tool.description : '';
  const start = description.indexOf(SOURCES_HEADING);
  if (start < 0) return [];
  const lines = description.slice(start + SOURCES_HEADING.length).split('\n');
  const end = lines.findIndex(line => !line.startsWith('- '));
  return lines.slice(0, end < 0 ? lines.length : end).map(line => line.slice(2).split(': ')[0]).sort();
}

/** Returns the tools the output of the first tool call in a request lists: the script host's or `tool_search`'s. */
export function heldTools(body: Json): string[] {
  const input = Array.isArray(body.input) ? body.input as Json[] : [];
  for (const item of input) {
    if (item.type === 'tool_search_output') return names(item.tools).sort();
    if (item.type === 'custom_tool_call_output' && Array.isArray(item.output)) {
      const list = (item.output as Json[]).map(part => String(part.text ?? '')).find(text => text.startsWith('['));
      if (list) return (JSON.parse(list) as string[]).sort();
    }
  }
  return [];
}

/** Returns the step that asks Codex for the tools it holds: its script host when it has one, else `tool_search`. */
export function heldToolsCall(offered: string[]): Json | undefined {
  if (offered.includes('functions.exec')) {
    return { type: 'custom_tool_call', call_id: 'call_held', name: 'exec', namespace: 'functions', input: ALL_TOOLS_SCRIPT, status: 'completed' };
  }
  if (offered.includes('tool_search')) {
    return { type: 'tool_search_call', call_id: 'call_held', execution: 'client', arguments: { query: SEARCH_QUERY, limit: 100 }, status: 'completed' };
  }
  return undefined;
}

// Codex opens its skill catalog with the first tag and each skill it adds in full with the second.
const SKILL_TAGS = ['<skills_instructions>', '<skill>'];

function carriesSkillText(body: Json): boolean {
  const input = Array.isArray(body.input) ? body.input as Json[] : [];
  const texts = input.flatMap(item => Array.isArray(item.content) ? (item.content as Json[]).map(part => String(part.text ?? '')) : []);
  return texts.some(text => SKILL_TAGS.some(tag => text.startsWith(tag)));
}

/** What the stand-in saw of one Codex run. */
export interface StandInRun {
  /** The Responses API requests Codex sent it. */
  bodies: Json[];
  /** The other hosts Codex asked it to reach as a proxy. */
  hosts: string[];
  /** The paths of every request Codex sent the stand-in itself. */
  paths: string[];
  /** The `Authorization` headers of those requests. */
  keys: string[];
  /** Whether the hook planted in the runner's home ran. */
  hookRan: boolean;
}

const OTEL_HOST = 'runner-otel.invalid:4318';
const DOTENV_KEY = 'runner-dotenv-key';
const REDIRECT_PATH = '/runner-';
const HOOK_TEXT = 'runner-hook-context';

const sent = (run: StandInRun, text: string): boolean => JSON.stringify(run.bodies).includes(text);

// Each part of the runner's setup that `plantRunnerSetup` plants, and how a run shows it reached Codex. Only a run on
// the ChatGPT login can show the provider redirect.
const RUNNER_SETUP: { what: string; login?: true; found: (run: StandInRun) => boolean }[] = [
  { what: 'skill in ~/.codex/skills', found: run => sent(run, 'runner-codex-skill') },
  { what: 'skill in ~/.agents/skills', found: run => sent(run, 'runner-agents-skill') },
  { what: 'MCP server in ~/.codex/config.toml', found: run => sent(run, 'runner_mcp_server') },
  { what: 'AGENTS.md in ~/.codex', found: run => sent(run, 'runner-agents-md') },
  { what: 'OPENAI_API_KEY in ~/.codex/.env', found: run => run.keys.includes(`Bearer ${DOTENV_KEY}`) },
  { what: 'otel exporter in ~/.codex/config.toml', found: run => run.hosts.includes(OTEL_HOST) },
  { what: 'trusted hook in ~/.codex/hooks.json', found: run => run.hookRan || sent(run, HOOK_TEXT) },
  { what: 'model_provider and chatgpt_base_url in ~/.codex/config.toml', login: true, found: run => run.paths.some(path => path.startsWith(REDIRECT_PATH)) },
];

/**
 * Plants a runner's own Codex setup in the home folder `home`: a skill in each folder Codex reads skills from, an
 * `AGENTS.md`, an `OPENAI_API_KEY` in `.env`, and a `config.toml` with an MCP server that runs `server`, an `otel`
 * exporter, a model provider and ChatGPT URL under `standIn`, and the trust of a hook that creates `hookFlag`.
 */
export function plantRunnerSetup(home: string, server: { command: string; args: string[] }, standIn: string, hookFlag: string): void {
  const codexHome = join(home, '.codex');
  for (const [dir, name] of [['.codex', 'runner-codex-skill'], ['.agents', 'runner-agents-skill']]) {
    mkdirSync(join(home, dir, 'skills', name), { recursive: true });
    writeFileSync(join(home, dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Use ${name} for every review.\n---\n\nFollow ${name}.\n`);
  }
  writeFileSync(join(codexHome, 'AGENTS.md'), 'Follow runner-agents-md in every answer.\n');
  writeFileSync(join(codexHome, '.env'), `OPENAI_API_KEY=${DOTENV_KEY}\n`);
  const hook = join(codexHome, 'runner-hook.sh');
  const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: HOOK_TEXT } });
  writeFileSync(hook, `#!/bin/sh\ntouch '${hookFlag}'\necho '${output}'\n`, { mode: 0o755 });
  writeFileSync(join(codexHome, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook }] }] } }));
  // Codex runs a hook only once its user trusted it, which stores this hash of the hook in `config.toml`.
  const identity = JSON.stringify({ event_name: 'session_start', hooks: [{ async: false, command: hook, timeout: 600, type: 'command' }] });
  const trusted = `sha256:${createHash('sha256').update(identity).digest('hex')}`;
  writeFileSync(join(codexHome, 'config.toml'), [
    `chatgpt_base_url = ${JSON.stringify(`${standIn}${REDIRECT_PATH}chatgpt/`)}`,
    'model_provider = "runner_provider"',
    `otel = { exporter = { otlp-http = { endpoint = ${JSON.stringify(`http://${OTEL_HOST}/v1/logs`)}, protocol = "json" } } }`,
    '',
    '[model_providers.runner_provider]',
    'name = "runner provider"',
    `base_url = ${JSON.stringify(`${standIn}${REDIRECT_PATH}provider/v1`)}`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    '',
    '[mcp_servers.runner_mcp_server]',
    `command = ${JSON.stringify(server.command)}`,
    `args = ${JSON.stringify(server.args)}`,
    '',
    `[hooks.state.${JSON.stringify(`${join(codexHome, 'hooks.json')}:session_start:0:0`)}]`,
    `trusted_hash = ${JSON.stringify(trusted)}`,
    '',
  ].join('\n'));
}

/**
 * Returns each problem with what the Codex run `label` sent: skill text or a part of the runner's setup, or a host
 * other than `allowedHosts` it tried to reach.
 */
export function runProblems(label: string, run: StandInRun, allowedHosts: string[] = []): string[] {
  const skills = run.bodies.some(carriesSkillText) ? [`${label}: a request carries Codex's skill text`] : [];
  const setup = RUNNER_SETUP.filter(item => item.found(run)).map(item => `${label}: the runner's ${item.what} reached Codex`);
  const hosts = [...new Set(run.hosts)].filter(host => !allowedHosts.includes(host)).map(host => `${label}: tried to reach ${host}`);
  return [...skills, ...setup, ...hosts];
}

/**
 * Returns each part of the planted setup that the run `label`, on the runner's own home, should have shown and did
 * not. Such a part could no longer fail the check, as when a new Codex version reads it from elsewhere.
 */
export function controlProblems(label: string, run: StandInRun, login: boolean): string[] {
  return RUNNER_SETUP.filter(item => !!item.login === login && !item.found(run))
    .map(item => `${label}: the runner's ${item.what} no longer reaches Codex from the runner's own home, so the check cannot see it`);
}

/** Returns each difference between the tools `expected` lists per model and the tools `actual` found. */
export function compareTools(expected: Record<string, OfferedTools>, actual: Record<string, OfferedTools>): string[] {
  const problems: string[] = [];
  for (const [model, want] of Object.entries(expected)) {
    const got = actual[model];
    if (!got) {
      problems.push(`${model}: not checked`);
      continue;
    }
    for (const kind of ['offered', 'held', 'sources'] as const) {
      for (const name of got[kind].filter(n => !want[kind].includes(n))) problems.push(`${model}: new in ${kind}: ${name}`);
      for (const name of want[kind].filter(n => !got[kind].includes(n))) problems.push(`${model}: gone from ${kind}: ${name}`);
    }
  }
  return problems;
}

function sse(type: string, data: Json): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/**
 * Starts the stand-in endpoint, which records what it sees in `run`. It answers the first Responses API request with
 * `heldToolsCall` and every later one with `OK`.
 */
function startStandIn(run: StandInRun): Promise<{ url: string; close: () => void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      // A plain HTTP request through a proxy names the whole URL, a request to the stand-in only the path.
      if (req.url && !req.url.startsWith('/')) {
        run.hosts.push(new URL(req.url).host);
        res.writeHead(404).end();
        return;
      }
      run.paths.push(req.url ?? '');
      run.keys.push(req.headers.authorization ?? '');
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as Json;
      run.bodies.push(body);
      const call = run.bodies.length === 1 ? heldToolsCall(offeredTools(body)) : undefined;
      const item = call ?? { type: 'message', role: 'assistant', id: 'msg_ok', content: [{ type: 'output_text', text: 'OK' }] };
      const id = `resp_${run.bodies.length}`;
      const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse('response.created', { response: { id } }) + sse('response.output_item.done', { item }) + sse('response.completed', { response: { id, usage } }));
    });
  });
  // Codex sends every other host through this server as its proxy, and the tunnel is refused.
  server.on('connect', (req: IncomingMessage, socket) => {
    run.hosts.push(String(req.url));
    socket.destroy();
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })));
}

function runCodex(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn('codex', args, { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', fail);
    child.on('close', code => done({ code, stderr }));
    child.stdin.end('Reply with OK.');
  });
}

const base64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Returns a made-up ChatGPT login file in the shape Codex reads. Its tokens are no real credential. */
function standInLogin(): string {
  const claims = { exp: Math.floor(Date.now() / 1000) + 86_400, 'https://api.openai.com/auth': { chatgpt_account_id: 'stand-in', chatgpt_user_id: 'stand-in', chatgpt_plan_type: 'pro' } };
  const jwt = `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.stand-in`;
  return JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: jwt, access_token: jwt, refresh_token: 'stand-in', account_id: 'stand-in' }, last_refresh: new Date().toISOString() });
}

// The hosts of OpenAI's own servers, which Codex tries to reach on the ChatGPT login.
const LOGIN_HOSTS = ['chatgpt.com:443', 'auth.openai.com:443'];

interface CodexRun {
  model: string;
  /** Run on the ChatGPT login instead of the endpoint. */
  login: boolean;
  /** Run on the runner's own home, as Manki ran Codex before it had a home of its own. */
  runnerHome: boolean;
}

/**
 * Runs Codex on `model` the way Manki runs a reviewer with repository tools, against a stand-in endpoint, on a runner
 * whose home holds its own Codex setup. Returns what the stand-in saw, and Codex's exit code and stderr.
 */
async function checkRun({ model, login, runnerHome }: CodexRun, repo: string, scratch: string): Promise<{ run: StandInRun; code: number | null; stderr: string }> {
  const run: StandInRun = { bodies: [], hosts: [], paths: [], keys: [], hookRan: false };
  const standIn = await startStandIn(run);
  try {
    const home = mkdtempSync(join(scratch, 'home-'));
    const cwd = mkdtempSync(join(scratch, 'cwd-'));
    const instructions = join(scratch, 'instructions.md');
    writeFileSync(instructions, 'Reply with OK.');
    const server = { command: process.execPath, args: [join(repo, 'dist', 'index.js'), MCP_SERVER_COMMAND, repo, FILE_TOOLS_FLAG, STEPS_FLAG, '30'] };
    const hookFlag = join(home, 'hook-ran');
    plantRunnerSetup(home, server, standIn.url, hookFlag);
    const runnerEnv = {
      PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'),
      HTTPS_PROXY: standIn.url, HTTP_PROXY: standIn.url, ALL_PROXY: standIn.url, NO_PROXY: '127.0.0.1',
    };
    const key = login ? {} : { OPENAI_API_KEY: 'stand-in' };
    const env = runnerHome ? { ...runnerEnv, ...key } : cliEnv('codex', key, login ? undefined : 'OPENAI_API_KEY', runnerEnv);
    const authFile = join(env.CODEX_HOME!, 'auth.json');
    if (login) writeFileSync(authFile, standInLogin(), { mode: 0o600 });
    const args = [
      ...codexExecArgs(model, login ? undefined : `${standIn.url}/v1`), ...codexToolServerArgs(server, env),
      '-c', `model_instructions_file=${JSON.stringify(instructions)}`, '-',
    ];
    try {
      const { code, stderr } = await runCodex(args, env, cwd);
      run.hookRan = existsSync(hookFlag);
      return { run, code, stderr };
    } finally {
      rmSync(authFile, { force: true });
    }
  } finally {
    standIn.close();
  }
}

/** Returns the version of the Codex CLI on the PATH, or an empty string when there is none. */
function codexVersion(): Promise<string> {
  return new Promise(done => {
    const child = spawn('codex', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.on('error', () => done(''));
    child.on('close', code => done(code === 0 ? stdout.trim().split(' ').pop() ?? '' : ''));
  });
}

async function main(): Promise<number> {
  const version = await codexVersion();
  if (version !== CODEX_CLI_VERSION) {
    console.log(`::error::The Codex CLI on the PATH is ${version || 'missing'}, and Manki pins ${CODEX_CLI_VERSION}.`);
    return 1;
  }
  const repo = resolve(__dirname, '..');
  const fixture = join(__dirname, 'fixtures', 'codex-tools.json');
  const expected = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, OfferedTools>;
  // Codex names a trusted hook by its real path.
  const scratch = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'manki-codex-tools-')));
  try {
    const actual: Record<string, OfferedTools> = {};
    const runs: string[] = [];
    const models = Object.keys(expected);
    for (const model of models) {
      const { run, code, stderr } = await checkRun({ model, login: false, runnerHome: false }, repo, scratch);
      if (code !== 0 || run.bodies.length === 0) throw new Error(`Codex exited with ${code} on ${model}:\n${stderr.slice(-2000)}`);
      const offered = offeredTools(run.bodies[0]);
      const tools = { offered, held: heldToolsCall(offered) && run.bodies[1] ? heldTools(run.bodies[1]) : [], sources: searchSources(run.bodies[0]) };
      actual[model] = tools;
      runs.push(...runProblems(model, run));
      console.log(`${model}: offered ${tools.offered.join(', ')}; held ${tools.held.join(', ') || 'none'}; sources ${tools.sources.join(', ') || 'none'}`);
    }
    // On the ChatGPT login Codex can only fail here, since the stand-in refuses OpenAI's servers.
    const login = await checkRun({ model: models[0], login: true, runnerHome: false }, repo, scratch);
    runs.push(...runProblems(`${models[0]} on the ChatGPT login`, login.run, LOGIN_HOSTS));
    // The same runs on the runner's own home show that every planted part still reaches Codex from there.
    for (const loginRun of [false, true]) {
      const label = `${models[0]}${loginRun ? ' on the ChatGPT login' : ''} with the runner's own home`;
      const control = await checkRun({ model: models[0], login: loginRun, runnerHome: true }, repo, scratch);
      runs.push(...controlProblems(label, control.run, loginRun));
    }
    for (const problem of runs) console.log(`::error::${problem}`);
    if (runs.length > 0) console.log('Find the Codex setting or the folder it came from, keep it out in `codexExecArgs` or `cliEnv`, and update docs/security.md.');
    if (process.argv.includes('--write')) {
      writeFileSync(fixture, `${JSON.stringify(actual, null, 2)}\n`);
      return runs.length === 0 ? 0 : 1;
    }
    const problems = compareTools(expected, actual);
    for (const problem of problems) console.log(`::error::${problem}`);
    if (problems.length > 0) console.log('Check what each changed tool can do, update docs/security.md, then record the new lists with --write.');
    return problems.length === 0 && runs.length === 0 ? 0 : 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().then(code => process.exit(code), (error) => {
    console.error(error);
    process.exit(1);
  });
}
