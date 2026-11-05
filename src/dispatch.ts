import * as core from '@actions/core';
import * as github from '@actions/github';

type Octokit = ReturnType<typeof github.getOctokit>;

type DispatchedEvent = 'pull_request' | 'issue_comment' | 'pull_request_review' | 'pull_request_review_comment';

/** The id input each event needs to find its comment or review. */
const OBJECT_INPUTS: Record<DispatchedEvent, 'comment_id' | 'review_id' | undefined> = {
  pull_request: undefined,
  issue_comment: 'comment_id',
  pull_request_review: 'review_id',
  pull_request_review_comment: 'comment_id',
};

const NUMBER = /^[1-9][0-9]{0,15}$/;
const SHA = /^[0-9a-f]{40}$/;
const ACTION = /^[a-z_]{1,32}$/;
const DELIVERY_ID = /^[A-Za-z0-9-]{1,64}$/;

interface DispatchInputs {
  event: DispatchedEvent;
  action: string;
  number: number;
  headSha?: string;
  objectId?: number;
  deliveryId?: string;
}

interface Sender {
  login: string;
  type: string;
}

interface FetchedEvent {
  objects: Record<string, unknown>;
  sender: Sender;
  headSha?: string;
}

/** What a dispatched run does next: run the handlers, or stop because the head moved on or the comment or review is gone. */
export type DispatchOutcome = 'run' | 'superseded' | 'gone';

/** Whether the run was started by `workflow_dispatch`. The original event name stays in the environment after the payload is rebuilt. */
export function isDispatchedRun(): boolean {
  return process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
}

/** The PR or issue number a dispatched run is for, read from the inputs alone so the post phase needs no API call. */
export function dispatchedNumber(): number {
  return readDispatchInputs(github.context.payload.inputs ?? {}).number;
}

/**
 * Replaces the `workflow_dispatch` context with the event the inputs name, read from the API.
 * Only the event kind and the ids come from the inputs, since anyone with write access can dispatch by hand.
 * Throws on an input that does not validate or an object from another PR.
 */
export async function restoreDispatchedEvent(octokit: Octokit): Promise<DispatchOutcome> {
  const inputs = readDispatchInputs(github.context.payload.inputs ?? {});
  core.info(`Dispatched ${inputs.event}.${inputs.action} for #${inputs.number} by ${github.context.actor}${inputs.deliveryId ? `, delivery ${inputs.deliveryId}` : ''}`);

  let event: FetchedEvent;
  try {
    event = await fetchEvent(octokit, inputs);
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
    core.info(`The dispatched ${inputs.event} on #${inputs.number} no longer exists, nothing to do`);
    return 'gone';
  }

  github.context.eventName = inputs.event;
  github.context.payload = { ...event.objects, action: inputs.action, sender: event.sender, repository: github.context.payload.repository };
  github.context.actor = event.sender.login;

  if (inputs.event === 'pull_request' && inputs.action !== 'closed' && event.headSha !== inputs.headSha) {
    core.info(`Dispatched for ${inputs.headSha?.slice(0, 7)}, but the PR head is ${event.headSha?.slice(0, 7)}. A newer run reviews it.`);
    return 'superseded';
  }
  return 'run';
}

/** Validates the dispatch inputs. Never echoes a value, so a crafted input cannot inject a workflow command into the log. */
function readDispatchInputs(raw: Record<string, unknown>): DispatchInputs {
  const input = (name: string): string | undefined => {
    const value = raw[name];
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string') throw new Error(`Dispatch input \`${name}\` must be a string`);
    return value;
  };
  const matching = (name: string, pattern: RegExp, expected: string): string | undefined => {
    const value = input(name);
    if (value !== undefined && !pattern.test(value)) throw new Error(`Dispatch input \`${name}\` must be ${expected}`);
    return value;
  };

  const event = input('event');
  if (!event || !Object.hasOwn(OBJECT_INPUTS, event)) {
    throw new Error(`Dispatch input \`event\` must be one of ${Object.keys(OBJECT_INPUTS).join(', ')}`);
  }
  const action = matching('action', ACTION, 'a webhook action such as `synchronize`');
  if (!action) throw new Error('Dispatch input `action` is required');
  const number = matching('pr', NUMBER, 'a PR or issue number');
  if (!number) throw new Error('Dispatch input `pr` is required');
  const headSha = matching('head_sha', SHA, 'a full 40 character commit SHA');
  if (event === 'pull_request' && !headSha) throw new Error('Dispatch input `head_sha` is required for `pull_request`');

  const objectInput = OBJECT_INPUTS[event as DispatchedEvent];
  let objectId: string | undefined;
  for (const name of ['comment_id', 'review_id'] as const) {
    const value = matching(name, NUMBER, 'a numeric id');
    if (name === objectInput) {
      if (!value) throw new Error(`Dispatch input \`${name}\` is required for \`${event}\``);
      objectId = value;
    } else if (value) {
      throw new Error(`Dispatch input \`${name}\` does not apply to \`${event}\``);
    }
  }

  return {
    event: event as DispatchedEvent,
    action,
    number: Number(number),
    headSha,
    objectId: objectId === undefined ? undefined : Number(objectId),
    deliveryId: matching('delivery_id', DELIVERY_ID, 'a webhook delivery GUID'),
  };
}

/** Reads the objects the original webhook payload carried, and who caused the event. */
async function fetchEvent(octokit: Octokit, inputs: DispatchInputs): Promise<FetchedEvent> {
  const { owner, repo } = github.context.repo;
  const { number, objectId } = inputs;
  const issuePath = `/repos/${owner}/${repo}/issues/${number}`;
  const pullPath = `/repos/${owner}/${repo}/pulls/${number}`;

  switch (inputs.event) {
    case 'pull_request': {
      const pull_request = await fetchPullRequest(octokit, owner, repo, number);
      // The API does not say who pushed, and a commit author is forgeable. The service drops bot pushes, so a push counts as the PR author's.
      const sender = userOf(inputs.action === 'closed' ? pull_request.merged_by ?? pull_request.user : pull_request.user);
      return { objects: { pull_request }, sender, headSha: pull_request.head.sha };
    }
    case 'issue_comment': {
      const { data: comment } = await octokit.rest.issues.getComment({ owner, repo, comment_id: objectId! });
      assertPartOf(comment.issue_url, issuePath, `Comment ${objectId}`, number);
      const { data: issue } = await octokit.rest.issues.get({ owner, repo, issue_number: number });
      const sender = inputs.action === 'edited' ? await lastEditor(octokit, comment.node_id) : undefined;
      return { objects: { comment, issue }, sender: sender ?? userOf(comment.user) };
    }
    case 'pull_request_review': {
      const pull_request = await fetchPullRequest(octokit, owner, repo, number);
      const { data: review } = await octokit.rest.pulls.getReview({ owner, repo, pull_number: number, review_id: objectId! });
      assertPartOf(review.pull_request_url, pullPath, `Review ${objectId}`, number);
      return { objects: { review, pull_request }, sender: userOf(review.user) };
    }
    case 'pull_request_review_comment': {
      const { data: comment } = await octokit.rest.pulls.getReviewComment({ owner, repo, comment_id: objectId! });
      assertPartOf(comment.pull_request_url, pullPath, `Review comment ${objectId}`, number);
      const pull_request = await fetchPullRequest(octokit, owner, repo, number);
      return { objects: { comment, pull_request }, sender: userOf(comment.user) };
    }
  }
}

async function fetchPullRequest(octokit: Octokit, owner: string, repo: string, number: number) {
  const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: number });
  if (data.base.repo.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    throw new Error(`PR #${number} does not belong to ${owner}/${repo}`);
  }
  return data;
}

function assertPartOf(url: string | undefined, path: string, what: string, number: number): void {
  if (!url || !new URL(url).pathname.toLowerCase().endsWith(path.toLowerCase())) {
    throw new Error(`${what} does not belong to #${number}`);
  }
}


/** Who last edited a comment, such as the person who ticked a Force review box on Manki's comment. */
async function lastEditor(octokit: Octokit, nodeId: string): Promise<Sender | undefined> {
  const { node } = await octokit.graphql<{ node: { editor: { login: string; __typename: string } | null } | null }>(
    'query($id: ID!) { node(id: $id) { ... on IssueComment { editor { login __typename } } } }',
    { id: nodeId },
  );
  const editor = node?.editor;
  if (!editor) return undefined;
  // GraphQL names a bot `<slug>`, while webhook payloads and REST use `<slug>[bot]`.
  return editor.__typename === 'Bot' ? { login: `${editor.login}[bot]`, type: 'Bot' } : { login: editor.login, type: 'User' };
}

function userOf(user: { login: string; type: string } | null | undefined): Sender {
  return user ? { login: user.login, type: user.type } : { login: 'unknown', type: 'User' };
}
