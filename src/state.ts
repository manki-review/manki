import * as core from '@actions/core';
import * as github from '@actions/github';

import { assertWritesAllowed } from './abort';
import { fetchPrState, reportPrState } from './auth';
import { completeReviewCheck, outcomeReport, startReviewCheck } from './check-run';
import { ApprovalHeld, approvalHoldLine, APPROVED_LINE, AUTO_APPROVE_MARKER, BotIdentity, BOT_MARKER as PROGRESS_MARKER, dismissPreviousReviews, fetchApprovalHold, fetchInterRoundDiff, fetchPRComments, fetchReviewThreadNodes, fetchStandingVerdict, PAUSE_NOTICE_MARKER, REVIEW_COMPLETE_MARKER, formatSecurityOverrides, isApprovalSettingRefusal, isBotLogin, isFailedProgressOn, isRepoAdmin, markAutoApproveComplete, markProgressCommentFailed, markProgressCommentSuperseded, postAutoApproveProgressComment } from './github';
import { SETTINGS_MARKER } from './settings';
import type { StandingVerdict } from './github';
import { isSameChange } from './diff';
import { fetchPriorRoundContexts, foundAgainAsBlocker, isOverrideCandidate, isSecurityThread, mayClearSecurityThread, PreviousFinding, RecapState, recordedSecurityOverride, REOPENED_MARKER, securityOverrideMarker, securityOverrideOf } from './recap';
import { migrateLegacySeverity, ReviewConfig, RoundContext, SecurityOverride, SEVERITY_TOKEN_PATTERN } from './types';
import { withMarkers } from './utils';

type Octokit = ReturnType<typeof github.getOctokit>;
type PullHead = { head: { sha: string }; base: { ref: string } };
type ReviewEntry = { body?: string | null; state?: string; commit_id?: string | null; user?: { login?: string; type?: string } | null };

const BOT_MARKER = '<!-- manki -->';
const STALE_APPROVE_MARKER_PREFIX = '<!-- manki-stale-approve:';
const APPROVAL_HELD_MARKER_PREFIX = '<!-- manki-approval-held:';

function staleApproveMarker(headSha: string): string {
  return `${STALE_APPROVE_MARKER_PREFIX}${headSha} -->`;
}

/**
 * Returns the standing verdict when the PR's own change at `commitSha` equals
 * the change at the reviewed commit, otherwise `undefined`. Both commits are
 * compared against `baseRef`, so a clean rebase or an empty commit matches.
 */
async function findUnchangedVerdict(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number,
  baseRef: string, commitSha: string, excludePaths: string[],
): Promise<StandingVerdict | undefined> {
  const standing = await fetchStandingVerdict(octokit, bot, owner, repo, prNumber);
  if (!standing || standing.commitSha === commitSha) return undefined;
  try {
    const [reviewed, current] = await Promise.all([
      fetchInterRoundDiff(octokit, owner, repo, baseRef, standing.commitSha),
      fetchInterRoundDiff(octokit, owner, repo, baseRef, commitSha),
    ]);
    if (!reviewed.trim() || !current.trim()) return undefined;
    return isSameChange(reviewed, current, excludePaths) ? standing : undefined;
  } catch (error) {
    core.warning(`Could not compare with the reviewed commit ${standing.commitSha.slice(0, 7)}: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

interface ReviewThread {
  id: string;
  /** REST ID of the thread's first comment, which replies point at through `in_reply_to_id`. */
  rootCommentId?: number;
  isResolved: boolean;
  resolvedByLogin?: string;
  isBlocking: boolean;
  isSecurity?: boolean;
  /** The override recorded in one of Manki's comments on this security thread. Trusted only after an admin check. */
  recordedOverride?: Omit<SecurityOverride, 'thread'>;
  findingTitle: string;
  /** URL of the thread's first comment. */
  threadUrl?: string;
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
        url?: string;
        author: { login: string } | null;
      }>;
    };
  }>(octokit, owner, repo, prNumber, `
    id
    isResolved
    resolvedBy {
      login
    }
    comments(first: 100) {
      nodes {
        databaseId
        body
        url
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
      const isSecurity = isSecurityThread(body);
      // A thread without a severity marker predates them, so it keeps blocking.
      const isBlocking = !severityMatch?.[1] || migrateLegacySeverity(severityMatch[1]) === 'blocker' || foundAgainAsBlocker(bot, thread.comments.nodes);
      const titleMatch = body.match(/<!-- manki:\w+:(.+?) -->/);
      const findingTitle = titleMatch?.[1]?.replace(/-/g, ' ') ?? 'Unknown';

      const rootCommentId = thread.comments.nodes[0]?.databaseId;
      const resolvedByLogin = thread.resolvedBy?.login;
      const threadUrl = thread.comments.nodes[0]?.url;
      const recordedOverride = isSecurity ? recordedSecurityOverride(bot, thread.comments.nodes) : undefined;
      return {
        id: thread.id,
        ...(rootCommentId != null && { rootCommentId }),
        isResolved: thread.isResolved,
        ...(resolvedByLogin && { resolvedByLogin }),
        isBlocking,
        ...(isSecurity && { isSecurity: true }),
        ...(recordedOverride && { recordedOverride }),
        findingTitle,
        ...(threadUrl && { threadUrl }),
      };
    });
}

/** Why a thread closed, as GitHub shows it on the resolved thread. */
type ResolutionReason = 'ADDRESSED' | 'INVALID' | 'WONT_FIX';

/** Resolves the review thread `threadId` with `resolutionReason`. Throws the abort reason once GitHub writes are stopped. */
async function resolveReviewThread(octokit: Octokit, threadId: string, resolutionReason: ResolutionReason): Promise<void> {
  assertWritesAllowed();
  await octokit.graphql(
    'mutation($threadId: ID!, $resolutionReason: PullRequestReviewThreadResolutionReason) { resolveReviewThread(input: { threadId: $threadId, resolutionReason: $resolutionReason }) { thread { isResolved } } }',
    { threadId, resolutionReason },
  );
}

async function unresolveReviewThread(octokit: Octokit, threadId: string): Promise<void> {
  assertWritesAllowed();
  await octokit.graphql('mutation($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }', { threadId });
}

/**
 * Posts `body` as a Manki reply in the review thread `threadId`. Pass any marker besides `BOT_MARKER` in `markers`.
 * Throws the abort reason once GitHub writes are stopped.
 */
async function replyToReviewThread(octokit: Octokit, threadId: string, body: string, ...markers: string[]): Promise<void> {
  assertWritesAllowed();
  await octokit.graphql(
    'mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }',
    { threadId, body: withMarkers(body, BOT_MARKER, ...markers) },
  );
}

const REOPEN_REPLY = 'Reopened. A security finding needs a maintainer or a fix: the PR author cannot resolve it. '
  + 'A reviewer with write access can resolve it, or push a fix and Manki will check it.';
const PAUSED_REOPEN_REPLY = 'Reopened. A security finding needs a maintainer or a fix: the PR author cannot resolve it. '
  + 'A reviewer with write access can resolve it. Automatic review is paused, so after pushing a fix comment `@manki review` and Manki will check it.';

/** Reopens each security thread the PR author resolved and replies once to say why. While `paused`, the reply says a push alone is not reviewed. */
async function reopenAuthorResolvedThreads(octokit: Octokit, previousFindings: PreviousFinding[], paused = false): Promise<void> {
  for (const f of previousFindings) {
    if (!f.reopen || !f.threadId) continue;
    // The reply goes first: its marker is what stops a later round from reopening the thread again.
    try {
      await replyToReviewThread(octokit, f.threadId, paused ? PAUSED_REOPEN_REPLY : REOPEN_REPLY, REOPENED_MARKER);
    } catch (error) {
      core.warning(`Failed to reply on security thread ${f.threadId}, leaving it resolved: ${error}`);
      continue;
    }
    try {
      await unresolveReviewThread(octokit, f.threadId);
      core.info(`Reopened security thread ${f.threadId} that the PR author resolved`);
    } catch (error) {
      core.warning(`Failed to reopen security thread ${f.threadId}: ${error}`);
    }
  }
}

/**
 * Replies once on each thread to record a security override. The reply's marker is what later rounds read the override from.
 * Returns the overrides it could record.
 */
async function announceSecurityOverrides(octokit: Octokit, overrides: SecurityOverride[]): Promise<SecurityOverride[]> {
  const announced: SecurityOverride[] = [];
  for (const o of overrides) {
    try {
      await replyToReviewThread(octokit, o.thread, `Security finding dismissed by @${o.login} (repo admin).`, securityOverrideMarker(o.via, o.login));
      announced.push(o);
      core.info(`Recorded the security override by ${o.login} on thread ${o.thread}`);
    } catch (error) {
      core.warning(`Failed to record the security override on thread ${o.thread}: ${error}`);
    }
  }
  return announced;
}

/**
 * Check if every blocking bot review thread is resolved. Suggestion and nitpick
 * threads posted by older versions never block, matching the verdict's bar.
 * A resolved security thread counts only when Manki resolved it, which it does after the judge marks it
 * addressed or a maintainer agrees, when `mayClearSecurityThread` accepts the resolver,
 * or when the PR author resolved it as a repo admin (`prAuthorIsAdmin`).
 */
function areAllFindingsResolved(threads: ReviewThread[], bot: BotIdentity, prAuthorLogin?: string, prAuthorIsAdmin = false): boolean {
  return threads.every(t => !t.isBlocking || (t.isResolved && (
    !t.isSecurity || isBotLogin(bot, t.resolvedByLogin) || mayClearSecurityThread(t.resolvedByLogin, bot, prAuthorLogin)
    || !!securityOverrideOf(t, prAuthorLogin, prAuthorIsAdmin)
  )));
}

/** The change a round reviews: its commit, and the `changeDigest` of its diff when known. */
interface ReviewedChange {
  commitSha: string;
  changeDigest?: string;
}

/** Whether `change` differs from the change `previous` reviewed. A round recorded without a digest is compared by commit. */
function isNewChange(change: ReviewedChange, previous: RoundContext | undefined): boolean {
  if (!previous) return true;
  const before = previous.diff?.changeDigest;
  return change.changeDigest && before ? change.changeDigest !== before : change.commitSha !== previous.meta.commitSha;
}

/**
 * Whether the PR was approved at or after `round`: by the round itself, or by auto-approve at `lastApprovalAt` or later.
 * An approval held on a conflict is recorded as an approval, so it counts.
 */
function approvedSince(round: RoundContext, lastApprovalAt: string | undefined): boolean {
  return round.verdict === 'APPROVE'
    || (lastApprovalAt !== undefined && Date.parse(round.meta.timestamp) <= Date.parse(lastApprovalAt));
}

/**
 * Returns how many rounds reviewed a new change since the last approval, or in all rounds without one. Draft rounds don't count.
 * The round cap stops fix loops, so a round after an approval, such as on a rebase, starts the count again.
 */
function roundsSinceApproval(priorRounds: RoundContext[], lastApprovalAt: string | undefined): { count: number; approved: boolean } {
  let count = 0;
  for (let i = priorRounds.length - 1; i >= 0; i--) {
    const round = priorRounds[i];
    if (approvedSince(round, lastApprovalAt)) return { count, approved: true };
    if (!round.meta.draft && isNewChange({ commitSha: round.meta.commitSha, changeDigest: round.diff?.changeDigest }, priorRounds[i - 1])) count++;
  }
  return { count, approved: lastApprovalAt !== undefined };
}

interface PauseState {
  capRounds: number;
  capReached: boolean;
  paused: boolean;
  /** Why automatic review is paused, as a sentence for the PR. Set only while `paused`. */
  reason?: string;
}

/**
 * Returns the rounds with new changes since the last approval, whether they reach the round cap, and whether automatic review
 * is paused by it or by a last round that ended `NOT_CONVERGING` with no approval since.
 */
function pauseState({ priorRounds, lastApprovalAt }: Pick<RecapState, 'priorRounds' | 'lastApprovalAt'>, config: ReviewConfig): PauseState {
  const maxAutoRounds = config.convergence?.max_auto_rounds ?? 0;
  const { count: capRounds, approved } = roundsSinceApproval(priorRounds, lastApprovalAt);
  const capReached = maxAutoRounds > 0 && capRounds >= maxAutoRounds;
  const lastRound = priorRounds.at(-1);
  const reason = capReached
    ? `Manki has reviewed new changes in ${capRounds}/${maxAutoRounds} rounds on this PR${approved ? ' since its last approval' : ''}.`
    : lastRound?.meta.outcome === 'NOT_CONVERGING' && !approvedSince(lastRound, lastApprovalAt) ? 'The last Manki round found a blocker that came back after a fix.' : undefined;
  return { capRounds, capReached, paused: reason !== undefined, ...(reason && { reason }) };
}

/** Returns why no automatic review will run on a new head commit, with how to start one, or `undefined` when a push review will run. */
async function autoReviewHalt(octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, config: ReviewConfig): Promise<string | undefined> {
  if (!config.auto_review) {
    return 'Automatic review is off for this repository (`auto_review: false`). Comment `@manki review` to review it.';
  }
  if ((await fetchPrState(owner, repo, prNumber, github.context.runId))?.settings.paused) {
    return 'Automatic review is paused in the settings block. Untick **Pause automatic reviews** there, or comment `@manki review`, to review it.';
  }
  const { reason } = pauseState(await fetchPriorRoundContexts(octokit, bot, owner, repo, prNumber), config);
  return reason && `${reason} Automatic review is paused. Tick **Force review** in the settings block, or comment \`@manki review\`, to review it.`;
}

function isBotReview(bot: BotIdentity, r: ReviewEntry): boolean {
  return !!r.body?.includes('<!-- manki') && isBotLogin(bot, r.user?.login);
}

/**
 * Whether a Manki review covers the head of `pr`. That is a review on the head that is not dismissed,
 * or the standing verdict on a commit whose PR diff equals the head's, as after a rebase.
 */
async function reviewCoversHead(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number,
  pr: PullHead, reviews: ReviewEntry[], config?: ReviewConfig,
): Promise<boolean> {
  if (reviews.some(r => isBotReview(bot, r) && r.state !== 'DISMISSED' && r.commit_id === pr.head.sha)) return true;
  const standing = await findUnchangedVerdict(octokit, bot, owner, repo, prNumber, pr.base.ref, pr.head.sha, config?.exclude_paths ?? []);
  if (standing) core.info(`No change since the reviewed commit ${standing.commitSha.slice(0, 7)}, so its review covers ${pr.head.sha.slice(0, 7)}`);
  return !!standing;
}

/** Returns why auto-approve has to wait because no Manki review covers the head yet, or `undefined` when one does. */
async function explainUnreviewedHead(octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, config?: ReviewConfig): Promise<string | undefined> {
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const head = `\`${pr.head.sha.slice(0, 7)}\``;
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 });
  if (await reviewCoversHead(octokit, bot, owner, repo, prNumber, pr, reviews, config)) return undefined;
  const halt = config && await autoReviewHalt(octokit, bot, owner, repo, prNumber, config);
  return halt
    ? `Manki has not reviewed ${head}. ${halt}`
    : `Manki has not reviewed ${head} yet. A push review should start shortly, and approval follows from its verdict.`;
}

/** Posts `text` as a comment carrying `marker`, unless a Manki comment with `marker` is already on the PR. */
async function postNoticeOnce(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, marker: string, text: string,
): Promise<void> {
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  if (existing.some(c => isBotLogin(bot, c.user?.login) && c.body?.includes(marker))) {
    core.info(`Notice ${marker} already present, skipping duplicate`);
    return;
  }
  await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: withMarkers(text, marker) });
}

/**
 * Posts a one-time comment that auto-approve is withheld because Manki has not reviewed `headSha`,
 * and no automatic review will. `halt` says why and how to start one.
 * The `manki-stale-approve:<sha>` marker keeps it to one comment per head commit.
 */
async function postStaleApproveSkippedComment(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  latestReviewSha: string,
  halt: string,
): Promise<void> {
  const shortHead = headSha.slice(0, 7);
  const shortLatest = latestReviewSha.slice(0, 7);
  const text = [
    `**Auto-approve withheld** for \`${shortHead}\`: all blocking review threads are resolved, but Manki has not reviewed this commit. Its latest review was on \`${shortLatest}\`.`,
    '',
    halt,
  ].join('\n');
  try {
    await postNoticeOnce(octokit, bot, owner, repo, prNumber, staleApproveMarker(headSha), text);
  } catch (error) {
    core.warning(`Failed to post stale-approve-skipped comment: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Returns why the PR's approval must be held now, a draft or a conflict with its base, and posts one
 * notice per head saying so. Returns `false` when it may be approved. `draftWhenUnread` decides when the PR can't be read.
 */
async function holdApproval(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, headSha: string, draftWhenUnread = false,
): Promise<ApprovalHeld> {
  const hold = await fetchApprovalHold(octokit, owner, repo, prNumber, draftWhenUnread);
  if (!hold) return false;
  core.info(`${hold.reason === 'conflict' ? `PR conflicts with ${hold.baseRef}` : 'The PR is a draft'}, so it is not approved`);
  assertWritesAllowed();
  try {
    await postNoticeOnce(octokit, bot, owner, repo, prNumber, `${APPROVAL_HELD_MARKER_PREFIX}${headSha} -->`, approvalHoldLine(hold));
  } catch (error) {
    core.warning(`Failed to post the approval-held notice: ${error instanceof Error ? error.message : error}`);
  }
  return hold.reason;
}

/**
 * Deletes the auto-approve withheld notice for `headSha` and every approval-held notice. Call it once a review posts its verdict on `headSha`.
 * Marks each failed or incomplete progress comment for `headSha` as superseded by that verdict.
 * With `pauseLifted`, when that round lifted the pause, each pause notice that lost its settings block is marked as resumed.
 */
async function retireStaleNotices(octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, headSha: string, pauseLifted = false): Promise<void> {
  let comments: Awaited<ReturnType<typeof fetchPRComments>>;
  try {
    comments = await fetchPRComments(octokit, owner, repo, prNumber);
  } catch (error) {
    core.warning(`Failed to look up stale notices: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const marker = staleApproveMarker(headSha);
  for (const c of comments) {
    if (!isBotLogin(bot, c.user?.login) || !c.body) continue;
    try {
      if (c.body.includes(marker) || c.body.includes(APPROVAL_HELD_MARKER_PREFIX)) {
        await octokit.rest.issues.deleteComment({ owner, repo, comment_id: c.id });
      } else if (isFailedProgressOn(c.body, headSha)) {
        await markProgressCommentSuperseded(octokit, owner, repo, c.id, { reviewedSha: headSha, headSha });
      } else if (pauseLifted && c.body.includes(PAUSE_NOTICE_MARKER) && !c.body.includes(SETTINGS_MARKER)) {
        const body = withMarkers(`Automatic review was paused. Review resumed on \`${headSha.slice(0, 7)}\`.`, PROGRESS_MARKER, REVIEW_COMPLETE_MARKER);
        await octokit.rest.issues.updateComment({ owner, repo, comment_id: c.id, body });
      }
    } catch (error) {
      core.warning(`Failed to retire stale notice ${c.id}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/** Post an approval review if all findings are resolved. */
async function checkAndAutoApprove(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
  config?: ReviewConfig,
): Promise<boolean> {
  const threads = await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber);

  const totalCount = threads.length;
  const resolvedCount = threads.filter(t => t.isResolved).length;

  core.info(`Review threads: ${resolvedCount}/${totalCount} resolved`);

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  if (pr.draft) {
    core.info('Skipping auto-approve — the PR is a draft');
    return false;
  }

  const prAuthorLogin = pr.user?.login;
  const prAuthorIsAdmin = !!prAuthorLogin && threads.some(t => isOverrideCandidate(t, prAuthorLogin))
    && await isRepoAdmin(octokit, owner, repo, prAuthorLogin);
  const overrides = threads.flatMap(t => {
    const o = securityOverrideOf(t, prAuthorLogin, prAuthorIsAdmin);
    return o ? [{ ...o, thread: t.id, title: t.findingTitle, threadUrl: t.threadUrl }] : [];
  });
  await announceSecurityOverrides(octokit, overrides.filter(o => !o.announced));

  if (!areAllFindingsResolved(threads, bot, prAuthorLogin, prAuthorIsAdmin)) {
    core.info('Not all blocking findings resolved — skipping auto-approve');
    return false;
  }

  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: prNumber,
    per_page: 100,
  });
  const botReviews = reviews.filter((r: ReviewEntry) => isBotReview(bot, r) && r.state !== 'DISMISSED');
  const latestBotReview = botReviews[botReviews.length - 1];

  // Stale-SHA gate: bail unless a Manki review covers the current HEAD. This covers
  // every variant: stale prior review, absent commit_id, all reviews DISMISSED, or
  // no bot review at all.
  if (!await reviewCoversHead(octokit, bot, owner, repo, prNumber, pr, reviews, config)) {
    const staleSha =
      reviews.filter((r: ReviewEntry) => isBotReview(bot, r) && r.commit_id !== pr.head.sha).slice(-1)[0]?.commit_id ?? 'unknown';
    core.warning(
      `Skipping auto-approve — manki has not reviewed HEAD (head=${pr.head.sha}, stale=${staleSha})`,
    );
    // A push review takes about a minute to post its progress comment, so the lack of one does not mean no review is coming.
    const halt = config && await autoReviewHalt(octokit, bot, owner, repo, prNumber, config);
    if (halt) {
      await postStaleApproveSkippedComment(octokit, bot, owner, repo, prNumber, pr.head.sha, staleSha, halt);
    } else {
      core.info(`A push review covers ${pr.head.sha.slice(0, 7)}, so no withheld notice is posted`);
    }
    return false;
  }

  if (latestBotReview?.state === 'APPROVED') {
    core.info('Already approved — skipping duplicate approval');
    return true;
  }

  if (await holdApproval(octokit, bot, owner, repo, prNumber, pr.head.sha)) {
    await reportPrState(owner, repo, prNumber, { approval: { commit: pr.head.sha, held: true } });
    return false;
  }

  const progressCommentId = await postAutoApproveProgressComment(octokit, owner, repo, prNumber);

  core.info('All findings resolved — auto-approving');
  // A visible body so the API does not render this review as `body_length: 0`.
  // An empty review body trips the head-SHA dedupe gate (`hasBotReviewOnCommit`)
  // for any subsequent force-review tick on the same commit ([#840]).
  const overrideLine = formatSecurityOverrides(overrides);
  const body = withMarkers(`${APPROVED_LINE} All blocking threads are resolved.${overrideLine ? `\n\n${overrideLine}` : ''}`, BOT_MARKER, AUTO_APPROVE_MARKER);

  try {
    try {
      assertWritesAllowed();
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: pr.head.sha,
        event: 'APPROVE',
        body,
      });
      core.info('Auto-approved PR');
      // An approval ends the pause, so the coordinator again starts push reviews.
      await reportPrState(owner, repo, prNumber, { approval: { commit: pr.head.sha, held: false }, pause: null });
      await dismissPreviousReviews(octokit, owner, repo, prNumber);
      await completeReviewCheck(await startReviewCheck(octokit, owner, repo, pr.head.sha), outcomeReport('READY', 'All blocking threads are resolved.'));
    } catch (error) {
      if (!isApprovalSettingRefusal(error)) throw error;
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
        body: withMarkers('All blocking threads are resolved, but repository settings block the approval. Enable "Allow GitHub Actions to create and approve pull requests" in the repo settings, or approve by hand.', BOT_MARKER),
      });
      core.info('Posted auto-approve permission notice as issue comment');
    }
  } catch (error) {
    // A cancelled run leaves its progress comment to the post step.
    assertWritesAllowed();
    const rawReason = error instanceof Error ? error.message : String(error);
    await markProgressCommentFailed(octokit, owner, repo, progressCommentId, 'Auto-approve', rawReason);
    throw error;
  }

  await markAutoApproveComplete(octokit, owner, repo, progressCommentId);
  return true;
}

export { PauseState, ResolutionReason, ReviewThread, announceSecurityOverrides, areAllFindingsResolved, checkAndAutoApprove, explainUnreviewedHead, fetchBotReviewThreads, findUnchangedVerdict, holdApproval, isNewChange, pauseState, reopenAuthorResolvedThreads, replyToReviewThread, resolveReviewThread, retireStaleNotices, unresolveReviewThread, BOT_MARKER, STALE_APPROVE_MARKER_PREFIX };
