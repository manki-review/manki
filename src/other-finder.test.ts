import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { otherFinderVotes, withVote } from './other-finder';
import type { LLMClient } from './providers';
import { GIT_TEST_TIMEOUT_MS } from './test-utils';
import { DISPROVED_TAG, Finding, isGuardedFinding, OtherFinderVote } from './types';
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
    // A blocker cell held at a warning for its one finder keeps it as `judgeCell` once disproved, and stays posted.
    expect(withVote(finding({ judgeCell: { row: 'wrong', column: 'normal' } }), declined).severity).toBe('warning');

    // A rule the refuter confirmed after the vote was asked gives the finding its grade.
    const rule = { file: 'AGENTS.md', quote: 'Every export is logged.', verdict: 'confirmed' as const };
    expect(withVote(finding({ rule }), declined, 'warn')).toEqual(finding({ rule }));
    expect(withVote(finding({ severity: 'blocker', rule }), declined, 'block').severity).toBe('blocker');
    expect(withVote(finding({ rule }), declined, 'auto').severity).toBe('note');
  });
});

describe('otherFinderVotes', () => {
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
      const [vote] = await otherFinderVotes([given], { workspace, finders: [{ name: 'Finder A', client: {} as LLMClient }, { name: 'Finder B', client: { sendMessage } as unknown as LLMClient }], restates: () => false });

      const message = sendMessage.mock.calls[0][1] as string;
      expect(message).toContain('1: exportAll();');
      expect(message).toContain('1: send(total);');
      expect(message).not.toMatch(/closedText|secrets\/key|relatedText|acme\/reports|CHECK-ANSWER|confirmed/);
      expect([vote?.answer, vote?.trigger.held, vote?.result.held]).toEqual(['backs', true, true]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, GIT_TEST_TIMEOUT_MS);
});
