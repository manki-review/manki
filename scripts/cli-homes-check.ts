/**
 * Checks that the Claude and Gemini CLIs see nothing of the runner user's own setup when Manki runs them. Each run
 * starts from a runner home that holds a planted setup for the CLI (`plantClaudeSetup`, `plantGeminiSetup`), and runs
 * the installed CLI with Manki's arguments and environment against the stand-in of `scripts/stand-in.ts`, which
 * refuses every other host. Claude's requests go to the stand-in through `ANTHROPIC_BASE_URL`. The Gemini CLI's login
 * checks and Code Assist calls go to Google's hosts, which the stand-in serves itself. The check fails when a planted
 * part reaches a request or runs, or when a CLI tries to reach a host it does not always reach.
 *
 * A control run on the runner's own home must still show every planted part, so a CLI version that reads one from
 * elsewhere fails the check instead of passing it. The Claude control runs the CLI with its defaults, since Manki's
 * flags alone already keep the setup out. The Gemini control runs it as Manki did before it had a home of its own.
 *
 * Usage (needs `npm run build`, `openssl`, and the Claude and Gemini CLI versions Manki pins on the PATH):
 *   npx tsx scripts/cli-homes-check.ts
 *
 * Exit codes: 0 no planted part reached a CLI, 1 one did, a control run no longer shows one, a run tried another
 * host, or a run failed.
 */

import { spawn } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { MCP_SERVER_COMMAND } from '../src/mcp-server';
import { CLAUDE_CLI_VERSION, claudeCliArgs, writeToolServerConfig } from '../src/providers/anthropic';
import { cliEnv, cliHome, MankiCommand } from '../src/providers/cli-utils';
import { GEMINI_CLI_VERSION, GEMINI_NO_TOOLS_POLICY, geminiCliArgs } from '../src/providers/gemini';
import { STEP_HOOK_COMMAND } from '../src/tool-steps';
import { Answer, controlProblems, hostProblems, Json, makeCertificate, newRun, PlantedItem, plantedProblems, sent, ServedHosts, sse, StandInRun, startStandIn } from './stand-in';

const HOOK_TEXT = 'runner-hook-context';
// A planted command creates a flag file of its name in the flag folder when it runs.
const FLAG = { hook: 'hook', keyHelper: 'key-helper', mcp: 'mcp-server', extensionMcp: 'extension-mcp-server' };
const HELPER_KEY = 'runner-helper-key';
const RUNNER_LOGIN = 'runner-oauth-token';
const REDIRECT = { settings: '/runner-settings/', dotenv: '/runner-dotenv', otel: '/runner-otel' };

const redirected = (run: StandInRun, path: string): boolean => run.paths.some(p => p.startsWith(path));

// Each part of the runner's Claude setup that `plantClaudeSetup` plants, and how a run shows it reached the CLI.
export const CLAUDE_SETUP: PlantedItem[] = [
  { what: 'CLAUDE.md in ~/.claude', found: run => sent(run, 'runner-claude-md') },
  { what: 'rule in ~/.claude/rules', found: run => sent(run, 'runner-claude-rule') },
  { what: 'skill in ~/.claude/skills', found: run => sent(run, 'runner-claude-skill') },
  { what: 'command in ~/.claude/commands', found: run => sent(run, 'runner-claude-command') },
  { what: 'agent in ~/.claude/agents', found: run => sent(run, 'runner-claude-agent') },
  { what: 'plugin in ~/.claude/plugins', found: run => sent(run, 'runner-plugin-skill') },
  { what: 'MCP server in ~/.claude.json', found: run => sent(run, 'runner_mcp_server') },
  { what: 'hook in ~/.claude/settings.json', found: run => run.ran.includes(FLAG.hook) || sent(run, HOOK_TEXT) },
  { what: 'ANTHROPIC_BASE_URL in the env of ~/.claude/settings.json', found: run => redirected(run, REDIRECT.settings) },
  { what: 'apiKeyHelper in ~/.claude/settings.json', found: run => run.ran.includes(FLAG.keyHelper) || run.keys.includes(`Bearer ${HELPER_KEY}`) },
];

// Each part of the runner's Gemini setup that `plantGeminiSetup` plants, and how a run shows it reached the CLI.
export const GEMINI_SETUP: PlantedItem[] = [
  { what: 'GEMINI.md in ~/.gemini', found: run => sent(run, 'runner-gemini-md') },
  { what: 'skill in ~/.gemini/skills', found: run => sent(run, 'runner-gemini-skill') },
  { what: 'skill in ~/.agents/skills', found: run => sent(run, 'runner-agents-skill') },
  { what: 'extension in ~/.gemini/extensions', found: run => run.ran.includes(FLAG.extensionMcp) || sent(run, 'runner-extension-context') },
  { what: 'MCP server in ~/.gemini/settings.json', found: run => run.ran.includes(FLAG.mcp) },
  { what: 'hook in ~/.gemini/settings.json', found: run => run.ran.includes(FLAG.hook) || sent(run, HOOK_TEXT) },
  { what: 'telemetry endpoint in ~/.gemini/settings.json', found: run => redirected(run, REDIRECT.otel) },
  { what: 'CODE_ASSIST_ENDPOINT in ~/.gemini/.env', found: run => redirected(run, REDIRECT.dotenv) },
  { what: 'login in ~/.gemini/oauth_creds.json', found: run => run.keys.includes(`Bearer ${RUNNER_LOGIN}`) },
];

// The hosts each CLI reaches on its own, whatever the home holds: Anthropic's API, and Google's usage statistics.
const CLAUDE_HOSTS = ['api.anthropic.com:443'];
const GEMINI_HOSTS = ['play.googleapis.com:443'];
// The Google hosts of the Gemini login and Code Assist, which the stand-in serves.
const GOOGLE_HOSTS = ['oauth2.googleapis.com', 'www.googleapis.com', 'cloudcode-pa.googleapis.com'];

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
}

const skill = (name: string): string => `---\nname: ${name}\ndescription: Use ${name} for every review.\n---\n\nFollow ${name}.\n`;

/** Writes a hook script into `dir` that creates the hook flag in `flags` and adds `HOOK_TEXT` to the session. */
function writeHook(dir: string, flags: string): string {
  const path = join(dir, 'runner-hook.sh');
  const output = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: HOOK_TEXT } });
  write(path, `#!/bin/sh\ntouch '${join(flags, FLAG.hook)}'\necho '${output}'\n`, 0o755);
  return path;
}

/** Returns a command that only creates the flag `name` in `flags`. */
function flagCommand(flags: string, name: string): MankiCommand {
  return { command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(join(flags, name))}, '')`] };
}

/**
 * Plants a runner's own Claude setup in the home folder `home`: a `CLAUDE.md`, a rule, a skill, a command, an agent and
 * a plugin with a skill in `~/.claude`, the MCP server `server` in `~/.claude.json`, and a `settings.json` whose `env`
 * points the CLI at `standIn`, with a hook and an `apiKeyHelper` that create their flags in `flags`.
 */
export function plantClaudeSetup(home: string, server: MankiCommand, standIn: string, flags: string): void {
  const claude = join(home, '.claude');
  write(join(claude, 'CLAUDE.md'), 'Follow runner-claude-md in every answer.\n');
  write(join(claude, 'rules', 'runner.md'), 'Follow runner-claude-rule in every answer.\n');
  write(join(claude, 'skills', 'runner-claude-skill', 'SKILL.md'), skill('runner-claude-skill'));
  write(join(claude, 'commands', 'runner-command.md'), '---\ndescription: runner-claude-command\n---\nFollow runner-claude-command.\n');
  write(join(claude, 'agents', 'runner-agent.md'), '---\nname: runner-claude-agent\ndescription: Use runner-claude-agent for every review.\n---\nFollow runner-claude-agent.\n');
  // A plugin installed from a marketplace in a local folder, as `claude plugin install` leaves it.
  const plugins = join(claude, 'plugins');
  const market = join(plugins, 'marketplaces', 'runner-market');
  const plugin = join(plugins, 'cache', 'runner-market', 'runner-plugin', '1.0.0');
  const at = '2026-01-01T00:00:00.000Z';
  write(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'runner-market', owner: { name: 'runner' }, plugins: [{ name: 'runner-plugin', source: './runner-plugin', version: '1.0.0' }] }));
  write(join(plugins, 'known_marketplaces.json'), JSON.stringify({ 'runner-market': { source: { source: 'directory', path: market }, installLocation: market, lastUpdated: at } }));
  for (const dir of [plugin, join(market, 'runner-plugin')]) {
    write(join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runner-plugin', version: '1.0.0' }));
    write(join(dir, 'skills', 'runner-plugin-skill', 'SKILL.md'), skill('runner-plugin-skill'));
  }
  const installed = { scope: 'user', installPath: plugin, version: '1.0.0', installedAt: at, lastUpdated: at };
  write(join(plugins, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'runner-plugin@runner-market': [installed] } }));
  write(join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { runner_mcp_server: { type: 'stdio', ...server } } }));
  const helper = join(claude, 'runner-key-helper.sh');
  write(helper, `#!/bin/sh\ntouch '${join(flags, FLAG.keyHelper)}'\necho ${HELPER_KEY}\n`, 0o755);
  write(join(claude, 'settings.json'), JSON.stringify({
    env: { ANTHROPIC_BASE_URL: `${standIn}${REDIRECT.settings}` },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: writeHook(claude, flags) }] }] },
    apiKeyHelper: helper,
    enabledPlugins: { 'runner-plugin@runner-market': true },
  }));
}

/**
 * Plants a runner's own Gemini setup in the home folder `home`: a `GEMINI.md`, a skill in `~/.gemini/skills` and in
 * `~/.agents/skills`, an extension with a context file and an MCP server, a `.env` and a login of its own, and a
 * `settings.json` with an MCP server, a hook and a telemetry endpoint. The `.env` and the telemetry point at `standIn`,
 * and the commands create their flags in `flags`.
 */
export function plantGeminiSetup(home: string, standIn: string, flags: string): void {
  const gemini = join(home, '.gemini');
  write(join(gemini, 'GEMINI.md'), 'Follow runner-gemini-md in every answer.\n');
  write(join(gemini, 'skills', 'runner-gemini-skill', 'SKILL.md'), skill('runner-gemini-skill'));
  write(join(home, '.agents', 'skills', 'runner-agents-skill', 'SKILL.md'), skill('runner-agents-skill'));
  const extension = join(gemini, 'extensions', 'runner-extension');
  write(join(extension, 'gemini-extension.json'), JSON.stringify({
    name: 'runner-extension', version: '1.0.0', contextFileName: 'RUNNER.md',
    mcpServers: { runner_extension_server: flagCommand(flags, FLAG.extensionMcp) },
  }));
  write(join(extension, 'RUNNER.md'), 'Follow runner-extension-context in every answer.\n');
  write(join(gemini, '.env'), `CODE_ASSIST_ENDPOINT=${standIn}${REDIRECT.dotenv}\n`);
  write(join(gemini, 'oauth_creds.json'), JSON.stringify({ access_token: RUNNER_LOGIN, refresh_token: 'runner-refresh', token_type: 'Bearer', expiry_date: Date.now() + 86_400_000 }), 0o600);
  write(join(gemini, 'settings.json'), JSON.stringify({
    mcpServers: { runner_mcp_server: flagCommand(flags, FLAG.mcp) },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: writeHook(gemini, flags) }] }] },
    telemetry: { enabled: true, target: 'local', otlpEndpoint: `${standIn}${REDIRECT.otel}`, otlpProtocol: 'http' },
  }));
}

/** Answers the Messages API with `OK`, as a stream when the request asks for one. */
function answerClaude(run: StandInRun): Answer {
  return (req, raw, res) => {
    if (req.method !== 'POST' || !(req.url ?? '').split('?')[0].endsWith('/v1/messages')) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(raw) as Json;
    run.bodies.push(body);
    const usage = { input_tokens: 1, output_tokens: 1 };
    const message = { id: 'msg_ok', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ...message, content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse('message_start', { message }) + sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      + sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OK' } }) + sse('content_block_stop', { index: 0 })
      + sse('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) + sse('message_stop', {}));
  };
}

/**
 * Answers the Gemini CLI's login checks and Code Assist calls, at Google's hosts or at a path the runner's setup sends
 * them to. A model call gets `OK`, or the routing choice when the CLI asks for one as JSON.
 */
function answerGemini(run: StandInRun): Answer {
  return (req, raw, res) => {
    const json = (data: Json): void => { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data)); };
    const host = req.headers.host ?? '';
    const path = req.url ?? '';
    if (host === 'oauth2.googleapis.com') return json({ aud: 'stand-in', scope: 'https://www.googleapis.com/auth/cloud-platform', expires_in: 3599 });
    if (host === 'www.googleapis.com') return json({ email: 'stand-in@example.com' });
    if (path.includes(':loadCodeAssist')) return json({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'stand-in' });
    if (!/:(?:stream)?generateContent\b/i.test(path)) return json({});
    run.bodies.push(JSON.parse(raw) as Json);
    const reply = (text: string): Json => ({ response: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } } });
    if (!path.includes(':streamGenerateContent')) return json(reply(JSON.stringify({ reasoning: 'stand-in', model_choice: 'pro' })));
    res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify(reply('OK'))}\n\n`);
  };
}

function runCli(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.on('error', fail);
    child.on('close', code => done({ code, stderr }));
    child.stdin.end('Reply with OK.');
  });
}

interface CheckRun {
  cli: 'claude' | 'gemini';
  /** Run on the runner's own home: Claude with its defaults, Gemini as Manki ran it before it had a home of its own. */
  control: boolean;
  /** A Claude call with Manki's repository tools. */
  tools?: boolean;
}

const MODEL = { claude: 'claude-sonnet-4-6', gemini: 'gemini-3-pro-preview' };
const STAND_IN_LOGIN = 'manki-stand-in-token';

/**
 * Runs the CLI of `check` on a runner home with a planted setup, against a stand-in. Throws when the CLI fails or
 * never asks the model, and returns what the stand-in saw.
 */
async function checkRun({ cli, control, tools = false }: CheckRun, repo: string, scratch: string, google: { served: ServedHosts; ca: string }): Promise<StandInRun> {
  const run = newRun();
  const standIn = await startStandIn(run, cli === 'claude' ? answerClaude(run) : answerGemini(run), cli === 'gemini' ? google.served : undefined);
  try {
    const home = mkdtempSync(join(scratch, 'home-'));
    const work = mkdtempSync(join(scratch, 'work-'));
    const flags = mkdtempSync(join(scratch, 'flags-'));
    const cwd = mkdtempSync(join(scratch, 'cwd-'));
    const proxy = { HTTPS_PROXY: standIn.url, HTTP_PROXY: standIn.url, ALL_PROXY: standIn.url, NO_PROXY: '127.0.0.1' };
    const runnerEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, USER: process.env.USER, ...proxy };
    let args: string[];
    let env: NodeJS.ProcessEnv;
    if (cli === 'claude') {
      const server = { command: process.execPath, args: [join(repo, 'dist', 'index.js'), MCP_SERVER_COMMAND, repo] };
      plantClaudeSetup(home, server, standIn.url, flags);
      runnerEnv.ANTHROPIC_BASE_URL = standIn.url;
      const login = { CLAUDE_CODE_OAUTH_TOKEN: STAND_IN_LOGIN };
      const systemPrompt = join(work, 'system.md');
      writeFileSync(systemPrompt, 'Reply with OK.');
      const steps = join(work, 'steps');
      mkdirSync(steps);
      const stepHook = { command: process.execPath, args: [join(repo, 'dist', 'index.js'), STEP_HOOK_COMMAND, steps, '30'] };
      const setup = tools ? { mcpConfigPath: writeToolServerConfig(work, server), stepHook } : undefined;
      args = control
        ? ['-p', '--verbose', '--output-format', 'stream-json', `--model=${MODEL.claude}`]
        : claudeCliArgs(MODEL.claude, systemPrompt, tools ? { repoTools: { root: repo, steps: 30, related: undefined } } : {}, setup);
      env = control ? { ...runnerEnv, ...login } : cliEnv('claude', login, 'CLAUDE_CODE_OAUTH_TOKEN', runnerEnv);
    } else {
      plantGeminiSetup(home, standIn.url, flags);
      runnerEnv.NODE_EXTRA_CA_CERTS = google.ca;
      const policy = join(work, 'no-tools.toml');
      writeFileSync(policy, GEMINI_NO_TOOLS_POLICY);
      args = geminiCliArgs(MODEL.gemini, policy);
      const vars = { GOOGLE_GENAI_USE_GCA: 'true' };
      env = control ? { ...runnerEnv, ...vars } : cliEnv('gemini', vars, undefined, runnerEnv);
      // Manki wrote its login only where none was, so on the runner's own home the runner's login stayed.
      const login = join(control ? home : cliHome('gemini'), '.gemini', 'oauth_creds.json');
      if (!existsSync(login)) write(login, JSON.stringify({ access_token: STAND_IN_LOGIN, refresh_token: 'stand-in', token_type: 'Bearer', expiry_date: Date.now() + 3_600_000 }), 0o600);
    }
    const { code, stderr } = await runCli(cli, args, env, cwd);
    run.ran = readdirSync(flags);
    if (code !== 0 || run.bodies.length === 0) throw new Error(`${cli} exited with ${code}${run.bodies.length === 0 ? ' without asking the model' : ''}:\n${stderr.slice(-2000)}`);
    return run;
  } finally {
    standIn.close();
  }
}

/** Returns the version the CLI `command` reports, or an empty string when there is none. */
function cliVersion(command: string): Promise<string> {
  return new Promise(done => {
    const child = spawn(command, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
    child.on('error', () => done(''));
    child.on('close', code => done(code === 0 ? stdout.trim().split(' ')[0] : ''));
  });
}

async function main(): Promise<number> {
  for (const [command, pinned] of [['claude', CLAUDE_CLI_VERSION], ['gemini', GEMINI_CLI_VERSION]]) {
    const version = await cliVersion(command);
    if (version !== pinned) {
      console.log(`::error::The ${command} CLI on the PATH is ${version || 'missing'}, and Manki pins ${pinned}.`);
      return 1;
    }
  }
  const repo = resolve(__dirname, '..');
  const scratch = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'manki-cli-homes-')));
  try {
    const google = makeCertificate(scratch, GOOGLE_HOSTS);
    const problems: string[] = [];
    for (const tools of [false, true]) {
      const label = `claude${tools ? ' with repository tools' : ''}`;
      const run = await checkRun({ cli: 'claude', control: false, tools }, repo, scratch, google);
      problems.push(...plantedProblems(label, 'Claude', CLAUDE_SETUP, run), ...hostProblems(label, run, CLAUDE_HOSTS));
    }
    const gemini = await checkRun({ cli: 'gemini', control: false }, repo, scratch, google);
    problems.push(...plantedProblems('gemini', 'Gemini', GEMINI_SETUP, gemini), ...hostProblems('gemini', gemini, GEMINI_HOSTS));
    const claudeControl = await checkRun({ cli: 'claude', control: true }, repo, scratch, google);
    problems.push(...controlProblems('claude with its defaults on the runner\'s own home', 'Claude', CLAUDE_SETUP, claudeControl));
    const geminiControl = await checkRun({ cli: 'gemini', control: true }, repo, scratch, google);
    problems.push(...controlProblems('gemini on the runner\'s own home', 'Gemini', GEMINI_SETUP, geminiControl));
    for (const problem of problems) console.log(`::error::${problem}`);
    if (problems.length > 0) console.log('Find the setting or the folder it came from, keep it out in `cliEnv`, `claudeCliArgs` or `geminiCliArgs`, and update docs/security.md.');
    else console.log(`No part of the runner's setup reached Claude ${CLAUDE_CLI_VERSION} or Gemini ${GEMINI_CLI_VERSION}.`);
    return problems.length === 0 ? 0 : 1;
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
