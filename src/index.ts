import * as core from '@actions/core';
import * as github from '@actions/github';

import { createAuthenticatedOctokit, getMemoryToken } from './auth';
import { ClaudeClient } from './claude';
import { loadConfig, resolveModel } from './config';
import { parsePRDiff, filterFiles, isDiffTooLarge } from './diff';
import { handleReviewCommentReply, handlePRComment, isReviewRequest, isBotMentionNonReview, hasBotMention } from './interaction';
import { loadMemory, applyEscalations, updatePattern, RepoMemory } from './memory';
import { fetchRecapState, deduplicateFindings, buildRecapSummary, resolveAddressedThreads } from './recap';
import { runReview, determineVerdict, selectTeam } from './review';
import { DashboardData, PrContext, ReviewMetadata, ReviewStats } from './types';
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
} from './github';
import { checkAndAutoApprove, resolveStaleThreads } from './state';

type Octokit = ReturnType<typeof github.getOctokit>;

let cachedOctokit: Octokit | null = null;

async function getOctokit(): Promise<Octokit> {
  if (!cachedOctokit) {
    cachedOctokit = await createAuthenticatedOctokit();
  }
  return cachedOctokit;
}

async function run(): Promise<void> {
  const eventName = github.context.eventName;
  const action = github.context.payload.action;

  core.info(`Event: ${eventName}, Action: ${action}`);

  // Prevent self-triggering — skip events caused by our own bot
  const actor = github.context.payload.sender?.login ?? '';
  if (actor === 'manki-labs[bot]' || actor === 'github-actions[bot]') {
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
    if (action !== 'created') {
      core.info(`Ignoring issue_comment action: ${action}`);
      return;
    }
    const body = github.context.payload.comment?.body ?? '';
    if (!hasBotMention(body) && !isReviewRequest(body)) {
      core.info('Comment does not mention Manki — ignoring');
      return;
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
      if (isReviewRequest(commentBody) && github.context.payload.issue?.pull_request) {
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

  const prContext: PrContext = {
    title: pr.title,
    body: pr.body || '',
    baseBranch: pr.base.ref,
  };

  await runFullReview(owner, repo, prNumber, commitSha, pr.base.ref, prContext);
}

async function handleCommentTrigger(): Promise<void> {
  const payload = github.context.payload;

  if (!payload.issue?.pull_request) {
    core.info('Comment is on an issue, not a PR — skipping');
    return;
  }

  const owner = github.context.repo.owner;
  const repo = github.context.repo.repo;
  const prNumber = payload.issue.number;

  const octokit = await getOctokit();

  // Acknowledge the review request
  if (payload.comment?.id) {
    await reactToIssueComment(octokit, owner, repo, payload.comment.id, 'eyes');
  }

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

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
  const startTime = Date.now();

  const oauthToken = core.getInput('claude_code_oauth_token');
  const apiKey = core.getInput('anthropic_api_key');
  const configPathInput = core.getInput('config_path');
  const modelOverride = core.getInput('model');

  const octokit = await getOctokit();

  const progressCommentId = await postProgressComment(octokit, owner, repo, prNumber);

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

    if (modelOverride) {
      config.model = modelOverride;
      config.models = { reviewer: modelOverride, judge: modelOverride };
    }

    if (github.context.eventName === 'pull_request' && !config.auto_review) {
      core.info('auto_review is disabled — skipping');
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: progressCommentId });
      return;
    }

    const authOptions = {
      oauthToken: oauthToken || undefined,
      apiKey: apiKey || undefined,
    };
    const reviewerModel = resolveModel(config, 'reviewer');
    const judgeModel = resolveModel(config, 'judge');
    core.info(`Models — reviewer: ${reviewerModel}, judge: ${judgeModel}`);

    const reviewerClient = new ClaudeClient({ ...authOptions, model: reviewerModel });
    const judgeClient = new ClaudeClient({ ...authOptions, model: judgeModel });

    const rawDiff = await fetchPRDiff(octokit, owner, repo, prNumber);
    const diff = parsePRDiff(rawDiff);
    const parseEndTime = Date.now();
    const team = selectTeam(diff, config, config.reviewers);
    const lineCount = diff.totalAdditions + diff.totalDeletions;

    const dashboard: DashboardData = {
      phase: 'started',
      lineCount,
      agentCount: team.agents.length,
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

    const filteredFiles = filterFiles(diff.files, config.include_paths, config.exclude_paths);
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
    if (config.memory?.enabled) {
      const memoryToken = getMemoryToken();
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

    if (recap.previousFindings.length > 0) {
      const autoResolved = await resolveAddressedThreads(
        octokit, judgeClient, owner, repo, prNumber,
        recap.previousFindings, diff,
      );
      if (autoResolved > 0) {
        core.info(`Auto-resolved ${autoResolved} findings addressed in latest push`);
      }
    }

    const fullContext = [repoContext, recap.recapContext].filter(Boolean).join('\n\n');

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

    let rawFindingCount = 0;
    let reviewEndTime = parseEndTime;
    const result = await runReview(
      { reviewer: reviewerClient, judge: judgeClient }, config, diff, rawDiff, fullContext,
      memory, fileContents, prContext, linkedIssues,
      (progress) => {
        rawFindingCount = progress.rawFindingCount;
        reviewEndTime = Date.now();
        dashboard.phase = 'reviewed';
        dashboard.rawFindingCount = progress.rawFindingCount;
        updateProgressDashboard(octokit, owner, repo, progressCommentId, dashboard)
          .catch(err => core.warning(`Failed to update dashboard: ${err}`));
      },
    );
    const judgeEndTime = Date.now();

    if (!result.reviewComplete && result.verdict === 'APPROVE') {
      result.verdict = 'COMMENT';
    }

    const { unique, duplicates } = deduplicateFindings(result.findings, recap.previousFindings, memory?.suppressions);
    if (duplicates.length > 0 || unique.length !== result.findings.length) {
      core.info(`Deduplicated ${duplicates.length} findings, ${result.findings.length - unique.length} total removed`);
      result.findings = unique;
      result.verdict = determineVerdict(result.findings);
    }

    if (memory && memory.patterns.length > 0) {
      result.findings = applyEscalations(result.findings, memory.patterns);
      result.verdict = determineVerdict(result.findings);
    }

    const resolved = recap.previousFindings.filter(f => f.status === 'resolved').length;
    const open = recap.previousFindings.filter(f => f.status === 'open').length;
    const recapSummary = buildRecapSummary(result.findings.length, duplicates.length, resolved, open);

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
    };

    const reviewResult = { ...result, findings: inlineFindings };
    const reviewId = await postReview(octokit, owner, repo, prNumber, commitSha, reviewResult, diff, stats, recapSummary);

    if (nitHandling === 'issues' && nitFindings.length > 0) {
      try {
        await createNitIssue(octokit, owner, repo, prNumber, nitFindings, commitSha);
      } catch (error) {
        core.warning(`Failed to create nit issue: ${error}`);
      }
    }

    if (memory && config.memory?.enabled) {
      const memoryToken = getMemoryToken();
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

    const droppedCount = rawFindingCount - result.findings.length;
    const completeDashboard: DashboardData = {
      phase: 'complete',
      lineCount,
      agentCount: team.agents.length,
      rawFindingCount,
      keptCount: result.findings.length,
      droppedCount: droppedCount >= 0 ? droppedCount : 0,
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
        teamAgents: team.agents.map(a => a.name),
        memoryEnabled: config.memory?.enabled ?? false,
        memoryRepo: config.memory?.repo ?? '',
        nitHandling,
      },
      judgeDecisions: (result.allJudgedFindings || result.findings).map(f => ({
        title: f.title,
        severity: f.severity,
        reasoning: f.judgeNotes || '',
        confidence: f.judgeConfidence || 'medium',
        kept: f.severity !== 'ignore',
      })),
      recap: {
        newFindings: result.findings.length,
        previouslyFlagged: recap.previousFindings.filter(f => f.status === 'open').length,
        resolved: recap.previousFindings.filter(f => f.status === 'resolved').length,
        suppressionsApplied: duplicates.length,
      },
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
    core.info(`PR #${prNumber} auto-approved after all required issues resolved`);
  }
}


async function handleInteraction(): Promise<void> {
  const oauthToken = core.getInput('claude_code_oauth_token');
  const apiKey = core.getInput('anthropic_api_key');
  const modelOverride = core.getInput('model');
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

  const interactionModel = modelOverride || resolveModel(config, 'judge');
  const claude = new ClaudeClient({
    oauthToken: oauthToken || undefined,
    apiKey: apiKey || undefined,
    model: interactionModel,
  });

  const memoryConfig = config.memory?.enabled ? config.memory : undefined;
  const memoryToken = config.memory?.enabled ? getMemoryToken() ?? undefined : undefined;

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
  const memoryToken = config.memory?.enabled ? getMemoryToken() ?? undefined : undefined;

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
  const memoryToken = config.memory?.enabled ? getMemoryToken() ?? undefined : undefined;

  await handleReviewCommentReply(octokit, claude, memoryConfig, memoryToken);

  if (config.auto_approve) {
    const prNumber = payload.pull_request?.number;
    if (prNumber) {
      await checkAndAutoApprove(octokit, owner, repo, prNumber);
    }
  }
}

async function main(): Promise<void> {
  process.on('SIGTERM', () => {
    core.info('Received SIGTERM — exiting gracefully');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    core.info('Received SIGINT — exiting gracefully');
    process.exit(0);
  });

  try {
    await run();
  } catch (error) {
    core.warning(`Manki encountered an error: ${error}`);
  }
  // Always exit 0 — the merge gate is the review approval, not the check status
  process.exit(0);
}

// Only auto-run when executed directly (not imported for testing)
if (process.env.NODE_ENV !== 'test') {
  main();
}

function _resetOctokitCache(): void {
  cachedOctokit = null;
}

export { run, handlePullRequest, handleCommentTrigger, handleInteraction, handleIssueInteraction, handleReviewCommentInteraction, handleReviewStateCheck, runFullReview, main, _resetOctokitCache };
