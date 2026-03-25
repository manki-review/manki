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
}

export interface ReviewerAgent {
  name: string;
  focus: string;
}

export type ReviewLevel = 'auto' | 'small' | 'medium' | 'large';

export interface ReviewThresholds {
  small: number;
  medium: number;
}

export interface TeamRoster {
  level: 'small' | 'medium' | 'large';  // resolved, never 'auto'
  agents: ReviewerAgent[];
  lineCount: number;
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
  review_level: ReviewLevel;
  review_thresholds: ReviewThresholds;
  memory: {
    enabled: boolean;
    repo: string;
  };
  models?: {
    reviewer?: string;
    judge?: string;
  };
  nit_handling?: 'issues' | 'comments';
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
