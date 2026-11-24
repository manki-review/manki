/**
 * Checks that the Claude CLI's own tools read nothing in the `.git` of a checkout, with the installed CLI, Manki's
 * arguments and the stand-in of `scripts/stand-in.ts` as the model. The stand-in asks for tool calls into `.git`, whose
 * results must not show it, and for calls on files whose names only look like it, which must still show them. A control
 * run without the deny rules must show `.git` in every call, so a CLI version that keeps it out by itself, or that no
 * longer runs a call, fails the check instead of passing it.
 *
 * Usage (needs `npm run build` and the Claude CLI version Manki pins on the PATH):
 *   npx tsx scripts/claude-git-check.ts
 *
 * Exit codes: 0 no call read `.git`, 1 one did, a call on another file or of the control run showed nothing, or a run failed.
 */

import { randomBytes } from 'crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { MCP_SERVER_COMMAND } from '../src/mcp-server';
import { CLAUDE_CLI_VERSION, claudeCliArgs, writeToolServerConfig } from '../src/providers/anthropic';
import { cliEnv } from '../src/providers/cli-utils';
import { STEP_HOOK_COMMAND } from '../src/tool-steps';
import { answerClaude, cliVersion, runCli, ToolCall } from './cli-homes-check';
import { Json, newRun, startStandIn } from './stand-in';

/** A tool call, the text its result holds when it read the file it names, and whether that file is in `.git`. */
export interface GitCall extends ToolCall {
  shows: string;
  inGit: boolean;
}

/**
 * Makes a folder `root` with a `.git` and files with similar names, and returns the calls on them. Every file holds
 * `text` and has `text` in its name. A refusal repeats the path it was asked for, so no call names the file it looks for.
 */
export function plantCheckout(root: string, text: string): GitCall[] {
  const folders = ['.git', '.github', 'my.git', 'src'];
  for (const folder of folders) {
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'notes.txt'), `${text}\n`);
    writeFileSync(join(root, folder, `${text}.txt`), 'named\n');
  }
  writeFileSync(join(root, '.gitignore'), `${text}\n`);
  symlinkSync(join(root, '.git'), join(root, 'link'));
  symlinkSync(join(root, '.git', 'notes.txt'), join(root, 'link.txt'));
  const read = (path: string, inGit: boolean): GitCall => ({ name: 'Read', input: { file_path: `${root}/${path}` }, shows: text, inGit });
  const grep = (path: string, inGit: boolean): GitCall => ({ name: 'Grep', input: { pattern: text, path: `${root}/${path}`, output_mode: 'content' }, shows: text, inGit });
  const glob = (path: string, pattern: string, inGit: boolean, shows = `${text}.txt`): GitCall => ({ name: 'Glob', input: { pattern, path: `${root}/${path}` }, shows, inGit });
  return [
    read('.git/notes.txt', true), read('src/../.git/notes.txt', true), read('link/notes.txt', true), read('link.txt', true),
    grep('.git', true), grep('.git/notes.txt', true), grep('src/../.git', true), grep('link', true), grep('link.txt', true),
    glob('.git', '*', true), glob('src/../.git', '*', true), glob('link', '*', true),
    ...['**/*', '.git/**', '[.]git/*'].map(pattern => glob('', pattern, true, `/.git/${text}.txt`)),
    read('.github/notes.txt', false), read('my.git/notes.txt', false), read('.gitignore', false),
    grep('.github', false), grep('', false), glob('my.git', '*', false), glob('', '.github/*', false), glob('', '**/*', false, `/src/${text}.txt`),
  ];
}

/** Returns each tool result in `bodies`, the model requests of a run, by the index its call has in `calls`. */
export function toolResults(bodies: Json[], calls: GitCall[]): (string | undefined)[] {
  const blocks = bodies.flatMap(body => body.messages as { content: unknown }[]).flatMap(message => (Array.isArray(message.content) ? message.content : []) as Json[]);
  return calls.map((_, i) => {
    const block = blocks.find(b => b.type === 'tool_result' && b.tool_use_id === `toolu_${i}`);
    return block && JSON.stringify(block.content);
  });
}

/** Returns what is wrong with the `results` of `calls`, in a run where `.git` is `open` or, as Manki runs the CLI, is not. */
export function gitReadProblems(label: string, calls: GitCall[], results: (string | undefined)[], open = false): string[] {
  return calls.flatMap((call, i) => {
    const what = `${label}: ${call.name} ${JSON.stringify(call.input)}`;
    if (results[i] === undefined) return [`${what} got no result`];
    const shown = results[i].includes(call.shows);
    if (call.inGit && !open) return shown ? [`${what} read \`.git\``] : [];
    return shown ? [] : [`${what} no longer shows its file, so the check cannot see it`];
  });
}

async function runCalls(calls: GitCall[], root: string, repo: string, scratch: string, open: boolean): Promise<(string | undefined)[]> {
  const run = newRun();
  const standIn = await startStandIn(run, answerClaude(run, calls));
  try {
    const work = mkdtempSync(join(scratch, 'work-'));
    const systemPrompt = join(work, 'system.md');
    writeFileSync(systemPrompt, 'Reply with OK.');
    const steps = join(work, 'steps');
    mkdirSync(steps);
    const dist = join(repo, 'dist', 'index.js');
    const mcpConfigPath = writeToolServerConfig(work, { command: process.execPath, args: [dist, MCP_SERVER_COMMAND, root] });
    const stepHook = { command: process.execPath, args: [dist, STEP_HOOK_COMMAND, steps, '60'] };
    const args = claudeCliArgs('claude-sonnet-4-6', systemPrompt, { repoTools: { root, steps: 60, related: undefined } }, { mcpConfigPath, stepHook });
    if (open) {
      const at = args.indexOf('--settings') + 1;
      args[at] = JSON.stringify({ ...JSON.parse(args[at]), permissions: undefined });
    }
    const proxy = { HTTPS_PROXY: standIn.url, HTTP_PROXY: standIn.url, ALL_PROXY: standIn.url, NO_PROXY: '127.0.0.1' };
    const runnerEnv = { PATH: process.env.PATH, HOME: mkdtempSync(join(scratch, 'home-')), USER: process.env.USER, ANTHROPIC_BASE_URL: standIn.url, ...proxy };
    const env = cliEnv('claude', { CLAUDE_CODE_OAUTH_TOKEN: 'manki-stand-in-token' }, 'CLAUDE_CODE_OAUTH_TOKEN', runnerEnv);
    const { code, output } = await runCli('claude', args, env, mkdtempSync(join(scratch, 'cwd-')));
    if (code !== 0) throw new Error(`claude exited with ${code}:\n${output.slice(-2000)}`);
    return toolResults(run.bodies, calls);
  } finally {
    standIn.close();
  }
}

async function main(): Promise<number> {
  const version = await cliVersion('claude');
  if (version !== CLAUDE_CLI_VERSION) {
    console.log(`::error::The claude CLI on the PATH is ${version || 'missing'}, and Manki pins ${CLAUDE_CLI_VERSION}.`);
    return 1;
  }
  const scratch = realpathSync(mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'manki-claude-git-')));
  process.env.TMPDIR = join(scratch, 'temp');
  mkdirSync(process.env.TMPDIR);
  try {
    const root = join(scratch, 'checkout');
    const calls = plantCheckout(root, randomBytes(8).toString('hex'));
    const run = (open: boolean) => runCalls(calls, root, resolve(__dirname, '..'), scratch, open);
    const problems = [
      ...gitReadProblems('claude', calls, await run(false)),
      ...gitReadProblems('claude without the deny rules', calls, await run(true), true),
    ];
    for (const problem of problems) console.log(`::error::${problem}`);
    if (problems.length > 0) console.log('Keep `.git` out in `claudeCliArgs`, and update docs/security.md.');
    else console.log(`Claude ${CLAUDE_CLI_VERSION} read nothing in the checkout's \`.git\`.`);
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
