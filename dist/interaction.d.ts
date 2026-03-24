import * as github from '@actions/github';
import { ClaudeClient } from './claude';
import { ReviewConfig } from './types';
type Octokit = ReturnType<typeof github.getOctokit>;
interface MemoryConfig {
    enabled: boolean;
    repo: string;
}
declare const BOT_MARKER = "<!-- manki -->";
/**
 * Handle a reply to one of our review comments.
 */
export declare function handleReviewCommentReply(octokit: Octokit, client: ClaudeClient, memoryConfig?: MemoryConfig, memoryToken?: string): Promise<void>;
/**
 * Handle @manki commands in PR comments.
 */
export declare function handlePRComment(octokit: Octokit, client: ClaudeClient | null, owner: string, repo: string, issueNumber: number, memoryConfig?: MemoryConfig, memoryToken?: string, config?: ReviewConfig): Promise<void>;
interface ParsedCommand {
    type: 'explain' | 'dismiss' | 'help' | 'remember' | 'forget' | 'check' | 'triage' | 'generic';
    args: string;
}
declare function parseCommand(body: string): ParsedCommand;
declare function buildReplyContext(originalComment: string, replyBody: string, filePath?: string | null, line?: number | null): string;
declare function isBotComment(body: string): boolean;
declare function hasBotMention(body: string): boolean;
export { parseCommand, buildReplyContext, ParsedCommand, BOT_MARKER, isBotComment, hasBotMention };
