import * as core from '@actions/core';
import { areAllFindingsResolved, resolveStaleThreads, fetchBotReviewThreads, checkAndAutoApprove, BOT_MARKER, ReviewThread } from './state';

jest.mock('./github', () => ({
  ...jest.requireActual('./github'),
  dismissPreviousReviews: jest.fn().mockResolvedValue(undefined),
  isReviewInProgress: jest.fn().mockResolvedValue(false),
  checkConcurrentSubmissionLock: jest.fn().mockResolvedValue(false),
  postAutoApproveProgressComment: jest.fn().mockResolvedValue(12345),
  markAutoApproveComplete: jest.fn().mockResolvedValue(undefined),
  markAutoApproveFailed: jest.fn().mockResolvedValue(undefined),
}));

const makeThread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'thread-1',
  isResolved: false,
  isRequired: false,
  findingTitle: 'Test finding',
  ...overrides,
});

describe('areAllFindingsResolved', () => {
  it('returns true for an empty array', () => {
    expect(areAllFindingsResolved([])).toBe(true);
  });

  it('returns true when all threads are resolved', () => {
    const threads = [
      makeThread({ id: '1', isRequired: true, isResolved: true }),
      makeThread({ id: '2', isRequired: false, isResolved: true }),
    ];
    expect(areAllFindingsResolved(threads)).toBe(true);
  });

  it('returns false when unresolved suggestion threads exist', () => {
    const threads = [
      makeThread({ id: '1', isRequired: false, isResolved: false }),
      makeThread({ id: '2', isRequired: false, isResolved: true }),
    ];
    expect(areAllFindingsResolved(threads)).toBe(false);
  });

  it('returns false when some required threads are unresolved', () => {
    const threads = [
      makeThread({ id: '1', isRequired: true, isResolved: true }),
      makeThread({ id: '2', isRequired: true, isResolved: false }),
    ];
    expect(areAllFindingsResolved(threads)).toBe(false);
  });

  it('returns false when required threads are resolved but suggestions are not', () => {
    const threads = [
      makeThread({ id: '1', isRequired: true, isResolved: true }),
      makeThread({ id: '2', isRequired: false, isResolved: false }),
      makeThread({ id: '3', isRequired: false, isResolved: false }),
    ];
    expect(areAllFindingsResolved(threads)).toBe(false);
  });

  it('returns true when all required and suggestion threads are resolved', () => {
    const threads = [
      makeThread({ id: '1', isRequired: true, isResolved: true }),
      makeThread({ id: '2', isRequired: false, isResolved: true }),
      makeThread({ id: '3', isRequired: false, isResolved: true }),
    ];
    expect(areAllFindingsResolved(threads)).toBe(true);
  });
});

type Octokit = ReturnType<typeof import('@actions/github').getOctokit>;

function makeGraphqlThreadNode(overrides: {
  id?: string;
  isResolved?: boolean;
  commitOid?: string | null;
  body?: string;
} = {}) {
  return {
    id: overrides.id ?? 'thread-1',
    isResolved: overrides.isResolved ?? false,
    comments: {
      nodes: [{
        body: overrides.body ?? '<!-- manki:blocker:test --> **Blocker**: test',
        commit: overrides.commitOid !== undefined
          ? (overrides.commitOid === null ? null : { oid: overrides.commitOid })
          : { oid: 'old-sha-111' },
      }],
    },
  };
}

describe('resolveStaleThreads', () => {
  const currentSha = 'current-sha-abc';

  it('resolves threads with a different commit SHA', async () => {
    const graphqlMock = jest.fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                makeGraphqlThreadNode({ id: 't1', commitOid: 'old-sha-111' }),
                makeGraphqlThreadNode({ id: 't2', commitOid: 'old-sha-222' }),
              ],
            },
          },
        },
      })
      .mockResolvedValue({ resolveReviewThread: { thread: { isResolved: true } } });

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const count = await resolveStaleThreads(octokit, 'owner', 'repo', 1, currentSha);

    expect(count).toBe(2);
    expect(graphqlMock).toHaveBeenCalledTimes(3);
  });

  it('does not resolve threads with the current commit SHA', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              makeGraphqlThreadNode({ id: 't1', commitOid: currentSha }),
            ],
          },
        },
      },
    });

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const count = await resolveStaleThreads(octokit, 'owner', 'repo', 1, currentSha);

    expect(count).toBe(0);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
  });

  it('does not resolve non-bot threads', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              makeGraphqlThreadNode({ id: 't1', commitOid: 'old-sha', body: 'plain human comment' }),
            ],
          },
        },
      },
    });

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const count = await resolveStaleThreads(octokit, 'owner', 'repo', 1, currentSha);

    expect(count).toBe(0);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
  });

  it('skips already-resolved threads', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              makeGraphqlThreadNode({ id: 't1', commitOid: 'old-sha', isResolved: true }),
            ],
          },
        },
      },
    });

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const count = await resolveStaleThreads(octokit, 'owner', 'repo', 1, currentSha);

    expect(count).toBe(0);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
  });

  it('skips threads with null commit on first comment', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              makeGraphqlThreadNode({ id: 't1', commitOid: null }),
            ],
          },
        },
      },
    });

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const count = await resolveStaleThreads(octokit, 'owner', 'repo', 1, currentSha);

    expect(count).toBe(0);
    expect(graphqlMock).toHaveBeenCalledTimes(1);
  });

  it('continues resolving remaining threads when one mutation fails', async () => {
    const graphqlMock = jest.fn()
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                makeGraphqlThreadNode({ id: 't1', commitOid: 'old-sha-111' }),
                makeGraphqlThreadNode({ id: 't2', commitOid: 'old-sha-222' }),
              ],
            },
          },
        },
      })
      .mockRejectedValueOnce(new Error('GraphQL mutation failed'))
      .mockResolvedValueOnce({ resolveReviewThread: { thread: { isResolved: true } } });

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const count = await resolveStaleThreads(octokit, 'owner', 'repo', 1, currentSha);

    expect(count).toBe(1);
    expect(graphqlMock).toHaveBeenCalledTimes(3);
  });
});

function makeGraphqlFetchThreadNode(overrides: {
  id?: string;
  isResolved?: boolean;
  body?: string;
  authorLogin?: string | null;
} = {}) {
  return {
    id: overrides.id ?? 'thread-1',
    isResolved: overrides.isResolved ?? false,
    comments: {
      nodes: [{
        body: overrides.body ?? '<!-- manki:blocker:test-finding --> **Blocker**: test finding',
        author: overrides.authorLogin !== undefined
          ? (overrides.authorLogin === null ? null : { login: overrides.authorLogin })
          : { login: 'github-actions[bot]' },
      }],
    },
  };
}

function makeGraphqlFetchResponse(nodes: ReturnType<typeof makeGraphqlFetchThreadNode>[]) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: { nodes },
      },
    },
  };
}

describe('fetchBotReviewThreads', () => {
  it('returns bot threads with parsed severity and title', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:null-check --> **Blocker**: null check' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:suggestion:rename-var --> **Suggestion**: rename var', isResolved: true }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, 'owner', 'repo', 1);

    expect(threads).toHaveLength(2);
    expect(threads[0]).toEqual({ id: 't1', isResolved: false, isRequired: true, findingTitle: 'null check' });
    expect(threads[1]).toEqual({ id: 't2', isResolved: true, isRequired: false, findingTitle: 'rename var' });
  });

  it('filters out non-bot threads', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:test --> required finding' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: 'just a regular human comment' }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, 'owner', 'repo', 1);

    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe('t1');
  });

  it('identifies threads by BOT_MARKER alone', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: `${BOT_MARKER} some comment without severity` }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, 'owner', 'repo', 1);

    expect(threads).toHaveLength(1);
    expect(threads[0].isRequired).toBe(false);
    expect(threads[0].findingTitle).toBe('Unknown');
  });

  it('parses nit and ignore severities as non-required', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:nitpick:style-issue --> nit' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:ignore:false-positive --> ignore' }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, 'owner', 'repo', 1);

    expect(threads).toHaveLength(2);
    expect(threads[0]).toEqual({ id: 't1', isResolved: false, isRequired: false, findingTitle: 'style issue' });
    expect(threads[1]).toEqual({ id: 't2', isResolved: false, isRequired: false, findingTitle: 'false positive' });
  });

  it('migrates legacy severity markers (`required`, `nit`) on read', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:required:legacy-blocker --> old' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:nit:legacy-nit --> old' }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, 'owner', 'repo', 1);

    expect(threads).toHaveLength(2);
    expect(threads[0].isRequired).toBe(true);
    expect(threads[1].isRequired).toBe(false);
  });

  it('returns empty array when no threads exist', async () => {
    const graphqlMock = jest.fn().mockResolvedValueOnce(
      makeGraphqlFetchResponse([]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, 'owner', 'repo', 1);

    expect(threads).toHaveLength(0);
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

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(false);
  });

  function makeMockOctokit(overrides: {
    threads?: ReturnType<typeof makeGraphqlFetchThreadNode>[];
    prHeadSha?: string;
    createReviewFn?: jest.Mock;
    createCommentFn?: jest.Mock;
    existingReviews?: Array<{ body?: string; state?: string; commit_id?: string; user?: { login?: string; type?: string } }>;
    existingComments?: Array<{ body?: string; user?: { login?: string } }>;
  } = {}) {
    const threads = overrides.threads ?? [];
    const prHeadSha = overrides.prHeadSha ?? 'abc123';
    const createReviewFn = overrides.createReviewFn ?? jest.fn().mockResolvedValue({});
    const createCommentFn = overrides.createCommentFn ?? jest.fn().mockResolvedValue({});
    const existingReviews = overrides.existingReviews ?? [];
    const existingComments = overrides.existingComments ?? [];

    return {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse(threads)),
      paginate: jest.fn().mockResolvedValue(existingComments),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: prHeadSha } } }),
          createReview: createReviewFn,
          listReviews: jest.fn().mockResolvedValue({ data: existingReviews }),
        },
        issues: {
          listComments: jest.fn(),
          createComment: createCommentFn,
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

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE', commit_id: 'sha-456' }),
    );
  });

  it('does not approve when required threads are resolved but suggestions are not', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: true }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:suggestion:style --> style', isResolved: false }),
      ],
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(createReviewMock).not.toHaveBeenCalled();
  });

  it('returns false when unresolved required threads remain', async () => {
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix-bug --> fix', isResolved: false }),
      ],
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(false);
  });

  it('does not approve when only suggestion threads exist and are unresolved', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:suggestion:style --> style', isResolved: false }),
      ],
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

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

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

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

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
  });

  it('posts an issue comment (not a COMMENT review) when APPROVE fails', async () => {
    // A COMMENT-review fallback would register as a bot review on the head SHA
    // and break the force-review tickbox loop ([#840]). The fallback must
    // surface the missing permission via an issue comment instead.
    const createReviewMock = jest.fn().mockRejectedValueOnce(new Error('APPROVE not allowed'));
    const createCommentMock = jest.fn().mockResolvedValue({});

    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: true }),
      ],
      prHeadSha: 'sha-789',
      createReviewFn: createReviewMock,
      createCommentFn: createCommentMock,
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledTimes(1);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      owner: 'owner',
      repo: 'repo',
      issue_number: 1,
      body: expect.stringContaining('auto-approve is blocked'),
    }));
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

    await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    const call = createReviewMock.mock.calls[0][0] as { body: string };
    expect(call.body).toContain(BOT_MARKER);
    // Visible content beyond the HTML comment so GitHub does not strip the body.
    expect(call.body.replace(/<!--[^]*?-->/g, '').trim().length).toBeGreaterThan(0);
  });

  it('dismisses previous reviews before approving', async () => {
    const octokit = makeMockOctokit({
      threads: [],
      createReviewFn: jest.fn().mockResolvedValue({}),
    });

    await checkAndAutoApprove(octokit, 'owner', 'repo', 42);

    expect(dismissPreviousReviews).toHaveBeenCalledWith(octokit, 'owner', 'repo', 42);
  });

  it('continues with approval when dismissPreviousReviews fails', async () => {
    dismissPreviousReviews.mockRejectedValueOnce(new Error('dismiss failed'));
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [],
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
  });

  it('skips duplicate approval when bot already has an active APPROVED review', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [],
      createReviewFn: createReviewMock,
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', user: { login: 'github-actions[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(dismissPreviousReviews).not.toHaveBeenCalled();
  });

  it('creates new approval when latest bot review is CHANGES_REQUESTED', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [],
      prHeadSha: 'sha-new',
      createReviewFn: createReviewMock,
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', user: { login: 'github-actions[bot]', type: 'Bot' } },
        { body: '<!-- manki -->', state: 'CHANGES_REQUESTED', user: { login: 'github-actions[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
  });

  it('creates new approval when previous bot approval was DISMISSED', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [],
      prHeadSha: 'sha-new',
      createReviewFn: createReviewMock,
      existingReviews: [
        { body: '<!-- manki -->', state: 'DISMISSED', user: { login: 'github-actions[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
  });

  describe('stale-SHA guard', () => {
    let warningSpy: jest.SpyInstance;

    beforeEach(() => {
      warningSpy = jest.spyOn(core, 'warning').mockImplementation(() => {});
    });

    afterEach(() => {
      warningSpy.mockRestore();
    });

    it('skips approval, warns, and posts one comment when latest manki review is on a stale SHA', async () => {
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
      });

      const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

      expect(result).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('manki has not reviewed HEAD'),
      );
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('head=head-sha-aaaa'),
      );
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('latest_manki_review=old-sha-bbbb'),
      );
      expect(createCommentMock).toHaveBeenCalledTimes(1);
      expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
        owner: 'owner',
        repo: 'repo',
        issue_number: 1,
        body: expect.stringContaining('<!-- manki-stale-approve:head-sha-aaaa -->'),
      }));
      expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
        body: expect.stringContaining('@manki review'),
      }));
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

      const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

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

      const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

      expect(result).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
      expect(createCommentMock).not.toHaveBeenCalled();
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining('manki has not reviewed HEAD'),
      );
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
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-1' } } }),
          createReview: jest.fn().mockResolvedValue({}),
          listReviews: jest.fn().mockResolvedValue({ data: [] }),
        },
      },
    } as unknown as Octokit;
  }

  it('bails when a different run holds a fresh in-progress marker', async () => {
    mockCheckConcurrentSubmissionLock.mockResolvedValueOnce(true);
    const octokit = makeMockOctokit();
    const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(dismissPreviousReviews).not.toHaveBeenCalled();
    expect(mockIsReviewInProgress).not.toHaveBeenCalled();
  });

  it('proceeds when lock guard returns false', async () => {
    mockCheckConcurrentSubmissionLock.mockResolvedValueOnce(false);
    const octokit = makeMockOctokit();
    const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
    );
  });

  it('forwards the supplied config to the lock guard', async () => {
    mockCheckConcurrentSubmissionLock.mockResolvedValueOnce(false);
    const octokit = makeMockOctokit();
    const config = { concurrency_lock_ttl_seconds: 300 } as Parameters<typeof checkAndAutoApprove>[4];

    await checkAndAutoApprove(octokit, 'owner', 'repo', 1, config);

    expect(mockCheckConcurrentSubmissionLock).toHaveBeenCalledWith(
      octokit, 'owner', 'repo', 1, config,
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
        rest: {
          pulls: {
            get: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-1' } } }),
            createReview: jest.fn().mockResolvedValue({}),
            listReviews: jest.fn().mockResolvedValue({ data: [] }),
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

      const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

      expect(result).toBe(false);
      expect(createReviewMock).not.toHaveBeenCalled();
    });

    it('proceeds when the in-progress marker has aged past the TTL', async () => {
      const octokit = makeOctokit([
        botComment(7, inProgressBody(999), '2026-05-22T10:00:00Z'),
      ]);
      const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;

      const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

      expect(result).toBe(true);
      expect(createReviewMock).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPROVE' }),
      );
    });

    it('proceeds when there is no in-progress marker on the PR', async () => {
      const octokit = makeOctokit([]);
      const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;

      const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

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

      const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

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

        await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

        expect(warningSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid concurrency_lock_ttl_seconds=not-a-number'),
        );
      });

      it('falls back to default and warns when TTL input is zero', async () => {
        process.env['INPUT_CONCURRENCY_LOCK_TTL_SECONDS'] = '0';
        const octokit = makeOctokit([
          botComment(7, inProgressBody(999), '2026-05-22T11:59:00Z'),
        ]);

        await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

        expect(warningSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid concurrency_lock_ttl_seconds=0'),
        );
      });

      it('falls back to default and warns when TTL input is negative', async () => {
        process.env['INPUT_CONCURRENCY_LOCK_TTL_SECONDS'] = '-1';
        const octokit = makeOctokit([
          botComment(7, inProgressBody(999), '2026-05-22T11:59:00Z'),
        ]);

        await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

        expect(warningSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid concurrency_lock_ttl_seconds=-1'),
        );
      });

      it('falls back to default and warns when TTL input exceeds the maximum', async () => {
        process.env['INPUT_CONCURRENCY_LOCK_TTL_SECONDS'] = '9999';
        const octokit = makeOctokit([
          botComment(7, inProgressBody(999), '2026-05-22T11:59:00Z'),
        ]);

        await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

        expect(warningSpy).toHaveBeenCalledWith(
          expect.stringContaining('Invalid concurrency_lock_ttl_seconds=9999'),
        );
      });

      it('falls back to default and warns when .manki.yml-sourced TTL is 0', async () => {
        const octokit = makeOctokit([
          botComment(7, inProgressBody(999), '2026-05-22T11:59:00Z'),
        ]);
        const createReviewMock = (octokit as unknown as { rest: { pulls: { createReview: jest.Mock } } }).rest.pulls.createReview;
        const config = { concurrency_lock_ttl_seconds: 0 } as Parameters<typeof checkAndAutoApprove>[4];

        const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1, config);

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
    markAutoApproveFailed: jest.Mock;
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
    existingReviews?: Array<{ body?: string; state?: string; user?: { login?: string; type?: string } }>;
  } = {}) {
    const createReviewFn = overrides.createReviewFn ?? jest.fn().mockResolvedValue({});
    const createCommentFn = overrides.createCommentFn ?? jest.fn().mockResolvedValue({});
    const existingReviews = overrides.existingReviews ?? [];
    return {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse([])),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-x' } } }),
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
    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(callOrder).toEqual(['post', 'createReview', 'complete']);
    expect(ghMock.markAutoApproveComplete).toHaveBeenCalledWith(octokit, 'owner', 'repo', 7777);
    expect(ghMock.markAutoApproveFailed).not.toHaveBeenCalled();
  });

  it('does not post a marker when the concurrency lock guard bails', async () => {
    ghMock.checkConcurrentSubmissionLock.mockResolvedValueOnce(true);
    const octokit = makeMockOctokit();

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(ghMock.postAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.markAutoApproveComplete).not.toHaveBeenCalled();
    expect(ghMock.markAutoApproveFailed).not.toHaveBeenCalled();
  });

  it('does not post a marker when `isReviewInProgress` returns true', async () => {
    ghMock.isReviewInProgress.mockResolvedValueOnce(true);
    const octokit = makeMockOctokit();

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(ghMock.postAutoApproveProgressComment).not.toHaveBeenCalled();
  });

  it('does not post a marker when unresolved findings remain', async () => {
    const octokit = {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse([
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:blocker:fix --> fix', isResolved: false }),
      ])),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: 'sha-x' } } }),
          createReview: jest.fn().mockResolvedValue({}),
          listReviews: jest.fn().mockResolvedValue({ data: [] }),
        },
      },
    } as unknown as Octokit;

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(false);
    expect(ghMock.postAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.markAutoApproveComplete).not.toHaveBeenCalled();
    expect(ghMock.markAutoApproveFailed).not.toHaveBeenCalled();
  });

  it('does not post a marker when a prior bot approval already exists for the same SHA', async () => {
    const octokit = makeMockOctokit({
      existingReviews: [
        { body: '<!-- manki -->', state: 'APPROVED', user: { login: 'github-actions[bot]', type: 'Bot' } },
      ],
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(ghMock.postAutoApproveProgressComment).not.toHaveBeenCalled();
    expect(ghMock.markAutoApproveComplete).not.toHaveBeenCalled();
  });

  it('transitions the marker to a failure state when APPROVE and the issue-comment fallback both fail', async () => {
    const createReviewMock = jest.fn().mockRejectedValueOnce(new Error('APPROVE forbidden'));
    const createCommentMock = jest.fn().mockRejectedValueOnce(new Error('comment also forbidden'));
    const octokit = makeMockOctokit({ createReviewFn: createReviewMock, createCommentFn: createCommentMock });

    await expect(checkAndAutoApprove(octokit, 'owner', 'repo', 1)).rejects.toThrow('comment also forbidden');
    expect(ghMock.markAutoApproveFailed).toHaveBeenCalledWith(
      octokit, 'owner', 'repo', 7777, 'comment also forbidden',
    );
    expect(ghMock.markAutoApproveComplete).not.toHaveBeenCalled();
  });

  it('still transitions to complete when APPROVE fails but the issue-comment fallback succeeds', async () => {
    const createReviewMock = jest.fn().mockRejectedValueOnce(new Error('APPROVE forbidden'));
    const createCommentMock = jest.fn().mockResolvedValueOnce({});
    const octokit = makeMockOctokit({ createReviewFn: createReviewMock, createCommentFn: createCommentMock });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createCommentMock).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: 1,
      body: expect.stringContaining('auto-approve is blocked'),
    }));
    // Crucially, no `COMMENT` review was posted (which would trip the head-SHA
    // dedupe gate on subsequent force-review ticks, see [#840]).
    expect(createReviewMock).toHaveBeenCalledTimes(1);
    expect(createReviewMock).toHaveBeenCalledWith(expect.objectContaining({ event: 'APPROVE' }));
    expect(ghMock.markAutoApproveComplete).toHaveBeenCalledWith(octokit, 'owner', 'repo', 7777);
    expect(ghMock.markAutoApproveFailed).not.toHaveBeenCalled();
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
    expect(ghActual.findInProgressLock(comments, /* different run */ 999)).not.toBeNull();
    expect(ghActual.findInProgressLock(comments, 12345)).toBeNull();
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
    expect(ghActual.findInProgressLock(comments, 999)).toBeNull();
    expect(updatedBody).toContain('Auto-approved (all findings resolved)');
  });

  it('failure-transition body no longer registers as a live lock', async () => {
    let updatedBody = '';
    const updateComment = jest.fn().mockImplementation(async ({ body }: { body: string }) => {
      updatedBody = body;
      return { data: {} };
    });
    const octokit = { rest: { issues: { updateComment } } } as unknown as Octokit;

    await ghActual.markAutoApproveFailed(octokit, 'o', 'r', 1, 'API rate limited');

    const comments = [
      { id: 1, body: updatedBody, user: { login: 'manki-review[bot]', type: 'Bot' }, updated_at: '2026-05-22T11:59:30Z' },
    ];
    expect(ghActual.findInProgressLock(comments, 999)).toBeNull();
    expect(updatedBody).toContain('API rate limited');
  });
});
