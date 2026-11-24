import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { LLMClient } from './providers';
import { otherFinderVotes, withVote } from './other-finder';
import { DISPROVED_TAG, Finding, isGuardedFinding, OtherFinderVote } from './types';

const finding = (more: Partial<Finding>): Finding => ({
  severity: 'warning', title: 'Totals drift', file: 'src/a.ts', line: 3, description: 'Totals drift.', reviewers: ['Finder A'], judgeNotes: '', soleFinder: true, ...more,
});
const declined: OtherFinderVote = { finder: 'Finder B', harm: '', situation: '', declined: true };
const backed: OtherFinderVote = { finder: 'Finder B', harm: 'A total is wrong.', situation: 'Any export.', line: 'src/a.ts:3', quote: 'total += 1;', declined: false };

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
    expect([note.severity, note.gradePath, note.unpostedReason]).toEqual(['note', [{ from: 'warning', to: 'note', by: 'other_finder', reason: 'the other finder named no harm in realistic use' }], undefined]);
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
    expect(withVote(finding({ cell, gradeIfConfirmed: 'blocker' }), declined).severity).toBe('note');
    expect(withVote(finding({ judgeCell: cell }), declined).severity).toBe('note');

    // A rule the refuter confirmed after the vote was asked gives the finding its grade.
    const rule = { file: 'AGENTS.md', quote: 'Every export is logged.', verdict: 'confirmed' as const };
    expect(withVote(finding({ rule }), declined, 'warn')).toEqual(finding({ rule }));
    expect(withVote(finding({ severity: 'blocker', rule }), declined, 'block').severity).toBe('blocker');
    expect(withVote(finding({ rule }), declined, 'auto').severity).toBe('note');
  });
});

describe('otherFinderVotes', () => {
  it('asks a finding only second reads reported of a finder on another model than every read that reported it, and of none when no such finder ran', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'manki-vote-'));
    mkdirSync(join(workspace, 'src'));
    writeFileSync(join(workspace, 'src', 'a.ts'), 'let total = 0;\ntotal += 1;\ntotal += 1;\n');
    const client = (): LLMClient => ({ sendMessage: jest.fn().mockResolvedValue({ content: JSON.stringify({ harm: '', situation: '', line: 'none' }) }) } as unknown as LLMClient);
    const read = finding({ reviewers: ['Second read 1'], soleFinder: undefined });
    const reads = [{ reviewer: 'Second read 1', finder: 'Finder A' }];
    const vote = async (models: string[]) => (await otherFinderVotes([read], {
      workspace, reads, restates: () => false, finders: models.map((model, i) => ({ name: `Finder ${'ABC'[i]}`, model, client: client() })),
    }))[0]?.finder;
    try {
      expect(await vote(['opus', 'sol'])).toBe('Finder B');
      expect(await vote(['opus', 'opus', 'sol'])).toBe('Finder C');
      expect(await vote(['opus', 'opus'])).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
