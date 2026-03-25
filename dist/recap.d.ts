import * as github from '@actions/github';
import { ClaudeClient } from './claude';
import { Suppression } from './memory';
import { Finding, FindingSeverity, ParsedDiff } from './types';
type Octokit = ReturnType<typeof github.getOctokit>;
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
declare function deduplicateFindings(newFindings: Finding[], previousFindings: PreviousFinding[], suppressions?: Suppression[]): {
    unique: Finding[];
    duplicates: Finding[];
};
/**
 * Build a review summary that includes deduplication stats.
 */
declare function buildRecapSummary(newCount: number, duplicateCount: number, resolvedCount: number, openCount: number): string;
/**
 * Auto-resolve review threads whose findings were addressed in the new diff.
 * Candidates are identified by hunk overlap, then validated by Claude to
 * confirm the code change actually addresses the finding.
 */
declare function resolveAddressedThreads(octokit: Octokit, client: ClaudeClient | null, owner: string, repo: string, prNumber: number, previousFindings: PreviousFinding[], diff: ParsedDiff): Promise<number>;
export { PreviousFinding, RecapState, fetchRecapState, deduplicateFindings, buildRecapSummary, resolveAddressedThreads };
