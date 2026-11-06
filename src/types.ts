import type { LLMUsage } from './providers/types';

export const MAX_AGENT_RETRIES = 1;

export type FindingSeverity = 'blocker' | 'warning' | 'suggestion' | 'nitpick' | 'ignore';

/** Severities from most to least severe. */
export const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocker', 'warning', 'suggestion', 'nitpick', 'ignore'];

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

/** Whether a finding of this severity blocks the PR, so it is posted as a review thread. */
export function isBlockingSeverity(severity: FindingSeverity): boolean {
  return severity === 'blocker' || severity === 'warning';
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
/** Marks a warning that no longer blocks at this round. It is listed in the review body instead of posted as a thread. */
export const FOLLOW_UP_TAG = 'follow-up' as const;
/** Marks a security defect, which blocks at every round and never becomes a follow-up. */
export const SECURITY_TAG = 'security' as const;

export interface InterRoundDiffEmptyOverride {
  applied: boolean;
  affectedThreadCount: number;
}

/**
 * Three-way state of the GitHub review-thread fetch consumed by
 * `determineOutcome`. `fetched` and `empty` distinguish "threads returned"
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
 * Per-branch breakdown of which findings or priors triggered `determineOutcome`.
 * The verdict reader's blockers go in `survivingBlockers`.
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
  /** Severity the reviewer gave, when the judge graded the finding differently. The judge never sees it. */
  reviewerSeverity?: FindingSeverity;
  /** Fingerprint key of the prior-round blocker that names the same defect. */
  sameAs?: string;
  /** ID of the still open thread where an earlier round raised this blocker. The review points at that thread instead of opening a new one. */
  threadId?: string;
  /** Tool that reported the finding, when it comes from a CI or code-scanning result instead of a reviewer. */
  toolSource?: string;
  /** What the deterministic claim checks and CI results say about the finding. */
  toolEvidence?: ToolEvidence;
}

/** `none` means no tool spoke to the claim. Silence is never evidence against a finding. */
export type ToolEvidenceStatus = 'confirmed' | 'contradicted' | 'none';

export interface ToolEvidence {
  status: ToolEvidenceStatus;
  /** What was checked, and what confirmed or contradicted the claim. Shown to the judge. */
  note: string;
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

/** How a review round ended. Each outcome posts one review event, see `OUTCOME_VERDICT` in `review.ts`. */
export type RoundOutcome = 'READY' | 'ADDRESS_FIRST' | 'INCOMPLETE' | 'NOT_CONVERGING' | 'BUDGET';

/** Blockers a human has to settle, posted with a `NOT_CONVERGING` outcome. */
export interface NeedsHuman {
  /** `repeated`: a blocker came back after a fix push. `budget`: the last automatic round the round cap allows still has one open. */
  cause: 'repeated' | 'budget';
  blockers: VerdictTraceEntry[];
}

export type VerdictReason = 'required_present' | 'novel_suggestion' | 'prior_unaddressed' | 'only_nit_or_suggestion' | 'verdict_reader';

/** The verdict reader's answer on a round where no finding blocked. */
export interface VerdictReport {
  verdict: 'READY' | 'ADDRESS_FIRST';
  /** Each entry reads `file:line: defect`. Empty on `READY`. */
  blockers: string[];
  summary: string;
  whatThisDoes: string;
  whatToTest: TestGuide;
}

/** Manual checks for a pull request: what they need first, then one "Do X. Expect Y." step each. */
export interface TestGuide {
  setup?: string;
  steps: string[];
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  /** Required on what `runReview` returns. `verdict` is derived from it. */
  outcome?: RoundOutcome;
  /** Set when the verdict reader ran and answered. */
  verdictReport?: VerdictReport;
  /** Set on a `NOT_CONVERGING` outcome. */
  needsHuman?: NeedsHuman;
  verdictReason?: VerdictReason;
  summary: string;
  findings: Finding[];
  highlights: string[];
  reviewComplete: boolean;
  rawFindingCount?: number;
  /** Tool results sent to the judge as candidate findings, on top of `rawFindingCount`. */
  toolAlertCount?: number;
  agentNames: string[];
  allJudgedFindings?: Finding[];
  rawFindings?: Finding[];
  threadEvaluations?: ThreadEvaluation[];
  plannerResult?: PlannerResult;
  failedAgents?: string[];
  agentFailureReasons?: Record<string, string>;
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
  /** Verdict reader LLM usage. */
  verdictUsage?: LLMUsage;
  crossRoundSuppressed?: number;
  crossRoundDemoted?: number;
  /** Set when the judge stage forced every open thread to `not_addressed` because the inter-round diff was known-empty. */
  interRoundDiffEmptyOverride?: InterRoundDiffEmptyOverride;
  testNitSuppressedCount?: number;
  staticSignalMatches?: RoundStaticSignalMatch[];
  verdictTrace?: VerdictTrace;
  /** Team-selection provenance: which path produced this round's roster. */
  plannerSource?: RoundPlannerSource;
  /** Short tag describing the planner fallback path, when one fired. */
  plannerFallbackReason?: string;
  /** Stages a safety filter refused that ran again on a fallback model. */
  modelFallbacks?: RoundModelFallback[];
  /** Triage the team was built from, after the pin and the sensitive-path rule. */
  triage?: Triage;
  /** Whether the diff touches a security-sensitive path. */
  sensitivePaths?: boolean;
  /** Whether the diff touches CI, automation or a dependency or toolchain manifest. */
  ciOrDependencyPaths?: boolean;
  /** Set when code overrode the planner's `trivial: true`. */
  trivialOverridden?: boolean;
  /** Model each agent ran on. Keyed by agent name. */
  agentModels?: Map<string, string>;
  /** Name of the second finder, when one ran. */
  pairAgentName?: string;
  /** How the round's review group was picked. */
  routing?: TeamRouting;
  /** Per-agent multi-pass intersection stats. Keyed by agent name. */
  agentMultiPassConsistency?: Map<string, { consistent: number; totalRaw: number }>;
  /** Per-agent effort level actually used at run time. Keyed by agent name. */
  agentEffortMap?: Map<string, EffortLevel>;
}

export interface ReviewerAgent {
  name: string;
  focus: string;
}

export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/** The planner's three triage answers. Each takes the side that adds review when unknown. */
export interface Triage {
  /** No defect could hide in the change, so the trivial verifier reads it alone. */
  trivial: boolean;
  /** Judging the change needs reasoning about behavior, so finders run at high effort. */
  subtle: boolean;
  /** A defect could reach a user if every reader missed it, so a second finder on another model reads it. */
  paired: boolean;
}

/** Who reads the diff in a round. Every non-trivial finder gets the same prompt. */
export interface Finder {
  /** Display name, unique in its round, such as "Claude Sonnet 5.5 · high". Labels its findings, metrics and progress line. */
  name: string;
  prompt: ReviewerAgent;
  /** Position in its review group. The second reader, index 1, is the pair finder. */
  index: number;
  model: string;
  effort: EffortLevel;
}

/** One reader in a review group. `auto` effort is `high` when the triage says `subtle`, else `medium`. */
export interface GroupReviewer {
  /** A model id, `provider/model`, `@reviewer` or `@reviewer_pair`. Unset means `@reviewer`. */
  model?: string;
  /** Unset means `auto`. */
  effort?: EffortLevel | 'auto';
  /** One more line for this finder to check, added to its prompt like a `reviewers` entry. */
  focus?: string;
  role?: 'finder' | 'verifier';
}

export interface ReviewGroup {
  reviewers: GroupReviewer[];
}

/** Conditions a PR must meet to fall in a review class. Every condition set must hold. */
export interface ReviewClassMatch {
  /** Globs or `@` path aliases, one of which some changed file must match. */
  paths_any?: string[];
  /** Answers the triage, after `planner.paired` and the floor and file rules, must give. */
  triage?: Partial<Triage>;
}

export interface ReviewClass {
  /** The matching class with the highest rank decides the group. */
  rank: number;
  /** A floor class always gets at least two readers on two models. */
  floor?: boolean;
  match: ReviewClassMatch;
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

export interface PlannerResult extends Triage {
  judgeEffort: EffortLevel;
  prType: ValidPrType | 'unknown';
  language?: string;
  context?: string;
  /** Answers the planner left out or got wrong, which took the side that adds review. */
  defaultedFields?: string[];
}

export type ReviewLevel = 'auto' | 'small' | 'medium' | 'large';

export type NoiseLevel = 'low' | 'medium' | 'high';

export type PairedPin = 'auto' | 'always' | 'never';

/** The `review` block of `.manki.yml`. Unset keys keep the built-ins. */
export interface ReviewRoutingConfig {
  /** Group for a class with no route, and for every class when `groups` is set without `routing`. */
  default_group?: string;
  /** Adds groups, or replaces a built-in group of the same name. */
  groups?: Record<string, ReviewGroup>;
  /** Adds classes. On a built-in path class, `match.paths_any` adds paths to the built-in rule. */
  classes?: Record<string, { rank?: number; match?: ReviewClassMatch }>;
  /** Group per class, over the built-in routing. */
  routing?: Record<string, string>;
  /** Floor classes that may route to a group below the floor. */
  allow_weaker?: string[];
}

/** How a round's review group was picked. */
export interface TeamRouting {
  /** Review class the PR fell in, or unset when none matched and the default group ran. */
  class?: string;
  rank?: number;
  /** Every class the PR matched, highest rank first. */
  matched: string[];
  /** Whether a path rule or the triage put the PR in its class, or `default` when no class matched. */
  classSource: 'paths' | 'triage' | 'default';
  /** Review group the finders came from. */
  group: string;
  /** Whether the class's route, the default group or the floor picked the group. */
  groupSource: 'routing' | 'default_group' | 'floor_escalation';
  /** Highest ranked floor class the PR matched. */
  floor?: string;
  /** Routed group the floor moved the PR up from. */
  escalatedFrom?: string;
  /** Floor classes `review.allow_weaker` let run below the floor. */
  weakerAllowed?: string[];
}

export interface TeamRoster {
  finders: Finder[];
  routing: TeamRouting;
  /** Triage after `planner.paired` and the floor and file rules. */
  triage: Triage;
  sensitivePaths: boolean;
  /** Whether the diff touches CI, automation or a dependency or toolchain manifest. */
  ciOrDependencyPaths: boolean;
  /** The planner answered `trivial: true`, but a changed file is not one that could be trivial or a floor class matched. */
  trivialOverridden: boolean;
}

export interface ReviewConfig {
  auto_review: boolean;
  auto_approve: boolean;
  exclude_paths: string[];
  max_diff_lines: number;
  reviewers: ReviewerAgent[];
  instructions: string;
  memory: {
    enabled: boolean;
    repo: string;
  };
  models?: {
    planner?: string;
    reviewer?: string;
    /** Model of the second finder. Unset means the other Claude tier of `reviewer`. */
    reviewer_pair?: string;
    judge?: string;
    dedup?: string;
    /** Model a stage moves to when a safety filter refuses it. Unset means `reviewer`. */
    fallback?: string;
  };
  planner?: {
    enabled?: boolean;
    /**
     * @deprecated Use `review.routing`. Pins the planner's `paired` answer. A floor class path,
     * such as a security-sensitive one, still gets a pair.
     */
    paired?: PairedPin;
  };
  /** Review groups and how PR classes route to them. Always read from the base branch, so a PR cannot weaken its own review. */
  review?: ReviewRoutingConfig;
  /** Which CI results reviewers read as evidence. Always read from the base branch, so a PR cannot turn it off. */
  static_analysis?: StaticAnalysisConfig;
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
     * Hard cap on the number of automatic review rounds since Manki last approved the PR at the full bar. The last round
     * blocks on blockers only. After it, automatic review is paused until
     * `@manki review`, which runs one round at the same bar. `0` disables the cap.
     */
    max_auto_rounds?: number;
    /** Glob patterns for test files. Suggestion/nitpick findings on these paths are dropped on round 2+. */
    test_path_patterns?: string[];
    /** When true, a prior-round finding whose thread a human resolved, or Manki resolved as judge-addressed, suppresses matching current findings. */
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
  metrics?: {
    /**
     * Records at merge how many posted findings were fixed, dismissed or left untouched.
     * Defaults to on when `memory.enabled` is true.
     */
    fix_rate?: boolean;
  };
  /**
   * TTL (in seconds) for the in-app concurrent-submission lock. When another
   * Manki run has posted an in-progress marker comment that was
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
  /** CI, code-scanning and analyzer results on lines in the diff, for the PR head commit. */
  staticSignals?: StaticSignal[];
}

/** Analyzers Manki runs itself on the PR's files. */
export const ANALYZERS = ['ast_grep', 'secrets', 'dependencies', 'semgrep'] as const;

export type AnalyzerName = typeof ANALYZERS[number];

export interface AnalyzerSettings {
  ast_grep?: boolean;
  secrets?: boolean;
  dependencies?: boolean;
  /** Paths of Semgrep rule files, read from the base branch. Manki ships no Semgrep rules. */
  semgrep?: false | { rules: string[] };
}

export interface StaticAnalysisConfig {
  checks: boolean;
  code_scanning: boolean;
  dependency_review: boolean;
  /** Check runs to wait for on the PR head before reading the results. */
  wait_for_checks: string[];
  wait_timeout_seconds: number;
  /** `all` turns on every analyzer that needs no rules from the user. */
  analyzers: 'all' | AnalyzerSettings;
}

export type StaticSignalSource = 'checks' | 'code_scanning' | 'dependency_review' | AnalyzerName;

/** A vulnerable package a dependency scanner reports for a manifest or lockfile. */
export interface PackageVulnerability {
  manifest: string;
  name: string;
  version: string;
  id: string;
  severity: StaticSignal['severity'];
  summary?: string;
}

/** One result a CI tool or a Manki analyzer reported on the PR head commit, normalized across sources. */
export interface StaticSignal {
  tool: string;
  ruleId: string;
  severity: 'error' | 'warning' | 'note';
  file: string;
  line: number;
  message: string;
  source: StaticSignalSource;
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
  suppressionCount?: number;
  staticDedupCount?: number;
  llmDedupCount?: number;
  keptCount?: number;
  droppedCount?: number;
  agentProgress?: AgentProgressEntry[];
  plannerInfo?: {
    /** Number of agents that read the diff. */
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
  /** The review class and group the round's readers came from, shown in the review header. */
  routing?: Pick<TeamRouting, 'class' | 'group'>;
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
    /** Triage answers and where they came from, as one readable line. */
    triage: string;
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
  /** Which class the PR fell in and which group reviewed it. Optional so older context blocks keep parsing. */
  routing?: RoundRouting;
  /**
   * Recap-stage attribution: which priors were loaded, how many flipped
   * `authorReplyClass` during refresh, and the flips themselves. Optional
   * so legacy context blocks parse cleanly.
   */
  recap?: RoundRecap;
  staticAnalysis?: RoundStaticAnalysis;
}

/** What the static analysis stage did besides reading results. */
export interface RoundStaticAnalysis {
  /** Each enabled analyzer and how it ended. */
  analyzers?: RoundAnalyzerRun[];
  /** Check runs from `wait_for_checks` that had not finished when the wait timed out. */
  checksStillPending?: string[];
}

export interface RoundAnalyzerRun {
  analyzer: AnalyzerName;
  status: 'ran' | 'skipped';
  /** Results on lines in the diff. */
  results?: number;
  /** Why the analyzer was skipped. */
  reason?: string;
}

export interface RoundRouting extends TeamRouting {
  /** Where the `review` block came from: the base branch, or the built-ins because the base has none, could not be read, or failed validation. */
  configSource: 'base' | 'builtin' | 'base_unreadable' | 'base_invalid';
  /** SHA-256 of the review classes, groups and routes the round chose from, so rounds under different definitions stay apart. */
  configDigest: string;
  reviewers: Array<{ name: string; model: string; provider: string; effort?: EffortLevel }>;
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
  /** How the round ended. Optional so older context blocks keep parsing. */
  outcome?: RoundOutcome;
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

/** Model spec each pipeline stage runs on. */
export interface ReviewModels {
  planner: string;
  reviewer: string;
  reviewerPair: string;
  judge: string;
  dedup: string;
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
  /** Written by releases that sized the team by `review_level`. */
  reviewLevel?: ReviewLevel;
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
  /** Model of the second finder, on rounds where one ran. */
  reviewerPair?: string;
  judge: string;
  dedup?: string;
  /** Stages a safety filter refused that ran again on a fallback model, in the order they ran. */
  fallbacks?: RoundModelFallback[];
}

/** A stage call that a safety filter refused and that ran again on `fallbackModel`. */
export interface RoundModelFallback {
  stage: keyof NonNullable<RoundUsage['perStage']>;
  /** Finder the filter refused, on the `reviewer` stage. */
  agent?: string;
  fallbackModel: string;
  /** The provider's refusal signal, such as `refusal (cyber)` or `content_filter`. */
  reason: string;
}

/**
 * Provenance of the triage that produced this round's team.
 *
 * - `planner`: the planner LLM answered. Any answer it left out took the side that adds review.
 * - `heuristic_fallback`: the planner was attempted but failed (timeout,
 *   truncation, parse error), so every answer took the side that adds review.
 * - `heuristic`: written by releases that skipped the planner for a pinned `review_level`.
 * - `disabled`: `planner.enabled` is false, so every answer took the side that adds review.
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
  /** Triage the team was built from, after `planner.paired` and the sensitive-path rule. */
  trivial?: boolean;
  subtle?: boolean;
  paired?: boolean;
  /** Whether the diff touches a security-sensitive path, which forces `trivial: false` and `paired: true`. */
  sensitivePaths?: boolean;
  /** Whether the diff touches CI, automation or a dependency or toolchain manifest, which also forces `trivial: false` and `paired: true`. */
  ciOrDependencyPaths?: boolean;
  /** Set when the planner answered `trivial: true` and code overrode it, because a changed file is not docs, tests, snapshots or generated, or one of the paths above forced it. */
  trivialOverridden?: boolean;
  /** Planner answers that were missing or invalid and took the side that adds review. */
  defaultedFields?: string[];
  /** Number of agents that read the diff. */
  teamSize?: number;
  /** Effort the agents ran at. */
  reviewerEffort?: EffortLevel;
  judgeEffort?: EffortLevel;
  prType?: string;
  durationMs?: number;
  /** Sanitized programming-language hint, when the planner identified one. */
  language?: string;
  /** Sanitized free-text PR context hint, when the planner identified one. */
  context?: string;
}

export interface RoundReviewers {
  /** Reviewer agent names that participated in this round. */
  agents: string[];
  agentMetrics?: RoundAgentMetric[];
  /** Kept findings raised only by agents on `models.reviewer`. */
  keptPrimaryOnly?: number;
  /** Kept findings raised only by the second finder. */
  keptPairOnly?: number;
  /** Kept findings raised by the second finder and an agent on `models.reviewer`. */
  keptBoth?: number;
  /** Kept findings raised by one finder alone, keyed by finder name. Finders with none are left out. */
  keptOnlyBy?: Record<string, number>;
  /** Kept findings raised by two or more finders. */
  keptByMany?: number;
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
  /** Number of CLI/SDK retries this agent triggered. Zero on the success-on-first-try path. */
  retryCount?: number;
  /** Last-failure reason recorded by the reviewer loop. Present only when retries exhausted. */
  failureReason?: string;
  /**
   * Model the agent ran on: `RoundModels.reviewer`, or `RoundModels.reviewerPair`
   * for the second finder. Present whenever the agent ran.
   */
  model?: string;
  /** Effort level the agent ran with. */
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
  /** Narrative summary written by the judge. */
  summary: string;
  confidenceDistribution?: { high: number; medium: number; low: number };
  severityChanges?: number;
  /** Findings the judge graded above (`up`) or below (`down`) the reviewer's severity. */
  regrades?: { up: number; down: number };
  mergedDuplicates?: number;
  /** Tool results the judge triaged as candidate findings. */
  toolAlertCount?: number;
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
   * threads. `status: 'addressed'` retires warning priors via `determineOutcome`
   * and ratchets suggestion/nitpick priors via `applyCrossRoundSuppression`;
   * blockers require GitHub thread resolution or explicit `authorReply: 'agree'`.
   */
  threadEvaluations?: ThreadEvaluation[];
  /**
   * Identity of every finding or prior that triggered the verdict gate
   * (`determineOutcome`). Only the branch that fired is non-empty; the others
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

export interface RoundStaticSignalMatch {
  droppedTitle: string;
  file: string;
  line: number;
  tool: string;
  ruleId: string;
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
  /** Suggestions and nitpicks dropped because a CI tool already reports a result on the same file and line. Capped at 50 entries. */
  staticSignalMatches?: RoundStaticSignalMatch[];
  durationMs?: number;
}

export type MemoryLoadStatus = 'loaded' | 'disabled' | 'no_token' | 'failed';

export interface RoundMemory {
  suppressionsApplied?: number;
  /**
   * Outcome of the memory-load step. `disabled` when `config.memory.enabled`
   * is false, `no_token` when memory is enabled but no token was available,
   * `failed` when the load attempt threw, `loaded` on success. Optional so
   * legacy context blocks parse cleanly; absence is treated as `loaded` when
   * `suppressionsApplied` is present.
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
  /** Security threads the PR author cleared as a repo admin. Omitted when none. */
  securityOverrides?: SecurityOverride[];
}

/** A security finding the PR author cleared on their own PR as a repo admin. */
export interface SecurityOverride {
  /** Review thread ID. */
  thread: string;
  login: string;
  /** `resolve`: resolved in the GitHub UI. `dismiss`: through `@manki dismiss` in the thread. */
  via: 'resolve' | 'dismiss';
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
  /** Every reviewer agent that raised the finding (`Finding.reviewers`). */
  reviewers?: string[];
  /** First reviewer of the finding. Written by releases before `reviewers`, read only as a fallback. */
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
  /** Reviewer severity, when the judge graded the finding differently. Mirrors `Finding.reviewerSeverity`. */
  reviewerSeverity?: FindingSeverity;
  /** Whether a tool confirmed or contradicted the finding, or was silent. Mirrors `Finding.toolEvidence.status`. */
  toolEvidence?: ToolEvidenceStatus;
  /** Tool that reported the finding. Mirrors `Finding.toolSource`. */
  toolSource?: string;
}

export interface RoundUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  perStage?: Partial<Record<'planner' | 'reviewer' | 'judge' | 'dedup' | 'verdict', RoundUsageStage>>;
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
