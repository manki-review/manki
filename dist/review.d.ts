import { ClaudeClient } from './claude';
import { RepoMemory } from './memory';
import { LinkedIssue } from './github';
import { PreviousFinding } from './recap';
import { ReviewConfig, ReviewerAgent, Finding, HandoverFinding, HandoverRound, OpenThread, ReviewResult, ReviewVerdict, VerdictReason, ParsedDiff, TeamRoster, PrContext, PlannerResult, PlannerRoundHint, AgentPick, ProvenanceEntry } from './types';
export declare const PLANNER_TIMEOUT_MS = 30000;
export declare const AGENT_POOL: readonly ReviewerAgent[];
export declare const TRIVIAL_VERIFIER_AGENT: ReviewerAgent;
export declare function buildAgentPool(customReviewers?: ReviewerAgent[]): ReviewerAgent[];
export declare function selectTeam(diff: ParsedDiff, config: ReviewConfig, customReviewers?: ReviewerAgent[], teamSizeOverride?: 1 | 2 | 3 | 4 | 5 | 6 | 7, agentPicks?: AgentPick[], priorRoundAgents?: string[], silent?: boolean): TeamRoster;
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
/**
 * Summarize recent rounds from the per-PR handover as per-specialist outcome
 * counts for the planner. Groups each round's findings by `specialist`,
 * skipping entries that predate the `specialist` field. Returns an empty
 * array when no round carries specialist attribution.
 */
export declare function buildPlannerHints(rounds: HandoverRound[] | undefined): PlannerRoundHint[];
export declare function buildPlannerSystemPrompt(agents: Array<{
    name: string;
    focus: string;
}>, hints?: PlannerRoundHint[]): string;
/**
 * Sanitize a free-text field from the planner LLM to prevent prompt injection.
 * Strips markdown fences, instruction-like patterns, and limits to safe characters.
 */
export declare function sanitizePlannerField(raw: string, maxLength: number): string;
export declare function parseAgentPicks(raw: unknown, availableNames: Set<string>): AgentPick[] | null;
export declare function runPlanner(client: ClaudeClient, diff: ParsedDiff, prContext?: PrContext, customReviewers?: ReviewerAgent[], priorRoundHints?: PlannerRoundHint[]): Promise<PlannerResult | null>;
export declare function collectPriorRoundAgents(priorRounds?: HandoverRound[]): string[];
export declare function runReview(clients: ReviewClients, config: ReviewConfig, diff: ParsedDiff, rawDiff: string, repoContext: string, memory?: RepoMemory | null, fileContents?: Map<string, string>, prContext?: PrContext, linkedIssues?: LinkedIssue[], onProgress?: (progress: ReviewProgress) => void, isFollowUp?: boolean, openThreads?: OpenThread[], previousFindings?: PreviousFinding[], priorRounds?: HandoverRound[], prAuthorLogin?: string, interRoundDiff?: string): Promise<ReviewResult>;
export declare function buildReviewerSystemPrompt(reviewer: ReviewerAgent, config: ReviewConfig, language?: string, context?: string): string;
export declare function buildReviewerUserMessage(rawDiff: string, repoContext: string, fileContents?: Map<string, string>, prContext?: PrContext, memoryContext?: string, linkedIssues?: LinkedIssue[], provenanceMap?: ProvenanceEntry[]): string;
export declare function parseFindings(responseText: string, reviewerName: string): Finding[];
export declare function validateSeverity(severity: unknown): Finding['severity'];
/**
 * Pick a verdict plus a machine-readable reason.
 *
 * Decision order:
 *   1. any surviving `blocker` finding → REQUEST_CHANGES / required_present
 *   2. any `warning` that is NOT a prior-round dismissed match → REQUEST_CHANGES / novel_suggestion
 *   3. any prior-round `warning`/`blocker` still unresolved → REQUEST_CHANGES / prior_unaddressed
 *   4. otherwise (only suggestions/nitpicks / previously-dismissed warnings / empty) → APPROVE / only_nit_or_suggestion
 *
 * A prior `warning`/`blocker` is "unresolved" when the author has not agreed to
 * dismiss it (`authorReply !== 'agree'`) and the underlying GitHub thread is
 * still in `openThreads`. A prior finding without a `threadId` is treated as
 * unresolved, which conservatively blocks APPROVE for older handover formats.
 *
 * The judge's `threadEvaluations.status === 'addressed'` is intentionally not
 * consulted here. That signal is LLM-derived and could be flipped by prompt
 * injection in prior-round source or comments, allowing an attacker to
 * unblock APPROVE on an unaddressed warning. Resolution must come from the
 * GitHub thread state (`openThreads`) or from an explicit author agreement
 * captured in `authorReply`.
 *
 * Multi-round priors are collapsed to one entry per fingerprint, keeping the
 * most recent round's `authorReply` and `threadId`. Callers must pass
 * `priorRounds` in chronological order. Without this dedup, a stale round 1
 * `authorReply: 'none'` would still match `.some(...)` even if round 2
 * captured an `agree` for the same thread.
 *
 * Contract for `openThreads`: callers must pass the result of a successful
 * GitHub thread fetch. Both `undefined` and `[]` are interpreted the same way
 * (no thread is open on GitHub), so any prior finding with a `threadId` that
 * does not appear in the set is treated as resolved. Callers that fail to
 * fetch thread state must abort before reaching this function rather than
 * pass a partial or empty list, otherwise unaddressed warnings could be
 * silently approved.
 *
 * Nitpicks and suggestions are non-blocking, and prior-round dismissed warnings
 * have already been acknowledged by the author. All these cases approve the PR.
 */
export declare function determineVerdict(findings: Finding[], priorRounds?: HandoverFinding[], openThreads?: OpenThread[]): {
    verdict: ReviewVerdict;
    verdictReason: VerdictReason;
};
export declare function truncateDiff(rawDiff: string, maxLength?: number): string;
export declare function titlesMatch(a: string, b: string): boolean;
