import * as core from '@actions/core';
import * as github from '@actions/github';

import { ACTIONS_BOT_LOGIN, BOT_LOGIN, checkConcurrentSubmissionLock, dismissPreviousReviews, isReviewInProgress, markAutoApproveComplete, markAutoApproveFailed, postAutoApproveProgressComment } from './github';
import { migrateLegacySeverity, ReviewConfig, SEVERITY_TOKEN_PATTERN } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- manki -->';
const STALE_APPROVE_MARKER_PREFIX = '<!-- manki-stale-approve:';

function staleApproveMarker(headSha: string): string {
  return `${STALE_APPROVE_MARKER_PREFIX}${headSha} -->`;
}

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
 * Post a one-time explanatory comment when auto-approve is withheld because
 * manki has not actually reviewed the current HEAD. The comment is idempotent
 * per HEAD SHA via a `manki-stale-approve:<sha>` marker so repeated invocations
 * on the same HEAD do not spam the PR.
 */
async function postStaleApproveSkippedComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  latestReviewSha: string,
): Promise<void> {
  const marker = staleApproveMarker(headSha);
  try {
    const existing = await octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number: prNumber, per_page: 100,
    });
    if (existing.some(c =>
      (c.user?.login === BOT_LOGIN || c.user?.login === ACTIONS_BOT_LOGIN) &&
      c.body?.includes(marker)
    )) {
      core.info(`Stale-approve comment already present for ${headSha.slice(0, 7)} — skipping duplicate`);
      return;
    }
    const shortHead = headSha.slice(0, 7);
    const shortLatest = latestReviewSha.slice(0, 7);
    const body = [
      marker,
      `**Auto-approve withheld** for \`${shortHead}\` — all review threads are resolved on the current HEAD, but manki has not reviewed this commit (latest manki review was on \`${shortLatest}\`).`,
      '',
      'To approve, request a fresh review by commenting `@manki review` or by ticking the **Force review** checkbox on the latest progress comment.',
    ].join('\n');
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  } catch (error) {
    core.warning(`Failed to post stale-approve-skipped comment: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Post an approval review if all findings are resolved.
 *
 * Two concurrency guards run before any review is posted. First the TTL-based
 * `checkConcurrentSubmissionLock` scans for a fresh in-progress marker from a
 * different run, which protects against the Actions-API failure mode in
 * `isReviewInProgress` (the bot identity often lacks `actions:read`, so its
 * catch path fails open and would otherwise let an APPROVED race land on top
 * of a parallel CHANGES_REQUESTED). The original `isReviewInProgress` check
 * runs afterward as belt-and-suspenders.
 */
async function checkAndAutoApprove(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  config?: ReviewConfig,
): Promise<boolean> {
  if (await checkConcurrentSubmissionLock(octokit, owner, repo, prNumber, config)) {
    core.info('Skipping auto-approve — another run holds the in-progress lock');
    return false;
  }

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

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  // Stale-SHA guard: third-party thread replies fire `pull_request_review`
  // events with `commit_id = head.sha`, which pass the event-level stale check
  // in `handleReviewStateCheck`. Without this guard the function would issue an
  // APPROVED review on HEAD even though manki has never actually reviewed HEAD.
  // Bail when the latest non-DISMISSED bot review's `commit_id` is absent or
  // differs from the current head SHA. This check must run before the APPROVED
  // early-return so a stale approval cannot bypass the guard.
  const latestBotReviewSha = (latestBotReview as { commit_id?: string } | undefined)?.commit_id;
  if (latestBotReview) {
    if (!latestBotReviewSha) {
      core.warning(
        `Skipping auto-approve — commit_id absent on latest manki review (head=${pr.head.sha}); cannot verify HEAD coverage`,
      );
      return false;
    }
    if (latestBotReviewSha !== pr.head.sha) {
      core.warning(
        `Skipping auto-approve — manki has not reviewed HEAD (head=${pr.head.sha}, latest_manki_review=${latestBotReviewSha})`,
      );
      await postStaleApproveSkippedComment(octokit, owner, repo, prNumber, pr.head.sha, latestBotReviewSha);
      return false;
    }
  }

  if (latestBotReview?.state === 'APPROVED') {
    core.info('Already approved — skipping duplicate approval');
    return true;
  }

  const progressCommentId = await postAutoApproveProgressComment(octokit, owner, repo, prNumber);

  try {
    await dismissPreviousReviews(octokit, owner, repo, prNumber);
  } catch (error) {
    core.warning(`Failed to dismiss previous reviews during auto-approve: ${error}`);
  }

  core.info('All findings resolved — auto-approving');
  // A visible body so the API does not render this review as `body_length: 0`.
  // An empty review body trips the head-SHA dedupe gate (`hasBotReviewOnCommit`)
  // for any subsequent force-review tick on the same commit ([#840]).
  const body = `${BOT_MARKER}\n**Manki** — Auto-approved (all findings resolved).`;

  try {
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
      // Do not fall back to a `COMMENT` review here. A `COMMENT` placeholder
      // with this body would still register as a bot review on the head SHA
      // and break the force-review tickbox loop ([#840]). Surface the missing
      // permission via an issue comment instead, which carries no review state.
      core.warning(
        'Failed to auto-approve PR. Ensure "Allow GitHub Actions to create and approve pull requests" is enabled in repo settings.',
      );
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: `${BOT_MARKER}\n**Manki** — All findings are resolved but auto-approve is blocked by repository settings. Enable "Allow GitHub Actions to create and approve pull requests" in repo settings, or approve manually.`,
      });
      core.info('Posted auto-approve permission notice as issue comment');
    }
  } catch (error) {
    const rawReason = error instanceof Error ? error.message : String(error);
    await markAutoApproveFailed(octokit, owner, repo, progressCommentId, rawReason);
    throw error;
  }

  await markAutoApproveComplete(octokit, owner, repo, progressCommentId);
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

export { ReviewThread, areAllFindingsResolved, checkAndAutoApprove, fetchBotReviewThreads, resolveStaleThreads, BOT_MARKER, STALE_APPROVE_MARKER_PREFIX };
