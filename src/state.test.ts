import { areAllRequiredResolved, resolveStaleThreads, fetchBotReviewThreads, checkAndAutoApprove, BOT_MARKER, ReviewThread } from './state';

jest.mock('./github', () => ({
  dismissPreviousReviews: jest.fn().mockResolvedValue(undefined),
  isReviewInProgress: jest.fn().mockResolvedValue(false),
}));

const makeThread = (overrides: Partial<ReviewThread> = {}): ReviewThread => ({
  id: 'thread-1',
  isResolved: false,
  isRequired: false,
  findingTitle: 'Test finding',
  ...overrides,
});

describe('areAllRequiredResolved', () => {
  it('returns true when there are no required threads', () => {
    const threads = [
      makeThread({ id: '1', isRequired: false, isResolved: false }),
      makeThread({ id: '2', isRequired: false, isResolved: true }),
    ];
    expect(areAllRequiredResolved(threads)).toBe(true);
  });

  it('returns true when all required threads are resolved', () => {
    const threads = [
      makeThread({ id: '1', isRequired: true, isResolved: true }),
      makeThread({ id: '2', isRequired: true, isResolved: true }),
    ];
    expect(areAllRequiredResolved(threads)).toBe(true);
  });

  it('returns false when some required threads are unresolved', () => {
    const threads = [
      makeThread({ id: '1', isRequired: true, isResolved: true }),
      makeThread({ id: '2', isRequired: true, isResolved: false }),
    ];
    expect(areAllRequiredResolved(threads)).toBe(false);
  });

  it('returns true when required threads are resolved and suggestions are not', () => {
    const threads = [
      makeThread({ id: '1', isRequired: true, isResolved: true }),
      makeThread({ id: '2', isRequired: false, isResolved: false }),
      makeThread({ id: '3', isRequired: false, isResolved: false }),
    ];
    expect(areAllRequiredResolved(threads)).toBe(true);
  });

  it('returns true for an empty array', () => {
    expect(areAllRequiredResolved([])).toBe(true);
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
        body: overrides.body ?? '<!-- manki:required:test --> **Required**: test',
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
        body: overrides.body ?? '<!-- manki:required:test-finding --> **Required**: test finding',
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
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:required:null-check --> **Required**: null check' }),
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
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:required:test --> required finding' }),
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
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:nit:style-issue --> nit' }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:ignore:false-positive --> ignore' }),
      ]),
    );

    const octokit = { graphql: graphqlMock } as unknown as Octokit;
    const threads = await fetchBotReviewThreads(octokit, 'owner', 'repo', 1);

    expect(threads).toHaveLength(2);
    expect(threads[0]).toEqual({ id: 't1', isResolved: false, isRequired: false, findingTitle: 'style issue' });
    expect(threads[1]).toEqual({ id: 't2', isResolved: false, isRequired: false, findingTitle: 'false positive' });
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
    mockIsReviewInProgress.mockResolvedValueOnce(5);
    const octokit = {} as unknown as Octokit;

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(false);
  });

  function makeMockOctokit(overrides: {
    threads?: ReturnType<typeof makeGraphqlFetchThreadNode>[];
    prHeadSha?: string;
    createReviewFn?: jest.Mock;
    existingReviews?: Array<{ body?: string; state?: string; user?: { login?: string; type?: string } }>;
  } = {}) {
    const threads = overrides.threads ?? [];
    const prHeadSha = overrides.prHeadSha ?? 'abc123';
    const createReviewFn = overrides.createReviewFn ?? jest.fn().mockResolvedValue({});
    const existingReviews = overrides.existingReviews ?? [];

    return {
      graphql: jest.fn().mockResolvedValue(makeGraphqlFetchResponse(threads)),
      rest: {
        pulls: {
          get: jest.fn().mockResolvedValue({ data: { head: { sha: prHeadSha } } }),
          createReview: createReviewFn,
          listReviews: jest.fn().mockResolvedValue({ data: existingReviews }),
        },
      },
    } as unknown as Octokit;
  }

  it('approves when all required threads are resolved', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:required:fix-bug --> fix', isResolved: true }),
        makeGraphqlFetchThreadNode({ id: 't2', body: '<!-- manki:suggestion:style --> style', isResolved: false }),
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

  it('returns false when unresolved required threads remain', async () => {
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:required:fix-bug --> fix', isResolved: false }),
      ],
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(false);
  });

  it('approves when there are no required threads', async () => {
    const createReviewMock = jest.fn().mockResolvedValue({});
    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:suggestion:style --> style', isResolved: false }),
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

  it('falls back to COMMENT when APPROVE fails', async () => {
    const createReviewMock = jest.fn()
      .mockRejectedValueOnce(new Error('APPROVE not allowed'))
      .mockResolvedValueOnce({});

    const octokit = makeMockOctokit({
      threads: [
        makeGraphqlFetchThreadNode({ id: 't1', body: '<!-- manki:required:fix --> fix', isResolved: true }),
      ],
      prHeadSha: 'sha-789',
      createReviewFn: createReviewMock,
    });

    const result = await checkAndAutoApprove(octokit, 'owner', 'repo', 1);

    expect(result).toBe(true);
    expect(createReviewMock).toHaveBeenCalledTimes(2);
    expect(createReviewMock).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ event: 'APPROVE' }),
    );
    expect(createReviewMock).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ event: 'COMMENT' }),
    );
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
});
