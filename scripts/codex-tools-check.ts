/**
 * Checks which tools the Codex CLI offers a model when Manki runs it. Runs the installed CLI with the arguments Manki
 * gives a reviewer on an OpenAI-compatible endpoint, against a stand-in endpoint on localhost that records each
 * request. The first answer asks Codex's script host for every tool it holds, or `tool_search` for the tools it
 * holds back. The check fails when a model is offered a tool that `scripts/fixtures/codex-tools.json` does not list, or
 * no longer offered one it lists. It also fails when a request carries Codex's skill text, or Codex tries to reach any
 * host but the stand-in. Every other address goes to a proxy that records and refuses it, so no request leaves the
 * machine. A connection that ignores the proxy settings is not seen. Each run starts from a runner home that holds a
 * skill, an MCP server and an `AGENTS.md` of its own, and the check fails when a request carries any of them.
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
 * text or the runner's setup or tried another host, or the run failed.
 */

import { spawn } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { FILE_TOOLS_FLAG, MCP_SERVER_COMMAND, STEPS_FLAG } from '../src/mcp-server';
import { CODEX_CLI_VERSION, codexEnv, codexExecArgs, codexToolServerArgs } from '../src/providers/openai';

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

// The names of what `plantRunnerSetup` puts in a runner home, and where each one is.
const RUNNER_SETUP: Record<string, string> = {
  'runner-codex-skill': 'skill in ~/.codex/skills',
  'runner-agents-skill': 'skill in ~/.agents/skills',
  'runner_mcp_server': 'MCP server in ~/.codex/config.toml',
  'runner-agents-md': 'AGENTS.md in ~/.codex',
};

/**
 * Plants a runner's own Codex setup in the home folder `home`: a skill in each folder Codex reads skills from, an MCP
 * server that runs `server`, and an `AGENTS.md`. Each one names itself, so a request that carries it shows its name.
 */
export function plantRunnerSetup(home: string, server: { command: string; args: string[] }): void {
  for (const [dir, name] of [['.codex', 'runner-codex-skill'], ['.agents', 'runner-agents-skill']]) {
    mkdirSync(join(home, dir, 'skills', name), { recursive: true });
    writeFileSync(join(home, dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Use ${name} for every review.\n---\n\nFollow ${name}.\n`);
  }
  writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers.runner_mcp_server]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n`);
  writeFileSync(join(home, '.codex', 'AGENTS.md'), 'Follow runner-agents-md in every answer.\n');
}

/**
 * Returns each problem with what a Codex run of `model` sent: skill text or a part of the runner's setup in a request,
 * or a host it tried to reach.
 */
export function runProblems(model: string, bodies: Json[], hosts: string[]): string[] {
  const skills = bodies.some(carriesSkillText) ? [`${model}: a request carries Codex's skill text`] : [];
  const sent = JSON.stringify(bodies);
  const setup = Object.entries(RUNNER_SETUP).filter(([name]) => sent.includes(name)).map(([, what]) => `${model}: a request carries the runner's ${what}`);
  return [...skills, ...setup, ...[...new Set(hosts)].map(host => `${model}: tried to reach ${host}`)];
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
 * Starts the stand-in endpoint. It answers the first request with `heldToolsCall` and every later one with `OK`, and
 * adds each host Codex asks it for as a proxy to `hosts`.
 */
function startStandIn(bodies: Json[], hosts: string[]): Promise<{ port: number; close: () => void }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString(); });
    req.on('end', () => {
      // A plain HTTP request through a proxy names the whole URL, a request to the stand-in only the path.
      if (req.url && !req.url.startsWith('/')) hosts.push(new URL(req.url).host);
      if (req.method !== 'POST' || !req.url?.startsWith('/') || !req.url.endsWith('/responses')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as Json;
      bodies.push(body);
      const call = bodies.length === 1 ? heldToolsCall(offeredTools(body)) : undefined;
      const item = call ?? { type: 'message', role: 'assistant', id: 'msg_ok', content: [{ type: 'output_text', text: 'OK' }] };
      const id = `resp_${bodies.length}`;
      const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse('response.created', { response: { id } }) + sse('response.output_item.done', { item }) + sse('response.completed', { response: { id, usage } }));
    });
  });
  // Codex sends every other host through this server as its proxy, and the tunnel is refused.
  server.on('connect', (req: IncomingMessage, socket) => {
    hosts.push(String(req.url));
    socket.destroy();
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done({ port: (server.address() as AddressInfo).port, close: () => server.close() })));
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

/**
 * Runs Codex on `model` the way Manki runs a reviewer with repository tools, on a runner whose home holds its own Codex
 * setup, and returns the tools it offered and each problem `runProblems` finds in the run.
 */
async function checkModel(model: string, repo: string, scratch: string): Promise<{ tools: OfferedTools; problems: string[] }> {
  const bodies: Json[] = [];
  const hosts: string[] = [];
  const standIn = await startStandIn(bodies, hosts);
  try {
    const home = mkdtempSync(join(scratch, 'home-'));
    const cwd = mkdtempSync(join(scratch, 'cwd-'));
    const instructions = join(scratch, 'instructions.md');
    writeFileSync(instructions, 'Reply with OK.');
    const local = `http://127.0.0.1:${standIn.port}`;
    const server = { command: process.execPath, args: [join(repo, 'dist', 'index.js'), MCP_SERVER_COMMAND, repo, FILE_TOOLS_FLAG, STEPS_FLAG, '30'] };
    plantRunnerSetup(home, server);
    const env = codexEnv({ OPENAI_API_KEY: 'stand-in' }, 'OPENAI_API_KEY', {
      PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, '.codex'),
      HTTPS_PROXY: local, HTTP_PROXY: local, ALL_PROXY: local, NO_PROXY: '127.0.0.1',
    });
    const args = [
      ...codexExecArgs(model, `${local}/v1`), ...codexToolServerArgs(server, env),
      '-c', `model_instructions_file=${JSON.stringify(instructions)}`, '-',
    ];
    const { code, stderr } = await runCodex(args, env, cwd);
    if (code !== 0 || bodies.length === 0) throw new Error(`Codex exited with ${code} on ${model}:\n${stderr.slice(-2000)}`);
    const offered = offeredTools(bodies[0]);
    const tools = { offered, held: heldToolsCall(offered) && bodies[1] ? heldTools(bodies[1]) : [], sources: searchSources(bodies[0]) };
    return { tools, problems: runProblems(model, bodies, hosts) };
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
  const scratch = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'manki-codex-tools-'));
  try {
    const actual: Record<string, OfferedTools> = {};
    const runs: string[] = [];
    for (const model of Object.keys(expected)) {
      const { tools, problems } = await checkModel(model, repo, scratch);
      actual[model] = tools;
      runs.push(...problems);
      console.log(`${model}: offered ${tools.offered.join(', ')}; held ${tools.held.join(', ') || 'none'}; sources ${tools.sources.join(', ') || 'none'}`);
    }
    for (const problem of runs) console.log(`::error::${problem}`);
    if (runs.length > 0) console.log('Find the Codex setting or the folder it came from, keep it out in `codexExecArgs` or `codexEnv`, and update docs/security.md.');
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
