import * as core from '@actions/core';
import * as github from '@actions/github';

import { createAuthenticatedOctokit, getMemoryToken } from './auth';
import { loadConfig, resolveModel } from './config';
import { buildAuthForProvider, createLLMClient, hasAnyProviderCredentials, parseModelSpec, sanitizeLogOutput } from './providers';
import type { LLMClient, ProviderAuth, ProviderInputs } from './providers';
import { extractCurrentCodeWindow } from './code-window';
import { parsePRDiff, filterFiles, isDiffTooLarge, countDiffLines } from './diff';
import { handleReviewCommentReply, handleReviewCommentCommand, handlePRComment, isReviewRequest, isBotMentionNonReview, hasBotMention, parseCommand, isLLMAccessAllowed } from './interaction';
import { isEmptyInterRoundDiff, MAX_INTER_ROUND_DIFF_CHARS } from './judge';
import { loadMemory, applyEscalations, updatePattern, RepoMemory } from './memory';
import { collectResolvedThreadIds, fetchRecapState, fingerprintFinding } from './recap';
import { buildAgentPool, buildPriorRoundLookup, collectPriorRoundAgents, runReview, determineVerdict, selectTeam } from './review';
import { CONTRADICTION_TAG, DEFENSIVE_HARDENING_TAG, DashboardData, OWN_PROPOSAL_TAG, PrContext, RATCHET_SUPPRESSED_TAG, RESOLVED_THREAD_SUPPRESSED_TAG, ReviewMetadata, RoundCap, RoundContext, RoundTrigger, ThreadResolutionOverrides, roundContextToFlatAliases } from './types';
import {
  fetchPRDiff,
  fetchConfigFile,
  fetchRepoContext,
  fetchSubdirClaudeMd,
  fetchFileContents,
  fetchInterRoundDiff,
  postProgressComment,
  updateProgressComment,
  updateProgressDashboard,
  dismissPreviousReviews,
  postReview,
  reactToIssueComment,
  fetchLinkedIssues,
  BOT_LOGIN,
  BOT_MARKER as PROGRESS_MARKER,
  FORCE_REVIEW_MARKER,
  FORCE_CAP_MARKER,
  MANKI_VERSION,
  isReviewInProgress,
  isApprovedOnCommit,
  markOwnProgressCommentCancelled,
  postAppWarningIfNeeded,
  checkConcurrentSubmissionLock,
} from './github';
import { checkAndAutoApprove, resolveStaleThreads } from './state';

type Octokit = ReturnType<typeof github.getOctokit>;

const ALLOWED_FINGERPRINT_TAGS = new Set<string>([
  DEFENSIVE_HARDENING_TAG,
  OWN_PROPOSAL_TAG,
  CONTRADICTION_TAG,
  RATCHET_SUPPRESSED_TAG,
  RESOLVED_THREAD_SUPPRESSED_TAG,
]);

type BypassHint = 'force_review' | 'skip_cap' | 'manual_review_command';

function detectTickedMarker(body: string): 'FORCE_REVIEW_MARKER' | 'FORCE_CAP_MARKER' | null {
  if (!body.includes('- [x] Force review')) return null;
  if (body.includes(FORCE_REVIEW_MARKER)) return 'FORCE_REVIEW_MARKER';
  if (body.includes(FORCE_CAP_MARKER)) return 'FORCE_CAP_MARKER';
  return null;
}

/**
 * Build `RoundMeta.trigger` from the current GitHub Actions event. The event
 * string folds in the action and (for the marker-comment tickbox edits) the
 * specific marker, so a `5/5 -> 6/5` jump in the round-cap counter is
 * attributable to the exact UI affordance that fired.
 */
function buildRoundTrigger(): RoundTrigger {
  const eventName = github.context.eventName;
  const payload = github.context.payload;
  const action = payload.action;
  const sender = payload.sender?.login ?? 'unknown';

  let event = action ? `${eventName}:${action}` : eventName;
  if (eventName === 'issue_comment') {
    const body = payload.comment?.body ?? '';
    if (action === 'edited') {
      const ticked = detectTickedMarker(body);
      if (ticked) {
        event = `${event}:tick:${ticked}`;
      }
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

const octokitCache = {
  instance: null as Octokit | null,
  resolvedToken: null as string | null,
  identity: null as 'app' | 'actions' | null,
};

async function getOctokit(): Promise<Octokit> {
  if (!octokitCache.instance) {
    const { octokit, resolvedToken, identity } = await createAuthenticatedOctokit();
    octokitCache.instance = octokit;
    octokitCache.resolvedToken = resolvedToken;
    octokitCache.identity = identity;
  }
  return octokitCache.instance;
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

  if (core.getInput('claude_code_oauth_token')) {
    core.warning(
      '`claude_code_oauth_token` is deprecated. Anthropic restricts Claude Code OAuth tokens for third-party tools. ' +
      'Use `anthropic_api_key` instead, or use `openai_oauth_token` / `gemini_oauth_token` once those provider OAuth paths are stable.',
    );
  }

  const commentAuthorLogin = github.context.payload.comment?.user?.login as string | undefined;
  const isBotComment = commentAuthorLogin === BOT_LOGIN;

  // Event filtering — exit immediately for irrelevant events.
  // Tested via integration (live PR reviews) since it depends on GitHub Actions context.
  if (eventName === 'pull_request') {
    if (action !== 'opened' && action !== 'synchronize') {
      core.info(`Ignoring pull_request action: ${action}`);
      return;
    }
  } else if (eventName === 'issue_comment') {
    if (action !== 'created' && action !== 'edited') {
      core.info(`Ignoring issue_comment action: ${action}`);
      return;
    }
    const body = github.context.payload.comment?.body ?? '';
    const isForceReviewChecked = action === 'edited' && isBotComment && detectTickedMarker(body) !== null;
    if (!isForceReviewChecked && !hasBotMention(body) && !isReviewRequest(body)) {
      core.info('Comment does not mention Manki — ignoring');
      return;
    }
    // For edited comments, check if we already processed this comment (has eyes reaction)
    if (action === 'edited') {
      const commentId = github.context.payload.comment?.id;
      if (commentId) {
        try {
          const octokit = await getOctokit();
          const { owner, repo } = github.context.repo;
          const { data: reactions } = await octokit.rest.reactions.listForIssueComment({
            owner, repo, comment_id: commentId,
          });
          const alreadyProcessed = reactions.some(r =>
            r.content === 'eyes' &&
            (r.user?.login === BOT_LOGIN || r.user?.login === 'github-actions[bot]')
          );
          if (alreadyProcessed) {
            core.info('Edited comment already processed (has eyes reaction) — skipping');
            return;
          }
        } catch {
          // If we can't check reactions, proceed anyway
        }
      }
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
  } else if (eventName === 'pull_request_review') {
    if (action !== 'submitted' && action !== 'dismissed') {
      core.info(`Ignoring pull_request_review action: ${action}`);
      return;
    }
  } else {
    core.info(`Ignoring unsupported event: ${eventName}`);
    return;
  }

  // Route to the appropriate handler
  switch (eventName) {
    case 'pull_request':
      await handlePullRequest();
      break;

    case 'issue_comment': {
      const commentBody = github.context.payload.comment?.body ?? '';
      const tickedMarker = action === 'edited' && isBotComment ? detectTickedMarker(commentBody) : null;
      if (tickedMarker === 'FORCE_CAP_MARKER' && github.context.payload.issue?.pull_request) {
        await handleCommentTrigger(false, true, 'skip_cap');
      } else if (tickedMarker === 'FORCE_REVIEW_MARKER' && github.context.payload.issue?.pull_request) {
        await handleCommentTrigger(true, false, 'force_review');
      } else if (isReviewRequest(commentBody) && github.context.payload.issue?.pull_request) {
        await handleCommentTrigger(true, true, 'manual_review_command');
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
  }
}

async function postReviewSkippedComment(
  octokit: Octokit, owner: string, repo: string, prNumber: number,
): Promise<void> {
  try {
    const body = [
      PROGRESS_MARKER,
      `**Review skipped** — a review is currently in progress. Retry when it completes, or force now:`,
      '',
      '- [ ] Force review',
      '',
      FORCE_REVIEW_MARKER,
    ].join('\n');
    // Always create a fresh comment. Editing an older skip-ack in place is
    // silent on GitHub (no notification, original timeline position), so the
    // user perceives no response. Each fresh comment carries its own Force
    // review checkbox.
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  } catch (error) {
    core.warning(`Failed to post review-skipped comment: ${error instanceof Error ? error.message : error}`);
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

  if (pr.draft) {
    core.info('Skipping draft PR');
    return;
  }

  const octokit = await getOctokit();
  if (await isReviewInProgress(octokit, owner, repo, prNumber)) {
    await postReviewSkippedComment(octokit, owner, repo, prNumber);
    return;
  }

  if (await isApprovedOnCommit(octokit, owner, repo, prNumber, commitSha)) {
    core.info('Already approved on this commit — skipping review');
    return;
  }

  const prContext: PrContext = {
    title: pr.title,
    body: pr.body || '',
    baseBranch: pr.base.ref,
  };

  await runFullReview(owner, repo, prNumber, commitSha, pr.base.ref, prContext, pr.user?.login);
}

async function handleCommentTrigger(forceReview?: boolean, skipCap?: boolean, bypassHint?: BypassHint): Promise<void> {
  const payload = github.context.payload;

  if (!payload.issue?.pull_request) {
    core.info('Comment is on an issue, not a PR — skipping');
    return;
  }

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const prNumber = payload.issue.number;

  const octokit = await getOctokit();

  // Acknowledge the command unconditionally so the user knows it was received.
  if (payload.comment?.id) {
    await reactToIssueComment(octokit, owner, repo, payload.comment.id, 'eyes');
  }

  const authorAssociation = payload.comment?.author_association;
  const senderLogin = payload.sender?.login;
  const prAuthorLogin = payload.issue?.user?.login;
  if (!isLLMAccessAllowed(authorAssociation, senderLogin, prAuthorLogin)) {
    core.info(`Ignoring review request from ${senderLogin} (${authorAssociation ?? 'unknown association'})`);
    await octokit.rest.issues.createComment({
      owner, repo, issue_number: prNumber,
      body: `${PROGRESS_MARKER}\n**Manki** — Only repo contributors can trigger reviews.`,
    });
    return;
  }

  if (!forceReview) {
    if (await isReviewInProgress(octokit, owner, repo, prNumber)) {
      await postReviewSkippedComment(octokit, owner, repo, prNumber);
      core.info('Review already in progress — skipping');
      return;
    }
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  if (!forceReview) {
    if (await isApprovedOnCommit(octokit, owner, repo, prNumber, pr.head.sha)) {
      core.info('Already approved on this commit — skipping review');
      return;
    }
  }

  const prContext: PrContext = {
    title: pr.title,
    body: pr.body || '',
    baseBranch: pr.base.ref,
  };

  await runFullReview(owner, repo, prNumber, pr.head.sha, pr.base.ref, prContext, pr.user?.login, forceReview, skipCap, bypassHint);
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

async function runFullReview(
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  baseRef: string,
  prContext?: PrContext,
  prAuthorLogin?: string,
  forceReview?: boolean,
  skipCap?: boolean,
  bypassHint?: BypassHint,
): Promise<void> {
  core.info(`Starting review for ${owner}/${repo}#${prNumber}`);
  const trigger = buildRoundTrigger();

  const providerInputs = readProviderInputs();

  if (!hasAnyProviderCredentials(providerInputs)) {
    core.setFailed('No API key configured — set claude_code_oauth_token, anthropic_api_key, openai_oauth_token, openai_api_key, gemini_oauth_token, or gemini_api_key');
    return;
  }

  const startTime = Date.now();
  const configPathInput = core.getInput('config_path');
  const octokit = await getOctokit();

  if (octokitCache.identity === 'actions') {
    try {
      await postAppWarningIfNeeded(octokit, owner, repo, prNumber);
    } catch (error) {
      core.warning(`Failed to post app warning: ${error}`);
    }
  }

  let progressCommentId: number | undefined;
  let dashboardFlushTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    let configContent: string | null = null;
    if (configPathInput) {
      configContent = await fetchConfigFile(octokit, owner, repo, baseRef, configPathInput);
    } else {
      configContent = await fetchConfigFile(octokit, owner, repo, baseRef, '.manki.yml');
    }
    const config = loadConfig(configContent ?? undefined);

    // Scan for a competing in-progress marker before posting our own to shorten
    // the race window. A residual window remains when two runs both pass this scan
    // before either posts; tracking issue for the strict atomic fix: https://github.com/manki-review/manki/issues/798
    if (await checkConcurrentSubmissionLock(octokit, owner, repo, prNumber, config)) {
      core.warning('Defense-in-depth lock engaged — this run will not post a review. If no review appears on the PR, re-trigger with `/manki review`.');
      return;
    }

    progressCommentId = await postProgressComment(octokit, owner, repo, prNumber);

    // Capture recap state before resolving stale threads so dedup sees
    // the original open/resolved status of each previous finding.
    const recap = await fetchRecapState(octokit, owner, repo, prNumber, prAuthorLogin);

    const staleCount = await resolveStaleThreads(octokit, owner, repo, prNumber, commitSha);
    if (staleCount > 0) {
      core.info(`Resolved ${staleCount} stale review threads from previous commits`);
    }

    if (github.context.eventName === 'pull_request' && !config.auto_review) {
      core.info('auto_review is disabled — skipping');
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: progressCommentId });
      return;
    }

    const plannerModel = resolveModel(config, 'planner');
    const reviewerModel = resolveModel(config, 'reviewer');
    const judgeModel = resolveModel(config, 'judge');
    const dedupModel = resolveModel(config, 'dedup');
    core.info(`Models — planner: ${plannerModel}, reviewer: ${reviewerModel}, judge: ${judgeModel}, dedup: ${dedupModel}`);
    const agentOverrides = config.models?.agents;
    if (agentOverrides && Object.keys(agentOverrides).length > 0) {
      const formatted = Object.entries(agentOverrides).map(([n, m]) => `${n}=${m}`).join(', ');
      core.info(`Per-agent model overrides — ${formatted}`);
    }

    const buildClient = (model: string) => {
      const spec = parseModelSpec(model);
      const auth = buildAuthForProvider(spec.provider, providerInputs);
      return createLLMClient(spec.provider, spec.model, auth);
    };
    let reviewerClient: LLMClient, judgeClient: LLMClient, dedupClient: LLMClient;
    let plannerClient: LLMClient | undefined;
    const perAgentClients = new Map<string, LLMClient>();
    try {
      reviewerClient = buildClient(reviewerModel);
      judgeClient = buildClient(judgeModel);
      plannerClient = config.planner?.enabled !== false ? buildClient(plannerModel) : undefined;
      dedupClient = buildClient(dedupModel);
      for (const [name, model] of Object.entries(config.models?.agents ?? {})) {
        if (model !== reviewerModel) perAgentClients.set(name, buildClient(model));
      }
    } catch (error) {
      core.setFailed(`Invalid model config: ${error instanceof Error ? error.message : error}`);
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: progressCommentId }).catch(() => {});
      return;
    }

    const rawDiff = await fetchPRDiff(octokit, owner, repo, prNumber);
    const diff = parsePRDiff(rawDiff);
    const parseEndTime = Date.now();
    const plannerEnabled = !!plannerClient && config.review_level === 'auto';
    const team = selectTeam(diff, config, config.reviewers);
    // `team` here is only used for the initial dashboard preview; the actual
    // review team is resolved inside `runReview` once the handover and planner
    // result are available, so prior-round pinning is applied there.
    const lineCount = diff.totalAdditions + diff.totalDeletions;

    const dashboard: DashboardData = plannerEnabled
      ? {
          phase: 'planning',
          lineCount,
          agentCount: 0,
        }
      : {
          phase: 'started',
          lineCount,
          agentCount: team.agents.length,
          agentProgress: team.agents.map(a => ({ name: a.name, status: 'reviewing' as const })),
        };
    await updateProgressDashboard(octokit, owner, repo, progressCommentId, dashboard);

    if (isDiffTooLarge(diff, config.max_diff_lines, config.exclude_paths)) {
      const reviewableLines = countDiffLines(filterFiles(diff.files, config.exclude_paths));
      core.warning(`Diff too large (${reviewableLines} reviewable lines > ${config.max_diff_lines} max)`);
      const result = {
        verdict: 'COMMENT' as const,
        summary: `**Manki** — This PR is too large for automated review (${reviewableLines} lines). Consider splitting it up or request a manual review.`,
        findings: [],
        highlights: [],
        reviewComplete: true,
        agentNames: [] as string[],
      };
      // Dismiss stale CHANGES_REQUESTED reviews before posting the skip comment
      try {
        await dismissPreviousReviews(octokit, owner, repo, prNumber);
      } catch (error) {
        core.warning(`Failed to dismiss previous reviews: ${error}`);
      }
      await postReview(octokit, owner, repo, prNumber, commitSha, result, diff);
      await updateProgressComment(octokit, owner, repo, progressCommentId, dashboard);
      return;
    }

    const filteredFiles = filterFiles(diff.files, config.exclude_paths);
    core.info(`Reviewing ${filteredFiles.length} files (${diff.files.length} total, ${diff.files.length - filteredFiles.length} filtered out)`);

    if (filteredFiles.length === 0) {
      core.info('No reviewable files in diff');
      const result = {
        verdict: 'APPROVE' as const,
        summary: 'No reviewable files in this PR (all filtered out by config).',
        findings: [],
        highlights: [],
        reviewComplete: true,
        agentNames: [] as string[],
      };
      await dismissPreviousReviews(octokit, owner, repo, prNumber);
      await postReview(octokit, owner, repo, prNumber, commitSha, result, diff);
      await updateProgressComment(octokit, owner, repo, progressCommentId, dashboard);
      return;
    }

    // Eagerly install any provider CLI before the planner timer starts. The
    // fallback `npm install -g` inside `ensureCLI` takes around 30s on a
    // cold runner and would otherwise race the planner's own 30s timeout.
    // Warming up once here pays the cost before any per-call deadline runs.
    // Deduplicate by client instance so roles that share a client don't
    // serialize redundant install retries on failure. Placed after the
    // diff-size and empty-files guards so cold installs are skipped on paths
    // that never invoke an LLM.
    const warmupTargets = new Set<LLMClient>(
      [plannerClient, reviewerClient, judgeClient, dedupClient, ...perAgentClients.values()].filter(
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

    let repoContext = await fetchRepoContext(octokit, owner, repo, baseRef);

    const changedPaths = filteredFiles.map(f => f.path);
    try {
      const subdirContext = await fetchSubdirClaudeMd(octokit, owner, repo, baseRef, changedPaths);
      if (subdirContext) {
        repoContext = repoContext ? `${repoContext}\n\n---\n\n${subdirContext}` : subdirContext;
      }
    } catch (error) {
      core.warning(`Failed to fetch subdirectory CLAUDE.md files: ${error}`);
    }

    let memory: RepoMemory | null = null;
    if (config.memory?.enabled) {
      const memoryToken = getMemoryToken(octokitCache.resolvedToken);
      if (!memoryToken) {
        core.warning('No memory token available — skipping memory load. Set memory_repo_token or github_token.');
      } else {
        const memoryOctokit = github.getOctokit(memoryToken);
        const memoryRepo = config.memory?.repo || `${owner}/review-memory`;

        try {
          memory = await loadMemory(memoryOctokit, memoryRepo, repo);
          core.info(`Loaded memory: ${memory.learnings.length} learnings, ${memory.suppressions.length} suppressions`);
        } catch (error) {
          core.warning(`Failed to load review memory: ${error}`);
        }
      }
    }

    const priorRoundCount = recap.priorRounds.length;
    const maxAutoRounds = config.convergence?.max_auto_rounds ?? 0;
    if (
      maxAutoRounds > 0 &&
      priorRoundCount >= maxAutoRounds &&
      !skipCap
    ) {
      core.info(`Round cap reached (${priorRoundCount} prior rounds >= max ${maxAutoRounds}) — skipping auto review`);
      try {
        await octokit.rest.issues.deleteComment({ owner, repo, comment_id: progressCommentId });
      } catch (error) {
        core.warning(`Failed to delete progress comment: ${error}`);
      }
      try {
        const body = [
          PROGRESS_MARKER,
          `Manki has completed ${priorRoundCount}/${maxAutoRounds} review rounds on this PR. Automatic review is paused. Tick the box to force another round, or comment \`@manki review\`:`,
          '',
          '- [ ] Force review',
          '',
          FORCE_CAP_MARKER,
        ].join('\n');
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body,
        });
      } catch (error) {
        core.warning(`Failed to post round-cap notice: ${error}`);
      }
      return;
    }

    const fullContext = [repoContext, recap.recapContext].filter(Boolean).join('\n\n');

    const isFollowUp = recap.previousFindings.length > 0;
    const baseOpenThreads = recap.previousFindings
      .filter(f => (f.status === 'open' || f.status === 'replied') && f.threadId)
      .map(f => ({
        threadId: f.threadId!,
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
    const changedFilePaths = filteredFiles
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

    // Fetch inter-round diff (prior round commit -> current head) so the judge
    // can ground per-thread resolution in actual changes since last review.
    let interRoundDiff: string | undefined;
    const lastPriorSha = recap.priorRounds.at(-1)?.meta.commitSha;
    const shouldFetchDiff = !!(lastPriorSha && lastPriorSha !== commitSha);
    const prBody = prContext?.body;

    let linkedIssues;
    const diffPromise: Promise<string | undefined> = shouldFetchDiff && lastPriorSha
      ? fetchInterRoundDiff(octokit, owner, repo, lastPriorSha, commitSha)
      : Promise.resolve(undefined);
    const linkedIssuesPromise = prBody
      ? fetchLinkedIssues(octokit, owner, repo, prBody)
      : Promise.resolve(undefined);
    const [diffResult, linkedIssuesResult] = await Promise.allSettled([diffPromise, linkedIssuesPromise]);

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

    await dismissPreviousReviews(octokit, owner, repo, prNumber);

    let reviewEndTime = parseEndTime;

    // Names of every agent that participated in any prior round of this PR.
    // Used to pin the team across rounds so the roster grows monotonically:
    // an agent that flagged something earlier always reviews later rounds.
    const priorRoundAgents = collectPriorRoundAgents(recap.priorRounds);

    // On the non-planner path the dashboard was seeded with the heuristic team
    // before prior-round agents were known. Pre-populate any pinned agents now
    // so that agent-complete callbacks can record their metrics.
    if (!plannerEnabled && priorRoundAgents.length > 0 && dashboard.agentProgress) {
      const poolNames = new Set(buildAgentPool(config.reviewers).map(a => a.name));
      const inDashboard = new Set(dashboard.agentProgress.map(a => a.name));
      for (const name of priorRoundAgents) {
        if (!inDashboard.has(name) && poolNames.has(name)) {
          dashboard.agentProgress.push({ name, status: 'reviewing' as const });
        }
      }
    }

    function scheduleDashboardFlush(): void {
      if (dashboardFlushTimer) clearTimeout(dashboardFlushTimer);
      dashboardFlushTimer = setTimeout(() => {
        dashboardFlushTimer = null;
        updateProgressDashboard(octokit, owner, repo, progressCommentId!, dashboard)
          .catch(err => core.warning(`Failed to update dashboard: ${err}`));
      }, 500);
    }

    const result = await runReview(
      {
        reviewer: reviewerClient,
        judge: judgeClient,
        planner: plannerClient,
        dedup: dedupClient,
        reviewerForAgent: (agentName: string) =>
          perAgentClients.get(agentName) ?? reviewerClient,
      }, config, diff, rawDiff, fullContext,
      memory, fileContents, prContext, linkedIssues,
      (progress) => {
        if (progress.phase === 'planning') {
          core.info('Planner analyzing PR content...');
          if (progress.plannerResult) {
            const plannerTeam = selectTeam(diff, config, config.reviewers, progress.plannerResult.teamSize, progress.plannerResult.agents, priorRoundAgents, true);
            dashboard.plannerInfo = {
              agentCount: plannerTeam.agents.length,
              reviewerEffort: progress.plannerResult.reviewerEffort,
              judgeEffort: progress.plannerResult.judgeEffort,
              prType: progress.plannerResult.prType,
            };
            dashboard.agentCount = plannerTeam.agents.length;
            dashboard.agentProgress = plannerTeam.agents.map(a => ({ name: a.name, status: 'reviewing' as const }));
            dashboard.plannerDurationMs = progress.plannerDurationMs;
            dashboard.phase = 'started';
            scheduleDashboardFlush();
          } else if (progress.heuristicFallback && progress.teamAgentNames) {
            dashboard.agentCount = progress.teamAgentNames.length;
            dashboard.agentProgress = progress.teamAgentNames.map(name => ({ name, status: 'reviewing' as const }));
            dashboard.plannerDurationMs = progress.plannerDurationMs;
            dashboard.heuristicFallback = true;
            dashboard.phase = 'started';
            scheduleDashboardFlush();
          }
        } else if (progress.phase === 'agent-complete') {
          if (dashboard.agentProgress && progress.agentName) {
            const entry = dashboard.agentProgress.find(a => a.name === progress.agentName);
            if (entry) {
              if (progress.agentStatus === 'retrying') {
                entry.status = 'retrying';
                entry.retryCount = progress.retryCount;
              } else {
                entry.status = progress.agentStatus === 'failure' ? 'failed' : 'done';
                entry.findingCount = progress.agentFindingCount;
                entry.durationMs = progress.agentDurationMs;
                if (progress.agentStatus === 'failure' && progress.retryCount) {
                  entry.retryCount = progress.retryCount;
                }
              }
            }
          }
          scheduleDashboardFlush();
        } else if (progress.phase === 'reviewed') {
          if (dashboardFlushTimer) {
            clearTimeout(dashboardFlushTimer);
            dashboardFlushTimer = null;
          }
          reviewEndTime = Date.now();
          dashboard.phase = 'reviewed';
          dashboard.rawFindingCount = progress.rawFindingCount;
          updateProgressDashboard(octokit, owner, repo, progressCommentId!, dashboard)
            .catch(err => core.warning(`Failed to update dashboard: ${err}`));
        } else if (progress.phase === 'judging') {
          if (dashboardFlushTimer) {
            clearTimeout(dashboardFlushTimer);
            dashboardFlushTimer = null;
          }
          dashboard.phase = 'reviewed';
          dashboard.rawFindingCount = progress.rawFindingCount;
          dashboard.judgeInputCount = progress.judgeInputCount;
          updateProgressDashboard(octokit, owner, repo, progressCommentId!, dashboard)
            .catch(err => core.warning(`Failed to update dashboard: ${err}`));
        }
      },
      isFollowUp,
      openThreads,
      recap.previousFindings,
      recap.priorRounds,
      prAuthorLogin,
      interRoundDiff,
    );
    const judgeEndTime = Date.now();

    if (!result.reviewComplete) {
      if (dashboardFlushTimer) {
        clearTimeout(dashboardFlushTimer);
        dashboardFlushTimer = null;
      }
      core.warning(`Review incomplete: ${result.summary}`);
      result.verdict = 'COMMENT';
      await postReview(octokit, owner, repo, prNumber, commitSha, result, diff);
      dashboard.phase = 'complete';
      await updateProgressComment(octokit, owner, repo, progressCommentId, dashboard);
      return;
    }

    const sortedPriorRounds = [...recap.priorRounds].sort((a, b) => a.meta.round - b.meta.round);
    const priorFindingsFlat = sortedPriorRounds.flatMap(r => r.findings.entries ?? []);
    const priorRoundLookup = buildPriorRoundLookup(sortedPriorRounds);
    let escalationsApplied = 0;
    if (memory && memory.patterns.length > 0) {
      const beforeSeverities = result.findings.map(f => f.severity);
      result.findings = applyEscalations(result.findings, memory.patterns);
      escalationsApplied = result.findings.filter((f, i) => f.severity !== beforeSeverities[i]).length;
    }
    const resolvedThreadIds = collectResolvedThreadIds(recap.previousFindings);
    const { verdict: recomputedVerdict, verdictReason, verdictTrace } = determineVerdict(result.findings, priorFindingsFlat, openThreads, resolvedThreadIds, undefined, priorRoundLookup);
    result.verdict = recomputedVerdict;
    result.verdictReason = verdictReason;
    result.verdictTrace = verdictTrace;

    // Enrich findings with code context from the diff for nit issues
    for (const finding of result.findings) {
      if (finding.file && finding.line) {
        const diffFile = diff.files.find(f => f.path === finding.file);
        if (diffFile) {
          const hunk = diffFile.hunks.find(h =>
            finding.line >= h.newStart && finding.line <= h.newStart + h.newLines - 1,
          );
          if (hunk) {
            const lines = hunk.content.split('\n');
            const findingOffset = finding.line - hunk.newStart;
            const start = Math.max(0, findingOffset - 5);
            const end = Math.min(lines.length, findingOffset + 10);
            finding.codeContext = lines.slice(start, end).join('\n');
          }
        }
      }
    }

    const reviewTimeMs = Date.now() - startTime;
    const severityMap: Record<string, number> = { blocker: 0, warning: 0, suggestion: 0, nitpick: 0 };
    for (const f of result.findings) {
      if (f.severity in severityMap) severityMap[f.severity]++;
    }

    // Per-agent metrics: count raw and kept findings per agent
    const agentNames = result.agentNames;
    const allJudged = result.allJudgedFindings ?? [];
    const rawFindings = result.rawFindings ?? allJudged;
    const agentMetrics = agentNames.length > 0
      ? agentNames.map(name => ({
        name,
        findingsRaw: rawFindings.filter(f => f.reviewers.includes(name)).length,
        findingsKept: result.findings.filter(f => f.reviewers.includes(name)).length,
        responseLength: result.agentResponseLengths?.get(name),
      }))
      : undefined;

    // Judge calibration metrics
    const confidenceDistribution = { high: 0, medium: 0, low: 0 };
    for (const f of allJudged) {
      if (f.judgeConfidence) confidenceDistribution[f.judgeConfidence]++;
    }
    const severityChanges = allJudged.filter(f => f.judgeNotes).length;
    const mergedDuplicates = allJudged.length > 0
      ? (result.rawFindingCount ?? 0)
        - (result.suppressionCount ?? 0)
        - (result.staticDedupCount ?? 0)
        - (result.llmDedupCount ?? 0)
        - allJudged.length
      : 0;
    const defensiveHardeningCount = allJudged.filter(f => f.tags?.includes(DEFENSIVE_HARDENING_TAG)).length;
    const ownProposalDemotedCount = allJudged.filter(f => f.tags?.includes(OWN_PROPOSAL_TAG)).length;
    const contradictionDemotedCount = allJudged.filter(f => f.tags?.includes(CONTRADICTION_TAG)).length;
    const ratchetSuppressedCount = allJudged.filter(f => f.tags?.includes(RATCHET_SUPPRESSED_TAG)).length;
    const resolvedThreadSuppressedCount = allJudged.filter(f => f.tags?.includes(RESOLVED_THREAD_SUPPRESSED_TAG)).length;
    const crossRoundSuppressed = result.crossRoundSuppressed;
    const crossRoundDemoted = result.crossRoundDemoted;
    const interRoundDiffEmptyOverride = result.interRoundDiffEmptyOverride;
    const inPrSuppressedCount = result.inPrSuppressedCount ?? 0;
    const openThreadCount = openThreads.length;
    const resolvedThreadIdCount = resolvedThreadIds.size;
    const hasPriorRoundsForJudge = recap.priorRounds.length > 0;
    const interRoundDiffState: 'unknown' | 'empty' | 'changed' = !hasPriorRoundsForJudge || interRoundDiff === undefined
      ? 'unknown'
      : interRoundDiff.trim().length === 0
        ? 'empty'
        : 'changed';
    const interRoundDiffBytes = interRoundDiff !== undefined ? interRoundDiff.length : undefined;
    const interRoundDiffTruncated = interRoundDiff !== undefined && interRoundDiff.length > MAX_INTER_ROUND_DIFF_CHARS;
    const interRoundDiffKnownEmptyForCounts = hasPriorRoundsForJudge && isEmptyInterRoundDiff(interRoundDiff);
    const knownThreadIdSet = new Set(openThreads.map(t => t.threadId));
    let addressedDropped = 0;
    let uncertainCount = 0;
    for (const ev of result.threadEvaluations ?? []) {
      if (ev.status === 'uncertain') uncertainCount++;
      if (ev.status === 'addressed' && (!knownThreadIdSet.has(ev.threadId) || interRoundDiffKnownEmptyForCounts)) {
        addressedDropped++;
      }
    }
    const notAddressedOverridden = interRoundDiffEmptyOverride?.applied ? interRoundDiffEmptyOverride.affectedThreadCount : 0;
    const threadResolutionOverrides: ThreadResolutionOverrides | undefined =
      (addressedDropped > 0 || notAddressedOverridden > 0 || uncertainCount > 0)
        ? { addressedDropped, notAddressedOverridden, uncertainCount }
        : undefined;
    // File analysis metrics
    const fileTypes: Record<string, number> = {};
    for (const file of filteredFiles) {
      const dotIdx = file.path.lastIndexOf('.');
      const ext = dotIdx !== -1 ? file.path.slice(dotIdx) : '(none)';
      fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
    }

    const round = priorRoundCount + 1;
    const cap: RoundCap = {
      priorRoundCount,
      maxAutoRounds,
      skipCap: !!skipCap,
      forceReview: !!forceReview,
      bypassReason: bypassHint ?? 'within_cap',
    };
    const findingEntries = result.findings.map(f => ({
      fingerprint: fingerprintFinding(f.title, f.file ?? '', f.line || 0),
      severity: f.severity,
      ...(f.reviewers[0] && { specialist: f.reviewers[0] }),
      ...(f.suggestedFix && { suggestedFix: f.suggestedFix.slice(0, 300) }),
      ...(f.title && { title: f.title.slice(0, 200) }),
      ...(f.judgeNotes && { judgeNotes: f.judgeNotes.slice(0, 500) }),
      ...(f.judgeConfidence && { judgeConfidence: f.judgeConfidence }),
      ...(f.reachability && { reachability: f.reachability }),
      ...(f.reachabilityReasoning && { reachabilityReasoning: f.reachabilityReasoning.slice(0, 500) }),
      ...(f.tags && f.tags.length > 0 && { tags: f.tags.filter(t => ALLOWED_FINGERPRINT_TAGS.has(t)) }),
      ...(f.originalSeverity && { originalSeverity: f.originalSeverity }),
    }));
    const context: RoundContext = {
      meta: {
        prNumber,
        commitSha,
        round,
        timestamp: new Date().toISOString(),
        mankiVersion: MANKI_VERSION,
        cap,
        trigger,
      },
      config: {
        reviewLevel: team.level === 'trivial' ? 'small' : team.level,
        memoryEnabled: config.memory?.enabled ?? false,
        ...(config.review_passes != null && { reviewPasses: config.review_passes }),
      },
      diff: {
        lines: diff.totalAdditions + diff.totalDeletions,
        additions: diff.totalAdditions,
        deletions: diff.totalDeletions,
        filesReviewed: filteredFiles.length,
        fileTypes,
      },
      models: {
        ...(plannerClient && { planner: plannerModel }),
        reviewer: reviewerModel,
        judge: judgeModel,
        dedup: dedupModel,
      },
      planner: result.plannerResult
        ? {
            used: true,
            teamSize: result.plannerResult.teamSize,
            reviewerEffort: result.plannerResult.reviewerEffort,
            judgeEffort: result.plannerResult.judgeEffort,
            prType: result.plannerResult.prType,
            ...(dashboard.plannerDurationMs != null && { durationMs: dashboard.plannerDurationMs }),
          }
        : { used: false },
      reviewers: {
        agents: result.agentNames,
        ...(agentMetrics && { agentMetrics }),
      },
      judge: {
        summary: result.summary,
        confidenceDistribution,
        severityChanges,
        mergedDuplicates,
        durationMs: judgeEndTime - reviewEndTime,
        ...(verdictReason && { verdictReason }),
        ...(defensiveHardeningCount > 0 && { defensiveHardeningCount }),
        ...(ownProposalDemotedCount > 0 && { ownProposalDemotedCount }),
        ...(contradictionDemotedCount > 0 && { contradictionDemotedCount }),
        ...(ratchetSuppressedCount > 0 && { ratchetSuppressedCount }),
        ...(resolvedThreadSuppressedCount > 0 && { resolvedThreadSuppressedCount }),
        ...(inPrSuppressedCount > 0 && { inPrSuppressedCount }),
        ...(crossRoundSuppressed != null && crossRoundSuppressed > 0 && { crossRoundSuppressed }),
        ...(crossRoundDemoted != null && crossRoundDemoted > 0 && { crossRoundDemoted }),
        ...(interRoundDiffEmptyOverride && { interRoundDiffEmptyOverride }),
        ...(result.threadEvaluations && result.threadEvaluations.length > 0 && { threadEvaluations: result.threadEvaluations }),
        ...(verdictTrace && { verdictTrace }),
        openThreadsState: recap.openThreadsState,
        openThreadCount,
        resolvedThreadIdCount,
        interRoundDiffState,
        ...(interRoundDiffBytes != null && { interRoundDiffBytes }),
        interRoundDiffTruncated,
        ...(threadResolutionOverrides && { threadResolutionOverrides }),
      },
      dedup: {
        ...(result.staticDedupCount != null && { staticDropped: result.staticDedupCount }),
        ...(result.llmDedupCount != null && { llmDropped: result.llmDedupCount }),
      },
      memory: {
        ...(memory && memory.patterns.length > 0 && { patternsApplied: memory.patterns.length }),
        ...(result.suppressionCount != null && result.suppressionCount > 0 && { suppressionsApplied: result.suppressionCount }),
        ...(escalationsApplied > 0 && { escalationsApplied }),
      },
      findings: {
        count: result.findings.length,
        severityCounts: severityMap,
        entries: findingEntries,
      },
      usage: {},
      verdict: result.verdict,
    };
    const flatAliases = roundContextToFlatAliases(context);

    // Resolve threads the judge marked `addressed`. Other statuses
    // (`not_addressed`, `uncertain`) are logged for audit but never trigger a
    // resolveReviewThread mutation. Unknown thread IDs are filtered.
    //
    // Defense-in-depth: when the inter-round diff is known-empty (force-pushed
    // rebase to identical tree), no thread can be addressed. The judge already
    // synthesizes `not_addressed` for every thread in this case, but a future
    // refactor that bypasses `runJudgeAgent` would lose that guarantee. Drop
    // any `addressed` evaluation here as a second layer. `undefined` is the
    // unknown sentinel (compare-API failure) and must not trigger the guard.
    const hasPriorRounds = recap.priorRounds.length > 0;
    const interRoundDiffKnownEmpty = hasPriorRounds && isEmptyInterRoundDiff(interRoundDiff);
    if (result.threadEvaluations && result.threadEvaluations.length > 0) {
      const knownThreadIds = new Set(openThreads.map(t => t.threadId));
      for (const { threadId, status, reason } of result.threadEvaluations) {
        if (!knownThreadIds.has(threadId)) {
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
          await octokit.graphql(`mutation($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { isResolved } } }`, { threadId });
          core.info(`Judge resolved: "${reason}" — thread ${threadId}`);
        } catch (error) {
          core.debug(`Failed to resolve thread ${threadId}: ${error}`);
        }
      }
    }

    const reviewId = await postReview(octokit, owner, repo, prNumber, commitSha, result, diff, context, reviewTimeMs, config);

    if (memory && config.memory?.enabled) {
      const memoryToken = getMemoryToken(octokitCache.resolvedToken);
      if (!memoryToken) {
        core.warning('No memory token available — skipping memory update. Set memory_repo_token or github_token.');
      } else {
        const memoryOctokit = github.getOctokit(memoryToken);
        const memoryRepo = config.memory?.repo || `${owner}/review-memory`;

        for (const finding of result.findings) {
          try {
            await updatePattern(memoryOctokit, memoryRepo, repo, finding.title, repo);
          } catch (error) {
            core.debug(`Failed to update pattern for "${finding.title}": ${error}`);
          }
        }
        core.info(`Updated ${result.findings.length} patterns in memory repo`);
      }
    }

    // Reconcile the dashboard with the actual resolved team. On round 2+ the
    // initial dashboard was built without priorRoundAgents (not yet loaded),
    // so the agent list would otherwise show a stale, too-small count. On
    // round 1 without a planner, agents may fail and drop out, so reconcile
    // unconditionally to keep agentCount and agentProgress accurate.
    reconcileDashboardAgents(dashboard, result.agentNames);

    if (result.plannerResult) {
      dashboard.plannerInfo = {
        agentCount: result.agentNames.length,
        reviewerEffort: result.plannerResult.reviewerEffort,
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
    const completeDashboard: DashboardData = {
      ...dashboard,
      phase: 'complete',
      keptCount: result.findings.length,
      droppedCount: judgeDroppedCount,
      keptSeverities,
      droppedSeverities,
      ...(result.testNitSuppressedCount != null && result.testNitSuppressedCount > 0 && { testNitSuppressedCount: result.testNitSuppressedCount }),
      judgeDurationMs: judgeEndTime - reviewEndTime,
    };

    const timing = {
      parseMs: parseEndTime - startTime,
      reviewMs: reviewEndTime - parseEndTime,
      judgeMs: judgeEndTime - reviewEndTime,
      totalMs: judgeEndTime - startTime,
    };

    const metadata: ReviewMetadata = {
      config: {
        reviewerModel,
        judgeModel,
        reviewLevel: team.level,
        reviewLevelReason: `auto, ${diff.totalAdditions + diff.totalDeletions} lines`,
        teamAgents: result.agentNames,
        memoryEnabled: config.memory?.enabled ?? false,
        memoryRepo: config.memory?.repo ?? '',
      },
      judgeDecisions,
      timing,
    };

    await updateProgressComment(octokit, owner, repo, progressCommentId, completeDashboard, metadata);

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
  } catch (error) {
    if (dashboardFlushTimer) {
      clearTimeout(dashboardFlushTimer);
      dashboardFlushTimer = null;
    }
    const msg = error instanceof Error ? error.message : String(error);
    core.warning(`Review failed: ${msg}`);

    if (progressCommentId !== undefined) {
      await updateProgressComment(octokit, owner, repo, progressCommentId, {
        phase: 'complete',
        lineCount: 0,
        agentCount: 0,
      });
    }
  }
}

async function handleReviewStateCheck(): Promise<void> {
  const octokit = await getOctokit();

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

  let configContent: string | null = null;
  if (configPathInput) {
    configContent = await fetchConfigFile(octokit, owner, repo, pr.base.ref, configPathInput);
  } else {
    configContent = await fetchConfigFile(octokit, owner, repo, pr.base.ref, '.manki.yml');
  }
  const config = loadConfig(configContent ?? undefined);

  if (!config.auto_approve) {
    core.info('auto_approve is disabled — skipping state check');
    return;
  }

  const approved = await checkAndAutoApprove(octokit, owner, repo, prNumber, config);
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

  const octokit = await getOctokit();

  const { owner, repo } = github.context.repo;
  const prNumber = github.context.payload.issue?.number;
  if (!prNumber) return;

  let baseRef = 'main';
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: prNumber });
  baseRef = pr.base.ref;

  let configContent: string | null = null;
  if (configPathInput) {
    configContent = await fetchConfigFile(octokit, owner, repo, baseRef, configPathInput);
  } else {
    configContent = await fetchConfigFile(octokit, owner, repo, baseRef, '.manki.yml');
  }
  const config = loadConfig(configContent ?? undefined);

  const built = buildLLMClientFromInputs({ inputs: providerInputs, model: resolveModel(config, 'judge') });
  if (!built) return;
  const { client } = built;

  const memoryConfig = config.memory?.enabled ? config.memory : undefined;
  const memoryToken = config.memory?.enabled ? getMemoryToken(octokitCache.resolvedToken) ?? undefined : undefined;

  await handlePRComment(octokit, client, owner, repo, prNumber, memoryConfig, memoryToken, config);
}

async function handleIssueInteraction(): Promise<void> {
  const payload = github.context.payload;
  const comment = payload.comment;
  if (!comment) return;

  if (comment.user?.type === 'Bot' || comment.body?.includes('<!-- manki')) return;

  const { owner, repo } = github.context.repo;
  const issueNumber = payload.issue?.number;
  if (!issueNumber) return;

  const octokit = await getOctokit();
  const configPathInput = core.getInput('config_path');

  let configContent: string | null = null;
  if (configPathInput) {
    configContent = await fetchConfigFile(octokit, owner, repo, 'main', configPathInput);
  } else {
    configContent = await fetchConfigFile(octokit, owner, repo, 'main', '.manki.yml');
  }
  const config = loadConfig(configContent ?? undefined);

  const memoryConfig = config.memory?.enabled ? config.memory : undefined;
  const memoryToken = config.memory?.enabled ? getMemoryToken(octokitCache.resolvedToken) ?? undefined : undefined;

  await handlePRComment(octokit, null, owner, repo, issueNumber, memoryConfig, memoryToken, config);
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

  const octokit = await getOctokit();
  const { owner, repo } = github.context.repo;

  const baseRef = payload.pull_request?.base?.ref ?? 'main';
  let configContent: string | null = null;
  if (configPathInput) {
    configContent = await fetchConfigFile(octokit, owner, repo, baseRef, configPathInput);
  } else {
    configContent = await fetchConfigFile(octokit, owner, repo, baseRef, '.manki.yml');
  }
  const config = loadConfig(configContent ?? undefined);

  const built = buildLLMClientFromInputs({ inputs: providerInputs, model: resolveModel(config, 'judge') });
  if (!built) return;
  const { client } = built;

  const memoryConfig = config.memory?.enabled ? config.memory : undefined;
  const memoryToken = config.memory?.enabled ? getMemoryToken(octokitCache.resolvedToken) ?? undefined : undefined;

  const command = parseCommand(body);
  if (command.type !== 'generic') {
    const prNumber = payload.pull_request?.number;
    if (prNumber) {
      await handleReviewCommentCommand(octokit, owner, repo, prNumber, comment.id, command, memoryConfig, memoryToken);
    } else {
      core.warning('Cannot handle command — pull request number not available');
    }
  } else {
    const prNumber = payload.pull_request?.number;
    if (!prNumber) {
      core.warning('Cannot handle reply — pull request number not available');
      return;
    }
    await handleReviewCommentReply(octokit, client, owner, repo, prNumber, memoryConfig, memoryToken);
  }

  // Check if all review threads are now resolved (e.g. the reply resolved the last conversation)
  const prNum = payload.pull_request?.number;
  if (prNum && config.auto_approve) {
    const approved = await checkAndAutoApprove(octokit, owner, repo, prNum, config);
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
  const prNumber = pr?.number;
  if (!prNumber) {
    core.info('Post-cleanup: no PR number in event payload — skipping');
    return;
  }
  const { owner, repo } = github.context.repo;
  const runId = github.context.runId;
  try {
    const octokit = await getOctokit();
    const marked = await markOwnProgressCommentCancelled(octokit, owner, repo, prNumber, runId);
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
  process.on('SIGTERM', () => {
    core.info('Received SIGTERM — exiting gracefully');
  });

  process.on('SIGINT', () => {
    core.info('Received SIGINT — exiting gracefully');
  });

  // Dispatch: the same bundle is used for `main` and `post` in action.yml.
  // `core.saveState` sets a STATE_<key> env var that only reaches the post step,
  // so its presence indicates we're in the post phase.
  const isPostPhase = core.getState(POST_PHASE_STATE_KEY) === 'true';

  try {
    if (isPostPhase) {
      await postCleanup();
    } else {
      core.saveState(POST_PHASE_STATE_KEY, 'true');
      await run();
    }
  } catch (error) {
    core.warning(`Manki encountered an error: ${error}`);
  }
  // Let Node exit naturally. `core.setFailed` sets `process.exitCode = 1` which
  // propagates to GitHub Actions so the `post-if: failure()` condition fires.
  // Calling `process.exit()` here would force-terminate and override that signal.
}

// Only auto-run when executed directly (not imported for testing)
if (process.env.NODE_ENV !== 'test') {
  main();
}

function _resetOctokitCache(): void {
  octokitCache.instance = null;
  octokitCache.resolvedToken = null;
  octokitCache.identity = null;
}

export { run, handlePullRequest, handleCommentTrigger, handleInteraction, handleIssueInteraction, handleReviewCommentInteraction, handleReviewStateCheck, runFullReview, main, _resetOctokitCache };
