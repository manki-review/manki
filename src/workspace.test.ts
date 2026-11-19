import { execFileSync } from 'child_process';
import { createServer } from 'http';
import { AddressInfo } from 'net';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { git } from './test-utils';
import { closedPathsOf, closePaths, fetchWorkspace } from './workspace';

const TOKEN = 'ghs_workspaceFetchToken';
// Several git processes per test can pass Jest's default 5 seconds on a slow runner.
const GIT_TEST_TIMEOUT_MS = 30_000;

/** Every file under `dir`, `.git` included. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('fetchWorkspace', () => {
  let root: string;
  let source: string;
  const savedRunnerTemp = process.env.RUNNER_TEMP;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'manki-workspace-test-'));
    process.env.RUNNER_TEMP = root;
    source = join(root, 'source');
    execFileSync('git', ['init', '-q', source]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (savedRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = savedRunnerTemp;
  });

  it('checks out the commit with its history and symlinks as plain files, and keeps the token out of the checkout', async () => {
    writeFileSync(join(source, 'a.txt'), 'first\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'first');
    writeFileSync(join(source, 'a.txt'), 'second\n');
    symlinkSync('/etc/hosts', join(source, 'link'));
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'second');
    const sha = git(source, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'a.txt'), 'third\n');
    git(source, 'commit', '-qam', 'third');

    const dir = await fetchWorkspace(`file://${source}`, sha, TOKEN);

    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('second\n');
    expect(git(dir, 'log', '--format=%s')).toBe('second\nfirst');
    expect(git(dir, 'remote')).toBe('');
    expect(lstatSync(join(dir, 'link')).isFile()).toBe(true);
    expect(readFileSync(join(dir, 'link'), 'utf8')).toBe('/etc/hosts');
    const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    for (const file of filesUnder(dir)) {
      const text = readFileSync(file, 'latin1');
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(encoded);
    }
  }, GIT_TEST_TIMEOUT_MS);

  it('sends the token as a basic auth header with the fetch, and removes the workspace when the fetch fails', async () => {
    const headers: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      headers.push(request.headers.authorization);
      response.writeHead(404).end();
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    try {
      await expect(fetchWorkspace(`http://127.0.0.1:${port}/acme/widgets.git`, 'a'.repeat(40), TOKEN)).rejects.toThrow();
    } finally {
      server.close();
    }
    expect(headers.length).toBeGreaterThan(0);
    expect(new Set(headers)).toEqual(new Set([`basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`]));
    expect(readdirSync(root)).toEqual(['source']);
  }, GIT_TEST_TIMEOUT_MS);

  it('deletes every closed file and the folders that leaves empty, keeps the patterns for the tool server, and closes nothing without them', async () => {
    const files = ['bench/cases/a.yml', 'bench/holdout/b.yml', 'bench/holdout/deep/c.yml', 'data/secret.txt', 'data/open.txt', 'src/a.ts', 'src/secret.txt'];
    for (const file of files) {
      mkdirSync(join(source, file, '..'), { recursive: true });
      writeFileSync(join(source, file), 'closed marker\n');
    }
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'files');
    const sha = git(source, 'rev-parse', 'HEAD');
    const listed = (dir: string) => filesUnder(dir).map(f => f.slice(dir.length + 1)).filter(f => !f.startsWith('.git/')).sort();

    const closed = await fetchWorkspace(`file://${source}`, sha, undefined, ['bench/holdout/**', 'secret.txt']);
    expect(listed(closed)).toEqual(['bench/cases/a.yml', 'data/open.txt', 'src/a.ts']);
    expect(readdirSync(join(closed, 'bench'))).toEqual(['cases']);
    expect(closedPathsOf(closed)).toEqual(['bench/holdout/**', 'secret.txt']);
    // git reads a tracked file it no longer finds as deleted, so a search of the checkout finds nothing in it.
    expect(git(closed, 'grep', '-l', 'closed marker').split('\n')).toEqual(['bench/cases/a.yml', 'data/open.txt', 'src/a.ts']);

    const open = await fetchWorkspace(`file://${source}`, sha, undefined, []);
    expect(listed(open)).toEqual([...files].sort());
    expect(closedPathsOf(open)).toEqual([]);
  }, GIT_TEST_TIMEOUT_MS);

  it('reads no closed file through a symlink: the checkout holds the link text, and closing deletes any real symlink', async () => {
    mkdirSync(join(source, 'bench/holdout'), { recursive: true });
    writeFileSync(join(source, 'bench/holdout/case.yml'), 'closed marker\n');
    mkdirSync(join(source, 'src'));
    symlinkSync('../bench/holdout/case.yml', join(source, 'src/fixture.yml'));
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'link');

    const dir = await fetchWorkspace(`file://${source}`, git(source, 'rev-parse', 'HEAD'), undefined, ['bench/holdout/**']);
    expect(lstatSync(join(dir, 'src/fixture.yml')).isFile()).toBe(true);
    expect(readFileSync(join(dir, 'src/fixture.yml'), 'utf8')).toBe('../bench/holdout/case.yml');

    // A symlink that got into a checkout by other means is deleted, wherever it points.
    const checkout = mkdtempSync(join(tmpdir(), 'manki-close-'));
    mkdirSync(join(checkout, '.git'));
    mkdirSync(join(checkout, 'src'));
    writeFileSync(join(checkout, 'src/a.ts'), 'open\n');
    symlinkSync(join(source, 'bench/holdout/case.yml'), join(checkout, 'src/outside.yml'));
    symlinkSync('a.ts', join(checkout, 'src/inside.ts'));
    closePaths(checkout, ['bench/holdout/**']);
    expect(readdirSync(join(checkout, 'src'))).toEqual(['a.ts']);
    rmSync(checkout, { recursive: true, force: true });
  }, GIT_TEST_TIMEOUT_MS);
});
