export type FindingSeverity = 'required' | 'suggestion' | 'nit' | 'ignore';
export interface Finding {
    severity: FindingSeverity;
    title: string;
    file: string;
    line: number;
    description: string;
    suggestedFix?: string;
    reviewers: string[];
    codeContext?: string;
    judgeNotes?: string;
    judgeConfidence?: 'high' | 'medium' | 'low';
}
export type ReviewVerdict = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';
export interface ReviewResult {
    verdict: ReviewVerdict;
    summary: string;
    findings: Finding[];
    highlights: string[];
    reviewComplete: boolean;
    rawFindingCount?: number;
    agentNames?: string[];
    allJudgedFindings?: Finding[];
    rawFindings?: Finding[];
    resolveThreads?: Array<{
        threadId: string;
        reason: string;
    }>;
    plannerResult?: PlannerResult;
    failedAgents?: string[];
    staticDedupCount?: number;
    llmDedupCount?: number;
}
export interface ReviewerAgent {
    name: string;
    focus: string;
}
export interface PlannerResult {
    teamSize: 1 | 3 | 5 | 7;
    reviewerEffort: 'low' | 'medium' | 'high';
    judgeEffort: 'low' | 'medium' | 'high';
    prType: string;
}
export type ReviewLevel = 'auto' | 'small' | 'medium' | 'large';
export interface ReviewThresholds {
    small: number;
    medium: number;
}
export interface TeamRoster {
    level: 'trivial' | 'small' | 'medium' | 'large';
    agents: ReviewerAgent[];
    lineCount: number;
}
export interface ReviewConfig {
    auto_review: boolean;
    auto_approve: boolean;
    exclude_paths: string[];
    max_diff_lines: number;
    reviewers: ReviewerAgent[];
    instructions: string;
    review_level: ReviewLevel;
    review_thresholds: ReviewThresholds;
    memory: {
        enabled: boolean;
        repo: string;
    };
    models?: {
        planner?: string;
        reviewer?: string;
        judge?: string;
        dedup?: string;
    };
    planner?: {
        enabled?: boolean;
    };
    nit_handling?: 'issues' | 'comments';
    review_passes?: number;
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
export interface PrContext {
    title: string;
    body: string;
    baseBranch: string;
}
export interface ReviewStats {
    model: string;
    reviewTimeMs: number;
    diffLines: number;
    diffAdditions: number;
    diffDeletions: number;
    filesReviewed: number;
    agents: string[];
    findingsRaw: number;
    findingsKept: number;
    findingsDropped: number;
    severity: Record<string, number>;
    verdict: string;
    prNumber: number;
    commitSha: string;
    agentMetrics?: Array<{
        name: string;
        findingsRaw: number;
        findingsKept: number;
    }>;
    judgeMetrics?: {
        confidenceDistribution: {
            high: number;
            medium: number;
            low: number;
        };
        severityChanges: number;
        mergedDuplicates: number;
    };
    fileMetrics?: {
        fileTypes: Record<string, number>;
        findingsPerFile: Record<string, number>;
    };
    reviewerModel?: string;
    judgeModel?: string;
}
export interface AgentProgressEntry {
    name: string;
    status: 'pending' | 'reviewing' | 'done' | 'failed';
    findingCount?: number;
    durationMs?: number;
}
export interface DashboardData {
    phase: 'planning' | 'started' | 'reviewed' | 'complete';
    lineCount: number;
    agentCount: number;
    rawFindingCount?: number;
    judgeInputCount?: number;
    keptCount?: number;
    droppedCount?: number;
    agentProgress?: AgentProgressEntry[];
    plannerInfo?: Pick<PlannerResult, 'teamSize' | 'reviewerEffort' | 'judgeEffort' | 'prType'>;
}
export interface JudgeDecision {
    title: string;
    severity: FindingSeverity;
    reasoning: string;
    confidence: 'high' | 'medium' | 'low';
    kept: boolean;
}
export interface ReviewMetadata {
    config: {
        reviewerModel: string;
        judgeModel: string;
        reviewLevel: string;
        reviewLevelReason: string;
        teamAgents: string[];
        memoryEnabled: boolean;
        memoryRepo: string;
        nitHandling: string;
    };
    judgeDecisions: JudgeDecision[];
    timing: {
        parseMs: number;
        reviewMs: number;
        judgeMs: number;
        totalMs: number;
    };
}
