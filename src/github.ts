import * as core from '@actions/core';
import * as github from '@actions/github';

import { Finding, FindingSeverity, ParsedDiff, ReviewResult, ReviewVerdict } from './types';
import { isLineInDiff, findClosestDiffLine } from './diff';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_MARKER = '<!-- manki-bot -->';

// Covers all standard HTML elements including `base` (can inject a base URL that hijacks relative links)
const HTML_TAGS = 'a|abbr|address|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|footer|form|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|math|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|param|picture|pre|progress|q|rp|rt|ruby|s|samp|script|section|select|slot|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr';
// The `[^>]*` in these regexes is anchored by a literal `>`, so backtracking is
// linear. If no `>` exists, the unclosed-tag regex below handles that case
// separately (anchored to end-of-string). Not a ReDoS concern for our input.
const HTML_TAG_REGEX = new RegExp(`<\\/?(${HTML_TAGS})(?:\\s[^>]*)?\\s*\\/?>`, 'gi');
const HTML_UNCLOSED_TAG_REGEX = new RegExp(`<\\/?(${HTML_TAGS})(?:\\s[^>]*)?$`, 'gim');

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
  const safeSummary = sanitizeMarkdown(result.summary);
  const findingsSummary = result.findings.length > 0
    ? `\n\n| Severity | Count |\n|---|---|\n| Required | ${result.findings.filter(f => f.severity === 'required').length} |\n| Suggestions | ${result.findings.filter(f => f.severity === 'suggestion').length} |\n| Nits | ${result.findings.filter(f => f.severity === 'nit').length} |\n| Ignored | ${result.findings.filter(f => f.severity === 'ignore').length} |`
    : '';

  const safeHighlights = result.highlights.map(h => sanitizeMarkdown(h));
  const highlights = safeHighlights.length > 0
    ? `\n\n**Highlights:**\n${safeHighlights.map(h => `- ${h}`).join('\n')}`
    : '';

  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: truncateBody(`${BOT_MARKER}\n${emoji} **Manki** — ${result.verdict.replace('_', ' ')}\n\n${safeSummary}${findingsSummary}${highlights}`),
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
  const generalFindings: string[] = [];

  for (const f of result.findings) {
    if (!f.file || f.line <= 0) {
      const safeFile = f.file ? sanitizeFilePath(f.file) : '';
      const location = f.file ? ` — \`${safeFile}\`` : '';
      const safeTitle = sanitizeMarkdown(f.title);
      const fullDesc = sanitizeMarkdown(f.description);
      const safeDesc = safeTruncate(fullDesc, 300);
      let entry = `**[${getSeverityLabel(f.severity)}] ${safeTitle}**${location}\n  ${safeDesc}`;
      if (f.suggestedFix) {
        const fix = safeTruncate(f.suggestedFix, 200);
        if (fix.includes('`') || fix.includes('\n')) {
          // Dynamic fence: content inside code fences is literal, so no sanitization needed.
          const fence = dynamicFence(fix);
          entry += `\n  ${fence}\n  ${fix}\n  ${fence}`;
        } else {
          entry += `\n  Fix: \`${fix}\``;
        }
      }
      generalFindings.push(entry);
      continue;
    }

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
            const desc = sanitizeMarkdown(f.description);
            const truncDesc = safeTruncate(desc, 200);
            invalidComments.push(`**[${getSeverityLabel(f.severity)}] ${sanitizeMarkdown(f.title)}** (\`${sanitizeFilePath(f.file)}:${f.line}\`): ${truncDesc}`);
          }
        }
      } else {
        const desc = sanitizeMarkdown(f.description);
        const truncDesc = safeTruncate(desc, 200);
        invalidComments.push(`**[${getSeverityLabel(f.severity)}] ${sanitizeMarkdown(f.title)}** (\`${sanitizeFilePath(f.file)}:${f.line}\`): ${truncDesc}`);
      }
    } else {
      validComments.push({ path: f.file, line: f.line, side: 'RIGHT', body: commentBody });
    }
  }

  let body = `${BOT_MARKER}\n${sanitizeMarkdown(result.summary)}`;
  if (generalFindings.length > 0) {
    body += `\n\n**General findings:**\n${generalFindings.map(c => `- ${c}`).join('\n')}`;
  }
  if (invalidComments.length > 0) {
    body += `\n\n**Findings (not on changed lines):**\n${invalidComments.map(c => `- ${c}`).join('\n')}`;
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
      body: truncateBody(body),
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
      const lineErrFallbackBody = truncateBody(`${body}\n\n**Inline comments could not be posted:**\n${allAsBody}`);

      const { data: review } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitSha,
        event,
        body: lineErrFallbackBody,
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

    const findingSummary = validComments.map(c => {
      const firstLine = c.body.split('\n')[0];
      return `- ${firstLine} (\`${c.path}:${c.line}\`)`;
    }).join('\n');
    const fallbackBody = truncateBody(`${body}\n\n**Findings (could not post inline):**\n${findingSummary}`);

    const { data: review } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event: 'COMMENT',
      body: fallbackBody,
      comments: [],
    });

    core.info(`Posted fallback COMMENT review #${review.id} (original verdict: ${result.verdict})`);
    return review.id;
  }
}

function dynamicFence(content: string): string {
  const maxBt = (content.match(/`+/g) || []).reduce((max: number, s: string) => Math.max(max, s.length), 0);
  return '`'.repeat(Math.max(3, maxBt + 1));
}

function truncateBody(text: string, maxLength: number = 60000): string {
  if (text.length <= maxLength) return text;
  const notice = '\n\n*(Review body truncated)*';
  const safeMax = Math.max(0, maxLength - notice.length);
  const cutoff = text.lastIndexOf(' ', safeMax);
  return text.slice(0, cutoff > safeMax - 100 ? cutoff : safeMax) + notice;
}

function safeTruncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let end = maxLen;
  if (end > 0 && text.charCodeAt(end - 1) >= 0xD800 && text.charCodeAt(end - 1) <= 0xDBFF) {
    end--;
  }
  return text.slice(0, end) + '...';
}

function sanitizeFilePath(file: string): string {
  return file.replace(/`/g, "'").replace(/[\n\r]/g, ' ');
}

function mapVerdictToEvent(verdict: ReviewVerdict): 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES' {
  switch (verdict) {
    case 'APPROVE': return 'APPROVE';
    case 'REQUEST_CHANGES': return 'REQUEST_CHANGES';
    case 'COMMENT': return 'COMMENT';
  }
}

const severityLabels: Record<FindingSeverity, string> = {
  required: 'Required',
  suggestion: 'Suggestion',
  nit: 'Nit',
  ignore: 'Ignore',
};

const severityEmojis: Record<FindingSeverity, string> = {
  required: '🚫',
  suggestion: '💡',
  nit: '📝',
  ignore: '⚪',
};

function getSeverityLabel(severity: FindingSeverity): string {
  return severityLabels[severity];
}

function getSeverityEmoji(severity: FindingSeverity): string {
  return severityEmojis[severity];
}

// Sanitizes LLM-generated text (titles, descriptions, summaries) before embedding
// it into the GitHub comment body. Our own structural markup (<details>, <summary>,
// collapsible sections, etc.) is added AFTER sanitization and is never passed through here.
function sanitizeMarkdown(text: string): string {
  // Decode common HTML entities so encoded tags like &lt;script&gt; are caught by tag stripping
  let result = text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  // Run comment stripping twice to handle nested comments like <!-- <!-- --> -->,
  // then clean up any dangling close markers left behind.
  result = result.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  result = result.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  result = result.replace(/-->/g, '');

  // Run tag stripping twice to handle nesting like <div<div>>
  result = result.replace(HTML_TAG_REGEX, '');
  result = result.replace(HTML_TAG_REGEX, '');

  return result
    .replace(HTML_UNCLOSED_TAG_REGEX, '')  // Unclosed tags at end of string
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                       // Images: keep alt text only
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                        // Links: keep text only
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')                       // Second pass for nested brackets
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')                        // Second pass for nested brackets
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1')                       // Reference images
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')                        // Reference links
    .replace(/^\[[^\]]*\]:\s+.*$/gm, '')                             // Link/image definitions
    // Insert zero-width space after @ to prevent GitHub from resolving mentions.
    // Lookbehind avoids matching email addresses (which have chars before @).
    // Also handles @org/team patterns.
    .replace(/(?<![a-zA-Z0-9.])@([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)?)/g, '@\u200B$1');
}

function formatFindingComment(finding: Finding): string {
  const severityEmoji = getSeverityEmoji(finding.severity);
  const severityLabel = getSeverityLabel(finding.severity);
  const safeTitle = sanitizeMarkdown(finding.title);
  const safeDescription = sanitizeMarkdown(finding.description);

  let comment = `${severityEmoji} **${severityLabel}**: ${safeTitle}\n\n${safeDescription}`;

  if (finding.suggestedFix) {
    // Content inside dynamically-fenced code blocks is rendered literally by GitHub,
    // so HTML/markdown injection is not possible here — no sanitization needed.
    const fence = dynamicFence(finding.suggestedFix);
    comment += `\n\n<details>\n<summary>Suggested fix</summary>\n\n${fence}suggestion\n${finding.suggestedFix}\n${fence}\n</details>`;
  }

  const safeFile = sanitizeFilePath(finding.file);
  comment += '\n\n<details>\n<summary>🤖 Prompt for AI Agents</summary>\n\n';
  comment += `**File:** \`${safeFile}\`\n`;
  comment += `**Line:** ${finding.line}\n`;
  comment += `**Finding:** ${safeTitle}\n`;
  comment += `**Severity:** ${finding.severity}\n\n`;
  comment += `**Description:**\n${safeDescription}\n`;

  if (finding.suggestedFix) {
    // Inside a dynamically-fenced code block — GitHub renders literally, safe from injection.
    const fixFence = dynamicFence(finding.suggestedFix);
    comment += `\n**Suggested fix:**\n${fixFence}\n${finding.suggestedFix}\n${fixFence}\n`;
  }

  comment += '\n> **Important:** Before applying this fix, validate the finding in the broader context of the file and surrounding code. The review agent may have missed context that makes this a false positive.\n';
  comment += '\n</details>';

  if (finding.reviewers.length > 0) {
    const safeReviewers = finding.reviewers.map(r => sanitizeMarkdown(r)).join(', ');
    comment += `\n\n<sub>Flagged by: ${safeReviewers}</sub>`;
  }

  // The replace strips all non-alphanumeric chars, so the title is safe for use in an HTML comment marker
  comment += `\n\n<!-- manki:${finding.severity}:${finding.title.replace(/[^a-zA-Z0-9]/g, '-')} -->`;

  return comment;
}

/**
 * Build the markdown body for a nit issue from non-required findings.
 * Pure function — no API calls — for testability.
 */
export function buildNitIssueBody(
  prNumber: number,
  findings: Finding[],
  owner: string,
): string {
  const nits = findings.filter(f => f.severity === 'nit');

  const checklist = nits.map(f => {
    const icon = '\u{1F4DD}';
    const safeTitle = sanitizeMarkdown(f.title);
    const safeDescription = sanitizeMarkdown(f.description);
    const safeFile = sanitizeFilePath(f.file);

    let item = `- [ ] ${icon} **${safeTitle}** \u2014 \`${safeFile}:${f.line}\`\n`;
    item += `  \n  ${safeDescription}\n`;

    if (f.codeContext) {
      const ext = safeFile.split('.').pop() || '';
      const langMap: Record<string, string> = {
        'ts': 'typescript', 'tsx': 'typescript', 'js': 'javascript', 'jsx': 'javascript',
        'rs': 'rust', 'py': 'python', 'go': 'go', 'java': 'java',
        'css': 'css', 'html': 'html', 'yml': 'yaml', 'yaml': 'yaml',
      };
      const lang = langMap[ext] || ext;
      const fence = dynamicFence(f.codeContext);
      item += `  \n  ${fence}${lang}\n${f.codeContext}\n  ${fence}\n`;
    }

    item += `  \n  <details>\n  <summary>\u{1F916} Fix prompt</summary>\n\n`;
    item += `  **File:** \`${safeFile}\`\n`;
    item += `  **Line:** ${f.line}\n`;
    item += `  **Finding:** ${safeTitle}\n`;
    item += `  **Severity:** ${f.severity}\n\n`;
    item += `  **Description:**\n  ${safeDescription}\n`;
    if (f.suggestedFix) {
      const fixFence = dynamicFence(f.suggestedFix);
      item += `  \n  **Suggested fix:**\n  ${fixFence}\n  ${f.suggestedFix}\n  ${fixFence}\n`;
    }
    item += `  \n  > **Important:** Before applying this fix, validate the finding in the broader context of the file and surrounding code.\n`;
    item += `  \n  </details>`;

    return item;
  }).join('\n\n');

  return `## Review Nits from PR #${prNumber}

The following non-blocking findings were identified during automated review. Please triage:
- **Check the box** for findings worth fixing
- **Leave unchecked** for findings to dismiss
- Comment \`@manki triage\` when done

${checklist}

---
<sub>Auto-generated by [Manki](https://github.com/${owner}/manki)</sub>`;
}

/**
 * Create a GitHub issue from non-required review findings.
 * Returns the issue number, or null if no nits or issue already exists.
 */
export async function createNitIssue(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  findings: Finding[],
): Promise<number | null> {
  const nits = findings.filter(f => f.severity === 'nit');
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

export { dynamicFence, formatFindingComment, getSeverityEmoji, getSeverityLabel, mapVerdictToEvent, safeTruncate, sanitizeFilePath, sanitizeMarkdown, truncateBody, BOT_MARKER };
