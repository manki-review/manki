import * as core from '@actions/core';
import { areAllFindingsResolved, fetchBotReviewThreads, checkAndAutoApprove, explainUnreviewedHead, holdApproval, pauseState, reopenAuthorResolvedThreads, BOT_MARKER, ReviewThread } from './state';
import { PreviousFinding, REOPENED_MARKER, securityOverrideMarker } from './recap';
import { LAST_PAGE, makeRoundContext, paginateSinglePage, TEST_BOT } from './test-utils';
import { formatFindingComment } from './github';
import { formatReviewRecord } from './review-record';
import { DEFAULT_CONFIG } from './config';
import { Finding } from './types';
import * as authModule from './auth';

jest.mock('./auth', () => ({
  fetchPrState: jest.fn().mockResolvedValue(null),
  reportPrState: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./github', () => ({
  ...jest.requireActual('./github'),
  dismissPreviousReviews: jest.fn().mockResolvedValue(undefined),
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

  it('treats suggestion and warning threads, security ones included, as not blocking auto-approve, unless Manki said the problem came back as a blocker', async () => {
    const finding = (severity: Finding['severity'], title: string, tags?: string[]): Finding => ({
      severity, title, file: 'src/a.ts', line: 3, description: 'd', reviewers: [], ...(tags && { tags }),
    });
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 's', body: formatFindingComment(finding('suggestion', 'Extract helper')) }),
        makeGraphqlFetchThreadNode({ id: 'w', body: formatFindingComment(finding('warning', 'Deferred warning', ['follow-up'])) }),
        makeGraphqlFetchThreadNode({ id: 'p', body: formatFindingComment(finding('warning', 'Plain warning')) }),
        makeGraphqlFetchThreadNode({ id: 'x', body: formatFindingComment(finding('warning', 'Token in log', ['security'])) }),
        makeGraphqlFetchThreadNode({ id: 'b', body: formatFindingComment(finding('blocker', 'Real bug')) }),
        makeGraphqlFetchThreadNode({ id: 'f', body: formatFindingComment(finding('warning', 'Worse now')), replies: [{ body: 'Came back.\n\n<!-- manki -->\n<!-- manki-found-again -->\n<!-- manki-found-again-blocker -->', author: { login: 'github-actions[bot]' } }] }),
        makeGraphqlFetchThreadNode({ id: 'h', body: formatFindingComment(finding('warning', 'Pasted marker')), replies: [{ body: '<!-- manki-found-again-blocker -->', author: { login: 'developer' } }] }),
      ]),
    );

    const threads = await fetchBotReviewThreads({ graphql: graphqlMock } as unknown as Octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads.map(t => [t.id, t.isBlocking])).toEqual([['s', false], ['w', false], ['p', false], ['x', false], ['b', true], ['f', true], ['h', false]]);
    expect(threads.find(t => t.id === 'x')?.isSecurity).toBe(true);
    expect(areAllFindingsResolved(threads.filter(t => t.id !== 'b' && t.id !== 'f'), TEST_BOT)).toBe(true);
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

  it('parses blocker as blocking and plain warning, nit and ignore as non-blocking', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:nitpick:style-issue --> nit' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:ignore:false-positive --> ignore' }),
        makeGraphqlFetchThreadNode({ id: 't3', body: '<!-- manki:warning:race --> warning' }),
        makeGraphqlFetchThreadNode({ id: 't4', body: '<!-- manki:blocker:crash --> blocker' }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, TEST_BOT, 'owner', 'repo', 1);

    expect(threads).toHaveLength(4);
    expect(threads[0]).toEqual({ id: 't1', isResolved: false, isBlocking: false, findingTitle: 'style issue' });
    expect(threads[1]).toEqual({ id: 't2', isResolved: false, isBlocking: false, findingTitle: 'false positive' });
    expect(threads[2]).toEqual({ id: 't3', isResolved: false, isBlocking: false, findingTitle: 'race' });
    expect(threads[3]).toEqual({ id: 't4', isResolved: false, isBlocking: true, findingTitle: 'crash' });
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
    existingReviews?: Array<{ body?: string; state?: string; commit_id?: string; user?: { login?: string; type?: string } }>;
    existingComments?: Array<{ body?: string; user?: { login?: string } }>;
    permission?: string;
    /** The PR diff at each commit, keyed by its SHA, as `compareCommits` against the base returns it. */
    diffs?: Record<string, string>;
    mergeable?: boolean | null;
    draft?: boolean;
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
          get: jest.fn().mockResolvedValue({ data: { head: { sha: prHeadSha }, base: { ref: 'main' }, user: { login: 'author' }, mergeable: overrides.mergeable, draft: overrides.draft } }),
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
        checks: overrides.checks ?? { create: jest.fn().mockResolvedValue({ data: { id: 900 } }), update: jest.fn().mockResolvedValue({}) },
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
      expect.objectContaining({ event: 'APPROVE', commit_id: 'sha-456', body: '\u2705 **Approved.** All blocking threads are resolved.\n\n<!-- manki -->\n<!-- manki-auto-approve -->' }),
    );
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
    expect(jest.mocked(authModule.reportPrState).mock.calls).toEqual([
      ['owner', 'repo', 1, { approval: { commit: 'sha-456', held: true } }],
      ['owner', 'repo', 1, { approval: { commit: 'sha-456', held: true } }],
      ['owner', 'repo', 1, { approval: { commit: 'sha-456', held: false }, pause: null }],
    ]);
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
      ['the last round did not converge', DEFAULT_CONFIG, [formatReviewRecord(notConverging)], 'The last Manki round found a blocker that came back after a fix. Automatic review is paused. Tick **Force review** in the settings block'],
      ['the round cap is reached', DEFAULT_CONFIG, [1, 2, 3, 4, 5].map(n => formatReviewRecord(makeRoundContext(n))), 'Manki has reviewed new changes in 5/5 rounds on this PR. Automatic review is paused.'],
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

    it('still approves when the latest manki review is on the current HEAD, even with automatic review paused by the round cap', async () => {
      const createReviewMock = jest.fn().mockResolvedValue({});
      const createCommentMock = jest.fn().mockResolvedValue({ data: { id: 1 } });
      const octokit = makeMockOctokit({
        threads: [
          makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: true }),
        ],
        prHeadSha: 'head-sha-aaaa',
        createReviewFn: createReviewMock,
        createCommentFn: createCommentMock,
        existingReviews: [1, 2, 3, 4, 5].map(n => ({
          body: `<!-- manki -->\n${formatReviewRecord(makeRoundContext(n))}`, state: n === 5 ? 'CHANGES_REQUESTED' : 'COMMENTED',
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

    it('explains an unreviewed head by the pause, the Pause box, or by the review still to come', async () => {
      const octokit = staleHeadOctokit(jest.fn(), [formatReviewRecord(notConverging)]);
      expect(await explainUnreviewedHead(octokit, TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG))
        .toMatch(/^Manki has not reviewed `head-sh`\. The last Manki round found a blocker that came back after a fix\. Automatic review is paused\./);
      jest.mocked(authModule.fetchPrState).mockResolvedValueOnce({ settings: { paused: true }, runModes: new Set(), queuedModes: new Set() });
      expect(await explainUnreviewedHead(staleHeadOctokit(jest.fn(), []), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG))
        .toBe('Manki has not reviewed `head-sh`. Automatic review is paused in the settings block. Untick **Pause automatic reviews** there, or comment `@manki review`, to review it.');
      expect(await explainUnreviewedHead(staleHeadOctokit(jest.fn(), []), TEST_BOT, 'owner', 'repo', 1, DEFAULT_CONFIG))
        .toBe('Manki has not reviewed `head-sh` yet. A push review should start shortly, and approval follows from its verdict.');
    });
  });
});

describe('checkAndAutoApprove — in-progress marker lifecycle', () => {
  const ghMock = jest.requireMock('./github') as {
    dismissPreviousReviews: jest.Mock;
    postAutoApproveProgressComment: jest.Mock;
    markAutoApproveComplete: jest.Mock;
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

  beforeEach(() => {
    savedRunId = githubContext.runId;
    githubContext.runId = 12345;
  });
  afterEach(() => {
    githubContext.runId = savedRunId;
  });

  it('posts a body that names its run, so the post step can mark it cancelled', async () => {
    let postedBody = '';
    const createComment = jest.fn().mockImplementation(async ({ body }: { body: string }) => {
      postedBody = body;
      return { data: { id: 1 } };
    });
    const octokit = { rest: { issues: { createComment } } } as unknown as Octokit;

    await ghActual.postAutoApproveProgressComment(octokit, 'o', 'r', 1);

    expect(ghActual.extractRunIdFromBody(postedBody)).toBe(12345);
    expect(postedBody).toContain('Auto-approving');
  });

  it('marks the comment complete, so the post step leaves it alone', async () => {
    let updatedBody = '';
    const updateComment = jest.fn().mockImplementation(async ({ body }: { body: string }) => {
      updatedBody = body;
      return { data: {} };
    });
    const octokit = { rest: { issues: { updateComment } } } as unknown as Octokit;

    await ghActual.markAutoApproveComplete(octokit, 'o', 'r', 1);

    expect(updatedBody).toContain(ghActual.REVIEW_COMPLETE_MARKER);
    expect(updatedBody).toContain('**Auto-approved:** all findings are resolved.');
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
  });
});

describe('pauseState', () => {
  it('leaves draft rounds out of the round cap', () => {
    const rounds = [1, 2, 3, 4, 5].map(n => makeRoundContext(n));
    expect(pauseState({ priorRounds: rounds }, DEFAULT_CONFIG)).toMatchObject({ capRounds: 5, paused: true });
    rounds[1].meta.draft = true;
    rounds[3].meta.draft = true;
    expect(pauseState({ priorRounds: rounds }, DEFAULT_CONFIG)).toEqual({ capRounds: 3, capReached: false, paused: false });
  });
});
