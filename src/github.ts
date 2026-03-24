import * as core from '@actions/core';
import * as github from '@actions/github';

import { Finding, ReviewResult, ReviewVerdict } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- claude-review-bot -->';

/**
 * Fetch the raw diff for a PR.
 */
export async function fetchPRDiff(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<string> {
  const { data } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: 'diff' },
  });
  return data as unknown as string;
}

/**
 * Fetch the config file content from the repo.
 */
export async function fetchConfigFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  configPath: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: configPath,
      ref,
    });
    if ('content' in data && data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf-8');
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch repo context (CLAUDE.md, README, etc.) for richer reviews.
 */
export async function fetchRepoContext(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  const contextFiles = ['CLAUDE.md', '.claude/CLAUDE.md'];
  const parts: string[] = [];

  for (const path of contextFiles) {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
      if ('content' in data && data.encoding === 'base64') {
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        parts.push(`## ${path}\n\n${content}`);
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  try {
    const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
    if (repoData.description) {
      parts.unshift(`Repository: ${repoData.full_name}\nDescription: ${repoData.description}`);
    }
  } catch {
    // Skip
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Post a "review in progress" comment on the PR.
 * Returns the comment ID so we can update/delete it later.
 */
export async function postProgressComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number> {
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: `${BOT_MARKER}\n🔍 **Claude Review** in progress...\n\nRunning specialist reviewer agents. This typically takes 1-3 minutes.`,
  });
  return data.id;
}

/**
 * Update the progress comment with the final summary.
 */
export async function updateProgressComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  result: ReviewResult,
): Promise<void> {
  const emoji = result.verdict === 'APPROVE' ? '✅' : result.verdict === 'REQUEST_CHANGES' ? '❌' : '💬';
  const findingsSummary = result.findings.length > 0
    ? `\n\n| Severity | Count |\n|---|---|\n| Blocking | ${result.findings.filter(f => f.severity === 'blocking').length} |\n| Suggestions | ${result.findings.filter(f => f.severity === 'suggestion').length} |\n| Questions | ${result.findings.filter(f => f.severity === 'question').length} |`
    : '';

  const highlights = result.highlights.length > 0
    ? `\n\n**Highlights:**\n${result.highlights.map(h => `- ${h}`).join('\n')}`
    : '';

  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: `${BOT_MARKER}\n${emoji} **Claude Review** — ${result.verdict.replace('_', ' ')}\n\n${result.summary}${findingsSummary}${highlights}`,
  });
}

/**
 * Dismiss any previous reviews from the bot on this PR.
 */
export async function dismissPreviousReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner,
    repo,
    pull_number: prNumber,
  });

  for (const review of reviews) {
    if (review.body?.includes(BOT_MARKER) && review.state !== 'DISMISSED') {
      try {
        await octokit.rest.pulls.dismissReview({
          owner,
          repo,
          pull_number: prNumber,
          review_id: review.id,
          message: 'Superseded by new review',
        });
        core.info(`Dismissed previous review #${review.id}`);
      } catch (e) {
        core.debug(`Could not dismiss review #${review.id}: ${e}`);
      }
    }
  }
}

/**
 * Post the review with inline comments.
 */
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  result: ReviewResult,
): Promise<number> {
  const event = mapVerdictToEvent(result.verdict);

  const comments = result.findings
    .filter(f => f.file && f.line > 0)
    .map(f => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT' as const,
      body: formatFindingComment(f),
    }));

  const body = `${BOT_MARKER}\n${result.summary}`;

  const { data: review } = await octokit.rest.pulls.createReview({
    owner,
    repo,
    pull_number: prNumber,
    commit_id: commitSha,
    event,
    body,
    comments,
  });

  core.info(`Posted review #${review.id} with verdict ${result.verdict} and ${comments.length} inline comments`);
  return review.id;
}

function mapVerdictToEvent(verdict: ReviewVerdict): 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' {
  switch (verdict) {
    case 'APPROVE': return 'APPROVE';
    case 'REQUEST_CHANGES': return 'REQUEST_CHANGES';
    case 'COMMENT': return 'COMMENT';
  }
}

function formatFindingComment(finding: Finding): string {
  const severityEmoji = finding.severity === 'blocking' ? '🚫' : finding.severity === 'suggestion' ? '💡' : '❓';
  const severityLabel = finding.severity === 'blocking' ? 'Blocking' : finding.severity === 'suggestion' ? 'Suggestion' : 'Question';

  let comment = `${severityEmoji} **${severityLabel}**: ${finding.title}\n\n${finding.description}`;

  if (finding.suggestedFix) {
    comment += `\n\n**Suggested fix:**\n\`\`\`suggestion\n${finding.suggestedFix}\n\`\`\``;
  }

  if (finding.reviewers.length > 0) {
    comment += `\n\n<sub>Flagged by: ${finding.reviewers.join(', ')}</sub>`;
  }

  comment += `\n\n<!-- claude-review:${finding.severity}:${finding.title.replace(/[^a-zA-Z0-9]/g, '-')} -->`;

  return comment;
}

export { formatFindingComment, mapVerdictToEvent, BOT_MARKER };
