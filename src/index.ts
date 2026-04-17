import * as core from '@actions/core';
import * as github from '@actions/github';

import { createAuthenticatedOctokit, getMemoryToken } from './auth';
import { ClaudeClient } from './claude';
import { loadConfig, resolveModel } from './config';
import { parsePRDiff, filterFiles, isDiffTooLarge } from './diff';
import { handleReviewCommentReply, handleReviewCommentCommand, handlePRComment, isReviewRequest, isBotMentionNonReview, hasBotMention, parseCommand, isLLMAccessAllowed } from './interaction';
import { appendHandoverRound, loadHandover, loadMemory, applyEscalations, updatePattern, RepoMemory } from './memory';
import { classifyAuthorReply, fetchRecapState, fingerprintFinding } from './recap';
import { runReview, determineVerdict, selectTeam } from './review';
import { DEFENSIVE_HARDENING_TAG, DashboardData, PrContext, PrHandover, ReviewMetadata, ReviewStats, VerdictReason } from './types';
import {
  fetchPRDiff,
  fetchConfigFile,
  fetchRepoContext,
  fetchSubdirClaudeMd,
  fetchFileContents,
  postProgressComment,
  updateProgressComment,
  updateProgressDashboard,
  dismissPreviousReviews,
  postReview,
  createNitIssue,
  reactToIssueComment,
  fetchLinkedIssues,
  BOT_LOGIN,
  BOT_MARKER as PROGRESS_MARKER,
  FORCE_REVIEW_MARKER,
  isReviewInProgress,
  isApprovedOnCommit,
  markOwnProgressCommentCancelled,
  postAppWarningIfNeeded,
  cancelActiveReviewRun,
} from './github';
import { checkAndAutoApprove, resolveStaleThreads } from './state';

type Octokit = ReturnType<typeof github.getOctokit>;

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
    const isForceReview = action === 'edited' &&
      body.includes(FORCE_REVIEW_MARKER) && body.includes('- [x] Force review');
    if (!isForceReview && !hasBotMention(body) && !isReviewRequest(body)) {
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
      const forceReviewChecked = action === 'edited' && commentBody.includes(FORCE_REVIEW_MARKER) && commentBody.includes('- [x] Force review');
      if (forceReviewChecked && github.context.payload.issue?.pull_request) {
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
    // Update an existing skip comment instead of creating a duplicate
    const { data: comments } = await octokit.rest.issues.listComments({
      owner, repo, issue_number: prNumber, per_page: 100, direction: 'desc',
    });
    const existing = comments.find(c =>
      c.user?.login === BOT_LOGIN &&
      c.user?.type === 'Bot' &&
      c.body?.includes(PROGRESS_MARKER) && c.body?.includes('Review skipped'),
    );
    if (existing) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body });
    } else {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
    }
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

  await runFullReview(owner, repo, prNumber, commitSha, pr.base.ref, prContext);
}

async function handleCommentTrigger(forceReview?: boolean): Promise<void> {
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

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  if (!forceReview) {
    if (await isReviewInProgress(octokit, owner, repo, prNumber)) {
      const cancelled = await cancelActiveReviewRun(octokit, owner, repo, prNumber);
      if (cancelled) {
        core.info('Cancelled in-progress review — proceeding with new review');
      } else {
        core.info('Could not cancel in-progress review — proceeding anyway');
      }
    }

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

  await runFullReview(owner, repo, prNumber, pr.head.sha, pr.base.ref, prContext);
}

async function runFullReview(
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  baseRef: string,
  prContext?: PrContext,
): Promise<void> {
  core.info(`Starting review for ${owner}/${repo}#${prNumber}`);

  const oauthToken = core.getInput('claude_code_oauth_token');
  const apiKey = core.getInput('anthropic_api_key');

  if (!oauthToken && !apiKey) {
    core.setFailed('No API key configured — set claude_code_oauth_token or anthropic_api_key');
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

  const progressCommentId = await postProgressComment(octokit, owner, repo, prNumber);

  let dashboardFlushTimer: ReturnType<typeof setTimeout> | null = null;

  try {
    // Capture recap state before resolving stale threads so dedup sees
    // the original open/resolved status of each previous finding.
    const recap = await fetchRecapState(octokit, owner, repo, prNumber);

    const staleCount = await resolveStaleThreads(octokit, owner, repo, prNumber, commitSha);
    if (staleCount > 0) {
      core.info(`Resolved ${staleCount} stale review threads from previous commits`);
    }

    let configContent: string | null = null;
    if (configPathInput) {
      configContent = await fetchConfigFile(octokit, owner, repo, baseRef, configPathInput);
    } else {
      configContent = await fetchConfigFile(octokit, owner, repo, baseRef, '.manki.yml');
    }
    const config = loadConfig(configContent ?? undefined);

    if (github.context.eventName === 'pull_request' && !config.auto_review) {
      core.info('auto_review is disabled — skipping');
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: progressCommentId });
      return;
    }

    const authOptions = {
      oauthToken: oauthToken || undefined,
      apiKey: apiKey || undefined,
    };
    const plannerModel = resolveModel(config, 'planner');
    const reviewerModel = resolveModel(config, 'reviewer');
    const judgeModel = resolveModel(config, 'judge');
    const dedupModel = resolveModel(config, 'dedup');
    core.info(`Models — planner: ${plannerModel}, reviewer: ${reviewerModel}, judge: ${judgeModel}, dedup: ${dedupModel}`);

    const reviewerClient = new ClaudeClient({ ...authOptions, model: reviewerModel });
    const judgeClient = new ClaudeClient({ ...authOptions, model: judgeModel });
    const plannerClient = config.planner?.enabled !== false
      ? new ClaudeClient({ ...authOptions, model: plannerModel })
      : undefined;
    const dedupClient = new ClaudeClient({ ...authOptions, model: dedupModel });

    const rawDiff = await fetchPRDiff(octokit, owner, repo, prNumber);
    const diff = parsePRDiff(rawDiff);
    const parseEndTime = Date.now();
    const plannerEnabled = !!plannerClient && config.review_level === 'auto';
    const team = selectTeam(diff, config, config.reviewers);
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

    if (isDiffTooLarge(diff, config.max_diff_lines)) {
      core.warning(`Diff too large (${diff.totalAdditions + diff.totalDeletions} lines > ${config.max_diff_lines} max)`);
      const result = {
        verdict: 'COMMENT' as const,
        summary: `**Manki** — This PR is too large for automated review (${diff.totalAdditions + diff.totalDeletions} lines). Consider splitting it up or request a manual review.`,
        findings: [],
        highlights: [],
        reviewComplete: true,
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
      };
      await dismissPreviousReviews(octokit, owner, repo, prNumber);
      await postReview(octokit, owner, repo, prNumber, commitSha, result, diff);
      await updateProgressComment(octokit, owner, repo, progressCommentId, dashboard);
      return;
    }

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
    let handover: PrHandover | null = null;
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

        try {
          handover = await loadHandover(memoryOctokit, memoryRepo, repo, prNumber);
          if (handover) {
            core.info(`Loaded handover: ${handover.rounds.length} prior round(s)`);
          }
        } catch (error) {
          core.warning(`Failed to load handover for PR #${prNumber}: ${error}`);
        }
      }
    }

    const fullContext = [repoContext, recap.recapContext].filter(Boolean).join('\n\n');

    const isFollowUp = recap.previousFindings.length > 0;
    const openThreads = recap.previousFindings
      .filter(f => (f.status === 'open' || f.status === 'replied') && f.threadId)
      .map(f => ({
        threadId: f.threadId!,
        title: f.title,
        file: f.file,
        line: f.line,
        severity: f.severity,
      }));

    // Fetch full file contents for changed files so reviewers have surrounding context
    const filePaths = filteredFiles
      .filter(f => f.changeType !== 'deleted')
      .map(f => f.path);
    let fileContents: Map<string, string> | undefined;
    try {
      fileContents = await fetchFileContents(octokit, owner, repo, commitSha, filePaths);
    } catch (error) {
      core.warning(`Failed to fetch file contents: ${error}`);
    }

    let linkedIssues;
    if (prContext?.body) {
      try {
        linkedIssues = await fetchLinkedIssues(octokit, owner, repo, prContext.body);
        if (linkedIssues.length > 0) {
          core.info(`Fetched ${linkedIssues.length} linked issue(s) from PR body`);
        }
      } catch (error) {
        core.warning(`Failed to fetch linked issues: ${error}`);
      }
    }

    await dismissPreviousReviews(octokit, owner, repo, prNumber);

    let reviewEndTime = parseEndTime;

    function scheduleDashboardFlush(): void {
      if (dashboardFlushTimer) clearTimeout(dashboardFlushTimer);
      dashboardFlushTimer = setTimeout(() => {
        dashboardFlushTimer = null;
        updateProgressDashboard(octokit, owner, repo, progressCommentId, dashboard)
          .catch(err => core.warning(`Failed to update dashboard: ${err}`));
      }, 500);
    }

    const result = await runReview(
      { reviewer: reviewerClient, judge: judgeClient, planner: plannerClient, dedup: dedupClient }, config, diff, rawDiff, fullContext,
      memory, fileContents, prContext, linkedIssues,
      (progress) => {
        if (progress.phase === 'planning') {
          core.info('Planner analyzing PR content...');
          if (progress.plannerResult) {
            dashboard.plannerInfo = {
              teamSize: progress.plannerResult.teamSize,
              reviewerEffort: progress.plannerResult.reviewerEffort,
              judgeEffort: progress.plannerResult.judgeEffort,
              prType: progress.plannerResult.prType,
            };
            const plannerTeam = selectTeam(diff, config, config.reviewers, progress.plannerResult.teamSize, progress.plannerResult.agents);
            dashboard.agentCount = plannerTeam.agents.length;
            dashboard.agentProgress = plannerTeam.agents.map(a => ({ name: a.name, status: 'reviewing' as const }));
            dashboard.plannerDurationMs = progress.plannerDurationMs;
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
          updateProgressDashboard(octokit, owner, repo, progressCommentId, dashboard)
            .catch(err => core.warning(`Failed to update dashboard: ${err}`));
        } else if (progress.phase === 'judging') {
          if (dashboardFlushTimer) {
            clearTimeout(dashboardFlushTimer);
            dashboardFlushTimer = null;
          }
          dashboard.phase = 'reviewed';
          dashboard.rawFindingCount = progress.rawFindingCount;
          dashboard.judgeInputCount = progress.judgeInputCount;
          updateProgressDashboard(octokit, owner, repo, progressCommentId, dashboard)
            .catch(err => core.warning(`Failed to update dashboard: ${err}`));
        }
      },
      isFollowUp,
      openThreads,
      recap.previousFindings,
      handover?.rounds,
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

    const priorFindingsFlat = handover?.rounds.flatMap(r => r.findings) ?? [];
    if (memory && memory.patterns.length > 0) {
      result.findings = applyEscalations(result.findings, memory.patterns);
      result.verdict = determineVerdict(result.findings, priorFindingsFlat).verdict;
    }
    const verdictReason: VerdictReason = determineVerdict(result.findings, priorFindingsFlat).verdictReason;

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

    // Route findings based on nit_handling config:
    // - required + suggestion: always go to inline PR comments
    // - nit: inline comments if nit_handling === 'comments', nit issue if 'issues'
    const nitHandling = config.nit_handling ?? 'issues';
    const nitFindings = result.findings.filter(f => f.severity === 'nit');
    const inlineFindings = nitHandling === 'comments'
      ? result.findings
      : result.findings.filter(f => f.severity !== 'nit');

    const reviewTimeMs = Date.now() - startTime;
    const severityMap: Record<string, number> = { required: 0, suggestion: 0, nit: 0 };
    for (const f of result.findings) {
      if (f.severity in severityMap) severityMap[f.severity]++;
    }

    // Per-agent metrics: count raw and kept findings per agent
    const agentNames = result.agentNames ?? [];
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
    let judgeMetrics: ReviewStats['judgeMetrics'];
    if (allJudged.length > 0) {
      const confidenceDistribution = { high: 0, medium: 0, low: 0 };
      for (const f of allJudged) {
        if (f.judgeConfidence) confidenceDistribution[f.judgeConfidence]++;
      }
      const severityChanges = allJudged.filter(f => f.judgeNotes).length;
      const mergedDuplicates = (result.rawFindingCount ?? 0)
        - (result.suppressionCount ?? 0)
        - (result.staticDedupCount ?? 0)
        - (result.llmDedupCount ?? 0)
        - allJudged.length;
      const defensiveHardeningCount = allJudged.filter(f => f.tags?.includes(DEFENSIVE_HARDENING_TAG)).length;
      judgeMetrics = {
        confidenceDistribution,
        severityChanges,
        mergedDuplicates,
        ...(defensiveHardeningCount > 0 && { defensiveHardeningCount }),
        verdictReason,
      };
    }

    // File analysis metrics
    const fileTypes: Record<string, number> = {};
    for (const file of filteredFiles) {
      const dotIdx = file.path.lastIndexOf('.');
      const ext = dotIdx !== -1 ? file.path.slice(dotIdx) : '(none)';
      fileTypes[ext] = (fileTypes[ext] ?? 0) + 1;
    }
    const findingsPerFile: Record<string, number> = {};
    for (const f of result.findings) {
      if (f.file) findingsPerFile[f.file] = (findingsPerFile[f.file] ?? 0) + 1;
    }
    const fileMetrics = { fileTypes, findingsPerFile };

    const stats: ReviewStats = {
      model: reviewerModel,
      reviewTimeMs,
      diffLines: diff.totalAdditions + diff.totalDeletions,
      diffAdditions: diff.totalAdditions,
      diffDeletions: diff.totalDeletions,
      filesReviewed: filteredFiles.length,
      agents: result.agentNames ?? [],
      findingsRaw: result.rawFindingCount ?? result.findings.length,
      findingsKept: result.findings.length,
      findingsDropped: (result.rawFindingCount ?? result.findings.length) - result.findings.length,
      severity: severityMap,
      verdict: result.verdict,
      prNumber,
      commitSha,
      agentMetrics,
      judgeMetrics,
      fileMetrics,
      reviewerModel,
      judgeModel,
    };

    // Resolve threads the judge identified as addressed
    if (result.resolveThreads && result.resolveThreads.length > 0) {
      const knownThreadIds = new Set(openThreads.map(t => t.threadId));
      for (const { threadId, reason } of result.resolveThreads) {
        if (!knownThreadIds.has(threadId)) {
          core.debug(`Skipping unknown thread ${threadId} — not in openThreads allowlist`);
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

    const reviewResult = { ...result, findings: inlineFindings };
    const reviewId = await postReview(octokit, owner, repo, prNumber, commitSha, reviewResult, diff, stats);

    if (nitHandling === 'issues' && nitFindings.length > 0) {
      try {
        await createNitIssue(octokit, owner, repo, prNumber, nitFindings, commitSha);
      } catch (error) {
        core.warning(`Failed to create nit issue: ${error}`);
      }
    }

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

        try {
          await appendHandoverRound(
            memoryOctokit,
            memoryRepo,
            repo,
            prNumber,
            commitSha,
            result.findings,
            recap.previousFindings,
            result.summary,
            fingerprintFinding,
            classifyAuthorReply,
            handover,
          );
        } catch (error) {
          core.warning(`Failed to write handover for PR #${prNumber}: ${error}`);
        }
      }
    }

    if (result.plannerResult) {
      dashboard.plannerInfo = {
        teamSize: result.plannerResult.teamSize,
        reviewerEffort: result.plannerResult.reviewerEffort,
        judgeEffort: result.plannerResult.judgeEffort,
        prType: result.plannerResult.prType,
      };
      dashboard.agentCount = result.agentNames?.length ?? dashboard.agentCount;
      dashboard.agentProgress = result.agentNames?.map(name => {
        const existing = dashboard.agentProgress?.find(a => a.name === name);
        return existing ?? { name, status: 'done' as const };
      });
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
    for (const d of judgeDecisions) {
      if (d.kept) {
        keptSeverities[d.severity] = (keptSeverities[d.severity] ?? 0) + 1;
      } else {
        droppedSeverities[d.originalSeverity] = (droppedSeverities[d.originalSeverity] ?? 0) + 1;
      }
    }

    const judgeDroppedCount = judgeDecisions.filter(d => !d.kept).length;
    const completeDashboard: DashboardData = {
      ...dashboard,
      phase: 'complete',
      keptCount: result.findings.length,
      droppedCount: judgeDroppedCount,
      keptSeverities,
      droppedSeverities,
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
        teamAgents: result.agentNames ?? team.agents.map(a => a.name),
        memoryEnabled: config.memory?.enabled ?? false,
        memoryRepo: config.memory?.repo ?? '',
        nitHandling,
      },
      judgeDecisions,
      timing,
    };

    await updateProgressComment(octokit, owner, repo, progressCommentId, completeDashboard, metadata);

    core.setOutput('review_id', reviewId.toString());
    core.setOutput('verdict', result.verdict);
    core.setOutput('findings_count', result.findings.length.toString());
    core.setOutput('findings_json', JSON.stringify(result.findings));

    const severityCounts = { required: 0, suggestion: 0, nit: 0, ignore: 0 };
    for (const f of result.findings) {
      severityCounts[f.severity]++;
    }
    core.setOutput('severity_counts', JSON.stringify(severityCounts));

    core.setOutput('judge_model', judgeModel);

    core.info(`Review complete: ${result.verdict} with ${result.findings.length} findings`);
    core.info(`Severity breakdown: ${severityCounts.required} required, ${severityCounts.suggestion} suggestion, ${severityCounts.nit} nit, ${severityCounts.ignore} ignore`);
  } catch (error) {
    if (dashboardFlushTimer) {
      clearTimeout(dashboardFlushTimer);
      dashboardFlushTimer = null;
    }
    const msg = error instanceof Error ? error.message : String(error);
    core.warning(`Review failed: ${msg}`);

    await updateProgressComment(octokit, owner, repo, progressCommentId, {
      phase: 'complete',
      lineCount: 0,
      agentCount: 0,
    });
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

  const approved = await checkAndAutoApprove(octokit, owner, repo, prNumber);
  if (approved) {
    core.info(`PR #${prNumber} auto-approved after all findings resolved`);
  }
}


async function handleInteraction(): Promise<void> {
  const oauthToken = core.getInput('claude_code_oauth_token');
  const apiKey = core.getInput('anthropic_api_key');
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

  const interactionModel = resolveModel(config, 'judge');
  const claude = new ClaudeClient({
    oauthToken: oauthToken || undefined,
    apiKey: apiKey || undefined,
    model: interactionModel,
  });

  const memoryConfig = config.memory?.enabled ? config.memory : undefined;
  const memoryToken = config.memory?.enabled ? getMemoryToken(octokitCache.resolvedToken) ?? undefined : undefined;

  await handlePRComment(octokit, claude, owner, repo, prNumber, memoryConfig, memoryToken, config);
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

  const oauthToken = core.getInput('claude_code_oauth_token');
  const apiKey = core.getInput('anthropic_api_key');
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

  const claude = new ClaudeClient({
    oauthToken: oauthToken || undefined,
    apiKey: apiKey || undefined,
    model: resolveModel(config, 'judge'),
  });

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
    await handleReviewCommentReply(octokit, claude, owner, repo, prNumber, memoryConfig, memoryToken);
  }

  // Check if all review threads are now resolved (e.g. the reply resolved the last conversation)
  const prNum = payload.pull_request?.number;
  if (prNum && config.auto_approve) {
    const approved = await checkAndAutoApprove(octokit, owner, repo, prNum);
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
