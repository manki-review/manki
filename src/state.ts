import * as core from '@actions/core';
import * as github from '@actions/github';

import { assertWritesAllowed } from './abort';
import { changeThreadThroughService, fetchPrState, reportPrState } from './auth';
import { newestCheckPassed, outcomeReport, reportCheck } from './check-run';
import { AFTER_PUSH_LINE, ApprovalHeld, approvalHoldBox, approvalHoldLine, APPROVED_LINE, AUTO_APPROVE_MARKER, autoApproveHeadMarker, failedAutoApproveId, BotIdentity, BOT_MARKER as PROGRESS_MARKER, dismissPreviousReviews, fetchApprovalHold, fetchBlobShas, fetchInterRoundDiff, fetchPRComments, givesVerdict, HELD_FOR_PERSON_MARKER, inline, sanitizeMarkdown, standingOnCommit, fetchReviewThreadNodes, fetchStandingVerdict, MANKI_VERSION, PAUSE_NOTICE_MARKER, REVIEW_COMPLETE_MARKER, formatReadyReport, formatSecurityOverrides, isApprovalSettingRefusal, isBotLogin, isFailedProgress, authorClearRole, deleteAutoApproveProgressComment, reviewedCommit, markProgressCommentFailed, markProgressCommentSuperseded, postAutoApproveProgressComment } from './github';
import { ISSUE_BOX_LABEL, withMessageBoxes } from './issue-box';
import { MessageBox, SETTINGS_MARKER } from './settings';
import type { StandingVerdict } from './github';
import { compareChanges } from './diff';
import { clearRecordLogin, latestAnswer, personReplies, dismissRecordLogins, dismissRecordMarker, FixClaim, fixClaimOf, fetchPriorRoundContexts, fetchRecapState, guardedKind, isDisprovedThread, isOverrideCandidate, judgeAddressedThreadIds, parseContextBlocks, RAISED_MARKER, recordedThreadGrades, isSecurityThread, parseFindingData, RecapState, RecordedGrade, recordedSecurityOverride, REOPENED_MARKER, securityOverrideMarker, securityOverrideOf, resolveBacking, settledBy, threadMarkerSlug, threadSeverity, findingPlace } from './recap';
import { FIXED_MARKER_OPENER, fixedMarker, formatApprovalRecord, hasOwnMarker, hasReviewRecord, ROUND_REPLY_OPENER, settlingDecision } from './review-record';
import { findPriorThreadId } from './finding-fingerprint';
import { ApprovalRecord, AuthorClearRole, FindingSeverity, gradedAbove, PRE_EXISTING_TAG, ReviewConfig, RoundContext, SecurityOverride, threadBlocks, threadWarns } from './types';
import { COMMENT_MARKER as BOT_MARKER, ownMarker, withMarkers } from './utils';

type Octokit = ReturnType<typeof github.getOctokit>;
type PullHead = { head: { sha: string }; base: { ref: string } };
type ReviewEntry = { id: number; body?: string | null; state?: string; user?: { login?: string; type?: string } | null };

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
  /** Who Manki's latest record says it resolved the thread for, when that person has write access. Read only for a thread Manki resolved, and only below the comment limit. */
  writerClearLogin?: string;
  /** Who resolved the thread, when GitHub confirms a person with write access. */
  writerResolverLogin?: string;
  /** Set on a thread Manki resolved that is at the comment limit, so its latest record is unknown. */
  repliesUnread?: boolean;
  isBlocking: boolean;
  /** Whether the thread may carry a blocker: it is or was graded one, or a record that may have raised it is unread. */
  mayCarryBlocker?: boolean;
  /** Whether the thread is a warning that is no pre-existing defect, so it holds an approval until `heldWarnings` finds it cleared. */
  isWarning?: true;
  /**
   * Why a warning thread no longer holds an approval. `answer`: one of Manki's own replies accepted a reply, filed the
   * finding as an issue or moved it to a thread of a higher grade or guard, by `settlesWarning`. `fixed`: a round found
   * the thread fixed and Manki resolved it. Either counts only when it came after the latest round that made the thread
   * a warning or put a finding into it.
   */
  holdLifted?: 'answer' | 'fixed';
  isSecurity?: boolean;
  /** Whether the thread holds a blocker posted as a warning because every refuter disproved it. It clears as a security thread does. */
  disprovedBlocker?: boolean;
  /** The override recorded in one of Manki's comments on this blocking or security thread. Trusted only after `authorClearRole` confirms the role. */
  recordedOverride?: Omit<SecurityOverride, 'thread'>;
  /** Who Manki recorded a dismissal for on this thread since its last reopen or found-again reply, by `dismissRecordLogins`. */
  dismissRecords?: string[];
  /** The fix in another pull request that a reply in the thread named, and whether Manki checked it, by `fixClaimOf`. */
  fixClaim?: FixClaim;
  findingTitle: string;
  /** Where the thread was posted, for which finding and on which commit. Absent for a thread without a finding marker. */
  place?: { file: string; line: number; originalLine?: number; findingLine?: number; markerSlug: string; commit?: string };
  /** URL of the thread's first comment. */
  threadUrl?: string;
  /** The head commits on which a Manki reply in this thread confirmed the fix, from `fixedMarker`. */
  fixedOn?: string[];
  /** When the review of each head commit replied that this thread is not fixed, from `roundReplyMarker`. */
  roundReplies?: Array<{ commit: string; at: string }>;
  /** The replies in this thread that neither Manki nor another bot wrote, oldest first. */
  personReplies?: Array<{ id: number; login: string; body: string; at: string }>;
  /** Whether Manki answered a developer in this thread since the finding was last raised, by `latestAnswer`. Also set at the comment limit, which may hide an answer. */
  answered?: true;
}


const THREAD_COMMENTS_LIMIT = 100;

/** Marks Manki's reply that the thread's finding is filed as an issue, which lifts the hold of a warning thread. */
const TRACKED_MARKER = '<!-- manki-tracked -->';

/**
 * Whether `body`, one of Manki's own replies in a thread, settles a warning: it carries `TRACKED_MARKER` or
 * `RAISED_MARKER`, or its reply record holds the decision of a "Fixed.", "Withdrawn." or "Agreed." answer. Both are read
 * only below Manki's comment marker, so text a person or a model wrote settles nothing. Neither does a record that cannot be read.
 */
function settlesWarning(body: string): boolean {
  if (!body.includes(`\n${BOT_MARKER}`)) return false;
  if (hasOwnMarker(body, TRACKED_MARKER, BOT_MARKER) || hasOwnMarker(body, RAISED_MARKER, BOT_MARKER)) return true;
  return !!settlingDecision(body);
}

/** Returns the latest round that put a warning or a blocker into each earlier thread: one that restates the thread or finds its answered problem again. */
function lastRaised(rounds: RoundContext[]): Map<string, number> {
  const raised = new Map<string, number>();
  for (const round of rounds) {
    for (const { threadId, severity } of round.findings.entries) {
      if (threadId && (severity === 'warning' || severity === 'blocker')) raised.set(threadId, Math.max(round.meta.round, raised.get(threadId) ?? 0));
    }
  }
  return raised;
}

/**
 * Fetch all review threads `bot` started on a PR using GraphQL.
 * Returns threads with their resolution state and severity. `pending` is a round not posted yet, whose grades count too.
 * Without every round record each thread counts as blocking. `failIncomplete` asks for an error instead. With `holding`
 * it errs only when a thread could then still hold an approval. Any thread that is no pre-existing defect could, since a
 * resolved one holds too unless the records or a person with the role clear it. With `any` it errs whenever a thread is there.
 */
async function fetchBotReviewThreads(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
  pending?: RoundContext,
  failIncomplete: false | 'holding' | 'any' = false,
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
        createdAt?: string;
        author: { login: string; __typename?: string } | null;
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
        createdAt
        author {
          login
          __typename
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
  const records: Awaited<ReturnType<typeof fetchPriorRoundContexts>> = botThreads.length > 0 ? await fetchPriorRoundContexts(octokit, bot, owner, repo, prNumber) : { priorRounds: [] };
  const mayHold = (thread: typeof botThreads[number]): boolean => !parseFindingData(thread.comments.nodes[0]?.body ?? '')?.tags?.includes(PRE_EXISTING_TAG);
  if (failIncomplete && 'priorRoundsIncomplete' in records && botThreads.some(t => failIncomplete === 'any' || mayHold(t))) throw new Error('Not every round record could be read, so the grades of the threads are unknown');
  const rounds = pending ? [...records.priorRounds, pending] : records.priorRounds;
  const grades = recordedThreadGrades(rounds);
  const raised = lastRaised(rounds);
  // The pending round is not posted yet, so no reply can come after it.
  const postedAt = new Map(records.postedAt);
  if (pending) postedAt.delete(pending.meta.round);
  // Only Manki's own resolve needs its record to back it. A thread at the comment limit may hide a later reopen, so it names none.
  const byManki = (thread: typeof botThreads[number]) => thread.isResolved && isBotLogin(bot, thread.resolvedBy?.login);
  const repliesUnread = (thread: typeof botThreads[number]) => byManki(thread) && thread.comments.nodes.length >= THREAD_COMMENTS_LIMIT;
  const backing = await resolveBacking(octokit, owner, repo, rounds, botThreads.map(thread => {
    const cleared = byManki(thread) && !repliesUnread(thread) ? clearRecordLogin(bot, thread.comments.nodes) : undefined;
    const resolver = thread.isResolved && !byManki(thread) ? thread.resolvedBy?.login : undefined;
    return { id: thread.id, ...(cleared && { clearLogin: cleared }), ...(resolver && { resolverLogin: resolver }) };
  }));
  if ('priorRoundsIncomplete' in records) core.warning('Without every round record, every Manki thread counts as blocking');
  return botThreads
    .map(thread => {
      const body = thread.comments.nodes[0]?.body ?? '';
      const severity = threadSeverity(body);
      const isSecurity = isSecurityThread(body);
      const disprovedBlocker = isDisprovedThread(body);
      const recorded = grades.get(thread.id)?.grade;
      const peak = grades.get(thread.id)?.peak;
      // An unreadable record could hide a raise, so the thread blocks rather than let auto-approve pass it.
      const isBlocking = 'priorRoundsIncomplete' in records || threadBlocks({ severity, ...(recorded && { recordedGrade: recorded }), isSecurity, disprovedBlocker });
      const mayCarryBlocker = !gradedAbove('blocker', { severity, ...(peak && { peakGrade: peak }), ...('priorRoundsIncomplete' in records && { gradeUnknown: true }) });
      // The marker's slug turned every other character into a hyphen, so the finding data keeps the real title.
      const markerSlug = threadMarkerSlug(body);
      const data = parseFindingData(body);
      const isWarning = !isBlocking && threadWarns({ severity, ...(recorded && { recordedGrade: recorded }), isSecurity, disprovedBlocker }) && !data?.tags?.includes(PRE_EXISTING_TAG);
      const raisedIn = raised.get(thread.id);
      const since = isWarning ? warningSince(severity, grades.get(thread.id)?.history ?? [], raisedIn, postedAt) : undefined;
      const after = (c: { createdAt?: string }) => since === 'posted' || (!!since && !!c.createdAt && Date.parse(c.createdAt) > Date.parse(since));
      const answered = thread.comments.nodes.slice(1).some(c => isBotLogin(bot, c.author?.login) && after(c) && settlesWarning(c.body ?? ''));
      // The record of a fix counts only from the rounds after the latest one that put a finding into the thread.
      const fixed = isWarning && byManki(thread) && judgeAddressedThreadIds(rounds.filter(r => r.meta.round > (raisedIn ?? 0)), true).has(thread.id);
      const holdLifted = answered ? 'answer' as const : fixed ? 'fixed' as const : undefined;
      const findingTitle = data?.title?.trim() || (markerSlug?.replace(/-/g, ' ') ?? 'Unknown');
      const commit = thread.comments.nodes[0]?.originalCommit?.oid;
      const place = thread.path && markerSlug
        ? { ...findingPlace(body, thread.path, thread.line, thread.originalLine), markerSlug, ...(commit && { commit }) }
        : undefined;

      const rootCommentId = thread.comments.nodes[0]?.databaseId;
      const resolvedByLogin = thread.resolvedBy?.login;
      const threadUrl = thread.comments.nodes[0]?.url;
      const recordedOverride = isSecurity || disprovedBlocker || isBlocking ? recordedSecurityOverride(bot, thread.comments.nodes) : undefined;
      // A thread at the comment limit may hide a later answer or reopen, so it names no claim and no dismiss record.
      const complete = thread.comments.nodes.length < THREAD_COMMENTS_LIMIT;
      const dismissRecords = complete ? dismissRecordLogins(bot, thread.comments.nodes) : [];
      const fixClaim = (isSecurity || disprovedBlocker || isBlocking) && complete ? fixClaimOf(bot, thread.comments.nodes, `${owner}/${repo}`, prNumber) : undefined;
      const markedSha = (c: { body: string; author: { login: string } | null }, opener: string) =>
        isBotLogin(bot, c.author?.login) ? ownMarker(c.body ?? '', opener, BOT_MARKER)?.match(/^[0-9a-f]{40}$/)?.[0] : undefined;
      const fixedOn = thread.comments.nodes.slice(1).flatMap(c => markedSha(c, FIXED_MARKER_OPENER) ?? []);
      const roundReplies = thread.comments.nodes.slice(1).flatMap(c => {
        const commit = markedSha(c, ROUND_REPLY_OPENER);
        return commit && c.createdAt ? [{ commit, at: c.createdAt }] : [];
      });
      const replies = personReplies(bot, thread.comments.nodes).flatMap(c => (c.databaseId != null && c.author && c.createdAt ? [{ id: c.databaseId, login: c.author.login, body: c.body, at: c.createdAt }] : []));
      return {
        id: thread.id,
        ...(rootCommentId != null && { rootCommentId }),
        isResolved: thread.isResolved,
        ...(resolvedByLogin && { resolvedByLogin }),
        ...backing.get(thread.id),
        ...(repliesUnread(thread) && { repliesUnread: true }),
        isBlocking,
        ...(mayCarryBlocker && { mayCarryBlocker }),
        ...(isWarning && { isWarning: true as const }),
        ...(holdLifted && { holdLifted }),
        ...(isSecurity && { isSecurity: true }),
        ...(disprovedBlocker && { disprovedBlocker: true }),
        ...(recordedOverride && { recordedOverride }),
        ...(dismissRecords.length > 0 && { dismissRecords }),
        ...(fixClaim && { fixClaim }),
        findingTitle,
        ...(place && { place }),
        ...(threadUrl && { threadUrl }),
        ...(fixedOn.length > 0 && { fixedOn }),
        ...(roundReplies.length > 0 && { roundReplies }),
        ...(replies.length > 0 && { personReplies: replies }),
        ...((!complete || latestAnswer(bot, thread.comments.nodes) !== undefined) && { answered: true as const }),
      };
    });
}

/**
 * Returns since when a warning thread stands as it does: `posted` when its first comment was already a warning and no
 * round graded it otherwise or put a finding into it since. Otherwise it is when the review of the later of two rounds
 * was submitted: the round that last made the thread a warning, and `raisedIn`, the latest round that put a finding
 * into it. Returns `undefined` when that time is not known, as for a round not posted yet.
 */
function warningSince(
  severity: FindingSeverity | 'unknown', history: RecordedGrade['history'], raisedIn: number | undefined, postedAt: ReadonlyMap<number, string>,
): 'posted' | string | undefined {
  let since: 'posted' | number | undefined = severity === 'warning' ? 'posted' : undefined;
  for (const { round, grade } of history) {
    if (grade !== 'warning') since = undefined;
    else if (since === undefined) since = round;
  }
  if (raisedIn !== undefined && since !== undefined && (since === 'posted' || raisedIn > since)) since = raisedIn;
  return typeof since === 'number' ? postedAt.get(since) : since;
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

/** Returns the reply that says why a thread is reopened. A review never clears a thread tied to no `file`, so its reply names no fix. */
function reopenReply(thread: { isSecurity?: boolean; disprovedBlocker?: boolean }, file: string): string {
  const kind = guardedKind(thread);
  return file
    ? `Reopened. A ${kind} needs a maintainer or a fix: the PR author cannot resolve it. A reviewer with write access can resolve it, or push a fix and the next Manki review will check it. ${AFTER_PUSH_LINE}`
    : `Reopened. A ${kind} that is not tied to a file needs a maintainer: the PR author cannot resolve it, and no review can confirm a fix for it. A reviewer with write access can resolve it.`;
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
  return finding && reopenReply(finding, finding.file);
}

/** Reopens each guarded thread of `recap` that the PR author resolved, and replies once to say why. */
async function reopenAuthorResolvedThreads(octokit: Octokit, recap: RecapState): Promise<void> {
  for (const f of recap.previousFindings) {
    if (!f.reopen || !f.threadId) continue;
    // The thread opens first. The reply's marker stops every later reopen, so it must never sit on a thread that stayed resolved.
    if (!await reopenThread(octokit, f.threadId)) continue;
    try {
      await replyToReviewThread(octokit, f.threadId, reopenReply(f, f.file), REOPENED_MARKER);
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
 * Says which pull request a reply in the thread named, and whether Manki confirmed it as the fix. Only Manki's check
 * reads a reply as naming the fix, so an unchecked one only names the pull request.
 */
/** The note that records a dismissal by `login`, who is the PR author with `role`, the PR author, or someone with write access. */
function dismissalNote(login: string, who: { role?: AuthorClearRole; prAuthor?: boolean }, fixClaim: FixClaim | undefined): string {
  const by = who.role ? `, the PR author, who has ${rolePhrase(who.role)} on this repository` : who.prAuthor ? ', the PR author' : ', who has write access to this repository';
  return `Finding dismissed by \`@${login}\`${by}.${fixClaim ? ` ${fixClaimLine(fixClaim)}` : ''}`;
}

/**
 * Replies on `thread` to record the dismissal by `login` that Manki accepted, with its own marker that no reader of
 * security overrides sees, and with `markers`. Returns whether the reply was posted.
 */
async function recordDismissal(octokit: Octokit, thread: string, login: string, prAuthor: boolean, fixClaim: FixClaim | undefined, ...markers: string[]): Promise<boolean> {
  try {
    await replyToReviewThread(octokit, thread, dismissalNote(login, { prAuthor }, fixClaim), dismissRecordMarker(login), ...markers);
    core.info(`Recorded the dismissal by ${login} on thread ${thread}`);
    return true;
  } catch (error) {
    core.warning(`Failed to record the dismissal on thread ${thread}: ${error}`);
    return false;
  }
}

function fixClaimLine({ pr, status }: FixClaim): string {
  if (status === 'confirmed') return `A reply here named #${pr} as the fix, and Manki confirmed that #${pr} replaced the cited line on the default branch.`;
  if (status === 'unconfirmed') return `A reply here named #${pr} as the fix. Manki could not confirm that #${pr} fixes this finding.`;
  return `A reply here names #${pr}. Manki did not check whether it fixes this finding.`;
}

/**
 * Replies once on each thread to record a security override, and says what the thread's `fixClaim` was. The reply's
 * marker is what later rounds read the override from. Returns the overrides it could record.
 */
async function announceSecurityOverrides(octokit: Octokit, overrides: Array<Required<SecurityOverride> & { fixClaim?: FixClaim }>): Promise<SecurityOverride[]> {
  const announced: SecurityOverride[] = [];
  for (const o of overrides) {
    try {
      await replyToReviewThread(octokit, o.thread, dismissalNote(o.login, { role: o.role }, o.fixClaim), securityOverrideMarker(o.via, o.login));
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

/**
 * Returns the warning threads that hold an approval. A thread stops holding only when that is certain: `holdLifted`
 * gives a reason, or a person whom GitHub confirms in `clearRole` resolved it. A reply Manki did not accept, an
 * unanswered reply and a resolve by anyone else lift nothing. A security thread, and the thread of a blocker a check
 * disproved, clear only as a blocking one does, by `settledBy`.
 */
async function heldWarnings(
  octokit: Octokit, owner: string, repo: string, threads: ReviewThread[], bot: BotIdentity,
  prAuthorLogin: string | undefined, prAuthorRole: AuthorClearRole | undefined, clearRole: AuthorClearRole | undefined,
): Promise<ReviewThread[]> {
  const resolvedWithRole = async (t: ReviewThread): Promise<boolean> =>
    t.isResolved && !!t.resolvedByLogin && !isBotLogin(bot, t.resolvedByLogin) && !!await authorClearRole(octokit, owner, repo, t.resolvedByLogin, clearRole);
  const held: ReviewThread[] = [];
  for (const t of threads.filter(t => t.isWarning)) {
    const cleared = t.isSecurity || t.disprovedBlocker ? !!settledBy(t, bot, prAuthorLogin, prAuthorRole) : !!t.holdLifted || await resolvedWithRole(t);
    if (!cleared) held.push(t);
  }
  return held;
}

/** Names what lifts the hold of a warning that is no security finding, to follow "it is" or "each one is". Without `clearRole` no resolve by hand lifts it. A `resolved` thread has to be reopened first. */
function warningClearedBy(clearRole: AuthorClearRole | undefined, resolved = false): string {
  const tracked = `tracked with \`${ISSUE_BOX_LABEL}\``;
  return clearRole ? `fixed, ${tracked}, or ${resolved ? 'reopened and ' : ''}resolved by someone with ${rolePhrase(clearRole, true)}` : `fixed or ${tracked}`;
}

/**
 * Returns the note that says `thread` still holds the approval and what lifts that, for a Manki reply that leaves it
 * so. Returns `undefined` when `thread` is no warning, is a security one, or holds nothing.
 */
async function warningHoldNote(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, thread: ReviewThread, clearRole: AuthorClearRole | undefined,
): Promise<string | undefined> {
  if (thread.isSecurity || thread.disprovedBlocker || (await heldWarnings(octokit, owner, repo, [thread], bot, undefined, undefined, clearRole)).length === 0) return undefined;
  return `This warning holds the approval until it is ${warningClearedBy(clearRole, thread.isResolved)}.`;
}

/** Returns the PR author's role when `clearRole` allows it and a thread the author resolved needs it, as `securityOverrideOf` reads it. */
async function overrideRole(
  octokit: Octokit, owner: string, repo: string, threads: ReviewThread[], prAuthorLogin: string | undefined, clearRole: AuthorClearRole | undefined,
): Promise<AuthorClearRole | undefined> {
  return prAuthorLogin && threads.some(t => isOverrideCandidate(t, prAuthorLogin)) ? await authorClearRole(octokit, owner, repo, prAuthorLogin, clearRole) : undefined;
}

/**
 * Reads the PR's threads with the grades of `pending`, a round not posted yet, and returns the warning threads that hold an
 * approval. Throws when the threads or the round records cannot all be read, since a warning thread could then be missed.
 * With `blocking`, it also returns the blocking threads that are not cleared, such as one a person reopened after an approval.
 */
async function fetchHeldWarnings(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number,
  prAuthorLogin: string | undefined, clearRole: AuthorClearRole | undefined, pending?: RoundContext, blocking = false,
): Promise<ReviewThread[]> {
  const threads = await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber, pending, 'holding');
  const prAuthorRole = await overrideRole(octokit, owner, repo, threads, prAuthorLogin, clearRole);
  const warnings = await heldWarnings(octokit, owner, repo, threads, bot, prAuthorLogin, prAuthorRole, clearRole);
  return blocking ? [...new Set([...unclearedThreads(threads, bot, prAuthorLogin, prAuthorRole), ...warnings])] : warnings;
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
 * An approval held on a conflict, a draft, a config, unread files or a refusal by GitHub is recorded as an approval, so it counts. One that
 * warnings held does not, whatever hold came first, so a loop of warnings still reaches the round cap.
 */
function approvedSince(round: RoundContext, lastApprovalAt: string | undefined): boolean {
  return (round.verdict === 'APPROVE' && !round.approval?.warningsHeld)
    || (lastApprovalAt !== undefined && Date.parse(round.meta.timestamp) <= Date.parse(lastApprovalAt));
}

/** Automatic rounds a review started by hand turns back on while automatic review is paused, when the round cap allows fewer. */
const ROUNDS_AFTER_RESTART = 3;

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
 * other round, then `left` becomes the larger of the rounds still left and `ROUNDS_AFTER_RESTART`. `sinceRestart` counts
 * the rounds with new changes after the last restart, and is `undefined` without one.
 */
function countRounds(
  priorRounds: RoundContext[], lastApprovalAt: string | undefined, config: ReviewConfig,
): { total: number; left: number; sinceRestart?: number; approved: boolean } {
  const maxAutoRounds = config.max_auto_rounds ?? 0;
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
      left = Math.max(left, ROUNDS_AFTER_RESTART);
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

/** Says how many automatic rounds a review started by hand turns back on. */
function restartLine(rounds: number): string {
  const next = rounds === Infinity ? '' : ` for the next ${rounds} rounds`;
  return `A review you start by hand also turns automatic review back on${next}.`;
}

/**
 * Returns the rounds with new changes since the last approval, the automatic rounds left before the round cap, and whether
 * automatic review is paused by the cap or by a last round that ended `NOT_CONVERGING` with no approval since.
 */
function pauseState({ priorRounds, lastApprovalAt }: Pick<RecapState, 'priorRounds' | 'lastApprovalAt'>, config: ReviewConfig): PauseState {
  const maxAutoRounds = config.max_auto_rounds ?? 0;
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
  const restart = reason && restartLine(Math.max(roundsLeft - 1, ROUNDS_AFTER_RESTART));
  return { capRounds, roundsLeft, capReached, paused: reason !== undefined, ...(reason && { reason }), ...(restart && { restart }) };
}

/** Why no automatic review will run on a new head commit, with how to start one. An automatic pause carries its `pause`. */
type AutoReviewHalt =
  | { cause: 'auto_review_off' | 'settings_paused' | 'pause_unknown'; text: string }
  | { cause: 'automatic_pause'; text: string; pause: PauseState };

/**
 * Returns why no automatic review will run on a new head commit, with how to start one, or `undefined` when a push review will run.
 * It checks `auto_review` first, then the Pause box of the settings block, then `pauseState`.
 * When the token service cannot say whether the PR is paused, the cause is `pause_unknown`, so no caller promises a push review.
 * Reads the PR's rounds unless `rounds` holds them, and the Pause box unless `pauseBox` says whether it is ticked.
 */
async function autoReviewHalt(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, config: ReviewConfig,
  rounds?: Pick<RecapState, 'priorRounds' | 'lastApprovalAt'>, pauseBox?: boolean,
): Promise<AutoReviewHalt | undefined> {
  if (!config.auto_review) {
    return { cause: 'auto_review_off', text: 'Automatic review is off for this repository (`auto_review: false`). Comment `/manki review` to review it.' };
  }
  const boxTicked = pauseBox ?? await fetchPrState(owner, repo, prNumber, github.context.runId).then(state => !!state?.settings.paused, (error: unknown) => {
    core.warning(`Could not read whether #${prNumber} is paused, so not counting on a push review: ${error instanceof Error ? error.message : error}`);
    return undefined;
  });
  if (boxTicked) {
    return { cause: 'settings_paused', text: 'Automatic review is paused in the settings block. Tick the review box there, or comment `/manki review`, to review it. Untick **Pause automatic reviews** to lift the pause.' };
  }
  const pause = pauseState(rounds ?? await fetchPriorRoundContexts(octokit, bot, owner, repo, prNumber), config);
  const { reason, restart } = pause;
  if (reason) {
    return { cause: 'automatic_pause', pause, text: `${reason} Automatic review is paused. Tick the review box in the settings block, or comment \`/manki review\`, to review it. ${restart}` };
  }
  return boxTicked === undefined
    ? { cause: 'pause_unknown', text: 'Manki could not read whether automatic review is paused for this PR. If no review of the commit starts, tick the review box in the settings block, or comment `/manki review`.' }
    : undefined;
}

function isBotReview(bot: BotIdentity, r: ReviewEntry): boolean {
  return !!r.body?.includes('<!-- manki') && isBotLogin(bot, r.user?.login);
}

/** Returns Manki's reviews that still stand: on `headSha` the ones `standingOnCommit` keeps, and elsewhere every one not dismissed. */
async function standingReviews(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, headSha: string, reviews: ReviewEntry[],
): Promise<ReviewEntry[]> {
  const onHead = new Set(await standingOnCommit(octokit, bot, owner, repo, prNumber, reviews.filter(r => isBotReview(bot, r) && reviewedCommit(r) === headSha)));
  return reviews.filter(r => isBotReview(bot, r) && (reviewedCommit(r) === headSha ? onHead.has(r) : r.state !== 'DISMISSED'));
}

/**
 * Returns the commit whose Manki review covers the head of `pr`, or `undefined` when none does. That is the head with a
 * verdict among the `standing` reviews, or the commit of the standing verdict when its PR diff equals the head's, as after a rebase.
 */
async function coveredCommit(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number,
  pr: PullHead, standing: ReviewEntry[],
): Promise<string | undefined> {
  if (standing.some(r => reviewedCommit(r) === pr.head.sha && givesVerdict(r))) return pr.head.sha;
  const unchanged = await findUnchangedVerdict(octokit, bot, owner, repo, prNumber, pr.base.ref, pr.head.sha);
  if (unchanged) core.info(`No change since the reviewed commit ${unchanged.commitSha.slice(0, 7)}, so its review covers ${pr.head.sha.slice(0, 7)}`);
  return unchanged?.commitSha;
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
const NEXT_ROUND_LINE = `The next review round decides. To start one, tick the review box in the settings block, or push a commit. ${AFTER_PUSH_LINE}`;

/**
 * Returns what resolving threads can do about the newest round Manki posted on `commitSha`: `held` says why it cannot
 * lift that round's block, and `named` holds the live threads that carry its blockers. The record alone never proves a
 * thread. A thread carries a blocker when the record gives its `threadId` and the thread exists, or when the record
 * says the round posted the blocker as a thread and one of the threads posted on `commitSha` matches it. A standing
 * approval posted again on `commitSha` blocks on nothing. Anything else is unknown and holds the approval: a record
 * that cannot be read, a round that blocked without naming a blocker, and a blocker without a live thread. A warning
 * the record marks with `holds` also holds it when the round listed it only in its body or no live thread carries it.
 * `report` is what the change does and how to test it, which the round kept for the approval because warnings held it.
 * `hold` names the hold that the record proves on a round that approved and names no blocker: the files no model read or
 * the config that did not load, as its `approval` says, or else such a warning without a thread.
 */
function blockOf(
  reviews: ReviewEntry[], bot: BotIdentity, commitSha: string, threads: ReviewThread[], owner: string, repo: string, prNumber: number,
): { held?: string; named: Set<string>; report?: RoundContext['readyReport']; hold?: 'unread' | 'config' | 'warnings'; approval?: RoundContext['approval'] } {
  const sha = `\`${commitSha.slice(0, 7)}\``;
  // An auto-approval and a round without a verdict decide nothing about blockers, so the round before them stands.
  const review = reviews.filter(r => isBotReview(bot, r) && reviewedCommit(r) === commitSha && givesVerdict(r) && !hasOwnMarker(r.body ?? '', AUTO_APPROVE_MARKER)).at(-1);
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
  // Only a thread posted on the round's own commit can be the round's, and each one carries a single blocker. A
  // suggestion thread on the blocker's line is never its thread, so it never holds the approval.
  let own = threads.flatMap(t => t.place?.commit === commitSha && t.mayCarryBlocker ? [{ threadId: t.id, ...t.place }] : []);
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
  // A holding warning the round gave a thread holds while no thread carries it, as a blocker does.
  const holding = round.findings.entries.filter(e => e.holds);
  let ownWarnings = threads.flatMap(t => t.place?.commit === commitSha && !named.has(t.id) && (t.isWarning || t.mayCarryBlocker) ? [{ threadId: t.id, ...t.place }] : []);
  const gone: typeof holding = [];
  for (const e of holding.filter(e => e.posted !== 'body')) {
    const carrier = e.threadId && live.has(e.threadId) ? e.threadId : e.posted === 'thread' && findPriorThreadId(e.fingerprint, ownWarnings);
    if (!carrier) gone.push(e);
    ownWarnings = ownWarnings.filter(t => t.threadId !== carrier);
  }
  const warnedOf = (said: (count: string) => string, list: typeof holding): string[] => list.length === 0 ? [] : [
    `${said(list.length === 1 ? '1 warning' : `${list.length} warnings`)}, so resolving threads cannot lift its hold on the approval:\n${list.map(e => `- ${sanitizeMarkdown(e.title ?? 'Untitled warning')}${e.fingerprint.file ? ` (${inline(e.fingerprint.file)})` : ''}`).join('\n')}`,
  ];
  const warned = [
    ...warnedOf(count => `Manki's review of ${sha} lists ${count} with no thread`, holding.filter(e => e.posted === 'body')),
    ...warnedOf(count => `The record of Manki's review of ${sha} names a thread that does not exist for ${count}`, gone),
  ];
  const held = [...told('names no thread', loose.filter(b => !claimed(b))), ...told('names a thread that does not exist', loose.filter(claimed)), ...warned].join('\n\n');
  const person = round.approval?.held === 'unread' || round.approval?.held === 'config' ? round.approval.held : undefined;
  const hold = round.verdict === 'APPROVE' && blockers.length === 0 ? person ?? (warned.length > 0 ? 'warnings' as const : undefined) : undefined;
  return { ...(held && { held }), named, ...(round.readyReport && { report: round.readyReport }), ...(hold && { hold }), ...(round.approval && { approval: round.approval }) };
}

/**
 * Says that no Manki review covers `headSha` and, from `halt`, why none will start on its own. Without `halt` a push
 * review may still be on its way, or none comes, as for a fork, so the line names the review command for that case.
 */
function unreviewedLine(headSha: string, halt?: { text: string }): string {
  const head = `\`${headSha.slice(0, 7)}\``;
  return halt
    ? `Manki has not reviewed ${head}. ${halt.text}`
    : `Manki has not reviewed ${head} yet, and approval follows from the verdict of that review. If no review of it starts, as for a PR from a fork or one that matches a skip rule, comment \`/manki review\`.`;
}

/** Names `role` in a note. With `orHigher`, `role` is the repo's `author_clear_role` and the phrase covers every role that setting allows. */
function rolePhrase(role: AuthorClearRole, orHigher = false): string {
  return `the \`${role}\` role${orHigher && role !== 'admin' ? ' or a higher one' : ''}`;
}

/** Says that the PR author may not clear a blocking thread, or only with `clearRole`, the repo's `author_clear_role`. */
function authorClearLine(clearRole: AuthorClearRole | undefined): string {
  return `The PR author may not clear a blocking thread${clearRole ? ` without ${rolePhrase(clearRole, true)}` : ''}.`;
}

/**
 * Lists the threads `open` that hold an approval, for a person who asks why there is none. `named` holds the threads
 * the covering review blocks on whatever grade they show. `instead` replaces the last line when resolving them is not enough.
 */
function blockingThreadsLine(open: ReviewThread[], named: ReadonlySet<string>, bot: BotIdentity, clearRole: AuthorClearRole | undefined, instead?: string): string {
  const list = open.map(t => {
    const unbacked = t.repliesUnread ? 'the thread has too many comments for Manki to read its record, so someone other than the PR author with write access has to reopen it and resolve it' : 'no record of Manki names a maintainer other than the PR author who cleared it';
    const note = isBotLogin(bot, t.resolvedByLogin) ? ` (Manki resolved it, but no review record confirms a fix, and ${unbacked})`
      : t.isResolved ? ` (resolved by ${inline(t.resolvedByLogin ?? 'someone')}, who may not clear it)`
      : !t.isBlocking && named.has(t.id) ? ' (Manki\'s latest review blocks on this thread)' : '';
    return `- ${threadLink(t)}${note}`;
  }).join('\n');
  const one = open.length === 1;
  const lifts = `Approval follows once ${one ? 'it is' : 'they are'} resolved by someone allowed to. ${authorClearLine(clearRole)}`;
  return `${one ? '1 thread blocks' : `${open.length} threads block`} the approval:\n${list}\n\n${instead ?? lifts}`;
}

/** Returns the title of thread `t`, linked to the thread when its URL is known. */
function threadLink(t: ReviewThread): string {
  const title = sanitizeMarkdown(t.findingTitle);
  return t.threadUrl ? `[${title}](${t.threadUrl})` : title;
}

/** Lists the warning threads `held` that hold an approval, for a person who asks why there is none, and says what clears each. */
function warningThreadsLine(held: ReviewThread[], bot: BotIdentity, clearRole: AuthorClearRole | undefined): string {
  const note = (t: ReviewThread): string => t.isSecurity || t.disprovedBlocker ? ` (a ${guardedKind(t)}, which needs a fix or a maintainer to resolve it)`
    : !t.isResolved ? ''
    : isBotLogin(bot, t.resolvedByLogin) ? ' (Manki resolved it, but for none of the reasons that lift the hold)'
    : ` (resolved by ${inline(t.resolvedByLogin ?? 'someone')}, which ${clearRole ? `lifts the hold only with ${rolePhrase(clearRole, true)}` : 'does not lift the hold'})`;
  const list = held.map(t => `- ${threadLink(t)}${note(t)}`).join('\n');
  const reopen = clearRole && held.some(t => t.isResolved && !t.isSecurity && !t.disprovedBlocker) ? ' A thread that is already resolved has to be reopened first.' : '';
  const count = held.length === 1 ? '1 warning thread holds' : `${held.length} warning threads hold`;
  return `${count} the approval:\n${list}\n\nApproval follows once each one is ${warningClearedBy(clearRole)}.${reopen} A reply in a thread lifts its hold only when Manki answers it with Fixed, Withdrawn or Agreed.`;
}

/** Posts `text` as a comment carrying `marker`, unless a Manki comment with `marker` is already on the PR. Returns whether it posted. */
async function postNoticeOnce(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, marker: string, text: string,
): Promise<boolean> {
  const existing = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  if (existing.some(c => isBotLogin(bot, c.user?.login) && c.body?.includes(marker))) {
    core.info(`Notice ${marker} already present, skipping duplicate`);
    return false;
  }
  await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: withMarkers(text, marker) });
  return true;
}

/**
 * Posts a one-time comment that auto-approve is withheld because Manki has not reviewed `headSha`,
 * and no automatic review will, or none is certain. `halt` says why and how to start one.
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
  const text = withMessageBoxes([
    `**Auto-approve withheld** for \`${shortHead}\`: all blocking review threads are resolved, but Manki has not reviewed this commit. Its latest review was on \`${shortLatest}\`.`,
    '',
    halt,
  ].join('\n'), ['again']);
  try {
    await postNoticeOnce(octokit, bot, owner, repo, prNumber, staleApproveMarker(headSha), record ? `${text}\n\n${record}` : text);
  } catch (error) {
    core.warning(`Failed to post stale-approve-skipped comment: ${error instanceof Error ? error.message : error}`);
  }
}

/** The notice of an approval GitHub refused because of the repository setting. */
const REFUSED_LINE = 'All blocking threads are resolved, but repository settings block the approval. Enable "Allow GitHub Actions to create and approve pull requests" in the repo settings, or approve by hand.';

/** A held approval: the first reason, the notice's line, the box of the step it names, and whether this call posted the notice. */
type HeldApproval = { reason: Exclude<ApprovalHeld, false>; line: string; box?: MessageBox; posted: boolean };

/**
 * The holds the approval check tests, in the order it tests them, each with the sentence that says it no longer holds.
 * A hold the check stops at proves that every hold before it in this list has cleared.
 */
const CLEARED_HOLDS: ReadonlyArray<[Exclude<ApprovalHeld, false>, string]> = [
  ['warnings', 'Every warning that held the approval is handled.'],
  ['draft', 'This PR is no longer a draft.'],
  ['conflict', 'The conflict with the base branch is resolved.'],
  ['refused', ''],
];

/** Returns `line` for the hold `reason`, led by what cleared since the holds `before`, or as it is when none of them cleared. */
function stillHeldLine(line: string, reason: Exclude<ApprovalHeld, false>, before: readonly ApprovalHeld[]): string {
  // A refusal can follow a check that could not read the PR, so only the warnings, which the check read, are known to have cleared.
  const cleared = CLEARED_HOLDS.slice(0, CLEARED_HOLDS.findIndex(([r]) => r === reason))
    .filter(([r]) => before.includes(r) && (reason !== 'refused' || r === 'warnings')).map(([, text]) => text);
  return cleared.length > 0 ? `${cleared.join(' ')} ${line.replace(/^\*\*Approval held:\*\*/, '**Approval is still held:**')}` : line;
}

/**
 * Returns why the PR's approval must be held now, a draft or a conflict with its base, and posts one
 * notice per head saying so. Returns `false` when it may be approved. `draftWhenUnread` decides when the PR can't be read.
 * `autoApprove` is the `auto_approve` setting, which the notice for a draft depends on.
 * With `refused`, it holds because GitHub refused the approval, and does not read the PR. Its `summary` follows the
 * notice's line, since that notice stands in for the approval that would have shown it.
 * `before` are the holds of the review that covers the head, which the notice says have cleared when they come earlier
 * in `CLEARED_HOLDS`. Pass them only once no warning holds the approval.
 */
async function holdApproval(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, headSha: string, draftWhenUnread = false,
  autoApprove = true, recordFor?: (reason: string) => string, refused?: { reason: 'refused'; summary?: string }, before: readonly ApprovalHeld[] = [],
): Promise<HeldApproval | false> {
  const hold = refused ?? await fetchApprovalHold(octokit, owner, repo, prNumber, draftWhenUnread);
  if (!hold) return false;
  const why = hold.reason === 'refused' ? 'GitHub refused the approval' : hold.reason === 'conflict' ? `PR conflicts with ${hold.baseRef}` : 'The PR is a draft';
  core.info(`${why}, so it is not approved`);
  assertWritesAllowed();
  const line = stillHeldLine(hold.reason === 'refused' ? REFUSED_LINE : approvalHoldLine(hold, autoApprove), hold.reason, before);
  const box = hold.reason === 'refused' ? undefined : approvalHoldBox(hold, autoApprove);
  // A refusal has its own marker, so a draft or conflict notice of the head does not stand in for it.
  const marker = `${APPROVAL_HELD_MARKER_PREFIX}${headSha}${hold.reason === 'refused' ? ':refused' : ''} -->`;
  let posted = false;
  try {
    const text = [withMessageBoxes(line, [box]), refused?.summary, recordFor?.(hold.reason)].filter(Boolean).join('\n\n');
    posted = await postNoticeOnce(octokit, bot, owner, repo, prNumber, marker, text);
  } catch (error) {
    core.warning(`Failed to post the approval-held notice: ${error instanceof Error ? error.message : error}`);
  }
  return { reason: hold.reason, line, ...(box && { box }), posted };
}

/**
 * Deletes the auto-approve withheld notice for `headSha`, every approval-held notice and the token service's conflict
 * note. Call it once a review posts its verdict on `headSha`.
 * Marks every older failed or incomplete review progress comment as superseded by that verdict, whatever commit it was for.
 * With `pauseLifted`, when that round lifted the pause, each pause notice that lost its settings block is marked as resumed.
 * With `noVerdict`, for a round no model read, it leaves the failed and incomplete progress comments as they are.
 * With `approvalOnly`, for an auto-approval, it deletes only the withheld and approval-held notices and leaves every other
 * comment as it is, the conflict note included. An auto-approval posts no review round, and it can approve while GitHub
 * has not said whether the PR conflicts.
 */
async function retireStaleNotices(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, headSha: string,
  { pauseLifted = false, approvalOnly = false, noVerdict = false } = {},
): Promise<void> {
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
      if (c.body.includes(marker) || c.body.includes(APPROVAL_HELD_MARKER_PREFIX) || (!approvalOnly && c.body.includes(CONFLICT_NOTE_MARKER))) {
        await octokit.rest.issues.deleteComment({ owner, repo, comment_id: c.id });
      } else if (approvalOnly) {
        continue;
      } else if (!noVerdict && isFailedProgress(c.body)) {
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

const HELD_FOR_PERSON_LINE = 'Manki\'s review of the head holds its approval for a person and says why, such as files no model read. Resolving threads does not lift that. A person approves, or the next review round decides.';

/**
 * Whether the review that covers `headSha` holds its approval for a person: the latest of the `standing` reviews, or any
 * on the head, as when a no-verdict round follows it.
 */
function heldForPerson(standing: ReviewEntry[], headSha: string): boolean {
  const held = (r?: ReviewEntry) => hasOwnMarker(r?.body ?? '', HELD_FOR_PERSON_MARKER);
  return held(standing.at(-1)) || standing.some(r => reviewedCommit(r) === headSha && held(r));
}

/**
 * What `approveOrSayWhy` decided. `standing` marks an approval that was already there. `why` tells a person why the PR is
 * not approved and what lifts that. `answered` marks a reason already posted on the PR. `held` names the hold the check
 * stopped at, when that hold is certain: a draft, a warning, files no model read, a config that did not load, a conflict
 * or a refusal by GitHub. A block, and a reason the check cannot name for certain, set none.
 */
type ApprovalCheck = { approved: true; standing?: true } | { approved: false; why: () => Promise<string>; answered?: true; held?: Exclude<ApprovalHeld, false> };

// A dismissed approval no longer covers the head, so resolving the threads alone approves nothing.
const WITHDRAWN_LINE = `A blocking thread is not cleared, so Manki withdrew its approval. ${NEXT_ROUND_LINE}`;
const NOT_WITHDRAWN_LINE = `A blocking thread is not cleared, but Manki could not dismiss every approval it gave, so this check fails instead. ${NEXT_ROUND_LINE}`;
const STILL_BLOCKED_LINE = `A blocking thread is not cleared, so this check no longer passes. ${NEXT_ROUND_LINE}`;

/**
 * Dismisses Manki's approvals while a blocking thread is not cleared, as after a reopen. It then fails the `Manki` check
 * on the head, so a required check no longer passes, and tries a failed check write once more. With no dismissal tried,
 * it fails the check only when the newest one passed. Only when it dismissed one and no dismissal failed does it also
 * clear the approval the coordinator recorded. It never approves, so it also runs where `auto_approve` is off and only
 * a review round approves. Without every round record each thread counts as blocking, which proves no blocker, so it then
 * dismisses nothing.
 */
async function withdrawBlockedApproval(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, prAuthorLogin: string | undefined, clearRole: AuthorClearRole | undefined,
): Promise<void> {
  let threads: ReviewThread[];
  try {
    threads = await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber, undefined, 'any');
  } catch (error) {
    core.warning(`Could not read the grades of every review thread, so no approval is withdrawn: ${error instanceof Error ? error.message : error}`);
    return;
  }
  const prAuthorRole = await overrideRole(octokit, owner, repo, threads, prAuthorLogin, clearRole);
  if (unclearedThreads(threads, bot, prAuthorLogin, prAuthorRole).length === 0) return;
  const { dismissed, failed } = await dismissPreviousReviews(octokit, bot, owner, repo, prNumber, undefined, 'APPROVED');
  // An approval whose dismissal failed still stands, so the coordinator's record of it stays. The check fails anyway.
  if (dismissed > 0 && !failed) await reportPrState(owner, repo, prNumber, { approval: null });
  const line = failed ? NOT_WITHDRAWN_LINE : dismissed > 0 ? WITHDRAWN_LINE : STILL_BLOCKED_LINE;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
      // With no dismissal tried, only a check that still passes needs to fail.
      if (line === STILL_BLOCKED_LINE && !await newestCheckPassed(octokit, bot, owner, repo, pr.head.sha)) return;
      if (await reportCheck(octokit, owner, repo, pr.head.sha, outcomeReport('ADDRESS_FIRST', line))) return;
    } catch (error) {
      assertWritesAllowed();
      core.warning(`A blocking thread is not cleared, but Manki could not read the head to fail its check: ${error instanceof Error ? error.message : error}`);
    }
  }
  core.warning('A blocking thread is not cleared, but Manki could not fail its check, so a required check may pass until the next review round');
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
  return (await approveOrSayWhy(octokit, bot, owner, repo, prNumber, config)).approved;
}

/**
 * Post an approval review if all findings are resolved, and return the decision with its reason. With `head`, it decides
 * and writes nothing unless that commit is still the PR's head.
 */
async function approveOrSayWhy(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
  config?: ReviewConfig,
  head?: string,
): Promise<ApprovalCheck> {
  /** Declines with the reason `why`. Every exit states `held`: the hold it is certain of, or `false` for a block and for a reason it cannot name. */
  const withheld = (why: string | (() => Promise<string>), held: ApprovalHeld): Extract<ApprovalCheck, { approved: false }> =>
    ({ approved: false, why: typeof why === 'string' ? async () => why : why, ...(held && { held }) });
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
  if (pr.state === 'closed') {
    core.info('Skipping auto-approve — the PR is merged or closed');
    return withheld(`This pull request is ${pr.merged ? 'merged' : 'closed'}, so Manki approves nothing on it.`, false);
  }
  if (head && pr.head.sha !== head) {
    core.info(`Skipping auto-approve — the head is ${pr.head.sha.slice(0, 7)}, no longer ${head.slice(0, 7)}`);
    return withheld(`The head of this pull request is no longer \`${head.slice(0, 7)}\`, so Manki decides nothing for that commit.`, false);
  }
  const prAuthorLogin = pr.user?.login;
  const clearRole = config?.author_clear_role;
  const listReviews = () => octokit.paginate(octokit.rest.pulls.listReviews, { owner, repo, pull_number: prNumber, per_page: 100 });
  let haltRead: ReturnType<typeof autoReviewHalt> | undefined;
  /** Why no automatic review will start on the head, read once. */
  const halt = () => haltRead ??= config ? autoReviewHalt(octokit, bot, owner, repo, prNumber, config) : Promise.resolve(undefined);
  /**
   * Lists every reason that holds the approval, for a person who asks: the threads that block, the warning threads, a
   * review held for a person, then a draft or a conflict. Each check below returns at the first reason it finds, and
   * the reply to it still names them all.
   */
  const explain = async (role: AuthorClearRole | undefined): Promise<string> => {
    const reviews = await listReviews();
    const standing = await standingReviews(octokit, bot, owner, repo, prNumber, pr.head.sha, reviews);
    const covered = await coveredCommit(octokit, bot, owner, repo, prNumber, pr, standing);
    const block = covered ? blockOf(reviews, bot, covered, threads, owner, repo, prNumber) : undefined;
    const instead = block ? block.held && `${block.held}\n\n${NEXT_ROUND_LINE}` : unreviewedLine(pr.head.sha, await halt());
    const open = unclearedThreads(threads, bot, prAuthorLogin, role, block?.named);
    const warnings = await heldWarnings(octokit, owner, repo, threads, bot, prAuthorLogin, role, clearRole);
    const hold = pr.draft ? { reason: 'draft' as const } : await fetchApprovalHold(octokit, owner, repo, prNumber);
    const lead = open.length > 0 ? blockingThreadsLine(open, block?.named ?? new Set(), bot, clearRole, instead || undefined) : instead;
    const holdBox = hold && approvalHoldBox(hold, config?.auto_approve);
    // `instead` ends the lead and names the review box or the review command as the next step, so its box follows the lead.
    return [
      lead && withMessageBoxes(lead, [!!instead && 'again']),
      warnings.length > 0 && warningThreadsLine(warnings, bot, clearRole),
      covered && heldForPerson(standing, pr.head.sha) && HELD_FOR_PERSON_LINE,
      hold && withMessageBoxes(approvalHoldLine(hold, config?.auto_approve), [!(instead && holdBox === 'again') && holdBox]),
    ].filter((line): line is string => !!line).join('\n\n');
  };
  const prAuthorRole = await overrideRole(octokit, owner, repo, threads, prAuthorLogin, clearRole);
  const why = () => explain(prAuthorRole);
  const uncleared = (named?: ReadonlySet<string>) => unclearedThreads(threads, bot, prAuthorLogin, prAuthorRole, named);
  if (pr.draft) {
    core.info('Skipping auto-approve — the PR is a draft');
    // A blocking thread holds a draft too, and a block names no hold.
    return withheld(why, uncleared().length > 0 ? false : 'draft');
  }

  const overrides = threads.flatMap(t => {
    const o = securityOverrideOf(t, prAuthorLogin, prAuthorRole);
    return o ? [{ ...o, thread: t.id, title: t.findingTitle, threadUrl: t.threadUrl }] : [];
  });
  await announceSecurityOverrides(octokit, overrides.filter(o => !o.announced));

  if (uncleared().length > 0) {
    core.info('Not all blocking findings resolved — skipping auto-approve');
    await withdrawBlockedApproval(octokit, bot, owner, repo, prNumber, prAuthorLogin, clearRole);
    return withheld(why, false);
  }

  const reviews = await listReviews();
  const standing = await standingReviews(octokit, bot, owner, repo, prNumber, pr.head.sha, reviews);
  const latestBotReview = standing.at(-1);

  // Stale-SHA gate: bail unless a Manki review covers the current HEAD. This covers
  // every variant: stale prior review, a review that names no commit, all reviews dismissed other than by a person, or
  // no bot review at all.
  const covered = await coveredCommit(octokit, bot, owner, repo, prNumber, pr, standing);
  if (!covered) {
    const staleSha =
      reviews.filter((r: ReviewEntry) => isBotReview(bot, r)).map(reviewedCommit).filter(sha => sha && sha !== pr.head.sha).at(-1) ?? 'unknown';
    core.warning(
      `Skipping auto-approve — manki has not reviewed HEAD (head=${pr.head.sha}, stale=${staleSha})`,
    );
    // A push review takes about a minute to post its progress comment, so the lack of one does not mean no review is coming.
    const halted = await halt();
    if (halted) {
      await postStaleApproveSkippedComment(octokit, bot, owner, repo, prNumber, pr.head.sha, staleSha, halted.text, approvalRecord('withheld', halted.cause, pr.head.sha));
    } else {
      core.info(`A push review covers ${pr.head.sha.slice(0, 7)}, so no withheld notice is posted`);
    }
    return withheld(why, false);
  }

  // An open warning thread declines as an open blocking thread does, also beside an approval that stands.
  const warnings = await heldWarnings(octokit, owner, repo, threads, bot, prAuthorLogin, prAuthorRole, clearRole);
  if (warnings.length > 0) {
    core.info('A warning thread holds the approval — skipping auto-approve');
    return withheld(why, 'warnings');
  }

  if (latestBotReview?.state === 'APPROVED') {
    core.info('Already approved — skipping duplicate approval');
    // A check left in progress or stale on the head would hide the approval, and a passing one needs no other.
    if (!await newestCheckPassed(octokit, bot, owner, repo, pr.head.sha)) {
      await reportCheck(octokit, owner, repo, pr.head.sha, outcomeReport('READY', 'Manki\'s approval of this commit stands.'));
    }
    return { approved: true, standing: true };
  }

  const block = blockOf(reviews, bot, covered, threads, owner, repo, prNumber);
  if (heldForPerson(standing, pr.head.sha)) {
    core.info('The review that covers the head holds its approval for a person, such as for unread files — skipping auto-approve');
    return withheld(why, block.hold ?? false);
  }

  if (block.held) {
    core.info(`${block.held}\nSkipping auto-approve, the next review round decides`);
    return withheld(why, block.hold ?? false);
  }
  // A thread the record names for a blocker blocks whatever its own severity says.
  const open = uncleared(block.named);
  if (open.length > 0) {
    core.info('A thread the covering review blocks on is not resolved — skipping auto-approve');
    return withheld(why, false);
  }

  const recordFor = (cause: string) => approvalRecord('held', cause, pr.head.sha);
  /**
   * Reports the held approval, and the check once, with the notice. A later round reports its own check and deletes the
   * notice, so a hold after it reports again. A notice this check posted already answers a person.
   */
  const heldBy = async (held: HeldApproval): Promise<ApprovalCheck> => {
    await reportPrState(owner, repo, prNumber, { approval: { commit: pr.head.sha, held: true } });
    if (held.posted) await reportCheck(octokit, owner, repo, pr.head.sha, outcomeReport('READY', held.line, held.reason));
    return { ...withheld(withMessageBoxes(held.line, [held.box]), held.reason), ...(held.posted && { answered: true as const }) };
  };
  // The holds of the covering review, which a notice names as cleared. No warning holds by now.
  const before: ApprovalHeld[] = block.approval ? [block.approval.held, ...(block.approval.warningsHeld ? ['warnings' as const] : [])] : [];
  const hold = await holdApproval(octokit, bot, owner, repo, prNumber, pr.head.sha, false, config?.auto_approve, recordFor, undefined, before);
  if (hold) return heldBy(hold);

  const comments = await fetchPRComments(octokit, owner, repo, prNumber).catch((error: unknown) => {
    core.warning(`Failed to look up an earlier failed auto-approve, posting a new comment: ${error instanceof Error ? error.message : error}`);
    return [];
  });
  const progressCommentId = await postAutoApproveProgressComment(octokit, owner, repo, prNumber, pr.head.sha, failedAutoApproveId(comments, bot, pr.head.sha));

  core.info('All findings resolved — auto-approving');
  let refusal: HeldApproval | false = false;
  // A visible body so the API does not render this review as `body_length: 0`.
  // An empty review body trips the head-SHA dedupe gate (`hasBotReviewOnCommit`)
  // for any subsequent force-review tick on the same commit ([#840]).
  const overrideLine = formatSecurityOverrides(overrides);
  const cleared = threads.some(t => t.isWarning) ? 'All blocking threads are resolved, and no warning thread holds the approval.' : 'All blocking threads are resolved.';
  const reason = overrides.length > 0 ? `all blocking threads are resolved, ${overrides.length} by a security override` : 'all blocking threads are resolved';
  const report = formatReadyReport(block.report);
  const body = withMarkers(
    [`${APPROVED_LINE} ${cleared}`, report?.whatThisDoes, overrideLine, report?.whatToTest].filter(Boolean).join('\n\n'),
    BOT_MARKER, AUTO_APPROVE_MARKER, approvalRecord('approved', reason, pr.head.sha),
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
      // Each step after the approval catches its own failure, so only the write stop still throws from here on. A
      // caller can therefore read any other failure as "nothing was approved".
      // An approval ends the pause, so the coordinator again starts push reviews.
      await reportPrState(owner, repo, prNumber, { approval: { commit: pr.head.sha, held: false }, pause: null });
      await dismissPreviousReviews(octokit, bot, owner, repo, prNumber);
      await reportCheck(octokit, owner, repo, pr.head.sha, outcomeReport('READY', cleared));
      await retireStaleNotices(octokit, bot, owner, repo, prNumber, pr.head.sha, { approvalOnly: true });
    } catch (error) {
      if (!isApprovalSettingRefusal(error)) throw error;
      // Do not fall back to a `COMMENT` review here. A `COMMENT` placeholder
      // with this body would still register as a bot review on the head SHA
      // and break the force-review tickbox loop ([#840]). Surface the missing
      // permission via an issue comment instead, which carries no review state.
      core.warning(
        'Failed to auto-approve PR. Ensure "Allow GitHub Actions to create and approve pull requests" is enabled in repo settings.',
      );
      const summary = [report?.whatThisDoes, report?.whatToTest].filter(Boolean).join('\n\n');
      refusal = await holdApproval(octokit, bot, owner, repo, prNumber, pr.head.sha, false, config?.auto_approve, recordFor, { reason: 'refused', ...(summary && { summary }) }, before);
    }
  } catch (error) {
    // A cancelled run leaves its progress comment to the post step.
    assertWritesAllowed();
    const rawReason = error instanceof Error ? error.message : String(error);
    await markProgressCommentFailed(octokit, owner, repo, progressCommentId, 'Auto-approve', rawReason, undefined, [autoApproveHeadMarker(pr.head.sha)]);
    throw error;
  }

  await deleteAutoApproveProgressComment(octokit, owner, repo, progressCommentId);
  // A refused approval is held, as in a review round.
  return refusal ? heldBy(refusal) : { approved: true };
}

export { ApprovalCheck, PauseState, ResolutionReason, ReviewThread, announceSecurityOverrides, recordDismissal, approveOrSayWhy, authorClearLine, authorResolvedNote, autoReviewHalt, checkAndAutoApprove, deleteThreadReply, fetchBotReviewThreads, fetchHeldWarnings, fixedMarker, findUnchangedVerdict, holdApproval, isNewChange, pauseState, reopenAuthorResolvedThreads, reopenThread, replyToReviewThread, rolePhrase, resolveReviewThread, retireStaleNotices, unclearedThreads, unresolveReviewThread, warningHoldNote, withdrawBlockedApproval, BOT_MARKER, STALE_APPROVE_MARKER_PREFIX, TRACKED_MARKER };
