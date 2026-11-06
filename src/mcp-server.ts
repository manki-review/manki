import { execFile } from 'child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { promisify } from 'util';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { AST_GREP_FAMILIES, AstGrepApi, languageOf, loadAstGrep } from './ast-grep';
import { MANKI_VERSION } from './github';
import { gitEnv, WORKSPACE_DEPTH } from './workspace';

const execFileAsync = promisify(execFile);

/** The argument of `dist/index.js` that starts the tool server instead of a review. */
export const MCP_SERVER_COMMAND = 'mcp-server';

/** The argument after the root that makes the tool server also offer `read_file`, `grep` and `glob`. */
export const FILE_TOOLS_FLAG = '--file-tools';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 1024 * 1024;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 20_000;
const MAX_COMMITS = 50;
const MAX_MATCHES = 200;

/** A file or directory inside the repository, as its real path and its path relative to the repository root. */
interface RepoPath {
  absolute: string;
  relative: string;
}

/**
 * Resolves `path`, relative to `root` or absolute, to its real path. Refuses a path that does not exist, resolves
 * outside `root`, also through a symlink, or lies in `.git`.
 */
export function resolveInRoot(root: string, path: string): RepoPath {
  if (path.includes('\0')) throw new Error('the path holds a NUL character');
  const realRoot = realpathSync(root);
  let absolute: string;
  try {
    absolute = realpathSync(resolve(realRoot, path));
  } catch {
    throw new Error(`${path} does not exist in the repository`);
  }
  const rel = relative(realRoot, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`${path} is outside the repository`);
  if (rel === '.git' || rel.startsWith(`.git${sep}`)) throw new Error(`${path} is in .git, which the tools do not read`);
  return { absolute, relative: rel === '' ? '.' : rel.split(sep).join('/') };
}

/**
 * Returns the files under `dir`, as paths relative to `root`, and whether the walk stopped at `MAX_FILES`.
 * Skips `.git` and symlinks.
 */
function listFiles(root: string, dir: RepoPath): { files: string[]; cut: boolean } {
  if (statSync(dir.absolute).isFile()) return { files: [dir.relative], cut: false };
  const files: string[] = [];
  let cut = false;
  const walk = (absolute: string): void => {
    for (const name of readdirSync(absolute).sort()) {
      if (files.length >= MAX_FILES) {
        cut = true;
        return;
      }
      const child = join(absolute, name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink() || (name === '.git' && absolute === root)) continue;
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) files.push(relative(root, child).split(sep).join('/'));
    }
  };
  walk(dir.absolute);
  return { files, cut };
}

function capOutput(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output cut at ${MAX_OUTPUT_CHARS} characters]`;
}

export interface GitHistoryArgs {
  path: string;
  startLine?: number;
  endLine?: number;
  maxCommits?: number;
}

/** Returns the commits that changed `path`, or only its lines `startLine` to `endLine` with their diffs, newest first. */
export async function gitHistory(root: string, { path, startLine, endLine, maxCommits = 20 }: GitHistoryArgs): Promise<string> {
  const target = resolveInRoot(root, path);
  const realRoot = realpathSync(root);
  const args = ['log', '--no-color', '--no-ext-diff', '--no-textconv', `--max-count=${Math.min(maxCommits, MAX_COMMITS)}`, '--date=short', '--format=commit %H%nAuthor: %an%nDate: %ad%n%n    %s%n'];
  if (startLine !== undefined) {
    if (!statSync(target.absolute).isFile()) throw new Error(`${path} is not a file, so it has no lines`);
    args.push(`-L${startLine},${endLine ?? startLine}:${target.relative}`);
  } else {
    args.push('--', target.relative);
  }
  const stdout = await execFileAsync('git', args, { cwd: realRoot, env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })
    .then(result => result.stdout)
    // A history longer than the buffer is cut like any other long output.
    .catch((error: { code?: string; stdout?: string }) => {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && error.stdout) return error.stdout;
      throw error;
    });
  const shallow = existsSync(join(realRoot, '.git', 'shallow'))
    ? `\n[The repository holds only the last ${WORKSPACE_DEPTH} commits of the PR head, so older history is missing.]`
    : '';
  return capOutput(stdout.trim() || 'No commits changed it.') + shallow;
}

export interface AstGrepArgs {
  pattern: string;
  language?: typeof AST_GREP_FAMILIES[number];
  path?: string;
  maxResults?: number;
}

/**
 * Returns each match of the structural `pattern` under `path` as `file:line: first line of the match`, with a note when
 * files were left out. A file the pattern does not parse for is skipped, and the search fails only when it fails on every file.
 */
export async function astGrepSearch(root: string, api: AstGrepApi, { pattern, language, path = '.', maxResults = 50 }: AstGrepArgs): Promise<string> {
  const realRoot = realpathSync(root);
  const limit = Math.min(maxResults, MAX_MATCHES);
  const { files, cut } = listFiles(realRoot, resolveInRoot(root, path));
  const matches: string[] = [];
  const notes: string[] = [];
  let searched = 0;
  let tooLarge = 0;
  let firstError: unknown;
  for (const file of files) {
    const lang = languageOf(file);
    if (!lang || (language && lang.family !== language)) continue;
    const absolute = join(realRoot, file);
    if (statSync(absolute).size > MAX_FILE_BYTES) {
      tooLarge++;
      continue;
    }
    let nodes;
    try {
      nodes = api.parse(lang.lang, readFileSync(absolute, 'utf-8')).root().findAll(pattern);
    } catch (error) {
      firstError ??= error;
      continue;
    }
    searched++;
    for (const node of nodes) {
      matches.push(`${file}:${node.range().start.line + 1}: ${node.text().split('\n')[0].slice(0, 200)}`);
      if (matches.length >= limit) return capOutput(`${matches.join('\n')}\n[stopped at ${limit} matches]`);
    }
  }
  if (searched === 0 && firstError !== undefined) throw firstError;
  if (cut) notes.push(`[the search stopped after ${MAX_FILES} files, so later files were not searched]`);
  if (tooLarge > 0) notes.push(`[${tooLarge} files over ${MAX_FILE_BYTES / 1024} KB were not searched]`);
  return capOutput([matches.join('\n') || 'No matches.', ...notes].join('\n'));
}

/** Runs `tool` and turns its text, or the message of its error, into an MCP tool result. */
async function toolResult(tool: () => Promise<string>): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  try {
    return { content: [{ type: 'text', text: await tool() }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

/** Returns Manki's tool server for the repository at `root`. Every tool reads only inside `root` and runs no shell. */
export function createMcpServer(root: string, loadApi: () => Promise<AstGrepApi> = loadAstGrep): McpServer {
  const server = new McpServer({ name: 'manki', version: MANKI_VERSION });
  server.registerTool('git_history', {
    description: 'Lists the commits that changed a file or directory of the repository, newest first. With startLine, it follows only those lines and shows how each commit changed them.',
    inputSchema: {
      path: z.string().describe('File or directory, relative to the repository root.'),
      startLine: z.number().int().positive().optional().describe('First line to follow. Needs a file.'),
      endLine: z.number().int().positive().optional().describe('Last line to follow. Defaults to startLine.'),
      maxCommits: z.number().int().positive().max(MAX_COMMITS).optional().describe(`At most this many commits. Defaults to 20.`),
    },
  }, (args) => toolResult(() => gitHistory(root, args)));
  server.registerTool('ast_grep', {
    description: 'Finds code by syntax with an ast-grep pattern, such as `$A.unwrap()` or `fn $NAME($$$) -> Result<$T, $E>`, and lists each match as file:line.',
    inputSchema: {
      pattern: z.string().min(1).describe('ast-grep pattern. `$NAME` matches one node, `$$$` any number of nodes.'),
      language: z.enum(AST_GREP_FAMILIES).optional().describe('Only search files of this language.'),
      path: z.string().optional().describe('File or directory to search, relative to the repository root. Defaults to the whole repository.'),
      maxResults: z.number().int().positive().max(MAX_MATCHES).optional().describe('At most this many matches. Defaults to 50.'),
    },
  }, (args) => toolResult(async () => astGrepSearch(root, await loadApi(), args)));
  return server;
}

/**
 * Serves Manki's tools for the repository at `root` over stdin and stdout until the client disconnects. Exits with an
 * error on stderr when `root` is not a directory or the server cannot start.
 */
export async function runMcpServer(root: string | undefined): Promise<void> {
  try {
    if (!root || !statSync(root).isDirectory()) throw new Error(`${root ?? 'no root'} is not a directory`);
    await createMcpServer(root).connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(`Manki tool server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
