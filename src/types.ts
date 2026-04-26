export const MAX_AGENT_RETRIES = 1;

export type FindingSeverity = 'blocker' | 'warning' | 'suggestion' | 'nitpick' | 'ignore';

/**
 * Maps legacy severity values written by older versions of manki to the
 * current `FindingSeverity` set. `'required'` was renamed to `'blocker'` and
 * `'nit'` to `'nitpick'`; `'suggestion'` and `'ignore'` are unchanged. Used
 * when reading persisted data (handover JSON, posted review comment markers)
 * so old artifacts continue to round-trip correctly.
 */
export function migrateLegacySeverity(severity: string): FindingSeverity | string {
  if (severity === 'required') return 'blocker';
  if (severity === 'nit') return 'nitpick';
  return severity;
}

/** Regex source matching all current and legacy severity tokens. */
export const SEVERITY_TOKEN_PATTERN = 'blocker|warning|suggestion|nitpick|ignore|required|nit';

export type FindingReachability = 'reachable' | 'hypothetical' | 'unknown';

export const DEFENSIVE_HARDENING_TAG = 'defensive-hardening' as const;
export const RATCHET_SUPPRESSED_TAG = 'suppressed-by-ratchet' as const;
export const CONTRADICTION_TAG = 'contradicts-prior-round' as const;

export const OWN_PROPOSAL_TAG = 'own-proposal-followup' as const;

/**
 * A region of the current diff that implements code manki itself suggested in a
 * prior review round. Produced by matching prior-round `suggestedFix` text
 * against the raw diff's added lines.
 */
export interface ProvenanceEntry {
  file: string;
  lineStart: number;
  lineEnd: number;
  originatingRound: number;
  originatingTitle: string;
}

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
  reachability?: FindingReachability;
  reachabilityReasoning?: string;
  tags?: string[];
  originalSeverity?: FindingSeverity;
}

/**
 * Stable identifier for a finding across review rounds.
 * Title is reduced to a slug using the same expression used when posting the
 * `<!-- manki:severity:SLUG -->` HTML comment marker in review threads.
 */
export interface FindingFingerprint {
  file: string;
  lineStart: number;
  lineEnd: number;
  slug: string;
}

export type AuthorReplyClass = 'agree' | 'disagree' | 'partial' | 'none';

/** One finding as captured in a prior review round. */
export interface HandoverFinding {
  fingerprint: FindingFingerprint;
  severity: FindingSeverity | 'unknown';
  title: string;
  authorReply: AuthorReplyClass;
  threadId?: string;
  /** Originating specialist name (from `Finding.reviewers[0]`). Absent in handover files written before this field was added. */
  specialist?: string;
  /**
   * Text of the reviewer's proposed fix at the time the finding was raised.
   * Stored so later rounds can detect code that implements a prior-round
   * proposal (own-proposal caveat rule).
   */
  suggestedFix?: string;
}

/** A single completed review round recorded in the per-PR handover. */
export interface HandoverRound {
  round: number;
  commitSha: string;
  timestamp: string;
  findings: HandoverFinding[];
  judgeSummary?: string;
}

/** Per-PR cross-round state stored at `{targetRepo}/prs/{prNumber}/handover.json`. */
export interface PrHandover {
  prNumber: number;
  repo: string;
  rounds: HandoverRound[];
}

export type ReviewVerdict = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export type VerdictReason = 'required_present' | 'novel_suggestion' | 'only_nit_or_suggestion';

export interface ReviewResult {
  verdict: ReviewVerdict;
  verdictReason?: VerdictReason;
  summary: string;
  findings: Finding[];
  highlights: string[];
  reviewComplete: boolean;
  rawFindingCount?: number;
  agentNames?: string[];
  allJudgedFindings?: Finding[];
  rawFindings?: Finding[];
  resolveThreads?: Array<{ threadId: string; reason: string }>;
  plannerResult?: PlannerResult;
  failedAgents?: string[];
  agentFailureReasons?: Record<string, string>;
  partialReview?: boolean;
  partialNote?: string;
  staticDedupCount?: number;
  llmDedupCount?: number;
  suppressionCount?: number;
  agentResponseLengths?: Map<string, number>;
  crossRoundSuppressed?: number;
  crossRoundDemoted?: number;
}

export interface ReviewerAgent {
  name: string;
  focus: string;
}

export type EffortLevel = 'low' | 'medium' | 'high';

export interface AgentPick {
  name: string;
  effort: EffortLevel;
}

export interface PlannerResult {
  teamSize: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  reviewerEffort: EffortLevel;
  judgeEffort: EffortLevel;
  prType: string;
  agents?: AgentPick[];
  language?: string;
  context?: string;
}

/** Per-specialist outcome aggregate for a single prior round. */
export interface SpecialistOutcome {
  specialist: string;
  /** Count of findings the author did not acknowledge as fixed (`authorReply !== 'agree'`). */
  findingsKept: number;
  /** Count of findings the author agreed with and acted on (`authorReply === 'agree'`). */
  findingsDismissed: number;
}

/** Compact summary of a prior review round fed back to the planner for budget allocation. */
export interface PlannerRoundHint {
  round: number;
  specialistOutcomes: SpecialistOutcome[];
}

export type ReviewLevel = 'auto' | 'small' | 'medium' | 'large';

export interface ReviewThresholds {
  small: number;
  medium: number;
}

export interface TeamRoster {
  level: 'trivial' | 'small' | 'medium' | 'large';  // resolved, never 'auto'
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

/**
 * An unresolved review thread carried into a follow-up review so the judge
 * can decide whether the new diff addresses it.
 */
export interface OpenThread {
  threadId: string;
  threadUrl?: string;
  title: string;
  file: string;
  line: number;
  severity: FindingSeverity | 'unknown';
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

  // Per-agent metrics
  agentMetrics?: Array<{
    name: string;
    findingsRaw: number;
    findingsKept: number;
    failureReason?: string;
    responseLength?: number;
  }>;

  // Judge calibration
  judgeMetrics?: {
    confidenceDistribution: { high: number; medium: number; low: number };
    severityChanges: number;
    mergedDuplicates: number;
    defensiveHardeningCount?: number;
    verdictReason?: VerdictReason;
    crossRoundSuppressed?: number;
    crossRoundDemoted?: number;
  };

  // File analysis
  fileMetrics?: {
    fileTypes: Record<string, number>;
    findingsPerFile: Record<string, number>;
  };

  // Split model into reviewer/judge
  reviewerModel?: string;
  judgeModel?: string;
}

export interface AgentProgressEntry {
  name: string;
  status: 'pending' | 'reviewing' | 'done' | 'failed' | 'retrying';
  findingCount?: number;
  durationMs?: number;
  retryCount?: number;
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
  keptSeverities?: Record<string, number>;
  droppedSeverities?: Record<string, number>;
  plannerDurationMs?: number;
  judgeDurationMs?: number;
}

export interface JudgeDecision {
  title: string;
  severity: FindingSeverity;
  originalSeverity?: FindingSeverity;
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
