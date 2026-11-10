import { LLMClient, SendMessageOptions } from './providers';
import { runSweeps } from './sweep';
import { Finding } from './types';
import { UNTRUSTED_CONTENT_RULE } from './writing-rules';

jest.mock('@actions/core');

const blocker = (title: string, overrides: Partial<Finding> = {}): Finding => ({
  severity: 'blocker', title, file: 'src/cache.ts', line: 10, description: 'The key leaves out the locale.', reviewers: ['general'],
  evidence: { checks: [], proof: ['src/cache.ts:10'] }, judgeConfidence: 'medium', ...overrides,
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
      findings: [found('src/cache.ts', 11, 'The same key again'), found('src/search.ts', 40)],
    }));

    const { findings, sweeps } = await runSweeps(() => client, [blocker('Cache key misses the locale')], { rawDiff, effort: 'high', workspace: '/work' });

    expect(findings.map(f => [f.file, f.line, f.reviewers])).toEqual([['src/search.ts', 40, ['Sweep: Cache key misses the locale']]]);
    expect(sweeps).toEqual([{
      reviewer: 'Sweep: Cache key misses the locale', blocker: 'src/cache.ts:10', status: 'answered',
      class: 'a cache key leaves out a field the cached value depends on', findings: 1,
    }]);
    const [{ system, user, options }] = client.calls;
    expect(system).toContain('never the names, values or files of this instance');
    expect(system).toContain('Never report the blocker\'s own location again.');
    expect(system).toContain(UNTRUSTED_CONTENT_RULE);
    expect(user).toContain('## Blocker: Cache key misses the locale');
    expect(user).toContain('- **Location**: src/cache.ts:10');
    expect(user).toContain('const key = `${user}:${page}`;');
    expect(options).toEqual({ effort: 'high', repoTools: { root: '/work', steps: 15 }, timeoutMs: 600_000 });
  });

  it('sweeps at most three blockers, security ones and the surest first, and records why each one found nothing', async () => {
    const client = fakeClient(user => {
      if (user.includes(': Typo in the header name')) return { class: 'a misspelled header name', general: false, findings: [found('src/a.ts', 1)] };
      if (user.includes(': Broken reply')) return 'not json';
      return { class: 'a general class', general: true, findings: [] };
    }, false);
    const blockers = [
      blocker('Low confidence', { judgeConfidence: 'low' }),
      blocker('Typo in the header name', { judgeConfidence: 'high' }),
      blocker('Broken reply'),
      blocker('Token in log', { tags: ['security'], judgeConfidence: 'low' }),
    ];

    const { findings, sweeps } = await runSweeps(() => client, blockers, { rawDiff });

    expect(findings).toEqual([]);
    expect(sweeps.map(s => [s.reviewer, s.status])).toEqual([
      ['Sweep: Token in log', 'answered'],
      ['Sweep: Typo in the header name', 'too_specific'],
      // A reply that does not parse is asked once more, then recorded as failed.
      ['Sweep: Broken reply', 'failed'],
      ['Sweep: Low confidence', 'cut'],
    ]);
    expect(client.calls.filter(c => c.user.includes(': Broken reply'))).toHaveLength(2);
    // Without tools, the call reads only the diff it is given.
    expect(client.calls[0].options).toEqual({});
  });
});
