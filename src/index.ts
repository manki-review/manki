import * as core from '@actions/core';
import * as fs from 'fs';
import * as github from '@actions/github';
import * as path from 'path';

import { assertWritesAllowed, RunCancelledError, stopWritesOn } from './abort';
import { AppMemory, AuthResult, createAuthenticatedOctokit, fetchPrState, getMemoryToken } from './auth';
import { sanitizeTokens, withMarkers } from './utils';
import { applyBaseReviewConfig, BaseReviewConfig, loadConfig, loadConfigFromFile, loadReviewConfig, matchSkipRule, sanitizeForkConfig, resolveFallbackModel, resolveMemoryRepo, resolveModel, resolvePairModel } from './config';
import { buildAuthForProvider, createLLMClient, hasAnyProviderCredentials, parseModelSpec, sanitizeLogOutput } from './providers';
import type { LLMClient, ProviderAuth, ProviderInputs } from './providers';
import { cancelOpenReviewCheck, CheckReport, completeReviewCheck, failedReport, outcomeReport, ReviewCheck, startReviewCheck } from './check-run';
import { extractCurrentCodeWindow } from './code-window';
import { recordFixRate } from './fix-rate';
import { dispatchedNumber, isDispatchedRun, restoreDispatchedEvent } from './dispatch';
import { addCodeContext, changeDigest, parsePRDiff, filterDiff, filterRawDiff, rebuildRawDiff, tagFindingOrigins } from './diff';
import { handleReviewCommentReply, handleReviewCommentCommand, handlePRComment, isReviewRequest, isBotMentionNonReview, hasBotMention, parseCommand, isLLMAccessAllowed } from './interaction';
import { isEmptyInterRoundDiff } from './judge';
import { loadMemory, RepoMemory } from './memory';
import { MCP_SERVER_COMMAND, runMcpServer } from './mcp-server';
import { fetchRecapState, PreviousFinding, RecapState, securityOverridesIn } from './recap';
import { RETRY_HINT, ReviewClients, ReviewOptions, runReview, selectTeam, stringifyFindingFingerprint, teamModels } from './review';
import { buildRoundContext, RoundRecordInput } from './round-context';
import { collectStaticSignals } from './static-signals';
import { runStepHook, STEP_HOOK_COMMAND } from './tool-steps';
import { fetchWorkspace } from './workspace';
import { SETTINGS_MARKER, SettingsBox, SettingsView, withSettingsBlock } from './settings';
import { DashboardData, FullReviewOptions, MemoryLoadStatus, OpenThread, ParsedDiff, PrContext, ReviewConfig, ReviewMetadata, ReviewModels, ReviewResult, RoundContext, RoundOutcome, RoundStaticAnalysis, RoundTrigger, SettingsState, StaticSignal, roundContextToFlatAliases } from './types';
import {
  fetchPRDiff,
  fetchConfigFile,
  readConfigFile,
  fetchRepoContext,
  fetchFileContents,
  fetchInterRoundDiff,
  fetchHeadSha,
  assertHeadUnchanged,
  SupersededError,
  postProgressComment,
  updateProgressComment,
  updateProgressDashboard,
  dismissPreviousReviews,
  postReview,
  formatOpenBlockers,
  reactToIssueComment,
  fetchLinkedIssues,
  APPROVED_LINE,
  BOT_MARKER as PROGRESS_MARKER,
  isBotLogin,
  isReviewInProgress,
  titleToSlug,
  isApprovedOnCommit,
  hasBotReviewOnCommit,
  fetchPRComments,
  markOwnProgressCommentCancelled,
  markProgressCommentFailed,
  markProgressCommentSuperseded,
  postAppWarningIfNeeded,
  checkConcurrentSubmissionLock,
  postConfigErrorComment,
  latestSettings,
  PAUSE_NOTICE_MARKER,
  REVIEW_COMPLETE_MARKER,
  retireSettingsBlocks,
  setSettingsBlock,
  showSettings,
} from './github';
import type { ApprovalHeld, BotIdentity, LinkedIssue, StandingVerdict } from './github';
import { announceSecurityOverrides, checkAndAutoApprove, findUnchangedVerdict, holdApproval, isNewChange, pauseState, reopenAuthorResolvedThreads, replyToReviewThread, resolveReviewThread, retireStaleNotices, unresolveReviewThread } from './state';
import type { PauseState } from './state';

type Octokit = ReturnType<typeof github.getOctokit>;

const HEAD_POLL_MS = 30_000;

/** The outcome a standing review reports on a no-op push. A COMMENT never stands, so it runs a full round instead. */
const STANDING_OUTCOMES: Record<StandingVerdict['verdict'], RoundOutcome> = { APPROVE: 'READY', REQUEST_CHANGES: 'ADDRESS_FIRST' };

/**
 * Build `RoundMeta.trigger` from the current GitHub Actions event. The event
 * string folds in the action and, for an edit of the settings block, the box
 * modes of the run, so a `5/5 -> 6/5` jump in the round-cap counter is
 * attributable to the exact box that fired.
 */
function buildRoundTrigger(modes: ReadonlySet<string> = new Set()): RoundTrigger {
  const eventName = github.context.eventName;
  const payload = github.context.payload;
  const action = payload.action;
  const sender = payload.sender?.login ?? 'unknown';

  let event = action ? `${eventName}:${action}` : eventName;
  if (eventName === 'issue_comment') {
    const body = payload.comment?.body ?? '';
    if (action === 'edited' && body.includes(SETTINGS_MARKER)) {
      event = [`${event}:settings`, ...(modes.size > 0 ? [[...modes].sort().join(',')] : [])].join(':');
    } else if (action === 'created' && isReviewRequest(body)) {
      event = `${event}:@manki review`;
    }
  }
  return { event, sender };
}

function readProviderInputs(): ProviderInputs {
  return {
    anthropicOauthToken: core.getInput('claude_code_oauth_token'),
    anthropicApiKey: core.getInput('anthropic_api_key'),
    openaiOauthToken: core.getInput('openai_oauth_token'),
    openaiApiKey: core.getInput('openai_api_key'),
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
  authCache ??= await createAuthenticatedOctokit();
  return authCache;
}

/** A client on the workflow's own `github_token`, which needs no call to the token service. */
async function workflowOctokit(): Promise<Octokit> {
  const token = core.getInput('github_token');
  return token ? github.getOctokit(token) : (await getAuth()).octokit;
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
  const reviewAuthorType = github.context.payload.review?.user?.type ?? '';
  if (senderType === 'Bot' || reviewAuthorType === 'Bot') {
    const actor = senderType === 'Bot'
      ? (github.context.payload.sender?.login ?? 'unknown bot')
      : (github.context.payload.review?.user?.login ?? 'unknown bot');
    core.info(`Ignoring event from bot: ${actor}`);
    return;
  }

  let settingsTick = false;

  // Event filtering — exit immediately for irrelevant events.
  // Tested via integration (live PR reviews) since it depends on GitHub Actions context.
  if (eventName === 'pull_request') {
    if (action !== 'opened' && action !== 'synchronize' && action !== 'ready_for_review' && action !== 'closed') {
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
    if (!mentioned && !settingsEdit) {
      core.info('Comment does not mention Manki — ignoring');
      return;
    }
    if (!await commenterAllowed()) return;
    const { bot } = await getAuth();
    // A bot's edit never gets here, but Manki on a personal access token edits as that user.
    settingsTick = settingsEdit && isBotLogin(bot, github.context.payload.comment?.user?.login) && !isBotLogin(bot, github.context.payload.sender?.login);
    if (!settingsTick && !mentioned) {
      core.info('Comment does not mention Manki — ignoring');
      return;
    }
    const commentId = github.context.payload.comment?.id;
    const issueNumber = github.context.payload.issue?.number;
    // Every tick in the settings block starts its own run, which the coordinator's modes describe, so none counts as answered.
    if (commentId && issueNumber && !settingsTick) {
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
    if (action !== 'created') {
      core.info(`Ignoring pull_request_review_comment action: ${action}`);
      return;
    }
    // Skip our own review comments
    const commentBody = github.context.payload.comment?.body ?? '';
    if (commentBody.includes('<!-- manki')) {
      core.info('Ignoring our own review comment');
      return;
    }
    if (!await commenterAllowed()) return;
  } else if (eventName === 'pull_request_review') {
    if (action !== 'submitted' && action !== 'dismissed') {
      core.info(`Ignoring pull_request_review action: ${action}`);
      return;
    }
  } else if (eventName === 'pull_request_review_thread') {
    // Only a dispatched run sees this event, since GitHub Actions cannot trigger on it.
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
      } else {
        await handlePullRequest();
      }
      break;

    case 'issue_comment': {
      const commentBody = github.context.payload.comment?.body ?? '';
      if (settingsTick && github.context.payload.issue?.pull_request) {
        await handleCommentTrigger(true);
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
      await handleReviewCommentInteraction();
      break;

    case 'pull_request_review':
      core.info('Review submitted/dismissed — checking if auto-approve is warranted');
      await handleReviewStateCheck();
      break;

    case 'pull_request_review_thread':
      core.info(`Review thread ${action}, checking if auto-approve is warranted`);
      await handleReviewStateCheck();
      break;
  }
}

/** The state of a PR the coordinator has nothing on: not paused, and no box modes. */
const NO_SETTINGS: SettingsState = { settings: { paused: false }, runModes: new Set(), queuedModes: new Set() };

/**
 * Returns the PR's coordinator state. Without one, as when the token service cannot answer, the PR counts as
 * not paused with no box modes, so a push still gets its review.
 */
async function loadSettings(owner: string, repo: string, prNumber: number): Promise<SettingsState> {
  const state = isDispatchedRun() ? await fetchPrState(owner, repo, prNumber, github.context.runId) : null;
  return state ? { ...state, settings: state.settings ?? NO_SETTINGS.settings } : NO_SETTINGS;
}

/** The boxes that apply to a PR: Pause, Full review and Deeper review always, Review this draft on a draft, and `extra`. */
function settingsBoxes(draft: boolean, extra: SettingsBox[] = []): Set<SettingsBox> {
  return new Set<SettingsBox>(['pause', 'full', 'deeper', ...(draft ? ['draft' as const] : []), ...extra]);
}

/** The boxes the coordinator state ticks: Pause while paused, and each box whose run is still queued. */
function tickedBoxes(settings: SettingsState): Set<SettingsBox> {
  return new Set<SettingsBox>([...(settings.settings.paused ? ['pause' as const] : []), ...settings.queuedModes]);
}

/**
 * How a run reviews. Any box a writer ticked reviews even a draft or an already reviewed or paused PR.
 * `full` counts every finding as new, and `deeper` runs two finders on every group, each one effort level higher.
 */
function reviewModes({ runModes }: SettingsState): { forced: boolean; fullReview: boolean; deeper: boolean } {
  return { forced: runModes.size > 0, fullReview: runModes.has('full'), deeper: runModes.has('deeper') };
}

/**
 * Shows `status` in the settings block, for a run that reviews nothing. Posts `text` with it when no comment has a block.
 * Without `lastReviewed`, the block keeps the commit it names.
 */
async function showRunStatus(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, settings: SettingsState,
  { head, draft, status, text, lastReviewed }: { head: string; draft: boolean; status: string; text: string; lastReviewed?: string },
): Promise<void> {
  await showSettings(octokit, bot, owner, repo, prNumber, {
    ...(lastReviewed && { lastReviewed }), head, status, boxes: settingsBoxes(draft), ticked: tickedBoxes(settings),
  }, text);
}

/** Shows an already reviewed `commitSha` as up to date in the settings block. Its Full review box reviews it again. */
async function showAlreadyReviewed(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, commitSha: string, settings: SettingsState, draft = false,
): Promise<void> {
  await showRunStatus(octokit, bot, owner, repo, prNumber, settings, {
    head: commitSha, draft, status: 'up to date', text: 'This commit already has a review.', lastReviewed: commitSha,
  });
}

/** Whether the base branch's config sets `drafts: review`. A config that cannot be read counts as `drafts: skip`. */
async function reviewsDrafts(octokit: Octokit, owner: string, repo: string, baseRef: string): Promise<boolean> {
  const configPath = core.getInput('config_path') || '.manki.yml';
  try {
    return loadConfig(await fetchConfigFile(octokit, owner, repo, baseRef, configPath) ?? undefined, configPath).drafts === 'review';
  } catch (error) {
    core.warning(`Could not read ${configPath} on the base branch, skipping the draft PR: ${error instanceof Error ? error.message : error}`);
    return false;
  }
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
  if (draft && !forced && !(await reviewsDrafts(octokit, owner, repo, pr.base.ref))) {
    core.info('Skipping draft PR (`drafts: skip`)');
    await showRunStatus(octokit, bot, owner, repo, prNumber, settings, {
      head: commitSha, draft, status: 'draft, not reviewed automatically', text: 'This PR is a draft, so Manki does not review it automatically.',
    });
    return;
  }
  if (settings.settings.paused && !forced) {
    core.info('Automatic review is paused in the settings block, skipping');
    await showRunStatus(octokit, bot, owner, repo, prNumber, settings, {
      head: commitSha, draft, status: 'automatic review paused', text: 'Automatic review is paused.',
    });
    return;
  }

  // A running review already shows in the settings block.
  if (await isReviewInProgress(octokit, bot, owner, repo, prNumber, commitSha)) return;

  if (!forced && await isApprovedOnCommit(octokit, bot, owner, repo, prNumber, commitSha)) {
    core.info('Already approved on this commit — skipping review');
    return;
  }

  if (!forced && await hasBotReviewOnCommit(octokit, bot, owner, repo, prNumber, commitSha)) {
    core.info(`Bot already reviewed commit ${commitSha.slice(0, 7)} — skipping serialized sibling run`);
    await showAlreadyReviewed(octokit, bot, owner, repo, prNumber, commitSha, settings, draft);
    return;
  }

  const prContext: PrContext = {
    title: pr.title,
    body: pr.body || '',
    baseBranch: pr.base.ref,
  };

  await runFullReview(owner, repo, prNumber, commitSha, pr.base.ref, prContext, {
    prAuthorLogin: pr.user?.login,
    skipFacts: {
      labels: (pr.labels ?? []).map((l: { name?: string }) => l.name ?? '').filter(Boolean),
      author: pr.user?.login,
      sender: github.context.payload.sender?.login,
      branch: pr.head.ref ?? '',
      fromFork: pr.head.repo?.full_name !== `${owner}/${repo}`,
    },
    headRepoFullName: pr.head.repo?.full_name,
    trigger: buildRoundTrigger(),
    ...(forced && { forceReview: true, skipCap: true, bypassHint: 'force_review' as const }),
    settings,
    draft,
    fullReview,
    deeper,
  });
}

async function handleMergedPullRequest(): Promise<void> {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.warning('No pull request found in event payload');
    return;
  }

  const { octokit, bot, appMemory } = await getAuth();
  const { owner, repo } = github.context.repo;
  const configPath = core.getInput('config_path') || '.manki.yml';
  const configContent = await fetchConfigFile(octokit, owner, repo, pr.base.ref, configPath);
  const config = loadConfig(configContent ?? undefined, configPath);
  if (!(config.metrics?.fix_rate ?? config.memory?.enabled)) {
    core.info('Fix-rate metrics are off, skipping');
    return;
  }

  let memory: { octokit: Octokit; repo: string } | undefined;
  if (config.memory?.enabled) {
    const memoryRepo = resolveMemoryRepo(config.memory, owner);
    const memoryToken = await getMemoryToken(appMemory, memoryRepo);
    if (memoryToken) {
      memory = { octokit: github.getOctokit(memoryToken), repo: memoryRepo };
    } else {
      core.info('The fix rate goes to the job summary only');
    }
  }

  await recordFixRate(octokit, bot, owner, repo, {
    number: pr.number,
    headSha: pr.head.sha,
    mergedSha: pr.merge_commit_sha ?? '',
    authorLogin: pr.user?.login,
  }, memory);
}

/**
 * Reviews the PR a comment is on, for a review command or, with `settingsTick`, a box ticked in the settings block.
 * A tick reviews only with a mode the coordinator queued for the run.
 */
async function handleCommentTrigger(settingsTick = false): Promise<void> {
  const payload = github.context.payload;

  if (!payload.issue?.pull_request) {
    core.info('Comment is on an issue, not a PR — skipping');
    return;
  }

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const prNumber = payload.issue.number;

  const { octokit, bot } = await getAuth();
  const settings = await loadSettings(owner, repo, prNumber);
  const { forced, fullReview, deeper } = reviewModes(settings);
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

  // A running review already shows in the settings block.
  if (!forced && await isReviewInProgress(octokit, bot, owner, repo, prNumber, pr.head.sha)) {
    core.info('Review already in progress — skipping');
    return;
  }

  // An approved head counts as reviewed here, so a review command on it shows up to date, and Full review reviews it again.
  if (!forced && await hasBotReviewOnCommit(octokit, bot, owner, repo, prNumber, pr.head.sha)) {
    core.info(`Bot already reviewed commit ${pr.head.sha.slice(0, 7)} — skipping`);
    await showAlreadyReviewed(octokit, bot, owner, repo, prNumber, pr.head.sha, settings, draft);
    return;
  }

  const prContext: PrContext = {
    title: pr.title,
    body: pr.body || '',
    baseBranch: pr.base.ref,
  };

  await runFullReview(owner, repo, prNumber, pr.head.sha, pr.base.ref, prContext, {
    prAuthorLogin: pr.user?.login,
    headRepoFullName: pr.head.repo?.full_name,
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

function failureReason(error: unknown): string {
  return sanitizeLogOutput(sanitizeTokens(describeFailure(error)));
}

/**
 * Describes a failure in a sentence that always names a cause. A 5xx from GitHub reads as a
 * transient failure, and an Octokit error with an empty message falls back to its status and call.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error).trim() || `A ${typeof error} with no message`;
  const message = error.message.trim();
  if (error.name === 'HttpError') {
    const { status, request, response } = error as OctokitErrorFields;
    const path = request?.url?.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const call = request?.method && path ? ` on ${request.method} ${path}` : '';
    const requestId = response?.headers?.['x-github-request-id'];
    const where = `${call}${requestId ? ` (request id ${requestId})` : ''}`;
    // Without a response the request never reached GitHub, so the message names the network error.
    if (response && status !== undefined && status >= 500) return `GitHub returned ${status}${where}. ${RETRY_HINT}`;
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

/** The progress comment of a run, its pending dashboard update and whether its review is posted, which the failure path also reads. */
interface RunProgress {
  commentId?: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  reviewPosted: boolean;
  /** Stops the head watcher, so a later push no longer stops the round. */
  stopHeadWatch: () => void;
  /**
   * What the settings block of the progress comment carries over all its edits, and the comment that had the block before.
   * Set once the progress comment is posted.
   */
  settings?: { lastReviewed?: string; draft: boolean; ticked: ReadonlySet<SettingsBox>; previousId?: number };
}

/** The settings block of the run's progress comment with `status`, or `undefined` without one. `reviewed` marks the head reviewed. */
function progressSettings(
  target: RunTarget, progress: RunProgress, status: string, { boxes = [], reviewed = false }: { boxes?: SettingsBox[]; reviewed?: boolean } = {},
): SettingsView | undefined {
  const settings = progress.settings;
  if (!settings) return undefined;
  const lastReviewed = reviewed ? target.commitSha : settings.lastReviewed;
  return { ...(lastReviewed && { lastReviewed }), head: target.commitSha, status, boxes: settingsBoxes(settings.draft, boxes), ticked: settings.ticked };
}

const runningSettings = (target: RunTarget, progress: RunProgress): SettingsView | undefined =>
  progressSettings(target, progress, 'review running', { boxes: ['cancel'] });

/** Posts the run's progress comment, ending with the settings block, which older comments then lose, so only the newest progress comment has one. */
async function postRunProgress(target: RunTarget, progress: RunProgress, { settings = NO_SETTINGS, draft = false }: FullReviewOptions): Promise<number> {
  const { octokit, bot, owner, repo, prNumber, commitSha } = target;
  let comments: Awaited<ReturnType<typeof fetchPRComments>> = [];
  try {
    comments = await fetchPRComments(octokit, owner, repo, prNumber);
  } catch (error) {
    core.warning(`Failed to read the earlier settings block, so it stays: ${error instanceof Error ? error.message : error}`);
  }
  const latest = latestSettings(comments, bot);
  progress.settings = {
    lastReviewed: latest?.settings.lastReviewed, draft, ticked: tickedBoxes(settings),
    ...(latest && { previousId: latest.id }),
  };
  const commentId = await postProgressComment(octokit, owner, repo, prNumber, commitSha, undefined, runningSettings(target, progress));
  await retireSettingsBlocks(octokit, bot, owner, repo, comments, commentId);
  return commentId;
}

/**
 * Deletes the run's progress comment for a run that reviews nothing. The settings block goes back to the comment that
 * had it before, with `status`. Without such a comment, `text` is posted with the block.
 */
async function dropProgressComment(target: RunTarget, progress: RunProgress, settings: SettingsState = NO_SETTINGS, status: string, text: string): Promise<void> {
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

/** What a review round works on. Built once its inputs are collected, then passed to the stages that review, post and record. */
interface ReviewRun extends RunTarget, RoundRecordInput {
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

function cancelDashboardFlush(progress: RunProgress): void {
  if (progress.flushTimer) {
    clearTimeout(progress.flushTimer);
    progress.flushTimer = null;
  }
}

/**
 * Loads `.manki.yml` from the local checkout so a PR that modifies its own
 * config (e.g., extending `exclude_paths`) takes effect on the same PR.
 * `process.cwd()` is the PR tree because the action runs as a local
 * composite via `./` in the consumer workflow. A dispatched run reads the
 * file at the head commit through the API instead. The `review` block is the
 * exception: it comes from the base branch, so a PR cannot weaken its own
 * review. Returns `undefined` after reporting a config that does not load.
 */
async function loadRunConfig(target: RunTarget, configPath: string, headRepoFullName?: string): Promise<{ config: ReviewConfig; reviewSource: BaseReviewConfig['source'] } | undefined> {
  const { octokit, owner, repo, prNumber, commitSha, baseRef } = target;
  const cwd = path.resolve(process.cwd());
  const configAbsPath = path.isAbsolute(configPath)
    ? configPath
    : path.join(cwd, configPath);
  let resolvedConfigPath: string;
  try {
    resolvedConfigPath = fs.realpathSync(configAbsPath);
  } catch {
    resolvedConfigPath = configAbsPath;
  }
  if (resolvedConfigPath !== cwd && !resolvedConfigPath.startsWith(cwd + path.sep)) {
    core.warning(`\`config_path\` resolved outside workspace — using defaults`);
  }
  const effectiveConfigPath = (resolvedConfigPath === cwd || resolvedConfigPath.startsWith(cwd + path.sep))
    ? resolvedConfigPath
    : path.join(cwd, '.manki.yml');
  // The contents API takes a repo-relative path, so `./`, absolute and outside paths are normalised first.
  const repoRelative = path.relative(cwd, configAbsPath);
  const repoConfigPath = repoRelative.startsWith('..') || path.isAbsolute(repoRelative) ? '.manki.yml' : repoRelative.split(path.sep).join('/');
  try {
    // A dispatched run checks out the default branch or nothing, so the PR's config comes from the API.
    const rawConfig = isDispatchedRun()
      ? loadConfig(await readConfigFile(octokit, owner, repo, commitSha, repoConfigPath) ?? undefined, repoConfigPath)
      : loadConfigFromFile(effectiveConfigPath);
    const isFork = headRepoFullName !== undefined && headRepoFullName !== `${owner}/${repo}`;
    const headConfig = isFork ? sanitizeForkConfig(rawConfig) : rawConfig;
    const base = await loadBaseReviewConfig(octokit, owner, repo, baseRef, repoConfigPath);
    const { config, source } = applyBaseReviewConfig(headConfig, base);
    return { config, reviewSource: source };
  } catch (error) {
    const reason = failureReason(error);
    core.setFailed(reason);
    await postConfigErrorComment(octokit, owner, repo, prNumber, reason);
    return undefined;
  }
}

/** Reads the `review` block from the base branch. A base config that cannot be fetched gives the built-ins. */
async function loadBaseReviewConfig(octokit: Octokit, owner: string, repo: string, baseRef: string, configPath: string): Promise<BaseReviewConfig> {
  let content: string | null;
  try {
    content = await readConfigFile(octokit, owner, repo, baseRef, configPath);
  } catch (error) {
    core.warning(`Could not read ${configPath} on the base branch, using the built-in review groups: ${error instanceof Error ? error.message : String(error)}`);
    return { source: 'base_unreadable' };
  }
  return loadReviewConfig(content, configPath);
}

/** Whether the run stops before posting a progress comment: another run holds the PR, the commit is reviewed or stale, or nothing changed. */
async function skipsRound(target: RunTarget, config: ReviewConfig, trigger: RoundTrigger, { forceReview, settings = NO_SETTINGS, draft }: FullReviewOptions): Promise<boolean> {
  const { octokit, bot, owner, repo, prNumber, commitSha, baseRef } = target;

  // Scan for a competing in-progress marker before posting our own to shorten
  // the race window. A residual window remains when two runs both pass this scan
  // before either posts; tracking issue for the strict atomic fix: https://github.com/manki-review/manki/issues/798
  if (await checkConcurrentSubmissionLock(octokit, bot, owner, repo, prNumber, config, commitSha)) {
    core.warning('Defense-in-depth lock engaged — this run will not post a review. If no review appears on the PR, re-trigger with `/manki review`.');
    return true;
  }

  // Sibling head-SHA dedupe: serialized siblings (e.g., `pull_request_review`
  // and `pull_request_review_comment` fan-out from one human review) can both
  // pass the in-progress scan when the prior run's marker has already been
  // cleared. The state-based check on the bot's posted reviews catches that.
  // Honors `forceReview`, so a box tick still reviews the same SHA again.
  if (!forceReview && await hasBotReviewOnCommit(octokit, bot, owner, repo, prNumber, commitSha)) {
    core.warning(`Bot already posted a non-DISMISSED review on commit ${commitSha.slice(0, 7)} — bailing serialized sibling run.`);
    await showAlreadyReviewed(octokit, bot, owner, repo, prNumber, commitSha, settings, draft);
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

  if (trigger.event === 'pull_request:synchronize' && config.auto_review) {
    const standing = await findUnchangedVerdict(octokit, bot, owner, repo, prNumber, baseRef, commitSha, config.exclude_paths);
    if (standing) {
      const shortSha = standing.commitSha.slice(0, 7);
      assertWritesAllowed();
      try {
        const approved = standing.verdict === 'APPROVE';
        const held = approved && await holdApproval(octokit, bot, owner, repo, prNumber, commitSha, draft);
        const summary = `No change to this PR since the reviewed commit \`${shortSha}\`. The previous verdict stands.`;
        // A push can dismiss approvals, so the approval is posted again on the new head.
        if (approved && !held) {
          await octokit.rest.pulls.createReview({
            owner, repo, pull_number: prNumber, commit_id: commitSha, event: 'APPROVE',
            body: withMarkers(`${APPROVED_LINE} ${summary}`, PROGRESS_MARKER),
          });
          await retireStaleNotices(octokit, bot, owner, repo, prNumber, commitSha);
        }
        core.info(`Round SKIPPED: no change since reviewed commit ${shortSha}, ${standing.verdict} stands`);
        await showRunStatus(octokit, bot, owner, repo, prNumber, settings, {
          head: commitSha, draft: !!draft, status: 'up to date', text: summary, lastReviewed: standing.commitSha,
        });
        await completeReviewCheck(await startReviewCheck(octokit, owner, repo, commitSha), outcomeReport(STANDING_OUTCOMES[standing.verdict], summary, held));
        return true;
      } catch (error) {
        core.warning(`Could not post the previous approval again, reviewing in full: ${error instanceof Error ? error.message : error}`);
      }
    }
  }
  return false;
}

/**
 * Reads the prior rounds and threads, reopens security threads the author resolved, and records the ones a repo admin author cleared.
 * Returns `undefined` when `auto_review` is off for a push.
 */
async function loadRecap(
  target: RunTarget, config: ReviewConfig, progress: RunProgress, { prAuthorLogin, settings }: FullReviewOptions,
): Promise<RecapState | undefined> {
  const { octokit, bot, owner, repo, prNumber } = target;
  const recap = await fetchRecapState(octokit, bot, owner, repo, prNumber, prAuthorLogin);

  if (github.context.eventName === 'pull_request' && !config.auto_review) {
    core.info('auto_review is disabled — skipping');
    await dropProgressComment(target, progress, settings, 'automatic review off', 'Automatic review is off for this repository (`auto_review: false`).');
    return undefined;
  }
  if (progress.settings) progress.settings.lastReviewed = recap.priorRounds.at(-1)?.meta.commitSha ?? progress.settings.lastReviewed;

  await reopenAuthorResolvedThreads(octokit, recap.previousFindings, pauseState(recap, config).paused);
  await announceSecurityOverrides(octokit, securityOverridesIn(recap.previousFindings).filter(o => !o.announced));
  return recap;
}

/** Builds one LLM client per stage, plus each stage's refusal fallback. Throws on a model spec or credentials that do not resolve. */
function buildReviewClients(config: ReviewConfig, providerInputs: ProviderInputs): { clients: ReviewClients; models: ReviewModels } {
  const models: ReviewModels = {
    planner: resolveModel(config, 'planner'),
    reviewer: resolveModel(config, 'reviewer'),
    reviewerPair: resolvePairModel(config),
    judge: resolveModel(config, 'judge'),
    dedup: resolveModel(config, 'dedup'),
  };
  core.info(`Models — planner: ${models.planner}, reviewer: ${models.reviewer}, reviewer pair: ${models.reviewerPair}, judge: ${models.judge}, dedup: ${models.dedup}`);

  const buildClient = (model: string) => {
    const spec = parseModelSpec(model);
    const auth = buildAuthForProvider(spec.provider, providerInputs);
    return createLLMClient(spec.provider, spec.model, auth);
  };
  const reviewer = buildClient(models.reviewer);
  const reviewerByModel = new Map<string, LLMClient>([[models.reviewer, reviewer]]);
  for (const model of teamModels(config)) {
    if (!reviewerByModel.has(model)) reviewerByModel.set(model, buildClient(model));
  }
  const judge = buildClient(models.judge);
  const planner = config.planner?.enabled !== false ? buildClient(models.planner) : undefined;
  const dedup = buildClient(models.dedup);
  const fallbackClients = new Map<string, LLMClient>([...reviewerByModel, [models.judge, judge]]);
  const fallbackFor = (stageModel: string) => {
    const model = resolveFallbackModel(config, stageModel);
    if (!model) return undefined;
    if (!fallbackClients.has(model)) fallbackClients.set(model, buildClient(model));
    return { model, client: fallbackClients.get(model)! };
  };
  const fallbacks: NonNullable<ReviewClients['fallbacks']> = {
    ...(planner && { planner: fallbackFor(models.planner) }),
    reviewerByModel: new Map([...reviewerByModel.keys()].flatMap((model) => {
      const fallback = fallbackFor(model);
      return fallback ? [[model, fallback] as const] : [];
    })),
    judge: fallbackFor(models.judge),
    dedup: fallbackFor(models.dedup),
  };
  return { clients: { reviewer, reviewerByModel, judge, planner, dedup, fallbacks }, models };
}

async function collectDiff(target: RunTarget, config: ReviewConfig) {
  const { octokit, owner, repo, prNumber } = target;
  const fullDiff = parsePRDiff(await fetchPRDiff(octokit, owner, repo, prNumber));
  const { diff, excluded: excludedFiles } = filterDiff(fullDiff, config.exclude_paths);
  return { fullDiff, diff, excludedFiles, rawDiff: rebuildRawDiff(diff) };
}

function initialDashboard(diff: ParsedDiff, config: ReviewConfig, plannerEnabled: boolean, deeper?: boolean): DashboardData {
  // Without a planner the team is the fail-safe one. With one, `runReview` reports the team after triage.
  const previewTeam = selectTeam(diff, config, undefined, deeper);
  const lineCount = diff.totalAdditions + diff.totalDeletions;
  return plannerEnabled
    ? {
        phase: 'planning',
        lineCount,
        agentCount: 0,
      }
    : {
        phase: 'started',
        lineCount,
        agentCount: previewTeam.finders.length,
        agentProgress: previewTeam.finders.map(a => ({ name: a.name, status: 'reviewing' as const })),
        routing: previewTeam.routing,
      };
}

/**
 * Dismisses the reviews `reviewId` replaces. Throws `SupersededError` instead when the head moved since,
 * so a review of an old commit never lifts the merge block on a new one. Past that check the round is final,
 * so a later push no longer stops it.
 */
async function replacePreviousReviews(target: RunTarget, progress: RunProgress, reviewId: number): Promise<void> {
  const { octokit, owner, repo, prNumber, commitSha } = target;
  progress.reviewPosted = true;
  await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
  progress.stopHeadWatch();
  await dismissPreviousReviews(octokit, owner, repo, prNumber, reviewId);
}

/** Posts a verdict for a diff no reviewer reads, replaces the previous review and marks the progress comment complete. Returns the report for the PR check. */
async function postUnreviewedRound(
  target: RunTarget, progress: RunProgress, commentId: number, dashboard: DashboardData, diff: ParsedDiff,
  verdict: 'APPROVE' | 'COMMENT', summary: string, metadata: ReviewMetadata,
): Promise<CheckReport> {
  const { octokit, bot, owner, repo, prNumber, commitSha } = target;
  await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
  const result = { verdict, summary, findings: [], highlights: [], reviewComplete: true, agentNames: [] as string[] };
  const { id: reviewId, approvalHeld } = await postReview(octokit, owner, repo, prNumber, commitSha, result, diff);
  await replacePreviousReviews(target, progress, reviewId);
  await updateProgressComment(octokit, owner, repo, commentId, dashboard, metadata, undefined, progressSettings(target, progress, 'up to date', { reviewed: true }));
  await retireStaleNotices(octokit, bot, owner, repo, prNumber, commitSha);
  // A diff no reviewer read must not pass a required check, so it waits for a person.
  return verdict === 'APPROVE' ? outcomeReport('READY', summary, approvalHeld) : { conclusion: 'action_required', title: 'Not reviewed', summary };
}

/**
 * Eagerly install any provider CLI before the planner timer starts. The
 * fallback `npm install -g` inside `ensureCLI` takes around 30s on a
 * cold runner and would otherwise race the planner's own 30s timeout.
 * Warming up once here pays the cost before any per-call deadline runs.
 * Deduplicate by client instance so roles that share a client don't
 * serialize redundant install retries on failure.
 */
function fallbackClientsOf({ fallbacks }: ReviewClients): LLMClient[] {
  if (!fallbacks) return [];
  return [fallbacks.planner, ...(fallbacks.reviewerByModel?.values() ?? []), fallbacks.judge, fallbacks.dedup].flatMap(f => f ? [f.client] : []);
}

async function warmUpClients(clients: ReviewClients): Promise<void> {
  const warmupTargets = new Set<LLMClient>(
    [clients.planner, ...(clients.reviewerByModel?.values() ?? []), clients.judge, clients.dedup, ...fallbackClientsOf(clients)].filter(
      (c): c is LLMClient => !!c,
    ),
  );
  await Promise.allSettled(
    [...warmupTargets].map((c) =>
      c.warmupCLI
        ? c.warmupCLI().catch((error) =>
            core.warning(
              sanitizeLogOutput(
                `Provider CLI warmup failed (${c.constructor.name}): ${error instanceof Error ? error.message : error}`,
              ),
            ),
          )
        : Promise.resolve(),
    ),
  );
}

async function loadRunMemory(
  config: ReviewConfig, appMemory: AppMemory | undefined, owner: string, repo: string,
): Promise<{ memory: RepoMemory | null; memoryLoadStatus: MemoryLoadStatus; memoryLoadError?: string }> {
  if (!config.memory?.enabled) {
    return { memory: null, memoryLoadStatus: 'disabled' };
  }
  const memoryRepo = resolveMemoryRepo(config.memory, owner);
  const memoryToken = await getMemoryToken(appMemory, memoryRepo);
  if (!memoryToken) {
    return { memory: null, memoryLoadStatus: 'no_token' };
  }
  const memoryOctokit = github.getOctokit(memoryToken);
  try {
    const memory = await loadMemory(memoryOctokit, memoryRepo, repo);
    core.info(`Loaded memory: ${memory.learnings.length} learnings, ${memory.suppressions.length} suppressions`);
    return { memory, memoryLoadStatus: 'loaded' };
  } catch (error) {
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
 * approvals, since no reviewer read the new code. Posts no review, so a request for changes stays. `offerForce`
 * offers Force review in the settings block.
 */
async function postTooBigNotice(target: RunTarget, progress: RunProgress, text: string, offerForce: boolean, lastRoundAt?: string): Promise<CheckReport> {
  const { octokit, owner, repo, prNumber } = target;
  await dismissPreviousReviews(octokit, owner, repo, prNumber, undefined, 'APPROVED');
  const offered = progressSettings(target, progress, offerForce ? 'too big for automatic review' : 'too big to review', { boxes: ['force'] });
  // Above the hard limit no box can review the PR, so only Pause stays.
  const settings = offered && (offerForce ? offered : { ...offered, boxes: new Set<SettingsBox>(['pause']) });
  const body = withSettingsBlock(withMarkers(text, PROGRESS_MARKER, REVIEW_COMPLETE_MARKER, TOO_BIG_MARKER), settings);
  await replaceWithNotice(target, progress, TOO_BIG_MARKER, body, lastRoundAt);
  // A diff no reviewer read must not pass a required check, so it waits for a person.
  return { conclusion: 'action_required', title: 'Not reviewed', summary: text };
}

/**
 * Replaces the progress comment with a notice that automatic review is paused, listing the blocking threads still open.
 * Each push during the same pause updates the notice from after `lastRoundAt` instead of adding another.
 * The notice's settings block offers Force review.
 */
async function postPauseNotice(
  target: RunTarget, progress: RunProgress, { capReached, capRounds, reason }: PauseState, maxAutoRounds: number,
  previousFindings: PreviousFinding[], lastRoundAt?: string,
): Promise<CheckReport> {
  core.info(capReached
    ? `Round cap reached (${capRounds} rounds with new changes since the last approval >= max ${maxAutoRounds}) — skipping auto review`
    : 'Last round did not converge — skipping auto review');
  const settings = progressSettings(target, progress, 'automatic review paused', { boxes: ['force'] });
  const blockers = formatOpenBlockers(previousFindings);
  const body = withSettingsBlock(
    withMarkers(`${reason} Automatic review is paused.${blockers ? `\n\n${blockers}` : ''}`, PROGRESS_MARKER, REVIEW_COMPLETE_MARKER, PAUSE_NOTICE_MARKER),
    settings,
  );
  await replaceWithNotice(target, progress, PAUSE_NOTICE_MARKER, body, lastRoundAt);
  return { conclusion: 'action_required', title: 'Automatic review paused', summary: `${reason} Automatic review is paused until someone asks for another round.` };
}

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
      && !c.body.includes('- [x] Force review') && Date.parse(c.updated_at) > since);
  } catch (error) {
    core.warning(`Failed to look up an earlier notice: ${error}`);
    return undefined;
  }
}

/** Collects the open review threads with the code now at each, and the contents of the files the review reads. */
async function collectOpenThreads(
  target: RunTarget, recap: RecapState, diff: ParsedDiff,
): Promise<{ openThreads: OpenThread[]; fileContents?: Map<string, string> }> {
  const { octokit, owner, repo, commitSha } = target;
  const baseOpenThreads = recap.previousFindings
    .filter((f): f is PreviousFinding & { threadId: string } =>
      (f.status === 'open' || f.status === 'replied') && f.threadId != null && f.threadId !== '')
    .map(f => ({
      threadId: f.threadId,
      threadUrl: f.threadUrl,
      title: f.title,
      file: f.file,
      line: f.line,
      severity: f.severity,
      description: f.description,
      suggestedFix: f.suggestedFix,
    }));

  // Fetch full file contents for changed files so reviewers have surrounding context.
  // Also fetch each open thread's file (if missing from changed files) so the judge
  // can see the current code at the flagged region when deciding whether the
  // thread is addressed.
  const changedFilePaths = diff.files
    .filter(f => f.changeType !== 'deleted')
    .map(f => f.path);
  const threadFilePaths = baseOpenThreads.map(t => t.file).filter(p => !changedFilePaths.includes(p));
  const filePaths = [...changedFilePaths, ...threadFilePaths];
  let fileContents: Map<string, string> | undefined;
  try {
    fileContents = await fetchFileContents(octokit, owner, repo, commitSha, filePaths);
  } catch (error) {
    core.warning(`Failed to fetch file contents: ${error}`);
  }

  const openThreads = baseOpenThreads.map(t => ({
    ...t,
    currentCode: extractCurrentCodeWindow(fileContents, t.file, t.line),
  }));
  return { openThreads, fileContents };
}

/**
 * Fetches the diff since the last reviewed commit, the PR's change at that commit, the issues the PR body links,
 * and the static analysis results.
 */
async function collectRoundSignals(
  target: RunTarget, config: ReviewConfig, recap: RecapState, diff: ParsedDiff, fullDiff: ParsedDiff, configPath: string, prBody?: string,
): Promise<{ interRoundDiff?: string; priorChange?: ParsedDiff; linkedIssues?: LinkedIssue[]; staticSignals: StaticSignal[]; staticAnalysis?: RoundStaticAnalysis }> {
  const { octokit, owner, repo, prNumber, commitSha, baseRef } = target;
  // Fetch inter-round diff (prior round commit -> current head) so the judge
  // can ground per-thread resolution in actual changes since last review.
  let interRoundDiff: string | undefined;
  const lastPriorSha = recap.priorRounds.at(-1)?.meta.commitSha;
  const shouldFetchDiff = !!(lastPriorSha && lastPriorSha !== commitSha);

  // Read with the workflow token, which carries the `checks` and `security-events` permissions the workflow grants.
  const staticSignalsPromise = collectStaticSignals(await workflowOctokit(), {
    owner, repo, prNumber, headSha: commitSha, baseRef, configPath, diff, fullDiff,
  });

  let linkedIssues;
  const diffPromise: Promise<string | undefined> = shouldFetchDiff && lastPriorSha
    ? fetchInterRoundDiff(octokit, owner, repo, lastPriorSha, commitSha)
      .then(raw => filterRawDiff(raw, config.exclude_paths))
    : Promise.resolve(undefined);
  // The base branch diffed against the prior commit gives the PR's own change then, without what a rebase brought in.
  const priorChangePromise: Promise<ParsedDiff | undefined> = !lastPriorSha || lastPriorSha === commitSha
    ? Promise.resolve(lastPriorSha ? diff : undefined)
    : fetchInterRoundDiff(octokit, owner, repo, baseRef, lastPriorSha)
      .then(raw => filterDiff(parsePRDiff(raw), config.exclude_paths).diff);
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
    if (diffResult.status === 'fulfilled') {
      interRoundDiff = diffResult.value;
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
  return { interRoundDiff, priorChange, linkedIssues, staticSignals, staticAnalysis };
}

/**
 * Fetches the PR head for the finders and the judge when the client of any has repository tools. Returns `undefined`
 * when none has them, or when the fetch fails, and the round then runs without tools.
 */
async function fetchReviewWorkspace({ octokit, owner, repo, commitSha }: RunTarget, clients: ReviewClients): Promise<string | undefined> {
  if (![clients.reviewer, clients.judge, ...(clients.reviewerByModel?.values() ?? [])].some(client => client.repoTools)) return undefined;
  try {
    const { token } = await octokit.auth() as { token?: string };
    return await fetchWorkspace(`${github.context.serverUrl}/${owner}/${repo}.git`, commitSha, token);
  } catch (error) {
    core.warning(`Could not fetch the PR head for the reviewer tools, so the reviewers run without them: ${sanitizeTokens(String(error))}`);
    return undefined;
  }
}

/** Runs the review pipeline and mirrors its progress on the dashboard in the progress comment. */
async function reviewRound(
  run: ReviewRun, clients: ReviewClients, inputs: Omit<ReviewOptions, 'onProgress'>,
): Promise<ReviewStageResult> {
  const { octokit, owner, repo, commitSha, commentId, dashboard, progress } = run;
  let reviewEndTime = run.parseEndTime;

  function scheduleDashboardFlush(): void {
    if (progress.flushTimer) clearTimeout(progress.flushTimer);
    progress.flushTimer = setTimeout(() => {
      progress.flushTimer = null;
      updateProgressDashboard(octokit, owner, repo, commentId, dashboard, commitSha, runningSettings(run, progress))
        .catch(err => core.warning(`Failed to update dashboard: ${err}`));
    }, 500);
  }

  const result = await runReview(clients, {
    ...inputs,
    onProgress: (event) => {
      if (event.phase === 'planning') {
        core.info('Planner analyzing PR content...');
        if (event.teamAgentNames) {
          if (event.plannerResult && event.reviewerEffort) {
            dashboard.plannerInfo = {
              agentCount: event.teamAgentNames.length,
              reviewerEffort: event.reviewerEffort,
              judgeEffort: event.plannerResult.judgeEffort,
              prType: event.plannerResult.prType,
            };
          }
          dashboard.agentCount = event.teamAgentNames.length;
          dashboard.agentProgress = event.teamAgentNames.map(name => ({ name, status: 'reviewing' as const }));
          dashboard.routing = event.routing;
          dashboard.plannerDurationMs = event.plannerDurationMs;
          if (event.heuristicFallback) dashboard.heuristicFallback = true;
          dashboard.phase = 'started';
          scheduleDashboardFlush();
        }
      } else if (event.phase === 'agent-complete') {
        if (dashboard.agentProgress && event.agentName) {
          const entry = dashboard.agentProgress.find(a => a.name === event.agentName);
          if (entry) {
            if (event.agentStatus === 'retrying') {
              entry.status = 'retrying';
              entry.retryCount = event.retryCount;
            } else {
              entry.status = event.agentStatus === 'failure' ? 'failed' : 'done';
              entry.findingCount = event.agentFindingCount;
              entry.durationMs = event.agentDurationMs;
              if (event.agentStatus === 'failure' && event.retryCount) {
                entry.retryCount = event.retryCount;
              }
            }
          }
        }
        scheduleDashboardFlush();
      } else if (event.phase === 'reviewed') {
        cancelDashboardFlush(progress);
        reviewEndTime = Date.now();
        dashboard.phase = 'reviewed';
        dashboard.rawFindingCount = event.rawFindingCount;
        updateProgressDashboard(octokit, owner, repo, commentId, dashboard, commitSha, runningSettings(run, progress))
          .catch(err => core.warning(`Failed to update dashboard: ${err}`));
      } else if (event.phase === 'judging') {
        cancelDashboardFlush(progress);
        dashboard.phase = 'reviewed';
        dashboard.rawFindingCount = event.rawFindingCount;
        dashboard.judgeInputCount = event.judgeInputCount;
        dashboard.suppressionCount = event.suppressionCount;
        dashboard.staticDedupCount = event.staticDedupCount;
        dashboard.llmDedupCount = event.llmDedupCount;
        updateProgressDashboard(octokit, owner, repo, commentId, dashboard, commitSha, runningSettings(run, progress))
          .catch(err => core.warning(`Failed to update dashboard: ${err}`));
      }
    },
  });
  return { result, reviewEndTime, judgeEndTime: Date.now() };
}

/** Fails the run and posts the incomplete round as a COMMENT, so the previous review stays standing. Returns the report for the PR check. */
async function postIncompleteRound(run: ReviewRun, result: ReviewResult): Promise<CheckReport> {
  const { octokit, owner, repo, prNumber, commitSha, commentId, dashboard, diff } = run;
  await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
  cancelDashboardFlush(run.progress);
  core.setFailed(`Review incomplete: ${failureReason(result.summary)}`);
  result.verdict = 'COMMENT';
  await postReview(octokit, owner, repo, prNumber, commitSha, result, diff);
  dashboard.phase = 'complete';
  await updateProgressComment(octokit, owner, repo, commentId, dashboard, undefined, commitSha, progressSettings(run, run.progress, 'review incomplete'));
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

/** Replies `Fixed in <sha>.` in each thread the round resolved. */
async function replyFixedThreads(run: ReviewRun, threads: OpenThread[]): Promise<void> {
  for (const { threadId } of threads) {
    try {
      await replyToReviewThread(run.octokit, threadId, `Fixed in ${run.commitSha.slice(0, 7)}.`);
    } catch (error) {
      core.warning(`Failed to reply on resolved thread ${threadId}: ${error}`);
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
  const blocking = threads.filter(t => t.severity === 'blocker' || t.severity === 'unknown');
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

/** Posts the round's review and dismisses the previous one. Returns the new review's id, and whether its approval was held. */
async function postRound(run: ReviewRun, result: ReviewResult, context: RoundContext, reviewTimeMs: number): Promise<{ id: number; approvalHeld: ApprovalHeld }> {
  const { octokit, owner, repo, prNumber, commitSha, diff, recap } = run;
  const posted = await postReview(octokit, owner, repo, prNumber, commitSha, result, diff, context, reviewTimeMs, {
    existingThreads: recap.previousFindings,
    draft: run.options.draft,
  });
  await replacePreviousReviews(run, run.progress, posted.id);
  return posted;
}

function metadataConfig(config: ReviewConfig, models: ReviewModels, triage: string, teamAgents: string[]): ReviewMetadata['config'] {
  return {
    reviewerModel: models.reviewer,
    judgeModel: models.judge,
    triage,
    teamAgents,
    memoryEnabled: config.memory?.enabled ?? false,
    memoryRepo: config.memory?.repo ?? '',
  };
}

/** Marks the progress comment complete with the judge's decisions and the round's timing. */
async function completeProgressComment(run: ReviewRun, stage: ReviewStageResult): Promise<void> {
  const { octokit, owner, repo, commentId, dashboard, config, models, startTime, parseEndTime } = run;
  const { result, reviewEndTime, judgeEndTime } = stage;

  // Reconcile the dashboard with the actual resolved team. Agents may fail
  // and drop out, so reconcile unconditionally to keep agentCount and
  // agentProgress accurate.
  reconcileDashboardAgents(dashboard, result.agentNames);

  const reviewerEffort = result.agentEffortMap?.values().next().value;
  if (result.plannerResult && reviewerEffort) {
    dashboard.plannerInfo = {
      agentCount: result.agentNames.length,
      reviewerEffort,
      judgeEffort: result.plannerResult.judgeEffort,
      prType: result.plannerResult.prType,
    };
  }

  const allJudgedForDashboard = result.allJudgedFindings || result.findings;
  const rawForLookup = result.rawFindings ?? allJudgedForDashboard;
  const judgeDecisions = allJudgedForDashboard.map(f => {
    const kept = f.severity !== 'ignore';
    const originalSeverity = kept
      ? f.severity
      : rawForLookup.find(r => r.title === f.title && r.file === f.file && r.line === f.line)?.severity ?? f.severity;
    return {
      title: f.title,
      severity: f.severity,
      reasoning: f.judgeNotes || '',
      confidence: f.judgeConfidence || 'medium',
      kept,
      originalSeverity,
    };
  });

  const keptSeverities: Record<string, number> = {};
  const droppedSeverities: Record<string, number> = {};
  const keptSet = new Set(result.findings);
  for (const f of result.findings) {
    keptSeverities[f.severity] = (keptSeverities[f.severity] ?? 0) + 1;
  }
  // judgeDecisions is built in lock-step with allJudgedForDashboard, so the
  // index aligns and d.originalSeverity carries the pre-judge severity even
  // when the judge merged or renamed the finding before dropping it.
  allJudgedForDashboard.forEach((f, i) => {
    if (!keptSet.has(f)) {
      const sev = judgeDecisions[i].originalSeverity;
      droppedSeverities[sev] = (droppedSeverities[sev] ?? 0) + 1;
    }
  });

  const judgeDroppedCount = allJudgedForDashboard.length - keptSet.size;
  const disproved = allJudgedForDashboard.flatMap(({ title, file, line, severity, refutation }) => refutation?.outcome === 'disproved' && severity === 'ignore' ? [{ title, file, line, reason: refutation.reason }] : []);
  const completeDashboard: DashboardData = {
    ...dashboard,
    phase: 'complete',
    ...(result.routing && { routing: result.routing }),
    keptCount: result.findings.length,
    droppedCount: judgeDroppedCount,
    keptSeverities,
    droppedSeverities,
    ...(result.testNitSuppressedCount != null && result.testNitSuppressedCount > 0 && { testNitSuppressedCount: result.testNitSuppressedCount }),
    ...(result.openLeads && { unfinishedChecks: result.openLeads.map(({ title, file, line }) => ({ title, file, line })) }),
    ...(disproved.length > 0 && { disproved }),
    judgeDurationMs: judgeEndTime - reviewEndTime,
  };

  const timing = {
    parseMs: parseEndTime - startTime,
    reviewMs: reviewEndTime - parseEndTime,
    judgeMs: judgeEndTime - reviewEndTime,
    totalMs: judgeEndTime - startTime,
  };

  const triage = result.triage
    ? `trivial=${result.triage.trivial}, subtle=${result.triage.subtle}, paired=${result.triage.paired} (${result.plannerSource ?? 'planner'}${result.sensitivePaths ? ', security-sensitive paths' : ''}${result.ciOrDependencyPaths ? ', CI or dependency paths' : ''})`
    : 'none';
  const metadata: ReviewMetadata = {
    config: metadataConfig(config, models, triage, result.agentNames),
    judgeDecisions,
    timing,
  };

  await updateProgressComment(octokit, owner, repo, commentId, completeDashboard, metadata, undefined, progressSettings(run, run.progress, 'up to date', { reviewed: true }));
}

function setReviewOutputs(reviewId: number, context: RoundContext, result: ReviewResult): void {
  const flatAliases = roundContextToFlatAliases(context);
  const severityMap = context.findings.severityCounts;
  core.setOutput('review_id', reviewId.toString());
  core.setOutput('verdict', flatAliases.verdict);
  core.setOutput('findings_count', flatAliases.findingsKept.toString());
  core.setOutput('findings_json', JSON.stringify(result.findings));

  // `result.findings` excludes 'ignore' severity (filtered in review.ts), so
  // the counts here mirror `severityMap` above and the legacy `severity` alias.
  core.setOutput('severity_counts', JSON.stringify(flatAliases.severity));

  core.setOutput('judge_model', flatAliases.judgeModel);

  core.info(`Review complete: ${result.verdict} with ${flatAliases.findingsKept} findings`);
  core.info(`Severity breakdown: ${severityMap.blocker} blocker, ${severityMap.warning} warning, ${severityMap.suggestion} suggestion, ${severityMap.nitpick} nitpick`);
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
  const { prAuthorLogin, forceReview, skipCap, trigger = buildRoundTrigger(), headRepoFullName } = options;
  core.info(`Starting review for ${owner}/${repo}#${prNumber}`);

  const providerInputs = readProviderInputs();

  if (!hasAnyProviderCredentials(providerInputs)) {
    core.setFailed('No API key configured — set claude_code_oauth_token, anthropic_api_key, openai_oauth_token, openai_api_key, gemini_oauth_token, or gemini_api_key');
    return;
  }

  const startTime = Date.now();
  const configPath = core.getInput('config_path') || '.manki.yml';
  const { octokit, bot, identity, appMemory } = await getAuth();
  const target: RunTarget = { octokit, bot, owner, repo, prNumber, commitSha, baseRef };

  if (identity === 'actions') {
    try {
      await postAppWarningIfNeeded(octokit, bot, owner, repo, prNumber);
    } catch (error) {
      core.warning(`Failed to post app warning: ${error}`);
    }
  }

  const headMoved = new AbortController();
  const stop = stopWritesOn(headMoved.signal);
  const progress: RunProgress = { flushTimer: null, reviewPosted: false, stopHeadWatch: watchHead(target, headMoved) };
  let check: ReviewCheck | undefined;
  // Stays unset when the run is cancelled, so the post step reports the check cancelled.
  let checkReport: CheckReport | undefined;

  try {
    const loaded = await loadRunConfig(target, configPath, headRepoFullName);
    if (!loaded) return;
    const { config, reviewSource } = loaded;
    const skipRule = !forceReview && options.skipFacts ? matchSkipRule(config, options.skipFacts) : undefined;
    if (skipRule) {
      core.info(`Skipping review: the PR matches the skip rule for ${skipRule}`);
      check = await startReviewCheck(octokit, owner, repo, commitSha);
      checkReport = { conclusion: 'skipped', title: 'Review skipped', summary: `This PR matches the skip rule for ${skipRule} in \`${configPath}\` on the base branch.` };
      return;
    }
    if (await skipsRound(target, config, trigger, options)) return;

    const commentId = await postRunProgress(target, progress, options);
    progress.commentId = commentId;

    const recap = await loadRecap(target, config, progress, options);
    if (!recap) return;
    check = await startReviewCheck(octokit, owner, repo, commitSha);

    let built: ReturnType<typeof buildReviewClients>;
    try {
      built = buildReviewClients(config, providerInputs);
    } catch (error) {
      const reason = `Invalid model config: ${error instanceof Error ? error.message : error}`;
      core.setFailed(reason);
      checkReport = failedReport(reason);
      await dropProgressComment(target, progress, options.settings, 'review failed', `Review failed: ${reason}`);
      return;
    }
    const { clients, models } = built;

    const { fullDiff, diff, excludedFiles, rawDiff } = await collectDiff(target, config);
    const parseEndTime = Date.now();
    const lineCount = diff.totalAdditions + diff.totalDeletions;
    const dashboard = initialDashboard(diff, config, !!clients.planner, options.deeper);
    await updateProgressDashboard(octokit, owner, repo, commentId, dashboard, commitSha, runningSettings(target, progress));
    const unreviewedMetadata = (): ReviewMetadata => ({
      config: metadataConfig(config, models, 'none', []),
      judgeDecisions: [],
      timing: { parseMs: parseEndTime - startTime, reviewMs: 0, judgeMs: 0, totalMs: Date.now() - startTime },
    });

    const autoLimit = Math.min(config.auto_review_max_lines ?? config.max_diff_lines, config.max_diff_lines);
    const shortSha = commitSha.slice(0, 7);
    if (lineCount > config.max_diff_lines) {
      core.warning(`Diff too large (${lineCount} reviewable lines > ${config.max_diff_lines} max)`);
      checkReport = await postTooBigNotice(target, progress, `**Too big to review** at \`${shortSha}\`: this PR has ${lineCount} reviewable lines, above the limit of ${config.max_diff_lines} that Manki reviews. Split it into smaller PRs to get a review.`, false, recap.priorRounds.at(-1)?.meta.timestamp);
      return;
    }
    if (lineCount > autoLimit && !forceReview && !skipCap) {
      core.info(`No automatic review: ${lineCount} reviewable lines > ${autoLimit}`);
      checkReport = await postTooBigNotice(target, progress, `**Too big for automatic review** at \`${shortSha}\`: this PR has ${lineCount} reviewable lines, above the limit of ${autoLimit} for automatic review. Split it into smaller PRs, or tick Force review to review it in full.`, true, recap.priorRounds.at(-1)?.meta.timestamp);
      return;
    }

    core.info(`Reviewing ${diff.files.length} files (${fullDiff.files.length} total, ${excludedFiles.length} filtered out)`);

    if (diff.files.length === 0) {
      core.info('No reviewable files in diff');
      checkReport = await postUnreviewedRound(target, progress, commentId, dashboard, diff, 'APPROVE', 'No reviewable files in this PR (all filtered out by config).',
        unreviewedMetadata());
      return;
    }

    // Placed after the diff-size and empty-files guards so cold installs are skipped on paths that never invoke an LLM.
    await warmUpClients(clients);

    const repoContext = await fetchRepoContext(target.octokit, target.owner, target.repo, target.baseRef, diff.files.map(f => f.path));
    const { memory, memoryLoadStatus, memoryLoadError } = await loadRunMemory(config, appMemory, owner, repo);

    const priorRoundCount = recap.priorRounds.length;
    const maxAutoRounds = config.convergence?.max_auto_rounds ?? 0;
    const pause = pauseState(recap, config);
    const { capRounds, paused } = pause;
    if (paused && !skipCap && !forceReview) {
      checkReport = await postPauseNotice(target, progress, pause, maxAutoRounds, recap.previousFindings, recap.priorRounds.at(-1)?.meta.timestamp);
      return;
    }
    const countsTowardCap = !options.draft && isNewChange({ commitSha, changeDigest: changeDigest(diff, config.exclude_paths) }, recap.priorRounds.at(-1));

    const { openThreads, fileContents } = await collectOpenThreads(target, recap, diff);
    const [{ interRoundDiff, priorChange, linkedIssues, staticSignals, staticAnalysis }, workspace] = await Promise.all([
      collectRoundSignals(target, config, recap, diff, fullDiff, configPath, prContext?.body),
      fetchReviewWorkspace(target, clients),
    ]);

    const run: ReviewRun = {
      ...target, options, trigger, config, reviewSource, models, plannerEnabled: !!clients.planner,
      recap, priorRoundCount, maxAutoRounds,
      diff, excludedFiles, openThreads, interRoundDiff, memoryLoadStatus, memoryLoadError, staticAnalysis,
      commentId, dashboard, progress, startTime, parseEndTime,
    };

    const stage = await reviewRound(run, clients, {
      checkpoint: async () => {
        stop.signal.throwIfAborted();
        await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
      },
      signal: stop.signal,
      config,
      diff,
      rawDiff,
      repoContext,
      memory,
      fileContents,
      prContext: prContext && staticSignals.length > 0 ? { ...prContext, staticSignals } : prContext,
      linkedIssues,
      isFollowUp: recap.previousFindings.length > 0,
      // `null` tells `determineOutcome` the open threads are unknown, so no prior can retire.
      openThreads: recap.openThreadsState === 'fetch_failed' ? null : openThreads,
      previousFindings: recap.previousFindings,
      priorRounds: recap.priorRounds,
      prAuthorLogin,
      interRoundDiff,
      headSha: commitSha,
      finalRound: !paused && countsTowardCap && maxAutoRounds > 0 && capRounds + 1 === maxAutoRounds,
      workspace,
      deeper: options.deeper,
    });
    // A model call the stop aborted can end the round incomplete, and that round must not be posted.
    stop.signal.throwIfAborted();
    const { result } = stage;

    if (!result.reviewComplete) {
      checkReport = await postIncompleteRound(run, result);
      return;
    }

    addCodeContext(result.findings, diff);
    tagFindingOrigins(result.findings, diff, options.fullReview ? undefined : priorChange, interRoundDiff ? parsePRDiff(interRoundDiff) : undefined);
    const reviewTimeMs = Date.now() - startTime;
    const buildContext = () => buildRoundContext(run, result, {
      plannerDurationMs: dashboard.plannerDurationMs,
      judgeDurationMs: stage.judgeEndTime - stage.reviewEndTime,
    });

    await assertHeadUnchanged(octokit, owner, repo, prNumber, commitSha);
    // Resolved before posting, so a thread that stays open settles the verdict of the one review the round posts.
    const resolved = await resolveAddressedThreads(run, result);
    const context = buildContext();
    let posted: Awaited<ReturnType<typeof postRound>>;
    try {
      posted = await postRound(run, result, context, reviewTimeMs);
    } catch (error) {
      // A thread is resolved only by a review that replaces the previous one.
      await reopenThreads(octokit, resolved);
      throw error;
    }
    await replyFixedThreads(run, resolved);
    await completeProgressComment(run, stage);
    const pauseLifted = !pauseState({ ...recap, priorRounds: [...recap.priorRounds, context] }, config).paused;
    await retireStaleNotices(octokit, bot, owner, repo, prNumber, commitSha, pauseLifted);
    setReviewOutputs(posted.id, context, result);
    checkReport = outcomeReport(result.outcome, result.summary, posted.approvalHeld);
  } catch (caught) {
    cancelDashboardFlush(progress);
    // A stopped run reports the stop, whatever error it ended on.
    const error = stop.signal.aborted ? stop.signal.reason : caught;
    if (error instanceof RunCancelledError) {
      core.info(`${error.message}, writing nothing more to GitHub`);
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
      await markProgressCommentFailed(octokit, owner, repo, progress.commentId, 'Review', reason, commitSha, progressSettings(target, progress, 'review failed'));
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

  const reviewSha = github.context.payload.review?.commit_id;
  const headSha = github.context.payload.pull_request?.head?.sha;
  if (reviewSha && headSha && reviewSha !== headSha) {
    core.info(`Review is for stale commit ${reviewSha}, HEAD is ${headSha} — skipping auto-approve`);
    return;
  }

  const { owner, repo } = github.context.repo;
  const prNumber = pr.number;
  const configPathInput = core.getInput('config_path');

  const configPath = configPathInput || '.manki.yml';
  const configContent = await fetchConfigFile(octokit, owner, repo, pr.base.ref, configPath);
  const config = loadConfig(configContent ?? undefined, configPath);

  if (!config.auto_approve) {
    core.info('auto_approve is disabled — skipping state check');
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
    core.setFailed('No API key configured — set claude_code_oauth_token, anthropic_api_key, openai_oauth_token, openai_api_key, gemini_oauth_token, or gemini_api_key');
    return;
  }

  const configPathInput = core.getInput('config_path');

  const { octokit, bot, appMemory } = await getAuth();

  const { owner, repo } = github.context.repo;
  const prNumber = github.context.payload.issue?.number;
  if (!prNumber) return;

  let baseRef = 'main';
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  baseRef = pr.base.ref;

  const configPath = configPathInput || '.manki.yml';
  const configContent = await fetchConfigFile(octokit, owner, repo, baseRef, configPath);
  const config = loadConfig(configContent ?? undefined, configPath);

  const built = buildLLMClientFromInputs({ inputs: providerInputs, model: resolveModel(config, 'judge') });
  if (!built) return;
  const { client } = built;

  const memoryConfig = config.memory?.enabled ? config.memory : undefined;
  const memoryToken = config.memory?.enabled ? (await getMemoryToken(appMemory, resolveMemoryRepo(config.memory, owner))) ?? undefined : undefined;

  await handlePRComment(octokit, bot, client, owner, repo, prNumber, memoryConfig, memoryToken, config);
}

async function handleIssueInteraction(): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;
  if (!comment) return;

  if (comment.user?.type === 'Bot' || comment.body?.includes('<!-- manki')) return;

  const { owner, repo } = github.context.repo;
  const issueNumber = payload.issue?.number;
  if (!issueNumber) return;

  const { octokit, bot, appMemory } = await getAuth();
  const configPathInput = core.getInput('config_path');

  const configPath = configPathInput || '.manki.yml';
  const configContent = await fetchConfigFile(octokit, owner, repo, 'main', configPath);
  const config = loadConfig(configContent ?? undefined, configPath);

  const memoryConfig = config.memory?.enabled ? config.memory : undefined;
  const memoryToken = config.memory?.enabled ? (await getMemoryToken(appMemory, resolveMemoryRepo(config.memory, owner))) ?? undefined : undefined;

  await handlePRComment(octokit, bot, null, owner, repo, issueNumber, memoryConfig, memoryToken, config);
}

async function handleReviewCommentInteraction(): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;

  if (!comment) return;

  // Don't respond to our own comments
  if (comment.user?.type === 'Bot' || comment.body?.includes('<!-- manki')) {
    return;
  }

  // Only respond if this is a reply to a bot comment or mentions @manki
  const body = comment.body ?? '';
  const isReplyToBot = !!comment.in_reply_to_id; // handleReviewCommentReply will verify it's actually our comment
  const mentionsBot = hasBotMention(body);

  if (!isReplyToBot && !mentionsBot) {
    core.info('Review comment is not a reply to bot or @manki mention — skipping');
    return;
  }

  const providerInputs = readProviderInputs();

  if (!hasAnyProviderCredentials(providerInputs)) {
    core.setFailed('No API key configured — set claude_code_oauth_token, anthropic_api_key, openai_oauth_token, openai_api_key, gemini_oauth_token, or gemini_api_key');
    return;
  }

  const configPathInput = core.getInput('config_path');

  const { octokit, bot, appMemory } = await getAuth();
  const { owner, repo } = github.context.repo;

  const baseRef = payload.pull_request?.base?.ref ?? 'main';
  const configPath = configPathInput || '.manki.yml';
  const configContent = await fetchConfigFile(octokit, owner, repo, baseRef, configPath);
  const config = loadConfig(configContent ?? undefined, configPath);

  const built = buildLLMClientFromInputs({ inputs: providerInputs, model: resolveModel(config, 'judge') });
  if (!built) return;
  const { client } = built;

  const memoryConfig = config.memory?.enabled ? config.memory : undefined;
  const memoryToken = config.memory?.enabled ? (await getMemoryToken(appMemory, resolveMemoryRepo(config.memory, owner))) ?? undefined : undefined;

  const command = parseCommand(body);
  if (command.type !== 'generic') {
    const prNumber = payload.pull_request?.number;
    if (prNumber) {
      await handleReviewCommentCommand(octokit, bot, owner, repo, prNumber, comment.id, command, memoryConfig, memoryToken);
    } else {
      core.warning('Cannot handle command — pull request number not available');
    }
  } else {
    const prNumber = payload.pull_request?.number;
    if (!prNumber) {
      core.warning('Cannot handle reply — pull request number not available');
      return;
    }
    await handleReviewCommentReply(octokit, bot, client, owner, repo, prNumber, memoryConfig, memoryToken);
  }

  // Check if all review threads are now resolved (e.g. the reply resolved the last conversation)
  const prNum = payload.pull_request?.number;
  if (prNum && config.auto_approve) {
    const approved = await checkAndAutoApprove(octokit, bot, owner, repo, prNum, config);
    if (approved) {
      core.info(`PR #${prNum} auto-approved after all findings resolved`);
    }
  }
}

const POST_PHASE_STATE_KEY = 'manki_post_phase';

/**
 * Post-step cleanup invoked when the main step is cancelled or fails.
 * Marks the current run's progress comment as cancelled so the next trigger
 * doesn't see a zombie.
 */
async function postCleanup(): Promise<void> {
  const pr = github.context.payload.pull_request
    ?? (github.context.payload.issue?.pull_request ? github.context.payload.issue : undefined);
  const prNumber = isDispatchedRun() ? dispatchedNumber() : pr?.number;
  if (!prNumber) {
    core.info('Post-cleanup: no PR number in event payload — skipping');
    return;
  }
  const { owner, repo } = github.context.repo;
  const runId = github.context.runId;
  try {
    const { octokit, bot } = await getAuth();
    await cancelOpenReviewCheck(octokit, owner, repo);
    const marked = await markOwnProgressCommentCancelled(octokit, bot, owner, repo, prNumber, runId);
    if (marked) {
      core.info(`Post-cleanup: marked progress comment for run ${runId} as cancelled`);
    } else {
      core.info(`Post-cleanup: no progress comment found for run ${runId}`);
    }
  } catch (error) {
    core.warning(`Post-cleanup failed: ${error instanceof Error ? error.message : error}`);
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

  try {
    if (isPostPhase) {
      await postCleanup();
    } else {
      core.saveState(POST_PHASE_STATE_KEY, 'true');
      if (!isDispatchedRun() || await restoreDispatchedEvent(await workflowOctokit()) === 'run') await run();
    }
  } catch (error) {
    core.setFailed(`Manki encountered an error: ${failureReason(error)}`);
  } finally {
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
  else main();
}

function _resetOctokitCache(): void {
  authCache = null;
}

export { run, handlePullRequest, handleCommentTrigger, handleInteraction, handleIssueInteraction, handleReviewCommentInteraction, handleReviewStateCheck, runFullReview, main, _resetOctokitCache };
