import * as github from '@actions/github';
type Octokit = ReturnType<typeof github.getOctokit>;
declare const BOT_MARKER = "<!-- claude-review -->";
interface ReviewThread {
    id: string;
    isResolved: boolean;
    isBlocking: boolean;
    findingTitle: string;
}
/**
 * Fetch all review threads from the bot on a PR using GraphQL.
 * Returns threads with their resolution state and severity.
 */
declare function fetchBotReviewThreads(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<ReviewThread[]>;
/**
 * Check if all blocking threads are resolved.
 */
declare function areAllBlockingResolved(threads: ReviewThread[]): boolean;
/**
 * Post an approval review if all blocking issues are resolved.
 */
declare function checkAndAutoApprove(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<boolean>;
export { ReviewThread, areAllBlockingResolved, checkAndAutoApprove, fetchBotReviewThreads, BOT_MARKER };
