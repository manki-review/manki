import { createRequire } from 'module';

import * as core from '@actions/core';
import * as github from '@actions/github';

import { AgentProgressEntry, DashboardData, FOLLOW_UP_TAG, Finding, FindingFingerprintEntry, FindingSeverity, ParsedDiff, ReviewConfig, ReviewMetadata, ReviewResult, RoundContext, RoundOutcome, ReviewVerdict, VALID_PR_TYPES, VerdictReason, VerdictTrace, VerdictTraceEntry, SECURITY_TAG, TestGuide, isBlockingSeverity } from './types';
import { isLineInDiff } from './diff';
import { codeTokensFromDiff, highlightCode } from './highlight';
import { findPriorThreadId } from './finding-fingerprint';
import type { PreviousFinding } from './recap';
import { MAX_AGENT_RETRIES } from './types';
import { MAX_LOCK_TTL_SECONDS } from './config';
import { safeTruncate, sanitizeTokens } from './utils';

type Octokit = ReturnType<typeof github.getOctokit>;

interface IssueComment {
  id: number;
  body?: string | null;
  user?: { login?: string | null; type?: string } | null;
  updated_at: string;
}

const BOT_LOGIN = 'manki-review[bot]';
const ACTIONS_BOT_LOGIN = 'github-actions[bot]';

/** The logins Manki's comments and reviews can carry on this repo, in REST form (`<slug>[bot]`). */
interface BotIdentity {
  logins: readonly string[];
}

/** Whether `login` is one of `bot`'s logins. GraphQL reports a bot as `<slug>`, REST as `<slug>[bot]`, so both match. */
function isBotLogin(bot: BotIdentity, login: string | null | undefined): boolean {
  if (!login) return false;
  return bot.logins.includes(login) || bot.logins.includes(`${login}[bot]`);
}

/** Whether a REST `user` is one of `bot`'s accounts. REST reports a bot as `<slug>[bot]`, so only an exact login matches. */
function isBotUser(bot: BotIdentity, user: { login?: string | null } | null | undefined): boolean {
  return !!user?.login && bot.logins.includes(user.login);
}

/** Whether a comment's `author_association` grants write access to the repo. */
function isTrustedAssociation(authorAssociation: string | null | undefined): boolean {
  return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(authorAssociation ?? '');
}
const BOT_MARKER = '<!-- manki-bot -->';
const REVIEW_COMPLETE_MARKER = '<!-- manki-review-complete -->';
const FORCE_REVIEW_MARKER = '<!-- manki-force-review -->';
const FORCE_CAP_MARKER = '<!-- manki-force-cap -->';
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
 * Fetch the unified diff between two commits via GitHub's compare API, which
 * diffs `head` against its merge base with `base`. Used to ground the judge's
 * per-thread evaluation in actual code changes since the prior review round,
 * distinguishing real fixes from no-op pushes (force-pushed rebases, branch
 * resets) where every open thread should remain unresolved. Returns an empty string when `base === head` or when the
 * comparison yields a non-string payload. Throws on API failure so the caller
 * can distinguish "no changes" (empty string) from "unknown" (caught error,
 * leaves the diff undefined upstream).
 */
export async function fetchInterRoundDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string> {
  if (!base || !head || base === head) return '';
  try {
    const { data } = await octokit.rest.repos.compareCommits({
      owner,
      repo,
      base,
      head,
      mediaType: { format: 'diff' },
    });
    const diff = data as unknown as string;
    return typeof diff === 'string' ? diff : '';
  } catch (error) {
    core.debug(`Failed to fetch inter-round diff ${base}..${head}: ${error}`);
    throw error;
  }
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
      return `${INDENT}✅ ${a.name}: ${countOf(a.findingCount ?? 0, 'finding')} (${formatDuration(a.durationMs ?? 0)})`;
    }
    if (a.status === 'failed') {
      if (a.retryCount && a.retryCount > 0) {
        return `${INDENT}🔴 ${a.name}: failed after ${a.retryCount + 1} attempts (${formatDuration(a.durationMs ?? 0)})`;
      }
      return `${INDENT}🔴 ${a.name}: failed (${formatDuration(a.durationMs ?? 0)})`;
    }
    if (a.status === 'retrying') {
      if (a.retryCount != null) {
        return `${INDENT}⚠️ ${a.name}: retrying (${a.retryCount + 1}/${MAX_AGENT_RETRIES + 1})`;
      }
      return `${INDENT}⚠️ ${a.name}: retrying`;
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

function validPrTypeOrNull(prType: string): string | null {
  return VALID_PR_TYPES.has(prType) ? prType : null;
}

const VALID_EFFORTS = new Set(['low', 'medium', 'high']);

function sanitizeEffort(v: string): string {
  return VALID_EFFORTS.has(v) ? v : 'unknown';
}

const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocker', 'warning', 'suggestion', 'nitpick', 'ignore'];

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
    sections.push('**Review in progress**');
  }

  const plannerLines: string[] = [];
  if (data.phase === 'planning') {
    plannerLines.push(`**Planner**`);
    plannerLines.push(`${INDENT}analyzing...`);
  } else if (data.plannerInfo) {
    const prType = validPrTypeOrNull(data.plannerInfo.prType);
    const plannerDur = data.plannerDurationMs != null ? ` (${formatDuration(data.plannerDurationMs)})` : '';
    plannerLines.push(`**Planner**${plannerDur}`);
    const summaryParts = [
      ...(prType ? [prType] : []),
      `${data.lineCount} lines`,
      `${data.plannerInfo.agentCount} agents`,
    ];
    plannerLines.push(`${INDENT}${summaryParts.join(' · ')}`);
    plannerLines.push(`${INDENT}review effort: ${sanitizeEffort(data.plannerInfo.reviewerEffort)} · judge effort: ${sanitizeEffort(data.plannerInfo.judgeEffort)}`);
  } else {
    const plannerDur = data.plannerDurationMs != null ? ` (${formatDuration(data.plannerDurationMs)})` : '';
    plannerLines.push(`**Planner**${plannerDur}`);
    plannerLines.push(`${INDENT}${data.lineCount} lines · ${data.agentCount} agents`);
    if (data.heuristicFallback) {
      plannerLines.push(`${INDENT}_(planner heuristic fallback used)_`);
    }
  }
  sections.push(plannerLines.join('\n'));

  const reviewLines: string[] = [];
  if (data.phase === 'planning') {
    reviewLines.push(`**Review**`);
    reviewLines.push(`${INDENT}pending`);
  } else if (data.phase === 'started') {
    if (hasAgentProgress) {
      const done = agents.filter(a => a.status === 'done' || a.status === 'failed' || a.status === 'retrying').length;
      reviewLines.push(`**Review:** ${done}/${agents.length} agents complete`);
      reviewLines.push(renderAgentLines(agents));
    } else {
      reviewLines.push(`**Review**`);
      reviewLines.push(`${INDENT}reviewing with ${data.agentCount} agents...`);
    }
  } else {
    reviewLines.push(`**Review:** ${countOf(data.rawFindingCount ?? 0, 'finding')}`);
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
    judgeLines.push(`**Judge:** ${data.keptCount ?? 0} kept · ${data.droppedCount ?? 0} dropped${judgeDur}`);
    if (data.keptSeverities) {
      const breakdown = renderSeverityBreakdown(data.keptSeverities);
      if (breakdown) judgeLines.push(`${INDENT}kept: ${breakdown}`);
    }
    if (data.droppedSeverities) {
      const breakdown = renderSeverityBreakdown(data.droppedSeverities);
      if (breakdown) judgeLines.push(`${INDENT}dropped: ${breakdown}`);
    }
    if (data.testNitSuppressedCount != null && data.testNitSuppressedCount > 0) {
      judgeLines.push(`${INDENT}suppressed: ${data.testNitSuppressedCount} test-only nit${data.testNitSuppressedCount === 1 ? '' : 's'} (round ≥2 throttle)`);
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
    : `${BOT_MARKERS}\n${runIdMarker}\n**Review started**`;

  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  return data.id;
}

/**
 * Post an auto-approve specific "in progress" marker comment. Distinct body
 * text from `postProgressComment` so a human reading the PR sees which path
 * is running, but reuses `BOT_MARKERS` + `manki-run-id` so `findInProgressLock`
 * treats it as a live concurrency lock for sibling runs.
 */
export async function postAutoApproveProgressComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number> {
  const runIdMarker = buildRunIdMarker(github.context.runId);
  const body = `${BOT_MARKERS}\n${runIdMarker}\n**Auto-approving:** no findings remain.`;
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  return data.id;
}

/**
 * Transition the auto-approve progress comment to its terminal "complete"
 * state. Adds `REVIEW_COMPLETE_MARKER` so the comment is no longer treated as
 * a live in-progress lock by `findInProgressLock`.
 */
export async function markAutoApproveComplete(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
): Promise<void> {
  const body = [
    BOT_MARKER,
    VERSION_MARKER,
    '✅ **Auto-approved:** all findings are resolved.',
    REVIEW_COMPLETE_MARKER,
  ].join('\n');
  try {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
  } catch (error) {
    core.warning(`Failed to mark auto-approve comment as complete: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Transition a progress comment to a terminal failure state that names the
 * failed `action` and the reason, with tokens redacted. Uses `CANCELLED_MARKER`
 * so `findInProgressLock` no longer treats it as a live lock.
 */
export async function markProgressCommentFailed(
  octokit: Octokit,
  owner: string,
  repo: string,
  commentId: number,
  action: 'Review' | 'Auto-approve',
  reason: string,
): Promise<void> {
  const body = [
    BOT_MARKER,
    VERSION_MARKER,
    CANCELLED_MARKER,
    `🔴 **${action} failed:** ${sanitizeMarkdown(sanitizeTokens(String(reason))).slice(0, 300)}`,
  ].join('\n');
  try {
    await octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body });
  } catch (error) {
    core.warning(`Failed to mark ${action.toLowerCase()} comment as failed: ${error instanceof Error ? error.message : error}`);
  }
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
    metadata ? '✅ **Review complete**' : '🔴 **Review failed**',
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
    parts.push(`- Triage: ${metadata.config.triage}`);
    parts.push(`- Team: ${metadata.config.teamAgents.join(', ')}`);
    parts.push(`- Memory: ${metadata.config.memoryEnabled ? `enabled (${metadata.config.memoryRepo})` : 'disabled'}`);
    parts.push('');

    if (metadata.judgeDecisions.length > 0) {
      parts.push('**Judge decisions:**');
      for (const d of metadata.judgeDecisions) {
        parts.push(`- ${d.kept ? 'Kept' : 'Dropped'}: "${sanitizeMarkdown(d.title)}" (${d.severity}, ${d.confidence} confidence): "${sanitizeMarkdown(d.reasoning)}"`);
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
 * Dismiss the bot's `CHANGES_REQUESTED` reviews on this PR, except `keepReviewId`.
 * Call it only after the new review is posted, so a failed run leaves the merge
 * block in place. Never throws: the new review already stands.
 */
export async function dismissPreviousReviews(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  keepReviewId?: number,
): Promise<void> {
  let reviews;
  try {
    reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
  } catch (error) {
    core.warning(`Failed to dismiss previous reviews: ${error instanceof Error ? error.message : error}`);
    return;
  }

  for (const review of reviews) {
    if (review.id !== keepReviewId && review.body?.includes(BOT_MARKER) && review.state === 'CHANGES_REQUESTED') {
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

function countOf(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatStatsOneLiner(context: RoundContext, reviewTimeMs: number): string {
  const sev = context.findings.severityCounts;
  const breakdown = SEVERITY_ORDER
    .filter(s => s !== 'ignore' && (sev[s] ?? 0) > 0)
    .map(s => countOf(sev[s], s))
    .join(', ');
  const time = Math.round(reviewTimeMs / 1000);
  return `<!-- manki-stats: ${countOf(context.findings.count, 'finding')} (${breakdown || 'none'}), ${countOf(context.diff.lines, 'line')}, ${time}s -->`;
}

/**
 * Neutralise any `-->` or `--!>` inside a JSON payload by escaping the
 * closing `>` as the JSON Unicode escape. Both sequences close HTML5 comments.
 * Reversible: JSON parsing un-escapes back to `>`.
 */
function sanitizeHtmlCommentJson(json: string): string {
  return json.replace(/--(!?)>/g, '--$1\\u003E');
}

function formatContextBlock(context: RoundContext, hidden = false): string {
  const ctx = context.judge.threadEvaluations?.length === 0
    ? { ...context, judge: { ...context.judge, threadEvaluations: undefined } }
    : context;
  if (hidden) {
    const json = sanitizeHtmlCommentJson(JSON.stringify(ctx));
    return `<!-- manki-context: ${json} -->`;
  }
  const json = JSON.stringify(ctx, null, 2)
    .replace(/`/g, '\\u0060');
  return `<details>\n<summary>Manki context</summary>\n\n\`\`\`json\n${json}\n\`\`\`\n</details>`;
}

/**
 * Severity drop order when shrinking `findings.entries[]` to fit the review
 * body budget. Lowest-impact severities go first; metadata, agents, judge
 * summary, models, and usage are preserved unconditionally.
 *
 * `'unknown'` is placed before `'blocker'` because a confirmed blocker carries
 * more informational value than an entry whose severity could not be determined.
 */
const TRUNCATION_PRIORITY: ReadonlyArray<FindingFingerprintEntry['severity']> = [
  'ignore', 'nitpick', 'suggestion', 'warning', 'unknown', 'blocker',
];

/**
 * Drop entries from `findings.entries[]` in priority order until the
 * rendered review body is within `maxBodyLength`. Returns the (possibly
 * mutated) context, the count of entries dropped, and whether the judge
 * summary was capped. Caller is expected to `core.warning` on either signal.
 */
function truncateContextToFitBody(
  context: RoundContext,
  renderBody: (ctx: RoundContext) => string,
  maxBodyLength: number,
): { context: RoundContext; droppedCount: number; summaryCapped: boolean } {
  if (renderBody(context).length <= maxBodyLength) {
    return { context, droppedCount: 0, summaryCapped: false };
  }
  const remaining = [...context.findings.entries];
  let dropped = 0;
  for (const target of TRUNCATION_PRIORITY) {
    while (renderBody({ ...context, findings: { ...context.findings, entries: remaining, truncated: true } }).length > maxBodyLength) {
      const idx = remaining.findIndex(e => e.severity === target);
      if (idx === -1) break;
      remaining.splice(idx, 1);
      dropped++;
    }
    if (renderBody({ ...context, findings: { ...context.findings, entries: remaining, truncated: true } }).length <= maxBodyLength) {
      break;
    }
  }
  let truncated: RoundContext = {
    ...context,
    findings: { ...context.findings, entries: remaining, count: remaining.length, ...(dropped > 0 && { truncated: true }) },
  };
  let summaryCapped = false;
  if (renderBody(truncated).length > maxBodyLength && truncated.judge.summary) {
    const cappedSummary = safeTruncate(truncated.judge.summary, 2000);
    if (cappedSummary !== truncated.judge.summary) {
      truncated = { ...truncated, judge: { ...truncated.judge, summary: cappedSummary } };
      summaryCapped = true;
    }
  }
  return { context: truncated, droppedCount: dropped, summaryCapped };
}

const REVIEW_BODY_BUDGET = 60000;

/** The icon that opens a finding comment. Apart from the verdict line, the only emoji Manki posts. */
const SEVERITY_EMOJI: Record<FindingSeverity, string> = {
  blocker: '🚫',
  warning: '⚠️',
  suggestion: '✨',
  nitpick: '📝',
  ignore: '⚪',
};

/** Shown under a finding the judge kept with low confidence. */
const LOW_CONFIDENCE_NOTE = '_Manki is not sure this applies, so please check it._';

/** Non-blocking findings posted as line comments per review. The rest go in the body list. */
const MAX_NON_BLOCKING_INLINE = 5;

/** Marks a thread for a warning that no longer blocks, so auto-approve skips it. */
const FOLLOW_UP_MARKER = '<!-- manki-follow-up -->';

/** Whether a warning was deferred as a follow-up. A security finding never is, whatever its tags say. */
function isFollowUp(finding: Finding): boolean {
  return !!finding.tags?.includes(FOLLOW_UP_TAG) && !finding.tags.includes(SECURITY_TAG);
}

function isBlockingFinding(finding: Finding): boolean {
  return isBlockingSeverity(finding.severity) && !isFollowUp(finding);
}

function isOnChangedLine(finding: Finding, diff: ParsedDiff): boolean {
  const diffFile = finding.file ? diff.files.find(df => df.path === finding.file) : undefined;
  return !!diffFile && isLineInDiff(diffFile, finding.line);
}

/** Whether a finding sits on code that the inter-round diff did not touch. */
function isOnUnchangedCode(finding: Finding, interRoundDiff: ParsedDiff): boolean {
  if (!finding.file) return false;
  const diffFile = interRoundDiff.files.find(df => df.path === finding.file);
  if (!diffFile) return true;
  return finding.line > 0 && !isLineInDiff(diffFile, finding.line);
}

function inlineCode(text: string): string {
  const longestRun = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const ticks = '`'.repeat(longestRun + 1);
  return longestRun > 0 ? `${ticks} ${text} ${ticks}` : `${ticks}${text}${ticks}`;
}

type LineLink = (file: string, line: number) => string;

function repoUrl(serverUrl: string, owner: string, repo: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/${owner}/${repo}`;
}

function buildLineLink(owner: string, repo: string, commitSha: string, serverUrl: string): LineLink {
  return (file, line) => `${repoUrl(serverUrl, owner, repo)}/blob/${commitSha}/${file.split('/').map(encodeURIComponent).join('/')}${line > 0 ? `#L${line}` : ''}`;
}

/** Renders a fix for the body: one line of prose or code inline, anything longer as text and code blocks. */
function formatBodyFix(fix: string, file: string): string {
  const parts = splitFix(safeTruncate(fix, 600), file);
  const code = parts.filter(p => p.kind === 'code');
  if (code.length === 0) return `Fix: ${sanitizeMarkdown(parts.map(p => p.lines.join(' ')).join(' '))}`;
  if (parts.length === 1 && code[0].lines.length === 1 && code[0].lines[0].length <= SUGGESTION_MAX_LENGTH) {
    return `Fix: ${inlineCode(code[0].lines[0].trim())}`;
  }
  const rendered = parts.map(p => {
    const text = p.lines.join('\n');
    if (p.kind === 'prose') return sanitizeMarkdown(text);
    const fence = dynamicFence(text);
    return `${fence}${(p.lang ?? '').replace(/[^\w+#.-]/g, '')}\n${text}\n${fence}`;
  }).join('\n');
  return `Fix:\n${rendered}`;
}

/** Renders a finding listed in the review body: title, link to the line, what goes wrong, and the fix. */
function formatFindingBlock(finding: Finding, linkTo: LineLink): string {
  const lines = [`**${sanitizeMarkdown(finding.title)}**`];
  if (finding.judgeConfidence === 'low') lines.push(LOW_CONFIDENCE_NOTE);
  if (finding.file) {
    const location = `${sanitizeFilePath(finding.file)}${finding.line > 0 ? `:${finding.line}` : ''}`;
    lines.push(`[${inlineCode(location)}](${linkTo(finding.file, finding.line)})`);
  }
  const description = sanitizeMarkdown(finding.description.trim()).split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
  if (description) lines.push(safeTruncate(description, 300));
  if (finding.suggestedFix?.trim()) lines.push(formatBodyFix(finding.suggestedFix, finding.file));
  return lines.join('\n');
}

function formatSmallerFindings(entries: string[], unpostedCount: number): string | null {
  const parts: string[] = [];
  if (entries.length > 0) {
    parts.push(`<details>\n<summary>${countOf(entries.length, 'smaller fix', 'smaller fixes')} in this PR</summary>\n\n${entries.join('\n\n')}\n\n</details>`);
  }
  if (unpostedCount > 0) {
    parts.push(`${countOf(unpostedCount, 'smaller fix', 'smaller fixes')} on code unchanged since the last review ${unpostedCount === 1 ? 'is' : 'are'} not listed.`);
  }
  return parts.length > 0 ? parts.join('\n\n') : null;
}

/**
 * Posts each comment as a file-level review thread and returns the findings GitHub refused.
 * The create-review endpoint does not document `subject_type` on its comments, so these
 * go through the single-comment endpoint.
 */
async function postFileLevelComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  comments: Array<{ path: string; body: string; finding: Finding }>,
): Promise<Finding[]> {
  const refused: Finding[] = [];
  for (const c of comments) {
    try {
      await octokit.rest.pulls.createReviewComment({
        owner,
        repo,
        pull_number: prNumber,
        commit_id: commitSha,
        path: c.path,
        body: c.body,
        subject_type: 'file',
      });
    } catch (error) {
      core.warning(`Could not post file-level comment on ${c.path}: ${error instanceof Error ? error.message : error}`);
      refused.push(c.finding);
    }
  }
  return refused;
}

/** Whether an unresolved Manki thread was already posted for this finding. */
function hasOpenThread(finding: Finding, existingThreads: PreviousFinding[]): boolean {
  const open = existingThreads.filter(t => t.status !== 'resolved' && t.threadId && t.markerSlug);
  const fingerprint = { file: finding.file, lineStart: finding.line, lineEnd: finding.line, slug: titleToSlug(finding.title) };
  return findPriorThreadId(fingerprint, open) !== undefined;
}

/**
 * Post the review. Blocking findings become threads. Non-blocking findings on a changed line
 * become line comments marked "not blocking", up to `MAX_NON_BLOCKING_INLINE` and most severe
 * first. The rest go in the body.
 *
 * A blocking finding on a changed line gets a line comment, one elsewhere in a diff file
 * gets a file-level comment. A finding that one of the open `existingThreads` already carries
 * is not posted again. When `interRoundDiff` is given, non-blocking findings on code it did not
 * change are only counted.
 *
 * When `context` is provided without `reviewTimeMs`, the hidden stats line
 * records `0s` for review time. Pass both together to avoid this.
 */
export async function postReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  result: ReviewResult,
  diff?: ParsedDiff,
  context?: RoundContext,
  reviewTimeMs?: number,
  config?: ReviewConfig,
  { interRoundDiff, existingThreads = [] }: { interRoundDiff?: ParsedDiff; existingThreads?: PreviousFinding[] } = {},
): Promise<number> {
  const statsHidden = config?.stats?.hidden ?? true;
  const event = mapVerdictToEvent(result.verdict);

  const validComments: Array<{path: string; line: number; side: 'RIGHT'; body: string}> = [];
  const fileComments: Array<{ path: string; body: string; finding: Finding }> = [];
  const invalidComments: string[] = [];
  const generalFindings: string[] = [];
  const smallerFindings: string[] = [];
  let unpostedCount = 0;
  const nonBlocking: Finding[] = [];
  const linkTo = buildLineLink(owner, repo, commitSha, github.context.serverUrl);

  for (const f of result.findings) {
    if (!isBlockingFinding(f)) {
      if (!isFollowUp(f) && interRoundDiff && isOnUnchangedCode(f, interRoundDiff)) {
        unpostedCount++;
      } else if (hasOpenThread(f, existingThreads)) {
        core.info(`Skipping "${f.title}" on ${f.file}: an open thread already carries it`);
      } else {
        nonBlocking.push(f);
      }
      continue;
    }

    const diffFile = f.file ? diff?.files.find(df => df.path === f.file) : undefined;
    if (!f.file || (f.line <= 0 && !diffFile)) {
      generalFindings.push(formatFindingBlock(f, linkTo));
      continue;
    }

    const commentBody = formatFindingComment(f);

    if (!diff) {
      validComments.push({ path: f.file, line: f.line, side: 'RIGHT', body: commentBody });
    } else if (!diffFile) {
      invalidComments.push(formatFindingBlock(f, linkTo));
    } else if (f.line > 0 && isLineInDiff(diffFile, f.line)) {
      validComments.push({ path: f.file, line: f.line, side: 'RIGHT', body: commentBody });
    } else if (hasOpenThread(f, existingThreads)) {
      core.info(`Skipping file-level comment for "${f.title}" on ${f.file}: an open thread already carries it`);
    } else {
      fileComments.push({ path: f.file, body: commentBody, finding: f });
    }
  }

  const inline = new Set(nonBlocking
    .filter(f => diff && f.line > 0 && isOnChangedLine(f, diff))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
    .slice(0, MAX_NON_BLOCKING_INLINE));
  for (const f of nonBlocking) {
    if (inline.has(f)) {
      validComments.push({ path: f.file, line: f.line, side: 'RIGHT', body: formatFindingComment(f) });
    } else {
      smallerFindings.push(formatFindingBlock(f, linkTo));
    }
  }

  const reviewedCommitFooter = buildReviewedCommitFooter(owner, repo, commitSha, github.context.serverUrl);

  const blockingFindings = result.findings.filter(isBlockingFinding);
  const lead = formatLead(result, blockingFindings);

  const renderBody = (ctx: RoundContext | undefined): string => {
    let b = `${BOT_MARKERS}\n${lead}`;
    const needsHuman = formatNeedsHuman(result);
    if (needsHuman) {
      b += `\n\n${needsHuman}`;
    }
    const blockingThreads = formatBlockingPriorThreads(result);
    if (blockingThreads) {
      b += `\n\n${blockingThreads}`;
    }
    const readyReport = formatReadyReport(result);
    if (readyReport) {
      b += `\n\n${readyReport}`;
    }
    if (generalFindings.length > 0) {
      b += `\n\n**Blockers not tied to a line:**\n\n${generalFindings.join('\n\n')}`;
    }
    if (invalidComments.length > 0) {
      b += `\n\n**Blockers in files outside this diff:**\n\n${invalidComments.join('\n\n')}`;
    }
    const smaller = formatSmallerFindings(smallerFindings, unpostedCount);
    if (smaller) {
      b += `\n\n${smaller}`;
    }
    if (ctx) {
      b += `\n\n${formatStatsOneLiner(ctx, reviewTimeMs ?? 0)}`;
      b += `\n${formatContextBlock(ctx, statsHidden)}`;
    }
    return b;
  };

  let effectiveContext = context;
  if (context) {
    const { context: maybeTruncated, droppedCount, summaryCapped } = truncateContextToFitBody(
      context,
      ctx => renderBody(ctx),
      REVIEW_BODY_BUDGET,
    );
    effectiveContext = maybeTruncated;
    if (droppedCount > 0 || summaryCapped) {
      core.warning(`Manki context truncated: dropped ${droppedCount} finding entries${summaryCapped ? ', judge summary capped at 2000 chars' : ''} to fit comment body`);
    }
  }
  // Generated text often names code without backticks, so every posted body is highlighted before it goes out.
  const codeTokens = diff ? codeTokensFromDiff(diff) : new Set<string>();
  const highlight = <T extends { body: string }>(c: T): T => ({ ...c, body: highlightCode(c.body, codeTokens) });
  const body = highlightCode(renderBody(effectiveContext), codeTokens);

  if (invalidComments.length > 0) {
    core.info(`Moved ${invalidComments.length} comments to review body (not postable as threads)`);
  }
  core.info(`Posting review: ${event} with ${validComments.length} line comments and ${fileComments.length} file-level comments`);

  const review = await submitReview(octokit, owner, repo, prNumber, commitSha, result.verdict, body, validComments.map(highlight), reviewedCommitFooter);
  const refused = await postFileLevelComments(octokit, owner, repo, prNumber, commitSha, fileComments.map(highlight));
  if (refused.length > 0) {
    const titles = refused.map(f => `"${f.title}" (${f.file})`).join(', ');
    const section = highlightCode(`\n\n**Blockers that could not be posted as threads:**\n\n${refused.map(f => formatFindingBlock(f, linkTo)).join('\n\n')}`, codeTokens);
    // Truncate the existing body, never the blocking findings appended to it.
    const room = REVIEW_BODY_BUDGET - section.length;
    if (room <= 0) {
      throw new Error(`Could not post blocking findings as threads or fit them in review #${review.id}: ${titles}`);
    }
    try {
      await octokit.rest.pulls.updateReview({
        owner,
        repo,
        pull_number: prNumber,
        review_id: review.id,
        body: appendReviewedCommitFooter(`${truncateBody(review.body, room)}${section}`, reviewedCommitFooter),
      });
    } catch (error) {
      throw new Error(`Could not post blocking findings as threads or in review #${review.id}: ${titles}. ${error instanceof Error ? error.message : error}`);
    }
  }
  return review.id;
}

/**
 * Creates the review, falling back to a body-only review when GitHub rejects the line
 * comments and to COMMENT when it refuses the event with a 422. Returns the review ID
 * and the posted body without the reviewed-commit footer.
 */
async function submitReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  commitSha: string,
  verdict: ReviewVerdict,
  body: string,
  validComments: Array<{path: string; line: number; side: 'RIGHT'; body: string}>,
  reviewedCommitFooter: string,
): Promise<{ id: number; body: string }> {
  const event = mapVerdictToEvent(verdict);
  try {
    const { data: review } = await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      event,
      body: appendReviewedCommitFooter(truncateBody(body), reviewedCommitFooter),
      comments: validComments,
    });

    core.info(`Posted review #${review.id} with verdict ${verdict}`);
    return { id: review.id, body: truncateBody(body) };
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
        body: appendReviewedCommitFooter(lineErrFallbackBody, reviewedCommitFooter),
        comments: [],
      });

      core.info(`Posted review #${review.id} without inline comments (line validation failed)`);
      return { id: review.id, body: lineErrFallbackBody };
    }

    // Only a 422 is GitHub refusing this review event (e.g. approving or requesting
    // changes is not allowed), so a 5xx or rate limit must not weaken the verdict.
    const status = (error as { status?: number }).status;
    if (event === 'COMMENT' || status !== 422) {
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
      body: appendReviewedCommitFooter(fallbackBody, reviewedCommitFooter),
      comments: [],
    });

    core.info(`Posted fallback COMMENT review #${review.id} (original verdict: ${verdict})`);
    return { id: review.id, body: fallbackBody };
  }
}

function dynamicFence(content: string): string {
  const maxBt = (content.match(/`+/g) || []).reduce((max: number, s: string) => Math.max(max, s.length), 0);
  return '`'.repeat(Math.max(3, maxBt + 1));
}

function buildReviewedCommitFooter(owner: string, repo: string, commitSha: string, serverUrl: string): string {
  return `Reviewed [\`${commitSha.slice(0, 7)}\`](${repoUrl(serverUrl, owner, repo)}/commit/${commitSha}).`;
}

function appendReviewedCommitFooter(body: string, footer: string): string {
  return `${body}\n\n${footer}`;
}

function truncateBody(text: string, maxLength: number = 60000): string {
  if (text.length <= maxLength) return text;
  const notice = '\n\n*(Review body truncated)*';
  const safeMax = Math.max(0, maxLength - notice.length);
  const cutoff = text.lastIndexOf(' ', safeMax);
  return text.slice(0, cutoff > safeMax - 100 ? cutoff : safeMax) + notice;
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

function asSentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?:]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** The first line of the review body for each outcome. Its emoji is the only one in the review. */
const VERDICT_LINES: Record<RoundOutcome, (result: ReviewResult, blockerCount: number) => string> = {
  READY: () => '✅ **Approved.**',
  ADDRESS_FIRST: (_result, blockerCount) => `🔴 **Changes requested:** ${countOf(blockerCount, 'blocker')}.`,
  INCOMPLETE: result => `⚠️ **Review incomplete:** ${asSentence(sanitizeMarkdown(result.summary.trim()) || 'The review did not finish')}`,
  NOT_CONVERGING: result => {
    const blockers = countOf(result.needsHuman?.blockers.length ?? 0, 'blocker');
    return result.needsHuman?.cause === 'budget'
      ? `🛑 **Needs a human:** ${blockers} still open after the last automatic round.`
      : `🛑 **Needs a human:** ${blockers} came back after a fix.`;
  },
  BUDGET: () => '✅ **Approved.**',
};

/** Returns what goes wrong in practice, from the judge summary or else the top blocker's description. */
function formatVerdictDetail(result: ReviewResult, blocking: Finding[]): string {
  const summary = sanitizeMarkdown(result.summary.trim());
  if (result.outcome === 'READY' || result.outcome === 'BUDGET') return result.verdictReport ? '' : summary;
  if (result.outcome !== 'ADDRESS_FIRST') return '';
  // The judge writes its summary before the verdict reader runs, so it never describes the reader's blockers.
  if (summary && result.verdictReason !== 'verdict_reader') return asSentence(summary);
  const top = blocking.find(f => f.severity === 'blocker') ?? blocking[0];
  return top ? sanitizeMarkdown(top.description.trim()).split(/(?<=[.!?])\s+/).slice(0, 2).join(' ') : '';
}

/** Returns the verdict line and the sentences under it that open the review body. */
function formatLead(result: ReviewResult, blocking: Finding[]): string {
  if (!result.outcome) return sanitizeMarkdown(result.summary.trim());
  const blockerCount = blocking.length || (result.verdictTrace?.unresolvedPriors.length ?? 0);
  const line = VERDICT_LINES[result.outcome](result, blockerCount);
  const detail = formatVerdictDetail(result, blocking);
  return detail ? `${line}\n\n${detail}` : line;
}

/**
 * Lists every entry in `verdictTrace.unresolvedPriors` when the outcome is blocked by
 * `prior_unaddressed`, with its location and a link to the thread, so the author sees
 * which earlier thread blocks without reading the context JSON.
 */
export function formatBlockingPriorThreads(result: { verdictReason?: VerdictReason; verdictTrace?: VerdictTrace }): string | null {
  if (result.verdictReason !== 'prior_unaddressed') return null;
  const priors = result.verdictTrace?.unresolvedPriors ?? [];
  if (priors.length === 0) return null;

  return `**Still open from earlier reviews:**\n${priors.map(formatTraceEntry).join('\n')}`;
}

function formatTraceEntry(p: VerdictTraceEntry): string {
  const file = sanitizeFilePath(p.file);
  const location = !file ? '' : p.line != null ? `\`${file}:${p.line}\`: ` : `\`${file}\`: `;
  const title = sanitizeMarkdown(p.title || '(untitled)');
  const safeUrl = p.threadUrl && /^https?:\/\/[^\s)]+$/.test(p.threadUrl) ? p.threadUrl : null;
  const link = safeUrl ? ` ([view thread](${safeUrl}))` : '';
  return `- ${location}${title}${link}`;
}

function formatNeedsHuman(result: ReviewResult): string | null {
  if (result.outcome !== 'NOT_CONVERGING' || !result.needsHuman) return null;
  return `Automatic review is paused until someone comments \`@manki review\`.\n\n${result.needsHuman.blockers.map(formatTraceEntry).join('\n')}`;
}

function formatLabelled(label: string, text: string): string {
  const safe = sanitizeMarkdown(text.trim());
  return `**${label}:**${safe.includes('\n') ? '\n\n' : ' '}${safe}`;
}

/** Renders the setup on its own line and the steps as a numbered list, one step per line. */
function formatTestGuide(guide: TestGuide): string {
  const oneLine = (text: string): string => sanitizeMarkdown(text.replace(/\s+/g, ' ').trim());
  const steps = guide.steps.map((step, i) => `${i + 1}. ${oneLine(step.replace(/^\s*\d+[.)]\s*/, ''))}`).join('\n');
  return guide.setup ? `**Setup:** ${oneLine(guide.setup)}\n\n${steps}` : steps;
}

function formatReadyReport(result: ReviewResult): string | null {
  if ((result.outcome !== 'READY' && result.outcome !== 'BUDGET') || !result.verdictReport) return null;
  const { whatThisDoes, whatToTest } = result.verdictReport;
  return `${formatLabelled('What this does', whatThisDoes)}\n\n**What to test:**\n\n${formatTestGuide(whatToTest)}`;
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

/** Reduce a finding title to a URL-safe slug for use in HTML comment markers and fingerprints. */
export function titleToSlug(title: string): string {
  return title.replace(/[^a-zA-Z0-9]/g, '-');
}

const SUGGESTION_MAX_LINES = 3;
const SUGGESTION_MAX_LENGTH = 120;
const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})(.*)$/;
const PROSE_LINE_RE = /^[A-Z][A-Za-z']*(?:\s+\S+){2,}[.:]$/;
// A comment that says where the code goes, such as `// After the guard, add:`, means the code does not apply as is.
const PLACEMENT_COMMENT_RE = /^\s*(?:\/\/|#|--|\/\*)\s+(?:(?:in|after|before|replace|add|then|change|move|instead)\b|.*:\s*(?:\*\/)?$)/i;
const PROSE_FILE_RE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;

interface FixPart {
  kind: 'prose' | 'code';
  lines: string[];
  lang?: string;
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start++;
  while (end > start && !lines[end - 1].trim()) end--;
  return lines.slice(start, end);
}

/**
 * Splits a suggested fix into prose and code. With fences, everything outside them is prose.
 * Without, prose lines are peeled off the start and the end, except in prose files.
 */
function splitFix(fix: string, file: string): FixPart[] {
  const lines = fix.split('\n');
  if (!lines.some(l => FENCE_LINE_RE.test(l))) {
    const isProse = (l: string): boolean => !PROSE_FILE_RE.test(file) && (PROSE_LINE_RE.test(l.trim()) || !l.trim());
    let start = 0;
    let end = lines.length;
    while (start < end && isProse(lines[start])) start++;
    while (end > start && isProse(lines[end - 1])) end--;
    return [
      { kind: 'prose' as const, lines: lines.slice(0, start) },
      { kind: 'code' as const, lines: lines.slice(start, end) },
      { kind: 'prose' as const, lines: lines.slice(end) },
    ].map(p => ({ ...p, lines: trimBlankLines(p.lines) })).filter(p => p.lines.length > 0);
  }
  const parts: FixPart[] = [];
  let fence: string | null = null;
  let current: FixPart = { kind: 'prose', lines: [] };
  for (const line of lines) {
    const marker = line.match(FENCE_LINE_RE);
    if (!marker) {
      current.lines.push(line);
    } else if (fence === null) {
      parts.push(current);
      fence = marker[1];
      current = { kind: 'code', lines: [], lang: marker[2].trim() };
    } else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
      parts.push(current);
      fence = null;
      current = { kind: 'prose', lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  parts.push(current);
  return parts.map(p => ({ ...p, lines: trimBlankLines(p.lines) })).filter(p => p.lines.length > 0);
}

/**
 * Renders a suggested fix. Only code that replaces the flagged line as is goes in a
 * `suggestion` block, because committing it writes the block verbatim into the file.
 * Anything else is shown as text and plain code blocks.
 */
function formatSuggestedFix(fix: string, file: string): string {
  const parts = splitFix(fix, file);
  const code = parts.filter(p => p.kind === 'code').map(p => p.lines.join('\n'));
  const isShort = code.every(c => c.split('\n').length <= SUGGESTION_MAX_LINES && c.length <= SUGGESTION_MAX_LENGTH);
  if (parts.length === 1 && code.length === 1 && isShort && !PLACEMENT_COMMENT_RE.test(code[0].split('\n')[0])) {
    const fence = dynamicFence(code[0]);
    return `${fence}suggestion\n${code[0]}\n${fence}`;
  }
  // Code inside a dynamic fence renders literally, so only the prose needs sanitizing.
  const rendered = parts.map(p => {
    const text = p.lines.join('\n');
    if (p.kind === 'prose') return sanitizeMarkdown(text);
    const fence = dynamicFence(text);
    return `${fence}${(p.lang ?? '').replace(/[^\w+#.-]/g, '')}\n${text}\n${fence}`;
  }).join('\n\n');
  return isShort ? rendered : `<details>\n<summary>Suggested fix</summary>\n\n${rendered}\n</details>`;
}

function formatFindingComment(finding: Finding): string {
  const severity = `${finding.severity[0].toUpperCase()}${finding.severity.slice(1)}`;
  const label = isBlockingFinding(finding) ? severity : `${severity}, not blocking`;
  let comment = `${SEVERITY_EMOJI[finding.severity]} **${label}:** ${sanitizeMarkdown(finding.title)}\n\n`;
  if (finding.judgeConfidence === 'low') comment += `${LOW_CONFIDENCE_NOTE}\n\n`;
  comment += sanitizeMarkdown(finding.description);
  if (finding.suggestedFix?.trim()) {
    comment += `\n\n${formatSuggestedFix(finding.suggestedFix, finding.file)}`;
  }

  const data: Record<string, unknown> = {
    file: finding.file,
    line: finding.line,
    severity: finding.severity,
    ...(finding.judgeConfidence && { confidence: finding.judgeConfidence }),
    flaggedBy: finding.reviewers,
    title: finding.title,
    ...(finding.suggestedFix && { fix: finding.suggestedFix.slice(0, 200) }),
    ...(finding.tags && finding.tags.length > 0 && { tags: finding.tags }),
    ...(finding.reachability && { reachability: finding.reachability }),
    ...(finding.reachabilityReasoning && { reachabilityReasoning: finding.reachabilityReasoning }),
    ...(finding.originalSeverity && { originalSeverity: finding.originalSeverity }),
  };
  comment += `\n\n<!-- manki:${finding.severity}:${titleToSlug(finding.title)} -->`;
  if (isFollowUp(finding)) comment += `\n${FOLLOW_UP_MARKER}`;
  comment += `\n<!-- manki-finding: ${sanitizeHtmlCommentJson(JSON.stringify(data))} -->`;

  return comment;
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
    '**Review cancelled:** a newer run replaced it.',
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

interface GraphqlConnection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

/**
 * Runs `query` page by page from `cursor` and returns every node of the connection `connectionOf` picks.
 * `query` must take a `$cursor: String` variable and select `pageInfo { hasNextPage endCursor }`.
 */
async function paginateGraphql<R, T>(
  octokit: Octokit,
  query: string,
  variables: Record<string, unknown>,
  connectionOf: (result: R) => GraphqlConnection<T>,
  cursor: string | null = null,
): Promise<T[]> {
  const nodes: T[] = [];
  do {
    const connection = connectionOf(await octokit.graphql<R>(query, { ...variables, cursor }));
    nodes.push(...connection.nodes);
    cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);
  return nodes;
}

/** Returns every review thread on the PR. `threadFields` is the GraphQL selection for one thread. */
async function fetchReviewThreadNodes<T>(
  octokit: Octokit, owner: string, repo: string, prNumber: number, threadFields: string,
): Promise<T[]> {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { ${threadFields} }
          }
        }
      }
    }
  `;
  return paginateGraphql(
    octokit, query, { owner, repo, prNumber },
    (result: { repository: { pullRequest: { reviewThreads: GraphqlConnection<T> } } }) => result.repository.pullRequest.reviewThreads,
  );
}

interface ProgressComment {
  id: number;
  body: string;
  runId: number | null;
}

/** Returns every comment on the PR, most recently updated first. */
async function fetchPRComments(
  octokit: Octokit, owner: string, repo: string, prNumber: number,
): Promise<IssueComment[]> {
  const data = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: prNumber, per_page: 100,
  });
  return [...data].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

/**
 * Find the most recent non-complete, non-cancelled progress comment posted by the bot.
 */
function findProgressComment(comments: IssueComment[], bot: BotIdentity): ProgressComment | null {
  const match = comments.find(c =>
    isBotUser(bot, c.user) &&
    c.body?.includes(BOT_MARKER) &&
    !c.body?.includes(REVIEW_COMPLETE_MARKER) &&
    !c.body?.includes(FORCE_REVIEW_MARKER) &&
    !c.body?.includes(FORCE_CAP_MARKER) &&
    !c.body?.includes(CANCELLED_MARKER)
  );
  if (!match || !match.body) return null;
  return { id: match.id, body: match.body, runId: extractRunIdFromBody(match.body) };
}

const ACTIVE_RUN_STATUSES = new Set([
  'in_progress', 'queued', 'waiting', 'pending', 'requested', 'action_required',
]);

/**
 * Check whether a review is currently in progress for a PR by verifying the
 * embedded Actions run_id via the GitHub Actions API. Zombie comments from
 * cancelled/failed runs are marked as cancelled in-place (not deleted) so the
 * audit trail is preserved.
 */
async function isReviewInProgress(octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number): Promise<boolean> {
  let progress: ProgressComment | null;
  try {
    const comments = await fetchPRComments(octokit, owner, repo, prNumber);
    progress = findProgressComment(comments, bot);
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

  if (ACTIVE_RUN_STATUSES.has(status ?? '')) {
    core.info(`Skipping — review already in progress (run ${progress.runId}, status=${status})`);
    return true;
  }

  core.info(`Progress comment belongs to completed run ${progress.runId} (status=${status}, conclusion=${conclusion}) — marking as cancelled`);
  await markProgressCommentCancelled(octokit, owner, repo, progress.id, progress.body);
  return false;
}

/**
 * Lock info for an in-progress marker comment posted by a different run.
 */
interface InProgressLock {
  runId: number;
  updatedAt: string;
  commentId: number;
}

/**
 * Scan the PR's bot comments for an in-progress marker carrying a `manki-run-id`
 * that differs from `currentRunId`. Returns the most recent such comment, or
 * null when none is found. Skips terminal-state comments (complete, cancelled,
 * force-review / force-cap stubs) and comments whose run id cannot be parsed.
 *
 * Used as a defense-in-depth check at the review entry point: if a sibling run
 * has already announced "Review in progress" within the configured TTL, the
 * current run bails before any LLM cost is incurred. This complements the
 * workflow-level `concurrency` group, which is best-effort and can let two
 * runs reach `in_progress` within the same scheduling window.
 */
function findInProgressLock(comments: IssueComment[], bot: BotIdentity, currentRunId: number): InProgressLock | null {
  for (const c of comments) {
    if (!isBotUser(bot, c.user)) continue;
    if (!c.body?.includes(BOT_MARKER)) continue;
    if (c.body.includes(REVIEW_COMPLETE_MARKER)) continue;
    if (c.body.includes(CANCELLED_MARKER)) continue;
    if (c.body.includes(FORCE_REVIEW_MARKER)) continue;
    if (c.body.includes(FORCE_CAP_MARKER)) continue;
    const runId = extractRunIdFromBody(c.body);
    if (runId === null) continue;
    if (runId === currentRunId) continue;
    return { runId, updatedAt: c.updated_at, commentId: c.id };
  }
  return null;
}

/**
 * True when `updatedAt` is older than `ttlSeconds` relative to `now`. Used to
 * ignore in-progress markers from runs that crashed without clearing their
 * lock, so a single stale comment cannot wedge the PR indefinitely.
 */
function isLockExpired(updatedAt: string, ttlSeconds: number, now: Date): boolean {
  const updated = Date.parse(updatedAt);
  if (!Number.isFinite(updated)) return true;
  return (now.getTime() - updated) / 1000 > ttlSeconds;
}

const DEFAULT_CONCURRENCY_LOCK_TTL_SECONDS = 600;

function readConcurrencyLockTtlSeconds(config?: ReviewConfig): number {
  const raw = core.getInput('concurrency_lock_ttl_seconds');
  if (raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > MAX_LOCK_TTL_SECONDS) {
      core.warning(`Invalid concurrency_lock_ttl_seconds=${raw}, using default ${DEFAULT_CONCURRENCY_LOCK_TTL_SECONDS}`);
      return DEFAULT_CONCURRENCY_LOCK_TTL_SECONDS;
    }
    return n;
  }
  const fromConfig = config?.concurrency_lock_ttl_seconds;
  if (fromConfig === undefined) return DEFAULT_CONCURRENCY_LOCK_TTL_SECONDS;
  if (!Number.isFinite(fromConfig) || fromConfig <= 0 || fromConfig > MAX_LOCK_TTL_SECONDS) {
    core.warning(`Invalid \`concurrency_lock_ttl_seconds\` in config (${fromConfig}), using default ${DEFAULT_CONCURRENCY_LOCK_TTL_SECONDS}`);
    return DEFAULT_CONCURRENCY_LOCK_TTL_SECONDS;
  }
  return fromConfig;
}

/**
 * Defense-in-depth check before any LLM call. When another Manki
 * run has posted an in-progress marker comment whose `manki-run-id` differs
 * from ours and whose `updated_at` is within the configured TTL, bail to avoid
 * a double review. The workflow-level `concurrency` group is best-effort and
 * can let two runs reach `in_progress` within the same scheduling window.
 *
 * Returns `true` when the caller should bail.
 */
async function checkConcurrentSubmissionLock(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, config?: ReviewConfig,
): Promise<boolean> {
  const currentRunId = github.context.runId;
  let lock;
  try {
    const comments = await fetchPRComments(octokit, owner, repo, prNumber);
    lock = findInProgressLock(comments, bot, currentRunId);
  } catch (error) {
    core.warning(`Concurrency lock scan failed: ${error instanceof Error ? error.message : error}`);
    return false;
  }
  if (!lock) return false;

  const ttlSeconds = readConcurrencyLockTtlSeconds(config);
  const now = new Date();
  if (isLockExpired(lock.updatedAt, ttlSeconds, now)) {
    core.info(`Ignoring stale in-progress marker from run ${lock.runId} (updated_at=${lock.updatedAt}, TTL=${ttlSeconds}s)`);
    return false;
  }
  const ageSeconds = Math.round((now.getTime() - Date.parse(lock.updatedAt)) / 1000);
  core.warning(`Bailing: another Manki run (id=${lock.runId}) posted an in-progress marker ${ageSeconds}s ago (TTL=${ttlSeconds}s). Defense-in-depth lock engaged before LLM call.`);
  return true;
}

/**
 * Post-step cleanup: find our run's progress comment and mark it as cancelled.
 * Invoked when GitHub Actions cancels the main step.
 */
async function markOwnProgressCommentCancelled(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, runId: number,
): Promise<boolean> {
  try {
    const comments = await fetchPRComments(octokit, owner, repo, prNumber);
    const target = comments.find(c =>
      isBotUser(bot, c.user) &&
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

type BotReviewSummary = {
  id: number;
  state: string;
  commitId: string;
  htmlUrl: string;
  body: string;
};

/**
  * Shared scanner: returns all non-DISMISSED reviews by `bot` on the
  * PR in API order (oldest first), or every one with `includeDismissed`. Callers
  * filter to the commit SHA they care about.
 *
 * Fail-open contract: any API error returns `[]` rather than throwing, so
 * callers such as `hasBotReviewOnCommit` and `isApprovedOnCommit` return
 * `false` and allow the run to proceed. Callers must not wrap this function in
 * a try/catch to handle errors — the catch is already here.
 */
async function fetchBotReviews(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, includeDismissed = false,
): Promise<BotReviewSummary[]> {
  try {
    const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });
    return reviews.slice(-500)
      .filter((r: { state?: string; user?: { login?: string } | null; body?: string | null }) =>
        isBotUser(bot, r.user) && (includeDismissed || r.state !== 'DISMISSED') &&
        !!r.body && r.body.includes(BOT_MARKER),
      )
      .map((r: unknown) => {
        const raw = r as { id: number; state: string; commit_id: string; html_url?: string; body?: string | null };
        return {
          id: raw.id,
          state: raw.state,
          commitId: raw.commit_id,
          htmlUrl: raw.html_url ?? '',
          body: raw.body ?? '',
        };
      });
  } catch {
    return [];
  }
}

/**
 * State-based head-SHA dedupe gate. Returns the most-recent non-DISMISSED
 * review by `bot` whose `commit_id` matches `commitSha`, otherwise
 * `undefined`. Run entry points consult this before any LLM call so serialized
 * sibling events (e.g., the `pull_request_review` + `pull_request_review_comment`
 * fan-out from a single human review) cannot post duplicate reviews on the
 * same commit. Complements the temporally-overlapping `checkConcurrentSubmissionLock`.
 */
async function findBotReviewOnCommit(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, commitSha: string,
): Promise<BotReviewSummary | undefined> {
  const reviews = await fetchBotReviews(octokit, bot, owner, repo, prNumber);
  const onCommit = reviews.filter(r => r.commitId === commitSha);
  return onCommit[onCommit.length - 1];
}

async function hasBotReviewOnCommit(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, commitSha: string,
): Promise<boolean> {
  return (await findBotReviewOnCommit(octokit, bot, owner, repo, prNumber, commitSha)) !== undefined;
}

/**
 * Auto-approve gate. Returns true only when the latest non-DISMISSED bot review
 * (across all commits on the PR) is APPROVED and lands on `commitSha`. The
 * "latest across all commits" semantic is preserved so a fresh CHANGES_REQUESTED
 * on a newer commit overrides an older APPROVED.
 */
async function isApprovedOnCommit(octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number, commitSha: string): Promise<boolean> {
  const reviews = await fetchBotReviews(octokit, bot, owner, repo, prNumber);
  const latest = reviews[reviews.length - 1];
  if (!latest || latest.state !== 'APPROVED') return false;
  return latest.commitId === commitSha;
}

type StandingVerdict = {
  verdict: 'APPROVE' | 'REQUEST_CHANGES';
  commitSha: string;
};

/**
 * Returns the verdict of the latest bot review and the commit it reviewed. An
 * approval that a push dismissed still counts as APPROVE. Returns `undefined`
 * for a comment, a dismissal by hand, or when the reviews cannot be read.
 */
async function fetchStandingVerdict(
  octokit: Octokit, bot: BotIdentity, owner: string, repo: string, prNumber: number,
): Promise<StandingVerdict | undefined> {
  const latest = (await fetchBotReviews(octokit, bot, owner, repo, prNumber, true)).at(-1);
  if (!latest) return undefined;
  if (latest.state === 'APPROVED') return { verdict: 'APPROVE', commitSha: latest.commitId };
  if (latest.state === 'CHANGES_REQUESTED') return { verdict: 'REQUEST_CHANGES', commitSha: latest.commitId };
  if (latest.state !== 'DISMISSED') return undefined;
  // The reviews API reports only `DISMISSED`. The timeline keeps the state
  // before the dismissal and, for a push, the commit that caused it.
  try {
    const events = await octokit.paginate(octokit.rest.issues.listEventsForTimeline, {
      owner, repo, issue_number: prNumber, per_page: 100,
    });
    const dismissed = events
      .map(e => ('dismissed_review' in e ? e.dismissed_review : undefined))
      .find(d => d?.review_id === latest.id);
    if (dismissed?.state === 'approved' && dismissed.dismissal_commit_id) {
      return { verdict: 'APPROVE', commitSha: latest.commitId };
    }
  } catch (error) {
    core.warning(`Failed to read review dismissals: ${error instanceof Error ? error.message : error}`);
  }
  return undefined;
}

const APP_WARNING_MARKER = '<!-- manki-app-warning -->';
const CONFIG_ERROR_MARKER = '<!-- manki-config-error -->';

async function postAppWarningIfNeeded(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<void> {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, {
    owner, repo, issue_number: prNumber,
  });

  if (comments.some(c =>
    isBotLogin(bot, c.user?.login) &&
    c.body?.includes(APP_WARNING_MARKER)
  )) {
    return;
  }

  await octokit.rest.issues.createComment({
    owner, repo, issue_number: prNumber,
    body: `${APP_WARNING_MARKER}\nThe [Manki GitHub App](https://github.com/apps/manki-review) is not installed on this repository. Reviews are posting as \`github-actions[bot]\` instead of \`manki-review[bot]\`. Some features (memory repo access, bot identity for review dismissal) may not work correctly.\n\nInstall the app at: https://github.com/apps/manki-review`,
  });
}

/**
 * Posts a config load error on the PR. Uses its own marker instead of `BOT_MARKER`,
 * so the progress-comment scans never treat it as a run in progress or a stale one.
 */
async function postConfigErrorComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  message: string,
): Promise<void> {
  const fence = dynamicFence(message);
  const body = `${CONFIG_ERROR_MARKER}\n**Manki** could not load its config, so no review ran. Fix the file and push again.\n\n${fence}\n${message}\n${fence}`;
  try {
    await octokit.rest.issues.createComment({ owner, repo, issue_number: prNumber, body });
  } catch (error) {
    core.warning(`Failed to post config error comment: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Cancel the in-progress review run for a PR, if one exists.
 * Returns true if a run was successfully cancelled, false otherwise.
 *
 * Requires actions: write permission on the workflow token.
 */
async function cancelActiveReviewRun(
  octokit: Octokit,
  bot: BotIdentity,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  let progress: ProgressComment | null;
  try {
    const comments = await fetchPRComments(octokit, owner, repo, prNumber);
    progress = findProgressComment(comments, bot);
  } catch {
    return false;
  }
  if (!progress) return false;

  const runId = progress.runId;
  if (!runId) return false;

  if (runId === github.context.runId) {
    core.warning('Skipping self-cancellation');
    return false;
  }

  let runData: { status?: string | null };
  try {
    const { data } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: runId });
    runData = data;
  } catch (error) {
    core.warning(`Failed to query run ${runId}: ${error instanceof Error ? error.message : error}`);
    return false;
  }
  if (!ACTIVE_RUN_STATUSES.has(runData.status ?? '')) {
    core.info(`Run ${runId} is already ${runData.status} — skipping cancel`);
    return false;
  }
  try {
    await octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id: runId });
    // cancelWorkflowRun transitions the run to 'cancelling' — the old run may
    // still complete in-flight API calls before stopping.
    core.info(`Cancelled in-progress review run ${runId}`);
    await markProgressCommentCancelled(octokit, owner, repo, progress.id, progress.body);
    return true;
  } catch (error) {
    core.warning(`Failed to cancel run ${runId}: ${error instanceof Error ? error.message : error}`);
    return false;
  }
}

export { dynamicFence, formatContextBlock, formatFindingComment, formatStatsOneLiner, mapVerdictToEvent, resolveReferences, sanitizeFilePath, sanitizeMarkdown, truncateBody, truncateContextToFitBody, BOT_LOGIN, ACTIONS_BOT_LOGIN, BotIdentity, isBotLogin, isTrustedAssociation, BOT_MARKER, REVIEW_COMPLETE_MARKER, FORCE_REVIEW_MARKER, FORCE_CAP_MARKER, CANCELLED_MARKER, RUN_ID_MARKER_PREFIX, VERSION_MARKER_PREFIX, MANKI_VERSION, isReviewInProgress, isApprovedOnCommit, hasBotReviewOnCommit, findBotReviewOnCommit, markOwnProgressCommentCancelled, cancelActiveReviewRun, extractRunIdFromBody, extractVersionFromBody, fetchPRComments, findInProgressLock, isLockExpired, checkConcurrentSubmissionLock, GraphqlConnection, paginateGraphql, fetchReviewThreadNodes, APP_WARNING_MARKER, postAppWarningIfNeeded, CONFIG_ERROR_MARKER, postConfigErrorComment, fetchStandingVerdict, FOLLOW_UP_MARKER, LOW_CONFIDENCE_NOTE };
export type { InProgressLock, StandingVerdict };
