import * as github from '@actions/github';
import { ClaudeClient } from './claude';
type Octokit = ReturnType<typeof github.getOctokit>;
declare const BOT_MARKER = "<!-- claude-review -->";
/**
 * Handle a reply to one of our review comments.
 */
export declare function handleReviewCommentReply(octokit: Octokit, client: ClaudeClient): Promise<void>;
/**
 * Handle @claude commands in PR comments.
 */
export declare function handlePRComment(octokit: Octokit, client: ClaudeClient): Promise<void>;
interface ParsedCommand {
    type: 'explain' | 'dismiss' | 'help' | 'generic';
    args: string;
}
declare function parseCommand(body: string): ParsedCommand;
declare function buildReplyContext(originalComment: string, replyBody: string, filePath?: string | null, line?: number | null): string;
export { parseCommand, buildReplyContext, ParsedCommand, BOT_MARKER };
