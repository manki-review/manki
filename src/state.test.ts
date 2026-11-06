import * as core from '@actions/core';
import { areAllFindingsResolved, fetchBotReviewThreads, checkAndAutoApprove, explainUnreviewedHead, reopenAuthorResolvedThreads, BOT_MARKER, ReviewThread } from './state';
import { PreviousFinding, REOPENED_MARKER, securityOverrideMarker } from './recap';
import { LAST_PAGE, makeRoundContext, paginateSinglePage, TEST_BOT } from './test-utils';
import { formatContextBlock, formatFindingComment, isReviewInProgress } from './github';
import { DEFAULT_CONFIG } from './config';
import { Finding } from './types';

jest.mock('./github', () => ({
  ...jest.requireActual('./github'),
  dismissPreviousReviews: jest.fn().mockResolvedValue(undefined),
  isReviewInProgress: jest.fn().mockResolvedValue(false),
  checkConcurrentSubmissionLock: jest.fn().mockResolvedValue(false),
  postAutoApproveProgressComment: jest.fn().mockResolvedValue(12345),
  markAutoApproveComplete: jest.fn().mockResolvedValue(undefined),
  markProgressCommentFailed: jest.fn().mockResolvedValue(undefined),
}));

const AUTO_REVIEW_OFF = { ...DEFAULT_CONFIG, auto_review: false };

const SETTING_REFUSAL = 'GitHub Actions is not permitted to approve pull requests.';

const makeThread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'thread-1',
  isResolved: false,
  isBlocking: true,
  findingTitle: 'Test finding',
  ...overrides,
});

describe('areAllFindingsResolved', () => {
  it('returns true for an empty array', () => {
    expect(areAllFindingsResolved([], TEST_BOT)).toBe(true);
  });

  it('returns true when all threads are resolved', () => {
    const threads = [
      makeThread({ id: '1', isBlocking: true, isResolved: true }),
      makeThread({ id: '2', isBlocking: false, isResolved: true }),
    ];
    expect(areAllFindingsResolved(threads, TEST_BOT)).toBe(true);
  });

  it('returns false when some blocking threads are unresolved', () => {
    const threads = [
      makeThread({ id: '1', isBlocking: true, isResolved: true }),
      makeThread({ id: '2', isBlocking: true, isResolved: false }),
    ];
    expect(areAllFindingsResolved(threads, TEST_BOT)).toBe(false);
  });

  it('ignores unresolved non-blocking threads', () => {
    const threads = [
      makeThread({ id: '1', isBlocking: true, isResolved: true }),
      makeThread({ id: '2', isBlocking: false, isResolved: false }),
      makeThread({ id: '3', isBlocking: false, isResolved: false }),
    ];
    expect(areAllFindingsResolved(threads, TEST_BOT)).toBe(true);
  });

  it('counts a resolved security thread only for Manki or a human other than the PR author', () => {
    const security = (resolvedByLogin: string) => [makeThread({ isResolved: true, isSecurity: true, resolvedByLogin })];
    expect(areAllFindingsResolved(security('author'), TEST_BOT, 'author')).toBe(false);
    expect(areAllFindingsResolved(security('dependabot[bot]'), TEST_BOT, 'author')).toBe(false);
    expect(areAllFindingsResolved(security('alice'), TEST_BOT, 'author')).toBe(true);
    expect(areAllFindingsResolved(security('github-actions[bot]'), TEST_BOT, 'author')).toBe(true);
    // With the PR author unknown, any human resolver has write access.
    expect(areAllFindingsResolved(security('alice'), TEST_BOT)).toBe(true);
    // A PR author who is a repo admin clears their own.
    expect(areAllFindingsResolved(security('author'), TEST_BOT, 'author', true)).toBe(true);
    expect(areAllFindingsResolved(security('dependabot[bot]'), TEST_BOT, 'author', true)).toBe(false);
    // A recorded override counts only for an admin author, since a Manki reply can echo any text.
    const recorded = [makeThread({ isResolved: true, isSecurity: true, resolvedByLogin: 'author', recordedOverride: { login: 'author', via: 'dismiss' } })];
    expect(areAllFindingsResolved(recorded, TEST_BOT, 'author')).toBe(false);
    expect(areAllFindingsResolved(recorded, TEST_BOT, 'author', true)).toBe(true);
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
} = {}) {
  return {
    id: overrides.id ?? 'thread-1',
    isResolved: overrides.isResolved ?? false,
    ...(overrides.resolvedBy && { resolvedBy: { login: overrides.resolvedBy } }),
    comments: {
      nodes: [{
        ...(overrides.databaseId !== undefined && { databaseId: overrides.databaseId }),
        body: overrides.body ?? '<!-- manki:blocker:test-finding --> **Blocker**: test finding',
        ...(overrides.url && { url: overrides.url }),
        author: overrides.authorLogin !== undefined
          ? (overrides.authorLogin === null ? null : { login: overrides.authorLogin })
          : { login: 'github-actions[bot]' },
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
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:null-check --> **Blocker**: null check', databaseId: 501 }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:suggestion:rename-var --> **Suggestion**: rename var', isResolved: true }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(2);
    expect(threads[0]).toEqual({ id: 't1', rootCommentId: 501, isResolved: false, isBlocking: true, findingTitle: 'null check' });
    expect(threads[1]).toEqual({ id: 't2', isResolved: true, isBlocking: false, findingTitle: 'rename var' });
  });

  it('reads every page of review threads', async () => {
    const nodes = Array.from({ length: 150 }, (_, i) => makeGraphqlFetchThreadNode({ id: `t${i}` }));
    const graphqlMock = jest.fn()
      .mockResolvedValueOnce({ repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: 'p2' }, nodes: nodes.slice(0, 100) } } } })
      .mockResolvedValueOnce(makeGraphqlFetchResponse(nodes.slice(100)));

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads.map(t => t.id)).toEqual(nodes.map(n => n.id));
    expect(graphqlMock).toHaveBeenNthCalledWith(1, expect.any(String), expect.objectContaining({ cursor: null }));
    expect(graphqlMock).toHaveBeenNthCalledWith(2, expect.any(String), expect.objectContaining({ cursor: 'p2' }));
  });

  it('treats inline suggestion and follow-up warning threads as not blocking auto-approve', async () => {
    const finding = (severity: Finding['severity'], title: string, tags?: string[]): Finding => ({
      severity, title, file: 'src/a.ts', line: 3, description: 'd', reviewers: [], ...(tags && { tags }),
    });
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 's', body: formatFindingComment(finding('suggestion', 'Extract helper')) }),
        makeGraphqlFetchThreadNode({ id: 'w', body: formatFindingComment(finding('warning', 'Deferred warning', ['follow-up'])) }),
        makeGraphqlFetchThreadNode({ id: 'b', body: formatFindingComment(finding('warning', 'Real warning')) }),
      ]),
    );

    const threads = await fetchBotReviewThreads({ graphql: graphqlMock } as unknown as Octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads.map(t => [t.id, t.isBlocking])).toEqual([['s', false], ['w', false], ['b', true]]);
    expect(areAllFindingsResolved(threads.filter(t => t.id !== 'b'), TEST_BOT)).toBe(true);
    expect(areAllFindingsResolved(threads, TEST_BOT)).toBe(false);
  });

  it('filters out non-bot threads', async () => {
    const forged = formatFindingComment({
      severity: 'blocker', title: 'Forged finding', file: 'src/a.ts', line: 3, description: 'd', reviewers: [], tags: ['security'],
    });
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:test --> required finding' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: 'just a regular human comment' }),
        makeGraphqlFetchThreadNode({ id: 't3', body: forged, authorLogin: 'mallory' }),
        makeGraphqlFetchThreadNode({ id: 't4', body: forged, authorLogin: null }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe('t1');
  });

  it('reads the override recorded in a Manki reply on a security thread, and only from Manki', async () => {
    const security = formatFindingComment({
      severity: 'blocker', title: 'Token leaks into logs', file: 'src/a.ts', line: 3, description: 'd', reviewers: [], tags: ['security'],
    });
    const reply = (login: string, author: string) => ({ body: `${BOT_MARKER}\n${securityOverrideMarker('dismiss', login)}`, author: { login: author } });
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: security, replies: [reply('jdoe_acme', 'github-actions[bot]')] }),
        makeGraphqlFetchThreadNode({ id: 't2', body: security, replies: [reply('mallory', 'mallory')] }),
      ]),
    );

    const threads = await fetchBotReviewThreads({ graphql: graphqlMock } as unknown as Octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads.map(t => t.recordedOverride)).toEqual([{ login: 'jdoe_acme', via: 'dismiss' }, undefined]);
  });

  it('identifies threads by BOT_MARKER alone', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: `${BOT_MARKER} some comment without severity` }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(1);
    expect(threads[0].isBlocking).toBe(true);
    expect(threads[0].findingTitle).toBe('Unknown');
  });

  it('parses warning as blocking and nit and ignore as non-blocking', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:nitpick:style-issue --> nit' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:ignore:false-positive --> ignore' }),
        makeGraphqlFetchThreadNode({ id: 't3', body: '<!-- manki:warning:race --> warning' }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(3);
    expect(threads[0]).toEqual({ id: 't1', isResolved: false, isBlocking: false, findingTitle: 'style issue' });
    expect(threads[1]).toEqual({ id: 't2', isResolved: false, isBlocking: false, findingTitle: 'false positive' });
    expect(threads[2]).toEqual({ id: 't3', isResolved: false, isBlocking: true, findingTitle: 'race' });
  });

  it('migrates legacy severity markers (`required`, `nit`) on read', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:required:legacy-blocker --> old' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:nit:legacy-nit --> old' }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(2);
    expect(threads[0].isBlocking).toBe(true);
    expect(threads[1].isBlocking).toBe(false);
  });

  it('returns empty array when no threads exist', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(0);
  });
});

describe('reopenAuthorResolvedThreads', () => {
  const previous = (threadId: string, reopen: boolean): PreviousFinding => ({
    title: 'Token leaks into logs', file: 'src/a.ts', line: 3, severity: 'blocker', status: 'open', threadId, isSecurity: true, ...(reopen && { reopen }),
  });

  const mutation = (call: unknown[]) => [String(call[0]).match(/unresolveReviewThread|addPullRequestReviewThreadReply/)?.[0], (call[1] as { threadId: string }).threadId];

  it('replies with the markers, then reopens, for flagged threads only', async () => {
    const graphql = jest.fn().mockResolvedValue({});

    await reopenAuthorResolvedThreads({ graphql } as unknown as Octokit, [previous('T_author', true), previous('T_other', false)]);

    expect(graphql.mock.calls.map(mutation)).toEqual([
      ['addPullRequestReviewThreadReply', 'T_author'],
      ['unresolveReviewThread', 'T_author'],
    ]);
    expect(graphql.mock.calls[0][1].body).toMatch(/^Reopened\. A security finding needs a maintainer or a fix/);
    expect(graphql.mock.calls[0][1].body).toContain('push a fix and Manki will check it');
    expect(graphql.mock.calls[0][1].body.endsWith(`\n\n${BOT_MARKER}\n${REOPENED_MARKER}`)).toBe(true);

    // While automatic review is paused a push is not reviewed, so the reply asks for `@manki review`.
    graphql.mockClear();
    await reopenAuthorResolvedThreads({ graphql } as unknown as Octokit, [previous('T_author', true)], true);
    const pausedReply = graphql.mock.calls[0][1].body;
    expect(pausedReply).toContain('Automatic review is paused, so after pushing a fix comment `@manki review` and Manki will check it.');
    expect(pausedReply).not.toContain('push a fix and Manki will check it');
  });

  it('skips the reopen when the reply fails, and keeps going when the reopen fails', async () => {
    const warnSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    const graphql = jest.fn()
      .mockRejectedValueOnce(new Error('reply refused'))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('reopen refused'))
      .mockResolvedValue({});

    await reopenAuthorResolvedThreads({ graphql } as unknown as Octokit, [previous('T_1', true), previous('T_2', true), previous('T_3', true)]);

    expect(graphql.mock.calls.map(mutation)).toEqual([
      ['addPullRequestReviewThreadReply', 'T_1'],
      ['addPullRequestReviewThreadReply', 'T_2'],
      ['unresolveReviewThread', 'T_2'],
      ['addPullRequestReviewThreadReply', 'T_3'],
      ['unresolveReviewThread', 'T_3'],
    ]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reply refused'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('reopen refused'));
    warnSpy.mockRestore();
  });
});

describe('checkAndAutoApprove', () => {
  const { dismissPreviousReviews, isReviewInProgress: mockIsReviewInProgress } = jest.requireMock('./github') as {
    dismissPreviousReviews: jest.Mock;
    isReviewInProgress: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips when review is in progress', async () => {
    mockIsReviewInProgress.mockResolvedValueOnce(true);
    const octokit = {} as unknown as Octokit;

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(false);
  });

  function makeMockOctokit(overrides: {
    threads?: ReturnType<typeof makeGraphqlFetchThreadNode>[];
    prHeadSha?: string;
    createReviewFn?: jest.Mock;
    createCommentFn?: jest.Mock;
    existingReviews?: Array<{ body?: string; state?: string; commit_id?: string; user?: { login?: string; type?: string } }>;
    existingComments?: Array<{ body?: string; user?: { login?: string } }>;
    permission?: string;
    /** The PR diff at each commit, keyed by its SHA, as `compareCommits` against the base returns it. */
    diffs?: Record<string, string>;
    mergeable?: boolean | null;
  } = {}) {
    const threads = overrides.threads ?? [];
    const prHeadSha = overrides.prHeadSha ?? 'abc123';
    const createReviewFn = overrides.createReviewFn ?? jest.fn().mockResolvedValue({});
    const createCommentFn = overrides.createCommentFn ?? jest.fn().mockResolvedValue({});
    const existingReviews = overrides.existingReviews ?? [
      { body: '<!-- manki -->', state: 'CHANGES_REQUESTED', commit_id: prHeadSha, user: { login: 'github-actions[bot]', type: 'Bot' } },
    ];
    const existingComments = overrides.existingComments ?? [];

    return {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse(threads)),
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: prHeadSha }, base: { ref: 'main' }, user: { login: 'author' }, mergeable: overrides.mergeable } }),
          createReview: createReviewFn,
          listReviews: jest.fn().mockResolvedValue({ data: existingReviews }),
        },
        issues: {
          listComments: jest.fn().mockResolvedValue({ data: existingComments }),
          createComment: createCommentFn,
        },
        repos: {
          getCollaboratorPermissionLevel: jest.fn().mockResolvedValue({ data: { permission: overrides.permission ?? 'write' } }),
          compareCommits: jest.fn(async ({ head }: { head: string }) => ({ data: overrides.diffs?.[head] ?? '' })),
        },
      },
    } as unknown as Octokit;
  }

  it('approves when all threads including suggestions are resolved', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:suggestion:style --> style', isResolved: true }),
      ],
      prHeadSha: 'sha-456',
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE', commit_id: 'sha-456', body: expect.stringMatching(/^\u2705 \*\*Approved\.\*\* All blocking threads are resolved\.\n\n<!-- manki -->$/) }),
    );
  });

  it('holds the approval of a PR that conflicts with its base, with one notice per head', async () => {
    const resolved = [makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true })];
    const createReviewMock = jest.fn().mockResolvedValue({});
    const createCommentMock = jest.fn().mockResolvedValue({});
    const notice = '**Approval held:** this PR conflicts with `main`. Rebase it, and Manki reviews the result.\n\n<!-- manki-approval-held:sha-456 -->';

    const first = makeMockOctokit({ threads: resolved, prHeadSha: 'sha-456', mergeable: false, createReviewFn: createReviewMock, createCommentFn: createCommentMock });
    expect(await checkAndAutoApprove(first, TEST_BOT, 'owner', 'repo', 1)).toBe(false);
    expect(createCommentMock.mock.calls.map(([c]) => c.body)).toEqual([notice]);

    const again = makeMockOctokit({
      threads: resolved, prHeadSha: 'sha-456', mergeable: false, createReviewFn: createReviewMock, createCommentFn: createCommentMock,
      existingComments: [{ body: notice, user: { login: 'github-actions[bot]' } }],
    });
    expect(await checkAndAutoApprove(again, TEST_BOT, 'owner', 'repo', 1)).toBe(false);
    expect(createCommentMock).toHaveBeenCalledTimes(1);
    expect(createReviewMock).not.toHaveBeenCalled();

    const clean = makeMockOctokit({ threads: resolved, prHeadSha: 'sha-456', mergeable: true, createReviewFn: createReviewMock, createCommentFn: createCommentMock });
    expect(await checkAndAutoApprove(clean, TEST_BOT, 'owner', 'repo', 1)).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'APPROVE', commit_id: 'sha-456' }));
  });

  it.each([
    ['the PR author', 'author', 'write', false, false],
    ['a collaborator', 'alice', 'write', false, true],
    ['the PR author as a repo admin', 'author', 'admin', false, true],
    ['the PR author as a repo admin, already recorded', 'author', 'admin', true, true],
    ['the PR author without admin, with a recorded override', 'author', 'write', true, false],
  ])('approves a security thread resolved by %s', async (who, resolver, permission, recorded, approves) => {
    const finding = (title: string, tags?: string[]): Finding => ({
      severity: 'blocker', title, file: 'src/a.ts', line: 3, description: 'd', reviewers: [], ...(tags && { tags }),
    });
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({
          id: 't1', isResolved: true, resolvedBy: resolver, url: 'https://github.com/o/r/pull/1#r1',
          body: formatFindingComment(finding('Token leaks into logs', ['security'])),
          ...(recorded && { replies: [{ body: `<!-- manki -->\n${securityOverrideMarker('resolve', 'author')}`, author: { login: 'github-actions[bot]' } }] }),
        }),
        makeGraphqlFetchThreadNode({ id: 't2', isResolved: true, resolvedBy: 'author', body: formatFindingComment(finding('Off by one')) }),
      ],
      createReviewFn: createReviewMock,
      permission,
    });

    expect(await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1)).toBe(approves);
    expect(createReviewMock).toHaveBeenCalledTimes(approves ? 1 : 0);

    const isAdmin = who.includes('repo admin');
    const replies = jest.mocked(octokit.graphql).mock.calls.filter(([query]) => String(query).includes('addPullRequestReviewThreadReply'));
    expect(replies.map(([, vars]) => vars)).toEqual(isAdmin && !recorded
      ? [{ threadId: 't1', body: 'Security finding dismissed by @author (repo admin).\n\n<!-- manki -->\n<!-- manki-security-override:resolve:author -->' }]
      : []);
    // Only a security thread the author resolved or overrode needs the admin lookup.
    expect(octokit.rest.repos.getCollaboratorPermissionLevel).toHaveBeenCalledTimes(resolver === 'author' ? 1 : 0);
    if (approves) {
      const line = '**Security findings dismissed by a repo admin:** [Token leaks into logs](https://github.com/o/r/pull/1#r1) by @author.';
      expect(createReviewMock.mock.calls[0][0].body.includes(line)).toBe(isAdmin);
    }
  });

  it('approves when blocking threads are resolved and only old suggestion and nitpick threads are open', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:suggestion:style --> style', isResolved: false }),
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

  it('does not approve while a warning thread is unresolved', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:warning:race --> race', isResolved: false }),
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
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:suggestion:style --> style', isResolved: true }),
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
        { body: '<!-- manki -->', state: 'APPROVED', commit_id: 'abc123', user: { login: 'github-actions[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(dismissPreviousReviews).not.toHaveBeenCalled();
  });

  it('finds the latest bot review past the first page of reviews', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const bot = { login: 'github-actions[bot]', type: 'Bot' };
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
      threads: [],
      prHeadSha: 'sha-new',
      createReviewFn: createReviewMock,
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', commit_id: 'sha-new', user: { login: 'github-actions[bot]', type: 'Bot' } },
        { body: '<!-- manki -->', state: 'CHANGES_REQUESTED', commit_id: 'sha-new', user: { login: 'github-actions[bot]', type: 'Bot' } },
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
        { body: '<!-- manki -->', state: 'DISMISSED', commit_id: 'sha-new', user: { login: 'github-actions[bot]', type: 'Bot' } },
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
      const octokit = staleHeadOctokit(createCommentMock, [formatContextBlock(makeRoundContext(1))]);

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, config);

      expect(result).toBe(false);
      expect(octokit.rest.pulls.createReview).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledWith(expect.stringContaining('head=head-sha-aaaa'));
      expect(createCommentMock).not.toHaveBeenCalled();
    });

    const notConverging = makeRoundContext(1);
    notConverging.meta.outcome = 'NOT_CONVERGING';
    it.each([
      ['the last round did not converge', DEFAULT_CONFIG, [formatContextBlock(notConverging)], 'The last Manki round found a blocker that came back after a fix. Automatic review is paused. Tick **Force review** on the pause notice'],
      ['the round cap is reached', DEFAULT_CONFIG, [1, 2, 3, 4, 5].map(n => formatContextBlock(makeRoundContext(n))), 'Manki has completed 5/5 review rounds on this PR. Automatic review is paused.'],
      ['automatic review is off', AUTO_REVIEW_OFF, [], 'Automatic review is off for this repository (`auto_review: false`). Comment `@manki review` to review it.'],
    ])('posts one withheld notice with the reason when %s', async (_label, config, roundBodies, reason) => {
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
    });

    it('still approves when the latest manki review is on the current HEAD', async () => {
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
          { body: '<!-- manki -->', state: 'CHANGES_REQUESTED', commit_id: 'head-sha-aaaa', user: { login: 'manki-review[bot]', type: 'Bot' } },
        ],
      });

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

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

    it('skips approval when latest bot review is APPROVED but on a stale commit', async () => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const octokit = makeMockOctokit({
        threads: [],
        prHeadSha: 'new-sha',
        createReviewFn: createReviewMock,
        existingReviews: [
          { body: '<!-- manki -->', state: 'APPROVED', commit_id: 'old-sha', user: { login: 'github-actions[bot]', type: 'Bot' } },
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
          { body: '<!-- manki -->', state: 'DISMISSED', commit_id: 'old-sha', user: { login: 'github-actions[bot]', type: 'Bot' } },
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
        threads: [makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: true })],
        prHeadSha: 'head-sha-aaaa',
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        existingReviews: [
          { body: '<!-- manki-bot -->', state: 'CHANGES_REQUESTED', commit_id: 'old-sha-bbbb', user: { login: 'manki-review[bot]', type: 'Bot' } },
        ],
        diffs: { 'old-sha-bbbb': rebaseDiff, 'head-sha-aaaa': headDiff },
      });

      expect(await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG)).toBe(approves);
      expect(createReviewMock.mock.calls.map(([args]) => [args.event, args.commit_id])).toEqual(approves ? [['APPROVE', 'head-sha-aaaa']] : []);
      expect(createCommentMock).not.toHaveBeenCalled();
      expect(await explainUnreviewedHead(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG)).toBe(approves
        ? undefined
        : 'Manki has not reviewed `head-sh` yet. A push review should start shortly, and approval follows from its verdict.');
    });

    it('explains an unreviewed head by the review that is running, the pause, or the absence of both', async () => {
      const octokit = staleHeadOctokit(jest.fn(), [formatContextBlock(notConverging)]);
      jest.mocked(isReviewInProgress).mockResolvedValueOnce(true);
      expect(await explainUnreviewedHead(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG))
        .toBe('A review of `head-sh` is running or queued. Approval follows from its verdict.');
      expect(isReviewInProgress).toHaveBeenLastCalledWith(octokit, TEST_BOT, 'owner', 'repo', 1, 'head-sha-aaaa');
      expect(await explainUnreviewedHead(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG))
        .toMatch(/^Manki has not reviewed `head-sh`\. The last Manki round found a blocker that came back after a fix\. Automatic review is paused\./);
      expect(await explainUnreviewedHead(staleHeadOctokit(jest.fn(), []), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG))
        .toBe('Manki has not reviewed `head-sh` yet. A push review should start shortly, and approval follows from its verdict.');
    });
  });
});

describe('checkAndAutoApprove — concurrent run guard', () => {
  const { dismissPreviousReviews, isReviewInProgress: mockIsReviewInProgress, checkConcurrentSubmissionLock: mockCheckConcurrentSubmissionLock } = jest.requireMock('./github') as {
    dismissPreviousReviews: jest.Mock;
    isReviewInProgress: jest.Mock;
    checkConcurrentSubmissionLock: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsReviewInProgress.mockResolvedValue(false);
  });

  function makeMockOctokit(): Octokit {
    return {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse([])),
      paginate: jest.fn(paginateSinglePage),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-1' } } }),
          createReview: jest.fn().mockResolvedValue({}),
          listReviews: jest.fn().mockResolvedValue({ data: [
            { body: '<!-- manki -->', state: 'CHANGES_REQUESTED', commit_id: 'sha-1', user: { login: 'github-actions[bot]', type: 'Bot' } },
          ] }),
        },
        issues: { listComments: jest.fn().mockResolvedValue({ data: [] }), createComment: jest.fn().mockResolvedValue({ data: { id: 1 } }) },
      },
    } as unknown as Octokit;
  }

  it('bails when a different run holds a fresh in-progress marker', async () => {
    mockCheckConcurrentSubmissionLock.mockResolvedValueOnce(true);
    const octokit = makeMockOctokit();
    const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(dismissPreviousReviews).not.toHaveBeenCalled();
    expect(mockIsReviewInProgress).not.toHaveBeenCalled();
  });

  it('proceeds when lock guard returns false', async () => {
    mockCheckConcurrentSubmissionLock.mockResolvedValueOnce(false);
    const octokit = makeMockOctokit();
    const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
  });

  it('forwards the supplied config to the lock guard', async () => {
    mockCheckConcurrentSubmissionLock.mockResolvedValueOnce(false);
    const octokit = makeMockOctokit();
    const config = { concurrency_lock_ttl_seconds: 300 } as Parameters<typeof checkAndAutoApprove>[5];

    await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, config);

    expect(mockCheckConcurrentSubmissionLock).toHaveBeenCalledWith(
      octokit, TEST_BOT, 'owner', 'repo', 1, config,
    );
  });

  describe('end-to-end with realistic comment bodies', () => {
    const ghActual = jest.requireActual('./github') as typeof import('./github');
    const githubContext = jest.requireActual('@actions/github').context as { runId: number };
    const BOT_LOGIN = 'manki-review[bot]';
    const GH_BOT_MARKER = '<!-- manki-bot -->';
    const NOW = new Date('2026-05-22T12:00:00Z');
    let savedRunId: number;

    function inProgressBody(runId: number): string {
      return `${GH_BOT_MARKER}\n<!-- manki-run-id:${runId} -->\n**Manki** — Review in progress`;
    }

    function botComment(id: number, body: string, updatedAt: string) {
      return { id, body, user: { login: BOT_LOGIN, type: 'Bot' }, updated_at: updatedAt };
    }

    function makeOctokit(comments: ReturnType<typeof botComment>[]): Octokit {
      return {
        graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse([])),
        paginate: jest.fn(paginateSinglePage),
        rest: {
          pulls: {
            get: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-1' } } }),
            createReview: jest.fn().mockResolvedValue({}),
            listReviews: jest.fn().mockResolvedValue({ data: [
              { body: '<!-- manki -->', state: 'CHANGES_REQUESTED', commit_id: 'sha-1', user: { login: 'github-actions[bot]', type: 'Bot' } },
            ] }),
          },
          issues: {
            listComments: jest.fn().mockResolvedValue({ data: comments }),
            createComment: jest.fn().mockResolvedValue({}),
          },
        },
      } as unknown as Octokit;
    }

    beforeEach(() => {
      mockCheckConcurrentSubmissionLock.mockImplementation(ghActual.checkConcurrentSubmissionLock);
      savedRunId = githubContext.runId;
      githubContext.runId = 42;
      jest.useFakeTimers().setSystemTime(NOW);
    });

    afterEach(() => {
      githubContext.runId = savedRunId;
      jest.useRealTimers();
    });

    it('bails when a fresh in-progress marker from a different run is present', async () => {
      const octokit = makeOctokit([
        botComment(7, inProgressBody(999), '2026-05-22T11:59:00Z'),
      ]);
      const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

      expect(result).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
    });

    it('proceeds when the in-progress marker has aged past the TTL', async () => {
      const octokit = makeOctokit([
        botComment(7, inProgressBody(999), '2026-05-22T10:00:00Z'),
      ]);
      const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

      expect(result).toBe(true);
      expect(createReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVE' }),
      );
    });

    it('proceeds when there is no in-progress marker on the PR', async () => {
      const octokit = makeOctokit([]);
      const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

      expect(result).toBe(true);
      expect(createReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVE' }),
      );
    });

    it('treats an in-progress marker from the current run as non-competing', async () => {
      const octokit = makeOctokit([
        botComment(7, inProgressBody(42), '2026-05-22T11:59:00Z'),
      ]);
      const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;

      const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

      expect(result).toBe(true);
      expect(createReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVE' }),
      );
    });

    describe('readConcurrencyLockTtlSeconds validation', () => {
      let warningSpy: jest.SpyInstance;

      beforeEach(() => {
        warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
      });

      afterEach(() => {
        delete process.env['INPUT_CONCURRENCY_LOCK_TTL_SECONDS'];
        warningSpy.mockRestore();
      });

      it('falls back to default and warns when TTL input is non-finite', async () => {
        process.env['INPUT_CONCURRENCY_LOCK_TTL_SECONDS'] = 'not-a-number';
        const octokit = makeOctokit([
          botComment(7, inProgressBody(999), '2026-05-22T11:59:00Z'),
        ]);

        await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

        expect(warningSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid concurrency_lock_ttl_seconds=not-a-number'),
        );
      });

      it('falls back to default and warns when TTL input is zero', async () => {
        process.env['INPUT_CONCURRENCY_LOCK_TTL_SECONDS'] = '0';
        const octokit = makeOctokit([
          botComment(7, inProgressBody(999), '2026-05-22T11:59:00Z'),
        ]);

        await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

        expect(warningSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid concurrency_lock_ttl_seconds=0'),
        );
      });

      it('falls back to default and warns when TTL input is negative', async () => {
        process.env['INPUT_CONCURRENCY_LOCK_TTL_SECONDS'] = '-1';
        const octokit = makeOctokit([
          botComment(7, inProgressBody(999), '2026-05-22T11:59:00Z'),
        ]);

        await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

        expect(warningSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid concurrency_lock_ttl_seconds=-1'),
        );
      });

      it('falls back to default and warns when TTL input exceeds the maximum', async () => {
        process.env['INPUT_CONCURRENCY_LOCK_TTL_SECONDS'] = '9999';
        const octokit = makeOctokit([
          botComment(7, inProgressBody(999), '2026-05-22T11:59:00Z'),
        ]);

        await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

        expect(warningSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid concurrency_lock_ttl_seconds=9999'),
        );
      });

      it('falls back to default and warns when .manki.yml-sourced TTL is 0', async () => {
        const octokit = makeOctokit([
          botComment(7, inProgressBody(999), '2026-05-22T11:59:00Z'),
        ]);
        const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;
        const config = { concurrency_lock_ttl_seconds: 0 } as Parameters<typeof checkAndAutoApprove>[5];

        const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1, config);

        expect(warningSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid `concurrency_lock_ttl_seconds` in config (0)'),
        );
        expect(result).toBe(false);
        expect(createReviewMock).not.toHaveBeenCalled();
      });
    });
  });
});

describe('checkAndAutoApprove — in-progress marker lifecycle', () => {
  const ghMock = jest.requireMock('./github') as {
    dismissPreviousReviews: jest.Mock;
    isReviewInProgress: jest.Mock;
    checkConcurrentSubmissionLock: jest.Mock;
    postAutoApproveProgressComment: jest.Mock;
    markAutoApproveComplete: jest.Mock;
    markProgressCommentFailed: jest.Mock;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    ghMock.isReviewInProgress.mockResolvedValue(false);
    ghMock.checkConcurrentSubmissionLock.mockResolvedValue(false);
    ghMock.postAutoApproveProgressComment.mockResolvedValue(7777);
  });

  function makeMockOctokit(overrides: {
    createReviewFn?: jest.Mock;
    createCommentFn?: jest.Mock;
    prHeadSha?: string;
    existingReviews?: Array<{ body?: string; state?: string; commit_id?: string; user?: { login?: string; type?: string } }>;
  } = {}) {
    const createReviewFn = overrides.createReviewFn ?? jest.fn().mockResolvedValue({});
    const createCommentFn = overrides.createCommentFn ?? jest.fn().mockResolvedValue({});
    const prHeadSha = overrides.prHeadSha ?? 'sha-x';
    const existingReviews = overrides.existingReviews ?? [
      { body: '<!-- manki -->', state: 'CHANGES_REQUESTED', commit_id: prHeadSha, user: { login: 'github-actions[bot]', type: 'Bot' } },
    ];
    return {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse([])),
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

  it('posts the in-progress marker before calling createReview and transitions to complete on success', async () => {
    const callOrder: string[] = [];
    ghMock.postAutoApproveProgressComment.mockImplementationOnce(async () => {
      callOrder.push('post');
      return 7777;
    });
    const createReviewMock = jest.fn().mockImplementationOnce(async () => {
      callOrder.push('createReview');
      return {};
    });
    ghMock.markAutoApproveComplete.mockImplementationOnce(async () => {
      callOrder.push('complete');
    });

    const octokit = makeMockOctokit({ createReviewFn: createReviewMock });
    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(callOrder).toEqual(['post', 'createReview', 'complete']);
    expect(ghMock.markAutoApproveComplete).toHaveBeenCalledWith(octokit, 'owner', 'repo', 7777);
    expect(ghMock.markProgressCommentFailed).not.toHaveBeenCalled();
  });

  it('does not post a marker when the concurrency lock guard bails', async () => {
    ghMock.checkConcurrentSubmissionLock.mockResolvedValueOnce(true);
    const octokit = makeMockOctokit();

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(ghMock.postAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.markAutoApproveComplete).not.toHaveBeenCalled();
    expect(ghMock.markProgressCommentFailed).not.toHaveBeenCalled();
  });

  it('does not post a marker when `isReviewInProgress` returns true', async () => {
    ghMock.isReviewInProgress.mockResolvedValueOnce(true);
    const octokit = makeMockOctokit();

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(ghMock.postAutoApproveProgressComment).not.toHaveBeenCalled();
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
    expect(ghMock.markAutoApproveComplete).not.toHaveBeenCalled();
    expect(ghMock.markProgressCommentFailed).not.toHaveBeenCalled();
  });

  it('does not post a marker when a prior bot approval already exists for the same SHA', async () => {
    const octokit = makeMockOctokit({
      prHeadSha: 'sha-x',
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', commit_id: 'sha-x', user: { login: 'github-actions[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(ghMock.postAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.markAutoApproveComplete).not.toHaveBeenCalled();
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
    expect(ghMock.markAutoApproveComplete).not.toHaveBeenCalled();
    expect(ghMock.dismissPreviousReviews).not.toHaveBeenCalled();
  });

  it('still transitions to complete when APPROVE fails but the issue-comment fallback succeeds', async () => {
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
    expect(ghMock.markAutoApproveComplete).toHaveBeenCalledWith(octokit, 'owner', 'repo', 7777);
    expect(ghMock.markProgressCommentFailed).not.toHaveBeenCalled();
  });
});

describe('postAutoApproveProgressComment / markAutoApprove*', () => {
  const ghActual = jest.requireActual('./github') as typeof import('./github');
  const githubContext = jest.requireActual('@actions/github').context as { runId: number };
  let savedRunId: number;

  const NOW = new Date('2026-05-22T12:00:00Z');

  beforeEach(() => {
    savedRunId = githubContext.runId;
    githubContext.runId = 12345;
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => {
    githubContext.runId = savedRunId;
    jest.useRealTimers();
  });

  it('posts a body that `findInProgressLock` detects as a live lock', async () => {
    let postedBody = '';
    const createComment = jest.fn().mockImplementation(async ({ body }: { body: string }) => {
      postedBody = body;
      return { data: { id: 1 } };
    });
    const octokit = { rest: { issues: { createComment } } } as unknown as Octokit;

    await ghActual.postAutoApproveProgressComment(octokit, 'o', 'r', 1);

    const comments = [
      { id: 1, body: postedBody, user: { login: 'manki-review[bot]', type: 'Bot' }, updated_at: '2026-05-22T11:59:00Z' },
    ];
    expect(ghActual.findInProgressLock(comments, TEST_BOT, /* different run */ 999)).not.toBeNull();
    expect(ghActual.findInProgressLock(comments, TEST_BOT, 12345)).toBeNull();
    expect(postedBody).toContain('Auto-approving');
  });

  it('complete-transition body no longer registers as a live lock', async () => {
    let updatedBody = '';
    const updateComment = jest.fn().mockImplementation(async ({ body }: { body: string }) => {
      updatedBody = body;
      return { data: {} };
    });
    const octokit = { rest: { issues: { updateComment } } } as unknown as Octokit;

    await ghActual.markAutoApproveComplete(octokit, 'o', 'r', 1);

    const comments = [
      { id: 1, body: updatedBody, user: { login: 'manki-review[bot]', type: 'Bot' }, updated_at: '2026-05-22T11:59:30Z' },
    ];
    expect(ghActual.findInProgressLock(comments, TEST_BOT, 999)).toBeNull();
    expect(updatedBody).toContain('**Auto-approved:** all findings are resolved.');
  });

  it('failure-transition body no longer registers as a live lock', async () => {
    let updatedBody = '';
    const updateComment = jest.fn().mockImplementation(async ({ body }: { body: string }) => {
      updatedBody = body;
      return { data: {} };
    });
    const octokit = { rest: { issues: { updateComment } } } as unknown as Octokit;

    await ghActual.markProgressCommentFailed(octokit, 'o', 'r', 1, 'Auto-approve', 'API rate limited for ghs_secret123');

    const comments = [
      { id: 1, body: updatedBody, user: { login: 'manki-review[bot]', type: 'Bot' }, updated_at: '2026-05-22T11:59:30Z' },
    ];
    expect(ghActual.findInProgressLock(comments, TEST_BOT, 999)).toBeNull();
    expect(updatedBody).toContain('API rate limited for [REDACTED]');
    expect(updatedBody).not.toContain('ghs_secret123');
  });
});
