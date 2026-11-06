import { execFileSync } from 'child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { fetchWorkspace } from './workspace';

const TOKEN = 'ghs_workspaceFetchToken';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

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

  it('checks out the commit with its history, and keeps the token out of the checkout', async () => {
    writeFileSync(join(source, 'a.txt'), 'first\n');
    git(source, 'add', '.');
    git(source, 'commit', '-qm', 'first');
    writeFileSync(join(source, 'a.txt'), 'second\n');
    git(source, 'commit', '-qam', 'second');
    const sha = git(source, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'a.txt'), 'third\n');
    git(source, 'commit', '-qam', 'third');

    const dir = await fetchWorkspace(`file://${source}`, sha, TOKEN);

    expect(git(dir, 'rev-parse', 'HEAD')).toBe(sha);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('second\n');
    expect(git(dir, 'log', '--format=%s')).toBe('second\nfirst');
    expect(git(dir, 'remote')).toBe('');
    const encoded = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    for (const file of filesUnder(dir)) {
      const text = readFileSync(file, 'latin1');
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(encoded);
    }
  });
});
