import { ClaudeClient } from './claude';
import { RepoMemory } from './memory';
import { LinkedIssue } from './github';
import { ReviewConfig, ReviewerAgent, Finding, ReviewResult, ReviewVerdict, ParsedDiff, TeamRoster, PrContext } from './types';
export declare const AGENT_POOL: readonly ReviewerAgent[];
export declare function selectTeam(diff: ParsedDiff, config: ReviewConfig, customReviewers?: ReviewerAgent[]): TeamRoster;
export declare function shuffleDiffFiles(diff: ParsedDiff): ParsedDiff;
export declare function rebuildRawDiff(diff: ParsedDiff): string;
export declare function findingsMatch(a: Finding, b: Finding): boolean;
export declare function intersectFindings(passes: Finding[][], threshold: number): Finding[];
export interface ReviewClients {
    reviewer: ClaudeClient;
    judge: ClaudeClient;
}
export declare function runReview(clients: ReviewClients, config: ReviewConfig, diff: ParsedDiff, rawDiff: string, repoContext: string, memory?: RepoMemory | null, fileContents?: Map<string, string>, prContext?: PrContext, linkedIssues?: LinkedIssue[]): Promise<ReviewResult>;
export declare function buildReviewerSystemPrompt(reviewer: ReviewerAgent, config: ReviewConfig): string;
export declare function buildReviewerUserMessage(rawDiff: string, repoContext: string, fileContents?: Map<string, string>, prContext?: PrContext, memoryContext?: string, linkedIssues?: LinkedIssue[]): string;
export declare function parseFindings(responseText: string, reviewerName: string): Finding[];
export declare function validateSeverity(severity: unknown): Finding['severity'];
export declare function determineVerdict(findings: Finding[]): ReviewVerdict;
export declare function truncateDiff(rawDiff: string, maxLength?: number): string;
export declare function titlesMatch(a: string, b: string): boolean;
