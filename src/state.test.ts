import * as core from '@actions/core';
import { approveOrSayWhy, fetchBotReviewThreads, fixedMarker, checkAndAutoApprove, holdApproval, pauseState, reopenAuthorResolvedThreads, BOT_MARKER, ReviewThread, unclearedThreads } from './state';
import { PreviousFinding, REOPENED_MARKER, securityOverrideMarker } from './recap';
import { LAST_PAGE, makeFindingFingerprintEntry, makeRoundContext, paginateSinglePage, TEST_BOT, TEST_LINKS } from './test-utils';
import { APPROVED_LINE, formatFindingComment, postReview, titleToSlug } from './github';
import { extractApprovalRecords, formatReviewRecord } from './review-record';
import { DEFAULT_CONFIG, fallbackConfig } from './config';
import { determineOutcome } from './review';
import { ApprovalRecord, AuthorClearRole, Finding, FindingFingerprintEntry, RoundContext, ThreadEvaluation, VerdictTraceEntry } from './types';
import * as authModule from './auth';

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
  ...(overrides.isResolved && { resolvedByLogin: 'reviewer' }),
  ...overrides,
});


/** An octokit that serves review threads from `graphql` and lists `reviews`, whose round records grade the threads. */
function threadsOctokit(graphql: jest.Mock, reviews: unknown[] = []): Octokit {
  return { graphql, paginate: jest.fn().mockResolvedValue(reviews), rest: { pulls: { listReviews: jest.fn() } } } as unknown as Octokit;
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
    expect(unclearedThreads(resolvedBy('author'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(resolvedBy('dependabot[bot]'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(resolvedBy(undefined), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(resolvedBy('alice'), TEST_BOT, 'author')).toEqual([]);
    // Manki's own resolve counts only with a record that says addressed, or after a latest reply from a maintainer other than the PR author.
    expect(unclearedThreads(resolvedBy('manki-review[bot]'), TEST_BOT, 'author')).not.toEqual([]);
    expect(unclearedThreads(resolvedBy('manki-review[bot]', { addressed: true }), TEST_BOT, 'author')).toEqual([]);
    expect(unclearedThreads(resolvedBy('manki-review[bot]', { writerReplyLogin: 'alice' }), TEST_BOT, 'author')).toEqual([]);
    expect(unclearedThreads(resolvedBy('manki-review[bot]', { writerReplyLogin: 'author' }), TEST_BOT, 'author')).not.toEqual([]);
    // Neither makes the PR author's own resolve count, also not after a thread was reopened.
    expect(unclearedThreads(resolvedBy('author', { addressed: true, writerReplyLogin: 'alice' }), TEST_BOT, 'author')).not.toEqual([]);
    // With the PR author unknown, any human resolver has write access.
    expect(unclearedThreads(resolvedBy('alice'), TEST_BOT)).toEqual([]);
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
  replies?: Array<{ body: string; author: { login: string } }>;
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
          ],
        }),
      ]),
    );

    const octokit = threadsOctokit(graphqlMock);
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(3);
    expect(threads[0]).toEqual({ id: 't1', rootCommentId: 501, isResolved: false, isBlocking: true, findingTitle: 'null check', place: { file: 'src/a.ts', line: 10, markerSlug: 'null-check', commit: 'sha-1' } });
    expect(threads[1]).toEqual({ id: 't3', isResolved: false, isBlocking: false, findingTitle: '`parse` drops a field', place: { file: 'src/parse.ts', line: 0, findingLine: 40, markerSlug: '-parse--drops-a-field' } });
    expect(threads[2]).toEqual({ id: 't2', isResolved: true, resolvedByLogin: 'reviewer', isBlocking: false, findingTitle: 'rename var', place: { file: 'src/a.ts', line: 10, markerSlug: 'rename-var' }, fixedOn: ['ab'.repeat(20)] });
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
    expect(threads.map(t => [t.id, t.isBlocking])).toEqual([['s', false], ['w', false], ['p', false], ['x', false], ['b', true], ['f', true], ['h', false], ['pw', false], ['pb', true], ['pf', true], ['ps', true], ['pr', true], ['pa', true], ['l', false]]);
    expect(threads.find(t => t.id === 'x')?.isSecurity).toBe(true);
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
    expect(unreadThreads.map(t => [t.id, t.isBlocking])).toEqual([['s', true], ['l', true]]);
    expect(unclearedThreads(unreadThreads, TEST_BOT).map(t => t.id)).toEqual(['l']);
  });

  it('reads what backs a thread Manki resolved: a record that says addressed, or a latest reply from someone with write access', async () => {
    const manki = 'manki-review[bot]';
    const reply = (login: string) => ({ body: 'Every caller bounds it.', author: { login } });
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
    ]));
    const octokit = threadsOctokit(graphql, [{ id: 1, user: { login: manki }, body: `<!-- manki-context: ${JSON.stringify(makeRoundContext(1, {
      judge: { summary: '', threadEvaluations: [{ threadId: 'addressed', status: 'addressed', reason: 'r' }, { threadId: 'alone', status: 'not_addressed', reason: 'r' }] },
    }))} -->` }]);
    const permissions: Record<string, string> = { author: 'write', bob: 'write', dave: 'read' };
    Object.assign(octokit.rest, { repos: { getCollaboratorPermissionLevel: jest.fn(async ({ username }: { username: string }) => ({ data: { permission: permissions[username] } })) } });

    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads.flatMap(t => t.addressed ? [t.id] : [])).toEqual(['addressed']);
    expect(threads.flatMap(t => t.writerReplyLogin ? [[t.id, t.writerReplyLogin]] : [])).toEqual([['writer', 'bob'], ['author-last', 'author']]);
    expect(unclearedThreads(threads, TEST_BOT, 'author').map(t => t.id)).toEqual(['alone', 'reader', 'author-last', 'by-author', 'cut-off']);
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
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: security, replies: [reply('jdoe_acme', 'manki-review[bot]')] }),
        makeGraphqlFetchThreadNode({ id: 't2', body: security, replies: [reply('mallory', 'mallory')] }),
      ]),
    );

    const threads = await fetchBotReviewThreads(threadsOctokit(graphqlMock), TEST_BOT, 'owner', 'repo', 1);

    expect(threads.map(t => t.recordedOverride)).toEqual([{ login: 'jdoe_acme', via: 'dismiss' }, undefined]);
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

  const reopen = (graphql: jest.Mock, previousFindings: PreviousFinding[], config = DEFAULT_CONFIG, priorRounds: RoundContext[] = []) =>
    reopenAuthorResolvedThreads({ graphql } as unknown as Octokit, TEST_BOT, 'owner', 'repo', 1, config, { previousFindings, priorRounds });

  it('reopens, then replies with the markers, for flagged threads only', async () => {
    const graphql = jest.fn().mockResolvedValue({});

    await reopen(graphql, [previous('T_author', true), previous('T_other', false)]);

    expect(graphql.mock.calls.map(mutation)).toEqual([
      ['unresolveReviewThread', 'T_author'],
      ['addPullRequestReviewThreadReply', 'T_author'],
    ]);
    expect(graphql.mock.calls[1][1].body).toMatch(/^Reopened\. A security finding needs a maintainer or a fix/);
    expect(graphql.mock.calls[1][1].body).toContain('push a fix and the next Manki review will check it');
    expect(graphql.mock.calls[1][1].body.endsWith(`\n\n${BOT_MARKER}\n${REOPENED_MARKER}`)).toBe(true);

    graphql.mockClear();
    await reopen(graphql, [{ ...previous('T_plain', true), isSecurity: false }]);
    expect(graphql.mock.calls[1][1].body).toMatch(/^Reopened\. A blocking finding needs a maintainer or a fix/);

    // With nothing to reopen, the settings are not read.
    jest.mocked(authModule.fetchPrState).mockClear();
    await reopen(graphql, [previous('T_other', false)]);
    expect(authModule.fetchPrState).not.toHaveBeenCalled();
  });

  // A push starts no review then, so the reply asks for `@manki review`.
  it.each<[string, string, typeof DEFAULT_CONFIG, number, boolean]>([
    ['the round cap is reached', 'paused', DEFAULT_CONFIG, 10, false],
    ['`auto_review` is off', 'off', AUTO_REVIEW_OFF, 1, false],
    ['the Pause box is ticked', 'paused', DEFAULT_CONFIG, 1, true],
  ])('asks for the review command when %s', async (_label, word, config, rounds, boxTicked) => {
    const graphql = jest.fn().mockResolvedValue({});
    if (boxTicked) jest.mocked(authModule.fetchPrState).mockResolvedValueOnce({ settings: { paused: true }, runModes: new Set(), queuedModes: new Set() });

    await reopen(graphql, [previous('T_author', true)], config, Array.from({ length: rounds }, (_, i) => makeRoundContext(i + 1)));

    const reply = graphql.mock.calls[1][1].body;
    expect(reply).toContain(`Automatic review is ${word}, so after pushing a fix comment \`@manki review\` and Manki will check it.`);
    expect(reply).not.toContain('push a fix and the next Manki review will check it');
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
    checks?: { create: jest.Mock; update: jest.Mock };
    existingReviews?: Array<{ id?: number; body?: string; state?: string; commit_id?: string; user?: { login?: string; type?: string } }>;
    existingComments?: Array<{ body?: string; user?: { login?: string } }>;
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
        },
        repos: {
          getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: overrides.role === 'admin' ? 'admin' : 'write', role_name: overrides.role ?? 'write' } }),
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
    const NEXT_ROUND = 'The next review round decides. Push a commit or comment `@manki review` to start one.';
    const FOLLOWS = 'Approval follows once it is resolved by someone allowed to. The PR author may not clear a blocking thread without the `maintain` role or a higher one.';
    const UNREAD = 'Manki cannot read the record of its review of `head-sh`, so it cannot tell what that review blocked on.';
    const UNNAMED = 'The record of Manki\'s review of `head-sh` does not say what it blocked on.';

    it.each<[string, string, ReturnType<typeof thread>[], true | string]>([
      ['a new blocker on a changed line, its thread resolved', blocked([blocker({ posted: 'thread' })]), [fixed()], true],
      ['a new blocker on a changed line, its thread open', blocked([blocker({ posted: 'thread' })]), [thread('t1', 'blocker')], 'Not all blocking findings resolved'],
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
      // The blocker sits outside the hunks of its file, where an open warning thread with its title already is.
      const posted = jest.fn().mockResolvedValue({ data: { id: 7 } });
      const postedComment = jest.fn().mockResolvedValue({ data: { id: 70 } });
      await postReview({ rest: { pulls: { createReview: posted, createReviewComment: postedComment } } } as unknown as Octokit, 'owner', 'repo', 1, HEAD,
        { verdict: 'REQUEST_CHANGES', outcome: 'ADDRESS_FIRST', summary: '', findings: [{ severity: 'blocker', title, file: 'src/lock.ts', line: 40, description: 'd', reviewers: [] }], highlights: [], reviewComplete: true, agentNames: [] },
        { files: [{ path: 'src/lock.ts', changeType: 'modified', hunks: [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, content: '' }] }], totalAdditions: 1, totalDeletions: 0 },
        blockingRound(HEAD, { findings: { count: 1, severityCounts: {}, entries: [blocker({ lineStart: 40 })] } }), undefined,
        { existingThreads: [{ title, file: 'src/lock.ts', line: 0, severity: 'warning', status: 'open', threadId: 't1', markerSlug: titleToSlug(title) }] });
      expect(postedComment).not.toHaveBeenCalled();
      const body = posted.mock.calls[0][0].body as string;

      const createReviewMock = jest.fn().mockResolvedValue({});
      const check = async (threads: ReturnType<typeof thread>[]) => {
        const octokit = makeMockOctokit({ threads, prHeadSha: HEAD, mergeable: true, createReviewFn: createReviewMock, existingReviews: [{ id: 7, body, state: 'CHANGES_REQUESTED', commit_id: HEAD, user }] });
        const result = await approveOrSayWhy(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
        return result.approved || result.why();
      };
      // The record names the thread, so it blocks though its own marker says warning, and the check reply names that thread and no missing one.
      expect(await check([thread('t1', 'warning')])).toBe(`1 thread blocks the approval:\n- Lock is never released\n\n${FOLLOWS}`);
      expect(infoSpy).toHaveBeenLastCalledWith(expect.stringContaining('Not all blocking findings resolved'));
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(await check([fixed('t1', 'warning')])).toBe(true);
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

    it('never approves a blocker without a thread from the review its own round submits, as on a body-only blocker carried after a fix push', async () => {
      const infoSpy = jest.spyOn(core, 'info').mockImplementation(() => {});
      const createReviewMock = jest.fn().mockResolvedValue({});
      const outside = blocker({ posted: 'body', file: 'src/store.ts', title: 'Persisters miss the lock' });
      const first = blockingRound('sha-1', { findings: { count: 1, severityCounts: {}, entries: [outside] } });
      const firstReview = { id: 1, body: roundBody(first), state: 'CHANGES_REQUESTED', commit_id: 'sha-1', user };
      const check = (head: string, existingReviews: typeof firstReview[], threads: ReturnType<typeof thread>[]) => checkAndAutoApprove(
        makeMockOctokit({ threads, prHeadSha: head, mergeable: true, createReviewFn: createReviewMock, existingReviews }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);

      // Round 1 lists the blocker in its body, and its own review starts the check.
      expect(await check('sha-1', [firstReview], [thread('t2', 'note')])).toBe(false);

      // The fix push touches the blocker's file, and round 2 carries the blocker without a finding that restates it.
      const decided = determineOutcome([], first.findings.entries, [], new Set(), [], new Map(), new Set(['src/store.ts']));
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
    });

    it.each<[string, Parameters<typeof makeMockOctokit>[0], string | { approved: true; standing: true }]>([
      ['a draft', { draft: true }, '**Approval held:** this PR is a draft. Mark it ready for review, and Manki reviews it again.'],
      // The title comes from the model, so its links must not reach the comment.
      ['an open blocking thread', { threads: [makeGraphqlFetchThreadNode({ url: 'https://github.com/o/r/pull/1#r1', body: `<!-- manki:blocker:x --> **Blocker**\n\n<!-- manki-finding: ${JSON.stringify({ title: 'Null deref in [`parse`](https://example.com)' })} -->` })] },
        `1 thread blocks the approval:\n- [Null deref in \`parse\`](https://github.com/o/r/pull/1#r1)\n\n${FOLLOWS}`],
      ['a blocking thread the PR author resolved', { threads: [makeGraphqlFetchThreadNode({ isResolved: true, resolvedBy: 'author' })] },
        `1 thread blocks the approval:\n- test finding (resolved by \`author\`, who may not clear it)\n\n${FOLLOWS}`],
      ['a blocking thread Manki resolved with no addressed record and no reply from a maintainer', { threads: [makeGraphqlFetchThreadNode({ isResolved: true, resolvedBy: 'manki-review[bot]' })] },
        `1 thread blocks the approval:\n- test finding (Manki resolved it, but no review record confirms a fix, and the latest reply is not from a maintainer other than the PR author)\n\n${FOLLOWS}`],
      ['an open thread the review blocks on though its marker says note',
        { threads: [thread('t1', 'note')], existingReviews: [{ id: 7, body: blocked([], [prior('t1')]), state: 'CHANGES_REQUESTED', commit_id: HEAD, user }] },
        `1 thread blocks the approval:\n- Lock is never released (Manki's latest review blocks on this thread)\n\n${FOLLOWS}`],
      ['open blocking threads beside a blocker no thread carries', {
        threads: [thread('t1', 'blocker'), thread('t2', 'blocker', 'author', { title: 'Second' })],
        existingReviews: [{ id: 7, body: blocked([blocker({ posted: 'thread' }), blocker({ posted: 'thread', title: 'Second' }), blocker({ posted: 'body', title: 'Other', file: 'src/b.ts' })]), state: 'CHANGES_REQUESTED', commit_id: HEAD, user }],
      }, `2 threads block the approval:\n- Lock is never released\n- Second (resolved by \`author\`, who may not clear it)\n\nThe record of Manki's review of \`head-sh\` names no thread for 1 blocker, so resolving threads cannot lift the block:\n- Other (\`src/b.ts\`)\n\n${NEXT_ROUND}`],
      ['an open blocking thread on a head no review covers',
        { threads: [thread('t1', 'blocker', undefined, { commit: 'old-sha' })], existingReviews: [{ id: 7, body: roundBody(blockingRound('old-sha')), state: 'CHANGES_REQUESTED', commit_id: 'old-sha', user }] },
        '1 thread blocks the approval:\n- Lock is never released\n\nManki has not reviewed `head-sh` yet. A push review should start shortly, and approval follows from its verdict.'],
      ['a head no review covers', { existingReviews: [{ id: 7, body: roundBody(blockingRound('old-sha')), state: 'CHANGES_REQUESTED', commit_id: 'old-sha', user }] },
        'Manki has not reviewed `head-sh` yet. A push review should start shortly, and approval follows from its verdict.'],
      ['an approval that already stands', { existingReviews: [{ id: 7, body: roundBody(roundThatPosted(HEAD, [])), state: 'APPROVED', commit_id: HEAD, user }] }, { approved: true, standing: true }],
      ['a review that holds its approval for a person', { existingReviews: [{ id: 7, body: `${roundBody(roundThatPosted(HEAD, []))}\n\n<!-- manki-held-for-person -->`, state: 'COMMENTED', commit_id: HEAD, user }] },
        'Manki\'s review of the head holds its approval for a person and says why, such as files no model read. Resolving threads does not lift that. A person approves, or the next review round decides.'],
      ['a conflict with the base', { mergeable: false }, '**Approval held:** this PR conflicts with `main`. Rebase it, and Manki reviews the result.'],
    ])('tells a person who asks why there is no approval: %s', async (_label, setup, reply) => {
      jest.spyOn(core, 'info').mockImplementation(() => {});
      jest.spyOn(core, 'warning').mockImplementation(() => {});
      const createReviewMock = jest.fn().mockResolvedValue({});
      const result = await approveOrSayWhy(makeMockOctokit({ prHeadSha: HEAD, mergeable: true, createReviewFn: createReviewMock, ...setup }), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG);
      expect(result.approved ? result : await result.why()).toEqual(reply);
      expect(createReviewMock).not.toHaveBeenCalled();
    });
  });

  it('holds an approval on a draft with one notice per head, and on the event draft state when the PR cannot be read', async () => {
    const createCommentMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({ draft: true, mergeable: true, createCommentFn: createCommentMock });

    expect(await holdApproval(octokit, TEST_BOT, 'owner', 'repo', 1, 'sha-9')).toBe('draft');
    expect(createCommentMock.mock.calls.map(([c]) => c.body)).toEqual([
      '**Approval held:** this PR is a draft. Mark it ready for review, and Manki reviews it again.\n\n<!-- manki-approval-held:sha-9 -->',
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
    const notice = '**Approval held:** this PR conflicts with `main`. Rebase it, and Manki reviews the result.\n\n<!-- manki-approval-held:sha-456 -->';

    const first = makeMockOctokit({ threads: resolved, prHeadSha: 'sha-456', mergeable: false, createReviewFn: createReviewMock, createCommentFn: createCommentMock });
    expect(await checkAndAutoApprove(first, TEST_BOT, 'owner', 'repo', 1)).toBe(false);
    const [posted] = createCommentMock.mock.calls.map(([c]) => c.body as string);
    expect(posted).toMatch(/^\*\*Approval held:\*\* this PR conflicts with `main`\. Rebase it, and Manki reviews the result\.\n\n<!-- manki-approval-record: .+ -->\n\n<!-- manki-approval-held:sha-456 -->$/);
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
    // Only a thread the author resolved or overrode needs the role lookup, and only when the level is known.
    expect(octokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(resolver === 'author' && level ? 1 : 0);
    if (approves) {
      const line = `**Findings dismissed by the PR author:** [Token leaks into logs](https://github.com/o/r/pull/1#r1) by @author (\`${role}\` role), [Off by one](https://github.com/o/r/pull/1#r2) by @author (\`${role}\` role).`;
      expect(createReviewMock.mock.calls[0][0].body.includes(line)).toBe(byAuthor);
    }
  });

  it('approves when blocking threads are resolved and only old suggestion and nitpick threads are open', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:note:style --> style', isResolved: false }),
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

  it('reports the approval as a passing `Manki` check on the head', async () => {
    const checks = { create: jest.fn().mockResolvedValue({ data: { id: 901 } }), update: jest.fn().mockResolvedValue({}) };
    const octokit = makeMockOctokit({ threads: [], checks });
    expect(await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1)).toBe(true);

    expect(checks.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Manki', head_sha: 'abc123', status: 'in_progress' }));
    expect(checks.update).toHaveBeenCalledWith(expect.objectContaining({
      check_run_id: 901, status: 'completed', conclusion: 'success',
      output: { title: 'Approved', summary: 'All blocking threads are resolved.' },
    }));
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

    expect(result).toBe(true);
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
    expect(dismissPreviousReviews).not.toHaveBeenCalled();
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

    expect(dismissPreviousReviews).toHaveBeenCalledWith(octokit, 'owner', 'repo', 42);
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

    const heldReview = (commit: string) => ({ body: '**Changes requested**\n\n<!-- manki-held-for-person --><!-- manki --><!-- manki-bot -->', state: 'CHANGES_REQUESTED', commit_id: commit, user: { login: 'manki-review[bot]', type: 'Bot' } });
    it.each([
      ['on the head', [heldReview('head-sha')]],
      ['on an earlier commit with the same change, such as before an empty commit', [heldReview('old-sha')]],
      ['on the head under a later round that gave no verdict', [heldReview('head-sha'), { body: 'Incomplete\n\n<!-- manki-no-verdict --><!-- manki --><!-- manki-bot -->', state: 'COMMENTED', commit_id: 'head-sha', user: { login: 'manki-review[bot]', type: 'Bot' } }]],
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
          { body: '**Review incomplete**\n\n<!-- manki-context: {"meta":{"round":1,"mankiVersion":"7","incomplete":true}} -->\n\n<!-- manki-no-verdict --><!-- manki -->', state: 'COMMENTED', commit_id: 'head-sha', user: { login: 'manki-review[bot]', type: 'Bot' } },
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
      if (!result.approved) expect(await result.why()).toBe('Manki has not reviewed `head-sh` yet. A push review should start shortly, and approval follows from its verdict.');
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
        .toBe('Manki has not reviewed `head-sh`. Automatic review is paused in the settings block. Untick **Pause automatic reviews** there, or comment `@manki review`, to review it.');
      expect(await asked(staleHeadOctokit(notice(), [])))
        .toBe('Manki has not reviewed `head-sh` yet. A push review should start shortly, and approval follows from its verdict.');
    });
  });
});

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
        },
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
      octokit, 'owner', 'repo', 7777, 'Auto-approve', reason,
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

    expect(result).toBe(true);
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

    await ghActual.postAutoApproveProgressComment(octokit, 'o', 'r', 1);

    expect(saveState).toHaveBeenCalledWith('manki_progress_comment', '1');
    expect(postedBody).toContain('Auto-approving');
    saveState.mockRestore();
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
