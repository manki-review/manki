import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { GitCall, gitReadProblems, plantCheckout, toolResults } from './claude-git-check';

describe('the check of the Claude CLI on `.git`', () => {
  let root: string;
  let calls: GitCall[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'manki-claude-git-'));
    calls = plantCheckout(root, 'marker');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const bodies = (shown: (call: GitCall) => boolean) => [
    { messages: [{ role: 'user', content: 'Reply with OK.' }] },
    { messages: [{ role: 'user', content: calls.map((call, i) => ({ type: 'tool_result', tool_use_id: `toolu_${i}`, content: shown(call) ? call.shows : 'denied' })) }] },
  ];

  it('plants each file and asks for no call that names the text it looks for, but in a search pattern', () => {
    expect(['.git/notes.txt', '.git/marker.txt', '.github/notes.txt', 'my.git/notes.txt', '.gitignore', 'link/notes.txt', 'link.txt'].filter(file => !existsSync(join(root, file)))).toEqual([]);
    expect(calls.filter(call => [call.input.file_path, call.input.path, call.name === 'Glob' && call.input.pattern].some(value => String(value).includes('marker')))).toEqual([]);
  });

  it('reports a call that read `.git`, one that no longer shows another file, and one with no result', () => {
    const inGit = calls.filter(call => call.inGit).length;
    const results = (shown: (call: GitCall) => boolean) => toolResults(bodies(shown), calls);
    expect(gitReadProblems('claude', calls, results(call => !call.inGit))).toEqual([]);
    const read = gitReadProblems('claude', calls, results(() => true));
    expect(read).toHaveLength(inGit);
    expect(read[0]).toBe(`claude: Read {"file_path":"${root}/.git/notes.txt"} read \`.git\``);
    expect(gitReadProblems('claude', calls, results(() => false))).toHaveLength(calls.length - inGit);
    expect(gitReadProblems('claude', calls, toolResults([bodies(() => true)[0]], calls))[0]).toMatch(/ got no result$/);
    // The control run must show every file.
    expect(gitReadProblems('control', calls, results(() => true), true)).toEqual([]);
    expect(gitReadProblems('control', calls, results(call => !call.inGit), true)).toHaveLength(inGit);
  });
});
