import { LLMClient, SendMessageOptions } from './providers';
import { runSweeps, startsSweep } from './sweep';
import { Finding, SweepMode } from './types';
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

describe('startsSweep', () => {
  const confirmed = { outcome: 'confirmed' as const, defect: 'confirmed' as const, reason: 'It does.', files: ['src/cache.ts'], codeDigest: 'd' };
  const disproved = { outcome: 'disproved' as const, reason: 'Bounded.', files: [], codeDigest: '' };
  const unproven = { checks: [], proof: [] };
  const warning = (overrides: Partial<Finding> = {}) => blocker('Stale entry', { severity: 'warning', ...overrides });
  const note = (overrides: Partial<Finding> = {}) => blocker('Guard missing', { severity: 'note', cell: { row: 'improvement', column: 'normal' }, ...overrides });
  const modes = (finding: Finding) => (['off', 'blockers', 'warnings', 'notes'] as SweepMode[]).filter(mode => startsSweep(finding, mode));

  it.each<[string, Finding, SweepMode[]]>([
    ['a blocker', blocker('Cache key misses the locale'), ['blockers', 'warnings', 'notes']],
    ['a blocker nothing confirmed', blocker('Cache key misses the locale', { evidence: unproven }), ['blockers', 'warnings', 'notes']],
    ['a blocker a check disproved', blocker('Cache key misses the locale', { refutation: disproved }), []],
    ['a warning its cited lines prove', warning(), ['warnings', 'notes']],
    ['a warning a check confirmed', warning({ evidence: unproven, refutation: confirmed }), ['warnings', 'notes']],
    ['a warning that cites no proof', warning({ evidence: unproven }), []],
    ['a warning a check left unsettled', warning({ refutation: { ...confirmed, outcome: 'unsettled', defect: 'unsettled' } }), []],
    ['a warning a tool reported', warning({ toolSource: 'eslint' }), []],
    ['a note', note(), ['notes']],
    ['a note without a cell', note({ cell: undefined }), ['notes']],
    ['a note on style', note({ cell: { row: 'style', column: 'normal' } }), []],
    ['a note a check disproved', note({ refutation: disproved }), []],
    ['a note a tool reported', note({ toolSource: 'eslint' }), []],
    ['a finding the judge dropped', note({ severity: 'ignore' }), []],
  ])('%s starts a sweep only under the settings that reach its grade', (_name, finding, expected) => {
    expect(modes(finding)).toEqual(expected);
  });
});

describe('runSweeps', () => {
  it('states each finding\'s class in general terms and reports every other place in the diff, without the finding\'s own line', async () => {
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
      reviewer: 'Sweep 1', source: 'src/cache.ts:10', severity: 'blocker', status: 'answered',
      class: 'a cache key leaves out a field the cached value depends on', findings: 1,
    }]);
    const [{ system, user, options }] = client.calls;
    expect(system).toContain('never the names, values or files of this instance');
    expect(system).toContain('Never report the finding\'s own location again.');
    expect(system).toContain('Grade each place on its own, by what goes wrong there');
    expect(system).toContain('- **warning**: a real case that fails, but not catastrophically. List its proving lines in `proof` too.');
    expect(system).toContain(UNTRUSTED_CONTENT_RULE);
    expect(user).toContain('## Finding: Cache key misses the locale');
    expect(user).toContain('- **Location**: src/cache.ts:10');
    expect(user).toContain('const key = `${user}:${page}`;');
    expect(options).toEqual({ effort: 'high', repoTools: { root: '/work', steps: 15 }, timeoutMs: 600_000 });
  });

  it('sweeps at most three findings, security ones first, then by grade and the best checked, and records why each one found nothing', async () => {
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
      // A security finding goes before every other finding, whatever its grade.
      blocker('Broken reply', { severity: 'note', tags: ['security'], line: 4 }),
      blocker('Token in log', { tags: ['security'], evidence: unproven, line: 5 }),
      blocker('Unranked note', { severity: 'note', line: 6 }),
      blocker('Second note', { severity: 'note', noteRank: 1, line: 7 }),
      blocker('First note', { severity: 'note', noteRank: 0, evidence: unproven, line: 8 }),
      blocker('Proven warning', { severity: 'warning', line: 9 }),
    ];

    const { findings, sweeps } = await runSweeps(() => client, blockers, { rawDiff });

    expect(findings).toEqual([]);
    // Each sweep is numbered in its order, and its record names the finding's location and grade, never its text.
    expect(sweeps.map(s => [s.reviewer, s.source, s.severity, s.status])).toEqual([
      ['Sweep 1', 'src/cache.ts:5', 'blocker', 'answered'],
      // A reply that does not parse is asked once more, then recorded as failed.
      ['Sweep 2', 'src/cache.ts:4', 'note', 'failed'],
      ['Sweep 3', 'src/cache.ts:3', 'blocker', 'too_specific'],
      ['Sweep 4', 'src/cache.ts:1', 'blocker', 'cut'],
      ['Sweep 5', 'src/cache.ts:2', 'blocker', 'cut'],
      ['Sweep 6', 'src/cache.ts:9', 'warning', 'cut'],
      // The notes keep the judge's order, the unranked last.
      ['Sweep 7', 'src/cache.ts:8', 'note', 'cut'],
      ['Sweep 8', 'src/cache.ts:7', 'note', 'cut'],
      ['Sweep 9', 'src/cache.ts:6', 'note', 'cut'],
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
