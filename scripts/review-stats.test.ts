import type { LLMCall } from '../src/providers';
import { formatApprovalRecord, formatReplyRecord, formatReviewRecord } from '../src/review-record';
import { makeFindingFingerprintEntry, makeRoundContext } from '../src/test-utils';
import type { ApprovalRecord, ReplyRecord, RoundContext } from '../src/types';
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
          {
            ...makeFindingFingerprintEntry({ severity: 'blocker' }), refutation: { outcome: 'disproved', reason: 'r', files: [], codeDigest: 'd' },
            pairRefutation: { outcome: 'confirmed', reason: 'r', files: [], codeDigest: 'd' },
          },
          { ...makeFindingFingerprintEntry({ severity: 'warning' }), origin: 'reviewed' },
        ],
      },
      reviewers: {
        agents: ['Sonnet', 'Opus'],
        agentMetrics: [{ name: 'Sonnet', model: 'claude-sonnet', findingsRaw: 3, keptOnly: 1, keptShared: 1 }, { name: 'Opus', model: 'claude-opus', findingsRaw: 1, keptOnly: 0, keptShared: 1 }],
      },
      usage: {
        estimatedCostUsd: 0.5,
        llmCalls: [
          { ...call('claude-sonnet', 4), stepBudget: 15 }, { ...call('claude-opus', 10), stepBudget: 12, wrapUpNoted: true }, { ...call('j', 3), stage: 'judge' },
          // A fallback that answered for the Sonnet finder on another model still counts for that finder.
          { ...call('gpt-5', 2), agent: 'Sonnet', fallback: true },
          { ...call('gpt-5', 5), stage: 'judge', agent: 'refute_pair', costUsd: 0.12 },
        ],
      },
    });
    const second = makeRoundContext(2, {
      meta: { prNumber: 1, commitSha: 'b', round: 2, timestamp: 't', mankiVersion: '7', outcome: 'READY' },
      judge: {
        summary: '', interRoundDiffState: 'changed',
        // A finding a disproof dropped is listed with the judge's drops, and its refutations count too.
        dropped: [{
          title: 't', file: 'a', line: 1, reviewers: [],
          refutation: { outcome: 'unsettled', reason: 'r', files: [], codeDigest: 'd' }, pairRefutation: { outcome: 'disproved', reason: 'r', files: [], codeDigest: 'd' },
        }],
      },
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

    const unreviewed = prRecords('o/r', 3, { reviews: [{ id: 200, body: 'A person\'s review.', user: person }], threadComments: [] });
    const stats = computeStats([one, two, unreviewed]);
    expect(stats).toMatchObject({
      prs: 2, unreviewed: 1, roundsPerPr: [2, 5], passedFirstRound: 0, manyRounds: 1, rounds: 7,
      severityCounts: { blocker: 1, warning: 1 }, findings: 2, onReviewedCode: 1,
      blockerOutcomes: { fixed: 1, withdrawn: 1, other: 1 },
      readerRounds: 1, readerBlockers: 2,
      costPerPr: [0.75, 1], costPerRound: [0.5, 0.25, 1, 0, 0, 0, 0],
      // Rounds 2 of the first PR and 4 and 5 of the second had a whole diff. Round 2 of the second was cut, round 3 unknown.
      followUpRounds: 5, interRoundDiffCutOrUnknown: 2,
    });
    expect(Object.fromEntries(stats.refutations)).toEqual({ 'blocker disproved': 1, 'ignore unsettled': 1 });
    expect(Object.fromEntries(stats.pairRefutations)).toEqual({ 'disproved / confirmed': 1, 'unsettled / disproved': 1 });
    expect(stats.pairRefutationCost).toBeCloseTo(0.12);
    expect(Object.fromEntries(stats.finders)).toEqual({
      'claude-sonnet': { rounds: 1, rawFindings: 3, keptOnly: 1, keptShared: 1, toolSteps: [4, 2], budgetedCalls: 1, wrapUps: 0 },
      'claude-opus': { rounds: 1, rawFindings: 1, keptOnly: 0, keptShared: 1, toolSteps: [10], budgetedCalls: 1, wrapUps: 1 },
    });

    const report = renderStats(stats);
    expect(report).toContain('# Review statistics over 2 merged PRs and 7 rounds\n\n1 more merged PR has no round record and is left out.');
    expect(report).toContain('- Rounds per PR: mean 3.5, median 3.5, max 5.0');
    expect(report).toContain('- Needed 5 or more rounds: 50% (1 of 2)');
    expect(report).toContain('| blocker | 1 | 0.14 |');
    expect(report).toContain('- Blocker threads: 3, fixed 1, withdrawn 1, other 1');
    // The split and the answer the first refuter left unsettled both changed the outcome, and neither agreed.
    expect(report).toContain([
      '## Second refuter', '',
      '- Findings checked: 2, for 0.12 USD',
      '- Agreed with the first refuter: 0% (0 of 2)',
      '- Split, one confirmed and one disproved: 50% (1 of 2)',
      '- Changed the outcome the first refuter alone gave: 100% (2 of 2)',
    ].join('\n'));
    expect(report).toContain('| claude-sonnet | 1 | 3 | 3.00 | 1 | 1 | mean 3.0, median 3.0, max 4.0 | 0% (0 of 1) |');
    expect(report).toContain('| claude-opus | 1 | 1 | 1.00 | 0 | 1 | mean 10.0, median 10.0, max 10.0 | 100% (1 of 1) |');
    expect(report).toContain('| blocker disproved | 1 |');
    expect(report).toContain('- Follow-up rounds whose inter-round diff was cut or unknown: 40% (2 of 5)');
  });

  it('tallies every decision the round and reply records keep, and lists each in the report', () => {
    const round = makeRoundContext(2, {
      meta: {
        prNumber: 4, commitSha: 'd', round: 2, timestamp: 't', mankiVersion: '7', outcome: 'NOT_CONVERGING',
        promptVersions: { reviewer: ['aaaaaaaaaaaa'], judge: ['bbbbbbbbbbbb'] },
        needsHuman: { cause: 'repeated', blockers: [] },
      },
      staticAnalysis: {
        sources: [{ source: 'checks', status: 'ran', results: 1 }, { source: 'code_scanning', status: 'skipped', reason: 'the token cannot read it (HTTP 403)' }, { source: 'dependency_review', status: 'skipped', reason: 'Bad\n| injected | row' }],
        analyzers: [{ analyzer: 'secrets', status: 'ran', results: 0 }],
      },
      findings: {
        count: 1, severityCounts: {},
        entries: [{ ...makeFindingFingerprintEntry({ severity: 'warning' }), gradePath: [{ from: 'blocker', to: 'warning', by: 'unproven' }] }],
        unposted: [{
          ...makeFindingFingerprintEntry({ severity: 'suggestion' }), preExisting: { reason: 'Old.', check: 'pre_existing' },
          gradePath: [{ from: 'warning', to: 'suggestion', by: 'judge' }],
        }],
      },
      judge: {
        summary: '', fixClaimedThreads: ['T1', 'T2'],
        dropped: [{ title: 't', file: 'a', line: 1, reviewers: [], gradePath: [{ from: 'warning', to: 'ignore', by: 'refutation', reason: 'r' }] }],
      },
      diff: { lines: 1, additions: 1, deletions: 0, filesReviewed: 1, fileTypes: {}, changedSinceLastRound: 3 },
      memory: { loaded: { learnings: 4, suppressions: 2 }, suppressed: [{ title: 't', file: 'a', line: 1, severity: 'nitpick', suppressionId: 'sup-1' }] },
      slicing: { files: [2, 1], reader: [{ verdict: 'READY', blockers: 0 }, { verdict: 'ADDRESS_FIRST', blockers: 1 }] },
      approval: { held: 'conflict' },
      tokenService: [{ endpoint: 'token', status: 200, durationMs: 1 }, { endpoint: 'state', status: 429, error: 'Too many requests', durationMs: 1 }],
      relatedRepos: [
        { repo: 'dashpay/dash', ref: 'v23', status: 'fetched', durationMs: 900, reads: 5 },
        { repo: 'dashpay/dips', status: 'failed', reason: 'fatal: repository not found' },
        { repo: 'dashpay/platform', status: 'unused' },
      ],
    });
    const reply = { kind: 'thread-reply', prNumber: 4, timestamp: 't', mankiVersion: '7', usage: {}, decision: { outcome: 'Fixed', thread: 'stays_open' }, tokenService: [{ endpoint: 'resolve', error: 'no OIDC token', durationMs: 1 }] };
    const approval = (decision: ApprovalRecord['decision'], reason: string) => formatApprovalRecord({
      decision, reason, head: 'h', threads: { total: 2, resolved: 2 }, timestamp: 't', mankiVersion: '7',
    });
    const pr = prRecords('o/r', 4, {
      reviews: [review(1, round), { id: 3, body: `Approved.\n${approval('approved', 'all blocking threads are resolved')}`, user: bot }],
      threadComments: [{ id: 60, in_reply_to_id: 59, body: `Fixed.\n${formatReplyRecord(reply as ReplyRecord)}`, user: bot }],
      issueComments: [
        { id: 70, body: `Approval held.\n\n${approval('held', 'conflict')}`, user: bot },
        { id: 71, body: `Pasted.\n${approval('approved', 'faked')}`, user: person },
      ],
    });

    // A round of a release that recorded no fix claims adds nothing to their series.
    const older = prRecords('o/r', 5, { reviews: [review(2, makeRoundContext(1, { relatedRepos: [
      { repo: 'dashpay/dash', status: 'fetched', durationMs: 700, reads: 1 }, { repo: 'dashpay/dips', status: 'skipped', reason: 'no finder has repository tools' },
    ] }))], threadComments: [] });
    const stats = computeStats([pr, older]);
    const decisions = Object.fromEntries([...stats.decisions].map(([name, counts]) => [name, Object.fromEntries(counts)]));
    expect(decisions).toEqual({
      'Prompt versions (rounds per stage and digest)': { 'reviewer aaaaaaaaaaaa': 1, 'judge bbbbbbbbbbbb': 1 },
      'Pause causes': { repeated: 1 },
      'Static analysis sources': {
        'checks ran': 1, 'code_scanning skipped: the token cannot read it (HTTP 403)': 1, 'dependency_review skipped: Bad\n| injected | row': 1, 'secrets ran': 1,
      },
      'Grade changes': { 'unproven: blocker to warning': 1, 'judge: warning to suggestion': 1, 'refutation: warning to ignore': 1 },
      'Pre-existing claims (how each was checked)': { pre_existing: 1 },
      'Memory suppressions (findings hidden per suppression)': { 'sup-1': 1 },
      'Verdict reader per slice': { READY: 1, ADDRESS_FIRST: 1 },
      Approvals: { 'held: conflict': 1 },
      'Thread reply decisions': { 'Fixed, stays_open': 1 },
      'State check approvals': { 'approved: all blocking threads are resolved': 1, 'held: conflict': 1 },
      'Token service calls': { 'token ok': 1, 'state failed: 429': 1, 'resolve failed: no OIDC token': 1 },
    });
    expect(stats).toMatchObject({ learningsLoaded: [4], suppressionsLoaded: [2], slicesPerRound: [2], changedSinceLastRound: [3], fixClaims: [2] });

    const report = renderStats(stats);
    expect(report).toContain('### Pause causes\n\n| value | count |\n| --- | ---: |\n| repeated | 1 |');
    expect(renderStats(stats, 'o/r')).toMatch(/^# Review statistics for o\/r over 2 merged PRs and 2 rounds\n/);
    expect(report).toContain('- Threads with a fix claim, per round: mean 2.0, median 2.0, max 2.0');
    // A value from a record never breaks the table.
    expect(report).toContain('| dependency_review skipped: Bad \\| injected \\| row | 1 |');
    expect(report).toContain([
      '## Related repositories',
      '',
      '| repo | rounds it was configured | rounds that read it | reads per round that read it | fetch failures | skipped rounds |',
      '| --- | ---: | ---: | --- | ---: | ---: |',
      '| dashpay/dash | 2 | 2 | mean 3.0, median 3.0, max 5.0 | 0 | 0 |',
      '| dashpay/dips | 2 | 0 | - | 1 | 1 |',
      '| dashpay/platform | 1 | 0 | - | 0 | 0 |',
    ].join('\n'));
    // A record from before a field existed shows it as none recorded.
    expect(renderStats(computeStats([]))).toContain('### Approvals\n\nNone recorded.');
    expect(renderStats(computeStats([]))).toContain('## Related repositories\n\nNone recorded.');
  });

  it('lists the highest used share of each subscription limit per week, and the rounds past 70, 80 and 90%', () => {
    const weekly = (usedPercent: number) => ({ account: 'Claude subscription', window: 'weekly', usedPercent });
    const at = (timestamp: string, limits: ReturnType<typeof weekly>[]) =>
      makeRoundContext(1, { meta: { prNumber: 1, commitSha: 'a', round: 1, timestamp, mankiVersion: '7' }, usage: { limits } });
    const rounds = [
      // A Sunday ends the week that began on the Monday before it.
      at('2026-11-08T23:00:00Z', [weekly(72)]),
      at('2026-11-09T00:00:00Z', [weekly(81), { ...weekly(40), window: '5-hour' }]),
      at('2026-11-12T10:00:00Z', [weekly(93), { ...weekly(12), account: 'ChatGPT | subscription' }]),
      at('t', [weekly(50)]),
    ];
    const prs = rounds.map((round, i) => prRecords('o/r', i + 1, { reviews: [review(i + 1, round)], threadComments: [] }));
    const report = renderStats(computeStats(prs));
    expect(report).toContain([
      '## Subscription limits',
      '',
      '| week of | account | window | highest used | rounds at 70%+ | rounds at 80%+ | rounds at 90%+ |',
      '| --- | --- | --- | ---: | ---: | ---: | ---: |',
      '| 2026-11-02 | Claude subscription | weekly | 72% | 1 | 0 | 0 |',
      '| 2026-11-09 | ChatGPT \\| subscription | weekly | 12% | 0 | 0 | 0 |',
      '| 2026-11-09 | Claude subscription | 5-hour | 40% | 0 | 0 | 0 |',
      '| 2026-11-09 | Claude subscription | weekly | 93% | 2 | 2 | 1 |',
      '| unknown | Claude subscription | weekly | 50% | 0 | 0 | 0 |',
    ].join('\n'));
    expect(renderStats(computeStats([]))).toContain('## Subscription limits\n\nNo limit readings recorded.');
  });

  it('prints a report for no PRs without dividing by zero', () => {
    const report = renderStats(computeStats([]));
    expect(report).toContain('- Rounds per PR: -');
    expect(report).toContain('- Passed after one round: -');
    expect(report).toContain('No refutations.');
    expect(report).toContain('No second refuter.');
  });
});
