import * as core from '@actions/core';
import * as github from '@actions/github';

import { DashboardData, Finding, FindingSeverity, ParsedDiff, ReviewResult, ReviewStats, ReviewVerdict } from './types';
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

const MAX_RESOLVE_DEPTH = 3;

/**
 * Resolve `@path/to/file.md` references in CLAUDE.md content by fetching
 * the referenced files from the repo and inlining their content.
 */
async function resolveReferences(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  content: string,
  basePath: string,
  depth: number = 0,
): Promise<string> {
  if (depth >= MAX_RESOLVE_DEPTH) {
    return content;
  }

  const lines = content.split('\n');
  const resolvedLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^@(\S+\.md)\s*$/);
    if (!match) {
      resolvedLines.push(line);
      continue;
    }

    const filePath = match[1];
    if (filePath.includes('..')) {
      resolvedLines.push(line);
      continue;
    }

    const resolvedPath = basePath ? `${basePath}/${filePath}` : filePath;
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path: resolvedPath, ref });
      if ('content' in data && data.encoding === 'base64') {
        let fileContent = Buffer.from(data.content, 'base64').toString('utf-8');
        const fileDir = resolvedPath.includes('/') ? resolvedPath.substring(0, resolvedPath.lastIndexOf('/')) : '';
        fileContent = await resolveReferences(octokit, owner, repo, ref, fileContent, fileDir, depth + 1);
        resolvedLines.push(fileContent.trimEnd());
      } else {
        // Not a file (e.g., directory listing) — keep original reference
        resolvedLines.push(line);
      }
    } catch {
      resolvedLines.push(line);
      resolvedLines.push(`<!-- Could not resolve reference: ${filePath} -->`);
    }
  }

  return resolvedLines.join('\n');
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
        let content = Buffer.from(data.content, 'base64').toString('utf-8');
        const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '';
        content = await resolveReferences(octokit, owner, repo, ref, content, dir);
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
 * Build a markdown dashboard table showing review progress across phases.
 */
export function buildDashboard(data: DashboardData): string {
  const parseStatus = `Done (${data.lineCount} lines)`;

  let reviewStatus: string;
  if (data.phase === 'started') {
    reviewStatus = 'Running...';
  } else {
    reviewStatus = `Done — ${data.rawFindingCount ?? 0} findings`;
  }

  let judgeStatus: string;
  if (data.phase === 'started') {
    judgeStatus = 'Pending';
  } else if (data.phase === 'reviewed') {
    judgeStatus = 'Running...';
  } else {
    judgeStatus = `Done — ${data.keptCount ?? 0} kept, ${data.droppedCount ?? 0} dropped`;
  }

  const header = data.phase === 'complete'
    ? '**Manki** — Review complete'
    : '**Manki** — Review started';

  return [
    header,
    '',
    '| | Step | Status |',
    '|---|------|--------|',
    `| 1 | Parse diff | ${parseStatus} |`,
    `| 2 | Review (${data.agentCount} agents) | ${reviewStatus} |`,
    `| 3 | Judge | ${judgeStatus} |`,
  ].join('\n');
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
  dashboard?: DashboardData,
): Promise<number> {
  const body = dashboard
    ? `${BOT_MARKER}\n${buildDashboard(dashboard)}`
    : `${BOT_MARKER}\n**Manki** — Review started`;

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  return data.id;
}

/**
 * Update the progress comment with dashboard state or the final summary.
 */
export async function updateProgressComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  result: ReviewResult,
  dashboard?: DashboardData,
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

  const dashboardBlock = dashboard ? `${buildDashboard(dashboard)}\n\n---\n\n` : '';

  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: truncateBody(`${BOT_MARKER}\n${dashboardBlock}${emoji} **Manki** — ${result.verdict.replace('_', ' ')}\n\n${safeSummary}${findingsSummary}${highlights}`),
  });
}

/**
 * Update the progress comment with just a dashboard (no final result yet).
 */
export async function updateProgressDashboard(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  dashboard: DashboardData,
): Promise<void> {
  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: `${BOT_MARKER}\n${buildDashboard(dashboard)}`,
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

function formatStatsOneLiner(stats: ReviewStats): string {
  const parts: string[] = [];
  if (stats.severity.required) parts.push(`${stats.severity.required} required`);
  if (stats.severity.suggestion) parts.push(`${stats.severity.suggestion} suggestion`);
  if (stats.severity.nit) parts.push(`${stats.severity.nit} nit`);
  const breakdown = parts.length > 0 ? parts.join(', ') : 'none';
  const total = stats.findingsKept;
  const time = Math.round(stats.reviewTimeMs / 1000);
  return `\u{1F4CA} ${total} findings (${breakdown}) \u00B7 ${stats.diffLines} lines \u00B7 ${time}s`;
}

function formatStatsJson(stats: ReviewStats): string {
  const json = JSON.stringify(stats, null, 2);
  return `<details>\n<summary>Review stats</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n</details>`;
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
  stats?: ReviewStats,
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
  if (stats) {
    body += `\n\n${formatStatsOneLiner(stats)}`;
    body += `\n\n${formatStatsJson(stats)}`;
  }
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

  const confidence = finding.judgeConfidence ? ` <sub>[${finding.judgeConfidence} confidence]</sub>` : '';
  let comment = `${severityEmoji} **${severityLabel}**${confidence}: ${safeTitle}\n\n${safeDescription}`;

  if (finding.suggestedFix) {
    // Content inside dynamically-fenced code blocks is rendered literally by GitHub,
    // so HTML/markdown injection is not possible here — no sanitization needed.
    const fence = dynamicFence(finding.suggestedFix);
    const lines = finding.suggestedFix.split('\n').length;
    const isShort = lines <= 3 && finding.suggestedFix.length <= 120;
    if (isShort) {
      comment += `\n\n${fence}suggestion\n${finding.suggestedFix}\n${fence}`;
    } else {
      comment += `\n\n<details>\n<summary>Suggested fix</summary>\n\n${fence}suggestion\n${finding.suggestedFix}\n${fence}\n</details>`;
    }
  }

  const aiContext: Record<string, unknown> = {
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    ...(finding.judgeConfidence && { confidence: finding.judgeConfidence }),
    flaggedBy: finding.reviewers,
    title: finding.title,
    ...(finding.suggestedFix && { fix: finding.suggestedFix.slice(0, 200) }),
  };
  comment += `\n\n<details>\n<summary>AI context</summary>\n\n\`\`\`json\n${JSON.stringify(aiContext, null, 2)}\n\`\`\`\n</details>`;

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
  repo: string,
  commitSha: string,
): string {
  const nits = findings.filter(f => f.severity === 'nit');

  const checklist = nits.map(f => {
    const icon = '\u{1F4DD}';
    const safeTitle = sanitizeMarkdown(f.title);
    const safeDescription = sanitizeMarkdown(f.description);
    const safeFile = sanitizeFilePath(f.file);

    const startLine = Math.max(1, f.line - 5);
    const endLine = f.line + 10;
    const permalink = `https://github.com/${owner}/${repo}/blob/${commitSha}/${safeFile}#L${startLine}-L${endLine}`;

    let item = `- [ ] <details><summary>${icon} **${safeTitle}** \u2014 <code>${safeFile}:${f.line}</code></summary>\n`;
    item += `\n  ${safeDescription}\n`;
    item += `\n  ${permalink}\n`;

    if (f.suggestedFix) {
      const fence = dynamicFence(f.suggestedFix);
      item += `\n  **Suggested fix:**\n${fence}\n${f.suggestedFix}\n${fence}\n`;
    }

    item += `\n  </details>`;

    return item;
  }).join('\n\n');

  return `The following non-blocking findings were identified during automated review. Triaging these helps Manki learn your preferences.
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
  commitSha: string,
): Promise<number | null> {
  const nits = findings.filter(f => f.severity === 'nit');
  if (nits.length === 0) return null;

  const searchQuery = `repo:${owner}/${repo} is:issue "triage: findings from PR #${prNumber}" label:needs-human`;
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

  const body = buildNitIssueBody(prNumber, findings, owner, repo, commitSha);

  const { data: issue } = await octokit.rest.issues.create({
    owner, repo,
    title: `triage: findings from PR #${prNumber}`,
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

const DEFAULT_MAX_FILE_SIZE = 50 * 1024; // 50KB per file
const DEFAULT_MAX_TOTAL_SIZE = 100 * 1024; // 100KB total

/**
 * Fetch file contents for changed files via the GitHub API.
 * Skips binary files and files exceeding the size limit.
 * If total content exceeds the budget, includes only the largest files that fit.
 */
export async function fetchFileContents(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  files: string[],
  maxFileSize: number = DEFAULT_MAX_FILE_SIZE,
  maxTotalSize: number = DEFAULT_MAX_TOTAL_SIZE,
): Promise<Map<string, string>> {
  const results: Array<{ path: string; content: string }> = [];

  const fetches = files.map(async (path) => {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });

      if (Array.isArray(data) || !('content' in data) || data.encoding !== 'base64') {
        return null;
      }

      if (data.size > maxFileSize) {
        core.debug(`Skipping ${path}: ${data.size} bytes exceeds ${maxFileSize} limit`);
        return null;
      }

      const content = Buffer.from(data.content, 'base64').toString('utf-8');

      // Skip binary files (content with null bytes)
      if (content.includes('\0')) {
        core.debug(`Skipping ${path}: binary file`);
        return null;
      }

      return { path, content };
    } catch {
      core.debug(`Could not fetch ${path}`);
      return null;
    }
  });

  const settled = await Promise.all(fetches);
  for (const result of settled) {
    if (result) {
      results.push(result);
    }
  }

  // Sort by content size descending so we include the largest files first
  results.sort((a, b) => b.content.length - a.content.length);

  const fileContents = new Map<string, string>();
  let totalSize = 0;

  for (const { path, content } of results) {
    if (totalSize + content.length > maxTotalSize) {
      core.debug(`Skipping ${path}: would exceed total size budget (${totalSize}/${maxTotalSize})`);
      continue;
    }
    fileContents.set(path, content);
    totalSize += content.length;
  }

  core.info(`Fetched ${fileContents.size}/${files.length} file contents (${totalSize} bytes)`);
  return fileContents;
}

export interface LinkedIssue {
  number: number;
  title: string;
  body: string;
}

const MAX_ISSUE_BODY_LENGTH = 2000;
const MAX_LINKED_ISSUES = 5;

/**
 * Parse PR body for issue references and fetch their details.
 */
export async function fetchLinkedIssues(
  octokit: Octokit,
  owner: string,
  repo: string,
  prBody: string,
): Promise<LinkedIssue[]> {
  if (!prBody) return [];

  const regex = /(?:closes?|fixes?|resolves?|part\s+of)\s+#(\d+)/gi;
  const issueNumbers = new Set<number>();
  for (const match of prBody.matchAll(regex)) {
    issueNumbers.add(parseInt(match[1], 10));
  }

  if (issueNumbers.size === 0) return [];

  const results: LinkedIssue[] = [];
  for (const issueNumber of issueNumbers) {
    if (results.length >= MAX_LINKED_ISSUES) break;
    try {
      const { data } = await octokit.rest.issues.get({ owner, repo, issue_number: issueNumber });
      const rawBody = data.body || '';
      const body = rawBody.length > MAX_ISSUE_BODY_LENGTH
        ? sanitizeMarkdown(rawBody.slice(0, MAX_ISSUE_BODY_LENGTH) + '\n... (truncated)')
        : sanitizeMarkdown(rawBody);
      results.push({ number: data.number, title: sanitizeMarkdown(data.title), body });
    } catch {
      core.debug(`Could not fetch linked issue #${issueNumber}`);
    }
  }

  return results;
}

/**
 * Discover and fetch CLAUDE.md files in subdirectories relevant to changed file paths.
 * Walks up the directory tree from each changed file to find the nearest CLAUDE.md,
 * excluding root-level files already fetched by `fetchRepoContext`.
 */
export async function fetchSubdirClaudeMd(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  changedPaths: string[],
): Promise<string> {
  if (changedPaths.length === 0) return '';

  let treeEntries: Array<{ path?: string; type?: string }>;
  try {
    const { data } = await octokit.rest.git.getTree({ owner, repo, tree_sha: ref, recursive: 'true' });
    treeEntries = data.tree;
  } catch {
    core.debug('Could not fetch repo tree for subdirectory CLAUDE.md discovery');
    return '';
  }

  const claudeMdPaths = new Set(
    treeEntries
      .filter(e => e.type === 'blob' && e.path?.endsWith('/CLAUDE.md'))
      .map(e => e.path!)
      .filter(p => p !== 'CLAUDE.md' && p !== '.claude/CLAUDE.md'),
  );

  if (claudeMdPaths.size === 0) return '';

  // For each changed file, walk up the directory tree and find the nearest CLAUDE.md
  const toFetch = new Set<string>();
  for (const changedPath of changedPaths) {
    let dir = changedPath.includes('/') ? changedPath.substring(0, changedPath.lastIndexOf('/')) : '';
    while (dir) {
      const candidate = `${dir}/CLAUDE.md`;
      if (claudeMdPaths.has(candidate)) {
        toFetch.add(candidate);
        break;
      }
      dir = dir.includes('/') ? dir.substring(0, dir.lastIndexOf('/')) : '';
    }
  }

  if (toFetch.size === 0) return '';

  const parts: string[] = [];
  for (const path of toFetch) {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
      if ('content' in data && data.encoding === 'base64') {
        let content = Buffer.from(data.content, 'base64').toString('utf-8');
        const dir = path.substring(0, path.lastIndexOf('/'));
        content = await resolveReferences(octokit, owner, repo, ref, content, dir);
        parts.push(`## ${path}\n\n${content}`);
      }
    } catch {
      core.debug(`Could not fetch subdirectory CLAUDE.md: ${path}`);
    }
  }

  return parts.join('\n\n---\n\n');
}

export { dynamicFence, formatFindingComment, formatStatsJson, formatStatsOneLiner, getSeverityEmoji, getSeverityLabel, mapVerdictToEvent, resolveReferences, safeTruncate, sanitizeFilePath, sanitizeMarkdown, truncateBody, BOT_MARKER };
