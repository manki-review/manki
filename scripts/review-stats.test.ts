import type { LLMCall } from '../src/providers';
import { parsePRDiff } from '../src/diff';
import { SEEN_MARKERS, UNSETTLED_ANSWER_MARKER } from '../src/recap';
import { formatApprovalRecord, formatReplyRecord, formatReviewRecord } from '../src/review-record';
import { makeFindingFingerprintEntry, makeRoundContext } from '../src/test-utils';
import { PRE_EXISTING_TAG } from '../src/types';
import type { ApprovalRecord, FindingFingerprintEntry, ReplyRecord, RoundContext } from '../src/types';
import { computeStats, fetchSinceRoundOne, prRecords, renderStats, roundNumbering } from './review-stats';
import type { PrRecords, RoundOneDiffs } from './review-stats';

const bot = { login: 'manki-review[bot]', type: 'Bot' };
const person = { login: 'alice', type: 'User' };

const call = (model: string, steps: number): LLMCall => ({
  stage: 'reviewer', model, attempt: 1, durationMs: 10, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
  costUsd: 0, toolSteps: Array.from({ length: steps }, () => ({ tool: 'Read', durationMs: 1 })),
});

const review = (id: number, context: RoundContext) => ({ id, body: `Review.\n${formatReviewRecord(context)}`, user: bot });

/** Returns the diff of `src/a.ts` that adds each line of `added` at its line number. */
const addsTo = (...added: Array<[number, string]>) => parsePRDiff(added.length === 0 ? '' : [
  'diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', ...added.flatMap(([line, text]) => [`@@ -${line - 1},0 +${line},1 @@`, `+${text}`]), '',
].join('\n'));
/** The diffs of a later round whose push since round 1 added nothing to the PR's change on line 10 of `src/a.ts`. */
const untouchedSinceRoundOne: RoundOneDiffs = { prior: addsTo([10, 'const a = 1;']), current: addsTo([10, 'const a = 1;']), interRound: addsTo() };

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
          { ...makeFindingFingerprintEntry({ severity: 'warning', title: 'Minor' }), origin: 'new', reviewers: ['Sweep 1'] },
        ],
      },
      // The first sweep reported two places, of which the round posted one. The fourth was past the round's cap.
      sweeps: [
        { reviewer: 'Sweep 1', source: 'src/a.ts:10', severity: 'blocker', status: 'answered', class: 'c', findings: 2 },
        { reviewer: 'Sweep 2', source: 'src/a.ts:20', severity: 'warning', status: 'answered', class: 'c', findings: 0 },
        { reviewer: 'Sweep 3', source: 'src/a.ts:30', severity: 'warning', status: 'too_specific', class: 'c' },
        { reviewer: 'Sweep 4', source: 'src/a.ts:40', severity: 'warning', status: 'cut' },
      ],
      diff: { lines: 1, additions: 1, deletions: 0, filesReviewed: 1, fileTypes: {}, perFile: [{ path: 'src/a.ts', additions: 1, deletions: 0, changeType: 'modified' }] },
      reviewers: {
        agents: ['Sonnet', 'Opus'],
        agentMetrics: [{ name: 'Sonnet', model: 'claude-sonnet', findingsRaw: 3, keptOnly: 1, keptShared: 1 }, { name: 'Opus', model: 'claude-opus', findingsRaw: 1, keptOnly: 0, keptShared: 1 }],
      },
      usage: {
        estimatedCostUsd: 0.5,
        llmCalls: [
          // A step whose record has no characters counts in no figure of them.
          {
            ...call('claude-sonnet', 4), agent: 'Sonnet', stepBudget: 15, filesRead: ['src/a.ts', 'src//util.ts'],
            toolSteps: [{ tool: 'Read', resultChars: 100 }, { tool: 'Read', resultChars: 300 }, { tool: 'Read' }, { tool: 'Read', resultChars: 200 }],
          },
          { ...call('claude-opus', 10), agent: 'Opus', stepBudget: 12, wrapUpNoted: true }, { ...call('j', 3), stage: 'judge' },
          // A second read is no finder, so its call counts in no figure of finder tool use.
          { ...call('claude-opus', 7), agent: 'Second read 1', stepBudget: 12, wrapUpNoted: true, filesRead: ['src/z.ts'] },
          // A fallback that answered for the Sonnet finder on another model still counts for that finder. A file both calls
          // read counts once, however each spells it. A file of a related repo counts apart from the share in the diff.
          {
            ...call('gpt-5', 2), agent: 'Sonnet', fallback: true, filesRead: ['./src/a.ts', 'o/r:lib/x.ts'],
            toolSteps: [{ tool: 'mcp__manki__read_file', durationMs: 1, file: 'src/a.ts', resultChars: 20_000 }, { tool: 'Grep', durationMs: 1, resultChars: 50 }],
          },
          { ...call('gpt-5', 5), stage: 'judge', agent: 'refute_pair', costUsd: 0.12 },
          { ...call('claude-sonnet', 6), stage: 'sweep', agent: 'Sweep 1', costUsd: 0.1 }, { ...call('j', 0), stage: 'judge', agent: 'sweep', costUsd: 0.05 },
          // The refuter and dedup calls on what a sweep reported count as its cost. A record from before the mark has only the two above.
          { ...call('j', 4), stage: 'judge', agent: 'refute', costUsd: 0.2, sweep: true }, { ...call('d', 0), stage: 'dedup', agent: 'sweep', costUsd: 0.01 },
        ],
      },
    });
    const second = makeRoundContext(2, {
      meta: { prNumber: 1, commitSha: 'b', round: 2, timestamp: 't', mankiVersion: '7.6.0', outcome: 'READY' },
      judge: {
        summary: '', interRoundDiffState: 'changed',
        // A finding a disproof dropped is listed with the judge's drops, and its refutations count too.
        dropped: [{
          title: 't', file: 'a', line: 1, reviewers: [],
          refutation: unsettled('first'), pairRefutation: { outcome: 'unsettled', defect: 'disproved', reason: 'r', files: [], codeDigest: 'd' },
        }, { title: 'u', file: 'a', line: 2, reviewers: ['Sweep 1'] }],
      },
      // The blocker's answers are reused from round 1, so they count once. A lead left unsettled counts, a posted one does not.
      findings: {
        count: 3, severityCounts: {},
        // A finding that restates an earlier one was not first raised in this round. One under an earlier thread is not posted either.
        entries: [
          { ...makeFindingFingerprintEntry({ severity: 'warning' }), origin: 'reviewed' },
          { ...makeFindingFingerprintEntry({ severity: 'note' }), origin: 'new' },
          { ...makeFindingFingerprintEntry({ severity: 'note' }), origin: 'earlier' },
          { ...makeFindingFingerprintEntry({ severity: 'warning' }), origin: 'reviewed', threadId: 'T1' },
          { ...makeFindingFingerprintEntry({ severity: 'note' }), origin: 'new', threadId: 'T2' },
          // Neither is one that matches a thread the first review opened, a few lines away.
          { ...makeFindingFingerprintEntry({ severity: 'warning', title: 'Minor', lineStart: 12 }), origin: 'reviewed' },
        ],
        unposted: [{ ...makeFindingFingerprintEntry({ severity: 'blocker' }), refutation: disprovedBlocker, pairRefutation: confirmedBlocker, reviewers: ['Sweep 1'] }],
      },
      sweeps: [{ reviewer: 'Sweep 1', source: 'src/a.ts:10', severity: 'blocker', status: 'failed' }],
      leads: [
        { ...lead, outcome: 'unsettled', refutation: unsettled('lead first'), pairRefutation: unsettled('lead second') },
        { ...lead, outcome: 'confirmed', posted: true, refutation: confirmedBlocker },
      ],
      usage: { estimatedCostUsd: 0.25, llmCalls: [{ ...call('gpt-5', 3), stage: 'judge', agent: 'refute_pair', costUsd: null }] },
    });
    const threadComments = [
      { id: 10, body: '**Blocker**: Bug\n\n<!-- manki:blocker:Bug -->', user: bot },
      { id: 11, in_reply_to_id: 10, body: 'Fixed in abc1234.\n\n<!-- manki -->', user: bot },
      { id: 20, body: '**Blocker**: Wrong\n\n<!-- manki:blocker:Wrong -->', user: bot },
      { id: 21, in_reply_to_id: 20, body: 'Fixed', user: person },
      { id: 22, in_reply_to_id: 20, body: '**Withdrawn.** The value is checked above.', user: bot },
      { id: 30, body: '**Blocker**: Open\n\n<!-- manki:blocker:Open -->', user: bot },
      { id: 31, in_reply_to_id: 30, body: 'Fixed in def5678.', user: person },
      // A "Fixed." that opens with the state of the thread it leaves open counts as one, and a later unsettled answer changes nothing.
      { id: 35, body: '**Blocker**: Guard\n\n<!-- manki:blocker:Guard -->', user: bot },
      { id: 36, in_reply_to_id: 35, body: `**Fix seen, the thread stays open until a review or a maintainer confirms it.**\n\nThe guard runs first.\n\n<!-- manki -->\n${SEEN_MARKERS.Fixed}`, user: bot },
      { id: 37, in_reply_to_id: 35, body: `**Not settled yet.** The guard runs first.\n\n<!-- manki -->\n${UNSETTLED_ANSWER_MARKER}`, user: bot },
      { id: 40, body: '**Warning**: Minor\n\n<!-- manki:warning:Minor -->', user: bot, pull_request_review_id: 1, path: 'src/a.ts', line: null, original_line: 10 },
      { id: 41, in_reply_to_id: 40, body: 'Withdrawn.', user: bot },
      { id: 50, body: 'A person\'s comment\n\n<!-- manki:blocker:Pasted -->', user: person },
    ];
    const one = prRecords('o/r', 1, { reviews: [review(1, first), { id: 2, body: 'A person\'s review.', user: person }, review(3, second)], threadComments });

    const reader = makeRoundContext(1, {
      meta: { prNumber: 2, commitSha: 'c', round: 1, timestamp: 't', mankiVersion: '7', outcome: 'ADDRESS_FIRST' },
      judge: {
        summary: '',
        verdictReason: 'verdict_reader',
        verdictTrace: { survivingBlockers: [{ file: 'a', line: 1, title: 'x', fingerprint: 'k1' }, { file: 'b', line: 2, title: 'y', fingerprint: 'k2' }], unresolvedPriors: [] },
      },
      // A record too large to keep `diff.perFile` leaves its files out of the share read in the diff. Two finders on one model
      // count as two finder rounds. A failed call adds no files, and a call without steps, as in an older record of a Codex
      // call, counts in no figure of tool use.
      usage: {
        estimatedCostUsd: 1,
        llmCalls: [
          { ...call('claude-opus', 1), agent: 'Opus A', filesRead: ['src/b.ts'] }, { ...call('claude-opus', 1), agent: 'Opus B' },
          { ...call('claude-opus', 0), agent: 'Opus B', toolSteps: undefined, failed: true, filesRead: ['src/d.ts'] },
          { ...call('gpt-5', 0), toolSteps: undefined, filesRead: ['src/c.ts'] },
        ],
      },
    });
    // A record that says where each finding went is read as it says: a finding under an earlier thread is left out, and
    // one posted again beside a matching earlier thread counts. A round that tagged origins without the earlier change
    // counts its findings, but not as first raised later. An earlier blocker listed again to get a thread counts nowhere.
    const placed: Record<number, RoundContext['findings']> = {
      3: {
        count: 4, severityCounts: {},
        entries: [
          { ...makeFindingFingerprintEntry({ severity: 'blocker', title: 'Listed again' }), origin: 'earlier', raisedIn: 1, posted: 'thread', relisted: true },
          { ...makeFindingFingerprintEntry({ severity: 'warning' }), origin: 'reviewed', posted: 'body' },
          { ...makeFindingFingerprintEntry({ severity: 'note' }), origin: 'new', posted: 'earlier_thread' },
          { ...makeFindingFingerprintEntry({ severity: 'warning', title: 'Minor', lineStart: 10 }), origin: 'reviewed', posted: 'thread' },
        ],
      },
      4: { count: 1, severityCounts: {}, originsWithoutPrior: true, entries: [{ ...makeFindingFingerprintEntry({ severity: 'warning' }), origin: 'new', posted: 'thread' }] },
    };
    const later = [2, 3, 4, 5].map(round => makeRoundContext(round, {
      meta: { prNumber: 2, commitSha: `c${round}`, round, timestamp: 't', mankiVersion: '7.6.0', ...(round === 2 && { outcome: 'READY' as const }) },
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
    const earlierThread = { id: 80, body: '**Warning**: Minor\n\n<!-- manki:warning:Minor -->', user: bot, pull_request_review_id: 100, path: 'src/a.ts', line: 10 };
    const two = prRecords('o/r', 2, { reviews: [reader, later[0], failed, ...later.slice(1)].map((context, i) => review(100 + i, context)), threadComments: [earlierThread] });
    expect([two.rounds.length, two.incompleteRounds]).toEqual([5, [failed]]);

    const unreviewed = prRecords('o/r', 3, { reviews: [{ id: 200, body: 'A person\'s review.', user: person }], threadComments: [] });
    const fixRate = (pr: number, posted: number) => JSON.stringify({
      pr, counts: [{ severity: 'warning', specialist: 'Sonnet', posted, fixed: 1, dismissed: 0, untouched: posted - 1 }, { severity: 'warning', specialist: 'Sweep 1', posted: 1, fixed: 0, dismissed: 1, untouched: 0 }],
      calibration: [{ severity: 'warning', checkStatus: 'proven', posted, fixed: 1, dismissed: 0, untouched: posted - 1 }],
    });
    // A fix-rate line of a PR outside the report does not count.
    const stats = computeStats([one, two, unreviewed], [fixRate(1, 2), fixRate(9, 5)]);
    expect(stats).toMatchObject({
      prs: 2, unreviewed: 1, roundsPerPr: [2, 5], passedFirstRound: 0, manyRounds: 1, rounds: 7, incompleteRounds: 1,
      // The first PR ended on its approval. The second ran three more rounds after its own.
      approvedRounds: 2, roundsAfterApproval: [3],
      severities: {
        blocker: { posted: 1, inApprovedRounds: 0, raisedLater: 0, onReviewedCode: 0 },
        // Round 3 of the second PR did not read the diff since round 2, so its findings on reviewed code are not known to be late.
        warning: { posted: 5, inApprovedRounds: 1, raisedLater: 1, onReviewedCode: 1 },
        note: { posted: 2, inApprovedRounds: 2, raisedLater: 1, onReviewedCode: 0 },
      },
      blockerOutcomes: { fixed: 2, withdrawn: 1, other: 1 },
      readerRounds: 1, readerBlockers: 2,
      costPerPr: [0.75, 1], costPerRound: [0.5, 0.25, 1, 0, 0, 0, 0],
      // Rounds 2 of the first PR and 4 and 5 of the second had a whole diff. Round 2 of the second was cut, round 3 unknown.
      followUpRounds: 5, interRoundDiffCutOrUnknown: 2,
    });
    expect(Object.fromEntries(stats.refutations)).toEqual({ 'blocker disproved': 1, 'ignore unsettled': 1, 'warning unsettled': 1 });
    expect(Object.fromEntries(stats.pairRefutations)).toEqual({ 'disproved / confirmed': 1, 'unsettled / disproved': 1, 'unsettled / unsettled': 1 });
    expect(Object.fromEntries(stats.finders)).toEqual({
      'claude-sonnet': {
        rounds: 1, rawFindings: 3, keptOnly: 1, keptShared: 1, toolSteps: [4, 2], budgetedCalls: 1, wrapUps: 0,
        stepsPerRound: [6], filesPerRound: [3], relatedFiles: 1, filesInDiff: 1, filesInListedRounds: 2, readSteps: 4, readFileSteps: 1, otherSteps: 1,
        readChars: [100, 300, 200], readFileChars: [20_000],
      },
      'claude-opus': {
        rounds: 1, rawFindings: 1, keptOnly: 0, keptShared: 1, toolSteps: [10, 1, 1, 0], budgetedCalls: 1, wrapUps: 1,
        stepsPerRound: [10, 1, 1], filesPerRound: [0, 1, 0], relatedFiles: 0, filesInDiff: 0, filesInListedRounds: 0, readSteps: 12, readFileSteps: 0, otherSteps: 0,
        readChars: [], readFileChars: [],
      },
      'gpt-5': {
        rounds: 0, rawFindings: 0, keptOnly: 0, keptShared: 0, toolSteps: [0], budgetedCalls: 0, wrapUps: 0,
        stepsPerRound: [], filesPerRound: [], relatedFiles: 0, filesInDiff: 0, filesInListedRounds: 0, readSteps: 0, readFileSteps: 0, otherSteps: 0,
        readChars: [], readFileChars: [],
      },
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
      '| warning | 5 | 0.71 | 1 | 0.50 | 100% (1 of 1) |',
      '| note | 2 | 0.29 | 2 | 1.00 | 0% (0 of 1) |',
      '| all | 8 | 1.14 | 3 | 1.50 | 50% (1 of 2) |',
    ].join('\n'));
    expect(report).toContain('whether or not that commit fixed it.\n\n| severity | posted | fixed | dismissed | untouched | fixed % | dismissed % |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n| warning | 3 | 1 | 1 | 1 | 33% | 33% |\n\n| checkStatus | posted | fixed | dismissed | untouched | fixed % | dismissed % |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: |\n| proven | 2 | 1 | 0 | 1 | 50% | 0% |\n\n## Finders');
    expect(report).toContain('- Blocker threads: 4, fixed 2, withdrawn 1, other 1');
    // The split and the answer the first refuter left unsettled both changed the outcome. The lead's two answers agreed.
    expect(report).toContain([
      '## Second refuter', '',
      '- Findings checked: 3, for 0.12 USD plus 1 unpriced call',
      '- Agreed with the first refuter: 33% (1 of 3)',
      '- Split, one confirmed and one disproved: 33% (1 of 3)',
      '- Changed the outcome the first refuter alone gave: 67% (2 of 3)',
    ].join('\n'));
    expect(report).toContain([
      '## Sweeps', '',
      '- Rounds that started a sweep: 29% (2 of 7)',
      '- Sweeps: 2 answered, 1 too_specific, 1 failed, 1 cut',
      '- Sweeps that reported another place: 50% (1 of 2) of those answered, 2 places in all',
      '- Findings of a sweep: 1 posted (1 warning), 1 recorded without posting, 1 dropped by the judge. A place that restates another finding, one a memory suppression hid and one the judge left as an open lead count in none of the three.',
      '- Cost of the sweep calls and of the dedup, judge and refuter calls that ran only for what they reported: 0.36 USD, 21% of the cost of all rounds',
      '',
      '| raised by | posted | fixed | dismissed | untouched | fixed % | dismissed % |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| any other source | 2 | 1 | 0 | 1 | 50% | 0% |',
      '| a sweep | 1 | 0 | 1 | 0 | 0% | 100% |',
    ].join('\n'));
    expect(report).toContain('| claude-sonnet | 1 | 3 | 3.00 | 1 | 1 | mean 3.0, median 3.0, max 4.0 | 0% (0 of 1) |');
    expect(report).toContain('| claude-opus | 1 | 1 | 1.00 | 0 | 1 | mean 3.0, median 1.0, max 10.0 | 100% (1 of 1) |');
    expect(report).toContain([
      '| model | finder rounds | tool steps per round | files read per round | files read in a related repo | own files read that the diff changes | `Read` steps | characters per `Read` step | `read_file` steps | characters per `read_file` step | other steps |',
      '| --- | ---: | --- | --- | ---: | ---: | ---: | --- | ---: | --- | ---: |',
      '| claude-opus | 3 | mean 4.0, median 1.0, max 10.0 | mean 0.3, median 0.0, max 1.0 | 0 | - | 12 | - | 0 | - | 0 |',
      '| claude-sonnet | 1 | mean 6.0, median 6.0, max 6.0 | mean 3.0, median 3.0, max 3.0 | 1 | 50% (1 of 2) | 4 | mean 200, median 200, max 300 | 1 | mean 20000, median 20000, max 20000 | 1 |',
      '',
      '## Refutations',
    ].join('\n'));
    expect(report).toContain('| blocker disproved | 1 |');
    expect(report).toContain('- Follow-up rounds whose inter-round diff was cut or unknown: 40% (2 of 5)');
  });

  it('counts the blockers and warnings round 1 found against those a later round found on reviewed code, over the PRs whose records prove it, and leaves PRs with rounds out of sequence out of every figure that reads a round number', () => {
    let made = 0;
    const entry = (severity: 'blocker' | 'warning' | 'note', more: Partial<FindingFingerprintEntry> = {}): FindingFingerprintEntry =>
      ({ ...makeFindingFingerprintEntry({ severity, title: `Finding ${++made}` }), ...more });
    const round = (
      number: number, mankiVersion: string, entries: FindingFingerprintEntry[], more: Partial<RoundContext['findings']> = {}, outcome?: 'READY',
      interRoundDiffState: RoundContext['judge']['interRoundDiffState'] = number > 1 ? 'changed' : undefined,
    ) => makeRoundContext(number, {
      meta: { prNumber: 1, commitSha: 'a', round: number, timestamp: 't', mankiVersion, ...(outcome && { outcome }) },
      judge: { summary: '', ...(interRoundDiffState && { interRoundDiffState }) }, findings: { count: entries.length, severityCounts: {}, entries, ...more },
    });
    const carried = { carried: [entry('warning', { raisedIn: 1 })] };
    const pr = (number: number, rounds: RoundContext[], sinceRoundOne?: PrRecords['sinceRoundOne']): PrRecords =>
      ({ ...prRecords('o/r', number, { reviews: rounds.map((context, i) => review(number * 10 + i, context)), threadComments: [] }), ...(sinceRoundOne && { sinceRoundOne }) });
    const prs = [
      pr(10, [
        // Round 1 needs no origin. A note and a pre-existing finding count in no column.
        round(1, '7.6.0', [entry('blocker', { origin: 'new' }), entry('warning', { origin: 'new' }), entry('warning'), entry('note'), entry('warning', { tags: [PRE_EXISTING_TAG] })]),
        // A finding on code the push changed, one that restates an earlier one, also in a thread of its own, one under an
        // earlier thread and a pre-existing one are not late.
        round(2, '7.6.0', [
          entry('warning', { origin: 'reviewed' }), entry('blocker', { origin: 'new' }), entry('note', { origin: 'reviewed' }), entry('warning', { origin: 'earlier', raisedIn: 1, posted: 'thread' }),
          entry('warning', { origin: 'reviewed', posted: 'earlier_thread' }), entry('blocker', { origin: 'reviewed', tags: [PRE_EXISTING_TAG] }),
        ]),
        round(3, '7.6.1', [entry('blocker', { origin: 'reviewed' })], carried),
      ], [undefined, undefined, untouchedSinceRoundOne]),
      // A later round of a release that did not flag a round without the earlier change cannot prove a finding new.
      pr(11, [round(1, '7.4.0', [entry('warning')]), round(2, '7.4.0', [entry('warning', { origin: 'new' })]), round(3, '7.4.0', [entry('note', { origin: 'reviewed' })])]),
      // A round without the earlier change, and one whose findings have no origin, prove nothing either.
      pr(12, [round(1, '7.6.0', [entry('blocker')]), round(2, '7.6.0', [entry('warning', { origin: 'new' })], { originsWithoutPrior: true }), round(3, '7.6.0', [entry('warning')])]),
      // A later round of an old release that posted no blocker or warning adds nothing late, so the PR still counts.
      pr(13, [round(1, '6.1.0', [entry('warning')]), round(2, '6.1.0', [entry('note')])]),
      // Without the record of round 1 the PR's first findings are unknown, and so are those its later rounds call late, which nothing compares with round 1.
      // Nor did it pass after one round, and its later round is no known follow-up round.
      pr(14, [round(2, '7.6.0', [entry('warning', { origin: 'reviewed' })], {}, 'READY'), round(3, '7.6.0', [entry('warning', { origin: 'reviewed' })])]),
      pr(15, [round(1, '7.6.0', [], {}, 'READY')]),
      // A round that could not read the earlier records numbers itself round 1 again. Only the first record can be round 1.
      pr(16, [round(1, '7.6.0', [entry('warning')]), round(2, '7.6.0', [entry('note', { origin: 'new' })]), round(1, '7.6.0', [entry('warning', { origin: 'new' })])]),
      // Two records of one round leave the order unknown, and so the rounds since a carried warning was first listed.
      pr(17, [round(1, '7.6.0', [entry('blocker')]), round(2, '7.6.0', []), round(2, '7.6.0', [entry('warning', { origin: 'reviewed' })], carried)]),
      // Without the diff since the round before, a line a push deleted or restored can read as reviewed.
      pr(19, [round(1, '7.6.0', [entry('warning')]), round(2, '7.6.0', [entry('warning', { origin: 'reviewed' })], {}, undefined, 'unknown')]),
    ];
    // A record that does not decode may hold any round, findings on reviewed code included.
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    prs.push(prRecords('o/r', 18, { reviews: [review(180, round(1, '7.6.0', [entry('warning')], {}, 'READY')), { id: 181, body: '<!-- manki-context: {not json} -->', user: bot }], threadComments: [] }));
    errorSpy.mockRestore();
    expect(prs.at(-1)).toMatchObject({ undecodedRounds: 1, rounds: [{ meta: { round: 1 } }] });
    const numbering = (number: number) => roundNumbering(prs.find(p => p.number === number)!);
    expect([10, 14, 16, 17, 18].map(numbering)).toEqual([
      undefined, 'record 1 in posting order is of round 2, not 1', 'record 3 in posting order is of round 1, not 3', 'record 3 in posting order is of round 2, not 3', '1 round record did not decode',
    ]);
    const stats = computeStats(prs);
    // Only PRs 10, 11, 12, 13, 15 and 19 have records of rounds 1, 2, 3 in posting order that all decode.
    expect(stats).toMatchObject({
      prs: 10, numberedPrs: 6, passedFirstRound: 1, followUpRounds: 8, interRoundDiffCutOrUnknown: 1,
      // The findings of PR 11 on 7.4.0 and of PR 19 without the diff since the round before are not known to be first raised later.
      severities: { blocker: { raisedLater: 3, onReviewedCode: 2 }, warning: { raisedLater: 1, onReviewedCode: 1 } },
    });
    expect(Object.fromEntries(stats.decisions.get('Warnings carried from an earlier review body (listed again per rounds since first listed, ended per reason)')!)).toEqual({ 'listed again, 2 rounds on': 1 });
    const grades = (blocker: [number, number], warning: [number, number]) => ({
      blocker: { firstRound: blocker[0], later: blocker[1] }, warning: { firstRound: warning[0], later: warning[1] },
    });
    const counts = (number: number, blocker: [number, number], warning: [number, number], unproven = 0, noFirstRound = false) => ({ number, size: 0, grades: grades(blocker, warning), noFirstRound, unproven });
    expect(stats.firstRound).toEqual([
      counts(10, [1, 1], [2, 1]),
      counts(11, [0, 0], [1, 0], 1),
      counts(12, [1, 0], [0, 0], 2),
      counts(13, [0, 0], [1, 0]),
      counts(14, [0, 0], [0, 0], 1, true),
      counts(15, [0, 0], [0, 0]),
      counts(16, [0, 0], [1, 0], 1),
      counts(17, [1, 0], [0, 0], 1),
      counts(19, [0, 0], [1, 0], 1),
      counts(18, [0, 0], [1, 0], 1),
    ]);
    const report = renderStats(stats);
    expect(report).toContain('- Passed after one round: 17% (1 of 6)');
    expect(report).toContain('- PRs left out of the share passed after one round, the findings first raised in a later round, the follow-up rounds and the rounds a carried warning waited, because a round record did not decode or the records are not rounds 1, 2, 3 in posting order: 4\n');
    expect(report).toContain([
      '## Found in round 1', '',
      '| grade | round 1 | later, on code round 1 reviewed | found in round 1 |',
      '| --- | ---: | ---: | ---: |',
      '| blocker | 1 | 1 | 50% (1 of 2) |',
      '| warning | 3 | 1 | 75% (3 of 4) |',
      '| both | 4 | 2 | 67% (4 of 6) |',
    ].join('\n'));
    expect(report).toContain('\n\n7 PRs left out (#11, #12, #14, #16, #17, #19, #18): 1 without a round 1 record, 8 round records that cannot say where a finding was first raised.\n\n');
    expect(report).toContain([
      '| PR | round 1 blockers | round 1 warnings | later blockers | later warnings | found in round 1 |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
      '| #10 | 1 | 2 | 1 | 1 | 60% (3 of 5) |',
      '| #13 | 0 | 1 | 0 | 0 | 100% (1 of 1) |',
      '',
      '## Fix rate',
    ].join('\n'));
    const none = renderStats(computeStats([]));
    expect(none).toContain('| both | 0 | 0 | - |');
    expect(none).not.toContain('left out (');
    expect(none).not.toContain('| PR | round 1 blockers');
  });

  it('counts a finding of round 3 on reviewed code as late only when round 1 reviewed that code too, and splits the share by PR size', async () => {
    const entry = (severity: 'blocker' | 'warning', line: number) => ({ ...makeFindingFingerprintEntry({ severity, title: `Line ${line}`, lineStart: line }), origin: 'reviewed' as const });
    const round = (number: number, entries: FindingFingerprintEntry[], changed = 0) => makeRoundContext(number, {
      meta: { prNumber: 1, commitSha: `head${number}`, round: number, timestamp: 't', mankiVersion: '7.8.0' },
      judge: { summary: '', ...(number > 1 && { interRoundDiffState: 'changed' as const }) },
      findings: { count: entries.length, severityCounts: {}, entries },
      diff: { ...makeRoundContext(number).diff, additions: changed, deletions: 0 },
    });
    const pr = (number: number, rounds: RoundContext[], sinceRoundOne?: PrRecords['sinceRoundOne']): PrRecords =>
      ({ ...prRecords('o/r', number, { reviews: rounds.map((context, i) => review(number * 10 + i, context)), threadComments: [] }), ...(sinceRoundOne && { sinceRoundOne }) });
    // A push after round 1 added line 40, so round 1 never saw it.
    const addedLater: RoundOneDiffs = { prior: addsTo([10, 'const a = 1;']), current: addsTo([10, 'const a = 1;'], [40, 'const b = 2;']), interRound: addsTo([40, 'const b = 2;']) };
    const prs = [
      pr(1, [round(1, [entry('blocker', 10)]), round(2, []), round(3, [entry('blocker', 10), entry('warning', 40)], 299)], [undefined, undefined, addedLater]),
      // Round 2 compares with round 1 by its own origins.
      pr(2, [round(1, [entry('warning', 10)]), round(2, [entry('warning', 10)], 800)]),
      // Without the diffs since round 1, a finding of round 3 on reviewed code cannot be placed.
      pr(3, [round(1, []), round(2, []), round(3, [entry('warning', 10)], 801)]),
      pr(4, [round(1, [entry('warning', 10)]), round(2, [], 801)]),
    ];
    const stats = computeStats(prs);
    expect(stats.firstRound.map(({ number, size, grades, unproven }) => [number, size, grades.blocker, grades.warning, unproven])).toEqual([
      [1, 299, { firstRound: 1, later: 1 }, { firstRound: 0, later: 0 }, 0],
      [2, 800, { firstRound: 0, later: 0 }, { firstRound: 1, later: 1 }, 0],
      [3, 801, { firstRound: 0, later: 0 }, { firstRound: 0, later: 0 }, 1],
      [4, 801, { firstRound: 0, later: 0 }, { firstRound: 1, later: 0 }, 0],
    ]);
    expect(renderStats(stats)).toContain([
      '| PR size, changed lines as last reviewed | PRs | round 1 | later | found in round 1 |',
      '| --- | ---: | ---: | ---: | ---: |',
      '| under 300 lines | 1 | 1 | 1 | 50% (1 of 2) |',
      '| 300 to 800 lines | 1 | 1 | 1 | 50% (1 of 2) |',
      '| over 800 lines | 1 | 1 | 0 | 100% (1 of 1) |',
    ].join('\n'));

    // The diffs are read only for a round from round 3 on with a finding on reviewed code: the PR's change from the base
    // at round 1 and at that round, and the change between the two commits. A diff that cannot be read gives none.
    const diffs: Record<string, string> = {
      'base...head1': 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,0 +10,1 @@\n+const a = 1;\n',
      'base...head3': 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -9,0 +10,1 @@\n+const a = 1;\n@@ -39,0 +40,1 @@\n+const b = 2;\n',
      'head1...head3': 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -39,0 +40,1 @@\n+const b = 2;\n',
    };
    const compareCommits = jest.fn(async ({ base, head }: { base: string; head: string }) => {
      if (!(`${base}...${head}` in diffs)) throw new Error('Not Found');
      return { data: diffs[`${base}...${head}`] };
    });
    const octokit = { rest: { repos: { compareCommits } } } as unknown as Parameters<typeof fetchSinceRoundOne>[0];
    const [read] = (await fetchSinceRoundOne(octokit, 'o', 'r', prs[0], 'base'))!.slice(2);
    expect(compareCommits.mock.calls.map(([{ base, head }]) => `${base}...${head}`).sort()).toEqual(Object.keys(diffs).sort());
    expect(computeStats([{ ...prs[0], sinceRoundOne: [undefined, undefined, read] }]).firstRound[0].grades.blocker).toEqual({ firstRound: 1, later: 1 });
    expect(await fetchSinceRoundOne(octokit, 'o', 'r', prs[1], 'base')).toBeUndefined();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await fetchSinceRoundOne(octokit, 'o', 'r', prs[2], 'gone')).toEqual([undefined, undefined, undefined]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('#3 round 3: the diffs since round 1 could not be read'));
    errorSpy.mockRestore();
  });

  it('tallies every decision the round and reply records keep, and lists each in the report', () => {
    const rule = { file: 'AGENTS.md', quote: 'Every migration needs a rollback.' };
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
        entries: [{ ...makeFindingFingerprintEntry({ severity: 'warning' }), gradePath: [{ from: 'blocker', to: 'warning', by: 'unproven' }], rule: { ...rule, verdict: 'confirmed' } }],
        // An unposted finding of a record that says nothing about why still counts.
        unposted: [{
          ...makeFindingFingerprintEntry({ severity: 'note' }), preExisting: { reason: 'Old.', check: 'pre_existing' },
          gradePath: [{ from: 'warning', to: 'note', by: 'judge' }],
        }, { ...makeFindingFingerprintEntry({ severity: 'note' }), rule: { ...rule, verdict: 'no_requirement' } }, {
          // The reason a note was left out counts ahead of a pre-existing claim the diff contradicted.
          ...makeFindingFingerprintEntry({ severity: 'note' }), origin: 'reviewed', unpostedReason: 'reviewed_code', preExisting: { reason: 'Old.', check: 'touches_diff' },
        }, { ...makeFindingFingerprintEntry({ severity: 'note' }), origin: 'earlier', raisedIn: 1, unpostedReason: 'listed_earlier' }, { ...makeFindingFingerprintEntry({ severity: 'note' }), unpostedReason: 'note_cap', posted: 'record' },
        // A warning nothing proves counts under what kept it unproven.
        ...(['unsettled_check', 'not_checked', 'not_checked', 'no_proof'] as const).map(unpostedReason => ({ ...makeFindingFingerprintEntry({ severity: 'warning' }), unpostedReason, posted: 'record' as const }))],
        carried: [{ ...makeFindingFingerprintEntry({ severity: 'warning' }), raisedIn: 1 }],
        carriedEnded: [{ key: 'src/a.ts:3:3:x', reason: 'fixed' }, { key: 'src/a.ts:4:4:y', reason: 'fixed' }, { key: 'src/a.ts:5:5:z', reason: 'judge_dropped' }],
      },
      judge: {
        summary: '', fixClaimedThreads: ['T1', 'T2'],
        inPrSuppressedCount: 1, ratchetSuppressedCount: 2, resolvedThreadSuppressedCount: 3, ownProposalDemotedCount: 4,
        // A drop takes its severity from its last grade step. The counts cover the drops the record does not list.
        dropped: [
          { title: 't', file: 'a', line: 1, reviewers: [], gradePath: [{ from: 'warning', to: 'ignore', by: 'refutation', reason: 'r' }], rule: { ...rule, verdict: 'not_broken' } },
          { title: 't', file: 'a', line: 2, reviewers: [], gradePath: [{ from: 'warning', to: 'ignore', by: 'in_pr_suppression' }], rule },
          { title: 't', file: 'a', line: 3, reviewers: [], gradePath: [{ from: 'note', to: 'warning', by: 'judge' }, { from: 'warning', to: 'ignore', by: 'ratchet' }] },
          { title: 't', file: 'a', line: 4, reviewers: [] },
        ],
      },
      dedup: { testNitSuppressedCount: 5, staticSignalMatches: [{ droppedTitle: 't', file: 'a', line: 1, tool: 'eslint', ruleId: 'r' }] },
      diff: { lines: 1, additions: 1, deletions: 0, filesReviewed: 1, fileTypes: {}, changedSinceLastRound: 3 },
      memory: { loaded: { learnings: 4, suppressions: 2 }, suppressed: [{ title: 't', file: 'a', line: 1, severity: 'note', suppressionId: 'sup-1' }] },
      slicing: { files: [2, 1], reader: [{ verdict: 'READY', blockers: 0 }, { verdict: 'ADDRESS_FIRST', blockers: 1 }] },
      approval: { held: 'conflict' },
      secondReads: { reads: [{ reviewer: 'Second read 1', finder: 'f', status: 'answered', findings: 2, added: 1 }, { reviewer: 'Second read 2', finder: 'g', status: 'failed', error: 'e' }], stop: 'failed' },
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
      // Round 2 follows the record of round 1, so the rounds its carried warning waited are known.
      reviews: [review(0, makeRoundContext(1)), review(1, round), { id: 3, body: `Approved.\n${approval('approved', 'all blocking threads are resolved')}`, user: bot }],
      threadComments: [{ id: 60, in_reply_to_id: 59, body: `Fixed.\n\n<!-- manki -->\n${formatReplyRecord(reply as ReplyRecord)}`, user: bot }],
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
        'unproven: blocker to warning': 1, 'judge: warning to note': 1, 'refutation: warning to ignore': 1, 'in_pr_suppression: warning to ignore': 1,
        'judge: note to warning': 1, 'ratchet: warning to ignore': 1,
      },
      'Pre-existing claims (how each was checked)': { pre_existing: 1, touches_diff: 1 },
      // Posted, recorded without posting and dropped by the judge, and a record from before the judge answered.
      'Rule findings (the judge\'s answer and the grade)': { 'confirmed, warning': 1, 'no_requirement, note': 1, 'not_broken, dropped': 1, 'not judged, dropped': 1 },
      'Memory suppressions (findings hidden per suppression)': { 'sup-1': 1 },
      'Findings recorded without posting (per reason and severity)': {
        'memory_suppression, note': 1, 'pre_existing, note': 1, 'no reason recorded, note': 1,
        'reviewed_code, note': 1, 'listed_earlier, note': 1, 'note_cap, note': 1,
        'unsettled_check, warning': 1, 'not_checked, warning': 2, 'no_proof, warning': 1,
        'in_pr_suppression, warning': 1, 'ratchet, warning': 1, 'ratchet, severity not recorded': 1, 'resolved_thread, severity not recorded': 3,
        'own_proposal, severity not recorded': 4, 'test_file, severity not recorded': 5, 'static_signal, severity not recorded': 1,
      },
      'Warnings carried from an earlier review body (listed again per rounds since first listed, ended per reason)': {
        'listed again, 1 round on': 1, 'ended, fixed': 2, 'ended, judge_dropped': 1,
      },
      'Verdict reader per slice': { READY: 1, ADDRESS_FIRST: 1 },
      'Second reads (per round: reads run, blockers and warnings added, why they stopped)': { '2 run, 1 added, failed': 1 },
      Approvals: { 'held: conflict': 1 },
      'Thread reply decisions': { 'Fixed, stays_open': 1 },
      'State check approvals': { 'approved: all blocking threads are resolved': 1, 'held: conflict': 1 },
      'Token service calls': { 'token ok': 1, 'state failed: 429': 1, 'resolve failed: no OIDC token': 1 },
    });
    expect(stats).toMatchObject({ learningsLoaded: [4], suppressionsLoaded: [2], slicesPerRound: [2], changedSinceLastRound: [3], fixClaims: [2] });

    const report = renderStats(stats);
    expect(report).toContain('### Pause causes\n\n| value | count |\n| --- | ---: |\n| repeated | 1 |');
    expect(renderStats(stats, 'o/r')).toMatch(/^# Review statistics for o\/r over 2 merged PRs and 3 rounds\n/);
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
    expect(report).toContain('## Sweeps\n\nNo sweeps.');
    expect(report).toContain('## Finder tool use\n\nNo finder tool steps recorded.');
    // Calls that gave no answer still show what they cost.
    const failed = makeRoundContext(1, { usage: { llmCalls: [{ ...call('gpt-5', 2), stage: 'judge', agent: 'refute_pair', costUsd: 0.05, failed: true }] } });
    const silent = computeStats([prRecords('o/r', 4, { reviews: [review(300, failed)], threadComments: [] })]);
    expect(renderStats(silent)).toContain('- Findings checked: 0, for 0.05 USD\n- Agreed with the first refuter: -');
  });
});
