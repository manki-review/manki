import { LLMClient } from './providers';
import { RepoMemory } from './memory';
import { LinkedIssue } from './github';
import { DiffFile, Finding, FindingReachability, FindingSeverity, InPrSuppression, NoiseLevel, OpenThread, ProvenanceEntry, ReviewConfig, RoundContext, ParsedDiff, PrContext, ThreadEvaluation } from './types';
/**
 * Find regions of `rawDiff` that implement `suggestedFix` text from prior
 * rounds. Used to detect own-proposal follow-ups that should be demoted to
 * nits rather than re-flagged as new required/suggestion findings.
 */
export declare function computeProvenanceMap(priorRounds: RoundContext[] | undefined, rawDiff: string): ProvenanceEntry[];
/**
 * Whether the inter-round diff is known to be empty, meaning prior rounds exist
 * but the tree is unchanged (force-pushed rebase, branch reset, identical
 * resync). `undefined` is the unknown sentinel (e.g., compare-API failure) and
 * does not count as empty. Callers must additionally gate on `hasPriorRounds`.
 */
export declare function isEmptyInterRoundDiff(interRoundDiff: string | undefined): boolean;
export interface JudgeInput {
    findings: Finding[];
    diff: ParsedDiff;
    rawDiff: string;
    memory?: RepoMemory;
    repoContext: string;
    prContext?: PrContext;
    linkedIssues?: LinkedIssue[];
    agentCount: number;
    isFollowUp?: boolean;
    openThreads?: OpenThread[];
    priorRounds?: RoundContext[];
    inPrSuppressions?: InPrSuppression[];
    effort?: 'low' | 'medium' | 'high';
    provenanceMap?: ProvenanceEntry[];
    /**
     * Unified diff between the prior round's `commitSha` and the current head.
     * Empty string means no code changes since the prior review (e.g.,
     * force-pushed rebase with identical tree). Undefined when there is no
     * prior round to compare against (first round of a PR).
     */
    interRoundDiff?: string;
    /** IDs of prior-round threads currently resolved on GitHub. */
    resolvedThreadIds?: Set<string>;
    /** When true, resolved prior-round threads suppress matching findings. */
    suppressResolvedThreads?: boolean;
}
export interface JudgedFinding {
    title: string;
    severity: FindingSeverity;
    reasoning: string;
    confidence: 'high' | 'medium' | 'low';
    reachability?: FindingReachability;
    reachabilityReasoning?: string;
}
export interface JudgeResult {
    summary: string;
    findings: JudgedFinding[];
    threadEvaluations?: ThreadEvaluation[];
}
export declare function buildJudgeSystemPrompt(config: ReviewConfig, agentCount: number, isFollowUp?: boolean, hasOpenThreads?: boolean, noiseLevel?: NoiseLevel): string;
export declare function buildJudgeUserMessage(findings: Finding[], codeContextMap: Map<string, string>, memoryContext: string, prContext?: PrContext, linkedIssues?: LinkedIssue[], changedFiles?: DiffFile[], openThreads?: OpenThread[], priorRounds?: RoundContext[], interRoundDiff?: string): string;
export declare function extractCodeContext(finding: Finding, diff: ParsedDiff): string;
export declare function filterMemoryForFindings(findings: Finding[], memory: RepoMemory): string;
export declare function parseJudgeResponse(responseText: string): JudgeResult;
export declare function runJudgeAgent(client: LLMClient, config: ReviewConfig, input: JudgeInput): Promise<{
    findings: Finding[];
    summary: string;
    threadEvaluations?: ThreadEvaluation[];
    crossRoundSuppressed?: number;
    crossRoundDemoted?: number;
    inPrSuppressedCount?: number;
}>;
/**
 * Flip findings whose fingerprint matches an in-PR suppression to `ignore` and
 * tag them with `IN_PR_SUPPRESSED_TAG`. Returns the new findings array and the
 * number of findings that were suppressed on this pass (idempotent: a finding
 * already tagged with `IN_PR_SUPPRESSED_TAG` is not double-counted).
 *
 * `required` findings are protected from suppression (mirrors the cross-round
 * ratchet guard): a prior resolved or author-agreed thread must not silently
 * drop a current `required` finding, since severity inflation could come from
 * prompt injection or from a genuine regression after a thread was resolved.
 */
export declare function applyInPrSuppression(findings: Finding[], suppressions: InPrSuppression[] | undefined): {
    findings: Finding[];
    count: number;
};
export declare function mapJudgedToFindings(original: Finding[], judged: JudgedFinding[], provenanceMap?: ProvenanceEntry[]): Finding[];
/**
 * Options for `applyCrossRoundSuppression` that broaden the suppression set
 * beyond `authorReply === 'agree'` priors.
 */
export interface CrossRoundSuppressionOptions {
    /**
     * IDs of prior-round threads currently resolved on GitHub. Any prior finding
     * whose `threadId` is in this set is treated as accepted regardless of how
     * the thread was resolved (agree reply, manual resolve, etc.). Requires
     * `suppressResolvedThreads` to be true.
     */
    resolvedThreadIds?: Set<string>;
    /** When true, treat resolved prior-round threads as accepted priors. */
    suppressResolvedThreads?: boolean;
    /**
     * Latest judge `threadEvaluations` keyed by prior `threadId`. When a prior
     * `suggestion`/`nitpick` thread has `status: 'addressed'` here, it joins the
     * accepted-priors set for ratchet (but never for contradiction). `blocker`
     * and `warning` priors are intentionally excluded: an `addressed` signal
     * alone is LLM-derived and must not silently retire higher-severity priors
     * without GitHub thread resolution or explicit author agreement.
     */
    threadEvaluations?: ThreadEvaluation[];
}
/**
 * Apply cross-round suppression rules using prior-round handover state.
 *
 * Ratchet: if a prior finding with the same slug + file exists and the author
 * agreed (or, when `suppressResolvedThreads` is true, the prior thread is
 * resolved on GitHub), suppress the current finding unless it is `blocker`.
 *
 * Contradiction: if a prior finding with the same slug + file + line proximity
 * exists, the author agreed, and the current finding uses a reversal word,
 * demote `suggestion`/`warning` to `nitpick` and annotate `judgeNotes`. `blocker`
 * findings are intentionally excluded from contradiction demotion to prevent
 * prompt injection attacks where adversarial PR content could silently hide real bugs.
 *
 * Resolved-thread priors also match by fuzzy line proximity (±`LINE_WINDOW`)
 * when slug differs, since reflowed code can shift line numbers and authors
 * may have resolved the thread without a fingerprint-stable reply.
 */
export declare function applyCrossRoundSuppression(findings: Finding[], priorRounds: RoundContext[] | undefined, options?: CrossRoundSuppressionOptions): {
    findings: Finding[];
    suppressedCount: number;
    demotedCount: number;
};
export declare function deduplicateFindings(findings: Finding[]): Finding[];
