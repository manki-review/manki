import * as core from '@actions/core';
import * as github from '@actions/github';

import { BotIdentity, checkConcurrentSubmissionLock, dismissPreviousReviews, fetchReviewThreadNodes, FOLLOW_UP_MARKER, isBotLogin, isReviewInProgress, markAutoApproveComplete, markProgressCommentFailed, postAutoApproveProgressComment } from './github';
import { isSecurityThread, mayClearSecurityThread, PreviousFinding, REOPENED_MARKER } from './recap';
import { FindingSeverity, isBlockingSeverity, migrateLegacySeverity, ReviewConfig, SEVERITY_TOKEN_PATTERN } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;
type ReviewEntry = { body?: string | null; state?: string; commit_id?: string | null; user?: { login?: string; type?: string } | null };

const BOT_MARKER = '<!-- manki -->';
const STALE_APPROVE_MARKER_PREFIX = '<!-- manki-stale-approve:';

function staleApproveMarker(headSha: string): string {
  return `${STALE_APPROVE_MARKER_PREFIX}${headSha} -->`;
}

interface ReviewThread {
  id: string;
  /** REST ID of the thread's first comment, which replies point at through `in_reply_to_id`. */
  rootCommentId?: number;
  isResolved: boolean;
  resolvedByLogin?: string;
  isBlocking: boolean;
  isSecurity?: boolean;
  findingTitle: string;
}

/**
 * Fetch all review threads `bot` started on a PR using GraphQL.
 * Returns threads with their resolution state and severity.
 */
async function fetchBotReviewThreads(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<ReviewThread[]> {
  const threads = await fetchReviewThreadNodes<{
    id: string;
    isResolved: boolean;
    resolvedBy?: { login: string } | null;
    comments: {
      nodes: Array<{
        databaseId?: number | null;
        body: string;
        author: { login: string } | null;
      }>;
    };
  }>(octokit, owner, repo, prNumber, `
    id
    isResolved
    resolvedBy {
      login
    }
    comments(first: 1) {
      nodes {
        databaseId
        body
        author {
          login
        }
      }
    }
  `);

  return threads
    .filter(thread => {
      const firstComment = thread.comments.nodes[0];
      return isBotLogin(bot, firstComment?.author?.login) &&
        (firstComment.body?.includes('manki:') || firstComment.body?.includes(BOT_MARKER));
    })
    .map(thread => {
      const body = thread.comments.nodes[0]?.body ?? '';
      const severityMatch = body.match(new RegExp(`<!-- manki:(${SEVERITY_TOKEN_PATTERN}):`));
      // A thread without a severity marker predates them, so it keeps blocking.
      const isBlocking = severityMatch?.[1]
        ? isBlockingSeverity(migrateLegacySeverity(severityMatch[1]) as FindingSeverity) && !body.includes(FOLLOW_UP_MARKER)
        : true;
      const titleMatch = body.match(/<!-- manki:\w+:(.+?) -->/);
      const findingTitle = titleMatch?.[1]?.replace(/-/g, ' ') ?? 'Unknown';

      const rootCommentId = thread.comments.nodes[0]?.databaseId;
      const resolvedByLogin = thread.resolvedBy?.login;
      return {
        id: thread.id,
        ...(rootCommentId != null && { rootCommentId }),
        isResolved: thread.isResolved,
        ...(resolvedByLogin && { resolvedByLogin }),
        isBlocking,
        ...(isSecurityThread(body) && { isSecurity: true }),
        findingTitle,
      };
    });
}

async function resolveReviewThread(octokit: Octokit, threadId: string): Promise<void> {
  await octokit.graphql('mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }', { threadId });
}

const REOPEN_REPLY = 'Reopened. A security finding needs a maintainer or a fix: the PR author cannot resolve it. '
  + 'A reviewer with write access can resolve it, or push a fix and Manki will check it.';

/** Reopens each security thread the PR author resolved and replies once to say why. */
async function reopenAuthorResolvedThreads(octokit: Octokit, previousFindings: PreviousFinding[]): Promise<void> {
  for (const f of previousFindings) {
    if (!f.reopen || !f.threadId) continue;
    // The reply goes first: its marker is what stops a later round from reopening the thread again.
    try {
      await octokit.graphql(
        'mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }',
        { threadId: f.threadId, body: `${BOT_MARKER}\n${REOPENED_MARKER}\n${REOPEN_REPLY}` },
      );
    } catch (error) {
      core.warning(`Failed to reply on security thread ${f.threadId}, leaving it resolved: ${error}`);
      continue;
    }
    try {
      await octokit.graphql('mutation($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }', { threadId: f.threadId });
      core.info(`Reopened security thread ${f.threadId} that the PR author resolved`);
    } catch (error) {
      core.warning(`Failed to reopen security thread ${f.threadId}: ${error}`);
    }
  }
}

/**
 * Check if every blocking bot review thread is resolved. Suggestion and nitpick
 * threads posted by older versions never block, matching the verdict's bar.
 * A resolved security thread counts only when Manki resolved it, which it does after the judge marks it
 * addressed or a maintainer agrees, or when `mayClearSecurityThread` accepts the resolver.
 */
function areAllFindingsResolved(threads: ReviewThread[], bot: BotIdentity, prAuthorLogin?: string): boolean {
  return threads.every(t => !t.isBlocking || (t.isResolved && (
    !t.isSecurity || isBotLogin(bot, t.resolvedByLogin) || mayClearSecurityThread(t.resolvedByLogin, bot, prAuthorLogin)
  )));
}

/**
 * Post a one-time explanatory comment when auto-approve is withheld because
 * manki has not actually reviewed the current HEAD. The comment is idempotent
 * per HEAD SHA via a `manki-stale-approve:<sha>` marker so repeated invocations
 * on the same HEAD do not spam the PR.
 */
async function postStaleApproveSkippedComment(
  octokit: Octokit,
  bot: BotIdentity,
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
      isBotLogin(bot, c.user?.login) &&
      c.body?.includes(marker)
    )) {
      core.info(`Stale-approve comment already present for ${headSha.slice(0, 7)} — skipping duplicate`);
      return;
    }
    const shortHead = headSha.slice(0, 7);
    const shortLatest = latestReviewSha.slice(0, 7);
    const body = [
      marker,
      `**Auto-approve withheld** for \`${shortHead}\` — all blocking review threads are resolved on the current HEAD, but manki has not reviewed this commit (latest manki review was on \`${shortLatest}\`).`,
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
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
  config?: ReviewConfig,
): Promise<boolean> {
  if (await checkConcurrentSubmissionLock(octokit, bot, owner, repo, prNumber, config)) {
    core.info('Skipping auto-approve — another run holds the in-progress lock');
    return false;
  }

  if (await isReviewInProgress(octokit, bot, owner, repo, prNumber)) {
    core.info('Skipping auto-approve — review in progress');
    return false;
  }

  const threads = await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber);

  const totalCount = threads.length;
  const resolvedCount = threads.filter(t => t.isResolved).length;

  core.info(`Review threads: ${resolvedCount}/${totalCount} resolved`);

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  if (!areAllFindingsResolved(threads, bot, pr.user?.login)) {
    core.info('Not all blocking findings resolved — skipping auto-approve');
    return false;
  }

  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const isBotReview = (r: ReviewEntry) => r.body?.includes('<!-- manki') && isBotLogin(bot, r.user?.login);
  const botReviews = reviews.filter((r: ReviewEntry) => isBotReview(r) && r.state !== 'DISMISSED');
  const latestBotReview = botReviews[botReviews.length - 1];

  // Stale-SHA gate: bail unless manki has actually submitted a non-DISMISSED
  // review on the current HEAD commit. This single check covers every variant —
  // stale prior review, absent commit_id, all reviews DISMISSED, or no bot
  // review at all.
  const hasReviewedHead = botReviews.some((r) => r.commit_id === pr.head.sha);
  if (!hasReviewedHead) {
    const staleSha =
      reviews.filter((r: ReviewEntry) => isBotReview(r) && r.commit_id !== pr.head.sha).slice(-1)[0]?.commit_id ?? 'unknown';
    core.warning(
      `Skipping auto-approve — manki has not reviewed HEAD (head=${pr.head.sha}, stale=${staleSha})`,
    );
    await postStaleApproveSkippedComment(octokit, bot, owner, repo, prNumber, pr.head.sha, staleSha);
    return false;
  }

  if (latestBotReview?.state === 'APPROVED') {
    core.info('Already approved — skipping duplicate approval');
    return true;
  }

  const progressCommentId = await postAutoApproveProgressComment(octokit, owner, repo, prNumber);

  core.info('All findings resolved — auto-approving');
  // A visible body so the API does not render this review as `body_length: 0`.
  // An empty review body trips the head-SHA dedupe gate (`hasBotReviewOnCommit`)
  // for any subsequent force-review tick on the same commit ([#840]).
  const body = `${BOT_MARKER}\n✅ **Approved.** All blocking threads are resolved.`;

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
      await dismissPreviousReviews(octokit, owner, repo, prNumber);
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
        body: `${BOT_MARKER}\nAll blocking threads are resolved, but repository settings block the approval. Enable "Allow GitHub Actions to create and approve pull requests" in the repo settings, or approve by hand.`,
      });
      core.info('Posted auto-approve permission notice as issue comment');
    }
  } catch (error) {
    const rawReason = error instanceof Error ? error.message : String(error);
    await markProgressCommentFailed(octokit, owner, repo, progressCommentId, 'Auto-approve', rawReason);
    throw error;
  }

  await markAutoApproveComplete(octokit, owner, repo, progressCommentId);
  return true;
}

export { ReviewThread, areAllFindingsResolved, checkAndAutoApprove, fetchBotReviewThreads, reopenAuthorResolvedThreads, resolveReviewThread, BOT_MARKER, STALE_APPROVE_MARKER_PREFIX };
