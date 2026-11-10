import type { LimitUsage, LLMCall, UsageSummary } from './providers/types';

export const MAX_AGENT_RETRIES = 1;

export type FindingSeverity = 'blocker' | 'warning' | 'suggestion' | 'nitpick' | 'ignore';

/** Severities from most to least severe. */
export const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocker', 'warning', 'suggestion', 'nitpick', 'ignore'];

/** The kind of problem a finding names, as the judge classifies it, with the label a reader sees. */
export const FINDING_CATEGORIES = {
  correctness: 'Correctness',
  security: 'Security',
  reliability: 'Reliability',
  data: 'Data integrity',
  concurrency: 'Concurrency',
  performance: 'Performance',
  compatibility: 'Compatibility',
  testing: 'Testing',
  maintainability: 'Maintainability',
  documentation: 'Documentation',
  style: 'Style',
} as const;
export type FindingCategory = keyof typeof FINDING_CATEGORIES;

/** How big the fix for a finding is, as the judge estimates it, with the label a reader sees. */
export const FINDING_EFFORTS = {
  quick: 'Quick fix',
  moderate: 'Moderate',
  larger: 'Larger change',
} as const;
export type FindingEffort = keyof typeof FINDING_EFFORTS;

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

/** Whether a finding of this severity is posted as a review thread, unless it is a follow-up. */
export function isBlockingSeverity(severity: FindingSeverity): boolean {
  return severity === 'blocker' || severity === 'warning';
}


/** Regex source matching all current and legacy severity tokens. */
export const SEVERITY_TOKEN_PATTERN = 'blocker|warning|suggestion|nitpick|ignore|required|nit';

export const RATCHET_SUPPRESSED_TAG = 'suppressed-by-ratchet' as const;
export const CONTRADICTION_TAG = 'contradicts-prior-round' as const;
export const RESOLVED_THREAD_SUPPRESSED_TAG = 'suppressed-by-resolved-thread' as const;

export const OWN_PROPOSAL_TAG = 'own-proposal-followup' as const;
export const IN_PR_SUPPRESSED_TAG = 'suppressed-in-pr' as const;
/** Marks a warning that no longer blocks at this round. It is listed in the review body instead of posted as a thread. */
export const FOLLOW_UP_TAG = 'follow-up' as const;
/** Names the verdict reader as the reviewer of the blockers it reports. */
export const VERDICT_READER_NAME = 'Verdict reader';
/** Marks a security defect, which blocks at every round and never becomes a follow-up. */
export const SECURITY_TAG = 'security' as const;
/** Marks a finding on lines outside every hunk of the PR's diff. Unless it is a security finding, it never blocks. */
export const PRE_EXISTING_TAG = 'pre-existing' as const;
/** Marks a blocker posted as a warning because nothing cited the lines that prove it. */
export const UNPROVEN_TAG = 'unproven-blocker' as const;
/** Marks a blocker posted as a warning because it claims a build, type or test failure that no CI result on the commit reports. */
export const UNBUILT_TAG = 'unconfirmed-build-claim' as const;

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
 * `unresolvedPriors` lists the earlier blockers still open even when a surviving blocker decided the outcome.
 * Recorded on `RoundJudge.verdictTrace` so replay tooling can answer "which N
 * priors gated APPROVE on round 15?" without re-deriving from `findings.entries`.
 */
export interface VerdictTrace {
  survivingBlockers: VerdictTraceEntry[];
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
  howToFix?: string;
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
  /** The change that fixes the finding, in words. `suggestedFix` holds only code that replaces the flagged line. */
  howToFix?: string;
  reviewers: string[];
  codeContext?: string;
  judgeNotes?: string;
  judgeConfidence?: 'high' | 'medium' | 'low';
  tags?: string[];
  originalSeverity?: FindingSeverity;
  /** Severity the reviewer gave, when the judge graded the finding differently. The judge never sees it. */
  reviewerSeverity?: FindingSeverity;
  /** Each change of the finding's severity after the reviewer graded it, in order, with what changed it. */
  gradePath?: GradeStep[];
  /** Fingerprint key of the earlier finding that names the same defect. */
  sameAs?: string;
  /** Fingerprint key of the earlier finding this one is another instance of: the same mistake in another place. */
  variantOf?: string;
  /**
   * ID of the still open thread where an earlier round raised this finding. The review opens no new thread for it. A
   * variant goes there as a reply, and a blocker is listed under a link to that thread.
   */
  threadId?: string;
  /** Round that listed this finding in its review body first, when the finding restates it. */
  raisedIn?: number;
  /** Tool that reported the finding, when it comes from a CI or code-scanning result instead of a reviewer. */
  toolSource?: string;
  /** What the deterministic claim checks and CI results say about the finding. */
  toolEvidence?: ToolEvidence;
  /** Whether the judge or the verdict reader says the finding claims the code fails to compile, type-check or pass its tests. */
  buildClaim?: boolean;
  /** Earlier finding this one resembles, whose fix the judge of an earlier round confirmed. */
  resemblesFixed?: { title: string; file: string; line: number };
  /** The Manki thread that already answered the developer about this problem, and that answer. The judge keeps the finding only when the code there got worse. */
  answeredIn?: { threadId: string; answer: string };
  /** Whether the finding sits on code the PR changed since the last reviewed round or on code an earlier round reviewed, or restates a finding an earlier round listed. */
  origin?: FindingOrigin;
  /** The kind of problem, set by the judge. */
  category?: FindingCategory;
  /** How big the fix is, set by the judge. */
  effort?: FindingEffort;
  /** What the reviewer, and for proving lines also the judge, cited to back the finding. */
  evidence?: FindingEvidence;
  /** The reviewer ran out of tool steps before it finished checking the finding. */
  notChecked?: boolean;
  /** Set on a suspicion the reviewer was still checking when it wrapped up, instead of a finished finding. */
  lead?: OpenLead;
  /** The round an open lead first came up in, when an earlier round left it unsettled. */
  leadSince?: number;
  /**
   * The grade the judge would give if every premise it doubts holds. Set when that is above the grade it gave, or when
   * the judge names a doubt in `doubts`. The refuter checks the finding, and a confirmation of every doubt gives it this grade.
   */
  gradeIfConfirmed?: FindingSeverity;
  /** The premises the judge doubts, which the refuter checks one by one. */
  doubts?: Doubt[];
  /** How the judge's attempt to refute the finding with tools came out. Set on blockers, open leads, findings lowered for want of proof and findings checked for a doubt the judge named. */
  refutation?: Refutation;
  /** How the second refuter, on `models.refuter_pair`, came out. Set beside `refutation` when that model checked the finding. */
  pairRefutation?: Refutation;
  /** The id of the memory suppression that hid the finding. */
  suppressedBy?: string;
  /** Why the defect exists without this PR's change, when the reviewer says so. The judge must keep it, or it is cleared. */
  preExisting?: string;
  /** How a claim in `preExisting` was checked against the diff: held, or the condition that failed. */
  preExistingCheck?: PreExistingCheck;
}

/**
 * How a pre-existing claim the reviewer made and the judge kept was checked: `pre_existing` when it held, or the
 * condition that failed: no location, a file `exclude_paths` left out, a file the PR deletes, or a line or proof
 * inside the diff.
 */
export type PreExistingCheck = 'pre_existing' | 'no_location' | 'excluded_file' | 'deleted_file' | 'touches_diff';

/** How a round split a diff too large to read at once. */
/** A fetched reference repo: its `owner/name` and the directory holding its checkout. */
export interface ReferenceCheckout {
  repo: string;
  dir: string;
}

/** How an open PR or issue relates to the PR under review. Only a PR is a `duplicate`, and only an issue is `fixes_issue`. */
export type RelatedRelation = 'duplicate' | 'overlapping' | 'fixes_issue' | 'unrelated';

/** An open PR or issue of the repository that may relate to the PR under review, with the dedup model's classification. */
export interface RelatedItem {
  kind: 'pr' | 'issue';
  number: number;
  /** Untrusted text from the PR or issue. */
  title: string;
  /** The start of its body, untrusted text. */
  excerpt: string;
  /** For a PR, the files it changes, the shared ones first. */
  files?: string[];
  /** For a PR, how many of its files the PR under review changes too. */
  sharedFiles?: number;
  draft?: boolean;
  /** Unset until the dedup model classified it, and when the classification failed. */
  relation?: RelatedRelation;
  /** The dedup model's one line of reasoning. */
  reason?: string;
}

/** The open PRs and issues a round looked at, and why any source was left out, such as a rate-limited search. */
export interface RelatedWork {
  items: RelatedItem[];
  skipped?: string[];
}

/** What the round record keeps of `RelatedWork`, without the untrusted text of the PRs and issues. */
export interface RoundRelatedWork {
  candidates: Array<Pick<RelatedItem, 'kind' | 'number' | 'sharedFiles' | 'relation' | 'reason'>>;
  skipped?: string[];
}

/** How one configured related repo fared in a round, and how often the round's finders read it. */
export interface RoundRelatedRepo {
  repo: string;
  ref?: string;
  /**
   * `fetched`, `failed` with the `reason`, `unused` when no tool call named it, or `skipped` with the `reason` when the
   * round gave no finder the repo.
   */
  status: 'fetched' | 'failed' | 'unused' | 'skipped';
  reason?: string;
  /** How long the fetch took, when it ended. */
  durationMs?: number;
  /** Tool calls that read the repo, over every call of the round. */
  reads?: number;
}

/** What the "Uses Outside the Diff" section showed the finders, as locations without the quoted code. */
export interface RoundUses {
  /** Each symbol listed with its uses. */
  symbols?: RoundUsesSymbol[];
  /** Each type listed with all its fields, as `file:line: struct Name { fields }`. */
  types?: string[];
  /** Symbols named but not listed, since they have too many uses. */
  common?: string[];
  /** Symbols the cap on listed lines left out. */
  capped?: string[];
  /** Each name found in the reference repos, with the lines shown. */
  reference?: RoundReferenceUse[];
  /** Names searched for that no reference line holds. */
  referenceMissing?: string[];
  /** Names found in the reference repos that the cap on reference lines left out. */
  referenceCapped?: string[];
}

export interface RoundReferenceUse {
  name: string;
  /** Each line shown, as `owner/name:path:line`. */
  lines: string[];
  /** Lines found but not shown. */
  notShown?: number;
}

export interface RoundUsesSymbol {
  name: string;
  /** Where the symbol is declared, as `file:line`. */
  declared: string;
  /** Each use shown, as `file:line`. */
  uses: string[];
  /** Uses found but not shown. */
  notShown?: number;
}

/** A targeted call comparing changed code with the code beside it, asked alongside the finders. */
export interface RoundComparison {
  /** `field` asks whether a sibling field can hold the item a change looks up, `implementations` compares sibling functions. */
  kind: 'field' | 'implementations';
  /** The reviewer name its findings carry. */
  reviewer: string;
  /** The changed lookup, or each function compared, as `file:line`. */
  at: string[];
  /**
   * `failed` when the call failed or its reply did not parse twice, `cut` when the round's cap left it out, and
   * `timed_out` when it was still unanswered once the grace after the finders ran out.
   */
  status: 'answered' | 'failed' | 'cut' | 'timed_out';
  findings?: number;
}

export interface RoundSlicing {
  /** The changed files in each slice. A file split across slices counts in each. */
  files: number[];
  /** The verdict reader's answer on each slice, when it ran. */
  reader?: Array<{ verdict: VerdictReport['verdict']; blockers: number }>;
}

/** What changed a finding's severity. */
export type GradeChange =
  | 'judge' | 'unproven' | 'build_claim' | 'refutation' | 'in_pr_suppression' | 'own_proposal' | 'contradiction' | 'ratchet'
  | 'resolved_thread' | 'pre_existing';

/** One change of a finding's severity. */
export interface GradeStep {
  from: FindingSeverity;
  to: FindingSeverity;
  by: GradeChange;
  /** Why, in one short line, when the stage that changed it said. */
  reason?: string;
}

const MAX_GRADE_REASON_CHARS = 200;

/**
 * Returns the fields that move `finding` to severity `to`, with the step appended to its `gradePath`. Spread them into
 * a copy of the finding, or assign them to it. A step that keeps the severity adds no step.
 */
export function gradeStep(finding: Finding, to: FindingSeverity, by: GradeChange, reason?: string): Pick<Finding, 'severity' | 'gradePath'> {
  if (finding.severity === to) return { severity: to };
  const step: GradeStep = { from: finding.severity, to, by, ...(reason && { reason: reason.slice(0, MAX_GRADE_REASON_CHARS) }) };
  return { severity: to, gradePath: [...(finding.gradePath ?? []), step] };
}

export type RefutationOutcome = 'disproved' | 'confirmed' | 'unsettled';

/**
 * A premise the judge doubts, stated as a fact the code can confirm or disprove. It `decides` either whether the defect
 * exists at all, so a disproof drops the finding, or only whether the finding earns its `gradeIfConfirmed`.
 */
export interface Doubt {
  premise: string;
  decides: 'defect' | 'grade';
}

/** How a refuter answered one premise the judge doubts. */
export interface PremiseCheck {
  premise: string;
  outcome: RefutationOutcome;
  reason: string;
  proof?: string[];
}

/** The outcome of the judge's attempt to refute a finding with tools. */
export interface Refutation {
  outcome: RefutationOutcome;
  /** What decided it, in one or two sentences. */
  reason: string;
  /** The general rule of the language, a library or a protocol that the finding relies on, as the refuter named it. */
  rule?: string;
  /** The `file:line` locations the judge cites: the failure for `confirmed`, the reason it cannot happen for `disproved`. */
  proof?: string[];
  /** The answer to each premise in the finding's `doubts`, in order. The outcome follows from them. */
  premises?: PremiseCheck[];
  /** The finding's own file and the files the outcome cites. */
  files: string[];
  /** SHA-256 over `files` at the commit checked. A later round reuses the outcome while it still matches. */
  codeDigest: string;
}

/** `earlier` restates a finding an earlier round listed in its review body, whatever code it sits on. */
export type FindingOrigin = 'new' | 'reviewed' | 'earlier';

/** What was cited to back a finding. */
export interface FindingEvidence {
  /** What the reviewer read or searched and what it showed, one short line each. */
  checks: string[];
  /** The `file:line` or `file:start-end` locations that show the failure. A blocker without them is posted as a warning at most. */
  proof: string[];
  /**
   * Set when the finding says something is missing or handled nowhere: the search that came back empty, or an empty
   * string when the reviewer cited none. Such a claim never blocks on its own.
   */
  emptySearch?: string;
}

/** Whether `evidence` cites anything: a check, a proving line or an empty search. */
export function citesEvidence(evidence: FindingEvidence | undefined): boolean {
  return !!evidence && (evidence.checks.length > 0 || evidence.proof.length > 0 || !!evidence.emptySearch);
}

/** What a reviewer had checked of a suspicion when it wrapped up, and what was left. */
export interface OpenLead {
  checked: string;
  left: string;
}

/**
 * How an open lead ended in a round: `confirmed` and posted, `disproved` by the judge's tools, `dropped` by the judge,
 * `unsettled` by the tools, or `not_checked` because it went to no check and was only listed.
 */
export type LeadOutcome = 'confirmed' | 'disproved' | 'dropped' | 'unsettled' | 'not_checked';

/** An open lead as a round recorded it, so the next round can carry it over while it stays unsettled. */
export interface RoundLead {
  title: string;
  file: string;
  line: number;
  severity: FindingSeverity;
  reviewers: string[];
  description: string;
  lead: OpenLead;
  outcome: LeadOutcome;
  /** The round the lead first came up in. */
  since: number;
  /** Set when the lead was posted as a finding, so the next round does not carry it over. */
  posted?: true;
  /** Mirror `Finding.refutation` and `Finding.pairRefutation` of the judged lead. */
  refutation?: Refutation;
  pairRefutation?: Refutation;
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
export type RoundOutcome = 'READY' | 'ADDRESS_FIRST' | 'INCOMPLETE' | 'NOT_CONVERGING';

/** Blockers a human has to settle, posted with a `NOT_CONVERGING` outcome. */
export interface NeedsHuman {
  /** `repeated`: a blocker came back after a fix push. `budget`: the last automatic round the round cap allows still has one open. */
  cause: 'repeated' | 'budget';
  blockers: VerdictTraceEntry[];
}

export type VerdictReason = 'required_present' | 'prior_unaddressed' | 'warnings_present' | 'only_nit_or_suggestion' | 'verdict_reader';

/** The verdict reader's answer on a round where no finding blocked. */
export interface VerdictReport {
  verdict: 'READY' | 'ADDRESS_FIRST';
  /** The blockers as findings, with the evidence the reader cited. Empty on `READY`. */
  blockers: Finding[];
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
  /** Findings sent on toward the judge: the finders', and the earlier leads carried over, without the open leads only listed. */
  rawFindingCount?: number;
  /** Tool results sent to the judge as candidate findings, on top of `rawFindingCount`. */
  toolAlertCount?: number;
  agentNames: string[];
  allJudgedFindings?: Finding[];
  rawFindings?: Finding[];
  /** Open leads below blocker, which are listed in the progress comment and never posted. */
  openLeads?: Finding[];
  /** How each open lead of the round ended, carried-over ones included. */
  leads?: RoundLead[];
  threadEvaluations?: ThreadEvaluation[];
  plannerResult?: PlannerResult;
  failedAgents?: string[];
  agentFailureReasons?: Record<string, string>;
  staticDedupCount?: number;
  llmDedupCount?: number;
  /** Per-drop cross-round dedup attribution: both `deduplicateFindings` (static) and `llmDeduplicateFindings` (llm) entries, in the order they were dropped. */
  duplicateMatches?: RoundDedupDuplicateMatch[];
  suppressionCount?: number;
  /** The findings memory suppressions hid, each with `suppressedBy`. */
  memorySuppressed?: Finding[];
  /** The learnings and suppressions loaded from memory for the round. */
  memoryLoaded?: { learnings: number; suppressions: number };
  /** Pre-existing findings not worth posting, such as suggestions. Only the round record keeps them. */
  unpostedPreExisting?: Finding[];
  /** How the diff was split, when it was read in several slices. */
  slicing?: RoundSlicing;
  /** The configured related repos, with the outcome of each fetch. */
  relatedRepos?: RoundRelatedRepo[];
  /** What the finders were shown as uses outside the diff. */
  usesOutsideDiff?: RoundUses;
  /** The open PRs and issues that may relate to this PR, classified. Unset when the round looked at none. */
  relatedWork?: RelatedWork;
  /** Each sibling comparison the round found, asked or cut. */
  comparisons?: RoundComparison[];
  /** The changed files the push since the last round touched, when an earlier round exists and its diff is known. */
  changedSinceLastRoundCount?: number;
  /** The open or earlier threads where someone claimed a fix: resolved, answered by a person, or confirmed by a round. */
  fixClaimedThreadIds?: string[];
  inPrSuppressedCount?: number;
  agentResponseLengths?: Map<string, number>;
  /** Aggregated wall-clock duration per agent across all passes/retries. */
  agentDurationMs?: Map<string, number>;
  /** Number of CLI/SDK retries per agent. Zero (omitted) when the first try succeeded. */
  agentRetryCount?: Map<string, number>;
  plannerDurationMs?: number;
  judgeDurationMs?: number;
  judgeRetryCount?: number;
  dedupDurationMs?: number;
  /** Every LLM call of the round, in the order each finished. */
  llmCalls?: LLMCall[];
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

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
  model: string;
  effort: EffortLevel;
  /** How many tool calls the finder may make when its client has repository tools. */
  steps: number;
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
  /** Globs or path aliases where any wrong result is severe damage, even in a rare internal edge case, for the judge. */
  critical_paths?: string[];
  /** What counts as outside input in this repository, for the judge. */
  outside_input?: string;
  /** Worked examples of this repository's findings that are and are not blockers, for the judge. */
  examples?: { blocker?: string[]; not_blocker?: string[] };
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
  /** Whether the class's route, the default group, the floor or a deeper review picked the group. */
  groupSource: 'routing' | 'default_group' | 'floor_escalation' | 'deeper_review';
  /** Highest ranked floor class the PR matched. */
  floor?: string;
  /** Routed group the floor, or a deeper review, moved the PR up from. */
  escalatedFrom?: string;
  /** Floor classes `review.allow_weaker` let run below the floor. */
  weakerAllowed?: string[];
  /** A Deeper review ran: two finders on every group, each one effort level higher. */
  deeper?: true;
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
  /** Labels that skip review, compared case-insensitively. Read from the base branch only. */
  skip_labels?: string[];
  /** PR authors whose PRs are skipped, compared case-insensitively, such as `dependabot[bot]`. Read from the base branch only. */
  skip_authors?: string[];
  /** Glob patterns for head branches in the repo itself that skip review, such as `dependabot/**`. Read from the base branch only. */
  skip_branches?: string[];
  /** Reviewable lines above which Manki never reviews a PR, even when forced. */
  max_diff_lines: number;
  /** Reviewable lines above which a PR gets no automatic review, only a forced one. */
  auto_review_max_lines?: number;
  /** Changed lines a finder reads in one call. A larger diff is split into slices read in parallel. */
  slice_lines?: number;
  reviewers: ReviewerAgent[];
  instructions: string;
  /** A short phrase naming what the project is, such as `blockchain consensus library`. */
  project?: string;
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
    /** Model of a second refuter that checks each blocker beside the judge's. Unset means no second refuter. */
    refuter_pair?: string;
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
  judge?: {
    /** Read-only repository tool calls the judge may make while it grades. 0 gives it none. */
    tool_steps?: number;
  };
  /** Review groups and how PR classes route to them. Always read from the base branch, so a PR cannot weaken its own review. */
  review?: ReviewRoutingConfig;
  /** Which CI results reviewers read as evidence. Always read from the base branch, so a PR cannot turn it off. */
  static_analysis?: StaticAnalysisConfig;
  /** Public repos the review may read as context. Always read from the base branch, so a PR cannot make Manki fetch another repo. */
  related_repos?: RelatedRepo[];
  /**
   * @deprecated Removed in v5.1.0. All surviving findings post inline as PR
   * review comments. The field is still parsed so old configs don't fail,
   * but the value is ignored and a one-line warning is emitted at run start.
   */
  nit_handling?: 'issues' | 'comments';
  noise_level?: NoiseLevel;
  /** `skip` reviews a draft PR only on request, `review` reviews it automatically. A draft review never approves. */
  drafts?: 'skip' | 'review';
  review_passes?: number;
  convergence?: {
    /**
     * Hard cap on the number of automatic review rounds since Manki last approved the PR. After the last round,
     * automatic review is paused until `@manki review`. `0` disables the cap.
     */
    max_auto_rounds?: number;
    /**
     * Automatic rounds a review started by hand turns back on while automatic review is paused, when the cap allows fewer.
     * `0` grants none, so after a round-cap pause a review started by hand reviews only its own round.
     */
    rounds_after_restart?: number;
    /** Glob patterns for test files. Suggestion/nitpick findings on these paths are dropped on round 2+. */
    test_path_patterns?: string[];
    /** When true, a prior-round finding whose thread a human resolved, or Manki resolved as judge-addressed, suppresses matching current findings. */
    suppress_resolved_threads?: boolean;
  };
  metrics?: {
    /**
     * Records at merge how many posted findings were fixed, dismissed or left untouched.
     * Defaults to on when `memory.enabled` is true.
     */
    fix_rate?: boolean;
  };
}

export interface DiffFile {
  path: string;
  oldPath?: string;
  changeType: 'added' | 'modified' | 'deleted' | 'renamed';
  hunks: DiffHunk[];
  additions?: number;
  deletions?: number;
  /**
   * The old and new mode, such as `100644 100755`, when the PR changes the mode of a file it also edits, or the mode
   * of an added file that is no plain file, such as `100755`.
   */
  modeChange?: string;
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
  /**
   * Files with no code a model can read, dropped during `parsePRDiff`: binaries, mode changes, empty files, Git LFS
   * pointers and submodule bumps.
   */
  binarySkipped?: BinaryFile[];
}

export interface BinaryFile {
  path: string;
  /** The paths, abbreviated blob ids and modes from the file's diff header, which change with its content. */
  header: string;
  /** Set when the file's lines are only a Git LFS pointer or a submodule commit. */
  kind?: 'lfs' | 'submodule';
  /** Set when the PR deletes the file, which leaves nothing unread. */
  deleted?: true;
}

export interface PrContext {
  title: string;
  body: string;
  baseBranch: string;
  /** CI, code-scanning and analyzer results on lines in the diff, for the PR head commit. */
  staticSignals?: StaticSignal[];
}

/** Analyzers Manki runs itself on the PR's files. */
export const ANALYZERS = ['ast_grep', 'secrets', 'dependencies', 'semgrep', 'actionlint', 'zizmor', 'shellcheck'] as const;

export type AnalyzerName = typeof ANALYZERS[number];

export interface AnalyzerSettings {
  ast_grep?: boolean;
  secrets?: boolean;
  dependencies?: boolean;
  /** Paths of Semgrep rule files, read from the base branch. Manki ships no Semgrep rules. */
  semgrep?: false | { rules: string[] };
  actionlint?: boolean;
  zizmor?: boolean;
  shellcheck?: boolean;
}

/** `reference`: a repo this one implements or ports, such as a protocol. `consumer`: a repo that depends on this one. */
export type RelatedRepoKind = 'reference' | 'consumer';

export interface RelatedRepo {
  /** `owner/name` of a public repo on github.com. */
  repo: string;
  kind: RelatedRepoKind;
  /** Branch, tag or full commit hash to read. Defaults to the repo's default branch. */
  ref?: string;
  /** Paths or globs to fetch, relative to the repo root. Defaults to the whole repo. */
  paths?: string[];
}

/** The related repos one review round offers its reviewer tools, each fetched on first use. */
export interface RelatedRepoTools {
  repos: RelatedRepo[];
  /** Directory the repos are cloned into, one `owner/name` directory each. A workflow can keep it between runs with `actions/cache`. */
  cacheDir: string;
  /** The round's own directory, where the tool servers record which repo one of them fetched or failed to fetch. */
  stateDir: string;
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

export type StaticSignalSource = 'checks' | 'code_scanning' | 'dependency_review' | 'hidden_characters' | 'lockfile' | AnalyzerName;

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
  /** The grade an earlier round's partly-fixed reply gave what remains. The thread blocks only when it is `blocker`. */
  partlyFixedGrade?: FindingSeverity;
  isSecurity?: boolean;
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
 * not-addressed (insufficient evidence). A `partly_addressed` thread stays open.
 */
export interface ThreadEvaluation {
  threadId: string;
  status: 'addressed' | 'partly_addressed' | 'not_addressed' | 'uncertain';
  reason: string;
  /** For `partly_addressed`, what still goes wrong. */
  remaining?: string;
  /**
   * The grade the thread keeps after this round when a partial fix sets or changes it: on `partly_addressed` the grade
   * the remaining damage earns, and on a thread an earlier partial fix lowered, its own grade once it is open again.
   */
  grade?: FindingSeverity;
}

/**
 * Whether an open thread blocks: by the grade Manki's latest partly-fixed reply gave what remains, or else by its own
 * severity. A partial fix never lowers a security thread. A thread without a severity marker predates them and blocks.
 */
export function threadBlocks(t: { severity: FindingSeverity | 'unknown'; partlyFixedGrade?: FindingSeverity; isSecurity?: boolean }): boolean {
  return t.partlyFixedGrade && !t.isSecurity ? t.partlyFixedGrade === 'blocker' : t.severity === 'blocker' || t.severity === 'unknown';
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
  /** Wall-clock time of the whole run, shown in the headline once it finished. */
  totalDurationMs?: number;
  /** True when team selection fell back to the heuristic because the planner failed or timed out. Surfaces a one-line marker in the rendered summary so the broader team set is self-explanatory. */
  heuristicFallback?: boolean;
  /** The review class and group the round's readers came from, shown in the review header. */
  routing?: Pick<TeamRouting, 'class' | 'group'>;
  /** Open leads below blocker that the reviewers did not finish checking. They are listed, never posted. */
  unfinishedChecks?: Pick<Finding, 'title' | 'file' | 'line' | 'leadSince'>[];
  /** Blockers and open leads the judge disproved with tools, with the reason. They are dropped. */
  disproved?: (Pick<Finding, 'title' | 'file' | 'line'> & { reason: string })[];
}

export interface JudgeDecision {
  title: string;
  severity: FindingSeverity;
  originalSeverity?: FindingSeverity;
  reasoning: string;
  confidence: 'high' | 'medium' | 'low';
  kept: boolean;
  /** Set on an open lead the judge's tools left unsettled, which is listed as not finished instead of posted. */
  listed?: true;
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
  /** The newest usage reading of each subscription window the round's calls used. */
  limits?: LimitUsage[];
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
  /** The token service calls the run made before it posted the review. */
  tokenService?: TokenServiceCall[];
  /** How the diff was split, when it was read in several slices. */
  slicing?: RoundSlicing;
  /** The configured related repos, with the outcome of each fetch. */
  relatedRepos?: RoundRelatedRepo[];
  /** What the finders were shown as uses outside the diff. */
  usesOutsideDiff?: RoundUses;
  /** The open PRs and issues that may relate to this PR, with their classification. */
  relatedWork?: RoundRelatedWork;
  /** Each sibling comparison the round found, asked or cut. */
  comparisons?: RoundComparison[];
  /** How each open lead ended, so the next round carries over the ones still unsettled. */
  leads?: RoundLead[];
  /**
   * Set on a round that approved: whether the approval was held, and why: a conflict with the base, a draft, a config
   * that failed to load, or files the review could not read.
   */
  approval?: { held: false | 'conflict' | 'draft' | 'config' | 'unread' };
  /**
   * Lengths of what the round composed, in characters. The record goes out with the review, so a comment
   * GitHub refuses afterwards, or a body rewritten to carry it, is not reflected.
   */
  output?: RoundOutput;
}

export interface RoundOutput {
  /** The review body without the round record and the reviewed-commit footer. */
  bodyLength: number;
  /** Each inline and file-level comment, in posting order. */
  commentLengths: number[];
}

/** What the static analysis stage did besides reading results. */
export interface RoundStaticAnalysis {
  /** Each enabled analyzer and how it ended. */
  analyzers?: RoundAnalyzerRun[];
  /** Each other enabled source, the checks, code scanning and dependency review, and how it ended. */
  sources?: RoundSignalSourceRun[];
  /** Hidden characters found in added lines, which are looked for whatever the config says. */
  hiddenCharacters?: number;
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

export interface RoundSignalSourceRun {
  source: Exclude<StaticSignalSource, AnalyzerName | 'hidden_characters' | 'lockfile'>;
  status: 'ran' | 'skipped';
  /** Results on lines in the diff. */
  results?: number;
  /** Why the source gave nothing, such as an HTTP 403. */
  reason?: string;
}

/** Where the `review` block came from: the base branch, or the built-ins because the base has none, could not be read, or failed validation. */
export type ConfigSource = 'base' | 'builtin' | 'base_unreadable' | 'base_invalid';

export interface RoundRouting extends TeamRouting {
  configSource: ConfigSource;
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
  /** Why a `NOT_CONVERGING` round paused automatic review, and the blockers it names. */
  needsHuman?: NeedsHuman;
  /** Set when the round reviewed a draft, which does not count toward the round cap. */
  draft?: boolean;
  /**
   * Set when the record was too large for the review even compressed: the fields of per-file and per-finding
   * diagnostics that were left out, such as `judge.dropped`.
   */
  omitted?: string[];
  /**
   * Set when such a record kept `reviewers.rawFindings` with only titles, locations, severities and reviewers, and
   * `usesOutsideDiff` with `types` cut to their locations: the fields it shortened.
   */
  compacted?: string[];
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
  /** Whether the PR is a draft. A draft round never approves and does not count toward the round cap. */
  draft?: boolean;
  forceReview?: boolean;
  skipCap?: boolean;
  bypassHint?: 'force_review' | 'skip_cap' | 'manual_review_command';
  trigger?: RoundTrigger;
  /** The PR's coordinator state. */
  settings?: PrState;
  /** Reviews the whole PR as new, so every finding counts as new code. */
  fullReview?: boolean;
  /** A Deeper review: two finders on every group, each one effort level higher. */
  deeper?: boolean;
}

/** A one-off mode a settings box queued for a run. */
export type RunMode = 'again' | 'deeper' | 'draft';

/** What the PR coordinator says about a PR. */
export interface PrState {
  /** The PR's sticky settings. */
  settings: { paused: boolean };
  /** The commit of the PR's last finished review. */
  lastReviewed?: string;
  /** The modes of this run. */
  runModes: ReadonlySet<RunMode>;
  /** The modes of the work still queued for the PR. */
  queuedModes: ReadonlySet<RunMode>;
}

/** What a run tells the PR coordinator once it has posted, as `/state/report` takes it. */
export interface StateReport {
  reviewed?: { commit: string };
  approval?: { commit: string; held: boolean };
  /** Why automatic review is paused, or `null` once it is not. */
  pause?: { reason: string } | null;
}

/** Model spec each pipeline stage runs on. */
export interface ReviewModels {
  planner: string;
  reviewer: string;
  reviewerPair: string;
  judge: string;
  /** Model of the second refuter, when `models.refuter_pair` is set. */
  refuterPair?: string;
  dedup: string;
}

/** Provenance of the event that triggered a round. */
export interface RoundTrigger {
  /**
   * `github.context.eventName` plus the action and (when applicable) the
   * marker comment that fired. Examples: `pull_request:synchronize`,
   * `issue_comment:created:@manki review`,
   * `issue_comment:edited:settings:again`.
   */
  event: string;
  /** `github.context.payload.sender.login`, or `'unknown'` when absent. */
  sender: string;
}

/** Per stage, the distinct `LLMCall.promptDigest`s of its calls in the round, sorted. Finders can differ by focus. */
export type PromptVersions = Record<string, string[]>;

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
  /** `changeDigest` of the reviewed diff, so rounds that reviewed the same change share it. Optional so older context blocks keep parsing. */
  changeDigest?: string;
  /** The changed files the push since the last round touched, which the finders were told about. Unset on a first round. */
  changedSinceLastRound?: number;
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
   * True when the PR was over `max_diff_lines` for this round. The early-exit path
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
  /** Model of the second refuter, on rounds where it checked a finding or an earlier round's answer of it was reused. */
  refuterPair?: string;
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
  judgeEffort?: EffortLevel;
  prType?: string;
  durationMs?: number;
  /** Sanitized programming-language hint, when the planner identified one. */
  language?: string;
}

export interface RoundReviewers {
  /** Reviewer agent names that participated in this round. */
  agents: string[];
  agentMetrics?: RoundAgentMetric[];
  /** Every finding the finders reported, before suppressions, dedup and the judge. */
  rawFindings?: RoundRawFinding[];
}

/** A finding as the finders reported it. */
export interface RoundRawFinding {
  title: string;
  file: string;
  line: number;
  severity: FindingSeverity;
  reviewers: string[];
  /** Left out, as are `suggestedFix`, `howToFix`, `evidence`, `notChecked` and `lead`, when the record was compacted to fit the review. */
  description?: string;
  suggestedFix?: string;
  howToFix?: string;
  evidence?: FindingEvidence;
  notChecked?: boolean;
  lead?: OpenLead;
}

/** A finding the judge dropped, with the judge's reasoning. */
export interface RoundJudgeDrop {
  title: string;
  file: string;
  line: number;
  reviewers: string[];
  reviewerSeverity?: FindingSeverity;
  judgeConfidence?: 'high' | 'medium' | 'low';
  judgeNotes?: string;
  refutation?: Refutation;
  pairRefutation?: Refutation;
  /** How the finding's severity changed until it was dropped. */
  gradePath?: GradeStep[];
  /** Mirrors `Finding.gradeIfConfirmed`. */
  gradeIfConfirmed?: FindingSeverity;
  /** Mirrors `Finding.doubts`. */
  doubts?: Doubt[];
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
  /** Model the agent ran on. Present whenever the agent ran. */
  model?: string;
  /** Kept findings this finder raised and no other finder did. */
  keptOnly?: number;
  /** Kept findings this finder raised together with another finder. */
  keptShared?: number;
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
  /** Findings the judge dropped. The kept ones are in `RoundFindings.entries`. */
  dropped?: RoundJudgeDrop[];
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
  inPrSuppressedCount?: number;
  crossRoundSuppressed?: number;
  crossRoundDemoted?: number;
  /**
   * Count of findings dropped because they object to code that applies a prior-round
   * `suggestedFix` (tagged `OWN_PROPOSAL_TAG`).
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
  /** The threads where someone claimed a fix, which a blocker coming back counts against. Empty when none did. */
  fixClaimedThreads?: string[];
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
   * matches use the title-overlap branch that hit.
   */
  duplicateMatches?: RoundDedupDuplicateMatch[];
  /**
   * Count of suggestion/nitpick findings dropped by the round-2+
   * test-file suppressor. Returned from `runReview` but previously
   * never written into `RoundContext`.
   */
  testNitSuppressedCount?: number;
  /** Suggestions and nitpicks dropped because a CI tool already reports a result on the same file and line. */
  staticSignalMatches?: RoundStaticSignalMatch[];
  durationMs?: number;
}

export type MemoryLoadStatus = 'loaded' | 'disabled' | 'skipped' | 'failed';

/**
 * Why memory was skipped. A private repo never uses the central memory, and uses its own `memory.repo` only when that
 * repo is private and has the same owner. `refused` is the token service answering 403.
 */
export type MemorySkipReason = 'private_repo' | 'no_token' | 'memory_repo_unreadable' | 'memory_repo_public' | 'memory_repo_other_owner' | 'refused';

export interface RoundMemory {
  suppressionsApplied?: number;
  /** The learnings and suppressions loaded for the round. */
  loaded?: { learnings: number; suppressions: number };
  /** Each finding a memory suppression hid, with the suppression's id. */
  suppressed?: RoundSuppressedFinding[];
  /**
   * Outcome of the memory-load step. `disabled` when `config.memory.enabled`
   * is false, `skipped` with `skipReason` when the run may not use memory,
   * `failed` when the load attempt threw, `loaded` on success. Optional so
   * legacy context blocks parse cleanly; absence is treated as `loaded` when
   * `suppressionsApplied` is present.
   */
  loadStatus?: MemoryLoadStatus;
  /** Set when `loadStatus === 'skipped'`. */
  skipReason?: MemorySkipReason;
  /** Truncated error message recorded when `loadStatus === 'failed'`. */
  loadError?: string;
}

export interface RoundSuppressedFinding {
  title: string;
  file: string;
  line: number;
  severity: FindingSeverity;
  suppressionId: string;
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
  /** The flips. Omitted when none flipped. */
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
  /** Pre-existing findings Manki recorded without posting them. Nothing that reads posted findings sees them. */
  unposted?: FindingFingerprintEntry[];
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
  /** Tags applied by the judge (e.g. `OWN_PROPOSAL_TAG`, `SECURITY_TAG`). Preserves the exact string constants from `Finding.tags`. */
  tags?: string[];
  /** Pre-demotion severity, when the judge demoted the finding. Mirrors `Finding.originalSeverity`. */
  originalSeverity?: FindingSeverity;
  /** Reviewer severity, when the judge graded the finding differently. Mirrors `Finding.reviewerSeverity`. */
  reviewerSeverity?: FindingSeverity;
  /** Whether a tool confirmed or contradicted the finding, or was silent. Mirrors `Finding.toolEvidence.status`. */
  toolEvidence?: ToolEvidenceStatus;
  /** Tool that reported the finding. Mirrors `Finding.toolSource`. */
  toolSource?: string;
  /** New code or code an earlier round reviewed. Mirrors `Finding.origin`. */
  origin?: FindingOrigin;
  /** Mirrors `Finding.raisedIn`. */
  raisedIn?: number;
  /** Mirrors `Finding.category`. */
  category?: FindingCategory;
  /** Mirrors `Finding.effort`. */
  effort?: FindingEffort;
  /** Mirrors `Finding.evidence`. */
  evidence?: FindingEvidence;
  /** Mirrors `Finding.notChecked`. */
  notChecked?: boolean;
  /** Mirrors `Finding.refutation`. */
  refutation?: Refutation;
  /** Mirrors `Finding.pairRefutation`. */
  pairRefutation?: Refutation;
  /** Mirrors `Finding.gradeIfConfirmed`. */
  gradeIfConfirmed?: FindingSeverity;
  /** Mirrors `Finding.doubts`. */
  doubts?: Doubt[];
  /** Mirrors `Finding.gradePath`. */
  gradePath?: GradeStep[];
  /** The reviewer's pre-existing claim kept by the judge, and how it was checked against the diff. */
  preExisting?: { reason: string; check: PreExistingCheck };
}

/**
 * What a review state check decided about approving: `approved`, `held` for a conflict or a draft, or `withheld`
 * because Manki has not reviewed the head. It rides on the approval review or the notice the check posts.
 */
export interface ApprovalRecord {
  decision: 'approved' | 'held' | 'withheld';
  reason: string;
  head: string;
  /** Manki's review threads on the PR, and how many of them are resolved. */
  threads: { total: number; resolved: number };
  timestamp: string;
  mankiVersion: string;
}

/** One call a run made to the token service. */
export interface TokenServiceCall {
  /** The endpoint path, such as `token`, `state`, `state/report`, `resolve` or a memory endpoint. */
  endpoint: string;
  /** The HTTP status. Unset when the run had no OIDC token or the request failed. */
  status?: number;
  /** Why the call failed: the service's error, `no OIDC token`, or the request's error. */
  error?: string;
  /** The service's request id of a failed call, which names its log line in the Worker. */
  requestId?: string;
  durationMs: number;
}

/** What a reply-handler run, Manki answering in a thread or to a command, records in its comment. */
export interface ReplyRecord {
  kind: 'thread-reply' | 'explain' | 'question';
  prNumber: number;
  timestamp: string;
  mankiVersion: string;
  usage: RoundUsage;
  /** The token service calls the run made before the reply. */
  tokenService?: TokenServiceCall[];
  /** What a thread reply that settles the finding decided. */
  decision?: ReplyDecision;
}

/**
 * What a thread reply decided: the word it opens with, and what happens to the thread. `stays_open` is a blocking or
 * security thread only a maintainer may close, `lookup_failed` a thread GitHub could not list, and `deferred_to_round`
 * a fix a later round already judged.
 */
export interface ReplyDecision {
  outcome: 'Fixed' | 'Agreed' | 'Withdrawn';
  thread: 'resolves' | 'stays_open' | 'no_permission' | 'already_resolved' | 'not_found' | 'lookup_failed' | 'deferred_to_round';
}

/** The round's LLM usage: totals over its calls, per stage and per model, and the calls themselves. */
export interface RoundUsage extends RoundUsageStage {
  /** Wall-clock time of the review run, from its start to the review it posts. `durationMs` is the time spent in model calls. */
  wallClockMs?: number;
  perStage?: Partial<Record<'planner' | 'reviewer' | 'compare' | 'judge' | 'dedup' | 'verdict' | 'related', RoundUsageStage>>;
  perModel?: Record<string, RoundUsageStage>;
  llmCalls?: LLMCall[];
  /** The newest reading of each subscription usage window the round's calls reported. */
  limits?: LimitUsage[];
}

/** Older records hold only some of the fields. */
export type RoundUsageStage = Partial<UsageSummary>;

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
