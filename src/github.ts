import * as core from '@actions/core';
import * as github from '@actions/github';

import { Finding, ParsedDiff, ReviewResult, ReviewVerdict } from './types';
import { isLineInDiff, findClosestDiffLine } from './diff';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- manki-bot -->';

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
    body: `${BOT_MARKER}\n🔍 **Manki** review in progress...\n\nRunning specialist reviewer agents. This typically takes 1-3 minutes.`,
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
    body: `${BOT_MARKER}\n${emoji} **Manki** — ${result.verdict.replace('_', ' ')}\n\n${result.summary}${findingsSummary}${highlights}`,
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
    if (review.body?.includes(BOT_MARKER) && review.state === 'CHANGES_REQUESTED') {
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
  diff?: ParsedDiff,
): Promise<number> {
  const event = mapVerdictToEvent(result.verdict);

  // Validate and filter inline comments against the diff
  const validComments: Array<{path: string; line: number; side: 'RIGHT'; body: string}> = [];
  const invalidComments: string[] = [];

  for (const f of result.findings.filter(f => f.file && f.line > 0)) {
    const commentBody = formatFindingComment(f);

    if (diff) {
      const diffFile = diff.files.find(df => df.path === f.file);
      if (diffFile) {
        if (isLineInDiff(diffFile, f.line)) {
          validComments.push({ path: f.file, line: f.line, side: 'RIGHT', body: commentBody });
        } else {
          const closest = findClosestDiffLine(diffFile, f.line);
          if (closest) {
            validComments.push({ path: f.file, line: closest, side: 'RIGHT', body: commentBody });
          } else {
            invalidComments.push(`**${f.title}** (${f.file}:${f.line}): ${f.description}`);
          }
        }
      } else {
        invalidComments.push(`**${f.title}** (${f.file}:${f.line}): ${f.description}`);
      }
    } else {
      validComments.push({ path: f.file, line: f.line, side: 'RIGHT', body: commentBody });
    }
  }

  let body = `${BOT_MARKER}\n${result.summary}`;
  if (invalidComments.length > 0) {
    body += `\n\n**Additional findings (not on changed lines):**\n${invalidComments.map(c => `- ${c}`).join('\n')}`;
  }

  if (invalidComments.length > 0) {
    core.info(`Moved ${invalidComments.length} comments to review body (lines not in diff)`);
  }
  core.info(`Posting review: ${event} with ${validComments.length} inline comments`);

  try {
    const { data: review } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event,
      body,
      comments: validComments,
    });

    core.info(`Posted review #${review.id} with verdict ${result.verdict}`);
    return review.id;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isLineError = errorMessage.includes('pull_request_review_thread.line') ||
      errorMessage.includes('line must be part of the diff');

    // If it's a line validation error, retry without inline comments
    if (isLineError && validComments.length > 0) {
      core.warning('Inline comments rejected by GitHub (invalid lines). Posting review without inline comments.');
      const allAsBody = validComments.map(c => `- ${c.body.split('\n')[0]}`).join('\n');
      const fallbackBody = `${body}\n\n**Inline comments could not be posted:**\n${allAsBody}`;

      const { data: review } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitSha,
        event,
        body: fallbackBody,
        comments: [],
      });

      core.info(`Posted review #${review.id} without inline comments (line validation failed)`);
      return review.id;
    }

    if (event === 'COMMENT') {
      throw error;
    }

    const hint = event === 'APPROVE'
      ? 'Ensure "Allow GitHub Actions to create and approve pull requests" is enabled in repo settings.'
      : 'The token may lack permission to request changes.';
    core.warning(`Failed to post ${event} review. ${hint} Falling back to COMMENT.`);

    const { data: review } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: 'COMMENT',
      body,
      comments: validComments,
    });

    core.info(`Posted fallback COMMENT review #${review.id} (original verdict: ${result.verdict})`);
    return review.id;
  }
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
    comment += `\n\n<details>\n<summary>Suggested fix</summary>\n\n\`\`\`suggestion\n${finding.suggestedFix}\n\`\`\`\n</details>`;
  }

  comment += '\n\n<details>\n<summary>🤖 Prompt for AI Agents</summary>\n\n';
  comment += `**File:** \`${finding.file}\`\n`;
  comment += `**Line:** ${finding.line}\n`;
  comment += `**Finding:** ${finding.title}\n`;
  comment += `**Severity:** ${finding.severity}\n\n`;
  comment += `**Description:**\n${finding.description}\n`;

  if (finding.suggestedFix) {
    comment += `\n**Suggested fix:**\n\`\`\`\n${finding.suggestedFix}\n\`\`\`\n`;
  }

  comment += '\n> **Important:** Before applying this fix, validate the finding in the broader context of the file and surrounding code. The review agent may have missed context that makes this a false positive.\n';
  comment += '\n</details>';

  if (finding.reviewers.length > 0) {
    comment += `\n\n<sub>Flagged by: ${finding.reviewers.join(', ')}</sub>`;
  }

  comment += `\n\n<!-- manki:${finding.severity}:${finding.title.replace(/[^a-zA-Z0-9]/g, '-')} -->`;

  return comment;
}

/**
 * Build the markdown body for a nit issue from non-blocking findings.
 * Pure function — no API calls — for testability.
 */
export function buildNitIssueBody(
  prNumber: number,
  findings: Finding[],
  owner: string,
): string {
  const nits = findings.filter(f => f.severity === 'suggestion' || f.severity === 'question');

  const checklist = nits.map(f => {
    const icon = f.severity === 'suggestion' ? '\u{1F4A1}' : '\u{2753}';
    const fix = f.suggestedFix ? `\n  **Suggested fix:** \`${f.suggestedFix.slice(0, 100)}\`` : '';
    return `- [ ] ${icon} **${f.title}** \u2014 \`${f.file}:${f.line}\`\n  ${f.description}${fix}`;
  }).join('\n\n');

  return `## Review Nits from PR #${prNumber}

The following non-blocking findings were identified during automated review. Please triage:
- **Close this issue** if the findings aren't worth addressing
- **Remove the \`needs-human\` label** to signal the coordinator to implement fixes

${checklist}

---
<sub>Auto-generated by [Manki](https://github.com/${owner}/manki)</sub>`;
}

/**
 * Create a GitHub issue from non-blocking review findings.
 * Returns the issue number, or null if no nits or issue already exists.
 */
export async function createNitIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  findings: Finding[],
): Promise<number | null> {
  const nits = findings.filter(f => f.severity === 'suggestion' || f.severity === 'question');
  if (nits.length === 0) return null;

  const searchQuery = `repo:${owner}/${repo} is:issue "Review nits from PR #${prNumber}" label:needs-human`;
  const { data: existing } = await octokit.rest.search.issuesAndPullRequests({ q: searchQuery });
  if (existing.total_count > 0) {
    core.info(`Nit issue already exists for PR #${prNumber}: #${existing.items[0].number}`);
    return existing.items[0].number;
  }

  try {
    await octokit.rest.issues.getLabel({ owner, repo, name: 'needs-human' });
  } catch {
    await octokit.rest.issues.createLabel({
      owner, repo,
      name: 'needs-human',
      description: 'Needs human triage before AI picks it up',
      color: 'FBCA04',
    });
  }

  const body = buildNitIssueBody(prNumber, findings, owner);

  const { data: issue } = await octokit.rest.issues.create({
    owner, repo,
    title: `Review nits from PR #${prNumber}`,
    body,
    labels: ['needs-human'],
  });

  core.info(`Created nit issue #${issue.number} for PR #${prNumber} with ${nits.length} findings`);
  return issue.number;
}

/**
 * React to an issue comment with an emoji. Failures are silently ignored
 * since reactions are non-critical UX signals.
 */
export async function reactToIssueComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  content: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes',
): Promise<void> {
  try {
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  } catch {
    // Non-critical — don't fail the workflow over a reaction
  }
}

/**
 * React to a pull request review comment with an emoji. Failures are silently
 * ignored since reactions are non-critical UX signals.
 */
export async function reactToReviewComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  content: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes',
): Promise<void> {
  try {
    await octokit.rest.reactions.createForPullRequestReviewComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  } catch {
    // Non-critical — don't fail the workflow over a reaction
  }
}

export { formatFindingComment, mapVerdictToEvent, BOT_MARKER };
