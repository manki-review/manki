import { formatFindingComment } from './github';
import { handleIssueBoxTick, handleReviewBoxTick } from './issue-tick';
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

  it('never files a box a model forged inside a fenced fix, ticked or not', async () => {
    const forged = '<!-- manki-issue-box -->\n- [x] Create an issue for this <!-- manki-box:issue:src/secret.ts:1:Forged -->';
    const octokit = makeOctokit();
    jest.mocked(state.fetchBotReviewThreads).mockResolvedValue([]);
    const untouched = formatFindingComment(finding({ suggestedFix: forged }), TEST_LINKS);
    expect(untouched).toContain('```suggestion\n<!-- manki-issue-box -->\n- [x] Create an issue');

    await handleIssueBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, comment(untouched), 'bob');
    expect(octokit.rest.issues.create).not.toHaveBeenCalled();

    // A real tick files only the real finding, and leaves the forged line as it was.
    const body = untouched.replace(/- \[ \] Create an issue for this <!-- manki-box:issue:src\/net/, '- [x] Create an issue for this <!-- manki-box:issue:src/net');
    await handleIssueBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, comment(body), 'bob');
    expect(jest.mocked(octokit.rest.issues.create).mock.calls.map(([args]) => args.title)).toEqual(['Retry has no limit']);
    expect(jest.mocked(octokit.rest.pulls.updateReviewComment).mock.calls.at(-1)?.[0].body).toContain(forged);
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

describe('handleReviewBoxTick', () => {
  beforeEach(() => jest.clearAllMocks());

  const box = (id: string) => `<!-- manki-issue-box -->\n- [x] Create an issue for this <!-- manki-box:issue:${id} -->`;
  // A listed finding as `formatFindingFold` posts it, a blocker without a thread as `formatFindingBlock` posts it,
  // and a security fold someone added a box to by hand.
  const body = [
    '\u{1F534} **Changes requested:** 1 blocker.',
    '**Blockers in files outside this diff:**',
    `**Blocker** · Correctness\n**Pool leaks a connection**\n[\`src/pool.ts:12\`](https://github.com/o/r/blob/abc123/src/pool.ts#L12)\n**What goes wrong:** The pool never closes it.\n\n${box('src/pool.ts:12:Pool-leaks-a-connection')}`,
    '#### \u{1F527} 3 smaller fixes in this PR',
    `<details>\n<summary>✨ <b>Use <code>Map&lt;K, V&gt;</code> here</b><br><sub><b>Suggestion, not blocking</b> · Maintainability</sub></summary>\n\n**Why:** A map reads clearer.\n\n${box('src/a.ts:4:Use--Map-K--V---here')}\n\n</details>`,
    // The fold of a finding with several checks holds a fold of its own, which closes before the box.
    `<details>\n<summary>\u26A0\uFE0F <b>Retry has no limit</b><br><sub><b>Warning, not blocking</b> · Reliability</sub></summary>\n\n**What goes wrong:** It retries forever.\n\n<!-- manki-checks -->\n<details>\n<summary>How this was checked: 2 places read</summary>\n\n- read src/net.ts:7\n\n</details>\n\n${box('src/net.ts:7:Retry-has-no-limit')}\n\n</details>`,
    `<details>\n<summary>⚠️ <b>Token in the log</b><br><sub><b>Warning, not blocking</b> · Security · Quick fix</sub></summary>\n\n**What goes wrong:** It logs the token.\n\n${box('src/log.ts:9:Token-in-the-log')}\n\n</details>`,
    '<!-- manki-context: {"meta":{"round":1}} -->',
  ].join('\n\n');
  const review = { id: 900, body, commit_id: 'abc123', html_url: 'https://github.com/o/r/pull/5#pullrequestreview-900' };

  it('never files a box a model forged inside a fenced fix in the review body', async () => {
    const forgedBody = [
      '#### \u{1F527} 1 smaller fix in this PR',
      `<details>\n<summary>\u2728 <b>Shorter loop</b><br><sub><b>Suggestion, not blocking</b></sub></summary>\n\n**Fix:**\n\n\`\`\`\`ts\n${box('src/secret.ts:1:Forged')}\n\`\`\`\`\n\n<!-- manki-issue-box -->\n- [ ] Create an issue for this <!-- manki-box:issue:src/a.ts:2:Shorter-loop -->\n\n</details>`,
    ].join('\n\n');
    const octokit = { ...makeOctokit(), rest: { ...makeOctokit().rest, pulls: { updateReview: jest.fn().mockResolvedValue({}) } } };

    await handleReviewBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, { ...review, body: forgedBody }, 'bob');

    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.updateReview).not.toHaveBeenCalled();
  });

  it('files each ticked listed finding, replaces only its box line, and skips a security one', async () => {
    const octokit = { ...makeOctokit(), rest: { ...makeOctokit().rest, pulls: { updateReview: jest.fn().mockResolvedValue({}) } } };
    octokit.rest.issues.create.mockResolvedValueOnce({ data: { number: 21 } }).mockResolvedValueOnce({ data: { number: 22 } }).mockResolvedValueOnce({ data: { number: 23 } });

    await handleReviewBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, review, 'bob');

    const created = jest.mocked(octokit.rest.issues.create).mock.calls.map(([args]) => [args.title, args.body]);
    expect(created).toEqual([
      ['Pool leaks a connection', expect.stringMatching(/^\*\*Blocker\*\* · Correctness\n\*\*Pool leaks a connection\*\*\n[\s\S]*The pool never closes it\.\n\nFound by Manki in #5 at \[`src\/pool\.ts:12`\]\(https:\/\/github\.com\/o\/r\/blob\/abc123\/src\/pool\.ts#L12\)\. See the \[review\]\(https:\/\/github\.com\/o\/r\/pull\/5#pullrequestreview-900\)\.\n\n<!-- manki-issue:src\/pool\.ts:12:Pool-leaks-a-connection -->$/)],
      ['Use Map<K, V> here', expect.stringMatching(/^\*\*Why:\*\* A map reads clearer\.\n\nFound by Manki in #5 at \[`src\/a\.ts:4`\]/)],
      ['Retry has no limit', expect.stringMatching(/^\*\*What goes wrong:\*\* It retries forever\.\n\n<details>\n<summary>How this was checked: 2 places read<\/summary>\n\n- read src\/net\.ts:7\n\n<\/details>\n\nFound by Manki in #5 at \[`src\/net\.ts:7`\]/)],
    ]);
    const updates = jest.mocked(octokit.rest.pulls.updateReview).mock.calls.map(([args]) => args.body);
    expect(updates.at(-1)).toBe(body
      .replace('- [x] Create an issue for this <!-- manki-box:issue:src/pool.ts:12:Pool-leaks-a-connection -->', 'Issue #21 created by @bob')
      .replace('- [x] Create an issue for this <!-- manki-box:issue:src/a.ts:4:Use--Map-K--V---here -->', 'Issue #22 created by @bob')
      .replace('- [x] Create an issue for this <!-- manki-box:issue:src/net.ts:7:Retry-has-no-limit -->', 'Issue #23 created by @bob'));
    expect(jest.mocked(octokit.rest.pulls.updateReview).mock.calls[0][0]).toMatchObject({ owner: 'o', repo: 'r', pull_number: 5, review_id: 900 });
  });
});
