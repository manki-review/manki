import * as github from '@actions/github';
import { ClaudeClient } from './claude';
import { ReviewConfig } from './types';
type Octokit = ReturnType<typeof github.getOctokit>;
export declare function isRepoUser(authorAssociation: string | null | undefined): boolean;
/**
 * Returns true if the sender is allowed to trigger LLM calls.
 * Logs a diagnostic when the PR author cannot be determined from the payload.
 */
export declare function isLLMAccessAllowed(authorAssociation: string | null | undefined, senderLogin: string | undefined, prAuthorLogin: string | undefined): boolean;
interface MemoryConfig {
    enabled: boolean;
    repo: string;
}
declare const BOT_MARKER = "<!-- manki -->";
/**
 * Handle a reply to one of our review comments.
 */
export declare function handleReviewCommentReply(octokit: Octokit, client: ClaudeClient, owner: string, repo: string, prNumber: number, memoryConfig?: MemoryConfig, memoryToken?: string): Promise<void>;
/**
 * Handle @manki commands in PR comments.
 */
export declare function handlePRComment(octokit: Octokit, client: ClaudeClient | null, owner: string, repo: string, issueNumber: number, memoryConfig?: MemoryConfig, memoryToken?: string, config?: ReviewConfig): Promise<void>;
interface ParsedCommand {
    type: 'explain' | 'dismiss' | 'help' | 'remember' | 'forget' | 'check' | 'triage' | 'generic';
    args: string;
}
declare const BOT_MENTION_PATTERN: RegExp;
declare function parseCommand(body: string): ParsedCommand;
declare function buildReplyContext(originalComment: string, replyBody: string, filePath?: string | null, line?: number | null): string;
export declare function scopeDiffToFile(fullDiff: string, filePath: string): string;
declare function isBotComment(body: string): boolean;
declare function hasBotMention(body: string): boolean;
interface TriageFinding {
    title: string;
    ref: string;
    section: string;
}
interface TriageResult {
    accepted: TriageFinding[];
    rejected: TriageFinding[];
}
interface FindingContent {
    description: string;
    permalink: string | null;
    suggestedFix: string | null;
}
declare function parseTriageBody(body: string): TriageResult;
declare function extractFindingContent(section: string): FindingContent;
declare function triageTitlePrefix(title: string): string;
declare function extractPrNumber(issueTitle: string): number | null;
declare function isReviewRequest(body: string): boolean;
declare function isBotMentionNonReview(body: string): boolean;
/**
 * Handle a bot command posted as a reply to an inline review comment.
 * Routes to the same handlers as handlePRComment but uses review-comment
 * reactions and skips commands that only make sense at PR level.
 */
export declare function handleReviewCommentCommand(octokit: Octokit, owner: string, repo: string, prNumber: number, commentId: number, command: ParsedCommand, memoryConfig?: MemoryConfig, memoryToken?: string): Promise<void>;
export { parseCommand, buildReplyContext, parseTriageBody, extractFindingContent, triageTitlePrefix, extractPrNumber, ParsedCommand, TriageFinding, TriageResult, FindingContent, BOT_MARKER, BOT_MENTION_PATTERN, isBotComment, hasBotMention, isReviewRequest, isBotMentionNonReview };
