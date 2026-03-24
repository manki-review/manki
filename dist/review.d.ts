import { ClaudeClient } from './claude';
import { ReviewConfig, ReviewerAgent, Finding, ReviewResult, ReviewVerdict, ParsedDiff } from './types';
export declare function runReview(client: ClaudeClient, config: ReviewConfig, _diff: ParsedDiff, rawDiff: string, repoContext: string): Promise<ReviewResult>;
export declare function buildReviewerSystemPrompt(reviewer: ReviewerAgent, config: ReviewConfig): string;
export declare function buildReviewerUserMessage(rawDiff: string, repoContext: string): string;
export declare function parseFindings(responseText: string, reviewerName: string): Finding[];
export declare function validateSeverity(severity: unknown): Finding['severity'];
export declare function parseConsolidatedReview(responseText: string): ReviewResult;
export declare function determineVerdict(claimed: unknown, findings: Finding[]): ReviewVerdict;
/**
 * Merge individual reviewer findings when the consolidation agent fails.
 * De-duplicates by title similarity + file + line proximity.
 */
export declare function mergeIndividualFindings(agentFindings: {
    reviewer: string;
    findings: Finding[];
}[]): ReviewResult;
