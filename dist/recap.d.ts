import * as github from '@actions/github';
import { ClaudeClient } from './claude';
import { Suppression } from './memory';
import { AuthorReplyClass, Finding, FindingFingerprint, FindingSeverity, InPrSuppression } from './types';
type Octokit = ReturnType<typeof github.getOctokit>;
/** Escape double quotes and strip triple-backtick sequences from untrusted text before LLM interpolation. */
export declare function sanitize(s: string, maxLength?: number): string;
/**
 * Build a stable fingerprint for a finding. The slug mirrors the regex used
 * when writing the `<!-- manki:severity:SLUG -->` HTML marker in `github.ts`,
 * so fingerprints round-trip through posted review comments.
 */
declare function fingerprintFinding(title: string, file: string, lineStart: number, lineEnd?: number): FindingFingerprint;
/**
 * Classify an author reply body into a coarse stance.
 * Keyword order matters: agree wins over disagree, which wins over partial.
 * Signals preceded by a negation word within two tokens are skipped.
 */
declare function classifyAuthorReply(text: string | undefined): AuthorReplyClass;
interface PreviousFinding {
    title: string;
    file: string;
    line: number;
    lineStart?: number;
    severity: FindingSeverity | 'unknown';
    status: 'open' | 'resolved' | 'replied';
    threadId?: string;
    threadUrl?: string;
    authorReplyText?: string;
    /** Login of the latest non-bot replier on this thread, if any. */
    authorReplyLogin?: string;
}
/**
 * Build suppression entries from the current PR's review threads. Returns one
 * entry per manki-authored thread that is either resolved or whose latest
 * author reply is classified `agree`. Threads without a parseable title
 * (missing severity marker) are skipped.
 *
 * `agree-reply` suppressions only fire when the reply author matches
 * `prAuthorLogin`. This prevents an arbitrary third-party commenter from
 * silently dropping findings by posting "Fixed!" on a manki thread on a
 * public repo. `resolved-thread` suppressions are unaffected because
 * resolving a thread already requires repository write access.
 */
declare function collectInPrSuppressions(previousFindings: PreviousFinding[], prAuthorLogin?: string): InPrSuppression[];
interface RecapState {
    previousFindings: PreviousFinding[];
    recapContext: string;
}
/**
 * Fetch previous review state for a PR.
 */
declare function fetchRecapState(octokit: Octokit, owner: string, repo: string, prNumber: number, prAuthorLogin?: string): Promise<RecapState>;
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
export { DuplicateMatch, PreviousFinding, RecapState, classifyAuthorReply, collectInPrSuppressions, fingerprintFinding, fetchRecapState, deduplicateFindings, titlesOverlap, llmDeduplicateFindings };
