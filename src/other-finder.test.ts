import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { otherFinderVotes, withVote } from './other-finder';
import type { LLMClient } from './providers';
import { GIT_TEST_TIMEOUT_MS } from './test-utils';
import { DISPROVED_TAG, Finding, isGuardedFinding, OtherFinderVote, ParsedDiff, pendingGrade, wouldBlockIfTrue } from './types';
import { closePaths } from './workspace';

const finding = (more: Partial<Finding>): Finding => ({
  severity: 'warning', title: 'Totals drift', file: 'src/a.ts', line: 3, description: 'Totals drift.', reviewers: ['Finder A'], judgeNotes: '', soleFinder: true, ...more,
});
const declined: OtherFinderVote = { finder: 'Finder B', trigger: { reason: '' }, result: { reason: '' }, answer: 'declines' };
const backed: OtherFinderVote = {
  finder: 'Finder B', trigger: { reason: 'Any export.', line: 'src/export.ts:9', quote: 'exportAll();', held: true }, result: { reason: 'A total is wrong.', line: 'src/a.ts:3', quote: 'total += 1;', held: true }, answer: 'backs',
};

describe('withVote', () => {
  it('lowers a declined blocker to a guarded warning and a declined warning to a note, and leaves alone a finding a refuter lowered or a rule grades', () => {
    // A declined blocker is a warning only a fix or a maintainer clears, as one the refuters disproved. Its cell moves to
    // `judgeCell`, so a later round does not restore the blocker from it.
    const cell = { row: 'wrong' as const, column: 'normal' as const };
    const lowered = withVote(finding({ severity: 'blocker', cell }), declined);
    expect([lowered.severity, lowered.gradePath, lowered.otherFinderVote]).toEqual(['warning', [{ from: 'blocker', to: 'warning', by: 'other_finder', reason: 'the other finder would not block on it' }], declined]);
    expect([lowered.cell, lowered.judgeCell]).toEqual([undefined, cell]);
    expect(isGuardedFinding(lowered.tags, lowered.reviewers)).toBe(true);
    expect(withVote(finding({ severity: 'blocker' }), backed)).toEqual(finding({ severity: 'blocker', otherFinderVote: backed }));

    // A declined warning stays visible as a note.
    const note = withVote(finding({}), declined);
    expect([note.severity, note.gradePath, note.unpostedReason]).toEqual(['note', [{ from: 'warning', to: 'note', by: 'other_finder', reason: 'the other finder cited no trigger and result in normal use' }], undefined]);
    expect(withVote(finding({}), backed).severity).toBe('warning');

    // A check confirms the code path, not the harm, so a confirmed blocker still becomes a guarded warning, and a confirmed warning a note.
    const refutation = { outcome: 'confirmed' as const, defect: 'confirmed' as const, reason: 'The total drifts.', files: ['src/a.ts'], codeDigest: 'abc' };
    const confirmed = withVote(finding({ severity: 'blocker', cell, refutation }), declined);
    expect([confirmed.severity, confirmed.judgeCell, isGuardedFinding(confirmed.tags, confirmed.reviewers)]).toEqual(['warning', cell, true]);
    expect(withVote(finding({ refutation }), declined).severity).toBe('note');
    // A finding the refuter already lowered from a blocker took its step, whether its disproof guards it or not.
    const disproved = finding({ gradePath: [{ from: 'blocker', to: 'warning', by: 'refutation' }], tags: [DISPROVED_TAG] });
    expect(withVote(disproved, declined)).toBe(disproved);
    const unguarded = finding({ gradePath: [{ from: 'blocker', to: 'warning', by: 'refutation' }] });
    expect(withVote(unguarded, declined)).toBe(unguarded);
    // A warning the judge held in a blocker cell goes to a note like any other warning, whether it holds the cell as `cell` or `judgeCell`.
    // Its cell moves to `judgeCell` and it drops `gradeIfConfirmed`, so a later round does not raise the note from them.
    const heldNote = withVote(finding({ cell, gradeIfConfirmed: 'blocker' }), declined);
    expect([heldNote.severity, heldNote.cell, heldNote.judgeCell, heldNote.gradeIfConfirmed]).toEqual(['note', undefined, cell, 'blocker']);
    // The vote settles its grade, so it has no `pendingGrade` and would no longer block if true.
    expect([pendingGrade(heldNote), wouldBlockIfTrue(heldNote), wouldBlockIfTrue(finding({ cell, gradeIfConfirmed: 'blocker' }))]).toEqual([undefined, false, true]);
    // A warning whose blocker cell an unconfirmed raise already moved to `judgeCell` keeps it there.
    const capped = withVote(finding({ judgeCell: cell, gradeIfConfirmed: 'blocker' }), declined);
    expect([capped.severity, capped.cell, capped.judgeCell, capped.gradeIfConfirmed]).toEqual(['note', undefined, cell, 'blocker']);
    const degraded = { row: 'degraded' as const, column: 'normal' as const };
    expect(withVote(finding({ cell: degraded }), declined)).toMatchObject({ severity: 'note', cell: degraded });
    expect(withVote(finding({ judgeCell: cell }), declined).severity).toBe('note');

    // A rule the refuter confirmed after the vote was asked gives the finding its grade.
    const rule = { file: 'AGENTS.md', quote: 'Every export is logged.', verdict: 'confirmed' as const };
    expect(withVote(finding({ rule }), declined, 'warn')).toEqual(finding({ rule }));
    expect(withVote(finding({ severity: 'blocker', rule }), declined, 'block').severity).toBe('blocker');
    expect(withVote(finding({ rule }), declined, 'auto').severity).toBe('note');
  });
});

describe('otherFinderVotes', () => {
  it('asks a finder other than the one a second read or a sweep counts as', async () => {
    const client = (): LLMClient => ({ sendMessage: jest.fn().mockResolvedValue({ content: JSON.stringify({ trigger: { reason: '', line: 'none' }, result: { reason: '', line: 'none' } }) }) }) as unknown as LLMClient;
    const finders = [{ name: 'Finder A', model: 'opus', client: client() }, { name: 'Finder B', model: 'sol', client: client() }];
    const countsAs = new Map([['Second read 1', ['Finder A']], ['Sweep 1', ['Finder A']]]);
    const findings = [finding({ reviewers: ['Second read 1'] }), finding({ reviewers: ['Sweep 1'] }), finding({ reviewers: ['Finder B'] })];
    const votes = await otherFinderVotes(findings, { workspace: '/work/pr-head', finders, restates: () => false, countsAs, reads: [{ reviewer: 'Second read 1', model: 'opus' }] });
    expect(votes.map(v => v?.finder)).toEqual(['Finder B', 'Finder B', 'Finder A']);
  });

  it('asks a finding only second reads reported of a finder on another model than every read that reported it, and of none when no such finder ran', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'manki-vote-'));
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'a.ts'), 'let total = 0;\ntotal += 1;\ntotal += 1;\n');
    const client = (): LLMClient => ({ sendMessage: jest.fn().mockResolvedValue({ content: JSON.stringify({ trigger: { reason: '', line: 'none' }, result: { reason: '', line: 'none' } }) }) } as unknown as LLMClient);
    const read = finding({ reviewers: ['Second read 1'], soleFinder: undefined });
    const reads = [{ reviewer: 'Second read 1', model: 'opus' }];
    const vote = async (models: string[], reported = read) => (await otherFinderVotes([reported], {
      workspace, reads, restates: () => false, finders: models.map((model, i) => ({ name: `Finder ${'ABC'[i]}`, model, client: client() })),
    }))[0]?.finder;
    try {
      expect(await vote(['opus', 'sol'])).toBe('Finder B');
      expect(await vote(['opus', 'opus', 'sol'])).toBe('Finder C');
      expect(await vote(['opus', 'opus'])).toBeUndefined();
      // A read without a known model could be any finder's, so its finding gets no vote, also beside a read whose model is known.
      expect(await vote(['sol', 'terra'])).toBeUndefined();
      expect(await vote(['opus', 'sol'], finding({ reviewers: ['Second read 1', 'Second read 2'], soleFinder: undefined }))).toBeUndefined();
      // A finding a finder reported keeps its voter, also when a second read on that voter's model reported it too.
      const both = finding({ reviewers: ['Finder A', 'Second read 1'] });
      const voters = [{ name: 'Finder A', model: 'opus', client: client() }, { name: 'Finder B', model: 'sol', client: client() }];
      expect((await otherFinderVotes([both], { workspace, reads: [{ reviewer: 'Second read 1', model: 'sol' }], restates: () => false, finders: voters }))[0]?.finder).toBe('Finder B');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('shows the code at the trigger and result lines a check cites, without its answer, a closed path or a line of a related repo, and lets the vote quote it', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'manki-vote-lines-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(join(workspace, path, '..'), { recursive: true });
        writeFileSync(join(workspace, path), text);
      };
      write('src/a.ts', 'let total = 0;\n\ntotal += 1;\n');
      write('src/caller.ts', 'exportAll();\n');
      write('src/sink.ts', 'send(total);\n');
      write('secrets/key.ts', 'const closedText = 1;\n');
      // Git allows `:` in a file name, so a PR can hold a file whose path reads like a line of a related repo.
      write('acme/reports:src/use.ts', 'const relatedText = 1;\n');
      execFileSync('git', ['init', '-q'], { cwd: workspace });
      execFileSync('git', ['add', '.'], { cwd: workspace });
      await closePaths(workspace, ['secrets/']);

      const check = (triggerProof: string[], resultProof: string[]) => ({
        outcome: 'confirmed' as const, defect: 'confirmed' as const, reason: 'CHECK-ANSWER', files: ['src/a.ts'], codeDigest: 'abc', triggerProof, resultProof,
        proof: ['src/a.ts:3', 'src/caller.ts:1', 'src/sink.ts:1', 'secrets/key.ts:1'], relatedProof: ['acme/reports:src/use.ts:1'],
      });
      const sendMessage = jest.fn().mockResolvedValue({ content: JSON.stringify({
        trigger: { reason: 'The export runs it.', line: 'src/caller.ts:1', quote: 'exportAll();' }, result: { reason: 'A wrong total is sent.', line: 'src/sink.ts:1', quote: 'send(total);' },
      }) });
      const given = finding({ refutation: check(['src/caller.ts:1', 'acme/reports:src/use.ts:1'], ['src/a.ts:3']), pairRefutation: check(['secrets/key.ts:1'], ['src/sink.ts:1']) });
      const [vote] = await otherFinderVotes([given], { workspace, finders: [{ name: 'Finder A', model: 'opus', client: {} as LLMClient }, { name: 'Finder B', model: 'sol', client: { sendMessage } as unknown as LLMClient }], restates: () => false });

      const message = sendMessage.mock.calls[0][1] as string;
      expect(message).toContain('1: exportAll();');
      expect(message).toContain('1: send(total);');
      expect(message).not.toMatch(/closedText|secrets\/key|relatedText|acme\/reports|CHECK-ANSWER|confirmed/);
      expect([vote?.answer, vote?.trigger.held, vote?.result.held]).toEqual(['backs', true, true]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);

  it('finds the quote anywhere in the hunk of the named line, also across lines, and only near a line outside every hunk', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'manki-vote-'));
    mkdirSync(join(workspace, 'src'));
    for (const name of ['a.ts', 'b.ts']) writeFileSync(join(workspace, 'src', name), Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n'));
    const removedSix = [' const line20 = 20;', ...Array.from({ length: 6 }, (_, i) => `-const gone${i} = ${i};`), '+const line21 = 21;', ' const line22 = 22;', ' const line23 = 23;'].join('\n');
    const diff: ParsedDiff = { files: [{ path: 'src/a.ts', changeType: 'modified', hunks: [{ oldStart: 10, oldLines: 10, newStart: 10, newLines: 10, content: '' }, { oldStart: 20, oldLines: 9, newStart: 20, newLines: 4, content: removedSix }] },
      // A line in the head lines of the second hunk belongs to it, even within the count past the first hunk's removed lines.
      { path: 'src/b.ts', changeType: 'modified', hunks: [{ oldStart: 10, oldLines: 9, newStart: 10, newLines: 4, content: removedSix }, { oldStart: 19, oldLines: 4, newStart: 15, newLines: 4, content: '' }] }], totalAdditions: 1, totalDeletions: 1 };
    const answers: Record<string, { line: string; quote: string }> = {
      // The voter counted 6 lines off inside the hunk.
      'Off by several': { line: 'src/a.ts:12', quote: 'const line18 = 18;' },
      'Across two lines': { line: 'src/a.ts:14', quote: 'const line14 = 14;\nconst line15 = 15;' },
      'Outside the hunk': { line: 'src/a.ts:12', quote: 'const line25 = 25;' },
      'Near a line outside every hunk': { line: 'src/a.ts:33', quote: 'const line35 = 35;' },
      'Far from a line outside every hunk': { line: 'src/a.ts:33', quote: 'const line38 = 38;' },
      // The second hunk removes 6 lines, which the voter counted as if they had head numbers.
      'Counted past removed lines': { line: 'src/a.ts:29', quote: 'const line23 = 23;' },
      'Top of the next hunk': { line: 'src/b.ts:15', quote: 'const line10 = 10;' },
    };
    const client = { sendMessage: jest.fn(async (_system: string, message: string) => {
      const [title, answer] = Object.entries(answers).find(([t]) => message.includes(`## Claim: ${t}\n`))!;
      return { content: JSON.stringify({ trigger: { reason: `${title} triggers.`, ...answer }, result: { reason: `${title} shows.`, ...answer } }) };
    }) } as unknown as LLMClient;
    try {
      const findings = Object.keys(answers).map(title => finding({ title }));
      const votes = await otherFinderVotes(findings, { workspace, diff, finders: [{ name: 'Finder A', model: 'opus', client }, { name: 'Finder B', model: 'sol', client }], restates: () => false });
      expect(findings.map((f, i) => [f.title, votes[i]?.answer])).toEqual([
        ['Off by several', 'backs'], ['Across two lines', 'backs'], ['Outside the hunk', 'declines'], ['Near a line outside every hunk', 'backs'], ['Far from a line outside every hunk', 'declines'],
        ['Counted past removed lines', 'backs'], ['Top of the next hunk', 'declines'],
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
