import * as github from '@actions/github';
import { Finding, ReviewResult, ReviewVerdict } from './types';
type Octokit = ReturnType<typeof github.getOctokit>;
declare const BOT_MARKER = "<!-- claude-review-bot -->";
/**
 * Fetch the raw diff for a PR.
 */
export declare function fetchPRDiff(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<string>;
/**
 * Fetch the config file content from the repo.
 */
export declare function fetchConfigFile(octokit: Octokit, owner: string, repo: string, ref: string, configPath: string): Promise<string | null>;
/**
 * Fetch repo context (CLAUDE.md, README, etc.) for richer reviews.
 */
export declare function fetchRepoContext(octokit: Octokit, owner: string, repo: string, ref: string): Promise<string>;
/**
 * Post a "review in progress" comment on the PR.
 * Returns the comment ID so we can update/delete it later.
 */
export declare function postProgressComment(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<number>;
/**
 * Update the progress comment with the final summary.
 */
export declare function updateProgressComment(octokit: Octokit, owner: string, repo: string, commentId: number, result: ReviewResult): Promise<void>;
/**
 * Dismiss any previous reviews from the bot on this PR.
 */
export declare function dismissPreviousReviews(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<void>;
/**
 * Post the review with inline comments.
 */
export declare function postReview(octokit: Octokit, owner: string, repo: string, prNumber: number, commitSha: string, result: ReviewResult): Promise<number>;
declare function mapVerdictToEvent(verdict: ReviewVerdict): 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
declare function formatFindingComment(finding: Finding): string;
export { formatFindingComment, mapVerdictToEvent, BOT_MARKER };
