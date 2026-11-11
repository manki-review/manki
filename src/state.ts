import * as core from '@actions/core';
import * as github from '@actions/github';

import { assertWritesAllowed } from './abort';
import { changeThreadThroughService, fetchPrState, reportPrState } from './auth';
import { completeReviewCheck, outcomeReport, startReviewCheck } from './check-run';
import { ApprovalHeld, approvalHoldLine, APPROVED_LINE, AUTO_APPROVE_MARKER, BotIdentity, BOT_MARKER as PROGRESS_MARKER, dismissPreviousReviews, fetchApprovalHold, fetchBlobShas, fetchInterRoundDiff, fetchPRComments, HELD_FOR_PERSON_MARKER, inline, NO_VERDICT_MARKER, sanitizeMarkdown, fetchReviewThreadNodes, fetchStandingVerdict, MANKI_VERSION, PAUSE_NOTICE_MARKER, REVIEW_COMPLETE_MARKER, formatSecurityOverrides, isApprovalSettingRefusal, isBotLogin, isFailedProgress, authorClearRole, deleteAutoApproveProgressComment, markProgressCommentFailed, markProgressCommentSuperseded, postAutoApproveProgressComment } from './github';
import { SETTINGS_MARKER } from './settings';
import type { StandingVerdict } from './github';
import { compareChanges } from './diff';
import { fetchPriorRoundContexts, fetchRecapState, isOverrideCandidate, latestPersonReply, parseContextBlocks, recordedThreadGrades, isSecurityThread, parseFindingData, RecapState, recordedSecurityOverride, REOPENED_MARKER, securityOverrideMarker, securityOverrideOf, resolveBacking, settledBy, threadMarkerSlug, threadSeverity, findingFile } from './recap';
import { formatApprovalRecord, hasOwnMarker, hasReviewRecord } from './review-record';
import { findPriorThreadId } from './finding-fingerprint';
import { ApprovalRecord, AuthorClearRole, ReviewConfig, RoundContext, SecurityOverride, threadBlocks } from './types';
import { COMMENT_MARKER as BOT_MARKER, ownMarker, withMarkers } from './utils';

type Octokit = ReturnType<typeof github.getOctokit>;
type PullHead = { head: { sha: string }; base: { ref: string } };
type ReviewEntry = { id: number; body?: string | null; state?: string; commit_id?: string | null; user?: { login?: string; type?: string } | null };

const STALE_APPROVE_MARKER_PREFIX = '<!-- manki-stale-approve:';
const APPROVAL_HELD_MARKER_PREFIX = '<!-- manki-approval-held:';
/** Marks the token service's note that a PR conflicting with its base waits for a rebase before Manki reviews it. */
const CONFLICT_NOTE_MARKER = '<!-- manki-conflict-note -->';

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
  baseRef: string, commitSha: string,
): Promise<StandingVerdict | undefined> {
  const standing = await fetchStandingVerdict(octokit, bot, owner, repo, prNumber);
  if (!standing || standing.commitSha === commitSha) return undefined;
  try {
    const [reviewed, current] = await Promise.all([
      fetchInterRoundDiff(octokit, owner, repo, baseRef, standing.commitSha),
      fetchInterRoundDiff(octokit, owner, repo, baseRef, commitSha),
    ]);
    if (!reviewed.trim() || !current.trim()) return undefined;
    const { same, binaries } = compareChanges(reviewed, current);
    if (!same) return undefined;
    if (binaries.length === 0) return standing;
    const [reviewedShas, currentShas] = await Promise.all([
      fetchBlobShas(octokit, owner, repo, baseRef, standing.commitSha),
      fetchBlobShas(octokit, owner, repo, baseRef, commitSha),
    ]);
    return binaries.every(f => reviewedShas.has(f.path) && reviewedShas.get(f.path) === currentShas.get(f.path)) ? standing : undefined;
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
  /** The latest round that evaluated the thread marked it addressed. */
  addressed?: boolean;
  /** Who wrote the latest reply by a person, when that person has write access. Read only for a thread Manki resolved, and only below the comment limit. */
  writerReplyLogin?: string;
  /** Set on a thread Manki resolved that is at the comment limit, so its latest reply is unknown. */
  repliesUnread?: boolean;
  isBlocking: boolean;
  isSecurity?: boolean;
  /** The override recorded in one of Manki's comments on this blocking or security thread. Trusted only after `authorClearRole` confirms the role. */
  recordedOverride?: Omit<SecurityOverride, 'thread'>;
  findingTitle: string;
  /** Where the thread was posted, for which finding and on which commit. Absent for a thread without a finding marker. */
  place?: { file: string; line: number; originalLine?: number; findingLine?: number; markerSlug: string; commit?: string };
  /** URL of the thread's first comment. */
  threadUrl?: string;
  /** The head commits on which a Manki reply in this thread confirmed the fix, from `fixedMarker`. */
  fixedOn?: string[];
}

const FIXED_MARKER_OPENER = '<!-- manki-fixed:';

/** Marks Manki's reply that confirms a fix on `commitSha`, so a thread gets one such reply per head. */
function fixedMarker(commitSha: string): string {
  return `${FIXED_MARKER_OPENER}${commitSha} -->`;
}

const THREAD_COMMENTS_LIMIT = 100;

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
    path?: string | null;
    line?: number | null;
    originalLine?: number | null;
    comments: {
      nodes: Array<{
        databaseId?: number | null;
        body: string;
        url?: string;
        author: { login: string } | null;
        originalCommit?: { oid: string } | null;
      }>;
    };
  }>(octokit, owner, repo, prNumber, `
    id
    isResolved
    resolvedBy {
      login
    }
    path
    line
    originalLine
    comments(first: ${THREAD_COMMENTS_LIMIT}) {
      nodes {
        databaseId
        body
        url
        author {
          login
        }
        originalCommit {
          oid
        }
      }
    }
  `);

  const botThreads = threads.filter(thread => {
    const firstComment = thread.comments.nodes[0];
    return isBotLogin(bot, firstComment?.author?.login) &&
      (firstComment.body?.includes('manki:') || firstComment.body?.includes(BOT_MARKER));
  });
  // The round records hold each thread's grade, which also decides who may clear a resolved thread.
  const records = botThreads.length > 0 ? await fetchPriorRoundContexts(octokit, bot, owner, repo, prNumber) : { priorRounds: [] };
  const grades = recordedThreadGrades(records.priorRounds);
  // Only Manki's own resolve needs a replier to back it. A thread at the comment limit may hide a later reply, so it names none.
  const byManki = (thread: typeof botThreads[number]) => thread.isResolved && isBotLogin(bot, thread.resolvedBy?.login);
  const repliesUnread = (thread: typeof botThreads[number]) => byManki(thread) && thread.comments.nodes.length >= THREAD_COMMENTS_LIMIT;
  const backing = await resolveBacking(octokit, owner, repo, records.priorRounds, botThreads.map(thread => {
    const replier = byManki(thread) && !repliesUnread(thread) ? latestPersonReply(bot, thread.comments.nodes)?.author?.login : undefined;
    return { id: thread.id, ...(replier && { latestReplyLogin: replier }) };
  }));
  if ('priorRoundsIncomplete' in records) core.warning('Without every round record, every Manki thread counts as blocking');
  return botThreads
    .map(thread => {
      const body = thread.comments.nodes[0]?.body ?? '';
      const severity = threadSeverity(body);
      const isSecurity = isSecurityThread(body);
      const recorded = grades.get(thread.id)?.grade;
      // An unreadable record could hide a raise, so the thread blocks rather than let auto-approve pass it.
      const isBlocking = 'priorRoundsIncomplete' in records || threadBlocks({ severity, ...(recorded && { recordedGrade: recorded }), isSecurity });
      // The marker's slug turned every other character into a hyphen, so the finding data keeps the real title.
      const markerSlug = threadMarkerSlug(body);
      const data = parseFindingData(body);
      const findingTitle = data?.title?.trim() || (markerSlug?.replace(/-/g, ' ') ?? 'Unknown');
      const file = findingFile(body, thread.path);
      const findingLine = data && data.file === file ? data.line : undefined;
      const commit = thread.comments.nodes[0]?.originalCommit?.oid;
      const place = thread.path && markerSlug ? {
        file, line: thread.line ?? 0, markerSlug,
        ...(thread.originalLine && { originalLine: thread.originalLine }), ...(findingLine && { findingLine }), ...(commit && { commit }),
      } : undefined;

      const rootCommentId = thread.comments.nodes[0]?.databaseId;
      const resolvedByLogin = thread.resolvedBy?.login;
      const threadUrl = thread.comments.nodes[0]?.url;
      const recordedOverride = isSecurity || isBlocking ? recordedSecurityOverride(bot, thread.comments.nodes) : undefined;
      const fixedOn = thread.comments.nodes.slice(1).flatMap(c => {
        const sha = isBotLogin(bot, c.author?.login) ? ownMarker(c.body ?? '', FIXED_MARKER_OPENER, BOT_MARKER)?.match(/^[0-9a-f]{40}$/)?.[0] : undefined;
        return sha ? [sha] : [];
      });
      return {
        id: thread.id,
        ...(rootCommentId != null && { rootCommentId }),
        isResolved: thread.isResolved,
        ...(resolvedByLogin && { resolvedByLogin }),
        ...backing.get(thread.id),
        ...(repliesUnread(thread) && { repliesUnread: true }),
        isBlocking,
        ...(isSecurity && { isSecurity: true }),
        ...(recordedOverride && { recordedOverride }),
        findingTitle,
        ...(place && { place }),
        ...(threadUrl && { threadUrl }),
        ...(fixedOn.length > 0 && { fixedOn }),
      };
    });
}

/** Why a thread closed, as GitHub shows it on the resolved thread. */
type ResolutionReason = 'ADDRESSED' | 'INVALID' | 'WONT_FIX';

/** Resolves the review thread `threadId` with `resolutionReason`. Throws the abort reason once GitHub writes are stopped. */
async function resolveReviewThread(octokit: Octokit, threadId: string, resolutionReason: ResolutionReason): Promise<void> {
  assertWritesAllowed();
  if (await changeThreadThroughService(octokit, threadId, true, resolutionReason)) return;
  await octokit.graphql(
    'mutation($threadId: ID!, $resolutionReason: PullRequestReviewThreadResolutionReason) { resolveReviewThread(input: { threadId: $threadId, resolutionReason: $resolutionReason }) { thread { isResolved } } }',
    { threadId, resolutionReason },
  );
}

async function unresolveReviewThread(octokit: Octokit, threadId: string): Promise<void> {
  assertWritesAllowed();
  if (await changeThreadThroughService(octokit, threadId, false)) return;
  await octokit.graphql('mutation($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }', { threadId });
}

/**
 * Posts `body` as a Manki reply in the review thread `threadId` and returns the reply's node ID. Pass any marker besides
 * `BOT_MARKER` in `markers`. Throws the abort reason once GitHub writes are stopped.
 */
async function replyToReviewThread(octokit: Octokit, threadId: string, body: string, ...markers: string[]): Promise<string | undefined> {
  assertWritesAllowed();
  const result = await octokit.graphql<{ addPullRequestReviewThreadReply?: { comment?: { id?: string } } } | undefined>(
    'mutation($threadId: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) { comment { id } } }',
    { threadId, body: withMarkers(body, BOT_MARKER, ...markers) },
  );
  return result?.addPullRequestReviewThreadReply?.comment?.id;
}

/** Deletes Manki's reply with the node ID `commentId` from its review thread. Throws the abort reason once GitHub writes are stopped. */
async function deleteThreadReply(octokit: Octokit, commentId: string): Promise<void> {
  assertWritesAllowed();
  await octokit.graphql('mutation($id: ID!) { deletePullRequestReviewComment(input: { id: $id }) { clientMutationId } }', { id: commentId });
}

/** Returns the reply that says why a thread is reopened. With `halt`, a push starts no review, so the reply asks for the review command. */
function reopenReply(isSecurity: boolean, halt: Awaited<ReturnType<typeof autoReviewHalt>>): string {
  const next = halt
    ? `A reviewer with write access can resolve it. Automatic review is ${halt.cause === 'auto_review_off' ? 'off' : 'paused'}, so after pushing a fix comment \`@manki review\` and Manki will check it.`
    : 'A reviewer with write access can resolve it, or push a fix and the next Manki review will check it.';
  return `Reopened. A ${isSecurity ? 'security' : 'blocking'} finding needs a maintainer or a fix: the PR author cannot resolve it. ${next}`;
}

/**
 * Returns the reply that says why the thread `threadId` is reopened. Returns `undefined` unless the PR author resolved that
 * guarded thread and Manki has not reopened it yet.
 */
async function authorResolvedNote(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, prAuthorLogin: string | undefined, config: ReviewConfig, threadId: string,
): Promise<string | undefined> {
  const recap = await fetchRecapState(octokit, bot, owner, repo, prNumber, prAuthorLogin, config.author_clear_role);
  const finding = recap.previousFindings.find(f => f.reopen && f.threadId === threadId);
  return finding && reopenReply(!!finding.isSecurity, await autoReviewHalt(octokit, bot, owner, repo, prNumber, config, recap));
}

/** Reopens each guarded thread of `recap` that the PR author resolved, and replies once to say why. */
async function reopenAuthorResolvedThreads(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, config: ReviewConfig, recap: RecapState,
): Promise<void> {
  if (!recap.previousFindings.some(f => f.reopen && f.threadId)) return;
  const halt = await autoReviewHalt(octokit, bot, owner, repo, prNumber, config, recap);
  for (const f of recap.previousFindings) {
    if (!f.reopen || !f.threadId) continue;
    // The thread opens first. The reply's marker stops every later reopen, so it must never sit on a thread that stayed resolved.
    if (!await reopenThread(octokit, f.threadId)) continue;
    try {
      await replyToReviewThread(octokit, f.threadId, reopenReply(!!f.isSecurity, halt), REOPENED_MARKER);
    } catch (error) {
      core.warning(`Reopened thread ${f.threadId}, but failed to say why: ${error}`);
    }
  }
}

/** Reopens the thread `threadId` that someone other than Manki resolved, and returns whether that worked. A failure is logged and leaves the thread resolved. */
async function reopenThread(octokit: Octokit, threadId: string): Promise<boolean> {
  try {
    await unresolveReviewThread(octokit, threadId);
    core.info(`Reopened thread ${threadId} that someone other than Manki resolved`);
    return true;
  } catch (error) {
    core.warning(`Failed to reopen thread ${threadId}: ${error}`);
    return false;
  }
}

/**
 * Replies once on each thread to record a security override. The reply's marker is what later rounds read the override from.
 * Returns the overrides it could record.
 */
async function announceSecurityOverrides(octokit: Octokit, overrides: Array<Required<SecurityOverride>>): Promise<SecurityOverride[]> {
  const announced: SecurityOverride[] = [];
  for (const o of overrides) {
    try {
      await replyToReviewThread(octokit, o.thread, `Finding dismissed by @${o.login}, the PR author, who has ${rolePhrase(o.role)} on this repository.`, securityOverrideMarker(o.via, o.login));
      announced.push(o);
      core.info(`Recorded the security override by ${o.login} on thread ${o.thread}`);
    } catch (error) {
      core.warning(`Failed to record the security override on thread ${o.thread}: ${error}`);
    }
  }
  return announced;
}

/**
 * Returns the bot review threads that hold an approval: every blocking thread, and every thread in `named`, that is
 * not cleared. Note threads posted by older versions never block, matching the verdict's bar.
 * A resolved thread is cleared only when `settledBy` gives a reason, as in a review round.
 */
function unclearedThreads(threads: ReviewThread[], bot: BotIdentity, prAuthorLogin?: string, prAuthorRole?: AuthorClearRole, named: ReadonlySet<string> = new Set()): ReviewThread[] {
  return threads.filter(t => (t.isBlocking || named.has(t.id)) && !settledBy(t, bot, prAuthorLogin, prAuthorRole));
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

/** Whether a person started `round` with a review command or a settings box. */
function startedByHand(round: RoundContext): boolean {
  const reason = round.meta.cap?.bypassReason;
  return reason !== undefined && reason !== 'within_cap';
}

/**
 * Counts the rounds since the last approval, or in all rounds without one. `total` counts every round that reviewed a new
 * change, and `left` is how many automatic rounds remain before the round cap pauses automatic review, `Infinity` with the
 * cap off. Draft rounds don't count. The round cap stops fix loops, so a round after an approval, such as on a rebase,
 * starts the count again. A round a person started while automatic review was paused restarts it: it counts like any
 * other round, then `left` becomes the larger of the rounds still left and `rounds_after_restart`. `sinceRestart` counts
 * the rounds with new changes after the last restart, and is `undefined` without one.
 */
function countRounds(
  priorRounds: RoundContext[], lastApprovalAt: string | undefined, config: ReviewConfig,
): { total: number; left: number; sinceRestart?: number; approved: boolean } {
  const maxAutoRounds = config.convergence?.max_auto_rounds ?? 0;
  const roundsAfterRestart = config.convergence?.rounds_after_restart ?? 0;
  let start = priorRounds.length;
  while (start > 0 && !approvedSince(priorRounds[start - 1], lastApprovalAt)) start--;
  let total = 0;
  let sinceRestart: number | undefined;
  let left = maxAutoRounds > 0 ? maxAutoRounds : Infinity;
  for (let i = start; i < priorRounds.length; i++) {
    const round = priorRounds[i];
    const paused = left <= 0 || (i > start && priorRounds[i - 1].meta.outcome === 'NOT_CONVERGING');
    const counts = !round.meta.draft && isNewChange({ commitSha: round.meta.commitSha, changeDigest: round.diff?.changeDigest }, priorRounds[i - 1]);
    if (counts) {
      total++;
      left--;
      if (sinceRestart !== undefined) sinceRestart++;
    }
    if (paused && startedByHand(round)) {
      left = Math.max(left, roundsAfterRestart);
      sinceRestart = 0;
    }
  }
  return { total, left, sinceRestart, approved: start > 0 || lastApprovalAt !== undefined };
}

interface PauseState {
  /** Rounds with new changes since the last approval, or in all rounds without one. */
  capRounds: number;
  /** Automatic rounds left before the round cap pauses automatic review, `Infinity` with the cap off. */
  roundsLeft: number;
  capReached: boolean;
  paused: boolean;
  /** Why automatic review is paused, as a sentence for the PR. Set only while `paused`. */
  reason?: string;
  /** What a review started by hand does beyond its own round, as a sentence for the PR. Set only while `paused`. */
  restart?: string;
}

/** Ends the reason of a round-cap pause, since rounds that keep finding problems point at the design. */
const RETHINK_LINE = 'Rounds that keep finding problems usually mean the approach needs another look, so step back and reconsider it before pushing more fixes.';

/** Says how many automatic rounds a review started by hand turns back on, or `undefined` when it turns none on. */
function restartLine(rounds: number): string | undefined {
  if (rounds <= 0) return undefined;
  const next = rounds === Infinity ? '' : rounds === 1 ? ' for the next round' : ` for the next ${rounds} rounds`;
  return `A review you start by hand also turns automatic review back on${next}.`;
}

/**
 * Returns the rounds with new changes since the last approval, the automatic rounds left before the round cap, and whether
 * automatic review is paused by the cap or by a last round that ended `NOT_CONVERGING` with no approval since.
 */
function pauseState({ priorRounds, lastApprovalAt }: Pick<RecapState, 'priorRounds' | 'lastApprovalAt'>, config: ReviewConfig): PauseState {
  const maxAutoRounds = config.convergence?.max_auto_rounds ?? 0;
  const { total: capRounds, left: roundsLeft, sinceRestart, approved } = countRounds(priorRounds, lastApprovalAt, config);
  const capReached = roundsLeft <= 0;
  const lastRound = priorRounds.at(-1);
  const since = approved ? ' since its last approval' : '';
  const reviewed = sinceRestart === undefined ? `${capRounds}/${maxAutoRounds} rounds on this PR${since}`
    : `${capRounds} rounds on this PR${since}${sinceRestart > 0 ? `, ${sinceRestart} of them after the last review started by hand` : ''}`;
  const reason = capReached
    ? `Manki has reviewed new changes in ${reviewed}. ${RETHINK_LINE}`
    : lastRound?.meta.outcome === 'NOT_CONVERGING' && !approvedSince(lastRound, lastApprovalAt) ? 'The last Manki round found a blocker that came back after a fix.' : undefined;
  // The restart usually reviews a new change, which uses one of the rounds still left.
  const restart = reason && restartLine(Math.max(roundsLeft - 1, config.convergence?.rounds_after_restart ?? 0));
  return { capRounds, roundsLeft, capReached, paused: reason !== undefined, ...(reason && { reason }), ...(restart && { restart }) };
}

/**
 * Returns why no automatic review will run on a new head commit, with how to start one, or `undefined` when a push review will run.
 * Reads the PR's rounds unless `rounds` holds them.
 */
async function autoReviewHalt(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, config: ReviewConfig,
  rounds?: Pick<RecapState, 'priorRounds' | 'lastApprovalAt'>,
): Promise<{ cause: 'auto_review_off' | 'settings_paused' | 'automatic_pause'; text: string } | undefined> {
  if (!config.auto_review) {
    return { cause: 'auto_review_off', text: 'Automatic review is off for this repository (`auto_review: false`). Comment `@manki review` to review it.' };
  }
  if ((await fetchPrState(owner, repo, prNumber, github.context.runId))?.settings.paused) {
    return { cause: 'settings_paused', text: 'Automatic review is paused in the settings block. Untick **Pause automatic reviews** there, or comment `@manki review`, to review it.' };
  }
  const { reason, restart } = pauseState(rounds ?? await fetchPriorRoundContexts(octokit, bot, owner, repo, prNumber), config);
  return reason
    ? { cause: 'automatic_pause', text: `${reason} Automatic review is paused. Tick **Review again** in the settings block, or comment \`@manki review\`, to review it.${restart ? ` ${restart}` : ''}` }
    : undefined;
}

function isBotReview(bot: BotIdentity, r: ReviewEntry): boolean {
  return !!r.body?.includes('<!-- manki') && isBotLogin(bot, r.user?.login);
}

/**
 * Returns the commit whose Manki review covers the head of `pr`, or `undefined` when none does. That is the head with a
 * verdict that is not dismissed, or the commit of the standing verdict when its PR diff equals the head's, as after a rebase.
 */
async function coveredCommit(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number,
  pr: PullHead, reviews: ReviewEntry[],
): Promise<string | undefined> {
  if (reviews.some(r => isBotReview(bot, r) && r.state !== 'DISMISSED' && r.commit_id === pr.head.sha && !hasOwnMarker(r.body ?? '', NO_VERDICT_MARKER))) return pr.head.sha;
  const standing = await findUnchangedVerdict(octokit, bot, owner, repo, prNumber, pr.base.ref, pr.head.sha);
  if (standing) core.info(`No change since the reviewed commit ${standing.commitSha.slice(0, 7)}, so its review covers ${pr.head.sha.slice(0, 7)}`);
  return standing?.commitSha;
}

/**
 * Whether `review` is the approval Manki posts again on a new head while the PR's change equals the approved one. It has
 * no round record and blocks on nothing, since a round or auto-approve gave the approval it restates. A push may have
 * dismissed it since.
 */
function restatesApproval(review: ReviewEntry): boolean {
  return (review.state === 'APPROVED' || review.state === 'DISMISSED') && !!review.body?.startsWith(APPROVED_LINE) && !hasReviewRecord(review.body);
}

/** How a PR with a block that resolving threads cannot lift gets its next verdict. */
const NEXT_ROUND_LINE = 'The next review round decides. Push a commit or comment `@manki review` to start one.';

/**
 * Returns what resolving threads can do about the newest round Manki posted on `commitSha`: `held` says why it cannot
 * lift that round's block, and `named` holds the live threads that carry its blockers. The record alone never proves a
 * thread. A thread carries a blocker when the record gives its `threadId` and the thread exists, or when the record
 * says the round posted the blocker as a thread and one of the threads posted on `commitSha` matches it. A standing
 * approval posted again on `commitSha` blocks on nothing. Anything else is unknown and holds the approval: a record
 * that cannot be read, a round that blocked without naming a blocker, and a blocker without a live thread.
 */
function blockOf(
  reviews: ReviewEntry[], bot: BotIdentity, commitSha: string, threads: ReviewThread[], owner: string, repo: string, prNumber: number,
): { held?: string; named: Set<string> } {
  const sha = `\`${commitSha.slice(0, 7)}\``;
  // An auto-approval and a round without a verdict decide nothing about blockers, so the round before them stands.
  const review = reviews.filter(r => isBotReview(bot, r) && r.commit_id === commitSha && !hasOwnMarker(r.body ?? '', NO_VERDICT_MARKER) && !hasOwnMarker(r.body ?? '', AUTO_APPROVE_MARKER)).at(-1);
  if (review && restatesApproval(review)) return { named: new Set() };
  const round = review && parseContextBlocks([{ body: review.body ?? '', id: review.id }], owner, repo, prNumber).rounds.at(0);
  if (!round || round.meta.commitSha !== commitSha) {
    return { held: `Manki cannot read the record of its review of ${sha}, so it cannot tell what that review blocked on.`, named: new Set() };
  }
  const blockers = [
    ...round.findings.entries.filter(e => e.severity === 'blocker').map(e => ({ title: e.title, file: e.fingerprint.file, threadId: e.threadId, posted: e.posted === 'thread' ? e.fingerprint : undefined })),
    ...(round.judge.verdictTrace?.unresolvedPriors ?? []).map(p => ({ title: p.title, file: p.file, threadId: p.threadId, posted: undefined })),
  ];
  if (round.verdict !== 'APPROVE' && blockers.length === 0) {
    return { held: `The record of Manki's review of ${sha} does not say what it blocked on.`, named: new Set() };
  }
  const live = new Set(threads.map(t => t.id));
  // Only a thread posted on the round's own commit can be the round's, and each one carries a single blocker.
  let own = threads.flatMap(t => t.place?.commit === commitSha ? [{ threadId: t.id, ...t.place }] : []);
  const named = new Set<string>();
  const loose: typeof blockers = [];
  for (const b of blockers) {
    const carrier = b.threadId && live.has(b.threadId) ? b.threadId : b.posted && findPriorThreadId(b.posted, own);
    if (!carrier) loose.push(b);
    else named.add(carrier);
    own = own.filter(t => t.threadId !== carrier);
  }
  const told = (claim: string, list: typeof loose): string[] => {
    if (list.length === 0) return [];
    const lines = list.map(b => `- ${sanitizeMarkdown(b.title ?? 'Untitled blocker')}${b.file ? ` (${inline(b.file)})` : ''}`).join('\n');
    return [`The record of Manki's review of ${sha} ${claim} for ${list.length === 1 ? '1 blocker' : `${list.length} blockers`}, so resolving threads cannot lift the block:\n${lines}`];
  };
  const claimed = (b: typeof loose[number]): boolean => !!b.threadId || !!b.posted;
  const held = [...told('names no thread', loose.filter(b => !claimed(b))), ...told('names a thread that does not exist', loose.filter(claimed))].join('\n\n');
  return { ...(held && { held }), named };
}

/** Says that no Manki review covers `headSha` and, from `halt`, why none will start on its own. */
function unreviewedLine(headSha: string, halt?: { text: string }): string {
  const head = `\`${headSha.slice(0, 7)}\``;
  return halt
    ? `Manki has not reviewed ${head}. ${halt.text}`
    : `Manki has not reviewed ${head} yet. A push review should start shortly, and approval follows from its verdict.`;
}

/** Names `role` in a note. With `orHigher`, `role` is the repo's `author_clear_role` and the phrase covers every role that setting allows. */
function rolePhrase(role: AuthorClearRole, orHigher = false): string {
  return `the \`${role}\` role${orHigher && role !== 'admin' ? ' or a higher one' : ''}`;
}

/**
 * Lists the threads `open` that hold an approval, for a person who asks why there is none. `named` holds the threads
 * the covering review blocks on whatever grade they show. `instead` replaces the last line when resolving them is not enough.
 */
function blockingThreadsLine(open: ReviewThread[], named: ReadonlySet<string>, bot: BotIdentity, clearRole: AuthorClearRole | undefined, instead?: string): string {
  const list = open.map(t => {
    const title = sanitizeMarkdown(t.findingTitle);
    const unbacked = t.repliesUnread ? 'the thread has too many comments for Manki to read its latest reply' : 'the latest reply is not from a maintainer other than the PR author';
    const note = isBotLogin(bot, t.resolvedByLogin) ? ` (Manki resolved it, but no review record confirms a fix, and ${unbacked})`
      : t.isResolved ? ` (resolved by ${inline(t.resolvedByLogin ?? 'someone')}, who may not clear it)`
      : !t.isBlocking && named.has(t.id) ? ' (Manki\'s latest review blocks on this thread)' : '';
    return `- ${t.threadUrl ? `[${title}](${t.threadUrl})` : title}${note}`;
  }).join('\n');
  const one = open.length === 1;
  const lifts = `Approval follows once ${one ? 'it is' : 'they are'} resolved by someone allowed to. The PR author may not clear a blocking thread${clearRole ? ` without ${rolePhrase(clearRole, true)}` : ''}.`;
  return `${one ? '1 thread blocks' : `${open.length} threads block`} the approval:\n${list}\n\n${instead ?? lifts}`;
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
  record?: string,
): Promise<void> {
  const shortHead = headSha.slice(0, 7);
  const shortLatest = latestReviewSha.slice(0, 7);
  const text = [
    `**Auto-approve withheld** for \`${shortHead}\`: all blocking review threads are resolved, but Manki has not reviewed this commit. Its latest review was on \`${shortLatest}\`.`,
    '',
    halt,
  ].join('\n');
  try {
    await postNoticeOnce(octokit, bot, owner, repo, prNumber, staleApproveMarker(headSha), record ? `${text}\n\n${record}` : text);
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
  recordFor?: (reason: string) => string,
): Promise<ApprovalHeld> {
  const hold = await fetchApprovalHold(octokit, owner, repo, prNumber, draftWhenUnread);
  if (!hold) return false;
  core.info(`${hold.reason === 'conflict' ? `PR conflicts with ${hold.baseRef}` : 'The PR is a draft'}, so it is not approved`);
  assertWritesAllowed();
  try {
    const line = approvalHoldLine(hold);
    await postNoticeOnce(octokit, bot, owner, repo, prNumber, `${APPROVAL_HELD_MARKER_PREFIX}${headSha} -->`, recordFor ? `${line}\n\n${recordFor(hold.reason)}` : line);
  } catch (error) {
    core.warning(`Failed to post the approval-held notice: ${error instanceof Error ? error.message : error}`);
  }
  return hold.reason;
}

/**
 * Deletes the auto-approve withheld notice for `headSha`, every approval-held notice and the token service's conflict
 * note. Call it once a review posts its verdict on `headSha`.
 * Marks every older failed or incomplete review progress comment as superseded by that verdict, whatever commit it was for.
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
      if (c.body.includes(marker) || c.body.includes(APPROVAL_HELD_MARKER_PREFIX) || c.body.includes(CONFLICT_NOTE_MARKER)) {
        await octokit.rest.issues.deleteComment({ owner, repo, comment_id: c.id });
      } else if (isFailedProgress(c.body)) {
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

/** What `approveOrSayWhy` decided. `standing` marks an approval that was already there. `why` tells a person why the PR is not approved and what lifts that. */
type ApprovalCheck = { approved: true; standing?: true } | { approved: false; why: () => Promise<string> };

/** Post an approval review if all findings are resolved. */
async function checkAndAutoApprove(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
  config?: ReviewConfig,
): Promise<boolean> {
  return (await approveOrSayWhy(octokit, bot, owner, repo, prNumber, config)).approved;
}

/** Post an approval review if all findings are resolved, and return the decision with its reason. */
async function approveOrSayWhy(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
  config?: ReviewConfig,
): Promise<ApprovalCheck> {
  const withheld = (why: string | (() => Promise<string>)): ApprovalCheck => ({ approved: false, why: typeof why === 'string' ? async () => why : why });
  const threads = await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber);

  const totalCount = threads.length;
  const resolvedCount = threads.filter(t => t.isResolved).length;
  const approvalRecord = (decision: ApprovalRecord['decision'], reason: string, head: string) => formatApprovalRecord({
    decision, reason, head, threads: { total: totalCount, resolved: resolvedCount }, timestamp: new Date().toISOString(), mankiVersion: MANKI_VERSION,
  });

  core.info(`Review threads: ${resolvedCount}/${totalCount} resolved`);

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  if (pr.draft) {
    core.info('Skipping auto-approve — the PR is a draft');
    return withheld(approvalHoldLine({ reason: 'draft' }));
  }

  const prAuthorLogin = pr.user?.login;
  const prAuthorRole = prAuthorLogin && threads.some(t => isOverrideCandidate(t, prAuthorLogin))
    ? await authorClearRole(octokit, owner, repo, prAuthorLogin, config?.author_clear_role) : undefined;
  const overrides = threads.flatMap(t => {
    const o = securityOverrideOf(t, prAuthorLogin, prAuthorRole);
    return o ? [{ ...o, thread: t.id, title: t.findingTitle, threadUrl: t.threadUrl }] : [];
  });
  await announceSecurityOverrides(octokit, overrides.filter(o => !o.announced));

  const listReviews = () => octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 });
  const uncleared = (named?: ReadonlySet<string>) => unclearedThreads(threads, bot, prAuthorLogin, prAuthorRole, named);
  if (uncleared().length > 0) {
    core.info('Not all blocking findings resolved — skipping auto-approve');
    // Only the reply reads the covering review here, to list every thread that blocks and to say when resolving them is not enough.
    return withheld(async () => {
      const reviews = await listReviews();
      const covered = await coveredCommit(octokit, bot, owner, repo, prNumber, pr, reviews);
      if (!covered) return blockingThreadsLine(uncleared(), new Set(), bot, config?.author_clear_role, unreviewedLine(pr.head.sha, config && await autoReviewHalt(octokit, bot, owner, repo, prNumber, config)));
      const block = blockOf(reviews, bot, covered, threads, owner, repo, prNumber);
      return blockingThreadsLine(uncleared(block.named), block.named, bot, config?.author_clear_role, block.held && `${block.held}\n\n${NEXT_ROUND_LINE}`);
    });
  }

  const reviews = await listReviews();
  const botReviews = reviews.filter((r: ReviewEntry) => isBotReview(bot, r) && r.state !== 'DISMISSED');
  const latestBotReview = botReviews[botReviews.length - 1];

  // Stale-SHA gate: bail unless a Manki review covers the current HEAD. This covers
  // every variant: stale prior review, absent commit_id, all reviews DISMISSED, or
  // no bot review at all.
  const covered = await coveredCommit(octokit, bot, owner, repo, prNumber, pr, reviews);
  if (!covered) {
    const staleSha =
      reviews.filter((r: ReviewEntry) => isBotReview(bot, r) && r.commit_id !== pr.head.sha).slice(-1)[0]?.commit_id ?? 'unknown';
    core.warning(
      `Skipping auto-approve — manki has not reviewed HEAD (head=${pr.head.sha}, stale=${staleSha})`,
    );
    // A push review takes about a minute to post its progress comment, so the lack of one does not mean no review is coming.
    const halt = config && await autoReviewHalt(octokit, bot, owner, repo, prNumber, config);
    if (halt) {
      await postStaleApproveSkippedComment(octokit, bot, owner, repo, prNumber, pr.head.sha, staleSha, halt.text, approvalRecord('withheld', halt.cause, pr.head.sha));
    } else {
      core.info(`A push review covers ${pr.head.sha.slice(0, 7)}, so no withheld notice is posted`);
    }
    return withheld(unreviewedLine(pr.head.sha, halt));
  }

  if (latestBotReview?.state === 'APPROVED') {
    core.info('Already approved — skipping duplicate approval');
    return { approved: true, standing: true };
  }

  // The review that covers the head is the latest one, or any on the head, as when a no-verdict round follows it.
  const held = (r?: ReviewEntry) => hasOwnMarker(r?.body ?? '', HELD_FOR_PERSON_MARKER);
  if (held(latestBotReview) || botReviews.some(r => r.commit_id === pr.head.sha && held(r))) {
    core.info('The review that covers the head holds its approval for a person, such as for unread files — skipping auto-approve');
    return withheld('Manki\'s review of the head holds its approval for a person and says why, such as files no model read. Resolving threads does not lift that. A person approves, or the next review round decides.');
  }

  const block = blockOf(reviews, bot, covered, threads, owner, repo, prNumber);
  if (block.held) {
    core.info(`${block.held}\nSkipping auto-approve, the next review round decides`);
    return withheld(`${block.held}\n\n${NEXT_ROUND_LINE}`);
  }
  // A thread the record names for a blocker blocks whatever its own severity says.
  const open = uncleared(block.named);
  if (open.length > 0) {
    core.info('A thread the covering review blocks on is not resolved — skipping auto-approve');
    return withheld(blockingThreadsLine(open, block.named, bot, config?.author_clear_role));
  }

  const hold = await holdApproval(octokit, bot, owner, repo, prNumber, pr.head.sha, false, reason => approvalRecord('held', reason, pr.head.sha));
  if (hold) {
    await reportPrState(owner, repo, prNumber, { approval: { commit: pr.head.sha, held: true } });
    return withheld(approvalHoldLine(hold === 'conflict' ? { reason: hold, baseRef: pr.base.ref } : { reason: 'draft' }));
  }

  const progressCommentId = await postAutoApproveProgressComment(octokit, owner, repo, prNumber);

  core.info('All findings resolved — auto-approving');
  // A visible body so the API does not render this review as `body_length: 0`.
  // An empty review body trips the head-SHA dedupe gate (`hasBotReviewOnCommit`)
  // for any subsequent force-review tick on the same commit ([#840]).
  const overrideLine = formatSecurityOverrides(overrides);
  const reason = overrides.length > 0 ? `all blocking threads are resolved, ${overrides.length} by a security override` : 'all blocking threads are resolved';
  const body = withMarkers(
    `${APPROVED_LINE} All blocking threads are resolved.${overrideLine ? `\n\n${overrideLine}` : ''}`, BOT_MARKER, AUTO_APPROVE_MARKER, approvalRecord('approved', reason, pr.head.sha),
  );

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

  await deleteAutoApproveProgressComment(octokit, owner, repo, progressCommentId);
  return { approved: true };
}

export { ApprovalCheck, PauseState, ResolutionReason, ReviewThread, announceSecurityOverrides, approveOrSayWhy, authorResolvedNote, checkAndAutoApprove, deleteThreadReply, fetchBotReviewThreads, fixedMarker, findUnchangedVerdict, holdApproval, isNewChange, pauseState, reopenAuthorResolvedThreads, reopenThread, replyToReviewThread, rolePhrase, resolveReviewThread, retireStaleNotices, unclearedThreads, unresolveReviewThread, BOT_MARKER, STALE_APPROVE_MARKER_PREFIX };
