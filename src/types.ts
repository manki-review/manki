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
export const RESOLVED_THREAD_SUPPRESSED_TAG = 'suppressed-by-resolved-thread' as const;

export const OWN_PROPOSAL_TAG = 'own-proposal-followup' as const;
export const IN_PR_SUPPRESSED_TAG = 'suppressed-in-pr' as const;

/** Shared shape for the prose extracted from a review-thread comment body. */
export interface FindingMetadata {
  description?: string;
  suggestedFix?: string;
}

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

/** Reason why a prior-round thread's fingerprint is suppressing current findings. */
export type InPrSuppressionReason = 'resolved-thread' | 'agree-reply';

/** Fingerprint-level suppression derived from the current PR's thread state. */
export interface InPrSuppression {
  fingerprint: FindingFingerprint;
  reason: InPrSuppressionReason;
  /**
   * Login of the commenter whose reply triggered an `agree-reply` suppression.
   * Absent for `resolved-thread` reasons. Used for audit-log attribution.
   */
  authorLogin?: string;
}

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
  /**
   * Names of the reviewer agents that participated in this round. Used by
   * later rounds to pin the team across rounds (monotonic growth): an agent
   * present in any prior round is always carried forward. Optional so older
   * serialized handovers without this field still parse.
   */
  agents?: string[];
}

/** Per-PR cross-round state stored at `{targetRepo}/prs/{prNumber}/handover.json`. */
export interface PrHandover {
  prNumber: number;
  repo: string;
  rounds: HandoverRound[];
}

export type ReviewVerdict = 'APPROVE' | 'COMMENT' | 'REQUEST_CHANGES';

export type VerdictReason = 'required_present' | 'novel_suggestion' | 'prior_unaddressed' | 'only_nit_or_suggestion';

export interface ReviewResult {
  verdict: ReviewVerdict;
  verdictReason?: VerdictReason;
  summary: string;
  findings: Finding[];
  highlights: string[];
  reviewComplete: boolean;
  rawFindingCount?: number;
  agentNames: string[];
  allJudgedFindings?: Finding[];
  rawFindings?: Finding[];
  threadEvaluations?: ThreadEvaluation[];
  plannerResult?: PlannerResult;
  failedAgents?: string[];
  agentFailureReasons?: Record<string, string>;
  partialReview?: boolean;
  partialNote?: string;
  staticDedupCount?: number;
  llmDedupCount?: number;
  suppressionCount?: number;
  inPrSuppressedCount?: number;
  agentResponseLengths?: Map<string, number>;
  crossRoundSuppressed?: number;
  crossRoundDemoted?: number;
  testNitSuppressedCount?: number;
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
    /**
     * Per-agent model overrides. Keys are reviewer agent names (built-in or
     * custom). When set, the resolver picks this model for the named agent
     * instead of `models.reviewer`.
     */
    agents?: Record<string, string>;
  };
  planner?: {
    enabled?: boolean;
  };
  nit_handling?: 'issues' | 'comments';
  review_passes?: number;
  convergence?: {
    /**
     * Hard cap on the number of automatic review rounds per PR. Once exceeded,
     * automatic review is paused; the author can re-trigger with `@manki review`.
     * Set to `0` to disable the cap.
     */
    max_auto_rounds?: number;
    /** Glob patterns for test files. Suggestion/nitpick findings on these paths are dropped on round 2+. */
    test_path_patterns?: string[];
    /** When true, a prior-round finding whose thread is currently resolved on GitHub suppresses matching current findings. */
    suppress_resolved_threads?: boolean;
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

export interface PrContext {
  title: string;
  body: string;
  baseBranch: string;
}

/**
 * An unresolved review thread carried into a follow-up review so the judge
 * can decide whether the new diff addresses it.
 */
export interface OpenThread extends FindingMetadata {
  threadId: string;
  threadUrl?: string;
  title: string;
  file: string;
  line: number;
  severity: FindingSeverity | 'unknown';
  /**
   * Snippet of the current source around `line` (line ± a small window). Lets
   * the judge ground its addressed/not-addressed decision in the actual code,
   * not just the thread title. `'(file removed)'` when the file no longer
   * exists at the head commit.
   */
  currentCode?: string;
}

/**
 * Per-thread judgment from the LLM judge on whether an open review thread has
 * been addressed by the latest changes. Only `status === 'addressed'` triggers
 * a `resolveReviewThread` mutation downstream; `'uncertain'` is treated as
 * not-addressed (insufficient evidence).
 */
export interface ThreadEvaluation {
  threadId: string;
  status: 'addressed' | 'not_addressed' | 'uncertain';
  reason: string;
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
    inPrSuppressedCount?: number;
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

/**
 * Per-round semantic state of a manki review, grouped by pipeline stage.
 *
 * Single source of truth for per-round context, consumed by two surfaces:
 *
 * 1. The PR-embedded `Manki context` block — the structured payload manki
 *    attaches to its review comment. Replaces the ad-hoc `Review stats` JSON
 *    grown organically over time and consolidates everything `HandoverRound`
 *    used to carry in the per-PR handover file.
 * 2. Local replay bundles — the `context` sub-field of the bundles produced for
 *    offline replay, so a replay carries the full prior-round state without
 *    having to re-derive it from the review comment.
 *
 * Both consumers see the same shape, version-stamped via `meta.mankiVersion`
 * (per the schema-versioning decision in #461). Flat-compat aliases used by
 * legacy downstream workflows (`verdict`, `findingsRaw`, `findingsKept`,
 * `severity`, `reviewTimeMs`, `diffLines`, etc.) are derived at emit time via
 * `roundContextToFlatAliases` rather than duplicated in the type.
 *
 * Sub-issues #686, #687, #688, #689, #690 wire the emitter, HTML render,
 * recap aggregator, consumer migration, and handover deletion.
 */
export interface RoundContext {
  meta: RoundMeta;
  config: RoundConfig;
  diff: RoundDiff;
  models: RoundModels;
  planner: RoundPlanner;
  reviewers: RoundReviewers;
  judge: RoundJudge;
  dedup: RoundDedup;
  memory: RoundMemory;
  findings: RoundFindings;
  usage: RoundUsage;
  verdict: ReviewVerdict;
}

/** Identity, provenance, and versioning for a single completed review round. */
export interface RoundMeta {
  prNumber: number;
  commitSha: string;
  round: number;
  /** ISO 8601 timestamp at which the round completed. */
  timestamp: string;
  /** GitHub Actions `run_id` that produced this round. */
  runId: number;
  /** `version` from `package.json` of the manki release that produced this round. */
  mankiVersion: string;
  promptVersions: PromptVersions;
}

/** Version identifiers for the prompt templates used by each pipeline stage. */
export interface PromptVersions {
  judge: string;
  reviewer: string;
  planner: string;
}

/** Effective config snapshot for the round: AI pipeline behavior fields (model behavior, pass configuration, memory). Convergence/post-processing rules are not included. */
export interface RoundConfig {
  reviewLevel: ReviewLevel;
  nitHandling: 'issues' | 'comments';
  memoryEnabled: boolean;
  reviewPasses?: number;
}

export interface RoundDiff {
  lines: number;
  additions: number;
  deletions: number;
  filesReviewed: number;
  fileTypes: Record<string, number>;
}

/** Resolved model IDs per pipeline stage. */
export interface RoundModels {
  planner?: string;
  reviewer: string;
  judge: string;
  dedup?: string;
}

export interface RoundPlanner {
  /** False when the planner was disabled or fell back to the heuristic team selector. */
  used: boolean;
  teamSize?: PlannerResult['teamSize'];
  reviewerEffort?: EffortLevel;
  judgeEffort?: EffortLevel;
  prType?: string;
  durationMs?: number;
}

export interface RoundReviewers {
  /** Reviewer agent names that participated in this round (subsumes `HandoverRound.agents`). */
  agents: string[];
  agentMetrics?: RoundAgentMetric[];
}

export interface RoundAgentMetric {
  name: string;
  findingsRaw?: number;
  findingsKept?: number;
  durationMs?: number;
  status?: 'success' | 'failed';
  responseLength?: number;
  warnings?: string[];
  inputTokens?: number;
  outputTokens?: number;
  failureReason?: string;
}

export interface RoundJudge {
  /** Narrative summary used today by `buildPlannerHints` and surfaced in handover. */
  summary: string;
  confidenceDistribution?: { high: number; medium: number; low: number };
  severityChanges?: number;
  mergedDuplicates?: number;
  durationMs?: number;
  verdictReason?: VerdictReason;
  defensiveHardeningCount?: number;
  inPrSuppressedCount?: number;
  crossRoundSuppressed?: number;
  crossRoundDemoted?: number;
}

export interface RoundDedup {
  staticDropped?: number;
  llmDropped?: number;
  durationMs?: number;
}

export interface RoundMemory {
  patternsApplied?: number;
  suppressionsApplied?: number;
  escalationsApplied?: number;
}

/**
 * Per-round fingerprint table. Carries identity and outcome of each finding,
 * never the body. Replaces `HandoverRound.findings` in the new shape.
 */
export interface RoundFindings {
  count: number;
  severityCounts: Record<string, number>;
  entries: FindingFingerprintEntry[];
}

export interface FindingFingerprintEntry {
  fingerprint: FindingFingerprint;
  threadId?: string;
  severity: FindingSeverity | 'unknown';
  authorReplyClass?: AuthorReplyClass;
}

export interface RoundUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  perStage?: Partial<Record<'planner' | 'reviewer' | 'judge' | 'dedup', RoundUsageStage>>;
}

export interface RoundUsageStage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

/**
 * Flat-compat aliases preserved for downstream workflows that read the legacy
 * `Review stats` keys (`fromJSON(steps.manki.outputs.severity_counts)` etc.).
 * Derived from a `RoundContext` at emit time so the type itself stays free of
 * duplicated fields. Slated for removal in v5.0.0 per the #461 decision log.
 */
export interface RoundContextFlatAliases {
  prNumber: number;
  commitSha: string;
  verdict: ReviewVerdict;
  diffLines: number;
  diffAdditions: number;
  diffDeletions: number;
  filesReviewed: number;
  agents: string[];
  findingsRaw: number;
  findingsKept: number;
  findingsDropped: number;
  severity: Record<string, number>;
  model: string;
  reviewerModel: string;
  judgeModel: string;
}

/**
 * Project a `RoundContext` to the legacy flat-key shape consumed by older
 * downstream workflows. Keep this the single derivation point so removing the
 * aliases in v5.0.0 is a one-file change.
 *
 * `findingsRaw` is reconstructed as `findings.count + dedup.staticDropped +
 * dedup.llmDropped + judge.mergedDuplicates`, matching the pre-grouping
 * `ReviewStats.findingsRaw` definition.
 */
export function roundContextToFlatAliases(ctx: RoundContext): RoundContextFlatAliases {
  const kept = ctx.findings.count;
  const staticDropped = ctx.dedup.staticDropped ?? 0;
  const llmDropped = ctx.dedup.llmDropped ?? 0;
  const mergedDuplicates = ctx.judge.mergedDuplicates ?? 0;
  const raw = kept + staticDropped + llmDropped + mergedDuplicates;
  return {
    prNumber: ctx.meta.prNumber,
    commitSha: ctx.meta.commitSha,
    verdict: ctx.verdict,
    diffLines: ctx.diff.lines,
    diffAdditions: ctx.diff.additions,
    diffDeletions: ctx.diff.deletions,
    filesReviewed: ctx.diff.filesReviewed,
    agents: ctx.reviewers.agents,
    findingsRaw: raw,
    findingsKept: kept,
    findingsDropped: raw - kept,
    severity: ctx.findings.severityCounts,
    model: ctx.models.reviewer,
    reviewerModel: ctx.models.reviewer,
    judgeModel: ctx.models.judge,
  };
}
