import { formatFindingComment } from './github';
import { handleIssueBoxTick } from './issue-tick';
import * as state from './state';
import { Finding } from './types';
import { TEST_BOT, TEST_LINKS } from './test-utils';

jest.mock('@actions/core', () => ({ info: jest.fn(), warning: jest.fn(), debug: jest.fn() }));

jest.mock('@actions/github', () => ({ context: { serverUrl: 'https://github.com' } }));

jest.mock('./state', () => ({
  fetchBotReviewThreads: jest.fn(),
  replyToReviewThread: jest.fn().mockResolvedValue(undefined),
  resolveReviewThread: jest.fn().mockResolvedValue(undefined),
}));

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  severity: 'warning', title: 'Retry has no limit', file: 'src/net.ts', line: 7, description: 'It retries forever.', reviewers: ['r'], ...overrides,
});

/** Manki's comment for `f`, with its issue box ticked as GitHub ticks it. */
const ticked = (f: Finding): string => formatFindingComment(f, TEST_LINKS).replace('- [ ] Create an issue', '- [x] Create an issue');

function makeOctokit(filed: Array<{ number: number; body: string; pull_request?: object }> = []) {
  return {
    paginate: jest.fn().mockResolvedValue(filed),
    rest: {
      issues: { listForRepo: jest.fn(), create: jest.fn().mockResolvedValue({ data: { number: 12 } }) },
      pulls: { updateReviewComment: jest.fn().mockResolvedValue({}) },
    },
  };
}

const comment = (body: string) => ({
  id: 501, body, path: 'src/net.ts', original_commit_id: 'abc123', original_line: 7, html_url: 'https://github.com/o/r/pull/5#discussion_r501',
});

describe('handleIssueBoxTick', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['a warning thread is resolved', false, [['PRRT_1', 'WONT_FIX']]],
    ['a blocker thread stays open', true, []],
  ])('files the finding once, links it in place of the box and replies, and %s', async (_case, isBlocking, resolved) => {
    const octokit = makeOctokit();
    const body = ticked(finding());
    jest.mocked(state.fetchBotReviewThreads).mockResolvedValue([{ id: 'PRRT_1', rootCommentId: 501, isResolved: false, isBlocking, findingTitle: 'x' }]);

    await handleIssueBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, comment(body), 'bob');

    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.issues.listForRepo, { owner: 'o', repo: 'r', creator: 'manki-review[bot]', state: 'open', per_page: 100 });
    // The issue holds the finding as posted, without the box or Manki's hidden markers.
    expect(octokit.rest.issues.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', title: 'Retry has no limit' }));
    const issue: string = jest.mocked(octokit.rest.issues.create).mock.calls[0][0].body;
    expect(issue).toMatch(/^⚠️ \*\*Warning\*\*[\s\S]*\*\*What goes wrong:\*\* It retries forever\.[\s\S]*\n\nFound by Manki in #5 at \[`src\/net\.ts:7`\]\(https:\/\/github\.com\/o\/r\/blob\/abc123\/src\/net\.ts#L7\)\. See the \[review thread\]\(https:\/\/github\.com\/o\/r\/pull\/5#discussion_r501\)\.\n\n<!-- manki-issue:src\/net\.ts:7:Retry-has-no-limit -->$/);
    expect(issue).not.toMatch(/manki-checks|manki-box|manki-finding|Create an issue/);
    // Only the box line changes. The finding and its hidden data stay as they were.
    const expected = body.replace(/- \[x\] Create an issue for this <!-- manki-box:issue:[^\n]* -->/, 'Issue #12 created by @bob');
    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 501, body: expected });
    expect(expected).toContain('<!-- manki-finding:');
    expect(jest.mocked(state.replyToReviewThread).mock.calls).toEqual([[octokit, 'PRRT_1', 'Agreed. Filed as #12 for later work.']]);
    expect(jest.mocked(state.resolveReviewThread).mock.calls).toEqual(resolved.map(([id, reason]) => [octokit, id, reason]));
  });

  it('links the finding\'s own line when the comment sits on another line', async () => {
    const octokit = makeOctokit();
    jest.mocked(state.fetchBotReviewThreads).mockResolvedValue([]);

    await handleIssueBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, { ...comment(ticked(finding())), original_line: 1 }, 'bob');

    expect(jest.mocked(octokit.rest.issues.create).mock.calls[0][0].body).toContain('[`src/net.ts:7`](https://github.com/o/r/blob/abc123/src/net.ts#L7)');
  });

  it('clears the box, says why in the thread and leaves the thread open when filing fails', async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.create.mockRejectedValue(new Error('Resource not accessible by integration'));
    jest.mocked(state.fetchBotReviewThreads).mockResolvedValue([{ id: 'PRRT_1', rootCommentId: 501, isResolved: false, isBlocking: false, findingTitle: 'x' }]);
    const body = ticked(finding());

    await handleIssueBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, comment(body), 'bob');

    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 501, body: formatFindingComment(finding(), TEST_LINKS) });
    expect(jest.mocked(state.replyToReviewThread).mock.calls).toEqual([[octokit, 'PRRT_1', 'Could not file an issue for this finding: Error: Resource not accessible by integration. Tick the box again to retry.']]);
    expect(state.resolveReviewThread).not.toHaveBeenCalled();
  });

  it('links the issue Manki already filed for the finding instead of filing another', async () => {
    const octokit = makeOctokit([
      { number: 4, body: 'A pull request <!-- manki-issue:src/net.ts:7:Retry-has-no-limit -->', pull_request: {} },
      { number: 9, body: 'Old.\n\n<!-- manki-issue:src/net.ts:7:Retry-has-no-limit -->' },
    ]);
    jest.mocked(state.fetchBotReviewThreads).mockResolvedValue([{ id: 'PRRT_1', rootCommentId: 501, isResolved: false, isBlocking: false, findingTitle: 'x' }]);

    await handleIssueBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, comment(ticked(finding())), 'bob');

    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
    expect(jest.mocked(octokit.rest.pulls.updateReviewComment).mock.calls[0][0].body).toContain('\nIssue #9 already tracks this, linked by @bob\n');
    expect(jest.mocked(state.replyToReviewThread).mock.calls).toEqual([[octokit, 'PRRT_1', 'Agreed. Filed as #9 for later work.']]);
  });

  it.each([
    ['an unticked box', formatFindingComment(finding(), TEST_LINKS)],
    ['a box someone added to a security finding', `${ticked(finding())}`.replace('"flaggedBy"', '"tags":["security"],"flaggedBy"')],
  ])('files nothing for %s', async (_case, body) => {
    const octokit = makeOctokit();

    await handleIssueBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, comment(body), 'bob');

    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.updateReviewComment).not.toHaveBeenCalled();
    expect(state.replyToReviewThread).not.toHaveBeenCalled();
  });
});
