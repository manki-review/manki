import * as core from '@actions/core';
import * as github from '@actions/github';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
  debug: jest.fn(),
  getInput: jest.fn().mockReturnValue(''),
  setOutput: jest.fn(),
  setFailed: jest.fn(),
  getState: jest.fn().mockReturnValue(''),
  saveState: jest.fn(),
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

const mockListReviews = jest.fn().mockResolvedValue({ data: [] });

const mockListReactionsForIssueComment = jest.fn().mockResolvedValue({ data: [] });

const mockListComments = jest.fn().mockResolvedValue({ data: [] });

const mockGraphql = jest.fn().mockResolvedValue({ resolveReviewThread: { thread: { isResolved: true } } });

const mockOctokitInstance = {
  rest: {
    pulls: { get: mockPullsGet, listReviews: mockListReviews },
    issues: { deleteComment: jest.fn().mockResolvedValue(undefined), listComments: mockListComments, createComment: jest.fn().mockResolvedValue({ data: { id: 999 } }), updateComment: jest.fn().mockResolvedValue({}) },
    reactions: { listForIssueComment: mockListReactionsForIssueComment },
  },
  graphql: mockGraphql,
};

jest.mock('./auth', () => ({
  createAuthenticatedOctokit: jest.fn().mockResolvedValue({ octokit: mockOctokitInstance, resolvedToken: 'mock-resolved-token', identity: 'app' }),
  getMemoryToken: jest.fn().mockReturnValue(null),
}));

jest.mock('./claude', () => ({
  ClaudeClient: jest.fn().mockImplementation(() => ({})),
}));

jest.mock('./config', () => ({
  loadConfig: jest.fn().mockReturnValue({
    auto_review: true,
    max_diff_lines: 5000,
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
  handleReviewCommentCommand: jest.fn().mockResolvedValue(undefined),
  handlePRComment: jest.fn().mockResolvedValue(undefined),
  isReviewRequest: jest.fn().mockReturnValue(false),
  isBotMentionNonReview: jest.fn().mockReturnValue(false),
  hasBotMention: jest.fn().mockReturnValue(false),
  parseCommand: jest.fn().mockReturnValue({ type: 'generic', args: '' }),
  isRepoUser: jest.requireActual('./interaction').isRepoUser,
  isLLMAccessAllowed: jest.requireActual('./interaction').isLLMAccessAllowed,
}));

jest.mock('./memory', () => ({
  loadMemory: jest.fn().mockResolvedValue(null),
  applyEscalations: jest.fn((findings: unknown[]) => findings),
  updatePattern: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('./recap', () => ({
  fetchRecapState: jest.fn().mockResolvedValue({ previousFindings: [], recapContext: '' }),
  deduplicateFindings: jest.fn().mockReturnValue({ unique: [], duplicates: [] }),
  llmDeduplicateFindings: jest.fn().mockResolvedValue({ unique: [], duplicates: [] }),
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
  isReviewInProgress: jest.fn().mockResolvedValue(false),
  isApprovedOnCommit: jest.fn().mockResolvedValue(false),
  markOwnProgressCommentCancelled: jest.fn().mockResolvedValue(false),
  postAppWarningIfNeeded: jest.fn().mockResolvedValue(undefined),
  cancelActiveReviewRun: jest.fn().mockResolvedValue(false),
  BOT_LOGIN: 'manki-review[bot]',
  BOT_MARKER: '<!-- manki-bot -->',
  REVIEW_COMPLETE_MARKER: '<!-- manki-review-complete -->',
  FORCE_REVIEW_MARKER: '<!-- manki-force-review -->',
  APP_WARNING_MARKER: '<!-- manki-app-warning -->',
}));

jest.mock('./state', () => ({
  checkAndAutoApprove: jest.fn().mockResolvedValue(false),
  resolveStaleThreads: jest.fn().mockResolvedValue(0),
}));

import { run, runFullReview, handlePullRequest, handleCommentTrigger, handleInteraction, handleIssueInteraction, handleReviewCommentInteraction, handleReviewStateCheck, main, _resetOctokitCache } from './index';
import { FORCE_REVIEW_MARKER } from './github';
import * as interaction from './interaction';
import * as ghUtils from './github';
import * as diffModule from './diff';
import * as configModule from './config';
import * as reviewModule from './review';
import * as recapModule from './recap';
import * as memoryModule from './memory';
import * as stateModule from './state';
import * as authModule from './auth';

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
    // Provide a valid API key so runFullReview passes early validation
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'test-api-key' : '',
    );
  });

  describe('bot self-triggering prevention', () => {
    it('ignores events from any bot sender', async () => {
      setContext({
        eventName: 'pull_request',
        payload: { action: 'opened', sender: { login: 'dependabot[bot]', type: 'Bot' } },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Ignoring event from bot: dependabot[bot]',
      );
    });

    it('ignores pull_request_review events where review author is a bot', async () => {
      setContext({
        eventName: 'pull_request_review',
        payload: {
          action: 'submitted',
          sender: { login: 'some-human', type: 'User' },
          review: { user: { login: 'manki-review[bot]', type: 'Bot' } },
          pull_request: { number: 1, base: { ref: 'main' } },
        },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Ignoring event from bot: manki-review[bot]',
      );
    });

    it('does not ignore events from human users', async () => {
      setContext({
        eventName: 'pull_request',
        payload: {
          action: 'opened',
          sender: { login: 'some-user', type: 'User' },
          pull_request: { number: 1, head: { sha: 'abc' }, base: { ref: 'main' }, title: 'Test', body: '', draft: false },
        },
      });

      await run();

      expect(jest.mocked(core.info)).not.toHaveBeenCalledWith(
        expect.stringContaining('Ignoring event from bot'),
      );
    });

    it('does not ignore events from human users even without explicit type', async () => {
      setContext({
        eventName: 'pull_request',
        payload: {
          action: 'opened',
          sender: { login: 'some-user' },
          pull_request: { number: 1, head: { sha: 'abc' }, base: { ref: 'main' }, title: 'Test', body: '', draft: false },
        },
      });

      await run();

      expect(jest.mocked(core.info)).not.toHaveBeenCalledWith(
        expect.stringContaining('Ignoring event from bot'),
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
    it('skips issue_comment events with unsupported action', async () => {
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
          comment: { body: '@manki review', id: 42, author_association: 'COLLABORATOR' },
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

    it('skips edited comments that already have eyes reaction from bot', async () => {
      jest.mocked(interaction.hasBotMention).mockReturnValue(true);
      jest.mocked(interaction.isReviewRequest).mockReturnValue(true);
      mockListReactionsForIssueComment.mockResolvedValueOnce({
        data: [{ content: 'eyes', user: { login: 'manki-review[bot]' } }],
      });

      setContext({
        eventName: 'issue_comment',
        payload: {
          action: 'edited',
          sender: { login: 'user' },
          comment: { body: '@manki review', id: 99 },
          issue: { number: 5, pull_request: { url: 'https://...' } },
        },
      });

      await run();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        'Edited comment already processed (has eyes reaction) — skipping',
      );
      expect(jest.mocked(ghUtils.reactToIssueComment)).not.toHaveBeenCalled();
    });

    it('processes edited comments that have no eyes reaction from bot', async () => {
      jest.mocked(interaction.hasBotMention).mockReturnValue(true);
      jest.mocked(interaction.isReviewRequest).mockReturnValue(true);
      mockListReactionsForIssueComment.mockResolvedValueOnce({
        data: [{ content: 'heart', user: { login: 'some-user' } }],
      });

      setContext({
        eventName: 'issue_comment',
        payload: {
          action: 'edited',
          sender: { login: 'user' },
          comment: { body: '@manki review', id: 99, author_association: 'COLLABORATOR' },
          issue: { number: 5, pull_request: { url: 'https://...' } },
        },
      });

      await run();

      // Should proceed to handle the comment (reactToIssueComment is called in handleCommentTrigger)
      expect(jest.mocked(ghUtils.reactToIssueComment)).toHaveBeenCalled();
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

    it('routes generic review comments to handleReviewCommentReply', async () => {
      jest.mocked(interaction.hasBotMention).mockReturnValueOnce(true);
      jest.mocked(interaction.parseCommand).mockReturnValueOnce({ type: 'generic', args: '' });

      setContext({
        eventName: 'pull_request_review_comment',
        payload: {
          action: 'created',
          sender: { login: 'user' },
          comment: {
            body: '@manki what do you think?',
            in_reply_to_id: 123,
            user: { type: 'User' },
          },
          pull_request: { number: 1, base: { ref: 'main' } },
        },
      });

      await run();

      expect(jest.mocked(interaction.handleReviewCommentReply)).toHaveBeenCalled();
      expect(jest.mocked(interaction.handleReviewCommentCommand)).not.toHaveBeenCalled();
    });

    it('routes command review comments to handleReviewCommentCommand', async () => {
      jest.mocked(interaction.hasBotMention).mockReturnValueOnce(true);
      jest.mocked(interaction.parseCommand).mockReturnValueOnce({ type: 'dismiss', args: 'null-check' });

      setContext({
        eventName: 'pull_request_review_comment',
        payload: {
          action: 'created',
          sender: { login: 'user' },
          comment: {
            id: 55,
            body: '/manki dismiss null-check',
            in_reply_to_id: 123,
            user: { type: 'User' },
          },
          pull_request: { number: 1, base: { ref: 'main' } },
        },
      });

      await run();

      expect(jest.mocked(interaction.handleReviewCommentCommand)).toHaveBeenCalled();
      expect(jest.mocked(interaction.handleReviewCommentReply)).not.toHaveBeenCalled();
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

  it('skips when review is already in progress and posts skip comment', async () => {
    jest.mocked(ghUtils.isReviewInProgress).mockResolvedValueOnce(true);

    setContext({
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        sender: { login: 'user' },
        pull_request: {
          number: 1,
          head: { sha: 'abc' },
          base: { ref: 'main' },
          title: 'Test PR',
          body: '',
          draft: false,
        },
      },
    });

    await handlePullRequest();

    expect(mockOctokitInstance.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Review skipped') }),
    );
    const skipBody = mockOctokitInstance.rest.issues.createComment.mock.calls[0][0].body as string;
    expect(skipBody).toContain(FORCE_REVIEW_MARKER);
    expect(skipBody).toContain('- [ ] Force review');
    expect(jest.mocked(ghUtils.postProgressComment)).not.toHaveBeenCalled();
  });

  it('updates existing skip comment instead of creating a duplicate', async () => {
    jest.mocked(ghUtils.isReviewInProgress).mockResolvedValueOnce(true);
    mockListComments.mockResolvedValueOnce({
      data: [
        {
          id: 77,
          body: '<!-- manki-bot -->\n**Review skipped** — a review is currently in progress.',
          user: { login: 'manki-review[bot]', type: 'Bot' },
        },
      ],
    });

    setContext({
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        sender: { login: 'user' },
        pull_request: {
          number: 1,
          head: { sha: 'abc' },
          base: { ref: 'main' },
          title: 'Test PR',
          body: '',
          draft: false,
        },
      },
    });

    await handlePullRequest();

    expect(mockOctokitInstance.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 77, body: expect.stringContaining('Review skipped') }),
    );
    expect(mockOctokitInstance.rest.issues.createComment).not.toHaveBeenCalled();
  });

  it('skips review when already approved on this commit', async () => {
    jest.mocked(ghUtils.isApprovedOnCommit).mockResolvedValueOnce(true);

    setContext({
      eventName: 'pull_request',
      payload: {
        action: 'opened',
        sender: { login: 'user' },
        pull_request: {
          number: 1,
          head: { sha: 'abc' },
          base: { ref: 'main' },
          title: 'Test PR',
          body: '',
          draft: false,
        },
      },
    });

    await handlePullRequest();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Already approved on this commit — skipping review');
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

  it('cancels in-progress review and proceeds when review is already running', async () => {
    jest.mocked(ghUtils.isReviewInProgress).mockResolvedValueOnce(true);
    jest.mocked(ghUtils.cancelActiveReviewRun).mockResolvedValueOnce(true);

    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 42, body: '@manki review', author_association: 'COLLABORATOR' },
      },
    });

    await handleCommentTrigger();

    expect(jest.mocked(ghUtils.reactToIssueComment)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'eyes',
    );
    expect(jest.mocked(ghUtils.cancelActiveReviewRun)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 1,
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Cancelled in-progress review — proceeding with new review');
    expect(jest.mocked(ghUtils.isApprovedOnCommit)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 1, expect.any(String),
    );
    expect(mockOctokitInstance.rest.issues.createComment).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Review skipped') }),
    );
    expect(mockOctokitInstance.rest.pulls.get).toHaveBeenCalled();
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
  });

  it('skips review after cancel when already approved on current commit', async () => {
    jest.mocked(ghUtils.isReviewInProgress).mockResolvedValueOnce(true);
    jest.mocked(ghUtils.cancelActiveReviewRun).mockResolvedValueOnce(true);
    jest.mocked(ghUtils.isApprovedOnCommit).mockResolvedValueOnce(true);

    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 42, body: '@manki review', author_association: 'COLLABORATOR' },
      },
    });

    await handleCommentTrigger();

    expect(jest.mocked(ghUtils.cancelActiveReviewRun)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 1,
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Cancelled in-progress review — proceeding with new review');
    expect(jest.mocked(ghUtils.isApprovedOnCommit)).toHaveBeenCalled();
    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Already approved on this commit — skipping review');
    expect(jest.mocked(ghUtils.postProgressComment)).not.toHaveBeenCalled();
  });

  it('proceeds even when cancel fails for in-progress review', async () => {
    jest.mocked(ghUtils.isReviewInProgress).mockResolvedValueOnce(true);
    jest.mocked(ghUtils.cancelActiveReviewRun).mockResolvedValueOnce(false);

    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 42, body: '@manki review', author_association: 'COLLABORATOR' },
      },
    });

    await handleCommentTrigger();

    expect(jest.mocked(ghUtils.cancelActiveReviewRun)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 1,
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Could not cancel in-progress review — proceeding anyway');
    expect(jest.mocked(ghUtils.isApprovedOnCommit)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 1, expect.any(String),
    );
    expect(mockOctokitInstance.rest.pulls.get).toHaveBeenCalled();
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
  });

  it('does not call cancelActiveReviewRun when forceReview is true', async () => {
    jest.mocked(ghUtils.isReviewInProgress).mockResolvedValueOnce(true); // there IS an in-progress review

    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 42, body: '@manki review', author_association: 'COLLABORATOR' },
      },
    });

    await handleCommentTrigger(true);

    expect(jest.mocked(ghUtils.isReviewInProgress)).not.toHaveBeenCalled(); // entire block skipped
    expect(jest.mocked(ghUtils.cancelActiveReviewRun)).not.toHaveBeenCalled();
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
  });

  it('does not call cancelActiveReviewRun when no review is in progress', async () => {
    // Reset to clear any once-values leaked from preceding tests
    jest.mocked(ghUtils.isReviewInProgress).mockReset().mockResolvedValue(false);
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 42, body: '@manki review', author_association: 'COLLABORATOR' },
      },
    });

    await handleCommentTrigger();

    expect(jest.mocked(ghUtils.cancelActiveReviewRun)).not.toHaveBeenCalled();
  });

  it('skips review when already approved on this commit', async () => {
    jest.mocked(ghUtils.isApprovedOnCommit).mockResolvedValueOnce(true);

    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 42, body: '@manki-review review', author_association: 'COLLABORATOR' },
      },
    });

    await handleCommentTrigger();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Already approved on this commit — skipping review');
    expect(jest.mocked(ghUtils.postProgressComment)).not.toHaveBeenCalled();
  });

  it('ignores review request from NONE association non-PR-author', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' }, user: { login: 'pr-author' } },
        comment: { id: 42, body: '@manki review', author_association: 'NONE' },
        sender: { login: 'stranger' },
      },
    });

    await handleCommentTrigger();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith(expect.stringContaining('Ignoring review request from stranger'));
    expect(jest.mocked(ghUtils.reactToIssueComment)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'eyes',
    );
    expect(mockOctokitInstance.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Only repo contributors can trigger reviews') }),
    );
    expect(mockOctokitInstance.rest.pulls.get).not.toHaveBeenCalled();
  });

  it('allows review request from CONTRIBUTOR', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' }, user: { login: 'pr-author' } },
        comment: { id: 42, body: '@manki review', author_association: 'CONTRIBUTOR' },
        sender: { login: 'contributor-user' },
      },
    });

    await handleCommentTrigger();

    expect(jest.mocked(core.info)).not.toHaveBeenCalledWith(expect.stringContaining('Ignoring review request'));
    expect(mockOctokitInstance.rest.pulls.get).toHaveBeenCalled();
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
  });

  it('allows review request from PR author with NONE association', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' }, user: { login: 'pr-author' } },
        comment: { id: 42, body: '@manki review', author_association: 'NONE' },
        sender: { login: 'pr-author' },
      },
    });

    await handleCommentTrigger();

    expect(jest.mocked(core.info)).not.toHaveBeenCalledWith(expect.stringContaining('Ignoring review request'));
    expect(mockOctokitInstance.rest.pulls.get).toHaveBeenCalled();
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
  });

  it('blocks force review from NONE-association non-PR-author', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' }, user: { login: 'pr-author' } },
        comment: { id: 42, body: '@manki review', author_association: 'NONE' },
        sender: { login: 'stranger' },
      },
    });

    await handleCommentTrigger(true);

    expect(jest.mocked(core.info)).toHaveBeenCalledWith(expect.stringContaining('Ignoring review request from stranger'));
    expect(jest.mocked(ghUtils.reactToIssueComment)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'eyes',
    );
    expect(mockOctokitInstance.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Only repo contributors can trigger reviews') }),
    );
    expect(mockOctokitInstance.rest.pulls.get).not.toHaveBeenCalled();
  });
});

describe('isApprovedOnCommit guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
  });

  const prPayload = {
    action: 'opened',
    sender: { login: 'user' },
    pull_request: {
      number: 1,
      head: { sha: 'abc' },
      base: { ref: 'main' },
      title: 'Test PR',
      body: '',
      draft: false,
    },
  };

  const commentPayload = {
    action: 'created',
    issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
    comment: { id: 42, body: '@manki review', author_association: 'COLLABORATOR' },
  };

  it('skips review when already approved on commit', async () => {
    jest.mocked(ghUtils.isApprovedOnCommit).mockResolvedValueOnce(true);

    setContext({ eventName: 'pull_request', payload: prPayload });
    await handlePullRequest();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Already approved on this commit — skipping review');
    expect(jest.mocked(ghUtils.postProgressComment)).not.toHaveBeenCalled();
  });

  it('proceeds when not approved on commit', async () => {
    jest.mocked(ghUtils.isApprovedOnCommit).mockResolvedValueOnce(false);

    setContext({ eventName: 'pull_request', payload: prPayload });
    await handlePullRequest();

    expect(jest.mocked(core.info)).not.toHaveBeenCalledWith('Already approved on this commit — skipping review');
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
  });

  it('skips review via handleCommentTrigger when already approved on commit', async () => {
    jest.mocked(ghUtils.isApprovedOnCommit).mockResolvedValueOnce(true);

    setContext({ eventName: 'issue_comment', payload: commentPayload });
    await handleCommentTrigger();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Already approved on this commit — skipping review');
    expect(jest.mocked(ghUtils.postProgressComment)).not.toHaveBeenCalled();
    expect(jest.mocked(ghUtils.reactToIssueComment)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'eyes',
    );
  });

  it('force review bypasses the approved-on-commit check', async () => {
    setContext({ eventName: 'issue_comment', payload: commentPayload });
    await handleCommentTrigger(true);

    expect(jest.mocked(core.info)).not.toHaveBeenCalledWith('Already approved on this commit — skipping review');
    expect(jest.mocked(ghUtils.isApprovedOnCommit)).not.toHaveBeenCalled();
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

  it('skips auto-approve when review is for a stale commit', async () => {
    setContext({
      eventName: 'pull_request_review',
      payload: {
        action: 'submitted',
        review: { commit_id: 'old-sha-111' },
        pull_request: {
          number: 1,
          head: { sha: 'new-sha-222' },
          base: { ref: 'main' },
        },
      },
    });

    await handleReviewStateCheck();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'Review is for stale commit old-sha-111, HEAD is new-sha-222 — skipping auto-approve',
    );
    expect(jest.mocked(stateModule.checkAndAutoApprove)).not.toHaveBeenCalled();
  });
});

describe('main', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'test-api-key' : '',
    );
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

    await main();

    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      'Manki encountered an error: Error: Something broke',
    );
  });

  it('does not call process.exit so exit code propagates to post step', async () => {
    setContext({
      eventName: 'push',
      payload: { sender: { login: 'user' } },
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (() => {}) as any,
    );

    await main();

    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('saves state to signal post phase on first (main) invocation', async () => {
    setContext({ eventName: 'push', payload: { sender: { login: 'user' } } });
    jest.mocked(core.getState).mockReturnValueOnce('');

    await main();

    expect(jest.mocked(core.saveState)).toHaveBeenCalledWith('manki_post_phase', 'true');
  });
});

describe('postCleanup (via main dispatch)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'test-api-key' : '',
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (github.context as any).runId = 12345;
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (github.context as any).runId = undefined;
  });

  function runPostPhase(): Promise<void> {
    jest.mocked(core.getState).mockReturnValueOnce('true');
    return main();
  }

  it('marks progress comment cancelled for the current run when PR is in payload', async () => {
    setContext({
      eventName: 'pull_request',
      payload: { pull_request: { number: 42 } },
    });
    jest.mocked(ghUtils.markOwnProgressCommentCancelled).mockResolvedValueOnce(true);

    await runPostPhase();

    expect(jest.mocked(ghUtils.markOwnProgressCommentCancelled)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 12345,
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      expect.stringContaining('marked progress comment for run 12345 as cancelled'),
    );
  });

  it('logs that no comment was found when markOwnProgressCommentCancelled returns false', async () => {
    setContext({
      eventName: 'pull_request',
      payload: { pull_request: { number: 7 } },
    });
    jest.mocked(ghUtils.markOwnProgressCommentCancelled).mockResolvedValueOnce(false);

    await runPostPhase();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      expect.stringContaining('no progress comment found for run 12345'),
    );
  });

  it('falls back to issue.pull_request when PR is not directly in payload', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: { issue: { number: 55, pull_request: { url: 'https://api.github.com/pr/55' } } },
    });
    jest.mocked(ghUtils.markOwnProgressCommentCancelled).mockResolvedValueOnce(true);

    await runPostPhase();

    expect(jest.mocked(ghUtils.markOwnProgressCommentCancelled)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 55, 12345,
    );
  });

  it('skips when no PR number can be derived from event payload', async () => {
    setContext({ eventName: 'push', payload: { sender: { login: 'user' } } });

    await runPostPhase();

    expect(jest.mocked(ghUtils.markOwnProgressCommentCancelled)).not.toHaveBeenCalled();
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      expect.stringContaining('no PR number in event payload'),
    );
  });

  it('skips when event payload has issue without pull_request (plain issue comment)', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: { issue: { number: 99 } },
    });

    await runPostPhase();

    expect(jest.mocked(ghUtils.markOwnProgressCommentCancelled)).not.toHaveBeenCalled();
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      expect.stringContaining('no PR number in event payload'),
    );
  });

  it('warns when the cleanup helper throws', async () => {
    setContext({
      eventName: 'pull_request',
      payload: { pull_request: { number: 42 } },
    });
    jest.mocked(ghUtils.markOwnProgressCommentCancelled).mockRejectedValueOnce(new Error('boom'));

    await runPostPhase();

    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Post-cleanup failed: boom'),
    );
  });

  it('does not save state again when running in post phase', async () => {
    setContext({ eventName: 'pull_request', payload: { pull_request: { number: 1 } } });
    jest.mocked(ghUtils.markOwnProgressCommentCancelled).mockResolvedValueOnce(false);

    await runPostPhase();

    expect(jest.mocked(core.saveState)).not.toHaveBeenCalled();
  });
});

describe('runFullReview orchestration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
    setContext({ eventName: 'pull_request', payload: { action: 'opened' } });
    // Provide a valid API key so the early validation passes
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'test-api-key' : '',
    );
    // Reset to default config for each test
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, max_diff_lines: 5000,
      exclude_paths: [], nit_handling: 'issues',
      reviewers: [],
      instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: false, repo: '' },
    });
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({ files: [], totalAdditions: 0, totalDeletions: 0 });
    jest.mocked(diffModule.filterFiles).mockReturnValue([]);
    jest.mocked(authModule.getMemoryToken).mockReturnValue(null);
    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({ previousFindings: [], recapContext: '' });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: [], duplicates: [] });
    jest.mocked(stateModule.resolveStaleThreads).mockResolvedValue(0);
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'Looks good',
      findings: [], highlights: [], reviewComplete: true,
    });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('APPROVE');
    jest.mocked(reviewModule.selectTeam).mockReturnValue({ level: 'standard' as 'small', agents: [{ name: 'general', focus: '' }], lineCount: 0 });
    jest.mocked(ghUtils.postProgressComment).mockResolvedValue(1);
    jest.mocked(ghUtils.postReview).mockResolvedValue(123);
    jest.mocked(ghUtils.fetchPRDiff).mockResolvedValue('');
    jest.mocked(ghUtils.fetchRepoContext).mockResolvedValue('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.mocked(ghUtils.fetchSubdirClaudeMd).mockResolvedValue(null as any);
    jest.mocked(ghUtils.fetchFileContents).mockResolvedValue(new Map());
    jest.mocked(ghUtils.fetchLinkedIssues).mockResolvedValue([]);
    jest.mocked(ghUtils.dismissPreviousReviews).mockResolvedValue(undefined);
    jest.mocked(ghUtils.updateProgressComment).mockResolvedValue(undefined);
    jest.mocked(ghUtils.updateProgressDashboard).mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.mocked(memoryModule.loadMemory).mockResolvedValue(null as any);
    jest.mocked(memoryModule.applyEscalations).mockImplementation((findings) => findings);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.mocked(memoryModule.updatePattern).mockResolvedValue(undefined as any);
  });

  const baseArgs = {
    owner: 'test-owner',
    repo: 'test-repo',
    prNumber: 42,
    commitSha: 'abc123',
    baseRef: 'main',
    prContext: { title: 'Test PR', body: 'Test body', baseBranch: 'main' },
  };

  function callRunFullReview(): Promise<void> {
    return runFullReview(
      baseArgs.owner, baseArgs.repo, baseArgs.prNumber,
      baseArgs.commitSha, baseArgs.baseRef, baseArgs.prContext,
    );
  }

  it('handles diff too large by posting warning review without running Claude', async () => {
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(true);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [], totalAdditions: 3000, totalDeletions: 3000,
    });

    await callRunFullReview();

    // Should post a review with the "too large" message
    expect(jest.mocked(ghUtils.postReview)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'abc123',
      expect.objectContaining({
        verdict: 'COMMENT',
        summary: expect.stringContaining('too large for automated review'),
      }),
      expect.anything(),
    );
    // Should NOT have called runReview (Claude)
    expect(jest.mocked(reviewModule.runReview)).not.toHaveBeenCalled();
  });

  it('dismisses previous reviews before posting diff-too-large warning', async () => {
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(true);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [], totalAdditions: 6000, totalDeletions: 0,
    });

    await callRunFullReview();

    expect(jest.mocked(ghUtils.dismissPreviousReviews)).toHaveBeenCalled();
  });

  it('gracefully handles dismissPreviousReviews failure on diff-too-large path', async () => {
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(true);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [], totalAdditions: 6000, totalDeletions: 0,
    });
    jest.mocked(ghUtils.dismissPreviousReviews).mockRejectedValueOnce(new Error('permission denied'));

    await callRunFullReview();

    // Should still post the review despite dismiss failure
    expect(jest.mocked(ghUtils.postReview)).toHaveBeenCalled();
    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to dismiss previous reviews'),
    );
  });

  it('approves when all files are filtered out by config', async () => {
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [{ path: 'package-lock.json', changeType: 'modified', hunks: [] }],
      totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([]);

    await callRunFullReview();

    expect(jest.mocked(ghUtils.postReview)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'abc123',
      expect.objectContaining({
        verdict: 'APPROVE',
        summary: expect.stringContaining('No reviewable files'),
      }),
      expect.anything(),
    );
    expect(jest.mocked(reviewModule.runReview)).not.toHaveBeenCalled();
  });

  it('skips auto_review disabled PR events and deletes progress comment', async () => {
    // Set event to pull_request so the auto_review check triggers
    ctx.eventName = 'pull_request';
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: false,
      auto_approve: false,
      max_diff_lines: 5000,
      exclude_paths: [],
      nit_handling: 'issues',
      reviewers: [],
      instructions: '',
      review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: false, repo: '' },
    });

    await callRunFullReview();

    // Should delete the progress comment, not proceed with review
    expect(mockOctokitInstance.rest.issues.deleteComment).toHaveBeenCalled();
    expect(jest.mocked(reviewModule.runReview)).not.toHaveBeenCalled();
  });

  it('runs full review pipeline and posts findings for a normal PR', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'line1\nline2\nline3' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    const findings = [
      { severity: 'required' as const, title: 'Bug found', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['general'] },
    ];
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'REQUEST_CHANGES',
      summary: 'Issues found',
      findings,
      highlights: [],
      reviewComplete: true,
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: findings, duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('REQUEST_CHANGES');

    await callRunFullReview();

    // Review should have been called
    expect(jest.mocked(reviewModule.runReview)).toHaveBeenCalled();
    // Review posted with findings
    expect(jest.mocked(ghUtils.postReview)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'abc123',
      expect.objectContaining({ verdict: 'REQUEST_CHANGES' }),
      expect.anything(),
      expect.anything(),
    );
    // Outputs set
    expect(jest.mocked(core.setOutput)).toHaveBeenCalledWith('verdict', 'REQUEST_CHANGES');
    expect(jest.mocked(core.setOutput)).toHaveBeenCalledWith('findings_count', '1');
  });

  it('populates enriched stats fields (agentMetrics, judgeMetrics, fileMetrics, model split)', async () => {
    const testFiles = [
      { path: 'src/app.ts', changeType: 'modified' as const, hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }] },
      { path: 'src/utils.js', changeType: 'added' as const, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3, content: 'new' }] },
    ];
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: testFiles, totalAdditions: 20, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue(testFiles);

    const findings = [
      { severity: 'required' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const, judgeNotes: 'confirmed' },
      { severity: 'suggestion' as const, title: 'Style', file: 'src/app.ts', line: 8, description: 'desc', reviewers: ['general'], judgeConfidence: 'medium' as const },
      { severity: 'nit' as const, title: 'Nit', file: 'src/utils.js', line: 1, description: 'desc', reviewers: ['general', 'security'], judgeConfidence: 'low' as const },
    ];
    const allJudged = [
      ...findings,
      { severity: 'ignore' as const, title: 'Dropped', file: 'src/app.ts', line: 2, description: 'dropped', reviewers: ['security'], judgeConfidence: 'high' as const, judgeNotes: 'not relevant' },
    ];
    const rawFindings = [
      ...findings,
      { severity: 'nit' as const, title: 'Dropped', file: 'src/app.ts', line: 2, description: 'dropped', reviewers: ['security'] },
    ];

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'REQUEST_CHANGES', summary: 'Issues found',
      findings,
      highlights: [],
      reviewComplete: true,
      rawFindingCount: 6,
      agentNames: ['security', 'general'],
      allJudgedFindings: allJudged,
      rawFindings,
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: findings, duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('REQUEST_CHANGES');

    await callRunFullReview();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg).toBeDefined();

    // agentMetrics: third finding has both reviewers, so security gets 3 raw / 2 kept
    expect(statsArg!.agentMetrics).toEqual([
      { name: 'security', findingsRaw: 3, findingsKept: 2 },
      { name: 'general', findingsRaw: 2, findingsKept: 2 },
    ]);

    // judgeMetrics
    expect(statsArg!.judgeMetrics).toEqual({
      confidenceDistribution: { high: 2, medium: 1, low: 1 },
      severityChanges: 2,
      mergedDuplicates: 2,
    });

    // fileMetrics
    expect(statsArg!.fileMetrics).toEqual({
      fileTypes: { '.ts': 1, '.js': 1 },
      findingsPerFile: { 'src/app.ts': 2, 'src/utils.js': 1 },
    });

    // Model split
    expect(statsArg!.reviewerModel).toBeDefined();
    expect(statsArg!.judgeModel).toBeDefined();

    // Backwards compatibility: model field still present
    expect(statsArg!.model).toBeDefined();

    // keptSeverities/droppedSeverities passed to dashboard use original severity for dropped findings
    const dashboardArg = jest.mocked(ghUtils.updateProgressComment).mock.calls.at(-1)?.[4];
    expect(dashboardArg?.keptSeverities).toEqual({ required: 1, suggestion: 1, nit: 1 });
    expect(dashboardArg?.droppedSeverities).toEqual({ nit: 1 });
    expect(dashboardArg?.droppedCount).toBe(1);
    expect(dashboardArg?.keptCount).toBe(3);
  });

  it('adjusts mergedDuplicates and findingsRaw for pre-judge dedup counts', async () => {
    const testFiles = [
      { path: 'src/app.ts', changeType: 'modified' as const, hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }] },
    ];
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: testFiles, totalAdditions: 20, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue(testFiles);

    const findings = [
      { severity: 'required' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const },
    ];
    const allJudged = [...findings];
    // rawFindings: 5 findings from agents (pre-suppression, pre-dedup)
    const rawFindings = [
      { severity: 'required' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'] },
      { severity: 'required' as const, title: 'Dup1', file: 'src/app.ts', line: 6, description: 'desc', reviewers: ['security'] },
      { severity: 'required' as const, title: 'Dup2', file: 'src/app.ts', line: 7, description: 'desc', reviewers: ['general'] },
      { severity: 'suggestion' as const, title: 'Judge-merged', file: 'src/app.ts', line: 8, description: 'desc', reviewers: ['general'] },
      { severity: 'suggestion' as const, title: 'Judge-merged-2', file: 'src/app.ts', line: 9, description: 'desc', reviewers: ['general'] },
    ];

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'REQUEST_CHANGES', summary: 'Issues found',
      findings,
      highlights: [],
      reviewComplete: true,
      rawFindingCount: 5,
      agentNames: ['security', 'general'],
      allJudgedFindings: allJudged,
      rawFindings,
      staticDedupCount: 1,
      llmDedupCount: 1,
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: findings, duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('REQUEST_CHANGES');

    await callRunFullReview();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg).toBeDefined();

    // mergedDuplicates excludes pre-judge dedup: 5 - 1 (static) - 1 (llm) - 1 (judged) = 2
    expect(statsArg!.judgeMetrics?.mergedDuplicates).toBe(2);

    // findingsRaw comes from rawFindings (pre-dedup per-agent counts)
    expect(statsArg!.agentMetrics).toEqual([
      { name: 'security', findingsRaw: 2, findingsKept: 1 },
      { name: 'general', findingsRaw: 3, findingsKept: 0 },
    ]);
  });

  it('excludes memory suppressions from mergedDuplicates metric', async () => {
    const testFiles = [
      { path: 'src/app.ts', changeType: 'modified' as const, hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }] },
    ];
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: testFiles, totalAdditions: 20, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue(testFiles);

    const findings = [
      { severity: 'required' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const },
    ];
    const allJudged = [...findings];
    const rawFindings = [
      { severity: 'required' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'] },
      { severity: 'nit' as const, title: 'Suppressed1', file: 'src/app.ts', line: 6, description: 'desc', reviewers: ['security'] },
      { severity: 'nit' as const, title: 'Suppressed2', file: 'src/app.ts', line: 7, description: 'desc', reviewers: ['general'] },
      { severity: 'suggestion' as const, title: 'Judge-merged', file: 'src/app.ts', line: 8, description: 'desc', reviewers: ['general'] },
    ];

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'REQUEST_CHANGES', summary: 'Issues found',
      findings,
      highlights: [],
      reviewComplete: true,
      rawFindingCount: 4,
      agentNames: ['security', 'general'],
      allJudgedFindings: allJudged,
      rawFindings,
      staticDedupCount: 0,
      llmDedupCount: 0,
      suppressionCount: 2,
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: findings, duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('REQUEST_CHANGES');

    await callRunFullReview();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg).toBeDefined();

    // mergedDuplicates excludes memory suppressions: 4 - 2 (suppressed) - 0 - 0 - 1 (judged) = 1
    expect(statsArg!.judgeMetrics?.mergedDuplicates).toBe(1);
  });

  it('counts defensive-hardening findings in judgeMetrics', async () => {
    const testFiles = [
      { path: 'src/app.ts', changeType: 'modified' as const, hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }] },
    ];
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: testFiles, totalAdditions: 20, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue(testFiles);

    const findings = [
      { severity: 'nit' as const, title: 'Guard', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const, tags: ['defensive-hardening'], originalSeverity: 'required' as const, reachability: 'hypothetical' as const },
      { severity: 'required' as const, title: 'Real', file: 'src/app.ts', line: 6, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const, reachability: 'reachable' as const },
    ];
    const allJudged = [...findings];

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'REQUEST_CHANGES', summary: 'Issues found',
      findings,
      highlights: [],
      reviewComplete: true,
      rawFindingCount: 2,
      agentNames: ['security'],
      allJudgedFindings: allJudged,
      rawFindings: [...findings],
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: findings, duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('REQUEST_CHANGES');

    await callRunFullReview();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg!.judgeMetrics?.defensiveHardeningCount).toBe(1);
  });

  it('creates nit issues when nit_handling is "issues"', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'line1\nline2' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, max_diff_lines: 5000,
      exclude_paths: [], nit_handling: 'issues',
      reviewers: [],
      instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: false, repo: '' },
    });

    const nitFinding = {
      severity: 'nit' as const, title: 'Style nit', file: 'src/app.ts',
      line: 3, description: 'nit desc', reviewers: ['general'],
    };
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Minor nits',
      findings: [nitFinding], highlights: [], reviewComplete: true,
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({
      unique: [nitFinding], duplicates: [],
    });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('COMMENT');

    await callRunFullReview();

    expect(jest.mocked(ghUtils.createNitIssue)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42,
      [expect.objectContaining({ severity: 'nit' })], 'abc123',
    );
  });

  it('does not create nit issues when nit_handling is "comments"', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'line1\nline2' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, max_diff_lines: 5000,
      exclude_paths: [], nit_handling: 'comments',
      reviewers: [],
      instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: false, repo: '' },
    });

    const nitFinding = {
      severity: 'nit' as const, title: 'Style nit', file: 'src/app.ts',
      line: 3, description: 'nit desc', reviewers: ['general'],
    };
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Minor nits',
      findings: [nitFinding], highlights: [], reviewComplete: true,
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({
      unique: [nitFinding], duplicates: [],
    });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('COMMENT');

    await callRunFullReview();

    // Nits go inline, no nit issue created
    expect(jest.mocked(ghUtils.createNitIssue)).not.toHaveBeenCalled();
    // All findings (including nits) should be in the posted review
    expect(jest.mocked(ghUtils.postReview)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'abc123',
      expect.objectContaining({
        findings: [expect.objectContaining({ severity: 'nit' })],
      }),
      expect.anything(), expect.anything(),
    );
  });

  it('posts COMMENT and skips post-review processing for incomplete review', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'Review incomplete',
      findings: [], highlights: [], reviewComplete: false,
    });

    await callRunFullReview();

    // Incomplete review should post COMMENT and skip dedup/nit/memory processing
    expect(jest.mocked(ghUtils.postReview)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'abc123',
      expect.objectContaining({ verdict: 'COMMENT' }),
      expect.anything(),
    );
    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Review incomplete'),
    );
    // Should not call dedup since we return early
    expect(jest.mocked(recapModule.deduplicateFindings)).not.toHaveBeenCalled();
  });

  it('catches review failure and updates progress comment with error state', async () => {
    jest.mocked(ghUtils.fetchPRDiff).mockRejectedValue(new Error('GitHub API down'));

    await callRunFullReview();

    // Error should be caught and reported
    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Review failed: GitHub API down'),
    );
    // Progress comment should be updated even on failure
    expect(jest.mocked(ghUtils.updateProgressComment)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 1,
      expect.objectContaining({ phase: 'complete', lineCount: 0 }),
    );
  });

  it('passes recap previousFindings to runReview so dedup runs before judge', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    const previousFindings = [
      { title: 'Bug', file: 'src/app.ts', line: 5, severity: 'required' as const, status: 'resolved' as const },
    ];
    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings,
      recapContext: 'previous context',
    });

    const finding2 = { severity: 'nit' as const, title: 'Style', file: 'src/app.ts', line: 8, description: 'desc', reviewers: ['general'] };
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Issues',
      findings: [finding2], highlights: [], reviewComplete: true,
    });

    await callRunFullReview();

    // runReview should receive previousFindings as the last positional arg so
    // dedup runs before the judge stage.
    const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
    expect(runReviewCall[12]).toEqual(previousFindings);
  });

  it('applies memory escalations when patterns exist', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, max_diff_lines: 5000,
      exclude_paths: [], nit_handling: 'issues',
      reviewers: [],
      instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: true, repo: 'owner/memory' },
    });
    jest.mocked(authModule.getMemoryToken).mockReturnValue('token123');

    const memory = {
      learnings: [], suppressions: [],
      patterns: [{
        id: 'p1', finding_title: 'Bug', occurrences: 5, accepted_count: 3,
        rejected_count: 0, repos: ['test-repo'], first_seen: '2024-01-01',
        last_seen: '2024-06-01', escalated: true,
      }],
    };
    jest.mocked(memoryModule.loadMemory).mockResolvedValue(memory);

    const finding = { severity: 'nit' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['general'] };
    const escalated = { ...finding, severity: 'required' as const };
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Nits',
      findings: [finding], highlights: [], reviewComplete: true,
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: [finding], duplicates: [] });
    jest.mocked(memoryModule.applyEscalations).mockReturnValue([escalated]);
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('REQUEST_CHANGES');

    await callRunFullReview();

    expect(jest.mocked(memoryModule.applyEscalations)).toHaveBeenCalledWith(
      [finding], memory.patterns,
    );
    // Verdict recalculated after escalation
    expect(jest.mocked(reviewModule.determineVerdict)).toHaveBeenCalled();
  });

  it('enriches findings with code context from diff hunks', async () => {
    const hunkContent = 'line0\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9';
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 10, newStart: 1, newLines: 10, content: hunkContent }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    const finding = {
      severity: 'suggestion' as const, title: 'Improvement', file: 'src/app.ts',
      line: 5, description: 'desc', reviewers: ['general'],
    };
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Suggestions',
      findings: [finding], highlights: [], reviewComplete: true,
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: [finding], duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('COMMENT');

    await callRunFullReview();

    // The finding object is mutated in-place with codeContext.
    // Verify postReview was called (the enrichment happens before posting).
    expect(jest.mocked(ghUtils.postReview)).toHaveBeenCalled();
    // The finding at line 5 in a hunk starting at 1 with 10 lines should match,
    // so codeContext should have been set on the finding object.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const postedFindings = (jest.mocked(ghUtils.postReview).mock.calls[0][5] as any).findings;
    // Since nit_handling defaults to 'issues' and this is a suggestion, it stays inline
    expect(postedFindings.length).toBeGreaterThan(0);
  });

  it('resolves stale threads and logs count', async () => {
    jest.mocked(stateModule.resolveStaleThreads).mockResolvedValue(3);

    await callRunFullReview();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'Resolved 3 stale review threads from previous commits',
    );
  });

  it('updates dashboard on agent-complete progress', async () => {
    jest.useFakeTimers();
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(reviewModule.runReview).mockImplementation(
      async (_clients, _config, _diff, _rawDiff, _repoContext, _memory, _fileContents, _prContext, _linkedIssues, onProgress) => {
        if (onProgress) {
          onProgress({
            phase: 'planning', rawFindingCount: 0,
            plannerResult: { teamSize: 1, reviewerEffort: 'low', judgeEffort: 'low', prType: 'chore' },
          });
          onProgress({
            phase: 'agent-complete',
            agentName: 'general',
            agentFindingCount: 2,
            agentDurationMs: 100,
            agentStatus: 'success',
            rawFindingCount: 2,
            completedAgents: 1,
            totalAgents: 1,
          });
        }
        // Flush the debounce timer
        jest.advanceTimersByTime(600);
        await Promise.resolve();
        return {
          verdict: 'APPROVE', summary: 'ok', findings: [],
          highlights: [], reviewComplete: true,
        };
      },
    );

    await callRunFullReview();
    jest.useRealTimers();

    // The debounced flush should have called updateProgressDashboard
    const dashboardCalls = jest.mocked(ghUtils.updateProgressDashboard).mock.calls;
    // At least the initial dashboard + the agent-complete flush
    expect(dashboardCalls.length).toBeGreaterThanOrEqual(2);

    // Verify dashboard content reflects agent-complete status
    const agentFlushDashboard = dashboardCalls[1][4];
    expect(agentFlushDashboard.agentProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'general', status: 'done', findingCount: 2 }),
      ]),
    );
  });

  it('updates dashboard on agent-complete with failure status', async () => {
    jest.useFakeTimers();
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(reviewModule.runReview).mockImplementation(
      async (_clients, _config, _diff, _rawDiff, _repoContext, _memory, _fileContents, _prContext, _linkedIssues, onProgress) => {
        if (onProgress) {
          onProgress({
            phase: 'planning', rawFindingCount: 0,
            plannerResult: { teamSize: 1, reviewerEffort: 'low', judgeEffort: 'low', prType: 'chore' },
          });
          onProgress({
            phase: 'agent-complete',
            agentName: 'general',
            agentFindingCount: 0,
            agentDurationMs: 50,
            agentStatus: 'failure',
            rawFindingCount: 0,
            completedAgents: 1,
            totalAgents: 1,
          });
        }
        jest.advanceTimersByTime(600);
        await Promise.resolve();
        return {
          verdict: 'APPROVE', summary: 'ok', findings: [],
          highlights: [], reviewComplete: true,
        };
      },
    );

    await callRunFullReview();
    jest.useRealTimers();

    const dashboardCalls = jest.mocked(ghUtils.updateProgressDashboard).mock.calls;
    expect(dashboardCalls.length).toBeGreaterThanOrEqual(2);

    // Verify dashboard content reflects agent failure status
    const agentFlushDashboard = dashboardCalls[1][4];
    expect(agentFlushDashboard.agentProgress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'general', status: 'failed', findingCount: 0 }),
      ]),
    );
  });

  it('flushes dashboard immediately on judging progress', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(reviewModule.runReview).mockImplementation(
      async (_clients, _config, _diff, _rawDiff, _repoContext, _memory, _fileContents, _prContext, _linkedIssues, onProgress) => {
        if (onProgress) {
          onProgress({
            phase: 'planning', rawFindingCount: 0,
            plannerResult: { teamSize: 1, reviewerEffort: 'low', judgeEffort: 'low', prType: 'chore' },
          });
          onProgress({
            phase: 'judging',
            rawFindingCount: 5,
            judgeInputCount: 3,
          });
        }
        return {
          verdict: 'APPROVE', summary: 'ok', findings: [],
          highlights: [], reviewComplete: true,
        };
      },
    );

    await callRunFullReview();

    const dashboardCalls = jest.mocked(ghUtils.updateProgressDashboard).mock.calls;
    // Initial dashboard + judging flush
    expect(dashboardCalls.length).toBeGreaterThanOrEqual(2);
    // The last call before postReview should reflect reviewed phase
    const lastDashboard = dashboardCalls[dashboardCalls.length - 1][4];
    expect(lastDashboard.phase).toBe('reviewed');
    expect(lastDashboard.judgeInputCount).toBe(3);
    expect(lastDashboard.agentProgress).toBeDefined();
  });

  it('flushes dashboard immediately on reviewed progress', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(reviewModule.runReview).mockImplementation(
      async (_clients, _config, _diff, _rawDiff, _repoContext, _memory, _fileContents, _prContext, _linkedIssues, onProgress) => {
        if (onProgress) {
          onProgress({
            phase: 'planning', rawFindingCount: 0,
            plannerResult: { teamSize: 1, reviewerEffort: 'low', judgeEffort: 'low', prType: 'chore' },
          });
          onProgress({
            phase: 'reviewed',
            rawFindingCount: 4,
          });
        }
        return {
          verdict: 'APPROVE', summary: 'ok', findings: [],
          highlights: [], reviewComplete: true,
        };
      },
    );

    await callRunFullReview();

    const dashboardCalls = jest.mocked(ghUtils.updateProgressDashboard).mock.calls;
    expect(dashboardCalls.length).toBeGreaterThanOrEqual(2);
    const lastDashboard = dashboardCalls[dashboardCalls.length - 1][4];
    expect(lastDashboard.phase).toBe('reviewed');
    expect(lastDashboard.rawFindingCount).toBe(4);
    expect(lastDashboard.agentProgress).toBeDefined();
  });

  it('reflects suppression-reduced judgeInputCount in dashboard', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, max_diff_lines: 5000,
      exclude_paths: [], nit_handling: 'issues',
      reviewers: [],
      instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: true, repo: 'owner/memory' },
    });
    jest.mocked(authModule.getMemoryToken).mockReturnValue('token123');

    const memory = {
      learnings: [],
      suppressions: [{
        id: 's1', pattern: 'Noise', reason: 'false positive',
        created_by: 'tester', created_at: '2024-01-01', pr_ref: 'test-owner/test-repo#1',
      }],
      patterns: [],
    };
    jest.mocked(memoryModule.loadMemory).mockResolvedValue(memory);

    const finding1 = { severity: 'suggestion' as const, title: 'Real issue', file: 'src/app.ts', line: 3, description: 'desc', reviewers: ['general'] };
    const finding2 = { severity: 'nit' as const, title: 'Noise', file: 'src/app.ts', line: 7, description: 'desc', reviewers: ['general'] };

    jest.mocked(reviewModule.runReview).mockImplementation(
      async (_clients, _config, _diff, _rawDiff, _repoContext, _memory, _fileContents, _prContext, _linkedIssues, onProgress) => {
        if (onProgress) {
          onProgress({
            phase: 'judging',
            rawFindingCount: 6,
            judgeInputCount: 4,
          });
        }
        return {
          verdict: 'COMMENT', summary: 'Issues found',
          findings: [finding1, finding2], highlights: [], reviewComplete: true,
        };
      },
    );
    jest.mocked(reviewModule.determineVerdict).mockReturnValue('COMMENT');

    await callRunFullReview();

    const dashboardCalls = jest.mocked(ghUtils.updateProgressDashboard).mock.calls;
    // The judging flush should include judgeInputCount < rawFindingCount
    const judgingDashboard = dashboardCalls.find(c => c[4].judgeInputCount !== undefined)?.[4];
    expect(judgingDashboard).toBeDefined();
    expect(judgingDashboard!.rawFindingCount).toBe(6);
    expect(judgingDashboard!.judgeInputCount).toBe(4);
    expect(judgingDashboard!.judgeInputCount).toBeLessThan(judgingDashboard!.rawFindingCount!);
  });

  it('passes isFollowUp and openThreads to runReview when previous findings exist', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    const previousFindings = [
      { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'required' as const, status: 'resolved' as const },
      { title: 'Bug B', file: 'src/app.ts', line: 2, severity: 'suggestion' as const, status: 'open' as const, threadId: 'PRRT_123' },
    ];
    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings,
      recapContext: 'previous context',
    });

    await callRunFullReview();

    // runReview should receive isFollowUp and openThreads as the last two args
    const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
    const isFollowUp = runReviewCall[10];
    const openThreads = runReviewCall[11];

    expect(isFollowUp).toBe(true);
    expect(openThreads).toEqual([
      { threadId: 'PRRT_123', title: 'Bug B', file: 'src/app.ts', line: 2, severity: 'suggestion' },
    ]);
  });

  it('includes planner info in dashboard when planner result is available', async () => {
    jest.useFakeTimers();
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(reviewModule.runReview).mockImplementation(
      async (_clients, _config, _diff, _rawDiff, _repoContext, _memory, _fileContents, _prContext, _linkedIssues, onProgress) => {
        if (onProgress) {
          onProgress({ phase: 'planning', rawFindingCount: 0 });
          onProgress({ phase: 'planning', rawFindingCount: 0, plannerResult: { teamSize: 3 as const, reviewerEffort: 'low' as const, judgeEffort: 'low' as const, prType: 'chore' } });
        }
        jest.advanceTimersByTime(600);
        await Promise.resolve();
        return {
          verdict: 'APPROVE', summary: 'ok', findings: [],
          highlights: [], reviewComplete: true,
          agentNames: ['Security & Safety', 'Correctness & Logic', 'Architecture & Design'],
          plannerResult: { teamSize: 3 as const, reviewerEffort: 'low' as const, judgeEffort: 'low' as const, prType: 'chore' },
        };
      },
    );

    await callRunFullReview();
    jest.useRealTimers();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Planner analyzing PR content...');

    const dashboardCalls = jest.mocked(ghUtils.updateProgressDashboard).mock.calls;
    const dashboardWithPlanner = dashboardCalls.find(call => call[4]?.plannerInfo !== undefined);
    expect(dashboardWithPlanner).toBeDefined();
    expect(dashboardWithPlanner![4].plannerInfo).toEqual({
      teamSize: 3, reviewerEffort: 'low', judgeEffort: 'low', prType: 'chore',
    });
  });

  it('resolves threads the judge identified as addressed', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings: [
        { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'required' as const, status: 'open' as const, threadId: 'PRRT_abc' },
        { title: 'Bug B', file: 'src/app.ts', line: 2, severity: 'suggestion' as const, status: 'open' as const, threadId: 'PRRT_def' },
      ],
      recapContext: 'previous context',
    });

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'ok', findings: [],
      highlights: [], reviewComplete: true,
      resolveThreads: [
        { threadId: 'PRRT_abc', reason: 'Fixed in new diff' },
        { threadId: 'PRRT_def', reason: 'Addressed by refactoring' },
      ],
    });

    await callRunFullReview();

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_abc' },
    );
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_def' },
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'Judge resolved: "Fixed in new diff" — thread PRRT_abc',
    );
  });

  it('skips resolving threads not in the openThreads allowlist', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings: [
        { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'required' as const, status: 'open' as const, threadId: 'PRRT_known' },
      ],
      recapContext: 'previous context',
    });

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'ok', findings: [],
      highlights: [], reviewComplete: true,
      resolveThreads: [
        { threadId: 'PRRT_known', reason: 'Legit fix' },
        { threadId: 'PRRT_unknown', reason: 'Injected by adversary' },
      ],
    });

    await callRunFullReview();

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_known' },
    );
    expect(mockGraphql).not.toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_unknown' },
    );
    expect(jest.mocked(core.debug)).toHaveBeenCalledWith(
      expect.stringContaining('Skipping unknown thread PRRT_unknown'),
    );
  });

  it('includes replied threads in openThreads for judge evaluation', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings: [
        { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'required' as const, status: 'open' as const, threadId: 'PRRT_open' },
        { title: 'Bug B', file: 'src/app.ts', line: 2, severity: 'suggestion' as const, status: 'replied' as const, threadId: 'PRRT_replied' },
        { title: 'Bug C', file: 'src/app.ts', line: 3, severity: 'nit' as const, status: 'resolved' as const, threadId: 'PRRT_resolved' },
      ],
      recapContext: 'previous context',
    });

    await callRunFullReview();

    const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
    const openThreads = runReviewCall[11] as Array<{ threadId: string }>;
    const threadIds = openThreads.map(t => t.threadId);

    expect(threadIds).toContain('PRRT_open');
    expect(threadIds).toContain('PRRT_replied');
    expect(threadIds).not.toContain('PRRT_resolved');
  });

  it('logs debug message when thread resolution fails', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings: [
        { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'required' as const, status: 'open' as const, threadId: 'PRRT_fail' },
      ],
      recapContext: 'previous context',
    });

    mockGraphql.mockRejectedValueOnce(new Error('GraphQL error'));

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'ok', findings: [],
      highlights: [], reviewComplete: true,
      resolveThreads: [
        { threadId: 'PRRT_fail', reason: 'Should fail' },
      ],
    });

    await callRunFullReview();

    expect(jest.mocked(core.debug)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to resolve thread PRRT_fail'),
    );
  });

  it('fails fast with setFailed when no API key is configured', async () => {
    jest.mocked(core.getInput).mockReturnValue('');

    await callRunFullReview();

    expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
      'No API key configured — set claude_code_oauth_token or anthropic_api_key',
    );
    expect(jest.mocked(ghUtils.postProgressComment)).not.toHaveBeenCalled();
    expect(jest.mocked(reviewModule.runReview)).not.toHaveBeenCalled();
  });

  it('proceeds when claude_code_oauth_token is set', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'claude_code_oauth_token' ? 'oauth-token' : '',
    );

    await callRunFullReview();

    expect(jest.mocked(core.setFailed)).not.toHaveBeenCalled();
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
  });

  it('proceeds when anthropic_api_key is set', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'api-key' : '',
    );

    await callRunFullReview();

    expect(jest.mocked(core.setFailed)).not.toHaveBeenCalled();
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
  });

  it('posts app warning when identity is actions', async () => {
    _resetOctokitCache();
    jest.mocked(authModule.createAuthenticatedOctokit).mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      octokit: mockOctokitInstance as any,
      resolvedToken: 'mock-token',
      identity: 'actions',
    });

    await callRunFullReview();

    expect(jest.mocked(ghUtils.postAppWarningIfNeeded)).toHaveBeenCalledWith(
      mockOctokitInstance, 'test-owner', 'test-repo', 42,
    );
  });

  it('does not post app warning when identity is app', async () => {
    _resetOctokitCache();
    jest.mocked(authModule.createAuthenticatedOctokit).mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      octokit: mockOctokitInstance as any,
      resolvedToken: 'mock-token',
      identity: 'app',
    });

    await callRunFullReview();

    expect(jest.mocked(ghUtils.postAppWarningIfNeeded)).not.toHaveBeenCalled();
  });

  it('continues review and warns when postAppWarningIfNeeded throws', async () => {
    _resetOctokitCache();
    jest.mocked(authModule.createAuthenticatedOctokit).mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      octokit: mockOctokitInstance as any,
      resolvedToken: 'mock-token',
      identity: 'actions',
    });
    jest.mocked(ghUtils.postAppWarningIfNeeded).mockRejectedValueOnce(new Error('API error'));

    await callRunFullReview();

    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to post app warning'),
    );
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
  });
});

describe('handleInteraction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, max_diff_lines: 5000,
      exclude_paths: [], nit_handling: 'issues',
      reviewers: [],
      instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: false, repo: '' },
    });
  });

  it('returns early when no issue number in payload', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help' },
        issue: undefined,
      },
    });

    await handleInteraction();

    expect(jest.mocked(interaction.handlePRComment)).not.toHaveBeenCalled();
  });

  it('routes PR comment to handlePRComment with correct params', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help' },
        issue: { number: 7, pull_request: { url: 'https://...' } },
      },
    });

    await handleInteraction();

    expect(jest.mocked(interaction.handlePRComment)).toHaveBeenCalledWith(
      expect.anything(),  // octokit
      expect.anything(),  // claude client
      'test-owner', 'test-repo', 7,
      undefined,          // memoryConfig (memory not enabled)
      undefined,          // memoryToken
      expect.anything(),  // config
    );
  });
});

describe('handleIssueInteraction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, max_diff_lines: 5000,
      exclude_paths: [], nit_handling: 'issues',
      reviewers: [],
      instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: false, repo: '' },
    });
  });

  it('returns early when no comment in payload', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: { action: 'created', issue: { number: 10 } },
    });

    await handleIssueInteraction();

    expect(jest.mocked(interaction.handlePRComment)).not.toHaveBeenCalled();
  });

  it('skips bot comments', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: 'hello', user: { type: 'Bot' } },
        issue: { number: 10 },
      },
    });

    await handleIssueInteraction();

    expect(jest.mocked(interaction.handlePRComment)).not.toHaveBeenCalled();
  });

  it('skips comments with manki marker', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '<!-- manki -->', user: { type: 'User' } },
        issue: { number: 10 },
      },
    });

    await handleIssueInteraction();

    expect(jest.mocked(interaction.handlePRComment)).not.toHaveBeenCalled();
  });

  it('returns early when no issue number', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help', user: { type: 'User' } },
      },
    });

    await handleIssueInteraction();

    expect(jest.mocked(interaction.handlePRComment)).not.toHaveBeenCalled();
  });

  it('calls handlePRComment with null claude client for issue interactions', async () => {
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki triage this', user: { type: 'User' } },
        issue: { number: 15 },
      },
    });

    await handleIssueInteraction();

    expect(jest.mocked(interaction.handlePRComment)).toHaveBeenCalledWith(
      expect.anything(),  // octokit
      null,               // no claude client for issue interactions
      'test-owner', 'test-repo', 15,
      undefined, undefined, expect.anything(),
    );
  });
});

describe('handleReviewStateCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
  });

  it('skips when auto_approve is disabled', async () => {
    setContext({
      eventName: 'pull_request_review',
      payload: {
        action: 'submitted',
        pull_request: { number: 1, base: { ref: 'main' } },
      },
    });
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, max_diff_lines: 5000,
      exclude_paths: [], nit_handling: 'issues',
      reviewers: [],
      instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: false, repo: '' },
    });

    await handleReviewStateCheck();

    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'auto_approve is disabled — skipping state check',
    );
    expect(jest.mocked(stateModule.checkAndAutoApprove)).not.toHaveBeenCalled();
  });

  it('calls checkAndAutoApprove when enabled and logs success', async () => {
    setContext({
      eventName: 'pull_request_review',
      payload: {
        action: 'submitted',
        pull_request: { number: 5, base: { ref: 'main' } },
      },
    });
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: true, max_diff_lines: 5000,
      exclude_paths: [], nit_handling: 'issues',
      reviewers: [],
      instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: false, repo: '' },
    });
    jest.mocked(stateModule.checkAndAutoApprove).mockResolvedValue(true);

    await handleReviewStateCheck();

    expect(jest.mocked(stateModule.checkAndAutoApprove)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 5,
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'PR #5 auto-approved after all findings resolved',
    );
  });
});

describe('handleReviewCommentInteraction auto-approve', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
  });

  it('triggers auto-approve after handling review comment reply', async () => {
    jest.mocked(interaction.hasBotMention).mockReturnValue(true);
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: true, max_diff_lines: 5000,
      exclude_paths: [], nit_handling: 'issues',
      reviewers: [],
      instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: false, repo: '' },
    });

    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: {
          body: '@manki resolved',
          in_reply_to_id: 100,
          user: { type: 'User' },
        },
        pull_request: { number: 8, base: { ref: 'main' } },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(interaction.handleReviewCommentReply)).toHaveBeenCalled();
    expect(jest.mocked(stateModule.checkAndAutoApprove)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 8,
    );
  });
});

describe('force review checkbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _resetOctokitCache();
    jest.mocked(interaction.hasBotMention).mockReturnValue(false);
    jest.mocked(interaction.isReviewRequest).mockReturnValue(false);
  });

  it('routes force review checkbox edit to handleCommentTrigger with forceReview', async () => {
    // Simulate an active review so the test proves force review bypasses the gate
    jest.mocked(ghUtils.isReviewInProgress).mockResolvedValueOnce(true);
    const forceBody = `<!-- manki-bot -->\n**Review skipped** — a review is currently in progress. Retry in ~5 minutes, or force now:\n\n- [x] Force review\n\n${FORCE_REVIEW_MARKER}`;
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'edited',
        sender: { login: 'user' },
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 42, body: forceBody, author_association: 'COLLABORATOR' },
      },
    });

    await run();

    expect(jest.mocked(ghUtils.reactToIssueComment)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'eyes',
    );
    // force review bypasses the isReviewInProgress check entirely
    expect(jest.mocked(ghUtils.isReviewInProgress)).not.toHaveBeenCalled();
    expect(mockPullsGet).toHaveBeenCalled();
  });

  it('ignores force review checkbox when unchecked', async () => {
    const uncheckedBody = `<!-- manki-bot -->\n**Review skipped**\n\n- [ ] Force review\n\n${FORCE_REVIEW_MARKER}`;
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'edited',
        sender: { login: 'user' },
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 42, body: uncheckedBody },
      },
    });

    await run();

    // Unchecked checkbox should not trigger a review
    expect(mockPullsGet).not.toHaveBeenCalled();
    expect(jest.mocked(ghUtils.reactToIssueComment)).not.toHaveBeenCalled();
  });
});
