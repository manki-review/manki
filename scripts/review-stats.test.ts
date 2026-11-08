import type { LLMCall } from '../src/providers';
import { formatReviewRecord } from '../src/review-record';
import { makeFindingFingerprintEntry, makeRoundContext } from '../src/test-utils';
import type { RoundContext } from '../src/types';
import { computeStats, prRecords, renderStats } from './review-stats';

const bot = { login: 'manki-review[bot]', type: 'Bot' };
const person = { login: 'alice', type: 'User' };

const call = (model: string, steps: number): LLMCall => ({
  stage: 'reviewer', model, attempt: 1, durationMs: 10, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  costUsd: 0, toolSteps: Array.from({ length: steps }, () => ({ tool: 'Read', durationMs: 1 })),
});

const review = (id: number, context: RoundContext) => ({ id, body: `Review.\n${formatReviewRecord(context)}`, user: bot });

describe('review stats', () => {
  it('adds up rounds, findings, blocker outcomes, finders, refutations, cost and inter-round diffs over merged PRs', () => {
    const first = makeRoundContext(1, {
      meta: { prNumber: 1, commitSha: 'a', round: 1, timestamp: 't', mankiVersion: '7', outcome: 'ADDRESS_FIRST' },
      findings: {
        count: 2,
        severityCounts: {},
        entries: [
          { ...makeFindingFingerprintEntry({ severity: 'blocker' }), refutation: { outcome: 'disproved', reason: 'r', files: [], codeDigest: 'd' } },
          { ...makeFindingFingerprintEntry({ severity: 'warning' }), origin: 'reviewed' },
        ],
      },
      reviewers: {
        agents: ['Sonnet', 'Opus'],
        agentMetrics: [{ name: 'Sonnet', model: 'claude-sonnet', findingsRaw: 3 }, { name: 'Opus', model: 'claude-opus', findingsRaw: 1 }],
        keptOnlyBy: { Sonnet: 1 },
        keptByMany: 1,
      },
      usage: { estimatedCostUsd: 0.5, llmCalls: [call('claude-sonnet', 4), call('claude-opus', 10), { ...call('j', 3), stage: 'judge' }] },
    });
    const second = makeRoundContext(2, {
      meta: { prNumber: 1, commitSha: 'b', round: 2, timestamp: 't', mankiVersion: '7', outcome: 'READY' },
      judge: { summary: '', interRoundDiffState: 'changed' },
      usage: { estimatedCostUsd: 0.25 },
    });
    const threadComments = [
      { id: 10, body: '**Blocker**: Bug <!-- manki:blocker:Bug -->', user: bot },
      { id: 11, in_reply_to_id: 10, body: 'Fixed in abc1234.\n\n<!-- manki -->', user: bot },
      { id: 20, body: '**Blocker**: Wrong <!-- manki:blocker:Wrong -->', user: bot },
      { id: 21, in_reply_to_id: 20, body: 'Fixed', user: person },
      { id: 22, in_reply_to_id: 20, body: '**Withdrawn.** The value is checked above.', user: bot },
      { id: 30, body: '**Blocker**: Open <!-- manki:blocker:Open -->', user: bot },
      { id: 31, in_reply_to_id: 30, body: 'Fixed in def5678.', user: person },
      { id: 40, body: '**Warning**: Minor <!-- manki:warning:Minor -->', user: bot },
      { id: 41, in_reply_to_id: 40, body: 'Withdrawn.', user: bot },
      { id: 50, body: 'A person\'s comment <!-- manki:blocker:Pasted -->', user: person },
    ];
    const one = prRecords('o/r', 1, { reviews: [review(1, first), { id: 2, body: 'A person\'s review.', user: person }, review(3, second)], threadComments });

    const reader = makeRoundContext(1, {
      meta: { prNumber: 2, commitSha: 'c', round: 1, timestamp: 't', mankiVersion: '7', outcome: 'ADDRESS_FIRST' },
      judge: {
        summary: '',
        verdictReason: 'verdict_reader',
        verdictTrace: { survivingBlockers: [{ file: 'a', line: 1, title: 'x', fingerprint: 'k1' }, { file: 'b', line: 2, title: 'y', fingerprint: 'k2' }], unresolvedPriors: [] },
      },
      usage: { estimatedCostUsd: 1 },
    });
    const later = [2, 3, 4, 5].map(round => makeRoundContext(round, {
      meta: { prNumber: 2, commitSha: `c${round}`, round, timestamp: 't', mankiVersion: '7' },
      judge: { summary: '', ...(round === 2 && { interRoundDiffState: 'changed', interRoundDiffTruncated: true }), ...(round >= 4 && { interRoundDiffState: 'empty' }) },
    }));
    const two = prRecords('o/r', 2, { reviews: [reader, ...later].map((context, i) => review(100 + i, context)), threadComments: [] });

    const stats = computeStats([one, two]);
    expect(stats).toMatchObject({
      prs: 2, roundsPerPr: [2, 5], passedFirstRound: 0, manyRounds: 1, rounds: 7,
      severityCounts: { blocker: 1, warning: 1 }, findings: 2, onReviewedCode: 1,
      blockerOutcomes: { fixed: 1, withdrawn: 1, other: 1 },
      keptByMany: 1, readerRounds: 1, readerBlockers: 2,
      costPerPr: [0.75, 1], costPerRound: [0.5, 0.25, 1, 0, 0, 0, 0],
      // Rounds 2 of the first PR and 4 and 5 of the second had a whole diff. Round 2 of the second was cut, round 3 unknown.
      followUpRounds: 5, interRoundDiffCutOrUnknown: 2,
    });
    expect(Object.fromEntries(stats.refutations)).toEqual({ 'blocker disproved': 1 });
    expect(Object.fromEntries(stats.finders)).toEqual({
      'claude-sonnet': { rounds: 1, rawFindings: 3, keptOnlyBy: 1, toolSteps: [4] },
      'claude-opus': { rounds: 1, rawFindings: 1, keptOnlyBy: 0, toolSteps: [10] },
    });

    const report = renderStats(stats);
    expect(report).toContain('# Review statistics over 2 merged PRs and 7 rounds');
    expect(report).toContain('- Rounds per PR: mean 3.5, median 3.5, max 5.0');
    expect(report).toContain('- Needed 5 or more rounds: 50% (1 of 2)');
    expect(report).toContain('| blocker | 1 | 0.14 |');
    expect(report).toContain('- Blocker threads: 3, fixed 1, withdrawn 1, other 1');
    expect(report).toContain('| claude-sonnet | 1 | 3 | 3.00 | 1 | mean 4.0, median 4.0, max 4.0 |');
    expect(report).toContain('| blocker disproved | 1 |');
    expect(report).toContain('- Follow-up rounds whose inter-round diff was cut or unknown: 40% (2 of 5)');
  });

  it('prints a report for no PRs without dividing by zero', () => {
    const report = renderStats(computeStats([]));
    expect(report).toContain('- Rounds per PR: -');
    expect(report).toContain('- Passed after one round: -');
    expect(report).toContain('No refutations.');
  });
});
