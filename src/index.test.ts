import * as core from '@actions/core';
import * as github from '@actions/github';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  getInput: jest.fn().mockReturnValue(''),
  setOutput: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  context: {
    eventName: '',
    payload: {},
    repo: { owner: 'test-owner', repo: 'test-repo' },
  },
  getOctokit: jest.fn(),
}));

const mockPullsGet = jest.fn().mockResolvedValue({
  data: {
    title: 'Test PR',
    body: 'body',
    head: { sha: 'abc' },
    base: { ref: 'main' },
  },
});

const mockOctokitInstance = {
  rest: {
    pulls: { get: mockPullsGet },
    issues: { deleteComment: jest.fn().mockResolvedValue(undefined) },
  },
};

jest.mock('./auth', () => ({
  createAuthenticatedOctokit: jest.fn().mockResolvedValue(mockOctokitInstance),
  getMemoryToken: jest.fn().mockReturnValue(null),
}));

jest.mock('./claude', () => ({
  ClaudeClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('./config', () => ({
  loadConfig: jest.fn().mockReturnValue({
    auto_review: true,
    max_diff_lines: 5000,
    include_paths: [],
    exclude_paths: [],
    nit_handling: 'issues',
    reviewers: [],
  }),
  resolveModel: jest.fn().mockReturnValue('claude-sonnet-4-20250514'),
}));

jest.mock('./diff', () => ({
  parsePRDiff: jest.fn().mockReturnValue({ files: [], totalAdditions: 0, totalDeletions: 0 }),
  filterFiles: jest.fn().mockReturnValue([]),
  isDiffTooLarge: jest.fn().mockReturnValue(false),
}));

jest.mock('./interaction', () => ({
  handleReviewCommentReply: jest.fn().mockResolvedValue(undefined),
  handlePRComment: jest.fn().mockResolvedValue(undefined),
  isReviewRequest: jest.fn().mockReturnValue(false),
  isBotMentionNonReview: jest.fn().mockReturnValue(false),
  hasBotMention: jest.fn().mockReturnValue(false),
}));

jest.mock('./memory', () => ({
  loadMemory: jest.fn().mockResolvedValue(null),
  applyEscalations: jest.fn((findings: unknown[]) => findings),
  updatePattern: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./recap', () => ({
  fetchRecapState: jest.fn().mockResolvedValue({ previousFindings: [], recapContext: '' }),
  deduplicateFindings: jest.fn().mockReturnValue({ unique: [], duplicates: [] }),
  buildRecapSummary: jest.fn().mockReturnValue(''),
  resolveAddressedThreads: jest.fn().mockResolvedValue(0),
}));

jest.mock('./review', () => ({
  runReview: jest.fn().mockResolvedValue({
    verdict: 'APPROVE',
    summary: 'Looks good',
    findings: [],
    highlights: [],
    reviewComplete: true,
  }),
  determineVerdict: jest.fn().mockReturnValue('APPROVE'),
  selectTeam: jest.fn().mockReturnValue({ level: 'standard', agents: [{ name: 'general' }] }),
}));

jest.mock('./github', () => ({
  fetchPRDiff: jest.fn().mockResolvedValue(''),
  fetchConfigFile: jest.fn().mockResolvedValue(null),
  fetchRepoContext: jest.fn().mockResolvedValue(''),
  fetchSubdirClaudeMd: jest.fn().mockResolvedValue(null),
  fetchFileContents: jest.fn().mockResolvedValue(new Map()),
  postProgressComment: jest.fn().mockResolvedValue(1),
  updateProgressComment: jest.fn().mockResolvedValue(undefined),
  updateProgressDashboard: jest.fn().mockResolvedValue(undefined),
  dismissPreviousReviews: jest.fn().mockResolvedValue(undefined),
  postReview: jest.fn().mockResolvedValue(123),
  createNitIssue: jest.fn().mockResolvedValue(undefined),
  reactToIssueComment: jest.fn().mockResolvedValue(undefined),
  fetchLinkedIssues: jest.fn().mockResolvedValue([]),
}));

jest.mock('./state', () => ({
  checkAndAutoApprove: jest.fn().mockResolvedValue(false),
  resolveStaleThreads: jest.fn().mockResolvedValue(0),
}));

import { run, handlePullRequest, handleCommentTrigger, handleReviewCommentInteraction, handleReviewStateCheck, main, _resetOctokitCache } from './index';
import * as interaction from './interaction';
import * as ghUtils from './github';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = github.context as any;

function setContext(overrides: Record<string, unknown>): void {
  ctx.eventName = overrides.eventName ?? '';
  ctx.payload = overrides.payload ?? {};
  ctx.repo = overrides.repo ?? { owner: 'test-owner', repo: 'test-repo' };
}

describe('run', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
    setContext({ eventName: '', payload: {} });
  });

  describe('bot self-triggering prevention', () => {
    it('ignores events from manki-labs[bot]', async () => {
      setContext({
        eventName: 'pull_request',
        payload: { action: 'opened', sender: { login: 'manki-labs[bot]' } },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Ignoring event from bot: manki-labs[bot]',
      );
    });

    it('ignores events from github-actions[bot]', async () => {
      setContext({
        eventName: 'pull_request',
        payload: { action: 'opened', sender: { login: 'github-actions[bot]' } },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Ignoring event from bot: github-actions[bot]',
      );
    });
  });

  describe('pull_request event filtering', () => {
    it('skips pull_request events with non-opened/synchronize action', async () => {
      setContext({
        eventName: 'pull_request',
        payload: { action: 'closed', sender: { login: 'user' } },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Ignoring pull_request action: closed',
      );
    });

    it('processes pull_request opened events', async () => {
      setContext({
        eventName: 'pull_request',
        payload: {
          action: 'opened',
          sender: { login: 'user' },
          pull_request: {
            number: 1,
            head: { sha: 'abc123' },
            base: { ref: 'main' },
            title: 'Test PR',
            body: 'Test body',
            draft: false,
          },
        },
      });

      await run();

      expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
    });

    it('processes pull_request synchronize events', async () => {
      setContext({
        eventName: 'pull_request',
        payload: {
          action: 'synchronize',
          sender: { login: 'user' },
          pull_request: {
            number: 1,
            head: { sha: 'abc123' },
            base: { ref: 'main' },
            title: 'Test PR',
            body: 'Test body',
            draft: false,
          },
        },
      });

      await run();

      expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
    });
  });

  describe('issue_comment event filtering', () => {
    it('skips issue_comment events with non-created action', async () => {
      setContext({
        eventName: 'issue_comment',
        payload: { action: 'deleted', sender: { login: 'user' } },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Ignoring issue_comment action: deleted',
      );
    });

    it('skips comments that do not mention the bot', async () => {
      jest.mocked(interaction.hasBotMention).mockReturnValue(false);
      jest.mocked(interaction.isReviewRequest).mockReturnValue(false);

      setContext({
        eventName: 'issue_comment',
        payload: {
          action: 'created',
          sender: { login: 'user' },
          comment: { body: 'just a regular comment' },
        },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Comment does not mention Manki — ignoring',
      );
    });

    it('routes review request on PR to handleCommentTrigger', async () => {
      jest.mocked(interaction.hasBotMention).mockReturnValue(true);
      jest.mocked(interaction.isReviewRequest).mockReturnValue(true);

      setContext({
        eventName: 'issue_comment',
        payload: {
          action: 'created',
          sender: { login: 'user' },
          comment: { body: '@manki review', id: 42 },
          issue: { number: 5, pull_request: { url: 'https://...' } },
        },
      });

      await run();

      expect(jest.mocked(ghUtils.reactToIssueComment)).toHaveBeenCalledWith(
        expect.anything(), 'test-owner', 'test-repo', 42, 'eyes',
      );
    });

    it('routes bot mention non-review on PR to handleInteraction', async () => {
      jest.mocked(interaction.hasBotMention).mockReturnValue(true);
      jest.mocked(interaction.isReviewRequest).mockReturnValue(false);
      jest.mocked(interaction.isBotMentionNonReview).mockReturnValue(true);

      setContext({
        eventName: 'issue_comment',
        payload: {
          action: 'created',
          sender: { login: 'user' },
          comment: { body: '@manki explain this' },
          issue: { number: 5, pull_request: { url: 'https://...' } },
        },
      });

      await run();

      expect(jest.mocked(interaction.handlePRComment)).toHaveBeenCalled();
    });

    it('routes bot mention on issue (not PR) to handleIssueInteraction', async () => {
      jest.mocked(interaction.hasBotMention).mockReturnValue(true);
      jest.mocked(interaction.isReviewRequest).mockReturnValue(false);
      jest.mocked(interaction.isBotMentionNonReview).mockReturnValue(true);

      setContext({
        eventName: 'issue_comment',
        payload: {
          action: 'created',
          sender: { login: 'user' },
          comment: { body: '@manki help', user: { type: 'User' } },
          issue: { number: 10 },
        },
      });

      await run();

      expect(jest.mocked(interaction.handlePRComment)).toHaveBeenCalledWith(
        expect.anything(), null, 'test-owner', 'test-repo', 10,
        undefined, undefined, expect.anything(),
      );
    });
  });

  describe('pull_request_review_comment event filtering', () => {
    it('skips non-created actions', async () => {
      setContext({
        eventName: 'pull_request_review_comment',
        payload: { action: 'edited', sender: { login: 'user' } },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Ignoring pull_request_review_comment action: edited',
      );
    });

    it('skips own review comments containing manki marker', async () => {
      setContext({
        eventName: 'pull_request_review_comment',
        payload: {
          action: 'created',
          sender: { login: 'user' },
          comment: { body: 'Some text <!-- manki --> more text' },
        },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Ignoring our own review comment',
      );
    });

    it('routes valid review comments to handler', async () => {
      jest.mocked(interaction.hasBotMention).mockReturnValue(true);

      setContext({
        eventName: 'pull_request_review_comment',
        payload: {
          action: 'created',
          sender: { login: 'user' },
          comment: {
            body: '@manki explain this',
            in_reply_to_id: 123,
            user: { type: 'User' },
          },
          pull_request: { base: { ref: 'main' } },
        },
      });

      await run();

      expect(jest.mocked(interaction.handleReviewCommentReply)).toHaveBeenCalled();
    });
  });

  describe('pull_request_review event filtering', () => {
    it('skips non-submitted/dismissed actions', async () => {
      setContext({
        eventName: 'pull_request_review',
        payload: { action: 'edited', sender: { login: 'user' } },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Ignoring pull_request_review action: edited',
      );
    });

    it('routes submitted review to state check', async () => {
      setContext({
        eventName: 'pull_request_review',
        payload: {
          action: 'submitted',
          sender: { login: 'user' },
          pull_request: {
            number: 1,
            base: { ref: 'main' },
          },
        },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Review submitted/dismissed — checking if auto-approve is warranted',
      );
    });
  });

  describe('unsupported events', () => {
    it('ignores unsupported event types', async () => {
      setContext({
        eventName: 'push',
        payload: { sender: { login: 'user' } },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Ignoring unsupported event: push',
      );
    });
  });
});

describe('handlePullRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
  });

  it('warns when no pull request in payload', async () => {
    setContext({
      eventName: 'pull_request',
      payload: { action: 'opened', sender: { login: 'user' } },
    });

    await handlePullRequest();

    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      'No pull request found in event payload',
    );
  });

  it('skips draft PRs', async () => {
    setContext({
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        sender: { login: 'user' },
        pull_request: {
          number: 1,
          head: { sha: 'abc' },
          base: { ref: 'main' },
          title: 'Draft PR',
          body: '',
          draft: true,
        },
      },
    });

    await handlePullRequest();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Skipping draft PR');
    expect(jest.mocked(ghUtils.postProgressComment)).not.toHaveBeenCalled();
  });
});

describe('handleCommentTrigger', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
  });

  it('skips when comment is on an issue, not a PR', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1 },
        comment: { body: '@manki review' },
      },
    });

    await handleCommentTrigger();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'Comment is on an issue, not a PR — skipping',
    );
  });
});

describe('handleReviewCommentInteraction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
  });

  it('returns early when no comment in payload', async () => {
    setContext({
      eventName: 'pull_request_review_comment',
      payload: { action: 'created' },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(interaction.handleReviewCommentReply)).not.toHaveBeenCalled();
  });

  it('skips bot comments', async () => {
    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: { body: 'test', user: { type: 'Bot' } },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(interaction.handleReviewCommentReply)).not.toHaveBeenCalled();
  });

  it('skips comments with manki marker', async () => {
    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: { body: '<!-- manki -->', user: { type: 'User' } },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(interaction.handleReviewCommentReply)).not.toHaveBeenCalled();
  });

  it('skips comments that are not replies and do not mention bot', async () => {
    jest.mocked(interaction.hasBotMention).mockReturnValue(false);

    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: { body: 'regular comment', user: { type: 'User' } },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'Review comment is not a reply to bot or @manki mention — skipping',
    );
  });
});

describe('handleReviewStateCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
  });

  it('skips when no pull request in payload', async () => {
    setContext({
      eventName: 'pull_request_review',
      payload: { action: 'submitted' },
    });

    await handleReviewStateCheck();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'No pull request in payload — skipping auto-approve check',
    );
  });
});

describe('main', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
  });

  it('catches errors and reports via core.warning', async () => {
    setContext({
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        sender: { login: 'user' },
        pull_request: {
          number: 1,
          head: { sha: 'abc' },
          base: { ref: 'main' },
          title: 'Test',
          body: '',
          draft: false,
        },
      },
    });

    const error = new Error('Something broke');
    jest.mocked(ghUtils.postProgressComment).mockRejectedValueOnce(error);

    // Mock process.exit to prevent test from exiting
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => {}) as any,
    );

    await main();

    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      'Manki encountered an error: Error: Something broke',
    );
    exitSpy.mockRestore();
  });

  it('always exits with code 0', async () => {
    setContext({
      eventName: 'push',
      payload: { sender: { login: 'user' } },
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => {}) as any,
    );

    await main();

    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });
});
