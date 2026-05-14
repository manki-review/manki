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

jest.mock('./providers', () => ({
  buildAuthForProvider: jest.requireActual('./providers').buildAuthForProvider,
  hasAnyProviderCredentials: jest.requireActual('./providers').hasAnyProviderCredentials,
  createLLMClient: jest.fn().mockImplementation(() => ({ sendMessage: jest.fn() })),
  parseModelSpec: jest.fn().mockImplementation((m: string) => ({ provider: 'anthropic', model: m })),
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
  fetchRecapState: jest.fn().mockResolvedValue({ previousFindings: [], recapContext: '', priorRounds: [] }),
  deduplicateFindings: jest.fn().mockReturnValue({ unique: [], duplicates: [] }),
  llmDeduplicateFindings: jest.fn().mockResolvedValue({ unique: [], duplicates: [] }),
  classifyAuthorReply: jest.fn().mockReturnValue('none'),
  fingerprintFinding: jest.fn((title: string, file: string, line: number) => ({ file, lineStart: line, lineEnd: line, slug: title })),
  sanitize: jest.requireActual('./recap').sanitize,
}));

jest.mock('./review', () => {
  const actual = jest.requireActual('./review') as typeof import('./review');
  return {
    runReview: jest.fn().mockResolvedValue({
      verdict: 'APPROVE',
      summary: 'Looks good',
      findings: [],
      highlights: [],
      reviewComplete: true,
      agentNames: ['general'],
    }),
    determineVerdict: jest.fn().mockReturnValue({ verdict: 'APPROVE', verdictReason: 'only_nit_or_suggestion' }),
    selectTeam: jest.fn().mockReturnValue({ level: 'standard', agents: [{ name: 'general' }] }),
    buildPlannerHints: actual.buildPlannerHints,
    buildAgentPool: actual.buildAgentPool,
    collectPriorRoundAgents: actual.collectPriorRoundAgents,
    TRIVIAL_VERIFIER_AGENT: actual.TRIVIAL_VERIFIER_AGENT,
  };
});

jest.mock('./github', () => ({
  fetchPRDiff: jest.fn().mockResolvedValue(''),
  fetchConfigFile: jest.fn().mockResolvedValue(null),
  fetchRepoContext: jest.fn().mockResolvedValue(''),
  fetchSubdirClaudeMd: jest.fn().mockResolvedValue(null),
  fetchFileContents: jest.fn().mockResolvedValue(new Map()),
  fetchInterRoundDiff: jest.fn().mockResolvedValue(''),
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
import type { ReviewConfig } from './types';
import { createLLMClient, parseModelSpec } from './providers';
import * as interaction from './interaction';
import * as ghUtils from './github';
import * as diffModule from './diff';
import * as configModule from './config';
import * as reviewModule from './review';
import * as recapModule from './recap';
import type { RecapState } from './recap';
import * as memoryModule from './memory';
import * as stateModule from './state';
import * as authModule from './auth';
import { LegacyHandoverRoundFixture, roundContextFromLegacy } from './test-utils';

/**
 * Seed `RecapState.priorRounds` (the consumer surface for round cap,
 * `lastPriorSha`, planner hints, etc.) with the given prior-round fixtures.
 */
function seedPriorRounds(
  _prNumber: number,
  _repo: string,
  rounds: LegacyHandoverRoundFixture[],
  previousFindings: RecapState['previousFindings'] = [],
  recapContext = '',
): void {
  jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
    previousFindings,
    recapContext,
    priorRounds: rounds.map(roundContextFromLegacy),
  });
}

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

  describe('claude_code_oauth_token deprecation warning', () => {
    it('warns once when claude_code_oauth_token is set', async () => {
      setContext({
        eventName: 'pull_request',
        payload: {
          action: 'opened',
          sender: { login: 'alice', type: 'User' },
          pull_request: { number: 1, head: { sha: 'abc' }, base: { ref: 'main' } },
        },
      });
      jest.mocked(core.getInput).mockImplementation((name: string) =>
        name === 'claude_code_oauth_token' ? 'oauth-tok' : '',
      );

      await run();

      const deprecationCalls = jest.mocked(core.warning).mock.calls.filter(([msg]) =>
        typeof msg === 'string' && msg.includes('`claude_code_oauth_token` is deprecated'),
      );
      expect(deprecationCalls).toHaveLength(1);
    });

    it('does not warn when claude_code_oauth_token is unset', async () => {
      setContext({
        eventName: 'pull_request',
        payload: {
          action: 'opened',
          sender: { login: 'alice', type: 'User' },
          pull_request: { number: 1, head: { sha: 'abc' }, base: { ref: 'main' } },
        },
      });
      jest.mocked(core.getInput).mockImplementation(() => '');

      await run();

      expect(jest.mocked(core.warning)).not.toHaveBeenCalledWith(
        expect.stringContaining('`claude_code_oauth_token` is deprecated'),
      );
    });
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
    expect(mockOctokitInstance.rest.pulls.get).not.toHaveBeenCalled();
    expect(jest.mocked(ghUtils.isApprovedOnCommit)).not.toHaveBeenCalled();
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

  it('posts skip comment and returns early when review is already in progress', async () => {
    jest.mocked(ghUtils.isReviewInProgress).mockResolvedValueOnce(true);
    mockListComments.mockResolvedValueOnce({ data: [] });

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
    expect(jest.mocked(ghUtils.cancelActiveReviewRun)).not.toHaveBeenCalled();
    expect(mockOctokitInstance.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Review skipped') }),
    );
    const skipBody = mockOctokitInstance.rest.issues.createComment.mock.calls
      .map((c: [{ body: string }]) => c[0].body)
      .find((body: string) => body.includes('Review skipped'));
    expect(skipBody).toContain(FORCE_REVIEW_MARKER);
    expect(skipBody).toContain('- [ ] Force review');
    expect(jest.mocked(core.info)).toHaveBeenCalledWith('Review already in progress — skipping');
    expect(jest.mocked(ghUtils.isApprovedOnCommit)).not.toHaveBeenCalled();
    expect(jest.mocked(ghUtils.postProgressComment)).not.toHaveBeenCalled();
    expect(mockOctokitInstance.rest.pulls.get).not.toHaveBeenCalled();
  });

  it('updates existing skip comment instead of creating a duplicate', async () => {
    jest.mocked(ghUtils.isReviewInProgress).mockResolvedValueOnce(true);
    mockListComments.mockResolvedValueOnce({
      data: [
        {
          id: 99,
          body: `${ghUtils.BOT_MARKER}\n**Review skipped** — a review is currently in progress.`,
          user: { login: ghUtils.BOT_LOGIN, type: 'Bot' },
        },
      ],
    });

    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 42, body: '@manki review', author_association: 'COLLABORATOR' },
      },
    });

    await handleCommentTrigger();

    expect(mockOctokitInstance.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 99, body: expect.stringContaining('Review skipped') }),
    );
    expect(mockOctokitInstance.rest.issues.createComment).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Review skipped') }),
    );
    expect(jest.mocked(ghUtils.postProgressComment)).not.toHaveBeenCalled();
  });

  it('swallows errors from skip-comment helpers and emits a warning', async () => {
    jest.mocked(ghUtils.isReviewInProgress).mockResolvedValueOnce(true);
    mockListComments.mockRejectedValueOnce(new Error('boom'));

    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 42, body: '@manki review', author_association: 'COLLABORATOR' },
      },
    });

    await expect(handleCommentTrigger()).resolves.toBeUndefined();

    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to post review-skipped comment'),
    );
    expect(mockOctokitInstance.rest.issues.createComment).not.toHaveBeenCalled();
    expect(mockOctokitInstance.rest.issues.updateComment).not.toHaveBeenCalled();
    expect(jest.mocked(ghUtils.postProgressComment)).not.toHaveBeenCalled();
    expect(mockOctokitInstance.rest.pulls.get).not.toHaveBeenCalled();
  });

  it('bypasses in-progress check when forceReview is true', async () => {
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
    expect(mockOctokitInstance.rest.issues.createComment).not.toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('Review skipped') }),
    );
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
  });

  it('proceeds with review when no review is in progress', async () => {
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
    expect(jest.mocked(ghUtils.isApprovedOnCommit)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 1, expect.any(String),
    );
    expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
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

  it('calls setFailed when no auth tokens are configured', async () => {
    jest.mocked(core.getInput).mockReturnValue('');
    jest.mocked(interaction.hasBotMention).mockReturnValue(true);

    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help', user: { type: 'User' } },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
      'No API key configured — set claude_code_oauth_token, anthropic_api_key, openai_oauth_token, openai_api_key, gemini_oauth_token, or gemini_api_key',
    );
    expect(jest.mocked(interaction.handleReviewCommentReply)).not.toHaveBeenCalled();
  });

  it('calls setFailed when parseModelSpec throws for an unknown model', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'claude_code_oauth_token' ? 'oauth-tok' : '',
    );
    jest.mocked(interaction.hasBotMention).mockReturnValue(true);
    jest.mocked(parseModelSpec).mockImplementationOnce(() => {
      throw new Error('Unknown model "gpt-4o"');
    });

    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help', user: { type: 'User' } },
        pull_request: { base: { ref: 'main' }, number: 42 },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
      expect.stringContaining('Unknown model "gpt-4o"'),
    );
    expect(jest.mocked(interaction.handleReviewCommentReply)).not.toHaveBeenCalled();
    expect(jest.mocked(interaction.handleReviewCommentCommand)).not.toHaveBeenCalled();
  });

  it('routes openai-prefixed models to OpenAI apiKey auth dispatch', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'openai_api_key' ? 'sk-openai-key' : '',
    );
    jest.mocked(interaction.hasBotMention).mockReturnValue(true);
    jest.mocked(parseModelSpec).mockImplementationOnce((m: string) => ({ provider: 'openai', model: m }));

    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help', user: { type: 'User' } },
        pull_request: { base: { ref: 'main' }, number: 42 },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
      'openai',
      expect.any(String),
      { kind: 'apiKey', key: 'sk-openai-key' },
    );
  });

  it('uses oauth auth when openai_oauth_token is set', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'openai_oauth_token' ? 'codex-oauth-tok' : '',
    );
    jest.mocked(interaction.hasBotMention).mockReturnValue(true);
    jest.mocked(parseModelSpec).mockImplementationOnce((m: string) => ({ provider: 'openai', model: m }));

    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help', user: { type: 'User' } },
        pull_request: { base: { ref: 'main' }, number: 42 },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
      'openai',
      expect.any(String),
      { kind: 'oauth', token: 'codex-oauth-tok' },
    );
  });

  it('sets failed when openai model is selected but only anthropic credentials are configured', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'sk-anthropic' : '',
    );
    jest.mocked(interaction.hasBotMention).mockReturnValue(true);
    jest.mocked(parseModelSpec).mockImplementationOnce((m: string) => ({ provider: 'openai', model: m }));

    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help', user: { type: 'User' } },
        pull_request: { base: { ref: 'main' }, number: 42 },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
      expect.stringContaining('Either openai_oauth_token or openai_api_key must be provided'),
    );
    expect(jest.mocked(createLLMClient)).not.toHaveBeenCalled();
  });

  it('sets failed when createLLMClient throws after valid model spec and auth', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'claude_code_oauth_token' ? 'oauth-tok' : '',
    );
    jest.mocked(interaction.hasBotMention).mockReturnValue(true);
    jest.mocked(createLLMClient).mockImplementationOnce(() => { throw new Error('unsupported model variant'); });

    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help', user: { type: 'User' } },
        pull_request: { base: { ref: 'main' }, number: 42 },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
      expect.stringContaining('Invalid model config'),
    );
    expect(jest.mocked(interaction.handleReviewCommentReply)).not.toHaveBeenCalled();
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
  // Named indices for positional parameters of `runReview` (src/review.ts).
  const RUN_REVIEW_IS_FOLLOW_UP_ARG = 10;
  const RUN_REVIEW_OPEN_THREADS_ARG = 11;
  const RUN_REVIEW_PREVIOUS_FINDINGS_ARG = 12;
  const RUN_REVIEW_PRIOR_ROUNDS_ARG = 13;
  const RUN_REVIEW_LINKED_ISSUES_ARG = 8;
  const RUN_REVIEW_INTER_ROUND_DIFF_ARG = 15;

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
    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({ previousFindings: [], recapContext: '', priorRounds: [] });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: [], duplicates: [] });
    jest.mocked(stateModule.resolveStaleThreads).mockResolvedValue(0);
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'Looks good',
      findings: [], highlights: [], reviewComplete: true,
      agentNames: ['general'],
    });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'APPROVE', verdictReason: 'only_nit_or_suggestion' });
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
      { severity: 'blocker' as const, title: 'Bug found', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['general'] },
    ];
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'REQUEST_CHANGES',
      summary: 'Issues found',
      findings,
      highlights: [],
      reviewComplete: true,
      agentNames: ['general'],
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: findings, duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'REQUEST_CHANGES', verdictReason: 'novel_suggestion' });

    await callRunFullReview();

    // Review should have been called
    expect(jest.mocked(reviewModule.runReview)).toHaveBeenCalled();
    // Review posted with findings
    expect(jest.mocked(ghUtils.postReview)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'abc123',
      expect.objectContaining({ verdict: 'REQUEST_CHANGES' }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    // Outputs set
    expect(jest.mocked(core.setOutput)).toHaveBeenCalledWith('verdict', 'REQUEST_CHANGES');
    expect(jest.mocked(core.setOutput)).toHaveBeenCalledWith('findings_count', '1');
    // `severity_counts` uses the new key shape (#593): blocker/warning/suggestion/nitpick.
    const setOutputCalls = jest.mocked(core.setOutput).mock.calls;
    const severityCountsCall = setOutputCalls.find(c => c[0] === 'severity_counts');
    expect(severityCountsCall).toBeTruthy();
    const counts = JSON.parse(severityCountsCall![1] as string);
    expect(counts).toEqual({ blocker: 1, warning: 0, suggestion: 0, nitpick: 0 });
    expect(counts).not.toHaveProperty('required');
    expect(counts).not.toHaveProperty('nit');
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
      { severity: 'blocker' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const, judgeNotes: 'confirmed' },
      { severity: 'suggestion' as const, title: 'Style', file: 'src/app.ts', line: 8, description: 'desc', reviewers: ['general'], judgeConfidence: 'medium' as const },
      { severity: 'nitpick' as const, title: 'Nit', file: 'src/utils.js', line: 1, description: 'desc', reviewers: ['general', 'security'], judgeConfidence: 'low' as const },
    ];
    const allJudged = [
      ...findings,
      { severity: 'ignore' as const, title: 'Dropped', file: 'src/app.ts', line: 2, description: 'dropped', reviewers: ['security'], judgeConfidence: 'high' as const, judgeNotes: 'not relevant' },
    ];
    const rawFindings = [
      ...findings,
      { severity: 'nitpick' as const, title: 'Dropped', file: 'src/app.ts', line: 2, description: 'dropped', reviewers: ['security'] },
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
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'REQUEST_CHANGES', verdictReason: 'novel_suggestion' });

    await callRunFullReview();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg).toBeDefined();

    // agentMetrics: third finding has both reviewers, so security gets 3 raw / 2 kept
    expect(statsArg!.reviewers.agentMetrics).toEqual([
      { name: 'security', findingsRaw: 3, findingsKept: 2 },
      { name: 'general', findingsRaw: 2, findingsKept: 2 },
    ]);

    expect(statsArg!.judge).toEqual(expect.objectContaining({
      confidenceDistribution: { high: 2, medium: 1, low: 1 },
      severityChanges: 2,
      mergedDuplicates: 2,
      verdictReason: 'novel_suggestion',
    }));

    expect(statsArg!.diff.fileTypes).toEqual({ '.ts': 1, '.js': 1 });

    expect(statsArg!.models.reviewer).toBeDefined();
    expect(statsArg!.models.judge).toBeDefined();

    expect(statsArg!.meta.round).toBe(1);

    // keptSeverities/droppedSeverities passed to dashboard use original severity for dropped findings
    const dashboardArg = jest.mocked(ghUtils.updateProgressComment).mock.calls.at(-1)?.[4];
    expect(dashboardArg?.keptSeverities).toEqual({ blocker: 1, suggestion: 1, nitpick: 1 });
    expect(dashboardArg?.droppedSeverities).toEqual({ nitpick: 1 });
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
      { severity: 'blocker' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const },
    ];
    const allJudged = [...findings];
    // rawFindings: 5 findings from agents (pre-suppression, pre-dedup)
    const rawFindings = [
      { severity: 'blocker' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'] },
      { severity: 'blocker' as const, title: 'Dup1', file: 'src/app.ts', line: 6, description: 'desc', reviewers: ['security'] },
      { severity: 'blocker' as const, title: 'Dup2', file: 'src/app.ts', line: 7, description: 'desc', reviewers: ['general'] },
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
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'REQUEST_CHANGES', verdictReason: 'novel_suggestion' });

    await callRunFullReview();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg).toBeDefined();

    // mergedDuplicates excludes pre-judge dedup: 5 - 1 (static) - 1 (llm) - 1 (judged) = 2
    expect(statsArg!.judge.mergedDuplicates).toBe(2);

    // findingsRaw comes from rawFindings (pre-dedup per-agent counts)
    expect(statsArg!.reviewers.agentMetrics).toEqual([
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
      { severity: 'blocker' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const },
    ];
    const allJudged = [...findings];
    const rawFindings = [
      { severity: 'blocker' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'] },
      { severity: 'nitpick' as const, title: 'Suppressed1', file: 'src/app.ts', line: 6, description: 'desc', reviewers: ['security'] },
      { severity: 'nitpick' as const, title: 'Suppressed2', file: 'src/app.ts', line: 7, description: 'desc', reviewers: ['general'] },
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
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'REQUEST_CHANGES', verdictReason: 'novel_suggestion' });

    await callRunFullReview();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg).toBeDefined();

    // mergedDuplicates excludes memory suppressions: 4 - 2 (suppressed) - 0 - 0 - 1 (judged) = 1
    expect(statsArg!.judge.mergedDuplicates).toBe(1);
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
      { severity: 'nitpick' as const, title: 'Guard', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const, tags: ['defensive-hardening'], originalSeverity: 'blocker' as const, reachability: 'hypothetical' as const },
      { severity: 'blocker' as const, title: 'Real', file: 'src/app.ts', line: 6, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const, reachability: 'reachable' as const },
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
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'REQUEST_CHANGES', verdictReason: 'novel_suggestion' });

    await callRunFullReview();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg!.judge.defensiveHardeningCount).toBe(1);
  });

  it('surfaces crossRoundSuppressed and crossRoundDemoted counts in judgeMetrics', async () => {
    const testFiles = [
      { path: 'src/app.ts', changeType: 'modified' as const, hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }] },
    ];
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: testFiles, totalAdditions: 20, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue(testFiles);

    const findings = [
      { severity: 'blocker' as const, title: 'Real', file: 'src/app.ts', line: 6, description: 'desc', reviewers: ['security'], judgeConfidence: 'high' as const },
    ];

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'REQUEST_CHANGES', summary: 'Issues found',
      findings,
      highlights: [],
      reviewComplete: true,
      rawFindingCount: 3,
      agentNames: ['security'],
      allJudgedFindings: [...findings],
      rawFindings: [...findings],
      crossRoundSuppressed: 1,
      crossRoundDemoted: 1,
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: findings, duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'REQUEST_CHANGES', verdictReason: 'required_present' });

    await callRunFullReview();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg!.judge.crossRoundSuppressed).toBe(1);
    expect(statsArg!.judge.crossRoundDemoted).toBe(1);
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
      severity: 'nitpick' as const, title: 'Style nit', file: 'src/app.ts',
      line: 3, description: 'nit desc', reviewers: ['general'],
    };
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Minor nits',
      findings: [nitFinding], highlights: [], reviewComplete: true,
      agentNames: ['general'],
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({
      unique: [nitFinding], duplicates: [],
    });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'COMMENT', verdictReason: 'only_nit_or_suggestion' });

    await callRunFullReview();

    expect(jest.mocked(ghUtils.createNitIssue)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42,
      [expect.objectContaining({ severity: 'nitpick' })], 'abc123',
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
      severity: 'nitpick' as const, title: 'Style nit', file: 'src/app.ts',
      line: 3, description: 'nit desc', reviewers: ['general'],
    };
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Minor nits',
      findings: [nitFinding], highlights: [], reviewComplete: true,
      agentNames: ['general'],
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({
      unique: [nitFinding], duplicates: [],
    });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'COMMENT', verdictReason: 'only_nit_or_suggestion' });

    await callRunFullReview();

    // Nits go inline, no nit issue created
    expect(jest.mocked(ghUtils.createNitIssue)).not.toHaveBeenCalled();
    // All findings (including nits) should be in the posted review
    expect(jest.mocked(ghUtils.postReview)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 42, 'abc123',
      expect.objectContaining({
        findings: [expect.objectContaining({ severity: 'nitpick' })],
      }),
      expect.anything(), expect.anything(), expect.anything(), expect.anything(),
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
      agentNames: ['general'],
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
      { title: 'Bug', file: 'src/app.ts', line: 5, severity: 'blocker' as const, status: 'resolved' as const },
    ];
    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings,
      recapContext: 'previous context',
      priorRounds: [],
    });

    const finding2 = { severity: 'nitpick' as const, title: 'Style', file: 'src/app.ts', line: 8, description: 'desc', reviewers: ['general'] };
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Issues',
      findings: [finding2], highlights: [], reviewComplete: true,
      agentNames: ['general'],
    });

    await callRunFullReview();

    // runReview should receive previousFindings as the last positional arg so
    // dedup runs before the judge stage.
    const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
    expect(runReviewCall[RUN_REVIEW_PREVIOUS_FINDINGS_ARG]).toEqual(previousFindings);
  });

  it('forwards prior rounds from recap state to runReview when memory is enabled', async () => {
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
      auto_review: true, auto_approve: false, exclude_paths: [], max_diff_lines: 10000,
      reviewers: [], instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: true, repo: 'owner/memory' },
    });
    jest.mocked(authModule.getMemoryToken).mockReturnValue('token123');
    jest.mocked(memoryModule.loadMemory).mockResolvedValue({
      learnings: [], suppressions: [], patterns: [],
    });

    const priorRounds = [{
      round: 1,
      commitSha: 'abc',
      timestamp: '2025-01-01T00:00:00Z',
      findings: [
        {
          fingerprint: { file: 'a.ts', lineStart: 1, lineEnd: 1, slug: 's' },
          severity: 'blocker' as const,
          title: 't',
          authorReply: 'agree' as const,
          specialist: 'Security & Safety',
        },
        {
          fingerprint: { file: 'a.ts', lineStart: 2, lineEnd: 2, slug: 's2' },
          severity: 'blocker' as const,
          title: 't2',
          authorReply: 'agree' as const,
          specialist: 'Security & Safety',
        },
      ],
    }];
    seedPriorRounds(1, 'test-repo', priorRounds);

    await callRunFullReview();

    const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
    expect(runReviewCall[RUN_REVIEW_PRIOR_ROUNDS_ARG]).toEqual(priorRounds.map(roundContextFromLegacy));

    // With 1 prior round, meta.round must be 2
    const roundContextArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(roundContextArg!.meta.round).toBe(2);
  });

  describe('meta.round derivation', () => {
    const roundTestFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };

    it('sets meta.round to 1 when no prior rounds are present', async () => {
      jest.mocked(diffModule.parsePRDiff).mockReturnValue({
        files: [roundTestFile], totalAdditions: 10, totalDeletions: 5,
      });
      jest.mocked(diffModule.filterFiles).mockReturnValue([roundTestFile]);

      await callRunFullReview();

      const roundContextArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
      expect(roundContextArg!.meta.round).toBe(1);
    });

    it('sets meta.round to N+1 when recap has N prior rounds', async () => {
      jest.mocked(diffModule.parsePRDiff).mockReturnValue({
        files: [roundTestFile], totalAdditions: 10, totalDeletions: 5,
      });
      jest.mocked(diffModule.filterFiles).mockReturnValue([roundTestFile]);
      jest.mocked(configModule.loadConfig).mockReturnValue({
        auto_review: true, auto_approve: false, exclude_paths: [], max_diff_lines: 10000,
        reviewers: [], instructions: '', review_level: 'auto',
        review_thresholds: { small: 200, medium: 800 },
        memory: { enabled: true, repo: 'owner/memory' },
      });
      jest.mocked(authModule.getMemoryToken).mockReturnValue('token123');
      jest.mocked(memoryModule.loadMemory).mockResolvedValue({
        learnings: [], suppressions: [], patterns: [],
      });

      const priorRounds: LegacyHandoverRoundFixture[] = [
        { round: 1, commitSha: 'sha1', timestamp: '2025-01-01T00:00:00Z', findings: [] },
        { round: 2, commitSha: 'sha2', timestamp: '2025-01-02T00:00:00Z', findings: [] },
        { round: 3, commitSha: 'sha3', timestamp: '2025-01-03T00:00:00Z', findings: [] },
      ];
      seedPriorRounds(1, 'test-repo', priorRounds);

      await callRunFullReview();

      const roundContextArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
      expect(roundContextArg!.meta.round).toBe(4);
    });
  });

  describe('prior-round agent pinning', () => {
    const pinTestFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };

    beforeEach(() => {
      jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
      jest.mocked(diffModule.parsePRDiff).mockReturnValue({
        files: [pinTestFile], totalAdditions: 10, totalDeletions: 5,
      });
      jest.mocked(diffModule.filterFiles).mockReturnValue([pinTestFile]);
      jest.mocked(authModule.getMemoryToken).mockReturnValue('token123');
      jest.mocked(memoryModule.loadMemory).mockResolvedValue({
        learnings: [], suppressions: [], patterns: [],
      });
      jest.mocked(configModule.loadConfig).mockReturnValue({
        auto_review: true, auto_approve: false, exclude_paths: [], max_diff_lines: 10000,
        reviewers: [], instructions: '', review_level: 'auto',
        review_thresholds: { small: 200, medium: 800 },
        memory: { enabled: true, repo: 'owner/memory' },
      });
    });

    it('forwards prior-round agents through to the dashboard selectTeam call', async () => {
      const priorRounds: LegacyHandoverRoundFixture[] = [{
        round: 1,
        commitSha: 'abc',
        timestamp: '2025-01-01T00:00:00Z',
        findings: [],
        agents: ['Security & Safety', 'Architecture & Design', 'Correctness & Logic', 'Testing & Coverage'],
      }];
      seedPriorRounds(1, 'test-repo', priorRounds);

      // Trigger the planning-phase progress callback so the dashboard selectTeam runs.
      jest.mocked(reviewModule.runReview).mockImplementation(async (_clients, _config, _diff, _rawDiff, _ctx, _mem, _files, _pr, _issues, onProgress) => {
        onProgress?.({
          phase: 'planning',
          rawFindingCount: 0,
          plannerResult: {
            teamSize: 3,
            reviewerEffort: 'medium',
            judgeEffort: 'medium',
            prType: 'feature',
            agents: [
              { name: 'Security & Safety', effort: 'high' },
              { name: 'Architecture & Design', effort: 'medium' },
              { name: 'Correctness & Logic', effort: 'medium' },
            ],
          },
          plannerDurationMs: 100,
        });
        return {
          verdict: 'APPROVE', summary: 'ok',
          findings: [], highlights: [], reviewComplete: true,
          agentNames: ['Security & Safety', 'Architecture & Design', 'Correctness & Logic', 'Testing & Coverage'],
        };
      });

      await callRunFullReview();

      // The dashboard selectTeam call inside the planning callback receives the
      // prior-round agents as the 6th positional argument.
      const calls = jest.mocked(reviewModule.selectTeam).mock.calls;
      // Identify the planning-phase call by the exact agent picks the planner emitted.
      const planningCall = calls.find(c =>
        Array.isArray(c[4]) && c[4].length === 3 && c[4][0]?.name === 'Security & Safety',
      );
      expect(planningCall).toBeDefined();
      const { 5: priorRoundAgentsArg } = planningCall!;
      expect(priorRoundAgentsArg).toEqual(['Security & Safety', 'Architecture & Design', 'Correctness & Logic', 'Testing & Coverage']);
    });

    it('reconciles planner-path dashboard with prior-round agents after runReview', async () => {
      // Planner path: review_level is 'auto' (set by beforeEach) and prior rounds exist.
      const priorRounds: LegacyHandoverRoundFixture[] = [{
        round: 1,
        commitSha: 'abc',
        timestamp: '2025-01-01T00:00:00Z',
        findings: [],
        agents: ['Security & Safety', 'Architecture & Design'],
      }];
      seedPriorRounds(1, 'test-repo', priorRounds);

      const resolvedNames = ['Security & Safety', 'Architecture & Design', 'Correctness & Logic'];
      // Override selectTeam so the planning-phase callback seeds the dashboard with the
      // actual resolved agent names; this lets agent-complete metrics be preserved through
      // the reconcileDashboardAgents call.
      jest.mocked(reviewModule.selectTeam).mockReturnValue({
        level: 'standard' as 'small',
        agents: resolvedNames.map(n => ({ name: n, focus: '' })),
        lineCount: 0,
      });
      jest.mocked(reviewModule.runReview).mockImplementation(async (_clients, _config, _diff, _rawDiff, _ctx, _mem, _files, _pr, _issues, onProgress) => {
        onProgress?.({
          phase: 'planning',
          rawFindingCount: 0,
          plannerResult: {
            teamSize: 3,
            reviewerEffort: 'medium',
            judgeEffort: 'medium',
            prType: 'feature',
            agents: [
              { name: 'Security & Safety', effort: 'high' },
              { name: 'Architecture & Design', effort: 'medium' },
              { name: 'Correctness & Logic', effort: 'medium' },
            ],
          },
          plannerDurationMs: 100,
        });
        onProgress?.({
          phase: 'agent-complete',
          agentName: 'Security & Safety',
          agentFindingCount: 3,
          agentDurationMs: 1200,
          agentStatus: 'success',
          rawFindingCount: 3,
          completedAgents: 1,
          totalAgents: 3,
        });
        return {
          verdict: 'APPROVE', summary: 'ok',
          findings: [], highlights: [], reviewComplete: true,
          agentNames: resolvedNames,
          plannerResult: {
            teamSize: 3,
            reviewerEffort: 'medium',
            judgeEffort: 'medium',
            prType: 'feature',
            agents: [],
          },
        };
      });

      await callRunFullReview();

      const progressCommentCalls = jest.mocked(ghUtils.updateProgressComment).mock.calls;
      expect(progressCommentCalls.length).toBeGreaterThan(0);
      const finalDashboard = progressCommentCalls[progressCommentCalls.length - 1][4];
      expect(finalDashboard.agentCount).toBe(3);
      expect(finalDashboard.agentProgress?.map((a: { name: string }) => a.name)).toEqual(resolvedNames);
      // Verify reconcileDashboardAgents preserves metrics from prior agent-complete callbacks.
      const secEntry = finalDashboard.agentProgress?.find((a: { name: string }) => a.name === 'Security & Safety');
      expect(secEntry?.findingCount).toBe(3);
      expect(secEntry?.durationMs).toBe(1200);
    });

    it('reconciles non-planner dashboard with pinned agents after runReview', async () => {
      // Non-planner path: review_level is explicitly 'small', not 'auto'.
      jest.mocked(configModule.loadConfig).mockReturnValue({
        auto_review: true, auto_approve: false, exclude_paths: [], max_diff_lines: 10000,
        reviewers: [], instructions: '', review_level: 'small',
        review_thresholds: { small: 200, medium: 800 },
        memory: { enabled: true, repo: 'owner/memory' },
      });

      const priorRounds: LegacyHandoverRoundFixture[] = [{
        round: 1,
        commitSha: 'abc',
        timestamp: '2025-01-01T00:00:00Z',
        findings: [],
        agents: ['Security & Safety', 'Architecture & Design', 'Correctness & Logic', 'Testing & Coverage'],
      }];
      seedPriorRounds(1, 'test-repo', priorRounds);

      const resolvedNames = ['Security & Safety', 'Architecture & Design', 'Correctness & Logic', 'Testing & Coverage'];
      jest.mocked(reviewModule.runReview).mockResolvedValue({
        verdict: 'APPROVE', summary: 'ok',
        findings: [], highlights: [], reviewComplete: true,
        agentNames: resolvedNames,
      });

      await callRunFullReview();

      // The final completeDashboard passed to updateProgressComment must include the pinned agents.
      const progressCommentCalls = jest.mocked(ghUtils.updateProgressComment).mock.calls;
      expect(progressCommentCalls.length).toBeGreaterThan(0);
      const finalDashboard = progressCommentCalls[progressCommentCalls.length - 1][4];
      expect(finalDashboard.agentCount).toBe(4);
      expect(finalDashboard.agentProgress?.map((a: { name: string }) => a.name)).toEqual(resolvedNames);
    });

    it('silently drops unknown prior-round agent from non-planner dashboard without error', async () => {
      // Non-planner path with a prior-round agent name not present in the agent pool.
      // The pool-check guard in runFullReview silently omits the unknown agent from the
      // dashboard; selectTeam already warns for this case so no duplicate warning is needed.
      jest.mocked(configModule.loadConfig).mockReturnValue({
        auto_review: true, auto_approve: false, exclude_paths: [], max_diff_lines: 10000,
        reviewers: [], instructions: '', review_level: 'small',
        review_thresholds: { small: 200, medium: 800 },
        memory: { enabled: true, repo: 'owner/memory' },
      });

      const priorRounds: LegacyHandoverRoundFixture[] = [{
        round: 1,
        commitSha: 'abc',
        timestamp: '2025-01-01T00:00:00Z',
        findings: [],
        agents: ['Security & Safety', 'Bogus Unknown Agent'],
      }];
      seedPriorRounds(1, 'test-repo', priorRounds);

      const resolvedNames = ['Security & Safety'];
      jest.mocked(reviewModule.runReview).mockResolvedValue({
        verdict: 'APPROVE', summary: 'ok',
        findings: [], highlights: [], reviewComplete: true,
        agentNames: resolvedNames,
      });

      await expect(callRunFullReview()).resolves.not.toThrow();

      const progressCommentCalls = jest.mocked(ghUtils.updateProgressComment).mock.calls;
      expect(progressCommentCalls.length).toBeGreaterThan(0);
      const finalDashboard = progressCommentCalls[progressCommentCalls.length - 1][4];
      // Unknown agent must not appear in the dashboard.
      const agentNames = finalDashboard.agentProgress?.map((a: { name: string }) => a.name) ?? [];
      expect(agentNames).not.toContain('Bogus Unknown Agent');
      // agentCount reflects only known-pool agents that were reconciled.
      expect(finalDashboard.agentCount).toBe(resolvedNames.length);
      // The dashboard pre-population path silently skips unknown agents — no warning
      // should fire for the unknown name here (selectTeam handles its own warning).
      const bogusWarnings = jest.mocked(core.warning).mock.calls
        .filter(c => String(c[0]).includes('Bogus Unknown Agent'));
      expect(bogusWarnings).toHaveLength(0);
    });
  });

  it('includes specialist, suggestedFix, and title in RoundContext findingEntries', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Issues',
      findings: [{
        severity: 'warning' as const,
        title: 'Misleading variable',
        file: 'src/app.ts',
        line: 5,
        description: 'The variable name is misleading.',
        reviewers: ['Correctness & Logic'],
        suggestedFix: 'Rename `x` to `userCount`.',
      }],
      highlights: [],
      reviewComplete: true,
      agentNames: ['Correctness & Logic'],
    });

    await callRunFullReview();

    const calls = jest.mocked(ghUtils.postReview).mock.calls;
    expect(calls).toHaveLength(1);
    const [,,,,,,,roundContextArg] = calls[0];
    expect(roundContextArg).toBeDefined();
    const entry = roundContextArg!.findings.entries[0];
    expect(entry.specialist).toBe('Correctness & Logic');
    expect(entry.suggestedFix).toBe('Rename `x` to `userCount`.');
    expect(entry.title).toBe('Misleading variable');
  });

  it('truncates suggestedFix longer than 300 chars in findingEntries', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Issues',
      findings: [{
        severity: 'warning' as const,
        title: 'T',
        file: 'src/app.ts',
        line: 5,
        description: 'desc',
        reviewers: ['Agent'],
        suggestedFix: 'x'.repeat(301),
      }],
      highlights: [], reviewComplete: true, agentNames: ['Agent'],
    });

    await callRunFullReview();

    const [,,,,,,,rc] = jest.mocked(ghUtils.postReview).mock.calls[0];
    expect(rc!.findings.entries[0].suggestedFix).toHaveLength(300);
  });

  it('truncates title longer than 200 chars in findingEntries', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: '',
      findings: [{
        severity: 'warning' as const,
        title: 'A'.repeat(201),
        file: 'src/app.ts',
        line: 5,
        description: 'd',
        reviewers: ['Agent'],
      }],
      highlights: [], reviewComplete: true, agentNames: ['Agent'],
    });

    await callRunFullReview();

    const [,,,,,,,rc] = jest.mocked(ghUtils.postReview).mock.calls[0];
    expect(rc!.findings.entries[0].title).toHaveLength(200);
  });

  it('does not touch memory repo when memory is disabled', async () => {
    const testFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [testFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);
    // Default config already has memory.enabled = false, so no override needed.

    await callRunFullReview();

    expect(jest.mocked(memoryModule.loadMemory)).not.toHaveBeenCalled();
    expect(jest.mocked(memoryModule.updatePattern)).not.toHaveBeenCalled();
    const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
    // Consumers read prior rounds from `RecapState.priorRounds`, which is
    // always an array (empty when recap finds no prior context blocks).
    expect(runReviewCall[RUN_REVIEW_PRIOR_ROUNDS_ARG]).toEqual([]);
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

    const finding = { severity: 'nitpick' as const, title: 'Bug', file: 'src/app.ts', line: 5, description: 'desc', reviewers: ['general'] };
    const escalated = { ...finding, severity: 'blocker' as const };
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'Nits',
      findings: [finding], highlights: [], reviewComplete: true,
      agentNames: ['general'],
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: [finding], duplicates: [] });
    jest.mocked(memoryModule.applyEscalations).mockReturnValue([escalated]);
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'REQUEST_CHANGES', verdictReason: 'novel_suggestion' });

    await callRunFullReview();

    expect(jest.mocked(memoryModule.applyEscalations)).toHaveBeenCalledWith(
      [finding], memory.patterns,
    );
    // Verdict recalculated after escalation
    expect(jest.mocked(reviewModule.determineVerdict)).toHaveBeenCalled();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg?.judge.verdictReason).toBe('novel_suggestion');
    // result.verdictReason must also be updated alongside result.verdict after escalation
    const reviewResultArg = jest.mocked(ghUtils.postReview).mock.calls[0][5];
    expect(reviewResultArg?.verdictReason).toBe('novel_suggestion');
    // one finding changed severity → escalationsApplied must reflect that
    expect(statsArg?.memory.escalationsApplied).toBe(1);
  });

  it('populates verdictReason in judge on clean APPROVE with no findings', async () => {
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
      verdict: 'APPROVE', summary: 'Looks good',
      findings: [], highlights: [], reviewComplete: true,
      agentNames: ['general'],
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: [], duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'APPROVE', verdictReason: 'only_nit_or_suggestion' });

    await callRunFullReview();

    const statsArg = jest.mocked(ghUtils.postReview).mock.calls[0][7];
    expect(statsArg?.judge.verdictReason).toBe('only_nit_or_suggestion');
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
      agentNames: ['general'],
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: [finding], duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'COMMENT', verdictReason: 'only_nit_or_suggestion' });

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
          agentNames: [],
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
          agentNames: [],
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
          agentNames: [],
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
          agentNames: [],
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
    const finding2 = { severity: 'nitpick' as const, title: 'Noise', file: 'src/app.ts', line: 7, description: 'desc', reviewers: ['general'] };

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
          agentNames: [],
        };
      },
    );
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'COMMENT', verdictReason: 'only_nit_or_suggestion' });

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
      { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'blocker' as const, status: 'resolved' as const },
      { title: 'Bug B', file: 'src/app.ts', line: 2, severity: 'suggestion' as const, status: 'open' as const, threadId: 'PRRT_123' },
    ];
    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings,
      recapContext: 'previous context',
      priorRounds: [],
    });

    await callRunFullReview();

    // runReview should receive isFollowUp and openThreads as the last two args
    const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
    const isFollowUp = runReviewCall[RUN_REVIEW_IS_FOLLOW_UP_ARG];
    const openThreads = runReviewCall[RUN_REVIEW_OPEN_THREADS_ARG];

    expect(isFollowUp).toBe(true);
    expect(openThreads).toEqual([
      {
        threadId: 'PRRT_123',
        threadUrl: undefined,
        title: 'Bug B',
        file: 'src/app.ts',
        line: 2,
        severity: 'suggestion',
        currentCode: '(file content unavailable)',
      },
    ]);
  });

  it('passes openThreads to the post-escalation `determineVerdict` so prior unaddressed warnings block APPROVE', async () => {
    // Regression for the dispatch-site bug: `runFullReview` recomputes the
    // verdict after memory escalations and must forward `openThreads` so the
    // `prior_unaddressed` branch can fire. Without the third argument every
    // unresolved prior warning silently falls through to APPROVE.
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
        { title: 'Old warning', file: 'src/app.ts', line: 5, severity: 'warning' as const, status: 'open' as const, threadId: 'PRRT_OPEN' },
      ],
      recapContext: '',
      priorRounds: [],
    });

    const finding = { severity: 'nitpick' as const, title: 'Tiny', file: 'src/app.ts', line: 9, description: 'd', reviewers: ['general'] };
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'Nits',
      findings: [finding], highlights: [], reviewComplete: true,
      agentNames: ['general'],
    });
    jest.mocked(recapModule.deduplicateFindings).mockReturnValue({ unique: [finding], duplicates: [] });
    jest.mocked(reviewModule.determineVerdict).mockReturnValue({ verdict: 'REQUEST_CHANGES', verdictReason: 'prior_unaddressed' });

    await callRunFullReview();

    const determineVerdictCalls = jest.mocked(reviewModule.determineVerdict).mock.calls;
    expect(determineVerdictCalls.length).toBeGreaterThan(0);
    const lastCall = determineVerdictCalls[determineVerdictCalls.length - 1];
    expect(lastCall[2]).toEqual([
      expect.objectContaining({ threadId: 'PRRT_OPEN', file: 'src/app.ts', line: 5 }),
    ]);

    const reviewResultArg = jest.mocked(ghUtils.postReview).mock.calls[0][5];
    expect(reviewResultArg?.verdict).toBe('REQUEST_CHANGES');
    expect(reviewResultArg?.verdictReason).toBe('prior_unaddressed');
  });

  it('forwards `description` and `suggestedFix` from `previousFindings` into `baseOpenThreads`', async () => {
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
      previousFindings: [{
        title: 'Missing variant',
        file: 'src/app.ts',
        line: 5,
        severity: 'warning' as const,
        status: 'open' as const,
        threadId: 'PRRT_meta',
        description: 'Error enum lacks the rotation chainlock variant.',
        suggestedFix: 'Add `MissingRotationChainLockSigs(QuorumHash)` to the enum.',
      }],
      recapContext: '',
      priorRounds: [],
    });

    await callRunFullReview();

    const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
    const openThreads = runReviewCall[RUN_REVIEW_OPEN_THREADS_ARG] as Array<{ threadId: string; description?: string; suggestedFix?: string }>;
    expect(openThreads).toHaveLength(1);
    expect(openThreads[0].threadId).toBe('PRRT_meta');
    expect(openThreads[0].description).toBe('Error enum lacks the rotation chainlock variant.');
    expect(openThreads[0].suggestedFix).toBe('Add `MissingRotationChainLockSigs(QuorumHash)` to the enum.');
  });
  it('populates openThreads[].currentCode with a windowed snippet when file contents are available', async () => {
    const threadFile = 'src/app.ts';
    const fileText = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const changedFile = {
      path: threadFile, changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 20, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [changedFile], totalAdditions: 20, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([changedFile]);
    jest.mocked(ghUtils.fetchFileContents).mockResolvedValue(new Map([[threadFile, fileText]]));

    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings: [
        { title: 'Bug A', file: threadFile, line: 10, severity: 'warning' as const, status: 'open' as const, threadId: 'PRRT_code' },
      ],
      recapContext: '',
      priorRounds: [],
    });

    await callRunFullReview();

    const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
    const openThreads = runReviewCall[RUN_REVIEW_OPEN_THREADS_ARG];
    expect(openThreads).toHaveLength(1);
    expect(openThreads![0].currentCode).toContain('>>> 10: line 10');
    expect(openThreads![0].currentCode).toContain('   5: line 5');
    expect(openThreads![0].currentCode).toContain('   15: line 15');
  });

  it('deduplicates open-thread file paths against changed files when fetching contents', async () => {
    const changedFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [changedFile], totalAdditions: 10, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([changedFile]);

    // Two open threads: one in a changed file (must not duplicate) and one in
    // an unchanged file (must be added to the fetch list).
    const previousFindings = [
      { title: 'Issue in changed', file: 'src/app.ts', line: 3, severity: 'suggestion' as const, status: 'open' as const, threadId: 'PRRT_dup' },
      { title: 'Issue in unchanged', file: 'src/other.ts', line: 5, severity: 'warning' as const, status: 'open' as const, threadId: 'PRRT_new' },
    ];
    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings,
      recapContext: '',
      priorRounds: [],
    });

    await callRunFullReview();

    expect(jest.mocked(ghUtils.fetchFileContents)).toHaveBeenCalledTimes(1);
    const fetchCall = jest.mocked(ghUtils.fetchFileContents).mock.calls[0];
    const requestedPaths = fetchCall[4];
    // Both files present, no duplicate of `src/app.ts`
    expect(requestedPaths).toContain('src/app.ts');
    expect(requestedPaths).toContain('src/other.ts');
    expect(requestedPaths.filter(p => p === 'src/app.ts')).toHaveLength(1);
  });

  it('skips deleted changed files but still fetches open-thread files', async () => {
    const deletedFile = {
      path: 'src/gone.ts', changeType: 'deleted' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 0, newLines: 0, content: 'code' }],
    };
    jest.mocked(diffModule.isDiffTooLarge).mockReturnValue(false);
    jest.mocked(diffModule.parsePRDiff).mockReturnValue({
      files: [deletedFile], totalAdditions: 0, totalDeletions: 5,
    });
    jest.mocked(diffModule.filterFiles).mockReturnValue([deletedFile]);

    const previousFindings = [
      { title: 'Live thread', file: 'src/live.ts', line: 1, severity: 'suggestion' as const, status: 'open' as const, threadId: 'PRRT_live' },
    ];
    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings,
      recapContext: '',
      priorRounds: [],
    });

    await callRunFullReview();

    expect(jest.mocked(ghUtils.fetchFileContents)).toHaveBeenCalledTimes(1);
    const requestedPaths = jest.mocked(ghUtils.fetchFileContents).mock.calls[0][4];
    expect(requestedPaths).not.toContain('src/gone.ts');
    expect(requestedPaths).toContain('src/live.ts');
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

  it('does not resolve any thread when inter-round diff is empty even if LLM claimed addressed', async () => {
    // Force-pushed rebase with identical tree: every open thread must remain
    // unresolved regardless of what the LLM-driven judge reports.
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
        { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'warning' as const, status: 'open' as const, threadId: 'PRRT_a' },
      ],
      recapContext: 'previous context',
      priorRounds: [],
    });

    // Enable memory so prior-round state is read from recap and
    // fetchInterRoundDiff is invoked with a prior-round SHA distinct from
    // the current commit.
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, exclude_paths: [], max_diff_lines: 10000,
      reviewers: [], instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: true, repo: 'owner/memory' },
    });
    jest.mocked(authModule.getMemoryToken).mockReturnValue('token123');
    jest.mocked(memoryModule.loadMemory).mockResolvedValue({
      learnings: [], suppressions: [], patterns: [],
    });
    seedPriorRounds(42, 'test-repo', [{
      round: 1, commitSha: 'prior-sha', timestamp: '2025-01-01T00:00:00Z', findings: [],
    }]);
    // fetchInterRoundDiff returns '' to simulate a force-pushed rebase whose
    // compare API yields no patch between prior and current head.
    jest.mocked(ghUtils.fetchInterRoundDiff).mockResolvedValue('');

    // Mock returns `addressed` to honour the test title "even if LLM claimed
    // addressed". The judge-level synthetic override is bypassed here because
    // `runReview` is mocked, so the assertion that no resolveReviewThread
    // mutation fires proves the index.ts-level defense-in-depth guard works.
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'No changes since last review', findings: [],
      highlights: [], reviewComplete: true,
      agentNames: ['general'],
      threadEvaluations: [
        { threadId: 'PRRT_a', status: 'addressed', reason: 'LLM hallucination' },
      ],
    });

    await callRunFullReview();

    expect(jest.mocked(ghUtils.fetchInterRoundDiff)).toHaveBeenCalledTimes(1);
    const runReviewArgs = jest.mocked(reviewModule.runReview).mock.calls[0];
    const passedInterRoundDiff = runReviewArgs[RUN_REVIEW_INTER_ROUND_DIFF_ARG];
    expect(passedInterRoundDiff).toBe('');

    expect(mockGraphql).not.toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      expect.anything(),
    );
  });

  it('sets interRoundDiff to empty string without API call when lastPriorSha equals commitSha', async () => {
    // Force-push that lands on the same tree hash as the prior round: index.ts
    // short-circuits the compare-API call and passes '' directly. Guards
    // against an accidental `!==` inversion that would slip past the existing
    // empty-diff test where prior and current SHAs differ.
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
        { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'warning' as const, status: 'open' as const, threadId: 'PRRT_a' },
      ],
      recapContext: 'previous context',
      priorRounds: [],
    });

    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, exclude_paths: [], max_diff_lines: 10000,
      reviewers: [], instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: true, repo: 'owner/memory' },
    });
    jest.mocked(authModule.getMemoryToken).mockReturnValue('token123');
    jest.mocked(memoryModule.loadMemory).mockResolvedValue({
      learnings: [], suppressions: [], patterns: [],
    });
    // Prior round commit equals the current commitSha (`baseArgs.commitSha`).
    seedPriorRounds(42, 'test-repo', [{
      round: 1, commitSha: baseArgs.commitSha, timestamp: '2025-01-01T00:00:00Z', findings: [],
    }]);

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'No changes since last review', findings: [],
      highlights: [], reviewComplete: true,
      agentNames: ['general'],
      threadEvaluations: [
        { threadId: 'PRRT_a', status: 'not_addressed', reason: 'No code changes since prior review' },
      ],
    });

    await callRunFullReview();

    expect(jest.mocked(ghUtils.fetchInterRoundDiff)).not.toHaveBeenCalled();
    const runReviewArgs = jest.mocked(reviewModule.runReview).mock.calls[0];
    const passedInterRoundDiff = runReviewArgs[RUN_REVIEW_INTER_ROUND_DIFF_ARG];
    expect(passedInterRoundDiff).toBe('');
  });

  // Common setup for the parallel-fetch partial-rejection cases below: prior
  // round SHA distinct from the current commit (so `shouldFetchDiff` is true)
  // and a non-empty PR body (so `shouldFetchLinkedIssues` is true).
  function setupParallelFetchCase(): void {
    // Guard the second invariant: the cases below assume `shouldFetchLinkedIssues`
    // is true via `baseArgs.prContext.body`. Fail loudly if a future edit empties
    // the default body, otherwise the linked-issues rejection test would pass
    // trivially without exercising `fetchLinkedIssues`.
    expect(baseArgs.prContext?.body).toBeTruthy();
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
      previousFindings: [], recapContext: '', priorRounds: [],
    });
    jest.mocked(configModule.loadConfig).mockReturnValue({
      auto_review: true, auto_approve: false, exclude_paths: [], max_diff_lines: 10000,
      reviewers: [], instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: true, repo: 'owner/memory' },
    });
    jest.mocked(authModule.getMemoryToken).mockReturnValue('token123');
    jest.mocked(memoryModule.loadMemory).mockResolvedValue({
      learnings: [], suppressions: [], patterns: [],
    });
    seedPriorRounds(42, 'test-repo', [{
      round: 1, commitSha: 'prior-sha', timestamp: '2025-01-01T00:00:00Z', findings: [],
    }]);
    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'COMMENT', summary: 'ok', findings: [],
      highlights: [], reviewComplete: true,
      agentNames: ['general'],
      threadEvaluations: [],
    });
  }

  it('handles inter-round diff fetch rejection while linked issues fetch fulfills', async () => {
    // Promise.allSettled isolates failures: a rejected diffPromise must not
    // cancel the linked-issues fetch, and `interRoundDiff` must remain
    // undefined so the judge's known-empty override does not engage.
    setupParallelFetchCase();
    jest.mocked(ghUtils.fetchInterRoundDiff).mockRejectedValue(new Error('diff API down'));
    jest.mocked(ghUtils.fetchLinkedIssues).mockResolvedValue([
      { number: 7, title: 'Linked issue', body: 'Issue body' },
    ]);

    await callRunFullReview();

    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch inter-round diff'),
    );
    expect(jest.mocked(core.warning)).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch linked issues'),
    );
    const runReviewArgs = jest.mocked(reviewModule.runReview).mock.calls[0];
    expect(runReviewArgs[RUN_REVIEW_INTER_ROUND_DIFF_ARG]).toBeUndefined();
    expect(runReviewArgs[RUN_REVIEW_LINKED_ISSUES_ARG]).toEqual([
      { number: 7, title: 'Linked issue', body: 'Issue body' },
    ]);
  });

  it('handles linked issues fetch rejection while inter-round diff fetch fulfills', async () => {
    // Mirror image: a rejected linkedIssuesPromise must not lose the
    // successfully-fetched inter-round diff, and the warning must mention
    // linked issues only.
    setupParallelFetchCase();
    jest.mocked(ghUtils.fetchInterRoundDiff).mockResolvedValue(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
    );
    jest.mocked(ghUtils.fetchLinkedIssues).mockRejectedValue(new Error('issues API down'));

    await callRunFullReview();

    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch linked issues'),
    );
    expect(jest.mocked(core.warning)).not.toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch inter-round diff'),
    );
    const runReviewArgs = jest.mocked(reviewModule.runReview).mock.calls[0];
    expect(runReviewArgs[RUN_REVIEW_INTER_ROUND_DIFF_ARG]).toBe(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
    );
    expect(runReviewArgs[RUN_REVIEW_LINKED_ISSUES_ARG]).toBeUndefined();
  });

  it('handles both inter-round diff and linked issues fetch rejecting simultaneously', async () => {
    // `Promise.allSettled` reports both rejections independently: each warning
    // must be emitted on its own and both values must remain `undefined`. Guards
    // against a future regression where one rejection silently suppresses the
    // other warning.
    setupParallelFetchCase();
    jest.mocked(ghUtils.fetchInterRoundDiff).mockRejectedValue(new Error('diff API down'));
    jest.mocked(ghUtils.fetchLinkedIssues).mockRejectedValue(new Error('issues API down'));

    await callRunFullReview();

    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch inter-round diff'),
    );
    expect(jest.mocked(core.warning)).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch linked issues'),
    );
    const runReviewArgs = jest.mocked(reviewModule.runReview).mock.calls[0];
    expect(runReviewArgs[RUN_REVIEW_INTER_ROUND_DIFF_ARG]).toBeUndefined();
    expect(runReviewArgs[RUN_REVIEW_LINKED_ISSUES_ARG]).toBeUndefined();
  });

  it('fetches inter-round diff but skips linked issues fetch when PR body is empty', async () => {
    // Covers the `shouldFetchDiff=true` / `shouldFetchLinkedIssues=false`
    // combination: prior round SHA differs from current head (diff fetched)
    // but the PR body is empty so `fetchLinkedIssues` must not be invoked.
    setupParallelFetchCase();
    jest.mocked(ghUtils.fetchInterRoundDiff).mockResolvedValue(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
    );

    await runFullReview(
      baseArgs.owner, baseArgs.repo, baseArgs.prNumber,
      baseArgs.commitSha, baseArgs.baseRef,
      { title: 'Test PR', body: '', baseBranch: 'main' },
    );

    expect(jest.mocked(ghUtils.fetchInterRoundDiff)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(ghUtils.fetchLinkedIssues)).not.toHaveBeenCalled();
    const runReviewArgs = jest.mocked(reviewModule.runReview).mock.calls[0];
    expect(runReviewArgs[RUN_REVIEW_INTER_ROUND_DIFF_ARG]).toBe(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
    );
    expect(runReviewArgs[RUN_REVIEW_LINKED_ISSUES_ARG]).toBeUndefined();
  });

  it('fetches linked issues but skips inter-round diff fetch when no prior round exists', async () => {
    // Covers the `shouldFetchDiff=false` / `shouldFetchLinkedIssues=true`
    // combination: no prior round (so `lastPriorSha` is undefined and
    // `fetchInterRoundDiff` must not be invoked) but the PR body is non-empty
    // so `fetchLinkedIssues` is called. `interRoundDiff` must remain `undefined`
    // (not the empty-string assigned in the same-SHA branch).
    setupParallelFetchCase();
    jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
      previousFindings: [], recapContext: '', priorRounds: [],
    });
    jest.mocked(ghUtils.fetchLinkedIssues).mockResolvedValue([
      { number: 11, title: 'First-round linked issue', body: 'Issue body' },
    ]);

    await callRunFullReview();

    expect(jest.mocked(ghUtils.fetchInterRoundDiff)).not.toHaveBeenCalled();
    expect(jest.mocked(ghUtils.fetchLinkedIssues)).toHaveBeenCalledTimes(1);
    const runReviewArgs = jest.mocked(reviewModule.runReview).mock.calls[0];
    expect(runReviewArgs[RUN_REVIEW_INTER_ROUND_DIFF_ARG]).toBeUndefined();
    expect(runReviewArgs[RUN_REVIEW_LINKED_ISSUES_ARG]).toEqual([
      { number: 11, title: 'First-round linked issue', body: 'Issue body' },
    ]);
  });

  it('suppresses addressed verdict from judge when inter-round diff is known-empty (defense-in-depth override)', async () => {
    // The judge allows `addressed` on current-code evidence alone, but the
    // index.ts override must still block resolution when the inter-round diff
    // is known-empty so a force-push-to-same-tree cannot resolve threads.
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
      auto_review: true, auto_approve: false, exclude_paths: [], max_diff_lines: 10000,
      reviewers: [], instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: true, repo: 'owner/memory' },
    });
    jest.mocked(authModule.getMemoryToken).mockReturnValue('token123');
    jest.mocked(memoryModule.loadMemory).mockResolvedValue({
      learnings: [], suppressions: [], patterns: [],
    });
    seedPriorRounds(
      42, 'test-repo',
      [{ round: 1, commitSha: baseArgs.commitSha, timestamp: '2025-01-01T00:00:00Z', findings: [] }],
      [{ title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'warning' as const, status: 'open' as const, threadId: 'PRRT_override' }],
      'previous context',
    );

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'ok', findings: [],
      highlights: [], reviewComplete: true,
      agentNames: ['general'],
      threadEvaluations: [
        { threadId: 'PRRT_override', status: 'addressed', reason: 'Current code resolves the concern' },
      ],
    });

    await callRunFullReview();

    expect(mockGraphql).not.toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_override' },
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      expect.stringContaining("ignoring 'addressed' verdict — inter-round diff is empty"),
    );
  });

  it('resolves addressed thread when prior rounds exist and inter-round diff is non-empty', async () => {
    // End-to-end happy path for the thread-resolution flow: memory enabled,
    // recap exposes a prior round with a SHA distinct from the current
    // commit, `fetchInterRoundDiff` returns a non-empty patch, and the LLM
    // reports `addressed`. The judge-level empty-diff override is not
    // engaged, so `resolveReviewThread` must fire for the addressed thread.
    // Guards against a regression that flips `interRoundDiffKnownEmpty` to
    // true for any non-empty diff.
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
      auto_review: true, auto_approve: false, exclude_paths: [], max_diff_lines: 10000,
      reviewers: [], instructions: '', review_level: 'auto',
      review_thresholds: { small: 200, medium: 800 },
      memory: { enabled: true, repo: 'owner/memory' },
    });
    jest.mocked(authModule.getMemoryToken).mockReturnValue('token123');
    jest.mocked(memoryModule.loadMemory).mockResolvedValue({
      learnings: [], suppressions: [], patterns: [],
    });
    seedPriorRounds(
      42, 'test-repo',
      [{ round: 1, commitSha: 'prior-sha', timestamp: '2025-01-01T00:00:00Z', findings: [] }],
      [{ title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'blocker' as const, status: 'open' as const, threadId: 'PRRT_abc' }],
      'previous context',
    );
    jest.mocked(ghUtils.fetchInterRoundDiff).mockResolvedValue(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
    );

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'ok', findings: [],
      highlights: [], reviewComplete: true,
      agentNames: ['general'],
      threadEvaluations: [
        { threadId: 'PRRT_abc', status: 'addressed', reason: 'Fixed in latest push' },
      ],
    });

    await callRunFullReview();

    expect(jest.mocked(ghUtils.fetchInterRoundDiff)).toHaveBeenCalledTimes(1);
    const runReviewArgs = jest.mocked(reviewModule.runReview).mock.calls[0];
    const passedInterRoundDiff = runReviewArgs[RUN_REVIEW_INTER_ROUND_DIFF_ARG];
    expect(passedInterRoundDiff).toBe(
      'diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new\n',
    );
    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_abc' },
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'Judge resolved: "Fixed in latest push" — thread PRRT_abc',
    );
  });

  it('resolves only threads with status addressed', async () => {
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
        { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'blocker' as const, status: 'open' as const, threadId: 'PRRT_abc' },
        { title: 'Bug B', file: 'src/app.ts', line: 2, severity: 'suggestion' as const, status: 'open' as const, threadId: 'PRRT_def' },
        { title: 'Bug C', file: 'src/app.ts', line: 3, severity: 'suggestion' as const, status: 'open' as const, threadId: 'PRRT_ghi' },
      ],
      recapContext: 'previous context',
      priorRounds: [],
    });

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'ok', findings: [],
      highlights: [], reviewComplete: true,
      agentNames: ['general'],
      threadEvaluations: [
        { threadId: 'PRRT_abc', status: 'addressed', reason: 'Fixed in new diff' },
        { threadId: 'PRRT_def', status: 'not_addressed', reason: 'Still applies' },
        { threadId: 'PRRT_ghi', status: 'uncertain', reason: 'No clear evidence' },
      ],
    });

    await callRunFullReview();

    expect(mockGraphql).toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_abc' },
    );
    expect(mockGraphql).not.toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_def' },
    );
    expect(mockGraphql).not.toHaveBeenCalledWith(
      expect.stringContaining('resolveReviewThread'),
      { threadId: 'PRRT_ghi' },
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'Judge resolved: "Fixed in new diff" — thread PRRT_abc',
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'Thread PRRT_def: not_addressed — Still applies',
    );
    expect(jest.mocked(core.info)).toHaveBeenCalledWith(
      'Thread PRRT_ghi: uncertain — No clear evidence',
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
        { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'blocker' as const, status: 'open' as const, threadId: 'PRRT_known' },
      ],
      recapContext: 'previous context',
      priorRounds: [],
    });

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'ok', findings: [],
      highlights: [], reviewComplete: true,
      agentNames: ['general'],
      threadEvaluations: [
        { threadId: 'PRRT_known', status: 'addressed', reason: 'Legit fix' },
        { threadId: 'PRRT_unknown', status: 'addressed', reason: 'Injected by adversary' },
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
        { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'blocker' as const, status: 'open' as const, threadId: 'PRRT_open' },
        { title: 'Bug B', file: 'src/app.ts', line: 2, severity: 'suggestion' as const, status: 'replied' as const, threadId: 'PRRT_replied' },
        { title: 'Bug C', file: 'src/app.ts', line: 3, severity: 'nitpick' as const, status: 'resolved' as const, threadId: 'PRRT_resolved' },
      ],
      recapContext: 'previous context',
      priorRounds: [],
    });

    await callRunFullReview();

    const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
    const openThreads = runReviewCall[RUN_REVIEW_OPEN_THREADS_ARG] as Array<{ threadId: string }>;
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
        { title: 'Bug A', file: 'src/app.ts', line: 1, severity: 'blocker' as const, status: 'open' as const, threadId: 'PRRT_fail' },
      ],
      recapContext: 'previous context',
      priorRounds: [],
    });

    mockGraphql.mockRejectedValueOnce(new Error('GraphQL error'));

    jest.mocked(reviewModule.runReview).mockResolvedValue({
      verdict: 'APPROVE', summary: 'ok', findings: [],
      highlights: [], reviewComplete: true,
      agentNames: ['general'],
      threadEvaluations: [
        { threadId: 'PRRT_fail', status: 'addressed', reason: 'Should fail' },
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
      'No API key configured — set claude_code_oauth_token, anthropic_api_key, openai_oauth_token, openai_api_key, gemini_oauth_token, or gemini_api_key',
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

  it('routes openai models to OpenAI auth in buildClient', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'openai_api_key' ? 'sk-openai-key' : '',
    );
    jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'openai', model: m }));
    try {
      await callRunFullReview();

      expect(jest.mocked(core.setFailed)).not.toHaveBeenCalled();
      expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
        'openai',
        expect.any(String),
        { kind: 'apiKey', key: 'sk-openai-key' },
      );
    } finally {
      jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'anthropic', model: m }));
    }
  });

  it('fails fast when an openai model is selected but only anthropic credentials are set', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'sk-anthropic' : '',
    );
    jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'openai', model: m }));
    try {
      await callRunFullReview();

      expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
        expect.stringContaining('Either openai_oauth_token or openai_api_key must be provided'),
      );
      expect(jest.mocked(reviewModule.runReview)).not.toHaveBeenCalled();
    } finally {
      jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'anthropic', model: m }));
    }
  });

  it('routes each stage to its own provider when planner/reviewer/judge models cross provider boundaries', async () => {
    // Mixed-provider scenario: planner on anthropic, reviewer on openai, judge on anthropic.
    // Both credential sets are set so each stage can resolve.
    jest.mocked(core.getInput).mockImplementation((name: string) => {
      if (name === 'anthropic_api_key') return 'sk-anthropic';
      if (name === 'openai_api_key') return 'sk-openai';
      return '';
    });
    jest.mocked(configModule.resolveModel).mockImplementation((_cfg, stage: string) => {
      if (stage === 'planner') return 'claude-sonnet-4-20250514';
      if (stage === 'reviewer') return 'gpt-4o';
      if (stage === 'judge') return 'claude-opus-4-7';
      return 'claude-sonnet-4-20250514'; // dedup
    });
    jest.mocked(parseModelSpec).mockImplementation((m: string) =>
      m.startsWith('gpt-') || /^o\d/.test(m)
        ? { provider: 'openai', model: m }
        : { provider: 'anthropic', model: m },
    );
    try {
      await callRunFullReview();

      expect(jest.mocked(core.setFailed)).not.toHaveBeenCalled();
      // Reviewer stage routed to OpenAI with apiKey auth.
      expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
        'openai', 'gpt-4o', { kind: 'apiKey', key: 'sk-openai' },
      );
      // Judge stage routed to Anthropic with apiKey auth.
      expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
        'anthropic', 'claude-opus-4-7', { kind: 'apiKey', key: 'sk-anthropic' },
      );
      // Planner stage routed to Anthropic.
      expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
        'anthropic', 'claude-sonnet-4-20250514', { kind: 'apiKey', key: 'sk-anthropic' },
      );
    } finally {
      jest.mocked(configModule.resolveModel).mockReturnValue('claude-sonnet-4-20250514');
      jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'anthropic', model: m }));
    }
  });

  it('proceeds when gemini_api_key is set and resolves auth via the gemini branch', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'gemini_api_key' ? 'gem-key' : '',
    );
    jest.mocked(configModule.resolveModel).mockReturnValue('gemini-3.1-flash-lite');
    jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'gemini', model: m }));
    try {
      await callRunFullReview();

      expect(jest.mocked(core.setFailed)).not.toHaveBeenCalled();
      expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
    } finally {
      jest.mocked(configModule.resolveModel).mockReturnValue('claude-sonnet-4-20250514');
      jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'anthropic', model: m }));
    }
  });

  it('proceeds when gemini_oauth_token is set', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'gemini_oauth_token' ? 'gem-tok' : '',
    );
    jest.mocked(configModule.resolveModel).mockReturnValue('gemini-3.1-flash-lite');
    jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'gemini', model: m }));
    try {
      await callRunFullReview();

      expect(jest.mocked(core.setFailed)).not.toHaveBeenCalled();
      expect(jest.mocked(ghUtils.postProgressComment)).toHaveBeenCalled();
    } finally {
      jest.mocked(configModule.resolveModel).mockReturnValue('claude-sonnet-4-20250514');
      jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'anthropic', model: m }));
    }
  });


  it('fails with Invalid model config when only anthropic_api_key is set but model is gemini', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'sk-test' : '',
    );
    jest.mocked(configModule.resolveModel).mockReturnValue('gemini-3.1-flash-lite');
    jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'gemini', model: m }));
    try {
      await callRunFullReview();

      expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
        expect.stringContaining('Invalid model config'),
      );
    } finally {
      jest.mocked(configModule.resolveModel).mockReturnValue('claude-sonnet-4-20250514');
      jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'anthropic', model: m }));
    }
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

  describe('convergence round-count cap', () => {
    function memoryEnabledConfig(maxAutoRounds = 5): ReturnType<typeof configModule.loadConfig> {
      return {
        auto_review: true, auto_approve: false, max_diff_lines: 5000,
        exclude_paths: [], nit_handling: 'issues',
        reviewers: [], instructions: '', review_level: 'auto',
        review_thresholds: { small: 200, medium: 800 },
        memory: { enabled: true, repo: 'owner/memory' },
        convergence: {
          max_auto_rounds: maxAutoRounds,
          test_path_patterns: ['**/*.test.*'],
          suppress_resolved_threads: true,
        },
      };
    }

    function priorRounds(n: number): LegacyHandoverRoundFixture[] {
      return Array.from({ length: n }, (_, i) => ({
        round: i + 1,
        commitSha: `sha${i + 1}`,
        timestamp: '2025-01-01T00:00:00Z',
        findings: [],
      }));
    }

    const reviewableFile = {
      path: 'src/app.ts', changeType: 'modified' as const,
      hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
    };

    beforeEach(() => {
      jest.mocked(authModule.getMemoryToken).mockReturnValue('mem-token');
      jest.mocked(memoryModule.loadMemory).mockResolvedValue({
        learnings: [], suppressions: [], patterns: [],
      });
      jest.mocked(diffModule.parsePRDiff).mockReturnValue({
        files: [reviewableFile], totalAdditions: 5, totalDeletions: 5,
      });
      jest.mocked(diffModule.filterFiles).mockReturnValue([reviewableFile]);
    });

    it('runs review normally when prior rounds are below the cap', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(memoryEnabledConfig(5));
      seedPriorRounds(42, 'test-repo', priorRounds(4));

      await callRunFullReview();

      expect(jest.mocked(reviewModule.runReview)).toHaveBeenCalled();
    });

    it('skips review and posts notice when prior rounds reach the cap on auto trigger', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(memoryEnabledConfig(5));
      seedPriorRounds(42, 'test-repo', priorRounds(5));

      await callRunFullReview();

      expect(jest.mocked(reviewModule.runReview)).not.toHaveBeenCalled();
      expect(mockOctokitInstance.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'test-owner',
          repo: 'test-repo',
          issue_number: 42,
          body: expect.stringContaining('Automatic review is paused'),
        }),
      );
      const capCall = jest.mocked(mockOctokitInstance.rest.issues.createComment).mock.calls
        .find(([args]) => typeof args.body === 'string' && args.body.includes('Automatic review is paused'));
      expect(capCall).toBeDefined();
      const capBody = capCall![0].body as string;
      expect(capBody).toContain(FORCE_REVIEW_MARKER);
      expect(capBody).toContain('- [ ] Force review');
    });

    it('bypasses the cap when forceReview is true', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(memoryEnabledConfig(5));
      seedPriorRounds(42, 'test-repo', priorRounds(5));

      await runFullReview(
        baseArgs.owner, baseArgs.repo, baseArgs.prNumber,
        baseArgs.commitSha, baseArgs.baseRef, baseArgs.prContext,
        undefined, true,
      );

      expect(jest.mocked(reviewModule.runReview)).toHaveBeenCalled();
    });

    it('does nothing when max_auto_rounds is 0 (cap disabled)', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(memoryEnabledConfig(0));
      seedPriorRounds(42, 'test-repo', priorRounds(20));

      await callRunFullReview();

      expect(jest.mocked(reviewModule.runReview)).toHaveBeenCalled();
    });

    it('cap never fires when memory is disabled and no prior rounds in recap', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue({
        ...memoryEnabledConfig(1),
        memory: { enabled: false, repo: '' },
      });

      await callRunFullReview();

      // With memory disabled and no prior rounds from recap, priorRoundCount
      // stays 0 and the cap cannot trigger even with max_auto_rounds: 1.
      expect(jest.mocked(reviewModule.runReview)).toHaveBeenCalled();
    });

    it('reproduces the round-9 nit-spam scenario by posting cap notice', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(memoryEnabledConfig(5));
      seedPriorRounds(42, 'test-repo', priorRounds(5));
      const testFile = {
        path: 'src/foo.test.ts', changeType: 'modified' as const,
        hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: 'code' }],
      };
      jest.mocked(diffModule.parsePRDiff).mockReturnValue({
        files: [testFile], totalAdditions: 5, totalDeletions: 5,
      });
      jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

      await callRunFullReview();

      expect(jest.mocked(reviewModule.runReview)).not.toHaveBeenCalled();
      expect(mockOctokitInstance.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('Automatic review is paused') }),
      );
      const capCall = jest.mocked(mockOctokitInstance.rest.issues.createComment).mock.calls
        .find(([args]) => typeof args.body === 'string' && args.body.includes('Automatic review is paused'));
      expect(capCall).toBeDefined();
      const capBody = capCall![0].body as string;
      expect(capBody).toContain(FORCE_REVIEW_MARKER);
      expect(capBody).toContain('- [ ] Force review');
    });

    it('runs review normally when below cap (test-nit suppression path exercises review.ts, not index.ts)', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(memoryEnabledConfig(5));
      seedPriorRounds(42, 'test-repo', priorRounds(1));

      await callRunFullReview();

      // Cap has not triggered (1 prior round < 5 max). runReview runs and test-nit
      // suppression is exercised inside review.ts (tested in review.test.ts).
      expect(jest.mocked(reviewModule.runReview)).toHaveBeenCalled();
    });

    it('cap fires on the 6th push when recap aggregates 5 PR-embedded context blocks', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(memoryEnabledConfig(5));
      jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
        previousFindings: [],
        recapContext: '',
        priorRounds: priorRounds(5).map(roundContextFromLegacy),
      });

      await callRunFullReview();

      expect(jest.mocked(reviewModule.runReview)).not.toHaveBeenCalled();
      expect(mockOctokitInstance.rest.issues.createComment).toHaveBeenCalledWith(
        expect.objectContaining({ body: expect.stringContaining('Automatic review is paused') }),
      );
    });

    it('proceeds to review when below cap (recap has 4 of 5 rounds)', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(memoryEnabledConfig(5));
      jest.mocked(recapModule.fetchRecapState).mockResolvedValue({
        previousFindings: [],
        recapContext: '',
        priorRounds: priorRounds(4).map(roundContextFromLegacy),
      });

      await callRunFullReview();

      expect(jest.mocked(reviewModule.runReview)).toHaveBeenCalled();
    });
  });

  it('calls setFailed when parseModelSpec throws for an unknown model', async () => {
    jest.mocked(parseModelSpec).mockImplementationOnce(() => {
      throw new Error('Unknown model "x"');
    });

    await callRunFullReview();

    expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
      expect.stringContaining('Unknown model "x"'),
    );
    expect(jest.mocked(reviewModule.runReview)).not.toHaveBeenCalled();
  });

  describe('per-agent model overrides', () => {
    function configWithAgents(agents: Record<string, string>): ReviewConfig {
      return {
        auto_review: true, auto_approve: false, max_diff_lines: 5000,
        exclude_paths: [], nit_handling: 'issues',
        reviewers: [], instructions: '', review_level: 'auto',
        review_thresholds: { small: 200, medium: 800 },
        memory: { enabled: false, repo: '' },
        models: { reviewer: 'claude-sonnet-4-6', agents },
      };
    }

    it('logs per-agent model overrides when configured', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(
        configWithAgents({ 'Security & Safety': 'claude-opus-4-7' }),
      );

      await callRunFullReview();

      expect(jest.mocked(core.info)).toHaveBeenCalledWith(
        expect.stringContaining('Per-agent model overrides — Security & Safety=claude-opus-4-7'),
      );
    });

    it('does not log per-agent overrides when models.agents is absent or empty', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(configWithAgents({}));

      await callRunFullReview();

      const infoCalls = jest.mocked(core.info).mock.calls.map(c => c[0]);
      expect(infoCalls.some((m: string) => m?.includes('Per-agent model overrides'))).toBe(false);
    });

    it('eagerly constructs per-agent clients and surfaces failures via setFailed', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(
        configWithAgents({ 'Security & Safety': 'bogus-model' }),
      );
      jest.mocked(parseModelSpec).mockImplementation((m: string) => {
        if (m === 'bogus-model') throw new Error('Unsupported provider for "bogus-model"');
        return { provider: 'anthropic', model: m };
      });

      await callRunFullReview();

      expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
        expect.stringContaining('Unsupported provider'),
      );
      expect(jest.mocked(reviewModule.runReview)).not.toHaveBeenCalled();
    });

    it('passes a reviewerForAgent callback that returns the override client for overridden agents', async () => {
      const overrideClient = { sendMessage: jest.fn() };
      jest.mocked(createLLMClient).mockImplementation((_p: unknown, model: unknown) =>
        model === 'claude-opus-4-7' ? overrideClient : { sendMessage: jest.fn() },
      );
      jest.mocked(configModule.loadConfig).mockReturnValue(
        configWithAgents({ 'Security & Safety': 'claude-opus-4-7' }),
      );
      const testFile = {
        path: 'src/app.ts', changeType: 'modified' as const,
        hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: '' }],
      };
      jest.mocked(diffModule.parsePRDiff).mockReturnValue({
        files: [testFile], totalAdditions: 10, totalDeletions: 5,
      });
      jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

      await callRunFullReview();

      const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
      expect(runReviewCall).toBeDefined();
      const clientsArg = runReviewCall[0] as { reviewerForAgent: (n: string) => unknown };
      expect(clientsArg.reviewerForAgent('Security & Safety')).toBe(overrideClient);
    });

    it('reviewerForAgent falls back to the default reviewer client when no override is configured', async () => {
      const defaultClient = { sendMessage: jest.fn(), tag: 'default' };
      jest.mocked(createLLMClient).mockReturnValue(defaultClient);
      jest.mocked(configModule.loadConfig).mockReturnValue(configWithAgents({}));
      const testFile = {
        path: 'src/app.ts', changeType: 'modified' as const,
        hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: '' }],
      };
      jest.mocked(diffModule.parsePRDiff).mockReturnValue({
        files: [testFile], totalAdditions: 10, totalDeletions: 5,
      });
      jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

      await callRunFullReview();

      const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
      const clientsArg = runReviewCall[0] as { reviewerForAgent: (n: string) => unknown; reviewer: unknown };
      expect(clientsArg.reviewerForAgent('Architecture & Design')).toBe(clientsArg.reviewer);
    });

    it('reviewerForAgent caches per-agent clients across repeated invocations', async () => {
      jest.mocked(configModule.loadConfig).mockReturnValue(
        configWithAgents({ 'Security & Safety': 'claude-opus-4-7' }),
      );
      const testFile = {
        path: 'src/app.ts', changeType: 'modified' as const,
        hunks: [{ oldStart: 1, oldLines: 5, newStart: 1, newLines: 10, content: '' }],
      };
      jest.mocked(diffModule.parsePRDiff).mockReturnValue({
        files: [testFile], totalAdditions: 10, totalDeletions: 5,
      });
      jest.mocked(diffModule.filterFiles).mockReturnValue([testFile]);

      await callRunFullReview();

      const callsBefore = jest.mocked(createLLMClient).mock.calls.length;
      const runReviewCall = jest.mocked(reviewModule.runReview).mock.calls[0];
      const clientsArg = runReviewCall[0] as { reviewerForAgent: (n: string) => unknown };
      const a = clientsArg.reviewerForAgent('Security & Safety');
      const b = clientsArg.reviewerForAgent('Security & Safety');
      expect(a).toBe(b);
      expect(jest.mocked(createLLMClient).mock.calls.length).toBe(callsBefore);
    });
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

  it('calls setFailed when no auth tokens are configured', async () => {
    jest.mocked(core.getInput).mockReturnValue('');

    await handleInteraction();

    expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
      'No API key configured — set claude_code_oauth_token, anthropic_api_key, openai_oauth_token, openai_api_key, gemini_oauth_token, or gemini_api_key',
    );
    expect(jest.mocked(interaction.handlePRComment)).not.toHaveBeenCalled();
  });

  it('returns early when no issue number in payload', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'claude_code_oauth_token' ? 'oauth-tok' : '',
    );
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
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'claude_code_oauth_token' ? 'oauth-tok' : '',
    );
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help' },
        issue: { number: 7, pull_request: { url: 'https://...' } },
      },
    });

    await handleInteraction();

    expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
      'anthropic',
      expect.any(String),
      { kind: 'oauth', token: 'oauth-tok' },
    );
    expect(jest.mocked(interaction.handlePRComment)).toHaveBeenCalledWith(
      expect.anything(),  // octokit
      expect.anything(),  // claude client
      'test-owner', 'test-repo', 7,
      undefined,          // memoryConfig (memory not enabled)
      undefined,          // memoryToken
      expect.anything(),  // config
    );
  });

  it('calls setFailed when parseModelSpec throws for an unknown model', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'claude_code_oauth_token' ? 'oauth-tok' : '',
    );
    jest.mocked(parseModelSpec).mockImplementationOnce(() => {
      throw new Error('Unknown model "gpt-4o"');
    });
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help' },
        issue: { number: 7, pull_request: { url: 'https://...' } },
      },
    });

    await handleInteraction();

    expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
      expect.stringContaining('Unknown model "gpt-4o"'),
    );
    expect(jest.mocked(interaction.handlePRComment)).not.toHaveBeenCalled();
  });

  it('uses apiKey auth when only anthropic_api_key is set', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'sk-api-key' : '',
    );
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help' },
        issue: { number: 7, pull_request: { url: 'https://...' } },
      },
    });

    await handleInteraction();

    expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
      'anthropic',
      expect.any(String),
      { kind: 'apiKey', key: 'sk-api-key' },
    );
  });

  it('routes openai-prefixed models to OpenAI auth dispatch', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'openai_api_key' ? 'sk-openai-key' : '',
    );
    jest.mocked(parseModelSpec).mockImplementationOnce((m: string) => ({ provider: 'openai', model: m }));
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help' },
        issue: { number: 7, pull_request: { url: 'https://...' } },
      },
    });

    await handleInteraction();

    expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
      'openai',
      expect.any(String),
      { kind: 'apiKey', key: 'sk-openai-key' },
    );
  });

  it('uses oauth auth when openai_oauth_token is set', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'openai_oauth_token' ? 'codex-oauth-tok' : '',
    );
    jest.mocked(parseModelSpec).mockImplementationOnce((m: string) => ({ provider: 'openai', model: m }));
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help' },
        issue: { number: 7, pull_request: { url: 'https://...' } },
      },
    });

    await handleInteraction();

    expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
      'openai',
      expect.any(String),
      { kind: 'oauth', token: 'codex-oauth-tok' },
    );
  });

  it('sets failed when openai model is selected but only anthropic credentials are configured', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'sk-anthropic' : '',
    );
    jest.mocked(parseModelSpec).mockImplementationOnce((m: string) => ({ provider: 'openai', model: m }));
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'created',
        comment: { body: '@manki help' },
        issue: { number: 7, pull_request: { url: 'https://...' } },
      },
    });

    await handleInteraction();

    expect(jest.mocked(core.setFailed)).toHaveBeenCalledWith(
      expect.stringContaining('Either openai_oauth_token or openai_api_key must be provided'),
    );
    expect(jest.mocked(createLLMClient)).not.toHaveBeenCalled();
  });

  it('proceeds when gemini_api_key is set and routes via gemini provider', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'gemini_api_key' ? 'gem-key' : '',
    );
    jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'gemini', model: m }));
    try {
      setContext({
        eventName: 'issue_comment',
        payload: {
          action: 'created',
          comment: { body: '@manki help' },
          issue: { number: 7, pull_request: { url: 'https://...' } },
        },
      });

      await handleInteraction();

      expect(jest.mocked(core.setFailed)).not.toHaveBeenCalled();
      expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
        'gemini',
        expect.any(String),
        { kind: 'apiKey', key: 'gem-key' },
      );
    } finally {
      jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'anthropic', model: m }));
    }
  });

  it('proceeds when gemini_oauth_token is set and routes via gemini provider', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'gemini_oauth_token' ? 'gem-tok' : '',
    );
    jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'gemini', model: m }));
    try {
      setContext({
        eventName: 'issue_comment',
        payload: {
          action: 'created',
          comment: { body: '@manki help' },
          issue: { number: 7, pull_request: { url: 'https://...' } },
        },
      });

      await handleInteraction();

      expect(jest.mocked(core.setFailed)).not.toHaveBeenCalled();
      expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
        'gemini',
        expect.any(String),
        { kind: 'oauth', token: 'gem-tok' },
      );
    } finally {
      jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'anthropic', model: m }));
    }
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
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'claude_code_oauth_token' ? 'oauth-tok' : '',
    );
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

    expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
      'anthropic',
      expect.any(String),
      { kind: 'oauth', token: 'oauth-tok' },
    );
    expect(jest.mocked(interaction.handleReviewCommentReply)).toHaveBeenCalled();
    expect(jest.mocked(stateModule.checkAndAutoApprove)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 8,
    );
  });

  it('uses apiKey auth when only anthropic_api_key is set', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'anthropic_api_key' ? 'sk-api-key' : '',
    );
    jest.mocked(interaction.hasBotMention).mockReturnValue(true);

    setContext({
      eventName: 'pull_request_review_comment',
      payload: {
        action: 'created',
        comment: {
          body: '@manki help',
          user: { type: 'User' },
        },
        pull_request: { number: 9, base: { ref: 'main' } },
      },
    });

    await handleReviewCommentInteraction();

    expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
      'anthropic',
      expect.any(String),
      { kind: 'apiKey', key: 'sk-api-key' },
    );
  });

  it('proceeds when gemini_api_key is set and routes via gemini provider', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'gemini_api_key' ? 'gem-key' : '',
    );
    jest.mocked(interaction.hasBotMention).mockReturnValue(true);
    jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'gemini', model: m }));
    try {
      setContext({
        eventName: 'pull_request_review_comment',
        payload: {
          action: 'created',
          comment: {
            body: '@manki help',
            user: { type: 'User' },
          },
          pull_request: { number: 9, base: { ref: 'main' } },
        },
      });

      await handleReviewCommentInteraction();

      expect(jest.mocked(core.setFailed)).not.toHaveBeenCalled();
      expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
        'gemini',
        expect.any(String),
        { kind: 'apiKey', key: 'gem-key' },
      );
    } finally {
      jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'anthropic', model: m }));
    }
  });

  it('proceeds when gemini_oauth_token is set and routes via gemini provider', async () => {
    jest.mocked(core.getInput).mockImplementation((name: string) =>
      name === 'gemini_oauth_token' ? 'gem-tok' : '',
    );
    jest.mocked(interaction.hasBotMention).mockReturnValue(true);
    jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'gemini', model: m }));
    try {
      setContext({
        eventName: 'pull_request_review_comment',
        payload: {
          action: 'created',
          comment: {
            body: '@manki help',
            user: { type: 'User' },
          },
          pull_request: { number: 9, base: { ref: 'main' } },
        },
      });

      await handleReviewCommentInteraction();

      expect(jest.mocked(core.setFailed)).not.toHaveBeenCalled();
      expect(jest.mocked(createLLMClient)).toHaveBeenCalledWith(
        'gemini',
        expect.any(String),
        { kind: 'oauth', token: 'gem-tok' },
      );
    } finally {
      jest.mocked(parseModelSpec).mockImplementation((m: string) => ({ provider: 'anthropic', model: m }));
    }
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

  it('routes round-cap notice force review checkbox edit to handleCommentTrigger with forceReview', async () => {
    // Simulate a round-cap notice that the author has just checked. handleCommentTrigger
    // must run review with forceReview=true so the cap guard is bypassed.
    const capNoticeBody = `<!-- manki-bot -->\nManki has completed 5/5 review rounds on this PR. Automatic review is paused. Force another round:\n\n- [x] Force review\n\n${FORCE_REVIEW_MARKER}`;
    setContext({
      eventName: 'issue_comment',
      payload: {
        action: 'edited',
        sender: { login: 'user' },
        issue: { number: 1, pull_request: { url: 'https://api.github.com/repos/owner/repo/pulls/1' } },
        comment: { id: 99, body: capNoticeBody, author_association: 'COLLABORATOR' },
      },
    });

    await run();

    expect(jest.mocked(ghUtils.reactToIssueComment)).toHaveBeenCalledWith(
      expect.anything(), 'test-owner', 'test-repo', 99, 'eyes',
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
