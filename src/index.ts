import * as core from '@actions/core';
import * as github from '@actions/github';

import { ClaudeClient } from './claude';
import { loadConfig } from './config';
import { parsePRDiff, filterFiles, isDiffTooLarge } from './diff';
import { handleReviewCommentReply, handlePRComment } from './interaction';
import { loadMemory, buildMemoryContext, applySuppressions, RepoMemory } from './memory';
import { runReview, determineVerdict } from './review';
import {
  fetchPRDiff,
  fetchConfigFile,
  fetchRepoContext,
  postProgressComment,
  updateProgressComment,
  dismissPreviousReviews,
  postReview,
} from './github';
import { checkAndAutoApprove } from './state';

async function run(): Promise<void> {
  try {
    const eventName = github.context.eventName;
    const action = github.context.payload.action;

    core.info(`Event: ${eventName}, Action: ${action}`);

    switch (eventName) {
      case 'pull_request':
        if (action === 'opened' || action === 'synchronize') {
          await handlePullRequest();
        }
        break;

      case 'issue_comment':
        if (action === 'created') {
          if (isClaudeReviewRequest()) {
            await handleCommentTrigger();
          } else if (hasClaudeMention()) {
            await handleInteraction();
          }
        }
        break;

      case 'pull_request_review_comment':
        if (action === 'created') {
          await handleReviewCommentInteraction();
        }
        break;

      case 'pull_request_review':
        if (action === 'submitted' || action === 'dismissed') {
          core.info('Review submitted/dismissed — checking if auto-approve is warranted');
          await handleReviewStateCheck();
        }
        break;

      default:
        core.info(`Unhandled event: ${eventName}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    }
  }
}

async function handlePullRequest(): Promise<void> {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.setFailed('No pull request found in event payload');
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

  await runFullReview(owner, repo, prNumber, commitSha, pr.base.ref);
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

  const githubToken = core.getInput('github_token', { required: true });
  const octokit = github.getOctokit(githubToken);

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
  });

  await runFullReview(owner, repo, prNumber, pr.head.sha, pr.base.ref);
}

async function runFullReview(
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  baseRef: string,
): Promise<void> {
  core.info(`Starting review for ${owner}/${repo}#${prNumber}`);

  const githubToken = core.getInput('github_token', { required: true });
  const oauthToken = core.getInput('claude_code_oauth_token');
  const apiKey = core.getInput('anthropic_api_key');
  const configPath = core.getInput('config_path') || '.claude-review.yml';
  const modelOverride = core.getInput('model');

  const octokit = github.getOctokit(githubToken);

  const progressCommentId = await postProgressComment(octokit, owner, repo, prNumber);

  try {
    const configContent = await fetchConfigFile(octokit, owner, repo, baseRef, configPath);
    const config = loadConfig(configContent ?? undefined);

    if (modelOverride) {
      config.model = modelOverride;
    }

    if (github.context.eventName === 'pull_request' && !config.auto_review) {
      core.info('auto_review is disabled — skipping');
      await octokit.rest.issues.deleteComment({ owner, repo, comment_id: progressCommentId });
      return;
    }

    const claude = new ClaudeClient({
      oauthToken: oauthToken || undefined,
      apiKey: apiKey || undefined,
      model: config.model,
    });

    const rawDiff = await fetchPRDiff(octokit, owner, repo, prNumber);
    const diff = parsePRDiff(rawDiff);

    if (isDiffTooLarge(diff, config.max_diff_lines)) {
      core.warning(`Diff too large (${diff.totalAdditions + diff.totalDeletions} lines > ${config.max_diff_lines} max)`);
      await updateProgressComment(octokit, owner, repo, progressCommentId, {
        verdict: 'COMMENT',
        summary: `Diff too large for automated review (${diff.totalAdditions + diff.totalDeletions} lines). Please request a manual review.`,
        findings: [],
        highlights: [],
      });
      return;
    }

    const filteredFiles = filterFiles(diff.files, config.include_paths, config.exclude_paths);
    core.info(`Reviewing ${filteredFiles.length} files (${diff.files.length} total, ${diff.files.length - filteredFiles.length} filtered out)`);

    if (filteredFiles.length === 0) {
      core.info('No reviewable files in diff');
      await updateProgressComment(octokit, owner, repo, progressCommentId, {
        verdict: 'APPROVE',
        summary: 'No reviewable files in this PR (all filtered out by config).',
        findings: [],
        highlights: [],
      });
      return;
    }

    const repoContext = await fetchRepoContext(octokit, owner, repo, baseRef);

    let memory: RepoMemory | null = null;
    let memoryContext = '';
    if (config.memory.enabled) {
      const memoryToken = core.getInput('memory_repo_token') || githubToken;
      const memoryOctokit = github.getOctokit(memoryToken);
      const memoryRepo = config.memory.repo || `${owner}/review-memory`;

      try {
        memory = await loadMemory(memoryOctokit, memoryRepo, repo);
        memoryContext = buildMemoryContext(memory);
        core.info(`Loaded memory: ${memory.learnings.length} learnings, ${memory.suppressions.length} suppressions`);
      } catch (error) {
        core.warning(`Failed to load review memory: ${error}`);
      }
    }

    await dismissPreviousReviews(octokit, owner, repo, prNumber);

    const result = await runReview(claude, config, diff, rawDiff, repoContext, memoryContext);

    if (memory && memory.suppressions.length > 0) {
      const { kept, suppressed } = applySuppressions(result.findings, memory.suppressions);
      if (suppressed.length > 0) {
        core.info(`Suppressed ${suppressed.length} findings based on memory`);
        result.findings = kept;
        result.verdict = determineVerdict(undefined, result.findings);
      }
    }

    const reviewId = await postReview(octokit, owner, repo, prNumber, commitSha, result);

    await updateProgressComment(octokit, owner, repo, progressCommentId, result);

    core.setOutput('review_id', reviewId.toString());
    core.setOutput('verdict', result.verdict);
    core.setOutput('findings_count', result.findings.length.toString());
    core.setOutput('findings_json', JSON.stringify(result.findings));

    core.info(`Review complete: ${result.verdict} with ${result.findings.length} findings`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    core.setFailed(`Review failed: ${msg}`);

    await updateProgressComment(octokit, owner, repo, progressCommentId, {
      verdict: 'COMMENT',
      summary: `Review failed: ${msg}`,
      findings: [],
      highlights: [],
    });
  }
}

async function handleReviewStateCheck(): Promise<void> {
  const token = core.getInput('github_token', { required: true });
  const octokit = github.getOctokit(token);

  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.info('No pull request in payload — skipping auto-approve check');
    return;
  }

  const { owner, repo } = github.context.repo;
  const prNumber = pr.number;

  const approved = await checkAndAutoApprove(octokit, owner, repo, prNumber);
  if (approved) {
    core.info(`PR #${prNumber} auto-approved after all blocking issues resolved`);
  }
}

function isClaudeReviewRequest(): boolean {
  const comment = github.context.payload.comment;
  if (!comment) return false;

  const body = comment.body?.toLowerCase() ?? '';
  return body.includes('@claude') && body.includes('review');
}

function hasClaudeMention(): boolean {
  const comment = github.context.payload.comment;
  if (!comment) return false;

  const body = comment.body?.toLowerCase() ?? '';
  return body.includes('@claude') && !body.includes('review');
}

async function handleInteraction(): Promise<void> {
  const githubToken = core.getInput('github_token', { required: true });
  const oauthToken = core.getInput('claude_code_oauth_token');
  const apiKey = core.getInput('anthropic_api_key');
  const modelOverride = core.getInput('model');

  const octokit = github.getOctokit(githubToken);
  const claude = new ClaudeClient({
    oauthToken: oauthToken || undefined,
    apiKey: apiKey || undefined,
    model: modelOverride || 'claude-opus-4-6',
  });

  await handlePRComment(octokit, claude);
}

async function handleReviewCommentInteraction(): Promise<void> {
  const githubToken = core.getInput('github_token', { required: true });
  const oauthToken = core.getInput('claude_code_oauth_token');
  const apiKey = core.getInput('anthropic_api_key');
  const modelOverride = core.getInput('model');

  const octokit = github.getOctokit(githubToken);
  const claude = new ClaudeClient({
    oauthToken: oauthToken || undefined,
    apiKey: apiKey || undefined,
    model: modelOverride || 'claude-opus-4-6',
  });

  await handleReviewCommentReply(octokit, claude);
}

run();
