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
    const disprovedBlocker = { outcome: 'disproved' as const, reason: 'r', files: [], codeDigest: 'd' };
    const confirmedBlocker = { outcome: 'confirmed' as const, reason: 'r', files: [], codeDigest: 'd' };
    const unsettled = (reason: string) => ({ outcome: 'unsettled' as const, reason, files: [], codeDigest: 'd' });
    const lead = { title: 'l', file: 'a', line: 1, severity: 'warning' as const, reviewers: [], description: 'd', lead: { checked: 'c', left: 'l' }, since: 1 };
    const first = makeRoundContext(1, {
      meta: { prNumber: 1, commitSha: 'a', round: 1, timestamp: 't', mankiVersion: '7', outcome: 'ADDRESS_FIRST' },
      findings: {
        count: 2,
        severityCounts: {},
        entries: [
          {
            ...makeFindingFingerprintEntry({ severity: 'blocker' }), refutation: disprovedBlocker, pairRefutation: confirmedBlocker,
          },
          // The thread this finding opens belongs to its own review, so the finding counts as posted.
          { ...makeFindingFingerprintEntry({ severity: 'warning', title: 'Minor' }), origin: 'new' },
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
          refutation: unsettled('first'), pairRefutation: { outcome: 'disproved', reason: 'r', files: [], codeDigest: 'd' },
        }],
      },
      // The blocker's answers are reused from round 1, so they count once. A lead left unsettled counts, a posted one does not.
      findings: {
        count: 3, severityCounts: {},
        // A finding that restates an earlier one was not first raised in this round. One under an earlier thread is not posted either.
        entries: [
          { ...makeFindingFingerprintEntry({ severity: 'warning' }), origin: 'reviewed' },
          { ...makeFindingFingerprintEntry({ severity: 'suggestion' }), origin: 'new' },
          { ...makeFindingFingerprintEntry({ severity: 'suggestion' }), origin: 'earlier' },
          { ...makeFindingFingerprintEntry({ severity: 'warning' }), origin: 'reviewed', threadId: 'T1' },
          { ...makeFindingFingerprintEntry({ severity: 'nitpick' }), origin: 'new', threadId: 'T2' },
          // Neither is one that matches a thread the first review opened, a few lines away.
          { ...makeFindingFingerprintEntry({ severity: 'warning', title: 'Minor', lineStart: 12 }), origin: 'reviewed' },
        ],
        unposted: [{ ...makeFindingFingerprintEntry({ severity: 'blocker' }), refutation: disprovedBlocker, pairRefutation: confirmedBlocker }],
      },
      leads: [
        { ...lead, outcome: 'unsettled', refutation: unsettled('lead first'), pairRefutation: unsettled('lead second') },
        { ...lead, outcome: 'confirmed', posted: true, refutation: confirmedBlocker },
      ],
      usage: { estimatedCostUsd: 0.25, llmCalls: [{ ...call('gpt-5', 3), stage: 'judge', agent: 'refute_pair', costUsd: null }] },
    });
    const threadComments = [
      { id: 10, body: '**Blocker**: Bug <!-- manki:blocker:Bug -->', user: bot },
      { id: 11, in_reply_to_id: 10, body: 'Fixed in abc1234.\n\n<!-- manki -->', user: bot },
      { id: 20, body: '**Blocker**: Wrong <!-- manki:blocker:Wrong -->', user: bot },
      { id: 21, in_reply_to_id: 20, body: 'Fixed', user: person },
      { id: 22, in_reply_to_id: 20, body: '**Withdrawn.** The value is checked above.', user: bot },
      { id: 30, body: '**Blocker**: Open <!-- manki:blocker:Open -->', user: bot },
      { id: 31, in_reply_to_id: 30, body: 'Fixed in def5678.', user: person },
      { id: 40, body: '**Warning**: Minor <!-- manki:warning:Minor -->', user: bot, pull_request_review_id: 1, path: 'src/a.ts', line: null, original_line: 10 },
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
    // A record that says where each finding went is read as it says: a finding under an earlier thread is left out, and
    // one posted again beside a matching earlier thread counts. A round that tagged origins without the earlier change
    // counts its findings, but not as first raised later.
    const placed: Record<number, RoundContext['findings']> = {
      3: {
        count: 3, severityCounts: {},
        entries: [
          { ...makeFindingFingerprintEntry({ severity: 'warning' }), origin: 'reviewed', posted: 'body' },
          { ...makeFindingFingerprintEntry({ severity: 'suggestion' }), origin: 'new', posted: 'earlier_thread' },
          { ...makeFindingFingerprintEntry({ severity: 'warning', title: 'Minor', lineStart: 10 }), origin: 'reviewed', posted: 'thread' },
        ],
      },
      4: { count: 1, severityCounts: {}, originsWithoutPrior: true, entries: [{ ...makeFindingFingerprintEntry({ severity: 'warning' }), origin: 'new', posted: 'thread' }] },
    };
    const later = [2, 3, 4, 5].map(round => makeRoundContext(round, {
      meta: { prNumber: 2, commitSha: `c${round}`, round, timestamp: 't', mankiVersion: '7', ...(round === 2 && { outcome: 'READY' as const }) },
      judge: { summary: '', ...(round === 2 && { interRoundDiffState: 'changed', interRoundDiffTruncated: true }), ...(round >= 4 && { interRoundDiffState: 'empty' }) },
      ...(placed[round] && { findings: placed[round] }),
    }));
    // An incomplete round is counted apart: none of its findings, cost or round number reaches another figure.
    // It follows the approval and is no round after it, and its finding on reviewed code counts nowhere.
    const failed = makeRoundContext(2, {
      meta: { prNumber: 2, commitSha: 'f', round: 2, timestamp: 't', mankiVersion: '7', outcome: 'INCOMPLETE', incomplete: true },
      findings: { count: 1, severityCounts: {}, entries: [{ ...makeFindingFingerprintEntry({ severity: 'blocker' }), origin: 'reviewed' }] },
      usage: { estimatedCostUsd: 9 },
    });
    const earlierThread = { id: 80, body: '**Warning**: Minor <!-- manki:warning:Minor -->', user: bot, pull_request_review_id: 100, path: 'src/a.ts', line: 10 };
    const two = prRecords('o/r', 2, { reviews: [reader, later[0], failed, ...later.slice(1)].map((context, i) => review(100 + i, context)), threadComments: [earlierThread] });
    expect([two.rounds.length, two.incompleteRounds]).toEqual([5, [failed]]);

    const unreviewed = prRecords('o/r', 3, { reviews: [{ id: 200, body: 'A person\'s review.', user: person }], threadComments: [] });
    const fixRate = (pr: number, posted: number) => JSON.stringify({ pr, counts: [{ severity: 'warning', specialist: 'Sonnet', posted, fixed: 1, dismissed: 0, untouched: posted - 1 }] });
    // A fix-rate line of a PR outside the report does not count.
    const stats = computeStats([one, two, unreviewed], [fixRate(1, 2), fixRate(9, 5)]);
    expect(stats).toMatchObject({
      prs: 2, unreviewed: 1, roundsPerPr: [2, 5], passedFirstRound: 0, manyRounds: 1, rounds: 7, incompleteRounds: 1,
      // The first PR ended on its approval. The second ran three more rounds after its own.
      approvedRounds: 2, roundsAfterApproval: [3],
      severities: {
        blocker: { posted: 1, inApprovedRounds: 0, raisedLater: 0, onReviewedCode: 0 },
        warning: { posted: 5, inApprovedRounds: 1, raisedLater: 3, onReviewedCode: 3 },
        suggestion: { posted: 2, inApprovedRounds: 2, raisedLater: 1, onReviewedCode: 0 },
      },
      blockerOutcomes: { fixed: 1, withdrawn: 1, other: 1 },
      readerRounds: 1, readerBlockers: 2,
      costPerPr: [0.75, 1], costPerRound: [0.5, 0.25, 1, 0, 0, 0, 0],
      // Rounds 2 of the first PR and 4 and 5 of the second had a whole diff. Round 2 of the second was cut, round 3 unknown.
      followUpRounds: 5, interRoundDiffCutOrUnknown: 2,
    });
    expect(Object.fromEntries(stats.refutations)).toEqual({ 'blocker disproved': 1, 'ignore unsettled': 1, 'warning unsettled': 1 });
    expect(Object.fromEntries(stats.pairRefutations)).toEqual({ 'disproved / confirmed': 1, 'unsettled / disproved': 1, 'unsettled / unsettled': 1 });
    expect(Object.fromEntries(stats.finders)).toEqual({
      'claude-sonnet': { rounds: 1, rawFindings: 3, keptOnly: 1, keptShared: 1, toolSteps: [4, 2], budgetedCalls: 1, wrapUps: 0 },
      'claude-opus': { rounds: 1, rawFindings: 1, keptOnly: 0, keptShared: 1, toolSteps: [10], budgetedCalls: 1, wrapUps: 1 },
    });

    const report = renderStats(stats);
    expect(report).toContain('# Review statistics over 2 merged PRs and 7 rounds\n\n1 more merged PR has no record of a completed round and is left out.');
    expect(report).toContain('- Rounds that ended incomplete, counted in no other figure: 1');
    expect(report).toContain('- Rounds per PR: mean 3.5, median 3.5, max 5.0');
    expect(report).toContain('- Needed 5 or more rounds: 50% (1 of 2)');
    expect(report).toContain('- Approved rounds: 29% (2 of 7)\n- PRs with rounds after their first approval: 50% (1 of 2), 3 such rounds');
    expect(report).toContain([
      '| severity | total | per round | in approved rounds | per approved round | first raised in a later round, on code an earlier round reviewed |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
      '| blocker | 1 | 0.14 | 0 | 0.00 | - |',
      '| warning | 5 | 0.71 | 1 | 0.50 | 100% (3 of 3) |',
      '| suggestion | 2 | 0.29 | 2 | 1.00 | 0% (0 of 1) |',
      '| nitpick | 0 | 0.00 | 0 | 0.00 | - |',
      '| all | 8 | 1.14 | 3 | 1.50 | 75% (3 of 4) |',
    ].join('\n'));
    expect(report).toContain('whether or not that commit fixed it.\n\n| severity | posted | fixed | dismissed | untouched | fixed % | dismissed % |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n| warning | 2 | 1 | 0 | 1 | 50% | 0% |\n\n## Finders');
    expect(report).toContain('- Blocker threads: 3, fixed 1, withdrawn 1, other 1');
    // The split and the answer the first refuter left unsettled both changed the outcome. The lead's two answers agreed.
    expect(report).toContain([
      '## Second refuter', '',
      '- Findings checked: 3, for 0.12 USD plus 1 unpriced call',
      '- Agreed with the first refuter: 33% (1 of 3)',
      '- Split, one confirmed and one disproved: 33% (1 of 3)',
      '- Changed the outcome the first refuter alone gave: 67% (2 of 3)',
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
        // An unposted finding of a record that says nothing about why still counts.
        unposted: [{
          ...makeFindingFingerprintEntry({ severity: 'suggestion' }), preExisting: { reason: 'Old.', check: 'pre_existing' },
          gradePath: [{ from: 'warning', to: 'suggestion', by: 'judge' }],
        }, makeFindingFingerprintEntry({ severity: 'nitpick' }), {
          // The reason a note was left out counts ahead of a pre-existing claim the diff contradicted.
          ...makeFindingFingerprintEntry({ severity: 'suggestion' }), origin: 'reviewed', unpostedReason: 'reviewed_code', preExisting: { reason: 'Old.', check: 'touches_diff' },
        }, { ...makeFindingFingerprintEntry({ severity: 'nitpick' }), origin: 'earlier', raisedIn: 1, unpostedReason: 'listed_earlier' }, { ...makeFindingFingerprintEntry({ severity: 'suggestion' }), unpostedReason: 'note_cap', posted: 'record' }],
      },
      judge: {
        summary: '', fixClaimedThreads: ['T1', 'T2'],
        inPrSuppressedCount: 1, ratchetSuppressedCount: 2, resolvedThreadSuppressedCount: 3, ownProposalDemotedCount: 4,
        // A drop takes its severity from its last grade step. The counts cover the drops the record does not list.
        dropped: [
          { title: 't', file: 'a', line: 1, reviewers: [], gradePath: [{ from: 'warning', to: 'ignore', by: 'refutation', reason: 'r' }] },
          { title: 't', file: 'a', line: 2, reviewers: [], gradePath: [{ from: 'warning', to: 'ignore', by: 'in_pr_suppression' }] },
          { title: 't', file: 'a', line: 3, reviewers: [], gradePath: [{ from: 'suggestion', to: 'warning', by: 'judge' }, { from: 'warning', to: 'ignore', by: 'ratchet' }] },
          { title: 't', file: 'a', line: 4, reviewers: [] },
        ],
      },
      dedup: { testNitSuppressedCount: 5, staticSignalMatches: [{ droppedTitle: 't', file: 'a', line: 1, tool: 'eslint', ruleId: 'r' }] },
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
      'Grade changes': {
        'unproven: blocker to warning': 1, 'judge: warning to suggestion': 1, 'refutation: warning to ignore': 1, 'in_pr_suppression: warning to ignore': 1,
        'judge: suggestion to warning': 1, 'ratchet: warning to ignore': 1,
      },
      'Pre-existing claims (how each was checked)': { pre_existing: 1, touches_diff: 1 },
      'Memory suppressions (findings hidden per suppression)': { 'sup-1': 1 },
      'Findings recorded without posting (per reason and severity)': {
        'memory_suppression, nitpick': 1, 'pre_existing, suggestion': 1, 'no reason recorded, nitpick': 1,
        'reviewed_code, suggestion': 1, 'listed_earlier, nitpick': 1, 'note_cap, suggestion': 1,
        'in_pr_suppression, warning': 1, 'ratchet, warning': 1, 'ratchet, severity not recorded': 1, 'resolved_thread, severity not recorded': 3,
        'own_proposal, severity not recorded': 4, 'test_file, severity not recorded': 5, 'static_signal, severity not recorded': 1,
      },
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
    expect(report).toContain('- Approved rounds: -\n- PRs with rounds after their first approval: -, 0 such rounds');
    expect(report).toContain('| all | 0 | - | 0 | - | - |');
    expect(report).toContain('| severity | posted | fixed | dismissed | untouched | fixed % | dismissed % |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n\nNo data.');
    expect(report).toContain('### Findings recorded without posting (per reason and severity)\n\nNone recorded.');
    expect(report).toContain('No refutations.');
    expect(report).toContain('No second refuter.');
    // Calls that gave no answer still show what they cost.
    const failed = makeRoundContext(1, { usage: { llmCalls: [{ ...call('gpt-5', 2), stage: 'judge', agent: 'refute_pair', costUsd: 0.05, failed: true }] } });
    const silent = computeStats([prRecords('o/r', 4, { reviews: [review(300, failed)], threadComments: [] })]);
    expect(renderStats(silent)).toContain('- Findings checked: 0, for 0.05 USD\n- Agreed with the first refuter: -');
  });
});
