#!/usr/bin/env node
import * as core from '@actions/core';
import * as github from '@actions/github';

import { assertWritesAllowed, RunCancelledError, stopWritesOn } from './abort';
import { AuthResult, createAuthenticatedOctokit, createOctokit, fetchPrState, reportPrState, tokenServiceCalls, TokenServiceError } from './auth';
import { COMMENT_MARKER, redactSecrets, redactSecretsDeep, sanitizeTokens, withMarkers } from './utils';
import { CONFIG_PATH, fallbackConfig, loadConfig, resolveModel } from './config';
import { BENCH_COMMAND, runBenchCommand } from './bench';
import { REVIEW_COMMAND, runReviewCommand } from './cli';
import { buildAuthForProvider, createLLMClient, hasAnyProviderCredentials, latestLimits, parseModelSpec, removeSeededAuthFiles, sanitizeLogOutput } from './providers';
import type { LLMClient, ProviderAuth, ProviderInputs } from './providers';
import { cancelOpenReviewCheck, CheckReport, completeReviewCheck, failedReport, hasQueuedCheck, outcomeReport, reportCheck, ReviewCheck, startReviewCheck } from './check-run';
import { extractCurrentCodeWindow, locatePostedFile, locatePostedLine } from './code-window';
import { FixRateHistory, readFixRateHistory, recordFixRate } from './fix-rate';
import { APPROVAL_CHECK_ACTION, dispatchedInputs, dispatchedNumber, eventPrClosed, isDispatchedRun, restoreDispatchedEvent, startedByCatchUp } from './dispatch';
import { addCodeContext, changeDigest, hideSeenNotes, onlyCommitChanging, parsePRDiff, filterDiff, filterRawDiff, ownChangeSince, rebuildRawDiff, reviewableDiff, shortenLongLines, tagFindingOrigins, findClosedPattern } from './diff';
import { handleBoxCommand, handleReviewCommentReply, handleReviewCommentCommand, handlePRComment, isReviewRequest, isBotMentionNonReview, hasBotMention, mentionsMankiUser, parseCommand, isLLMAccessAllowed } from './interaction';
import { isEmptyInterRoundDiff } from './judge';
import { isParsedLockfile, LockfileDiff, lockfilesLast, readLockfileChanges, withLockfiles } from './lockfile';
import { loadMemory, MemoryRefusedError, MemorySkip, openMemoryStore, RepoMemory } from './memory';
import { MCP_SERVER_COMMAND, runMcpServer } from './mcp-server';
import { findRelatedWork } from './related-work';
import { currentFindingLine, fetchRecapState, FOUND_AGAIN_MARKER, isGuarded, parseContextBlocks, PreviousFinding, pushTouchesThread, RAISED_MARKER, RecapState, replyClassOf, replyShownToJudge, securityOverridesIn } from './recap';
import { carryBodyWarnings, citedPlaces, filesChangedByPush, RETRY_HINT, ReviewClients, ReviewOptions, ROUND_TIME_MS, runReview } from './review';
import { findPriorThreadId, stringifyFindingFingerprint } from './finding-fingerprint';
import { buildReviewClients, warmUpClients } from './review-clients';
import { roundReplyMarker } from './review-record';
import { buildRoundContext, mergedDuplicateCount, RoundRecordInput } from './round-context';
import { formatRunner, recordQueueWait, runnerDiagnostics, startMemorySampler } from './run-diagnostics';
import { collectStaticSignals, fetchLockfiles } from './static-signals';
import { runStepHook, STEP_HOOK_COMMAND } from './tool-steps';
import { fetchWorkspace } from './workspace';
import { messageBox, tickedIssueBoxes, tickedMessageBoxes, withMessageBoxes } from './issue-box';
import { handleIssueBoxTick, handleReviewBoxTick, settleTickedBox, TickedMessage } from './issue-tick';
import { parseSettingsBlock, SETTINGS_MARKER, SettingsBox, SettingsView, withSettingsBlock } from './settings';
import { ConfigSource, partlyFixedEffect, DashboardData, disproof, DisprovedFinding, EarlierAttempt, Finding, findingKey, fixThreadFiles, FullReviewOptions, isSecurityFinding, LaterDrop, MemoryLoadStatus, OpenThread, ParsedDiff, PrContext, RelatedWork, ReviewConfig, ReviewMetadata, ReviewModels, ReviewResult, RoundContext, RoundOutcome, RoundStaticAnalysis, PrState, RecordOnlyReason, RoundTrigger, StateReport, StaticSignal, UnpostedReason, roundContextToFlatAliases, SCOPE_READER_NAME, SEVERITY_NAME, threadBlocks, SkippedFile } from './types';
import {
  fetchPRDiff,
  brokenConfig,
  ConfigHold,
  configFailed,
  editedKeys,
  loadBaseConfig,
  readConfigFile,
  githubRepoFiles,
  openRepoFiles,
  fetchRepoContext,
  formatUnreviewedNotice,
  fetchFileContents,
  LeftOutFile,
  MAX_CONTENT_API_BYTES,
  fetchChangesSince,
  fetchInterRoundDiff,
  fetchCommitDiff,
  fetchCommitsSince,
  formatFoundAgainReply,
  formatVariantReply,
  fetchHeadSha,
  assertHeadUnchanged,
  SupersededError,
  PrClosedError,
  TooManyFilesError,
  postProgressComment,
  updateProgressComment,
  startLiveEdits,
  updateProgressDashboard,
  dismissPreviousReviews,
  postReview,
  capNotes,
  earlierPlaces,
  holdsApproval,
  limitFallbackLines,
  formatOpenBlockers,
  unreadRecordsLine,
  withheldSummary,
  roundSentence,
  roundSummary,
  reactToIssueComment,
  fetchLinkedIssues,
  APPROVED_LINE,
  autoApproveHeadMarker,
  BOT_MARKER as PROGRESS_MARKER,
  isBotLogin,
  sanitizeMarkdown,
  titleToSlug,
  isApprovedOnCommit,
  hasBotReviewOnCommit,
  findBotReviewOnCommit,
  fetchApprovalHold,
  alsoHeldLine,
  fetchMergeBase,
  REVIEW_STATE_VERDICTS,
  fetchPRComments,
  fetchReviewThreadNodes,
  hasWriteAccess,
  inline,
  isFailedProgress,
  markOwnProgressCommentCancelled,
  markProgressCommentFailed,
  markFailedProgressSuperseded,
  markProgressCommentSuperseded,
  latestSettings,
  PAUSE_NOTICE_MARKER,
  REVIEW_COMPLETE_MARKER,
  REVIEW_INCOMPLETE_LINE,
  retireSettingsBlocks,
  setSettingsBlock,
  showSettings,
  skippedFiles,
  wasEdited,
} from './github';
import type { ApprovalHeld, BotIdentity, EarlierPlace, LinkedIssue, StandingVerdict } from './github';
import { announceSecurityOverrides, approveOrSayWhy, authorClearLine, autoReviewHalt, checkAndAutoApprove, deleteThreadReply, fetchBotReviewThreads, fetchHeldWarnings, findUnchangedVerdict, fixedMarker, holdApproval, isNewChange, pauseState, reopenAuthorResolvedThreads, reopenThread, replyToReviewThread, resolveReviewThread, retireStaleNotices, unresolveReviewThread, withdrawBlockedApproval } from './state';
import type { PauseState, ReviewThread } from './state';

type Octokit = ReturnType<typeof github.getOctokit>;

const HEAD_POLL_MS = 30_000;
/** Commits since the last review past which a fix reply names the range, so a round reads at most this many diffs. */
const MAX_FIXING_COMMITS = 20;

/** The outcome a standing review reports on a no-op push. A COMMENT never stands, so it runs a full round instead. */
const STANDING_OUTCOMES: Record<StandingVerdict['verdict'], RoundOutcome> = { APPROVE: 'READY', REQUEST_CHANGES: 'ADDRESS_FIRST' };
const ALREADY_REVIEWED_TEXT = 'This commit already has a review.';

/**
 * Build `RoundMeta.trigger` from the current GitHub Actions event. The event
 * string folds in the action and, for an edit of the settings block or a box
 * in another message, the box modes of the run, so a `5/5 -> 6/5` jump in the
 * round-cap counter is attributable to the exact box that fired.
 */
function buildRoundTrigger(modes: ReadonlySet<string> = new Set()): RoundTrigger {
  const eventName = github.context.eventName;
  const payload = github.context.payload;
  const action = payload.action;
  const sender = payload.sender?.login ?? 'unknown';

  let event = action ? `${eventName}:${action}` : eventName;
  const body = (eventName === 'pull_request_review' ? payload.review?.body : payload.comment?.body) ?? '';
  const sorted = modes.size > 0 ? [[...modes].sort().join(',')] : [];
  if (eventName === 'issue_comment' && action === 'edited' && body.includes(SETTINGS_MARKER)) {
    event = [`${event}:settings`, ...sorted].join(':');
  } else if (action === 'edited' && sorted.length > 0) {
    event = [`${event}:box`, ...sorted].join(':');
  } else if (eventName === 'issue_comment' && action === 'created' && isReviewRequest(body)) {
    event = `${event}:/manki review`;
  }
  return { event, sender, ...(startedByCatchUp() && { catchUp: true as const }) };
}

function readProviderInputs(): ProviderInputs {
  return {
    anthropicOauthToken: core.getInput('claude_code_oauth_token'),
    anthropicApiKey: core.getInput('anthropic_api_key'),
    openaiOauthToken: core.getInput('openai_oauth_token'),
    openaiOauthFile: core.getInput('openai_oauth_file'),
    openaiApiKey: core.getInput('openai_api_key'),
    openaiBaseUrl: core.getInput('openai_base_url'),
    geminiOauthToken: core.getInput('gemini_oauth_token'),
    geminiApiKey: core.getInput('gemini_api_key'),
  };
}

function buildLLMClientFromInputs(opts: {
  inputs: ProviderInputs;
  model: string;
}): { client: LLMClient } | null {
  let spec: ReturnType<typeof parseModelSpec>;
  try {
    spec = parseModelSpec(opts.model);
  } catch (error) {
    core.setFailed(`Invalid model config: ${error instanceof Error ? error.message : error}`);
    return null;
  }
  let auth: ProviderAuth;
  try {
    auth = buildAuthForProvider(spec.provider, opts.inputs);
  } catch (error) {
    core.setFailed(`Missing credentials for provider "${spec.provider}": ${error instanceof Error ? error.message : error}`);
    return null;
  }
  try {
    return { client: createLLMClient(spec.provider, spec.model, auth) };
  } catch (error) {
    core.setFailed(`Invalid model config: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

let authCache: AuthResult | null = null;

async function getAuth(): Promise<AuthResult> {
  if (!authCache) {
    authCache = await createAuthenticatedOctokit();
    hintSlashForm(authCache.octokit);
  }
  return authCache;
}

/** A client on the workflow's own `github_token`, which needs no call to the token service. */
async function workflowOctokit(): Promise<Octokit> {
  const token = core.getInput('github_token');
  return token ? createOctokit(token) : (await getAuth()).octokit;
}

/** Whether the commenter may start Manki. Refuses without a comment, so a stranger cannot make Manki post. */
async function commenterAllowed(): Promise<boolean> {
  const { owner, repo } = github.context.repo;
  if (await isLLMAccessAllowed(await workflowOctokit(), owner, repo)) return true;
  const { sender, comment } = github.context.payload;
  core.info(`Ignoring comment from ${sender?.login ?? 'unknown user'} (${comment?.author_association ?? 'unknown association'}): no write access`);
  return false;
}

/** Marks the comments Manki writes while it answers comment `commentId`. Unlike the eyes reaction, the webhook service never writes it. */
function answeredMarker(commentId: number): string {
  return `<!-- manki-answered:${commentId} -->`;
}

const CREATE_COMMENT = 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments';
const EDIT_COMMENT = 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}';
const CREATE_THREAD_REPLY = 'POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies';

const SLASH_HINT = 'Next time, write `/manki` instead of `@manki`. `@manki` is the login of an unrelated GitHub user, who gets a notification each time.';

/** Whether this run answers a person's command that mentions `@manki`. A reply in a review thread that is no command does not count. */
function answersMankiMention(): boolean {
  const { eventName, payload } = github.context;
  const body: string = payload.comment?.body ?? '';
  if (body.includes('<!-- manki') || !mentionsMankiUser(body)) return false;
  return eventName === 'issue_comment' || (eventName === 'pull_request_review_comment' && parseCommand(body).type !== 'generic');
}

/** The clients that `hintSlashForm` has hooked. */
const hinting = new WeakSet<Octokit>();

/**
 * Adds `SLASH_HINT` to every PR, issue or thread comment `octokit` creates in a run that `answersMankiMention`, above
 * the comment's hidden markers. A comment with the settings block stays as it is, since the block has to end it.
 */
function hintSlashForm(octokit: Octokit): void {
  if (hinting.has(octokit)) return;
  hinting.add(octokit);
  octokit.hook.wrap('request', async (request, options) => {
    const route = `${options.method} ${options.url}`;
    if ((route === CREATE_COMMENT || route === CREATE_THREAD_REPLY) && typeof options.body === 'string' && !options.body.includes(SETTINGS_MARKER) && answersMankiMention()) {
      options.body = options.body.replace(/(?:\n+<!--[^\n]*-->)*\s*$/, markers => `\n\n${SLASH_HINT}${markers}`);
    }
    return request(options);
  });
}

/** The marker a client adds while it answers a comment, and the ids of the comments it created for that answer. */
const answering = new WeakMap<Octokit, { marker: string; created: Set<number> }>();

/**
 * Adds `answeredMarker(commentId)` to every PR or issue comment `octokit` creates from now on, and to its later edits of
 * those comments. An edit of an older comment keeps the marker of the answer it belongs to.
 */
function markAnswers(octokit: Octokit, commentId: number): void {
  if (!answering.has(octokit)) {
    octokit.hook.wrap('request', async (request, options) => {
      const current = answering.get(octokit);
      const route = `${options.method} ${options.url}`;
      const ours = route === CREATE_COMMENT || (route === EDIT_COMMENT && !!current?.created.has(Number(options.comment_id)));
      if (current && ours && typeof options.body === 'string' && !options.body.endsWith(current.marker)) {
        options.body = `${options.body}\n${current.marker}`;
      }
      const response = await request(options);
      if (current && route === CREATE_COMMENT) current.created.add(response.data.id);
      return response;
    });
  }
  answering.set(octokit, { marker: answeredMarker(commentId), created: new Set() });
}

/** Whether one of Manki's `comments` answers comment `commentId`. Only a marker on the last line counts, since a comment can quote user text. */
function isAnswered(comments: Awaited<ReturnType<typeof fetchPRComments>>, bot: BotIdentity, commentId: number): boolean {
  const marker = answeredMarker(commentId);
  return comments.some(c => isBotLogin(bot, c.user?.login) && c.body?.trimEnd().endsWith(marker));
}

async function run(): Promise<void> {
  const eventName = github.context.eventName;
  const action = github.context.payload.action;

  core.info(`Event: ${eventName}, Action: ${action}`);

  // Prevent self-triggering — skip events caused by any bot
  const senderType = github.context.payload.sender?.type ?? '';
  // A tick in Manki's own review is an edit of a bot's review by a person, whose write access is checked below.
  const reviewAuthorType = action === 'edited' ? '' : github.context.payload.review?.user?.type ?? '';
  if (senderType === 'Bot' || reviewAuthorType === 'Bot') {
    const actor = senderType === 'Bot'
      ? (github.context.payload.sender?.login ?? 'unknown bot')
      : (github.context.payload.review?.user?.login ?? 'unknown bot');
    core.info(`Ignoring event from bot: ${actor}`);
    return;
  }

  let settingsTick = false;
  /** A tick of a finding's issue box or of a box in another message of Manki's than the settings block. */
  let boxTick = false;

  // Event filtering — exit immediately for irrelevant events.
  // Tested via integration (live PR reviews) since it depends on GitHub Actions context.
  if (eventName === 'pull_request') {
    if (action !== 'opened' && action !== 'synchronize' && action !== 'ready_for_review' && action !== 'closed' && action !== APPROVAL_CHECK_ACTION) {
      core.info(`Ignoring pull_request action: ${action}`);
      return;
    }
    if (action === 'closed' && !github.context.payload.pull_request?.merged) {
      core.info('Ignoring pull_request closed without merging');
      return;
    }
  } else if (eventName === 'issue_comment') {
    if (action !== 'created' && action !== 'edited') {
      core.info(`Ignoring issue_comment action: ${action}`);
      return;
    }
    const body = github.context.payload.comment?.body ?? '';
    const mentioned = hasBotMention(body) || isReviewRequest(body);
    const settingsEdit = action === 'edited' && body.includes(SETTINGS_MARKER);
    const boxEdit = action === 'edited' && !settingsEdit && tickedMessageBoxes(body).length > 0;
    if (!mentioned && !settingsEdit && !boxEdit) {
      core.info('Comment does not mention Manki — ignoring');
      return;
    }
    if (!await commenterAllowed()) return;
    const { bot } = await getAuth();
    // A bot's edit never gets here, but Manki on a personal access token edits as that user.
    const tickedOwn = isBotLogin(bot, github.context.payload.comment?.user?.login) && !isBotLogin(bot, github.context.payload.sender?.login);
    settingsTick = settingsEdit && tickedOwn;
    boxTick = boxEdit && tickedOwn;
    if (!settingsTick && !boxTick && !mentioned) {
      core.info('Comment does not mention Manki — ignoring');
      return;
    }
    const commentId = github.context.payload.comment?.id;
    const issueNumber = github.context.payload.issue?.number;
    // Every tick of a box starts its own run, which the coordinator's modes describe, so none counts as answered.
    if (commentId && issueNumber && !settingsTick && !boxTick) {
      const { octokit, bot } = await getAuth();
      const { owner, repo } = github.context.repo;
      if (action === 'edited') {
        try {
          if (isAnswered(await fetchPRComments(octokit, owner, repo, issueNumber), bot, commentId)) {
            core.info('Manki already answered this comment, skipping the edit');
            return;
          }
        } catch (error) {
          core.warning(`Could not check whether Manki already answered comment ${commentId}, handling the edit: ${error instanceof Error ? error.message : error}`);
        }
      }
      markAnswers(octokit, commentId);
    }
  } else if (eventName === 'pull_request_review_comment') {
    if (action === 'edited') {
      // Only a tick of a box in Manki's own comment matters. The editor needs write access.
      const comment = github.context.payload.comment;
      if (!hasTickedBox(comment?.body ?? '')) {
        core.info('Edited review comment has no ticked box, ignoring');
        return;
      }
      if (!await commenterAllowed()) return;
      const { bot } = await getAuth();
      if (!isBotLogin(bot, comment?.user?.login)) {
        core.info('Edited review comment is not one of Manki\'s, ignoring');
        return;
      }
      boxTick = true;
    } else if (action !== 'created') {
      core.info(`Ignoring pull_request_review_comment action: ${action}`);
      return;
    }
    // Skip our own review comments
    const commentBody = github.context.payload.comment?.body ?? '';
    if (!boxTick && commentBody.includes('<!-- manki')) {
      core.info('Ignoring our own review comment');
      return;
    }
    if (!boxTick && !await commenterAllowed()) return;
  } else if (eventName === 'pull_request_review') {
    if (action === 'edited') {
      // Only a tick of a box in Manki's own review matters. The editor needs write access.
      const review = github.context.payload.review;
      if (!hasTickedBox(review?.body ?? '')) {
        core.info('Edited review has no ticked box, ignoring');
        return;
      }
      if (!await commenterAllowed()) return;
      const { bot } = await getAuth();
      if (!isBotLogin(bot, review?.user?.login)) {
        core.info('Edited review is not one of Manki\'s, ignoring');
        return;
      }
      boxTick = true;
    } else if (action !== 'submitted' && action !== 'dismissed') {
      core.info(`Ignoring pull_request_review action: ${action}`);
      return;
    }
  } else if (eventName === 'pull_request_review_thread') {
    if (action !== 'resolved' && action !== 'unresolved') {
      core.info(`Ignoring pull_request_review_thread action: ${action}`);
      return;
    }
  } else {
    core.info(`Ignoring unsupported event: ${eventName}`);
    return;
  }

  // Route to the appropriate handler
  switch (eventName) {
    case 'pull_request':
      if (action === 'closed') {
        await handleMergedPullRequest();
      } else if (action === APPROVAL_CHECK_ACTION) {
        core.info('Approval check asked for, checking if auto-approve is warranted');
        await handleReviewStateCheck();
      } else {
        await handlePullRequest();
      }
      break;

    case 'issue_comment': {
      const commentBody = github.context.payload.comment?.body ?? '';
      if (settingsTick && github.context.payload.issue?.pull_request) {
        await handleCommentTrigger(true);
      } else if (boxTick && github.context.payload.issue?.pull_request) {
        await handleBoxTick();
      } else if (isReviewRequest(commentBody) && github.context.payload.issue?.pull_request) {
        await handleCommentTrigger();
      } else if (isBotMentionNonReview(commentBody) && github.context.payload.issue?.pull_request) {
        await handleInteraction();
      } else if (isBotMentionNonReview(commentBody) && !github.context.payload.issue?.pull_request) {
        await handleIssueInteraction();
      }
      break;
    }

    case 'pull_request_review_comment':
      if (boxTick) {
        await handleTicks();
      } else {
        await handleReviewCommentInteraction();
      }
      break;

    case 'pull_request_review':
      if (boxTick) {
        await handleTicks();
        break;
      }
      core.info('Review submitted/dismissed — checking if auto-approve is warranted');
      await handleReviewStateCheck();
      break;

    case 'pull_request_review_thread':
      core.info(`Review thread ${action}, checking if auto-approve is warranted`);
      await handleReviewStateCheck();
      break;
  }
}

/** Whether `body` has a ticked issue box or another ticked box of Manki's outside the settings block. */
function hasTickedBox(body: string): boolean {
  return tickedIssueBoxes(body).length > 0 || tickedMessageBoxes(body).length > 0;
}

/** The state of a PR the coordinator has nothing on: not paused, and no box modes. */
const NO_SETTINGS: PrState = { settings: { paused: false }, runModes: new Set(), queuedModes: new Set(), queuedReplies: new Set() };

/**
 * Returns the PR's coordinator state. Without one, as on a run with no OIDC token, the PR counts as not paused with no
 * box modes, so a push still gets its review. Throws `TokenServiceError` when the token service fails to answer.
 */
async function loadSettings(owner: string, repo: string, prNumber: number): Promise<PrState> {
  return await fetchPrState(owner, repo, prNumber, github.context.runId) ?? NO_SETTINGS;
}

/**
 * The boxes that apply to a PR: Pause, Review again and Deeper review always, Review this draft on a draft, Review every
 * push on a draft whose state offers it (`offersAuto`), and `extra`.
 */
function settingsBoxes(draft: boolean, offersAuto: boolean, extra: SettingsBox[] = []): Set<SettingsBox> {
  return new Set<SettingsBox>(['pause', 'again', 'deeper', ...(draft ? ['draft' as const] : []), ...(draft && offersAuto ? ['auto' as const] : []), ...extra]);
}

/** Whether the coordinator offers the Review every push box on the PR. */
const offersAuto = ({ settings }: PrState): boolean => settings.auto !== undefined;

/** The boxes the coordinator state ticks: Pause while paused, Review every push while set, and each box whose run is still queued. */
function tickedBoxes({ settings, queuedModes }: PrState): Set<SettingsBox> {
  return new Set<SettingsBox>([...(settings.paused ? ['pause' as const] : []), ...(settings.auto ? ['auto' as const] : []), ...queuedModes]);
}

/**
 * How a run reviews. Any box a writer ticked reviews even a draft, or an already reviewed, paused or too big PR.
 * `again` counts every finding as new, and `deeper` moves a group with fewer than two finders up to `full` and runs every finder at xhigh effort or one level above a configured effort.
 */
function reviewModes({ runModes }: PrState): { forced: boolean; fullReview: boolean; deeper: boolean } {
  return { forced: runModes.size > 0, fullReview: runModes.has('again'), deeper: runModes.has('deeper') };
}

/**
 * Shows `status` in the settings block, for a run that reviews nothing. Posts `text` with it when no comment has a block.
 * Without `lastReviewed`, the block keeps the commit it names.
 */
async function showRunStatus(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, settings: PrState,
  { head, draft, status, text, lastReviewed }: { head: string; draft: boolean; status: string; text: string; lastReviewed?: string },
): Promise<void> {
  await showSettings(octokit, bot, owner, repo, prNumber, {
    ...(lastReviewed && { lastReviewed }), head, status, boxes: settingsBoxes(draft, offersAuto(settings)), ticked: tickedBoxes(settings),
  }, text);
}

/** Shows an already reviewed `commitSha` as up to date in the settings block. Its Review again box reviews it again. */
async function showAlreadyReviewed(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, commitSha: string, settings: PrState, draft = false,
): Promise<void> {
  await showRunStatus(octokit, bot, owner, repo, prNumber, settings, {
    head: commitSha, draft, status: 'up to date', text: ALREADY_REVIEWED_TEXT, lastReviewed: commitSha,
  });
}

/**
 * Answers the waiting `Manki` check of a run that ends because `target.commitSha` already has a review. It reports the
 * verdict of that review and never a better one. An approval counts only while it is Manki's newest review, and it is
 * reported as held while a draft, a conflict or a warning thread holds it. A comment review counts only when its own
 * round record says that it held an approval. `approveOrSayWhy` then decides. The hold it names is reported, and it
 * approves the PR itself once nothing holds the approval. Nothing else here posts on the PR. It reports nothing when the
 * run has no waiting check on the commit, when `approveOrSayWhy` names no hold, finds another head or may not run because
 * `auto_approve` is off, or when the PR, the config or the threads cannot be read. `loaded` is the base branch's config
 * when the run has read it, and `held` says that it did not load.
 */
async function reportReviewedCheck(target: RunTarget, prAuthorLogin: string | undefined, loaded?: { config: ReviewConfig; held: boolean }): Promise<void> {
  const { octokit, bot, owner, repo, prNumber, commitSha, baseRef } = target;
  // Without a waiting check the head keeps the check of its review, which says more than this report would.
  if (!hasQueuedCheck(octokit, commitSha)) return;
  const shortSha = commitSha.slice(0, 7);
  const review = await findBotReviewOnCommit(octokit, bot, owner, repo, prNumber, commitSha);
  // Only the review's own round record says that it held an approval. A request for changes that GitHub refused is a comment too.
  const record = review?.state === 'COMMENTED' ? parseContextBlocks([review], owner, repo, prNumber).rounds.at(0) : undefined;
  const heldReview = record?.meta.commitSha === commitSha && record.verdict === 'APPROVE' && !!record.approval?.held;
  // A dismissed review found is a request for changes that a person dismissed, and its threads still decide the approval.
  const verdict = heldReview ? 'APPROVE' : review && (review.state === 'DISMISSED' ? 'REQUEST_CHANGES' : REVIEW_STATE_VERDICTS[review.state]);
  if (!verdict) {
    core.info(`No review of ${shortSha} gives a verdict a check can report, leaving its check as it is`);
    return;
  }
  let held: ApprovalHeld = false;
  if (verdict === 'APPROVE') {
    try {
      // A newer review of another commit overrides an approval, and without the config nothing says what holds it.
      const base = heldReview || await isApprovedOnCommit(octokit, bot, owner, repo, prNumber, commitSha) ? loaded ?? await loadEventConfig(octokit, owner, repo, baseRef) : undefined;
      if (!base || base.held) {
        core.info(`Cannot tell whether the approval of ${shortSha} stands, leaving its check as it is`);
        return;
      }
      if (heldReview) {
        // `approveOrSayWhy` approves a PR that nothing holds, so it runs only where `auto_approve` lets Manki approve.
        // It decides for the PR's head, so it gets this commit and declines once the head has moved on.
        const check = base.config.auto_approve ? await approveOrSayWhy(octokit, bot, owner, repo, prNumber, base.config, commitSha) : undefined;
        // An approval, and a hold whose notice `approveOrSayWhy` posted, have completed the waiting check already.
        if (!hasQueuedCheck(octokit, commitSha)) return;
        if (!check || check.approved || !check.held) {
          core.info(`Cannot tell what holds the approval of ${shortSha}, leaving its check as it is`);
          return;
        }
        held = check.held;
      } else {
        // The strict lookup throws on a PR whose draft or conflict state is unknown, so an unknown state is never taken for no hold.
        const hold = await fetchApprovalHold(octokit, owner, repo, prNumber, false, true);
        const open = hold ? [] : await fetchHeldWarnings(octokit, bot, owner, repo, prNumber, prAuthorLogin, base.config.author_clear_role, undefined, true);
        // A blocking thread reopened after the approval leaves its check to the next round.
        if (open.some(t => !t.isWarning)) {
          core.info(`A blocking thread is open, so the approval of ${shortSha} may not stand, leaving its check as it is`);
          return;
        }
        held = hold ? hold.reason : open.length > 0 && 'warnings';
      }
    } catch (error) {
      const failed = heldReview ? 'The approval check failed on' : 'Could not read what holds the approval of';
      core.warning(`${failed} ${shortSha}, leaving its check as it is: ${error instanceof Error ? error.message : error}`);
      return;
    }
  }
  core.info(`Reporting the ${verdict} of the review of ${shortSha} as its check`);
  await reportCheck(octokit, owner, repo, commitSha, outcomeReport(STANDING_OUTCOMES[verdict], ALREADY_REVIEWED_TEXT, held));
}

/**
 * Answers a review command that started no round because `target.commitSha` already has a review, and says what starts
 * one. It adds the text of the pause notice only when `autoReviewHalt` names an automatic pause and everything that
 * decision reads is known: the base branch's config is not `held`, the coordinator has the PR's `settings`, and every
 * round record and the threads were read.
 */
async function answerAlreadyReviewed(
  target: RunTarget, prAuthorLogin: string | undefined, { config, held }: { config: ReviewConfig; held: boolean }, settings: PrState,
): Promise<void> {
  const { octokit, bot, owner, repo, prNumber, commitSha } = target;
  const parts = [`\`${commitSha.slice(0, 7)}\` already has a review, so this command started no new round. The command starts one after a push, and ticking the review box in the settings block reviews this commit again.`];
  try {
    // Without the config or the coordinator's state, nothing says how many rounds the cap allows or whether the Pause box is ticked.
    if (!held && settings !== NO_SETTINGS) {
      const recap = await fetchRecapState(octokit, bot, owner, repo, prNumber, prAuthorLogin, config.author_clear_role);
      // Rounds or threads read only in part can give a wrong pause or miss a blocking thread.
      const partial = recap.priorRoundsIncomplete || recap.openThreadsState === 'fetch_failed';
      const halt = partial ? undefined : await autoReviewHalt(octokit, bot, owner, repo, prNumber, config, recap, settings.settings.paused);
      const blockers = formatOpenBlockers(recap.previousFindings);
      // Every thread the list names blocks, so the PR author alone clears none of them.
      if (halt?.cause === 'automatic_pause') parts.push(pauseText(halt.pause, blockers && `${blockers}\n\n${authorClearLine(config.author_clear_role)}`));
    }
  } catch (error) {
    core.warning(`Could not read whether automatic review is paused, answering without it: ${error instanceof Error ? error.message : error}`);
  }
  try {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: withMarkers(withMessageBoxes(parts.join('\n\n'), ['again']), COMMENT_MARKER) });
  } catch (error) {
    core.warning(`Failed to answer the review command: ${error instanceof Error ? error.message : error}`);
  }
}

/** Returns the branch the event names as `what`. Throws when it names none, so a config is never read from a guessed branch. */
function eventBranch(ref: unknown, what: string): string {
  if (typeof ref !== 'string' || !ref) throw new Error(`The event names no ${what}, so Manki cannot read its config`);
  return ref;
}

/**
 * Loads the config at `ref` of the base branch `branch` with `loadBaseConfig`. A base without a config file takes the
 * default branch's, unless the base is the default branch. Both are branches of the repository, never the PR's head.
 */
function loadConfigAt(octokit: Octokit, owner: string, repo: string, ref: string, branch = ref): ReturnType<typeof loadBaseConfig> {
  const defaultBranch: unknown = github.context.payload.repository?.default_branch;
  const read = (at: string) => () => readConfigFile(octokit, owner, repo, at, CONFIG_PATH);
  const readDefault = typeof defaultBranch === 'string' && defaultBranch && defaultBranch !== branch ? read(defaultBranch) : undefined;
  return loadBaseConfig(read(ref), CONFIG_PATH, failureReason, readDefault);
}

/**
 * Loads the base branch's config at `ref` for an event that runs no review round, as `loadConfigAt` does. `held` says
 * that it could not be read or loaded. The config is then `fallbackConfig`, and the event must approve nothing.
 * `closedUnknown` is set as `loadBaseConfig` sets it.
 */
async function loadEventConfig(octokit: Octokit, owner: string, repo: string, ref: string, branch = ref): Promise<{ config: ReviewConfig; held: boolean; closedUnknown?: string }> {
  const { config, source, closedUnknown } = await loadConfigAt(octokit, owner, repo, ref, branch);
  return { config, held: configFailed(source), ...(closedUnknown && { closedUnknown }) };
}

/**
 * Whether the token service's catch-up reviews the head of `pr` once more when this run's review does not finish. It skips
 * a fork's head and a bot's PR. A head that was reopened or marked ready can have had its catch-up already, or a skipped
 * review that counts as handled, so only a PR opened or pushed to gets the promise.
 */
function retriedByCatchUp(pr: NonNullable<typeof github.context.payload.pull_request>, action: string | undefined): boolean {
  return (action === 'opened' || action === 'synchronize') && pr.user?.type !== 'Bot' && pr.head.repo?.full_name === pr.base.repo?.full_name;
}

async function handlePullRequest(): Promise<void> {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.warning('No pull request found in event payload');
    return;
  }

  const prNumber = pr.number;
  const commitSha = pr.head.sha;
  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  const draft = !!pr.draft;
  const settings = await loadSettings(owner, repo, prNumber);
  const { forced, fullReview, deeper } = reviewModes(settings);
  const { octokit, bot } = await getAuth();
  const target: RunTarget = { octokit, bot, owner, repo, prNumber, commitSha, baseRef: pr.base.ref };
  if (!forced && await isApprovedOnCommit(octokit, bot, owner, repo, prNumber, commitSha)) {
    core.info('Already approved on this commit — skipping review');
    await reportReviewedCheck(target, pr.user?.login);
    return;
  }

  if (!forced && await hasBotReviewOnCommit(octokit, bot, owner, repo, prNumber, commitSha)) {
    core.info(`Bot already reviewed commit ${commitSha.slice(0, 7)} — skipping serialized sibling run`);
    await showAlreadyReviewed(octokit, bot, owner, repo, prNumber, commitSha, settings, draft);
    try {
      // The review of a draft held its approval, so a PR marked ready gets the approval check on that review.
      if (github.context.payload.action === 'ready_for_review') await handleReviewStateCheck();
    } finally {
      // The approval check answers a waiting check when it approves or holds. Otherwise the review found does, also after a failed approval check.
      await reportReviewedCheck(target, pr.user?.login);
    }
    return;
  }

  const prContext: PrContext = {
    title: pr.title,
    body: pr.body || '',
    baseBranch: pr.base.ref,
  };

  const trigger = buildRoundTrigger();
  await runFullReview(owner, repo, prNumber, commitSha, pr.base.ref, prContext, {
    prAuthorLogin: pr.user?.login,
    trigger,
    ...(forced && { forceReview: true, skipCap: true, bypassHint: 'force_review' as const }),
    settings,
    draft,
    fullReview,
    deeper,
    automaticRetry: !forced && !draft && !trigger.catchUp && retriedByCatchUp(pr, github.context.payload.action),
  });
}

async function handleMergedPullRequest(): Promise<void> {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.warning('No pull request found in event payload');
    return;
  }

  const { octokit, bot } = await getAuth();
  const { owner, repo } = github.context.repo;
  const { config } = await loadEventConfig(octokit, owner, repo, pr.base.ref);
  if (!config.memory?.enabled) {
    core.info('Memory is off, so no fix rate is recorded');
    return;
  }
  // The merged base branch holds the PR's own config. `base.sha` is a commit of the base branch from before the merge.
  const before = pr.base.sha ? (await loadEventConfig(octokit, owner, repo, pr.base.sha, pr.base.ref)).config : fallbackConfig();

  const { store: memory } = await openMemoryStore(octokit, config.memory, owner, repo, pr.number);
  if (!memory) core.info('The fix rate goes to the job summary only');

  await recordFixRate(octokit, bot, owner, repo, {
    number: pr.number,
    headSha: pr.head.sha,
    mergedSha: pr.merge_commit_sha ?? '',
    authorLogin: pr.user?.login,
    clearRole: before.author_clear_role,
  }, memory);
}

/** The answer to a review command on a merged or closed PR. Its Review again box, labelled Review anyway, reviews it once. */
const REVIEW_PR_CLOSED = `Nothing was reviewed, since this pull request is merged or closed.\n\n${messageBox('again', undefined, 'Review anyway')}`;

/**
 * Reviews the PR a comment is on, for a review command or, with `settingsTick`, a box ticked in the settings block or
 * the Review again box ticked in another `message`. A tick reviews only with a mode the coordinator queued for the run.
 * The Review again box of `message` then names who asked for the review, and is unticked again when none was queued.
 * A review command on a merged or closed PR reviews nothing, and its answer carries a box that reviews it anyway.
 */
async function handleCommentTrigger(settingsTick = false, message?: TickedMessage): Promise<void> {
  const payload = github.context.payload;

  const prNumber: number | undefined = payload.issue ? (payload.issue.pull_request ? payload.issue.number : undefined) : payload.pull_request?.number;
  if (!prNumber) {
    core.info('Comment is on an issue, not a PR — skipping');
    return;
  }

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;

  const { octokit, bot } = await getAuth();
  if (!settingsTick && eventPrClosed()) {
    core.info(`PR #${prNumber} is merged or closed, so the review command reviews nothing`);
    try {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body: withMarkers(REVIEW_PR_CLOSED, COMMENT_MARKER) });
    } catch (error) {
      core.warning(`Failed to answer the review command: ${error instanceof Error ? error.message : error}`);
    }
    return;
  }
  const settings = await loadSettings(owner, repo, prNumber);
  const { forced, fullReview, deeper } = reviewModes(settings);
  if (message) await settleTickedBox(octokit, owner, repo, prNumber, message, 'again', undefined, forced ? payload.sender?.login : undefined);
  if (settingsTick && !forced) {
    core.info('The settings box tick queued no review for this run, nothing to do');
    return;
  }

  // Acknowledge the command unconditionally so the user knows it was received.
  if (payload.comment?.id && !settingsTick) {
    await reactToIssueComment(octokit, owner, repo, payload.comment.id, 'eyes');
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });
  const draft = !!pr.draft;

  // An approved head counts as reviewed here, so a review command on it shows up to date, and Review again reviews it again.
  if (!forced && await hasBotReviewOnCommit(octokit, bot, owner, repo, prNumber, pr.head.sha)) {
    core.info(`Bot already reviewed commit ${pr.head.sha.slice(0, 7)} — skipping`);
    await showAlreadyReviewed(octokit, bot, owner, repo, prNumber, pr.head.sha, settings, draft);
    const target: RunTarget = { octokit, bot, owner, repo, prNumber, commitSha: pr.head.sha, baseRef: pr.base.ref };
    const loaded = await loadEventConfig(octokit, owner, repo, pr.base.ref);
    await answerAlreadyReviewed(target, pr.user?.login, loaded, settings);
    try {
      // Threads cleared since the review, or a block a person dismissed, can leave nothing that holds the approval.
      await runStateCheck(octokit, bot, owner, repo, prNumber, pr.user?.login, loaded);
    } catch (error) {
      assertWritesAllowed();
      core.warning(`The approval check after the review command failed, so nothing was approved: ${error instanceof Error ? error.message : error}`);
    }
    await reportReviewedCheck(target, pr.user?.login, loaded);
    return;
  }

  const prContext: PrContext = {
    title: pr.title,
    body: pr.body || '',
    baseBranch: pr.base.ref,
  };

  await runFullReview(owner, repo, prNumber, pr.head.sha, pr.base.ref, prContext, {
    prAuthorLogin: pr.user?.login,
    ...(forced ? { forceReview: true, skipCap: true, bypassHint: 'force_review' as const } : { skipCap: true, bypassHint: 'manual_review_command' as const }),
    trigger: buildRoundTrigger(settings.runModes),
    settings,
    draft,
    fullReview,
    deeper,
  });
}

/** The fields of an Octokit `RequestError`, whose `name` is `HttpError`. */
interface OctokitErrorFields {
  status?: number;
  request?: { method?: string; url?: string };
  response?: { headers?: Record<string, string | undefined> };
}

function failureReason(error: unknown, retryHint = FAILED_RUN_HINT): string {
  return sanitizeLogOutput(sanitizeTokens(describeFailure(error, retryHint)));
}

/** How to retry a run that failed. The review command starts nothing on a commit whose newest review gave a verdict, as after a failed box run, so the hint names the box too. */
const FAILED_RUN_HINT = `${RETRY_HINT} If that shows the commit as up to date, tick the review box in the settings block.`;
/** How to retry a failed run that only checks the approval. The check command does the same without a review round. */
const CHECK_HINT = 'Retry with /manki check.';
/** How to retry a failed run that a comment, a reply or a tick of a box started. */
const REPEAT_HINT = 'Repeat the comment or the tick that started this run.';

/** Returns how to retry a failed run of the dispatched event, by what a run of that event does. */
function retryHintFor({ event, action }: ReturnType<typeof dispatchedInputs>): string {
  switch (event) {
    case 'pull_request':
      // No hint for a merge. A review command would review the merged PR instead of recording its fix rate.
      if (action === 'closed') return '';
      return action === APPROVAL_CHECK_ACTION ? CHECK_HINT : FAILED_RUN_HINT;
    case 'pull_request_review_thread':
      return CHECK_HINT;
    case 'pull_request_review':
      // An edited review is a tick of an issue box. A submitted or dismissed one starts the approval check.
      return action === 'edited' ? REPEAT_HINT : CHECK_HINT;
    default:
      return REPEAT_HINT;
  }
}

/**
 * Describes a failure in a sentence that always names a cause. A 5xx from GitHub reads as a
 * transient failure that ends with `retryHint`, and an Octokit error with an empty message falls back to its status and call.
 */
function describeFailure(error: unknown, retryHint: string): string {
  if (!(error instanceof Error)) return String(error).trim() || `A ${typeof error} with no message`;
  const message = error.message.trim();
  if (error.name === 'HttpError') {
    const { status, request, response } = error as OctokitErrorFields;
    const path = request?.url?.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const call = request?.method && path ? ` on ${request.method} ${path}` : '';
    const requestId = response?.headers?.['x-github-request-id'];
    const where = `${call}${requestId ? ` (request id ${requestId})` : ''}`;
    // Without a response the request never reached GitHub, so the message names the network error.
    if (response && status !== undefined && status >= 500) return `GitHub returned ${status}${where}. ${retryHint}`.trimEnd();
    if (!message) return `GitHub returned ${status ?? 'an error'}${where}.`;
  }
  return message || `${error.name} with no message`;
}

function reconcileDashboardAgents(dashboard: DashboardData, names: string[]): void {
  const existingByName = new Map(dashboard.agentProgress?.map(a => [a.name, a]) ?? []);
  const reconciled = names.map(name => existingByName.get(name) ?? { name, status: 'done' as const });
  // Preserve entries for agents that have reported back (status is not the
  // initial 'reviewing') but are not in the resolved name list. These agents
  // participated and the dashboard should continue to surface their status.
  for (const [name, entry] of existingByName) {
    if (!names.includes(name) && entry.status !== 'reviewing') {
      reconciled.push(entry);
    }
  }
  dashboard.agentCount = reconciled.length;
  dashboard.agentProgress = reconciled;
}

/** The pull request commit a run reviews, and the client and identity it reads and posts with. */
interface RunTarget {
  octokit: Octokit;
  bot: BotIdentity;
  owner: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  baseRef: string;
}

/** The progress comment of a run, its live dashboard edits and whether its review is posted, which the failure path also reads. */
interface RunProgress {
  commentId?: number;
  liveEdits?: { stop(): Promise<void> };
  reviewPosted: boolean;
  /** Stops the head watcher, so a later push no longer stops the round. */
  stopHeadWatch: () => void;
  /**
   * What the settings block of the progress comment carries over all its edits, and the comment that had the block before.
   * Set once the progress comment is posted.
   */
  settings?: { lastReviewed?: string; draft: boolean; offersAuto: boolean; ticked: ReadonlySet<SettingsBox>; previousId?: number };
}

/** The settings block of the run's progress comment with `status`, or `undefined` without one. `reviewed` marks the head reviewed. */
function progressSettings(
  target: RunTarget, progress: RunProgress, status: string, { boxes = [], reviewed = false }: { boxes?: SettingsBox[]; reviewed?: boolean } = {},
): SettingsView | undefined {
  const settings = progress.settings;
  if (!settings) return undefined;
  const lastReviewed = reviewed ? target.commitSha : settings.lastReviewed;
  return { ...(lastReviewed && { lastReviewed }), head: target.commitSha, status, boxes: settingsBoxes(settings.draft, settings.offersAuto, boxes), ticked: settings.ticked };
}

const runningSettings = (target: RunTarget, progress: RunProgress): SettingsView | undefined =>
  progressSettings(target, progress, 'review running', { boxes: ['cancel'] });

/**
 * Posts the run's progress comment, ending with the settings block, which older comments then lose, so only the newest
 * progress comment has one. Returns its id and the failed progress comment of an earlier run on the same head, which
 * the run marks superseded once it reviews. A new comment is posted, since the token service takes only a comment created
 * after the run started.
 */
async function postRunProgress(
  target: RunTarget, progress: RunProgress, { settings = NO_SETTINGS, draft = false }: FullReviewOptions,
): Promise<{ commentId: number; failed?: { id: number; body: string } }> {
  const { octokit, bot, owner, repo, prNumber, commitSha } = target;
  let comments: Awaited<ReturnType<typeof fetchPRComments>> = [];
  try {
    comments = await fetchPRComments(octokit, owner, repo, prNumber);
  } catch (error) {
    core.warning(`Failed to read the earlier settings block, so it stays: ${error instanceof Error ? error.message : error}`);
  }
  const latest = latestSettings(comments, bot);
  const failed = latest && isFailedProgress(latest.body) && commitSha.startsWith(latest.settings.head) ? latest : undefined;
  progress.settings = {
    // The block keeps the commit it named when the coordinator holds none, as after its storage was cleared.
    lastReviewed: settings.lastReviewed ?? latest?.settings.lastReviewed, draft, offersAuto: offersAuto(settings), ticked: tickedBoxes(settings),
    ...(latest && { previousId: latest.id }),
  };
  const commentId = await postProgressComment(octokit, owner, repo, prNumber, undefined, runningSettings(target, progress));
  await retireSettingsBlocks(octokit, bot, owner, repo, comments, commentId);
  return { commentId, ...(failed && { failed }) };
}

/**
 * Deletes the run's progress comment for a run that reviews nothing. The settings block goes back to the comment that
 * had it before, with `status`. Without such a comment, `text` is posted with the block.
 */
async function dropProgressComment(target: RunTarget, progress: RunProgress, settings: PrState = NO_SETTINGS, status: string, text: string): Promise<void> {
  const { octokit, bot, owner, repo, prNumber, commitSha } = target;
  if (progress.commentId === undefined) return;
  try {
    await octokit.rest.issues.deleteComment({ owner, repo, comment_id: progress.commentId });
  } catch (error) {
    core.warning(`Failed to delete the progress comment: ${error instanceof Error ? error.message : error}`);
  }
  if (!progress.settings) return;
  const { draft, lastReviewed, previousId } = progress.settings;
  if (previousId === undefined) {
    await showRunStatus(octokit, bot, owner, repo, prNumber, settings, { head: commitSha, draft, status, text, lastReviewed });
    return;
  }
  await setSettingsBlock(octokit, owner, repo, previousId, progressSettings(target, progress, status));
}

/** Characters of reviewable diff above which a PR gets no automatic review, since each `MAX_SLICE_CHARS` of them cost a call per reader. */
const MAX_AUTO_REVIEW_CHARS = 2_000_000;
/** Characters of reviewable diff above which Manki never reviews a PR, even when forced. */
const MAX_REVIEW_CHARS = 4_000_000;

/** What a review round works on. Built once its inputs are collected, then passed to the stages that review, post and record. */
interface ReviewRun extends RunTarget, RoundRecordInput {
  configHold?: ConfigHold;
  /** The lockfiles a model reads as a package list, so they hold no approval. */
  lockfiles: LockfileDiff[];
  commentId: number;
  dashboard: DashboardData;
  progress: RunProgress;
  startTime: number;
  parseEndTime: number;
}

interface ReviewStageResult {
  result: ReviewResult & { outcome: RoundOutcome };
  reviewEndTime: number;
  judgeEndTime: number;
}

/** Stops the live dashboard edits of the run and waits for one in flight, so the edit that follows lands last. */
async function stopLiveEdits(progress: RunProgress): Promise<void> {
  await progress.liveEdits?.stop();
  progress.liveEdits = undefined;
}

/**
 * Loads the round's config from the base branch, so a PR cannot weaken its own review. The keys the PR's own `.manki.yml`
 * changes are logged as applying after merge. A PR file that does not load gives a warning and `brokenHead`, which says
 * whether the PR changed it.
 */
async function loadRunConfig(target: RunTarget): Promise<{ config: ReviewConfig; reviewSource: ConfigSource; brokenHead?: { changed: boolean }; closedUnknown?: string }> {
  const { octokit, owner, repo, commitSha, baseRef } = target;
  let headContent: string | null | undefined;
  let headConfig: ReviewConfig | undefined;
  try {
    headContent = await readConfigFile(octokit, owner, repo, commitSha, CONFIG_PATH);
    headConfig = loadConfig(headContent ?? undefined, CONFIG_PATH);
  } catch (error) {
    core.warning(`Could not read or load the PR's ${CONFIG_PATH}, this round uses the base branch's settings: ${failureReason(error)}`);
  }
  const { config, source, closedUnknown } = await loadConfigAt(octokit, owner, repo, baseRef);
  const unknown = closedUnknown ? { closedUnknown } : {};
  if (!headConfig) return { config, reviewSource: source, brokenHead: { changed: await changesConfig(target, headContent) }, ...unknown };
  const changed = editedKeys(headConfig, { config, source });
  if (changed.length > 0) {
    core.info(`This PR changes ${changed.map(key => `\`${key}\``).join(', ')} in ${CONFIG_PATH}. The change applies after merge: this round uses the base branch's settings.`);
  }
  return { config, reviewSource: source, ...unknown };
}

/**
 * Whether the PR changed its config file: the copy at its head differs from the copy at the merge base. A copy that cannot
 * be read or compared counts as changed, so its approval is held.
 */
async function changesConfig(target: RunTarget, headContent: string | null | undefined): Promise<boolean> {
  if (headContent === undefined) return true;
  const { octokit, owner, repo, commitSha, baseRef } = target;
  try {
    return await readConfigFile(octokit, owner, repo, await fetchMergeBase(octokit, owner, repo, baseRef, commitSha), CONFIG_PATH) !== headContent;
  } catch (error) {
    core.warning(`Could not read ${CONFIG_PATH} at the merge base, so the PR counts as changing it: ${failureReason(error)}`);
    return true;
  }
}

/**
 * Whether the run stops before posting a progress comment: the commit is reviewed or stale, or nothing changed. With
 * `configBroken`, an unchanged PR is reviewed again, so the full round decides whether the config holds its approval.
 * So is an approved one while a warning thread holds the approval.
 */
async function skipsRound(target: RunTarget, config: ReviewConfig, trigger: RoundTrigger, { forceReview, settings = NO_SETTINGS, draft, prAuthorLogin }: FullReviewOptions, configBroken: boolean): Promise<boolean> {
  const { octokit, bot, owner, repo, prNumber, commitSha, baseRef } = target;

  // A run queued behind another can find its commit reviewed already. `forceReview` reviews it again, as a box tick asks.
  if (!forceReview && await hasBotReviewOnCommit(octokit, bot, owner, repo, prNumber, commitSha)) {
    core.warning(`Bot already posted a non-DISMISSED review on commit ${commitSha.slice(0, 7)} — bailing serialized sibling run.`);
    await showAlreadyReviewed(octokit, bot, owner, repo, prNumber, commitSha, settings, draft);
    await reportReviewedCheck(target, prAuthorLogin, { config, held: configBroken });
    return true;
  }

  // Fast-exit when the PR head has advanced past the event SHA between the
  // event firing and this run reaching the LLM phase. Placed before any
  // progress comment is posted so no marker cleanup is required on bail.
  // Fail-open: a `pulls.get` failure does not disable the review.
  const headSha = await fetchHeadSha(octokit, owner, repo, prNumber);
  if (headSha && headSha !== commitSha) {
    core.info(`Event SHA ${commitSha.slice(0, 7)} != head SHA ${headSha.slice(0, 7)} — bailing out`);
    return true;
  }

  if (trigger.event === 'pull_request:synchronize' && config.auto_review && !configBroken) {
    const standing = await findUnchangedVerdict(octokit, bot, owner, repo, prNumber, baseRef, commitSha);
    if (standing) {
      const shortSha = standing.commitSha.slice(0, 7);
      assertWritesAllowed();
      try {
        const approved = standing.verdict === 'APPROVE';
        const prHold = approved ? await fetchApprovalHold(octokit, owner, repo, prNumber, draft) : undefined;
        // A warning thread can hold an approval given before warnings held one, or one given before the thread was reopened.
        // So can a blocking thread a person reopened after the approval. Beside a draft or a conflict the threads are only named.
        let open: ReviewThread[] = [];
        try {
          if (approved) open = await fetchHeldWarnings(octokit, bot, owner, repo, prNumber, prAuthorLogin, config.author_clear_role, undefined, true);
        } catch (error) {
          if (!prHold) throw error;
          core.warning(`Could not read the threads of ${shortSha}, so its ${prHold.reason} alone is named: ${error instanceof Error ? error.message : error}`);
        }
        if (approved && !prHold && open.length > 0) {
          core.info(`An open thread holds the approval of ${shortSha}, reviewing in full`);
          return false;
        }
        // As in the review, warnings come before a draft or a conflict, which follows them in one sentence.
        const warningsFirst = !!prHold && open.length > 0 && open.every(t => t.isWarning);
        const hold = prHold && !warningsFirst && await holdApproval(octokit, bot, owner, repo, prNumber, commitSha, draft, config.auto_approve);
        const held = warningsFirst ? 'warnings' as const : hold && hold.reason;
        const summary = `No change to this PR since the reviewed commit \`${shortSha}\`. The previous verdict stands.`;
        // A push can dismiss approvals, so the approval is posted again on the new head.
        if (approved && !held) {
          await octokit.rest.pulls.createReview({
            owner, repo, pull_number: prNumber, commit_id: commitSha, event: 'APPROVE',
            body: withMarkers(`${APPROVED_LINE} ${summary}`, PROGRESS_MARKER, autoApproveHeadMarker(commitSha)),
          });
          await retireStaleNotices(octokit, bot, owner, repo, prNumber, commitSha);
        }
        if (approved) await reportPrState(owner, repo, prNumber, { approval: { commit: commitSha, held: !!held } });
        core.info(`Round SKIPPED: no change since reviewed commit ${shortSha}, ${standing.verdict} stands`);
        await showRunStatus(octokit, bot, owner, repo, prNumber, settings, {
          head: commitSha, draft: !!draft, status: 'up to date', text: summary, lastReviewed: standing.commitSha,
        });
        const also = warningsFirst ? `\n\n${alsoHeldLine(prHold, config.auto_approve)}` : '';
        await reportCheck(octokit, owner, repo, commitSha, outcomeReport(STANDING_OUTCOMES[standing.verdict], `${summary}${also}`, held));
        return true;
      } catch (error) {
        core.warning(`Could not post the previous approval again, reviewing in full: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  return false;
}

/**
 * Reads the prior rounds and threads, reopens guarded threads the author resolved, and records the ones the author cleared with a role `author_clear_role` allows.
 * Returns `undefined` when `auto_review` is off for a push.
 */
async function loadRecap(
  target: RunTarget, config: ReviewConfig, progress: RunProgress, { prAuthorLogin, settings }: FullReviewOptions,
): Promise<RecapState | undefined> {
  const { octokit, bot, owner, repo, prNumber } = target;
  const recap = await fetchRecapState(octokit, bot, owner, repo, prNumber, prAuthorLogin, config.author_clear_role);

  if (github.context.eventName === 'pull_request' && !config.auto_review) {
    core.info('auto_review is disabled — skipping');
    await dropProgressComment(target, progress, settings, 'automatic review off', 'Automatic review is off for this repository (`auto_review: false`).');
    return undefined;
  }

  await reopenAuthorResolvedThreads(octokit, recap);
  await announceSecurityOverrides(octokit, securityOverridesIn(recap.previousFindings).filter(o => !o.announced));
  return recap;
}

/**
 * Returns the PR's last attempt on `commitSha` when the round may keep results of it. Review again and Deeper review ask for
 * a new read, so they keep nothing, and neither does a round whose last attempt's review someone edited.
 */
async function reusableAttempt(octokit: Octokit, recap: RecapState, commitSha: string, { fullReview, deeper }: FullReviewOptions): Promise<EarlierAttempt | undefined> {
  const attempt = recap.lastAttempt;
  if (!attempt?.nodeId || attempt.record.meta.commitSha !== commitSha || fullReview || deeper) return undefined;
  if (await wasEdited(octokit, attempt.nodeId)) {
    core.info('The last attempt is not reused, since its review was edited');
    return undefined;
  }
  return attempt;
}

/** Reads the PR's diff and splits it into the files the review reads and the files `exclude_paths` or `closed_paths` leave out. */
async function collectDiff(target: RunTarget, config: ReviewConfig) {
  const { octokit, owner, repo, prNumber } = target;
  return reviewableDiff(await fetchPRDiff(octokit, owner, repo, prNumber), config.exclude_paths, config.closed_paths);
}

/** Reads the package changes of the changed lockfiles Manki parses. A lockfile that can't be read stays unread. */
async function collectLockfiles(target: RunTarget, fullDiff: ParsedDiff): Promise<LockfileDiff[]> {
  const { octokit, owner, repo, commitSha } = target;
  if (!fullDiff.files.some(f => isParsedLockfile(f.path))) return [];
  const skipped: SkippedFile[] = [];
  const heads = await fetchLockfiles(octokit, { owner, repo, headSha: commitSha, fullDiff }, isParsedLockfile, skipped);
  for (const { path, reason } of skipped) core.warning(`Could not read the changed lockfile ${path}, so no model reads it: ${reason}`);
  return readLockfileChanges(fullDiff, heads);
}

/**
 * Dismisses the reviews `reviewId` replaces and returns what `dismissPreviousReviews` returns. Throws `SupersededError` instead when
 * the head moved since, so a review of an old commit never lifts the merge block on a new one. Past that check the
 * round is final, so a later push no longer stops it.
 */
async function replacePreviousReviews(
  target: RunTarget, progress: RunProgress, reviewId: number, state: 'CHANGES_REQUESTED' | 'APPROVED' = 'CHANGES_REQUESTED',
): ReturnType<typeof dismissPreviousReviews> {
  const { octokit, bot, owner, repo, prNumber, commitSha } = target;
  progress.reviewPosted = true;
  await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
  progress.stopHeadWatch();
  return dismissPreviousReviews(octokit, bot, owner, repo, prNumber, reviewId, state);
}

/**
 * Posts a comment for a diff no model reads, dismisses the earlier approvals and marks the progress comment complete.
 * An earlier request for changes stands, since no model read whether the change fixed it. Returns the report for the
 * PR check, which waits for a person.
 */
async function postUnreviewedRound(
  target: RunTarget, progress: RunProgress, commentId: number, dashboard: DashboardData, diff: ParsedDiff, summary: string, metadata: ReviewMetadata,
): Promise<CheckReport> {
  const { octokit, bot, owner, repo, prNumber, commitSha } = target;
  await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
  const result = { verdict: 'COMMENT' as const, summary, findings: [], highlights: [], reviewComplete: true, agentNames: [] as string[] };
  const { id: reviewId } = await postReview(octokit, owner, repo, prNumber, commitSha, result, diff, undefined, undefined, { noVerdict: true });
  // Once every approval is gone, the coordinator no longer records one.
  const { dismissed, failed } = await replacePreviousReviews(target, progress, reviewId, 'APPROVED');
  if (dismissed > 0 && !failed) await reportPrState(owner, repo, prNumber, { approval: null });
  await updateProgressComment(octokit, owner, repo, commentId, { ...dashboard, totalDurationMs: metadata.timing.totalMs }, metadata, progressSettings(target, progress, 'up to date', { reviewed: true }));
  await retireStaleNotices(octokit, bot, owner, repo, prNumber, commitSha, { noVerdict: true });
  return { conclusion: 'action_required', title: 'Not reviewed', summary };
}

async function loadRunMemory(
  octokit: Octokit, config: ReviewConfig, owner: string, repo: string, prNumber: number,
): Promise<{ memory: RepoMemory | null; memoryLoadStatus: MemoryLoadStatus; memoryLoadError?: string; memorySkip?: MemorySkip; fixRates?: FixRateHistory }> {
  if (!config.memory?.enabled) {
    return { memory: null, memoryLoadStatus: 'disabled' };
  }
  const { store, skip } = await openMemoryStore(octokit, config.memory, owner, repo, prNumber);
  if (!store) {
    return { memory: null, memoryLoadStatus: 'skipped', memorySkip: skip };
  }
  try {
    const [memory, fixRates] = await Promise.all([loadMemory(store), readFixRateHistory(store)]);
    core.info(`Loaded memory: ${memory.learnings.length} learnings, ${memory.suppressions.length} suppressions`);
    return { memory, memoryLoadStatus: 'loaded', ...(fixRates && { fixRates }) };
  } catch (error) {
    if (error instanceof MemoryRefusedError) {
      core.warning(`Memory is skipped: ${error.skip.message}`);
      return { memory: null, memoryLoadStatus: 'skipped', memorySkip: error.skip };
    }
    const message = error instanceof Error ? error.message : String(error);
    const sanitized = sanitizeTokens(message);
    core.warning(`Failed to load review memory: ${sanitized}`);
    return { memory: null, memoryLoadStatus: 'failed', memoryLoadError: sanitized.length > 300 ? sanitized.slice(0, 300) + '...' : sanitized };
  }
}

/** Marks a request to split a PR too big to review, so the next push edits it. */
const TOO_BIG_MARKER = '<!-- manki-too-big -->';

/**
 * Replaces the run's progress comment with notice `body`. The open notice with `marker` from after `lastRoundAt` is
 * edited instead of adding another. Without such a notice, the progress comment becomes the notice, so it keeps the settings block.
 */
async function replaceWithNotice(target: RunTarget, progress: RunProgress, marker: string, body: string, lastRoundAt?: string): Promise<void> {
  const { octokit, owner, repo, prNumber } = target;
  const notice = await findOpenNotice(target, marker, lastRoundAt);
  const keepId = notice ? undefined : progress.commentId;
  if (progress.commentId !== undefined && keepId === undefined) {
    try {
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: progress.commentId });
    } catch (error) {
      core.warning(`Failed to delete progress comment: ${error}`);
    }
  }
  try {
    const id = notice?.id ?? keepId;
    if (id !== undefined) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: id, body });
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    }
  } catch (error) {
    core.warning(`Failed to post the notice: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Replaces the progress comment with a request to split a PR too big to review, and dismisses Manki's earlier
 * approvals, since no reviewer read the new code. Posts no review, so a request for changes stays. `offerReview`
 * keeps the Review again and Deeper review boxes, which review the PR anyway.
 */
async function postTooBigNotice(target: RunTarget, progress: RunProgress, text: string, offerReview: boolean, lastRoundAt?: string): Promise<CheckReport> {
  const { octokit, bot, owner, repo, prNumber } = target;
  const { dismissed, failed } = await dismissPreviousReviews(octokit, bot, owner, repo, prNumber, undefined, 'APPROVED');
  if (dismissed > 0 && !failed) await reportPrState(owner, repo, prNumber, { approval: null });
  const offered = progressSettings(target, progress, offerReview ? 'too big for automatic review' : 'too big to review');
  // Above the hard limit no box can review the PR, so only Pause stays.
  const settings = offered && (offerReview ? offered : { ...offered, boxes: new Set<SettingsBox>(['pause']) });
  const body = withSettingsBlock(withMarkers(text, PROGRESS_MARKER, REVIEW_COMPLETE_MARKER, TOO_BIG_MARKER), settings);
  await replaceWithNotice(target, progress, TOO_BIG_MARKER, body, lastRoundAt);
  // A diff no reviewer read must not pass a required check, so it waits for a person.
  return { conclusion: 'action_required', title: 'Not reviewed', summary: text };
}

/** The pause to report to the coordinator: its reason while automatic review is paused, otherwise `null`. */
function pauseReport({ reason }: PauseState): StateReport['pause'] {
  return reason ? { reason } : null;
}

/** Says why automatic review is paused and what a review started by hand turns back on, above `blockers`, the list of blocking threads still open. */
function pauseText({ reason, restart }: PauseState, blockers: string | null): string {
  return `${reason} Automatic review is paused. ${restart}${blockers ? `\n\n${blockers}` : ''}`;
}

/**
 * Replaces the progress comment with a notice that automatic review is paused, listing the blocking threads still open.
 * Each push during the same pause updates the notice from after `lastRoundAt` instead of adding another.
 * The notice's settings block offers Review again, which reviews the PR anyway.
 */
async function postPauseNotice(
  target: RunTarget, progress: RunProgress, pause: PauseState, maxAutoRounds: number,
  previousFindings: PreviousFinding[], lastRoundAt?: string,
): Promise<CheckReport> {
  const { capReached, capRounds, reason } = pause;
  core.info(capReached
    ? `Round cap reached (${capRounds} rounds with new changes since the last approval >= max ${maxAutoRounds}) — skipping auto review`
    : 'Last round did not converge — skipping auto review');
  const settings = progressSettings(target, progress, 'automatic review paused');
  const body = withSettingsBlock(
    withMarkers(pauseText(pause, formatOpenBlockers(previousFindings)), PROGRESS_MARKER, REVIEW_COMPLETE_MARKER, PAUSE_NOTICE_MARKER),
    settings,
  );
  await replaceWithNotice(target, progress, PAUSE_NOTICE_MARKER, body, lastRoundAt);
  await reportPrState(target.owner, target.repo, target.prNumber, { pause: pauseReport(pause) });
  return { conclusion: 'action_required', title: 'Automatic review paused', summary: `${reason} Automatic review is paused until someone asks for another round.` };
}

/** The boxes whose tick answers a notice. */
const REVIEW_BOXES: readonly SettingsBox[] = ['again', 'deeper'];

/**
 * Returns Manki's latest notice with `marker` and no ticked box, posted or updated after `lastRoundAt`.
 * A failed lookup returns `undefined`, so a new notice is posted.
 */
async function findOpenNotice(target: RunTarget, marker: string, lastRoundAt: string | undefined): Promise<{ id: number } | undefined> {
  const { octokit, bot, owner, repo, prNumber } = target;
  const since = lastRoundAt ? Date.parse(lastRoundAt) : -Infinity;
  try {
    const comments = await fetchPRComments(octokit, owner, repo, prNumber);
    return comments.find(c => isBotLogin(bot, c.user?.login) && !!c.body?.includes(marker)
      && !REVIEW_BOXES.some(box => parseSettingsBlock(c.body ?? '')?.ticked.has(box)) && Date.parse(c.updated_at) > since);
  } catch (error) {
    core.warning(`Failed to look up an earlier notice: ${error}`);
    return undefined;
  }
}

/**
 * Collects the open review threads with the code now at each, and the contents of the files the review reads. The code
 * of a thread on a path `closedPaths` closes is never read, so the thread is marked unread.
 */
async function collectOpenThreads(
  target: RunTarget, recap: RecapState, diff: ParsedDiff, lockfiles: LockfileDiff[], prAuthorLogin: string | undefined, closedPaths: readonly string[] = [],
): Promise<{ openThreads: OpenThread[]; fileContents?: Map<string, string>; leftOutFiles: LeftOutFile[] }> {
  const { octokit, owner, repo, commitSha } = target;
  const isClosed = (path: string | undefined): boolean => !!path && !!findClosedPattern(path, closedPaths);
  const baseOpenThreads = recap.previousFindings
    .filter((f): f is PreviousFinding & { threadId: string } =>
      (f.status === 'open' || f.status === 'replied') && f.threadId != null && f.threadId !== '')
    .map(f => {
      const authorReplyText = replyShownToJudge(f, prAuthorLogin);
      return {
        threadId: f.threadId,
        threadUrl: f.threadUrl,
        title: f.title,
        file: f.file,
        ...(f.evidenceFiles && { evidenceFiles: f.evidenceFiles }),
        // A thread posted on a fallback line sits away from its finding, and the judge has to look at the finding.
        line: currentFindingLine(f),
        severity: f.severity,
        ...(f.recordedGrade && { recordedGrade: f.recordedGrade }),
        ...(f.peakGrade && { peakGrade: f.peakGrade }),
        ...(f.gradeUnknown && { gradeUnknown: true }),
        ...(f.isSecurity && { isSecurity: true }),
        ...(f.disprovedBlocker && { disprovedBlocker: true }),
        description: f.description,
        suggestedFix: f.suggestedFix,
        howToFix: f.howToFix,
        ...(f.answer && { answer: f.answer }),
        ...(authorReplyText && { authorReplyText }),
      };
    });

  // Fetch full file contents for changed files so reviewers have surrounding context.
  // Also fetch each open thread's file (if missing from changed files) so the judge
  // can see the current code at the flagged region when deciding whether the
  // thread is addressed.
  const changedFilePaths = diff.files
    .filter(f => f.changeType !== 'deleted')
    .map(f => f.path);
  // A thread tied to no file has no code to fetch.
  const threadFiles = baseOpenThreads.flatMap(t => (t.file && !isClosed(t.file) ? [t.file] : []));
  const closedThreadFiles = baseOpenThreads.flatMap(t => (isClosed(t.file) ? [t.file] : []));
  const threadFilePaths = threadFiles.filter(p => !changedFilePaths.includes(p));
  // The prompts read a parsed lockfile's package list, never the file, so it stays out of the shared budget.
  // Only a thread on it reads the file, for its window.
  const parsed = new Set(lockfiles.map(l => l.path));
  const filePaths = [...changedFilePaths, ...threadFilePaths].filter(p => !parsed.has(p));
  const lockfileThreadPaths = [...new Set(threadFiles.filter(p => parsed.has(p)))];
  let fileContents: Map<string, string> | undefined;
  let lockfileContents: Map<string, string> | undefined;
  // A file that is not at the head, as one the PR deleted or renamed away, has no code to read, which is no failure to read it.
  const notFound = new Set<string>();
  const leftOut: LeftOutFile[] = [];
  try {
    [fileContents, lockfileContents] = await Promise.all([
      // The changed files of blocker and warning threads are read first, so the judge sees a fix however large the rest of the change is.
      // A thread file outside the diff keeps its place, since the finders read the same files and need the changed ones.
      fetchFileContents(octokit, owner, repo, commitSha, filePaths, undefined, undefined, [...fixThreadFiles(baseOpenThreads)].filter(p => changedFilePaths.includes(p)), notFound, leftOut),
      lockfileThreadPaths.length > 0 ? fetchFileContents(octokit, owner, repo, commitSha, lockfileThreadPaths, MAX_CONTENT_API_BYTES, Infinity, [], notFound) : new Map<string, string>(),
    ]);
  } catch (error) {
    core.warning(`Failed to fetch file contents: ${error}`);
  }

  // An outdated thread has no line at the head, so the judge sees the code it named when posted and where that code is now.
  // GitHub moves no line of a thread on another file either, so its line is checked against the posted code the same way.
  const postedAt = new Map(recap.previousFindings.flatMap(f => {
    const line = f.findingLine ?? f.originalLine;
    const outdated = f.detached || (!f.line && f.originalCommit);
    return f.threadId && f.file && !isClosed(f.file) && outdated && line ? [[f.threadId, { commit: f.originalCommit, line }] as const] : [];
  }));
  const postedContents = new Map(await Promise.all([...new Set([...postedAt.values()].flatMap(p => p.commit ?? []))].map(async commit => {
    const files = [...new Set(baseOpenThreads.filter(t => postedAt.get(t.threadId)?.commit === commit).map(t => t.file))];
    try {
      return [commit, await fetchFileContents(octokit, owner, repo, commit, files)] as const;
    } catch (error) {
      core.warning(`Failed to fetch the code outdated threads were posted on at ${commit.slice(0, 7)}: ${error}`);
      return [commit, new Map<string, string>()] as const;
    }
  })));
  const placed = baseOpenThreads.map((t): OpenThread => {
    const contents = parsed.has(t.file) ? lockfileContents : fileContents;
    const posted = postedAt.get(t.threadId);
    const commit = posted?.commit;
    const old = commit && postedContents.get(commit)?.get(t.file);
    const current = contents?.get(t.file);
    // Without both copies of the code, nothing can be said about where it went, so the thread keeps the plain path. A
    // thread on another file then names no line, since the one it was posted with may hold other code by now.
    if (!posted || !commit || old === undefined || current === undefined || posted.line > old.split('\n').length) {
      const line = posted ? 0 : t.line;
      return { ...t, line, currentCode: extractCurrentCodeWindow(contents, t.file, line) };
    }
    // A thread on another file keeps its line while that file reads as it did when the thread was posted.
    if (t.line && old === current) return { ...t, currentCode: extractCurrentCodeWindow(contents, t.file, t.line) };
    // An unchanged file holds the code where it was, however few of its lines could vote.
    const now = old === current ? posted.line : locatePostedLine(old, posted.line, current);
    // Code that left its file counts as moved only when exactly one other file the PR changes holds it unchanged.
    const elsewhere = now === undefined
      ? locatePostedFile(old, posted.line, changedFilePaths.flatMap(p => p !== t.file && fileContents?.has(p) ? [[p, fileContents.get(p)!] as const] : []))
      : undefined;
    // Where the code is not found, the head's code near the same line still shows what the fix left there.
    const near = now ?? Math.min(posted.line, current.split('\n').length);
    return {
      ...t,
      line: near,
      postedCode: extractCurrentCodeWindow(new Map([[t.file, old]]), t.file, posted.line),
      postedCommit: commit,
      ...(elsewhere ? { movedTo: elsewhere.file } : now === undefined && { postedCodeGone: true }),
      currentCode: elsewhere ? extractCurrentCodeWindow(fileContents, elsewhere.file, elsewhere.line) : extractCurrentCodeWindow(contents, t.file, near),
    };
  });
  const read = (path: string): boolean => [fileContents, lockfileContents].some(contents => contents?.has(path));
  const unread = new Set([...filePaths, ...lockfileThreadPaths, ...closedThreadFiles].filter(p => !notFound.has(p) && !read(p)));
  const openThreads = placed.map(t => (unread.has(t.file) ? { ...t, codeUnread: true } : t));
  // A thread file outside the diff is no changed file the finders are told about.
  return { openThreads, fileContents, leftOutFiles: leftOut.filter(f => changedFilePaths.includes(f.path)) };
}

/**
 * Fetches the diff since the last reviewed commit, the PR's change at that commit, the issues the PR body links, the
 * open PRs and issues that may relate to the PR, and the static analysis results.
 */
async function collectRoundSignals(
  target: RunTarget, config: ReviewConfig, recap: RecapState, diff: ParsedDiff, fullDiff: ParsedDiff, lockfiles: LockfileDiff[], prContext?: PrContext,
): Promise<{ interRoundDiff?: string; priorChange?: ParsedDiff; linkedIssues?: LinkedIssue[]; relatedWork?: RelatedWork; staticSignals: StaticSignal[]; staticAnalysis?: RoundStaticAnalysis }> {
  const { octokit, owner, repo, prNumber, commitSha, baseRef } = target;
  const prBody = prContext?.body;
  const relatedWorkPromise = prContext
    ? findRelatedWork(octokit, {
      owner, repo, prNumber, title: prContext.title, body: prContext.body, diff, closedPaths: config.closed_paths,
      trackingIssues: recap.previousFindings.flatMap(f => f.trackingIssues ?? []),
    })
    : Promise.resolve(undefined);
  // A parsed lockfile stays in the diffs between rounds, so a push that changes it counts as a change.
  const parsedLockfiles = new Set(lockfiles.map(l => l.path));
  const reviewed = withLockfiles(diff, lockfiles);
  // Fetch the PR's own change since the prior round so the judge
  // can ground per-thread resolution in actual changes since last review.
  let interRoundDiff: string | undefined;
  const lastPriorSha = recap.priorRounds.at(-1)?.meta.commitSha;
  const shouldFetchDiff = !!(lastPriorSha && lastPriorSha !== commitSha);

  // Read with the workflow token, which carries the `checks` and `security-events` permissions the workflow grants.
  const staticSignalsPromise = collectStaticSignals(await workflowOctokit(), {
    owner, repo, prNumber, headSha: commitSha, baseRef, diff, fullDiff, lockfiles,
  });

  let linkedIssues;
  const diffPromise: Promise<string | undefined> = shouldFetchDiff && lastPriorSha
    ? fetchInterRoundDiff(octokit, owner, repo, lastPriorSha, commitSha)
      .then(raw => filterRawDiff(raw, config.exclude_paths, parsedLockfiles, config.closed_paths))
    : Promise.resolve(undefined);
  // The base branch diffed against the prior commit gives the PR's own change then, without what a rebase brought in.
  const priorChangePromise: Promise<ParsedDiff | undefined> = !lastPriorSha || lastPriorSha === commitSha
    ? Promise.resolve(lastPriorSha ? reviewed : undefined)
    : fetchInterRoundDiff(octokit, owner, repo, baseRef, lastPriorSha)
      .then(raw => filterDiff(parsePRDiff(raw), config.exclude_paths, parsedLockfiles, config.closed_paths).diff);
  const linkedIssuesPromise = prBody
    ? fetchLinkedIssues(octokit, owner, repo, prBody)
    : Promise.resolve(undefined);
  const [diffResult, priorChangeResult, linkedIssuesResult] = await Promise.allSettled([diffPromise, priorChangePromise, linkedIssuesPromise]);
  let priorChange: ParsedDiff | undefined;
  if (priorChangeResult.status === 'fulfilled') {
    priorChange = priorChangeResult.value;
  } else {
    core.warning(`Failed to fetch the PR's change at the last reviewed commit, so every finding counts as new: ${priorChangeResult.reason}`);
  }

  if (shouldFetchDiff) {
    if (diffResult.status === 'fulfilled' && priorChange && diffResult.value !== undefined) {
      // The two heads also differ by what a rebase brought in, so only the files whose PR change moved are kept.
      // The lockfile hunks go after the code, so the judge reads the code first.
      interRoundDiff = lockfilesLast(ownChangeSince(diffResult.value, priorChange, reviewed), lockfiles);
    } else if (diffResult.status === 'fulfilled') {
      core.warning('Without the PR\'s change at the last reviewed commit, the inter-round diff cannot leave out a rebase, so it is not used');
    } else {
      core.warning(`Failed to fetch inter-round diff: ${diffResult.reason}`);
    }
  } else if (lastPriorSha === commitSha) {
    // Same SHA as last round (force-push to same tree, or replay) — empty diff.
    interRoundDiff = '';
  }

  if (prBody) {
    if (linkedIssuesResult.status === 'fulfilled') {
      linkedIssues = linkedIssuesResult.value;
      if (linkedIssues && linkedIssues.length > 0) {
        core.info(`Fetched ${linkedIssues.length} linked issue(s) from PR body`);
      }
    } else {
      core.warning(`Failed to fetch linked issues: ${linkedIssuesResult.reason}`);
    }
  }

  const { signals: staticSignals, record: staticAnalysis } = await staticSignalsPromise;
  return { interRoundDiff, priorChange, linkedIssues, relatedWork: await relatedWorkPromise, staticSignals, staticAnalysis };
}

/**
 * Fetches the PR head for the repository tools when any of `clients` has them, without the paths `closedPaths` closes,
 * with the merge base the PR's diff starts from for reads at the base, which leave out `excludePaths`. Returns
 * `undefined` when none has them, or when the fetch of the head or the removal fails, and the models then run without
 * tools. A merge base that cannot be found leaves only the head.
 */
async function fetchToolWorkspace(
  { octokit, owner, repo, commitSha, baseRef }: Pick<RunTarget, 'octokit' | 'owner' | 'repo' | 'commitSha' | 'baseRef'>, clients: LLMClient[],
  excludePaths: readonly string[], closedPaths: readonly string[] = [],
): Promise<string | undefined> {
  if (!clients.some(client => client.repoTools)) return undefined;
  try {
    const [{ token }, base] = await Promise.all([
      octokit.auth() as Promise<{ token?: string }>,
      fetchMergeBase(octokit, owner, repo, baseRef, commitSha).catch((error: unknown) => {
        core.warning(`Could not find the PR's merge base, so the tools read only the head: ${failureReason(error)}`);
        return undefined;
      }),
    ]);
    return await fetchWorkspace(`${github.context.serverUrl}/${owner}/${repo}.git`, commitSha, token, closedPaths, base ? { sha: base, excludePaths } : undefined);
  } catch (error) {
    core.warning(`Could not fetch the PR head for the repository tools, so the models run without them: ${sanitizeTokens(String(error))}`);
    return undefined;
  }
}

/** Runs the review pipeline and mirrors its progress on the dashboard in the progress comment. */
async function reviewRound(
  run: ReviewRun, clients: ReviewClients, inputs: Omit<ReviewOptions, 'onProgress'>,
): Promise<ReviewStageResult> {
  const { octokit, owner, repo, commentId, dashboard, progress } = run;
  let reviewEndTime = run.parseEndTime;
  progress.liveEdits = startLiveEdits(() => updateProgressDashboard(octokit, owner, repo, commentId, dashboard, runningSettings(run, progress)));
  try {
    const result = await runReview(clients, { ...inputs, onProgress: event => {
      const now = Date.now();
      if (event.phase === 'planning') {
        core.info('Planner analyzing PR content...');
        dashboard.plannerStartedAt ??= now;
        if (event.teamAgentNames) {
          if (event.plannerResult) {
            dashboard.plannerInfo = {
              agentCount: event.teamAgentNames.length,
              judgeEffort: event.plannerResult.judgeEffort,
              prType: event.plannerResult.prType,
            };
          }
          dashboard.agentCount = event.teamAgentNames.length;
          dashboard.judgeEffort = event.judgeEffort;
          dashboard.agentProgress = event.teamAgentNames.map(name => ({ name, status: 'reviewing' as const }));
          dashboard.routing = event.routing;
          dashboard.plannerDurationMs = event.plannerDurationMs;
          if (event.heuristicFallback) dashboard.heuristicFallback = true;
          dashboard.phase = 'started';
        }
      } else if (event.phase === 'agent-start') {
        // A retry counts from its own start, as the time it ends with does.
        const entry = dashboard.agentProgress?.find(a => a.name === event.agentName);
        if (entry) {
          entry.startedAt = now;
          delete entry.toolSteps;
        }
      } else if (event.phase === 'agent-step') {
        const entry = dashboard.agentProgress?.find(a => a.name === event.agentName);
        if (entry) entry.toolSteps = (entry.toolSteps ?? 0) + 1;
      } else if (event.phase === 'agent-complete') {
        if (dashboard.agentProgress && event.agentName) {
          const entry = dashboard.agentProgress.find(a => a.name === event.agentName);
          if (entry) {
            if (event.notStarted) {
              entry.notStarted = event.notStarted;
            } else if (event.agentStatus === 'retrying') {
              entry.status = 'retrying';
              entry.retryCount = event.retryCount;
            } else {
              entry.status = event.agentStatus === 'failure' ? 'failed' : 'done';
              entry.findingCount = event.agentFindingCount;
              entry.durationMs = event.agentDurationMs;
              if (event.agentReused) entry.reused = true;
              if (event.agentStatus === 'failure' && event.retryCount) {
                entry.retryCount = event.retryCount;
              }
            }
          }
        }
      } else if (event.phase === 'side-check' && event.sideCheck) {
        const { kind, ...check } = event.sideCheck;
        const checks = dashboard.sideChecks ??= {};
        const step = checks[kind] ??= { total: 0, ended: 0, findings: 0, startedAt: now };
        if ('total' in check) step.total += check.total;
        else if (check.ended === undefined) step.total--;
        else {
          step.ended++;
          step.findings += check.ended;
        }
        step.endedAt = step.ended === step.total ? now : undefined;
      } else if (event.phase === 'reviewed') {
        reviewEndTime = now;
        dashboard.phase = 'reviewed';
        dashboard.rawFindingCount = event.rawFindingCount;
        dashboard.judgeStartedAt = now;
      } else if (event.phase === 'judging') {
        dashboard.phase = 'reviewed';
        dashboard.rawFindingCount = event.rawFindingCount;
        dashboard.judgeInputCount = event.judgeInputCount;
        if (event.judgeSkipped) dashboard.judgeSkipped = true;
        dashboard.staticDedupCount = event.staticDedupCount;
        dashboard.llmDedupCount = event.llmDedupCount;
        dashboard.toolAlertCount = event.toolAlertCount;
        dashboard.carriedLeadCount = event.carriedLeadCount;
        dashboard.openLeadCount = event.openLeadCount;
      } else if (event.phase === 'graded' && event.graded) {
        dashboard.graded = { ...event.graded, durationMs: now - (dashboard.judgeStartedAt ?? now) };
      } else if (event.phase === 'refuter' && event.refuterCheck) {
        const refuter = dashboard.refuter ??= { total: 0, outcomes: {} };
        const check = event.refuterCheck;
        if ('total' in check) refuter.total += check.total;
        else if (check.ended) refuter.outcomes[check.ended] = (refuter.outcomes[check.ended] ?? 0) + 1;
      } else if (event.phase === 'verdict-reader') {
        if (!event.verdictReaderDone) dashboard.verdictReader = { startedAt: now };
        else if (dashboard.verdictReader) dashboard.verdictReader.durationMs = now - dashboard.verdictReader.startedAt;
      }
    } });
    return { result, reviewEndTime, judgeEndTime: Date.now() };
  } finally {
    await stopLiveEdits(progress);
  }
}

/**
 * Fails the run and posts the incomplete round as a COMMENT with its record. An earlier request for changes stays standing, while an
 * approval of an older commit is dismissed, since nothing approved the code since. Once no Manki approval stands, the
 * coordinator's record of one is cleared too. Returns the report for the PR check.
 */
async function postIncompleteRound(run: ReviewRun, result: ReviewResult, buildContext: () => RoundContext, reviewTimeMs: number): Promise<CheckReport> {
  const { octokit, bot, owner, repo, prNumber, commitSha, commentId, dashboard, diff } = run;
  await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
  await stopLiveEdits(run.progress);
  core.setFailed(`Review incomplete: ${failureReason(result.summary)}`);
  result.verdict = 'COMMENT';
  const { id: reviewId } = await postReview(octokit, owner, repo, prNumber, commitSha, result, diff, buildContext(), reviewTimeMs, { noVerdict: true, rules: run.config.review?.rules, closedPaths: run.config.closed_paths });
  const { dismissed, failed, kept } = await dismissPreviousReviews(octokit, bot, owner, repo, prNumber, reviewId, 'APPROVED', commitSha);
  if (dismissed > 0 && !failed && kept === 0) await reportPrState(owner, repo, prNumber, { approval: null });
  dashboard.phase = 'complete';
  await updateProgressComment(octokit, owner, repo, commentId, { ...dashboard, totalDurationMs: Date.now() - run.startTime }, undefined, progressSettings(run, run.progress, 'review incomplete'));
  return outcomeReport('INCOMPLETE', result.summary);
}

/**
 * Resolves the threads the judge marked `addressed` and returns the ones it resolved. A thread that
 * fails to resolve stays open: `result` then records it as `uncertain`, and a blocker thread among them
 * keeps the round from approving. Other statuses
 * (`not_addressed`, `uncertain`) are logged for audit but never trigger a
 * resolveReviewThread mutation. Unknown thread IDs are filtered.
 *
 * Defense-in-depth: when the inter-round diff is known-empty (force-pushed
 * rebase to identical tree), no thread can be addressed. The judge already
 * synthesizes `not_addressed` for every thread in this case, but a future
 * refactor that bypasses `runJudgeAgent` would lose that guarantee. Drop
 * any `addressed` evaluation here as a second layer. `undefined` is the
 * unknown sentinel (compare-API failure) and must not trigger the guard.
 */
async function resolveAddressedThreads(run: ReviewRun, result: ReviewResult): Promise<OpenThread[]> {
  const hasPriorRounds = run.recap.priorRounds.length > 0;
  const interRoundDiffKnownEmpty = hasPriorRounds && isEmptyInterRoundDiff(run.interRoundDiff);
  const resolved: OpenThread[] = [];
  const stillOpen: OpenThread[] = [];
  let resolvedByOthers: Promise<Set<string>> | undefined;
  const resolvedByOther = (threadId: string) => (resolvedByOthers ??= fetchReviewThreadNodes<{ id: string; isResolved: boolean; resolvedBy: { login: string } | null }>(
    run.octokit, run.owner, run.repo, run.prNumber, 'id isResolved resolvedBy { login }',
  ).then(live => new Set(live.filter(t => t.isResolved && !isBotLogin(run.bot, t.resolvedBy?.login)).map(t => t.id)))
    .catch((error: unknown) => {
      core.warning(`Could not read who resolved the threads, resolving them as they are: ${error}`);
      return new Set<string>();
    })).then(ids => ids.has(threadId));
  if (result.threadEvaluations && result.threadEvaluations.length > 0) {
    const knownThreads = new Map(run.openThreads.map(t => [t.threadId, t]));
    for (const { threadId, status, reason } of result.threadEvaluations) {
      const thread = knownThreads.get(threadId);
      if (!thread) {
        core.debug(`Skipping unknown thread ${threadId} — not in openThreads allowlist`);
        continue;
      }
      core.info(`Thread ${threadId}: ${status} — ${reason}`);
      if (status !== 'addressed') continue;
      if (interRoundDiffKnownEmpty) {
        core.info(`Thread ${threadId}: ignoring 'addressed' verdict — inter-round diff is empty`);
        continue;
      }
      try {
        // The round record backs only a resolve GitHub credits to Manki, so a thread someone else resolved is reopened first.
        if (await resolvedByOther(threadId) && !await reopenThread(run.octokit, threadId)) throw new Error('someone else resolved it, and it could not be reopened for Manki to resolve');
        await resolveReviewThread(run.octokit, threadId, 'ADDRESSED');
        core.info(`Judge resolved: "${reason}" — thread ${threadId}`);
      } catch (error) {
        core.warning(`Failed to resolve thread ${threadId}, it stays open: ${error}`);
        stillOpen.push(thread);
        continue;
      }
      resolved.push(thread);
    }
  }
  if (stillOpen.length === 0) return resolved;
  // A later round reads `addressed` as a confirmed fix, so a thread that stayed open must not keep it.
  const failed = new Set(stillOpen.map(t => t.threadId));
  result.threadEvaluations = result.threadEvaluations?.map(e => failed.has(e.threadId)
    ? { ...e, status: 'uncertain', reason: `Resolving the thread failed, so it stays open. ${e.reason}` }
    : e);
  blockOnOpenThreads(result, stillOpen);
  return resolved;
}

/**
 * Replies in each thread the round resolved with the commit that fixed it, unless a Manki reply there already confirmed
 * the fix on this head. That reply answered the developer, so it says more than this line. A thread whose fixing commit
 * cannot be told gets "Fixed by the commits up to" the head.
 */
async function replyFixedThreads(run: ReviewRun, threads: OpenThread[]): Promise<void> {
  if (threads.length === 0) return;
  const { octokit, bot, owner, repo, prNumber, commitSha } = run;
  const confirmed = await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber)
    .then(live => new Set(live.filter(t => t.fixedOn?.includes(commitSha)).map(t => t.id)))
    .catch((error: unknown) => {
      core.warning(`Could not read which threads already confirm the fix, replying on all of them: ${error}`);
      return new Set<string>();
    });
  for (const { threadId } of threads.filter(t => confirmed.has(t.threadId))) {
    core.info(`Thread ${threadId} already confirms the fix on ${commitSha.slice(0, 7)}, so the round adds no reply`);
  }
  const unconfirmed = threads.filter(t => !confirmed.has(t.threadId));
  if (unconfirmed.length === 0) return;
  const fixingCommit = await findFixingCommit(run);
  for (const thread of unconfirmed) {
    const sha = fixingCommit(thread);
    const reply = sha ? `Fixed in ${sha.slice(0, 7)}.` : `Fixed by the commits up to ${commitSha.slice(0, 7)}.`;
    try {
      await replyToReviewThread(octokit, thread.threadId, reply, fixedMarker(commitSha));
    } catch (error) {
      core.warning(`Failed to reply on resolved thread ${thread.threadId}: ${error}`);
    }
  }
}

/**
 * Points each earlier thread a finding `raises` to the thread that carries that finding, and resolves it, so the PR
 * shows the defect once. That thread is the one the round posted for the finding, or the earlier thread the review put
 * it into by `placements`. The reply lifts a warning's hold, so the earlier thread stays open, with no reply, unless the
 * new thread blocks whenever it blocked and blocks or warns whenever it warned, and no finding of this round went into it.
 * A guarded thread stays open too, since only a fix or a person clears it.
 */
async function closeRaisedThreads(run: ReviewRun, result: ReviewResult, placements: ReadonlyMap<Finding, EarlierPlace | undefined>): Promise<void> {
  const raising = result.findings.filter(f => f.raises);
  if (raising.length === 0) return;
  const { octokit, bot, owner, repo, prNumber, commitSha } = run;
  let live: ReviewThread[];
  try {
    live = await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber);
  } catch (error) {
    core.warning(`Could not read the review threads, so the threads a finding raised stay open: ${error}`);
    return;
  }
  const earlier = new Set(run.recap.previousFindings.map(t => t.threadId));
  const posted = live.flatMap(t => t.place?.commit === commitSha && !earlier.has(t.id) ? [{ threadId: t.id, thread: t, ...t.place }] : []);
  const raised = raisedThreads(result, placements);
  const closed = new Set<string>();
  for (const f of raising) {
    const old = live.find(t => t.id === f.raises);
    const placed = placements.get(f)?.threadId;
    const fresh = placed ? live.find(t => t.id === placed) : posted.find(t => t.threadId === findPriorThreadId({ file: f.file, lineStart: f.line, lineEnd: f.line, slug: titleToSlug(f.title) }, posted))?.thread;
    const keeps = !fresh?.threadUrl || fresh.isResolved ? `"${f.title}" is in no open thread`
      : !old || old.isResolved || isGuarded(old) ? 'it is resolved or guarded'
      : !raised.has(old.id) ? 'a finding of this round went into it'
      : !holdsAtLeast(fresh, old) ? `${fresh.id} holds less than it does`
      : undefined;
    if (keeps || !old || !fresh?.threadUrl) {
      core.info(`Thread ${f.raises} stays as it is: ${keeps}`);
      continue;
    }
    const kind = `${isSecurityFinding(f.tags, f.reviewers) ? 'security ' : ''}${SEVERITY_NAME[f.severity]}`;
    try {
      await replyToReviewThread(octokit, old.id, `Raised to a ${kind}, continued in [this thread](${fresh.threadUrl}).`, RAISED_MARKER);
      await resolveReviewThread(octokit, old.id, 'WONT_FIX');
      closed.add(old.id);
      core.info(`Thread ${old.id} continues in ${fresh.id}, so it is resolved`);
    } catch (error) {
      core.warning(`Failed to close thread ${old.id}, which "${f.title}" continues in ${fresh.id}: ${error}`);
    }
  }
  if (result.verdict !== 'APPROVE') return;
  for (const t of live.filter(t => !closed.has(t.id) && t.isWarning && leftOutOfHeld(t, raised))) {
    core.warning(`Thread ${t.id} still holds the approval, though the review did not count it, since it was to be closed`);
  }
}

/**
 * Returns the findings that raise each earlier thread, which `closeRaisedThreads` may close. By the review's `placements`,
 * only a thread that takes no finding of the round counts.
 */
function raisedThreads(result: ReviewResult, placements: ReadonlyMap<Finding, EarlierPlace | undefined>): Map<string, Finding[]> {
  const taking = new Set([...placements.values()].map(p => p?.threadId));
  const raised = new Map<string, Finding[]>();
  for (const f of result.findings) {
    if (!f.raises || taking.has(f.raises)) continue;
    raised.set(f.raises, [...raised.get(f.raises) ?? [], f]);
  }
  return raised;
}

/** Whether the review leaves warning thread `t` out of the warnings that hold, since a finding that blocks or holds the approval continues it and Manki closes it after posting. */
function leftOutOfHeld(t: ReviewThread, raised: Map<string, Finding[]>): boolean {
  return !!raised.get(t.id)?.some(f => f.severity === 'blocker' || holdsApproval(f)) && !isGuarded(t);
}

/** Whether thread `to` holds the approval whenever thread `from` does: it blocks when `from` blocks, and blocks or warns when `from` warns. */
function holdsAtLeast(to: ReviewThread, from: ReviewThread): boolean {
  return (!from.isBlocking || to.isBlocking) && (!from.isWarning || !!to.isWarning || to.isBlocking);
}

/**
 * Returns the threads with a reply whose own run is still queued and certain to answer it: it was written before
 * `judgedAt`, the time of this round's record, its writer has write access, and it is no command. That answer says what
 * this round found open. Returns none when any of it cannot be read.
 */
async function threadsAwaitingAnswer({ octokit, bot, owner, repo, prNumber }: ReviewRun, judgedAt: string): Promise<Set<string>> {
  try {
    const { queuedReplies } = await loadSettings(owner, repo, prNumber);
    if (queuedReplies.size === 0) return new Set();
    const threads = await fetchBotReviewThreads(octokit, bot, owner, repo, prNumber);
    const answered = (r: { id: number; body: string; at: string }) => queuedReplies.has(r.id) && Date.parse(r.at) < Date.parse(judgedAt) && parseCommand(r.body).type === 'generic';
    const queued = threads.flatMap(t => (t.personReplies ?? []).filter(answered).map(r => ({ id: t.id, login: r.login })));
    const writers = new Map<string, boolean>();
    for (const login of new Set(queued.map(r => r.login))) writers.set(login, await hasWriteAccess(octokit, owner, repo, login));
    return new Set(queued.filter(r => writers.get(r.login)).map(r => r.id));
  } catch (error) {
    core.warning(`Could not read which thread replies are queued, so the round replies in every thread: ${error}`);
    return new Set();
  }
}

/**
 * Tells each thread whose grade a partial fix sets or changes what happened. The round record keeps the grade, so a
 * reply that fails loses only the note. A partly fixed thread hears what remains, but not again while it already
 * carries that grade and the push changes neither its file nor a file its finding cited. A thread of
 * `threadsAwaitingAnswer` hears it in that answer. A thread an earlier partial fix lowered hears that it is open again
 * at its own grade.
 */
async function replyPartlyFixedThreads(run: ReviewRun, result: ReviewResult, judgedAt: string): Promise<void> {
  const changed = filesChangedByPush(run.interRoundDiff);
  const threads = new Map(run.openThreads.map(t => [t.threadId, t]));
  let awaiting: Promise<Set<string>> | undefined;
  for (const { threadId, status, reason, remaining, grade } of result.threadEvaluations ?? []) {
    const thread = threads.get(threadId);
    if (!thread || !grade) continue;
    const carried = thread.recordedGrade ?? (thread.severity === 'unknown' ? 'blocker' : thread.severity);
    let body: string;
    if (status === 'partly_addressed' && remaining) {
      if (thread.recordedGrade === grade && run.interRoundDiff !== undefined && !pushTouchesThread(thread, changed)) continue;
      if ((await (awaiting ??= threadsAwaitingAnswer(run, judgedAt))).has(threadId)) {
        core.info(`Thread ${threadId} is partly fixed, and the queued answer to the reply there says so`);
        continue;
      }
      body = `**Partly fixed${partlyFixedEffect(grade, carried)}.** Still open: ${sanitizeMarkdown(remaining)}`;
    } else if (grade !== carried) {
      body = `**Open again: this thread is a ${SEVERITY_NAME[grade]} again${grade === 'blocker' ? ', so it blocks' : ''}.** ${sanitizeMarkdown(reason)}`;
    } else {
      continue;
    }
    try {
      await replyToReviewThread(run.octokit, threadId, body, roundReplyMarker(run.commitSha));
    } catch (error) {
      core.warning(`Failed to reply on partly fixed thread ${threadId}: ${error}`);
    }
  }
}

/**
 * Tells each thread whose fix two refuters confirmed in another changed file (`fixedIn`) where Manki sees that fix. A
 * fix outside the files its finding cited lifts nothing, so the thread stays open and blocks until a maintainer resolves
 * it or a push changes one of those files. The round record keeps the evaluation, so a reply that fails loses only the note.
 */
async function replyFixedElsewhere(run: ReviewRun, result: ReviewResult): Promise<void> {
  const threads = new Map(run.openThreads.map(t => [t.threadId, t]));
  for (const { threadId, fixedIn } of result.threadEvaluations ?? []) {
    const thread = threads.get(threadId);
    if (!thread?.file || !fixedIn) continue;
    const files = [thread.file, ...(thread.evidenceFiles ?? [])].map(inline).join(' or ');
    const body = `**Fix seen in ${inline(fixedIn)}.** Two refuters on different models found that this failure no longer happens after the change to ${inline(fixedIn)}. `
      + `Manki resolves no blocker on a fix outside the files its finding cited, so this thread stays open and keeps blocking. `
      + `A maintainer can resolve it. ${authorClearLine(run.config.author_clear_role)} A push that changes ${files} lets the next review confirm the fix.`;
    try {
      await replyToReviewThread(run.octokit, threadId, body, roundReplyMarker(run.commitSha));
    } catch (error) {
      core.warning(`Failed to reply on thread ${threadId} with the fix seen in ${fixedIn}: ${error}`);
    }
  }
}

/**
 * Returns a lookup of the commit since the last reviewed head that fixed a thread, named only when it is certain: the
 * only commit that changed the thread's file, editing it in place. It finds none in every other case, and none after a
 * rebase or a merge, or past `MAX_FIXING_COMMITS` commits.
 */
async function findFixingCommit(run: ReviewRun): Promise<(thread: OpenThread) => string | undefined> {
  const { octokit, owner, repo, commitSha } = run;
  const reviewed = run.recap.priorRounds.at(-1)?.meta.commitSha;
  try {
    const shas = reviewed ? await fetchCommitsSince(octokit, owner, repo, reviewed, commitSha) : [];
    if (shas.length === 0 || shas.length > MAX_FIXING_COMMITS) return () => undefined;
    const commits = await Promise.all(shas.map(async sha => ({ sha, diff: parsePRDiff(await fetchCommitDiff(octokit, owner, repo, sha)) })));
    return thread => thread.file ? onlyCommitChanging(commits, thread.file) : undefined;
  } catch (error) {
    core.warning(`Could not read the commits since the last review, so each fix reply names the range: ${error}`);
    return () => undefined;
  }
}

/**
 * Reopens each closed answered thread where the judge kept a finding that repeats its problem, and replies there.
 * A thread gets one reply per round. The round record, not the reply, makes the thread block for a blocker. A scope
 * warning the reader gave anew also gets a reply in the open thread of its kind, which shows its current wording.
 */
async function replyAnsweredThreads(run: ReviewRun, result: ReviewResult): Promise<void> {
  const byThread = new Map<string, Finding[]>();
  const askedAnew = result.scope !== undefined && result.scope.skipped === undefined;
  for (const f of result.findings) {
    const threadId = f.answeredIn?.threadId ?? (askedAnew && f.reviewers.includes(SCOPE_READER_NAME) ? f.threadId : undefined);
    if (threadId) byThread.set(threadId, [...(byThread.get(threadId) ?? []), f]);
  }
  for (const [threadId, findings] of byThread) {
    const thread = run.recap.previousFindings.find(t => t.threadId === threadId);
    const closed = !!thread && thread.status !== 'open' && thread.status !== 'replied';
    // Reopened first, so the thread a blocker was listed under stays open even when the reply fails.
    if (closed) {
      try {
        await unresolveReviewThread(run.octokit, threadId);
      } catch (error) {
        core.warning(`Failed to reopen answered thread ${threadId}: ${error}`);
      }
    }
    try {
      await replyToReviewThread(run.octokit, threadId, formatFoundAgainReply(findings, closed), FOUND_AGAIN_MARKER, roundReplyMarker(run.commitSha));
    } catch (error) {
      core.warning(`Failed to reply on answered thread ${threadId}: ${error}`);
    }
  }
}

/**
 * Replies in each open thread with the variants of its finding this round found. It runs before the review posts, so a
 * finding whose reply fails is taken out of its thread and the review posts it on its own.
 * Returns the node IDs of the replies, which `withdrawReplies` deletes when the review does not post.
 */
async function replyInOpenThreads(run: ReviewRun, result: ReviewResult): Promise<string[]> {
  const replies: string[] = [];
  const byThread = new Map<string, Finding[]>();
  for (const f of result.findings) {
    if (f.answeredIn || !f.threadId || !f.variantOf) continue;
    byThread.set(f.threadId, [...(byThread.get(f.threadId) ?? []), f]);
  }
  for (const [threadId, findings] of byThread) {
    try {
      const reply = await replyToReviewThread(run.octokit, threadId, formatVariantReply(findings));
      if (reply) replies.push(reply);
    } catch (error) {
      core.warning(`Failed to reply in thread ${threadId}, so the review posts its findings on their own: ${error}`);
      for (const f of findings) {
        delete f.threadId;
        delete f.variantOf;
        f.ownThread = true;
      }
    }
  }
  return replies;
}

/** Deletes the replies a round posted in threads before its review, when the review did not post. */
async function withdrawReplies(octokit: Octokit, replies: string[]): Promise<void> {
  for (const reply of replies) {
    try {
      await deleteThreadReply(octokit, reply);
    } catch (error) {
      core.warning(`Failed to delete reply ${reply} after the review did not post: ${error}`);
    }
  }
}

/** Reopens the threads a round resolved when its review did not go through. */
async function reopenThreads(octokit: Octokit, threads: OpenThread[]): Promise<void> {
  for (const { threadId } of threads) {
    try {
      await unresolveReviewThread(octokit, threadId);
    } catch (error) {
      core.warning(`Failed to reopen thread ${threadId} after the review did not post: ${error}`);
    }
  }
}

/** Turns an approval into a request for changes when a blocker thread it counted as fixed could not be resolved. */
function blockOnOpenThreads(result: ReviewResult, threads: OpenThread[]): void {
  const blocking = threads.filter(threadBlocks);
  if (blocking.length === 0 || result.verdict !== 'APPROVE') return;
  result.verdict = 'REQUEST_CHANGES';
  result.outcome = 'ADDRESS_FIRST';
  result.verdictReason = 'prior_unaddressed';
  result.verdictTrace = {
    survivingBlockers: [],
    unresolvedPriors: blocking.map(t => ({
      file: t.file,
      title: t.title,
      fingerprint: stringifyFindingFingerprint({ file: t.file, lineStart: t.line, lineEnd: t.line, slug: titleToSlug(t.title) }),
      threadId: t.threadId,
      ...(t.line && { line: t.line }),
      ...(t.threadUrl && { threadUrl: t.threadUrl }),
    })),
  };
}

const WARNINGS_ALSO_HOLD_LINE = 'Warnings also hold the approval. The review names each one and what clears it.';

/** Posts the round's review and dismisses the previous one. Returns the new review's id, whether its approval was held, and whether warnings hold it. */
async function postRound(run: ReviewRun, result: ReviewResult, context: RoundContext, reviewTimeMs: number, restart?: string, unreadRecords?: string[]): Promise<{ id: number; approvalHeld: ApprovalHeld; warningsHeld: boolean; alsoHeld?: string; placements: ReadonlyMap<Finding, EarlierPlace | undefined> }> {
  const { octokit, bot, owner, repo, prNumber, commitSha, diff, recap } = run;
  // A finding on a parsed lockfile gets a thread on its line like any other.
  const disproved = (result.allJudgedFindings ?? []).flatMap((f): DisprovedFinding[] => {
    const by = f.severity === 'ignore' && disproof(f);
    return by ? [{ title: f.title, file: f.file, line: f.line, reason: by.reason }] : [];
  });
  // Read after the round resolved the threads it found fixed, and with its own grades, which can lower a blocker thread to a warning.
  const postedDiff = withLockfiles(diff, run.lockfiles);
  const placements = earlierPlaces(result.findings, recap.previousFindings, postedDiff);
  const raised = raisedThreads(result, placements);
  const openWarnings = result.verdict === 'APPROVE'
    ? await fetchHeldWarnings(octokit, bot, owner, repo, prNumber, run.options.prAuthorLogin, run.config.author_clear_role, context).then(held => held.filter(t => !leftOutOfHeld(t, raised)), (error: unknown) => {
      core.warning(`Could not read the warning threads, so the approval is held: ${error instanceof Error ? error.message : error}`);
      return 'unread' as const;
    }) : [];
  const posted = await postReview(octokit, owner, repo, prNumber, commitSha, result, postedDiff, context, reviewTimeMs, {
    existingThreads: recap.previousFindings,
    placements,
    openWarnings,
    disproved,
    draft: run.options.draft,
    autoApprove: run.config.auto_approve,
    rules: run.config.review?.rules,
    closedPaths: run.config.closed_paths,
    configHold: run.configHold,
    memorySkip: run.memorySkip?.message,
    restart,
    ...(unreadRecords && { unreadRecords }),
    skipped: skippedFiles(run.excludedFiles, run.lockfiles, diff),
    onPosted: () => { run.progress.reviewPosted = true; },
  });
  await replacePreviousReviews(run, run.progress, posted.id);
  // A held approval posts a COMMENT, which leaves an approval of an older commit standing unless it is dismissed. A warning
  // also takes back an approval of this commit, as a round run again on it can find one.
  if (posted.approvalHeld) await dismissPreviousReviews(octokit, bot, owner, repo, prNumber, posted.id, 'APPROVED', posted.warningsHeld ? undefined : commitSha);
  return { ...posted, placements };
}

function metadataConfig(config: ReviewConfig, models: ReviewModels, triage: string, teamAgents: string[], reviewerModel?: string, memorySkip?: MemorySkip): ReviewMetadata['config'] {
  return {
    ...(reviewerModel && { reviewerModel }),
    judgeModel: models.judge,
    triage,
    teamAgents,
    memoryEnabled: config.memory?.enabled ?? false,
    memoryRepo: memorySkip ? `skipped: ${memorySkip.reason}` : config.memory?.repo || 'central',
  };
}

const LATER_DROPS: readonly LaterDrop[] = ['refutation', 'in_pr_suppression', 'resolved_thread', 'ratchet'];

/** The step after the judge's grading that graded `finding` `ignore`, or none when the judge dropped it or nothing did. */
function laterDrop(finding: Finding): LaterDrop | undefined {
  const step = finding.severity === 'ignore' ? finding.gradePath?.filter(s => s.to === 'ignore').at(-1) : undefined;
  return LATER_DROPS.find(by => by === step?.by);
}

/** Marks the progress comment complete with the judge's decisions and the round's timing. */
async function completeProgressComment(run: ReviewRun, stage: ReviewStageResult, totalDurationMs: number, context: RoundContext): Promise<void> {
  const { octokit, owner, repo, commentId, dashboard, config, models, startTime, parseEndTime } = run;
  const { result, reviewEndTime, judgeEndTime } = stage;

  // Reconcile the dashboard with the actual resolved team. Agents may fail
  // and drop out, so reconcile unconditionally to keep agentCount and
  // agentProgress accurate.
  reconcileDashboardAgents(dashboard, result.agentNames);

  if (result.plannerResult) {
    dashboard.plannerInfo = {
      agentCount: result.agentNames.length,
      judgeEffort: result.plannerResult.judgeEffort,
      prType: result.plannerResult.prType,
    };
  }

  const allJudgedForDashboard = result.allJudgedFindings || result.findings;
  const rawForLookup = result.rawFindings ?? allJudgedForDashboard;
  // A lead the tools left unsettled is listed as not finished, neither kept nor dropped.
  const listed = new Set(result.openLeads);
  // Kept findings are copies of the judged ones, so a judged finding counts as kept by its file, line and title.
  const keptKeys = new Set(result.findings.map(findingKey));
  const unpostedReasons = new Map<string, UnpostedReason | undefined>([
    ...(result.unposted ?? []).map(f => [findingKey(f), f.unpostedReason] as const),
    ...(result.unpostedPreExisting ?? []).map(f => [findingKey(f), 'pre_existing'] as const),
    ...(result.memorySuppressed ?? []).map(f => [findingKey(f), 'memory_suppression'] as const),
    ...(result.staticSignalMatches ?? []).map(m => [findingKey({ ...m, title: m.droppedTitle }), 'static_signal_match'] as const),
  ]);
  const judgeDecisions = allJudgedForDashboard.map(f => {
    const judgeKept = f.severity !== 'ignore' && !listed.has(f);
    const originalSeverity = judgeKept
      ? f.severity
      : rawForLookup.find(r => r.title === f.title && r.file === f.file && r.line === f.line)?.severity ?? f.severity;
    const unpostedReason = unpostedReasons.get(findingKey(f));
    return {
      title: f.title,
      severity: f.severity,
      reasoning: f.judgeNotes || '',
      // A finding a later step took out is not among the round's findings, so it is not listed as kept here.
      kept: judgeKept && keptKeys.has(findingKey(f)),
      ...(listed.has(f) && { listed: true as const }),
      ...(judgeKept && unpostedReason && { unpostedReason }),
      ...(f.importance && { importance: f.importance }),
      originalSeverity,
    };
  });

  const postedSeverities: Record<string, number> = {};
  for (const f of result.findings) {
    postedSeverities[f.severity] = (postedSeverities[f.severity] ?? 0) + 1;
  }
  const droppedSeverities: Record<string, number> = {};
  const recordOnly: Partial<Record<RecordOnlyReason, number>> = {};
  let kept = 0;
  let unsettledLeads = 0;
  // Kept findings the review neither posted nor recorded with a reason: the test-only throttle drops some, the rest are repeats.
  let leftOut = 0;
  allJudgedForDashboard.forEach((f, i) => {
    const key = findingKey(f);
    const reason = unpostedReasons.get(key) ?? laterDrop(f);
    if (f.severity === 'ignore' && !reason) {
      // judgeDecisions is built in lock-step with allJudgedForDashboard, so the index aligns and originalSeverity carries
      // the pre-judge severity even when the judge merged or renamed the finding before dropping it.
      const { originalSeverity } = judgeDecisions[i];
      droppedSeverities[originalSeverity] = (droppedSeverities[originalSeverity] ?? 0) + 1;
      return;
    }
    kept++;
    if (listed.has(f)) unsettledLeads++;
    else if (keptKeys.has(key)) return;
    else if (reason) recordOnly[reason] = (recordOnly[reason] ?? 0) + 1;
    else leftOut++;
  });
  const judgedKeys = new Set(allJudgedForDashboard.map(findingKey));
  const addedUnposted = [...unpostedReasons].filter(([key]) => !judgedKeys.has(key));
  for (const [, reason] of addedUnposted) {
    if (reason) recordOnly[reason] = (recordOnly[reason] ?? 0) + 1;
  }
  const testNitSuppressedCount = result.testNitSuppressedCount ?? 0;
  const completeDashboard: DashboardData = {
    ...dashboard,
    phase: 'complete',
    totalDurationMs,
    ...(result.routing && { routing: result.routing }),
    // The sweeps and the checks after the judge run past the judging event, so the round's own counts replace the event's.
    staticDedupCount: result.staticDedupCount ?? dashboard.staticDedupCount,
    llmDedupCount: result.llmDedupCount ?? dashboard.llmDedupCount,
    sweepRepeatCount: result.sweepRepeatCount,
    sweepDedupCount: result.sweepDedupCount,
    openLeadCount: (result.openLeads?.length ?? 0) - unsettledLeads,
    unsettledLeadCount: unsettledLeads,
    ...(!dashboard.judgeSkipped && {
      graded: { kept, dropped: allJudgedForDashboard.length - kept, merged: Math.max(0, mergedDuplicateCount(result)), durationMs: dashboard.graded?.durationMs ?? 0 },
    }),
    addedAfterJudgeCount: result.findings.filter(f => !judgedKeys.has(findingKey(f))).length + addedUnposted.length,
    repeatCount: Math.max(0, leftOut - testNitSuppressedCount),
    recordOnly,
    postedSeverities,
    droppedSeverities,
    ...(testNitSuppressedCount > 0 && { testNitSuppressedCount }),
    ...(!dashboard.judgeSkipped && { judgeDurationMs: judgeEndTime - reviewEndTime }),
  };

  const timing = {
    parseMs: parseEndTime - startTime,
    reviewMs: reviewEndTime - parseEndTime,
    ...(!dashboard.judgeSkipped && { judgeMs: judgeEndTime - reviewEndTime }),
    totalMs: judgeEndTime - startTime,
  };

  const triage = result.triage
    ? `trivial=${result.triage.trivial}, subtle=${result.triage.subtle}, paired=${result.triage.paired} (${result.plannerSource ?? 'planner'}${result.sensitivePaths ? ', security-sensitive paths' : ''}${result.ciOrDependencyPaths ? ', CI or dependency paths' : ''})`
    : 'none';
  const limits = latestLimits(result.llmCalls ?? []);
  const limitFallbacks = limitFallbackLines(context);
  const metadata: ReviewMetadata = {
    config: {
      ...metadataConfig(config, models, triage, result.agentNames, [...(result.agentModels?.values() ?? [])][0], run.memorySkip),
      ...(limitFallbacks.length > 0 && { limitFallbacks }),
    },
    judgeDecisions,
    ...(limits.length > 0 && { limits }),
    timing,
  };

  await updateProgressComment(octokit, owner, repo, commentId, completeDashboard, metadata, progressSettings(run, run.progress, 'up to date', { reviewed: true }));
}

function setReviewOutputs({ id, approvalHeld }: { id: number; approvalHeld: ApprovalHeld }, context: RoundContext, result: ReviewResult): void {
  const flatAliases = roundContextToFlatAliases(context);
  const severityMap = context.findings.severityCounts;
  // A held approval posts a COMMENT review, so the output matches the review a later step can see on the PR.
  const verdict = approvalHeld ? 'COMMENT' : flatAliases.verdict;
  // A later step can post or log an output, so none may carry a secret.
  const setOutput = (name: string, value: string): void => core.setOutput(name, redactSecrets(value));
  setOutput('review_id', id.toString());
  setOutput('verdict', verdict);
  setOutput('approval_held', approvalHeld || '');
  setOutput('findings_count', flatAliases.findingsKept.toString());
  setOutput('findings_json', JSON.stringify(redactSecretsDeep(result.findings)));

  // `result.findings` excludes 'ignore' severity (filtered in review.ts), so
  // the counts here mirror `severityMap` above and the legacy `severity` alias.
  setOutput('severity_counts', JSON.stringify(flatAliases.severity));

  setOutput('judge_model', flatAliases.judgeModel);

  core.info(`Review complete: ${verdict} with ${flatAliases.findingsKept} findings`);
  core.info(`Severity breakdown: ${severityMap.blocker} blocker, ${severityMap.warning} warning, ${severityMap.note} note`);
}

/**
 * Checks the PR head every `HEAD_POLL_MS` and aborts `controller` with `SupersededError` once it moved past the
 * commit under review. A failed lookup lets the review go on. Returns the function that stops the checks.
 */
function watchHead({ octokit, owner, repo, prNumber, commitSha }: RunTarget, controller: AbortController): () => void {
  let stopped = false;
  const timer = setInterval(() => {
    if (controller.signal.aborted) return;
    assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha).catch((error: unknown) => {
      if (stopped) return;
      core.info(`${error instanceof Error ? error.message : error}, stopping the review`);
      controller.abort(error);
    });
  }, HEAD_POLL_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

async function runFullReview(
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  baseRef: string,
  prContext?: PrContext,
  options: FullReviewOptions = {},
): Promise<void> {
  const { prAuthorLogin, forceReview, skipCap, trigger = buildRoundTrigger() } = options;
  core.info(`Starting review for ${owner}/${repo}#${prNumber}`);

  const providerInputs = readProviderInputs();

  if (!hasAnyProviderCredentials(providerInputs)) {
    core.setFailed('No API key configured — set claude_code_oauth_token, anthropic_api_key, openai_oauth_token, openai_oauth_file, openai_api_key, gemini_oauth_token, or gemini_api_key');
    return;
  }

  const startTime = Date.now();
  const { octokit, bot } = await getAuth();
  const target: RunTarget = { octokit, bot, owner, repo, prNumber, commitSha, baseRef };

  const headMoved = new AbortController();
  const stop = stopWritesOn(headMoved.signal);
  const progress: RunProgress = { reviewPosted: false, stopHeadWatch: watchHead(target, headMoved) };
  let check: ReviewCheck | undefined;
  // Stays unset when the run is cancelled, so the post step reports the check cancelled.
  let checkReport: CheckReport | undefined;

  try {
    const { config: loaded, reviewSource, brokenHead, closedUnknown } = await loadRunConfig(target);
    let config = loaded;
    if (await skipsRound(target, config, trigger, options, configFailed(reviewSource) || brokenHead !== undefined)) return;

    const { commentId, failed } = await postRunProgress(target, progress, options);
    progress.commentId = commentId;

    const recap = await loadRecap(target, config, progress, options);
    if (!recap) return;
    check = await startReviewCheck(octokit, owner, repo, commitSha);

    if (closedUnknown) {
      core.setFailed(`Review failed: ${closedUnknown}`);
      checkReport = failedReport(closedUnknown);
      await markProgressCommentFailed(octokit, owner, repo, commentId, 'Review', closedUnknown, progressSettings(target, progress, 'review failed'));
      return;
    }

    let built: ReturnType<typeof buildReviewClients>;
    try {
      built = buildReviewClients(config, providerInputs);
    } catch (error) {
      const reason = `Invalid model config: ${error instanceof Error ? error.message : error}`;
      core.setFailed(reason);
      checkReport = failedReport(reason);
      await dropProgressComment(target, progress, options.settings, 'review failed', `Review failed: ${sanitizeMarkdown(reason)}`);
      return;
    }
    const { clients, models } = built;

    const shortSha = commitSha.slice(0, 7);
    let collected: Awaited<ReturnType<typeof collectDiff>>;
    try {
      collected = await collectDiff(target, config);
    } catch (error) {
      if (!(error instanceof TooManyFilesError)) throw error;
      core.warning(`Diff too large (${error.message})`);
      checkReport = await postTooBigNotice(target, progress, `**Too big to review** at \`${shortSha}\`: this PR changes ${error.changedFiles} files, and GitHub lists only ${error.listedFiles} of them, so Manki cannot read it. Split it into smaller PRs to get a review.`, false, recap.priorRounds.at(-1)?.meta.timestamp);
      return;
    }
    const { fullDiff, diff, excludedFiles, rawDiff, closedPaths } = collected;
    // Every later read, the tools' checkout included, keeps out the open path of a rename into or out of a closed path too.
    config = { ...config, closed_paths: closedPaths };
    const lockfiles = await collectLockfiles(target, fullDiff);
    const parseEndTime = Date.now();
    const lineCount = diff.totalAdditions + diff.totalDeletions;
    // `runReview` reports the team after triage.
    const dashboard: DashboardData = { phase: 'planning', lineCount, agentCount: 0, ...(trigger.catchUp && { catchUp: true }) };
    await updateProgressDashboard(octokit, owner, repo, commentId, dashboard, runningSettings(target, progress));
    const unreviewedMetadata = (): ReviewMetadata => ({
      config: metadataConfig(config, models, 'none', []),
      judgeDecisions: [],
      timing: { parseMs: parseEndTime - startTime, reviewMs: 0, judgeMs: 0, totalMs: Date.now() - startTime },
    });

    const autoLimit = Math.min(config.auto_review_max_lines ?? config.max_diff_lines, config.max_diff_lines);
    // The prompts show a long removed or unchanged line shortened, so the gate counts it the same way.
    const charCount = rebuildRawDiff({ ...diff, files: diff.files.map(shortenLongLines) }).length;
    if (charCount > MAX_REVIEW_CHARS) {
      core.warning(`Diff too large (${charCount} reviewable characters > ${MAX_REVIEW_CHARS} max)`);
      checkReport = await postTooBigNotice(target, progress, `**Too big to review** at \`${shortSha}\`: this PR has ${charCount} characters of reviewable diff, above the limit of ${MAX_REVIEW_CHARS} that Manki reviews. Split it into smaller PRs to get a review.`, false, recap.priorRounds.at(-1)?.meta.timestamp);
      return;
    }
    if (lineCount > config.max_diff_lines) {
      core.warning(`Diff too large (${lineCount} reviewable lines > ${config.max_diff_lines} max)`);
      checkReport = await postTooBigNotice(target, progress, `**Too big to review** at \`${shortSha}\`: this PR has ${lineCount} reviewable lines, above the limit of ${config.max_diff_lines} that Manki reviews. Split it into smaller PRs to get a review.`, false, recap.priorRounds.at(-1)?.meta.timestamp);
      return;
    }
    if (lineCount > autoLimit && !forceReview && !skipCap) {
      core.info(`No automatic review: ${lineCount} reviewable lines > ${autoLimit}`);
      checkReport = await postTooBigNotice(target, progress, `**Too big for automatic review** at \`${shortSha}\`: this PR has ${lineCount} reviewable lines, above the limit of ${autoLimit} for automatic review. Split it into smaller PRs, or tick the review box in the settings block to review it in full.`, true, recap.priorRounds.at(-1)?.meta.timestamp);
      return;
    }
    if (charCount > MAX_AUTO_REVIEW_CHARS && !forceReview && !skipCap) {
      core.info(`No automatic review: ${charCount} reviewable characters > ${MAX_AUTO_REVIEW_CHARS}`);
      checkReport = await postTooBigNotice(target, progress, `**Too big for automatic review** at \`${shortSha}\`: this PR has ${charCount} characters of reviewable diff, above the limit of ${MAX_AUTO_REVIEW_CHARS} for automatic review. Split it into smaller PRs, or tick the review box in the settings block to review it in full.`, true, recap.priorRounds.at(-1)?.meta.timestamp);
      return;
    }

    core.info(`Reviewing ${diff.files.length} files (${fullDiff.files.length} total, ${excludedFiles.length} filtered out)`);

    if (diff.files.length === 0 && lockfiles.length === 0) {
      core.info('No reviewable files in diff');
      // Every source reads the skipped files as the diff, so CI, dependency review and the analyzers still check them.
      const { signals } = await collectStaticSignals(await workflowOctokit(), { owner, repo, prNumber, headSha: commitSha, baseRef, diff: fullDiff, fullDiff });
      const notice = formatUnreviewedNotice(shortSha, { excluded: excludedFiles, binary: fullDiff.binarySkipped ?? [] }, signals);
      checkReport = await postUnreviewedRound(target, progress, commentId, dashboard, diff, notice, unreviewedMetadata());
      return;
    }

    // Placed after the diff-size and empty-files guards so cold installs are skipped on paths that never invoke an LLM.
    await warmUpClients(clients);

    const repoContext = await fetchRepoContext(target.octokit, target.owner, target.repo, target.baseRef, diff.files.map(f => f.path), config.closed_paths);
    const { memory, memoryLoadStatus, memoryLoadError, memorySkip, fixRates } = await loadRunMemory(octokit, config, owner, repo, prNumber);

    const priorRoundCount = recap.priorRounds.length;
    const maxAutoRounds = config.max_auto_rounds ?? 0;
    const pause = pauseState(recap, config);
    const { roundsLeft, paused } = pause;
    if (paused && !skipCap && !forceReview) {
      checkReport = await postPauseNotice(target, progress, pause, maxAutoRounds, recap.previousFindings, recap.priorRounds.at(-1)?.meta.timestamp);
      return;
    }
    const digest = changeDigest(fullDiff);
    const countsTowardCap = !options.draft && isNewChange({ commitSha, changeDigest: digest }, recap.priorRounds.at(-1));

    const { openThreads, fileContents, leftOutFiles } = await collectOpenThreads(target, recap, diff, lockfiles, prAuthorLogin, config.closed_paths);
    const [{ interRoundDiff, priorChange, linkedIssues, relatedWork, staticSignals, staticAnalysis }, workspace] = await Promise.all([
      collectRoundSignals(target, config, recap, diff, fullDiff, lockfiles, prContext),
      fetchToolWorkspace(target, [clients.reviewer, clients.judge, ...(clients.reviewerByModel?.values() ?? [])], config.exclude_paths, config.closed_paths),
    ]);

    const run: ReviewRun = {
      ...target, options, trigger, config, reviewSource, configHold: brokenConfig(reviewSource, brokenHead?.changed ?? false), models,
      recap, priorRoundCount, maxAutoRounds,
      diff, changeDigest: digest, excludedFiles, lockfiles, openThreads, interRoundDiff, memoryLoadStatus, memoryLoadError, memorySkip, fixRates, staticAnalysis, instructions: repoContext,
      commentId, dashboard, progress, startTime, parseEndTime,
    };

    if (failed) await markFailedProgressSuperseded(octokit, owner, repo, failed, commitSha);
    const stage = await reviewRound(run, clients, {
      checkpoint: async () => {
        stop.signal.throwIfAborted();
        await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
      },
      signal: stop.signal,
      // Counted from the start of the action, which is as close to the job's start as a step can see.
      deadline: Date.now() - process.uptime() * 1000 + ROUND_TIME_MS,
      config,
      diff,
      rawDiff,
      repoContext: repoContext.text,
      instructionFiles: repoContext.files,
      memory,
      fileContents,
      leftOutFiles,
      prContext: prContext && staticSignals.length > 0 ? { ...prContext, staticSignals } : prContext,
      linkedIssues,
      relatedWork,
      isFollowUp: recap.previousFindings.length > 0,
      // `null` tells `determineOutcome` the open threads are unknown, so no prior can retire.
      openThreads: recap.openThreadsState === 'fetch_failed' ? null : openThreads,
      previousFindings: recap.previousFindings,
      priorRounds: recap.priorRounds,
      ...(recap.priorRoundsIncomplete && { priorRoundsIncomplete: true }),
      prAuthorLogin,
      interRoundDiff,
      changesSince: base => fetchChangesSince(octokit, owner, repo, base, commitSha),
      headSha: commitSha,
      finalRound: !paused && countsTowardCap && roundsLeft === 1,
      workspace,
      deeper: options.deeper,
      excludedPaths: excludedFiles.map(f => f.path),
      fullDiff,
      lockfiles,
      changeDigest: digest,
      automaticRetry: options.automaticRetry,
      earlierAttempt: await reusableAttempt(octokit, recap, commitSha, options),
    });
    // A model call the stop aborted can end the round incomplete, and that round must not be posted.
    stop.signal.throwIfAborted();
    const { result } = stage;

    const reviewTimeMs = Date.now() - startTime;
    const buildContext = () => buildRoundContext({ ...run, tokenServiceCalls: tokenServiceCalls(), runner: runnerDiagnostics() }, result, {
      plannerDurationMs: dashboard.plannerDurationMs,
      judgeDurationMs: stage.judgeEndTime - stage.reviewEndTime,
      wallClockMs: reviewTimeMs,
    });

    if (!result.reviewComplete) {
      checkReport = await postIncompleteRound(run, result, buildContext, reviewTimeMs);
      return;
    }

    const reviewed = withLockfiles(diff, lockfiles);
    addCodeContext(result.findings, reviewed);
    tagFindingOrigins(result.findings, reviewed, options.fullReview ? undefined : priorChange, interRoundDiff ? parsePRDiff(interRoundDiff) : undefined, citedPlaces);
    if (priorRoundCount > 0 && (options.fullReview || !priorChange)) result.originsWithoutPrior = true;
    // Only the diff since the last round shows a line the push moved or restored, so without it no line counts as reviewed for certain.
    if (!options.fullReview) hideSeenNotes(result, interRoundDiff === undefined ? undefined : reviewed);

    await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
    // Resolved before posting, so a thread that stays open settles the verdict of the one review the round posts.
    const resolved = await resolveAddressedThreads(run, result);
    // A round record that could not be read may hold a raise, so the round requests changes while a Manki thread stays open,
    // and says why in the review and the check.
    const agreed = new Set(recap.previousFindings.filter(f => f.threadId && replyClassOf(f) === 'agree').map(f => f.threadId));
    const stillOpen = recap.priorRoundsIncomplete ? run.openThreads.filter(t => !resolved.includes(t) && !agreed.has(t.threadId)) : [];
    // Only a round the unread record kept from approving names it as the reason.
    const withheld = stillOpen.length > 0 && result.verdict === 'APPROVE';
    blockOnOpenThreads(result, stillOpen.map(t => ({ ...t, recordedGrade: 'blocker' as const })));
    const unreadRecords = withheld ? recap.unreadRecords ?? [] : undefined;
    const replies = await replyInOpenThreads(run, result);
    // After the replies, so a note whose reply failed competes for a place like any other note.
    capNotes(result, recap.previousFindings, config.review?.notes);
    await carryBodyWarnings(result, recap.priorRounds, openRepoFiles(githubRepoFiles(octokit, owner, repo, commitSha), config.closed_paths ?? [], true));
    const context = buildContext();
    if (context.meta.calibrationLowered !== undefined) {
      core.info(`Fix-rate calibration: ${context.meta.calibrationLowered} of ${context.findings.entries.filter(e => e.calibration).length} calibrated findings would be lowered, nothing changed`);
    }
    const pauseAfter = pauseState({ ...recap, priorRounds: [...recap.priorRounds, context] }, config);
    let posted: Awaited<ReturnType<typeof postRound>>;
    try {
      posted = await postRound(run, result, context, reviewTimeMs, pauseAfter.restart, unreadRecords);
    } catch (error) {
      // A thread is resolved only by a review that replaces the previous one. A reply stays under a review that posted.
      await reopenThreads(octokit, resolved);
      if (!run.progress.reviewPosted) await withdrawReplies(octokit, replies);
      throw error;
    }
    await reportPrState(owner, repo, prNumber, {
      reviewed: { commit: commitSha },
      ...(result.verdict === 'APPROVE' && { approval: { commit: commitSha, held: !!posted.approvalHeld } }),
      pause: pauseReport(pauseAfter),
    });
    await replyFixedThreads(run, resolved);
    await closeRaisedThreads(run, result, posted.placements);
    await replyPartlyFixedThreads(run, result, context.meta.timestamp);
    await replyFixedElsewhere(run, result);
    await replyAnsweredThreads(run, result);
    await completeProgressComment(run, stage, reviewTimeMs, context);
    await retireStaleNotices(octokit, bot, owner, repo, prNumber, commitSha, { pauseLifted: !pauseAfter.paused });
    setReviewOutputs(posted, context, result);
    // As in the review, warnings come before a draft or a conflict. Behind another hold, the summary names them.
    const alsoHeld = posted.alsoHeld ?? (posted.warningsHeld && posted.approvalHeld !== 'warnings' ? WARNINGS_ALSO_HOLD_LINE : '');
    const summary = unreadRecords ? [unreadRecordsLine(unreadRecords), withheldSummary(roundSentence(result))].filter(Boolean).join('\n\n') : roundSummary(result);
    checkReport = outcomeReport(result.outcome, [summary, alsoHeld].filter(Boolean).join('\n\n'), posted.alsoHeld ? 'warnings' : posted.approvalHeld);
  } catch (caught) {
    await stopLiveEdits(progress);
    // A stopped run reports the stop, whatever error it ended on.
    const error = stop.signal.aborted ? stop.signal.reason : caught;
    if (error instanceof RunCancelledError) {
      core.info(`${error.message}, writing nothing more to GitHub`);
      return;
    }
    if (error instanceof PrClosedError) {
      core.info(`${error.message}, posting nothing for it`);
      checkReport = { conclusion: 'neutral', title: 'PR closed, review stopped', summary: 'The pull request was closed or merged during the review, so Manki stopped it.' };
      return;
    }
    if (error instanceof SupersededError) {
      core.info(`${error.message}, ${progress.reviewPosted ? 'replacing no earlier review' : 'posting no verdict for it'}`);
      checkReport = { conclusion: 'cancelled', title: 'Superseded', summary: error.message };
      if (progress.commentId !== undefined) {
        await markProgressCommentSuperseded(octokit, owner, repo, progress.commentId, error, progress.reviewPosted);
      }
      return;
    }
    const reason = failureReason(error);
    core.setFailed(`Review failed: ${reason}`);
    checkReport = failedReport(reason);

    if (progress.commentId !== undefined) {
      await markProgressCommentFailed(octokit, owner, repo, progress.commentId, 'Review', reason, progressSettings(target, progress, 'review failed'));
    }
  } finally {
    progress.stopHeadWatch();
    stop.release();
    if (checkReport) await completeReviewCheck(check, checkReport);
  }
}

async function handleReviewStateCheck(): Promise<void> {
  const { octokit, bot } = await getAuth();

  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.info('No pull request in payload — skipping auto-approve check');
    return;
  }

  if (eventPrClosed()) {
    core.info(`PR #${pr.number} is merged or closed, skipping the state check`);
    return;
  }

  const reviewSha = github.context.payload.review?.commit_id;
  const headSha = github.context.payload.pull_request?.head?.sha;
  if (reviewSha && headSha && reviewSha !== headSha) {
    core.info(`Review is for stale commit ${reviewSha}, HEAD is ${headSha} — skipping auto-approve`);
    return;
  }

  const { owner, repo } = github.context.repo;
  await runStateCheck(octokit, bot, owner, repo, pr.number, pr.user?.login, await loadEventConfig(octokit, owner, repo, pr.base.ref));
}

/**
 * Runs the approval check after a thread or review changed, with the base branch's config `loaded`. It reopens the
 * guarded threads the PR author resolved, then approves when nothing holds, or with `auto_approve` off withdraws an
 * approval a blocking thread no longer allows.
 */
async function runStateCheck(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, prAuthorLogin: string | undefined,
  { config, held }: { config: ReviewConfig; held: boolean },
): Promise<void> {
  // Without the config nothing says whether Manki may approve, or which role below `admin` lets the PR author clear a thread.
  if (held) {
    core.info('The base branch config could not be read or loaded — skipping the state check');
    return;
  }

  // A guarded thread the PR author resolved blocks with `auto_approve` off too, so it is reopened first.
  const recap = await fetchRecapState(octokit, bot, owner, repo, prNumber, prAuthorLogin, config.author_clear_role);
  await reopenAuthorResolvedThreads(octokit, recap);

  if (!config.auto_approve) {
    core.info('auto_approve is disabled — skipping state check');
    await withdrawBlockedApproval(octokit, bot, owner, repo, prNumber, prAuthorLogin, config.author_clear_role);
    return;
  }

  const approved = await checkAndAutoApprove(octokit, bot, owner, repo, prNumber, config);
  if (approved) {
    core.info(`PR #${prNumber} auto-approved after all findings resolved`);
  }
}


async function handleInteraction(): Promise<void> {
  const providerInputs = readProviderInputs();

  if (!hasAnyProviderCredentials(providerInputs)) {
    core.setFailed('No API key configured — set claude_code_oauth_token, anthropic_api_key, openai_oauth_token, openai_oauth_file, openai_api_key, gemini_oauth_token, or gemini_api_key');
    return;
  }

  const { octokit, bot } = await getAuth();

  const { owner, repo } = github.context.repo;
  const prNumber = github.context.payload.issue?.number;
  if (!prNumber) return;

  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  const { config, held, closedUnknown } = await loadEventConfig(octokit, owner, repo, pr.base.ref);

  const built = buildLLMClientFromInputs({ inputs: providerInputs, model: resolveModel(config, 'judge') });
  if (!built) return;
  const { client } = built;

  const { store: memory } = await openMemoryStore(octokit, config.memory, owner, repo, prNumber);

  await handlePRComment(octokit, bot, client, owner, repo, prNumber, memory, config, held, closedUnknown);
}

async function handleIssueInteraction(): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;
  if (!comment) return;

  if (comment.user?.type === 'Bot' || comment.body?.includes('<!-- manki')) return;

  const { owner, repo } = github.context.repo;
  const issueNumber = payload.issue?.number;
  if (!issueNumber) return;

  const { octokit, bot } = await getAuth();
  const { config, held } = await loadEventConfig(octokit, owner, repo, eventBranch(payload.repository?.default_branch, 'default branch'));

  const { store: memory } = await openMemoryStore(octokit, config.memory, owner, repo, issueNumber);

  await handlePRComment(octokit, bot, null, owner, repo, issueNumber, memory, config, held);
}

/** Runs both tick handlers of an edited review or review comment, so one failing does not skip the other. The first error is rethrown. */
async function handleTicks(): Promise<void> {
  const failures: unknown[] = [];
  for (const handler of [handleIssueTick, handleBoxTick]) {
    try {
      await handler();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const later of failures.slice(1)) core.error(`A second tick handler failed too: ${later instanceof Error ? later.message : later}`);
  if (failures.length > 0) throw failures[0];
}

/** Files the findings whose issue box the editor ticked in Manki's review comment or review body. */
async function handleIssueTick(): Promise<void> {
  const { comment, review, pull_request: pr, sender } = github.context.payload;
  if (!pr || !sender?.login) return;
  const { octokit, bot } = await getAuth();
  const { owner, repo } = github.context.repo;
  if (review) {
    await handleReviewBoxTick(octokit, bot, owner, repo, pr.number, review as Parameters<typeof handleReviewBoxTick>[5], sender.login);
    return;
  }
  if (!comment || !await handleIssueBoxTick(octokit, bot, owner, repo, pr.number, comment as Parameters<typeof handleIssueBoxTick>[5], sender.login)) return;
  // Neither Manki's own resolve nor its reply starts an approval check, so it runs here, as it does after a person resolves a thread.
  const { config, held } = await loadEventConfig(octokit, owner, repo, eventBranch(pr.base?.ref, 'base branch'));
  if (held || !config.auto_approve) return;
  if (await checkAndAutoApprove(octokit, bot, owner, repo, pr.number, config)) core.info(`PR #${pr.number} auto-approved after a ticked issue box`);
}

/**
 * Acts on each box the editor ticked in Manki's comment, review or review comment, other than an issue box. Review again
 * reviews as a tick in the settings block does. Every other box runs its command for the editor, then names who asked
 * for it, or is unticked again when the command did nothing or failed.
 */
async function handleBoxTick(): Promise<void> {
  const { eventName, payload } = github.context;
  const object = eventName === 'pull_request_review' ? payload.review : payload.comment;
  const prNumber: number | undefined = payload.pull_request?.number ?? payload.issue?.number;
  if (!object?.id || !prNumber) return;
  const message: TickedMessage = { kind: eventName === 'issue_comment' ? 'comment' : eventName === 'pull_request_review' ? 'review' : 'review_comment', id: object.id };
  const ticked = tickedMessageBoxes(object.body ?? '');
  const commands = ticked.flatMap(({ box, id }) => (box === 'again' ? [] : [{ box, id }]));
  const again = ticked.some(({ box }) => box === 'again');
  const { owner, repo } = github.context.repo;
  // A Review again run that fails, before or after it settles its box, leaves no ticked box behind.
  const triggerAgain = async (): Promise<void> => {
    try {
      await handleCommentTrigger(true, message);
    } catch (error) {
      await getAuth().then(({ octokit }) => settleTickedBox(octokit, owner, repo, prNumber, message, 'again', undefined, undefined), () => undefined);
      throw error;
    }
  };
  if (commands.length === 0) {
    if (again) await triggerAgain();
    return;
  }
  const { octokit, bot } = await getAuth();
  const settled = new Set<(typeof commands)[number]>();
  const settle = async (command: (typeof commands)[number], editor?: string): Promise<void> => {
    settled.add(command);
    await settleTickedBox(octokit, owner, repo, prNumber, message, command.box, command.id, editor);
  };
  try {
    if (again) await triggerAgain();
    const baseRef: unknown = payload.pull_request?.base?.ref ?? (await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber })).data.base.ref;
    const { config, held } = await loadEventConfig(octokit, owner, repo, eventBranch(baseRef, 'base branch'));
    const memory = commands.some(({ box }) => box === 'forget') ? (await openMemoryStore(octokit, config.memory, owner, repo, prNumber)).store : undefined;
    const commentId = message.kind === 'review_comment' ? message.id : undefined;
    for (const command of commands) {
      let done = false;
      try {
        done = await handleBoxCommand(octokit, bot, owner, repo, prNumber, command.box, command.id, { memory, config, configHeld: held, commentId });
      } finally {
        await settle(command, done ? payload.sender?.login : undefined);
      }
    }
    // As after a dismiss reply, the resolved thread may have been the last one that blocked.
    if (commands.some(({ box }) => box === 'dismiss') && !held && config.auto_approve) {
      if (await checkAndAutoApprove(octokit, bot, owner, repo, prNumber, config)) core.info(`PR #${prNumber} auto-approved after a ticked Dismiss box`);
    }
  } finally {
    // A step that failed before its command ran leaves the box ticked, so each box not settled is put back.
    for (const command of commands.filter(c => !settled.has(c))) await settle(command);
  }
}

async function handleReviewCommentInteraction(): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;

  if (!comment) return;

  // Don't respond to our own comments
  if (comment.user?.type === 'Bot' || comment.body?.includes('<!-- manki')) {
    return;
  }

  // Only respond if this is a reply to a bot comment or names Manki
  const body = comment.body ?? '';
  const isReplyToBot = !!comment.in_reply_to_id; // handleReviewCommentReply will verify it's actually our comment
  const mentionsBot = hasBotMention(body);

  if (!isReplyToBot && !mentionsBot) {
    core.info('Review comment is not a reply to bot and does not name Manki — skipping');
    return;
  }

  const providerInputs = readProviderInputs();

  if (!hasAnyProviderCredentials(providerInputs)) {
    core.setFailed('No API key configured — set claude_code_oauth_token, anthropic_api_key, openai_oauth_token, openai_oauth_file, openai_api_key, gemini_oauth_token, or gemini_api_key');
    return;
  }

  const { octokit, bot } = await getAuth();
  const { owner, repo } = github.context.repo;

  const { config, held, closedUnknown } = await loadEventConfig(octokit, owner, repo, eventBranch(payload.pull_request?.base?.ref, 'base branch'));

  const built = buildLLMClientFromInputs({ inputs: providerInputs, model: resolveModel(config, 'judge') });
  if (!built) return;
  const { client } = built;

  const prNumber: number | undefined = payload.pull_request?.number;
  const memory = prNumber ? (await openMemoryStore(octokit, config.memory, owner, repo, prNumber)).store : undefined;

  const command = parseCommand(body);
  if (command.type !== 'generic') {
    if (prNumber) {
      await handleReviewCommentCommand(octokit, bot, owner, repo, prNumber, comment.id, command, memory, config.author_clear_role);
    } else {
      core.warning('Cannot handle command — pull request number not available');
    }
  } else {
    if (!prNumber) {
      core.warning('Cannot handle reply — pull request number not available');
      return;
    }
    const baseRef: string | undefined = payload.pull_request?.base?.ref;
    // The reply handler replaces the payload's PR when its head moves, so the head is read on each call.
    const loadWorkspace = async (commit: string | undefined = payload.pull_request?.head?.sha) => {
      if (!commit || !baseRef) return undefined;
      let closedPaths = config.closed_paths ?? [];
      try {
        // The open path of a file the PR renames into or out of a closed path holds the closed file's text at the base or the head.
        if (closedPaths.length > 0) closedPaths = reviewableDiff(await fetchPRDiff(octokit, owner, repo, prNumber), [], closedPaths).closedPaths;
      } catch (error) {
        core.warning(`Could not read the PR's diff to find the files it moves into or out of a closed path, so the reply runs without tools: ${failureReason(error)}`);
        return undefined;
      }
      return fetchToolWorkspace({ octokit, owner, repo, commitSha: commit, baseRef }, [client], config.exclude_paths, closedPaths);
    };
    await handleReviewCommentReply(octokit, bot, client, owner, repo, prNumber, memory, loadWorkspace, config, closedUnknown);
  }

  // Check if all review threads are now resolved (e.g. the reply resolved the last conversation)
  if (prNumber && !held && config.auto_approve) {
    const approved = await checkAndAutoApprove(octokit, bot, owner, repo, prNumber, config);
    if (approved) {
      core.info(`PR #${prNumber} auto-approved after all findings resolved`);
    }
  } else if (prNumber && !held && !eventPrClosed()) {
    // The reply can reopen a blocking thread, which takes back an approval a round gave.
    await withdrawBlockedApproval(octokit, bot, owner, repo, prNumber, payload.pull_request?.user?.login, config.author_clear_role);
  }
}

const POST_PHASE_STATE_KEY = 'manki_post_phase';
const TOKEN_FAILURE_LINE = '⚠️ **Manki did not run:**';
// The run has already failed, so the note must not keep it open for long.
const TOKEN_FAILURE_NOTE_TIMEOUT_MS = 10_000;

const NOT_DISPATCHED = 'Manki runs only from the `workflow_dispatch` workflow that the Manki service starts. '
  + 'See https://github.com/manki-review/manki/blob/main/docs/getting-started.md#step-3-add-the-workflow';

/**
 * Post-step cleanup invoked when the main step is cancelled or fails.
 * Marks the current run's progress comment as cancelled so the next trigger
 * doesn't see a zombie.
 */
async function postCleanup(): Promise<void> {
  const prNumber = dispatchedNumber();
  const { owner, repo } = github.context.repo;
  try {
    const { octokit } = await getAuth();
    await cancelOpenReviewCheck(octokit, owner, repo);
    if (await markOwnProgressCommentCancelled(octokit, owner, repo)) {
      core.info(`Post-cleanup: marked the progress comment on #${prNumber} as cancelled`);
    } else {
      core.info(`Post-cleanup: no open progress comment on #${prNumber}`);
    }
  } catch (error) {
    core.warning(`Post-cleanup failed: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Tells the PR or issue a dispatched run is for that the run stopped because the token service failed, once per reason.
 * A failed token call leaves only the workflow's `github_token` to post with, so the note comes from `github-actions[bot]`
 * and carries no Manki marker. A merge waits on nobody, so it gets no note.
 */
async function reportTokenFailure({ event, action, number }: ReturnType<typeof dispatchedInputs>, error: TokenServiceError): Promise<void> {
  const token = core.getInput('github_token');
  if (!token || (event === 'pull_request' && action === 'closed')) return;
  const { owner, repo } = github.context.repo;
  const reviews = event === 'pull_request' && action !== APPROVAL_CHECK_ACTION;
  const body = `${reviews ? REVIEW_INCOMPLETE_LINE : TOKEN_FAILURE_LINE} ${sanitizeMarkdown(redactSecrets(error.message))}`;
  try {
    const octokit = createOctokit(token, { deadline: AbortSignal.timeout(TOKEN_FAILURE_NOTE_TIMEOUT_MS) });
    const comments = await octokit.paginate(octokit.rest.issues.listComments, { owner, repo, issue_number: number, per_page: 100 });
    if (comments.some(comment => comment.body === body)) return;
    await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body });
  } catch (postError) {
    core.warning(`Could not post that the token service failed: ${postError}`);
  }
}

async function main(): Promise<void> {
  const cancel = new AbortController();
  const stop = stopWritesOn(cancel.signal);
  const onSignal = (signal: NodeJS.Signals): void => {
    core.info(`Received ${signal}, stopping before any further GitHub write`);
    cancel.abort(new RunCancelledError(signal));
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  // Dispatch: the same bundle is used for `main` and `post` in action.yml.
  // `core.saveState` sets a STATE_<key> env var that only reaches the post step,
  // so its presence indicates we're in the post phase.
  const isPostPhase = core.getState(POST_PHASE_STATE_KEY) === 'true';
  // Read before the dispatched event replaces the inputs in the context.
  let dispatched: ReturnType<typeof dispatchedInputs> | undefined;
  let stopSampler: (() => void) | undefined;
  let queueWait: Promise<void> | undefined;

  try {
    if (isPostPhase) {
      if (isDispatchedRun()) await postCleanup();
    } else {
      core.saveState(POST_PHASE_STATE_KEY, 'true');
      if (!isDispatchedRun()) throw new Error(NOT_DISPATCHED);
      dispatched = dispatchedInputs();
      const octokit = await workflowOctokit();
      if (await restoreDispatchedEvent(octokit) === 'run') {
        stopSampler = startMemorySampler();
        // Only the round record and the last log line read the result, so the event is handled while the lookup runs.
        queueWait = recordQueueWait(octokit);
        await run();
      }
    }
  } catch (error) {
    if (dispatched !== undefined && error instanceof TokenServiceError) await reportTokenFailure(dispatched, error);
    core.setFailed(`Manki encountered an error: ${failureReason(error, dispatched && retryHintFor(dispatched))}`);
  } finally {
    if (stopSampler) {
      stopSampler();
      await queueWait;
      core.info(formatRunner(runnerDiagnostics(), true));
    }
    removeSeededAuthFiles();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
    stop.release();
  }
  // Let Node exit naturally. `core.setFailed` sets `process.exitCode = 1` which
  // propagates to GitHub Actions so the `post-if: failure()` condition fires.
  // Calling `process.exit()` here would force-terminate and override that signal.
}

// Only auto-run when executed directly (not imported for testing)
if (process.env.NODE_ENV !== 'test') {
  if (process.argv[2] === MCP_SERVER_COMMAND) runMcpServer(process.argv.slice(3));
  else if (process.argv[2] === STEP_HOOK_COMMAND) runStepHook(process.argv[3], process.argv[4]);
  else if (process.argv[2] === REVIEW_COMMAND) runReviewCommand(process.argv.slice(3)).then((code) => { process.exitCode = code; });
  else if (process.argv[2] === BENCH_COMMAND) runBenchCommand(process.argv.slice(3)).then((code) => { process.exitCode = code; });
  else main();
}

function _resetOctokitCache(): void {
  authCache = null;
}

export { run, handlePullRequest, handleCommentTrigger, handleInteraction, handleIssueInteraction, handleReviewCommentInteraction, handleReviewStateCheck, runFullReview, main, _resetOctokitCache };
