import { rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { parsePRDiff } from './diff';
import { checkOrigins, MAX_ORIGIN_CHECKS } from './origin';
import { LLMClient, NotStartedError } from './providers';
import { AnthropicClient } from './providers/anthropic';
import { postedWhenPreExisting } from './review';
import { baseProofFixture, fakeClient, FakeCall, git, GIT_TEST_TIMEOUT_MS, gitWorkspace } from './test-utils';
import { Finding, foundOnBase, oneCheckOnBase, OriginAnswer, ParsedDiff, sameOnBase } from './types';
import { BASE_READS_FILE, fetchWorkspace } from './workspace';

jest.mock('@actions/core');

const finding = (title: string, overrides: Partial<Finding> = {}): Finding => ({
  severity: 'blocker', title, file: 'src/math.ts', line: 2, description: 'Large inputs overflow.', reviewers: ['R'],
  evidence: { checks: [], proof: ['src/math.ts:2'] }, ...overrides,
});

/** A client on `model` that answers each finding, picked by its title in the user message, with the reply `replies` holds for it. */
function originClient(replies: Record<string, unknown>, model: string): LLMClient & { calls: FakeCall[] } {
  const client = fakeClient(user => replies[Object.keys(replies).find(title => user.includes(`: ${title}\n`))!]);
  return { ...client, sendMessage: async (...args) => ({ ...await client.sendMessage(...args), model }) };
}

const titlesOf = (client: { calls: FakeCall[] }): string[] => client.calls.map(c => c.user.split('\n')[0].replace(/^## \w+: /, '')).sort();

describe('checkOrigins', () => {
  const math = 'export function add(a: number, b: number) {\n  return a + b;\n}\n';
  const same = { origin: 'pre_existing', reason: 'The sum overflowed the same way before this PR.', head: ['src/math.ts:2'], base: ['src/math.ts:2'] };

  it('keeps a pre-existing answer only with lines the code finds on both sides, the flagged line among them when the PR left it unchanged', async () => {
    // The base holds the same `src/math.ts`, one line less of `src/api.ts` and no `src/new.ts`.
    const { root, diff } = gitWorkspace(
      { 'src/math.ts': math, 'src/api.ts': '// handler\n'.repeat(8), 'README.md': 'Old notes.\n' },
      { 'src/api.ts': `${'// handler\n'.repeat(8)}if (a > 1000 || b > 1000) throw new Error();\n`, 'src/new.ts': 'export const sum = (a: number) => a + 1;\n' },
      [],
    );
    const baseCommit = git(root, 'rev-parse', 'HEAD');
    // Line 9 of `src/api.ts` is one the PR added, and line 3 one it left as it was.
    const fixed = { ...same, fixed_elsewhere_in_pr: 'src/api.ts:9' };
    const replies: Record<string, unknown> = {
      'Same before': fixed,
      'Claimed older': { ...same, fixed_elsewhere_in_pr: 'src/api.ts:3' },
      'No line at the base': { ...fixed, base: [] },
      'An unrelated file at the base': { ...same, base: ['README.md:1'] },
      // Line 9 of `src/api.ts` is there at the head only, so it is no line of the base, whatever the head holds.
      'A line of the head': { ...same, base: ['src/math.ts:2', 'src/api.ts:9'] },
      'No line at the head': { ...same, head: [] },
      'Introduced': { origin: 'introduced', reason: 'This PR adds the caller.', head: ['src/api.ts:9'], fixed_elsewhere_in_pr: 'src/api.ts:9' },
      'Note': same,
      'Tool alert': same,
      // A line the PR added has no place at the base, so the base must show the failure in the finding's own file. A file
      // the PR added has none there.
      'In a file the PR added': { ...same, head: ['src/new.ts:1'], base: ['src/math.ts:2'] },
      'Added to a changed file': { ...fixed, head: ['src/api.ts:9'], base: ['src/api.ts:8'] },
      'Added, with the base cited elsewhere': { ...same, head: ['src/api.ts:9'], base: ['src/math.ts:2'] },
      // A new caller of work an existing caller at the base already runs for the same input adds no cost of its own.
      'A new caller of shared work': { ...same, reason: 'The base runs the same work for the same input.', head: ['src/api.ts:9'], base: ['src/api.ts:1-8'] },
      'A new caller of shared work, as a blocker': { ...same, head: ['src/api.ts:9'], base: ['src/api.ts:1-8'] },
    };
    const client = originClient(replies, 'first-model');
    const pair = originClient(replies, 'pair-model');
    const progress = { started: jest.fn(), ended: jest.fn() };
    const findings = [
      ...['Same before', 'No line at the base', 'An unrelated file at the base', 'A line of the head', 'No line at the head', 'Introduced'].map(title => finding(title)),
      finding('Claimed older', { severity: 'warning', preExisting: 'The sum never had a bound.' }),
      finding('Note', { severity: 'note' }),
      finding('Tool alert', { toolSource: 'eslint' }),
      finding('In a file the PR added', { severity: 'warning', file: 'src/new.ts', line: 1, evidence: { checks: [], proof: ['src/new.ts:1'] } }),
    ];

    const checked = await checkOrigins(client, findings, { workspace: root, diff, pair, excludedPaths: ['gen/client.ts'], progress });

    expect(checked.map(f => [f.title, f.originCheck?.lineChanged, f.originCheck?.answers.map(a => `${a.model}:${a.verdict}`)])).toEqual([
      ['Same before', false, ['first-model:pre_existing', 'pair-model:pre_existing']],
      ['No line at the base', false, ['first-model:unsure', 'pair-model:unsure']],
      ['An unrelated file at the base', false, ['first-model:unsure', 'pair-model:unsure']],
      ['A line of the head', false, ['first-model:unsure', 'pair-model:unsure']],
      ['No line at the head', false, ['first-model:unsure', 'pair-model:unsure']],
      ['Introduced', false, ['first-model:introduced', 'pair-model:introduced']],
      // One answer settles a warning on an unchanged line, so the second refuter is not asked.
      ['Claimed older', false, ['first-model:pre_existing']],
      ['Note', undefined, undefined],
      ['Tool alert', undefined, undefined],
      ['In a file the PR added', true, ['first-model:unsure', 'pair-model:unsure']],
    ]);
    const onAdded = (title: string, overrides: Partial<Finding> = {}) => finding(title, { file: 'src/api.ts', line: 9, evidence: { checks: [], proof: ['src/api.ts:9'] }, ...overrides });
    const added = await checkOrigins(client, [
      onAdded('Added to a changed file'), onAdded('Added, with the base cited elsewhere'),
      onAdded('A new caller of shared work', { severity: 'warning', category: 'performance' }),
      onAdded('A new caller of shared work, as a blocker', { category: 'performance' }),
    ], { workspace: root, diff, pair });
    expect(added.map(f => [f.title, f.originCheck?.lineChanged, f.originCheck?.answers.map(a => a.verdict)])).toEqual([
      ['Added to a changed file', true, ['pre_existing', 'pre_existing']], ['Added, with the base cited elsewhere', true, ['unsure', 'unsure']],
      ['A new caller of shared work', true, ['pre_existing', 'pre_existing']], ['A new caller of shared work, as a blocker', true, ['pre_existing', 'pre_existing']],
    ]);
    // Both go to the round record only, like any pre-existing finding that is no security finding.
    expect(added.slice(2).map(f => [!!foundOnBase(f), postedWhenPreExisting(f)])).toEqual([[true, false], [true, false]]);
    expect(checked[0].originCheck?.answers[0]).toEqual({ verdict: 'pre_existing', reason: same.reason, head: ['src/math.ts:2'], base: ['src/math.ts:2'], commit: baseCommit, fixedElsewhere: 'src/api.ts:9', model: 'first-model' });
    // A fix line counts only on a standing pre-existing answer, on a line the PR added or changed other than the flagged one.
    const fixesOf = (f: Finding) => f.originCheck?.answers.map(a => a.fixedElsewhere);
    expect([...checked.slice(1, 7), ...added].map(fixesOf)).toEqual([[undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined], [undefined, undefined]]);
    // A line the base does not hold is dropped, so no answer links a line of the head as one of the base.
    expect(checked[3].originCheck?.answers[0].base).toEqual(['src/math.ts:2']);
    expect([progress.started.mock.calls, progress.ended.mock.calls.length]).toEqual([[[8]], 8]);
    // Each check that finds the failure older than the PR reports 1, so the progress comment can count them.
    const older = progress.ended.mock.calls.reduce((n: number, [found]: [number]) => n + found, 0);
    expect([older, checked.filter(f => foundOnBase(f)).length]).toEqual([2, 2]);
    // A worsened answer counts as the same case only when it says so itself, with lines that would let a pre-existing answer stand.
    const worse = { ...same, origin: 'worsened', new_case: 'none' };
    const named = { case: ' A sum over 1000 throws. ', head: ['src/api.ts:9'], base: ['src/api.ts:8'] };
    const worsened: Record<string, unknown> = {
      'Same case': worse, 'No base line': { ...worse, base: [] }, 'A base line of the head': { ...worse, base: ['src/math.ts:2', 'src/api.ts:9'] }, 'Not at the flagged line': { ...worse, base: ['src/math.ts:1'] },
      'Not said': { ...worse, new_case: undefined }, 'Null': { ...worse, new_case: null }, 'Empty': { ...worse, new_case: {} }, 'Another word': { ...worse, new_case: 'no' },
      'New case': { ...worse, new_case: named }, 'New case not at the base': { ...worse, new_case: { ...named, base: ['src/api.ts:9'] } }, 'New case without its text': { ...worse, new_case: { ...named, case: 5 } },
      'Not worsened': { ...worse, origin: 'introduced' },
    };
    const worsenedChecks = (await Promise.all(Object.keys(worsened).map(title => checkOrigins(originClient(worsened, 'm'), [finding(title)], { workspace: root, diff })))).map(([f]) => f);
    expect(worsenedChecks.map(f => [f.title, f.originCheck!.answers[0].verdict, f.originCheck!.answers[0].sameCase ?? false, f.originCheck!.answers[0].newCase])).toEqual(
      Object.keys(worsened).map(title => [title, title === 'Not worsened' ? 'introduced' : 'worsened', title === 'Same case', title === 'New case' ? { ...named, case: 'A sum over 1000 throws.' } : undefined]),
    );
    // The message shows the claim as one to check, the other files the PR changes, and the PR's change to a cited file.
    const message = (title: string) => client.calls.find(c => c.user.includes(`: ${title}\n`))!.user;
    expect(message('Claimed older')).toContain("- **A reviewer's claim that it is older than this PR**, to check: The sum never had a bound.");
    expect(message('Same before')).not.toContain('claim that it is older');
    expect(message('Same before')).toContain('- **Other files this PR changes**: src/api.ts, src/new.ts, gen/client.ts');
    expect(message('In a file the PR added')).toContain("## The PR's Change to the Cited Files");
    expect(client.calls[0].system).toContain("A failure that comes from what this PR added to a line, such as a new argument, is the PR's own.");
    expect(client.calls[0].system).toContain('`fixed_elsewhere_in_pr`');
    expect(client.calls[0].system).toContain('More memory, time or work for a case that fails at the base too, or that case happening more often, is none, also when a limit lies between the two.');
    expect(client.calls[0].system).toContain('a new caller of old code that reaches a crash, a wrong result or a security hole.');
    expect(client.calls[0].system).toContain('When the PR\'s new path runs existing work no more often and on no larger input than a path at the base already runs it for the same input, the cost is pre_existing');
    expect(client.calls[0].system).toContain('A cost that outside input can now trigger through the new caller, and could not trigger at the base, is a security hole such as resource exhaustion, and stays introduced.');
    expect(client.calls[0].system).toContain('Running the work again for an input the base already runs it for, such as a second delivery of the same data, is pre_existing even though the total work grows. A cost is worsened only when the PR makes each run of the work more expensive.');
    expect(client.calls[0].system).toContain('A cost the PR makes grow faster, such as a new loop around the work, a larger or unbounded input or a repeat that grows with the input, is introduced.');
    expect(client.calls[0].options?.repoTools).toMatchObject({ root, steps: 10 });

    // A large PR still gets the check, with every changed file named.
    const [large] = await checkOrigins(client, [finding('Same before')], { workspace: root, diff, excludedPaths: Array.from({ length: 300 }, (_, i) => `gen/${i}.ts`) });
    expect(large.originCheck?.answers.map(a => a.verdict)).toEqual(['pre_existing']);
    expect(client.calls.at(-1)!.user).toMatch(/gen\/0\.ts, .*gen\/299\.ts$/m);
    expect(client.calls.at(-1)!.user).not.toContain('does not name');
    // A list over the budget is cut and leaves the answer unsure, since a change it leaves out looks the same at the base.
    const [unnamed] = await checkOrigins(client, [finding('Same before')], { workspace: root, diff, excludedPaths: Array.from({ length: 1_100 }, (_, i) => `gen/${'nested/'.repeat(6)}${i}.ts`) });
    expect(unnamed.originCheck?.answers.map(a => a.verdict)).toEqual(['unsure']);
    expect(client.calls.at(-1)!.user).toMatch(/, and \d+ more it does not name/);
    // A base that `exclude_paths` keeps from the tools leaves the answer unsure, and a workspace without a base asks nothing.
    writeFileSync(join(root, '.git', BASE_READS_FILE), JSON.stringify({ excludePaths: ['src/math.ts'] }));
    const [excluded] = await checkOrigins(client, [finding('Same before')], { workspace: root, diff });
    expect(excluded.originCheck?.answers.map(a => a.verdict)).toEqual(['unsure']);
    rmSync(join(root, '.git', BASE_READS_FILE));
    const asked = client.calls.length;
    expect(await checkOrigins(client, [finding('Same before')], { workspace: root, diff })).toEqual([finding('Same before')]);
    expect(client.calls).toHaveLength(asked);
    rmSync(root, { recursive: true, force: true });
  }, GIT_TEST_TIMEOUT_MS);

  it('places the flagged line at the base only when the PR left it unchanged', async () => {
    const moved = gitWorkspace({ 'src/lines.ts': 'shared();\nb\nc\nshared();\n' }, { 'src/lines.ts': 'shared();\nb2\nnew\nc\nshared();\n' }, []);
    const at = (line: number, base: string[]) => ({ ...same, head: [`src/lines.ts:${line}`], base });
    const replies = {
      'Unchanged line at its base line': at(5, ['src/lines.ts:4']),
      'Unchanged line in a cited range': at(5, ['src/lines.ts:3-4']),
      'Unchanged line at a wrong base line': at(5, ['src/lines.ts:1']),
      'Changed line': at(2, ['src/lines.ts:2']),
      'Added line': at(3, ['src/lines.ts:3']),
    };
    const flagged = (title: string, line: number) => finding(title, { severity: 'warning', file: 'src/lines.ts', line, evidence: { checks: [], proof: [`src/lines.ts:${line}`] } });
    const lines = { 'Unchanged line at its base line': 5, 'Unchanged line in a cited range': 5, 'Unchanged line at a wrong base line': 5, 'Changed line': 2, 'Added line': 3 };
    const checked = await checkOrigins(originClient(replies, 'm'), Object.entries(lines).map(([title, line]) => flagged(title, line)), { workspace: moved.root, diff: moved.diff });
    expect(checked.map(f => [f.title, f.originCheck?.lineChanged, f.originCheck?.answers[0].verdict])).toEqual([
      ['Unchanged line at its base line', false, 'pre_existing'],
      ['Unchanged line in a cited range', false, 'pre_existing'],
      ['Unchanged line at a wrong base line', false, 'unsure'],
      // A changed or added line has no place at the base, so the answer stands with lines the base holds, and the rules
      // ask a second model for it.
      ['Changed line', true, 'pre_existing'],
      ['Added line', true, 'pre_existing'],
    ]);
    expect(checked.map(f => !!foundOnBase(f))).toEqual([true, true, false, false, false]);
    // A changed file whose patch GitHub left out, a file `exclude_paths` left out of the diff, and no diff at all are
    // not unchanged, so even head line 1, which reads the same at the base, counts as changed.
    const first = { 'First line': at(1, ['src/lines.ts:1']) };
    const omitted: Array<[ParsedDiff | undefined, readonly string[]]> = [
      [{ ...moved.diff, files: [], binarySkipped: [{ path: 'src/lines.ts', header: '' }] }, []],
      [{ ...moved.diff, files: [{ path: 'src/lines.ts', changeType: 'modified', hunks: [] }] }, []],
      [moved.diff, ['src/lines.ts']],
      [undefined, []],
    ];
    for (const [diff, excludedPaths] of omitted) {
      const [unmapped] = await checkOrigins(originClient(first, 'm'), [flagged('First line', 1)], { workspace: moved.root, diff, excludedPaths });
      expect(unmapped.originCheck?.lineChanged).toBe(true);
    }
    const [mapped] = await checkOrigins(originClient(first, 'm'), [flagged('First line', 1)], { workspace: moved.root, diff: moved.diff });
    expect(mapped.originCheck?.lineChanged).toBe(false);
    rmSync(moved.root, { recursive: true, force: true });
  }, GIT_TEST_TIMEOUT_MS);

  it('checks at most the round\'s limit, shared by its calls, the largest grades first, and none a later step decides or a call that fails', async () => {
    const { root, diff } = gitWorkspace({ 'src/math.ts': math }, {}, []);
    const warnings = Array.from({ length: MAX_ORIGIN_CHECKS }, (_, i) => finding(`Warning ${i + 1}`, { severity: 'warning' }));
    const replies: Record<string, unknown> = Object.fromEntries([...warnings.map(f => f.title), 'Blocker', 'Decided', 'Failing'].map(title => [title, same]));
    replies.Failing = new Error('timed out');
    const client = originClient(replies, 'm');
    const checked = await checkOrigins(client, [...warnings, finding('Decided'), finding('Blocker'), finding('Failing', { severity: 'warning' })], {
      workspace: root, diff, skip: f => f.title === 'Decided',
    });
    // The blocker goes first, so the last warning and the failing one are over the limit.
    expect(titlesOf(client)).toEqual(['Blocker', ...warnings.slice(0, MAX_ORIGIN_CHECKS - 1).map(f => f.title)].sort());
    expect(checked.filter(f => f.originCheck).length).toBe(MAX_ORIGIN_CHECKS);
    // A budget shared by the round's calls caps them together, so a later call checks only what the earlier one left.
    const budget = { left: 2 };
    const counted = originClient(replies, 'm');
    await checkOrigins(counted, [finding('Blocker')], { workspace: root, diff, budget });
    const later = await checkOrigins(counted, warnings.slice(0, 2), { workspace: root, diff, budget });
    expect([titlesOf(counted), later.map(f => !!f.originCheck), budget.left]).toEqual([['Blocker', 'Warning 1'], [true, false], 0]);
    // A call that fails leaves no answer, so the finding stays the PR's own. It still ends as a check that ran, while a
    // call that never started ends as none and records no check.
    const progress = { started: jest.fn(), ended: jest.fn() };
    const [failed] = await checkOrigins(client, [finding('Failing', { severity: 'warning' })], { workspace: root, diff, progress });
    expect([failed.originCheck, foundOnBase(failed)]).toEqual([{ lineChanged: false, answers: [] }, undefined]);
    const idle = { repoTools: true, sendMessage: jest.fn().mockRejectedValue(new NotStartedError('no quota left')) } as unknown as LLMClient;
    const [unchecked] = await checkOrigins(idle, [finding('Failing', { severity: 'warning' })], { workspace: root, diff, progress });
    expect(progress.ended.mock.calls).toEqual([[0], [undefined]]);
    expect(unchecked.originCheck).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  }, GIT_TEST_TIMEOUT_MS);

  it('keeps a finding out of the review on one answer only for a warning or note on an unchanged line that would never block', () => {
    const proven = (model?: string): OriginAnswer => ({ verdict: 'pre_existing', reason: 'r', head: ['src/math.ts:2'], base: ['src/math.ts:2'], commit: 'base', ...(model && { model }) });
    const withAnswers = (answers: OriginAnswer[], overrides: Partial<Finding> = {}, lineChanged = false): Finding => finding('F', { severity: 'warning', originCheck: { lineChanged, answers }, ...overrides });
    const one = [proven('a')];
    const two = [proven('a'), proven('b')];
    expect([
      foundOnBase(withAnswers(one)),
      foundOnBase(withAnswers(one, { severity: 'note' })),
      // The judge graded a finder's blocker a warning, so the finder's grade asks for no second model.
      foundOnBase(withAnswers(one, { reviewerSeverity: 'blocker', gradePath: [{ from: 'blocker', to: 'warning', by: 'judge' }] })),
      // A changed line, a blocker, a would-block warning, a blocker-cell warning, a security finding and the warning of a
      // disproved blocker need two models.
      foundOnBase(withAnswers(one, {}, true)),
      foundOnBase(withAnswers(one, { severity: 'blocker' })),
      foundOnBase(withAnswers(one, { gradePath: [{ from: 'blocker', to: 'warning', by: 'unproven' }] })),
      foundOnBase(withAnswers(one, { cell: { row: 'severe', column: 'normal' }, gradeIfConfirmed: 'warning' })),
      foundOnBase(withAnswers(one, { tags: ['security'] })),
      foundOnBase(withAnswers(one, { tags: ['disproved-blocker'] })),
    ].map(Boolean)).toEqual([true, true, true, false, false, false, false, false, false]);
    for (const overrides of [{}, { severity: 'blocker' as const }, { tags: ['security'] }]) {
      expect(foundOnBase(withAnswers(two, overrides, true))).toEqual(proven('a'));
    }
    // Two answers on one model, or on a model nobody named, count as one. An answer that the PR caused or worsened the
    // failure, or one stored without its base commit, leaves the finding the PR's own and adds no note.
    expect([sameOnBase(withAnswers([proven('a'), proven('a')])), sameOnBase(withAnswers([proven(), proven('b')]))]).toEqual([undefined, undefined]);
    expect(oneCheckOnBase(withAnswers([proven('a'), proven('a')], { severity: 'blocker' }))).toEqual(proven('a'));
    for (const other of [{ verdict: 'introduced' as const, reason: 'r' }, { verdict: 'worsened' as const, reason: 'r' }]) {
      const disputed = withAnswers([proven('a'), { ...other, model: 'b' }], {}, true);
      expect([sameOnBase(disputed), oneCheckOnBase(disputed), foundOnBase(disputed)]).toEqual([undefined, undefined, undefined]);
    }
    // A worsened answer without a new failing case agrees only on a warning that is not guarded, beside one on another
    // model that finds the failure at the base. The finding then goes on that one's reason.
    const sameCase = (model?: string): OriginAnswer => ({ ...proven(model), verdict: 'worsened', sameCase: true });
    for (const answers of [[proven('a'), sameCase('b')], [sameCase('b'), proven('a')]]) {
      // A finder's blocker the judge graded a warning counts as a warning, and so does a warning posted as a note by this rule.
      const judged = { from: 'blocker' as const, to: 'warning' as const, by: 'judge' as const };
      for (const overrides of [{}, { reviewerSeverity: 'blocker' as const, gradePath: [judged] }, { severity: 'note' as const, gradePath: [judged, { from: 'warning' as const, to: 'note' as const, by: 'pre_existing' as const }] }]) {
        expect(foundOnBase(withAnswers(answers, overrides, true))).toEqual(proven('a'));
      }
      const keptByRule: Array<Partial<Finding>> = [
        { severity: 'blocker' }, { severity: 'note' }, { tags: ['security'] }, { tags: ['disproved-blocker'] }, { gradeIfConfirmed: 'blocker' },
        { gradePath: [{ from: 'blocker', to: 'warning', by: 'unproven' }] }, { gradePath: [{ from: 'warning', to: 'blocker', by: 'judge' }, { from: 'blocker', to: 'warning', by: 'refutation' }] },
        { gradePath: [{ from: 'blocker', to: 'warning', by: 'pre_existing' }] },
      ];
      for (const overrides of keptByRule) {
        const kept = withAnswers(answers, overrides);
        expect([foundOnBase(kept), oneCheckOnBase(kept)]).toEqual([undefined, undefined]);
      }
    }
    for (const answers of [[sameCase('a')], [sameCase('a'), sameCase('b')], [proven('a'), sameCase('a')], [proven('a'), sameCase()], [proven('a'), { ...sameCase('b'), sameCase: undefined }], [proven('a'), sameCase('b'), { ...proven('c'), verdict: 'unsure' as const }]]) {
      const kept = withAnswers(answers);
      expect([foundOnBase(kept), oneCheckOnBase(kept)]).toEqual([undefined, undefined]);
    }
    expect(oneCheckOnBase(withAnswers([{ ...proven('a'), commit: undefined }]))).toBeUndefined();
    expect(foundOnBase(withAnswers(two, { severity: 'ignore' }))).toBeUndefined();
  });
});

// The live replay fetches the fixture's repository and asks a real model, so it runs only with
// RUN_REFUTE_LIVE_FIXTURES=1 and the token `claude setup-token` prints in CLAUDE_CODE_OAUTH_TOKEN. CI skips it.
const LIVE_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
if (process.env.RUN_REFUTE_LIVE_FIXTURES === '1' && !LIVE_TOKEN) {
  console.warn('Skipping the live origin replay: set CLAUDE_CODE_OAUTH_TOKEN to the token `claude setup-token` prints.');
}
const liveIt = process.env.RUN_REFUTE_LIVE_FIXTURES === '1' && LIVE_TOKEN ? it : it.skip;

describe('live origin replay', () => {
  liveIt('live origin check finds at the base each rust-dashcore blocker the base already had', async () => {
    const fixture = baseProofFixture('base-proof-rust-dashcore');
    const workspace = await fetchWorkspace(fixture.repository, fixture.head, undefined, [], { sha: fixture.base, excludePaths: [] });
    try {
      const diff = parsePRDiff(git(workspace, 'diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', fixture.base, fixture.head));
      const client = new AnthropicClient({ auth: { kind: 'oauth', token: LIVE_TOKEN }, model: process.env.REFUTE_LIVE_MODEL ?? 'claude-opus-5-5' });
      const findings: Finding[] = fixture.findings.map(f => ({
        severity: 'blocker', title: f.title, file: f.file, line: f.line, description: f.description, reviewers: ['replay'],
        evidence: { checks: [], proof: f.proof }, ...(f.security && { tags: ['security'] }),
      }));
      const checked = await checkOrigins(client, findings, { workspace, diff, effort: 'high' });
      for (const f of checked) console.log(`[live-origin] ${f.title}: ${JSON.stringify(f.originCheck)}`);
      // Without a second model, a blocker the base already had only notes that it may be older.
      expect(checked.map(f => [f.title, oneCheckOnBase(f) ? 'pre-existing' : 'blocker'])).toEqual(fixture.findings.map(f => [f.title, f.expected]));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 60 * 60_000);
});
