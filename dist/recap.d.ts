import * as github from '@actions/github';
import { ClaudeClient } from './claude';
import { Suppression } from './memory';
import { Finding, FindingSeverity } from './types';
type Octokit = ReturnType<typeof github.getOctokit>;
/** Escape double quotes and strip triple-backtick sequences from untrusted text before LLM interpolation. */
export declare function sanitize(s: string, maxLength?: number): string;
interface PreviousFinding {
    title: string;
    file: string;
    line: number;
    severity: FindingSeverity | 'unknown';
    status: 'open' | 'resolved' | 'replied';
    threadId?: string;
}
interface RecapState {
    previousFindings: PreviousFinding[];
    recapContext: string;
}
/**
 * Fetch previous review state for a PR.
 */
declare function fetchRecapState(octokit: Octokit, owner: string, repo: string, prNumber: number): Promise<RecapState>;
/**
 * Filter out findings that duplicate previous ones or match stored suppressions.
 * Returns only genuinely new findings.
 */
interface DuplicateMatch {
    finding: Finding;
    matchedTitle: string;
}
declare function deduplicateFindings(newFindings: Finding[], previousFindings: PreviousFinding[], suppressions?: Suppression[]): {
    unique: Finding[];
    duplicates: DuplicateMatch[];
};
declare function titlesOverlap(a: string, b: string): boolean;
declare function llmDeduplicateFindings(findings: Finding[], previousFindings: PreviousFinding[], client: ClaudeClient): Promise<{
    unique: Finding[];
    duplicates: DuplicateMatch[];
}>;
export { DuplicateMatch, PreviousFinding, RecapState, fetchRecapState, deduplicateFindings, titlesOverlap, llmDeduplicateFindings };
