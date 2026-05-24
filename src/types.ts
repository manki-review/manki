import type { LLMUsage } from './providers/types';

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

/**
 * Pre-Conventional-Commits planner vocab. Historical review bodies persisted
 * these values into `planner.prType`. Read-only remap so old rounds render
 * with the current canonical vocab.
 */
const LEGACY_PR_TYPE_MAP: Record<string, string> = {
  feature: 'feat',
  bugfix: 'fix',
  rename: 'refactor',
};

export function migrateLegacyPrType(value: string): string {
  return LEGACY_PR_TYPE_MAP[value] ?? value;
}

export type FindingReachability = 'reachable' | 'hypothetical' | 'unknown';

export const DEFENSIVE_HARDENING_TAG = 'defensive-hardening' as const;
export const RATCHET_SUPPRESSED_TAG = 'suppressed-by-ratchet' as const;
export const CONTRADICTION_TAG = 'contradicts-prior-round' as const;
export const RESOLVED_THREAD_SUPPRESSED_TAG = 'suppressed-by-resolved-thread' as const;

export const OWN_PROPOSAL_TAG = 'own-proposal-followup' as const;
export const IN_PR_SUPPRESSED_TAG = 'suppressed-in-pr' as const;

export interface InterRoundDiffEmptyOverride {
  applied: boolean;
  affectedThreadCount: number;
}

/**
 * Three-way state of the GitHub review-thread fetch consumed by
 * `determineVerdict`. `fetched` and `empty` distinguish "threads returned"
 * from "fetched, none open"; `fetch_failed` means the GraphQL call errored
 * and downstream code is operating on the conservative unknown-state
 * fallback.
 */
export type OpenThreadsState = 'fetched' | 'empty' | 'fetch_failed';

/**
 * Three-way state of the inter-round diff consumed by the judge stage.
 * `unknown` corresponds to a compare-API failure or the absence of any
 * prior round; `empty` is a known-no-changes diff (force-pushed rebase to
 * an identical tree); `changed` is a non-empty diff.
 */
export type InterRoundDiffState = 'unknown' | 'empty' | 'changed';

/** One verdict-trace entry recording the identity of a finding or prior that triggered the verdict gate. */
export interface VerdictTraceEntry {
  file: string;
  title: string;
  /**
   * Stable composite string identity (`file:lineStart:lineEnd:slug`). Mirrors
   * the dedupe key used by `dedupePriorFindings` so the same logical issue
   * has the same trace identity across rounds.
   */
  fingerprint: string;
  /** Set only on `unresolvedPriors` entries: the GitHub review-thread id, when known. */
  threadId?: string;
  /** Set only on `unresolvedPriors` entries: the originating round number. */
  round?: number;
  /** Set only on `unresolvedPriors` entries: the line number of the blocking thread. */
  line?: number;
  /** Set only on `unresolvedPriors` entries: the original severity of the prior finding. */
  severity?: FindingSeverity | 'unknown';
  /** Set only on `unresolvedPriors` entries: a direct GitHub link to the thread, when known. */
  threadUrl?: string;
}

/**
 * Per-branch breakdown of which findings or priors triggered `determineVerdict`.
 * Only the branch that fired needs to be non-empty; the other arrays stay empty.
 * Recorded on `RoundJudge.verdictTrace` so replay tooling can answer "which N
 * priors gated APPROVE on round 15?" without re-deriving from `findings.entries`.
 */
export interface VerdictTrace {
  survivingBlockers: VerdictTraceEntry[];
  novelWarnings: VerdictTraceEntry[];
  unresolvedPriors: VerdictTraceEntry[];
}

/**
 * Outcome counts for the post-judge thread-resolution loop in `runFullReview`.
 * Records overrides applied at the loop site (after `runJudgeAgent` already
 * synthesised `interRoundDiffEmptyOverride`): how many `addressed` evaluations
 * the loop dropped, how many `not_addressed` evaluations were synthesised by
 * the empty-diff override, and how many `uncertain` evaluations the judge
 * emitted in the round.
 */
export interface ThreadResolutionOverrides {
  addressedDropped: number;
  notAddressedOverridden: number;
  uncertainCount: number;
}

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
  /** Per-drop cross-round dedup attribution: both `deduplicateFindings` (static) and `llmDeduplicateFindings` (llm) entries, in the order they were dropped. */
  duplicateMatches?: RoundDedupDuplicateMatch[];
  suppressionCount?: number;
  inPrSuppressedCount?: number;
  agentResponseLengths?: Map<string, number>;
  /** Aggregated reviewer usage per agent across all passes/retries. */
  agentUsage?: Map<string, LLMUsage>;
  /** Aggregated wall-clock duration per agent across all passes/retries. */
  agentDurationMs?: Map<string, number>;
  /** Number of CLI/SDK retries per agent. Zero (omitted) when the first try succeeded. */
  agentRetryCount?: Map<string, number>;
  /** Aggregated planner LLM usage and wall-clock duration. */
  plannerUsage?: LLMUsage;
  plannerDurationMs?: number;
  /** Aggregated judge LLM usage, wall-clock duration, and retry count. */
  judgeUsage?: LLMUsage;
  judgeDurationMs?: number;
  judgeRetryCount?: number;
  /** Aggregated dedup LLM usage and wall-clock duration (LLM dedup step only). */
  dedupUsage?: LLMUsage;
  dedupDurationMs?: number;
  crossRoundSuppressed?: number;
  crossRoundDemoted?: number;
  /** Set when the judge stage forced every open thread to `not_addressed` because the inter-round diff was known-empty. */
  interRoundDiffEmptyOverride?: InterRoundDiffEmptyOverride;
  testNitSuppressedCount?: number;
  verdictTrace?: VerdictTrace;
  /** Team-selection provenance: which path produced this round's roster. */
  plannerSource?: RoundPlannerSource;
  /** Short tag describing the planner fallback path, when one fired. */
  plannerFallbackReason?: string;
  /** Names of agents the team-builder reinjected after the planner omitted them. */
  coreAgentInjections?: string[];
  /** Effort downgrades applied by the prior-round safety net. */
  priorRoundEffortDowngrades?: PriorRoundEffortDowngrade[];
  /** Per-agent multi-pass intersection stats. Keyed by agent name. */
  agentMultiPassConsistency?: Map<string, { consistent: number; totalRaw: number }>;
  /** Per-agent effort level actually used at run time. Keyed by agent name. */
  agentEffortMap?: Map<string, EffortLevel>;
  /**
   * Reason per agent that was skipped before the model call (lens check). Keyed
   * by agent name. Absent when no agent was skipped.
   */
  agentSkipReasons?: Map<string, 'lens-no-match'>;
}

export interface ReviewerAgent {
  name: string;
  focus: string;
  /**
   * Optional file-pattern lens that decides whether the agent has anything new
   * to review in the current diff. When set, the reviewer loop checks the diff
   * against this lens and skips the model call when the lens evaluates to
   * "no relevant changes". Agents without a lens always run. Lens evaluation
   * is conservative: when in doubt, run the agent.
   */
  lens?: AgentLens;
}

/**
 * Lens describing which files an agent cares about. The reviewer loop skips
 * the agent's model call when none of the diff's files satisfy the lens.
 *
 * `mode` controls how `filePatterns` is interpreted:
 *
 * - `'include'`: run only when at least one changed file matches a pattern.
 *   Used for narrowly-scoped agents (e.g. testing agents only care about test
 *   files).
 * - `'exclude-only'`: skip only when every changed file matches a pattern.
 *   Used for broadly-scoped agents that should run unless the diff is *purely*
 *   irrelevant (e.g. an architecture agent skipping a tests-only diff).
 */
export interface AgentLens {
  mode: 'include' | 'exclude-only';
  filePatterns: string[];
}

export type EffortLevel = 'low' | 'medium' | 'high';

export interface AgentPick {
  name: string;
  effort: EffortLevel;
}

/**
 * Conventional Commits canonical types the planner is allowed to emit for
 * `PlannerResult.prType`. Values outside this set collapse to `'unknown'` at
 * parse time and the renderer omits the chip entirely.
 */
export const VALID_PR_TYPE_VALUES = [
  'build',
  'chore',
  'ci',
  'docs',
  'feat',
  'fix',
  'perf',
  'refactor',
  'revert',
  'style',
  'test',
] as const;

export type ValidPrType = typeof VALID_PR_TYPE_VALUES[number];

export const VALID_PR_TYPES = new Set<string>(VALID_PR_TYPE_VALUES);

export interface PlannerResult {
  teamSize: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  reviewerEffort: EffortLevel;
  judgeEffort: EffortLevel;
  prType: ValidPrType | 'unknown';
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

export type NoiseLevel = 'low' | 'medium' | 'high';

export interface ReviewThresholds {
  small: number;
  medium: number;
}

export interface TeamRoster {
  level: 'trivial' | 'small' | 'medium' | 'large';  // resolved, never 'auto'
  agents: ReviewerAgent[];
  lineCount: number;
  /**
   * Names of agents added by a code-level reinjection backstop after the
   * planner omitted them (e.g., Security & Safety force-add on sensitive
   * paths). Empty when no reinjection fired. Populated by `selectTeam` on the
   * planner path; the heuristic-fallback path leaves it empty.
   */
  coreAgentInjections?: string[];
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
  /**
   * @deprecated Removed in v5.1.0. All surviving findings post inline as PR
   * review comments. The field is still parsed so old configs don't fail,
   * but the value is ignored and a one-line warning is emitted at run start.
   */
  nit_handling?: 'issues' | 'comments';
  noise_level?: NoiseLevel;
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
  stats?: {
    /**
     * When true, the `Manki context` block is rendered as an HTML comment
     * (`<!-- manki-context: ... -->`) instead of a `<details>` block. Hides
     * the structured payload from the rendered review while keeping it
     * machine-readable.
     */
    hidden?: boolean;
  };
  /**
   * TTL (in seconds) for the in-app concurrent-submission lock. When another
   * `manki-review[bot]` run has posted an in-progress marker comment that was
   * updated within this window, the current run bails before any LLM call.
   * Acts as defense in depth on top of the workflow-level concurrency group.
   */
  concurrency_lock_ttl_seconds?: number;
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  hunks: DiffHunk[];
  additions?: number;
  deletions?: number;
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
  /** Paths of binary files dropped by `isBinaryFile` during `parsePRDiff`. */
  binarySkipped?: string[];
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
  plannerInfo?: {
    /**
     * Size of the final resolved roster (after prior-round pinning and any
     * other adjustments), not the raw `teamSize` the planner asked for.
     */
    agentCount: number;
    reviewerEffort: EffortLevel;
    judgeEffort: EffortLevel;
    /**
     * Raw prType as received from a `PlannerResult` or replayed from a persisted
     * `RoundPlanner.prType`. The dashboard sanitizes through `validPrTypeOrNull`
     * before rendering, so off-vocab values are tolerated here.
     */
    prType: string;
  };
  keptSeverities?: Record<string, number>;
  droppedSeverities?: Record<string, number>;
  testNitSuppressedCount?: number;
  plannerDurationMs?: number;
  judgeDurationMs?: number;
  /** True when team selection fell back to the heuristic because the planner failed or timed out. Surfaces a one-line marker in the rendered summary so the broader team set is self-explanatory. */
  heuristicFallback?: boolean;
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
 *    attaches to its review comment.
 * 2. Local replay bundles — the `context` sub-field of the bundles produced for
 *    offline replay, so a replay carries the full prior-round state without
 *    having to re-derive it from the review comment.
 *
 * Both consumers see the same shape, version-stamped via `meta.mankiVersion`.
 * Flat-compat aliases used by legacy downstream workflows (`verdict`,
 * `findingsRaw`, `findingsKept`, `severity`, `reviewTimeMs`, `diffLines`,
 * etc.) are derived at emit time via `roundContextToFlatAliases` rather than
 * duplicated in the type.
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
  /**
   * Recap-stage attribution: which priors were loaded, how many flipped
   * `authorReplyClass` during refresh, and the flips themselves. Optional
   * so legacy context blocks parse cleanly.
   */
  recap?: RoundRecap;
}

/** Identity, provenance, and versioning for a single completed review round. */
export interface RoundMeta {
  prNumber: number;
  commitSha: string;
  round: number;
  /** ISO 8601 timestamp at which the round completed. */
  timestamp: string;
  /** `version` from `package.json` of the manki release that produced this round. */
  mankiVersion: string;
  promptVersions?: PromptVersions;
  /**
   * Round-cap accounting captured at the moment this round was admitted.
   * `priorRoundCount` is the count *before* this round was appended, so the
   * public `5/5` display reads as `priorRoundCount: 5, maxAutoRounds: 5`.
   * Optional so replay tooling reading older context blocks keeps working.
   */
  cap?: RoundCap;
  /**
   * Provenance of the event that triggered this round. Optional so replay
   * tooling reading older context blocks keeps working.
   */
  trigger?: RoundTrigger;
}

/** Round-cap accounting captured at the moment a round was admitted. */
export interface RoundCap {
  priorRoundCount: number;
  maxAutoRounds: number;
  skipCap: boolean;
  forceReview: boolean;
  /**
   * Which path admitted this round. `within_cap` means the cap was not
   * reached. The remaining values name the bypass branch that fired.
   */
  bypassReason?: 'within_cap' | 'force_review' | 'skip_cap' | 'manual_review_command';
}

/** Options forwarded from the dispatch site into `runFullReview`. */
export interface FullReviewOptions {
  prAuthorLogin?: string;
  forceReview?: boolean;
  skipCap?: boolean;
  bypassHint?: 'force_review' | 'skip_cap' | 'manual_review_command';
  trigger?: RoundTrigger;
  headRepoFullName?: string;
}

/** Provenance of the event that triggered a round. */
export interface RoundTrigger {
  /**
   * `github.context.eventName` plus the action and (when applicable) the
   * marker comment that fired. Examples: `pull_request:synchronize`,
   * `issue_comment:created:@manki review`,
   * `issue_comment:edited:tick:FORCE_REVIEW_MARKER`.
   */
  event: string;
  /** `github.context.payload.sender.login`, or `'unknown'` when absent. */
  sender: string;
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
  memoryEnabled: boolean;
  reviewPasses?: number;
}

export interface RoundDiffExcludedFile {
  path: string;
  matchedPattern: string;
}

export interface RoundDiffPerFile {
  path: string;
  additions: number;
  deletions: number;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface RoundDiff {
  lines: number;
  additions: number;
  deletions: number;
  filesReviewed: number;
  fileTypes: Record<string, number>;
  /** Files filtered out by `config.exclude_paths` and which pattern fired. */
  excludedFiles?: RoundDiffExcludedFile[];
  /** Paths skipped by `isBinaryFile` during `parsePRDiff`. */
  binarySkipped?: string[];
  /**
   * True when `isDiffTooLarge` fired for this round. The early-exit path
   * never emits a `RoundContext`, so on the success path this is always
   * `false`. Recorded explicitly so the absence of context for an
   * oversized PR is unambiguous in replay tooling.
   */
  oversizedHandled?: boolean;
  /** Per-file aggregate (lossless replacement for the existing `fileTypes` rollup). */
  perFile?: RoundDiffPerFile[];
}

/** Resolved model IDs per pipeline stage. */
export interface RoundModels {
  planner?: string;
  reviewer: string;
  judge: string;
  dedup?: string;
}

/**
 * Provenance of the team-selection path that produced this round's roster.
 *
 * - `planner`: the planner LLM returned a valid result and its picks were used.
 * - `heuristic_fallback`: the planner was attempted but failed (timeout,
 *   validation error, parse error) and team-builder substituted the fixed
 *   three-core roster.
 * - `heuristic`: the planner was not attempted because the user pinned
 *   `review_level` to an explicit value (heuristic on by user choice).
 * - `disabled`: the planner has no client (no `planner` provider configured)
 *   and team selection ran via the heuristic path.
 */
export type RoundPlannerSource = 'planner' | 'heuristic' | 'heuristic_fallback' | 'disabled';

export interface RoundPlanner {
  /**
   * Provenance of the team selection path. Replaces the original `used: boolean`,
   * which collapsed three distinct paths into a single bit. `used` is preserved
   * as a derived getter alias (`source === 'planner'`) for back-compat.
   */
  source: RoundPlannerSource;
  /**
   * Back-compat alias for `source === 'planner'`. New code reads `source`.
   * Always present so older consumers that destructure `planner.used`
   * continue to work.
   */
  readonly used: boolean;
  /**
   * Set when team selection fell back from the planner (validation error,
   * timeout, parse failure). Free-text, capped, sanitized for logs.
   */
  fallbackReason?: string;
  teamSize?: PlannerResult['teamSize'];
  reviewerEffort?: EffortLevel;
  judgeEffort?: EffortLevel;
  prType?: string;
  durationMs?: number;
  /** Sanitized programming-language hint, when the planner identified one. */
  language?: string;
  /** Sanitized free-text PR context hint, when the planner identified one. */
  context?: string;
  /**
   * Per-agent picks the planner emitted (or that the team-builder synthesized
   * on the `planner` path before reinjections). Each entry carries the
   * planner's intended effort for that agent; the actual run-time effort is
   * recorded on `RoundAgentMetric.effort`.
   */
  agents?: AgentPick[];
  /**
   * Names of agents the planner omitted that the team-builder added back via a
   * code-level backstop (e.g., the security path-prefix guard). Empty when no
   * reinjection fired. Always present so audit tooling can distinguish
   * "no reinjection" (`[]`) from "data not recorded" (`undefined`).
   */
  coreAgentInjections: string[];
  /**
   * Effort levels the safety-net downgrader stepped down because the most
   * recent prior round dismissed all of that specialist's findings. One entry
   * per downgraded pick. Empty when nothing was downgraded.
   */
  priorRoundEffortDowngrades: PriorRoundEffortDowngrade[];
}

/** One effort downgrade applied by the prior-round safety net. */
export interface PriorRoundEffortDowngrade {
  agent: string;
  from: EffortLevel;
  to: EffortLevel;
}

export interface RoundReviewers {
  /** Reviewer agent names that participated in this round. */
  agents: string[];
  agentMetrics?: RoundAgentMetric[];
}

export interface RoundAgentMetric {
  name: string;
  findingsRaw?: number;
  findingsKept?: number;
  durationMs?: number;
  status?: 'success' | 'failed' | 'skipped';
  /**
   * Why the agent was skipped, when `status === 'skipped'`. Currently always
   * `'lens-no-match'` (set by the per-agent lens check before model dispatch).
   */
  skipReason?: 'lens-no-match';
  responseLength?: number;
  warnings?: string[];
  inputTokens?: number;
  outputTokens?: number;
  /** Number of CLI/SDK retries this agent triggered. Zero on the success-on-first-try path. */
  retryCount?: number;
  /** Last-failure reason recorded by the reviewer loop. Present only when retries exhausted. */
  failureReason?: string;
  /**
   * Resolved per-agent model ID. Falls back to `RoundModels.reviewer` when no
   * `models.agents` override applies. Present whenever the agent ran.
   */
  model?: string;
  /**
   * Effort level the agent actually ran with, after the planner pick (or the
   * default `reviewerEffort`) and any prior-round downgrade.
   */
  effort?: EffortLevel;
  /**
   * Multi-pass intersection stats for this agent on `review_passes > 1` rounds.
   * `consistent` is the count of findings retained by `intersectFindings`,
   * `totalRaw` is the pre-intersection sum across passes. Absent on single-pass
   * rounds and on agents that failed every pass.
   */
  multiPassConsistency?: { consistent: number; totalRaw: number };
}

export interface RoundJudge {
  /** Narrative summary used by `buildPlannerHints`. */
  summary: string;
  confidenceDistribution?: { high: number; medium: number; low: number };
  severityChanges?: number;
  mergedDuplicates?: number;
  durationMs?: number;
  /** Number of judge LLM retries (zero when the first call satisfied the validation contract). */
  retryCount?: number;
  verdictReason?: VerdictReason;
  defensiveHardeningCount?: number;
  inPrSuppressedCount?: number;
  crossRoundSuppressed?: number;
  crossRoundDemoted?: number;
  /**
   * Count of findings demoted to `nitpick` because they implement a prior-round
   * `suggestedFix` (tagged `OWN_PROPOSAL_TAG`). Distinct from
   * `defensiveHardeningCount` which covers hypothetical-reachability demotions.
   */
  ownProposalDemotedCount?: number;
  /**
   * Subset of `crossRoundDemoted` tagged `CONTRADICTION_TAG`. Together with
   * `ownProposalDemotedCount`, accounts for the full `crossRoundDemoted`
   * aggregate; split so future demotion categories don't collapse into a
   * single opaque counter.
   */
  contradictionDemotedCount?: number;
  /** Subset of `crossRoundSuppressed` tagged `RATCHET_SUPPRESSED_TAG`. */
  ratchetSuppressedCount?: number;
  /** Subset of `crossRoundSuppressed` tagged `RESOLVED_THREAD_SUPPRESSED_TAG`. */
  resolvedThreadSuppressedCount?: number;
  /**
   * Records the defense-in-depth path where the judge stage forced every open
   * thread to `not_addressed` because the inter-round diff was known-empty
   * (force-pushed rebase to identical tree). `applied: true` means the
   * synthetic evaluations replaced whatever the LLM returned.
   */
  interRoundDiffEmptyOverride?: InterRoundDiffEmptyOverride;
  /**
   * Per-open-thread judgment from the judge stage. Surfaced in the embedded
   * round-context block so the resolution signal is observable post-hoc when
   * debugging stuck reviews. Producers omit this field on rounds with no open
   * threads. `status: 'addressed'` retires warning priors via `determineVerdict`
   * and ratchets suggestion/nitpick priors via `applyCrossRoundSuppression`;
   * blockers require GitHub thread resolution or explicit `authorReply: 'agree'`.
   */
  threadEvaluations?: ThreadEvaluation[];
  /**
   * Identity of every finding or prior that triggered the verdict gate
   * (`determineVerdict`). Only the branch that fired is non-empty; the others
   * stay as empty arrays. Without this, a round returning `prior_unaddressed`
   * loses which N priors gated APPROVE — the `summary` text was the only
   * signal distinguishing a 1-prior round from a 12-prior one.
   */
  verdictTrace?: VerdictTrace;
  /** Three-way state of the open-thread fetch (`fetched` / `empty` / `fetch_failed`). Defaults to `fetched` when not recorded. */
  openThreadsState?: OpenThreadsState;
  /** Number of open review threads consumed by the verdict gate. */
  openThreadCount?: number;
  /** Number of thread ids in the resolved-threads set consumed by the verdict gate (`isResolved` previously-recorded threads). */
  resolvedThreadIdCount?: number;
  /** Three-way state of the inter-round diff (`unknown` / `empty` / `changed`). Defaults to `unknown` when not recorded. */
  interRoundDiffState?: InterRoundDiffState;
  /** Byte length of the inter-round diff before truncation. Absent when the diff was `undefined` (compare-API failure or no prior round). */
  interRoundDiffBytes?: number;
  /** True when the inter-round diff exceeded `MAX_INTER_ROUND_DIFF_CHARS` and was truncated before being passed to the judge prompt. */
  interRoundDiffTruncated?: boolean;
  /** Counts from the post-judge thread-resolution loop: `addressed` evaluations dropped, `not_addressed` evaluations synthesised by the empty-diff override, and `uncertain` evaluations emitted. */
  threadResolutionOverrides?: ThreadResolutionOverrides;
}

export type DuplicateMatchType = 'exact' | 'substring' | 'word_overlap' | 'llm';

export interface RoundDedupDuplicateMatch {
  droppedTitle: string;
  matchedTitle: string;
  matchType: DuplicateMatchType;
}

export interface RoundDedup {
  staticDropped?: number;
  llmDropped?: number;
  /**
   * Same-round duplicates merged by the judge stage (distinct from
   * cross-round `staticDropped` / `llmDropped`, which target dismissed
   * priors). Previously rolled into `RoundJudge.mergedDuplicates` via
   * subtraction in `index.ts`; surfaced here so dedup attribution lives
   * in one place. Always equals `RoundJudge.mergedDuplicates`.
   */
  sameRoundLlmDropped?: number;
  /**
   * Per-drop attribution for cross-round dedup. Each entry records the
   * dropped finding title, the prior-round title it matched, and which
   * matcher fired. LLM-stage matches use `matchType: 'llm'`; static
   * matches use the title-overlap branch that hit. Capped at 50 entries
   * to bound the context-block size.
   */
  duplicateMatches?: RoundDedupDuplicateMatch[];
  /**
   * Count of suggestion/nitpick findings dropped by the round-2+
   * test-file suppressor. Returned from `runReview` but previously
   * never written into `RoundContext`.
   */
  testNitSuppressedCount?: number;
  durationMs?: number;
}

export type MemoryLoadStatus = 'loaded' | 'disabled' | 'no_token' | 'failed';

export interface RoundMemory {
  patternsApplied?: number;
  suppressionsApplied?: number;
  escalationsApplied?: number;
  /**
   * Outcome of the memory-load step. `disabled` when `config.memory.enabled`
   * is false, `no_token` when memory is enabled but no token was available,
   * `failed` when the load attempt threw, `loaded` on success. Optional so
   * legacy context blocks parse cleanly; absence is treated as `loaded` when
   * `patternsApplied`/`suppressionsApplied` are present.
   */
  loadStatus?: MemoryLoadStatus;
  /** Truncated error message recorded when `loadStatus === 'failed'`. */
  loadError?: string;
}

/**
 * Author-reply re-classification attribution recorded by `refreshAuthorReplyClass`.
 * The cached `authorReplyClass` on each prior-round fingerprint is `'none'` at
 * emit time. When live thread state shifts it to `agree`/`disagree`/`partial`,
 * this records the flip so noise debugging can attribute prior-unaddressed
 * decisions to the reply state at recap time.
 */
export interface ReclassifiedPrior {
  threadId: string;
  from: string;
  to: string;
}

export interface RoundRecap {
  /**
   * Number of prior-round `RoundContext` payloads actually loaded from the
   * PR review timeline. Distinguishes "no priors" (`0`) from "couldn't load
   * priors" (a fetch failure also yields `0` today, but with this field a
   * future fail-open path can flag the difference).
   */
  priorRoundCount: number;
  /** Count of fingerprints whose `authorReplyClass` flipped during refresh. */
  reclassifiedPriorCount: number;
  /** Capped list of the actual flips (top N). Omitted when none flipped. */
  reclassifiedPriors?: ReclassifiedPrior[];
}

/**
 * Per-round fingerprint table. Carries identity and outcome of each finding,
 * never the body.
 */
export interface RoundFindings {
  count: number;
  severityCounts: Record<string, number>;
  entries: FindingFingerprintEntry[];
  /**
   * True when the emit-side budget enforcer dropped one or more entries from
   * `entries[]` to fit the review-comment body limit. Set by the truncation
   * helper at emit time, never by upstream pipeline stages.
   */
  truncated?: boolean;
}

export interface FindingFingerprintEntry {
  fingerprint: FindingFingerprint;
  threadId?: string;
  severity: FindingSeverity | 'unknown';
  authorReplyClass?: AuthorReplyClass;
  /** Originating specialist name (from `Finding.reviewers[0]`). */
  specialist?: string;
  /** Reviewer's proposed fix at the time the finding was raised. Stored so later rounds can detect code that implements a prior-round proposal (own-proposal caveat rule). */
  suggestedFix?: string;
  /** Human-readable finding title. */
  title?: string;
  /** Judge reasoning for the verdict on this finding. Mirrors `Finding.judgeNotes`. */
  judgeNotes?: string;
  /** Judge confidence in the verdict. Mirrors `Finding.judgeConfidence`. */
  judgeConfidence?: 'high' | 'medium' | 'low';
  /** Reachability classification of the underlying issue. Mirrors `Finding.reachability`. */
  reachability?: FindingReachability;
  /** Free-form explanation of the reachability classification. Mirrors `Finding.reachabilityReasoning`. */
  reachabilityReasoning?: string;
  /** Tags applied by the judge (e.g. `DEFENSIVE_HARDENING_TAG`, `OWN_PROPOSAL_TAG`). Preserves the exact string constants from `Finding.tags`. */
  tags?: string[];
  /** Pre-demotion severity, when the judge demoted the finding. Mirrors `Finding.originalSeverity`. */
  originalSeverity?: FindingSeverity;
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
