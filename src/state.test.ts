import * as core from '@actions/core';
import { approveOrSayWhy, fetchBotReviewThreads, fetchHeldWarnings, fixedMarker, checkAndAutoApprove, holdApproval, pauseState, reopenAuthorResolvedThreads, retireStaleNotices, BOT_MARKER, ReviewThread, TRACKED_MARKER, unclearedThreads, warningHoldNote, withdrawBlockedApproval } from './state';
import { clearRecordMarker, dismissRecordMarker, FOUND_AGAIN_MARKER, PreviousFinding, REOPENED_MARKER, securityOverrideMarker } from './recap';
import { LAST_PAGE, makeFindingFingerprintEntry, makeRoundContext, namingCommit, paginateSinglePage, reviewedLine, TEST_BOT, TEST_LINKS, testSha } from './test-utils';
import { APPROVED_LINE, autoApproveHeadMarker, formatFindingComment, postReview, reviewedCommit, titleToSlug } from './github';
import { extractApprovalRecords, formatApprovalRecord, formatReplyRecord, formatReviewRecord, roundReplyMarker } from './review-record';
import { DEFAULT_CONFIG, fallbackConfig } from './config';
import { CheckedReply, statementFold } from './reply-check';
import { determineOutcome } from './review';
import { ApprovalRecord, AuthorClearRole, Finding, FindingFingerprintEntry, ReplyDecision, ReplyModelAnswer, RoundContext, ThreadEvaluation, VerdictTraceEntry } from './types';
import * as authModule from './auth';
import { offerQueuedCheck } from './check-run';
import { RunCancelledError, stopWritesOn } from './abort';

jest.mock('./auth', () => ({
  changeThreadThroughService: jest.fn().mockResolvedValue(false),
  tokenServiceCalls: jest.fn().mockReturnValue([]),
  fetchPrState: jest.fn().mockResolvedValue(null),
  reportPrState: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./github', () => ({
  ...jest.requireActual('./github'),
  dismissPreviousReviews: jest.fn().mockResolvedValue({ dismissed: 0, failed: false, kept: 0 }),
  postAutoApproveProgressComment: jest.fn().mockResolvedValue(12345),
  deleteAutoApproveProgressComment: jest.fn().mockResolvedValue(undefined),
  markProgressCommentFailed: jest.fn().mockResolvedValue(undefined),
}));

const AUTO_REVIEW_OFF = { ...DEFAULT_CONFIG, auto_review: false };
const NOT_REVIEWED_YET = 'Manki has not reviewed `bead000` yet, and approval follows from the verdict of that review. If no review of it starts, as for a PR from a fork or one that matches a skip rule, comment `/manki review`.';
/** The Review again box a message carries below the step it names. */
const AGAIN_BOX = '\n\n<!-- manki-issue-box -->\n- [ ] Review again <!-- manki-box:again -->';
/** The Check approval box a message carries below the step it names. */
const CHECK_BOX = '\n\n<!-- manki-issue-box -->\n- [ ] Check approval <!-- manki-box:check -->';

const SETTING_REFUSAL = 'GitHub Actions is not permitted to approve pull requests.';

/**
 * The record of a round on `commitSha` that requested changes for one blocker it posted as a thread, unless `overrides`
 * say otherwise. The thread `makeGraphqlFetchThreadNode` builds by default is that blocker's.
 */
function blockingRound(commitSha: string, overrides: Partial<RoundContext> = {}, round = 1): RoundContext {
  const entries = [makeFindingFingerprintEntry({ severity: 'blocker', posted: 'thread', title: 'test finding' })];
  const context = makeRoundContext(round, { verdict: 'REQUEST_CHANGES', findings: { count: entries.length, severityCounts: {}, entries }, ...overrides });
  return { ...context, meta: { ...context.meta, commitSha } };
}

/** The record of the round on `commitSha` that posted `threads`: it requested changes for its blocker threads, or approved without one. */
function roundThatPosted(commitSha: string, threads: ReturnType<typeof makeGraphqlFetchThreadNode>[]): RoundContext {
  const entries = threads.flatMap(t => {
    const slug = t.comments.nodes[0].body.match(/<!-- manki:blocker:(.+?) -->/)?.[1];
    const line = t.line ?? 0;
    return slug ? [makeFindingFingerprintEntry({ severity: 'blocker', posted: 'thread', fingerprint: { file: t.path, lineStart: line, lineEnd: line, slug } })] : [];
  });
  return blockingRound(commitSha, { verdict: entries.length > 0 ? 'REQUEST_CHANGES' : 'APPROVE', findings: { count: entries.length, severityCounts: {}, entries } });
}

/** The body of the review that posted `round`. */
const roundBody = (round: RoundContext): string => `<!-- manki -->\n${formatReviewRecord(round)}`;

/** The body of Manki's answer `text` to a thread reply, with the reply record it carries. `decision` is set on an answer that accepts the reply. */
const answerBody = (text: string, decision?: ReplyDecision, modelAnswer?: ReplyModelAnswer): string =>
  `${text}\n\n${BOT_MARKER}\n${formatReplyRecord({ kind: 'thread-reply', prNumber: 1, timestamp: '2026-11-12T10:00:00Z', mankiVersion: '7.5.2', usage: {}, ...(decision && { decision }), ...(modelAnswer && { modelAnswer }) })}`;

const makeThread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'thread-1',
  isResolved: false,
  isBlocking: true,
  findingTitle: 'Test finding',
  ...(overrides.isResolved && !('resolvedByLogin' in overrides) && { resolvedByLogin: 'reviewer', writerResolverLogin: 'reviewer' }),
  ...overrides,
});


/** An octokit that serves review threads from `graphql` and lists `reviews`, whose round records grade the threads. Every login is a person with write access. */
function threadsOctokit(graphql: jest.Mock, reviews: unknown[] = []): Octokit {
  const getCollaboratorPermissionLevel = jest.fn().mockResolvedValue({ data: { permission: 'write', role_name: 'write', user: { type: 'User' } } });
  return { graphql, paginate: jest.fn().mockResolvedValue(reviews), rest: { pulls: { listReviews: jest.fn() }, repos: { getCollaboratorPermissionLevel } } } as unknown as Octokit;
}

describe('unclearedThreads', () => {
  it('returns none for an empty array', () => {
    expect(unclearedThreads([], TEST_BOT)).toEqual([]);
  });

  it('returns none when all threads are resolved', () => {
    const threads = [
      makeThread({ id: '1', isBlocking: true, isResolved: true }),
      makeThread({ id: '2', isBlocking: false, isResolved: true }),
    ];
    expect(unclearedThreads(threads, TEST_BOT)).toEqual([]);
  });

  it('returns the unresolved blocking threads, and the unresolved ones a review names', () => {
    const threads = [
      makeThread({ id: '1', isBlocking: true, isResolved: true }),
      makeThread({ id: '2', isBlocking: true, isResolved: false }),
      makeThread({ id: '3', isBlocking: false, isResolved: false }),
      makeThread({ id: '4', isBlocking: false, isResolved: true }),
    ];
    expect(unclearedThreads(threads, TEST_BOT)).toEqual([threads[1]]);
    expect(unclearedThreads(threads, TEST_BOT, undefined, undefined, new Set(['3', '4']))).toEqual([threads[1], threads[2]]);
  });

  it('ignores unresolved non-blocking threads', () => {
    const threads = [
      makeThread({ id: '1', isBlocking: true, isResolved: true }),
      makeThread({ id: '2', isBlocking: false, isResolved: false }),
      makeThread({ id: '3', isBlocking: false, isResolved: false }),
    ];
    expect(unclearedThreads(threads, TEST_BOT)).toEqual([]);
  });

  it.each([true, false])('counts a resolved blocking thread only once it is settled, security %s', isSecurity => {
    const resolvedBy = (resolvedByLogin: string | undefined, evidence: Partial<ReviewThread> = {}) => [makeThread({ isResolved: true, isSecurity, resolvedByLogin, ...evidence })];
    const confirmed = (login: string) => resolvedBy(login, { writerResolverLogin: login });
    expect(unclearedThreads(resolvedBy('author'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(resolvedBy(undefined), TEST_BOT, 'author')).not.toEqual([]);
    // A resolver counts only once the permission lookup confirmed a person with write access, so a bot's login clears nothing.
    expect(unclearedThreads(resolvedBy('alice'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(resolvedBy('github-actions'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(resolvedBy('github-actions[bot]'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(confirmed('dependabot[bot]'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(confirmed('author'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(confirmed('alice'), TEST_BOT, 'author')).toEqual([]);
    // Manki's own resolve counts only with a round record that says addressed, or its own record that it cleared the thread for a maintainer other than the PR author.
    expect(unclearedThreads(resolvedBy('manki-review[bot]'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(resolvedBy('manki-review[bot]', { addressed: true }), TEST_BOT, 'author')).toEqual([]);
    expect(unclearedThreads(resolvedBy('manki-review[bot]', { writerClearLogin: 'alice' }), TEST_BOT, 'author')).toEqual([]);
    expect(unclearedThreads(resolvedBy('manki-review[bot]', { writerClearLogin: 'author' }), TEST_BOT, 'author')).not.toEqual([]);
    // Neither makes the PR author's own resolve count, also not after a thread was reopened.
    expect(unclearedThreads(resolvedBy('author', { addressed: true, writerClearLogin: 'alice' }), TEST_BOT, 'author')).not.toEqual([]);
    // With the PR author unknown, a confirmed resolver still clears and an unconfirmed one does not.
    expect(unclearedThreads(confirmed('alice'), TEST_BOT)).toEqual([]);
    expect(unclearedThreads(resolvedBy('alice'), TEST_BOT)).not.toEqual([]);
    // A PR author with a confirmed role clears their own.
    expect(unclearedThreads(resolvedBy('author'), TEST_BOT, 'author', 'maintain')).toEqual([]);
    expect(unclearedThreads(resolvedBy('dependabot[bot]'), TEST_BOT, 'author', 'maintain')).not.toEqual([]);
    // A recorded override counts only for an author with a confirmed role, since a Manki reply can echo any text.
    const recorded = [makeThread({ isResolved: true, isSecurity, resolvedByLogin: 'author', recordedOverride: { login: 'author', via: 'dismiss' } })];
    expect(unclearedThreads(recorded, TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(recorded, TEST_BOT, 'author', 'maintain')).toEqual([]);
  });
});

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

function makeGraphqlFetchThreadNode(overrides: {
  id?: string;
  isResolved?: boolean;
  body?: string;
  authorLogin?: string | null;
  databaseId?: number;
  resolvedBy?: string;
  url?: string;
  replies?: Array<{ body: string; author: { login: string; __typename?: string }; createdAt?: string; databaseId?: number }>;
  path?: string;
  /** `null` for a file-level thread. */
  line?: number | null;
  /** The commit the thread was posted on. */
  commit?: string;
} = {}) {
  return {
    id: overrides.id ?? 'thread-1',
    isResolved: overrides.isResolved ?? false,
    ...(overrides.isResolved && { resolvedBy: { login: overrides.resolvedBy ?? 'reviewer' } }),
    path: overrides.path ?? 'src/a.ts',
    line: overrides.line === undefined ? 10 : overrides.line,
    comments: {
      nodes: [{
        ...(overrides.databaseId !== undefined && { databaseId: overrides.databaseId }),
        body: overrides.body ?? '<!-- manki:blocker:test-finding --> **Blocker**: test finding',
        ...(overrides.url && { url: overrides.url }),
        ...(overrides.commit && { originalCommit: { oid: overrides.commit } }),
        author: overrides.authorLogin !== undefined
          ? (overrides.authorLogin === null ? null : { login: overrides.authorLogin })
          : { login: 'manki-review[bot]' },
      }, ...(overrides.replies ?? [])],
    },
  };
}

function makeGraphqlFetchResponse(nodes: ReturnType<typeof makeGraphqlFetchThreadNode>[]) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: { pageInfo: LAST_PAGE, nodes },
      },
    },
  };
}

describe('fetchBotReviewThreads', () => {
  it('returns bot threads with parsed severity and title', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:null-check --> **Blocker**: null check', databaseId: 501, commit: testSha('1') }),
        // A file-level thread keeps the line its finding names.
        makeGraphqlFetchThreadNode({
          id: 't3', line: null, path: 'src/parse.ts',
          body: `<!-- manki:warning:-parse--drops-a-field --> **Warning**\n\n<!-- manki-finding: ${JSON.stringify({ title: '`parse` drops a field', file: 'src/parse.ts', line: 40 })} -->`,
        }),
        makeGraphqlFetchThreadNode({
          id: 't2', body: '<!-- manki:suggestion:rename-var --> **Suggestion**: rename var', isResolved: true,
          // Only Manki's own reply counts as a fix confirmation, not a developer who copies its marker.
          replies: [
            { body: `Fixed in abababa.\n\n${fixedMarker('ab'.repeat(20))}`, author: { login: 'manki-review' } },
            { body: `Done.\n\n${fixedMarker('cd'.repeat(20))}`, author: { login: 'alice' } },
            // Only Manki's own reply carries a review's verdict, with the time it was posted.
            { body: `**Partly fixed.** Still open: one path.\n\n<!-- manki -->\n${roundReplyMarker('ab'.repeat(20))}`, author: { login: 'manki-review' }, createdAt: '2026-11-06T14:34:11Z' },
            { body: `Done.\n\n${roundReplyMarker('cd'.repeat(20))}`, author: { login: 'alice' }, createdAt: '2026-11-06T14:35:00Z' },
            // A marker in a fix that Manki's reply quotes is a finder's text.
            { body: `This came up again.\n\n\`\`\`\n${fixedMarker('ef'.repeat(20))}\n\`\`\`\n\n<!-- manki -->\n<!-- manki-found-again -->`, author: { login: 'manki-review' } },
          ],
        }),
        // A thread at the comment limit may hide an answer.
        makeGraphqlFetchThreadNode({ id: 't4', replies: Array.from({ length: 99 }, () => ({ body: 'Why?', author: { login: 'alice' } })) }),
      ]),
    );

    const octokit = threadsOctokit(graphqlMock);
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(4);
    expect(threads[3].answered).toBe(true);
    expect(threads[0].answered).toBeUndefined();
    // A pointer at a round's verdict is no answer, so an earlier one still stands in the thread. A round's fix confirmation is none either.
    const pointer = `The review of \`abababa\`, which finished after this reply, confirmed this fix.\n\n${BOT_MARKER}`;
    const answeredAfter = async (...bodies: string[]) => (await fetchBotReviewThreads(threadsOctokit(jest.fn().mockResolvedValueOnce(makeGraphqlFetchResponse([
      makeGraphqlFetchThreadNode({ id: 't5', replies: bodies.map(body => ({ body, author: { login: 'manki-review' } })) }),
    ]))), TEST_BOT, 'owner', 'repo', 1))[0].answered;
    expect(await answeredAfter(`Withdrawn. The caller checks it.\n\n${BOT_MARKER}`, pointer)).toBe(true);
    expect(await answeredAfter(`Fixed in abababa.\n\n${BOT_MARKER}`, pointer)).toBeUndefined();
    expect(threads[0]).toEqual({ id: 't1', rootCommentId: 501, isResolved: false, isBlocking: true, mayCarryBlocker: true, findingTitle: 'null check', place: { file: 'src/a.ts', line: 10, markerSlug: 'null-check', commit: testSha('1') } });
    expect(threads[1]).toEqual({ id: 't3', isResolved: false, isBlocking: false, isWarning: true, findingTitle: '`parse` drops a field', place: { file: 'src/parse.ts', line: 0, findingLine: 40, markerSlug: '-parse--drops-a-field' } });
    // Who resolved a suggestion decides nothing, so no permission is looked up for it.
    expect(octokit.rest.repos.getCollaboratorPermissionLevel).not.toHaveBeenCalled();
    expect(threads[2]).toEqual({ id: 't2', isResolved: true, resolvedByLogin: 'reviewer', isBlocking: false, findingTitle: 'rename var', place: { file: 'src/a.ts', line: 10, markerSlug: 'rename-var' }, fixedOn: ['ab'.repeat(20)], roundReplies: [{ commit: 'ab'.repeat(20), at: '2026-11-06T14:34:11Z' }], answered: true });
    // Only a person's reply with an id counts, so a run queued for it can be found.
    const [withReplies] = await fetchBotReviewThreads(threadsOctokit(jest.fn().mockResolvedValueOnce(makeGraphqlFetchResponse([makeGraphqlFetchThreadNode({
      id: 't6', replies: [{ body: 'Done.', author: { login: 'alice' }, databaseId: 61, createdAt: '2026-11-06T14:30:00Z' }, { body: 'Fixed in abababa.', author: { login: 'manki-review' }, databaseId: 62 }, { body: 'No id.', author: { login: 'alice' }, createdAt: '2026-11-06T14:30:00Z' }, { body: 'No time.', author: { login: 'alice' }, databaseId: 63 }],
    })]))), TEST_BOT, 'owner', 'repo', 1);
    expect(withReplies.personReplies).toEqual([{ id: 61, login: 'alice', body: 'Done.', at: '2026-11-06T14:30:00Z' }]);
  });

  it('reads every page of review threads', async () => {
    const nodes = Array.from({ length: 150 }, (_, i) => makeGraphqlFetchThreadNode({ id: `t${i}` }));
    const graphqlMock = jest.fn()
      .mockResolvedValueOnce({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: 'p2' }, nodes: nodes.slice(0, 100) } } } })
      .mockResolvedValueOnce(makeGraphqlFetchResponse(nodes.slice(100)));

    const octokit = threadsOctokit(graphqlMock);
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads.map(t => t.id)).toEqual(nodes.map(n => n.id));
    expect(graphqlMock).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({ cursor: null }));
    expect(graphqlMock).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ cursor: 'p2' }));
  });

  it('treats suggestion and warning threads, security ones included, as not blocking auto-approve, unless a round record raised them, and a partly fixed blocker by what remains', async () => {
    const finding = (severity: Finding['severity'], title: string, tags?: string[]): Finding => ({
      severity, title, file: 'src/a.ts', line: 3, description: 'd', reviewers: [], ...(tags && { tags }),
    });
    // A warning on code an earlier round reviewed, which has a thread like any other warning.
    const late = makeGraphqlFetchThreadNode({ id: 'l', body: formatFindingComment({ ...finding('warning', 'Missed before', ['follow-up']), origin: 'reviewed' }, TEST_LINKS) });
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 's', body: formatFindingComment(finding('note', 'Extract helper'), TEST_LINKS) }),
        makeGraphqlFetchThreadNode({ id: 'w', body: formatFindingComment(finding('warning', 'Deferred warning', ['follow-up']), TEST_LINKS) }),
        makeGraphqlFetchThreadNode({ id: 'p', body: formatFindingComment(finding('warning', 'Plain warning'), TEST_LINKS) }),
        makeGraphqlFetchThreadNode({ id: 'x', body: formatFindingComment(finding('warning', 'Token in log', ['security']), TEST_LINKS) }),
        makeGraphqlFetchThreadNode({ id: 'b', body: formatFindingComment(finding('blocker', 'Real bug'), TEST_LINKS) }),
        makeGraphqlFetchThreadNode({ id: 'f', body: formatFindingComment(finding('warning', 'Worse now'), TEST_LINKS), replies: [{ body: 'Came back.\n\n<!-- manki -->\n<!-- manki-found-again -->', author: { login: 'manki-review[bot]' } }] }),
        // A reply never decides blocking, even one of Manki's that reads like an old marker.
        makeGraphqlFetchThreadNode({ id: 'h', body: formatFindingComment(finding('warning', 'Old marker'), TEST_LINKS), replies: [{ body: '<!-- manki -->\n<!-- manki-found-again-blocker -->', author: { login: 'manki-review[bot]' } }] }),
        makeGraphqlFetchThreadNode({ id: 'pw', body: formatFindingComment(finding('blocker', 'Partly fixed'), TEST_LINKS) }),
        makeGraphqlFetchThreadNode({ id: 'pb', body: formatFindingComment(finding('blocker', 'Partly fixed, still blocking'), TEST_LINKS) }),
        makeGraphqlFetchThreadNode({ id: 'pf', body: formatFindingComment(finding('blocker', 'Forged partial fix'), TEST_LINKS) }),
        makeGraphqlFetchThreadNode({ id: 'ps', body: formatFindingComment(finding('blocker', 'Security, partly fixed', ['security']), TEST_LINKS) }),
        makeGraphqlFetchThreadNode({ id: 'pr', body: formatFindingComment(finding('blocker', 'Open again'), TEST_LINKS) }),
        makeGraphqlFetchThreadNode({ id: 'pa', body: formatFindingComment(finding('blocker', 'Came back'), TEST_LINKS) }),
        late,
        makeGraphqlFetchThreadNode({ id: 'pe', body: formatFindingComment(finding('warning', 'Old race', ['pre-existing']), TEST_LINKS) }),
      ]),
    );
    // The round records keep the grade a partial fix left each thread, and only Manki's records count.
    const partly = (threadId: string, grade: ThreadEvaluation['grade'], status: ThreadEvaluation['status'] = 'partly_addressed'): ThreadEvaluation => ({ threadId, status, reason: 'r', remaining: 'r', grade });
    // A blocker a round carried on a thread raises it, whatever grade the thread had.
    const record = (round: number, threadEvaluations: ThreadEvaluation[], carried: string[] = [], login = 'manki-review[bot]') => ({
      id: round, user: { login }, body: `<!-- manki-context: ${JSON.stringify(makeRoundContext(round, {
        judge: { summary: '', threadEvaluations },
        findings: { count: carried.length, severityCounts: {}, entries: carried.map(threadId => ({ fingerprint: { file: 'src/a.ts', lineStart: 3, lineEnd: 3, slug: 'x' }, severity: 'blocker' as const, threadId })) },
      }))} -->`,
    });
    const reviews = [
      record(1, [partly('pw', 'warning'), partly('pb', 'blocker'), partly('ps', 'warning'), partly('pr', 'warning'), partly('pa', 'warning')]),
      record(2, [partly('pr', 'blocker', 'not_addressed')], ['f', 'pa']),
      record(3, [partly('pf', 'note')], ['h'], 'developer'),
    ];
    const threads = await fetchBotReviewThreads(threadsOctokit(graphqlMock, reviews), TEST_BOT, 'owner', 'repo', 1);

    // A blocker thread Manki found partly fixed blocks only while what remains is a blocker.
    expect(threads.map(t => [t.id, t.isBlocking])).toEqual([['s', false], ['w', false], ['p', false], ['x', false], ['b', true], ['f', true], ['h', false], ['pw', false], ['pb', true], ['pf', true], ['ps', true], ['pr', true], ['pa', true], ['l', false], ['pe', false]]);
    // A blocker thread a partial fix lowered can still be the thread of the round's blocker, and a suggestion or warning
    // thread a round raised to a blocker can too, but no other one.
    expect(threads.filter(t => t.mayCarryBlocker).map(t => t.id)).toEqual(['b', 'f', 'pw', 'pb', 'pf', 'ps', 'pr', 'pa']);
    expect(threads.find(t => t.id === 'x')?.isSecurity).toBe(true);
    // A warning thread holds an approval, also a late find and a blocker a partial fix lowered, but never a pre-existing defect.
    expect(threads.flatMap(t => t.isWarning ? [t.id] : [])).toEqual(['w', 'p', 'x', 'h', 'pw', 'l']);
    expect(unclearedThreads(threads.filter(t => !['b', 'f', 'pb', 'pf', 'ps', 'pr', 'pa'].includes(t.id)), TEST_BOT)).toEqual([]);
    expect(unclearedThreads(threads, TEST_BOT)).not.toEqual([]);

    // A raised thread the PR author resolved still blocks, though no thread is open any more.
    const resolved = threadsOctokit(graphqlMock.mockResolvedValueOnce(makeGraphqlFetchResponse([makeGraphqlFetchThreadNode({ id: 'f', body: formatFindingComment(finding('warning', 'Worse now'), TEST_LINKS), isResolved: true })])), reviews);
    expect((await fetchBotReviewThreads(resolved, TEST_BOT, 'owner', 'repo', 1)).map(t => [t.id, t.isBlocking])).toEqual([['f', true]]);

    // Without the round records a raise could hide, so every thread blocks and auto-approve waits, also for the open
    // thread of a warning an earlier round missed.
    const unread = threadsOctokit(graphqlMock.mockResolvedValueOnce(makeGraphqlFetchResponse([makeGraphqlFetchThreadNode({ id: 's', body: formatFindingComment(finding('note', 'Extract helper'), TEST_LINKS), isResolved: true }), late])));
    jest.mocked(unread.paginate).mockRejectedValueOnce(new Error('rate limited'));
    const unreadThreads = await fetchBotReviewThreads(unread, TEST_BOT, 'owner', 'repo', 1);
    expect(unreadThreads.map(t => [t.id, t.isBlocking, t.mayCarryBlocker])).toEqual([['s', true, true], ['l', true, true]]);
    expect(unclearedThreads(unreadThreads, TEST_BOT).map(t => t.id)).toEqual(['l']);

    // A round not posted yet grades the threads too: here it lowers a blocker to a warning and raises a warning to a blocker.
    // It also backs Manki's resolve of the security warning and of the disproved blocker it found fixed, so neither thread
    // holds anything. A lower grade it records never lowers the thread of a disproved blocker, which still holds.
    const pending = makeRoundContext(4, {
      judge: { summary: '', threadEvaluations: [partly('b', 'warning'), { threadId: 'x', status: 'addressed', reason: 'r' }, { threadId: 'd', status: 'addressed', reason: 'r' }, partly('n', 'note')] },
      findings: { count: 1, severityCounts: {}, entries: [{ fingerprint: { file: 'src/a.ts', lineStart: 3, lineEnd: 3, slug: 'x' }, severity: 'blocker', threadId: 'p' }] },
    });
    const pendingThreads = () => makeGraphqlFetchResponse([
      makeGraphqlFetchThreadNode({ id: 'b', body: formatFindingComment(finding('blocker', 'Real bug'), TEST_LINKS) }),
      makeGraphqlFetchThreadNode({ id: 'p', body: formatFindingComment(finding('warning', 'Plain warning'), TEST_LINKS) }),
      makeGraphqlFetchThreadNode({ id: 'x', body: formatFindingComment(finding('warning', 'Token in log', ['security']), TEST_LINKS), isResolved: true, resolvedBy: 'manki-review[bot]' }),
      makeGraphqlFetchThreadNode({ id: 'd', body: formatFindingComment(finding('warning', 'Lost update', ['disproved-blocker']), TEST_LINKS), isResolved: true, resolvedBy: 'manki-review[bot]' }),
      makeGraphqlFetchThreadNode({ id: 'n', body: formatFindingComment(finding('warning', 'Retry race', ['disproved-blocker']), TEST_LINKS) }),
    ]);
    const graded = await fetchBotReviewThreads(threadsOctokit(graphqlMock.mockResolvedValueOnce(pendingThreads()), reviews), TEST_BOT, 'owner', 'repo', 1, pending);
    expect(graded.map(t => [t.id, t.isBlocking, !!t.isWarning, !!t.addressed])).toEqual([['b', false, true, false], ['p', true, false, false], ['x', false, true, true], ['d', false, true, true], ['n', false, true, false]]);
    const held = await fetchHeldWarnings(threadsOctokit(graphqlMock.mockResolvedValueOnce(pendingThreads()), reviews), TEST_BOT, 'owner', 'repo', 1, 'author', undefined, pending);
    expect(held.map(t => t.id)).toEqual(['b', 'n']);
    // With `blocking`, the open blocking thread holds too.
    const withBlocking = await fetchHeldWarnings(threadsOctokit(graphqlMock.mockResolvedValueOnce(pendingThreads()), reviews), TEST_BOT, 'owner', 'repo', 1, 'author', undefined, pending, true);
    expect(withBlocking.map(t => t.id)).toEqual(['p', 'b', 'n']);
    // Without every round record or without the threads, a warning thread could be missed, so the read fails rather than return none.
    const recordsUnread = threadsOctokit(graphqlMock.mockResolvedValueOnce(pendingThreads()), reviews);
    jest.mocked(recordsUnread.paginate).mockRejectedValueOnce(new Error('rate limited'));
    await expect(fetchHeldWarnings(recordsUnread, TEST_BOT, 'owner', 'repo', 1, 'author', undefined, pending)).rejects.toThrow('Not every round record could be read');
    await expect(fetchHeldWarnings(threadsOctokit(graphqlMock.mockRejectedValueOnce(new Error('bad gateway')), reviews), TEST_BOT, 'owner', 'repo', 1, 'author', undefined)).rejects.toThrow('bad gateway');
    // A resolved thread can hold too, so it fails the read as well. Only a pre-existing one holds nothing whatever its grade.
    const resolvedOne = makeGraphqlFetchThreadNode({ id: 'p', body: formatFindingComment(finding('note', 'Plain note'), TEST_LINKS), isResolved: true });
    const preExisting = makeGraphqlFetchThreadNode({ id: 'pe', body: formatFindingComment(finding('warning', 'Old race', ['pre-existing']), TEST_LINKS) });
    const unreadWith = (nodes: ReturnType<typeof makeGraphqlFetchThreadNode>[]) => {
      const octokit = threadsOctokit(graphqlMock.mockResolvedValueOnce(makeGraphqlFetchResponse(nodes)), reviews);
      jest.mocked(octokit.paginate).mockRejectedValueOnce(new Error('rate limited'));
      return fetchHeldWarnings(octokit, TEST_BOT, 'owner', 'repo', 1, 'author', undefined, pending);
    };
    await expect(unreadWith([resolvedOne, preExisting])).rejects.toThrow('Not every round record could be read');
    expect(await unreadWith([preExisting])).toEqual([]);

    // A round not posted yet that puts a warning into a thread takes back an answer of Manki's that accepted a reply.
    // A resolve by a person with the role stands, since a round puts a finding only into a thread it read as open or as resolved by Manki.
    const cleared = () => makeGraphqlFetchResponse([
      makeGraphqlFetchThreadNode({ id: 'r', body: formatFindingComment(finding('warning', 'Resolved by hand'), TEST_LINKS), isResolved: true, resolvedBy: 'maria' }),
      makeGraphqlFetchThreadNode({ id: 'a', body: formatFindingComment(finding('warning', 'Answered'), TEST_LINKS), replies: [{ body: answerBody('Agreed. Fine.', { outcome: 'Agreed', thread: 'resolves' }), author: { login: 'manki-review[bot]' } }] }),
    ]);
    const raises = (severity: 'warning' | 'note') => makeRoundContext(4, {
      findings: { count: 2, severityCounts: {}, entries: ['r', 'a'].map(threadId => ({ fingerprint: { file: 'src/a.ts', lineStart: 3, lineEnd: 3, slug: 'x' }, severity, threadId })) },
    });
    const heldWith = async (round?: RoundContext) =>
      (await fetchHeldWarnings(threadsOctokit(graphqlMock.mockResolvedValueOnce(cleared()), reviews), TEST_BOT, 'owner', 'repo', 1, 'author', 'write', round)).map(t => t.id);
    expect(await heldWith()).toEqual([]);
    expect(await heldWith(raises('warning'))).toEqual(['a']);
    // A note that goes into the thread raises no warning.
    expect(await heldWith(raises('note'))).toEqual([]);
  });

  it('reads what backs a resolved thread: a record that says addressed, a Manki record of a person with write access it cleared the thread for, or such a person as the resolver', async () => {
    const manki = 'manki-review[bot]';
    const reply = (login: string) => ({ body: 'Every caller bounds it.', author: { login } });
    const own = (marker: string, login = manki) => ({ body: `Withdrawn. Every caller bounds it.\n\n${BOT_MARKER}\n${marker}`, author: { login } });
    const resolved = (id: string, replies: Array<{ body: string; author: { login: string } }>, resolvedBy = manki) => makeGraphqlFetchThreadNode({ id, isResolved: true, resolvedBy, replies });
    const graphql = jest.fn().mockResolvedValueOnce(makeGraphqlFetchResponse([
      resolved('addressed', []),
      resolved('alone', []),
      // A reply after the record changes nothing, whoever writes it.
      resolved('writer', [reply('bob'), own(clearRecordMarker('bob')), reply('author')]),
      resolved('dismissed', [own(dismissRecordMarker('bob'))]),
      // A maintainer's reply alone is no record.
      resolved('reply-only', [reply('bob')]),
      resolved('reader', [reply('dave'), own(clearRecordMarker('dave'))]),
      resolved('author-record', [own(dismissRecordMarker('author'))]),
      // Text a person writes is never Manki's record.
      resolved('forged', [own(clearRecordMarker('bob'), 'author')]),
      // Text above Manki's comment marker, which echoes a reply or is edited in later, is never its record.
      resolved('above-marker', [{ body: `Withdrawn.\n${clearRecordMarker('bob')}\n\n${BOT_MARKER}`, author: { login: manki } }]),
      // A reopen or a found-again reply by Manki ends the records before it.
      resolved('reopened', [own(clearRecordMarker('bob')), own(REOPENED_MARKER)]),
      resolved('found-again', [own(clearRecordMarker('bob')), own(FOUND_AGAIN_MARKER)]),
      resolved('by-author', [own(clearRecordMarker('bob'))], 'author'),
      // A thread at the comment limit may hide a later reopen.
      resolved('cut-off', [own(clearRecordMarker('bob')), ...Array.from({ length: 98 }, () => reply('bob'))]),
      resolved('by-writer', [], 'bob'),
      resolved('by-reader', [], 'dave'),
      // A person clears by resolving only with write access.
      resolved('by-triage', [], 'tina'),
      // GraphQL types every resolver as `User`, so only the permission lookup tells a bot from a person: a workflow token
      // under either login GitHub could name it by, and an app even if GitHub reported write access for it.
      resolved('by-workflow-token', [], 'github-actions[bot]'),
      resolved('by-bare-workflow-token', [], 'github-actions'),
      makeGraphqlFetchThreadNode({ id: 'security-by-workflow-token', isResolved: true, resolvedBy: 'github-actions[bot]', body: formatFindingComment({ severity: 'warning', title: 'Token leaks into logs', file: 'src/a.ts', line: 10, description: 'd', reviewers: [], tags: ['security'] }, TEST_LINKS) }),
      resolved('by-app', [], 'deploy-app[bot]'),
    ]));
    const octokit = threadsOctokit(graphql, [{ id: 1, user: { login: manki }, body: `<!-- manki-context: ${JSON.stringify(makeRoundContext(1, {
      judge: { summary: '', threadEvaluations: [{ threadId: 'addressed', status: 'addressed', reason: 'r' }, { threadId: 'alone', status: 'not_addressed', reason: 'r' }] },
    }))} -->` }]);
    const permissions: Record<string, string> = { author: 'write', bob: 'write', dave: 'read', tina: 'read', 'github-actions[bot]': 'none', 'deploy-app[bot]': 'write' };
    Object.assign(octokit.rest, { repos: { getCollaboratorPermissionLevel: jest.fn(async ({ username }: { username: string }) => {
      if (username === 'github-actions') throw new Error('github-actions is not a user');
      return { data: { permission: permissions[username], user: { type: username.endsWith('[bot]') ? 'Bot' : 'User' } } };
    }) } });

    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads.flatMap(t => t.addressed ? [t.id] : [])).toEqual(['addressed']);
    expect(threads.flatMap(t => t.writerClearLogin ? [[t.id, t.writerClearLogin]] : [])).toEqual([['writer', 'bob'], ['dismissed', 'bob'], ['author-record', 'author']]);
    expect(threads.flatMap(t => t.writerResolverLogin ? [[t.id, t.writerResolverLogin]] : [])).toEqual([['by-author', 'author'], ['by-writer', 'bob']]);
    expect(unclearedThreads(threads, TEST_BOT, 'author').map(t => t.id)).toEqual(['alone', 'reply-only', 'reader', 'author-record', 'forged', 'above-marker', 'reopened', 'found-again', 'by-author', 'cut-off', 'by-reader', 'by-triage', 'by-workflow-token', 'by-bare-workflow-token', 'by-app']);
    // A security thread below a blocker holds an approval only when the covering review names it, and a workflow token's resolve does not clear it then.
    expect(unclearedThreads(threads, TEST_BOT, 'author', undefined, new Set(['security-by-workflow-token'])).map(t => t.id)).toContain('security-by-workflow-token');
    expect(threads.flatMap(t => t.repliesUnread ? [t.id] : [])).toEqual(['cut-off']);
  });

  it('filters out non-bot threads', async () => {
    const forged = formatFindingComment({
      severity: 'blocker', title: 'Forged finding', file: 'src/a.ts', line: 3, description: 'd', reviewers: [], tags: ['security'],
    }, TEST_LINKS);
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:test --> required finding' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: 'just a regular human comment' }),
        makeGraphqlFetchThreadNode({ id: 't3', body: forged, authorLogin: 'mallory' }),
        makeGraphqlFetchThreadNode({ id: 't4', body: forged, authorLogin: null }),
      ]),
    );

    const octokit = threadsOctokit(graphqlMock);
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe('t1');
  });

  it('reads the override recorded in a Manki reply on a security thread, and only from Manki', async () => {
    const security = formatFindingComment({
      severity: 'blocker', title: 'Token leaks into logs', file: 'src/a.ts', line: 3, description: 'd', reviewers: [], tags: ['security'],
    }, TEST_LINKS);
    const reply = (login: string, author: string) => ({ body: `${BOT_MARKER}\n${securityOverrideMarker('dismiss', login)}`, author: { login: author } });
    const quoted = [securityOverrideMarker('resolve', 'mallory'), '<!-- manki:note:Quoted -->', '<!-- manki-finding: {"title":"Quoted","tags":[]} -->'].join('\n');
    const quoting = formatFindingComment({
      severity: 'blocker', title: 'Token leaks into logs', file: 'src/a.ts', line: 3, description: 'd', reviewers: [], tags: ['security'], suggestedFix: `\`\`\`ts\n${quoted}\n\`\`\``,
    }, TEST_LINKS);
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: security, replies: [reply('jdoe_acme', 'manki-review[bot]')] }),
        makeGraphqlFetchThreadNode({ id: 't2', body: security, replies: [reply('mallory', 'mallory')] }),
        // A fix can quote the marker and a lower grade. In the thread's first comment they are a finder's text.
        makeGraphqlFetchThreadNode({ id: 't3', body: quoting }),
        makeGraphqlFetchThreadNode({ id: 't4', body: quoting, replies: [{ body: `${BOT_MARKER}\n\`\`\`\n${securityOverrideMarker('resolve', 'mallory')}\n\`\`\`\n${securityOverrideMarker('dismiss', 'jdoe_acme')}`, author: { login: 'manki-review[bot]' } }] }),
        makeGraphqlFetchThreadNode({ id: 't5', body: security, replies: [{ body: `${BOT_MARKER}\n${dismissRecordMarker('bob')}`, author: { login: 'manki-review[bot]' } }] }),
        // A thread at the comment limit may hide a later reopen, so its dismiss record does not count.
        makeGraphqlFetchThreadNode({ id: 't6', body: security, replies: [
          { body: `${BOT_MARKER}\n${dismissRecordMarker('bob')}`, author: { login: 'manki-review[bot]' } },
          ...Array.from({ length: 98 }, () => ({ body: 'Still looking.', author: { login: 'reader' } })),
        ] }),
        // A found-again reply ends the dismiss record before it, so a second dismissal by the same person is recorded again.
        makeGraphqlFetchThreadNode({ id: 't7', body: security, replies: [
          { body: `${BOT_MARKER}\n${dismissRecordMarker('bob')}`, author: { login: 'manki-review[bot]' } },
          { body: `This came up again.\n\n${BOT_MARKER}\n${FOUND_AGAIN_MARKER}`, author: { login: 'manki-review[bot]' } },
        ] }),
      ]),
    );

    const threads = await fetchBotReviewThreads(threadsOctokit(graphqlMock), TEST_BOT, 'owner', 'repo', 1);

    expect(quoting).toContain(`\`\`\`ts\n${quoted}\n\`\`\``);
    expect(threads.map(t => t.recordedOverride)).toEqual([{ login: 'jdoe_acme', via: 'dismiss' }, undefined, undefined, { login: 'jdoe_acme', via: 'dismiss' }, undefined, undefined, undefined]);
    expect(threads.map(t => [t.isBlocking, t.findingTitle])).toEqual(Array(7).fill([true, 'Token leaks into logs']));
    expect(threads.map(t => t.dismissRecords)).toEqual([undefined, undefined, undefined, undefined, ['bob'], undefined, undefined]);
  });

  it('identifies threads by BOT_MARKER alone', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: `${BOT_MARKER} some comment without severity` }),
      ]),
    );

    const octokit = threadsOctokit(graphqlMock);
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(1);
    expect(threads[0].isBlocking).toBe(true);
    expect(threads[0].findingTitle).toBe('Unknown');
  });

  it('parses blocker as blocking and plain warning, nit and ignore as non-blocking', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:note:style-issue --> nit' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:ignore:false-positive --> ignore' }),
        makeGraphqlFetchThreadNode({ id: 't3', body: '<!-- manki:warning:race --> warning' }),
        makeGraphqlFetchThreadNode({ id: 't4', body: '<!-- manki:blocker:crash --> blocker' }),
      ]),
    );

    const octokit = threadsOctokit(graphqlMock);
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(4);
    expect(threads.map(({ id, isResolved, isBlocking, findingTitle }) => ({ id, isResolved, isBlocking, findingTitle }))).toEqual([
      { id: 't1', isResolved: false, isBlocking: false, findingTitle: 'style issue' },
      { id: 't2', isResolved: false, isBlocking: false, findingTitle: 'false positive' },
      { id: 't3', isResolved: false, isBlocking: false, findingTitle: 'race' },
      { id: 't4', isResolved: false, isBlocking: true, findingTitle: 'crash' },
    ]);
  });

  it('migrates legacy severity markers (`required`, `nit`) on read', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:required:legacy-blocker --> old' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:nit:legacy-nit --> old' }),
      ]),
    );

    const octokit = threadsOctokit(graphqlMock);
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(2);
    expect(threads[0].isBlocking).toBe(true);
    expect(threads[1].isBlocking).toBe(false);
  });

  it('returns empty array when no threads exist', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([]),
    );

    const octokit = threadsOctokit(graphqlMock);
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(0);
  });
});

describe('reopenAuthorResolvedThreads', () => {
  const previous = (threadId: string, reopen: boolean): PreviousFinding => ({
    title: 'Token leaks into logs', file: 'src/a.ts', line: 3, severity: 'blocker', status: 'open', threadId, isSecurity: true, ...(reopen && { reopen }),
  });

  const mutation = (call: unknown[]) => [String(call[0]).match(/unresolveReviewThread|addPullRequestReviewThreadReply/)?.[0], (call[1] as { threadId: string }).threadId];

  const reopen = (graphql: jest.Mock, previousFindings: PreviousFinding[]) =>
    reopenAuthorResolvedThreads({ graphql } as unknown as Octokit, { previousFindings, priorRounds: [] });

  it('reopens, then replies with the markers, for flagged threads only', async () => {
    const graphql = jest.fn().mockResolvedValue({});

    await reopen(graphql, [previous('T_author', true), previous('T_other', false)]);

    expect(graphql.mock.calls.map(mutation)).toEqual([
      ['unresolveReviewThread', 'T_author'],
      ['addPullRequestReviewThreadReply', 'T_author'],
    ]);
    // The reply names the review command for a push that starts no review, so it reads the same in every state.
    expect(graphql.mock.calls[1][1].body).toBe(
      'Reopened. A security finding needs a maintainer or a fix: the PR author cannot resolve it. A reviewer with write access can resolve it, '
      + 'or push a fix and the next Manki review will check it. If the push starts no review, as while automatic review is off or paused, comment `/manki review`.'
      + `\n\n${BOT_MARKER}\n${REOPENED_MARKER}`,
    );

    graphql.mockClear();
    await reopen(graphql, [{ ...previous('T_plain', true), isSecurity: false }]);
    expect(graphql.mock.calls[1][1].body).toMatch(/^Reopened\. A blocking finding needs a maintainer or a fix/);
    // No review clears a thread tied to no file, so its reply names no fix and no review.
    graphql.mockClear();
    await reopen(graphql, [{ ...previous('T_nowhere', true), isSecurity: false, file: '', line: 0 }]);
    expect(graphql.mock.calls[1][1].body).toBe(
      'Reopened. A blocking finding that is not tied to a file needs a maintainer: the PR author cannot resolve it, and no review can confirm a fix for it. '
      + `A reviewer with write access can resolve it.\n\n${BOT_MARKER}\n${REOPENED_MARKER}`,
    );
  });

  // The reply's marker stops every later reopen, so a thread that stayed resolved must not get it.
  it('posts no reply when the reopen fails, and keeps going when the reply fails', async () => {
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const graphql = jest.fn()
      .mockRejectedValueOnce(new Error('reopen refused'))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('reply refused'))
      .mockResolvedValue({});

    await reopen(graphql, [previous('T_1', true), previous('T_2', true), previous('T_3', true)]);

    expect(graphql.mock.calls.map(mutation)).toEqual([
      ['unresolveReviewThread', 'T_1'],
      ['unresolveReviewThread', 'T_2'],
      ['addPullRequestReviewThreadReply', 'T_2'],
      ['unresolveReviewThread', 'T_3'],
      ['addPullRequestReviewThreadReply', 'T_3'],
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reply refused'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reopen refused'));
    warnSpy.mockRestore();
  });
});

describe('checkAndAutoApprove', () => {
  const { dismissPreviousReviews, deleteAutoApproveProgressComment, markProgressCommentFailed } = jest.requireMock('./github') as {
    dismissPreviousReviews: jest.Mock;
    deleteAutoApproveProgressComment: jest.Mock;
    markProgressCommentFailed: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function makeMockOctokit(overrides: {
    threads?: ReturnType<typeof makeGraphqlFetchThreadNode>[];
    prHeadSha?: string;
    createReviewFn?: jest.Mock;
    createCommentFn?: jest.Mock;
    checks?: { create: jest.Mock; update: jest.Mock; listForRef?: jest.Mock };
    existingReviews?: Array<{ id?: number; body?: string; state?: string; commit_id?: string; user?: { login?: string; type?: string } }>;
    existingComments?: Array<{ id?: number; body?: string; user?: { login?: string } }>;
    deleteCommentFn?: jest.Mock;
    updateCommentFn?: jest.Mock;
    /** The PR author's `role_name`. */
    role?: string;
    /** The PR diff at each commit, keyed by its SHA, as `compareCommits` against the base returns it. */
    diffs?: Record<string, string>;
    mergeable?: boolean | null;
    draft?: boolean;
    state?: 'open' | 'closed';
    merged?: boolean;
  } = {}) {
    const prHeadSha = overrides.prHeadSha ?? testSha('abc123');
    // A thread was posted on the head unless it names another commit, and the round on the head posted the threads unless `existingReviews` says otherwise.
    const threads = (overrides.threads ?? []).map(t => ({ ...t, comments: { nodes: t.comments.nodes.map((c, i) => (i === 0 ? { originalCommit: { oid: prHeadSha }, ...c } : c)) } }));
    const createReviewFn = overrides.createReviewFn ?? jest.fn().mockResolvedValue({});
    const createCommentFn = overrides.createCommentFn ?? jest.fn().mockResolvedValue({});
    const existingReviews = overrides.existingReviews ?? [
      { body: roundBody(roundThatPosted(prHeadSha, overrides.threads ?? [])), state: 'CHANGES_REQUESTED', commit_id: prHeadSha, user: { login: 'manki-review[bot]', type: 'Bot' } },
    ];
    const existingComments = overrides.existingComments ?? [];

    return {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse(threads)),
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: prHeadSha }, base: { ref: 'main' }, user: { login: 'author' }, mergeable: overrides.mergeable, draft: overrides.draft, state: overrides.state ?? 'open', merged: overrides.merged ?? false } }),
          createReview: createReviewFn,
          listReviews: jest.fn().mockResolvedValue({ data: namingCommit(existingReviews) }),
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: existingComments }),
          createComment: createCommentFn,
          deleteComment: overrides.deleteCommentFn ?? jest.fn().mockResolvedValue({}),
          updateComment: overrides.updateCommentFn ?? jest.fn().mockResolvedValue({}),
        },
        repos: {
          getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: overrides.role === 'admin' ? 'admin' : 'write', role_name: overrides.role ?? 'write', user: { type: 'User' } } }),
          compareCommits: jest.fn(async ({ head }: { head: string }) => ({ data: overrides.diffs?.[head] ?? '' })),
        },
        checks: overrides.checks ?? { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) },
      },
    } as unknown as Octokit;
  }

  /**
   * Checks the hold `setup` makes a state check find on its head, the same for every hold. The first check posts one
   * notice and one neutral check titled `title`, and its notice answers a person. A repeat posts neither and replies with
   * `line`. A failed comment lookup still reports the hold and throws nothing. Returns the notice.
   */
  async function expectHeldOncePerHead(
    setup: Parameters<typeof makeMockOctokit>[0] & { prHeadSha: string; createCommentFn: jest.Mock; checks: { create: jest.Mock; update: jest.Mock } },
    reason: string, title: string, line: string, marker: string,
  ): Promise<string> {
    const { prHeadSha: head, createCommentFn: createComment, checks } = setup;
    const check = (existing: string[] = [], lookupFails = false) => {
      const octokit = makeMockOctokit({ ...setup, existingComments: existing.map(body => ({ body, user: { login: 'manki-review[bot]' } })) });
      if (lookupFails) jest.mocked(octokit.rest.issues.listComments).mockRejectedValue(new Error('API down'));
      return approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
    };
    const reportsHeld = () => expect(jest.mocked(authModule.reportPrState)).toHaveBeenLastCalledWith('owner', 'repo', 1, { approval: { commit: head, held: true } });
    const repliesWithLine = async (result: Awaited<ReturnType<typeof check>>) => {
      expect(result).toMatchObject({ approved: false, held: reason });
      expect(result).not.toHaveProperty('answered');
      expect(await (result as { why: () => Promise<string> }).why()).toBe(line);
    };

    expect(await check()).toMatchObject({ approved: false, answered: true, held: reason });
    const [posted] = createComment.mock.calls.map(([c]) => c.body as string);
    expect(posted.startsWith(`${line}\n\n<!-- manki-approval-record: `)).toBe(true);
    expect(posted.endsWith(` -->\n\n${marker}`)).toBe(true);
    expect(extractApprovalRecords(posted).map(r => JSON.parse(r) as ApprovalRecord)).toEqual([expect.objectContaining({ decision: 'held', reason, head, threads: { total: 1, resolved: 1 } })]);
    // The check says the approval is held instead of keeping the earlier round's result.
    expect(checks.create.mock.calls).toEqual([[expect.objectContaining({
      name: 'Manki', head_sha: head, status: 'completed', conclusion: 'neutral', output: { title, summary: line },
    })]]);
    reportsHeld();

    await repliesWithLine(await check([posted]));
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(checks.create).toHaveBeenCalledTimes(1);
    reportsHeld();

    jest.spyOn(core, 'warning').mockImplementation(() => {});
    await repliesWithLine(await check([], true));
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(checks.create).toHaveBeenCalledTimes(1);
    reportsHeld();
    return posted;
  }

  it('approves when all threads including suggestions are resolved', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:note:style --> style', isResolved: true }),
      ],
      prHeadSha: testSha('456'),
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'APPROVE', commit_id: testSha('456') }));
    const { body } = createReviewMock.mock.calls[0][0] as { body: string };
    expect(body).toMatch(/^\u2705 \*\*Approved\.\*\* All blocking threads are resolved\.\n\n<!-- manki -->\n<!-- manki-auto-approve -->\n<!-- manki-approval-record: /u);
    // The approval review keeps the decision, its reason and the threads it counted.
    expect(extractApprovalRecords(body).map(r => JSON.parse(r) as ApprovalRecord)).toEqual([{
      decision: 'approved', reason: 'all blocking threads are resolved', head: testSha('456'), threads: { total: 2, resolved: 2 },
      timestamp: expect.any(String), mankiVersion: expect.any(String),
    }]);
  });

  describe('the round that covers the head', () => {
    const HEAD = testSha('bead000');
    const user = { login: 'manki-review[bot]', type: 'Bot' };
    const blocker = (overrides: Parameters<typeof makeFindingFingerprintEntry>[0] = {}): FindingFingerprintEntry =>
      makeFindingFingerprintEntry({ severity: 'blocker', title: 'Lock is never released', file: 'src/lock.ts', ...overrides });
    const prior = (threadId?: string): VerdictTraceEntry =>
      ({ file: 'src/lock.ts', title: 'Lock is never released', fingerprint: 'src/lock.ts:10:10:Lock-is-never-released', ...(threadId && { threadId }) });
    /** A round that requested changes for `entries` of its own and the earlier blockers `priors`. */
    const blocked = (entries: FindingFingerprintEntry[], priors: VerdictTraceEntry[] = [], verdictReason: RoundContext['judge']['verdictReason'] = priors.length > 0 ? 'prior_unaddressed' : 'required_present') =>
      roundBody(blockingRound(HEAD, {
        findings: { count: entries.length, severityCounts: {}, entries },
        judge: { summary: '', verdictReason, verdictTrace: { survivingBlockers: [], unresolvedPriors: priors } },
      }));
    type Place = { title?: string; line?: number | null; commit?: string };
    /** A thread for the blocker `title` in `src/lock.ts`, posted on the head at the blocker's line unless `at` says otherwise. */
    const thread = (id: string, severity: 'blocker' | 'warning' | 'note', resolvedBy?: string, at: Place = {}) => makeGraphqlFetchThreadNode({
      id, body: `<!-- manki:${severity}:${titleToSlug(at.title ?? 'Lock is never released')} --> ${id}`, isResolved: !!resolvedBy, ...(resolvedBy && { resolvedBy }),
      path: 'src/lock.ts', ...(at.line !== undefined && { line: at.line }), ...(at.commit && { commit: at.commit }),
    });
    const fixed = (id = 't1', severity: 'blocker' | 'warning' = 'blocker', at: Place = {}) => thread(id, severity, 'reviewer', at);
    const NO_THREAD = 'names no thread for 1 blocker, so resolving threads cannot lift the block:\n- Lock is never released (`src/lock.ts`)';
    const GONE = 'names a thread that does not exist for 1 blocker, so resolving threads cannot lift the block:\n- Lock is never released (`src/lock.ts`)';
    const NEXT_ROUND = 'The next review round decides. To start one, tick the review box in the settings block, or push a commit. If the push starts no review, as while automatic review is off or paused, comment `/manki review`.';
    const FOLLOWS = 'Approval follows once it is resolved by someone allowed to. The PR author may not clear a blocking thread without the `maintain` role or a higher one.';
    const UNREAD = 'Manki cannot read the record of its review of `bead000`, so it cannot tell what that review blocked on.';
    const UNNAMED = 'The record of Manki\'s review of `bead000` does not say what it blocked on.';
    const warning = (posted: FindingFingerprintEntry['posted'], tags = ['follow-up'], holds = posted !== 'earlier_thread'): FindingFingerprintEntry =>
      ({ ...makeFindingFingerprintEntry({ title: 'Retry never stops', file: 'src/lock.ts', posted }), tags, ...(holds && { holds: true as const }) });
    const held = (entries: FindingFingerprintEntry[]) => roundBody(blockingRound(HEAD, { verdict: 'APPROVE', findings: { count: entries.length, severityCounts: {}, entries } }));
    const NO_WARNING_THREAD = 'Manki\'s review of `bead000` lists 1 warning with no thread, so resolving threads cannot lift its hold on the approval:\n- Retry never stops (`src/lock.ts`)';
    const WARNING_THREAD = '1 warning thread holds the approval:\n- Lock is never released\n\nApproval follows once each one is fixed, tracked with `Create an issue for this`, or resolved by someone with the `maintain` role or a higher one. A reply in a thread lifts its hold only when Manki answers it with Fixed, Withdrawn or Agreed.';
    /** The body of a review whose round approved and held its approval for a person, with `hold` in its record. */
    const heldForPerson = (hold: 'unread' | 'config') => `${roundBody({ ...roundThatPosted(HEAD, []), approval: { held: hold } })}\n\n<!-- manki-held-for-person -->`;
    const HELD_FOR_PERSON = 'Manki\'s review of the head holds its approval for a person and says why, such as files no model read. Resolving threads does not lift that. A person approves, or the next review round decides.';
    const GONE_WARNING = 'The record of Manki\'s review of `bead000` names a thread that does not exist for 1 warning, so resolving threads cannot lift its hold on the approval:\n- Retry never stops (`src/lock.ts`)';

    it.each<[string, string, ReturnType<typeof thread>[], true | string, 'warnings'?]>([
      ['a new blocker on a changed line, its thread resolved', blocked([blocker({ posted: 'thread' })]), [fixed()], true],
      ['a new blocker on a changed line, its thread open', blocked([blocker({ posted: 'thread' })]), [thread('t1', 'blocker')], 'Not all blocking findings resolved'],
      ['a new blocker on a changed line, its thread resolved beside an open suggestion thread on that line', blocked([blocker({ posted: 'thread' })]), [thread('t0', 'note'), fixed()], true],
      ['a new blocker in a changed file outside the hunks, its file-level thread resolved', blocked([blocker({ posted: 'thread', lineStart: 40 })]), [fixed('t1', 'blocker', { line: null })], true],
      ['a new blocker whose thread is not there yet, was refused or was deleted by hand', blocked([blocker({ posted: 'thread' })]), [], GONE],
      ['a new blocker without its thread, beside a resolved thread an earlier round posted at its place', blocked([blocker({ posted: 'thread' })]), [fixed('t1', 'blocker', { commit: testSha('01de') })], GONE],
      ['a new blocker without its thread, beside the resolved thread of another finding at its place', blocked([blocker({ posted: 'thread' })]), [fixed('t1', 'blocker', { title: 'Other' })], GONE],
      ['a new blocker without its thread, beside the resolved thread of the same finding in another place', blocked([blocker({ posted: 'thread' })]), [fixed('t1', 'blocker', { line: 30 })], GONE],
      ['two new blockers with one title at one place and a single thread, resolved', blocked([blocker({ posted: 'thread' }), blocker({ posted: 'thread', lineStart: 12 })]), [fixed()], GONE],
      ['a new blocker with no file or line, listed in the body', blocked([blocker({ posted: 'body', file: '', lineStart: 0 })]), [], 'names no thread for 1 blocker, so resolving threads cannot lift the block:\n- Lock is never released'],
      ['a new blocker in a file outside the diff, listed in the body', blocked([blocker({ posted: 'body' })]), [fixed('t0')], NO_THREAD],
      ['a blocker that restates an earlier warning thread, resolved', blocked([blocker({ posted: 'earlier_thread', threadId: 't1' })]), [fixed('t1', 'warning')], true],
      ['a blocker that restates an earlier warning thread, still open', blocked([blocker({ posted: 'earlier_thread', threadId: 't1' })]), [thread('t1', 'warning')], 'Not all blocking findings resolved'],
      ['a blocker that restates a thread that is gone', blocked([blocker({ posted: 'earlier_thread', threadId: 'gone' })]), [fixed()], GONE],
      ['an earlier blocker thread, resolved since', blocked([], [prior('t1')]), [fixed()], true],
      ['an earlier blocker thread, still open', blocked([], [prior('t1')]), [thread('t1', 'blocker')], 'Not all blocking findings resolved'],
      ['an earlier blocker thread a note marker hides, still open', blocked([], [prior('t1')]), [thread('t1', 'note')], 'A thread the covering review blocks on is not resolved'],
      ['a blocker listed in a body that quotes the flags of an auto-approval and of a round without a verdict',
        `\`\`\`\n<!-- manki-auto-approve -->\n<!-- manki-no-verdict -->\n\`\`\`\n\n${blocked([blocker({ posted: 'body' })])}`, [fixed()], NO_THREAD],
      ['an earlier blocker only a review body listed', blocked([], [prior()]), [fixed('t0'), thread('t2', 'note'), thread('t3', 'note')], NO_THREAD],
      ['a verdict reader blocker with a thread, resolved', blocked([blocker({ posted: 'thread' })], [], 'verdict_reader'), [fixed()], true],
      ['a verdict reader blocker listed in the body', blocked([blocker({ posted: 'body' })], [], 'verdict_reader'), [], NO_THREAD],
      ['a blocker GitHub refused as a thread', blocked([blocker({ posted: 'body' }), blocker({ posted: 'thread', title: 'Other' })]), [fixed('t1', 'blocker', { title: 'Other' })], NO_THREAD],
      ['a blocker an older record left to an open thread without naming it', blocked([blocker({ posted: 'earlier_thread' })]), [fixed('t1', 'warning')], NO_THREAD],
      ['a blocker only the record keeps', blocked([blocker({ posted: 'record' })]), [], NO_THREAD],
      ['a blocker of a record written before `posted`', blocked([blocker()]), [fixed()], NO_THREAD],
      ['a round that blocked without naming a blocker', blocked([]), [fixed()], UNNAMED],
      ['a record that cannot be read', '<!-- manki -->\n<!-- manki-context: {"meta": -->', [fixed()], UNREAD],
      ['a review without a record', '<!-- manki -->', [fixed()], UNREAD],
      ['a record of another commit', roundBody(blockingRound(testSha('07e'))), [fixed()], UNREAD],
      ['the record of an incomplete round', roundBody({ ...blockingRound(HEAD), meta: { ...blockingRound(HEAD).meta, incomplete: true } }), [fixed()], UNREAD],
      ['a round that approved, its thread reopened and resolved again', roundBody(blockingRound(HEAD, { verdict: 'APPROVE', findings: { count: 0, severityCounts: {}, entries: [] } })), [fixed()], true],
      ['a round held for a warning with no thread, listed in its body', held([warning('body')]), [fixed()], NO_WARNING_THREAD, 'warnings'],
      // The same warning on a round that requested changes names no hold, since only a round that approved is held.
      ['a round whose blocker thread is resolved, with a warning GitHub refused as a thread', blocked([blocker({ posted: 'thread' }), warning('body')]), [fixed()], NO_WARNING_THREAD],
      ['a round held for a warning thread, resolved', held([warning('thread')]), [fixed('t1', 'warning', { title: 'Retry never stops' })], true],
      ['a round held for a warning whose thread is not there, was refused or was deleted by hand', held([warning('thread')]), [fixed('t1', 'blocker')], GONE_WARNING, 'warnings'],
      ['a round held for a warning left to an open thread that is gone', held([{ ...warning('earlier_thread', ['follow-up'], true), threadId: 'gone' }]), [], GONE_WARNING, 'warnings'],
      ['a round held for a warning left to an open thread, resolved', held([{ ...warning('earlier_thread', ['follow-up'], true), threadId: 't1' }]), [fixed('t1', 'warning')], true],
      ['a round with a pre-existing warning listed in its body', held([warning('body', ['follow-up', 'pre-existing'], false)]), [fixed()], true],
      ['a round with a warning listed in its body that its record does not mark as holding, as before 7.5', held([warning('body', ['follow-up'], false)]), [fixed()], true],
      ['a round with a warning left to its answered thread', held([warning('earlier_thread')]), [fixed()], true],
    // A rest parameter, since jest takes a named one the row lacks for its `done` callback.
    ])('%s', async (_label, body, threads, outcome, ...[hold]) => {
      const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
      jest.spyOn(core, 'warning').mockImplementation(() => {});
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({});
      const octokit = makeMockOctokit({
        // The resolver has the role that clears a warning thread, so only the record decides here.
        threads, prHeadSha: HEAD, mergeable: true, role: 'maintain', createReviewFn: createReviewMock, createCommentFn: createCommentMock,
        // An earlier round on the head, whose blocker has a thread, never decides for the newest one.
        existingReviews: [{ id: 6, body: roundBody(blockingRound(HEAD)), state: 'COMMENTED', commit_id: HEAD, user }, { id: 7, body, state: 'COMMENTED', commit_id: HEAD, user }],
      });

      const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
      expect(result.approved).toBe(outcome === true);
      expect(createReviewMock.mock.calls.map(([args]) => args.event)).toEqual(outcome === true ? ['APPROVE'] : []);
      // The event path says why in the log and posts nothing on the PR.
      expect(createCommentMock).not.toHaveBeenCalled();
      if (result.approved || outcome === true) return;
      // A hold is named only where the record proves that an approval is held: a blocker, or a record that cannot be read, names none.
      expect(result.held).toBe(hold);
      expect(infoSpy.mock.calls.map(([line]) => line).join('\n')).toContain(outcome);
      // The `check` command gets the threads that block, or why resolving threads cannot lift the block.
      const reply = await result.why();
      if (outcome.includes('resolved')) expect(reply).toMatch(/^1 thread blocks the approval:\n- Lock is never released.*\n\nApproval follows once it is resolved by someone allowed to\./);
      else expect(reply).toBe(`${outcome.startsWith('names') ? 'The record of Manki\'s review of `bead000` ' : ''}${outcome}\n\n${NEXT_ROUND}${AGAIN_BOX}`);
    });

    it('approves a blocker left to an open thread at its place once that thread is resolved', async () => {
      const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
      const title = 'Lock is never released';
      // The blocker sits outside the hunks of its file, where an open blocker thread with its title already is.
      const posted = jest.fn().mockResolvedValue({ data: { id: 7 } });
      const postedComment = jest.fn().mockResolvedValue({ data: { id: 70 } });
      await postReview({ rest: { pulls: { createReview: posted, createReviewComment: postedComment } } } as unknown as Octokit, 'owner', 'repo', 1, HEAD,
        { verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: '', findings: [{ severity: 'blocker', title, file: 'src/lock.ts', line: 40, description: 'd', reviewers: [] }], highlights: [], reviewComplete: true, agentNames: [] },
        { files: [{ path: 'src/lock.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, content: '' }] }], totalAdditions: 1, totalDeletions: 0 },
        blockingRound(HEAD, { findings: { count: 1, severityCounts: {}, entries: [blocker({ lineStart: 40 })] } }), undefined,
        { existingThreads: [{ title, file: 'src/lock.ts', line: 0, severity: 'blocker', status: 'open', threadId: 't1', markerSlug: titleToSlug(title) }] });
      expect(postedComment).not.toHaveBeenCalled();
      const body = posted.mock.calls[0][0].body as string;

      const createReviewMock = jest.fn().mockResolvedValue({});
      const check = async (threads: ReturnType<typeof thread>[]) => {
        const octokit = makeMockOctokit({ threads, prHeadSha: HEAD, mergeable: true, createReviewFn: createReviewMock, existingReviews: [{ id: 7, body, state: 'CHANGES_REQUESTED', commit_id: HEAD, user }] });
        const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
        return result.approved || result.why();
      };
      // The check reply names that thread and no missing one.
      expect(await check([thread('t1', 'blocker')])).toBe(`1 thread blocks the approval:\n- Lock is never released\n\n${FOLLOWS}`);
      expect(infoSpy).toHaveBeenLastCalledWith(expect.stringContaining('Not all blocking findings resolved'));
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(await check([fixed('t1', 'blocker')])).toBe(true);
      expect(createReviewMock.mock.calls.map(([args]) => args.event)).toEqual(['APPROVE']);
    });

    it('never approves while the thread of a blocker the round posts after its review is missing', async () => {
      const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
      jest.spyOn(core, 'warning').mockImplementation(() => {});
      const createReviewMock = jest.fn().mockResolvedValue({});
      const check = (body: string, threads: ReturnType<typeof thread>[] = []) => checkAndAutoApprove(
        makeMockOctokit({ threads, prHeadSha: HEAD, mergeable: true, createReviewFn: createReviewMock, existingReviews: [{ id: 7, body, state: 'CHANGES_REQUESTED', commit_id: HEAD, user }] }),
        TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
      /**
       * Posts a round whose blocker sits outside the hunks of its file. GitHub refuses the review's line comments, so its
       * file-level thread follows the review. `comment` gets the review body.
       */
      const post = async (comment: (submitted: string) => Promise<unknown>, updateReview = jest.fn(), description = 'd') => {
        const createReview = jest.fn()
          .mockRejectedValueOnce(new Error('pull_request_review_thread.line must be part of the diff'))
          .mockResolvedValue({ data: { id: 7 } });
        const createReviewComment = jest.fn(() => comment(createReview.mock.calls[1][0].body as string));
        const failure = await postReview({ rest: { pulls: { createReview, createReviewComment, updateReview } } } as unknown as Octokit, 'owner', 'repo', 1, HEAD,
          { verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: '', findings: [{ severity: 'blocker', title: 'Lock is never released', file: 'src/lock.ts', line: 40, description, reviewers: [] }], highlights: [], reviewComplete: true, agentNames: [] },
          { files: [{ path: 'src/lock.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, content: '' }] }], totalAdditions: 1, totalDeletions: 0 },
          blockingRound(HEAD, { findings: { count: 1, severityCounts: {}, entries: [blocker({ lineStart: 40 })] } }),
        ).then(() => undefined, (error: Error) => error.message);
        return { body: createReview.mock.calls[1][0].body as string, failure, updateReview };
      };
      const refuse = () => Promise.reject(Object.assign(new Error('refused'), { status: 422 }));
      const held = () => expect(infoSpy).toHaveBeenLastCalledWith(`The record of Manki's review of \`bead000\` ${GONE}\nSkipping auto-approve, the next review round decides`);

      // GitHub refuses the thread, and the review has no room for the blocker, so its record still says `thread`.
      const full = await post(refuse, jest.fn(), 'word '.repeat(13000));
      expect(full.failure).toContain('or fit them in review #7');
      expect(full.updateReview).not.toHaveBeenCalled();
      expect(await check(full.body)).toBe(false);
      held();

      // GitHub refuses the thread, and the review cannot be updated either.
      const stuck = await post(refuse, jest.fn().mockRejectedValue(new Error('update down')));
      expect(stuck.failure).toContain('or in review #7');
      expect(await check(stuck.body)).toBe(false);
      held();

      // The submitted review starts the check before its thread is posted.
      let early: boolean | undefined;
      const raced = await post(async submitted => {
        early = await check(submitted);
        held();
        return { data: { id: 70 } };
      });
      expect([raced.failure, early]).toEqual([undefined, false]);

      // The thread is there afterwards and blocks until it is resolved. A thread deleted by hand leaves the block in place.
      const posted = (resolvedBy?: string) => thread('t1', 'blocker', resolvedBy, { line: null });
      expect(await check(raced.body, [posted()])).toBe(false);
      expect(infoSpy).toHaveBeenLastCalledWith(expect.stringContaining('Not all blocking findings resolved'));
      expect(await check(raced.body, [])).toBe(false);
      held();
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(await check(raced.body, [posted('reviewer')])).toBe(true);
      expect(createReviewMock.mock.calls.map(([args]) => args.event)).toEqual(['APPROVE']);
    });

    it('reads a standing approval posted again on a new head as blocking on nothing, and no other review without a record', async () => {
      const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
      const change = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n';
      const approving = roundBody(blockingRound(testSha('1'), { verdict: 'APPROVE', findings: { count: 0, severityCounts: {}, entries: [] } }));
      const restated = `${APPROVED_LINE} No change to this PR since the reviewed commit \`1000000\`. The previous verdict stands.\n\n<!-- manki-bot -->\n${autoApproveHeadMarker(testSha('2'))}`;
      // Round 1 approved `1000000`, a push without a change got the approval again on `2000000`, and another one made `3000000` the head.
      const check = async (second: { body: string; state: string }, threads = [fixed()]) => {
        const createReviewMock = jest.fn().mockResolvedValue({});
        const octokit = makeMockOctokit({
          threads, prHeadSha: testSha('3'), mergeable: true, createReviewFn: createReviewMock, diffs: { [testSha('2')]: change, [testSha('3')]: change },
          existingReviews: [{ id: 1, body: approving, state: 'DISMISSED', commit_id: testSha('1'), user }, { id: 2, ...second, commit_id: testSha('2'), user }],
        });
        Object.assign(octokit.rest.issues, { listEventsForTimeline: jest.fn().mockResolvedValue({ data: [{ dismissed_review: { review_id: 2, state: 'approved', dismissal_commit_id: testSha('3') } }] }) });
        return [await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG), createReviewMock.mock.calls.map(([args]) => [args.event, args.commit_id])];
      };
      const unread = 'Manki cannot read the record of its review of `2000000`, so it cannot tell what that review blocked on.';

      // The second push dismissed the approval, so the check approves the head again.
      expect(await check({ body: restated, state: 'DISMISSED' })).toEqual([true, [['APPROVE', testSha('3')]]]);
      // The approval was held at the second push and still stands, so nothing more is posted.
      expect(await check({ body: restated, state: 'APPROVED' })).toEqual([true, []]);
      // A thread that blocks still does.
      expect(await check({ body: restated, state: 'DISMISSED' }, [thread('t1', 'blocker')])).toEqual([false, []]);
      // A review without a record that is no such approval says nothing about blockers, whatever its state.
      for (const second of [{ body: restated, state: 'CHANGES_REQUESTED' }, { body: '<!-- manki -->\n<!-- manki-bot -->', state: 'DISMISSED' }]) {
        expect(await check(second)).toEqual([false, []]);
        expect(infoSpy).toHaveBeenLastCalledWith(`${unread}\nSkipping auto-approve, the next review round decides`);
      }
    });

    it('approves a blocker in a file outside the diff only once a person resolves the thread a later round gives it', async () => {
      const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
      const createReviewMock = jest.fn().mockResolvedValue({});
      const outside = blocker({ posted: 'body', file: 'src/store.ts', title: 'Persisters miss the lock' });
      const first = blockingRound(testSha('1'), { findings: { count: 1, severityCounts: {}, entries: [outside] } });
      const firstReview = { id: 1, body: roundBody(first), state: 'CHANGES_REQUESTED', commit_id: testSha('1'), user };
      const check = (head: string, existingReviews: typeof firstReview[], threads: ReturnType<typeof thread>[]) => checkAndAutoApprove(
        makeMockOctokit({ threads, prHeadSha: head, mergeable: true, createReviewFn: createReviewMock, existingReviews }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);

      // Round 1 lists the blocker in its body, and its own review starts the check.
      expect(await check(testSha('1'), [firstReview], [thread('t2', 'note')])).toBe(false);

      // Round 2 cannot read the threads, so it carries the blocker without a finding that restates it.
      const decided = determineOutcome([], first.findings.entries, null);
      expect(decided).toMatchObject({ outcome: 'ADDRESS_FIRST', verdictReason: 'prior_unaddressed' });
      expect(decided.verdictTrace.unresolvedPriors).toEqual([expect.not.objectContaining({ threadId: expect.anything() })]);
      const second = blockingRound(testSha('2'), { findings: { count: 0, severityCounts: {}, entries: [] }, judge: { summary: '', ...decided } }, 2);
      const reviews = [{ ...firstReview, state: 'DISMISSED' }, { id: 2, body: roundBody(second), state: 'CHANGES_REQUESTED', commit_id: testSha('2'), user }];
      const threads = [fixed('t1'), thread('t2', 'note'), thread('t3', 'note')];
      expect(await check(testSha('2'), reviews, threads)).toBe(false);

      expect(createReviewMock).not.toHaveBeenCalled();
      const told = 'The record of Manki\'s review of `2000000` names no thread for 1 blocker, so resolving threads cannot lift the block:\n- Persisters miss the lock (`src/store.ts`)';
      expect(infoSpy).toHaveBeenLastCalledWith(`${told}\nSkipping auto-approve, the next review round decides`);
      // The `check` command gets the same reason, and an approval once a thread of that round carries the blocker.
      const asked = async (existingReviews: typeof reviews, live = threads) => {
        const result = await approveOrSayWhy(makeMockOctokit({ threads: live, prHeadSha: testSha('2'), mergeable: true, createReviewFn: createReviewMock, existingReviews }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
        return result.approved || result.why();
      };
      expect(await asked(reviews)).toBe(`${told}\n\n${NEXT_ROUND}${AGAIN_BOX}`);
      const withThread = [{ ...reviews[1], body: roundBody(blockingRound(testSha('2'))) }];
      const own = (commit: string) => [makeGraphqlFetchThreadNode({ isResolved: true, commit })];
      // The same thread on an earlier commit is not that round's.
      expect(await asked(withThread, own(testSha('1')))).toBe(`The record of Manki's review of \`2000000\` names a thread that does not exist for 1 blocker, so resolving threads cannot lift the block:\n- test finding (\`src/a.ts\`)\n\n${NEXT_ROUND}${AGAIN_BOX}`);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(await asked(withThread, own(testSha('2')))).toBe(true);

      // Round 3 lists the blocker again, and the review posts it as a thread on the first changed file.
      createReviewMock.mockClear();
      const relisted: Finding = { severity: 'blocker', title: 'Persisters miss the lock', file: 'src/store.ts', line: 10, description: 'Two writers interleave.', reviewers: [], sameAs: 'src/store.ts:10:10:Persisters-miss-the-lock', raisedIn: 1, relisted: true };
      const third = blockingRound(testSha('3'), { findings: { count: 1, severityCounts: {}, entries: [blocker({ file: 'src/store.ts', title: relisted.title })] } }, 3);
      const postedReview = jest.fn().mockResolvedValue({ data: { id: 3 } });
      const postedComment = jest.fn().mockResolvedValue({ data: { id: 30 } });
      await postReview({ rest: { pulls: { createReview: postedReview, createReviewComment: postedComment } } } as unknown as Octokit, 'owner', 'repo', 1, testSha('3'),
        { verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: '', findings: [relisted], highlights: [], reviewComplete: true, agentNames: [] },
        { files: [{ path: 'src/api.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, content: '+x' }] }], totalAdditions: 1, totalDeletions: 0 }, third);
      expect(postedComment).not.toHaveBeenCalled();
      const [threadComment] = postedReview.mock.calls[0][0].comments as Array<{ path: string; line: number; body: string }>;
      expect([threadComment.path, threadComment.line]).toEqual(['src/api.ts', 1]);
      expect(postedReview.mock.calls[0][0].body).toMatch(/\*\*Changes requested:\*\* 1 blocker still open from an earlier review\./);
      const withThird = [...reviews.map(r => ({ ...r, state: 'DISMISSED' })), { id: 3, body: postedReview.mock.calls[0][0].body as string, state: 'CHANGES_REQUESTED', commit_id: testSha('3'), user }];
      const carrying = (resolvedBy?: string) => makeGraphqlFetchThreadNode({ id: 't4', path: 'src/api.ts', line: 1, body: threadComment.body, isResolved: !!resolvedBy, ...(resolvedBy && { resolvedBy }) });

      expect(await check(testSha('3'), withThird, [...threads, carrying()])).toBe(false);
      expect(infoSpy).toHaveBeenLastCalledWith(expect.stringContaining('Not all blocking findings resolved'));
      expect(createReviewMock).not.toHaveBeenCalled();
      // Manki's own resolve lifts nothing without a record that confirms the fix. A person who resolves the thread does.
      expect(await check(testSha('3'), withThird, [...threads, carrying('manki-review[bot]')])).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(await check(testSha('3'), withThird, [...threads, carrying('maintainer')])).toBe(true);
      expect(createReviewMock).toHaveBeenCalledTimes(1);
    });

    it.each<[string, Parameters<typeof makeMockOctokit>[0], string | { approved: true; standing: true }, { auto_approve: boolean }?, ('draft' | 'warnings' | 'conflict' | 'unread' | 'config')?]>([
      ['a draft', { draft: true }, '**Approval held:** this PR is a draft. Mark it ready for review, and Manki approves it if nothing else holds the approval. If the latest commit has no review yet, Manki reviews it first when automatic review runs on this PR. If nothing happens, as for a PR from a fork or while automatic review is off or paused, comment `/manki check`, and Manki approves or says what holds the approval.' + CHECK_BOX, undefined, 'draft'],
      ['a draft with `auto_approve` off, where marking it ready approves nothing', { draft: true }, '**Approval held:** this PR is a draft. Mark it ready for review, then tick the review box in the settings block. `auto_approve` is off, so Manki approves only at the end of a review round, when nothing holds the approval.' + AGAIN_BOX, { auto_approve: false }, 'draft'],
      // The title comes from the model, so its links must not reach the comment.
      ['an open blocking thread', { threads: [makeGraphqlFetchThreadNode({ url: 'https://github.com/o/r/pull/1#r1', body: `<!-- manki:blocker:x --> **Blocker**\n\n<!-- manki-finding: ${JSON.stringify({ title: 'Null deref in [`parse`](https://example.com)' })} -->` })] },
        `1 thread blocks the approval:\n- [Null deref in \`parse\`](https://github.com/o/r/pull/1#r1)\n\n${FOLLOWS}`],
      ['a blocking thread the PR author resolved', { threads: [makeGraphqlFetchThreadNode({ isResolved: true, resolvedBy: 'author' })] },
        `1 thread blocks the approval:\n- test finding (resolved by \`author\`, who may not clear it)\n\n${FOLLOWS}`],
      ['a blocking thread Manki resolved with no addressed record and no record of a maintainer', { threads: [makeGraphqlFetchThreadNode({ isResolved: true, resolvedBy: 'manki-review[bot]' })] },
        `1 thread blocks the approval:\n- test finding (Manki resolved it, but no review record confirms a fix, and no record of Manki names a maintainer other than the PR author who cleared it)\n\n${FOLLOWS}`],
      ['a blocking thread Manki resolved that is at the comment limit', { threads: [makeGraphqlFetchThreadNode({ isResolved: true, resolvedBy: 'manki-review[bot]', replies: Array.from({ length: 99 }, () => ({ body: 'Every caller bounds it.', author: { login: 'bob' } })) })] },
        `1 thread blocks the approval:\n- test finding (Manki resolved it, but no review record confirms a fix, and the thread has too many comments for Manki to read its record, so someone other than the PR author with write access has to reopen it and resolve it)\n\n${FOLLOWS}`],
      ['an open thread the review blocks on though its marker says note',
        { threads: [thread('t1', 'note')], existingReviews: [{ id: 7, body: blocked([], [prior('t1')]), state: 'CHANGES_REQUESTED', commit_id: HEAD, user }] },
        `1 thread blocks the approval:\n- Lock is never released (Manki's latest review blocks on this thread)\n\n${FOLLOWS}`],
      ['open blocking threads beside a blocker no thread carries', {
        threads: [thread('t1', 'blocker'), thread('t2', 'blocker', 'author', { title: 'Second' })],
        existingReviews: [{ id: 7, body: blocked([blocker({ posted: 'thread' }), blocker({ posted: 'thread', title: 'Second' }), blocker({ posted: 'body', title: 'Other', file: 'src/b.ts' })]), state: 'CHANGES_REQUESTED', commit_id: HEAD, user }],
      }, `2 threads block the approval:\n- Lock is never released\n- Second (resolved by \`author\`, who may not clear it)\n\nThe record of Manki's review of \`bead000\` names no thread for 1 blocker, so resolving threads cannot lift the block:\n- Other (\`src/b.ts\`)\n\n${NEXT_ROUND}${AGAIN_BOX}`],
      ['an open blocking thread on a head no review covers',
        { threads: [thread('t1', 'blocker', undefined, { commit: testSha('01d') })], existingReviews: [{ id: 7, body: roundBody(blockingRound(testSha('01d'))), state: 'CHANGES_REQUESTED', commit_id: testSha('01d'), user }] },
        `1 thread blocks the approval:\n- Lock is never released\n\n${NOT_REVIEWED_YET}${AGAIN_BOX}`],
      ['a head no review covers', { existingReviews: [{ id: 7, body: roundBody(blockingRound(testSha('01d'))), state: 'CHANGES_REQUESTED', commit_id: testSha('01d'), user }] },
        NOT_REVIEWED_YET + AGAIN_BOX],
      // The box sits under the sentence that names the review, and a hold line that names the same step adds no second one.
      ['a draft head no review covers, with `auto_approve` off', { draft: true, existingReviews: [{ id: 7, body: roundBody(blockingRound(testSha('01d'))), state: 'CHANGES_REQUESTED', commit_id: testSha('01d'), user }] },
        `${NOT_REVIEWED_YET}${AGAIN_BOX}\n\n**Approval held:** this PR is a draft. Mark it ready for review, then tick the review box in the settings block. \`auto_approve\` is off, so Manki approves only at the end of a review round, when nothing holds the approval.`, { auto_approve: false }, 'draft'],
      ['an approval that already stands', { existingReviews: [{ id: 7, body: roundBody(roundThatPosted(HEAD, [])), state: 'APPROVED', commit_id: HEAD, user }] }, { approved: true, standing: true }],
      // An open blocking or warning thread declines beside an approval that stands.
      ['an open blocking thread beside an approval that stands', { threads: [thread('t1', 'blocker')], existingReviews: [{ id: 7, body: roundBody(roundThatPosted(HEAD, [])), state: 'APPROVED', commit_id: HEAD, user }] },
        `1 thread blocks the approval:\n- Lock is never released\n\n${FOLLOWS}`],
      ['an open warning thread beside an approval that stands', { threads: [thread('t1', 'warning')], existingReviews: [{ id: 7, body: roundBody(roundThatPosted(HEAD, [])), state: 'APPROVED', commit_id: HEAD, user }] },
        '1 warning thread holds the approval:\n- Lock is never released\n\nApproval follows once each one is fixed, tracked with `Create an issue for this`, or resolved by someone with the `maintain` role or a higher one. A reply in a thread lifts its hold only when Manki answers it with Fixed, Withdrawn or Agreed.', undefined, 'warnings'],
      // Without the hold in its record, a review held for a person names none.
      ['a review that holds its approval for a person, with a record that does not say why', { existingReviews: [{ id: 7, body: `${roundBody(roundThatPosted(HEAD, []))}\n\n<!-- manki-held-for-person -->`, state: 'COMMENTED', commit_id: HEAD, user }] },
        'Manki\'s review of the head holds its approval for a person and says why, such as files no model read. Resolving threads does not lift that. A person approves, or the next review round decides.'],
      ['a review that holds its approval for files no model read', { existingReviews: [{ id: 7, body: heldForPerson('unread'), state: 'COMMENTED', commit_id: HEAD, user }] }, HELD_FOR_PERSON, undefined, 'unread'],
      ['a review that holds its approval for a config that did not load', { existingReviews: [{ id: 7, body: heldForPerson('config'), state: 'COMMENTED', commit_id: HEAD, user }] }, HELD_FOR_PERSON, undefined, 'config'],
      // A review held for a person that requested changes is no held approval, also once its blocker thread is resolved.
      ['a review that requested changes and waits for a person, its blocker thread resolved',
        { threads: [fixed()], existingReviews: [{ id: 7, body: `${blocked([blocker({ posted: 'thread' })])}\n\n<!-- manki-held-for-person -->`, state: 'CHANGES_REQUESTED', commit_id: HEAD, user }] }, HELD_FOR_PERSON],
      ['a conflict with the base', { mergeable: false }, '**Approval held:** this PR conflicts with `main`. Rebase it, and Manki reviews the result. If the push starts no review, as while automatic review is off or paused, comment `/manki review`.', undefined, 'conflict'],
      // Every reason that holds is named at once, blocking threads first, then warning threads with a draft or a conflict, then the other holds.
      ['an open warning thread beside a review that holds its approval for a person', {
        threads: [thread('t1', 'warning')], existingReviews: [{ id: 7, body: `${roundBody(roundThatPosted(HEAD, []))}\n\n<!-- manki-held-for-person -->`, state: 'COMMENTED', commit_id: HEAD, user }],
      }, `${WARNING_THREAD}\n\n${HELD_FOR_PERSON}`, undefined, 'warnings'],
      ['an open warning thread beside a warning the review lists with no thread', { threads: [thread('t1', 'warning')], existingReviews: [{ id: 7, body: held([warning('body')]), state: 'COMMENTED', commit_id: HEAD, user }] },
        `${NO_WARNING_THREAD}\n\n${NEXT_ROUND}${AGAIN_BOX}\n\n${WARNING_THREAD}`, undefined, 'warnings'],
      ['an open warning thread on a head no review covers',
        { threads: [thread('t1', 'warning', undefined, { commit: testSha('01d') })], existingReviews: [{ id: 7, body: roundBody(blockingRound(testSha('01d'))), state: 'CHANGES_REQUESTED', commit_id: testSha('01d'), user }] },
        `${NOT_REVIEWED_YET}${AGAIN_BOX}\n\n${WARNING_THREAD}`],
      // The open blocking thread blocks the draft too, so the check names no hold, which a waiting check would report as neutral.
      ['an open blocking thread and an open warning thread on a draft that conflicts', { threads: [thread('t1', 'blocker'), thread('t2', 'warning', undefined, { title: 'Retry never stops' })], draft: true, mergeable: false },
        `1 thread blocks the approval:\n- Lock is never released\n\n${FOLLOWS}\n\n${WARNING_THREAD.replace('Lock is never released', 'Retry never stops')}\n\nThe PR is also a draft, so mark it ready for review too. If no approval follows, comment \`/manki check\`.`],
      // Warnings are named before the draft, as in the review and the title of the check.
      ['an open warning thread on a draft that a review holds for a person', {
        threads: [thread('t1', 'warning')], draft: true, existingReviews: [{ id: 7, body: heldForPerson('config'), state: 'COMMENTED', commit_id: HEAD, user }],
      }, `${WARNING_THREAD}\n\nThe PR is also a draft, so mark it ready for review too. If no approval follows, comment \`/manki check\`.\n\n${HELD_FOR_PERSON}`, undefined, 'warnings'],
      ['an open warning thread on a PR that conflicts', { threads: [thread('t1', 'warning')], mergeable: false },
        `${WARNING_THREAD}\n\nThe PR also conflicts with \`main\`, so rebase it.`, undefined, 'warnings'],
    // A rest parameter, since jest takes a named one the row lacks for its `done` callback.
    ])('tells a person who asks why there is no approval: %s', async (_label, setup, reply, ...[config, hold]) => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      jest.spyOn(core, 'warning').mockImplementation(() => {});
      const createReviewMock = jest.fn().mockResolvedValue({});
      const result = await approveOrSayWhy(makeMockOctokit({ prHeadSha: HEAD, mergeable: true, createReviewFn: createReviewMock, ...setup }), TEST_BOT, 'owner', 'repo', 1, { ...DEFAULT_CONFIG, ...config });
      expect(result.approved ? result : await result.why()).toEqual(reply);
      // Only the hold the check stopped at is named, so a block by a thread or by the review names none.
      expect(result.approved ? undefined : result.held).toBe(hold);
      expect(createReviewMock).not.toHaveBeenCalled();
    });

    it('withdraws a round approval or an auto-approval once a blocking thread is open again and fails the check, and never for a warning thread', async () => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      const autoApproval = `${APPROVED_LINE} All blocking threads are resolved.\n\n<!-- manki -->\n<!-- manki-auto-approve -->\n${formatApprovalRecord({
        decision: 'approved', reason: 'all blocking threads are resolved', head: HEAD, threads: { total: 1, resolved: 1 }, timestamp: '2026-11-23T00:00:00Z', mankiVersion: '7.7.3',
      })}`;
      const approvals = [roundBody(roundThatPosted(HEAD, [])), autoApproval];
      for (const body of approvals) {
        let checkRuns: { create: jest.Mock; update: jest.Mock; listForRef?: jest.Mock } = { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) };
        const setup = (threads: ReturnType<typeof thread>[]): Octokit => makeMockOctokit({ threads, prHeadSha: HEAD, mergeable: true, checks: checkRuns, existingReviews: [{ id: 7, body, state: 'APPROVED', commit_id: HEAD, user }] });
        // The check that runs after a reopen, with `auto_approve` on, and the one that runs with it off.
        const checks = [
          async (threads: ReturnType<typeof thread>[]) => { await approveOrSayWhy(setup(threads), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG); },
          (threads: ReturnType<typeof thread>[]) => withdrawBlockedApproval(setup(threads), TEST_BOT, 'owner', 'repo', 1, 'author', undefined),
        ];
        for (const check of checks) {
          dismissPreviousReviews.mockClear();
          jest.mocked(authModule.reportPrState).mockClear();
          checkRuns = { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) };
          dismissPreviousReviews.mockResolvedValueOnce({ dismissed: 1, failed: false, kept: 0 });
          await check([thread('t1', 'blocker')]);
          expect(dismissPreviousReviews.mock.calls).toEqual([[expect.anything(), TEST_BOT, 'owner', 'repo', 1, undefined, 'APPROVED']]);
          // The coordinator no longer records the approval.
          expect(jest.mocked(authModule.reportPrState).mock.calls).toEqual([['owner', 'repo', 1, { approval: null }]]);
          // The check on the head fails as a round with an open blocker does, so a required check no longer passes.
          expect(checkRuns.create.mock.calls).toEqual([[expect.objectContaining({
            name: 'Manki', head_sha: HEAD, status: 'completed', conclusion: 'failure', output: expect.objectContaining({ title: 'Changes requested', summary: expect.stringMatching(/^A blocking thread is not cleared, so Manki withdrew its approval\. The next review round decides\./) }),
          })]]);
          // A dismissal GitHub refused, as under a ruleset, leaves that approval and the coordinator's record of it. The check
          // still fails, also when no dismissal worked.
          checkRuns = { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) };
          jest.mocked(authModule.reportPrState).mockClear();
          dismissPreviousReviews.mockResolvedValueOnce({ dismissed: 1, failed: true, kept: 0 });
          await check([thread('t1', 'blocker')]);
          expect(checkRuns.create.mock.calls).toEqual([[expect.objectContaining({
            conclusion: 'failure', output: expect.objectContaining({ summary: expect.stringMatching(/^A blocking thread is not cleared, but Manki could not dismiss every approval it gave, so this check fails instead\./) }),
          })]]);
          expect(authModule.reportPrState).not.toHaveBeenCalled();
          checkRuns = { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) };
          dismissPreviousReviews.mockResolvedValueOnce({ dismissed: 0, failed: true, kept: 0 });
          await check([thread('t1', 'blocker')]);
          expect(checkRuns.create.mock.calls).toEqual([[expect.objectContaining({ conclusion: 'failure' })]]);
          expect(authModule.reportPrState).not.toHaveBeenCalled();
          // A blocking thread someone allowed to clear it resolved, and an open warning thread, leave the approval to stand.
          dismissPreviousReviews.mockClear();
          await check([fixed('t1'), thread('t2', 'warning', undefined, { title: 'Retry never stops' })]);
          expect(dismissPreviousReviews).not.toHaveBeenCalled();
        }
        // Without the round records every thread counts as blocking, which proves no blocker, so an open warning thread
        // withdraws nothing, and neither does a thread of a pre-existing defect, which can hold no approval.
        jest.spyOn(core, 'warning').mockImplementation(() => {});
        const preExisting = makeGraphqlFetchThreadNode({ id: 'pe', body: formatFindingComment({ severity: 'blocker', title: 'Old race', file: 'src/a.ts', line: 3, description: 'd', reviewers: [], tags: ['pre-existing'] }, TEST_LINKS) });
        for (const threads of [[thread('t2', 'warning', undefined, { title: 'Retry never stops' })], [preExisting]]) {
          const unread = setup(threads);
          jest.mocked(unread.paginate).mockRejectedValueOnce(new Error('rate limited'));
          await withdrawBlockedApproval(unread, TEST_BOT, 'owner', 'repo', 1, 'author', undefined);
          expect(dismissPreviousReviews).not.toHaveBeenCalled();
        }
        // A head that cannot be read still leaves the approval withdrawn and the coordinator told, and only the check is
        // skipped after a second try.
        checkRuns = { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) };
        jest.mocked(authModule.reportPrState).mockClear();
        const headless = setup([thread('t1', 'blocker')]);
        jest.mocked(headless.rest.pulls.get).mockRejectedValue(new Error('Not Found'));
        dismissPreviousReviews.mockResolvedValueOnce({ dismissed: 1, failed: false, kept: 0 });
        await withdrawBlockedApproval(headless, TEST_BOT, 'owner', 'repo', 1, 'author', undefined);
        expect(jest.mocked(authModule.reportPrState).mock.calls).toEqual([['owner', 'repo', 1, { approval: null }]]);
        expect(headless.rest.pulls.get).toHaveBeenCalledTimes(2);
        expect(checkRuns.create).not.toHaveBeenCalled();
        expect(core.warning).toHaveBeenCalledWith('A blocking thread is not cleared, but Manki could not read the head to fail its check: Not Found');
        expect(core.warning).toHaveBeenLastCalledWith('A blocking thread is not cleared, but Manki could not fail its check, so a required check may pass until the next review round');
        // A check write that fails once is tried again, so the check still fails.
        checkRuns = { create: jest.fn().mockRejectedValueOnce(new Error('Bad Gateway')).mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) };
        dismissPreviousReviews.mockResolvedValueOnce({ dismissed: 1, failed: false, kept: 0 });
        await withdrawBlockedApproval(setup([thread('t1', 'blocker')]), TEST_BOT, 'owner', 'repo', 1, 'author', undefined);
        expect(checkRuns.create.mock.calls.map(([c]) => c.conclusion)).toEqual(['failure', 'failure']);
        // With no approval left to dismiss, as after a person dismissed it by hand, a check that still passes fails. One that
        // does not pass, and checks that cannot be read, get no write.
        const checkRun = (conclusion: string) => ({ id: 9, status: 'completed', conclusion, app: { slug: 'manki-review' } });
        for (const [runs, fails] of [[[checkRun('success')], true], [[checkRun('failure')], false], [null, false]] as const) {
          const listForRef = runs ? jest.fn().mockResolvedValue({ data: runs }) : jest.fn().mockRejectedValue(new Error('Forbidden'));
          checkRuns = { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}), listForRef };
          jest.mocked(authModule.reportPrState).mockClear();
          await withdrawBlockedApproval(setup([thread('t1', 'blocker')]), TEST_BOT, 'owner', 'repo', 1, 'author', undefined);
          expect(listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: HEAD, check_name: 'Manki' }));
          expect(checkRuns.create.mock.calls).toEqual(fails ? [[expect.objectContaining({
            head_sha: HEAD, conclusion: 'failure', output: expect.objectContaining({ summary: expect.stringMatching(/^A blocking thread is not cleared, so this check no longer passes\./) }),
          })]] : []);
          expect(authModule.reportPrState).not.toHaveBeenCalled();
        }
      }
    });
  });

  it('holds an approval on a draft with one notice per head, and on the event draft state when the PR cannot be read', async () => {
    const createCommentMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({ draft: true, mergeable: true, createCommentFn: createCommentMock });

    expect(await holdApproval(octokit, TEST_BOT, 'owner', 'repo', 1, testSha('9'))).toMatchObject({ reason: 'draft', posted: true });
    expect(createCommentMock.mock.calls.map(([c]) => c.body)).toEqual([
      `**Approval held:** this PR is a draft. Mark it ready for review, and Manki approves it if nothing else holds the approval. If the latest commit has no review yet, Manki reviews it first when automatic review runs on this PR. If nothing happens, as for a PR from a fork or while automatic review is off or paused, comment \`/manki check\`, and Manki approves or says what holds the approval.${CHECK_BOX}\n\n<!-- manki-approval-held:9000000000000000000000000000000000000000 -->`,
    ]);
    // With `auto_approve` off the notice promises no approval for marking the PR ready.
    createCommentMock.mockClear();
    expect(await holdApproval(octokit, TEST_BOT, 'owner', 'repo', 1, testSha('8'), false, false)).toMatchObject({ reason: 'draft', posted: true });
    expect(createCommentMock.mock.calls.map(([c]) => c.body)).toEqual([
      `**Approval held:** this PR is a draft. Mark it ready for review, then tick the review box in the settings block. \`auto_approve\` is off, so Manki approves only at the end of a review round, when nothing holds the approval.${AGAIN_BOX}\n\n<!-- manki-approval-held:8000000000000000000000000000000000000000 -->`,
    ]);
    expect(await holdApproval(makeMockOctokit({ mergeable: true }), TEST_BOT, 'owner', 'repo', 1, testSha('9'))).toBe(false);
    const unreadable = makeMockOctokit({ mergeable: true });
    jest.mocked(unreadable.rest.pulls.get).mockRejectedValue(new Error('API down'));
    expect(await holdApproval(unreadable, TEST_BOT, 'owner', 'repo', 1, testSha('9'), true)).toMatchObject({ reason: 'draft' });
    expect(await holdApproval(unreadable, TEST_BOT, 'owner', 'repo', 1, testSha('9'))).toBe(false);
  });

  it('never approves a draft, however its threads stand', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true })],
      draft: true, createReviewFn: createReviewMock,
    });

    expect(await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1)).toBe(false);
    expect(createReviewMock).not.toHaveBeenCalled();
  });

  it.each<[string, { state: 'open' | 'closed'; merged?: boolean }, string | undefined, string]>([
    ['a merged PR', { state: 'closed', merged: true }, undefined, 'This pull request is merged, so Manki approves nothing on it.'],
    ['a closed PR', { state: 'closed', merged: false }, undefined, 'This pull request is closed, so Manki approves nothing on it.'],
    // A caller that decides for one commit names it, and gets no decision for the head that replaced it.
    ['an open PR whose head is no longer the commit the caller names', { state: 'open' }, testSha('01d'), 'The head of this pull request is no longer `01d0000`, so Manki decides nothing for that commit.'],
  ])('approves nothing on %s whose threads are all resolved, and says so', async (_label, pr, head, why) => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const createCommentMock = jest.fn().mockResolvedValue({});
    const checks = { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) };
    const octokit = makeMockOctokit({
      // The PR author resolved the blocking thread with a role that clears it, which an open PR says in the thread.
      threads: [makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true, resolvedBy: 'author' })],
      role: 'admin', ...pr, prHeadSha: testSha('456'), mergeable: true, createReviewFn: createReviewMock, createCommentFn: createCommentMock, checks,
    });

    const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG, head);

    expect(result.approved).toBe(false);
    expect(result).not.toHaveProperty('held');
    expect(await (result as { why: () => Promise<string> }).why()).toBe(why);
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(createCommentMock).not.toHaveBeenCalled();
    expect(checks.create).not.toHaveBeenCalled();
    expect(dismissPreviousReviews).not.toHaveBeenCalled();
    // Nothing is written to a thread either, such as the note that the PR author dismissed a finding.
    expect(jest.mocked(octokit.graphql).mock.calls.filter(([query]) => String(query).includes('mutation'))).toEqual([]);
    expect(jest.mocked(authModule.reportPrState)).not.toHaveBeenCalled();
    // Named as the head, the same commit of the open PR is approved.
    if (head) expect((await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG, testSha('456'))).approved).toBe(true);
  });

  it('holds the approval of a PR that conflicts with its base, with one notice and one neutral check per head, and reports each outcome', async () => {
    const resolved = [makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true })];
    const createReviewMock = jest.fn().mockResolvedValue({});
    const createCommentMock = jest.fn().mockResolvedValue({});
    const checks = { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) };
    const line = '**Approval held:** this PR conflicts with `main`. Rebase it, and Manki reviews the result. If the push starts no review, as while automatic review is off or paused, comment `/manki review`.';

    await expectHeldOncePerHead(
      { threads: resolved, prHeadSha: testSha('456'), mergeable: false, createReviewFn: createReviewMock, createCommentFn: createCommentMock, checks },
      'conflict', 'Approval held: the PR conflicts with its base', line, '<!-- manki-approval-held:4560000000000000000000000000000000000000 -->',
    );
    expect(createReviewMock).not.toHaveBeenCalled();

    jest.mocked(authModule.reportPrState).mockClear();
    const clean = makeMockOctokit({ threads: resolved, prHeadSha: testSha('456'), mergeable: true, createReviewFn: createReviewMock, createCommentFn: createCommentMock });
    expect(await checkAndAutoApprove(clean, TEST_BOT, 'owner', 'repo', 1)).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'APPROVE', commit_id: testSha('456') }));
    expect(jest.mocked(authModule.reportPrState).mock.calls).toEqual([['owner', 'repo', 1, { approval: { commit: testSha('456'), held: false }, pause: null }]]);
  });

  it.each<[string, string, string, AuthorClearRole | 'unreadable' | undefined, boolean, boolean]>([
    ['a collaborator', 'alice', 'write', 'maintain', false, true],
    ['the PR author with `write` under the default', 'author', 'write', 'maintain', false, false],
    ['the PR author with `write` under the default, with a recorded override', 'author', 'write', 'maintain', true, false],
    ['the PR author with `maintain` under the default', 'author', 'maintain', 'maintain', false, true],
    ['the PR author with `maintain` under the default, already recorded', 'author', 'maintain', 'maintain', true, true],
    ['the PR author with `admin` under the default', 'author', 'admin', 'maintain', false, true],
    ['the PR author with `maintain` under `admin`', 'author', 'maintain', 'admin', false, false],
    ['the PR author with `maintain` under `admin`, with a recorded override', 'author', 'maintain', 'admin', true, false],
    ['the PR author with `write` under `write`', 'author', 'write', 'write', false, true],
    ['the PR author with `triage` under `write`', 'author', 'triage', 'write', false, false],
    ['the PR author with a custom role under `write`', 'author', 'release-manager', 'write', false, false],
    // While the base branch config cannot be read, only the role every value of the setting allows may clear.
    ['the PR author with `admin` under the defaults for an unreadable config', 'author', 'admin', 'unreadable', false, true],
    ['the PR author with `maintain` under the defaults for an unreadable config', 'author', 'maintain', 'unreadable', false, false],
    ['the PR author with `admin` under a config without the setting', 'author', 'admin', undefined, false, false],
  ])('approves a security and a plain blocking thread resolved by %s', async (_who, resolver, role, setting, recorded, approves) => {
    const config = setting === 'unreadable' ? fallbackConfig() : { ...DEFAULT_CONFIG, author_clear_role: setting };
    const level = config.author_clear_role;
    const finding = (title: string, tags?: string[]): Finding => ({
      severity: 'blocker', title, file: 'src/a.ts', line: 3, description: 'd', reviewers: [], ...(tags && { tags }),
    });
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({
          id: 't1', isResolved: true, resolvedBy: resolver, url: 'https://github.com/o/r/pull/1#r1', line: 3,
          body: formatFindingComment(finding('Token leaks into logs', ['security']), TEST_LINKS),
          ...(recorded && { replies: [{ body: `<!-- manki -->\n${securityOverrideMarker('resolve', 'author')}`, author: { login: 'manki-review[bot]' } }] }),
        }),
        makeGraphqlFetchThreadNode({ id: 't2', isResolved: true, resolvedBy: resolver, url: 'https://github.com/o/r/pull/1#r2', line: 3, body: formatFindingComment(finding('Off by one'), TEST_LINKS) }),
      ],
      createReviewFn: createReviewMock,
      role,
    });

    const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, config);
    expect(result.approved).toBe(approves);
    expect(createReviewMock).toHaveBeenCalledTimes(approves ? 1 : 0);
    // The reply names the role the repo asks for, and none while that is unknown.
    if (!result.approved) {
      const needs = level ? ` without the \`${level}\` role${level === 'admin' ? '' : ' or a higher one'}` : '';
      expect((await result.why()).split('\n').at(-1)).toBe(`Approval follows once they are resolved by someone allowed to. The PR author may not clear a blocking thread${needs}.`);
    }

    const byAuthor = approves && resolver === 'author';
    const replies = jest.mocked(octokit.graphql).mock.calls.filter(([query]) => String(query).includes('addPullRequestReviewThreadReply'));
    const reply = (threadId: string) => ({ threadId, body: `Finding dismissed by \`@author\`, the PR author, who has the \`${role}\` role on this repository.\n\n<!-- manki -->\n<!-- manki-security-override:resolve:author -->` });
    expect(replies.map(([, vars]) => vars)).toEqual(byAuthor ? [...(recorded ? [] : [reply('t1')]), reply('t2')] : []);
    // The resolver's write access is asked once for both threads, and the role lookup of an author who resolved reuses that answer.
    expect(octokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(1);
    if (approves) {
      const list = `**Findings dismissed by the PR author** \`@author\` (\`${role}\` role):\n\n- [Token leaks into logs](https://github.com/o/r/pull/1#r1)\n- [Off by one](https://github.com/o/r/pull/1#r2)`;
      expect(createReviewMock.mock.calls[0][0].body.includes(list)).toBe(byAuthor);
    }
  });

  it('names the fix claim of a thread when the PR author dismisses, and lists only one Manki confirmed apart', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const claimed = (pr: number, status: string) => `Unverified. You name #${pr}.\n\n<!-- manki -->\n<!-- manki-fix-claim:${pr}:${status} -->`;
    const resolved = (id: string, title: string, replies: Array<{ body: string; author: { login: string } }>) => makeGraphqlFetchThreadNode({
      id, isResolved: true, resolvedBy: 'author', url: `https://github.com/o/r/pull/1#${id}`, line: 3, replies,
      body: formatFindingComment({ severity: 'blocker', title, file: 'src/a.ts', line: 3, description: 'd', reviewers: [] }, TEST_LINKS),
    });
    const octokit = makeMockOctokit({
      threads: [
        resolved('r1', 'Token leaks into logs', [{ body: 'Fixed in #7.', author: { login: 'reader' } }, { body: claimed(7, 'confirmed'), author: { login: 'manki-review[bot]' } }]),
        resolved('r2', 'Off by one', [{ body: claimed(8, 'unconfirmed'), author: { login: 'manki-review[bot]' } }]),
        // The marker counts only in Manki's own reply, so a person's reply naming #9 is a claim Manki did not check.
        resolved('r3', 'Lock never released', [{ body: claimed(9, 'confirmed'), author: { login: 'author' } }]),
        // A reply of an account without write access starts no check, and the note still names its claim.
        resolved('r5', 'Cache never expires', [{ body: 'This is fixed in #12, further up the stack.', author: { login: 'reader' } }]),
        // A thread at the comment limit may hide a later answer, so it names no claim.
        resolved('r4', 'Retry never stops', [
          ...Array.from({ length: 98 }, () => ({ body: 'Still looking.', author: { login: 'reader' } })),
          { body: claimed(7, 'confirmed'), author: { login: 'manki-review[bot]' } },
        ]),
      ],
      createReviewFn: createReviewMock,
      role: 'maintain',
    });

    expect((await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, { ...DEFAULT_CONFIG, author_clear_role: 'maintain' })).approved).toBe(true);
    const notes = jest.mocked(octokit.graphql).mock.calls.filter(([query]) => String(query).includes('addPullRequestReviewThreadReply')).map(([, vars]) => (vars as { body: string }).body.split('\n')[0]);
    const dismissed = 'Finding dismissed by `@author`, the PR author, who has the `maintain` role on this repository.';
    expect(notes).toEqual([
      `${dismissed} A reply here named #7 as the fix, and Manki confirmed that #7 replaced the cited line on the default branch.`,
      `${dismissed} A reply here named #8 as the fix. Manki could not confirm that #8 fixes this finding.`,
      `${dismissed} A reply here names #9. Manki did not check whether it fixes this finding.`,
      `${dismissed} A reply here names #12. Manki did not check whether it fixes this finding.`,
      dismissed,
    ]);
    const body: string = createReviewMock.mock.calls[0][0].body;
    expect(body).toContain('**Findings dismissed by the PR author** `@author` (`maintain` role):\n\n- [Off by one](https://github.com/o/r/pull/1#r2)\n'
      + '- [Lock never released](https://github.com/o/r/pull/1#r3)\n- [Cache never expires](https://github.com/o/r/pull/1#r5)\n- [Retry never stops](https://github.com/o/r/pull/1#r4)');
    expect(body).toContain('**Findings dismissed by the PR author** `@author` (`maintain` role) **as fixed in another PR.** In a reply, Manki confirmed that the PR named replaced the cited line on the default branch.\n\n'
      + '- [Token leaks into logs](https://github.com/o/r/pull/1#r1): #7');
  });

  it('approves when blocking threads are resolved and only suggestion and old nitpick threads are open', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const suggestion = formatFindingComment({ severity: 'note', title: 'Name the retry', file: 'src/a.ts', line: 3, description: 'd', reviewers: [], suggestedFix: 'retryOnce();' }, TEST_LINKS);
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true }),
        makeGraphqlFetchThreadNode({ id: 't2', body: suggestion, isResolved: false }),
        makeGraphqlFetchThreadNode({ id: 't3', body: '<!-- manki:nit:naming --> naming', isResolved: false }),
      ],
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
  });

  it('returns false when unresolved required threads remain', async () => {
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: false }),
      ],
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(false);
  });

  it('does not approve while a blocker thread is unresolved', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:warning:retry --> retry', isResolved: false }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:blocker:race --> race', isResolved: false }),
      ],
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(createReviewMock).not.toHaveBeenCalled();
  });

  it('approves when only suggestion threads exist and all are resolved', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:note:style --> style', isResolved: true }),
      ],
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
  });

  it('approves when there are no threads at all', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [],
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
  });

  describe('a warning thread', () => {
    const HEAD = testSha('bead000');
    const user = { login: 'manki-review[bot]', type: 'Bot' };
    const reply = (login: string, body = 'It is bounded by the caller.', __typename?: string, createdAt?: string) => ({ body, author: { login, ...(__typename && { __typename }) }, ...(createdAt && { createdAt }) });
    const warning = (id: string, overrides: Parameters<typeof makeGraphqlFetchThreadNode>[0] = {}, tags?: string[]) => makeGraphqlFetchThreadNode({
      id, url: `https://example.com/${id}`, body: formatFindingComment({ severity: 'warning', title: `Retry ${id}`, file: 'src/a.ts', line: 10, description: 'd', reviewers: [], ...(tags && { tags }) }, TEST_LINKS), ...overrides,
    });
    /** Runs the state check after a round on the head that held its approval for warnings, or after `reviews`. */
    const check = async (threads: ReturnType<typeof makeGraphqlFetchThreadNode>[], role = 'write', unreadRecords = false, reviews?: Array<{ id: number; body: string; state: string; commit_id: string; user: typeof user; submitted_at: string }>) => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const octokit = makeMockOctokit({
        threads, prHeadSha: HEAD, mergeable: true, role, createReviewFn: createReviewMock,
        existingReviews: reviews ?? [{ id: 7, body: roundBody(roundThatPosted(HEAD, [])), state: 'COMMENTED', commit_id: HEAD, user }],
      });
      // The round records are the first list the check reads.
      if (unreadRecords) jest.mocked(octokit.paginate).mockRejectedValueOnce(new Error('rate limited'));
      const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
      return { approved: result.approved, why: result.approved ? undefined : await result.why(), events: createReviewMock.mock.calls.map(([args]) => args.event), body: createReviewMock.mock.calls[0]?.[0].body as string | undefined };
    };

    const manki = 'manki-review[bot]';
    /** Manki's answer to a reply. `decision` is set on an answer that accepts the reply. */
    const answer = (text: string, decision?: ReplyDecision, createdAt?: string, modelAnswer?: ReplyModelAnswer) => reply(manki, answerBody(text, decision, modelAnswer), undefined, createdAt);
    const accepted = (outcome: ReplyDecision['outcome'] = 'Agreed', thread: ReplyDecision['thread'] = 'resolves', createdAt?: string) => answer(`${outcome}. Fine.`, { outcome, thread }, createdAt);
    const kept = answer('Kept. `src/a.ts:12` still loops.');
    // The folded list quotes an accepting answer of Manki's, which settles nothing there.
    const listed = statementFold({ statements: [{ quote: accepted().body, status: 'contradicted', places: ['src/a.ts:3'] }], unchecked: 0 } as unknown as CheckedReply, true).join('\n\n');
    const tracked = `**Agreed.** Filed as #5 for later work.\n\n${BOT_MARKER}\n${TRACKED_MARKER}`;

    it.each<[string, ReturnType<typeof makeGraphqlFetchThreadNode>[], string?]>([
      ['an open warning thread', [warning('t1')]],
      ['a warning thread a bot replied in', [warning('t1', { replies: [reply('ci-app', 'Looks fine.', 'Bot')] })]],
      ['a warning thread only Manki replied in', [warning('t1', { replies: [reply(manki, 'Kept. The retry still loops.')] })]],
      ['a warning thread whose reply by the PR author Manki answered "Kept."', [warning('t1', { replies: [reply('author'), kept] })]],
      ['a warning thread whose reply by the PR author Manki answered "Kept." with a folded list', [warning('t1', { replies: [reply('author'), answer(`Kept. It still loops.\n\n${listed}`)] })]],
      ['a warning thread whose reply by the PR author Manki answered "Unverified."', [warning('t1', { replies: [reply('author'), answer('Unverified. I can\'t verify that from the code.')] })]],
      ['a warning thread whose "Fixed." the model could not prove', [warning('t1', { replies: [reply('author'), answer('Unverified. I could not point to a line this PR changed in `src/a.ts` since this was posted.', undefined, undefined, { outcome: 'Fixed', proof: [], cited: ['src/b.ts:3'] })] })]],
      ['a warning thread whose "Fixed." a rebase left unproven', [warning('t1', { replies: [reply('author'), reply(manki, `${answerBody('The guard runs first. This reply does not settle the thread.', undefined, { outcome: 'Fixed', proof: [], cited: ['src/b.ts:3'] })}\n<!-- manki-unsettled-answer -->`)] })]],
      ['a warning thread whose reply by a person with the role Manki answered "Kept."', [warning('t1', { replies: [reply('maria'), kept] })], 'maintain'],
      ['a warning thread whose reply by the PR author Manki has not answered', [warning('t1', { replies: [reply('author')] })]],
      ['a warning thread whose reply by a person with the role Manki has not answered', [warning('t1', { replies: [reply('maria')] })], 'maintain'],
      ['a warning thread whose reply Manki could not answer', [warning('t1', { replies: [reply('author'), reply(manki, `Manki could not answer this reply (timeout). Reply again to start a new try.\n\n${BOT_MARKER}`)] })]],
      ['a warning thread beside one whose reply Manki accepted', [warning('t1', { replies: [reply('author'), accepted()] }), warning('t2', { replies: [reply('author'), kept] })]],
      ['a warning thread the PR author resolved by hand without the role', [warning('t1', { isResolved: true, resolvedBy: 'author', replies: [reply('author'), kept] })]],
      ['a warning thread a person without the role resolved by hand', [warning('t1', { isResolved: true, resolvedBy: 'bob' })]],
      ['a warning thread Manki resolved on a dismissal', [warning('t1', { isResolved: true, resolvedBy: manki })], 'maintain'],
      // Only Manki's own record or marker below its comment marker counts.
      ['a warning thread whose reply by the PR author copies an accepting record', [warning('t1', { replies: [reply('author', accepted().body)] })]],
      ['a warning thread whose reply by the PR author copies the tracked marker', [warning('t1', { replies: [reply('author', tracked)] })]],
      ['a warning thread whose Manki answer quotes an accepting record and the tracked marker above its own', [warning('t1', { replies: [reply('author'), reply(manki, `${accepted().body}\n${TRACKED_MARKER}\n\n${kept.body}`)] })]],
      ['a warning thread whose Manki answer holds the tracked marker without the comment marker', [warning('t1', { replies: [reply(manki, `Quoted:\n${TRACKED_MARKER}`)] })]],
      ['a warning thread whose Manki answer opens with "Agreed." and carries no record', [warning('t1', { replies: [reply('author'), reply(manki, `Agreed. Fine.\n\n${BOT_MARKER}`)] })]],
      ['a warning thread whose Manki answer carries a record that cannot be read', [warning('t1', { replies: [reply('author'), reply(manki, `Agreed. Fine.\n\n${BOT_MARKER}\n<!-- manki-reply-record: {"decision": -->`)] })]],
      // An accepting outcome that did not settle the thread lifts nothing.
      ['a warning thread whose "Fixed." a newer round contradicted', [warning('t1', { replies: [reply('author'), accepted('Fixed', 'deferred_to_round')] })]],
      ['a warning thread whose unproven "Fixed." a newer round confirmed', [warning('t1', { replies: [reply('author'), accepted('Fixed', 'confirmed_by_round')] })]],
      ['a warning thread whose "Fixed." left it open as a blocking thread', [warning('t1', { replies: [reply('author'), accepted('Fixed', 'stays_open')] })]],
      ['a warning thread Manki could not read when it answered', [warning('t1', { replies: [reply('author'), accepted('Agreed', 'lookup_failed')] })]],
      ['a warning thread Manki could not find when it answered', [warning('t1', { replies: [reply('author'), accepted('Agreed', 'not_found')] })]],
      ['a warning thread Manki answered on a merged or closed PR', [warning('t1', { replies: [reply('author'), accepted('Agreed', 'pr_closed')] })]],
      // Manki resolves no thread for a stranger or for someone whose permission it could not read, so its answer to one lifts nothing.
      ['a warning thread whose reply by someone without write access Manki accepted', [warning('t1', { replies: [reply('bob'), accepted('Agreed', 'no_permission')] })]],
      ['a security warning thread whose reply by the PR author Manki accepted', [warning('t1', { replies: [reply('author'), accepted()] }, ['security'])]],
      ['a security warning thread the PR author resolved without the role', [warning('t1', { isResolved: true, resolvedBy: 'author' }, ['security'])]],
      // A blocker a check disproved is guarded as a security warning is, so the PR author's answer alone never clears it.
      ['the thread of a disproved blocker whose reply by the PR author Manki accepted', [warning('t1', { replies: [reply('author'), accepted()] }, ['disproved-blocker'])]],
      ['the thread of a disproved blocker the PR author resolved without the role', [warning('t1', { isResolved: true, resolvedBy: 'author' }, ['disproved-blocker'])]],
      ['a second warning thread nobody answered', [warning('t1', { isResolved: true, resolvedBy: manki, replies: [reply('author'), accepted()] }), warning('t2')]],
      ['a late warning thread with the header and note of a thread posted while warnings did not hold', [warning('t1', {
        body: formatFindingComment({ severity: 'warning', title: 'Retry t1', file: 'src/a.ts', line: 10, description: 'd', reviewers: [], origin: 'reviewed', tags: ['follow-up'] }, TEST_LINKS)
          .replace('**Warning**', '**Warning, not blocking**')
          .replace('_An earlier round already reviewed these lines and missed this. It is in this PR\'s own code, so it still holds the approval._', '_An earlier round already reviewed these lines and missed this, and it doesn\'t block this PR._'),
      })]],
    ])('holds the approval while it is %s', async (_label, threads, role = 'write') => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      const { approved, why, events } = await check(threads, role);
      expect(approved).toBe(false);
      expect(events).toEqual([]);
      const held = threads.at(-1)!.id;
      expect(why).toMatch(new RegExp(`^1 warning thread holds the approval:\\n- \\[Retry ${held}\\]\\(https://example\\.com/${held}\\)`));
      expect(why).toContain('Approval follows once each one is fixed, tracked with `Create an issue for this`, or resolved by someone with the `maintain` role or a higher one.');
      expect(why).toContain('A reply in a thread lifts its hold only when Manki answers it with Fixed, Withdrawn or Agreed.');
    });

    it('names a resolved warning thread that still holds with the reason', async () => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      const line = async (resolvedBy: string, role = 'write', config = DEFAULT_CONFIG, tags?: string[]) => {
        const octokit = makeMockOctokit({
          threads: [warning('t1', { isResolved: true, resolvedBy }, tags)], prHeadSha: HEAD, mergeable: true, role,
          existingReviews: [{ id: 7, body: roundBody(roundThatPosted(HEAD, [])), state: 'COMMENTED', commit_id: HEAD, user }],
        });
        const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, config);
        if (result.approved) return undefined;
        const why = await result.why();
        reopens = why.includes('A thread that is already resolved has to be reopened first. A reply');
        return why.split('\n')[1];
      };
      let reopens = false;
      expect(await line('author')).toBe('- [Retry t1](https://example.com/t1) (resolved by `author`, which lifts the hold only with the `maintain` role or a higher one)');
      expect(await line(manki, 'admin')).toBe('- [Retry t1](https://example.com/t1) (Manki resolved it, but for none of the reasons that lift the hold)');
      expect(reopens).toBe(true);
      // The note of a guarded thread already says what clears it.
      expect(await line('author', 'write', DEFAULT_CONFIG, ['security'])).toContain('needs a fix or a maintainer to resolve it');
      expect(reopens).toBe(false);
      // Without `author_clear_role` no resolve by hand lifts the hold, whatever the resolver's role.
      const { author_clear_role: _role, ...noRole } = DEFAULT_CONFIG;
      expect(await line('maria', 'admin', noRole)).toBe('- [Retry t1](https://example.com/t1) (resolved by `maria`, which does not lift the hold)');
      expect(reopens).toBe(false);
    });

    it.each<[string, ReturnType<typeof makeGraphqlFetchThreadNode>[], string?]>([
      ['answered "Fixed." by Manki, which resolved it', [warning('t1', { isResolved: true, resolvedBy: manki, replies: [reply('author'), accepted('Fixed')] })]],
      ['answered "Withdrawn." by Manki, which resolved it', [warning('t1', { isResolved: true, resolvedBy: manki, replies: [reply('author'), accepted('Withdrawn')] })]],
      ['answered "Agreed." by Manki, which resolved it', [warning('t1', { isResolved: true, resolvedBy: manki, replies: [reply('author'), accepted('Agreed')] })]],
      ['answered "Agreed." by Manki with a folded list', [warning('t1', { replies: [reply('author'), answer(`Agreed. Fine.\n\n${listed}`, { outcome: 'Agreed', thread: 'resolves' })] })]],
      ['answered "Agreed." by Manki after an earlier "Kept."', [warning('t1', { replies: [reply('author'), kept, reply('author'), accepted()] })]],
      // Only a later round that raises the warning again takes an accepted answer back, never a later answer.
      ['answered "Agreed." by Manki before a later "Kept."', [warning('t1', { replies: [reply('author'), accepted(), reply('bob'), kept] })]],
      ['answered "Agreed." by Manki after the PR author resolved it by hand', [warning('t1', { isResolved: true, resolvedBy: 'author', replies: [reply('author'), accepted('Agreed', 'already_resolved')] })]],
      ['tracked with its issue box', [warning('t1', { isResolved: true, resolvedBy: manki, replies: [reply(manki, tracked)] })]],
      ['resolved by a person with the role `author_clear_role` allows', [warning('t1', { isResolved: true, resolvedBy: 'maria' })], 'maintain'],
      ['resolved by a PR author with the role', [warning('t1', { isResolved: true, resolvedBy: 'author', replies: [reply('author'), kept] })], 'admin'],
      ['a security warning a maintainer resolved', [warning('t1', { isResolved: true, resolvedBy: 'maria' }, ['security'])]],
      ['the thread of a disproved blocker a maintainer resolved', [warning('t1', { isResolved: true, resolvedBy: 'maria' }, ['disproved-blocker'])]],
      ['the thread of a disproved blocker a PR author with the role resolved', [warning('t1', { isResolved: true, resolvedBy: 'author', replies: [reply('author'), accepted()] }, ['disproved-blocker'])], 'admin'],
      ['the last of several, each cleared its own way', [warning('t1', { isResolved: true, resolvedBy: 'maria' }), warning('t2', { replies: [reply('author'), accepted()] })], 'maintain'],
      // Neither a pre-existing defect nor a suggestion holds, though nobody answered them.
      ['answered, beside an open pre-existing warning and an open suggestion', [
        warning('t1', { replies: [reply('author'), accepted()] }), warning('t2', {}, ['pre-existing']), makeGraphqlFetchThreadNode({ id: 't3', body: '<!-- manki:note:style --> style' }),
      ]],
    ])('approves once the warning thread is %s', async (_label, threads, role = 'write') => {
      const { approved, events, body } = await check(threads, role);
      expect(approved).toBe(true);
      expect(events).toEqual(['APPROVE']);
      expect(body).toMatch(/^✅ \*\*Approved\.\*\* All blocking threads are resolved, and no warning thread holds the approval\.\n/u);
    });

    it('shows what the change does and how to test it, kept by the round the warnings held, in the approval that follows', async () => {
      const answered = [warning('t1', { replies: [reply('author'), accepted()] })];
      const line = '\u2705 **Approved.** All blocking threads are resolved, and no warning thread holds the approval.';
      const approval = async (readyReport?: RoundContext['readyReport']) => {
        const round = { ...roundThatPosted(HEAD, []), approval: { held: 'warnings' as const, warningsHeld: true as const }, ...(readyReport && { readyReport }) };
        const { body } = await check(answered, 'write', false, [{ id: 7, body: roundBody(round), state: 'COMMENTED', commit_id: HEAD, user, submitted_at: '' }]);
        return body!.split(`\n\n${BOT_MARKER}`)[0];
      };
      expect(await approval({ whatThisDoes: 'Adds a cache <script>x</script>. It halves requests. It also logs hits.', whatToTest: { steps: ['Load the page twice.'] } })).toBe([
        line,
        '**What this does:** Adds a cache x. It halves requests.',
        '<details>\n<summary>What to test</summary>\n\n_The review model wrote these steps. Check what a step runs before you follow it._\n\n1. Load the page twice.\n\n</details>',
      ].join('\n\n'));
      // Either part alone shows, and a record that keeps neither, as one from before, gives the one line.
      expect((await approval({ whatThisDoes: '', whatToTest: { steps: ['Load the page twice.'] } })).startsWith(`${line}\n\n<details>\n<summary>What to test</summary>`)).toBe(true);
      expect(await approval()).toBe(line);
    });

    it('shows the kept summary in the refusal notice when repository settings refuse that approval, once per head', async () => {
      const readyReport = { whatThisDoes: 'Adds a cache. It halves requests.', whatToTest: { steps: ['Load the page twice.'] } };
      const round = { ...roundThatPosted(HEAD, []), approval: { held: 'warnings' as const, warningsHeld: true as const }, readyReport };
      const reviews = [{ id: 7, body: roundBody(round), state: 'COMMENTED', commit_id: HEAD, user, submitted_at: '' }];
      const createReviewFn = jest.fn().mockRejectedValue(new Error(SETTING_REFUSAL));
      const createCommentFn = jest.fn().mockResolvedValue({});
      const refuse = (existingComments: Array<{ body: string; user: { login: string } }> = []) => approveOrSayWhy(makeMockOctokit({
        threads: [warning('t1', { replies: [reply('author'), accepted()] })], prHeadSha: HEAD, mergeable: true, createReviewFn, createCommentFn, existingReviews: reviews, existingComments,
      }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
      const result = await refuse();
      const notice = createCommentFn.mock.calls[0][0].body as string;
      expect(notice.split('\n\n<!-- manki-approval-record: ')[0]).toBe([
        'Every warning that held the approval is handled. All blocking threads are resolved, but repository settings block the approval. Enable "Allow GitHub Actions to create and approve pull requests" in the repo settings, or approve by hand.',
        '**What this does:** Adds a cache. It halves requests.',
        '<details>\n<summary>What to test</summary>\n\n_The review model wrote these steps. Check what a step runs before you follow it._\n\n1. Load the page twice.\n\n</details>',
      ].join('\n\n'));
      // The notice still ends with its record, and a person who asks gets the short line.
      expect(extractApprovalRecords(notice).map(r => JSON.parse(r) as ApprovalRecord)).toEqual([expect.objectContaining({ decision: 'held', reason: 'refused' })]);
      expect(result.approved ? undefined : await result.why()).toBe('Every warning that held the approval is handled. All blocking threads are resolved, but repository settings block the approval. Enable "Allow GitHub Actions to create and approve pull requests" in the repo settings, or approve by hand.');
      // A repeat on the same head posts nothing new.
      await refuse([{ body: notice, user: { login: 'manki-review[bot]' } }]);
      expect(createCommentFn).toHaveBeenCalledTimes(1);
    });

    it.each<[string, RoundContext['approval'], boolean, string]>([
      ['warnings to a conflict', { held: 'warnings', warningsHeld: true }, false, 'Every warning that held the approval is handled. **Approval is still held:** this PR conflicts'],
      ['a draft to a conflict', { held: 'draft' }, false, 'This PR is no longer a draft. **Approval is still held:** this PR conflicts'],
      ['a draft with warnings to a conflict', { held: 'draft', warningsHeld: true }, false, 'Every warning that held the approval is handled. This PR is no longer a draft. **Approval is still held:** this PR conflicts'],
      ['a conflict with warnings to the same conflict', { held: 'conflict', warningsHeld: true }, false, 'Every warning that held the approval is handled. **Approval is still held:** this PR conflicts'],
      // The check may not have read the PR before a refusal, so it never claims the conflict is resolved.
      ['a conflict to a refusal', { held: 'conflict' }, true, 'All blocking threads are resolved, but repository settings'],
      ['a conflict with warnings to a refusal', { held: 'conflict', warningsHeld: true }, true, 'Every warning that held the approval is handled. All blocking threads are resolved, but repository settings'],
      // The same hold, or none before, keeps the notice as it is.
      ['a conflict to the same conflict', { held: 'conflict' }, false, '**Approval held:** this PR conflicts'],
      ['no hold to a conflict', undefined, false, '**Approval held:** this PR conflicts'],
      ['a refusal to a conflict', { held: 'refused' }, false, '**Approval held:** this PR conflicts'],
    ])('says what cleared since the covering review held the approval, from %s', async (_label, approval, refused, start) => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      jest.spyOn(core, 'warning').mockImplementation(() => {});
      const round = { ...roundThatPosted(HEAD, []), ...(approval && { approval }) };
      const createCommentFn = jest.fn().mockResolvedValue({});
      const result = await approveOrSayWhy(makeMockOctokit({
        threads: [warning('t1', { replies: [reply('author'), accepted()] })], prHeadSha: HEAD, mergeable: refused, createCommentFn,
        existingReviews: [{ id: 7, body: roundBody(round), state: 'COMMENTED', commit_id: HEAD, user }],
        ...(refused && { createReviewFn: jest.fn().mockRejectedValue(new Error(SETTING_REFUSAL)) }),
      }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
      expect(result.approved).toBe(false);
      expect(createCommentFn.mock.calls[0][0].body).toMatch(new RegExp(`^${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    });

    it('counts only an accepted answer made after the review that lowered a blocker thread to a warning was posted', async () => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      const lowered = (replies: ReturnType<typeof reply>[]) => makeGraphqlFetchThreadNode({
        id: 't1', url: 'https://example.com/t1', body: formatFindingComment({ severity: 'blocker', title: 'Retry t1', file: 'src/a.ts', line: 10, description: 'd', reviewers: [] }, TEST_LINKS), replies,
      });
      const evaluations = [{ threadId: 't1', status: 'partly_addressed' as const, reason: 'Capped, but the cap is too high.', grade: 'warning' as const }];
      const round = blockingRound(HEAD, { verdict: 'APPROVE', findings: { count: 0, severityCounts: {}, entries: [] }, judge: { summary: '', threadEvaluations: evaluations } }, 2);
      const reviews = (submitted?: string) => [{ id: 7, body: roundBody(round), state: 'COMMENTED', commit_id: HEAD, user, submitted_at: submitted ?? '' }];
      const posted = '2026-11-12T10:00:00Z';
      const answeredAt = (at?: string) => [lowered([reply('author'), accepted('Agreed', 'resolves', at)])];
      // An answer about the blocker, made before the round lowered it, does not settle the warning.
      const before = await check(answeredAt('2026-11-12T09:59:00Z'), 'write', false, reviews(posted));
      expect([before.approved, before.events]).toEqual([false, []]);
      expect(before.why).toMatch(/^1 warning thread holds the approval:\n- \[Retry t1\]/);
      // Without the time the review was posted, no answer counts.
      expect((await check(answeredAt('2026-11-12T10:01:00Z'), 'write', false, reviews())).approved).toBe(false);
      // Neither does an answer whose own time is unknown.
      expect((await check(answeredAt(), 'write', false, reviews(posted))).approved).toBe(false);
      const after = await check(answeredAt('2026-11-12T10:01:00Z'), 'write', false, reviews(posted));
      expect([after.approved, after.events]).toEqual([true, ['APPROVE']]);
    });

    it('holds again once a later round puts a warning into the thread, until an answer or a fix follows that round', async () => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      type Round = { evaluations?: ThreadEvaluation[]; raises?: boolean; submitted?: string };
      const fixedBy: ThreadEvaluation[] = [{ threadId: 't1', status: 'addressed', reason: 'The retry stops now.' }];
      const reviews = (rounds: Round[]) => rounds.map(({ evaluations = [], raises = false, submitted = '' }, i) => ({
        id: i + 7, state: 'COMMENTED', commit_id: HEAD, user, submitted_at: submitted,
        body: roundBody(blockingRound(HEAD, {
          verdict: 'APPROVE', judge: { summary: '', threadEvaluations: evaluations },
          findings: { count: 0, severityCounts: {}, entries: raises ? [makeFindingFingerprintEntry({ severity: 'warning', posted: 'earlier_thread', threadId: 't1' })] : [] },
        }, i + 1)),
      }));
      const approves = async (thread: ReturnType<typeof warning>, rounds: Round[]) => (await check([thread], 'write', false, reviews(rounds))).approved;
      const posted = '2026-11-12T10:00:00Z';

      // An accepted answer counts only when it follows the round that raised the warning again.
      const answeredAt = (at: string) => warning('t1', { replies: [reply('author'), accepted('Agreed', 'resolves', at)] });
      expect(await approves(answeredAt('2026-11-12T09:59:00Z'), [{}, { raises: true, submitted: posted }])).toBe(false);
      expect(await approves(answeredAt('2026-11-12T10:01:00Z'), [{}, { raises: true, submitted: posted }])).toBe(true);
      // Without the time that round was posted, no answer counts.
      expect(await approves(answeredAt('2026-11-12T10:01:00Z'), [{}, { raises: true }])).toBe(false);
      // So does the issue its box filed.
      const trackedAt = (at: string) => warning('t1', { replies: [reply(manki, tracked, undefined, at)] });
      expect(await approves(trackedAt('2026-11-12T09:59:00Z'), [{}, { raises: true, submitted: posted }])).toBe(false);
      expect(await approves(trackedAt('2026-11-12T10:01:00Z'), [{}, { raises: true, submitted: posted }])).toBe(true);

      // A round that found the thread fixed backs Manki's resolve, but no resolve by anyone else and no open thread.
      const resolvedByManki = warning('t1', { isResolved: true, resolvedBy: manki });
      expect(await approves(resolvedByManki, [{ evaluations: fixedBy }])).toBe(true);
      expect(await approves(warning('t1', { isResolved: true, resolvedBy: 'author' }), [{ evaluations: fixedBy }])).toBe(false);
      expect(await approves(warning('t1'), [{ evaluations: fixedBy }])).toBe(false);
      // A fix found before the latest round that raised the warning again backs nothing, as after a dismissal there.
      expect(await approves(resolvedByManki, [{ evaluations: fixedBy }, { raises: true }])).toBe(false);
      expect(await approves(resolvedByManki, [{ evaluations: fixedBy, raises: true }])).toBe(false);
      expect(await approves(resolvedByManki, [{ evaluations: fixedBy }, { raises: true }, { evaluations: fixedBy }])).toBe(true);
      // Neither does one a later round took back.
      expect(await approves(resolvedByManki, [{ evaluations: fixedBy }, { evaluations: [{ threadId: 't1', status: 'not_addressed', reason: 'Still loops.' }] }])).toBe(false);
    });

    it('says in a reply what lifts the hold, only for a warning thread that still holds', async () => {
      const note = (thread: Partial<ReviewThread>, clearRole: AuthorClearRole | 'unset' = 'write') =>
        warningHoldNote(threadsOctokit(jest.fn()), TEST_BOT, 'owner', 'repo', makeThread({ isBlocking: false, isWarning: true, ...thread }), clearRole === 'unset' ? undefined : clearRole);
      expect(await note({})).toBe('This warning holds the approval until it is fixed, tracked with `Create an issue for this`, or resolved by someone with the `write` role or a higher one.');
      expect(await note({}, 'admin')).toBe('This warning holds the approval until it is fixed, tracked with `Create an issue for this`, or resolved by someone with the `admin` role.');
      expect(await note({}, 'unset')).toBe('This warning holds the approval until it is fixed or tracked with `Create an issue for this`.');
      // A resolve by a person below the role leaves the hold, and so does Manki's own resolve without a reason. A resolved thread has to be reopened first.
      expect(await note({ isResolved: true, resolvedByLogin: 'bob' }, 'admin')).toBe('This warning holds the approval until it is fixed, tracked with `Create an issue for this`, or reopened and resolved by someone with the `admin` role.');
      expect(await note({ isResolved: true, resolvedByLogin: 'manki-review[bot]' })).toMatch(/^This warning holds the approval/);
      // A thread that holds nothing gets no note, and a security warning has its own.
      expect(await note({ holdLifted: 'answer' })).toBeUndefined();
      expect(await note({ isResolved: true, resolvedByLogin: 'maria' })).toBeUndefined();
      expect(await note({ isWarning: undefined })).toBeUndefined();
      expect(await note({ isSecurity: true })).toBeUndefined();
      expect(await note({ disprovedBlocker: true })).toBeUndefined();
    });

    it('holds the approval when the round records cannot be read, since the thread then counts as blocking', async () => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      jest.spyOn(core, 'warning').mockImplementation(() => {});
      const { approved, events } = await check([warning('t1', { replies: [reply('author'), accepted()] })], 'write', true);
      expect([approved, events]).toEqual([false, []]);
    });

    it('names the warning threads that hold beside an open blocking thread', async () => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      const blocker = makeGraphqlFetchThreadNode({
        id: 'b1', url: 'https://example.com/b1', body: formatFindingComment({ severity: 'blocker', title: 'Lost write', file: 'src/a.ts', line: 10, description: 'd', reviewers: [] }, TEST_LINKS),
      });
      const { approved, why } = await check([blocker, warning('t1'), warning('t2', { replies: [reply('author'), accepted()] })]);
      expect(approved).toBe(false);
      expect(why).toContain('[Lost write](https://example.com/b1)');
      expect(why).toMatch(/\n\n1 warning thread holds the approval:\n- \[Retry t1\]\(https:\/\/example\.com\/t1\)\n/);
      // With every warning settled, the reply names only what blocks.
      expect((await check([blocker, warning('t2', { replies: [reply('author'), accepted()] })])).why).not.toContain('warning thread');
    });
  });

  it.each([
    ['in a check it creates completed', undefined, 0],
    ['in the queued check on the head, completed in one update', testSha('abc123'), 0],
    ['in a check it creates when the queued check sits on another head', 'def456', 0],
    ['in a check it creates, then completes the queued check, when its first update fails', testSha('abc123'), 1],
    ['in a check it creates when the queued check cannot be updated at all', testSha('abc123'), 2],
  ])('reports the approval as a passing `Manki` check on the head %s', async (_name, queuedHead, updateFailures) => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const checks = { create: jest.fn().mockResolvedValue({ data: { id: 901 } }), update: jest.fn().mockResolvedValue({}) };
    for (let i = 0; i < updateFailures; i++) checks.update.mockRejectedValueOnce(new Error('Not Found'));
    const octokit = makeMockOctokit({ threads: [], checks });
    if (queuedHead) offerQueuedCheck(octokit, { id: 77, headSha: queuedHead });
    expect(await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1)).toBe(true);

    // Each call writes a completed check, so a failed takeover still leaves a passing check newest on the head.
    const completed = { status: 'completed', conclusion: 'success', details_url: expect.any(String), output: { title: 'Approved', summary: 'All blocking threads are resolved.' } };
    const takesOver = queuedHead === testSha('abc123');
    const updateQueued = [{ owner: 'owner', repo: 'repo', check_run_id: 77, ...completed }];
    expect(checks.update.mock.calls).toEqual(takesOver ? (updateFailures ? [updateQueued, updateQueued] : [updateQueued]) : []);
    expect(checks.create.mock.calls).toEqual(takesOver && !updateFailures ? [] : [[{ owner: 'owner', repo: 'repo', name: 'Manki', head_sha: testSha('abc123'), ...completed }]]);
    expect(warning.mock.calls.filter(([message]) => String(message).includes('queued Manki check')).length).toBe(updateFailures);
  });

  const checkRun = (id: number, status: string, conclusion: string | null, slug = 'manki-review') => ({ id, status, conclusion, app: { slug } });
  const standingApproval = (runs: ReturnType<typeof checkRun>[] | null, botSlug = 'manki-review') => {
    jest.spyOn(core, 'info').mockImplementation(() => {});
    jest.spyOn(core, 'warning').mockImplementation(() => {});
    const listForRef = runs ? jest.fn().mockResolvedValue({ data: runs }) : jest.fn().mockRejectedValue(new Error('Forbidden'));
    const checks = { create: jest.fn().mockResolvedValue({ data: { id: 901 } }), update: jest.fn().mockResolvedValue({}), listForRef };
    const user = { login: `${botSlug}[bot]`, type: 'Bot' };
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({ checks, createReviewFn: createReviewMock, existingReviews: [{ id: 7, body: roundBody(roundThatPosted(testSha('abc123'), [])), state: 'APPROVED', commit_id: testSha('abc123'), user }] });
    return { octokit, checks, createReviewMock, bot: { logins: [user.login] } };
  };

  it.each([
    ['reports it when no check shows on the head', [], true, 'manki-review'],
    ['reports it when the newest check is still in progress', [checkRun(5, 'completed', 'success'), checkRun(9, 'in_progress', null)], true, 'manki-review'],
    ['reports it when the newest check did not pass', [checkRun(9, 'completed', 'neutral'), checkRun(5, 'completed', 'success')], true, 'manki-review'],
    ['reports it when only another App\'s newer check passed', [checkRun(5, 'in_progress', null), checkRun(9, 'completed', 'success', 'other-app')], true, 'manki-review'],
    ['reports it when the checks cannot be read', null, true, 'manki-review'],
    ['adds no check when the newest one passed', [checkRun(5, 'in_progress', null), checkRun(9, 'completed', 'success')], false, 'manki-review'],
    ['reports it with its own App when the Manki service\'s newer check is in progress', [checkRun(5, 'completed', 'success', 'own-app'), checkRun(9, 'in_progress', null)], true, 'own-app'],
    ['adds no check with its own App when the Manki service\'s newer check passed', [checkRun(5, 'in_progress', null, 'own-app'), checkRun(9, 'completed', 'success')], false, 'own-app'],
  ])('on an approval that already stands, %s', async (_name, runs, reports, botSlug) => {
    const { octokit, checks, createReviewMock, bot } = standingApproval(runs, botSlug);

    expect(await approveOrSayWhy(octokit, bot, 'owner', 'repo', 1)).toEqual({ approved: true, standing: true });

    expect(checks.listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: testSha('abc123'), check_name: 'Manki', filter: 'all' }));
    expect(checks.create.mock.calls).toEqual(reports ? [[expect.objectContaining({
      head_sha: testSha('abc123'), status: 'completed', conclusion: 'success', output: { title: 'Approved', summary: 'Manki\'s approval of this commit stands.' },
    })]] : []);
    expect(createReviewMock).not.toHaveBeenCalled();
  });

  it('writes no check on an approval that already stands once the run is cancelled', async () => {
    const { octokit, checks } = standingApproval([]);
    const { release } = stopWritesOn(AbortSignal.abort(new RunCancelledError('SIGTERM')));
    try {
      await expect(approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1)).rejects.toBeInstanceOf(RunCancelledError);
    } finally {
      release();
    }
    expect(checks.create).not.toHaveBeenCalled();
  });

  it('posts an issue comment (not a COMMENT review) when APPROVE fails', async () => {
    // A COMMENT-review fallback would register as a bot review on the head SHA
    // and break the force-review tickbox loop ([#840]). The fallback must
    // surface the missing permission via an issue comment instead.
    const createReviewMock = jest.fn().mockRejectedValueOnce(new Error(SETTING_REFUSAL));
    const createCommentMock = jest.fn().mockResolvedValue({});

    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: true }),
      ],
      prHeadSha: testSha('789'),
      createReviewFn: createReviewMock,
      createCommentFn: createCommentMock,
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    // A refused approval is held, as in a review round.
    expect(result).toBe(false);
    expect(jest.mocked(authModule.reportPrState)).toHaveBeenCalledWith('owner', 'repo', 1, { approval: { commit: testSha('789'), held: true } });
    expect(createReviewMock).toHaveBeenCalledTimes(1);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'owner',
      repo: 'repo',
      issue_number: 1,
      body: expect.stringContaining('repository settings block the approval'),
    }));
    // The notice records the hold, as the notice of a draft or a conflict does.
    const notice = createCommentMock.mock.calls[0][0].body as string;
    expect(extractApprovalRecords(notice).map(r => JSON.parse(r) as ApprovalRecord)).toEqual([expect.objectContaining({ decision: 'held', reason: 'refused', head: testSha('789') })]);
    expect(dismissPreviousReviews).not.toHaveBeenCalled();
  });

  it('posts the refusal notice and a neutral check once per head, and a later verdict or approval retires the notice', async () => {
    const refusal = 'All blocking threads are resolved, but repository settings block the approval. Enable "Allow GitHub Actions to create and approve pull requests" in the repo settings, or approve by hand.';
    const resolved = [makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: true })];
    const createReviewMock = jest.fn().mockRejectedValue(new Error(SETTING_REFUSAL));
    const createCommentMock = jest.fn().mockResolvedValue({});
    const checks = { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) };
    const heldCheck = (head: string) => expect.objectContaining({
      name: 'Manki', head_sha: head, status: 'completed', conclusion: 'neutral', output: { title: 'Approval held: GitHub refused the approval', summary: refusal },
    });
    const posted = await expectHeldOncePerHead(
      { threads: resolved, prHeadSha: testSha('789'), mergeable: true, createReviewFn: createReviewMock, createCommentFn: createCommentMock, checks },
      'refused', 'Approval held: GitHub refused the approval', refusal, '<!-- manki-approval-held:7890000000000000000000000000000000000000:refused -->',
    );
    // A failed notice still deletes the progress comment, so nothing marks the check failed.
    expect(deleteAutoApproveProgressComment).toHaveBeenCalledTimes(3);
    expect(markProgressCommentFailed).not.toHaveBeenCalled();

    // A new head gets its own notice, and the draft or conflict notice of that head does not stand in for it.
    await approveOrSayWhy(makeMockOctokit({
      threads: resolved, prHeadSha: testSha('790'), mergeable: true, createReviewFn: createReviewMock, createCommentFn: createCommentMock, checks,
      existingComments: [posted, '**Approval held:** this PR is a draft.\n\n<!-- manki-approval-held:7900000000000000000000000000000000000000 -->'].map(body => ({ body, user: { login: 'manki-review[bot]' } })),
    }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
    expect(createCommentMock).toHaveBeenCalledTimes(2);
    expect(createCommentMock.mock.calls[1][0].body).toContain('<!-- manki-approval-held:7900000000000000000000000000000000000000:refused -->');
    expect(checks.create.mock.calls).toEqual([[heldCheck(testSha('789'))], [heldCheck(testSha('790'))]]);

    const deleteComment = jest.fn().mockResolvedValue({});
    const listed = { paginate: jest.fn(paginateSinglePage), rest: { issues: {
      listComments: jest.fn().mockResolvedValue({ data: [{ id: 11, body: posted, user: { login: 'manki-review[bot]' }, updated_at: '2025-01-01T00:00:00Z' }] }),
      deleteComment,
    } } } as unknown as Octokit;
    await retireStaleNotices(listed, TEST_BOT, 'owner', 'repo', 1, testSha('791'));
    expect(deleteComment).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', comment_id: 11 });

    // Once the setting allows it, the approval of the head retires the notice too. It changes no other comment: not a
    // failed review that holds the PR's settings block, nor the token service's conflict note.
    const deleteOnApproval = jest.fn().mockResolvedValue({});
    const updateOnApproval = jest.fn().mockResolvedValue({});
    const failedReview = '🔴 **Review failed** boom\n\n<!-- manki-bot -->\n\n---\nNot reviewed yet · head `7890000` · failed\n- [ ] Review again <!-- manki-box:again -->\n<!-- manki-settings -->';
    const conflictNote = 'This PR conflicts with `main`. Rebase it, and Manki reviews it then.\n\n<!-- manki-conflict-note -->';
    const approved = await approveOrSayWhy(makeMockOctokit({
      threads: resolved, prHeadSha: testSha('789'), mergeable: true, deleteCommentFn: deleteOnApproval, updateCommentFn: updateOnApproval,
      existingComments: [
        { id: 12, body: posted, user: { login: 'manki-review[bot]' } },
        { id: 13, body: failedReview, user: { login: 'manki-review[bot]' } },
        { id: 14, body: conflictNote, user: { login: 'manki-review[bot]' } },
      ],
    }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
    expect(approved).toEqual({ approved: true });
    expect(deleteOnApproval.mock.calls).toEqual([[{ owner: 'owner', repo: 'repo', comment_id: 12 }]]);
    expect(updateOnApproval).not.toHaveBeenCalled();
  });

  it('approve review body is non-empty so it does not register as a placeholder', async () => {
    // The API returns `body_length: 0` for review bodies containing only HTML
    // comments, which trips the head-SHA dedupe gate on subsequent force-review
    // ticks. Auto-approve must include visible content ([#840]).
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: true }),
      ],
      prHeadSha: testSha('5a15'),
      createReviewFn: createReviewMock,
    });

    await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    const call = createReviewMock.mock.calls[0][0] as { body: string };
    expect(call.body).toContain(BOT_MARKER);
    // Visible content beyond the HTML comment so GitHub does not strip the body.
    expect(call.body.replace(/<!--[^]*?-->/g, '').trim().length).toBeGreaterThan(0);
  });

  it('dismisses previous reviews only after the approval posts', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [],
      createReviewFn: createReviewMock,
    });

    await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 42);

    expect(dismissPreviousReviews).toHaveBeenCalledWith(octokit, TEST_BOT, 'owner', 'repo', 42);
    expect(createReviewMock.mock.invocationCallOrder[0]).toBeLessThan(dismissPreviousReviews.mock.invocationCallOrder[0]);
  });


  it('skips duplicate approval when bot already has an active APPROVED review on HEAD', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [],
      prHeadSha: testSha('abc123'),
      createReviewFn: createReviewMock,
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', commit_id: testSha('abc123'), user: { login: 'manki-review[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(dismissPreviousReviews).not.toHaveBeenCalled();
  });

  it('finds the latest bot review past the first page of reviews', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const bot = { login: 'manki-review[bot]', type: 'Bot' };
    const older = Array.from({ length: 30 }, (_, i) => ({ body: '<!-- manki -->', state: 'CHANGES_REQUESTED', commit_id: `old-${i}`, user: bot }));
    const octokit = makeMockOctokit({ threads: [], prHeadSha: testSha('abc123'), createReviewFn: createReviewMock, existingReviews: older });
    (octokit.paginate as unknown as jest.Mock).mockResolvedValueOnce(namingCommit([
      ...older,
      { body: '<!-- manki -->', state: 'APPROVED', commit_id: testSha('abc123'), user: bot },
    ]));

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.pulls.listReviews, expect.objectContaining({ per_page: 100 }));
    expect(createReviewMock).not.toHaveBeenCalled();
  });

  it('creates new approval when latest bot review is CHANGES_REQUESTED', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [makeGraphqlFetchThreadNode({ isResolved: true })],
      prHeadSha: testSha('5ae'),
      createReviewFn: createReviewMock,
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', commit_id: testSha('5ae'), user: { login: 'manki-review[bot]', type: 'Bot' } },
        { body: roundBody(blockingRound(testSha('5ae'))), state: 'CHANGES_REQUESTED', commit_id: testSha('5ae'), user: { login: 'manki-review[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
  });

  it('skips approval when the only bot review on HEAD is DISMISSED', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const octokit = makeMockOctokit({
      threads: [],
      prHeadSha: testSha('5ae'),
      createReviewFn: createReviewMock,
      createCommentFn: createCommentMock,
      existingReviews: [
        { body: '<!-- manki -->', state: 'DISMISSED', commit_id: testSha('5ae'), user: { login: 'manki-review[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, AUTO_REVIEW_OFF);

    expect(result).toBe(false);
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('manki has not reviewed HEAD'));
    expect(createCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('unknown'),
      }),
    );
    warnSpy.mockRestore();
  });

  it('counts a request for changes on the head that a person dismissed as covering the head', async () => {
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const head = testSha('5ae');
    const person = { login: 'maintainer', type: 'User' };
    type Setup = { resolved?: boolean; commit?: string; heldForPerson?: boolean; timelineFails?: boolean; actor?: { login: string; type: string }; state?: string; pushed?: string; approvedAfter?: boolean; stands?: boolean; unlisted?: boolean };
    // Round 1 requested changes on `commit` for one blocker thread, and `actor` dismissed that review, unless it `stands`.
    // With `approvedAfter`, Manki then approved the head and a person dismissed that approval, which the timeline leaves out when `unlisted`.
    const check = async (setup: Setup = {}) => {
      warnSpy.mockClear();
      const threads = [makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: setup.resolved ?? true })];
      const commit = setup.commit ?? head;
      const body = `${roundBody(roundThatPosted(commit, threads))}${setup.heldForPerson ? '\n\n<!-- manki-held-for-person -->' : ''}`;
      const createReviewMock = jest.fn().mockResolvedValue({});
      const octokit = makeMockOctokit({
        threads, prHeadSha: head, createReviewFn: createReviewMock,
        existingReviews: [
          { id: 5, body, state: setup.stands ? 'CHANGES_REQUESTED' : 'DISMISSED', commit_id: commit, user: { login: 'manki-review[bot]', type: 'Bot' } },
          ...setup.approvedAfter ? [{ id: 6, body: roundBody(roundThatPosted(commit, [])), state: 'DISMISSED', commit_id: commit, user: { login: 'manki-review[bot]', type: 'Bot' } }] : [],
        ],
      });
      const dismissal = { actor: setup.actor ?? person, dismissed_review: { review_id: 5, state: setup.state ?? 'changes_requested', dismissal_commit_id: setup.pushed ?? null } };
      const approvalDismissal = { actor: person, dismissed_review: { review_id: 6, state: 'approved', dismissal_commit_id: null } };
      Object.assign(octokit.rest.issues, {
        listEventsForTimeline: setup.timelineFails ? jest.fn().mockRejectedValue(new Error('API down')) : jest.fn().mockResolvedValue({ data: setup.unlisted ? [dismissal] : [dismissal, approvalDismissal] }),
      });
      const approved = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, AUTO_REVIEW_OFF);
      const covered = !warnSpy.mock.calls.some(([m]) => String(m).includes('manki has not reviewed HEAD'));
      return { approved, posted: createReviewMock.mock.calls.map(([args]) => args.event), covered };
    };

    // A person set the block aside and resolved its thread, so the review still covers the head and the approval follows.
    expect(await check()).toEqual({ approved: true, posted: ['APPROVE'], covered: true });
    // A blocker thread still open holds it.
    expect(await check({ resolved: false })).toEqual({ approved: false, posted: [], covered: true });
    // So does a review that held its approval for a person.
    expect(await check({ heldForPerson: true })).toEqual({ approved: false, posted: [], covered: true });
    // A dismissal by Manki, by another app, of an approval, by a push, on an older commit, or one the timeline cannot show covers nothing.
    // The newest verdict on the head decides, so a person's dismissal of a later approval leaves no review on the head, standing or not.
    for (const setup of [
      { approvedAfter: true },
      { approvedAfter: true, stands: true },
      // A dismissal the timeline does not show, or cannot show, leaves no review on the head either.
      { approvedAfter: true, stands: true, unlisted: true },
      { approvedAfter: true, stands: true, timelineFails: true },
      { actor: { login: 'manki-review[bot]', type: 'Bot' } },
      { actor: { login: 'other-app[bot]', type: 'Bot' } },
      { state: 'approved' },
      { pushed: head },
      { commit: testSha('01d') },
      { timelineFails: true },
    ]) {
      expect(await check(setup)).toEqual({ approved: false, posted: [], covered: false });
    }
    warnSpy.mockRestore();
  });

  describe('stale-SHA guard', () => {
    let warningSpy: jest.SpyInstance;

    beforeEach(() => {
      warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    });

    afterEach(() => {
      warningSpy.mockRestore();
    });

    const staleHeadOctokit = (createCommentFn: jest.Mock, roundBodies: string[]) => makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: true }),
      ],
      prHeadSha: testSha('bead000a'),
      createCommentFn,
      existingReviews: (roundBodies.length > 0 ? roundBodies : ['']).map(extra => (
        { body: `<!-- manki -->\n${extra}`, state: 'COMMENTED', commit_id: testSha('01db'), user: { login: 'manki-review[bot]', type: 'Bot' } }
      )),
    });

    it.each([
      ['no config is passed', undefined],
      ['automatic review is on and not paused', DEFAULT_CONFIG],
    ])('posts no withheld notice on a stale SHA when %s, since a push review covers the head', async (_label, config) => {
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = staleHeadOctokit(createCommentMock, [formatReviewRecord(makeRoundContext(1))]);

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, config);

      expect(result).toBe(false);
      expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('head=bead000a00000000000000000000000000000000'));
      expect(createCommentMock).not.toHaveBeenCalled();
    });

    const notConverging = makeRoundContext(1);
    notConverging.meta.outcome = 'NOT_CONVERGING';
    it.each([
      ['the last round did not converge', DEFAULT_CONFIG, [formatReviewRecord(notConverging)], 'The last Manki round found a blocker that came back after a fix. Automatic review is paused. Tick the review box in the settings block', 'automatic_pause'],
      ['the round cap is reached', DEFAULT_CONFIG, Array.from({ length: 10 }, (_, i) => formatReviewRecord(makeRoundContext(i + 1))), 'Manki has reviewed new changes in 10/10 rounds on this PR. Rounds that keep finding problems usually mean the approach needs another look, so step back and reconsider it before pushing more fixes. Automatic review is paused. Tick the review box in the settings block, or comment `/manki review`, to review it. A review you start by hand also turns automatic review back on for the next 3 rounds.', 'automatic_pause'],
      ['automatic review is off', AUTO_REVIEW_OFF, [], 'Automatic review is off for this repository (`auto_review: false`). Comment `/manki review` to review it.', 'auto_review_off'],
    ])('posts one withheld notice with the reason when %s', async (_label, config, roundBodies, reason, cause) => {
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = staleHeadOctokit(createCommentMock, roundBodies);

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, config);

      expect(result).toBe(false);
      expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(createCommentMock).toHaveBeenCalledTimes(1);
      const { body, issue_number } = createCommentMock.mock.calls[0][0] as { body: string; issue_number: number };
      expect(issue_number).toBe(1);
      expect(body).toContain('**Auto-approve withheld** for `bead000`');
      expect(body).toContain('Its latest review was on `01db000`.');
      expect(body).toContain(reason);
      expect(body).toContain('<!-- manki-stale-approve:bead000a00000000000000000000000000000000 -->');
      // The record names the cause in a fixed word, so the stats count one cause on one row.
      expect(extractApprovalRecords(body).map(r => JSON.parse(r) as ApprovalRecord)).toEqual([expect.objectContaining({ decision: 'withheld', reason: cause, head: testSha('bead000a') })]);
    });

    it('still approves when the latest manki review is on the current HEAD, even with automatic review paused by the round cap', async () => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = makeMockOctokit({
        threads: [
          makeGraphqlFetchThreadNode({ id: 't1', isResolved: true }),
        ],
        prHeadSha: testSha('bead000a'),
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        existingReviews: [1, 2, 3, 4, 5].map(n => ({
          body: roundBody(n === 5 ? blockingRound(testSha('bead000a'), {}, 5) : makeRoundContext(n)), state: n === 5 ? 'CHANGES_REQUESTED' : 'COMMENTED',
          commit_id: n === 5 ? testSha('bead000a') : `old-sha-${n}`, user: { login: 'manki-review[bot]', type: 'Bot' },
        })),
      });

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);

      expect(result).toBe(true);
      expect(createReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVE', commit_id: testSha('bead000a') }),
      );
      expect(createCommentMock).not.toHaveBeenCalled();
      expect(warningSpy).not.toHaveBeenCalled();
    });

    it('does not post a duplicate comment when stale-approve marker for the same HEAD already exists', async () => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = makeMockOctokit({
        threads: [
          makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: true }),
        ],
        prHeadSha: testSha('bead000a'),
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        existingReviews: [
          { body: '<!-- manki -->', state: 'COMMENTED', commit_id: testSha('01db'), user: { login: 'manki-review[bot]', type: 'Bot' } },
        ],
        existingComments: [
          { body: '<!-- manki-stale-approve:bead000a00000000000000000000000000000000 -->\nAuto-approve withheld...', user: { login: 'manki-review[bot]' } },
        ],
      });

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, AUTO_REVIEW_OFF);

      expect(result).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(createCommentMock).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('manki has not reviewed HEAD'),
      );
    });

    const heldReview = (commit: string) => ({ body: '**Changes requested**\n\n<!-- manki-held-for-person -->\n\n<!-- manki -->\n<!-- manki-bot -->', state: 'CHANGES_REQUESTED', commit_id: commit, user: { login: 'manki-review[bot]', type: 'Bot' } });
    it.each([
      ['on the head', [heldReview(testSha('bead000'))]],
      ['on an earlier commit with the same change, such as before an empty commit', [heldReview(testSha('01d'))]],
      ['on the head under a later round that gave no verdict', [heldReview(testSha('bead000')), { body: 'Incomplete\n\n<!-- manki-no-verdict -->\n\n<!-- manki -->\n<!-- manki-bot -->', state: 'COMMENTED', commit_id: testSha('bead000'), user: { login: 'manki-review[bot]', type: 'Bot' } }]],
    ])('skips approval when the review that covers the head holds its approval for a person, %s', async (_label, existingReviews) => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const octokit = makeMockOctokit({
        threads: [],
        prHeadSha: testSha('bead000'),
        createReviewFn: createReviewMock,
        existingReviews,
      });
      const sameChange = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n';
      Object.assign(octokit.rest, { repos: { compareCommits: jest.fn().mockResolvedValue({ data: sameChange }) } });
      const info = jest.spyOn(core, 'info');

      expect(await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1)).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(expect.stringContaining('holds its approval for a person'));
    });

    it('skips approval when the only review on the head is no verdict, such as an unread or incomplete round', async () => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const octokit = makeMockOctokit({
        threads: [],
        prHeadSha: testSha('bead000'),
        createReviewFn: createReviewMock,
        existingReviews: [
          { body: '<!-- manki -->', state: 'APPROVED', commit_id: testSha('01d'), user: { login: 'manki-review[bot]', type: 'Bot' } },
          // An incomplete round carries its record, which makes it no more of a verdict.
          { body: '**Review incomplete**\n\n<!-- manki-context: {"meta":{"round":1,"mankiVersion":"7","incomplete":true}} -->\n\n<!-- manki-no-verdict -->\n\n<!-- manki -->', state: 'COMMENTED', commit_id: testSha('bead000'), user: { login: 'manki-review[bot]', type: 'Bot' } },
          // The review command reads an incomplete round by its first line, so that alone makes it no verdict here too.
          { body: '⏸️ **Review incomplete:** The judge failed.\n\n<!-- manki -->', state: 'COMMENTED', commit_id: testSha('bead000'), user: { login: 'manki-review[bot]', type: 'Bot' } },
        ],
      });

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

      expect(result).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('manki has not reviewed HEAD'));
    });

    it('skips approval when latest bot review is APPROVED but on a stale commit', async () => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const octokit = makeMockOctokit({
        threads: [],
        prHeadSha: testSha('e3'),
        createReviewFn: createReviewMock,
        existingReviews: [
          { body: '<!-- manki -->', state: 'APPROVED', commit_id: testSha('01d'), user: { login: 'manki-review[bot]', type: 'Bot' } },
        ],
      });

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

      expect(result).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('manki has not reviewed HEAD'));
    });

    it('skips approval when all bot reviews are DISMISSED and threads exist', async () => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = makeMockOctokit({
        threads: [
          makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: true }),
        ],
        prHeadSha: testSha('bead000e'),
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        existingReviews: [
          { body: '<!-- manki -->', state: 'DISMISSED', commit_id: testSha('01d'), user: { login: 'manki-review[bot]', type: 'Bot' } },
        ],
      });

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, AUTO_REVIEW_OFF);

      expect(result).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('manki has not reviewed HEAD'),
      );
      expect(createCommentMock).toHaveBeenCalledTimes(1);
      expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.stringContaining('<!-- manki-stale-approve:bead000e00000000000000000000000000000000 -->'),
      }));
    });

    it('skips approval when no bot reviews exist at all', async () => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = makeMockOctokit({
        threads: [],
        prHeadSha: testSha('5af'),
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        existingReviews: [],
      });

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

      expect(result).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('manki has not reviewed HEAD'),
      );
    });

    const rebaseDiff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
    const REVIEWED = testSha('01db');
    const REBASED = testSha('bead000a');
    // The review of `REVIEWED` names its commit in its footer. After a rebase GitHub can report it on the new head.
    const reviewOn = (commit_id: string, named = true) => ({
      body: `<!-- manki-bot -->\n${formatReviewRecord(blockingRound(REVIEWED))}${named ? `\n\n${reviewedLine(REVIEWED)}` : ''}`,
      state: 'CHANGES_REQUESTED', commit_id, user: { login: 'manki-review[bot]', type: 'Bot' },
    });
    it.each([
      ['approves the head when its PR diff equals the reviewed commit\'s, as after a rebase', rebaseDiff, reviewOn(REVIEWED), true],
      ['withholds approval when the head changes the PR diff', rebaseDiff.replace('+new', '+newer'), reviewOn(REVIEWED), false],
      ['approves the head on the review of the commit its body names, when GitHub reports the review on the head', rebaseDiff, reviewOn(REBASED), true],
      ['withholds approval when GitHub reports the review on a head that changes the PR diff', rebaseDiff.replace('+new', '+newer'), reviewOn(REBASED), false],
      ['withholds approval on a review whose body names no commit, whatever commit GitHub reports it on', rebaseDiff, reviewOn(REBASED, false), false],
      ['withholds approval on a review whose body names no commit, also with an unchanged PR diff since the commit GitHub reports', rebaseDiff, reviewOn(REVIEWED, false), false],
    ])('%s', async (_label, headDiff, review, approves) => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = makeMockOctokit({
        threads: [makeGraphqlFetchThreadNode({ id: 't1', isResolved: true, commit: REVIEWED })],
        prHeadSha: REBASED,
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        diffs: { [REVIEWED]: rebaseDiff, [REBASED]: headDiff },
      });
      // The review is listed as built, so one that names no commit stays that way.
      jest.mocked(octokit.rest.pulls.listReviews).mockResolvedValue({ data: [review] } as never);

      const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
      expect(result.approved).toBe(approves);
      expect(createReviewMock.mock.calls.map(([args]) => [args.event, args.commit_id])).toEqual(approves ? [['APPROVE', REBASED]] : []);
      expect(createCommentMock).not.toHaveBeenCalled();
      if (!result.approved) expect(await result.why()).toBe(NOT_REVIEWED_YET + AGAIN_BOX);
      // The auto-approval names the head it approves.
      else expect(reviewedCommit({ body: createReviewMock.mock.calls[0][0].body as string })).toBe(REBASED);
    });

    it('explains an unreviewed head by the pause, the Pause box, or by the review still to come', async () => {
      const asked = async (octokit: Octokit) => {
        const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
        return result.approved || result.why();
      };
      const notice = () => jest.fn().mockResolvedValue({ data: { id: 1 } });
      expect(await asked(staleHeadOctokit(notice(), [formatReviewRecord(notConverging)])))
        .toMatch(/^Manki has not reviewed `bead000`\. The last Manki round found a blocker that came back after a fix\. Automatic review is paused\./);
      jest.mocked(authModule.fetchPrState).mockResolvedValueOnce({ settings: { paused: true }, runModes: new Set(), queuedModes: new Set(), queuedReplies: new Set() });
      expect(await asked(staleHeadOctokit(notice(), [])))
        .toBe(`Manki has not reviewed \`bead000\`. Automatic review is paused in the settings block. Tick the review box there, or comment \`/manki review\`, to review it. Untick **Pause automatic reviews** to lift the pause.${AGAIN_BOX}`);
      expect(await asked(staleHeadOctokit(notice(), [])))
        .toBe(NOT_REVIEWED_YET + AGAIN_BOX);

      // A token service that cannot say whether the PR is paused must not end in the promise of a push review.
      const unknown = notice();
      jest.mocked(authModule.fetchPrState).mockRejectedValueOnce(new Error('HTTP 503'));
      expect(await asked(staleHeadOctokit(unknown, [])))
        .toBe(`Manki has not reviewed \`bead000\`. Manki could not read whether automatic review is paused for this PR. If no review of the commit starts, tick the review box in the settings block, or comment \`/manki review\`.${AGAIN_BOX}`);
      // The withheld notice names the review command too, so it carries the same box.
      expect(unknown.mock.calls[0][0].body).toContain(`**Auto-approve withheld** for \`bead000\`: all blocking review threads are resolved, but Manki has not reviewed this commit. Its latest review was on \`01db000\`.\n\nManki could not read whether automatic review is paused for this PR. If no review of the commit starts, tick the review box in the settings block, or comment \`/manki review\`.${AGAIN_BOX}`);
      expect(unknown.mock.calls[0][0].body).toContain('"reason":"pause_unknown"');

      // A pause the rounds show is certain, so it wins over the unknown Pause box.
      jest.mocked(authModule.fetchPrState).mockRejectedValueOnce(new Error('HTTP 503'));
      expect(await asked(staleHeadOctokit(notice(), [formatReviewRecord(notConverging)])))
        .toMatch(/^Manki has not reviewed `bead000`\. The last Manki round found a blocker that came back after a fix\. Automatic review is paused\./);
    });
  });
});

const ghActualMarker = (headSha: string) => (jest.requireActual('./github') as typeof import('./github')).autoApproveHeadMarker(headSha);

describe('checkAndAutoApprove — in-progress marker lifecycle', () => {
  const ghMock = jest.requireMock('./github') as {
    dismissPreviousReviews: jest.Mock;
    postAutoApproveProgressComment: jest.Mock;
    deleteAutoApproveProgressComment: jest.Mock;
    markProgressCommentFailed: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    ghMock.postAutoApproveProgressComment.mockResolvedValue(7777);
  });

  function makeMockOctokit(overrides: {
    createReviewFn?: jest.Mock;
    createCommentFn?: jest.Mock;
    comments?: Array<{ id: number; body: string; updated_at: string; user: { login: string; type: string } }>;
    prHeadSha?: string;
    existingReviews?: Array<{ id?: number; body?: string; state?: string; commit_id?: string; user?: { login?: string; type?: string } }>;
  } = {}) {
    const createReviewFn = overrides.createReviewFn ?? jest.fn().mockResolvedValue({});
    const createCommentFn = overrides.createCommentFn ?? jest.fn().mockResolvedValue({});
    const prHeadSha = overrides.prHeadSha ?? testSha('aaa1');
    const existingReviews = overrides.existingReviews ?? [
      { body: roundBody(blockingRound(prHeadSha)), state: 'CHANGES_REQUESTED', commit_id: prHeadSha, user: { login: 'manki-review[bot]', type: 'Bot' } },
    ];
    return {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse([makeGraphqlFetchThreadNode({ isResolved: true, commit: prHeadSha })])),
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: prHeadSha } } }),
          createReview: createReviewFn,
          listReviews: jest.fn().mockResolvedValue({ data: namingCommit(existingReviews) }),
        },
        issues: {
          createComment: createCommentFn,
          listComments: jest.fn().mockResolvedValue({ data: overrides.comments ?? [] }),
        },
        repos: { getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: 'write', role_name: 'write', user: { type: 'User' } } }) },
      },
    } as unknown as Octokit;
  }

  it('posts the in-progress marker before calling createReview and deletes it once the approval is posted', async () => {
    const callOrder: string[] = [];
    ghMock.postAutoApproveProgressComment.mockImplementationOnce(async () => {
      callOrder.push('post');
      return 7777;
    });
    const createReviewMock = jest.fn().mockImplementationOnce(async () => {
      callOrder.push('createReview');
      return {};
    });
    ghMock.deleteAutoApproveProgressComment.mockImplementationOnce(async () => {
      callOrder.push('delete');
    });

    const octokit = makeMockOctokit({ createReviewFn: createReviewMock });
    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(callOrder).toEqual(['post', 'createReview', 'delete']);
    expect(ghMock.deleteAutoApproveProgressComment).toHaveBeenCalledWith(octokit, 'owner', 'repo', 7777);
    expect(ghMock.markProgressCommentFailed).not.toHaveBeenCalled();
  });

  it('turns the failed auto-approve comment of the same head into the new attempt\'s, so a second failure posts no second comment', async () => {
    const failedOn = (id: number, head: string) => ({
      id, body: `🔴 **Auto-approve failed:** boom\n\n<!-- manki -->\n${ghActualMarker(head)}`, updated_at: `2026-11-13T10:00:0${id % 10}Z`, user: { login: 'manki-review[bot]', type: 'Bot' },
    });

    await checkAndAutoApprove(makeMockOctokit({ comments: [failedOn(55, testSha('aaa1')), failedOn(56, testSha('501d'))] }), TEST_BOT, 'owner', 'repo', 1);
    expect(ghMock.postAutoApproveProgressComment).toHaveBeenLastCalledWith(expect.anything(), 'owner', 'repo', 1, testSha('aaa1'), 55);

    // A failure on an earlier head stays, and the new head gets its own comment.
    await checkAndAutoApprove(makeMockOctokit({ comments: [failedOn(56, testSha('501d'))] }), TEST_BOT, 'owner', 'repo', 1);
    expect(ghMock.postAutoApproveProgressComment).toHaveBeenLastCalledWith(expect.anything(), 'owner', 'repo', 1, testSha('aaa1'), undefined);
  });

  it('does not post a marker when unresolved findings remain', async () => {
    const octokit = {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: false }),
      ])),
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: testSha('aaa1') } } }),
          createReview: jest.fn().mockResolvedValue({}),
          listReviews: jest.fn().mockResolvedValue({ data: [] }),
        },
      },
    } as unknown as Octokit;

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(ghMock.postAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.deleteAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.markProgressCommentFailed).not.toHaveBeenCalled();
  });

  it('does not post a marker when a prior bot approval already exists for the same SHA', async () => {
    const octokit = makeMockOctokit({
      prHeadSha: testSha('aaa1'),
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', commit_id: testSha('aaa1'), user: { login: 'manki-review[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(ghMock.postAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.deleteAutoApproveProgressComment).not.toHaveBeenCalled();
  });

  it('transitions the marker to a failure state when GitHub refuses the approval for a reason other than the repo setting', async () => {
    const reason = 'Review cannot be submitted';
    const createReviewMock = jest.fn().mockRejectedValueOnce(new Error(reason));
    const createCommentMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({ createReviewFn: createReviewMock, createCommentFn: createCommentMock });

    await expect(checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1)).rejects.toThrow(reason);
    expect(ghMock.markProgressCommentFailed).toHaveBeenCalledWith(
      octokit, 'owner', 'repo', 7777, 'Auto-approve', reason, undefined, [ghActualMarker(testSha('aaa1'))],
    );
    expect(createCommentMock).not.toHaveBeenCalled();
    expect(ghMock.deleteAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.dismissPreviousReviews).not.toHaveBeenCalled();
  });

  it.each([
    ['is posted', () => jest.fn().mockResolvedValueOnce({})],
    ['cannot be posted', () => jest.fn().mockRejectedValueOnce(new Error('comment also forbidden'))],
  ])('deletes the progress comment and holds when repository settings refuse the approval and the notice %s', async (_label, createComment) => {
    jest.spyOn(core, 'warning').mockImplementation(() => {});
    const createReviewMock = jest.fn().mockRejectedValueOnce(new Error(SETTING_REFUSAL));
    const createCommentMock = createComment();
    const octokit = makeMockOctokit({ createReviewFn: createReviewMock, createCommentFn: createCommentMock });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 1,
      body: expect.stringContaining('repository settings block the approval'),
    }));
    // Crucially, no `COMMENT` review was posted (which would trip the head-SHA
    // dedupe gate on subsequent force-review ticks, see [#840]).
    expect(createReviewMock).toHaveBeenCalledTimes(1);
    expect(createReviewMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'APPROVE' }));
    expect(ghMock.deleteAutoApproveProgressComment).toHaveBeenCalledWith(octokit, 'owner', 'repo', 7777);
    expect(ghMock.markProgressCommentFailed).not.toHaveBeenCalled();
  });
});

describe('postAutoApproveProgressComment / markAutoApprove*', () => {
  const ghActual = jest.requireActual('./github') as typeof import('./github');

  it('posts the comment and saves its id, so the post step can mark it cancelled', async () => {
    const saveState = jest.spyOn(core, 'saveState').mockImplementation(() => {});
    let postedBody = '';
    const createComment = jest.fn().mockImplementation(async ({ body }: { body: string }) => {
      postedBody = body;
      return { data: { id: 1 } };
    });
    const octokit = { rest: { issues: { createComment } } } as unknown as Octokit;

    await ghActual.postAutoApproveProgressComment(octokit, 'o', 'r', 1, testSha('aaa1'));

    expect(saveState).toHaveBeenCalledWith('manki_progress_comment', '1');
    expect(postedBody).toContain('Auto-approving');
    expect(postedBody).toContain(ghActual.autoApproveHeadMarker(testSha('aaa1')));
    saveState.mockRestore();
  });

  it('edits the failed comment it is given into the running one, and finds it again by its head once it fails again', async () => {
    let body = '';
    const updateComment = jest.fn().mockImplementation(async (args: { body: string }) => {
      body = args.body;
      return { data: {} };
    });
    const createComment = jest.fn();
    const octokit = { rest: { issues: { updateComment, createComment } } } as unknown as Octokit;

    expect(await ghActual.postAutoApproveProgressComment(octokit, 'o', 'r', 1, testSha('aaa1'), 55)).toBe(55);
    expect([body.startsWith('**Auto-approving:**'), createComment.mock.calls.length]).toEqual([true, 0]);

    await ghActual.markProgressCommentFailed(octokit, 'o', 'r', 55, 'Auto-approve', 'boom', undefined, [ghActual.autoApproveHeadMarker(testSha('aaa1'))]);
    const comment = { id: 55, body, user: { login: 'manki-review[bot]', type: 'Bot' } } as Parameters<typeof ghActual.failedAutoApproveId>[0][number];
    expect([ghActual.failedAutoApproveId([comment], TEST_BOT, testSha('aaa1')), ghActual.failedAutoApproveId([comment], TEST_BOT, testSha('aaa2'))]).toEqual([55, undefined]);
  });

  it('deletes the comment, and only warns when the deletion fails', async () => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const deleteComment = jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('gone'));
    const octokit = { rest: { issues: { deleteComment } } } as unknown as Octokit;

    await ghActual.deleteAutoApproveProgressComment(octokit, 'o', 'r', 1);
    await expect(ghActual.deleteAutoApproveProgressComment(octokit, 'o', 'r', 1)).resolves.toBeUndefined();

    expect(deleteComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 1 });
    expect(warning).toHaveBeenCalledWith('Failed to delete the auto-approve progress comment: gone');
    warning.mockRestore();
  });

  it('marks the comment failed with tokens redacted, so the post step leaves it alone', async () => {
    let updatedBody = '';
    const updateComment = jest.fn().mockImplementation(async ({ body }: { body: string }) => {
      updatedBody = body;
      return { data: {} };
    });
    const octokit = { rest: { issues: { updateComment } } } as unknown as Octokit;

    await ghActual.markProgressCommentFailed(octokit, 'o', 'r', 1, 'Auto-approve', 'API rate limited for ghs_secret123');

    expect(updatedBody).toContain(ghActual.CANCELLED_MARKER);
    expect(updatedBody).toContain('API rate limited for [REDACTED]');
    expect(updatedBody).not.toContain('ghs_secret123');

    // A long reason is cut with an ellipsis, so the comment never ends mid-word without a mark.
    await ghActual.markProgressCommentFailed(octokit, 'o', 'r', 1, 'Review', `The model timed out ${'again '.repeat(60)}`);
    expect(updatedBody).toContain(`**Review failed:** ${`The model timed out ${'again '.repeat(60)}`.slice(0, 300)}...`);
  });
});

describe('pauseState', () => {
  it('leaves draft rounds out of the round cap', () => {
    const rounds = Array.from({ length: 10 }, (_, i) => makeRoundContext(i + 1));
    expect(pauseState({ priorRounds: rounds }, DEFAULT_CONFIG)).toMatchObject({ capRounds: 10, paused: true });
    rounds[1].meta.draft = true;
    rounds[3].meta.draft = true;
    expect(pauseState({ priorRounds: rounds }, DEFAULT_CONFIG)).toEqual({ capRounds: 8, roundsLeft: 2, capReached: false, paused: false });
  });

  it('counts a round that warnings held as no approval, whatever hold came first', () => {
    const rounds = Array.from({ length: 10 }, (_, i) => makeRoundContext(i + 1));
    const held = (held: NonNullable<RoundContext['approval']>['held'], warningsHeld?: true): RoundContext =>
      ({ ...makeRoundContext(5, { verdict: 'APPROVE' }), approval: { held, ...(warningsHeld && { warningsHeld }) } });
    const withRound5 = (round: RoundContext) => rounds.map(r => (r.meta.round === 5 ? round : r));
    // Warnings held it, alone or behind a config hold, so the count runs on and the cap pauses with no approval to name.
    for (const round of [held('warnings', true), held('config', true)]) {
      expect(pauseState({ priorRounds: withRound5(round) }, DEFAULT_CONFIG)).toMatchObject({
        capRounds: 10, paused: true, reason: expect.stringMatching(/^Manki has reviewed new changes in 10\/10 rounds on this PR\. /),
      });
    }
    // An approval held for anything else, or one recorded without the flag, starts the count again.
    for (const round of [held('conflict'), held(false), makeRoundContext(5, { verdict: 'APPROVE' })]) {
      expect(pauseState({ priorRounds: withRound5(round) }, DEFAULT_CONFIG)).toMatchObject({ capRounds: 5, paused: false });
    }
  });

  it('turns automatic review back on for three rounds after a review started by hand while paused', () => {
    const byHand = (round: RoundContext, bypassReason: 'manual_review_command' | 'force_review' = 'manual_review_command'): RoundContext => ({
      ...round, meta: { ...round.meta, cap: { priorRoundCount: round.meta.round - 1, maxAutoRounds: 10, skipCap: true, forceReview: bypassReason === 'force_review', bypassReason } },
    });
    const rounds = (n: number, from = 1) => Array.from({ length: n }, (_, i) => makeRoundContext(from + i));
    const state = (priorRounds: RoundContext[], config = DEFAULT_CONFIG) => pauseState({ priorRounds }, config);
    const restartLine = 'A review you start by hand also turns automatic review back on for the next 3 rounds.';

    const capped = rounds(10);
    expect(state(capped)).toMatchObject({ capRounds: 10, roundsLeft: 0, capReached: true, paused: true, restart: restartLine });

    // The round started by hand counts, but exactly three automatic rounds follow it.
    const restarted = [...capped, byHand(makeRoundContext(11))];
    expect(state(restarted)).toEqual({ capRounds: 11, roundsLeft: 3, capReached: false, paused: false });
    expect(state([...restarted, ...rounds(2, 12)])).toMatchObject({ roundsLeft: 1, paused: false });
    const pausedAgain = [...restarted, ...rounds(3, 12)];
    expect(state(pausedAgain)).toMatchObject({
      capRounds: 14, roundsLeft: 0, paused: true, restart: restartLine,
      reason: expect.stringMatching(/^Manki has reviewed new changes in 14 rounds on this PR, 3 of them after the last review started by hand\. Rounds that/),
    });

    // Every later restart grants the same rounds again.
    const second = [...pausedAgain, byHand(makeRoundContext(15), 'force_review')];
    expect(state(second)).toMatchObject({ roundsLeft: 3, paused: false });
    expect(state([...second, ...rounds(3, 16)])).toMatchObject({ roundsLeft: 0, paused: true });

    // An approval resets the count to the full limit.
    const approved = makeRoundContext(19, { verdict: 'APPROVE' });
    expect(state([...second, ...rounds(3, 16), approved])).toEqual({ capRounds: 0, roundsLeft: 10, capReached: false, paused: false });
    expect(state([...second, ...rounds(3, 16), approved, ...rounds(2, 20)])).toMatchObject({ capRounds: 2, roundsLeft: 8 });

    // A review started by hand while not paused restarts nothing and counts like any other round.
    expect(state([...rounds(3), byHand(makeRoundContext(4)), ...rounds(1, 5)])).toMatchObject({ capRounds: 5, roundsLeft: 5, paused: false });

    // After a blocker came back, the restarted round counts and the cap keeps the rounds it still allows when they are more.
    const early = rounds(4);
    early[3].meta.outcome = 'NOT_CONVERGING';
    expect(state(early)).toMatchObject({ paused: true, capReached: false, restart: 'A review you start by hand also turns automatic review back on for the next 5 rounds.' });
    expect(state([...early, byHand(makeRoundContext(5))])).toMatchObject({ roundsLeft: 5, paused: false });
    const late = rounds(9);
    late[8].meta.outcome = 'NOT_CONVERGING';
    expect(state(late)).toMatchObject({ roundsLeft: 1, paused: true, restart: restartLine });
    expect(state([...late, byHand(makeRoundContext(10))])).toMatchObject({ roundsLeft: 3, paused: false });

    // A restarted round that ends `NOT_CONVERGING` pauses again at once.
    const blockedAgain = byHand(makeRoundContext(11));
    blockedAgain.meta.outcome = 'NOT_CONVERGING';
    expect(state([...capped, blockedAgain])).toMatchObject({ roundsLeft: 3, paused: true, reason: 'The last Manki round found a blocker that came back after a fix.' });

    // With the cap off, a restart turns automatic review back on with no limit.
    const uncapped = { ...DEFAULT_CONFIG, max_auto_rounds: 0 };
    expect(state(early, uncapped)).toMatchObject({ roundsLeft: Infinity, restart: 'A review you start by hand also turns automatic review back on.' });
  });
});
