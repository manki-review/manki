import * as github from '@actions/github';
import { ReviewConfig } from './types';
type Octokit = ReturnType<typeof github.getOctokit>;
declare const BOT_MARKER = "<!-- manki -->";
interface ReviewThread {
    id: string;
    isResolved: boolean;
    isRequired: boolean;
    findingTitle: string;
}
/**
 * Fetch all review threads from the bot on a PR using GraphQL.
 * Returns threads with their resolution state and severity.
 */
declare function fetchBotReviewThreads(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<ReviewThread[]>;
/**
 * Check if all bot review threads (blocker, warning, suggestion, nitpick) are resolved.
 * Auto-approve should only fire when every finding is resolved, because
 * CHANGES_REQUESTED can be caused by high-confidence warnings too.
 */
declare function areAllFindingsResolved(threads: ReviewThread[]): boolean;
/**
 * Post an approval review if all findings are resolved.
 *
 * Two concurrency guards run before any review is posted. First the TTL-based
 * `checkConcurrentSubmissionLock` scans for a fresh in-progress marker from a
 * different run, which protects against the Actions-API failure mode in
 * `isReviewInProgress` (the bot identity often lacks `actions:read`, so its
 * catch path fails open and would otherwise let an APPROVED race land on top
 * of a parallel CHANGES_REQUESTED). The original `isReviewInProgress` check
 * runs afterward as belt-and-suspenders.
 */
declare function checkAndAutoApprove(octokit: Octokit, owner: string, repo: string, prNumber: number, config?: ReviewConfig): Promise<boolean>;
/**
 * Resolve stale bot review threads left over from previous commits (e.g. after force-push).
 * A thread is stale when the first comment's commit differs from the current head SHA.
 */
declare function resolveStaleThreads(octokit: Octokit, owner: string, repo: string, prNumber: number, currentHeadSha: string): Promise<number>;
export { ReviewThread, areAllFindingsResolved, checkAndAutoApprove, fetchBotReviewThreads, resolveStaleThreads, BOT_MARKER };
