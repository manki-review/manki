import * as github from '@actions/github';
import { AuthorReplyClass, Finding, HandoverFinding, PrHandover } from './types';
type Octokit = ReturnType<typeof github.getOctokit>;
export interface Suppression {
    id: string;
    pattern: string;
    file_glob?: string;
    reason: string;
    created_by: string;
    created_at: string;
    pr_ref: string;
    last_matched?: string;
}
export interface Learning {
    id: string;
    content: string;
    scope: 'repo' | 'global';
    source: string;
    created_at: string;
    last_used?: string;
}
export interface Pattern {
    id: string;
    finding_title: string;
    occurrences: number;
    accepted_count: number;
    rejected_count: number;
    repos: string[];
    first_seen: string;
    last_seen: string;
    escalated: boolean;
}
export interface RepoMemory {
    learnings: Learning[];
    suppressions: Suppression[];
    patterns: Pattern[];
}
/**
 * Load memory for a specific repo from the memory repository.
 * Returns combined repo-specific + global memory.
 */
export declare function loadMemory(octokit: Octokit, memoryRepo: string, targetRepo: string): Promise<RepoMemory>;
/**
 * Filter findings against stored suppressions.
 * Returns findings that are NOT suppressed.
 * Blocking-severity findings are never suppressed.
 */
export declare function applySuppressions(findings: Finding[], suppressions: Suppression[]): {
    kept: Finding[];
    suppressed: Finding[];
};
export declare function matchesSuppression(finding: Finding, suppression: Suppression): boolean;
/**
 * Sanitize a memory field by truncating to a reasonable length.
 * Prompt injection is mitigated by wrapping output in data boundaries
 * rather than trying to filter patterns (which is easily bypassed).
 */
export declare function sanitizeMemoryField(value: string): string;
/**
 * Sanitize a `suggestedFix` value before persisting it to handover storage.
 * Caps length and collapses excessive newline runs. Content is preserved
 * faithfully so provenance matching against the raw diff continues to work.
 * Prompt-injection concerns are handled at the embedding boundary instead.
 */
export declare function sanitizeSuggestedFix(value: string): string;
/**
 * Sanitize text before embedding it into a prompt context.
 * Replaces angle brackets with fullwidth equivalents to prevent XML-style tag
 * injection, and strips backticks to avoid breaking fenced code block delimiters.
 */
export declare function sanitizeForPromptEmbed(text: string): string;
/**
 * Build a context string from memory to inject into reviewer prompts.
 */
export declare function buildMemoryContext(memory: RepoMemory): string;
/**
 * Filter learnings to those relevant to a specific finding,
 * matching by keyword overlap between the finding and learning content.
 */
export declare function filterLearningsForFinding(learnings: Learning[], finding: Finding): Learning[];
/**
 * Filter suppressions to those that match a specific finding.
 */
export declare function filterSuppressionsForFinding(suppressions: Suppression[], finding: Finding): Suppression[];
/**
 * Write a suppression to the memory repo.
 */
export declare function writeSuppression(octokit: Octokit, memoryRepo: string, targetRepo: string, suppression: Suppression): Promise<void>;
/**
 * Write a learning to the memory repo.
 */
export declare function writeLearning(octokit: Octokit, memoryRepo: string, targetRepo: string, learning: Learning): Promise<void>;
/**
 * Remove a learning from the memory repo by case-insensitive substring match on content.
 */
export declare function removeLearning(octokit: Octokit, memoryRepo: string, targetRepo: string, searchText: string): Promise<{
    removed: Learning | null;
    remaining: number;
}>;
/**
 * Remove a suppression from the memory repo by case-insensitive substring match on pattern.
 */
export declare function removeSuppression(octokit: Octokit, memoryRepo: string, targetRepo: string, searchPattern: string): Promise<{
    removed: Suppression | null;
    remaining: number;
}>;
/**
 * Update a pattern tracker in the memory repo.
 */
export declare function updatePattern(octokit: Octokit, memoryRepo: string, targetRepo: string, findingTitle: string, repoName: string): Promise<Pattern | null>;
/**
 * Update a pattern's acceptance/rejection count based on triage decision.
 */
export declare function updatePatternDecision(octokit: Octokit, memoryRepo: string, targetRepo: string, findingTitle: string, accepted: boolean): Promise<void>;
/**
 * Escalate findings whose patterns have been consistently accepted by the team.
 */
export declare function applyEscalations(findings: Finding[], patterns: Pattern[]): Finding[];
/**
 * Batch-update pattern acceptance/rejection counts in a single read-write cycle.
 */
export declare function batchUpdatePatternDecisions(octokit: Octokit, memoryRepo: string, targetRepo: string, decisions: Array<{
    title: string;
    accepted: boolean;
}>): Promise<void>;
/**
 * Load the per-PR handover file, or null if it does not yet exist.
 *
 * Legacy severity values written by older versions (`'required'`, `'nit'`)
 * are migrated to the current vocabulary on read so downstream code only ever
 * sees `FindingSeverity` values it recognizes.
 */
export declare function loadHandover(octokit: Octokit, memoryRepo: string, targetRepo: string, prNumber: number): Promise<PrHandover | null>;
/**
 * Write the per-PR handover file, replacing any existing content.
 */
export declare function writeHandover(octokit: Octokit, memoryRepo: string, targetRepo: string, prNumber: number, handover: PrHandover): Promise<void>;
/** Minimal shape of a previous finding required by `appendHandoverRound`. */
export interface HandoverPreviousFinding {
    threadId?: string;
    authorReplyText?: string;
    file: string;
    /** End line (annotation `line`). Used as the key for thread lookups. */
    line: number;
    /** Start line of the annotation range. Stored for reference but not used for key matching. */
    lineStart?: number;
    /** Finding title used to disambiguate same-line threads in `threadByKey`. */
    title?: string;
}
/**
 * Append a new round to the per-PR handover.
 * Prior rounds' findings are backfilled with fresh `authorReply` classifications
 * drawn from the latest recap state, matched by thread ID.
 *
 * Pass the already-loaded `handover` to avoid a redundant fetch. If omitted,
 * the function loads it from the memory repo.
 */
export declare function appendHandoverRound(octokit: Octokit, memoryRepo: string, targetRepo: string, prNumber: number, commitSha: string, findings: Finding[], previousFindings: HandoverPreviousFinding[], judgeSummary: string, agents: string[], fingerprintFn: (title: string, file: string, line: number) => HandoverFinding['fingerprint'], classifyFn: (text: string | undefined) => AuthorReplyClass, existingHandover?: PrHandover | null): Promise<void>;
export {};
