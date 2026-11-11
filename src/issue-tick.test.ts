import { formatFindingBlock, formatFindingComment } from './github';
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

/** A client whose review comment and review hold the body each update wrote, or the one `seed` set. */
function makeOctokit(filed: Array<{ number: number; body: string; pull_request?: object }> = []) {
  const held = { body: '' };
  const write = jest.fn(async ({ body }: { body: string }) => {
    held.body = body;
    return {};
  });
  return {
    seed: (body: string) => {
      held.body = body;
    },
    paginate: jest.fn().mockResolvedValue(filed),
    rest: {
      issues: { listForRepo: jest.fn(), create: jest.fn().mockResolvedValue({ data: { number: 12 } }), createComment: jest.fn().mockResolvedValue({}) },
      pulls: {
        getReviewComment: jest.fn(async () => ({ data: { body: held.body } })),
        updateReviewComment: write,
        getReview: jest.fn(async () => ({ data: { body: held.body } })),
        updateReview: write,
      },
    },
  };
}

type TestOctokit = ReturnType<typeof makeOctokit>;

/** Runs a tick of Manki's `ticked` comment. */
async function tick(octokit: TestOctokit, ticked: ReturnType<typeof comment>): Promise<void> {
  octokit.seed(ticked.body);
  await handleIssueBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, ticked, 'bob');
}

/** Runs a tick of Manki's `ticked` review. */
async function tickReview(octokit: TestOctokit, ticked: { id: number; body: string; commit_id: string; html_url: string }): Promise<void> {
  octokit.seed(ticked.body);
  await handleReviewBoxTick(octokit as never, TEST_BOT, 'o', 'r', 5, ticked, 'bob');
}

const comment = (body: string) => ({
  id: 501, body, path: 'src/net.ts', original_commit_id: 'abc123', original_line: 7, html_url: 'https://github.com/o/r/pull/5#discussion_r501',
});

describe('handleIssueBoxTick', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['a warning thread is resolved', { isBlocking: false }, [['PRRT_1', 'WONT_FIX']]],
    ['a blocker thread stays open', { isBlocking: true }, []],
    ['a security thread below a blocker stays open', { isBlocking: false, isSecurity: true }, []],
  ])('files the finding once, links it in place of the box and replies, and %s', async (_case, grade, resolved) => {
    const octokit = makeOctokit();
    const body = ticked(finding());
    jest.mocked(state.fetchBotReviewThreads).mockResolvedValue([{ id: 'PRRT_1', rootCommentId: 501, isResolved: false, ...grade, findingTitle: 'x' }]);

    await tick(octokit, comment(body));

    expect(octokit.paginate).toHaveBeenCalledWith(octokit.rest.issues.listForRepo, { owner: 'o', repo: 'r', creator: 'manki-review[bot]', state: 'open', per_page: 100 });
    // The issue holds the finding as posted, without the box or Manki's hidden markers.
    expect(octokit.rest.issues.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', title: 'Retry has no limit' }));
    const issue: string = jest.mocked(octokit.rest.issues.create).mock.calls[0][0].body;
    expect(issue).toMatch(/^⚠️ \*\*Warning\*\*[\s\S]*\*\*What goes wrong:\*\* It retries forever\.[\s\S]*\n\nFound by Manki in #5 at \[`src\/net\.ts:7`\]\(https:\/\/github\.com\/o\/r\/blob\/abc123\/src\/net\.ts#L7\)\. See the \[review thread\]\(https:\/\/github\.com\/o\/r\/pull\/5#discussion_r501\)\.\n\n<!-- manki-issue:src\/net\.ts:7:[0-9a-f]{12} -->$/);
    expect(issue).not.toMatch(/manki-checks|manki-box|manki-finding|Create an issue/);
    // Only the box line changes. The finding and its hidden data stay as they were.
    const expected = body.replace(/- \[x\] Create an issue for this <!-- manki-box:issue:[^\n]* -->/, 'Issue #12 created by @bob');
    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 501, body: expected });
    expect(expected).toContain('<!-- manki-finding:');
    expect(jest.mocked(state.replyToReviewThread).mock.calls).toEqual([[octokit, 'PRRT_1', 'Agreed. Filed as #12 for later work.']]);
    expect(jest.mocked(state.resolveReviewThread).mock.calls).toEqual(resolved.map(([id, reason]) => [octokit, id, reason]));
  });

  it('links the finding\'s own line and file when the comment sits on another line or another file', async () => {
    const octokit = makeOctokit();
    jest.mocked(state.fetchBotReviewThreads).mockResolvedValue([]);

    await tick(octokit, { ...comment(ticked(finding())), original_line: 1 });

    expect(jest.mocked(octokit.rest.issues.create).mock.calls[0][0].body).toContain('[`src/net.ts:7`](https://github.com/o/r/blob/abc123/src/net.ts#L7)');

    // A blocker in a file outside the diff has its thread on a changed file, and its finding data names its own file.
    const elsewhere = formatFindingComment(finding({ severity: 'blocker', file: 'src/store.ts', line: 30 }), TEST_LINKS, true).replace('- [ ] Create an issue', '- [x] Create an issue');
    await tick(octokit, { ...comment(elsewhere), original_line: 1 });

    expect(jest.mocked(octokit.rest.issues.create).mock.calls[1][0].body).toContain('[`src/store.ts:30`](https://github.com/o/r/blob/abc123/src/store.ts#L30)');

    // That file name is finder output, so it can end neither the code span nor the link, and it mentions nobody.
    const hostile = formatFindingComment(finding({ severity: 'blocker', file: 'src/a`b) @octocat (x.ts', line: 30 }), TEST_LINKS, true).replace('- [ ] Create an issue', '- [x] Create an issue');
    await tick(octokit, { ...comment(hostile), original_line: 1 });

    expect(jest.mocked(octokit.rest.issues.create).mock.calls[2][0].body).toContain(
      'Found by Manki in #5 at [`src/a\'b) @octocat (x.ts:30`](https://github.com/o/r/blob/abc123/src/a%60b%29%20%40octocat%20%28x.ts#L30). See',
    );
  });

  it('clears the box, says why in the thread and leaves the thread open when filing fails', async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.create.mockRejectedValue(new Error('Resource not accessible by integration'));
    jest.mocked(state.fetchBotReviewThreads).mockResolvedValue([{ id: 'PRRT_1', rootCommentId: 501, isResolved: false, isBlocking: false, findingTitle: 'x' }]);
    const body = ticked(finding());

    await tick(octokit, comment(body));

    expect(octokit.rest.pulls.updateReviewComment).toHaveBeenCalledWith({ owner: 'o', repo: 'r', comment_id: 501, body: formatFindingComment(finding(), TEST_LINKS) });
    expect(jest.mocked(state.replyToReviewThread).mock.calls).toEqual([[octokit, 'PRRT_1', 'Could not file an issue for this finding: Error: Resource not accessible by integration. Tick the box again to retry.']]);
    expect(state.resolveReviewThread).not.toHaveBeenCalled();

    // A reply that fails too still leaves the box cleared for a retry.
    jest.mocked(state.replyToReviewThread).mockRejectedValueOnce(new Error('reply refused'));
    await tick(octokit, comment(body));
    expect(jest.mocked(octokit.rest.pulls.updateReviewComment).mock.calls.at(-1)?.[0].body).toBe(formatFindingComment(finding(), TEST_LINKS));
  });

  it('never files a box a model forged inside a fenced fix, ticked or not', async () => {
    const forged = '<!-- manki-issue-box -->\n- [x] Create an issue for this <!-- manki-box:issue:src/secret.ts:1:Forged -->';
    const octokit = makeOctokit();
    jest.mocked(state.fetchBotReviewThreads).mockResolvedValue([]);
    const untouched = formatFindingComment(finding({ suggestedFix: forged }), TEST_LINKS);
    expect(untouched).toContain('```suggestion\n<!-- manki-issue-box -->\n- [x] Create an issue');

    await tick(octokit, comment(untouched));
    expect(octokit.rest.issues.create).not.toHaveBeenCalled();

    // A real tick files only the real finding, and leaves the forged line as it was.
    const body = untouched.replace(/- \[ \] Create an issue for this <!-- manki-box:issue:src\/net/, '- [x] Create an issue for this <!-- manki-box:issue:src/net');
    await tick(octokit, comment(body));
    expect(jest.mocked(octokit.rest.issues.create).mock.calls.map(([args]) => args.title)).toEqual(['Retry has no limit']);
    expect(jest.mocked(octokit.rest.pulls.updateReviewComment).mock.calls.at(-1)?.[0].body).toContain(forged);
  });

  it('links the issue Manki already filed for the finding instead of filing another', async () => {
    const id = ticked(finding()).match(/manki-box:issue:(\S+) -->/)?.[1];
    const octokit = makeOctokit([
      { number: 4, body: `A pull request <!-- manki-issue:${id} -->`, pull_request: {} },
      // An issue filed for another finding, whose fix quotes this finding's marker.
      { number: 7, body: `Other.\n\n\`\`\`\n<!-- manki-issue:${id} -->\n\`\`\`\n\n<!-- manki-issue:src/other.ts:1:abc -->` },
      { number: 9, body: `Old.\n\n<!-- manki-issue:${id} -->` },
    ]);
    jest.mocked(state.fetchBotReviewThreads).mockResolvedValue([{ id: 'PRRT_1', rootCommentId: 501, isResolved: false, isBlocking: false, findingTitle: 'x' }]);

    await tick(octokit, comment(ticked(finding())));

    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
    expect(jest.mocked(octokit.rest.pulls.updateReviewComment).mock.calls[0][0].body).toContain('\nIssue #9 already tracks this, linked by @bob\n');
    expect(jest.mocked(state.replyToReviewThread).mock.calls).toEqual([[octokit, 'PRRT_1', 'Agreed. Filed as #9 for later work.']]);
  });

  it.each([
    ['an unticked box', formatFindingComment(finding(), TEST_LINKS)],
  ])('files nothing for %s', async (_case, body) => {
    const octokit = makeOctokit();

    await tick(octokit, comment(body));

    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.updateReviewComment).not.toHaveBeenCalled();
    expect(state.replyToReviewThread).not.toHaveBeenCalled();
  });
});

describe('handleReviewBoxTick', () => {
  beforeEach(() => jest.clearAllMocks());

  const box = (id: string) => `<!-- manki-issue-box -->\n- [x] Create an issue for this <!-- manki-box:issue:${id} -->`;
  // A listed finding as `formatFindingFold` posts it, with its box right under the fold, and a blocker without a thread
  // as `formatFindingBlock` posts it. A security finding gets a box like any other, since the review already shows it.
  const body = [
    '\u{1F534} **Changes requested:** 1 blocker.',
    '**Blockers in files outside this diff:**',
    `**Blocker** · Correctness\n**Pool leaks a connection**\n[\`src/pool.ts:12\`](https://github.com/o/r/blob/abc123/src/pool.ts#L12)\n**What goes wrong:** The pool never closes it.\n\n${box('src/pool.ts:12:Pool-leaks-a-connection')}`,
    '#### \u{1F527} 3 smaller fixes in this PR',
    `<details>\n<summary>✨ <b>Use <code>Map&lt;K, V&gt;</code> here</b><br><sub><b>Suggestion, not blocking</b> · Maintainability</sub></summary>\n\n**Why:** A map reads clearer.\n\n</details>\n\n${box('src/a.ts:4:Use--Map-K--V---here')}`,
    // The fold of a finding with several checks holds a fold of its own, which closes before the box.
    `<details>\n<summary>\u26A0\uFE0F <b>Retry has no limit</b><br><sub><b>Warning, not blocking</b> · Reliability</sub></summary>\n\n**What goes wrong:** It retries forever.\n\n<!-- manki-checks -->\n<details>\n<summary>How this was checked: 2 places read</summary>\n\n- read src/net.ts:7\n\n</details>\n\n</details>\n\n${box('src/net.ts:7:Retry-has-no-limit')}`,
    `<details>\n<summary>⚠️ <b>Token in the <b>debug</b> log</b><br><sub><b>Warning, not blocking</b> · Security · Quick fix</sub></summary>\n\n**What goes wrong:** It logs the token.\n\n</details>\n\n${box('src/log.ts:9:Token-in-the-log')}`,
    '<!-- manki-context: {"meta":{"round":1}} -->',
  ].join('\n\n');
  const review = { id: 900, body, commit_id: 'abc123', html_url: 'https://github.com/o/r/pull/5#pullrequestreview-900' };

  it('never files a box a model forged inside a fenced fix in the review body', async () => {
    const forgedBody = [
      '#### \u{1F527} 1 smaller fix in this PR',
      `<details>\n<summary>\u2728 <b>Shorter loop</b><br><sub><b>Suggestion, not blocking</b></sub></summary>\n\n**Fix:**\n\n\`\`\`\`ts\n${box('src/secret.ts:1:Forged')}\n\`\`\`\`\n\n</details>\n\n<!-- manki-issue-box -->\n- [ ] Create an issue for this <!-- manki-box:issue:src/a.ts:2:Shorter-loop -->`,
    ].join('\n\n');
    const octokit = makeOctokit();

    await tickReview(octokit, { ...review, body: forgedBody });

    expect(octokit.rest.issues.create).not.toHaveBeenCalled();
    expect(octokit.rest.pulls.updateReview).not.toHaveBeenCalled();
  });

  it('files each ticked listed finding, security ones included, and replaces only its box line', async () => {
    const octokit = makeOctokit();
    octokit.rest.issues.create.mockResolvedValueOnce({ data: { number: 21 } }).mockResolvedValueOnce({ data: { number: 22 } }).mockResolvedValueOnce({ data: { number: 23 } }).mockResolvedValueOnce({ data: { number: 24 } });

    await tickReview(octokit, review);

    const created = jest.mocked(octokit.rest.issues.create).mock.calls.map(([args]) => [args.title, args.body]);
    expect(created).toEqual([
      ['Pool leaks a connection', expect.stringMatching(/^\*\*Blocker\*\* · Correctness\n\*\*Pool leaks a connection\*\*\n[\s\S]*The pool never closes it\.\n\nFound by Manki in #5 at \[`src\/pool\.ts:12`\]\(https:\/\/github\.com\/o\/r\/blob\/abc123\/src\/pool\.ts#L12\)\. See the \[review\]\(https:\/\/github\.com\/o\/r\/pull\/5#pullrequestreview-900\)\.\n\n<!-- manki-issue:src\/pool\.ts:12:Pool-leaks-a-connection -->$/)],
      ['Use Map<K, V> here', expect.stringMatching(/^\*\*Why:\*\* A map reads clearer\.\n\nFound by Manki in #5 at \[`src\/a\.ts:4`\]/)],
      ['Retry has no limit', expect.stringMatching(/^\*\*What goes wrong:\*\* It retries forever\.\n\n<details>\n<summary>How this was checked: 2 places read<\/summary>\n\n- read src\/net\.ts:7\n\n<\/details>\n\nFound by Manki in #5 at \[`src\/net\.ts:7`\]/)],
      // A title with bold text of its own is read whole.
      ['Token in the debug log', expect.stringMatching(/^\*\*What goes wrong:\*\* It logs the token\.\n\nFound by Manki in #5 at \[`src\/log\.ts:9`\]/)],
    ]);
    const updates = jest.mocked(octokit.rest.pulls.updateReview).mock.calls.map(([args]) => args.body);
    expect(updates.at(-1)).toBe(body
      .replace('- [x] Create an issue for this <!-- manki-box:issue:src/pool.ts:12:Pool-leaks-a-connection -->', 'Issue #21 created by @bob')
      .replace('- [x] Create an issue for this <!-- manki-box:issue:src/a.ts:4:Use--Map-K--V---here -->', 'Issue #22 created by @bob')
      .replace('- [x] Create an issue for this <!-- manki-box:issue:src/net.ts:7:Retry-has-no-limit -->', 'Issue #23 created by @bob')
      .replace('- [x] Create an issue for this <!-- manki-box:issue:src/log.ts:9:Token-in-the-log -->', 'Issue #24 created by @bob'));
    expect(jest.mocked(octokit.rest.pulls.updateReview).mock.calls[0][0]).toMatchObject({ owner: 'o', repo: 'r', pull_number: 5, review_id: 900 });
  });

  it('files one issue per tick for two findings on one line whose titles differ only in punctuation', async () => {
    const body = [finding({ title: 'Retry has no limit.' }), finding({ title: 'Retry has no limit!' })].map(f => formatFindingBlock(f, TEST_LINKS, true)).join('\n\n');
    const tickedBox = /- \[x\] Create an issue for this <!-- manki-box:issue:\S+ -->/;
    const octokit = makeOctokit();
    octokit.rest.issues.create.mockResolvedValueOnce({ data: { number: 21 } }).mockResolvedValueOnce({ data: { number: 22 } });

    const first = body.replace('- [ ]', '- [x]');
    await tickReview(octokit, { ...review, body: first });
    const afterFirst = jest.mocked(octokit.rest.pulls.updateReview).mock.calls.at(-1)?.[0].body as string;
    expect(afterFirst).toBe(first.replace(tickedBox, 'Issue #21 created by @bob'));

    const second = afterFirst.replace('- [ ]', '- [x]');
    await tickReview(octokit, { ...review, body: second });
    const created = jest.mocked(octokit.rest.issues.create).mock.calls.map(([args]) => [args.title, args.body.match(/<!-- manki-issue:\S+ -->/)?.[0]]);
    expect(created.map(([title]) => title)).toEqual(['Retry has no limit.', 'Retry has no limit!']);
    // Each issue carries its own marker, so a later tick of one never links the other's issue.
    expect(new Set(created.map(([, marker]) => marker)).size).toBe(2);
    expect(jest.mocked(octokit.rest.pulls.updateReview).mock.calls.at(-1)?.[0].body).toBe(second.replace(tickedBox, 'Issue #22 created by @bob'));
  });

  it('reads a fold whose fenced fix holds fold tags, keeps CRLF endings, keeps a tick made meanwhile, and reports a failure on the PR', async () => {
    const fold = (title: string, id: string, extra = '') =>
      `<details>\n<summary>\u2728 <b>${title}</b><br><sub><b>Suggestion, not blocking</b></sub></summary>\n\n**Why:** ${title}.${extra}\n\n</details>\n\n${box(id).replace('[x]', '[ ]')}`;
    // A fix for an HTML file can hold fold tags of its own, inside its fence.
    const htmlFix = '\n\n**Fix:**\n\n```html\n</details>\n<details>\n```';
    const listed = ['#### \u{1F527} 2 smaller fixes in this PR', fold('Close the menu', 'src/menu.html:3:Close-the-menu', htmlFix), fold('Trim the label', 'src/menu.html:9:Trim-the-label')].join('\n\n');
    const crlf = listed.replace('[ ] Create an issue for this <!-- manki-box:issue:src/menu.html:3', '[x] Create an issue for this <!-- manki-box:issue:src/menu.html:3').replace(/\n/g, '\r\n');
    const octokit = makeOctokit();
    // While the run files the first finding, a writer ticks the second one.
    octokit.rest.issues.create.mockImplementationOnce(async () => {
      octokit.seed(crlf.replace('[ ] Create an issue for this <!-- manki-box:issue:src/menu.html:9', '[x] Create an issue for this <!-- manki-box:issue:src/menu.html:9'));
      return { data: { number: 31 } };
    });

    await tickReview(octokit, { ...review, body: crlf });

    expect(jest.mocked(octokit.rest.issues.create).mock.calls.map(([args]) => args.title)).toEqual(['Close the menu']);
    const written = jest.mocked(octokit.rest.pulls.updateReview).mock.calls.at(-1)?.[0].body as string;
    expect(written).toContain('\r\nIssue #31 created by @bob\r\n');
    expect(written).toMatch(/\r\n- \[x\] Create an issue for this <!-- manki-box:issue:src\/menu\.html:9:Trim-the-label -->$/);

    const failing = makeOctokit();
    failing.rest.issues.create.mockRejectedValue(new Error('Resource not accessible by integration'));
    await tickReview(failing, { ...review, body: crlf });
    expect(jest.mocked(failing.rest.issues.createComment).mock.calls[0][0]).toMatchObject({
      owner: 'o', repo: 'r', issue_number: 5,
      body: expect.stringMatching(/^Could not file an issue for \*\*Close the menu\*\*: Error: Resource not accessible by integration\. Tick its box in the review again to retry\./),
    });
    expect(jest.mocked(failing.rest.pulls.updateReview).mock.calls[0][0].body).toContain('- [ ] Create an issue for this <!-- manki-box:issue:src/menu.html:3:Close-the-menu -->\r\n');
  });

  it('files a blocker block in a CRLF body, and goes on after a failed report of a failed filing', async () => {
    const block = (title: string, id: string) =>
      `**Blocker** · Correctness\n**${title}**\n**What goes wrong:** ${title}.\n\n${box(id)}`;
    // A file name with `-->` is encoded in the id, so its permalink names the real file.
    const crlf = ['**Blockers in files outside this diff:**', block('First leak', 'src/a--%3Eb.ts:3:First-leak'), block('Second leak', 'src/c.ts:4:Second-leak')]
      .join('\n\n').replace(/\n/g, '\r\n');
    const octokit = makeOctokit();
    octokit.rest.issues.create.mockRejectedValueOnce(new Error('rate limited')).mockResolvedValueOnce({ data: { number: 41 } });
    octokit.rest.issues.createComment.mockRejectedValueOnce(new Error('comment refused'));

    await tickReview(octokit, { ...review, body: crlf });

    expect(jest.mocked(octokit.rest.issues.create).mock.calls.map(([args]) => args.title)).toEqual(['First leak', 'Second leak']);
    expect(jest.mocked(octokit.rest.pulls.updateReview).mock.calls.at(-1)?.[0].body).toMatch(/\r\nIssue #41 created by @bob$/);
  });

  it('files a blocker block that ends with its own checks fold', async () => {
    const octokit = makeOctokit();
    const body = `**Blocker** · Correctness\n**Pool leaks**\n**What goes wrong:** It leaks.\n<!-- manki-checks -->\n<details>\n<summary>How this was checked: 2 places read</summary>\n\n- read src/pool.ts:12\n\n</details>\n\n${box('src/pool.ts:12:Pool-leaks')}`;

    await tickReview(octokit, { ...review, body });

    expect(jest.mocked(octokit.rest.issues.create).mock.calls.map(([args]) => args.title)).toEqual(['Pool leaks']);
    expect(jest.mocked(octokit.rest.pulls.updateReview).mock.calls.at(-1)?.[0].body).toMatch(/\nIssue #12 created by @bob$/);
  });

  it('links the real file of a box whose id encodes it', async () => {
    const octokit = makeOctokit();
    const body = `**Blocker** · Correctness\n**Odd name**\n**What goes wrong:** Odd.\n\n${box('src/a--%3Eb.ts:3:Odd-name')}`;

    await tickReview(octokit, { ...review, body });

    expect(jest.mocked(octokit.rest.issues.create).mock.calls[0][0].body).toContain('[`src/a--%3Eb.ts:3`](https://github.com/o/r/blob/abc123/src/a--%3Eb.ts#L3)');
  });
});
