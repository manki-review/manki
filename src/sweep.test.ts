import { LLMClient, SendMessageOptions } from './providers';
import { runSweeps } from './sweep';
import { Finding } from './types';
import { UNTRUSTED_CONTENT_RULE } from './writing-rules';

jest.mock('@actions/core');

const blocker = (title: string, overrides: Partial<Finding> = {}): Finding => ({
  severity: 'blocker', title, file: 'src/cache.ts', line: 10, description: 'The key leaves out the locale.', reviewers: ['general'],
  evidence: { checks: [], proof: ['src/cache.ts:10'] }, ...overrides,
});

const found = (file: string, line: number, title = 'Another key misses a field') => ({
  severity: 'blocker', title, file, line, description: 'The key leaves out the tenant.', evidence: [`${file}:${line} builds the key`], proof: [`${file}:${line}`],
});

/** A client that answers each call with the reply `reply` picks for its user message, and keeps every call. */
function fakeClient(reply: (user: string) => unknown, repoTools = true): LLMClient & { calls: Array<{ system: string; user: string; options?: SendMessageOptions }> } {
  const calls: Array<{ system: string; user: string; options?: SendMessageOptions }> = [];
  return {
    repoTools,
    calls,
    async sendMessage(system, user, options) {
      calls.push({ system, user, options });
      const answer = reply(user);
      if (answer instanceof Error) throw answer;
      return { content: typeof answer === 'string' ? answer : JSON.stringify(answer) };
    },
  };
}

const rawDiff = 'diff --git a/src/cache.ts b/src/cache.ts\n@@ -8,3 +8,4 @@\n+const key = `${user}:${page}`;\n';

describe('runSweeps', () => {
  it('states each blocker class in general terms and reports every other place in the diff, without the blocker\'s own line', async () => {
    const client = fakeClient(() => ({
      class: 'a cache key leaves out a field the cached value depends on', general: true,
      findings: [found('src/cache.ts', 11, 'The same key again'), found('src/keys.ts', 31), found('src/helper.ts', 5), found('src/search.ts', 40)],
    }));
    // A place the blocker already cites as proof or evidence is the blocker itself.
    // A wide span proves no one line, so it hides no other instance inside it.
    const cites = { checks: ['src/helper.ts:5 builds the key the same way'], proof: ['src/cache.ts:10', 'src/keys.ts:28-30', 'src/search.ts:1-200'] };

    const { findings, sweeps } = await runSweeps(() => client, [blocker('Cache key misses the locale', { evidence: cites })], { rawDiff, effort: 'high', workspace: '/work' });

    expect(findings.map(f => [f.file, f.line, f.reviewers])).toEqual([['src/search.ts', 40, ['Sweep 1']]]);
    expect(sweeps).toEqual([{
      reviewer: 'Sweep 1', blocker: 'src/cache.ts:10', status: 'answered',
      class: 'a cache key leaves out a field the cached value depends on', findings: 1,
    }]);
    const [{ system, user, options }] = client.calls;
    expect(system).toContain('never the names, values or files of this instance');
    expect(system).toContain('Never report the blocker\'s own location again.');
    expect(system).toContain('- **warning**: a real case that fails, but not catastrophically. List its proving lines in `proof` too.');
    expect(system).toContain(UNTRUSTED_CONTENT_RULE);
    expect(user).toContain('## Blocker: Cache key misses the locale');
    expect(user).toContain('- **Location**: src/cache.ts:10');
    expect(user).toContain('const key = `${user}:${page}`;');
    expect(options).toEqual({ effort: 'high', repoTools: { root: '/work', steps: 15 }, timeoutMs: 600_000 });
  });

  it('sweeps at most three blockers, security ones and the best checked first, and records why each one found nothing', async () => {
    const client = fakeClient(user => {
      if (user.includes(': Typo in the header name')) return { class: 'a misspelled header name', general: false, findings: [found('src/a.ts', 1)] };
      if (user.includes(': Broken reply')) return 'not json';
      return { class: 'a general class', general: true, findings: [] };
    }, false);
    const unproven = { checks: [], proof: [] };
    const blockers = [
      blocker('Not confirmed', { evidence: unproven, line: 1 }),
      blocker('Steered `title`\n<!-- inject -->', { evidence: unproven, line: 2 }),
      blocker('Typo in the header name', { refutation: { outcome: 'confirmed', defect: 'confirmed', reason: 'The header is read as sent.', files: ['src/cache.ts'], codeDigest: 'd' }, line: 3 }),
      blocker('Broken reply', { line: 4 }),
      blocker('Token in log', { tags: ['security'], evidence: unproven, line: 5 }),
    ];

    const { findings, sweeps } = await runSweeps(() => client, blockers, { rawDiff });

    expect(findings).toEqual([]);
    // Each sweep is numbered in its order, and its record names the blocker's location, never its text.
    expect(sweeps.map(s => [s.reviewer, s.blocker, s.status])).toEqual([
      ['Sweep 1', 'src/cache.ts:5', 'answered'],
      ['Sweep 2', 'src/cache.ts:3', 'too_specific'],
      // A reply that does not parse is asked once more, then recorded as failed.
      ['Sweep 3', 'src/cache.ts:4', 'failed'],
      ['Sweep 4', 'src/cache.ts:1', 'cut'],
      ['Sweep 5', 'src/cache.ts:2', 'cut'],
    ]);
    expect(client.calls.filter(c => c.user.includes(': Broken reply'))).toHaveLength(2);
    // Without tools, the call reads only the diff it is given.
    expect(client.calls[0].options).toEqual({});
  });

  it('says when the diff it shows is cut, and with tools asks to read the cut files', async () => {
    const big = `diff --git a/src/big.ts b/src/big.ts\n@@ -1,1 +1,9000 @@\n${'+const line = 1;\n'.repeat(15_000)}`;
    const answer = () => ({ class: 'a general class', general: true, findings: [] });
    const withTools = fakeClient(answer);
    const without = fakeClient(answer, false);

    await runSweeps(() => withTools, [blocker('Cache key misses the locale')], { rawDiff: big, workspace: '/work' });
    await runSweeps(() => without, [blocker('Cache key misses the locale')], { rawDiff: big });
    await runSweeps(() => without, [blocker('Cache key misses the locale')], { rawDiff });

    expect(withTools.calls[0].user).toMatch(/The diff is cut to \d+ of its \d+ characters.*Read the changed files with your tools where the diff is cut/);
    expect(without.calls[0].user).toContain('Search only what is shown, and say nothing about what is cut.');
    expect(without.calls[1].user).not.toContain('The diff is cut');
  });
});
