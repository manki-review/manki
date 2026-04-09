import { createRequire } from 'module';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { AgentProgressEntry, DashboardData, Finding, FindingSeverity, ParsedDiff, ReviewMetadata, ReviewResult, ReviewStats, ReviewVerdict } from './types';
import { isLineInDiff, findClosestDiffLine } from './diff';
import { MAX_AGENT_RETRIES } from './types';

type Octokit = ReturnType<typeof github.getOctokit>;

const BOT_LOGIN = 'manki-review[bot]';
const BOT_MARKER = '<!-- manki-bot -->';
const REVIEW_COMPLETE_MARKER = '<!-- manki-review-complete -->';
const FORCE_REVIEW_MARKER = '<!-- manki-force-review -->';
const RUN_ID_MARKER_PREFIX = '<!-- manki-run-id:';
const CANCELLED_MARKER = '<!-- manki-review-cancelled -->';
const VERSION_MARKER_PREFIX = '<!-- manki-version:';

const MANKI_VERSION: string = (() => {
  try {
    return (createRequire(__filename)('../package.json') as { version: string }).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();
const VERSION_MARKER = `${VERSION_MARKER_PREFIX} ${MANKI_VERSION} -->`;
const BOT_MARKERS = `${BOT_MARKER}\n${VERSION_MARKER}`;

const RUN_ID_MARKER_REGEX = /<!-- manki-run-id:(\d+) -->/;
const VERSION_MARKER_REGEX = /<!-- manki-version:\s*([^\s]+)\s*-->/;

function extractVersionFromBody(body: string | null | undefined): string | null {
  if (!body) return null;
  const match = body.match(VERSION_MARKER_REGEX);
  return match ? match[1] : null;
}

function buildRunIdMarker(runId: number | string): string {
  return `${RUN_ID_MARKER_PREFIX}${runId} -->`;
}

function extractRunIdFromBody(body: string | null | undefined): number | null {
  if (!body) return null;
  const match = body.match(RUN_ID_MARKER_REGEX);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isFinite(id) ? id : null;
}

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
 * Build text status lines showing review progress across phases.
 */
export const INDENT = '&nbsp;&nbsp;&nbsp;&nbsp;';

function renderAgentLines(agents: AgentProgressEntry[]): string {
  return agents.map(a => {
    if (a.status === 'done') {
      return `${INDENT}✅ ${a.name} — ${a.findingCount ?? 0} (${formatDuration(a.durationMs ?? 0)})`;
    }
    if (a.status === 'failed') {
      if (a.retryCount && a.retryCount > 0) {
        return `${INDENT}✗ ${a.name} — failed after ${a.retryCount + 1} attempts (${formatDuration(a.durationMs ?? 0)})`;
      }
      return `${INDENT}✗ ${a.name} — failed (${formatDuration(a.durationMs ?? 0)})`;
    }
    if (a.status === 'retrying') {
      if (a.retryCount != null) {
        return `${INDENT}⟳ ${a.name} — retrying (${a.retryCount + 1}/${MAX_AGENT_RETRIES + 1})...`;
      }
      return `${INDENT}⟳ ${a.name} — retrying...`;
    }
    if (a.status === 'reviewing') {
      return `${INDENT}⏳ ${a.name}`;
    }
    return `${INDENT}○ ${a.name}`;
  }).join('\n');
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

const VALID_PR_TYPES = new Set(['feature', 'bugfix', 'refactor', 'docs', 'test', 'chore', 'rename']);

function sanitizePrType(prType: string): string {
  return VALID_PR_TYPES.has(prType) ? prType : 'unknown';
}

const VALID_EFFORTS = new Set(['low', 'medium', 'high']);

function sanitizeEffort(v: string): string {
  return VALID_EFFORTS.has(v) ? v : 'unknown';
}

const SEVERITY_ORDER = ['required', 'suggestion', 'nit', 'ignore'];

function renderSeverityBreakdown(severities: Record<string, number>): string {
  return SEVERITY_ORDER
    .filter(s => (severities[s] ?? 0) > 0)
    .map(s => `${severities[s]} ${s}`)
    .join(' · ');
}

export function buildDashboard(data: DashboardData): string {
  const agents = data.agentProgress;
  const hasAgentProgress = !!(agents && agents.length > 0);
  const sections: string[] = [];

  if (data.phase !== 'complete') {
    sections.push('**Manki** — Review in progress');
  }

  const plannerLines: string[] = [];
  if (data.phase === 'planning') {
    plannerLines.push(`**Planner**`);
    plannerLines.push(`${INDENT}analyzing...`);
  } else if (data.plannerInfo) {
    const prType = sanitizePrType(data.plannerInfo.prType);
    const plannerDur = data.plannerDurationMs != null ? ` (${formatDuration(data.plannerDurationMs)})` : '';
    plannerLines.push(`**Planner**${plannerDur}`);
    plannerLines.push(`${INDENT}${prType} · ${data.lineCount} lines · ${data.plannerInfo.teamSize} agents`);
    plannerLines.push(`${INDENT}review effort: ${sanitizeEffort(data.plannerInfo.reviewerEffort)} · judge effort: ${sanitizeEffort(data.plannerInfo.judgeEffort)}`);
  } else {
    const plannerDur = data.plannerDurationMs != null ? ` (${formatDuration(data.plannerDurationMs)})` : '';
    plannerLines.push(`**Planner**${plannerDur}`);
    plannerLines.push(`${INDENT}${data.lineCount} lines · ${data.agentCount} agents`);
  }
  sections.push(plannerLines.join('\n'));

  const reviewLines: string[] = [];
  if (data.phase === 'planning') {
    reviewLines.push(`**Review**`);
    reviewLines.push(`${INDENT}pending`);
  } else if (data.phase === 'started') {
    if (hasAgentProgress) {
      const done = agents.filter(a => a.status === 'done' || a.status === 'failed' || a.status === 'retrying').length;
      reviewLines.push(`**Review** — ${done}/${agents.length} agents complete`);
      reviewLines.push(renderAgentLines(agents));
    } else {
      reviewLines.push(`**Review**`);
      reviewLines.push(`${INDENT}reviewing with ${data.agentCount} agents...`);
    }
  } else {
    reviewLines.push(`**Review** — ${data.rawFindingCount ?? 0} findings`);
    if (hasAgentProgress) {
      reviewLines.push(renderAgentLines(agents));
    }
  }
  sections.push(reviewLines.join('\n'));

  const judgeLines: string[] = [];
  if (data.phase === 'planning' || data.phase === 'started') {
    judgeLines.push(`**Judge**`);
    judgeLines.push(`${INDENT}pending`);
  } else if (data.phase === 'reviewed') {
    judgeLines.push(`**Judge**`);
    judgeLines.push(`${INDENT}evaluating ${data.judgeInputCount ?? data.rawFindingCount ?? 0} findings...`);
  } else {
    const judgeDur = data.judgeDurationMs != null ? ` (${formatDuration(data.judgeDurationMs)})` : '';
    judgeLines.push(`**Judge** — ${data.keptCount ?? 0} kept · ${data.droppedCount ?? 0} dropped${judgeDur}`);
    if (data.keptSeverities) {
      const breakdown = renderSeverityBreakdown(data.keptSeverities);
      if (breakdown) judgeLines.push(`${INDENT}kept: ${breakdown}`);
    }
    if (data.droppedSeverities) {
      const breakdown = renderSeverityBreakdown(data.droppedSeverities);
      if (breakdown) judgeLines.push(`${INDENT}dropped: ${breakdown}`);
    }
  }
  sections.push(judgeLines.join('\n'));

  return sections.join('\n\n');
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
  const runIdMarker = buildRunIdMarker(github.context.runId);
  const body = dashboard
    ? `${BOT_MARKERS}\n${runIdMarker}\n${buildDashboard(dashboard)}`
    : `${BOT_MARKERS}\n${runIdMarker}\n**Manki** — Review started`;

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  return data.id;
}

/**
 * Freeze the progress comment as an audit log with the final dashboard
 * and optional review metadata (config, judge decisions, recap, timing).
 */
export async function updateProgressComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  dashboard: DashboardData,
  metadata?: ReviewMetadata,
): Promise<void> {
  const parts: string[] = [
    BOT_MARKER,
    VERSION_MARKER,
    `**Manki** — ${metadata ? 'Review complete' : 'Review failed'}`,
    '',
    buildDashboard({ ...dashboard, phase: 'complete' }),
  ];

  if (metadata) {
    parts.push('');
    parts.push('<details>');
    parts.push('<summary>Review metadata</summary>');
    parts.push('');

    parts.push('**Config:**');
    parts.push(`- Models: reviewer=${metadata.config.reviewerModel}, judge=${metadata.config.judgeModel}`);
    parts.push(`- Review level: ${metadata.config.reviewLevel} (${metadata.config.reviewLevelReason})`);
    parts.push(`- Team: ${metadata.config.teamAgents.join(', ')}`);
    parts.push(`- Memory: ${metadata.config.memoryEnabled ? `enabled (${metadata.config.memoryRepo})` : 'disabled'}`);
    parts.push(`- Nit handling: ${metadata.config.nitHandling}`);
    parts.push('');

    if (metadata.judgeDecisions.length > 0) {
      parts.push('**Judge decisions:**');
      for (const d of metadata.judgeDecisions) {
        const icon = d.kept ? '\u2713 Kept' : '\u2717 Dropped';
        parts.push(`- ${icon}: "${sanitizeMarkdown(d.title)}" (${d.severity}, ${d.confidence} confidence) — "${sanitizeMarkdown(d.reasoning)}"`);
      }
      parts.push('');
    }


    parts.push('**Timing:**');
    parts.push(`- Parse: ${(metadata.timing.parseMs / 1000).toFixed(1)}s`);
    parts.push(`- Review agents: ${(metadata.timing.reviewMs / 1000).toFixed(1)}s`);
    parts.push(`- Judge: ${(metadata.timing.judgeMs / 1000).toFixed(1)}s`);
    parts.push(`- Total: ${(metadata.timing.totalMs / 1000).toFixed(1)}s`);
    parts.push('');
    parts.push('</details>');
  }

  parts.push(REVIEW_COMPLETE_MARKER);

  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: truncateBody(parts.join('\n')),
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
  const runIdMarker = buildRunIdMarker(github.context.runId);
  await octokit.rest.issues.updateComment({
    owner,
    repo,
    comment_id: commentId,
    body: `${BOT_MARKERS}\n${runIdMarker}\n${buildDashboard(dashboard)}`,
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

  let body = `${BOT_MARKERS}\n${sanitizeMarkdown(result.summary)}`;
  if (result.partialNote) {
    body += `\n\n> **Note:** ${sanitizeMarkdown(result.partialNote)}`;
  }
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
- Comment \`/manki triage\` when done

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

/**
 * Edit a progress comment in place to mark its run as cancelled/superseded.
 * Preserves audit trail — the original dashboard body is kept.
 */
async function markProgressCommentCancelled(
  octokit: Octokit, owner: string, repo: string, commentId: number, originalBody: string,
): Promise<void> {
  if (originalBody.includes(CANCELLED_MARKER)) return;
  const body = [
    CANCELLED_MARKER,
    '**Manki** — Review cancelled (superseded by newer run)',
    '',
    '<details><summary>Original progress</summary>',
    '',
    originalBody,
    '',
    '</details>',
  ].join('\n');
  try {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
  } catch (error) {
    core.warning(`Failed to mark progress comment as cancelled: ${error instanceof Error ? error.message : error}`);
  }
}

interface ProgressComment {
  id: number;
  body: string;
  runId: number | null;
}

/**
 * Find the most recent non-complete, non-cancelled progress comment posted by the bot.
 */
async function findProgressComment(
  octokit: Octokit, owner: string, repo: string, prNumber: number,
): Promise<ProgressComment | null> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner, repo, issue_number: prNumber, per_page: 100, direction: 'desc',
  });
  const match = comments.find(c =>
    c.user?.login === BOT_LOGIN &&
    c.user?.type === 'Bot' &&
    c.body?.includes(BOT_MARKER) &&
    !c.body?.includes(REVIEW_COMPLETE_MARKER) &&
    !c.body?.includes(FORCE_REVIEW_MARKER) &&
    !c.body?.includes(CANCELLED_MARKER)
  );
  if (!match || !match.body) return null;
  return { id: match.id, body: match.body, runId: extractRunIdFromBody(match.body) };
}

/**
 * Check whether a review is currently in progress for a PR by verifying the
 * embedded Actions run_id via the GitHub Actions API. Zombie comments from
 * cancelled/failed runs are marked as cancelled in-place (not deleted) so the
 * audit trail is preserved.
 */
async function isReviewInProgress(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<boolean> {
  let progress: ProgressComment | null;
  try {
    progress = await findProgressComment(octokit, owner, repo, prNumber);
  } catch {
    return false;
  }
  if (!progress) return false;

  // Legacy comments without a run_id marker predate this check — treat as stale.
  if (progress.runId === null) {
    core.info('Progress comment has no run_id marker — treating as stale');
    await markProgressCommentCancelled(octokit, owner, repo, progress.id, progress.body);
    return false;
  }

  // Same run: we're re-entering our own execution, nothing to skip.
  if (progress.runId === github.context.runId) {
    return false;
  }

  let status: string | null | undefined;
  let conclusion: string | null | undefined;
  try {
    const { data: workflowRun } = await octokit.rest.actions.getWorkflowRun({
      owner, repo, run_id: progress.runId,
    });
    status = workflowRun.status;
    conclusion = workflowRun.conclusion;
  } catch (error) {
    core.warning(`Failed to query Actions run ${progress.runId}: ${error instanceof Error ? error.message : error}`);
    return false;
  }

  if (status === 'in_progress' || status === 'queued' || status === 'waiting' || status === 'pending' || status === 'requested' || status === 'action_required') {
    core.info(`Skipping — review already in progress (run ${progress.runId}, status=${status})`);
    return true;
  }

  core.info(`Progress comment belongs to completed run ${progress.runId} (status=${status}, conclusion=${conclusion}) — marking as cancelled`);
  await markProgressCommentCancelled(octokit, owner, repo, progress.id, progress.body);
  return false;
}

/**
 * Post-step cleanup: find our run's progress comment and mark it as cancelled.
 * Invoked when GitHub Actions cancels the main step.
 */
async function markOwnProgressCommentCancelled(
  octokit: Octokit, owner: string, repo: string, prNumber: number, runId: number,
): Promise<boolean> {
  try {
    const { data: comments } = await octokit.rest.issues.listComments({
      owner, repo, issue_number: prNumber, per_page: 100, direction: 'desc',
    });
    const target = comments.find(c =>
      c.user?.login === BOT_LOGIN &&
      c.user?.type === 'Bot' &&
      c.body?.includes(BOT_MARKER) &&
      !c.body?.includes(REVIEW_COMPLETE_MARKER) &&
      !c.body?.includes(CANCELLED_MARKER) &&
      extractRunIdFromBody(c.body) === runId
    );
    if (!target || !target.body) return false;
    await markProgressCommentCancelled(octokit, owner, repo, target.id, target.body);
    return true;
  } catch (error) {
    core.warning(`Post-cleanup failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

/**
 * Check whether the bot already has an active (non-dismissed) APPROVED review
 * on the given commit SHA.
 */
async function isApprovedOnCommit(octokit: Octokit, owner: string, repo: string, prNumber: number, commitSha: string): Promise<boolean> {
  try {
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    const botReviews = reviews.filter(
      (r: { body?: string | null; state?: string; user?: { login?: string; type?: string } | null }) =>
        r.user?.login === BOT_LOGIN && r.user?.type === 'Bot' && r.state !== 'DISMISSED',
    );
    const latest = botReviews[botReviews.length - 1];
    if (!latest || latest.state !== 'APPROVED') return false;
    return (latest as unknown as { commit_id?: string }).commit_id === commitSha;
  } catch {
    return false;
  }
}

export { dynamicFence, formatFindingComment, formatStatsJson, formatStatsOneLiner, getSeverityEmoji, getSeverityLabel, mapVerdictToEvent, resolveReferences, safeTruncate, sanitizeFilePath, sanitizeMarkdown, truncateBody, BOT_LOGIN, BOT_MARKER, REVIEW_COMPLETE_MARKER, FORCE_REVIEW_MARKER, CANCELLED_MARKER, RUN_ID_MARKER_PREFIX, VERSION_MARKER_PREFIX, MANKI_VERSION, isReviewInProgress, isApprovedOnCommit, markOwnProgressCommentCancelled, extractRunIdFromBody, extractVersionFromBody };
