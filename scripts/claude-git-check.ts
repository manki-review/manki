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
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import { MCP_SERVER_COMMAND } from '../src/mcp-server';
import { CLAUDE_CLI_VERSION, claudeCliArgs, writeToolServerConfig } from '../src/providers/anthropic';
import { cliEnv } from '../src/providers/cli-utils';
import { STEP_HOOK_COMMAND } from '../src/tool-steps';
import { answerClaude, cliVersion, runCli, ToolCall } from './cli-homes-check';
import { Json, newRun, startStandIn } from './stand-in';

/** A tool call on the planted checkout. Without the deny rules its result shows `.git` when `git` is set. With them it must show another file when `open` is set. */
export interface GitCall extends ToolCall {
  git: boolean;
  open: boolean;
}

/** The text that marks the files of the planted `.git`, and the one that marks the other files. A search for `text` finds both. */
export const gitMark = (text: string): string => `${text}-git`;
export const openMark = (text: string): string => `${text}-open`;

/**
 * Makes a folder `root` with a `.git` and files with similar names, and returns the calls on them. Every file holds its
 * mark or has it in its name. A refusal repeats the path it was asked for, so no call names a mark. On a disk that
 * ignores case, the calls include `.git` in other letter case.
 */
export function plantCheckout(root: string, text: string): GitCall[] {
  for (const folder of ['.git', '.github', 'my.git', 'src']) {
    const mark = folder === '.git' ? gitMark(text) : openMark(text);
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(join(root, folder, 'notes.txt'), `${mark}\n`);
    writeFileSync(join(root, folder, `${mark}.txt`), 'named\n');
  }
  writeFileSync(join(root, '.gitignore'), `${openMark(text)}\n`);
  symlinkSync(join(root, '.git'), join(root, 'link'));
  symlinkSync(join(root, '.git', 'notes.txt'), join(root, 'link.txt'));
  const inGit = { git: true, open: false };
  const open = { git: false, open: true };
  const read = (path: string, kind = inGit): GitCall => ({ name: 'Read', input: { file_path: path }, ...kind });
  const grep = (path: string, kind = inGit): GitCall => ({ name: 'Grep', input: { pattern: text, path, output_mode: 'content' }, ...kind });
  const glob = (path: string, pattern = '*', kind = inGit): GitCall => ({ name: 'Glob', input: { pattern, path }, ...kind });
  const folder = (path: string): GitCall[] => [read(`${path}/notes.txt`), grep(path), grep(`${path}/notes.txt`), glob(path)];
  const calls = [
    ...['.git', 'src/../.git', 'link'].flatMap(path => folder(`${root}/${path}`)), read(`${root}/link.txt`), grep(`${root}/link.txt`),
    ...['.git/**', '[.]git/*'].map(pattern => glob(root, pattern)),
    read(`${root}/.github/notes.txt`, open), read(`${root}/my.git/notes.txt`, open), read(`${root}/.gitignore`, open),
    grep(`${root}/.github`, open), glob(`${root}/my.git`, '*', open), glob(root, '.github/*', open),
    // Grep searches no `.git` from the root, and Glob lists it there.
    grep(root, open), glob(root, '**/*', { git: true, open: true }),
  ];
  if (!existsSync(join(root, '.GIT'))) return calls;
  symlinkSync(join(root, '.GIT'), join(root, 'case-link'));
  return [...calls, ...[`${root}/.GIT`, `${root}/.Git`, `${root}/.gIT`, `${root}/case-link`, `${root}/LINK`, `${root}/SRC/../.git`].flatMap(folder)];
}

/** Returns each tool result in `bodies`, the model requests of a run, by the index its call has in `calls`. */
export function toolResults(bodies: Json[], calls: GitCall[]): (string | undefined)[] {
  const blocks = bodies.flatMap(body => body.messages as { content: unknown }[]).flatMap(message => (Array.isArray(message.content) ? message.content : []) as Json[]);
  return calls.map((_, i) => {
    const block = blocks.find(b => b.type === 'tool_result' && b.tool_use_id === `toolu_${i}`);
    return block && JSON.stringify(block.content);
  });
}

/** Returns what is wrong with the `results` of `calls` on the files marked by `text`, in a control run without the deny rules or, as Manki runs the CLI, with them. */
export function gitReadProblems(label: string, text: string, calls: GitCall[], results: (string | undefined)[], control = false): string[] {
  return calls.flatMap(({ name, input, git, open }, i) => {
    const what = `${label}: ${name} ${JSON.stringify(input)}`;
    const result = results[i];
    if (result === undefined) return [`${what} got no result`];
    return [
      ...(!control && result.includes(gitMark(text)) ? [`${what} read \`.git\``] : []),
      ...((control && git && !result.includes(gitMark(text))) || (!control && open && !result.includes(openMark(text))) ? [`${what} no longer shows its file, so the check cannot see it`] : []),
    ];
  });
}

async function runCalls(calls: GitCall[], root: string, repo: string, scratch: string, control: boolean): Promise<(string | undefined)[]> {
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
    if (control) {
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
    const text = randomBytes(8).toString('hex');
    const calls = plantCheckout(root, text);
    const run = (control: boolean) => runCalls(calls, root, resolve(__dirname, '..'), scratch, control);
    const problems = [
      ...gitReadProblems('claude', text, calls, await run(false)),
      ...gitReadProblems('claude without the deny rules', text, calls, await run(true), true),
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
