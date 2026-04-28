import * as github from '@actions/github';
import { DashboardData, Finding, FindingSeverity, ParsedDiff, ReviewMetadata, ReviewResult, ReviewStats, ReviewVerdict } from './types';
type Octokit = ReturnType<typeof github.getOctokit>;
declare const BOT_LOGIN = "manki-review[bot]";
declare const ACTIONS_BOT_LOGIN = "github-actions[bot]";
declare const BOT_MARKER = "<!-- manki-bot -->";
declare const REVIEW_COMPLETE_MARKER = "<!-- manki-review-complete -->";
declare const FORCE_REVIEW_MARKER = "<!-- manki-force-review -->";
declare const RUN_ID_MARKER_PREFIX = "<!-- manki-run-id:";
declare const CANCELLED_MARKER = "<!-- manki-review-cancelled -->";
declare const VERSION_MARKER_PREFIX = "<!-- manki-version:";
declare const MANKI_VERSION: string;
declare function extractVersionFromBody(body: string | null | undefined): string | null;
declare function extractRunIdFromBody(body: string | null | undefined): number | null;
/**
 * Fetch the raw diff for a PR.
 */
export declare function fetchPRDiff(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<string>;
/**
 * Fetch the unified diff between two commits via GitHub's compare API.
 * Used to ground the judge's per-thread evaluation in actual code changes
 * since the prior review round, distinguishing real fixes from no-op pushes
 * (force-pushed rebases, branch resets) where every open thread should remain
 * unresolved. Returns an empty string when `base === head` or when the
 * comparison yields a non-string payload. Throws on API failure so the caller
 * can distinguish "no changes" (empty string) from "unknown" (caught error,
 * leaves the diff undefined upstream).
 */
export declare function fetchInterRoundDiff(octokit: Octokit, owner: string, repo: string, base: string, head: string): Promise<string>;
/**
 * Fetch the config file content from the repo.
 */
export declare function fetchConfigFile(octokit: Octokit, owner: string, repo: string, ref: string, configPath: string): Promise<string | null>;
/**
 * Resolve `@path/to/file.md` references in CLAUDE.md content by fetching
 * the referenced files from the repo and inlining their content.
 */
declare function resolveReferences(octokit: Octokit, owner: string, repo: string, ref: string, content: string, basePath: string, depth?: number): Promise<string>;
/**
 * Fetch repo context (CLAUDE.md, README, etc.) for richer reviews.
 */
export declare function fetchRepoContext(octokit: Octokit, owner: string, repo: string, ref: string): Promise<string>;
/**
 * Build text status lines showing review progress across phases.
 */
export declare const INDENT = "&nbsp;&nbsp;&nbsp;&nbsp;";
export declare function buildDashboard(data: DashboardData): string;
/**
 * Post a "review in progress" comment on the PR.
 * Returns the comment ID so we can update/delete it later.
 */
export declare function postProgressComment(octokit: Octokit, owner: string, repo: string, prNumber: number, dashboard?: DashboardData): Promise<number>;
/**
 * Freeze the progress comment as an audit log with the final dashboard
 * and optional review metadata (config, judge decisions, recap, timing).
 */
export declare function updateProgressComment(octokit: Octokit, owner: string, repo: string, commentId: number, dashboard: DashboardData, metadata?: ReviewMetadata): Promise<void>;
/**
 * Update the progress comment with just a dashboard (no final result yet).
 */
export declare function updateProgressDashboard(octokit: Octokit, owner: string, repo: string, commentId: number, dashboard: DashboardData): Promise<void>;
/**
 * Dismiss any previous reviews from the bot on this PR.
 */
export declare function dismissPreviousReviews(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<void>;
declare function formatStatsOneLiner(stats: ReviewStats): string;
declare function formatStatsJson(stats: ReviewStats): string;
/**
 * Post the review with inline comments.
 */
export declare function postReview(octokit: Octokit, owner: string, repo: string, prNumber: number, commitSha: string, result: ReviewResult, diff?: ParsedDiff, stats?: ReviewStats): Promise<number>;
declare function dynamicFence(content: string): string;
declare function truncateBody(text: string, maxLength?: number): string;
declare function safeTruncate(text: string, maxLen: number): string;
declare function sanitizeFilePath(file: string): string;
declare function mapVerdictToEvent(verdict: ReviewVerdict): 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
declare function getSeverityLabel(severity: FindingSeverity): string;
declare function getSeverityEmoji(severity: FindingSeverity): string;
declare function sanitizeMarkdown(text: string): string;
/** Reduce a finding title to a URL-safe slug for use in HTML comment markers and fingerprints. */
export declare function titleToSlug(title: string): string;
declare function formatFindingComment(finding: Finding): string;
/**
 * Build the markdown body for a nit issue from non-required findings.
 * Pure function — no API calls — for testability.
 */
export declare function buildNitIssueBody(prNumber: number, findings: Finding[], owner: string, repo: string, commitSha: string): string;
/**
 * Create a GitHub issue from non-required review findings.
 * Returns the issue number, or null if no nits or issue already exists.
 */
export declare function createNitIssue(octokit: Octokit, owner: string, repo: string, prNumber: number, findings: Finding[], commitSha: string): Promise<number | null>;
/**
 * React to an issue comment with an emoji. Failures are silently ignored
 * since reactions are non-critical UX signals.
 */
export declare function reactToIssueComment(octokit: Octokit, owner: string, repo: string, commentId: number, content: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes'): Promise<void>;
/**
 * React to a pull request review comment with an emoji. Failures are silently
 * ignored since reactions are non-critical UX signals.
 */
export declare function reactToReviewComment(octokit: Octokit, owner: string, repo: string, commentId: number, content: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes'): Promise<void>;
/**
 * Fetch file contents for changed files via the GitHub API.
 * Skips binary files and files exceeding the size limit.
 * If total content exceeds the budget, includes only the largest files that fit.
 */
export declare function fetchFileContents(octokit: Octokit, owner: string, repo: string, ref: string, files: string[], maxFileSize?: number, maxTotalSize?: number): Promise<Map<string, string>>;
export interface LinkedIssue {
    number: number;
    title: string;
    body: string;
}
/**
 * Parse PR body for issue references and fetch their details.
 */
export declare function fetchLinkedIssues(octokit: Octokit, owner: string, repo: string, prBody: string): Promise<LinkedIssue[]>;
/**
 * Discover and fetch CLAUDE.md files in subdirectories relevant to changed file paths.
 * Walks up the directory tree from each changed file to find the nearest CLAUDE.md,
 * excluding root-level files already fetched by `fetchRepoContext`.
 */
export declare function fetchSubdirClaudeMd(octokit: Octokit, owner: string, repo: string, ref: string, changedPaths: string[]): Promise<string>;
/**
 * Check whether a review is currently in progress for a PR by verifying the
 * embedded Actions run_id via the GitHub Actions API. Zombie comments from
 * cancelled/failed runs are marked as cancelled in-place (not deleted) so the
 * audit trail is preserved.
 */
declare function isReviewInProgress(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<boolean>;
/**
 * Post-step cleanup: find our run's progress comment and mark it as cancelled.
 * Invoked when GitHub Actions cancels the main step.
 */
declare function markOwnProgressCommentCancelled(octokit: Octokit, owner: string, repo: string, prNumber: number, runId: number): Promise<boolean>;
/**
 * Check whether the bot already has an active (non-dismissed) APPROVED review
 * on the given commit SHA.
 */
declare function isApprovedOnCommit(octokit: Octokit, owner: string, repo: string, prNumber: number, commitSha: string): Promise<boolean>;
declare const APP_WARNING_MARKER = "<!-- manki-app-warning -->";
declare function postAppWarningIfNeeded(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<void>;
/**
 * Cancel the in-progress review run for a PR, if one exists.
 * Returns true if a run was successfully cancelled, false otherwise.
 *
 * Requires actions: write permission on the workflow token.
 */
declare function cancelActiveReviewRun(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<boolean>;
export { dynamicFence, formatFindingComment, formatStatsJson, formatStatsOneLiner, getSeverityEmoji, getSeverityLabel, mapVerdictToEvent, resolveReferences, safeTruncate, sanitizeFilePath, sanitizeMarkdown, truncateBody, BOT_LOGIN, ACTIONS_BOT_LOGIN, BOT_MARKER, REVIEW_COMPLETE_MARKER, FORCE_REVIEW_MARKER, CANCELLED_MARKER, RUN_ID_MARKER_PREFIX, VERSION_MARKER_PREFIX, MANKI_VERSION, isReviewInProgress, isApprovedOnCommit, markOwnProgressCommentCancelled, cancelActiveReviewRun, extractRunIdFromBody, extractVersionFromBody, APP_WARNING_MARKER, postAppWarningIfNeeded };
