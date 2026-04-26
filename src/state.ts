import * as core from '@actions/core';
import * as github from '@actions/github';

import { dismissPreviousReviews, isReviewInProgress } from './github';
import { migrateLegacySeverity, SEVERITY_TOKEN_PATTERN } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- manki -->';

interface ReviewThread {
  id: string;
  isResolved: boolean;
  isRequired: boolean;
  findingTitle: string;
}

/**
 * Fetch all review threads from the bot on a PR using GraphQL.
 * Returns threads with their resolution state and severity.
 */
async function fetchBotReviewThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes {
                  body
                  author {
                    login
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const result: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            id: string;
            isResolved: boolean;
            comments: {
              nodes: Array<{
                body: string;
                author: { login: string } | null;
              }>;
            };
          }>;
        };
      };
    };
  } = await octokit.graphql(query, { owner, repo, prNumber });

  const threads = result.repository.pullRequest.reviewThreads.nodes;

  return threads
    .filter(thread => {
      const firstComment = thread.comments.nodes[0];
      return firstComment?.body?.includes('manki:') ||
        firstComment?.body?.includes(BOT_MARKER);
    })
    .map(thread => {
      const body = thread.comments.nodes[0]?.body ?? '';
      const severityMatch = body.match(new RegExp(`<!-- manki:(${SEVERITY_TOKEN_PATTERN}):`));
      const isRequired = severityMatch?.[1]
        ? migrateLegacySeverity(severityMatch[1]) === 'blocker'
        : false;
      const titleMatch = body.match(/<!-- manki:\w+:(.+?) -->/);
      const findingTitle = titleMatch?.[1]?.replace(/-/g, ' ') ?? 'Unknown';

      return {
        id: thread.id,
        isResolved: thread.isResolved,
        isRequired,
        findingTitle,
      };
    });
}

/**
 * Check if all bot review threads (blocker, warning, suggestion, nitpick) are resolved.
 * Auto-approve should only fire when every finding is resolved, because
 * CHANGES_REQUESTED can be caused by high-confidence warnings too.
 */
function areAllFindingsResolved(threads: ReviewThread[]): boolean {
  return threads.every(t => t.isResolved);
}

/**
 * Post an approval review if all findings are resolved.
 */
async function checkAndAutoApprove(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  if (await isReviewInProgress(octokit, owner, repo, prNumber)) {
    core.info('Skipping auto-approve — review in progress');
    return false;
  }

  const threads = await fetchBotReviewThreads(octokit, owner, repo, prNumber);

  const totalCount = threads.length;
  const resolvedCount = threads.filter(t => t.isResolved).length;

  core.info(`Review threads: ${resolvedCount}/${totalCount} resolved`);

  if (!areAllFindingsResolved(threads)) {
    core.info('Not all findings resolved — skipping auto-approve');
    return false;
  }

  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
  });
  const botReviews = reviews.filter(
    (r: { body?: string | null; state?: string; user?: { login?: string; type?: string } | null }) =>
      r.body?.includes('<!-- manki') && r.user?.login?.includes('[bot]') && r.state !== 'DISMISSED',
  );
  const latestBotReview = botReviews[botReviews.length - 1];
  if (latestBotReview?.state === 'APPROVED') {
    core.info('Already approved — skipping duplicate approval');
    return true;
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  try {
    await dismissPreviousReviews(octokit, owner, repo, prNumber);
  } catch (error) {
    core.warning(`Failed to dismiss previous reviews during auto-approve: ${error}`);
  }

  core.info('All findings resolved — auto-approving');
  const body = BOT_MARKER;

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: pr.head.sha,
      event: 'APPROVE',
      body,
    });
    core.info('Auto-approved PR');
  } catch {
    core.warning(
      'Failed to auto-approve PR. Ensure "Allow GitHub Actions to create and approve pull requests" is enabled in repo settings. Falling back to COMMENT.',
    );
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: pr.head.sha,
      event: 'COMMENT',
      body,
    });
    core.info('Posted auto-approve as COMMENT (fallback)');
  }

  return true;
}

/**
 * Resolve stale bot review threads left over from previous commits (e.g. after force-push).
 * A thread is stale when the first comment's commit differs from the current head SHA.
 */
async function resolveStaleThreads(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  currentHeadSha: string,
): Promise<number> {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              comments(first: 1) {
                nodes {
                  body
                  commit {
                    oid
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const result: {
    repository: {
      pullRequest: {
        reviewThreads: {
          nodes: Array<{
            id: string;
            isResolved: boolean;
            comments: {
              nodes: Array<{ body: string; commit: { oid: string } | null }>;
            };
          }>;
        };
      };
    };
  } = await octokit.graphql(query, { owner, repo, prNumber });

  const threads = result.repository.pullRequest.reviewThreads.nodes;
  let resolvedCount = 0;

  for (const thread of threads) {
    if (thread.isResolved) continue;

    const body = thread.comments.nodes[0]?.body ?? '';
    if (!body.includes('manki:') && !body.includes(BOT_MARKER)) continue;

    const commitOid = thread.comments.nodes[0]?.commit?.oid;
    if (!commitOid || commitOid === currentHeadSha) continue;

    try {
      await octokit.graphql(`
        mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { isResolved }
          }
        }
      `, { threadId: thread.id });
      resolvedCount++;
    } catch (error) {
      core.debug(`Failed to resolve stale thread ${thread.id}: ${error}`);
    }
  }

  return resolvedCount;
}

export { ReviewThread, areAllFindingsResolved, checkAndAutoApprove, fetchBotReviewThreads, resolveStaleThreads, BOT_MARKER };
