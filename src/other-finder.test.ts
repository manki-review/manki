import { withVote } from './other-finder';
import { DISPROVED_TAG, Finding, isGuardedFinding, OtherFinderVote } from './types';

const finding = (more: Partial<Finding>): Finding => ({
  severity: 'warning', title: 'Totals drift', file: 'src/a.ts', line: 3, description: 'Totals drift.', reviewers: ['Finder A'], judgeNotes: '', soleFinder: true, ...more,
});
const declined: OtherFinderVote = { finder: 'Finder B', harm: '', situation: '', declined: true };
const backed: OtherFinderVote = { finder: 'Finder B', harm: 'A total is wrong.', situation: 'Any export.', line: 'src/a.ts:3', quote: 'total += 1;', declined: false };

describe('withVote', () => {
  it('lowers a declined blocker to a guarded warning and a declined warning to a note, and leaves alone a finding a refuter lowered or a rule grades', () => {
    // A declined blocker is a warning only a fix or a maintainer clears, as one the refuters disproved.
    const lowered = withVote(finding({ severity: 'blocker' }), declined);
    expect([lowered.severity, lowered.gradePath, lowered.otherFinderVote]).toEqual(['warning', [{ from: 'blocker', to: 'warning', by: 'other_finder', reason: 'the other finder would not block on it' }], declined]);
    expect(isGuardedFinding(lowered.tags, lowered.reviewers)).toBe(true);
    expect(withVote(finding({ severity: 'blocker' }), backed)).toEqual(finding({ severity: 'blocker', otherFinderVote: backed }));

    // A declined warning stays visible as a note.
    const note = withVote(finding({}), declined);
    expect([note.severity, note.gradePath, note.unpostedReason]).toEqual(['note', [{ from: 'warning', to: 'note', by: 'other_finder', reason: 'the other finder named no harm in realistic use' }], undefined]);
    expect(withVote(finding({}), backed).severity).toBe('warning');

    // A finding the refuter already lowered from a blocker took its step, whether its disproof guards it or not.
    const disproved = finding({ gradePath: [{ from: 'blocker', to: 'warning', by: 'refutation' }], tags: [DISPROVED_TAG] });
    expect(withVote(disproved, declined)).toBe(disproved);
    const unguarded = finding({ gradePath: [{ from: 'blocker', to: 'warning', by: 'refutation' }] });
    expect(withVote(unguarded, declined)).toBe(unguarded);
    // A blocker cell held at a warning for its one finder keeps it as `judgeCell` once disproved, and stays posted.
    expect(withVote(finding({ judgeCell: { row: 'wrong', column: 'normal' } }), declined).severity).toBe('warning');

    // A rule the refuter confirmed after the vote was asked gives the finding its grade.
    const rule = { file: 'AGENTS.md', quote: 'Every export is logged.', verdict: 'confirmed' as const };
    expect(withVote(finding({ rule }), declined, 'warn')).toEqual(finding({ rule }));
    expect(withVote(finding({ severity: 'blocker', rule }), declined, 'block').severity).toBe('blocker');
    expect(withVote(finding({ rule }), declined, 'auto').severity).toBe('note');
  });
});
