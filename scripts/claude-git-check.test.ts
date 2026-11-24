import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { GitCall, gitMark, gitReadProblems, openMark, plantCheckout, toolResults } from './claude-git-check';

describe('the check of the Claude CLI on `.git`', () => {
  let root: string;
  let calls: GitCall[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'manki-claude-git-'));
    calls = plantCheckout(root, 'marker');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  // The results of a run, where a call shows the files of `.git` when `git` is set, and the others when `open` is.
  const results = (git: boolean, open: boolean) => toolResults([
    { messages: [{ role: 'user', content: 'Reply with OK.' }] },
    { messages: [{ role: 'user', content: calls.map((call, i) => ({ type: 'tool_result', tool_use_id: `toolu_${i}`, content: `${git && call.git ? gitMark('marker') : ''} ${open && call.open ? openMark('marker') : ''}` })) }] },
  ], calls);

  it('plants each file, asks for no call that names a mark but in a search, and other letter case where the disk ignores it', () => {
    expect(['.git/notes.txt', '.git/marker-git.txt', '.github/notes.txt', 'my.git/marker-open.txt', '.gitignore', 'link/notes.txt', 'link.txt'].filter(file => !existsSync(join(root, file)))).toEqual([]);
    expect(calls.filter(call => [call.input.file_path, call.input.path, call.name === 'Glob' && call.input.pattern].some(value => String(value).includes('marker')))).toEqual([]);
    expect(calls.some(call => call.input.file_path === `${root}/.GIT/notes.txt`)).toBe(existsSync(join(root, '.GIT')));
  });

  it('reports a call that read `.git`, one that no longer shows another file, and one with no result', () => {
    const count = (kind: 'git' | 'open') => calls.filter(call => call[kind]).length;
    const problems = (git: boolean, open: boolean, control = false) => gitReadProblems('claude', 'marker', calls, results(git, open), control);
    expect(problems(false, true)).toEqual([]);
    expect(problems(true, true)).toHaveLength(count('git'));
    expect(problems(true, true)[0]).toBe(`claude: Read {"file_path":"${root}/.git/notes.txt"} read \`.git\``);
    expect(problems(false, false)).toHaveLength(count('open'));
    // A search from the root must show the other files and nothing of `.git`, also when it shows both.
    const search = calls.findIndex(call => call.name === 'Grep' && call.input.path === root);
    const leaked = results(false, true);
    leaked[search] += gitMark('marker');
    expect(gitReadProblems('claude', 'marker', calls, leaked)).toEqual([expect.stringMatching(/^claude: Grep .* read `\.git`$/)]);
    expect(gitReadProblems('claude', 'marker', calls, toolResults([], calls))[0]).toMatch(/ got no result$/);
    // The control run must show `.git`.
    expect(problems(true, false, true)).toEqual([]);
    expect(problems(false, true, true)).toHaveLength(count('git'));
  });
});
