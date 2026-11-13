import * as core from '@actions/core';
import { approveOrSayWhy, fetchBotReviewThreads, fetchHeldWarnings, fixedMarker, checkAndAutoApprove, holdApproval, pauseState, reopenAuthorResolvedThreads, retireStaleNotices, BOT_MARKER, ReviewThread, unclearedThreads } from './state';
import { PreviousFinding, REOPENED_MARKER, securityOverrideMarker } from './recap';
import { LAST_PAGE, makeFindingFingerprintEntry, makeRoundContext, paginateSinglePage, TEST_BOT, TEST_LINKS } from './test-utils';
import { APPROVED_LINE, formatFindingComment, postReview, titleToSlug } from './github';
import { extractApprovalRecords, formatReviewRecord } from './review-record';
import { DEFAULT_CONFIG, fallbackConfig } from './config';
import { determineOutcome } from './review';
import { ApprovalRecord, AuthorClearRole, Finding, FindingFingerprintEntry, RoundContext, ThreadEvaluation, VerdictTraceEntry } from './types';
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
  dismissPreviousReviews: jest.fn().mockResolvedValue(undefined),
  postAutoApproveProgressComment: jest.fn().mockResolvedValue(12345),
  deleteAutoApproveProgressComment: jest.fn().mockResolvedValue(undefined),
  markProgressCommentFailed: jest.fn().mockResolvedValue(undefined),
}));

const AUTO_REVIEW_OFF = { ...DEFAULT_CONFIG, auto_review: false };
const NOT_REVIEWED_YET = 'Manki has not reviewed `head-sh` yet, and approval follows from the verdict of that review. If no review of it starts, as for a PR from a fork or one that matches a skip rule, comment `@manki review`.';

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
    // Manki's own resolve counts only with a record that says addressed, or after a latest reply from a maintainer other than the PR author.
    expect(unclearedThreads(resolvedBy('manki-review[bot]'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(resolvedBy('manki-review[bot]', { addressed: true }), TEST_BOT, 'author')).toEqual([]);
    expect(unclearedThreads(resolvedBy('manki-review[bot]', { writerReplyLogin: 'alice' }), TEST_BOT, 'author')).toEqual([]);
    expect(unclearedThreads(resolvedBy('manki-review[bot]', { writerReplyLogin: 'author' }), TEST_BOT, 'author')).not.toEqual([]);
    // Neither makes the PR author's own resolve count, also not after a thread was reopened.
    expect(unclearedThreads(resolvedBy('author', { addressed: true, writerReplyLogin: 'alice' }), TEST_BOT, 'author')).not.toEqual([]);
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
  replies?: Array<{ body: string; author: { login: string; __typename?: string } }>;
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
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:null-check --> **Blocker**: null check', databaseId: 501, commit: 'sha-1' }),
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
            // A marker in a fix that Manki's reply quotes is a finder's text.
            { body: `This came up again.\n\n\`\`\`\n${fixedMarker('ef'.repeat(20))}\n\`\`\`\n\n<!-- manki -->\n<!-- manki-found-again -->`, author: { login: 'manki-review' } },
          ],
        }),
      ]),
    );

    const octokit = threadsOctokit(graphqlMock);
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(3);
    expect(threads[0]).toEqual({ id: 't1', rootCommentId: 501, isResolved: false, isBlocking: true, mayCarryBlocker: true, findingTitle: 'null check', place: { file: 'src/a.ts', line: 10, markerSlug: 'null-check', commit: 'sha-1' } });
    expect(threads[1]).toEqual({ id: 't3', isResolved: false, isBlocking: false, isWarning: true, findingTitle: '`parse` drops a field', place: { file: 'src/parse.ts', line: 0, findingLine: 40, markerSlug: '-parse--drops-a-field' } });
    expect(threads[2]).toEqual({ id: 't2', isResolved: true, resolvedByLogin: 'reviewer', writerResolverLogin: 'reviewer', isBlocking: false, findingTitle: 'rename var', place: { file: 'src/a.ts', line: 10, markerSlug: 'rename-var' }, fixedOn: ['ab'.repeat(20)] });
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
    // It also backs Manki's resolve of the security warning it found fixed, so that thread holds nothing.
    const pending = makeRoundContext(4, {
      judge: { summary: '', threadEvaluations: [partly('b', 'warning'), { threadId: 'x', status: 'addressed', reason: 'r' }] },
      findings: { count: 1, severityCounts: {}, entries: [{ fingerprint: { file: 'src/a.ts', lineStart: 3, lineEnd: 3, slug: 'x' }, severity: 'blocker', threadId: 'p' }] },
    });
    const pendingThreads = () => makeGraphqlFetchResponse([
      makeGraphqlFetchThreadNode({ id: 'b', body: formatFindingComment(finding('blocker', 'Real bug'), TEST_LINKS) }),
      makeGraphqlFetchThreadNode({ id: 'p', body: formatFindingComment(finding('warning', 'Plain warning'), TEST_LINKS) }),
      makeGraphqlFetchThreadNode({ id: 'x', body: formatFindingComment(finding('warning', 'Token in log', ['security']), TEST_LINKS), isResolved: true, resolvedBy: 'manki-review[bot]' }),
    ]);
    const graded = await fetchBotReviewThreads(threadsOctokit(graphqlMock.mockResolvedValueOnce(pendingThreads()), reviews), TEST_BOT, 'owner', 'repo', 1, pending);
    expect(graded.map(t => [t.id, t.isBlocking, !!t.isWarning, !!t.addressed])).toEqual([['b', false, true, false], ['p', true, false, false], ['x', false, true, true]]);
    const held = await fetchHeldWarnings(threadsOctokit(graphqlMock.mockResolvedValueOnce(pendingThreads()), reviews), TEST_BOT, 'owner', 'repo', 1, 'author', undefined, pending);
    expect(held.map(t => t.id)).toEqual(['b']);
    // Without every round record or without the threads, a warning thread could be missed, so the read fails rather than return none.
    const recordsUnread = threadsOctokit(graphqlMock.mockResolvedValueOnce(pendingThreads()), reviews);
    jest.mocked(recordsUnread.paginate).mockRejectedValueOnce(new Error('rate limited'));
    await expect(fetchHeldWarnings(recordsUnread, TEST_BOT, 'owner', 'repo', 1, 'author', undefined, pending)).rejects.toThrow('Not every round record could be read');
    await expect(fetchHeldWarnings(threadsOctokit(graphqlMock.mockRejectedValueOnce(new Error('bad gateway')), reviews), TEST_BOT, 'owner', 'repo', 1, 'author', undefined)).rejects.toThrow('bad gateway');
    // A resolved thread that is not a security one, or an open pre-existing one, holds nothing whatever its grade, so missing records do not matter.
    const settled = threadsOctokit(graphqlMock.mockResolvedValueOnce(makeGraphqlFetchResponse([
      makeGraphqlFetchThreadNode({ id: 'p', body: formatFindingComment(finding('warning', 'Plain warning'), TEST_LINKS), isResolved: true }),
      makeGraphqlFetchThreadNode({ id: 'pe', body: formatFindingComment(finding('warning', 'Old race', ['pre-existing']), TEST_LINKS) }),
    ])), reviews);
    jest.mocked(settled.paginate).mockRejectedValueOnce(new Error('rate limited'));
    expect(await fetchHeldWarnings(settled, TEST_BOT, 'owner', 'repo', 1, 'author', undefined, pending)).toEqual([]);
  });

  it('reads what backs a resolved thread: a record that says addressed, a latest reply from a person with write access, or such a person as the resolver', async () => {
    const manki = 'manki-review[bot]';
    const reply = (login: string, __typename?: string) => ({ body: 'Every caller bounds it.', author: { login, ...(__typename && { __typename }) } });
    const resolved = (id: string, replies: ReturnType<typeof reply>[], resolvedBy = manki) => makeGraphqlFetchThreadNode({ id, isResolved: true, resolvedBy, replies });
    const graphql = jest.fn().mockResolvedValueOnce(makeGraphqlFetchResponse([
      resolved('addressed', []),
      resolved('alone', []),
      resolved('writer', [reply('author'), reply('bob'), reply(manki)]),
      resolved('reader', [reply('dave')]),
      resolved('author-last', [reply('bob'), reply('author')]),
      resolved('by-author', [reply('bob')], 'author'),
      // A thread at the comment limit may hide a later reply.
      resolved('cut-off', Array.from({ length: 99 }, () => reply('bob'))),
      // A comment by another bot is no reply by a person, so the maintainer's reply before it still counts.
      resolved('bot-after-writer', [reply('bob'), reply('ci-app', 'Bot')]),
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
    expect(threads.flatMap(t => t.writerReplyLogin ? [[t.id, t.writerReplyLogin]] : [])).toEqual([['writer', 'bob'], ['author-last', 'author'], ['bot-after-writer', 'bob']]);
    expect(threads.flatMap(t => t.writerResolverLogin ? [[t.id, t.writerResolverLogin]] : [])).toEqual([['by-author', 'author'], ['by-writer', 'bob']]);
    expect(unclearedThreads(threads, TEST_BOT, 'author').map(t => t.id)).toEqual(['alone', 'reader', 'author-last', 'by-author', 'cut-off', 'by-reader', 'by-triage', 'by-workflow-token', 'by-bare-workflow-token', 'by-app']);
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
      ]),
    );

    const threads = await fetchBotReviewThreads(threadsOctokit(graphqlMock), TEST_BOT, 'owner', 'repo', 1);

    expect(quoting).toContain(`\`\`\`ts\n${quoted}\n\`\`\``);
    expect(threads.map(t => t.recordedOverride)).toEqual([{ login: 'jdoe_acme', via: 'dismiss' }, undefined, undefined, { login: 'jdoe_acme', via: 'dismiss' }]);
    expect(threads.map(t => [t.isBlocking, t.findingTitle])).toEqual(Array(4).fill([true, 'Token leaks into logs']));
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
      + 'or push a fix and the next Manki review will check it. If the push starts no review, as while automatic review is off or paused, comment `@manki review`.'
      + `\n\n${BOT_MARKER}\n${REOPENED_MARKER}`,
    );

    graphql.mockClear();
    await reopen(graphql, [{ ...previous('T_plain', true), isSecurity: false }]);
    expect(graphql.mock.calls[1][1].body).toMatch(/^Reopened\. A blocking finding needs a maintainer or a fix/);
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
  const { dismissPreviousReviews } = jest.requireMock('./github') as {
    dismissPreviousReviews: jest.Mock;
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
    /** The PR author's `role_name`. */
    role?: string;
    /** The PR diff at each commit, keyed by its SHA, as `compareCommits` against the base returns it. */
    diffs?: Record<string, string>;
    mergeable?: boolean | null;
    draft?: boolean;
  } = {}) {
    const prHeadSha = overrides.prHeadSha ?? 'abc123';
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
          get: jest.fn().mockResolvedValue({ data: { head: { sha: prHeadSha }, base: { ref: 'main' }, user: { login: 'author' }, mergeable: overrides.mergeable, draft: overrides.draft } }),
          createReview: createReviewFn,
          listReviews: jest.fn().mockResolvedValue({ data: existingReviews }),
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: existingComments }),
          createComment: createCommentFn,
          deleteComment: overrides.deleteCommentFn ?? jest.fn().mockResolvedValue({}),
        },
        repos: {
          getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: overrides.role === 'admin' ? 'admin' : 'write', role_name: overrides.role ?? 'write', user: { type: 'User' } } }),
          compareCommits: jest.fn(async ({ head }: { head: string }) => ({ data: overrides.diffs?.[head] ?? '' })),
        },
        checks: overrides.checks ?? { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) },
      },
    } as unknown as Octokit;
  }

  it('approves when all threads including suggestions are resolved', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:note:style --> style', isResolved: true }),
      ],
      prHeadSha: 'sha-456',
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'APPROVE', commit_id: 'sha-456' }));
    const { body } = createReviewMock.mock.calls[0][0] as { body: string };
    expect(body).toMatch(/^\u2705 \*\*Approved\.\*\* All blocking threads are resolved\.\n\n<!-- manki -->\n<!-- manki-auto-approve -->\n<!-- manki-approval-record: /u);
    // The approval review keeps the decision, its reason and the threads it counted.
    expect(extractApprovalRecords(body).map(r => JSON.parse(r) as ApprovalRecord)).toEqual([{
      decision: 'approved', reason: 'all blocking threads are resolved', head: 'sha-456', threads: { total: 2, resolved: 2 },
      timestamp: expect.any(String), mankiVersion: expect.any(String),
    }]);
  });

  describe('the round that covers the head', () => {
    const HEAD = 'head-sha';
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
    const NEXT_ROUND = 'The next review round decides. To start one, tick **Review again** in the settings block, or push a commit. If the push starts no review, as while automatic review is off or paused, comment `@manki review`.';
    const FOLLOWS = 'Approval follows once it is resolved by someone allowed to. The PR author may not clear a blocking thread without the `maintain` role or a higher one.';
    const UNREAD = 'Manki cannot read the record of its review of `head-sh`, so it cannot tell what that review blocked on.';
    const UNNAMED = 'The record of Manki\'s review of `head-sh` does not say what it blocked on.';
    const warning = (posted: FindingFingerprintEntry['posted'], tags = ['follow-up'], holds = posted !== 'earlier_thread'): FindingFingerprintEntry =>
      ({ ...makeFindingFingerprintEntry({ title: 'Retry never stops', file: 'src/lock.ts', posted }), tags, ...(holds && { holds: true as const }) });
    const held = (entries: FindingFingerprintEntry[]) => roundBody(blockingRound(HEAD, { verdict: 'APPROVE', findings: { count: entries.length, severityCounts: {}, entries } }));
    const NO_WARNING_THREAD = 'Manki\'s review of `head-sh` lists 1 warning with no thread, so resolving threads cannot lift its hold on the approval:\n- Retry never stops (`src/lock.ts`)';
    const WARNING_THREAD = '1 warning thread holds the approval:\n- Lock is never released\n\nApproval follows once each one is fixed, resolved, or answered in its thread by the PR author or someone with the `maintain` role or a higher one with a reason to keep it.';
    const HELD_FOR_PERSON = 'Manki\'s review of the head holds its approval for a person and says why, such as files no model read. Resolving threads does not lift that. A person approves, or the next review round decides.';
    const DRAFT = '**Approval held:** this PR is a draft. Mark it ready for review, and Manki approves it if nothing else holds the approval. A head commit without a review is reviewed first. If nothing follows, as for a PR from a fork or a commit pushed while automatic review is off or paused, comment `@manki check`, and Manki approves or says what holds the approval.';
    const GONE_WARNING = 'The record of Manki\'s review of `head-sh` names a thread that does not exist for 1 warning, so resolving threads cannot lift its hold on the approval:\n- Retry never stops (`src/lock.ts`)';

    it.each<[string, string, ReturnType<typeof thread>[], true | string]>([
      ['a new blocker on a changed line, its thread resolved', blocked([blocker({ posted: 'thread' })]), [fixed()], true],
      ['a new blocker on a changed line, its thread open', blocked([blocker({ posted: 'thread' })]), [thread('t1', 'blocker')], 'Not all blocking findings resolved'],
      ['a new blocker on a changed line, its thread resolved beside an open suggestion thread on that line', blocked([blocker({ posted: 'thread' })]), [thread('t0', 'note'), fixed()], true],
      ['a new blocker in a changed file outside the hunks, its file-level thread resolved', blocked([blocker({ posted: 'thread', lineStart: 40 })]), [fixed('t1', 'blocker', { line: null })], true],
      ['a new blocker whose thread is not there yet, was refused or was deleted by hand', blocked([blocker({ posted: 'thread' })]), [], GONE],
      ['a new blocker without its thread, beside a resolved thread an earlier round posted at its place', blocked([blocker({ posted: 'thread' })]), [fixed('t1', 'blocker', { commit: 'older-sha' })], GONE],
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
      ['a record of another commit', roundBody(blockingRound('other-sha')), [fixed()], UNREAD],
      ['the record of an incomplete round', roundBody({ ...blockingRound(HEAD), meta: { ...blockingRound(HEAD).meta, incomplete: true } }), [fixed()], UNREAD],
      ['a round that approved, its thread reopened and resolved again', roundBody(blockingRound(HEAD, { verdict: 'APPROVE', findings: { count: 0, severityCounts: {}, entries: [] } })), [fixed()], true],
      ['a round held for a warning with no thread, listed in its body', held([warning('body')]), [fixed()], NO_WARNING_THREAD],
      ['a round whose blocker thread is resolved, with a warning GitHub refused as a thread', blocked([blocker({ posted: 'thread' }), warning('body')]), [fixed()], NO_WARNING_THREAD],
      ['a round held for a warning thread, resolved', held([warning('thread')]), [fixed('t1', 'warning', { title: 'Retry never stops' })], true],
      ['a round held for a warning whose thread is not there, was refused or was deleted by hand', held([warning('thread')]), [fixed('t1', 'blocker')], GONE_WARNING],
      ['a round held for a warning left to an open thread that is gone', held([{ ...warning('earlier_thread', ['follow-up'], true), threadId: 'gone' }]), [], GONE_WARNING],
      ['a round held for a warning left to an open thread, resolved', held([{ ...warning('earlier_thread', ['follow-up'], true), threadId: 't1' }]), [fixed('t1', 'warning')], true],
      ['a round with a pre-existing warning listed in its body', held([warning('body', ['follow-up', 'pre-existing'], false)]), [fixed()], true],
      ['a round with a warning listed in its body that its record does not mark as holding, as before 7.5', held([warning('body', ['follow-up'], false)]), [fixed()], true],
      ['a round with a warning left to its answered thread', held([warning('earlier_thread')]), [fixed()], true],
    ])('%s', async (_label, body, threads, outcome) => {
      const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
      jest.spyOn(core, 'warning').mockImplementation(() => {});
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({});
      const octokit = makeMockOctokit({
        threads, prHeadSha: HEAD, mergeable: true, createReviewFn: createReviewMock, createCommentFn: createCommentMock,
        // An earlier round on the head, whose blocker has a thread, never decides for the newest one.
        existingReviews: [{ id: 6, body: roundBody(blockingRound(HEAD)), state: 'COMMENTED', commit_id: HEAD, user }, { id: 7, body, state: 'COMMENTED', commit_id: HEAD, user }],
      });

      const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
      expect(result.approved).toBe(outcome === true);
      expect(createReviewMock.mock.calls.map(([args]) => args.event)).toEqual(outcome === true ? ['APPROVE'] : []);
      // The event path says why in the log and posts nothing on the PR.
      expect(createCommentMock).not.toHaveBeenCalled();
      if (result.approved || outcome === true) return;
      expect(infoSpy.mock.calls.map(([line]) => line).join('\n')).toContain(outcome);
      // The `check` command gets the threads that block, or why resolving threads cannot lift the block.
      const reply = await result.why();
      if (outcome.includes('resolved')) expect(reply).toMatch(/^1 thread blocks the approval:\n- Lock is never released.*\n\nApproval follows once it is resolved by someone allowed to\./);
      else expect(reply).toBe(`${outcome.startsWith('names') ? 'The record of Manki\'s review of `head-sh` ' : ''}${outcome}\n\n${NEXT_ROUND}`);
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
      /** Posts a round whose blocker sits outside the hunks of its file, so its file-level thread follows the review. `comment` gets the review body. */
      const post = async (comment: (submitted: string) => Promise<unknown>, updateReview = jest.fn(), description = 'd') => {
        const createReview = jest.fn().mockResolvedValue({ data: { id: 7 } });
        const createReviewComment = jest.fn(() => comment(createReview.mock.calls[0][0].body as string));
        const failure = await postReview({ rest: { pulls: { createReview, createReviewComment, updateReview } } } as unknown as Octokit, 'owner', 'repo', 1, HEAD,
          { verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: '', findings: [{ severity: 'blocker', title: 'Lock is never released', file: 'src/lock.ts', line: 40, description, reviewers: [] }], highlights: [], reviewComplete: true, agentNames: [] },
          { files: [{ path: 'src/lock.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, content: '' }] }], totalAdditions: 1, totalDeletions: 0 },
          blockingRound(HEAD, { findings: { count: 1, severityCounts: {}, entries: [blocker({ lineStart: 40 })] } }),
        ).then(() => undefined, (error: Error) => error.message);
        return { body: createReview.mock.calls[0][0].body as string, failure, updateReview };
      };
      const refuse = () => Promise.reject(Object.assign(new Error('refused'), { status: 422 }));
      const held = () => expect(infoSpy).toHaveBeenLastCalledWith(`The record of Manki's review of \`head-sh\` ${GONE}\nSkipping auto-approve, the next review round decides`);

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
      const approving = roundBody(blockingRound('sha-1', { verdict: 'APPROVE', findings: { count: 0, severityCounts: {}, entries: [] } }));
      const restated = `${APPROVED_LINE} No change to this PR since the reviewed commit \`sha-1\`. The previous verdict stands.\n\n<!-- manki-bot -->`;
      // Round 1 approved `sha-1`, a push without a change got the approval again on `sha-2`, and another one made `sha-3` the head.
      const check = async (second: { body: string; state: string }, threads = [fixed()]) => {
        const createReviewMock = jest.fn().mockResolvedValue({});
        const octokit = makeMockOctokit({
          threads, prHeadSha: 'sha-3', mergeable: true, createReviewFn: createReviewMock, diffs: { 'sha-2': change, 'sha-3': change },
          existingReviews: [{ id: 1, body: approving, state: 'DISMISSED', commit_id: 'sha-1', user }, { id: 2, ...second, commit_id: 'sha-2', user }],
        });
        Object.assign(octokit.rest.issues, { listEventsForTimeline: jest.fn().mockResolvedValue({ data: [{ dismissed_review: { review_id: 2, state: 'approved', dismissal_commit_id: 'sha-3' } }] }) });
        return [await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG), createReviewMock.mock.calls.map(([args]) => [args.event, args.commit_id])];
      };
      const unread = 'Manki cannot read the record of its review of `sha-2`, so it cannot tell what that review blocked on.';

      // The second push dismissed the approval, so the check approves the head again.
      expect(await check({ body: restated, state: 'DISMISSED' })).toEqual([true, [['APPROVE', 'sha-3']]]);
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
      const first = blockingRound('sha-1', { findings: { count: 1, severityCounts: {}, entries: [outside] } });
      const firstReview = { id: 1, body: roundBody(first), state: 'CHANGES_REQUESTED', commit_id: 'sha-1', user };
      const check = (head: string, existingReviews: typeof firstReview[], threads: ReturnType<typeof thread>[]) => checkAndAutoApprove(
        makeMockOctokit({ threads, prHeadSha: head, mergeable: true, createReviewFn: createReviewMock, existingReviews }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);

      // Round 1 lists the blocker in its body, and its own review starts the check.
      expect(await check('sha-1', [firstReview], [thread('t2', 'note')])).toBe(false);

      // Round 2 cannot read the threads, so it carries the blocker without a finding that restates it.
      const decided = determineOutcome([], first.findings.entries, null);
      expect(decided).toMatchObject({ outcome: 'ADDRESS_FIRST', verdictReason: 'prior_unaddressed' });
      expect(decided.verdictTrace.unresolvedPriors).toEqual([expect.not.objectContaining({ threadId: expect.anything() })]);
      const second = blockingRound('sha-2', { findings: { count: 0, severityCounts: {}, entries: [] }, judge: { summary: '', ...decided } }, 2);
      const reviews = [{ ...firstReview, state: 'DISMISSED' }, { id: 2, body: roundBody(second), state: 'CHANGES_REQUESTED', commit_id: 'sha-2', user }];
      const threads = [fixed('t1'), thread('t2', 'note'), thread('t3', 'note')];
      expect(await check('sha-2', reviews, threads)).toBe(false);

      expect(createReviewMock).not.toHaveBeenCalled();
      const told = 'The record of Manki\'s review of `sha-2` names no thread for 1 blocker, so resolving threads cannot lift the block:\n- Persisters miss the lock (`src/store.ts`)';
      expect(infoSpy).toHaveBeenLastCalledWith(`${told}\nSkipping auto-approve, the next review round decides`);
      // The `check` command gets the same reason, and an approval once a thread of that round carries the blocker.
      const asked = async (existingReviews: typeof reviews, live = threads) => {
        const result = await approveOrSayWhy(makeMockOctokit({ threads: live, prHeadSha: 'sha-2', mergeable: true, createReviewFn: createReviewMock, existingReviews }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
        return result.approved || result.why();
      };
      expect(await asked(reviews)).toBe(`${told}\n\n${NEXT_ROUND}`);
      const withThread = [{ ...reviews[1], body: roundBody(blockingRound('sha-2')) }];
      const own = (commit: string) => [makeGraphqlFetchThreadNode({ isResolved: true, commit })];
      // The same thread on an earlier commit is not that round's.
      expect(await asked(withThread, own('sha-1'))).toBe(`The record of Manki's review of \`sha-2\` names a thread that does not exist for 1 blocker, so resolving threads cannot lift the block:\n- test finding (\`src/a.ts\`)\n\n${NEXT_ROUND}`);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(await asked(withThread, own('sha-2'))).toBe(true);

      // Round 3 lists the blocker again, and the review posts it as a thread on the first changed file.
      createReviewMock.mockClear();
      const relisted: Finding = { severity: 'blocker', title: 'Persisters miss the lock', file: 'src/store.ts', line: 10, description: 'Two writers interleave.', reviewers: [], sameAs: 'src/store.ts:10:10:Persisters-miss-the-lock', raisedIn: 1, relisted: true };
      const third = blockingRound('sha-3', { findings: { count: 1, severityCounts: {}, entries: [blocker({ file: 'src/store.ts', title: relisted.title })] } }, 3);
      const postedReview = jest.fn().mockResolvedValue({ data: { id: 3 } });
      const postedComment = jest.fn().mockResolvedValue({ data: { id: 30 } });
      await postReview({ rest: { pulls: { createReview: postedReview, createReviewComment: postedComment } } } as unknown as Octokit, 'owner', 'repo', 1, 'sha-3',
        { verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: '', findings: [relisted], highlights: [], reviewComplete: true, agentNames: [] },
        { files: [{ path: 'src/api.ts', changeType: 'modified', hunks: [] }], totalAdditions: 1, totalDeletions: 0 }, third);
      expect(postedComment.mock.calls.map(([c]) => c.path)).toEqual(['src/api.ts']);
      expect(postedReview.mock.calls[0][0].body).toMatch(/\*\*Changes requested:\*\* 1 blocker still open from an earlier review\./);
      const withThird = [...reviews.map(r => ({ ...r, state: 'DISMISSED' })), { id: 3, body: postedReview.mock.calls[0][0].body as string, state: 'CHANGES_REQUESTED', commit_id: 'sha-3', user }];
      const carrying = (resolvedBy?: string) => makeGraphqlFetchThreadNode({ id: 't4', path: 'src/api.ts', line: null, body: postedComment.mock.calls[0][0].body as string, isResolved: !!resolvedBy, ...(resolvedBy && { resolvedBy }) });

      expect(await check('sha-3', withThird, [...threads, carrying()])).toBe(false);
      expect(infoSpy).toHaveBeenLastCalledWith(expect.stringContaining('Not all blocking findings resolved'));
      expect(createReviewMock).not.toHaveBeenCalled();
      // Manki's own resolve lifts nothing without a record that confirms the fix. A person who resolves the thread does.
      expect(await check('sha-3', withThird, [...threads, carrying('manki-review[bot]')])).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(await check('sha-3', withThird, [...threads, carrying('maintainer')])).toBe(true);
      expect(createReviewMock).toHaveBeenCalledTimes(1);
    });

    it.each<[string, Parameters<typeof makeMockOctokit>[0], string | { approved: true; standing: true }, { auto_approve: boolean }?]>([
      ['a draft', { draft: true }, '**Approval held:** this PR is a draft. Mark it ready for review, and Manki approves it if nothing else holds the approval. A head commit without a review is reviewed first. If nothing follows, as for a PR from a fork or a commit pushed while automatic review is off or paused, comment `@manki check`, and Manki approves or says what holds the approval.'],
      ['a draft with `auto_approve` off, where marking it ready approves nothing', { draft: true }, '**Approval held:** this PR is a draft. Mark it ready for review, then tick Review again in the settings block. `auto_approve` is off, so Manki approves only in a review round, and that round approves the PR if nothing holds the approval.', { auto_approve: false }],
      // The title comes from the model, so its links must not reach the comment.
      ['an open blocking thread', { threads: [makeGraphqlFetchThreadNode({ url: 'https://github.com/o/r/pull/1#r1', body: `<!-- manki:blocker:x --> **Blocker**\n\n<!-- manki-finding: ${JSON.stringify({ title: 'Null deref in [`parse`](https://example.com)' })} -->` })] },
        `1 thread blocks the approval:\n- [Null deref in \`parse\`](https://github.com/o/r/pull/1#r1)\n\n${FOLLOWS}`],
      ['a blocking thread the PR author resolved', { threads: [makeGraphqlFetchThreadNode({ isResolved: true, resolvedBy: 'author' })] },
        `1 thread blocks the approval:\n- test finding (resolved by \`author\`, who may not clear it)\n\n${FOLLOWS}`],
      ['a blocking thread Manki resolved with no addressed record and no reply from a maintainer', { threads: [makeGraphqlFetchThreadNode({ isResolved: true, resolvedBy: 'manki-review[bot]' })] },
        `1 thread blocks the approval:\n- test finding (Manki resolved it, but no review record confirms a fix, and the latest reply is not from a maintainer other than the PR author)\n\n${FOLLOWS}`],
      ['a blocking thread Manki resolved that is at the comment limit', { threads: [makeGraphqlFetchThreadNode({ isResolved: true, resolvedBy: 'manki-review[bot]', replies: Array.from({ length: 99 }, () => ({ body: 'Every caller bounds it.', author: { login: 'bob' } })) })] },
        `1 thread blocks the approval:\n- test finding (Manki resolved it, but no review record confirms a fix, and the thread has too many comments for Manki to read its latest reply, so someone other than the PR author with write access has to reopen it and resolve it)\n\n${FOLLOWS}`],
      ['an open thread the review blocks on though its marker says note',
        { threads: [thread('t1', 'note')], existingReviews: [{ id: 7, body: blocked([], [prior('t1')]), state: 'CHANGES_REQUESTED', commit_id: HEAD, user }] },
        `1 thread blocks the approval:\n- Lock is never released (Manki's latest review blocks on this thread)\n\n${FOLLOWS}`],
      ['open blocking threads beside a blocker no thread carries', {
        threads: [thread('t1', 'blocker'), thread('t2', 'blocker', 'author', { title: 'Second' })],
        existingReviews: [{ id: 7, body: blocked([blocker({ posted: 'thread' }), blocker({ posted: 'thread', title: 'Second' }), blocker({ posted: 'body', title: 'Other', file: 'src/b.ts' })]), state: 'CHANGES_REQUESTED', commit_id: HEAD, user }],
      }, `2 threads block the approval:\n- Lock is never released\n- Second (resolved by \`author\`, who may not clear it)\n\nThe record of Manki's review of \`head-sh\` names no thread for 1 blocker, so resolving threads cannot lift the block:\n- Other (\`src/b.ts\`)\n\n${NEXT_ROUND}`],
      ['an open blocking thread on a head no review covers',
        { threads: [thread('t1', 'blocker', undefined, { commit: 'old-sha' })], existingReviews: [{ id: 7, body: roundBody(blockingRound('old-sha')), state: 'CHANGES_REQUESTED', commit_id: 'old-sha', user }] },
        `1 thread blocks the approval:\n- Lock is never released\n\n${NOT_REVIEWED_YET}`],
      ['a head no review covers', { existingReviews: [{ id: 7, body: roundBody(blockingRound('old-sha')), state: 'CHANGES_REQUESTED', commit_id: 'old-sha', user }] },
        NOT_REVIEWED_YET],
      ['an approval that already stands', { existingReviews: [{ id: 7, body: roundBody(roundThatPosted(HEAD, [])), state: 'APPROVED', commit_id: HEAD, user }] }, { approved: true, standing: true }],
      // An open blocking or warning thread declines beside an approval that stands, and neither dismisses that approval.
      ['an open blocking thread beside an approval that stands', { threads: [thread('t1', 'blocker')], existingReviews: [{ id: 7, body: roundBody(roundThatPosted(HEAD, [])), state: 'APPROVED', commit_id: HEAD, user }] },
        `1 thread blocks the approval:\n- Lock is never released\n\n${FOLLOWS}`],
      ['an open warning thread beside an approval that stands', { threads: [thread('t1', 'warning')], existingReviews: [{ id: 7, body: roundBody(roundThatPosted(HEAD, [])), state: 'APPROVED', commit_id: HEAD, user }] },
        '1 warning thread holds the approval:\n- Lock is never released\n\nApproval follows once each one is fixed, resolved, or answered in its thread by the PR author or someone with the `maintain` role or a higher one with a reason to keep it.'],
      ['a review that holds its approval for a person', { existingReviews: [{ id: 7, body: `${roundBody(roundThatPosted(HEAD, []))}\n\n<!-- manki-held-for-person -->`, state: 'COMMENTED', commit_id: HEAD, user }] },
        'Manki\'s review of the head holds its approval for a person and says why, such as files no model read. Resolving threads does not lift that. A person approves, or the next review round decides.'],
      ['a conflict with the base', { mergeable: false }, '**Approval held:** this PR conflicts with `main`. Rebase it, and Manki reviews the result. If the push starts no review, as while automatic review is off or paused, comment `@manki review`.'],
      // Every reason that holds is named at once, blocking threads first, then warning threads, then the other holds.
      ['an open warning thread beside a review that holds its approval for a person', {
        threads: [thread('t1', 'warning')], existingReviews: [{ id: 7, body: `${roundBody(roundThatPosted(HEAD, []))}\n\n<!-- manki-held-for-person -->`, state: 'COMMENTED', commit_id: HEAD, user }],
      }, `${WARNING_THREAD}\n\n${HELD_FOR_PERSON}`],
      ['an open warning thread beside a warning the review lists with no thread', { threads: [thread('t1', 'warning')], existingReviews: [{ id: 7, body: held([warning('body')]), state: 'COMMENTED', commit_id: HEAD, user }] },
        `${NO_WARNING_THREAD}\n\n${NEXT_ROUND}\n\n${WARNING_THREAD}`],
      ['an open warning thread on a head no review covers',
        { threads: [thread('t1', 'warning', undefined, { commit: 'old-sha' })], existingReviews: [{ id: 7, body: roundBody(blockingRound('old-sha')), state: 'CHANGES_REQUESTED', commit_id: 'old-sha', user }] },
        `${NOT_REVIEWED_YET}\n\n${WARNING_THREAD}`],
      ['an open blocking thread and an open warning thread on a draft that conflicts', { threads: [thread('t1', 'blocker'), thread('t2', 'warning', undefined, { title: 'Retry never stops' })], draft: true, mergeable: false },
        `1 thread blocks the approval:\n- Lock is never released\n\n${FOLLOWS}\n\n${WARNING_THREAD.replace('Lock is never released', 'Retry never stops')}\n\n${DRAFT}`],
      ['an open warning thread on a PR that conflicts', { threads: [thread('t1', 'warning')], mergeable: false },
        `${WARNING_THREAD}\n\n**Approval held:** this PR conflicts with \`main\`. Rebase it, and Manki reviews the result. If the push starts no review, as while automatic review is off or paused, comment \`@manki review\`.`],
    // A rest parameter, since jest takes a named one the row lacks for its `done` callback.
    ])('tells a person who asks why there is no approval: %s', async (_label, setup, reply, ...[config]) => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      jest.spyOn(core, 'warning').mockImplementation(() => {});
      const createReviewMock = jest.fn().mockResolvedValue({});
      const result = await approveOrSayWhy(makeMockOctokit({ prHeadSha: HEAD, mergeable: true, createReviewFn: createReviewMock, ...setup }), TEST_BOT, 'owner', 'repo', 1, { ...DEFAULT_CONFIG, ...config });
      expect(result.approved ? result : await result.why()).toEqual(reply);
      expect(createReviewMock).not.toHaveBeenCalled();
    });
  });

  it('holds an approval on a draft with one notice per head, and on the event draft state when the PR cannot be read', async () => {
    const createCommentMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({ draft: true, mergeable: true, createCommentFn: createCommentMock });

    expect(await holdApproval(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-9')).toBe('draft');
    expect(createCommentMock.mock.calls.map(([c]) => c.body)).toEqual([
      '**Approval held:** this PR is a draft. Mark it ready for review, and Manki approves it if nothing else holds the approval. A head commit without a review is reviewed first. If nothing follows, as for a PR from a fork or a commit pushed while automatic review is off or paused, comment `@manki check`, and Manki approves or says what holds the approval.\n\n<!-- manki-approval-held:sha-9 -->',
    ]);
    // With `auto_approve` off the notice promises no approval for marking the PR ready.
    createCommentMock.mockClear();
    expect(await holdApproval(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-8', false, false)).toBe('draft');
    expect(createCommentMock.mock.calls.map(([c]) => c.body)).toEqual([
      '**Approval held:** this PR is a draft. Mark it ready for review, then tick Review again in the settings block. `auto_approve` is off, so Manki approves only in a review round, and that round approves the PR if nothing holds the approval.\n\n<!-- manki-approval-held:sha-8 -->',
    ]);
    expect(await holdApproval(makeMockOctokit({ mergeable: true }), TEST_BOT, 'owner', 'repo', 1, 'sha-9')).toBe(false);
    const unreadable = makeMockOctokit({ mergeable: true });
    jest.mocked(unreadable.rest.pulls.get).mockRejectedValue(new Error('API down'));
    expect(await holdApproval(unreadable, TEST_BOT, 'owner', 'repo', 1, 'sha-9', true)).toBe('draft');
    expect(await holdApproval(unreadable, TEST_BOT, 'owner', 'repo', 1, 'sha-9')).toBe(false);
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

  it('holds the approval of a PR that conflicts with its base, with one notice per head, and reports each outcome', async () => {
    const resolved = [makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true })];
    const createReviewMock = jest.fn().mockResolvedValue({});
    const createCommentMock = jest.fn().mockResolvedValue({});
    const notice = '**Approval held:** this PR conflicts with `main`. Rebase it, and Manki reviews the result. If the push starts no review, as while automatic review is off or paused, comment `@manki review`.\n\n<!-- manki-approval-held:sha-456 -->';

    const first = makeMockOctokit({ threads: resolved, prHeadSha: 'sha-456', mergeable: false, createReviewFn: createReviewMock, createCommentFn: createCommentMock });
    expect(await checkAndAutoApprove(first, TEST_BOT, 'owner', 'repo', 1)).toBe(false);
    const [posted] = createCommentMock.mock.calls.map(([c]) => c.body as string);
    expect(posted).toMatch(/^\*\*Approval held:\*\* this PR conflicts with `main`\. Rebase it, and Manki reviews the result\. If the push starts no review, as while automatic review is off or paused, comment `@manki review`\.\n\n<!-- manki-approval-record: .+ -->\n\n<!-- manki-approval-held:sha-456 -->$/);
    expect(extractApprovalRecords(posted).map(r => JSON.parse(r) as ApprovalRecord)).toEqual([expect.objectContaining({ decision: 'held', reason: 'conflict', head: 'sha-456', threads: { total: 1, resolved: 1 } })]);

    const again = makeMockOctokit({
      threads: resolved, prHeadSha: 'sha-456', mergeable: false, createReviewFn: createReviewMock, createCommentFn: createCommentMock,
      existingComments: [{ body: notice, user: { login: 'manki-review[bot]' } }],
    });
    expect(await checkAndAutoApprove(again, TEST_BOT, 'owner', 'repo', 1)).toBe(false);
    expect(createCommentMock).toHaveBeenCalledTimes(1);
    expect(createReviewMock).not.toHaveBeenCalled();

    const clean = makeMockOctokit({ threads: resolved, prHeadSha: 'sha-456', mergeable: true, createReviewFn: createReviewMock, createCommentFn: createCommentMock });
    expect(await checkAndAutoApprove(clean, TEST_BOT, 'owner', 'repo', 1)).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'APPROVE', commit_id: 'sha-456' }));
    expect(jest.mocked(authModule.reportPrState).mock.calls).toEqual([
      ['owner', 'repo', 1, { approval: { commit: 'sha-456', held: true } }],
      ['owner', 'repo', 1, { approval: { commit: 'sha-456', held: true } }],
      ['owner', 'repo', 1, { approval: { commit: 'sha-456', held: false }, pause: null }],
    ]);
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
    const reply = (threadId: string) => ({ threadId, body: `Finding dismissed by @author, the PR author, who has the \`${role}\` role on this repository.\n\n<!-- manki -->\n<!-- manki-security-override:resolve:author -->` });
    expect(replies.map(([, vars]) => vars)).toEqual(byAuthor ? [...(recorded ? [] : [reply('t1')]), reply('t2')] : []);
    // The resolver's write access is asked once for both threads, and the role lookup of an author who resolved reuses that answer.
    expect(octokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(1);
    if (approves) {
      const line = `**Findings dismissed by the PR author:** [Token leaks into logs](https://github.com/o/r/pull/1#r1) by @author (\`${role}\` role), [Off by one](https://github.com/o/r/pull/1#r2) by @author (\`${role}\` role).`;
      expect(createReviewMock.mock.calls[0][0].body.includes(line)).toBe(byAuthor);
    }
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
    const HEAD = 'head-sha';
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

    it.each<[string, ReturnType<typeof makeGraphqlFetchThreadNode>[], string?]>([
      ['an open warning thread', [warning('t1')]],
      ['a warning thread a bot replied in', [warning('t1', { replies: [reply('ci-app', 'Looks fine.', 'Bot')] })]],
      ['a warning thread only Manki replied in', [warning('t1', { replies: [reply('manki-review[bot]', 'Kept. The retry still loops.')] })]],
      ['a warning thread a person without the role replied in', [warning('t1', { replies: [reply('bob')] })], 'write'],
      ['a security warning thread the PR author replied in', [warning('t1', { replies: [reply('author')] }, ['security'])]],
      ['a security warning thread the PR author resolved without the role', [warning('t1', { isResolved: true, resolvedBy: 'author' }, ['security'])]],
      ['a second warning thread nobody answered', [warning('t1', { isResolved: true }), warning('t2')]],
      ['a warning thread the PR author only asked a question in', [warning('t1', { replies: [reply('author', 'Why would the caller pass more than three?  ')] })]],
      ['a warning thread the PR author only sent a command in', [warning('t1', { replies: [reply('author', '@manki explain why this matters')] })]],
      ['a warning thread the PR author addressed Manki in mid-sentence', [warning('t1', { replies: [reply('author', 'It is bounded, so (@Manki-review) please drop it.')] })]],
      ['a warning thread the PR author sent a `/manki` line in', [warning('t1', { replies: [reply('author', 'It is bounded.\n  /manki dismiss')] })]],
      ['a warning thread the PR author sent a mid-line command in', [warning('t1', { replies: [reply('author', 'ok - /manki explain the retry')] })]],
      ['a late warning thread with the header and note of a thread posted while warnings did not hold', [warning('t1', {
        body: formatFindingComment({ severity: 'warning', title: 'Retry t1', file: 'src/a.ts', line: 10, description: 'd', reviewers: [], origin: 'reviewed', tags: ['follow-up'] }, TEST_LINKS)
          .replace('**Warning, needs an answer**', '**Warning, not blocking**')
          .replace('_An earlier round already reviewed these lines and missed this. It is in this PR\'s own code, so it still needs a fix or an answer._', '_An earlier round already reviewed these lines and missed this, and it doesn\'t block this PR._'),
      })]],
    ])('holds the approval while it is %s', async (_label, threads, role = 'write') => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      const { approved, why, events } = await check(threads, role);
      expect(approved).toBe(false);
      expect(events).toEqual([]);
      const held = threads.at(-1)!.id;
      expect(why).toMatch(new RegExp(`^1 warning thread holds the approval:\\n- \\[Retry ${held}\\]\\(https://example\\.com/${held}\\)`));
      expect(why).toContain('Approval follows once each one is fixed, resolved, or answered in its thread by the PR author or someone with the `maintain` role or a higher one with a reason to keep it.');
    });

    it.each<[string, ReturnType<typeof makeGraphqlFetchThreadNode>[], string?]>([
      ['resolved by anyone', [warning('t1', { isResolved: true, resolvedBy: 'author' })]],
      ['resolved by Manki after a round found it fixed', [warning('t1', { isResolved: true, resolvedBy: 'manki-review[bot]' })]],
      ['answered by the PR author, whatever Manki replied', [warning('t1', { replies: [reply('author'), reply('manki-review[bot]', 'Kept. The retry still loops.')] })]],
      ['answered by a person with the role `author_clear_role` allows', [warning('t1', { replies: [reply('maria')] })], 'maintain'],
      ['a security warning a maintainer resolved', [warning('t1', { isResolved: true, resolvedBy: 'maria' }, ['security'])]],
      ['the last of several, all answered', [warning('t1', { isResolved: true }), warning('t2', { replies: [reply('author')] })]],
      ['answered by the PR author after a question and a command', [warning('t1', { replies: [reply('author', 'Why?'), reply('author', '/manki explain'), reply('author')] })]],
      // Only a command counts as one: a path, a link or a quoted command in a reason does not.
      ['answered with a reason that names a path', [warning('t1', { replies: [reply('author', 'The caller in src/manki.ts bounds it.')] })]],
      ['answered with a reason that links the Manki repository', [warning('t1', { replies: [reply('author', 'See https://github.com/manki-review/manki/blob/main/src/recap.ts, the caller bounds it.')] })]],
      ['answered with a reason that quotes a command as code', [warning('t1', { replies: [reply('author', 'It is bounded, so `@manki dismiss` is not needed.')] })]],
      // Neither a pre-existing defect nor a suggestion holds, though nobody answered them.
      ['answered, beside an open pre-existing warning and an open suggestion', [
        warning('t1', { replies: [reply('author')] }), warning('t2', {}, ['pre-existing']), makeGraphqlFetchThreadNode({ id: 't3', body: '<!-- manki:note:style --> style' }),
      ]],
    ])('approves once the warning thread is %s', async (_label, threads, role = 'write') => {
      const { approved, events, body } = await check(threads, role);
      expect(approved).toBe(true);
      expect(events).toEqual(['APPROVE']);
      expect(body).toMatch(/^\u2705 \*\*Approved\.\*\* All blocking threads are resolved, and every warning thread is resolved or answered\.\n/u);
    });

    it('counts only a reply made after the review that lowered a blocker thread to a warning was posted', async () => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      const lowered = (replies: ReturnType<typeof reply>[]) => makeGraphqlFetchThreadNode({
        id: 't1', url: 'https://example.com/t1', body: formatFindingComment({ severity: 'blocker', title: 'Retry t1', file: 'src/a.ts', line: 10, description: 'd', reviewers: [] }, TEST_LINKS), replies,
      });
      const evaluations = [{ threadId: 't1', status: 'partly_addressed' as const, reason: 'Capped, but the cap is too high.', grade: 'warning' as const }];
      const round = blockingRound(HEAD, { verdict: 'APPROVE', findings: { count: 0, severityCounts: {}, entries: [] }, judge: { summary: '', threadEvaluations: evaluations } }, 2);
      const reviews = (submitted?: string) => [{ id: 7, body: roundBody(round), state: 'COMMENTED', commit_id: HEAD, user, submitted_at: submitted ?? '' }];
      const posted = '2026-11-12T10:00:00Z';
      // A reply to the blocker, made before the round lowered it, does not answer the warning.
      const before = await check([lowered([reply('author', 'It is bounded by the caller.', undefined, '2026-11-12T09:59:00Z')])], 'write', false, reviews(posted));
      expect([before.approved, before.events]).toEqual([false, []]);
      expect(before.why).toMatch(/^1 warning thread holds the approval:\n- \[Retry t1\]/);
      // Without the time the review was posted, no reply counts.
      const unknown = await check([lowered([reply('author', 'It is bounded by the caller.', undefined, '2026-11-12T10:01:00Z')])], 'write', false, reviews());
      expect(unknown.approved).toBe(false);
      // Neither does a reply whose own time is unknown.
      expect((await check([lowered([reply('author')])], 'write', false, reviews(posted))).approved).toBe(false);
      const after = await check([lowered([reply('author', 'It is bounded by the caller.', undefined, '2026-11-12T10:01:00Z')])], 'write', false, reviews(posted));
      expect([after.approved, after.events]).toEqual([true, ['APPROVE']]);
    });

    it('holds the approval when the round records cannot be read, since the thread then counts as blocking', async () => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      jest.spyOn(core, 'warning').mockImplementation(() => {});
      const { approved, events } = await check([warning('t1', { replies: [reply('author')] })], 'write', true);
      expect([approved, events]).toEqual([false, []]);
    });

    it('names the warning threads that hold beside an open blocking thread', async () => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      const blocker = makeGraphqlFetchThreadNode({
        id: 'b1', url: 'https://example.com/b1', body: formatFindingComment({ severity: 'blocker', title: 'Lost write', file: 'src/a.ts', line: 10, description: 'd', reviewers: [] }, TEST_LINKS),
      });
      const { approved, why } = await check([blocker, warning('t1'), warning('t2', { replies: [reply('author')] })]);
      expect(approved).toBe(false);
      expect(why).toContain('[Lost write](https://example.com/b1)');
      expect(why).toMatch(/\n\n1 warning thread holds the approval:\n- \[Retry t1\]\(https:\/\/example\.com\/t1\)\n/);
      // With every warning answered, the reply names only what blocks.
      expect((await check([blocker, warning('t2', { replies: [reply('author')] })])).why).not.toContain('warning thread');
    });
  });

  it.each([
    ['in a check it creates completed', undefined, 0],
    ['in the queued check on the head, completed in one update', 'abc123', 0],
    ['in a check it creates when the queued check sits on another head', 'def456', 0],
    ['in a check it creates, then completes the queued check, when its first update fails', 'abc123', 1],
    ['in a check it creates when the queued check cannot be updated at all', 'abc123', 2],
  ])('reports the approval as a passing `Manki` check on the head %s', async (_name, queuedHead, updateFailures) => {
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const checks = { create: jest.fn().mockResolvedValue({ data: { id: 901 } }), update: jest.fn().mockResolvedValue({}) };
    for (let i = 0; i < updateFailures; i++) checks.update.mockRejectedValueOnce(new Error('Not Found'));
    const octokit = makeMockOctokit({ threads: [], checks });
    if (queuedHead) offerQueuedCheck(octokit, { id: 77, headSha: queuedHead });
    expect(await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1)).toBe(true);

    // Each call writes a completed check, so a failed takeover still leaves a passing check newest on the head.
    const completed = { status: 'completed', conclusion: 'success', details_url: expect.any(String), output: { title: 'Approved', summary: 'All blocking threads are resolved.' } };
    const takesOver = queuedHead === 'abc123';
    const updateQueued = [{ owner: 'owner', repo: 'repo', check_run_id: 77, ...completed }];
    expect(checks.update.mock.calls).toEqual(takesOver ? (updateFailures ? [updateQueued, updateQueued] : [updateQueued]) : []);
    expect(checks.create.mock.calls).toEqual(takesOver && !updateFailures ? [] : [[{ owner: 'owner', repo: 'repo', name: 'Manki', head_sha: 'abc123', ...completed }]]);
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
    const octokit = makeMockOctokit({ checks, createReviewFn: createReviewMock, existingReviews: [{ id: 7, body: roundBody(roundThatPosted('abc123', [])), state: 'APPROVED', commit_id: 'abc123', user }] });
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

    expect(checks.listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: 'abc123', check_name: 'Manki', filter: 'all' }));
    expect(checks.create.mock.calls).toEqual(reports ? [[expect.objectContaining({
      head_sha: 'abc123', status: 'completed', conclusion: 'success', output: { title: 'Approved', summary: 'Manki\'s approval of this commit stands.' },
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
      prHeadSha: 'sha-789',
      createReviewFn: createReviewMock,
      createCommentFn: createCommentMock,
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    // A refused approval is held, as in a review round.
    expect(result).toBe(false);
    expect(jest.mocked(authModule.reportPrState)).toHaveBeenCalledWith('owner', 'repo', 1, { approval: { commit: 'sha-789', held: true } });
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
    expect(extractApprovalRecords(notice).map(r => JSON.parse(r) as ApprovalRecord)).toEqual([expect.objectContaining({ decision: 'held', reason: 'refused', head: 'sha-789' })]);
    expect(dismissPreviousReviews).not.toHaveBeenCalled();
  });

  it('posts the refusal notice once per head, and a later verdict or approval retires it', async () => {
    const refusal = 'All blocking threads are resolved, but repository settings block the approval. Enable "Allow GitHub Actions to create and approve pull requests" in the repo settings, or approve by hand.';
    const resolved = [makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: true })];
    const createReviewMock = jest.fn().mockRejectedValue(new Error(SETTING_REFUSAL));
    const createCommentMock = jest.fn().mockResolvedValue({});
    const check = (prHeadSha: string, existing: string[] = []) => approveOrSayWhy(makeMockOctokit({
      threads: resolved, prHeadSha, mergeable: true, createReviewFn: createReviewMock, createCommentFn: createCommentMock,
      existingComments: existing.map(body => ({ body, user: { login: 'manki-review[bot]' } })),
    }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);

    const first = await check('sha-789');
    expect(first).toMatchObject({ approved: false, answered: true });
    const [posted] = createCommentMock.mock.calls.map(([c]) => c.body as string);
    expect(posted.startsWith(`${refusal}\n\n<!-- manki-approval-record: `)).toBe(true);
    expect(posted.endsWith(' -->\n\n<!-- manki-approval-held:sha-789:refused -->')).toBe(true);

    // A second check on the head posts nothing, so a person who asked gets the notice as the reply.
    const again = await check('sha-789', [posted]);
    expect(createCommentMock).toHaveBeenCalledTimes(1);
    expect(again.approved).toBe(false);
    expect(again).not.toHaveProperty('answered');
    expect(await (again as { why: () => Promise<string> }).why()).toBe(refusal);

    // A new head gets its own notice, and the draft or conflict notice of that head does not stand in for it.
    await check('sha-790', [posted, '**Approval held:** this PR is a draft.\n\n<!-- manki-approval-held:sha-790 -->']);
    expect(createCommentMock).toHaveBeenCalledTimes(2);
    expect(createCommentMock.mock.calls[1][0].body).toContain('<!-- manki-approval-held:sha-790:refused -->');

    const deleteComment = jest.fn().mockResolvedValue({});
    const listed = { paginate: jest.fn(paginateSinglePage), rest: { issues: {
      listComments: jest.fn().mockResolvedValue({ data: [{ id: 11, body: posted, user: { login: 'manki-review[bot]' }, updated_at: '2025-01-01T00:00:00Z' }] }),
      deleteComment,
    } } } as unknown as Octokit;
    await retireStaleNotices(listed, TEST_BOT, 'owner', 'repo', 1, 'sha-791');
    expect(deleteComment).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', comment_id: 11 });

    // Once the setting allows it, the approval of the head retires the notice too.
    const deleteOnApproval = jest.fn().mockResolvedValue({});
    const approved = await approveOrSayWhy(makeMockOctokit({
      threads: resolved, prHeadSha: 'sha-789', mergeable: true, deleteCommentFn: deleteOnApproval,
      existingComments: [{ id: 12, body: posted, user: { login: 'manki-review[bot]' } }],
    }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
    expect(approved).toEqual({ approved: true });
    expect(deleteOnApproval).toHaveBeenCalledWith({ owner: 'owner', repo: 'repo', comment_id: 12 });
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
      prHeadSha: 'sha-vis',
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
      prHeadSha: 'abc123',
      createReviewFn: createReviewMock,
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', commit_id: 'abc123', user: { login: 'manki-review[bot]', type: 'Bot' } },
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
    const octokit = makeMockOctokit({ threads: [], prHeadSha: 'abc123', createReviewFn: createReviewMock, existingReviews: older });
    (octokit.paginate as unknown as jest.Mock).mockResolvedValueOnce([
      ...older,
      { body: '<!-- manki -->', state: 'APPROVED', commit_id: 'abc123', user: bot },
    ]);

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.pulls.listReviews, expect.objectContaining({ per_page: 100 }));
    expect(createReviewMock).not.toHaveBeenCalled();
  });

  it('creates new approval when latest bot review is CHANGES_REQUESTED', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [makeGraphqlFetchThreadNode({ isResolved: true })],
      prHeadSha: 'sha-new',
      createReviewFn: createReviewMock,
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', commit_id: 'sha-new', user: { login: 'manki-review[bot]', type: 'Bot' } },
        { body: roundBody(blockingRound('sha-new')), state: 'CHANGES_REQUESTED', commit_id: 'sha-new', user: { login: 'manki-review[bot]', type: 'Bot' } },
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
      prHeadSha: 'sha-new',
      createReviewFn: createReviewMock,
      createCommentFn: createCommentMock,
      existingReviews: [
        { body: '<!-- manki -->', state: 'DISMISSED', commit_id: 'sha-new', user: { login: 'manki-review[bot]', type: 'Bot' } },
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
      prHeadSha: 'head-sha-aaaa',
      createCommentFn,
      existingReviews: (roundBodies.length > 0 ? roundBodies : ['']).map(extra => (
        { body: `<!-- manki -->\n${extra}`, state: 'COMMENTED', commit_id: 'old-sha-bbbb', user: { login: 'manki-review[bot]', type: 'Bot' } }
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
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('head=head-sha-aaaa'));
      expect(createCommentMock).not.toHaveBeenCalled();
    });

    const notConverging = makeRoundContext(1);
    notConverging.meta.outcome = 'NOT_CONVERGING';
    it.each([
      ['the last round did not converge', DEFAULT_CONFIG, [formatReviewRecord(notConverging)], 'The last Manki round found a blocker that came back after a fix. Automatic review is paused. Tick **Review again** in the settings block', 'automatic_pause'],
      ['the round cap is reached', DEFAULT_CONFIG, Array.from({ length: 10 }, (_, i) => formatReviewRecord(makeRoundContext(i + 1))), 'Manki has reviewed new changes in 10/10 rounds on this PR. Rounds that keep finding problems usually mean the approach needs another look, so step back and reconsider it before pushing more fixes. Automatic review is paused. Tick **Review again** in the settings block, or comment `@manki review`, to review it. A review you start by hand also turns automatic review back on for the next 3 rounds.', 'automatic_pause'],
      ['automatic review is off', AUTO_REVIEW_OFF, [], 'Automatic review is off for this repository (`auto_review: false`). Comment `@manki review` to review it.', 'auto_review_off'],
    ])('posts one withheld notice with the reason when %s', async (_label, config, roundBodies, reason, cause) => {
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = staleHeadOctokit(createCommentMock, roundBodies);

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, config);

      expect(result).toBe(false);
      expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(createCommentMock).toHaveBeenCalledTimes(1);
      const { body, issue_number } = createCommentMock.mock.calls[0][0] as { body: string; issue_number: number };
      expect(issue_number).toBe(1);
      expect(body).toContain('**Auto-approve withheld** for `head-sh`');
      expect(body).toContain('Its latest review was on `old-sha`.');
      expect(body).toContain(reason);
      expect(body).toContain('<!-- manki-stale-approve:head-sha-aaaa -->');
      // The record names the cause in a fixed word, so the stats count one cause on one row.
      expect(extractApprovalRecords(body).map(r => JSON.parse(r) as ApprovalRecord)).toEqual([expect.objectContaining({ decision: 'withheld', reason: cause, head: 'head-sha-aaaa' })]);
    });

    it('still approves when the latest manki review is on the current HEAD, even with automatic review paused by the round cap', async () => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = makeMockOctokit({
        threads: [
          makeGraphqlFetchThreadNode({ id: 't1', isResolved: true }),
        ],
        prHeadSha: 'head-sha-aaaa',
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        existingReviews: [1, 2, 3, 4, 5].map(n => ({
          body: roundBody(n === 5 ? blockingRound('head-sha-aaaa', {}, 5) : makeRoundContext(n)), state: n === 5 ? 'CHANGES_REQUESTED' : 'COMMENTED',
          commit_id: n === 5 ? 'head-sha-aaaa' : `old-sha-${n}`, user: { login: 'manki-review[bot]', type: 'Bot' },
        })),
      });

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);

      expect(result).toBe(true);
      expect(createReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVE', commit_id: 'head-sha-aaaa' }),
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
        prHeadSha: 'head-sha-aaaa',
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        existingReviews: [
          { body: '<!-- manki -->', state: 'COMMENTED', commit_id: 'old-sha-bbbb', user: { login: 'manki-review[bot]', type: 'Bot' } },
        ],
        existingComments: [
          { body: '<!-- manki-stale-approve:head-sha-aaaa -->\nAuto-approve withheld...', user: { login: 'manki-review[bot]' } },
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
      ['on the head', [heldReview('head-sha')]],
      ['on an earlier commit with the same change, such as before an empty commit', [heldReview('old-sha')]],
      ['on the head under a later round that gave no verdict', [heldReview('head-sha'), { body: 'Incomplete\n\n<!-- manki-no-verdict -->\n\n<!-- manki -->\n<!-- manki-bot -->', state: 'COMMENTED', commit_id: 'head-sha', user: { login: 'manki-review[bot]', type: 'Bot' } }]],
    ])('skips approval when the review that covers the head holds its approval for a person, %s', async (_label, existingReviews) => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const octokit = makeMockOctokit({
        threads: [],
        prHeadSha: 'head-sha',
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
        prHeadSha: 'head-sha',
        createReviewFn: createReviewMock,
        existingReviews: [
          { body: '<!-- manki -->', state: 'APPROVED', commit_id: 'old-sha', user: { login: 'manki-review[bot]', type: 'Bot' } },
          // An incomplete round carries its record, which makes it no more of a verdict.
          { body: '**Review incomplete**\n\n<!-- manki-context: {"meta":{"round":1,"mankiVersion":"7","incomplete":true}} -->\n\n<!-- manki-no-verdict -->\n\n<!-- manki -->', state: 'COMMENTED', commit_id: 'head-sha', user: { login: 'manki-review[bot]', type: 'Bot' } },
          // The review command reads an incomplete round by its first line, so that alone makes it no verdict here too.
          { body: '⏸️ **Review incomplete:** The judge failed.\n\n<!-- manki -->', state: 'COMMENTED', commit_id: 'head-sha', user: { login: 'manki-review[bot]', type: 'Bot' } },
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
        prHeadSha: 'new-sha',
        createReviewFn: createReviewMock,
        existingReviews: [
          { body: '<!-- manki -->', state: 'APPROVED', commit_id: 'old-sha', user: { login: 'manki-review[bot]', type: 'Bot' } },
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
        prHeadSha: 'head-sha-new',
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        existingReviews: [
          { body: '<!-- manki -->', state: 'DISMISSED', commit_id: 'old-sha', user: { login: 'manki-review[bot]', type: 'Bot' } },
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
        body: expect.stringContaining('<!-- manki-stale-approve:head-sha-new -->'),
      }));
    });

    it('skips approval when no bot reviews exist at all', async () => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = makeMockOctokit({
        threads: [],
        prHeadSha: 'sha-fresh',
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
    it.each([
      ['approves the head when its PR diff equals the reviewed commit\'s, as after a rebase', rebaseDiff, true],
      ['withholds approval when the head changes the PR diff', rebaseDiff.replace('+new', '+newer'), false],
    ])('%s', async (_label, headDiff, approves) => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = makeMockOctokit({
        threads: [makeGraphqlFetchThreadNode({ id: 't1', isResolved: true, commit: 'old-sha-bbbb' })],
        prHeadSha: 'head-sha-aaaa',
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        existingReviews: [
          { body: `<!-- manki-bot -->\n${formatReviewRecord(blockingRound('old-sha-bbbb'))}`, state: 'CHANGES_REQUESTED', commit_id: 'old-sha-bbbb', user: { login: 'manki-review[bot]', type: 'Bot' } },
        ],
        diffs: { 'old-sha-bbbb': rebaseDiff, 'head-sha-aaaa': headDiff },
      });

      const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
      expect(result.approved).toBe(approves);
      expect(createReviewMock.mock.calls.map(([args]) => [args.event, args.commit_id])).toEqual(approves ? [['APPROVE', 'head-sha-aaaa']] : []);
      expect(createCommentMock).not.toHaveBeenCalled();
      if (!result.approved) expect(await result.why()).toBe(NOT_REVIEWED_YET);
    });

    it('explains an unreviewed head by the pause, the Pause box, or by the review still to come', async () => {
      const asked = async (octokit: Octokit) => {
        const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
        return result.approved || result.why();
      };
      const notice = () => jest.fn().mockResolvedValue({ data: { id: 1 } });
      expect(await asked(staleHeadOctokit(notice(), [formatReviewRecord(notConverging)])))
        .toMatch(/^Manki has not reviewed `head-sh`\. The last Manki round found a blocker that came back after a fix\. Automatic review is paused\./);
      jest.mocked(authModule.fetchPrState).mockResolvedValueOnce({ settings: { paused: true }, runModes: new Set(), queuedModes: new Set() });
      expect(await asked(staleHeadOctokit(notice(), [])))
        .toBe('Manki has not reviewed `head-sh`. Automatic review is paused in the settings block. Tick **Review again** there, or comment `@manki review`, to review it. Untick **Pause automatic reviews** to lift the pause.');
      expect(await asked(staleHeadOctokit(notice(), [])))
        .toBe(NOT_REVIEWED_YET);

      // A token service that cannot say whether the PR is paused must not end in the promise of a push review.
      const unknown = notice();
      jest.mocked(authModule.fetchPrState).mockRejectedValueOnce(new Error('HTTP 503'));
      expect(await asked(staleHeadOctokit(unknown, [])))
        .toBe('Manki has not reviewed `head-sh`. Manki could not read whether automatic review is paused for this PR. If no review of the commit starts, tick **Review again** in the settings block, or comment `@manki review`.');
      expect(unknown.mock.calls[0][0].body).toContain('**Auto-approve withheld** for `head-sh`');
      expect(unknown.mock.calls[0][0].body).toContain('"reason":"pause_unknown"');

      // A pause the rounds show is certain, so it wins over the unknown Pause box.
      jest.mocked(authModule.fetchPrState).mockRejectedValueOnce(new Error('HTTP 503'));
      expect(await asked(staleHeadOctokit(notice(), [formatReviewRecord(notConverging)])))
        .toMatch(/^Manki has not reviewed `head-sh`\. The last Manki round found a blocker that came back after a fix\. Automatic review is paused\./);
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
    const prHeadSha = overrides.prHeadSha ?? 'sha-x';
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
          listReviews: jest.fn().mockResolvedValue({ data: existingReviews }),
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

    await checkAndAutoApprove(makeMockOctokit({ comments: [failedOn(55, 'sha-x'), failedOn(56, 'sha-old')] }), TEST_BOT, 'owner', 'repo', 1);
    expect(ghMock.postAutoApproveProgressComment).toHaveBeenLastCalledWith(expect.anything(), 'owner', 'repo', 1, 'sha-x', 55);

    // A failure on an earlier head stays, and the new head gets its own comment.
    await checkAndAutoApprove(makeMockOctokit({ comments: [failedOn(56, 'sha-old')] }), TEST_BOT, 'owner', 'repo', 1);
    expect(ghMock.postAutoApproveProgressComment).toHaveBeenLastCalledWith(expect.anything(), 'owner', 'repo', 1, 'sha-x', undefined);
  });

  it('does not post a marker when unresolved findings remain', async () => {
    const octokit = {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: false }),
      ])),
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-x' } } }),
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
      prHeadSha: 'sha-x',
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', commit_id: 'sha-x', user: { login: 'manki-review[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(ghMock.postAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.deleteAutoApproveProgressComment).not.toHaveBeenCalled();
  });

  it.each([
    ['the issue-comment fallback also fails', SETTING_REFUSAL, 'comment also forbidden'],
    ['GitHub refuses it for a reason other than the repo setting', 'Review cannot be submitted', 'Review cannot be submitted'],
  ])('transitions the marker to a failure state when APPROVE fails and %s', async (_label, refusal, reason) => {
    const createReviewMock = jest.fn().mockRejectedValueOnce(new Error(refusal));
    const createCommentMock = jest.fn().mockRejectedValueOnce(new Error('comment also forbidden'));
    const octokit = makeMockOctokit({ createReviewFn: createReviewMock, createCommentFn: createCommentMock });

    await expect(checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1)).rejects.toThrow(reason);
    expect(ghMock.markProgressCommentFailed).toHaveBeenCalledWith(
      octokit, 'owner', 'repo', 7777, 'Auto-approve', reason, undefined, [ghActualMarker('sha-x')],
    );
    expect(createCommentMock).toHaveBeenCalledTimes(refusal === SETTING_REFUSAL ? 1 : 0);
    expect(ghMock.deleteAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.dismissPreviousReviews).not.toHaveBeenCalled();
  });

  it('deletes the progress comment and keeps the settings notice when repository settings refuse the approval', async () => {
    const createReviewMock = jest.fn().mockRejectedValueOnce(new Error(SETTING_REFUSAL));
    const createCommentMock = jest.fn().mockResolvedValueOnce({});
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

    await ghActual.postAutoApproveProgressComment(octokit, 'o', 'r', 1, 'sha-x');

    expect(saveState).toHaveBeenCalledWith('manki_progress_comment', '1');
    expect(postedBody).toContain('Auto-approving');
    expect(postedBody).toContain(ghActual.autoApproveHeadMarker('sha-x'));
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

    expect(await ghActual.postAutoApproveProgressComment(octokit, 'o', 'r', 1, 'sha-x', 55)).toBe(55);
    expect([body.startsWith('**Auto-approving:**'), createComment.mock.calls.length]).toEqual([true, 0]);

    await ghActual.markProgressCommentFailed(octokit, 'o', 'r', 55, 'Auto-approve', 'boom', undefined, [ghActual.autoApproveHeadMarker('sha-x')]);
    const comment = { id: 55, body, user: { login: 'manki-review[bot]', type: 'Bot' } } as Parameters<typeof ghActual.failedAutoApproveId>[0][number];
    expect([ghActual.failedAutoApproveId([comment], TEST_BOT, 'sha-x'), ghActual.failedAutoApproveId([comment], TEST_BOT, 'sha-y')]).toEqual([55, undefined]);
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

  it('turns automatic review back on for `rounds_after_restart` rounds after a review started by hand while paused', () => {
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

    // `0` keeps a restart to the one round asked for.
    const once = { ...DEFAULT_CONFIG, convergence: { ...DEFAULT_CONFIG.convergence, rounds_after_restart: 0 } };
    expect(state(capped, once)).not.toHaveProperty('restart');
    expect(state(restarted, once)).toMatchObject({ capRounds: 11, roundsLeft: 0, paused: true, reason: expect.stringMatching(/^Manki has reviewed new changes in 11 rounds on this PR\. Rounds that/) });

    // After a blocker came back, the restarted round counts and the cap keeps the rounds it still allows when they are more.
    const early = rounds(4);
    early[3].meta.outcome = 'NOT_CONVERGING';
    expect(state(early)).toMatchObject({ paused: true, capReached: false, restart: 'A review you start by hand also turns automatic review back on for the next 5 rounds.' });
    expect(state([...early, byHand(makeRoundContext(5))])).toMatchObject({ roundsLeft: 5, paused: false });
    expect(state([...early, byHand(makeRoundContext(5))], once)).toMatchObject({ roundsLeft: 5, paused: false });
    expect(state(early, once)).toMatchObject({ restart: 'A review you start by hand also turns automatic review back on for the next 5 rounds.' });
    const late = rounds(9);
    late[8].meta.outcome = 'NOT_CONVERGING';
    expect(state(late)).toMatchObject({ roundsLeft: 1, paused: true, restart: restartLine });
    expect(state([...late, byHand(makeRoundContext(10))])).toMatchObject({ roundsLeft: 3, paused: false });

    // A restarted round that ends `NOT_CONVERGING` pauses again at once.
    const blockedAgain = byHand(makeRoundContext(11));
    blockedAgain.meta.outcome = 'NOT_CONVERGING';
    expect(state([...capped, blockedAgain])).toMatchObject({ roundsLeft: 3, paused: true, reason: 'The last Manki round found a blocker that came back after a fix.' });

    // With the cap off, a restart turns automatic review back on with no limit.
    const uncapped = { ...DEFAULT_CONFIG, convergence: { ...DEFAULT_CONFIG.convergence, max_auto_rounds: 0 } };
    expect(state(early, uncapped)).toMatchObject({ roundsLeft: Infinity, restart: 'A review you start by hand also turns automatic review back on.' });
  });
});
