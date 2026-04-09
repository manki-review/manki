import { ClaudeClient } from './claude';
import { RepoMemory } from './memory';
import { LinkedIssue } from './github';
import { PreviousFinding } from './recap';
import { ReviewConfig, ReviewerAgent, Finding, ReviewResult, ReviewVerdict, ParsedDiff, TeamRoster, PrContext, PlannerResult, AgentPick } from './types';
export declare const HIGH_CONF_SUGGESTION_THRESHOLD = 1;
export declare const PLANNER_TIMEOUT_MS = 30000;
export declare const AGENT_POOL: readonly ReviewerAgent[];
export declare const TRIVIAL_VERIFIER_AGENT: ReviewerAgent;
export declare function buildAgentPool(customReviewers?: ReviewerAgent[]): ReviewerAgent[];
export declare function selectTeam(diff: ParsedDiff, config: ReviewConfig, customReviewers?: ReviewerAgent[], teamSizeOverride?: 1 | 2 | 3 | 4 | 5 | 6 | 7, agentPicks?: AgentPick[]): TeamRoster;
export declare function shuffleDiffFiles(diff: ParsedDiff): ParsedDiff;
export declare function rebuildRawDiff(diff: ParsedDiff): string;
export declare function findingsMatch(a: Finding, b: Finding): boolean;
export declare function intersectFindings(passes: Finding[][], threshold: number): Finding[];
export interface ReviewClients {
    reviewer: ClaudeClient;
    judge: ClaudeClient;
    planner?: ClaudeClient;
    dedup?: ClaudeClient;
}
export interface ReviewProgress {
    phase: 'planning' | 'agent-complete' | 'reviewed' | 'judging';
    agentName?: string;
    agentFindingCount?: number;
    agentDurationMs?: number;
    agentStatus?: 'success' | 'failure' | 'retrying';
    rawFindingCount: number;
    judgeInputCount?: number;
    completedAgents?: number;
    totalAgents?: number;
    plannerResult?: PlannerResult;
    plannerDurationMs?: number;
    retryCount?: number;
}
export declare function buildPlannerSystemPrompt(agents: Array<{
    name: string;
    focus: string;
}>): string;
/**
 * Sanitize a free-text field from the planner LLM to prevent prompt injection.
 * Strips markdown fences, instruction-like patterns, and limits to safe characters.
 */
export declare function sanitizePlannerField(raw: string, maxLength: number): string;
export declare function parseAgentPicks(raw: unknown, availableNames: Set<string>): AgentPick[] | null;
export declare function runPlanner(client: ClaudeClient, diff: ParsedDiff, prContext?: PrContext, customReviewers?: ReviewerAgent[]): Promise<PlannerResult | null>;
export declare function runReview(clients: ReviewClients, config: ReviewConfig, diff: ParsedDiff, rawDiff: string, repoContext: string, memory?: RepoMemory | null, fileContents?: Map<string, string>, prContext?: PrContext, linkedIssues?: LinkedIssue[], onProgress?: (progress: ReviewProgress) => void, isFollowUp?: boolean, openThreads?: Array<{
    threadId: string;
    title: string;
    file: string;
    line: number;
    severity: string;
}>, previousFindings?: PreviousFinding[]): Promise<ReviewResult>;
export declare function buildReviewerSystemPrompt(reviewer: ReviewerAgent, config: ReviewConfig, language?: string, context?: string): string;
export declare function buildReviewerUserMessage(rawDiff: string, repoContext: string, fileContents?: Map<string, string>, prContext?: PrContext, memoryContext?: string, linkedIssues?: LinkedIssue[]): string;
export declare function parseFindings(responseText: string, reviewerName: string): Finding[];
export declare function validateSeverity(severity: unknown): Finding['severity'];
export declare function determineVerdict(findings: Finding[]): ReviewVerdict;
export declare function truncateDiff(rawDiff: string, maxLength?: number): string;
export declare function titlesMatch(a: string, b: string): boolean;
