import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import * as napi from '@ast-grep/napi';
import python from '@ast-grep/lang-python';
import rust from '@ast-grep/lang-rust';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createMcpServer } from './mcp-server';

// The grammars are registered once per process, so every test file registers the same ones.
napi.registerDynamicLanguage({ python, rust });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

/** Connects a client to Manki's tool server for `root`, through the MCP protocol. */
async function connect(root: string, fileTools = false): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(root, { fileTools, loadApi: async () => napi }).connect(serverTransport);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args }) as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map(c => c.text).join('\n'), isError: result.isError === true };
}

describe('Manki tool server', () => {
  let base: string;
  let repo: string;
  let outside: string;
  let client: Client;
  let fileClient: Client;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), 'manki-mcp-test-'));
    repo = join(base, 'repo');
    outside = join(base, 'outside');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.ts'), 'console.log(secret);\n');
    git(base, 'init', '-q', repo);
    writeFileSync(join(repo, 'src', 'a.ts'), 'const x = 1;\nconsole.log(x);\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'add a');
    writeFileSync(join(repo, 'src', 'a.ts'), 'const x = 2;\nconsole.log(x);\n');
    git(repo, 'commit', '-qam', 'change x');
    writeFileSync(join(repo, 'src', 'b.rs'), 'fn f(v: Option<u8>) -> u8 {\n    v.unwrap()\n}\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'add b');
    writeFileSync(join(repo, 'src', 'big.txt'), `${'a'.repeat(400_000)}\n`);
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'add big');
    for (const fill of ['b', 'c', 'd']) {
      writeFileSync(join(repo, 'src', 'big.txt'), `${fill.repeat(400_000)}\n`);
      git(repo, 'commit', '-qam', `fill ${fill}`);
    }
    mkdirSync(join(repo, 'vendor'));
    writeFileSync(join(repo, 'vendor', 'huge.ts'), `console.log(1);\n${'// filler\n'.repeat(110_000)}`);
    symlinkSync(join(outside, 'secret.ts'), join(repo, 'src', 'link.ts'));
    symlinkSync(outside, join(repo, 'src', 'outdir'));
    client = await connect(repo);
    fileClient = await connect(repo, true);
  }, 30_000);

  afterAll(async () => {
    await client.close();
    await fileClient.close();
    rmSync(base, { recursive: true, force: true });
  });

  it('offers only the git history and ast-grep tools, and the file tools when asked, all marked read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual(['ast_grep', 'git_history']);
    const { tools: withFiles } = await fileClient.listTools();
    expect(withFiles.map(t => t.name).sort()).toEqual(['ast_grep', 'git_history', 'glob', 'grep', 'read_file']);
    expect(withFiles.every(t => t.annotations?.readOnlyHint === true && t.annotations?.openWorldHint === false)).toBe(true);
  });

  it('reads, searches and lists files', async () => {
    expect(await call(fileClient, 'read_file', { path: 'src/a.ts' })).toEqual({ text: '1\tconst x = 2;\n2\tconsole.log(x);\n3\t', isError: false });
    expect((await call(fileClient, 'read_file', { path: 'src/a.ts', offset: 2, limit: 1 })).text).toBe('2\tconsole.log(x);\n[1 more lines, read on with offset 3]');
    expect((await call(fileClient, 'grep', { text: 'CONSOLE.LOG', ignoreCase: true, path: 'src' })).text).toBe('src/a.ts:2: console.log(x);');
    expect((await call(fileClient, 'grep', { text: 'unwrap', glob: '*.rs' })).text).toBe('src/b.rs:2:     v.unwrap()');
    expect((await call(fileClient, 'grep', { text: 'console.log', path: 'vendor' })).text).toBe('No matches.\n[1 binary files or files over 1024 KB were not searched]');
    expect((await call(fileClient, 'glob', { pattern: '**/*.ts' })).text).toBe('src/a.ts\nvendor/huge.ts');
  });

  it('lists the commits of a file, or only those that changed its lines', async () => {
    const file = await call(client, 'git_history', { path: 'src/a.ts' });
    expect(file.isError).toBe(false);
    expect(file.text.match(/^ {4}.+$/gm)).toEqual(['    change x', '    add a']);
    expect(file.text).not.toContain('only the last');

    const lines = await call(client, 'git_history', { path: 'src/a.ts', startLine: 2 });
    expect(lines.text.match(/^ {4}\S.*$/gm)).toEqual(['    add a']);

    // Line history of four 400 KB rewrites runs past git's output buffer and is cut instead of failing.
    const long = await call(client, 'git_history', { path: 'src/big.txt', startLine: 1 });
    expect(long.isError).toBe(false);
    expect(long.text).toContain('[output cut at 20000 characters]');
  });

  it('finds code by syntax, with file and line, and skips symlinks', async () => {
    expect(await call(client, 'ast_grep', { pattern: 'console.log($A)', path: 'src' })).toEqual({ text: 'src/a.ts:2: console.log(x)', isError: false });
    expect(await call(client, 'ast_grep', { pattern: '$V.unwrap()', language: 'rust' })).toEqual({ text: 'src/b.rs:2: v.unwrap()', isError: false });
  });

  it('skips files a pattern does not parse for, and says which files it left out', async () => {
    expect(await call(client, 'ast_grep', { pattern: 'fn $F($$$) -> u8 { $$$ }', path: 'src' })).toEqual({ text: 'src/b.rs:1: fn f(v: Option<u8>) -> u8 {', isError: false });
    expect((await call(client, 'ast_grep', { pattern: 'console.log($A)' })).text).toBe('src/a.ts:2: console.log(x)\n[1 files over 1024 KB were not searched]');
    expect(await call(client, 'ast_grep', { pattern: 'fn $F($$$) -> u8 { $$$ }', language: 'typescript', path: 'src' })).toEqual({ text: expect.stringContaining('Multiple AST nodes'), isError: true });
  });

  it.each([
    ['an absolute path outside', () => join(outside, 'secret.ts'), 'is outside the repository'],
    ['a .. path', () => '../outside/secret.ts', 'is outside the repository'],
    ['a symlinked file', () => 'src/link.ts', 'is outside the repository'],
    ['a symlinked directory', () => 'src/outdir', 'is outside the repository'],
    ['.git', () => '.git/config', 'is in .git'],
    ['a missing path', () => 'nope.ts', 'does not exist'],
  ])('refuses %s in every tool', async (_, path, message) => {
    const calls = [
      ['git_history', { path: path() }], ['ast_grep', { pattern: 'console.log($A)', path: path() }],
      ['read_file', { path: path() }], ['grep', { text: 'secret', path: path() }], ['glob', { pattern: '**', path: path() }],
    ] as const;
    for (const [tool, args] of calls) {
      const result = await call(fileClient, tool, args);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(message);
    }
  });

  it('says when the history is cut at the shallow boundary', async () => {
    const shallow = join(base, 'shallow');
    execFileSync('git', ['clone', '-q', '--depth=1', `file://${repo}`, shallow]);
    const shallowClient = await connect(shallow);

    const result = await call(shallowClient, 'git_history', { path: 'src/a.ts' });

    expect(result.text).toContain('holds only the last 500 commits');
    await shallowClient.close();
  });
});
