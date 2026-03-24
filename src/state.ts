import * as core from '@actions/core';
import * as github from '@actions/github';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- claude-review -->';

interface ReviewThread {
  id: string;
  isResolved: boolean;
  isBlocking: boolean;
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
      return firstComment?.body?.includes('claude-review:') || firstComment?.body?.includes(BOT_MARKER);
    })
    .map(thread => {
      const body = thread.comments.nodes[0]?.body ?? '';
      const blockingMatch = body.match(/<!-- claude-review:(blocking|suggestion|question):/);
      const isBlocking = blockingMatch?.[1] === 'blocking';
      const titleMatch = body.match(/<!-- claude-review:\w+:(.+?) -->/);
      const findingTitle = titleMatch?.[1]?.replace(/-/g, ' ') ?? 'Unknown';

      return {
        id: thread.id,
        isResolved: thread.isResolved,
        isBlocking,
        findingTitle,
      };
    });
}

/**
 * Check if all blocking threads are resolved.
 */
function areAllBlockingResolved(threads: ReviewThread[]): boolean {
  const blockingThreads = threads.filter(t => t.isBlocking);
  if (blockingThreads.length === 0) return true;
  return blockingThreads.every(t => t.isResolved);
}

/**
 * Post an approval review if all blocking issues are resolved.
 */
async function checkAndAutoApprove(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  const threads = await fetchBotReviewThreads(octokit, owner, repo, prNumber);

  const blockingCount = threads.filter(t => t.isBlocking).length;
  const resolvedBlockingCount = threads.filter(t => t.isBlocking && t.isResolved).length;

  core.info(`Blocking threads: ${resolvedBlockingCount}/${blockingCount} resolved`);

  if (!areAllBlockingResolved(threads)) {
    core.info('Not all blocking issues resolved — skipping auto-approve');
    return false;
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: pr.head.sha,
    event: 'APPROVE',
    body: `${BOT_MARKER}\nAll blocking issues have been resolved. Auto-approving.`,
  });

  core.info('Auto-approved PR');
  return true;
}

export { ReviewThread, areAllBlockingResolved, checkAndAutoApprove, fetchBotReviewThreads, BOT_MARKER };
