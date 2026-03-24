export type FindingSeverity = 'blocking' | 'suggestion' | 'question';
export interface Finding {
    severity: FindingSeverity;
    title: string;
    file: string;
    line: number;
    description: string;
    suggestedFix?: string;
    reviewers: string[];
    codeContext?: string;
}
export type ReviewVerdict = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
export interface ReviewResult {
    verdict: ReviewVerdict;
    summary: string;
    findings: Finding[];
    highlights: string[];
    reviewComplete: boolean;
}
export interface ReviewerAgent {
    name: string;
    focus: string;
}
export interface ReviewConfig {
    model: string;
    auto_review: boolean;
    auto_approve: boolean;
    review_language: string;
    include_paths: string[];
    exclude_paths: string[];
    max_diff_lines: number;
    reviewers: ReviewerAgent[];
    instructions: string;
    memory: {
        enabled: boolean;
        repo: string;
    };
}
export interface DiffFile {
    path: string;
    oldPath?: string;
    changeType: 'added' | 'modified' | 'deleted' | 'renamed';
    hunks: DiffHunk[];
}
export interface DiffHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    content: string;
}
export interface ParsedDiff {
    files: DiffFile[];
    totalAdditions: number;
    totalDeletions: number;
}
