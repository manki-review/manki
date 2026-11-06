import { execFile } from 'child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { promisify } from 'util';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Minimatch } from 'minimatch';
import { z } from 'zod';

import { AST_GREP_FAMILIES, AstGrepApi, languageOf, loadAstGrep } from './ast-grep';
import { MANKI_VERSION } from './github';
import { stepCheck } from './tool-steps';
import { gitEnv, WORKSPACE_DEPTH } from './workspace';

const execFileAsync = promisify(execFile);

/** The argument of `dist/index.js` that starts the tool server instead of a review. */
export const MCP_SERVER_COMMAND = 'mcp-server';

/** The argument after the root that makes the tool server also offer `read_file`, `grep` and `glob`. */
export const FILE_TOOLS_FLAG = '--file-tools';

/** The argument before the number of tool calls the server runs before it refuses every further call. */
export const STEPS_FLAG = '--steps';

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

const MAX_READ_LINES = 2000;
const READ_NOTE_ROOM = 100;
const MAX_GLOB_RESULTS = 500;

/** Reads `absolute` as text, or returns `undefined` for a file over `MAX_FILE_BYTES` or one that looks binary. */
function readText(absolute: string): string | undefined {
  if (statSync(absolute).size > MAX_FILE_BYTES) return undefined;
  const text = readFileSync(absolute, 'utf-8');
  return text.slice(0, 8000).includes('\0') ? undefined : text;
}

export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

/** Returns lines `offset` to `offset + limit - 1` of the file, each prefixed with its number and a tab. */
export async function readRepoFile(root: string, { path, offset = 1, limit = MAX_READ_LINES }: ReadFileArgs): Promise<string> {
  const target = resolveInRoot(root, path);
  if (!statSync(target.absolute).isFile()) throw new Error(`${path} is not a file`);
  const text = readText(target.absolute);
  if (text === undefined) throw new Error(`${path} is binary or over ${MAX_FILE_BYTES / 1024} KB`);
  const lines = text.split('\n');
  const last = Math.min(lines.length, offset - 1 + Math.min(limit, MAX_READ_LINES));
  const shown: string[] = [];
  let chars = 0;
  let end = offset - 1;
  // Stops before the output cap, so the note that names the next offset is never the part that gets cut.
  for (; end < last; end++) {
    const line = `${end + 1}\t${lines[end]}`;
    if (shown.length > 0 && chars + line.length + 1 > MAX_OUTPUT_CHARS - READ_NOTE_ROOM) break;
    shown.push(line);
    chars += line.length + 1;
  }
  const more = end < lines.length ? `\n[${lines.length - end} more lines, read on with offset ${end + 1}]` : '';
  return capOutput((shown.join('\n') || `${path} has no line ${offset}.`) + more);
}

const MAX_GLOB_CHARS = 200;
const MAX_GLOB_ALTERNATIVES = 100;

/**
 * Compiles a glob once for a whole search. Refuses a long glob, nested braces, a brace range such as `{1..9}`, and braces
 * that expand into more than `MAX_GLOB_ALTERNATIVES` patterns, since each of them can make a huge regular expression.
 */
function compileGlob(pattern: string): Minimatch {
  if (pattern.length > MAX_GLOB_CHARS) throw new Error(`the glob is longer than ${MAX_GLOB_CHARS} characters`);
  const alternatives = (pattern.match(/\{[^{}]*\}/g) ?? []).reduce((n, group) => n * group.split(',').length, 1);
  if (/\{[^}]*\{|\{[^}]*\.\.[^}]*\}/.test(pattern) || alternatives > MAX_GLOB_ALTERNATIVES) {
    throw new Error(`the glob expands into more than ${MAX_GLOB_ALTERNATIVES} patterns, nests braces or uses a brace range`);
  }
  // Extglobs such as `+(a|aa)+(a|aa)b` compile to nested quantifiers that backtrack for ages on a long file name.
  return new Minimatch(pattern, { dot: true, matchBase: !pattern.includes('/'), noext: true });
}

export interface GrepArgs {
  text: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  maxResults?: number;
}

/** Returns each line under `path` that contains `text`, as `file:line: line`. Matches plain text, not a regular expression. */
export async function grepRepo(root: string, { text, path = '.', glob, ignoreCase = false, maxResults = 100 }: GrepArgs): Promise<string> {
  const realRoot = realpathSync(root);
  const { files, cut } = listFiles(realRoot, resolveInRoot(root, path));
  const filter = glob === undefined ? undefined : compileGlob(glob);
  const needle = ignoreCase ? text.toLowerCase() : text;
  const limit = Math.min(maxResults, MAX_MATCHES);
  const matches: string[] = [];
  let skipped = 0;
  for (const file of files) {
    if (filter && !filter.match(file)) continue;
    const content = readText(join(realRoot, file));
    if (content === undefined) {
      skipped++;
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!(ignoreCase ? lines[i].toLowerCase() : lines[i]).includes(needle)) continue;
      matches.push(`${file}:${i + 1}: ${lines[i].slice(0, 200)}`);
      if (matches.length >= limit) return capOutput(`${matches.join('\n')}\n[stopped at ${limit} matches]`);
    }
  }
  const notes = [
    ...(cut ? [`[the search stopped after ${MAX_FILES} files, so later files were not searched]`] : []),
    ...(skipped > 0 ? [`[${skipped} binary files or files over ${MAX_FILE_BYTES / 1024} KB were not searched]`] : []),
  ];
  return capOutput([matches.join('\n') || 'No matches.', ...notes].join('\n'));
}

export interface GlobArgs {
  pattern: string;
  path?: string;
}

/** Returns the files under `path` whose path relative to the repository root matches the glob `pattern`. */
export async function globRepo(root: string, { pattern, path = '.' }: GlobArgs): Promise<string> {
  const glob = compileGlob(pattern);
  const { files, cut } = listFiles(realpathSync(root), resolveInRoot(root, path));
  const matched = files.filter(file => glob.match(file));
  const shown = matched.slice(0, MAX_GLOB_RESULTS);
  const notes = [
    ...(matched.length > shown.length ? [`[${matched.length - shown.length} more files]`] : []),
    ...(cut ? [`[the listing stopped after ${MAX_FILES} files]`] : []),
  ];
  return capOutput([shown.join('\n') || 'No files.', ...notes].join('\n'));
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

/** Runs `tool` and turns its text, or the message of its error, into an MCP tool result. */
async function toolResult(tool: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await tool() }] };
  } catch (error) {
    return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
}

export interface McpServerOptions {
  /** Also offer `read_file`, `grep` and `glob`, for a CLI without file tools of its own. */
  fileTools?: boolean;
  /** Refuse every tool call after this many, and add the wrap-up note to the call that leaves `WRAP_UP_STEPS`. */
  steps?: number;
  loadApi?: () => Promise<AstGrepApi>;
}

// Read-only and closed-world, so a CLI that asks before a tool with side effects runs these without asking.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

/** Returns Manki's tool server for the repository at `root`. Every tool reads only inside `root` and runs no shell. */
export function createMcpServer(root: string, { fileTools = false, steps, loadApi = loadAstGrep }: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'manki', version: MANKI_VERSION });
  let taken = 0;
  const run = async (tool: () => Promise<string>): Promise<ToolResult> => {
    const check = steps === undefined ? {} : stepCheck(++taken, steps);
    if (check.refusal) return { content: [{ type: 'text', text: check.refusal }], isError: true };
    const result = await toolResult(tool);
    if (check.note) result.content.push({ type: 'text', text: check.note });
    return result;
  };
  if (fileTools) {
    server.registerTool('read_file', {
      description: 'Reads a text file of the repository, numbering each line.',
      inputSchema: {
        path: z.string().describe('File, relative to the repository root.'),
        offset: z.number().int().positive().optional().describe('First line to read. Defaults to 1.'),
        limit: z.number().int().positive().max(MAX_READ_LINES).optional().describe(`At most this many lines. Defaults to ${MAX_READ_LINES}.`),
      },
      annotations: READ_ONLY,
    }, (args) => run(() => readRepoFile(root, args)));
    server.registerTool('grep', {
      description: 'Finds the lines of the repository that contain a piece of text, and lists each as file:line. Matches plain text, not a regular expression.',
      inputSchema: {
        text: z.string().min(1).describe('Text to find.'),
        path: z.string().optional().describe('File or directory to search, relative to the repository root. Defaults to the whole repository.'),
        glob: z.string().optional().describe('Only search files whose path matches this glob, such as `*.rs` or `src/**/*.ts`.'),
        ignoreCase: z.boolean().optional().describe('Ignore case. Defaults to false.'),
        maxResults: z.number().int().positive().max(MAX_MATCHES).optional().describe('At most this many matches. Defaults to 100.'),
      },
      annotations: READ_ONLY,
    }, (args) => run(() => grepRepo(root, args)));
    server.registerTool('glob', {
      description: 'Lists the files of the repository whose path matches a glob, such as `**/*.rs` or `src/net/*`.',
      inputSchema: {
        pattern: z.string().min(1).describe('Glob over paths relative to the repository root.'),
        path: z.string().optional().describe('Directory to list, relative to the repository root. Defaults to the whole repository.'),
      },
      annotations: READ_ONLY,
    }, (args) => run(() => globRepo(root, args)));
  }
  server.registerTool('git_history', {
    description: 'Lists the commits that changed a file or directory of the repository, newest first. With startLine, it follows only those lines and shows how each commit changed them.',
    inputSchema: {
      path: z.string().describe('File or directory, relative to the repository root.'),
      startLine: z.number().int().positive().optional().describe('First line to follow. Needs a file.'),
      endLine: z.number().int().positive().optional().describe('Last line to follow. Defaults to startLine.'),
      maxCommits: z.number().int().positive().max(MAX_COMMITS).optional().describe(`At most this many commits. Defaults to 20.`),
    },
    annotations: READ_ONLY,
  }, (args) => run(() => gitHistory(root, args)));
  server.registerTool('ast_grep', {
    description: 'Finds code by syntax with an ast-grep pattern, such as `$A.unwrap()` or `fn $NAME($$$) -> Result<$T, $E>`, and lists each match as file:line.',
    inputSchema: {
      pattern: z.string().min(1).describe('ast-grep pattern. `$NAME` matches one node, `$$$` any number of nodes.'),
      language: z.enum(AST_GREP_FAMILIES).optional().describe('Only search files of this language.'),
      path: z.string().optional().describe('File or directory to search, relative to the repository root. Defaults to the whole repository.'),
      maxResults: z.number().int().positive().max(MAX_MATCHES).optional().describe('At most this many matches. Defaults to 50.'),
    },
    annotations: READ_ONLY,
  }, (args) => run(async () => astGrepSearch(root, await loadApi(), args)));
  return server;
}

/**
 * Serves Manki's tools over stdin and stdout until the client disconnects. `args` are the repository root, then
 * `FILE_TOOLS_FLAG` for the file tools and `STEPS_FLAG` with a number for a step budget. Exits with an error on stderr
 * when the arguments are wrong, the root is not a directory or the server cannot start.
 */
export async function runMcpServer(args: string[]): Promise<void> {
  try {
    const [root, ...flags] = args;
    const stepsAt = flags.indexOf(STEPS_FLAG);
    const steps = stepsAt === -1 ? undefined : Number(flags[stepsAt + 1]);
    if (steps !== undefined && !(Number.isInteger(steps) && steps > 0)) throw new Error(`${STEPS_FLAG} needs a positive whole number`);
    if (!root || !statSync(root).isDirectory()) throw new Error(`${root ?? 'no root'} is not a directory`);
    await createMcpServer(root, { fileTools: flags.includes(FILE_TOOLS_FLAG), steps }).connect(new StdioServerTransport());
  } catch (error) {
    process.stderr.write(`Manki tool server: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
