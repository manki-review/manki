import { areAllRequiredResolved, resolveStaleThreads, ReviewThread } from './state';

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
});
