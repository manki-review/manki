import * as core from '@actions/core';
import * as github from '@actions/github';

import { dismissPreviousReviews } from './github';

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
      const severityMatch = body.match(/<!-- manki:(required|suggestion|nit|ignore):/);
      const isRequired = severityMatch?.[1] === 'required';
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
 * Check if all required threads are resolved.
 */
function areAllRequiredResolved(threads: ReviewThread[]): boolean {
  const requiredThreads = threads.filter(t => t.isRequired);
  if (requiredThreads.length === 0) return true;
  return requiredThreads.every(t => t.isResolved);
}

/**
 * Post an approval review if all required issues are resolved.
 */
async function checkAndAutoApprove(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  const threads = await fetchBotReviewThreads(octokit, owner, repo, prNumber);

  const requiredCount = threads.filter(t => t.isRequired).length;
  const resolvedRequiredCount = threads.filter(t => t.isRequired && t.isResolved).length;

  core.info(`Required threads: ${resolvedRequiredCount}/${requiredCount} resolved`);

  if (!areAllRequiredResolved(threads)) {
    core.info('Not all required issues resolved — skipping auto-approve');
    return false;
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

  core.info('All required issues resolved — auto-approving');
  const body = `${BOT_MARKER}\nAll required issues resolved. Approved.`;

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

export { ReviewThread, areAllRequiredResolved, checkAndAutoApprove, fetchBotReviewThreads, resolveStaleThreads, BOT_MARKER };
