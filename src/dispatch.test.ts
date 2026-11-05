import * as core from '@actions/core';
import * as github from '@actions/github';

import { restoreDispatchedEvent } from './dispatch';

jest.mock('@actions/core', () => ({
  ...jest.requireActual('@actions/core'),
  info: jest.fn(),
}));

jest.mock('@actions/github', () => ({
  context: { eventName: 'workflow_dispatch', payload: {}, repo: { owner: 'acme', repo: 'widgets' }, actor: 'manki-review[bot]' },
}));

const HEAD = 'a1'.repeat(20);
const API = 'https://api.github.com/repos/acme/widgets';
const ALICE = { login: 'alice', type: 'User' };
const BOB = { login: 'bob', type: 'User' };
const PR = { number: 7, head: { sha: HEAD, repo: { full_name: 'acme/widgets' } }, base: { ref: 'main', repo: { full_name: 'acme/widgets' } }, user: ALICE, merged: true, merged_by: BOB };
const ISSUE = { number: 7, pull_request: { url: `${API}/pulls/7` }, user: ALICE };
const ISSUE_COMMENT = { id: 11, node_id: 'IC_11', body: '@manki explain', user: BOB, author_association: 'MEMBER', issue_url: `${API}/issues/7` };
const REVIEW = { id: 12, commit_id: HEAD, user: BOB, pull_request_url: `${API}/pulls/7` };
const REVIEW_COMMENT = { id: 13, body: 'Agreed', user: BOB, in_reply_to_id: 10, pull_request_url: `${API}/pulls/7` };
const REPOSITORY = { name: 'widgets', owner: { login: 'acme' } };
const THREAD = { id: 'PRRT_kwDOAbc123', isResolved: true, resolvedBy: { login: 'dave', __typename: 'User' }, pullRequest: { number: 7, repository: { nameWithOwner: 'acme/widgets' } } };

function mockOctokit() {
  return {
    rest: {
      pulls: {
        get: jest.fn().mockResolvedValue({ data: PR }),
        getReview: jest.fn().mockResolvedValue({ data: REVIEW }),
        getReviewComment: jest.fn().mockResolvedValue({ data: REVIEW_COMMENT }),
      },
      issues: {
        get: jest.fn().mockResolvedValue({ data: ISSUE }),
        getComment: jest.fn().mockResolvedValue({ data: ISSUE_COMMENT }),
      },
    },
    // One node answers both queries: the last editor of a comment and a review thread.
    graphql: jest.fn().mockResolvedValue({ node: { editor: { login: 'carol', __typename: 'User' }, ...THREAD } }),
  };
}

let octokit: ReturnType<typeof mockOctokit>;

function dispatch(inputs: Record<string, string>): ReturnType<typeof restoreDispatchedEvent> {
  Object.assign(github.context, { eventName: 'workflow_dispatch', actor: 'manki-review[bot]', payload: { inputs, repository: REPOSITORY, sender: { login: 'manki-review[bot]', type: 'Bot' } } });
  return restoreDispatchedEvent(octokit as unknown as Parameters<typeof restoreDispatchedEvent>[0]);
}

beforeEach(() => {
  jest.clearAllMocks();
  octokit = mockOctokit();
});

describe('restoreDispatchedEvent', () => {
  it.each([
    ['a push, as the PR author', { event: 'pull_request', action: 'synchronize', pr: '7', head_sha: HEAD },
      { pull_request: PR }, ALICE],
    ['a merge, as the merger', { event: 'pull_request', action: 'closed', pr: '7', head_sha: HEAD },
      { pull_request: PR }, BOB],
    ['a new PR comment, as its author', { event: 'issue_comment', action: 'created', pr: '7', comment_id: '11', delivery_id: 'f1e2d3c4-0000-4000-8000-000000000001' },
      { comment: ISSUE_COMMENT, issue: ISSUE }, BOB],
    ['an edited comment, as its last editor', { event: 'issue_comment', action: 'edited', pr: '7', comment_id: '11' },
      { comment: ISSUE_COMMENT, issue: ISSUE }, { login: 'carol', type: 'User' }],
    ['a review, as its author', { event: 'pull_request_review', action: 'submitted', pr: '7', review_id: '12', head_sha: HEAD },
      { review: REVIEW, pull_request: PR }, BOB],
    ['a thread reply, as its author', { event: 'pull_request_review_comment', action: 'created', pr: '7', comment_id: '13' },
      { comment: REVIEW_COMMENT, pull_request: PR }, BOB],
    ['a resolved thread, as its resolver', { event: 'pull_request_review_thread', action: 'resolved', pr: '7', thread_id: THREAD.id },
      { thread: { node_id: THREAD.id, is_resolved: true }, pull_request: PR }, { login: 'dave', type: 'User' }],
    ['a reopened thread, as the PR author', { event: 'pull_request_review_thread', action: 'unresolved', pr: '7', thread_id: THREAD.id },
      { thread: { node_id: THREAD.id, is_resolved: true }, pull_request: PR }, ALICE],
  ])('rebuilds %s', async (_label, inputs, objects, sender) => {
    expect(await dispatch(inputs)).toBe('run');

    expect(github.context.eventName).toBe(inputs.event);
    expect(github.context.payload).toEqual({ ...objects, action: inputs.action, sender, repository: REPOSITORY });
    expect(github.context.actor).toBe(sender.login);
    expect(core.info).toHaveBeenCalledWith(expect.stringContaining('by manki-review[bot]'));
  });

  it('reports a bot that last edited a comment the way a webhook names it', async () => {
    octokit.graphql.mockResolvedValue({ node: { editor: { login: 'manki-review', __typename: 'Bot' } } });

    await dispatch({ event: 'issue_comment', action: 'edited', pr: '7', comment_id: '11' });

    expect(github.context.payload.sender).toEqual({ login: 'manki-review[bot]', type: 'Bot' });
    expect(octokit.graphql).toHaveBeenCalledWith(expect.any(String), { id: 'IC_11' });
  });

  it('stops a push run whose head moved on, and not a merge', async () => {
    const pushed = { event: 'pull_request', pr: '7', head_sha: 'b2'.repeat(20) };

    expect(await dispatch({ ...pushed, action: 'synchronize' })).toBe('superseded');
    expect(await dispatch({ ...pushed, action: 'closed' })).toBe('run');
  });

  it('stops when the comment or review is gone', async () => {
    octokit.rest.issues.getComment.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));

    expect(await dispatch({ event: 'issue_comment', action: 'created', pr: '7', comment_id: '11' })).toBe('gone');
    expect(github.context.eventName).toBe('workflow_dispatch');
  });

  it('stops when the thread id names no review thread', async () => {
    octokit.graphql.mockRejectedValueOnce(Object.assign(new Error('Could not resolve to a node'), { errors: [{ type: 'NOT_FOUND' }] }));
    expect(await dispatch({ event: 'pull_request_review_thread', action: 'resolved', pr: '7', thread_id: THREAD.id })).toBe('gone');

    octokit.graphql.mockResolvedValueOnce({ node: { id: THREAD.id } });
    expect(await dispatch({ event: 'pull_request_review_thread', action: 'resolved', pr: '7', thread_id: THREAD.id })).toBe('gone');
  });

  it('rethrows an API failure other than a missing object', async () => {
    octokit.rest.pulls.get.mockRejectedValue(Object.assign(new Error('Server Error'), { status: 502 }));

    await expect(dispatch({ event: 'pull_request', action: 'opened', pr: '7', head_sha: HEAD })).rejects.toThrow('Server Error');
  });

  it.each([
    ['a comment on another PR', () => octokit.rest.issues.getComment.mockResolvedValue({ data: { ...ISSUE_COMMENT, issue_url: `${API}/issues/8` } }),
      { event: 'issue_comment', action: 'created', pr: '7', comment_id: '11' }, 'Comment 11 does not belong to #7'],
    ['a reply in another repo', () => octokit.rest.pulls.getReviewComment.mockResolvedValue({ data: { ...REVIEW_COMMENT, pull_request_url: 'https://api.github.com/repos/evil/widgets/pulls/7' } }),
      { event: 'pull_request_review_comment', action: 'created', pr: '7', comment_id: '13' }, 'Review comment 13 does not belong to #7'],
    ['a review of another PR', () => octokit.rest.pulls.getReview.mockResolvedValue({ data: { ...REVIEW, pull_request_url: `${API}/pulls/70` } }),
      { event: 'pull_request_review', action: 'submitted', pr: '7', review_id: '12' }, 'Review 12 does not belong to #7'],
    ['a thread on another PR', () => octokit.graphql.mockResolvedValue({ node: { ...THREAD, pullRequest: { number: 8, repository: { nameWithOwner: 'acme/widgets' } } } }),
      { event: 'pull_request_review_thread', action: 'resolved', pr: '7', thread_id: THREAD.id }, 'Review thread does not belong to #7'],
    ['a thread in another repo', () => octokit.graphql.mockResolvedValue({ node: { ...THREAD, pullRequest: { number: 7, repository: { nameWithOwner: 'evil/widgets' } } } }),
      { event: 'pull_request_review_thread', action: 'resolved', pr: '7', thread_id: THREAD.id }, 'Review thread does not belong to #7'],
    ['a PR based in another repo', () => octokit.rest.pulls.get.mockResolvedValue({ data: { ...PR, base: { ref: 'main', repo: { full_name: 'evil/widgets' } } } }),
      { event: 'pull_request', action: 'opened', pr: '7', head_sha: HEAD }, 'PR #7 does not belong to acme/widgets'],
  ])('refuses %s', async (_label, arrange, inputs, message) => {
    arrange();

    await expect(dispatch(inputs)).rejects.toThrow(message);
    expect(github.context.eventName).toBe('workflow_dispatch');
  });

  it.each([
    ['an unknown event', { event: 'push', action: 'created', pr: '7' }, '`event` must be one of'],
    ['a missing action', { event: 'pull_request', pr: '7', head_sha: HEAD }, '`action` is required'],
    ['a workflow command as the action', { event: 'pull_request', action: '::stop-commands::x', pr: '7', head_sha: HEAD }, '`action` must be'],
    ['a PR number that is not a number', { event: 'pull_request', action: 'opened', pr: '7; rm', head_sha: HEAD }, '`pr` must be'],
    ['PR zero', { event: 'pull_request', action: 'opened', pr: '0', head_sha: HEAD }, '`pr` must be'],
    ['a short head SHA', { event: 'pull_request', action: 'opened', pr: '7', head_sha: 'a1b2c3d' }, '`head_sha` must be'],
    ['a push without a head SHA', { event: 'pull_request', action: 'opened', pr: '7' }, '`head_sha` is required'],
    ['a comment event without a comment id', { event: 'issue_comment', action: 'created', pr: '7' }, '`comment_id` is required'],
    ['a review id on a comment event', { event: 'issue_comment', action: 'created', pr: '7', comment_id: '11', review_id: '12' }, '`review_id` does not apply'],
    ['a comment id on a push', { event: 'pull_request', action: 'opened', pr: '7', head_sha: HEAD, comment_id: '11' }, '`comment_id` does not apply'],
    ['a thread event without a thread id', { event: 'pull_request_review_thread', action: 'resolved', pr: '7' }, '`thread_id` is required'],
    ['a thread id that is not a node id', { event: 'pull_request_review_thread', action: 'resolved', pr: '7', thread_id: 'PRRT_x y' }, '`thread_id` must be'],
    ['a thread id on a review event', { event: 'pull_request_review', action: 'submitted', pr: '7', review_id: '12', thread_id: THREAD.id }, '`thread_id` does not apply'],
    ['a delivery id with spaces', { event: 'pull_request', action: 'opened', pr: '7', head_sha: HEAD, delivery_id: 'a b' }, '`delivery_id` must be'],
  ])('fails on %s without echoing the value', async (_label, inputs, message) => {
    const failure = dispatch(inputs);

    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.not.toThrow(/stop-commands|rm|a1b2c3d|a b/);
    expect(octokit.rest.pulls.get).not.toHaveBeenCalled();
  });
});
