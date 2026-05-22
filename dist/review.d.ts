import { LLMClient } from './providers';
import { RepoMemory } from './memory';
import { LinkedIssue } from './github';
import { PreviousFinding } from './recap';
import { ReviewConfig, ReviewerAgent, Finding, FindingFingerprintEntry, NoiseLevel, OpenThread, ReviewResult, ReviewVerdict, VerdictReason, ParsedDiff, TeamRoster, PrContext, PlannerResult, PlannerRoundHint, RoundContext, AgentPick, ProvenanceEntry, ThreadEvaluation } from './types';
export declare const PLANNER_TIMEOUT_MS = 60000;
export declare const AGENT_POOL: readonly ReviewerAgent[];
export declare const TRIVIAL_VERIFIER_AGENT: ReviewerAgent;
export declare function buildAgentPool(customReviewers?: ReviewerAgent[]): ReviewerAgent[];
export declare function selectTeam(diff: ParsedDiff, config: ReviewConfig, customReviewers?: ReviewerAgent[], teamSizeOverride?: 1 | 2 | 3 | 4 | 5 | 6 | 7, agentPicks?: AgentPick[], priorRoundAgents?: string[], silent?: boolean): TeamRoster;
export declare function shuffleDiffFiles(diff: ParsedDiff): ParsedDiff;
export declare function rebuildRawDiff(diff: ParsedDiff): string;
export declare function findingsMatch(a: Finding, b: Finding): boolean;
export declare function intersectFindings(passes: Finding[][], threshold: number): Finding[];
export interface ReviewClients {
    reviewer: LLMClient;
    judge: LLMClient;
    planner?: LLMClient;
    dedup?: LLMClient;
    /**
     * Optional resolver returning the reviewer client for a specific agent. When
     * present, it takes precedence over `reviewer`. Used to apply per-agent
     * model overrides from `models.agents`.
     */
    reviewerForAgent?: (agentName: string) => LLMClient;
}
export interface ReviewProgress {
    phase: 'planning' | 'agent-complete' | 'reviewed' | 'judging';
    agentName?: string;
    agentFindingCount?: number;
    agentDurationMs?: number;
    agentStatus?: 'success' | 'failure' | 'retrying';
    rawFindingCount?: number;
    judgeInputCount?: number;
    completedAgents?: number;
    totalAgents?: number;
    plannerResult?: PlannerResult;
    plannerDurationMs?: number;
    retryCount?: number;
    /** Names of agents resolved for this review. Emitted with a `planning` event on the heuristic-fallback path so the dashboard can seed per-agent entries even though no `plannerResult` is available. */
    teamAgentNames?: string[];
    /** True when team selection fell back to the heuristic because the planner failed or timed out. */
    heuristicFallback?: boolean;
}
/**
 * Summarize recent rounds from the per-PR handover as per-specialist outcome
 * counts for the planner. Groups each round's findings by `specialist`,
 * skipping entries that predate the `specialist` field. Returns an empty
 * array when no round carries specialist attribution.
 */
export declare function buildPlannerHints(rounds: RoundContext[] | undefined): PlannerRoundHint[];
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
export declare function runPlanner(client: LLMClient, diff: ParsedDiff, prContext?: PrContext, customReviewers?: ReviewerAgent[], priorRoundHints?: PlannerRoundHint[]): Promise<PlannerResult | null>;
export declare function collectPriorRoundAgents(priorRounds?: RoundContext[]): string[];
export declare function runReview(clients: ReviewClients, config: ReviewConfig, diff: ParsedDiff, rawDiff: string, repoContext: string, memory?: RepoMemory | null, fileContents?: Map<string, string>, prContext?: PrContext, linkedIssues?: LinkedIssue[], onProgress?: (progress: ReviewProgress) => void, isFollowUp?: boolean, openThreads?: OpenThread[], previousFindings?: PreviousFinding[], priorRounds?: RoundContext[], prAuthorLogin?: string, interRoundDiff?: string): Promise<ReviewResult>;
export declare function buildReviewerSystemPrompt(reviewer: ReviewerAgent, config: ReviewConfig, language?: string, context?: string, noiseLevel?: NoiseLevel): string;
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
 * The judge's `threadEvaluations.status === 'addressed'` resolves a prior
 * thread. `uncertain` and missing entries collapse to "not addressed" so the
 * default outcome stays conservative when the judge could not produce a
 * confident verdict. Defense-in-depth against prompt injection lives at three
 * other layers: (a) `buildJudgeUserMessage` routes untrusted PR/issue prose
 * through `sanitizeForPromptEmbed` and tags each section as evidence-not-
 * directive; (b) the adversarial `05_injection_attempt_unfixed` fixture in
 * the corpus gates regressions in the judge's resistance to injected text;
 * (c) `applyCrossRoundSuppression` only lets `addressed` ratchet prior
 * `suggestion`/`nitpick` findings, never `blocker`/`warning`, so a flipped
 * judge verdict on a higher-severity prior still requires GitHub thread
 * resolution or an explicit `authorReply: 'agree'` to retire.
 *
 * Multi-round priors are collapsed to one entry per fingerprint, keeping the
 * most recent round's `authorReply` and `threadId`. Callers must pass
 * `priorRounds` in chronological order. Without this dedup, a stale round 1
 * `authorReply: 'none'` would still match `.some(...)` even if round 2
 * captured an `agree` for the same thread.
 *
 * Contract for `openThreads`: three states with distinct meaning.
 *   - `null` / omitted → "unknown": caller did not (or could not) fetch open
 *     threads. Treated conservatively: any prior `warning`/`blocker` with a
 *     non-`agree` `authorReply` blocks APPROVE with `prior_unaddressed`,
 *     unconditionally. `resolvedThreadIds` is NOT honored in this branch,
 *     since both signals come from the same recap scan and could be stale
 *     together. Use the unknown state when the GitHub fetch failed, or at
 *     call sites that intentionally bypass the open-thread check, so
 *     unresolved priors can never be silently approved.
 *   - `[]` → "fetched, none open": GitHub confirmed no review threads are
 *     open on the PR. Prior findings with a `threadId` that does not appear
 *     here are treated as resolved.
 *   - `OpenThread[]` (non-empty) → "fetched, here they are": only priors
 *     whose `threadId` appears in the set are treated as still open.
 *
 * `resolvedThreadIds` is an explicit allowlist of thread ids that GitHub
 * reports as `isResolved: true` (derived from `previousFindings[i].status ===
 * 'resolved'`). It is consulted only when `openThreads` is a fetched array
 * (empty or non-empty) and the thread is not present in it. The precedence
 * is: live `openThreads` > unknown-fallback (conservative block) >
 * `resolvedThreadIds` (cached "resolved via fix") > implicit resolution
 * (absent from both, with a `threadId`). This covers the common "author
 * pushed a fix and clicked Resolve conversation" case, where the thread is
 * no longer open on GitHub but the prior's `authorReplyClass` stays `none`,
 * while still blocking when the live state cannot be trusted.
 *
 * Nitpicks and suggestions are non-blocking, and prior-round dismissed warnings
 * have already been acknowledged by the author. All these cases approve the PR.
 */
export declare function determineVerdict(findings: Finding[], priorRounds?: FindingFingerprintEntry[], openThreads?: OpenThread[] | null, resolvedThreadIds?: Set<string>, threadEvaluations?: ThreadEvaluation[]): {
    verdict: ReviewVerdict;
    verdictReason: VerdictReason;
};
export declare function truncateDiff(rawDiff: string, maxLength?: number): string;
export declare function titlesMatch(a: string, b: string): boolean;
